/**
 * Connections over HTTP (ADR 0039). Registered projects only for anything that names one.
 *
 *   GET   /api/connections/providers          {providers}: the catalogue, `supported` true where an adapter exists
 *   GET   /api/connections/list               {connections, policy}
 *   POST  /api/connections/create             {provider,label?,baseUrl?,insecureHttp?,caBundle?}      [person]
 *   POST  /api/connections/credential         {id,token}: stores the token in the vault; never returned [person]
 *   POST  /api/connections/test               {id}: runs the capability probe
 *   POST  /api/connections/update             {id,label?,disabled?}                                    [person]
 *   POST  /api/connections/remove             {id}                                                     [person]
 *   GET   /api/connections/detect?project=    where this project's `origin` points
 *   GET   /api/connections/mapping?project=   {mapping?, connection?}
 *   POST  /api/connections/map                {project,connection,repo?,workItems?,landing?,trunk?,stateMap?,confirmLanding?} [person]
 *   POST  /api/connections/unmap              {project}                                                [person]
 *   POST  /api/connections/sync               {project}: pull items, push state, observe pull requests now
 *   GET   /api/connections/packs              {packs}: agent-built connector packs with their status (shared/connections/packs.ts)
 *   POST  /api/connections/pack-test          {id}: replay the pack's fixtures on loopback through the real engine path
 *   POST  /api/connections/pack-enable        {id,hash}: a person approves exactly the content they were shown            [person]
 *   POST  /api/connections/pack-disable       {id}                                                                          [person]
 *   POST  /api/connections/pack-connect       {id,insecureHttp?}: a connection for an enabled pack (then: token, test)      [person]
 *   GET   /api/connections/discover?connection=&kind=repos|process[&q=|&owner=]   repositories to pick from, or the project's process
 *   POST  /api/connections/iteration-create   {project,sprint}: create the sprint's iteration on the platform         [person]
 *
 * WHO MAY SAY YES. The model can `curl` the loopback port and may learn the token, so everything
 * that stores a credential, changes where the engine sends one, or makes the engine push
 * (create, credential, update, remove, map, unmap) asks the decision gate for a person, exactly
 * like the Delivery routes. Reads, the capability test and a sync need only the token: a test
 * and a sync make read calls (and AICO's own labels/comments) against a host a person already
 * connected, and cannot widen anything. A token travels IN only: no route returns it, and the
 * connection a client sees has `hasCredential`, not the credential's name.
 *
 * @module server/connection-routes
 */

import type http from 'node:http';
import path from 'node:path';
import * as Packs from '../connections/packs/index.js';
import { providerCatalogue } from '../connections/registry.js';
import * as C from '../connections/service.js';
import * as Store from '../connections/store.js';
import { kickProject } from '../connections/poller.js';
import { boardConnection, syncProject } from '../connections/sync.js';
import { createRemoteIteration } from '../connections/iterations.js';
import type { ProviderId } from '../connections/types.js';

