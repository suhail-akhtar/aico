/**
 * `HttpRequest`: call an HTTP API with a stored credential the agent never
 * sees — create a service's admin user, configure it through its API, check
 * it answers.
 *
 * WebFetch reads pages; this is the tool for APIs, and it is shaped by what
 * an API call with a secret can go wrong in:
 *
 *  - **The credential goes where it is bound, and nowhere else.** It is
 *    resolved by the broker for the request's exact origin (scheme, host,
 *    port), so a credential bound to `https://10.0.0.5:3000` cannot be sent to
 *    any other place however the URL is phrased. Plain http and self-signed
 *    certificates follow the credential's policy, never a request flag.
 *  - **Redirects do not carry it away.** Redirects are followed by hand: a
 *    same-origin hop keeps the auth; a cross-origin hop keeps it only if the
 *    broker admits the new origin too, and one with a secret in the body is
 *    not followed at all — the 3xx is returned instead. Every hop is
 *    re-checked against the address policy (ssrf.ts).
 *  - **The address is pinned.** The name is resolved once, checked, and the
 *    socket connects to that address (TLS still verifies the name).
 *  - **What comes back is data.** Bodies are size-capped; `Set-Cookie` and
 *    auth-looking headers are reduced to their names; secret-shaped values in
 *    the body (JSON keys like `token`/`password`/`apiKey`, known token
 *    formats) are masked. `capture` moves a returned token into the vault
 *    instead — the way to keep an API key a setup step produced.
 *  - **`{{secret:NAME}}` in headers or the body** is substituted in memory
 *    for this origin only (e.g. the password when creating an account with a
 *    generated credential). Not in the URL, which servers log — except the
 *    explicit `query:<param>` auth mode some APIs require.
 *  - **DELETE needs a person**, which means it needs a credential: approval
 *    is a credential use (see common.ts), so an unauthenticated DELETE is
 *    refused rather than made without anyone agreeing.
 *
 * @module tools/ops/http
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { currentCwd } from '../../run-context.js';
import { list as vaultList, type ResolvedSecret } from '../../vault/index.js';
import { effectiveScope, hostMatches, originMatches } from '../../vault/policy.js';
import { parsePlaceholders } from '../../vault/placeholders.js';
import type { CredentialKind } from '../../vault/types.js';
import {
  captureSecret, checkRate, clampSeconds, credentialLabel, MASK_NOTE, maskUnknownSecrets, openOp, OpsError, useCredential,
} from './common.js';
import { isDestructiveHttpMethod } from './destructive.js';
import { activeTunnelPorts, localPathDenial } from './ssh.js';
import { decideTarget, resolveAll } from './ssrf.js';

export interface HttpRequestInput {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
  credential?: string;
  auth?: string;
  timeout?: number;
  max_bytes?: number;
  follow_redirects?: boolean;
  capture?: Array<{ name: string; from: string; kind?: CredentialKind; description?: string }>;
  save_to?: string;
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const DEFAULT_MAX_BYTES = 1024 * 1024;
const HARD_MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Headers the caller may not set: they are the transport's, or the auth's. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'expect']);
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Response headers whose values are credentials by nature. */
const SENSITIVE_RESPONSE_HEADERS = /^(set-cookie|authorization|proxy-authenticate|www-authenticate|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
/** JSON keys whose string values are treated as secrets in responses. */
const SECRET_KEY_RE = /(?:^|[_-])(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|apikey|private[_-]?key|credentials?|session(?:[_-]?id)?|cookie|signature|otp|totp)$|^(?:key|jwt|bearer)$/i;

// ── auth (pure) ──────────────────────────────────────────────────────

export type AuthMode = { kind: 'none' } | { kind: 'bearer' } | { kind: 'basic' } | { kind: 'header'; name: string } | { kind: 'query'; name: string };

/** Parse the `auth` argument, defaulting by credential kind. */
export function parseAuth(auth: string | undefined, credentialKind?: CredentialKind): AuthMode {
  const a = (auth ?? '').trim();
  if (!a) {
    if (!credentialKind) return { kind: 'none' };
    return credentialKind === 'api-token' || credentialKind === 'generic' ? { kind: 'bearer' } : { kind: 'basic' };
  }
  if (a === 'none') return { kind: 'none' };
  if (a === 'bearer') return { kind: 'bearer' };
  if (a === 'basic') return { kind: 'basic' };
  const m = /^(header|query):(.+)$/.exec(a);
  if (m) {
    const name = m[2]!.trim();
    if (m[1] === 'header') {
      if (!TOKEN_RE.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) throw new OpsError(`"${name}" cannot be used as an auth header.`);
      return { kind: 'header', name };
    }
    if (!/^[A-Za-z0-9_.~-]{1,64}$/.test(name)) throw new OpsError(`"${name}" is not a usable query parameter name.`);
    return { kind: 'query', name };
  }
  throw new OpsError('`auth` must be bearer, basic, header:<Name>, query:<param> or none.');
}

/** Headers (and URL change) for an auth mode. The value is placed only in the returned objects. */
export function applyAuth(mode: AuthMode, url: URL, value: string, username?: string): { headers: Record<string, string>; url: URL } {
  const u = new URL(url.toString());
  switch (mode.kind) {
    case 'none': return { headers: {}, url: u };
    case 'bearer': return { headers: { Authorization: `Bearer ${value}` }, url: u };
    case 'basic': {
      if (!username) throw new OpsError('Basic auth needs a username: the credential does not name one.');
      if (username.includes(':')) throw new OpsError('A Basic auth username cannot contain ":".');
      return { headers: { Authorization: `Basic ${Buffer.from(`${username}:${value}`, 'utf8').toString('base64')}` }, url: u };
    }
    case 'header': return { headers: { [mode.name]: value }, url: u };
    case 'query': u.searchParams.set(mode.name, value); return { headers: {}, url: u };
  }
}

/** `scheme://host:port` with default ports written out, as the vault compares origins. */
export function originOf(u: URL): string {
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.protocol}//${u.hostname}:${port}`;
}

