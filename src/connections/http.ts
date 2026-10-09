/**
 * The one way a connection talks to its forge: HTTP through the ops transport, with the
 * credential applied at the last moment and never visible to the caller.
 *
 * Every rule here exists because an adapter is a trusted consumer of the vault (ADR 0006)
 * and a network client of a host the repository's author could influence:
 *
 *  - **Policy twice.** The managed `connections` policy is asked on every request, not just
 *    when the connection was made, so a policy that appears later stops traffic at once
 *    (the second line; the first is `service.ts` at create/map). A `network` policy applies too.
 *  - **The credential goes where it is bound.** It is resolved from the vault for the request's
 *    exact origin; the vault refuses any other origin, so a hostile `Link:` header or redirect
 *    cannot carry it away. Redirects are followed by hand and only within the same origin.
 *  - **Same SSRF guard as `HttpRequest`.** The name is resolved once, checked
 *    (`decideTarget`: metadata and unspecified addresses never, LAN addresses allowed because the
 *    connection's credential vouches for them) and the socket is pinned to that address.
 *  - **TLS verification is never skipped.** `rejectUnauthorized` is always true. A private CA
 *    goes in as `caBundle`, added to the default roots for this connection's requests only.
 *    The vault's `allowSelfSigned` is deliberately not honoured here.
 *  - **Plain http is a person's explicit choice** (`insecureHttp`) and only for a private or
 *    loopback address; a public host over http is refused.
 *  - **Polite.** A per-connection token bucket, `Retry-After` / rate-limit reset honoured with a
 *    fast-failing `rate-limited` state, `If-None-Match` so an unchanged poll is free, bounded
 *    retries with jittered backoff for reads only (a write is never repeated blindly).
 *  - **Quiet in the log.** Writes and failures are audited with host and path but no query
 *    (audit.ts); a response body is size-capped; nothing here logs a header.
 *
 * What it does not do: know any provider's shapes (adapters do), or decide what to sync.
 *
 * @module connections/http
 */

import fs from 'node:fs';
import tls from 'node:tls';
import { connectionDecision } from '../policy/enforce.js';
import { urlDecision } from '../policy/enforce.js';
import { send, applyAuth, originOf, type AuthMode } from '../tools/ops/http.js';
import { decideTarget, resolveAll } from '../tools/ops/ssrf.js';
import { getVault, type ResolvedSecret } from '../vault/index.js';
import { isPrivateHost } from '../vault/policy.js';
import { auditConnection } from './audit.js';
import {
  EtagCache, RateLimitError, TokenBucket, backoffMs, rateLimitUntil, systemClock, type Clock,
} from './ratelimit.js';
import type { StoredConnection } from './types.js';

export const CONNECTION_TOOL = 'Connection';
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

export type ConnectionErrorCode = 'policy' | 'auth' | 'rate-limited' | 'network' | 'http' | 'config' | 'tls' | 'conflict' | 'not-found' | 'credential';

/** A failure the caller can act on. The message never carries a token. */
export class ConnectionError extends Error {
  constructor(message: string, readonly code: ConnectionErrorCode, readonly status?: number) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export interface ConnRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path under the API base, starting with `/`; or a full URL on the same origin (a `Link: rel=next`). */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  headers?: Record<string, string>;
  /** Default true for GET. */
  conditional?: boolean;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Names the operation in the audit log for writes (`pr.open`, `write`, `merge`). */
  audit?: string;
  /** An id for the audit line (item or PR number). */
  ref?: string;
  project?: string;
}

export interface ConnResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
  text: string;
  etag?: string;
  /** The server answered 304 and the body is the cached one. */
  notModified?: boolean;
  truncated?: boolean;
}

