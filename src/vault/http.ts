/**
 * `/api/vault/*` — the Credential Manager's API, behind the server's token.
 *
 * Written on the assumption that the model can reach it: it can run `curl`
 * against the loopback port, and it may learn the token. So:
 *
 *  - no route returns a secret value, except `reveal`, which needs a one-time
 *    human grant the token cannot mint (see human.ts);
 *  - secrets travel *in* only (create, rotate, fulfil) and never back out;
 *  - anything that widens what a credential can be used for, and deleting or
 *    replacing one the user stored, needs a grant too;
 *  - approving a pending use needs a grant or the passphrase; declining needs
 *    nothing, because refusing is always safe;
 *  - request bodies are never logged, and error messages never echo input;
 *  - `export` returns every credential sealed with a passphrase the person
 *    chose, and needs an `export` grant; `import` only ever adds.
 *
 * Responses carry `Cache-Control: no-store` so a reveal is not left in any
 * cache on the way to the window that asked.
 *
 * The routes are documented in docs/security/credential-broker.md.
 *
 * @module vault/http
 */

import type http from 'node:http';
import { getVault } from './index.js';
import type { GrantAction } from './human.js';
import type { MetaPatch } from './store.js';
import { CREDENTIAL_KINDS, isCreatedBy, VaultError, type CredentialKind, type Policy } from './types.js';

const MAX_BODY = 256 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new VaultError('invalid', 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    // Not the parser's message: it can quote the body.
    throw new VaultError('invalid', 'The request body is not valid JSON.');
  } finally {
    for (const c of chunks) c.fill(0);
  }
}

