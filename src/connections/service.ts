/**
 * Connections: create, sign in, test, map. The operations the Connections page, the
 * `ConnectionManage` tool and the CLI share, so the rules live once (ADR 0039).
 *
 * The rules, and who enforces them:
 *
 *  - **Policy first.** Every create and map asks the managed `connections` policy
 *    (`connectionDecision`); the HTTP client asks again on every request.
 *  - **A token is stored by a person, never by the model.** `storeToken` is the only place a
 *    token enters the system: the route calls it with the value the person typed, it goes
 *    straight into the vault bound to the connection's origins (`allowedTools: ['Connection']`,
 *    approval `auto`: the person's paste is the approval) and nothing returns it. The agent
 *    tool has no path to this function.
 *  - **Hosts are fixed by the first credential.** `baseUrl` and `hosts` cannot change once a
 *    token is stored; to point at another host, remove and create again. A model that could
 *    re-point a connection after the token was stored could send that token elsewhere.
 *  - **The repository only suggests.** `detectRepo` reads `origin` to pre-fill the page; only a
 *    person's `map` call makes it a mapping. Mappings and connections are in the user store.
 *  - **TLS and plain http** are decided here at create time (`insecureHttp` only for a private
 *    address and only by a person) and enforced by the client on every request.
 *
 * What it does not do: talk HTTP itself (client.ts/adapters), sync items (sync.ts) or land
 * tasks (landing.ts).
 *
 * @module connections/service
 */

import fs from 'node:fs';
import path from 'node:path';
import { connectionDecision } from '../policy/enforce.js';
import { getVault } from '../vault/index.js';
import { isPrivateHost } from '../vault/policy.js';
import * as G from '../delivery/git.js';
import * as S from '../delivery/store.js';
import type { AdapterCtx, ProviderAdapter } from './adapter.js';
import { auditConnection } from './audit.js';
import { ConnectionClient, ConnectionError, originsOf, rateLimitedUntil } from './http.js';
import { adapterFor, providerInfo } from './registry.js';
import * as Store from './store.js';
import {
  CONNECTION_ID_RE, DEFAULT_STATE_MAP,
  type Connection, type ConnectionsPolicyView, type LandingMode, type ProbeResult, type ProjectMapping, type ProviderId,
  type RepoDetection, type RepoRef, type StoredConnection, type WorkItemSource,
} from './types.js';
import { managedPolicy } from '../policy/managed.js';

export class ConnectionsError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) { super(message); }
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

// ── views ────────────────────────────────────────────────────────────────

/** What a client sees of a stored connection. No credential name, no secret. */
export function viewOf(c: StoredConnection): Connection {
  const projects = Store.mappingsOf(c.id).map(m => m.project);
  const decision = connectionDecision({ provider: c.provider, host: new URL(c.baseUrl).hostname });
  const limited = rateLimitedUntil(c.id);
  const missing = c.probe?.scopes.missing ?? [];
  let state: Connection['state'] = 'connected';
  let stateDetail: string | undefined;
  if (c.disabled) { state = 'off'; stateDetail = 'Turned off'; }
  else if (!decision.ok) { state = 'needs-attention'; stateDetail = 'Blocked by policy'; }
  else if (!c.credential) { state = 'needs-attention'; stateDetail = 'Add a token'; }
  else if (c.authFailedAt && (!c.probe || c.authFailedAt > c.probe.at)) { state = 'needs-attention'; stateDetail = 'Sign in again'; }
  else if (!c.probe) { state = 'needs-attention'; stateDetail = 'Not tested yet'; }
  else if (missing.length > 0) { state = 'needs-attention'; stateDetail = `Token is missing: ${missing.join(', ')}`; }
  else if (limited) { stateDetail = 'Rate-limited for now'; }
  return {
    id: c.id, provider: c.provider, label: c.label, baseUrl: c.baseUrl, host: new URL(c.baseUrl).host, hosts: [...c.hosts],
    ...(c.insecureHttp ? { insecureHttp: true } : {}), ...(c.caBundle ? { caBundle: c.caBundle } : {}),
    ...(c.disabled ? { disabled: true } : {}), createdAt: c.createdAt, createdBy: c.createdBy,
    hasCredential: Boolean(c.credential), state, ...(stateDetail ? { stateDetail } : {}),
    ...(c.probe ? { probe: c.probe } : {}),
    ...(limited ? { rateLimited: { until: new Date(limited).toISOString() } } : {}),
    projects,
  };
}