export interface ClientOptions {
  /** `https://api.github.com`, or `https://HOST/api/v3`. */
  apiBase: string;
  auth: AuthMode;
  /** Username for Basic auth, when the provider needs one. */
  username?: string;
  /** Headers every request carries (`Accept`, `X-GitHub-Api-Version`). */
  headers?: Record<string, string>;
  clock?: Clock;
  /** Retries for reads on 5xx and network errors. */
  retries?: number;
  rand?: () => number;
  /**
   * A provider that answers a dead token with something other than 401 (Azure DevOps sends 203 and an HTML
   * sign-in page for an expired PAT) says so here; it is then handled exactly like a 401.
   */
  authFailure?: (status: number, headers: Record<string, string>, contentType: string) => boolean;
  /**
   * A connector pack's contract test (packs/contract.ts) talks to a loopback server the engine itself
   * started, with this fixed fake token and no vault. It exists only for that: nothing a model or a
   * route can reach constructs a client with it, and it skips the managed `connections` policy
   * (which is about real forges) while the `network` policy and the SSRF guard still apply.
   */
  contractSecret?: string;
  /** Called when a 401 says the token no longer works, so the page can say "Sign in again". */
  onAuthFailed?: (conn: StoredConnection) => void;
  /** Called with the rate-limit state after each response, for the page's chip. */
  onRateLimit?: (conn: StoredConnection, until: number | undefined) => void;
}

// Per-connection state survives a new client object (a sync builds one per call).
const buckets = new Map<string, TokenBucket>();
const blocked = new Map<string, number>();
const caches = new Map<string, EtagCache>();

/** Tests: forget all limiter state. */
export function resetConnectionHttpForTest(): void { buckets.clear(); blocked.clear(); caches.clear(); }
export function rateLimitedUntil(connectionId: string): number | undefined {
  const t = blocked.get(connectionId);
  return t && t > Date.now() ? t : undefined;
}

/** The hosts a connection may contact, for the host check and the vault's origin binding. */
export function originsOf(conn: Pick<StoredConnection, 'hosts' | 'insecureHttp' | 'baseUrl'>): string[] {
  const scheme = conn.insecureHttp && conn.baseUrl.startsWith('http:') ? 'http' : 'https';
  const port = (() => { try { const u = new URL(conn.baseUrl); return u.port; } catch { return ''; } })();
  return conn.hosts.map(h => {
    const hasPort = /:\d+$/.test(h);
    // A custom port in the base URL applies to the base host only.
    const p = !hasPort && port && h === new URL(conn.baseUrl).hostname ? `:${port}` : '';
    return `${scheme}://${h}${p}`;
  });
}

let caCache: { file: string; mtime: number; roots: string[] } | undefined;
function caFor(file: string | undefined): string[] | undefined {
  if (!file) return undefined;
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch (e) {
    throw new ConnectionError(`The CA bundle ${file} cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'}). Fix the path in the connection's Advanced settings.`, 'config');
  }
  if (caCache?.file === file && caCache.mtime === mtime) return caCache.roots;
  const pem = fs.readFileSync(file, 'utf8');
  if (!/-----BEGIN CERTIFICATE-----/.test(pem)) throw new ConnectionError(`${file} does not contain a PEM certificate.`, 'config');
  // `ca` replaces Node's default roots, so they are passed too: the bundle adds trust, it never removes it.
  const roots = [...tls.rootCertificates, pem];
  caCache = { file, mtime, roots };
  return roots;
}

export class ConnectionClient {
  private readonly clock: Clock;
  private readonly bucket: TokenBucket;
  private readonly cache: EtagCache;

  constructor(readonly conn: StoredConnection, private readonly opts: ClientOptions) {
    this.clock = opts.clock ?? systemClock;
    if (!buckets.has(conn.id)) buckets.set(conn.id, new TokenBucket(undefined, this.clock));
    this.bucket = buckets.get(conn.id)!;
    if (!caches.has(conn.id)) caches.set(conn.id, new EtagCache());
    this.cache = caches.get(conn.id)!;
  }

