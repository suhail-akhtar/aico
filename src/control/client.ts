/**
 * The engine's side of AICO Control (ADR 0040): enrol, hold tokens, call the server.
 *
 * Enrolment is the OAuth device authorization grant (RFC 8628): the engine
 * shows a short code, the person approves it in a browser where they signed in
 * through their organisation's identity provider, and the engine receives a
 * short-lived access token and a rotating refresh token. No password and no
 * long-lived key ever passes through AICO.
 *
 * Where things live, and why:
 *  - **Tokens go in the credential vault**, bound to the server's origin and to
 *    the `Control` tool, never in `state.json`, a log or a tool result. The
 *    agent's tools cannot ask for them (the vault hands a secret only to the
 *    named consumer, and nothing here returns one to a caller outside it).
 *  - **Refresh is serialised across processes.** The server treats a reused
 *    refresh token as theft and revokes the device, so two processes of one
 *    engine (the desktop's engine and `aico control sync`) racing to refresh
 *    would lock themselves out. A lock file plus a re-read after acquiring it
 *    makes the second process use the first one's result.
 *  - **The URL is validated once, up front**: https (plain http only to a
 *    loopback server, for development), no embedded credentials, no link-local
 *    or cloud-metadata address. After that it is the organisation's server and
 *    is trusted to the extent of policy and usage — it can only ever *restrict*.
 *
 * Deliberately not here: applying the policy (policy/managed.ts reads
 * `state.ts`), pushing batches (`sync.ts`), the CLI (`cli.ts`).
 *
 * @module control/client
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getVault } from '../vault/index.js';
import { clearControlState, controlDir, readControlState, writeControlState, type ControlState } from './state.js';
import { engineVersion } from '../policy/managed.js';

export const CONTROL_TOOL = 'Control';
const CLIENT_ID = 'aico-engine';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const TIMEOUT_MS = 15_000;

export class ControlError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number, readonly retryAfterMs?: number) { super(message); this.name = 'ControlError'; }
}

// ── the URL ─────────────────────────────────────────────────────────

const isLoopbackHost = (h: string): boolean => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');

export function normaliseControlUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new ControlError(`"${raw}" is not a URL. Use the address your administrator gave you, e.g. https://aico.example.com.`, 'bad-url'); }
  if (u.username || u.password) throw new ControlError('The URL must not contain a user name or password.', 'bad-url');
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(host))) {
    throw new ControlError('AICO Control must be reached over https (plain http is accepted only for a server on this machine).', 'insecure-url');
  }
  if (/^169\.254\./.test(host) || host.startsWith('[fe80:') || host === 'metadata.google.internal' || host === '[fd00:ec2::254]') {
    throw new ControlError('That address is not allowed (link-local / cloud metadata).', 'bad-url');
  }
  return `${u.protocol}//${u.host}`;
}

// ── transport ───────────────────────────────────────────────────────

interface Reply { status: number; data: Record<string, unknown>; headers: Headers }

async function call(url: string, init: { method?: string; body?: unknown; token?: string; extraHeaders?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { accept: 'application/json', 'x-aico-version': engineVersion(), ...(init.extraHeaders ?? {}) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let res: Response;
  try {
    // security-allow: fetch-unguarded — the organisation's own control server: a person typed the address, normaliseControlUrl allows only https (or loopback) and refuses link-local/metadata, and no model or tool value reaches it
    res = await fetch(url, {
      method: init.method ?? 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (e) {
    throw new ControlError(`Could not reach ${new URL(url).host}: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : 'network error'}`, 'network');
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { const p = JSON.parse(text) as unknown; if (p && typeof p === 'object' && !Array.isArray(p)) data = p as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: res.status, data, headers: res.headers };
}

function retryAfter(h: Headers): number | undefined {
  const v = Number(h.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 300) * 1000 : undefined;
}

// ── tokens in the vault ─────────────────────────────────────────────

interface Tokens { access: string; refresh: string; expiresAt: number }

async function saveTokens(state: Pick<ControlState, 'url' | 'credential'>, t: Tokens): Promise<string> {
  const origin = new URL(state.url).origin;
  const name = `control-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await getVault().create({
    name, kind: 'generic', secret: { value: JSON.stringify(t) }, url: origin, tags: ['control'], createdBy: 'user',
    description: 'AICO Control sign-in for this device. Used only by AICO to reach your organisation server.',
    policy: { approval: 'auto', allowedTools: [CONTROL_TOOL], allowedOrigins: [origin], allowedHosts: [], allowShell: false, ...(origin.startsWith('http:') ? { allowInsecureHttp: true } : {}) },
  });
  return name;
}

async function loadTokens(state: Pick<ControlState, 'url' | 'credential'>): Promise<Tokens> {
  const secret = await getVault().resolve(state.credential, { tool: CONTROL_TOOL, origin: new URL(state.url).origin, purpose: 'Authenticate to your AICO Control server' });
  try { return JSON.parse(secret.value()) as Tokens; } finally { secret.release(); }
}

async function dropCredential(name: string): Promise<void> {
  try { await getVault().remove(name); } catch { /* best effort: an orphaned credential holds only expired tokens */ }
}

