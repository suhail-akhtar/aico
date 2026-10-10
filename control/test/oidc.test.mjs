/**
 * OIDC sign-in against a real (mock) identity provider: the happy path with
 * PKCE, and every way a hostile or broken provider response must be refused.
 */
import { assert, block, finish, startApp, startIdp, seedTenant, signIn, Browser, api } from './harness.mjs';
import { resetOidcCaches } from '../dist/lib.js';

const idp = await startIdp({ clientSecret: 'idp-secret-for-test' });
const { app, base, close } = await startApp();
const seed = seedTenant(app, idp, 'acme');

await block('authorization code + PKCE sign-in', async () => {
  const s = await signIn(base, idp, 'acme', 'owner@acme.test');
  assert(s.status === 200 && s.me.user.email === 'owner@acme.test', 'owner signs in and /v1/me names them');
  assert(s.me.user.role === 'owner' && s.me.permissions.includes('tenant.manage'), 'owner has tenant.manage');
  assert(typeof s.csrf === 'string' && s.csrf.length >= 20, 'the session carries a csrf token');
  assert(idp.requests.includes('GET /authorize') && idp.requests.includes('POST /token') && idp.requests.includes('GET /jwks'), 'discovery, authorize, token and jwks were all used');
  const cookie = s.browser.cookieFor(base);
  assert(cookie.startsWith('aico_sid='), 'the session cookie is set');
  const raw = await fetch(`${base}/auth/login?tenant=acme`, { redirect: 'manual' });
  const loc = new URL(raw.headers.get('location'));
  assert(loc.searchParams.get('code_challenge_method') === 'S256' && loc.searchParams.get('nonce') && loc.searchParams.get('state'), 'the authorize redirect carries PKCE S256, state and nonce');
  assert(app.store.getSession(cookie.split('=')[1]) === undefined, 'the raw cookie value is not the stored key (only its hash is)');
});

await block('the IdP client secret is encrypted at rest', async () => {
  const row = app.store.db.prepare('SELECT settings FROM tenants WHERE slug = ?').get('acme');
  assert(!row.settings.includes('idp-secret-for-test'), 'plaintext secret is not in the database');
  assert(row.settings.includes('clientSecretSealed'), 'a sealed value is');
  const t = await api(base, '/v1/admin/tenant', { browser: (await signIn(base, idp, 'acme', 'owner@acme.test')).browser });
  assert(t.status === 200 && t.data.settings.idp.hasSecret === true && !JSON.stringify(t.data).includes('idp-secret'), 'the API reports hasSecret, never the secret');
});

await block('hostile ID tokens are refused', async () => {
  for (const [mode, why] of [['badsig', 'wrong signing key'], ['nonce', 'nonce mismatch'], ['aud', 'wrong audience'], ['iss', 'wrong issuer'], ['expired', 'expired'], ['alg-none', 'alg none'], ['alg-hs256', 'HS256 key confusion'], ['unverified', 'unverified email']]) {
    resetOidcCaches();
    idp.tamper = mode;
    const s = await signIn(base, idp, 'acme', 'owner@acme.test');
    assert(s.status === 401 || (s.me === undefined && s.status >= 400), `${why}: no session is created (status ${s.status})`);
  }
  idp.tamper = undefined;
});

await block('state is single use; a replayed or forged callback is refused', async () => {
  const b = new Browser();
  const first = await b.req(`${base}/auth/login?tenant=acme&hint=owner@acme.test`);
  const idpRes = await b.req(first.headers.get('location'));
  const cb = idpRes.headers.get('location');
  const ok = await b.req(cb);
  assert(ok.status === 302, 'first use of the callback succeeds');
  const replay = await new Browser().req(cb);
  assert(replay.status === 400, 'replaying the same callback fails (state consumed)');
  const forged = await new Browser().req(`${base}/auth/callback?code=abc&state=forged`);
  assert(forged.status === 400, 'a forged state fails');
});

await block('who may sign in', async () => {
  const stranger = await signIn(base, idp, 'acme', 'stranger@elsewhere.test');
  assert(stranger.status === 403, 'an unknown email is refused when JIT is off');
  app.store.updateTenant(seed.tenant.id, { settings: { jit: true } });
  const jit = await signIn(base, idp, 'acme', 'newbie@acme.test');
  assert(jit.me?.user.role === 'developer', 'with JIT on, a new person becomes a developer (never more)');
  app.store.updateUser(seed.tenant.id, seed.dev.id, { status: 'disabled' });
  const disabled = await signIn(base, idp, 'acme', 'dev@acme.test');
  assert(disabled.status === 403, 'a disabled user cannot sign in');
  const unknownTenant = await new Browser().req(`${base}/auth/login?tenant=nope`);
  assert(unknownTenant.status === 404, 'an unknown tenant is a 404');
  idp.denyNext = true;
  const denied = await signIn(base, idp, 'acme', 'owner@acme.test');
  assert(denied.status === 403, 'an IdP error response (access_denied) creates no session');
});

await block('open redirect through next is impossible', async () => {
  const b = new Browser();
  const first = await b.req(`${base}/auth/login?tenant=acme&hint=owner@acme.test&next=//evil.example/x`);
  const cb = (await b.req(first.headers.get('location'))).headers.get('location');
  const fin = await b.req(cb);
  assert(fin.headers.get('location') === '/', 'a protocol-relative next becomes /');
});

await block('sign-in is audited', async () => {
  const rows = app.store.queryAudit(seed.tenant.id, { kind: 'auth', limit: 100 });
  assert(rows.some(r => r.action === 'login' && r.outcome === 'ok'), 'a successful login is in the chain');
  assert(rows.some(r => r.action === 'login' && r.outcome !== 'ok'), 'failed logins are in the chain too');
});

await close();
await idp.close();
finish('oidc');