  /** Everything checked before a byte leaves: policy, state, scheme. Throws ConnectionError. */
  private preflight(url: URL): void {
    const c = this.conn;
    if (c.disabled) throw new ConnectionError(`The connection "${c.label}" is turned off.`, 'config');
    if (!c.credential) throw new ConnectionError(`The connection "${c.label}" has no token yet. Add one on the Connections page.`, 'credential');
    const d = this.opts.contractSecret !== undefined ? { ok: true as const } : connectionDecision({ provider: c.provider, host: url.hostname, ...(c.pack ? { pack: true } : {}) });
    if (!d.ok) {
      auditConnection({ action: 'policy.deny', connection: c.id, provider: c.provider, target: url.toString(), outcome: 'denied', detail: d.rule });
      throw new ConnectionError(d.message, 'policy');
    }
    const net = urlDecision(url.toString());
    if (!net.ok) {
      auditConnection({ action: 'policy.deny', connection: c.id, provider: c.provider, target: url.toString(), outcome: 'denied', detail: net.rule });
      throw new ConnectionError(net.message, 'policy');
    }
    const host = url.host.toLowerCase();
    if (!c.hosts.some(h => h.toLowerCase() === host || h.toLowerCase() === url.hostname.toLowerCase())) {
      throw new ConnectionError(`${url.host} is not one of this connection's hosts (${c.hosts.join(', ')}).`, 'config');
    }
    if (url.protocol === 'http:') {
      if (!c.insecureHttp || !isPrivateHost(url.hostname)) {
        throw new ConnectionError('This connection would send its token over plain http. Plain http is allowed only for a private or loopback address that a person has opted into.', 'config');
      }
    } else if (url.protocol !== 'https:') {
      throw new ConnectionError('Only https (or opted-in private http) connections are supported.', 'config');
    }
    const until = blocked.get(c.id);
    if (until && until > this.clock.now()) {
      throw new ConnectionError(`Rate-limited by ${c.label} until ${new Date(until).toISOString()}.`, 'rate-limited', 429);
    }
  }

  private urlFor(req: ConnRequest): URL {
    let url: URL;
    if (/^https?:\/\//i.test(req.path)) {
      url = new URL(req.path);
      if (originOf(url) !== originOf(new URL(this.opts.apiBase))) {
        throw new ConnectionError('A link on another origin was not followed.', 'config');
      }
    } else {
      if (!req.path.startsWith('/')) throw new ConnectionError('Internal: a connection path must start with "/".', 'config');
      url = new URL(this.opts.apiBase.replace(/\/+$/, '') + req.path);
    }
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    if (url.username || url.password) throw new ConnectionError('A URL with credentials in it was refused.', 'config');
    return url;
  }