// ── cross-process refresh lock ──────────────────────────────────────

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = path.join(controlDir(), 'refresh.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true }); } catch { /* raced */ }
      if (Date.now() > deadline) throw new ControlError('Another AICO process is refreshing the sign-in; try again.', 'locked');
      await new Promise(r => setTimeout(r, 50));
    }
  }
  try { return await fn(); } finally { try { fs.rmSync(lock, { force: true }); } catch { /* gone */ } }
}

// ── enrolment ───────────────────────────────────────────────────────

export interface DeviceStart {
  url: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalS: number;
  expiresInS: number;
  startedAt: number;
}

export async function startLogin(rawUrl: string, opts: { tenant?: string; deviceName?: string } = {}): Promise<DeviceStart> {
  const url = normaliseControlUrl(rawUrl);
  const r = await call(`${url}/oauth/device_authorization`, {
    method: 'POST',
    body: { client_id: CLIENT_ID, ...(opts.tenant ? { tenant: opts.tenant } : {}), device_name: (opts.deviceName ?? os.hostname()).slice(0, 80), platform: `${process.platform}-${process.arch}`, aico_version: engineVersion() },
  });
  if (r.status !== 200 || typeof r.data.device_code !== 'string' || typeof r.data.user_code !== 'string') {
    throw new ControlError(String(r.data.message ?? r.data.error_description ?? `The server refused the request (${r.status}).`), 'refused', r.status);
  }
  // The server names where the person goes. It must be the same origin we asked: a hijacked answer
  // pointing the person at another site is the phishing shape this flow exists to avoid.
  const complete = String(r.data.verification_uri_complete ?? r.data.verification_uri);
  if (new URL(complete).origin !== new URL(url).origin) throw new ControlError('The server sent a verification address on a different site; refusing.', 'bad-reply');
  return {
    url, deviceCode: r.data.device_code, userCode: r.data.user_code, verificationUri: String(r.data.verification_uri), verificationUriComplete: complete,
    intervalS: Number(r.data.interval) || 5, expiresInS: Number(r.data.expires_in) || 600, startedAt: Date.now(),
  };
}

/** Poll until approved, denied or expired. `sleep` is injectable so tests do not wait real seconds. */
export async function completeLogin(start: DeviceStart, opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {}): Promise<ControlState> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let interval = start.intervalS;
  const until = start.startedAt + start.expiresInS * 1000 + 5000;
  for (;;) {
    if (opts.signal?.aborted) throw new ControlError('Sign-in cancelled.', 'cancelled');
    await sleep(interval * 1000);
    if (Date.now() > until) throw new ControlError('The code expired before it was approved. Run the command again.', 'expired');
    const r = await call(`${start.url}/oauth/token`, { method: 'POST', body: { client_id: CLIENT_ID, grant_type: DEVICE_GRANT, device_code: start.deviceCode } });
    if (r.status === 200 && typeof r.data.access_token === 'string') return finishLogin(start.url, r.data);
    const err = String(r.data.error ?? '');
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5; continue; }
    if (err === 'access_denied') throw new ControlError('The request was denied in the browser.', 'denied');
    if (err === 'expired_token') throw new ControlError('The code expired before it was approved. Run the command again.', 'expired');
    throw new ControlError(String(r.data.error_description ?? `Sign-in failed (${r.status}).`), 'refused', r.status);
  }
}

