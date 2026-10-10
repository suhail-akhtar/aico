/**
 * The control server: routes, sessions, device enrolment, engine API, admin API.
 *
 * Read ADR 0040 first. The shape, in the order a request meets it:
 *
 *   security headers -> rate limit -> route -> authentication (session cookie
 *   for people, bearer token for engines) -> CSRF (cookie + state change only)
 *   -> permission (rbac.ts) -> the repository (store.ts, tenant first) -> audit.
 *
 * Decisions that are easy to get wrong and are therefore stated here:
 *  - **Two authentications, never mixed.** `/v1/admin/*` and `/device*` accept
 *    only the session cookie; `/v1/engine/*` accepts only a bearer access token.
 *    Cookie requests that change state need the session's CSRF token and a
 *    same-origin `Origin`; bearer requests are not ambient, so they need
 *    neither, and a bearer token in a cookie-authenticated route is ignored.
 *  - **The engine cannot speak for anyone else.** Identity on audit and usage
 *    comes from the token; ids are namespaced by user so one engine cannot
 *    pre-claim another's record id and suppress it.
 *  - **Every admin action is audited** into the same hash chain as the engines'
 *    records (`source: "control"`).
 *  - **Revocation is immediate.** Access tokens are checked against the device
 *    and user rows on every request, not only at signature level.
 *  - **Refresh tokens rotate; a reused one revokes the device** (theft detection).
 *
 * Deliberately not here: SAML/SCIM, the model gateway, custom roles (ADR 0040,
 * later phases); any execution on behalf of a client.
 *
 * @module app
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from './db.js';
import { Store, newId, type AuditInput, type Device, type Grant, type Session, type Tenant, type TenantSettings, type User, DEFAULT_SETTINGS } from './store.js';
import {
  generateSigningKey, normaliseUserCode, open, randomToken, safeEqual, seal, sha256hex, signingKeyFromPem, signJwt, tenantKey, userCode, verifyJwt, type SigningKey,
} from './crypto.js';
import { PERMISSIONS, ROLE_DEFS, ROLES, can, canAssign, hasPortalAccess, isRole, isTeamScoped, permissionsOf, type Permission } from './rbac.js';
import { HttpError, RateLimiter, cookies, esc, readParams, redirect, safeNext, securityHeaders, sendJson, sendText, setCookie } from './http.js';
import { completeFlow, startFlow, OidcError, type IdpConfig } from './oidc.js';
import { layersFor, layersHash, leaseFor, validateDoc } from './policy.js';
import { devicePage, messagePage } from './pages.js';

export interface ControlOptions {
  /** SQLite file; `:memory:` for tests. */
  dbFile?: string;
  /** Directory for the master key file when none is given. */
  dataDir?: string;
  /** 32+ bytes as hex/base64, or any passphrase (hashed). Falls back to `<dataDir>/master.key`. */
  masterKey?: string;
  /** The URL clients use to reach this server (https in production). */
  publicUrl?: string;
  allowInsecureIdp?: boolean;
  behindProxy?: boolean;
  portalDir?: string;
  now?: () => number;
  /** Multiplies every rate limit (tests lower it to prove the limiter). */
  rateScale?: number;
}

const ACCESS_TTL_S = 900;
const REFRESH_TTL_MS = 30 * 86_400_000;
const SESSION_ABSOLUTE_MS = 8 * 3_600_000;
const SESSION_IDLE_MS = 30 * 60_000;
const GRANT_TTL_MS = 600_000;
const GRANT_INTERVAL_S = 5;
const MAX_WRONG_CODES = 5;
const CLIENT_ID = 'aico-engine';
const AUDIT_FIELDS = [
  'schema', 'id', 'time', 'kind', 'action', 'outcome', 'decision', 'decidedBy', 'stage', 'user', 'host', 'tenant', 'aicoVersion', 'project',
  'sessionId', 'turn', 'callId', 'tool', 'target', 'model', 'inputTokens', 'outputTokens', 'costUsd', 'durationMs', 'reason', 'credential',
] as const;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const finite = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  method: string;
  ip: string;
  params: Record<string, string>;
}
interface SessionAuth { session: Session; user: User; tenant: Tenant; perms: readonly Permission[] }
interface DeviceAuth { user: User; tenant: Tenant; device: Device }

function match(pattern: string, pathname: string): Record<string, string> | undefined {
  const a = pattern.split('/');
  const b = pathname.split('/');
  if (a.length !== b.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return undefined;
  }
  return params;
}

export class ControlApp {
  readonly store: Store;
  readonly limiter: RateLimiter;
  publicUrl: string | undefined;
  private readonly master: Buffer;
  private readonly signingKey: SigningKey;
  private server: http.Server | https.Server | undefined;
  private readonly now: () => number;

  constructor(readonly opts: ControlOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.store = new Store(openDb(opts.dbFile ?? ':memory:'), this.now);
    this.limiter = new RateLimiter(this.now, opts.rateScale ?? 1);
    this.publicUrl = opts.publicUrl?.replace(/\/$/, '');
    this.master = this.loadMaster();
    this.signingKey = this.loadSigningKey();
  }