export function listViews(): Connection[] { return Store.listConnections().map(viewOf); }

export function policyView(): ConnectionsPolicyView {
  const lp = managedPolicy();
  const rules = lp.layers.map(l => l.policy.connections).filter((r): r is NonNullable<typeof r> => Boolean(r));
  if (lp.lockdown) return { mode: 'forbid', message: 'AICO is locked down by an unreadable policy file.' };
  if (rules.length === 0) return { mode: 'any' };
  const strict = rules.find(r => r.mode === 'forbid') ?? rules.find(r => r.mode === 'allow-list') ?? rules[0]!;
  const maxLanding = rules.find(r => r.maxLanding === 'local')?.maxLanding ?? rules.find(r => r.maxLanding)?.maxLanding;
  const message = strict.mode === 'forbid' ? 'Your organisation does not allow connections to forges or trackers.'
    : strict.mode === 'allow-list' ? `Your organisation limits connections to: ${[...(strict.providers ?? []), ...(strict.hosts ?? [])].join(', ') || 'nothing'}.`
      : maxLanding === 'local' ? 'Your organisation keeps delivery local: pull-request mode is not available.' : undefined;
  return {
    mode: strict.mode, ...(strict.providers ? { providers: strict.providers } : {}), ...(strict.hosts ? { hosts: strict.hosts } : {}),
    ...(maxLanding ? { maxLanding } : {}), ...(message ? { message } : {}),
  };
}

// ── adapters and clients ─────────────────────────────────────────────────

export function requireAdapter(provider: ProviderId): ProviderAdapter {
  const a = adapterFor(provider);
  if (!a) throw new ConnectionsError(`${providerInfo(provider)?.label ?? provider} is not available yet.`, 400, 'unsupported');
  return a;
}

export function clientFor(conn: StoredConnection): { adapter: ProviderAdapter; client: ConnectionClient } {
  const adapter = requireAdapter(conn.provider);
  const client = new ConnectionClient(conn, {
    ...adapter.clientOptions(conn),
    onAuthFailed: c => {
      const cur = Store.getConnection(c.id);
      if (cur) Store.putConnection({ ...cur, authFailedAt: new Date().toISOString() });
    },
  });
  return { adapter, client };
}

export function ctxFor(conn: StoredConnection, opts: { repo?: RepoRef; project?: string; signal?: AbortSignal } = {}): { adapter: ProviderAdapter; ctx: AdapterCtx } {
  const { adapter, client } = clientFor(conn);
  return { adapter, ctx: { conn, client, ...(opts.repo ? { repo: opts.repo } : {}), ...(opts.project ? { project: opts.project } : {}), ...(opts.signal ? { signal: opts.signal } : {}) } };
}

/** Throw a plain error for the HTTP/tool layers when an operation fails below. */
export function asError(e: unknown): ConnectionsError {
  if (e instanceof ConnectionsError) return e;
  if (e instanceof ConnectionError) return new ConnectionsError(e.message, e.code === 'policy' ? 403 : e.code === 'auth' ? 401 : e.code === 'rate-limited' ? 429 : e.code === 'not-found' ? 404 : e.code === 'conflict' ? 409 : 502, e.code);
  return new ConnectionsError(e instanceof Error ? e.message : String(e), 500);
}

// ── create ───────────────────────────────────────────────────────────────

export interface CreateInput {
  provider: ProviderId;
  label?: string;
  baseUrl?: string;
  /** A person opted into plain http for this private address. Ignored for an agent. */
  insecureHttp?: boolean;
  caBundle?: string;
  by: 'person' | 'agent';
}

function normaliseBaseUrl(raw: string, insecure: boolean): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new ConnectionsError('The base URL is not a valid URL. Write it like https://git.example.com'); }
  if (u.username || u.password) throw new ConnectionsError('The base URL must not contain a username or password. The token is entered separately and kept in the vault.');
  if (u.search || u.hash) throw new ConnectionsError('The base URL must not contain a query or fragment.');
  if (u.protocol === 'http:') {
    if (!insecure) throw new ConnectionsError('Plain http is refused. Use https, or (for a private server only) tick "Allow plain http for this private address".');
    if (!isPrivateHost(u.hostname)) throw new ConnectionsError('Plain http is only allowed for a private or loopback address, never a public host.');
  } else if (u.protocol !== 'https:') throw new ConnectionsError('Only https (or opted-in private http) base URLs are supported.');
  return new URL(`${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`);
}