/** Where a redirect may go, and with what. Pure. */
export function redirectPlan(from: URL, to: URL, opts: { hasAuth: boolean; bodyHasSecrets: boolean; method: string; status: number }):
  { follow: boolean; sameOrigin: boolean; method: string; keepBody: boolean; reason?: string } {
  const sameOrigin = originOf(from) === originOf(to);
  const keepBody = opts.status === 307 || opts.status === 308;
  // 301/302/303 continue as GET without a body (what every client does); 307/308 repeat the request as is.
  const method = keepBody ? opts.method : opts.method === 'HEAD' ? 'HEAD' : 'GET';
  if (to.protocol !== 'http:' && to.protocol !== 'https:') return { follow: false, sameOrigin, method, keepBody, reason: `redirect to ${to.protocol} is not followed` };
  if (!sameOrigin && keepBody && opts.bodyHasSecrets) {
    return { follow: false, sameOrigin, method, keepBody, reason: 'a request body holding stored values is not re-sent to another origin' };
  }
  return { follow: true, sameOrigin, method, keepBody };
}

// ── response shaping (pure) ──────────────────────────────────────────

/** Mask secret-looking values under secret-looking keys, anywhere in a JSON value. */
export function maskJsonSecrets(value: unknown, count = { n: 0 }): { value: unknown; masked: number } {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key && SECRET_KEY_RE.test(key) && v.length >= 6 && !/^\[secret:/.test(v)) { count.n++; return `[masked ${key}]`; }
      return v;
    }
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  const out = walk(value);
  return { value: out, masked: count.n };
}