export interface ConnectionRouteDeps {
  send: (res: http.ServerResponse, status: number, body: unknown) => void;
  readJson: (req: http.IncomingMessage) => Promise<unknown>;
  isKnownProject: (dir: string) => Promise<boolean>;
  human: (req: http.IncomingMessage, body: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
}

const HUMAN_REQUIRED = 'This needs a person in the AICO window; the API token alone cannot do it.';
const str = (v: unknown, max = 500): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export async function handleConnectionRoute(
  route: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ConnectionRouteDeps,
): Promise<boolean> {
  if (!route.startsWith('connections/')) return false;
  const { send } = deps;
  const method = req.method ?? 'GET';
  const name = route.slice('connections/'.length);
  // Spelled out (not a set) so the security scan and the DAST suite, which read routes from the source, see each one.
  const known = route === 'connections/providers' || route === 'connections/list' || route === 'connections/create'
    || route === 'connections/credential' || route === 'connections/test' || route === 'connections/update'
    || route === 'connections/remove' || route === 'connections/detect' || route === 'connections/mapping'
    || route === 'connections/map' || route === 'connections/unmap' || route === 'connections/sync'
    || route === 'connections/packs' || route === 'connections/pack-test' || route === 'connections/pack-enable'
    || route === 'connections/pack-disable' || route === 'connections/pack-connect'
    || route === 'connections/discover' || route === 'connections/iteration-create';
  if (!known) { send(res, 404, { error: 'not found' }); return true; }
  try {
    const body = (method === 'GET' ? {} : await deps.readJson(req)) as Record<string, unknown>;
    const needPerson = async (): Promise<boolean> => {
      const person = await deps.human(req, body);
      if (person.ok) return true;
      send(res, 403, { ok: false, code: 'human-required', error: person.reason ?? HUMAN_REQUIRED });
      return false;
    };
    const getOnly = (): boolean => { if (method !== 'GET') { send(res, 405, { error: 'GET only' }); return false; } return true; };
    const postOnly = (): boolean => { if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return false; } return true; };
    const projectOf = async (): Promise<string | undefined> => {
      const raw = method === 'GET' ? url.searchParams.get('project') : body.project;
      if (typeof raw !== 'string' || !raw.trim()) { send(res, 400, { error: 'project required' }); return undefined; }
      const p = path.resolve(raw);
      if (!await deps.isKnownProject(p)) { send(res, 403, { error: 'not a registered project' }); return undefined; }
      return p;
    };
    const packFail = (e: unknown): boolean => {
      if (!(e instanceof Packs.PackError)) throw e;
      const status = e.code === 'not-found' ? 404 : e.code === 'stale' || e.code === 'not-tested' || e.code === 'not-enabled' ? 409 : e.code === 'policy' ? 403 : 400;
      send(res, status, { error: e.message, code: e.code });
      return true;
    };
    const idOf = (): string | undefined => {
      const id = str(body.id, 60);
      if (!id) { send(res, 400, { error: 'id required' }); return undefined; }
      return id;
    };

    switch (name) {
      case 'providers':
        if (!getOnly()) return true;
        send(res, 200, { providers: providerCatalogue() });
        return true;
      case 'list':
        if (!getOnly()) return true;
        send(res, 200, { connections: C.listViews(), policy: C.policyView() });
        return true;
      case 'create': {
        if (!postOnly() || !await needPerson()) return true;
        const provider = str(body.provider, 40) as ProviderId | undefined;
        if (!provider) { send(res, 400, { error: 'provider required' }); return true; }
        const stored = await C.createConnection({
          provider, by: 'person',
          ...(str(body.label, 60) ? { label: str(body.label, 60)! } : {}),
          ...(str(body.baseUrl, 300) ? { baseUrl: str(body.baseUrl, 300)! } : {}),
          ...(body.insecureHttp === true ? { insecureHttp: true } : {}),
          ...(str(body.caBundle, 400) ? { caBundle: str(body.caBundle, 400)! } : {}),
          ...(str(body.username, 200) ? { username: str(body.username, 200)! } : {}),
        });
        send(res, 200, C.viewOf(stored));
        return true;
      }
      case 'credential': {
        if (!postOnly() || !await needPerson()) return true;
        const id = idOf();
        if (!id) return true;
        const token = typeof body.token === 'string' ? body.token : '';
        const stored = await C.storeToken(id, token);
        send(res, 200, C.viewOf(stored));
        return true;
      }
      case 'test': {
        if (!postOnly()) return true;
        const id = idOf();
        if (!id) return true;
        send(res, 200, C.viewOf(await C.testConnection(id)));
        return true;
      }
      case 'update': {
        if (!postOnly() || !await needPerson()) return true;
        const id = idOf();
        if (!id) return true;
        send(res, 200, C.viewOf(C.updateConnection(id, {
          ...(typeof body.label === 'string' ? { label: body.label } : {}),
          ...(typeof body.disabled === 'boolean' ? { disabled: body.disabled } : {}),
        })));
        return true;
      }
      case 'remove': {
        if (!postOnly() || !await needPerson()) return true;
        const id = idOf();
        if (!id) return true;
        send(res, 200, await C.removeConnection(id));
        return true;
      }
      case 'detect': {
        if (!getOnly()) return true;
        const project = await projectOf();
        if (!project) return true;
        send(res, 200, await C.detectRepo(project));
        return true;
      }
      case 'mapping': {
        if (!getOnly()) return true;
        const project = await projectOf();
        if (!project) return true;
        const mapping = Store.getMapping(project);
        send(res, 200, { ...(mapping ? { mapping } : {}), ...(boardConnection(project) ? { connection: boardConnection(project) } : {}) });
        return true;
      }
      case 'map': {
        if (!postOnly()) return true;
        const project = await projectOf();
        if (!project || !await needPerson()) return true;
        const connection = str(body.connection, 60);
        if (!connection) { send(res, 400, { error: 'connection required' }); return true; }
        const repo = body.repo && typeof body.repo === 'object' ? body.repo as { owner?: unknown; name?: unknown } : undefined;
        const wi = body.workItems && typeof body.workItems === 'object' ? body.workItems as { source?: unknown; value?: unknown } : undefined;
        const source = wi?.source;
        if (source !== undefined && source !== 'off' && source !== 'assigned-to-me' && source !== 'label' && source !== 'query') { send(res, 400, { error: 'workItems.source must be off, assigned-to-me, label or query' }); return true; }
        if (body.landing !== undefined && body.landing !== 'local' && body.landing !== 'pr') { send(res, 400, { error: 'landing must be local or pr' }); return true; }
        const sm = body.stateMap && typeof body.stateMap === 'object' ? Object.fromEntries(Object.entries(body.stateMap as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined;
        const out = await C.mapProject({
          project, connection, by: 'person',
          ...(repo && str(repo.owner, 100) && str(repo.name, 100) ? { repo: { owner: str(repo.owner, 100)!, name: str(repo.name, 100)! } } : {}),
          ...(source ? { workItems: { source, ...(str(wi?.value, 200) ? { value: str(wi?.value, 200)! } : {}) } } : {}),
          ...(body.landing ? { landing: body.landing as 'local' | 'pr' } : {}),
          ...(str(body.trunk, 100) ? { trunk: str(body.trunk, 100)! } : {}),
          ...(body.iterations === 'off' || body.iterations === 'native' ? { iterations: body.iterations } : {}),
          ...(sm ? { stateMap: sm } : {}),
          ...(Array.isArray(body.trustedCommenters) ? { trustedCommenters: body.trustedCommenters.filter((x): x is string => typeof x === 'string') } : {}),
          ...(body.confirmLanding === true ? { confirmLanding: true } : {}),
        });
        if (out.needsConfirm) { send(res, 409, { error: out.needsConfirm.reason, code: 'confirm-landing' }); return true; }
        kickProject(project);
        send(res, 200, { mapping: out.mapping });
        return true;
      }
      case 'unmap': {
        if (!postOnly()) return true;
        const project = await projectOf();
        if (!project || !await needPerson()) return true;
        C.unmapProject(project);
        send(res, 200, { ok: true });
        return true;
      }
      case 'discover': {
        // Reads through an already-connected host with its stored token; nothing here can widen a host or write.
        if (!getOnly()) return true;
        const id = str(url.searchParams.get('connection'), 60);
        const conn = id ? Store.getConnection(id) : undefined;
        if (!conn) { send(res, 404, { error: 'no such connection' }); return true; }
        const { adapter, ctx } = C.ctxFor(conn);
        const kind = url.searchParams.get('kind');
        if (kind === 'repos') {
          const repos = await adapter.repos.list(ctx, str(url.searchParams.get('q'), 100));
          send(res, 200, { repos: repos.slice(0, 200).map(r => ({ owner: r.ref.owner, name: r.ref.name, defaultBranch: r.defaultBranch, private: r.private })) });
          return true;
        }
        if (kind === 'process') {
          const owner = str(url.searchParams.get('owner'), 128);
          if (!adapter.process || !owner) { send(res, 200, { process: null }); return true; }
          const repoCtx = C.ctxFor(conn, { repo: { owner, name: '-' } }).ctx;
          const err = adapter.validateRepo?.({ owner, name: 'x' });
          if (err) { send(res, 400, { error: err }); return true; }
          send(res, 200, { process: await adapter.process.describe(repoCtx) });
          return true;
        }
        send(res, 400, { error: 'kind must be repos or process' });
        return true;
      }
      case 'iteration-create': {
        if (!postOnly()) return true;
        const project = await projectOf();
        if (!project || !await needPerson()) return true;
        const sprint = str(body.sprint, 80);
        if (!sprint) { send(res, 400, { error: 'sprint required' }); return true; }
        const out = await createRemoteIteration(project, sprint);
        send(res, 200, { iteration: out.iteration, sprint: out.sprint });
        return true;
      }
      case 'sync': {
        if (!postOnly()) return true;
        const project = await projectOf();
        if (!project) return true;
        send(res, 200, await syncProject(project));
        return true;
      }
      case 'packs':
        if (!getOnly()) return true;
        send(res, 200, { packs: Packs.listPacks() });
        return true;
      case 'pack-test': {
        if (!postOnly()) return true;
        const id = idOf();
        if (!id) return true;
        try { send(res, 200, (await Packs.testPack(id)).view); } catch (e) { return packFail(e); }
        return true;
      }
      case 'pack-enable': {
        // The approval is bound to the digest the person saw; a pack that changed since is refused (409), never enabled blind.
        if (!postOnly() || !await needPerson()) return true;
        const id = idOf();
        if (!id) return true;
        const hash = str(body.hash, 80);
        if (!hash) { send(res, 400, { error: 'hash required: the content digest of the pack as you reviewed it' }); return true; }
        try { send(res, 200, Packs.enablePack(id, hash)); } catch (e) { return packFail(e); }
        return true;
      }
      case 'pack-disable': {
        if (!postOnly() || !await needPerson()) return true;
        const id = idOf();
        if (!id) return true;
        try { send(res, 200, Packs.disablePack(id)); } catch (e) { return packFail(e); }
        return true;
      }
      case 'pack-connect': {
        if (!postOnly() || !await needPerson()) return true;
        const id = idOf();
        if (!id) return true;
        try { send(res, 200, C.viewOf(Packs.connectPack(id, { by: 'person', ...(body.insecureHttp === true ? { insecureHttp: true } : {}) }))); } catch (e) { return packFail(e); }
        return true;
      }
    }
  } catch (e) {
    const err = C.asError(e);
    send(res, err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
    return true;
  }
  return true;
}