export async function createConnection(input: CreateInput): Promise<StoredConnection> {
  const info = providerInfo(input.provider);
  if (!info) throw new ConnectionsError(`Unknown provider "${input.provider}".`);
  const adapter = requireAdapter(input.provider);
  const insecure = input.by === 'person' && input.insecureHttp === true;
  const raw = input.baseUrl?.trim() || info.cloudUrl;
  if (!raw) throw new ConnectionsError(`${info.label} needs a base URL (the address of your server).`);
  const base = normaliseBaseUrl(raw, insecure);
  const decision = connectionDecision({ provider: input.provider, host: base.hostname });
  if (!decision.ok) {
    auditConnection({ action: 'policy.deny', connection: '-', provider: input.provider, target: base.toString(), outcome: 'denied', detail: decision.rule });
    throw new ConnectionsError(decision.message, 403, 'policy');
  }
  if (input.by === 'agent' && input.caBundle) throw new ConnectionsError('An agent cannot set a CA bundle; a person adds it under Advanced.', 403);
  let caBundle: string | undefined;
  if (input.caBundle?.trim()) {
    caBundle = path.resolve(input.caBundle.trim());
    let pem = '';
    try { pem = fs.readFileSync(caBundle, 'utf8'); } catch { throw new ConnectionsError(`The CA bundle ${caBundle} cannot be read.`); }
    if (!/-----BEGIN CERTIFICATE-----/.test(pem)) throw new ConnectionsError(`${caBundle} is not a PEM certificate file.`);
  }
  const baseUrl = base.toString().replace(/\/+$/, '');
  const hosts = adapter.hostsFor(baseUrl);
  for (const h of hosts) {
    const d = connectionDecision({ provider: input.provider, host: h.replace(/:\d+$/, '') });
    if (!d.ok) throw new ConnectionsError(d.message, 403, 'policy');
  }
  const id = Store.newConnectionId(input.provider, base.host);
  const stored: StoredConnection = {
    id, provider: input.provider, label: clip(input.label?.trim() || `${info.label}${info.cloudUrl && baseUrl === info.cloudUrl ? '' : ` (${base.host})`}`, 60),
    baseUrl, hosts, ...(insecure ? { insecureHttp: true } : {}), ...(caBundle ? { caBundle } : {}),
    createdAt: new Date().toISOString(), createdBy: input.by,
  };
  if (!CONNECTION_ID_RE.test(stored.id)) throw new ConnectionsError('Could not make an id for this connection.');
  Store.putConnection(stored);
  auditConnection({ action: 'create', connection: id, provider: input.provider, target: baseUrl, detail: `by ${input.by}` });
  return stored;
}

// ── sign in ──────────────────────────────────────────────────────────────

/**
 * Store the token a person typed. The ONLY entry point for a token. The value goes into the
 * vault bound to this connection's origins and is never returned, logged or kept anywhere else.
 */
export async function storeToken(id: string, token: string): Promise<StoredConnection> {
  const conn = Store.getConnection(id);
  if (!conn) throw new ConnectionsError(`No connection "${id}".`, 404);
  const value = token.replace(/\s+/g, '');
  if (value.length < 8 || value.length > 4096) throw new ConnectionsError('That does not look like an access token.');
  const d = connectionDecision({ provider: conn.provider, host: new URL(conn.baseUrl).hostname });
  if (!d.ok) throw new ConnectionsError(d.message, 403, 'policy');
  // A fresh name each time: replacing a user-stored credential in place would need a vault grant (by design).
  const name = `conn-${conn.id}${conn.credential ? `-${Date.now().toString(36)}` : ''}`.slice(0, 64);
  const origins = originsOf(conn);
  try {
    await getVault().create({
      name, kind: 'api-token', secret: { token: value },
      url: origins[0]!, description: `Token for the connection "${conn.label}" (${conn.provider}). Used only by AICO's connections.`,
      tags: ['connection'], createdBy: 'user',
      policy: { approval: 'auto', allowedTools: ['Connection'], allowedOrigins: origins, allowedHosts: [], allowShell: false, ...(conn.insecureHttp ? { allowInsecureHttp: true } : {}) },
    });
  } catch (e) {
    throw new ConnectionsError(e instanceof Error && !/secret|token/i.test(e.message) ? `The vault could not store the token: ${e.message}` : 'The vault could not store the token. Is it unlocked?', 500);
  }
  const next: StoredConnection = { ...conn, credential: name };
  delete next.authFailedAt;
  delete next.probe;
  Store.putConnection(next);
  auditConnection({ action: 'credential', connection: conn.id, provider: conn.provider, detail: conn.credential ? 'token replaced' : 'token stored' });
  return next;
}