/** Response headers as shown: credential-bearing ones reduced to what they are, never their value. */
export function shownHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (SENSITIVE_RESPONSE_HEADERS.test(k)) {
      if (/^set-cookie$/i.test(k)) {
        const names = (Array.isArray(v) ? v : [v]).map(c => c.split('=')[0]!.trim()).filter(Boolean);
        out[k] = `[${names.length} cookie(s): ${names.join(', ')} — values hidden]`;
      } else if (/authenticate$/i.test(k)) {
        out[k] = String(Array.isArray(v) ? v.join(', ') : v).slice(0, 200);
      } else {
        out[k] = '[hidden]';
      }
      continue;
    }
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/** Follow a dot/bracket path (`data.items[0].token`) into parsed JSON. */
export function jsonPath(value: unknown, p: string): unknown {
  let cur: unknown = value;
  for (const part of p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ── the request ──────────────────────────────────────────────────────

interface RawResponse { status: number; statusText: string; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }

function send(opts: {
  url: URL; method: string; headers: Record<string, string>; body?: Buffer; address: string;
  rejectUnauthorized: boolean; maxBytes: number; signal: AbortSignal;
}): Promise<RawResponse> {
  const family = net.isIPv6(opts.address) ? 6 : 4;
  const lib = opts.url.protocol === 'https:' ? https : http;
  return new Promise<RawResponse>((resolve, reject) => {
    const req = lib.request({
      protocol: opts.url.protocol,
      hostname: opts.url.hostname.replace(/^\[|\]$/g, ''),
      port: opts.url.port || (opts.url.protocol === 'https:' ? 443 : 80),
      path: `${opts.url.pathname}${opts.url.search}`,
      method: opts.method,
      headers: { 'User-Agent': 'aico-ops/1', ...opts.headers, ...(opts.body ? { 'Content-Length': String(opts.body.length) } : {}) },
      // Pinned to the checked address: a second DNS answer cannot redirect the socket.
      lookup: ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
        if (options?.all) cb(null, [{ address: opts.address, family }]);
        else cb(null, opts.address, family);
      }) as unknown as net.LookupFunction,
      ...(opts.url.protocol === 'https:' ? { rejectUnauthorized: opts.rejectUnauthorized, servername: net.isIP(opts.url.hostname.replace(/^\[|\]$/g, '')) ? undefined : opts.url.hostname } : {}),
      signal: opts.signal,
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on('data', (c: Buffer) => {
        if (truncated) return;
        if (size + c.length > opts.maxBytes) {
          chunks.push(c.subarray(0, opts.maxBytes - size));
          size = opts.maxBytes;
          truncated = true;
          res.destroy();
          resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers: res.headers, body: Buffer.concat(chunks), truncated });
          return;
        }
        chunks.push(c);
        size += c.length;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers: res.headers, body: Buffer.concat(chunks), truncated }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (opts.body) req.end(opts.body); else req.end();
  });
}

/** Does any stored credential's scope name this host (or origin)? Metadata only. */
async function isKnownTarget(u: URL): Promise<boolean> {
  try {
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const origin = originOf(u);
    for (const c of await vaultList({})) {
      const scope = effectiveScope(c, c.policy);
      if (scope.hosts.some(p => hostMatches(p, host, port)) || scope.origins.some(o => originMatches(o, origin))) return true;
    }
  } catch { /* no vault, or locked: nothing is known */ }
  return false;
}

/** Substitute `{{secret:…}}` in a string for this origin. Returns the text and whether anything was substituted. */
async function substitute(text: string, origin: string, purpose: string): Promise<{ text: string; used: boolean }> {
  const refs = parsePlaceholders(text);
  if (!refs.length) return { text, used: false };
  let out = '';
  let at = 0;
  for (const ref of refs) {
    const secret = await useCredential(ref.raw, { tool: 'HttpRequest', origin, purpose });
    try { out += text.slice(at, ref.start) + secret.value(ref.field); } finally { secret.release(); }
    at = ref.end;
  }
  return { text: out + text.slice(at), used: true };
}

async function substituteJson(value: unknown, origin: string, purpose: string, used = { any: false }): Promise<unknown> {
  if (typeof value === 'string') {
    const r = await substitute(value, origin, purpose);
    if (r.used) used.any = true;
    return r.text;
  }
  if (Array.isArray(value)) return Promise.all(value.map(v => substituteJson(v, origin, purpose, used)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = await substituteJson(v, origin, purpose, used);
    return out;
  }
  return value;
}

export async function httpRequest(input: HttpRequestInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const method = (input.method ?? (input.body !== undefined || input.json !== undefined ? 'POST' : 'GET')).toUpperCase();
  if (!METHODS.has(method)) throw new OpsError(`Method ${method.slice(0, 20)} is not supported.`);
  let url: URL;
  try { url = new URL(String(input.url ?? '')); } catch { throw new OpsError('`url` must be an absolute http(s) URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OpsError('Only http and https URLs.');
  if (url.username || url.password) throw new OpsError('Put credentials in the vault and name them in `credential`, not in the URL.');
  if (parsePlaceholders(url.toString()).length || parsePlaceholders(decodeURIComponent(url.toString())).length) {
    throw new OpsError('{{secret:…}} is not allowed in the URL (servers log URLs). Use `auth` with header:/bearer/basic, or query:<param> if the API insists.');
  }
  const headersIn = input.headers ?? {};
  for (const k of Object.keys(headersIn)) {
    if (!TOKEN_RE.test(k) || RESERVED_HEADERS.has(k.toLowerCase())) throw new OpsError(`Header "${k.slice(0, 40)}" cannot be set.`);
    if (/[\r\n]/.test(String(headersIn[k]))) throw new OpsError(`Header "${k}" contains a line break.`);
  }
  const maxBytes = Math.min(Math.max(1024, Number(input.max_bytes) || DEFAULT_MAX_BYTES), HARD_MAX_BYTES);
  const timeoutS = clampSeconds(input.timeout, 60, 300);
  const destructive = isDestructiveHttpMethod(method);
  if (destructive && !input.credential) {
    throw new OpsError('DELETE needs a person\'s approval, and approval goes through the credential used for the call. Name the credential.');
  }
  if (input.save_to) {
    const denial = localPathDenial(input.save_to, currentCwd());
    if (denial) throw new OpsError(denial);
  }
  const hostKey = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  checkRate('HttpRequest', hostKey);

  const credName = input.credential ? credentialLabel(input.credential) : undefined;
  const op = openOp({ tool: 'HttpRequest', target: originOf(url), ...(credName ? { credential: credName } : {}), summary: `${method} ${url.pathname}` });
  const deadline = AbortSignal.timeout(timeoutS * 1000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let secret: ResolvedSecret | undefined;
  const notes: string[] = [];
  try {
    // Refuse what nothing can unlock before anyone is asked to approve anything.
    let addresses = await resolveAll(hostKey);
    const prelim = decideTarget({
      host: hostKey, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), addresses,
      credentialAdmits: Boolean(input.credential), knownTarget: true, tunnelPort: true,
    });
    if (!prelim.allowed) throw new OpsError(prelim.reason);

    const purpose = `${destructive ? 'DESTRUCTIVE (HTTP DELETE). ' : ''}${method} ${url.origin}${url.pathname}`;
    let auth: AuthMode = { kind: 'none' };
    if (input.credential) {
      secret = await useCredential(input.credential, { tool: 'HttpRequest', origin: originOf(url), purpose, requireApproval: destructive });
      auth = parseAuth(input.auth, secret.kind);
    } else if (input.auth && input.auth !== 'none') {
      throw new OpsError('`auth` needs a `credential`.');
    }

    // Body, with stored values substituted for this origin only.
    let bodyText: string | undefined;
    let bodyHasSecrets = false;
    const contentHeaders: Record<string, string> = {};
    if (input.json !== undefined) {
      const used = { any: false };
      bodyText = JSON.stringify(await substituteJson(input.json, originOf(url), `send in a ${method} to ${url.origin}${url.pathname}`, used));
      bodyHasSecrets = used.any;
      contentHeaders['Content-Type'] = 'application/json';
    } else if (input.body !== undefined) {
      const r = await substitute(String(input.body), originOf(url), `send in a ${method} to ${url.origin}${url.pathname}`);
      bodyText = r.text;
      bodyHasSecrets = r.used;
    }
    const headerValues: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersIn)) {
      const r = await substitute(String(v), originOf(url), `send as header ${k} to ${url.origin}`);
      headerValues[k] = r.text;
    }

    let current = url;
    let currentMethod = method;
    let body = bodyText !== undefined ? Buffer.from(bodyText, 'utf8') : undefined;
    let withAuth = auth.kind !== 'none';
    let hops = 0;
    let res: RawResponse;
    for (;;) {
      const port = Number(current.port || (current.protocol === 'https:' ? 443 : 80));
      const host = current.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (hops > 0) addresses = await resolveAll(host);
      const decision = decideTarget({
        host, port, addresses,
        credentialAdmits: withAuth && Boolean(secret),
        knownTarget: await isKnownTarget(current),
        tunnelPort: activeTunnelPorts().includes(port),
      });
      if (!decision.allowed) throw new OpsError(decision.reason);
      const authed = withAuth && secret ? applyAuth(auth, current, secret.value(), secret.username) : { headers: {}, url: current };
      res = await send({
        url: authed.url, method: currentMethod,
        headers: { ...contentHeaders, ...headerValues, ...authed.headers },
        ...(body ? { body } : {}),
        address: decision.address,
        // Self-signed only where the credential says so, and only while its auth is on this origin.
        rejectUnauthorized: !(withAuth && secret?.allowSelfSigned),
        maxBytes: input.save_to ? HARD_MAX_BYTES : maxBytes,
        signal: combined,
      }).catch((err: unknown) => { throw requestError(err, current); });

      const location = res.headers.location;
      if (input.follow_redirects === false || ![301, 302, 303, 307, 308].includes(res.status) || !location) break;
      if (++hops > MAX_REDIRECTS) { notes.push(`Stopped after ${MAX_REDIRECTS} redirects.`); break; }
      let next: URL;
      try { next = new URL(location, current); } catch { notes.push('The redirect Location was not a valid URL.'); break; }
      const plan = redirectPlan(current, next, { hasAuth: withAuth, bodyHasSecrets, method: currentMethod, status: res.status });
      if (!plan.follow) { notes.push(`Redirect to ${next.origin} not followed: ${plan.reason}.`); break; }
      if (!plan.sameOrigin && withAuth && secret) {
        // Keep the credential only if the broker admits the new origin too.
        try {
          const again = await useCredential(input.credential!, { tool: 'HttpRequest', origin: originOf(next), purpose: `follow a redirect from ${current.origin} to ${next.origin}` });
          again.release();
        } catch {
          notes.push(`Redirect to ${next.origin} not followed: the credential is not bound there.`);
          break;
        }
      }
      if (!plan.keepBody) { body = undefined; delete contentHeaders['Content-Type']; }
      currentMethod = plan.method;
      current = next;
    }

    // ── what the model sees ──
    const contentType = String(res.headers['content-type'] ?? '');
    const textual = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|problem\+json|[\w.+-]*\+(json|xml)))/i.test(contentType) || !contentType;
    let parsed: unknown;
    let text = textual ? res.body.toString('utf8') : '';
    if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    }

    const captured: string[] = [];
    for (const c of input.capture ?? []) {
      let value: unknown;
      if (c.from === 'body') value = text;
      else if (c.from.startsWith('json:')) value = parsed === undefined ? undefined : jsonPath(parsed, c.from.slice(5));
      else if (c.from.startsWith('header:')) value = res.headers[c.from.slice(7).toLowerCase()];
      if (Array.isArray(value)) value = value[0];
      if (typeof value !== 'string' || !value) { notes.push(`capture "${c.name}": nothing found at ${c.from}.`); continue; }
      const ref = await captureSecret({
        name: c.name, value, url: url.origin, kind: c.kind ?? 'api-token',
        description: c.description ?? `Captured from ${method} ${url.origin}${url.pathname} (${c.from}).`,
      });
      captured.push(ref);
      text = text.split(value).join(`[secret:${c.name}]`);
      if (parsed !== undefined) parsed = JSON.parse(JSON.stringify(parsed).split(JSON.stringify(value).slice(1, -1)).join(`[secret:${c.name}]`));
    }

    let bodyOut: unknown;
    let masked = 0;
    if (input.save_to && res.status < 400) {
      const dest = path.resolve(currentCwd(), input.save_to);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, res.body);
      bodyOut = `(saved ${res.body.length} bytes to ${input.save_to})`;
    } else if (parsed !== undefined) {
      const m = maskJsonSecrets(parsed);
      masked += m.masked;
      const s = maskUnknownSecrets(JSON.stringify(m.value, null, 2));
      masked += s.masked;
      bodyOut = s.text;
    } else if (textual) {
      const s = maskUnknownSecrets(text);
      masked += s.masked;
      bodyOut = s.text;
    } else {
      bodyOut = `(${res.body.length} bytes of ${contentType || 'binary data'}; pass save_to to keep it)`;
    }
    if (masked) notes.push(MASK_NOTE);
    if (res.truncated) notes.push(`Body cut at ${maxBytes} bytes (max_bytes).`);

    const result = {
      status: res.status,
      status_text: res.statusText,
      url: `${current.origin}${current.pathname}`,
      ...(hops ? { redirects: hops } : {}),
      headers: shownHeaders(res.headers),
      body: bodyOut,
      ...(credName ? { credential: credName } : {}),
      ...(captured.length ? { captured } : {}),
      ...(destructive ? { approved_as: 'destructive: HTTP DELETE' } : {}),
      ...(notes.length ? { notes } : {}),
      work_id: op.id,
    };
    if (res.status < 400) op.done(`HTTP ${res.status}`);
    else op.fail(`HTTP ${res.status}`);
    return result;
  } catch (err) {
    op.fail(err instanceof Error ? err.message : String(err), { cancelled: signal?.aborted === true });
    throw err;
  } finally {
    secret?.release();
  }
}