  async request(req: ConnRequest): Promise<ConnResponse> {
    const method = req.method ?? 'GET';
    let url = this.urlFor(req);
    const c = this.conn;
    const read = method === 'GET';
    const maxAttempts = read ? 1 + (this.opts.retries ?? 2) : 1;
    let last: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        this.preflight(url);
        await this.bucket.take(30_000, req.signal).catch(e => {
          if (e instanceof RateLimitError) throw new ConnectionError(e.message, 'rate-limited', 429);
          throw e;
        });
        const res = await this.once(method, url, req);
        if (!read) {
          auditConnection({
            action: req.audit ?? 'write', connection: c.id, provider: c.provider, target: url.toString(),
            ...(req.ref ? { ref: req.ref } : {}), outcome: res.status < 400 ? 'ok' : 'error', detail: `${method} ${res.status}`,
            ...(req.project ? { project: req.project } : {}),
          });
        }
        if (res.status >= 500 && read && attempt + 1 < maxAttempts) {
          await this.clock.sleep(backoffMs(attempt, { base: 500, ...(this.opts.rand ? { rand: this.opts.rand } : {}) }), req.signal);
          continue;
        }
        return this.interpret(res, url);
      } catch (err) {
        last = err;
        const retryable = read && err instanceof ConnectionError && err.code === 'network' && attempt + 1 < maxAttempts;
        if (!retryable) break;
        await this.clock.sleep(backoffMs(attempt, { base: 500, ...(this.opts.rand ? { rand: this.opts.rand } : {}) }), req.signal);
      }
    }
    if (!read && last instanceof ConnectionError && last.code !== 'policy') {
      auditConnection({ action: req.audit ?? 'write', connection: c.id, provider: c.provider, target: url.toString(), outcome: 'error', detail: last.message.slice(0, 120), ...(req.ref ? { ref: req.ref } : {}) });
    }
    throw last;
  }

  private async once(method: string, start: URL, req: ConnRequest): Promise<Awaited<ReturnType<typeof send>> & { cached?: boolean; key: string; url: URL }> {
    const c = this.conn;
    let url = start;
    const key = `${method} ${url.toString()}`;
    const conditional = req.conditional ?? method === 'GET';
    const cached = conditional ? this.cache.get(key) : undefined;
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
    let secret: ResolvedSecret | undefined;
    try {
      const origin = originOf(url);
      const fake = this.opts.contractSecret;
      secret = fake !== undefined
        ? ({ name: 'contract-test', kind: 'api-token', fields: { token: fake }, allowSelfSigned: false, value: () => fake, release: () => undefined } as unknown as ResolvedSecret)
        : await getVault().resolve(c.credential!, {
          tool: CONNECTION_TOOL,
          origin,
          purpose: `${method} ${url.origin}${url.pathname} for the connection "${c.label}"`.slice(0, 480),
        }).catch((e: unknown) => {
          throw new ConnectionError(e instanceof Error ? e.message : 'The credential could not be used.', 'credential');
        });
      let body: Buffer | undefined = req.json !== undefined ? Buffer.from(JSON.stringify(req.json), 'utf8') : undefined;
      let curMethod = method;
      for (let hops = 0; ; hops++) {
        const addresses = await resolveAll(url.hostname.replace(/^\[|\]$/g, '').toLowerCase());
        const decision = decideTarget({
          host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
          addresses, credentialAdmits: true, knownTarget: true, tunnelPort: false,
        });
        if (!decision.allowed) throw new ConnectionError(decision.reason, 'policy');
        const authed = applyAuth(this.opts.auth, url, secret.value(), this.opts.username);
        const headers: Record<string, string> = {
          Accept: 'application/json', ...(this.opts.headers ?? {}), ...(req.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(req.headers ?? {}), ...authed.headers,
          ...(cached && hops === 0 ? { 'If-None-Match': cached.etag } : {}),
        };
        const raw = await send({
          url: authed.url, method: curMethod, headers, ...(body ? { body } : {}), address: decision.address,
          rejectUnauthorized: true, maxBytes: req.maxBytes ?? MAX_BYTES, signal,
          ...(caFor(c.caBundle) ? { ca: caFor(c.caBundle)! } : {}),
        }).catch((err: unknown) => { throw netError(err, url, c.caBundle !== undefined); });
        const location = raw.headers.location;
        if (![301, 302, 303, 307, 308].includes(raw.status) || !location) return { ...raw, ...(raw.status === 304 && cached ? { cached: true } : {}), key, url };
        if (hops >= MAX_REDIRECTS) throw new ConnectionError('Too many redirects.', 'network');
        let next: URL;
        try { next = new URL(location, url); } catch { throw new ConnectionError('The server sent an invalid redirect.', 'network'); }
        // A renamed repository redirects within the API; anywhere else would carry the token off.
        if (originOf(next) !== originOf(url)) throw new ConnectionError(`The server redirected to ${next.origin}, which was not followed (the token is bound to ${url.origin}).`, 'config');
        const keep = raw.status === 307 || raw.status === 308;
        if (!keep) { body = undefined; curMethod = curMethod === 'HEAD' ? 'HEAD' : 'GET'; }
        url = next;
      }
    } finally {
      secret?.release();
    }
  }

  private interpret(res: Awaited<ReturnType<ConnectionClient['once']>>, url: URL): ConnResponse {
    const c = this.conn;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    const until = rateLimitUntil(res.status, headers, this.clock.now());
    if (until !== undefined) {
      blocked.set(c.id, until);
      this.opts.onRateLimit?.(c, until);
      throw new ConnectionError(`${c.label} is rate-limiting this token until ${new Date(until).toISOString()}.`, 'rate-limited', res.status);
    }
    if (blocked.has(c.id) && (blocked.get(c.id) ?? 0) <= this.clock.now()) { blocked.delete(c.id); this.opts.onRateLimit?.(c, undefined); }
    if (res.status === 401 || this.opts.authFailure?.(res.status, headers, headers['content-type'] ?? '')) {
      this.opts.onAuthFailed?.(c);
      throw new ConnectionError(`${c.label} rejected the token (${res.status === 401 ? '401' : 'not signed in'}). It may have expired or been revoked; sign in again.`, 'auth', 401);
    }
    if (res.status === 304 && (res as { cached?: boolean }).cached) {
      const hit = this.cache.get(res.key);
      if (hit) return { status: hit.status, headers: { ...hit.headers, ...headers }, json: safeJson(hit.body), text: hit.body.toString('utf8'), etag: hit.etag, notModified: true };
    }
    const text = res.body.toString('utf8');
    const out: ConnResponse = {
      status: res.status, headers, json: safeJson(res.body), text, ...(headers.etag ? { etag: headers.etag } : {}),
      ...(res.truncated ? { truncated: true } : {}),
    };
    if (res.status === 200 && headers.etag && res.key.startsWith('GET ')) {
      this.cache.set(res.key, { etag: headers.etag, status: 200, body: res.body, headers });
    }
    void url;
    return out;
  }
}