// ── test ─────────────────────────────────────────────────────────────────

export async function testConnection(id: string, signal?: AbortSignal): Promise<StoredConnection> {
  const conn = Store.getConnection(id);
  if (!conn) throw new ConnectionsError(`No connection "${id}".`, 404);
  const { adapter, ctx } = ctxFor(conn, signal ? { signal } : {});
  let probe: ProbeResult;
  try {
    probe = await adapter.probe(ctx);
  } catch (e) {
    const err = asError(e);
    auditConnection({ action: 'test', connection: id, provider: conn.provider, target: conn.baseUrl, outcome: 'error', detail: err.code ?? String(err.status) });
    throw err;
  }
  const fresh = Store.getConnection(id) ?? conn;
  const next: StoredConnection = { ...fresh, probe };
  delete next.authFailedAt;
  Store.putConnection(next);
  auditConnection({ action: 'test', connection: id, provider: conn.provider, target: conn.baseUrl, detail: `as ${probe.user}` });
  return next;
}

// ── change and remove ────────────────────────────────────────────────────

export function updateConnection(id: string, patch: { label?: string; disabled?: boolean }): StoredConnection {
  const conn = Store.getConnection(id);
  if (!conn) throw new ConnectionsError(`No connection "${id}".`, 404);
  const next: StoredConnection = { ...conn };
  if (patch.label !== undefined) { const l = clip(patch.label.trim(), 60); if (!l) throw new ConnectionsError('A connection needs a name.'); next.label = l; }
  if (patch.disabled !== undefined) { if (patch.disabled) next.disabled = true; else delete next.disabled; }
  Store.putConnection(next);
  auditConnection({ action: 'update', connection: id, provider: conn.provider, detail: patch.disabled !== undefined ? (patch.disabled ? 'turned off' : 'turned on') : 'renamed' });
  return next;
}

export async function removeConnection(id: string): Promise<{ ok: true; credentialKept?: string }> {
  const conn = Store.getConnection(id);
  if (!conn) throw new ConnectionsError(`No connection "${id}".`, 404);
  for (const m of Store.mappingsOf(id)) Store.removeMapping(m.project);
  Store.removeConnection(id);
  let credentialKept: string | undefined;
  if (conn.credential) {
    // The token was stored by a person, so deleting it needs the vault's own grant: leave it and say where it is.
    try { await getVault().remove(conn.credential); } catch { credentialKept = conn.credential; }
  }
  auditConnection({ action: 'remove', connection: id, provider: conn.provider });
  return { ok: true, ...(credentialKept ? { credentialKept } : {}) };
}

// ── detect and map ───────────────────────────────────────────────────────

export async function detectRepo(project: string): Promise<RepoDetection> {
  const p = path.resolve(project);
  const out: RepoDetection = { project: p };
  const repoRoot = await G.repoRootOf(p);
  if (!repoRoot) return out;
  const trunk = (fs.existsSync(S.journalFile(p)) ? S.load(p).settings.trunk : undefined) ?? (await G.currentBranch(p));
  if (trunk) out.trunk = trunk;
  const r = await G.git(['remote', 'get-url', 'origin'], repoRoot);
  if (!r.ok) return out;
  const origin = r.out.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
  out.origin = origin;
  for (const c of Store.listConnections()) {
    const a = adapterFor(c.provider);
    const ref = a?.parseRemote(origin, c.baseUrl);
    if (ref) { out.connection = c.id; out.provider = c.provider; out.repo = ref; return out; }
  }
  // No connection yet: say which provider this looks like so the page can offer to connect it.
  for (const info of [providerInfo('github')].filter(Boolean)) {
    const a = adapterFor(info!.id);
    const ref = info!.cloudUrl ? a?.parseRemote(origin, info!.cloudUrl) : undefined;
    if (ref) { out.provider = info!.id; out.repo = ref; break; }
  }
  return out;
}

export interface MapInput {
  project: string;
  connection: string;
  repo?: RepoRef;
  workItems?: { source: WorkItemSource; value?: string };
  landing?: LandingMode;
  trunk?: string;
  iterations?: 'off' | 'native';
  stateMap?: Record<string, string>;
  trustedCommenters?: string[];
  /** The person accepted the PR-mode confirm card. */
  confirmLanding?: boolean;
  by: 'person' | 'agent';
}

