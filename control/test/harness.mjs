/**
 * Shared test helpers for the control server suites: assertions, a started
 * server, a cookie-keeping "browser", and a mock OpenID Connect provider.
 *
 * The mock IdP is a real HTTP server with a real RSA key: the control server
 * talks to it exactly as it would to Entra or Keycloak (discovery, authorize
 * redirect, PKCE-checked token exchange, JWKS), and it can be told to misbehave
 * (`idp.tamper`) so the negative paths are exercised against real bytes, not
 * against mocks of our own verifier.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { ControlApp } from '../dist/lib.js';

let passed = 0;
let failed = 0;
const failures = [];

export function assert(cond, name) {
  if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; failures.push(name); console.log(`  FAIL ${name}`); }
}
export async function block(title, fn) {
  console.log(`\n== ${title} ==`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}
export function finish(label) {
  console.log(`\n${label}: ${passed} passed, ${failed} failed`);
  if (failed) { console.log(`Failures:\n - ${failures.join('\n - ')}`); process.exitCode = 1; }
  // Handles (servers, sqlite) are closed by the suites; exit explicitly so a stray socket cannot hang CI.
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}

export const clock = { t: Date.now() };
export const advance = ms => { clock.t += ms; };

export async function startApp(opts = {}) {
  const app = new ControlApp({ allowInsecureIdp: true, now: () => clock.t, ...opts });
  const port = await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${port}`, close: () => app.close() };
}

/** fetch with manual redirects and a per-host cookie jar. */
export class Browser {
  constructor() { this.jar = new Map(); }
  cookieFor(url) { return [...(this.jar.get(new URL(url).host) ?? new Map()).entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(url, res) {
    const host = new URL(url).host;
    const m = this.jar.get(host) ?? new Map();
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = decodeURIComponent(pair.slice(i + 1).trim());
      if (attrs.some(a => /^\s*max-age=0/i.test(a)) || value === '') m.delete(name); else m.set(name, value);
    }
    this.jar.set(host, m);
  }
  async req(url, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    const cookie = this.cookieFor(url);
    if (cookie) headers.cookie = cookie;
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    this.store(url, res);
    return res;
  }
  /** Follow redirects (across hosts) up to the end; returns the last response and its URL. */
  async follow(url, init = {}, max = 10) {
    let cur = url;
    let res = await this.req(cur, init);
    for (let i = 0; i < max && res.status >= 300 && res.status < 400 && res.headers.get('location'); i++) {
      cur = new URL(res.headers.get('location'), cur).toString();
      res = await this.req(cur);
    }
    return { res, url: cur };
  }
}

export async function api(base, path, { method = 'GET', body, token, browser, csrf, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (csrf) h['x-csrf-token'] = csrf;
  const init = { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  const res = browser ? await browser.req(`${base}${path}`, init) : await fetch(`${base}${path}`, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

/** Sign a person in through the mock IdP; returns a Browser plus the portal csrf token. */
export async function signIn(base, idp, slug, email) {
  const b = new Browser();
  idp.emailFor = email;
  const { res } = await b.follow(`${base}/auth/login?tenant=${slug}&hint=${encodeURIComponent(email)}`);
  if (res.status !== 200 && res.status !== 404 && res.status >= 400) return { browser: b, status: res.status, body: await res.text() };
  const me = await api(base, '/v1/me', { browser: b });
  return { browser: b, status: me.status, me: me.data, csrf: me.data?.csrf };
}

// ── mock IdP ────────────────────────────────────────────────────────

const b64u = b => Buffer.from(b).toString('base64url');

export async function startIdp({ clientId = 'aico-control-test', clientSecret } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const codes = new Map();
  const idp = { tamper: undefined, emailFor: 'owner@acme.test', sub: undefined, requests: [], clientId, clientSecret, issuer: '' };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, idp.issuer || 'http://x');
    idp.requests.push(`${req.method} ${u.pathname}`);
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/.well-known/openid-configuration') {
      return send(200, { issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`, jwks_uri: `${idp.issuer}/jwks` });
    }
    if (u.pathname === '/jwks') return send(200, { keys: [jwk] });
    if (u.pathname === '/authorize') {
      const q = u.searchParams;
      if (q.get('client_id') !== clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') || !q.get('nonce')) {
        return send(400, { error: 'invalid_request' });
      }
      const code = crypto.randomBytes(12).toString('hex');
      codes.set(code, { challenge: q.get('code_challenge'), nonce: q.get('nonce'), redirect: q.get('redirect_uri'), email: q.get('login_hint') || idp.emailFor });
      if (idp.denyNext) { idp.denyNext = false; return send(302, {}, { location: `${q.get('redirect_uri')}?error=access_denied&state=${q.get('state')}` }); }
      return send(302, {}, { location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state'))}` });
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const f = new URLSearchParams(raw);
        const entry = codes.get(f.get('code'));
        codes.delete(f.get('code'));
        if (!entry) return send(400, { error: 'invalid_grant' });
        const verifier = f.get('code_verifier') ?? '';
        if (crypto.createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
        if (f.get('redirect_uri') !== entry.redirect) return send(400, { error: 'invalid_grant' });
        if (clientSecret) {
          const auth = req.headers.authorization ?? '';
          const want = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
          if (auth !== want) return send(401, { error: 'invalid_client' });
        }
        const now = Math.floor(clock.t / 1000);
        const t = idp.tamper;
        const claims = {
          iss: t === 'iss' ? 'https://evil.example' : idp.issuer, aud: t === 'aud' ? 'someone-else' : clientId, sub: idp.sub ?? `sub-${entry.email}`,
          email: entry.email, email_verified: t === 'unverified' ? false : true, name: entry.email.split('@')[0],
          iat: now, exp: t === 'expired' ? now - 3600 : now + 300, nonce: t === 'nonce' ? 'not-the-nonce' : entry.nonce,
        };
        const alg = t === 'alg-none' ? 'none' : t === 'alg-hs256' ? 'HS256' : 'RS256';
        const head = b64u(JSON.stringify({ alg, typ: 'JWT', kid: 'k1' }));
        const body = b64u(JSON.stringify(claims));
        let sig = '';
        if (alg === 'RS256') {
          sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), t === 'badsig' ? other.privateKey : privateKey).toString('base64url');
        } else if (alg === 'HS256') {
          // The classic confusion attack: sign with the PUBLIC key as the HMAC secret.
          sig = crypto.createHmac('sha256', publicKey.export({ type: 'spki', format: 'pem' })).update(`${head}.${body}`).digest('base64url');
        }
        send(200, { access_token: 'x', token_type: 'Bearer', id_token: `${head}.${body}.${sig}` });
      });
      return;
    }
    send(404, { error: 'not_found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  idp.issuer = `http://127.0.0.1:${server.address().port}`;
  idp.close = () => new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  return idp;
}

/** Create a tenant wired to the mock IdP with an owner, an admin, a dev and teams. */
export function seedTenant(app, idp, slug = 'acme', extra = {}) {
  const { tenant, owner } = app.createTenant({
    slug, name: `${slug} Inc`, ownerEmail: `owner@${slug}.test`,
    settings: { idp: { issuer: idp.issuer, clientId: idp.clientId, ...(idp.clientSecret ? { clientSecret: idp.clientSecret } : {}) }, ...extra },
  });
  const team = app.store.createTeam(tenant.id, 'Platform');
  const mk = (local, role, teamId = null) => app.store.createUser(tenant.id, { email: `${local}@${slug}.test`, role, teamId });
  return {
    tenant, owner, team,
    admin: mk('admin', 'admin'), auditor: mk('auditor', 'auditor'), lead: mk('lead', 'team-lead', team.id),
    dev: mk('dev', 'developer', team.id), contractor: mk('contractor', 'contractor'),
  };
}

/** Enrol a device through the real RFC 8628 flow; returns tokens. */
export async function enrol(base, idp, slug, email, { name = 'test-laptop' } = {}) {
  const dev = await api(base, '/oauth/device_authorization', { method: 'POST', body: { client_id: 'aico-engine', tenant: slug, device_name: name, platform: 'test', aico_version: '0.51.0' } });
  if (dev.status !== 200) throw new Error(`device_authorization failed: ${JSON.stringify(dev.data)}`);
  const s = await signIn(base, idp, slug, email);
  const page = await s.browser.req(`${base}/device?tenant=${slug}&code=${dev.data.user_code}`);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  const approve = await s.browser.req(`${base}/device/decision`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ csrf, code: dev.data.user_code, decision: 'approve' }).toString(),
  });
  if (approve.status !== 200) throw new Error(`approval failed: ${approve.status}`);
  advance(6000);
  const tok = await api(base, '/oauth/token', { method: 'POST', body: { client_id: 'aico-engine', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dev.data.device_code } });
  if (tok.status !== 200) throw new Error(`token failed: ${JSON.stringify(tok.data)}`);
  return { ...tok.data, browser: s.browser };
}