function requestError(err: unknown, u: URL): OpsError {
  const e = err as { code?: string; name?: string; message?: string };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'ABORT_ERR') return new OpsError(`The request to ${u.origin} timed out or was cancelled.`);
  if (e?.code === 'ECONNREFUSED') return new OpsError(`Nothing is listening at ${u.origin} (connection refused).`);
  if (e?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || e?.code === 'SELF_SIGNED_CERT_IN_CHAIN' || e?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return new OpsError(`${u.origin} uses a certificate that is not trusted (${e.code}). If it is the owner's self-signed server, `
      + 'the credential for it must allow self-signed certificates (a setting the owner controls); TLS checks are not turned off otherwise.');
  }
  if (e?.code === 'ERR_TLS_CERT_ALTNAME_INVALID') return new OpsError(`${u.origin}'s certificate is for a different name.`);
  return new OpsError(`Request to ${u.origin} failed: ${String(e?.code ?? e?.message ?? err).slice(0, 200)}`);
}

export const httpRequestDefinition = {
  name: 'HttpRequest',
  description: 'Call an HTTP API, optionally authenticated with a stored credential you never see (bearer, basic, a named '
    + 'header, or a query parameter). The credential is sent only to the origin it is bound to; redirects elsewhere drop it. '
    + 'Put {{secret:NAME}} in headers or the body (e.g. the password when creating an account with a CredentialGenerate '
    + 'credential). Private/LAN addresses are reachable when a stored credential is bound to that host; cloud metadata '
    + 'addresses never are. Tokens in responses are masked — use `capture` to store one in the vault. DELETE asks a person.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      method: { type: 'string', enum: [...METHODS], description: 'Default GET (POST when a body is given).' },
      url: { type: 'string', description: 'Absolute http(s) URL. No credentials in it.' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      json: { description: 'A JSON body (sets Content-Type).' },
      body: { type: 'string', description: 'A raw body, when not JSON.' },
      credential: { type: 'string', description: 'Stored credential to authenticate with, e.g. "grafana-admin".' },
      auth: { type: 'string', description: 'bearer | basic | header:<Name> | query:<param> | none. Default: bearer for tokens, basic for passwords.' },
      timeout: { type: 'number', description: 'Seconds, default 60, max 300.' },
      max_bytes: { type: 'number', description: 'Body bytes to read, default 1 MB, max 10 MB.' },
      follow_redirects: { type: 'boolean', description: 'Default true.' },
      save_to: { type: 'string', description: 'Save the response body to this local file instead of returning it.' },
      capture: {
        type: 'array',
        description: 'Store values from the response in the vault, bound to this origin: from "json:path.to.field", "header:Name" or "body".',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' }, from: { type: 'string' },
            kind: { type: 'string', enum: ['api-token', 'generic', 'login', 'basic-auth'] }, description: { type: 'string' },
          },
          required: ['name', 'from'],
        },
      },
    },
    required: ['url'],
  },
};