export interface MapResult { mapping?: ProjectMapping; needsConfirm?: { reason: string } }

export async function mapProject(input: MapInput): Promise<MapResult> {
  const project = path.resolve(input.project);
  const conn = Store.getConnection(input.connection);
  if (!conn) throw new ConnectionsError(`No connection "${input.connection}".`, 404);
  if (!conn.credential) throw new ConnectionsError('Add a token to this connection first.', 409);
  const repoRoot = await G.repoRootOf(project);
  if (!repoRoot) throw new ConnectionsError('This project is not a git repository, so there is nothing to map.', 409);
  const prior = Store.getMapping(project);
  const landing: LandingMode = input.landing ?? prior?.landing ?? 'local';
  const d = connectionDecision({ provider: conn.provider, host: new URL(conn.baseUrl).hostname, landing });
  if (!d.ok) {
    auditConnection({ action: 'policy.deny', connection: conn.id, provider: conn.provider, outcome: 'denied', detail: d.rule, project });
    throw new ConnectionsError(d.message, 403, 'policy');
  }
  if (landing === 'pr' && prior?.landing !== 'pr') {
    // Switching on PR mode makes the engine push: a standing change, only on a person's confirmed click.
    if (input.by === 'agent' || input.confirmLanding !== true) {
      return { needsConfirm: { reason: `Pull request mode: AICO will push aico/task-* branches to the remote and open pull requests. It never pushes the trunk and never force-pushes, and the remote's checks and reviews decide when work lands. Ask the person to turn it on on the Connections page.` } };
    }
    const cap = conn.probe?.capabilities.pulls.create;
    if (cap === false) throw new ConnectionsError('This connection cannot open pull requests (the last test showed the token lacks that permission).', 409);
  }
  const detection = await detectRepo(project);
  const repo = input.repo ?? prior?.repo ?? detection.repo;
  if (!repo) throw new ConnectionsError('Could not tell which repository this project is. Its "origin" does not match this connection; enter the repository as owner/name.', 400);
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo.name)) throw new ConnectionsError('The repository must look like owner/name.');
  // Confirm the repository exists and the token can see it (a read; also learns the default branch).
  const adapter = requireAdapter(conn.provider);
  const { ctx } = ctxFor(conn, { project });
  let defaultBranch: string | undefined;
  try {
    const info = await adapter.repos.get(ctx, repo);
    defaultBranch = info.defaultBranch;
  } catch (e) { throw asError(e); }
  const wi = input.workItems ?? prior?.workItems ?? { source: 'off' as WorkItemSource };
  if ((wi.source === 'label' || wi.source === 'query') && !wi.value?.trim()) throw new ConnectionsError(`Work items from a ${wi.source} need the ${wi.source} to look for.`);
  const trunk = input.trunk?.trim() || prior?.trunk || detection.trunk || defaultBranch || 'main';
  const mapping: ProjectMapping = {
    project, connection: conn.id, repo,
    workItems: { source: wi.source, ...(wi.value?.trim() ? { value: clip(wi.value.trim(), 200) } : {}) },
    landing, trunk, iterations: input.iterations ?? prior?.iterations ?? 'off',
    stateMap: { ...DEFAULT_STATE_MAP, ...(prior?.stateMap ?? {}), ...cleanStateMap(input.stateMap) },
    ...((input.trustedCommenters ?? prior?.trustedCommenters)?.length ? { trustedCommenters: (input.trustedCommenters ?? prior?.trustedCommenters)!.slice(0, 50).map(s => clip(s.trim(), 80)).filter(Boolean) } : {}),
  };
  Store.putMapping(mapping);
  auditConnection({ action: 'map', connection: conn.id, provider: conn.provider, ref: `${repo.owner}/${repo.name}`, detail: `landing ${landing}, items ${mapping.workItems.source}`, project });
  return { mapping };
}

function cleanStateMap(m: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m ?? {})) {
    if (k in DEFAULT_STATE_MAP && typeof v === 'string' && v.trim()) out[k] = clip(v.trim(), 80);
  }
  return out;
}

export function unmapProject(project: string): void {
  const p = path.resolve(project);
  const m = Store.getMapping(p);
  if (!m) return;
  Store.removeMapping(p);
  const c = Store.getConnection(m.connection);
  auditConnection({ action: 'unmap', connection: m.connection, provider: c?.provider ?? '-', project: p });
}