async function finishLogin(url: string, data: Record<string, unknown>): Promise<ControlState> {
  const tenant = data.tenant as { slug: string; name: string };
  const user = data.user as { email: string; name?: string; role: string };
  const tokens: Tokens = { access: String(data.access_token), refresh: String(data.refresh_token), expiresAt: Date.now() + Number(data.expires_in ?? 900) * 1000 };
  const prev = readControlState();
  const credential = await saveTokens({ url, credential: '' }, tokens);
  const state: ControlState = {
    url, tenant: { slug: tenant.slug, name: tenant.name }, user: { email: user.email, ...(user.name ? { name: user.name } : {}) }, role: user.role,
    deviceId: String(data.device_id), credential, enrolledAt: Date.now(), lastContactAt: Date.now(), cursors: { auditSince: Date.now() - 24 * 3_600_000 },
  };
  writeControlState(state);
  if (prev) await dropCredential(prev.credential);
  return state;
}

/** Sign out here. The device stays listed (revoked from the server by an administrator, or left idle). */
export async function logout(): Promise<{ wasEnrolled: boolean; org?: string }> {
  const s = readControlState();
  if (!s) return { wasEnrolled: false };
  clearControlState();
  await dropCredential(s.credential);
  return { wasEnrolled: true, org: s.tenant.name };
}

// ── authenticated calls ─────────────────────────────────────────────

/** The server no longer knows this device (revoked, user disabled): forget it here and say so. */
async function signedOutByServer(reason: string): Promise<never> {
  const s = readControlState();
  clearControlState();
  if (s) await dropCredential(s.credential);
  throw new ControlError(`${reason} This device is no longer managed by ${s?.tenant.name ?? 'your organisation'}.`, 'revoked');
}

/** `rejected`: an access token the server just refused; a fresh one is fetched even if its clock says it is valid. */
async function freshAccessToken(rejected?: string): Promise<{ state: ControlState; token: string }> {
  const state = readControlState();
  if (!state) throw new ControlError('This AICO is not signed in to an organisation. Run: aico control login <url>', 'not-enrolled');
  const t = await loadTokens(state).catch((e: unknown) => {
    throw new ControlError(`The sign-in could not be read from the vault: ${e instanceof Error ? e.message : 'unknown error'}`, 'vault');
  });
  if (t.expiresAt - Date.now() > 60_000 && t.access !== rejected) return { state, token: t.access };
  return withRefreshLock(async () => {
    const cur = readControlState();
    if (!cur) throw new ControlError('Signed out.', 'not-enrolled');
    const latest = await loadTokens(cur);
    if (latest.expiresAt - Date.now() > 60_000 && latest.access !== rejected) return { state: cur, token: latest.access };
    const r = await call(`${cur.url}/oauth/token`, { method: 'POST', body: { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: latest.refresh } });
    if (r.status === 200 && typeof r.data.access_token === 'string') {
      const next: Tokens = { access: String(r.data.access_token), refresh: String(r.data.refresh_token), expiresAt: Date.now() + Number(r.data.expires_in ?? 900) * 1000 };
      const credential = await saveTokens(cur, next);
      const updated: ControlState = { ...cur, credential, lastContactAt: Date.now(), role: String((r.data.user as { role?: string } | undefined)?.role ?? cur.role) };
      writeControlState(updated);
      await dropCredential(cur.credential);
      return { state: updated, token: next.access };
    }
    if (r.data.error === 'invalid_grant') return signedOutByServer(String(r.data.error_description ?? 'The server ended this sign-in.'));
    throw new ControlError(`The server could not refresh the sign-in (${r.status}).`, r.status >= 500 || r.status === 429 ? 'unavailable' : 'refused', r.status, retryAfter(r.headers));
  });
}

/** An authenticated request. One refresh-and-retry if the server says the access token is no good. */
export async function authedCall(pathAndQuery: string, init: { method?: string; body?: unknown } = {}): Promise<Reply> {
  let { state, token } = await freshAccessToken();
  let r = await call(`${state.url}${pathAndQuery}`, { ...init, token });
  if (r.status === 401) {
    ({ state, token } = await freshAccessToken(token));
    r = await call(`${state.url}${pathAndQuery}`, { ...init, token });
    if (r.status === 401) return signedOutByServer('The server rejected this device.');
  }
  if (r.status === 429 || r.status >= 500) throw new ControlError(`The server is busy or unavailable (${r.status}).`, 'unavailable', r.status, retryAfter(r.headers));
  return r;
}