function safeJson(body: Buffer): unknown {
  if (!body.length) return undefined;
  try { return JSON.parse(body.toString('utf8')); } catch { return undefined; }
}

function netError(err: unknown, u: URL, hasCa: boolean): ConnectionError {
  const e = err as { code?: string; name?: string; message?: string };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'ABORT_ERR') return new ConnectionError(`The request to ${u.origin} timed out or was cancelled.`, 'network');
  if (e?.code === 'ECONNREFUSED') return new ConnectionError(`Nothing is listening at ${u.origin} (connection refused).`, 'network');
  if (e?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || e?.code === 'SELF_SIGNED_CERT_IN_CHAIN' || e?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || e?.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY') {
    return new ConnectionError(`${u.origin} uses a certificate this machine does not trust (${e.code}). `
      + (hasCa ? 'The CA bundle on this connection did not verify it; check that it contains the server\'s issuing CA.' : 'If it is your own server with a private CA, add the CA bundle (PEM file) under the connection\'s Advanced settings. TLS checks are never turned off.'), 'tls');
  }
  if (e?.code === 'ERR_TLS_CERT_ALTNAME_INVALID') return new ConnectionError(`${u.origin}'s certificate is for a different name.`, 'tls');
  return new ConnectionError(`Request to ${u.origin} failed: ${String(e?.code ?? e?.message ?? err).slice(0, 160)}`, 'network');
}

/** Follow `Link: <url>; rel="next"` (GitHub, Gitea, GitLab). */
export function nextLink(headers: Record<string, string>): string | undefined {
  const link = headers.link;
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (m) return m[1];
  }
  return undefined;
}

/** Fetch every page of a list (bounded), following `rel=next` within the same origin. */
export async function listAll<T>(client: ConnectionClient, first: ConnRequest, pick: (json: unknown) => T[], maxPages = 5): Promise<{ items: T[]; notModified: boolean; more: boolean }> {
  const items: T[] = [];
  let req: ConnRequest = first;
  let allCached = true;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.request(req);
    // A 403 or 404 page is an error, never an empty list.
    if (res.status >= 400) throw new ConnectionError(`${client.conn.label} answered ${res.status} for a list request.`, res.status === 404 ? 'not-found' : 'http', res.status);
    if (!res.notModified) allCached = false;
    items.push(...pick(res.json));
    const next = nextLink(res.headers);
    if (!next) return { items, notModified: allCached, more: false };
    req = { ...first, path: next, query: undefined };
  }
  return { items, notModified: allCached, more: true };
}