  // ── keys ──────────────────────────────────────────────────────────
  private loadMaster(): Buffer {
    const given = this.opts.masterKey ?? process.env.CONTROL_MASTER_KEY;
    if (given) return /^[0-9a-f]{64}$/i.test(given) ? Buffer.from(given, 'hex') : crypto.createHash('sha256').update(given).digest();
    if (!this.opts.dataDir) return crypto.randomBytes(32); // in-memory server: nothing outlives the process anyway
    const file = path.join(this.opts.dataDir, 'master.key');
    try { return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); } catch { /* first start */ }
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
    return key;
  }

  private loadSigningKey(): SigningKey {
    const sealed = this.store.getMeta('signing_key');
    if (sealed) return signingKeyFromPem(open(this.master, sealed, 'signing-key'));
    const { key, privatePem } = generateSigningKey();
    this.store.setMeta('signing_key', seal(this.master, privatePem, 'signing-key'));
    return key;
  }

  private tenantSecretKey(tenantId: string): Buffer { return tenantKey(this.master, tenantId); }

  // ── tenants (also used by the bootstrap command and tests) ────────
  createTenant(input: { slug: string; name: string; ownerEmail: string; ownerName?: string; settings?: Partial<TenantSettings> & { idp?: { issuer: string; clientId: string; clientSecret?: string; scopes?: string } } }): { tenant: Tenant; owner: User } {
    if (!/^[a-z0-9][a-z0-9-]{1,38}$/.test(input.slug)) throw new HttpError(400, 'invalid_request', 'The tenant slug must be 2-39 lowercase letters, digits or dashes.');
    const { idp, ...rest } = input.settings ?? {};
    const tenant = this.store.createTenant(input.slug, input.name, rest);
    if (idp) this.setIdp(tenant.id, idp);
    const owner = this.store.createUser(tenant.id, { email: input.ownerEmail, name: input.ownerName ?? '', role: 'owner' });
    this.record(tenant.id, { kind: 'admin', action: 'tenant.create', outcome: 'ok', userId: null, body: { slug: input.slug } });
    return { tenant: this.store.getTenant(tenant.id)!, owner };
  }

  private setIdp(tenantId: string, idp: { issuer: string; clientId: string; clientSecret?: string; scopes?: string }): void {
    const t = this.store.getTenant(tenantId)!;
    const prev = t.settings.idp;
    const sealed = idp.clientSecret ? seal(this.tenantSecretKey(tenantId), idp.clientSecret, `idp-secret:${tenantId}`) : prev?.clientSecretSealed;
    this.store.updateTenant(tenantId, { settings: { idp: { issuer: idp.issuer, clientId: idp.clientId, ...(sealed ? { clientSecretSealed: sealed } : {}), ...(idp.scopes ? { scopes: idp.scopes } : {}) } } });
  }

  private idpOf(t: Tenant): IdpConfig {
    const i = t.settings.idp;
    if (!i) throw new HttpError(400, 'idp_not_configured', 'This organisation has no identity provider configured yet.');
    return { issuer: i.issuer, clientId: i.clientId, ...(i.clientSecretSealed ? { clientSecret: open(this.tenantSecretKey(t.id), i.clientSecretSealed, `idp-secret:${t.id}`) } : {}), ...(i.scopes ? { scopes: i.scopes } : {}) };
  }

  // ── audit of the server's own actions ─────────────────────────────
  record(tenantId: string, e: { kind: string; action: string; outcome: string; userId: string | null; userEmail?: string | null; deviceId?: string | null; body?: Record<string, unknown> }): void {
    const at = this.now();
    const input: AuditInput = {
      recordId: `ctl_${newId('r')}`, tsMs: at, source: 'control', userId: e.userId, userEmail: e.userEmail ?? null, deviceId: e.deviceId ?? null,
      kind: e.kind, action: e.action, outcome: e.outcome,
      body: { schema: 'aico.control.event/1', time: new Date(at).toISOString(), kind: e.kind, action: e.action, outcome: e.outcome, ...(e.userEmail ? { user: e.userEmail } : {}), ...(e.body ?? {}) },
    };
    this.store.appendAudit(tenantId, [input]);
  }

  // ── urls ──────────────────────────────────────────────────────────
  private origin(req: http.IncomingMessage): string {
    if (this.publicUrl) return this.publicUrl;
    return `http://${String(req.headers.host ?? 'localhost')}`;
  }
  private get secure(): boolean { return Boolean(this.publicUrl?.startsWith('https:')); }
  private clientIp(req: http.IncomingMessage): string {
    if (this.opts.behindProxy) {
      const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
      if (fwd.length) return fwd[fwd.length - 1]!;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  // ── lifecycle ─────────────────────────────────────────────────────
  readonly handler = (req: http.IncomingMessage, res: http.ServerResponse): void => { void this.dispatch(req, res); };

  async listen(port: number, host = '127.0.0.1', tls?: { cert: string; key: string }): Promise<number> {
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!loopback && !tls && !this.opts.behindProxy) throw new Error('Refusing to listen on a non-loopback address without TLS. Pass --tls-cert and --tls-key, or --behind-proxy when a TLS proxy terminates https in front of this server.');
    if (this.opts.behindProxy && !this.publicUrl?.startsWith('https:')) throw new Error('--behind-proxy needs --public-url https://... so that cookies are Secure and links are https.');
    this.server = tls ? https.createServer({ cert: tls.cert, key: tls.key }, this.handler) : http.createServer(this.handler);
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, host, resolve); });
    const actual = (this.server.address() as { port: number }).port;
    if (!this.publicUrl) this.publicUrl = `${tls ? 'https' : 'http'}://${host === '::1' ? '[::1]' : host}:${actual}`;
    return actual;
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => { if (!this.server) return resolve(); this.server.close(() => resolve()); this.server.closeAllConnections?.(); });
    try { this.store.db.close(); } catch { /* already closed */ }
  }

  // ── dispatch ──────────────────────────────────────────────────────
  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    securityHeaders(res, this.secure);
    const ctx: Ctx = { req, res, url: new URL(req.url ?? '/', 'http://x'), method: (req.method ?? 'GET').toUpperCase(), ip: this.clientIp(req), params: {} };
    try {
      if (this.opts.behindProxy && String(req.headers['x-forwarded-proto'] ?? '') !== 'https') throw new HttpError(400, 'https_required', 'This server only answers over https.');
      await this.route(ctx);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) {
        const wantsHtml = String(req.headers.accept ?? '').includes('text/html') && !ctx.url.pathname.startsWith('/v1/') && !ctx.url.pathname.startsWith('/oauth/');
        if (wantsHtml) sendText(res, e.status, 'text/html', messagePage('Something went wrong', e.message), e.status === 429 ? { 'retry-after': '60' } : {});
        else sendJson(res, e.status, { error: e.code, message: e.message, ...e.extra }, e.status === 401 && ctx.url.pathname.startsWith('/v1/engine') ? { 'www-authenticate': 'Bearer' } : {});
        return;
      }
      process.stderr.write(`control: unhandled ${e instanceof Error ? e.name : 'error'} on ${ctx.method} ${ctx.url.pathname}\n`);
      sendJson(res, 500, { error: 'server_error', message: 'Something went wrong on the server.' });
    }
  }

  private limit(key: string, max: number, windowMs = 60_000): void {
    if (!this.limiter.allow(key, max, windowMs)) throw new HttpError(429, 'rate_limited', 'Too many requests; wait a minute and try again.');
  }

  private async route(c: Ctx): Promise<void> {
    const p = c.url.pathname;
    const is = (method: string, pattern: string): boolean => {
      if (c.method !== method) return false;
      const m = match(pattern, p);
      if (m) c.params = m;
      return Boolean(m);
    };

    if (is('GET', '/healthz')) return sendJson(c.res, 200, { ok: true });

    // People: OIDC sign-in.
    if (is('GET', '/auth/login')) { this.limit(`auth:${c.ip}`, 60); return this.authLogin(c); }
    if (is('GET', '/auth/callback')) { this.limit(`auth:${c.ip}`, 60); return this.authCallback(c); }
    if (is('POST', '/auth/logout')) return this.authLogout(c);
    if (is('GET', '/v1/public')) {
      const all = this.store.listTenants();
      return sendJson(c.res, 200, { defaultTenant: all.length === 1 ? all[0]!.slug : null });
    }
    if (is('GET', '/v1/me')) return this.me(c);

    // The device authorization grant (RFC 8628).
    if (is('POST', '/oauth/device_authorization')) { this.limit(`devauth:${c.ip}`, 20); return this.deviceAuthorization(c); }
    if (is('POST', '/oauth/token')) { this.limit(`token:${c.ip}`, 240); return this.token(c); }
    if (is('GET', '/device')) return this.devicePageGet(c);
    if (is('POST', '/device/decision')) return this.deviceDecision(c);

    // Engines.
    if (is('GET', '/v1/engine/policy')) return this.enginePolicy(c);
    if (is('POST', '/v1/engine/audit')) return this.engineAudit(c);
    if (is('POST', '/v1/engine/usage')) return this.engineUsage(c);

    // The admin API.
    if (p.startsWith('/v1/admin/')) return this.admin(c, is);

    if (p.startsWith('/v1/') || p.startsWith('/oauth/') || p.startsWith('/auth/')) throw new HttpError(404, 'not_found', 'No such endpoint.');
    return this.serveStatic(c);
  }

  // ── authentication helpers ────────────────────────────────────────
  private sessionCookie(): string { return this.secure ? '__Host-aico_sid' : 'aico_sid'; }

  private sessionAuth(c: Ctx, o: { csrf: boolean }): SessionAuth {
    const raw = cookies(c.req)[this.sessionCookie()];
    if (!raw) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
    const idHash = sha256hex(raw);
    const session = this.store.getSession(idHash);
    const now = this.now();
    if (!session || session.expiresAt <= now || now - session.lastSeenAt > SESSION_IDLE_MS) {
      if (session) this.store.deleteSession(session.tenantId, idHash);
      throw new HttpError(401, 'unauthenticated', 'Your session has ended; sign in again.');
    }
    const user = this.store.getUser(session.tenantId, session.userId);
    const tenant = this.store.getTenant(session.tenantId);
    if (!user || !tenant || user.status !== 'active') {
      this.store.deleteSession(session.tenantId, idHash);
      throw new HttpError(401, 'unauthenticated', 'This account is not active.');
    }
    if (o.csrf) this.checkCsrf(c, session.csrf);
    this.store.touchSession(session.tenantId, idHash);
    return { session, user, tenant, perms: permissionsOf(user.role) };
  }

  /** State-changing cookie requests: same origin AND the session's token. Both, because either alone has known bypasses. */
  private checkCsrf(c: Ctx, csrf: string, formToken?: string): void {
    if (c.method === 'GET' || c.method === 'HEAD' || c.method === 'OPTIONS') return;
    const origin = c.req.headers.origin;
    if (origin !== undefined && origin !== this.origin(c.req)) throw new HttpError(403, 'csrf', 'Cross-origin request refused.');
    if (origin === undefined && String(c.req.headers['sec-fetch-site'] ?? 'same-origin') === 'cross-site') throw new HttpError(403, 'csrf', 'Cross-site request refused.');
    const sent = formToken ?? String(c.req.headers['x-csrf-token'] ?? '');
    if (!sent || !safeEqual(sent, csrf)) throw new HttpError(403, 'csrf', 'The request is missing its CSRF token; reload the page.');
  }

  private need(a: SessionAuth, perm: Permission): void {
    if (!a.perms.includes(perm)) throw new HttpError(403, 'forbidden', `Your role (${a.user.role}) cannot do this (needs ${perm}).`);
  }

  private deviceAuth(c: Ctx): DeviceAuth {
    const m = /^Bearer (.+)$/.exec(String(c.req.headers.authorization ?? ''));
    const claims = m ? verifyJwt(this.signingKey, m[1]!, Math.floor(this.now() / 1000)) : undefined;
    if (!claims || typeof claims.tid !== 'string' || typeof claims.sub !== 'string' || typeof claims.did !== 'string') throw new HttpError(401, 'invalid_token', 'The access token is missing, invalid or expired.');
    const tenant = this.store.getTenant(claims.tid);
    const user = tenant && this.store.getUser(tenant.id, claims.sub);
    const device = tenant && this.store.getDevice(tenant.id, claims.did);
    if (!tenant || !user || !device || device.revokedAt || device.userId !== user.id || user.status !== 'active' || !can(user.role, 'engine.use')) {
      throw new HttpError(401, 'invalid_token', 'This device is no longer enrolled.');
    }
    this.limit(`engine:${device.id}`, 600);
    return { user, tenant, device };
  }

  // ── OIDC sign-in ──────────────────────────────────────────────────
  private async authLogin(c: Ctx): Promise<void> {
    const slug = str(c.url.searchParams.get('tenant'), 40) ?? (this.store.listTenants().length === 1 ? this.store.listTenants()[0]!.slug : undefined);
    const tenant = slug ? this.store.getTenantBySlug(slug) : undefined;
    if (!tenant) throw new HttpError(404, 'unknown_tenant', 'No such organisation.');
    const idp = this.idpOf(tenant);
    const redirectUri = `${this.origin(c.req)}/auth/callback`;
    const start = await startFlow(idp, redirectUri, { allowInsecureIdp: this.opts.allowInsecureIdp, now: this.now }, str(c.url.searchParams.get('hint'), 200)).catch((e: unknown) => {
      throw new HttpError(502, 'idp_unavailable', e instanceof OidcError ? e.message : 'The identity provider could not be reached.');
    });
    this.store.createFlow(tenant.id, sha256hex(start.state), { verifier: start.verifier, nonce: start.nonce, next: safeNext(c.url.searchParams.get('next')) });
    redirect(c.res, start.url);
  }

  private async authCallback(c: Ctx): Promise<void> {
    const state = c.url.searchParams.get('state') ?? '';
    const flow = state ? this.store.takeFlow(sha256hex(state)) : undefined;
    if (!flow || this.now() - flow.createdAt > 600_000) throw new HttpError(400, 'invalid_state', 'This sign-in link has expired or was already used; start again.');
    const tenant = this.store.getTenant(flow.tenantId)!;
    const err = c.url.searchParams.get('error');
    if (err) {
      this.record(tenant.id, { kind: 'auth', action: 'login', outcome: 'denied', userId: null, body: { reason: `idp: ${err.slice(0, 80)}` } });
      throw new HttpError(403, 'idp_denied', 'The identity provider did not sign you in.');
    }
    const code = c.url.searchParams.get('code');
    if (!code) throw new HttpError(400, 'invalid_request', 'The identity provider returned no code.');
    const claims = await completeFlow(this.idpOf(tenant), `${this.origin(c.req)}/auth/callback`, code, flow.verifier, flow.nonce, { allowInsecureIdp: this.opts.allowInsecureIdp, now: this.now })
      .catch((e: unknown) => {
        this.record(tenant.id, { kind: 'auth', action: 'login', outcome: 'error', userId: null, body: { reason: e instanceof OidcError ? e.message.slice(0, 160) : 'idp error' } });
        throw new HttpError(401, 'invalid_id_token', e instanceof OidcError ? e.message : 'Sign-in failed.');
      });
    let user = this.store.findUserByExternal(tenant.id, claims.sub) ?? this.store.findUserByEmail(tenant.id, claims.email);
    if (!user) {
      if (!tenant.settings.jit) {
        this.record(tenant.id, { kind: 'auth', action: 'login', outcome: 'denied', userId: null, userEmail: claims.email, body: { reason: 'no such user' } });
        throw new HttpError(403, 'no_account', `${claims.email} has not been added to ${tenant.name}. Ask an administrator.`);
      }
      user = this.store.createUser(tenant.id, { email: claims.email, name: claims.name, role: 'developer', source: 'jit', externalId: claims.sub });
      this.record(tenant.id, { kind: 'admin', action: 'user.create', outcome: 'ok', userId: user.id, userEmail: user.email, body: { source: 'jit' } });
    }
    if (user.status !== 'active') {
      this.record(tenant.id, { kind: 'auth', action: 'login', outcome: 'denied', userId: user.id, userEmail: user.email, body: { reason: 'disabled' } });
      throw new HttpError(403, 'disabled', 'This account is disabled.');
    }
    if (user.externalId && user.externalId !== claims.sub) throw new HttpError(403, 'identity_mismatch', 'This account is linked to a different identity.');
    if (!user.externalId || (!user.name && claims.name)) this.store.updateUser(tenant.id, user.id, { externalId: claims.sub, ...(!user.name && claims.name ? { name: claims.name } : {}) });
    this.store.touchLogin(tenant.id, user.id);

    const sid = randomToken(32);
    this.store.createSession(tenant.id, user.id, sha256hex(sid), randomToken(24), SESSION_ABSOLUTE_MS);
    setCookie(c.res, this.sessionCookie(), sid, { secure: this.secure, maxAgeS: SESSION_ABSOLUTE_MS / 1000 });
    this.record(tenant.id, { kind: 'auth', action: 'login', outcome: 'ok', userId: user.id, userEmail: user.email });
    redirect(c.res, flow.next);
  }

  private async authLogout(c: Ctx): Promise<void> {
    const a = this.sessionAuth(c, { csrf: true });
    this.store.deleteSession(a.tenant.id, a.session.idHash);
    setCookie(c.res, this.sessionCookie(), '', { secure: this.secure, maxAgeS: 0 });
    this.record(a.tenant.id, { kind: 'auth', action: 'logout', outcome: 'ok', userId: a.user.id, userEmail: a.user.email });
    sendJson(c.res, 200, { ok: true });
  }

  private me(c: Ctx): void {
    const a = this.sessionAuth(c, { csrf: false });
    sendJson(c.res, 200, {
      user: { id: a.user.id, email: a.user.email, name: a.user.name, role: a.user.role, teamId: a.user.teamId },
      tenant: { slug: a.tenant.slug, name: a.tenant.name }, permissions: a.perms, portal: hasPortalAccess(a.user.role), csrf: a.session.csrf,
    });
  }

  // ── device flow ───────────────────────────────────────────────────
  private async deviceAuthorization(c: Ctx): Promise<void> {
    const body = await readParams(c.req, 16 * 1024);
    if (body.client_id !== CLIENT_ID) throw new HttpError(401, 'invalid_client', 'Unknown client_id.');
    const slug = str(body.tenant, 40) ?? (this.store.listTenants().length === 1 ? this.store.listTenants()[0]!.slug : undefined);
    const tenant = slug ? this.store.getTenantBySlug(slug) : undefined;
    if (!tenant) throw new HttpError(400, 'invalid_request', 'Name your organisation with "tenant".');
    let code = userCode();
    for (let i = 0; i < 10 && this.store.userCodeTaken(tenant.id, code); i++) code = userCode();
    const deviceCode = randomToken(32);
    this.store.createGrant(tenant.id, {
      deviceCodeHash: sha256hex(deviceCode), userCode: code, intervalS: GRANT_INTERVAL_S, ttlMs: GRANT_TTL_MS,
      deviceName: (str(body.device_name, 80) ?? 'unnamed device').replace(/[\u0000-\u001f]/g, ' '),
      platform: (str(body.platform, 40) ?? '').replace(/[\u0000-\u001f]/g, ' '), aicoVersion: (str(body.aico_version, 20) ?? '').replace(/[^0-9a-zA-Z.\-+]/g, ''),
    });
    const base = `${this.origin(c.req)}/device`;
    sendJson(c.res, 200, {
      device_code: deviceCode, user_code: code, verification_uri: base,
      verification_uri_complete: `${base}?tenant=${encodeURIComponent(tenant.slug)}&code=${encodeURIComponent(code)}`,
      expires_in: GRANT_TTL_MS / 1000, interval: GRANT_INTERVAL_S, tenant: tenant.slug,
    });
  }

  private tokenError(c: Ctx, error: string, message: string, status = 400): void {
    sendJson(c.res, status, { error, error_description: message });
  }

  private async token(c: Ctx): Promise<void> {
    const body = await readParams(c.req, 16 * 1024);
    if (body.client_id !== CLIENT_ID) return this.tokenError(c, 'invalid_client', 'Unknown client_id.', 401);
    if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') return this.tokenFromDeviceCode(c, String(body.device_code ?? ''));
    if (body.grant_type === 'refresh_token') return this.tokenFromRefresh(c, String(body.refresh_token ?? ''));
    this.tokenError(c, 'unsupported_grant_type', 'Use the device_code or refresh_token grant.');
  }

  private tokenFromDeviceCode(c: Ctx, deviceCode: string): void {
    const grant = deviceCode ? this.store.grantByDeviceCode(sha256hex(deviceCode)) : undefined;
    if (!grant) return this.tokenError(c, 'invalid_grant', 'Unknown or already used device code.');
    const now = this.now();
    if (grant.expiresAt <= now) { this.store.deleteGrant(grant.tenantId, grant.id); return this.tokenError(c, 'expired_token', 'The code expired; start again.'); }
    if (grant.lastPollAt !== null && now - grant.lastPollAt < grant.intervalS * 1000) {
      // RFC 8628 3.5: polling too fast raises the interval for the rest of the grant.
      this.store.setGrant(grant.tenantId, grant.id, { lastPollAt: now, intervalS: grant.intervalS + 5 });
      return this.tokenError(c, 'slow_down', `Poll no faster than every ${grant.intervalS + 5} seconds.`);
    }
    this.store.setGrant(grant.tenantId, grant.id, { lastPollAt: now });
    if (grant.status === 'pending') return this.tokenError(c, 'authorization_pending', 'Waiting for the person to approve in the browser.');
    if (grant.status === 'denied') { this.store.deleteGrant(grant.tenantId, grant.id); return this.tokenError(c, 'access_denied', 'The request was denied.'); }
    if (grant.status !== 'approved' || !grant.userId) return this.tokenError(c, 'invalid_grant', 'Unknown or already used device code.');
    const tenant = this.store.getTenant(grant.tenantId)!;
    const user = this.store.getUser(grant.tenantId, grant.userId);
    if (!user || user.status !== 'active' || !can(user.role, 'engine.use')) return this.tokenError(c, 'access_denied', 'This account cannot enrol a device.');
    this.store.setGrant(grant.tenantId, grant.id, { status: 'consumed' });
    this.store.deleteGrant(grant.tenantId, grant.id);
    const device = this.store.createDevice(tenant.id, { userId: user.id, name: grant.deviceName, platform: grant.platform, aicoVersion: grant.aicoVersion });
    this.record(tenant.id, { kind: 'device', action: 'enrol', outcome: 'ok', userId: user.id, userEmail: user.email, deviceId: device.id, body: { name: device.name, platform: device.platform } });
    sendJson(c.res, 200, this.issue(tenant, user, device), { 'cache-control': 'no-store', pragma: 'no-cache' });
  }

  private tokenFromRefresh(c: Ctx, token: string): void {
    const row = token ? this.store.refreshByHash(sha256hex(token)) : undefined;
    if (!row) return this.tokenError(c, 'invalid_grant', 'Unknown refresh token.');
    const tenant = this.store.getTenant(row.tenantId)!;
    const device = this.store.getDevice(tenant.id, row.deviceId);
    const user = device && this.store.getUser(tenant.id, device.userId);
    if (!device || !user) return this.tokenError(c, 'invalid_grant', 'Unknown refresh token.');
    if (row.usedAt !== null) {
      // A spent token came back: either the engine or a thief holds a stale copy. Neither can be trusted again.
      if (this.store.revokeDevice(tenant.id, device.id, 'refresh-token-reuse')) {
        this.record(tenant.id, { kind: 'device', action: 'revoke', outcome: 'denied', userId: user.id, userEmail: user.email, deviceId: device.id, body: { reason: 'refresh token reuse detected' } });
      }
      return this.tokenError(c, 'invalid_grant', 'This refresh token was already used; the device was revoked. Sign in again.');
    }
    if (device.revokedAt || user.status !== 'active' || !can(user.role, 'engine.use') || row.expiresAt <= this.now()) return this.tokenError(c, 'invalid_grant', 'This device is no longer enrolled. Sign in again.');
    if (!this.store.markRefreshUsed(tenant.id, row.id)) return this.tokenError(c, 'invalid_grant', 'This refresh token was already used.');
    this.store.touchDevice(tenant.id, device.id);
    sendJson(c.res, 200, this.issue(tenant, user, device), { 'cache-control': 'no-store', pragma: 'no-cache' });
  }

  private issue(tenant: Tenant, user: User, device: Device): Record<string, unknown> {
    const iat = Math.floor(this.now() / 1000);
    const access = signJwt(this.signingKey, { iss: 'aico-control', sub: user.id, tid: tenant.id, did: device.id, iat, exp: iat + ACCESS_TTL_S, jti: randomToken(12) });
    const refresh = randomToken(32);
    this.store.addRefreshToken(tenant.id, device.id, sha256hex(refresh), REFRESH_TTL_MS);
    return {
      access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'engine',
      tenant: { slug: tenant.slug, name: tenant.name }, user: { email: user.email, name: user.name, role: user.role }, device_id: device.id,
    };
  }

  // The browser half of the device flow: a small server-rendered page, no SPA needed.
  private devicePageGet(c: Ctx): void {
    let a: SessionAuth;
    try { a = this.sessionAuth(c, { csrf: false }); } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 401) throw e;
      const next = `/device${c.url.search}`;
      const tenant = c.url.searchParams.get('tenant');
      return redirect(c.res, `/auth/login?${new URLSearchParams({ ...(tenant ? { tenant } : {}), next }).toString()}`);
    }
    const code = normaliseUserCode(c.url.searchParams.get('code') ?? '');
    const grant = code ? this.store.grantByUserCode(a.tenant.id, code) : undefined;
    const usable = grant && grant.status === 'pending' && grant.expiresAt > this.now();
    if (code && !usable) this.countWrong(a);
    sendText(c.res, 200, 'text/html', devicePage({ email: a.user.email, tenantName: a.tenant.name, csrf: a.session.csrf, code, grant: usable ? { deviceName: grant.deviceName, platform: grant.platform, aicoVersion: grant.aicoVersion } : undefined, notFound: Boolean(code && !usable) }));
  }

  private countWrong(a: SessionAuth): void {
    const n = this.store.failApproval(a.tenant.id, a.session.idHash);
    if (n > MAX_WRONG_CODES) throw new HttpError(429, 'too_many_attempts', 'Too many wrong codes. Sign out and sign in again to continue.');
  }

  private async deviceDecision(c: Ctx): Promise<void> {
    const a = this.sessionAuth(c, { csrf: false });
    const body = await readParams(c.req, 4096);
    this.checkCsrf(c, a.session.csrf, typeof body.csrf === 'string' ? body.csrf : undefined);
    this.limit(`approve:${a.session.idHash}`, 30);
    if (!a.perms.includes('engine.use')) throw new HttpError(403, 'forbidden', 'Your role cannot enrol a device.');
    const grant = this.store.grantByUserCode(a.tenant.id, normaliseUserCode(String(body.code ?? '')));
    if (!grant || grant.status !== 'pending' || grant.expiresAt <= this.now()) {
      this.countWrong(a);
      throw new HttpError(400, 'invalid_code', 'That code is wrong or has expired.');
    }
    const approve = body.decision === 'approve';
    this.store.setGrant(a.tenant.id, grant.id, { status: approve ? 'approved' : 'denied', userId: a.user.id });
    this.record(a.tenant.id, { kind: 'device', action: approve ? 'approve' : 'deny', outcome: approve ? 'ok' : 'denied', userId: a.user.id, userEmail: a.user.email, body: { name: grant.deviceName } });
    sendText(c.res, 200, 'text/html', messagePage(approve ? 'Device connected' : 'Request denied', approve ? `You can close this tab. ${grant.deviceName} is now signed in to ${a.tenant.name}.` : 'Nothing was connected.'));
  }

  // ── engine API ────────────────────────────────────────────────────
  private enginePolicy(c: Ctx): void {
    const a = this.deviceAuth(c);
    this.store.touchDevice(a.tenant.id, a.device.id, str(c.req.headers['x-aico-version'], 20));
    const nowMs = this.now();
    const lease = leaseFor(this.store, a.tenant, a.user, nowMs);
    const layers = layersFor(this.store, a.tenant, a.user, lease);
    const team = a.user.teamId ? this.store.getTeam(a.tenant.id, a.user.teamId) : undefined;
    sendJson(c.res, 200, {
      schema: 'aico.control.policy/1', tenant: { slug: a.tenant.slug, name: a.tenant.name },
      user: { email: a.user.email, name: a.user.name }, role: a.user.role, ...(team ? { team: { name: team.name } } : {}),
      issuedAt: new Date(nowMs).toISOString(), graceHours: a.tenant.settings.graceHours, pollSeconds: a.tenant.settings.pollSeconds,
      layers, lease, hash: layersHash(layers),
    });
  }

  private async engineAudit(c: Ctx): Promise<void> {
    const a = this.deviceAuth(c);
    const body = await readParams(c.req, 4 * 1024 * 1024);
    const records = Array.isArray(body.records) ? body.records : undefined;
    if (!records || records.length > 1000) throw new HttpError(400, 'invalid_request', 'Send { "records": [ up to 1000 aico.audit/1 records ] }.');
    const inputs: AuditInput[] = [];
    let rejected = 0;
    for (const raw of records) {
      if (!isObj(raw)) { rejected++; continue; }
      const id = str(raw.id, 200);
      const kind = str(raw.kind, 40);
      const action = str(raw.action, 120);
      const outcome = str(raw.outcome, 40);
      const at = typeof raw.time === 'string' ? Date.parse(raw.time) : NaN;
      if (!id || !kind || !action || !outcome || !Number.isFinite(at)) { rejected++; continue; }
      const clean: Record<string, unknown> = {};
      for (const f of AUDIT_FIELDS) {
        const v = raw[f];
        if (typeof v === 'string') clean[f] = v.slice(0, 2000);
        else if (typeof v === 'number' && Number.isFinite(v)) clean[f] = v;
      }
      // Identity is the token's, whatever the record says.
      clean.user = a.user.email;
      clean.tenant = a.tenant.slug;
      clean.schema = 'aico.audit/1';
      inputs.push({ recordId: `${a.user.id}:${id}`, tsMs: at, source: 'engine', userId: a.user.id, userEmail: a.user.email, deviceId: a.device.id, kind, action, outcome, body: clean });
    }
    const out = this.store.appendAudit(a.tenant.id, inputs);
    sendJson(c.res, 200, { accepted: out.appended, duplicates: out.duplicates, rejected, head: out.head });
  }

  private async engineUsage(c: Ctx): Promise<void> {
    const a = this.deviceAuth(c);
    const body = await readParams(c.req, 2 * 1024 * 1024);
    const events = Array.isArray(body.events) ? body.events : undefined;
    if (!events || events.length > 2000) throw new HttpError(400, 'invalid_request', 'Send { "events": [ up to 2000 usage events ] }.');
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    this.store.tx(() => {
      for (const e of events) {
        if (!isObj(e)) { rejected++; continue; }
        const id = str(e.id, 200);
        const at = typeof e.at === 'number' ? e.at : typeof e.at === 'string' ? Date.parse(e.at) : NaN;
        const input = finite(e.inputTokens ?? 0, 0, 1e9);
        const output = finite(e.outputTokens ?? 0, 0, 1e9);
        const cost = finite(e.costUsd ?? 0, 0, 10_000);
        if (!id || !Number.isFinite(at) || input === undefined || output === undefined || cost === undefined) { rejected++; continue; }
        const fresh = this.store.insertUsage(a.tenant.id, {
          eventId: `${a.user.id}:${id}`, userId: a.user.id, teamId: a.user.teamId, deviceId: a.device.id, atMs: at,
          model: str(e.model, 120) ?? '', provider: str(e.provider, 60) ?? '', inputTokens: Math.trunc(input), outputTokens: Math.trunc(output), costUsd: cost, project: str(e.project, 200) ?? '',
        });
        if (fresh) accepted++; else duplicates++;
      }
    });
    sendJson(c.res, 200, { accepted, duplicates, rejected, lease: leaseFor(this.store, a.tenant, a.user, this.now()) });
  }

  // ── admin API ─────────────────────────────────────────────────────
  private async admin(c: Ctx, is: (m: string, p: string) => boolean): Promise<void> {
    const mutating = c.method !== 'GET';
    const a = this.sessionAuth(c, { csrf: mutating });
    if (!hasPortalAccess(a.user.role)) throw new HttpError(403, 'forbidden', 'Your role has no access to the admin portal.');
    const tid = a.tenant.id;
    const body = mutating ? await readParams(c.req, 256 * 1024) : {};
    const reply = (status: number, value: unknown): void => sendJson(c.res, status, value);
    const log = (action: string, extra: Record<string, unknown> = {}): void =>
      this.record(tid, { kind: 'admin', action, outcome: 'ok', userId: a.user.id, userEmail: a.user.email, body: extra });
    const teamFilter = (): { teamId?: string } | 'none' => (isTeamScoped(a.user.role) ? (a.user.teamId ? { teamId: a.user.teamId } : 'none') : {});

    // tenant
    if (is('GET', '/v1/admin/tenant')) {
      this.need(a, 'tenant.read');
      const s = a.tenant.settings;
      return reply(200, {
        slug: a.tenant.slug, name: a.tenant.name,
        settings: { graceHours: s.graceHours, jit: s.jit, pollSeconds: s.pollSeconds, idp: s.idp ? { issuer: s.idp.issuer, clientId: s.idp.clientId, scopes: s.idp.scopes ?? '', hasSecret: Boolean(s.idp.clientSecretSealed) } : null },
        serverUrl: this.publicUrl ?? null,
      });
    }
    if (is('PUT', '/v1/admin/tenant')) {
      this.need(a, 'tenant.manage');
      const patch: Partial<TenantSettings> = {};
      const grace = body.graceHours === undefined ? undefined : finite(body.graceHours, 0, 8760);
      const poll = body.pollSeconds === undefined ? undefined : finite(body.pollSeconds, 30, 3600);
      if (body.graceHours !== undefined && grace === undefined) throw new HttpError(400, 'invalid_request', 'graceHours must be 0-8760.');
      if (body.pollSeconds !== undefined && poll === undefined) throw new HttpError(400, 'invalid_request', 'pollSeconds must be 30-3600.');
      if (grace !== undefined) patch.graceHours = Math.trunc(grace);
      if (poll !== undefined) patch.pollSeconds = Math.trunc(poll);
      if (typeof body.jit === 'boolean') patch.jit = body.jit;
      if (isObj(body.idp)) {
        const issuer = str(body.idp.issuer, 300);
        const clientId = str(body.idp.clientId, 300);
        if (!issuer || !clientId || !/^https?:\/\//.test(issuer)) throw new HttpError(400, 'invalid_request', 'The identity provider needs an issuer URL and a client id.');
        this.setIdp(tid, { issuer, clientId, ...(str(body.idp.clientSecret, 500) ? { clientSecret: str(body.idp.clientSecret, 500)! } : {}), ...(str(body.idp.scopes, 200) ? { scopes: str(body.idp.scopes, 200)! } : {}) });
      }
      this.store.updateTenant(tid, { ...(str(body.name, 100) ? { name: str(body.name, 100)! } : {}), settings: patch });
      log('tenant.update', { fields: Object.keys(body) });
      return reply(200, { ok: true });
    }

    // roles
    if (is('GET', '/v1/admin/roles')) {
      this.need(a, 'roles.read');
      return reply(200, { permissions: PERMISSIONS, roles: ROLES.map(r => ({ ...ROLE_DEFS[r], members: this.store.listUsers(tid).filter(u => u.role === r).length })) });
    }

    // users
    if (is('GET', '/v1/admin/users')) {
      this.need(a, 'users.read');
      const f = teamFilter();
      const users = f === 'none' ? [] : this.store.listUsers(tid, f);
      return reply(200, { users: users.map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, teamId: u.teamId, status: u.status, source: u.source, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt })) });
    }
    if (is('POST', '/v1/admin/users')) {
      this.need(a, 'users.manage');
      const email = str(body.email, 200)?.toLowerCase();
      const role = String(body.role ?? 'developer');
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'invalid_request', 'Give a valid email address.');
      if (!isRole(role) || !canAssign(a.user.role, role)) throw new HttpError(403, 'forbidden', `You cannot assign the role ${JSON.stringify(role)}.`);
      const teamId = str(body.teamId, 80) ?? null;
      if (teamId && !this.store.getTeam(tid, teamId)) throw new HttpError(400, 'invalid_request', 'No such team.');
      if (this.store.findUserByEmail(tid, email)) throw new HttpError(409, 'exists', 'That email already has an account.');
      const user = this.store.createUser(tid, { email, name: str(body.name, 120) ?? '', role, teamId });
      log('user.create', { target: email, role });
      return reply(201, { id: user.id });
    }
    let m = match('/v1/admin/users/:id', c.url.pathname);
    if (m && c.method === 'PATCH') {
      this.need(a, 'users.manage');
      const target = this.store.getUser(tid, m.id!);
      if (!target) throw new HttpError(404, 'not_found', 'No such user.');
      const patch: Parameters<Store['updateUser']>[2] = {};
      if (body.role !== undefined) {
        if (target.id === a.user.id) throw new HttpError(403, 'forbidden', 'You cannot change your own role.');
        if (!isRole(body.role) || !canAssign(a.user.role, body.role) || !canAssign(a.user.role, target.role)) throw new HttpError(403, 'forbidden', 'You cannot assign that role.');
        patch.role = body.role;
      }
      if (body.status !== undefined) {
        if (body.status !== 'active' && body.status !== 'disabled') throw new HttpError(400, 'invalid_request', 'status must be active or disabled.');
        if (target.id === a.user.id) throw new HttpError(403, 'forbidden', 'You cannot disable yourself.');
        if (!canAssign(a.user.role, target.role)) throw new HttpError(403, 'forbidden', 'Only an owner can change an owner.');
        patch.status = body.status;
      }
      if (body.teamId !== undefined) {
        const t = body.teamId === null ? null : str(body.teamId, 80);
        if (t && !this.store.getTeam(tid, t)) throw new HttpError(400, 'invalid_request', 'No such team.');
        patch.teamId = t ?? null;
      }
      if (body.name !== undefined) patch.name = str(body.name, 120) ?? '';
      const demotesOwner = target.role === 'owner' && ((patch.role && patch.role !== 'owner') || patch.status === 'disabled');
      if (demotesOwner && this.store.countActiveOwners(tid) <= 1) throw new HttpError(409, 'last_owner', 'An organisation needs at least one active owner.');
      this.store.updateUser(tid, target.id, patch);
      if (patch.status === 'disabled') { this.store.revokeDevicesOf(tid, target.id, 'user-disabled'); this.store.deleteSessionsOf(tid, target.id); }
      log('user.update', { target: target.email, ...patch });
      return reply(200, { ok: true });
    }

    // teams
    if (is('GET', '/v1/admin/teams')) {
      this.need(a, 'teams.read');
      const f = teamFilter();
      const teams = this.store.listTeams(tid).filter(t => f === 'none' ? false : !f.teamId || t.id === f.teamId);
      return reply(200, { teams: teams.map(t => ({ id: t.id, name: t.name, members: t.members })) });
    }
    if (is('POST', '/v1/admin/teams')) {
      this.need(a, 'teams.manage');
      const name = str(body.name, 80);
      if (!name) throw new HttpError(400, 'invalid_request', 'Give the team a name.');
      try { const t = this.store.createTeam(tid, name); log('team.create', { name }); return reply(201, { id: t.id }); } catch { throw new HttpError(409, 'exists', 'A team with that name exists.'); }
    }
    m = match('/v1/admin/teams/:id', c.url.pathname);
    if (m && c.method === 'PATCH') {
      this.need(a, 'teams.manage');
      const name = str(body.name, 80);
      if (!name) throw new HttpError(400, 'invalid_request', 'Give the team a name.');
      try { if (!this.store.renameTeam(tid, m.id!, name)) throw new HttpError(404, 'not_found', 'No such team.'); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(409, 'exists', 'A team with that name exists.'); }
      log('team.rename', { name });
      return reply(200, { ok: true });
    }
    if (m && c.method === 'DELETE') {
      this.need(a, 'teams.manage');
      const team = this.store.listTeams(tid).find(t => t.id === m!.id);
      if (!team) throw new HttpError(404, 'not_found', 'No such team.');
      if (team.members > 0) throw new HttpError(409, 'not_empty', 'Move the team\'s members first.');
      this.store.deleteTeam(tid, team.id);
      log('team.delete', { name: team.name });
      return reply(200, { ok: true });
    }

    // policies
    if (is('GET', '/v1/admin/policies')) {
      this.need(a, 'policies.read');
      return reply(200, { policies: this.store.listPolicies(tid).map(p => ({ id: p.id, scope: p.scope, scopeId: p.scopeId, name: p.name, doc: p.doc, updatedAt: p.updatedAt, updatedBy: p.updatedBy })) });
    }
    if (is('POST', '/v1/admin/policies/validate')) {
      this.need(a, 'policies.read');
      const v = validateDoc(body.doc);
      return reply(200, { ok: v.ok, problems: v.problems, rules: v.rules ?? [] });
    }
    if (is('PUT', '/v1/admin/policies')) {
      this.need(a, 'policies.manage');
      const scope = body.scope;
      if (scope !== 'tenant' && scope !== 'role' && scope !== 'team') throw new HttpError(400, 'invalid_request', 'scope must be tenant, role or team.');
      const scopeId = scope === 'tenant' ? '*' : String(body.scopeId ?? '');
      if (scope === 'role' && !isRole(scopeId)) throw new HttpError(400, 'invalid_request', 'Unknown role.');
      if (scope === 'team' && !this.store.getTeam(tid, scopeId)) throw new HttpError(400, 'invalid_request', 'No such team.');
      const v = validateDoc(body.doc);
      if (!v.ok) throw new HttpError(422, 'invalid_policy', 'The policy has errors; fix them and save again.', { problems: v.problems });
      const saved = this.store.upsertPolicy(tid, { scope, scopeId, name: str(body.name, 100) ?? `${scope} policy`, doc: body.doc as Record<string, unknown>, by: a.user.email });
      log('policy.save', { scope, scopeId, keys: Object.keys(saved.doc) });
      return reply(200, { id: saved.id, problems: v.problems });
    }
    m = match('/v1/admin/policies/:id', c.url.pathname);
    if (m && c.method === 'DELETE') {
      this.need(a, 'policies.manage');
      const p = this.store.getPolicy(tid, m.id!);
      if (!p) throw new HttpError(404, 'not_found', 'No such policy.');
      this.store.deletePolicy(tid, p.id);
      log('policy.delete', { scope: p.scope, scopeId: p.scopeId });
      return reply(200, { ok: true });
    }

    // devices
    if (is('GET', '/v1/admin/devices')) {
      this.need(a, 'devices.read');
      const f = teamFilter();
      const devices = f === 'none' ? [] : this.store.listDevices(tid, f);
      return reply(200, { devices: devices.map(d => ({ id: d.id, user: d.userEmail, name: d.name, platform: d.platform, aicoVersion: d.aicoVersion, enrolledAt: d.createdAt, lastSeenAt: d.lastSeenAt, revokedAt: d.revokedAt, revokedReason: d.revokedReason })) });
    }
    m = match('/v1/admin/devices/:id/revoke', c.url.pathname);
    if (m && c.method === 'POST') {
      this.need(a, 'devices.revoke');
      const d = this.store.getDevice(tid, m.id!);
      if (!d) throw new HttpError(404, 'not_found', 'No such device.');
      const changed = this.store.revokeDevice(tid, d.id, `revoked by ${a.user.email}`);
      if (changed) log('device.revoke', { device: d.name, deviceId: d.id });
      return reply(200, { ok: true, changed });
    }

    // audit
    if (is('GET', '/v1/admin/audit/verify')) {
      this.need(a, 'audit.read');
      return reply(200, this.store.verifyAudit(tid));
    }
    if (is('GET', '/v1/admin/audit/export')) {
      this.need(a, 'audit.export');
      const rows = this.store.queryAudit(tid, { limit: 5000, ...this.auditFilters(c.url) }).reverse();
      log('audit.export', { count: rows.length });
      if (c.url.searchParams.get('format') === 'csv') {
        const cell = (v: unknown): string => { let s = v === undefined || v === null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        const cols = ['seq', 'time', 'source', 'user', 'kind', 'action', 'outcome', 'tool', 'target', 'model', 'costUsd'];
        const lines = rows.map(r => cols.map(col => cell(col === 'seq' ? r.seq : col === 'time' ? new Date(r.tsMs).toISOString() : col === 'user' ? r.userEmail : col === 'source' ? r.source : (r.body as Record<string, unknown>)[col] ?? (col === 'kind' ? r.kind : col === 'action' ? r.action : col === 'outcome' ? r.outcome : ''))).join(','));
        return sendText(c.res, 200, 'text/csv', `${cols.join(',')}\r\n${lines.join('\r\n')}\r\n`, { 'content-disposition': 'attachment; filename="aico-control-audit.csv"' });
      }
      return sendText(c.res, 200, 'application/x-ndjson', rows.map(r => JSON.stringify({ seq: r.seq, hash: r.hash, source: r.source, ...r.body })).join('\n') + (rows.length ? '\n' : ''), { 'content-disposition': 'attachment; filename="aico-control-audit.jsonl"' });
    }
    if (is('GET', '/v1/admin/audit')) {
      this.need(a, 'audit.read');
      const rows = this.store.queryAudit(tid, this.auditFilters(c.url));
      return reply(200, { records: rows.map(r => ({ seq: r.seq, time: new Date(r.tsMs).toISOString(), source: r.source, user: r.userEmail, deviceId: r.deviceId, kind: r.kind, action: r.action, outcome: r.outcome, detail: r.body, hash: r.hash })) });
    }

    // usage and budgets
    if (is('GET', '/v1/admin/usage')) {
      this.need(a, 'usage.read');
      const by = String(c.url.searchParams.get('by') ?? 'user');
      if (by !== 'user' && by !== 'team' && by !== 'model' && by !== 'day') throw new HttpError(400, 'invalid_request', 'by must be user, team, model or day.');
      const f = teamFilter();
      const days = Number(c.url.searchParams.get('days') ?? 30);
      const sinceMs = this.now() - Math.min(Math.max(days, 1), 366) * 86_400_000;
      const rows = f === 'none' ? [] : this.store.usageSummary(tid, by, { sinceMs, ...(f.teamId ? { teamId: f.teamId } : {}) });
      return reply(200, { by, estimated: true, days, rows, totalUsd: Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6 });
    }
    if (is('GET', '/v1/admin/budgets')) {
      this.need(a, 'usage.read');
      const nowMs = this.now();
      const day = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
      const month = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), 1);
      return reply(200, { budgets: this.store.listBudgets(tid).map(b => ({ id: b.id, scope: b.scope, scopeId: b.scopeId, period: b.period, limitUsd: b.limitUsd, spentUsd: Math.round(this.store.spend(tid, b.scope, b.scopeId, b.period === 'day' ? day : month) * 1e6) / 1e6 })) });
    }
    if (is('PUT', '/v1/admin/budgets')) {
      this.need(a, 'budgets.manage');
      const scope = body.scope;
      const period = body.period;
      const limit = finite(body.limitUsd, 0.01, 1_000_000);
      if ((scope !== 'tenant' && scope !== 'team' && scope !== 'user') || (period !== 'day' && period !== 'month') || limit === undefined) throw new HttpError(400, 'invalid_request', 'Give scope (tenant|team|user), period (day|month) and limitUsd (> 0).');
      const scopeId = scope === 'tenant' ? '*' : String(body.scopeId ?? '');
      if (scope === 'team' && !this.store.getTeam(tid, scopeId)) throw new HttpError(400, 'invalid_request', 'No such team.');
      if (scope === 'user' && !this.store.getUser(tid, scopeId)) throw new HttpError(400, 'invalid_request', 'No such user.');
      const b = this.store.upsertBudget(tid, { scope, scopeId, period, limitUsd: limit });
      log('budget.set', { scope, scopeId, period, limitUsd: limit });
      return reply(200, { id: b.id });
    }
    m = match('/v1/admin/budgets/:id', c.url.pathname);
    if (m && c.method === 'DELETE') {
      this.need(a, 'budgets.manage');
      if (!this.store.deleteBudget(tid, m.id!)) throw new HttpError(404, 'not_found', 'No such budget.');
      log('budget.delete', { id: m.id });
      return reply(200, { ok: true });
    }
    throw new HttpError(404, 'not_found', 'No such endpoint.');
  }

  private auditFilters(url: URL): Parameters<Store['queryAudit']>[1] {
    const g = (k: string): string | undefined => str(url.searchParams.get(k), 200);
    const time = (k: string): number | undefined => { const v = g(k); const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : undefined; };
    const limit = Number(g('limit') ?? 100);
    const before = Number(g('before'));
    return {
      ...(g('q') ? { q: g('q')! } : {}), ...(g('kind') ? { kind: g('kind')! } : {}), ...(g('user') ? { user: g('user')! } : {}),
      ...(g('outcome') ? { outcome: g('outcome')! } : {}), ...(g('source') ? { source: g('source')! } : {}),
      ...(time('since') !== undefined ? { since: time('since')! } : {}), ...(time('until') !== undefined ? { until: time('until')! } : {}),
      limit: Number.isFinite(limit) ? limit : 100, ...(Number.isFinite(before) && before > 0 ? { beforeSeq: before } : {}),
    };
  }

  // ── the portal's static files ─────────────────────────────────────
  private serveStatic(c: Ctx): void {
    if (c.method !== 'GET' && c.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'GET only.');
    const dir = this.opts.portalDir;
    if (!dir || !fs.existsSync(path.join(dir, 'index.html'))) {
      return sendText(c.res, 200, 'text/html', messagePage('AICO Control', 'The server is running, but the admin portal has not been built (run "npm run build" in control/).'));
    }
    const root = path.resolve(dir);
    let rel = decodeURIComponent(c.url.pathname);
    if (rel.includes('\0')) throw new HttpError(400, 'invalid_request', 'Bad path.');
    let file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) throw new HttpError(404, 'not_found', 'Not found.');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { rel = '/index.html'; file = path.join(root, 'index.html'); }
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };
    const data = fs.readFileSync(file);
    c.res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'content-length': data.length, 'cache-control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    c.res.end(c.method === 'HEAD' ? undefined : data);
  }
}

export { DEFAULT_SETTINGS };
export type { Grant };