function statusFor(err: VaultError): number {
  switch (err.code) {
    case 'not-found': return 404;
    case 'exists': return 409;
    case 'locked': return 423;
    case 'grant-required': return 403;
    case 'wrong-passphrase': return 401;
    case 'policy-denied': case 'approval-denied': return 403;
    case 'unavailable': return 503;
    case 'tampered': return 500;
    default: return 400;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const GRANT_ACTIONS: readonly GrantAction[] = ['reveal', 'loosen', 'export', 'delete', 'rotate', 'approve'];

function secretObject(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === 'string') out[k] = val;
  return out;
}

/**
 * Handle a `vault/…` route. Returns false for a route this module does not
 * own, so the caller can 404 it.
 */
export async function handleVaultRoute(req: http.IncomingMessage, res: http.ServerResponse, route: string, url: URL): Promise<boolean> {
  if (!route.startsWith('vault/')) return false;
  const action = route.slice('vault/'.length);
  const vault = getVault();
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET') {
      switch (action) {
        case 'status':
          send(res, 200, { ...vault.status(), pendingApprovals: vault.approvals.list(), pendingRequests: vault.requests.list() });
          return true;
        case 'list': {
          const kind = str(url.searchParams.get('kind'));
          send(res, 200, {
            credentials: await vault.list({
              ...(str(url.searchParams.get('host')) ? { host: str(url.searchParams.get('host'))! } : {}),
              ...(kind && CREDENTIAL_KINDS.includes(kind as CredentialKind) ? { kind: kind as CredentialKind } : {}),
            }),
          });
          return true;
        }
        case 'get': {
          const id = str(url.searchParams.get('id'));
          if (!id) { send(res, 400, { error: 'id required' }); return true; }
          send(res, 200, { credential: await vault.get(id) });
          return true;
        }
        case 'audit': {
          const limit = Number(url.searchParams.get('limit') ?? '200');
          const id = str(url.searchParams.get('id'));
          send(res, 200, { entries: vault.auditTrail({ limit: Number.isFinite(limit) ? limit : 200, ...(id ? { credentialId: id } : {}) }) });
          return true;
        }
        case 'match': {
          const origin = str(url.searchParams.get('origin'));
          if (!origin) { send(res, 400, { error: 'origin required' }); return true; }
          send(res, 200, { credentials: await vault.findForOrigin(origin) });
          return true;
        }
        default:
          send(res, 404, { error: `unknown vault route ${action}` });
          return true;
      }
    }
    if (method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return true; }

    const body = await readBody(req);
    switch (action) {
      case 'create': {
        const kind = str(body.kind) as CredentialKind | undefined;
        const secret = secretObject(body.secret);
        if (!kind || !secret) { send(res, 400, { error: 'kind and secret required' }); return true; }
        const out = await vault.create({
          name: String(body.name ?? ''),
          kind,
          secret,
          ...(str(body.username) ? { username: str(body.username)! } : {}),
          ...(str(body.host) ? { host: str(body.host)! } : {}),
          ...(typeof body.port === 'number' ? { port: body.port } : {}),
          ...(str(body.url) ? { url: str(body.url)! } : {}),
          ...(str(body.description) ? { description: str(body.description)! } : {}),
          ...(Array.isArray(body.tags) ? { tags: body.tags.filter((t): t is string => typeof t === 'string') } : {}),
          ...(body.policy && typeof body.policy === 'object' ? { policy: body.policy as Partial<Policy> } : {}),
          createdBy: isCreatedBy(body.createdBy) ? body.createdBy : 'user',
        });
        send(res, 200, out);
        return true;
      }
      case 'generate': {
        const kind = str(body.kind);
        if (!kind || !str(body.name)) { send(res, 400, { error: 'name and kind required' }); return true; }
        const out = await vault.generate({
          name: str(body.name)!,
          kind: kind as Parameters<typeof vault.generate>[0]['kind'],
          ...(str(body.username) ? { username: str(body.username)! } : {}),
          ...(str(body.host) ? { host: str(body.host)! } : {}),
          ...(str(body.url) ? { url: str(body.url)! } : {}),
          ...(typeof body.port === 'number' ? { port: body.port } : {}),
          ...(str(body.description) ? { description: str(body.description)! } : {}),
          ...(typeof body.length === 'number' ? { length: body.length } : {}),
          ...(body.symbols === false ? { symbols: false } : {}),
          ...(body.allowSelfSigned === true ? { allowSelfSigned: true } : {}),
        }, 'user');
        send(res, 200, out);
        return true;
      }
      case 'update': {
        const id = str(body.id);
        if (!id) { send(res, 400, { error: 'id required' }); return true; }
        const patch: MetaPatch = {};
        for (const k of ['name', 'username', 'host', 'url', 'description'] as const) if (typeof body[k] === 'string') patch[k] = body[k] as string;
        if (typeof body.port === 'number') patch.port = body.port;
        if (Array.isArray(body.tags)) patch.tags = body.tags.filter((t): t is string => typeof t === 'string');
        if (body.quarantined === false) patch.quarantined = false;
        send(res, 200, { credential: await vault.updateMeta(id, patch, body.grant) });
        return true;
      }
      case 'policy': {
        const id = str(body.id);
        if (!id || !body.policy || typeof body.policy !== 'object') { send(res, 400, { error: 'id and policy required' }); return true; }
        send(res, 200, { credential: await vault.setPolicy(id, body.policy as Partial<Policy>, body.grant) });
        return true;
      }
      case 'rotate': {
        const id = str(body.id);
        const secret = secretObject(body.secret);
        if (!id || !secret) { send(res, 400, { error: 'id and secret required' }); return true; }
        send(res, 200, { credential: await vault.rotate(id, secret, body.grant) });
        return true;
      }
      case 'delete': {
        const id = str(body.id);
        if (!id) { send(res, 400, { error: 'id required' }); return true; }
        send(res, 200, { deleted: (await vault.remove(id, body.grant)).name });
        return true;
      }
      case 'reveal': {
        const id = str(body.id);
        if (!id) { send(res, 400, { error: 'id required' }); return true; }
        send(res, 200, await vault.reveal(id, body.grant, str(body.actor) ?? 'credential-manager'));
        return true;
      }
      case 'grant': {
        const act = str(body.action) as GrantAction | undefined;
        if (!act || !GRANT_ACTIONS.includes(act)) { send(res, 400, { error: `action must be one of ${GRANT_ACTIONS.join(', ')}` }); return true; }
        const grant = await vault.grantWithPassphrase(body.passphrase, act, str(body.id));
        send(res, 200, { grant });
        return true;
      }
      case 'approve': {
        const id = str(body.id);
        if (!id || typeof body.approve !== 'boolean') { send(res, 400, { error: 'id and approve required' }); return true; }
        const ok = await vault.answerApproval(id, body.approve, {
          ...(body.grant !== undefined ? { grant: body.grant } : {}),
          ...(body.passphrase !== undefined ? { passphrase: body.passphrase } : {}),
        }, body.scope === 'once' ? 'once' : undefined);
        send(res, 200, { ok });
        return true;
      }
      case 'export': {
        // Ciphertext only, sealed with the passphrase the person chose; the
        // grant is what makes "every value at once" a person's decision.
        const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
        send(res, 200, await vault.exportEncrypted(passphrase, body.grant, str(body.actor) ?? 'credential-manager'));
        return true;
      }
      case 'import': {
        const file = typeof body.file === 'string' ? body.file : '';
        if (!file) { send(res, 400, { error: 'file required' }); return true; }
        send(res, 200, await vault.importEncrypted(file, typeof body.passphrase === 'string' ? body.passphrase : '', str(body.actor) ?? 'credential-manager'));
        return true;
      }
      case 'fulfil': {
        const requestId = str(body.requestId);
        if (!requestId) { send(res, 400, { error: 'requestId required' }); return true; }
        const ok = vault.fulfil(requestId, {
          ...(secretObject(body.secret) ? { secret: secretObject(body.secret)! } : {}),
          ...(typeof body.value === 'string' ? { value: body.value } : {}),
          ...(typeof body.username === 'string' ? { username: body.username } : {}),
          ...(body.decline === true ? { decline: true } : {}),
        });
        // Status only. Nothing about what was stored comes back on this route.
        send(res, ok ? 200 : 404, { ok });
        return true;
      }
      case 'lock':
        vault.lock();
        send(res, 200, { locked: true });
        return true;
      case 'unlock':
        await vault.unlock(str(body.passphrase));
        send(res, 200, { unlocked: true });
        return true;
      default:
        send(res, 404, { error: `unknown vault route ${action}` });
        return true;
    }
  } catch (err) {
    if (err instanceof VaultError) { send(res, statusFor(err), { error: err.message, code: err.code }); return true; }
    // Never the raw message of an unexpected error: it could quote input.
    send(res, 500, { error: 'The vault request failed.' });
    return true;
  }
}
