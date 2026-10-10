/**
 * Web security of the server: CSRF, session lifetime, header hygiene, rate
 * limits, TLS rules, body limits, static file traversal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, block, finish, startApp, startIdp, seedTenant, signIn, api, enrol, advance, Browser } from './harness.mjs';
import { ControlApp } from '../dist/lib.js';

const idp = await startIdp();
const portal = fs.mkdtempSync(path.join(os.tmpdir(), 'control-portal-'));
fs.writeFileSync(path.join(portal, 'index.html'), '<!doctype html><title>portal</title>');
fs.mkdirSync(path.join(portal, 'assets'));
fs.writeFileSync(path.join(portal, 'assets', 'a.js'), 'console.log(1)');
fs.writeFileSync(path.join(os.tmpdir(), 'control-secret.txt'), 'SECRET-OUTSIDE-PORTAL');
const { app, base, close } = await startApp({ portalDir: portal });
const S = seedTenant(app, idp, 'acme');

await block('CSRF', async () => {
  const a = await signIn(base, idp, 'acme', 'admin@acme.test');
  const body = { name: 'Csrf Team' };
  const post = (headers) => a.browser.req(`${base}/v1/admin/teams`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert((await post({})).status === 403, 'a cookie-authenticated POST without the token is refused');
  assert((await post({ 'x-csrf-token': 'nope' })).status === 403, 'with a wrong token');
  assert((await post({ 'x-csrf-token': a.csrf, origin: 'https://evil.example' })).status === 403, 'with the right token but a foreign Origin');
  assert((await post({ 'x-csrf-token': a.csrf, 'sec-fetch-site': 'cross-site' })).status === 403, 'cross-site fetch metadata without Origin');
  const other = await signIn(base, idp, 'acme', 'owner@acme.test');
  assert((await post({ 'x-csrf-token': other.csrf })).status === 403, 'another session\'s token does not work');
  assert((await post({ 'x-csrf-token': a.csrf, origin: base })).status === 201, 'right token + same origin works');
  assert((await a.browser.req(`${base}/v1/admin/teams`)).status === 200, 'GET needs no token');
  assert((await a.browser.req(`${base}/auth/logout`, { method: 'POST' })).status === 403, 'logout is CSRF-protected too');
  const raw = await new Browser().follow(`${base}/auth/login?tenant=acme&hint=owner@acme.test`);
  assert(raw.res.status === 200, 'sign-in completes');
});

await block('cookie attributes', async () => {
  const b = new Browser();
  const first = await b.req(`${base}/auth/login?tenant=acme&hint=admin@acme.test`);
  const cb = (await b.req(first.headers.get('location'))).headers.get('location');
  const res = await b.req(cb);
  const sc = res.headers.getSetCookie().join('\n');
  assert(/HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Path=\//.test(sc) && /Max-Age=\d+/.test(sc), 'HttpOnly, SameSite=Lax, Path=/ and a lifetime');
});

await block('two authentications, never mixed', async () => {
  const dev = await enrol(base, idp, 'acme', 'dev@acme.test');
  assert((await api(base, '/v1/admin/users', { token: dev.access_token })).status === 401, 'a bearer token does not open the admin API');
  const a = await signIn(base, idp, 'acme', 'admin@acme.test');
  assert((await api(base, '/v1/engine/policy', { browser: a.browser })).status === 401, 'a session cookie does not open the engine API');
  assert((await api(base, '/v1/engine/policy', { token: dev.access_token, browser: a.browser })).status === 200, 'but the bearer token still does');
  const noPortal = await signIn(base, idp, 'acme', 'dev@acme.test');
  assert((await api(base, '/v1/admin/users', { browser: noPortal.browser })).status === 403, 'a developer\'s session has no admin access');
});

await block('session lifetime and logout', async () => {
  const a = await signIn(base, idp, 'acme', 'admin@acme.test');
  assert((await api(base, '/v1/me', { browser: a.browser })).status === 200, 'session valid');
  advance(20 * 60_000);
  assert((await api(base, '/v1/me', { browser: a.browser })).status === 200, 'activity within 30 minutes keeps it alive');
  advance(31 * 60_000);
  assert((await api(base, '/v1/me', { browser: a.browser })).status === 401, 'idle for over 30 minutes ends it');
  const b = await signIn(base, idp, 'acme', 'admin@acme.test');
  const out = await api(base, '/auth/logout', { method: 'POST', browser: b.browser, csrf: b.csrf, body: {} });
  assert(out.status === 200, 'logout');
  assert((await api(base, '/v1/me', { browser: b.browser })).status === 401, 'the old cookie is dead server-side');
  const c = await signIn(base, idp, 'acme', 'admin@acme.test');
  for (let i = 0; i < 17; i++) { advance(29 * 60_000); await api(base, '/v1/me', { browser: c.browser }); }
  assert((await api(base, '/v1/me', { browser: c.browser })).status === 401, 'a busy session still ends after 8 hours');
});

await block('headers, errors, bodies', async () => {
  const r = await fetch(`${base}/v1/public`);
  const h = r.headers;
  assert(/default-src 'self'/.test(h.get('content-security-policy')) && /frame-ancestors 'none'/.test(h.get('content-security-policy')), 'CSP: self only, no framing');
  assert(h.get('x-content-type-options') === 'nosniff' && h.get('referrer-policy') === 'same-origin' && h.get('x-frame-options') === 'DENY', 'nosniff, same-origin referrer only, no framing');
  assert(h.get('cache-control') === 'no-store', 'API replies are not cacheable');
  const big = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(40_000) }) });
  assert(big.status === 413, 'an oversized body is refused before parsing');
  const bad = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert(bad.status === 400, 'invalid JSON is a 400');
  const err = await fetch(`${base}/v1/admin/users`);
  const text = await err.text();
  assert(err.status === 401 && !/at \w+ \(|node_modules|\.ts:/.test(text), 'errors carry a message, never a stack');
  assert((await fetch(`${base}/v1/nope`)).status === 404, 'unknown API paths are 404 JSON');
});

await block('rate limits', async () => {
  const lim = await startApp({ rateScale: 0.05 });
  seedTenant(lim.app, idp, 'rl');
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await api(lim.base, '/oauth/device_authorization', { method: 'POST', body: { client_id: 'aico-engine', tenant: 'rl' } })).status);
  assert(codes.includes(429) && codes[0] === 200, `device_authorization is throttled (${codes.join(',')})`);
  const r = await fetch(`${lim.base}/oauth/device_authorization`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert(r.status === 429 && r.headers.get('content-type').includes('json'), 'a throttled reply is JSON 429');
  await lim.close();
});

await block('TLS and proxy rules', async () => {
  const open = new ControlApp({});
  let msg = '';
  try { await open.listen(0, '0.0.0.0'); } catch (e) { msg = e.message; }
  assert(/without TLS/.test(msg), 'listening on a non-loopback address without TLS is refused');
  const proxy = new ControlApp({ behindProxy: true });
  msg = '';
  try { await proxy.listen(0, '0.0.0.0'); } catch (e) { msg = e.message; }
  assert(/public-url https/.test(msg), '--behind-proxy needs an https public URL');
  const ok = new ControlApp({ behindProxy: true, publicUrl: 'https://control.acme.test' });
  const port = await ok.listen(0, '127.0.0.1');
  const plain = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert(plain.status === 400, 'behind a proxy, a request not marked https is refused');
  const secure = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { 'x-forwarded-proto': 'https' } });
  assert(secure.status === 200 && /max-age=/.test(secure.headers.get('strict-transport-security') ?? ''), 'marked https it works and HSTS is sent');
  await ok.close();
  open.store.db.close();
  proxy.store.db.close();
});

await block('static files', async () => {
  assert((await (await fetch(`${base}/`)).text()).includes('<title>portal</title>'), 'the portal index is served');
  assert((await (await fetch(`${base}/some/spa/route`)).text()).includes('<title>portal</title>'), 'unknown paths fall back to the SPA');
  const a = await fetch(`${base}/assets/a.js`);
  assert(a.status === 200 && /immutable/.test(a.headers.get('cache-control')), 'assets are cacheable');
  for (const p of ['/..%2f..%2fcontrol-secret.txt', '/%2e%2e/control-secret.txt', '/assets/..%2f..%2f..%2fcontrol-secret.txt', '/..%5c..%5ccontrol-secret.txt']) {
    const r = await fetch(`${base}${p}`);
    const t = await r.text();
    assert(!t.includes('SECRET-OUTSIDE-PORTAL'), `traversal ${p} does not escape`);
  }
  assert((await fetch(`${base}/`, { method: 'POST' })).status === 405, 'POST to a static path is 405');
});

await close();
await idp.close();
fs.rmSync(portal, { recursive: true, force: true });
fs.rmSync(path.join(os.tmpdir(), 'control-secret.txt'), { force: true });
finish('security');
