/**
 * The OAuth device authorization grant (RFC 8628) end to end, and the token
 * lifecycle that follows: rotation, reuse detection, revocation, expiry.
 */
import { assert, block, finish, startApp, startIdp, seedTenant, signIn, api, enrol, advance, clock } from './harness.mjs';

const idp = await startIdp();
const { app, base, close } = await startApp();
const seed = seedTenant(app, idp, 'acme');
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const start = (extra = {}) => api(base, '/oauth/device_authorization', { method: 'POST', body: { client_id: 'aico-engine', tenant: 'acme', device_name: 'laptop', platform: 'win32', aico_version: '0.51.0', ...extra } });
const poll = code => api(base, '/oauth/token', { method: 'POST', body: { client_id: 'aico-engine', grant_type: GRANT, device_code: code } });

await block('device authorization response (RFC 8628 3.2)', async () => {
  const d = await start();
  assert(d.status === 200, '200');
  assert(/^[BCDFGHJKMNPQRTVWXZ2346789]{4}-[BCDFGHJKMNPQRTVWXZ2346789]{4}$/.test(d.data.user_code), 'user code is 8 unambiguous characters');
  assert(d.data.device_code.length >= 40, 'device code is long and random');
  assert(d.data.verification_uri.endsWith('/device') && d.data.verification_uri_complete.includes(d.data.user_code), 'verification URIs are given');
  assert(d.data.expires_in === 600 && d.data.interval === 5, 'ten minutes, five-second interval');
  const row = app.store.db.prepare('SELECT device_code_hash, user_code FROM device_grants').all();
  assert(row.every(r => r.device_code_hash !== d.data.device_code), 'the device code is stored only as a hash');
  assert((await api(base, '/oauth/device_authorization', { method: 'POST', body: { client_id: 'other', tenant: 'acme' } })).status === 401, 'an unknown client_id is refused');
});

await block('pending, slow_down, deny, expiry', async () => {
  const d = await start();
  advance(6000);
  let r = await poll(d.data.device_code);
  assert(r.status === 400 && r.data.error === 'authorization_pending', 'pending before approval');
  r = await poll(d.data.device_code);
  assert(r.data.error === 'slow_down', 'polling again at once is slow_down');
  advance(6000);
  r = await poll(d.data.device_code);
  assert(r.data.error === 'slow_down', 'the interval was raised by 5 s, so 6 s is still too fast');
  advance(16_000);
  r = await poll(d.data.device_code);
  assert(r.data.error === 'authorization_pending', 'after the longer interval it is pending again');

  const s = await signIn(base, idp, 'acme', 'dev@acme.test');
  const page = await (await s.browser.req(`${base}/device?tenant=acme&code=${d.data.user_code}`)).text();
  assert(page.includes('laptop') && page.includes('win32'), 'the approval page shows which device is asking');
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  const deny = await s.browser.req(`${base}/device/decision`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams({ csrf, code: d.data.user_code, decision: 'deny' }).toString() });
  assert(deny.status === 200, 'deny is accepted');
  advance(20_000);
  r = await poll(d.data.device_code);
  assert(r.data.error === 'access_denied', 'the engine is told access_denied');

  const e = await start();
  advance(601_000);
  r = await poll(e.data.device_code);
  assert(r.data.error === 'expired_token', 'an unapproved code expires after ten minutes');
});

await block('approval protections', async () => {
  const d = await start();
  const s = await signIn(base, idp, 'acme', 'dev@acme.test');
  const page = await (await s.browser.req(`${base}/device?tenant=acme&code=${d.data.user_code}`)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  const form = (extra, headers = {}) => s.browser.req(`${base}/device/decision`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...headers }, body: new URLSearchParams({ csrf, code: d.data.user_code, decision: 'approve', ...extra }).toString() });
  assert((await form({ csrf: 'wrong' })).status === 403, 'a wrong csrf token is refused');
  assert((await form({}, { origin: 'https://evil.example' })).status === 403, 'a cross-origin approval is refused');
  const noSession = await fetch(`${base}/device/decision`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=approve&code=' + d.data.user_code });
  assert(noSession.status === 401, 'approving without a session is refused');
  const other = await signIn(base, idp, 'acme', 'contractor@acme.test');
  let wrong = 0;
  for (let i = 0; i < 8; i++) {
    const r = await other.browser.req(`${base}/device/decision`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams({ csrf: other.csrf, code: `BCDF-${String(i).padStart(4, '3')}`, decision: 'approve' }).toString() });
    if (r.status === 429) wrong++;
  }
  assert(wrong >= 2, 'guessing codes locks the session out (429)');
});

await block('enrolment issues tokens; the policy endpoint accepts them', async () => {
  const t = await enrol(base, idp, 'acme', 'dev@acme.test');
  assert(t.token_type === 'Bearer' && t.expires_in === 900 && t.refresh_token && t.access_token.split('.').length === 3, 'bearer access token + refresh token');
  assert(t.user.email === 'dev@acme.test' && t.tenant.slug === 'acme', 'the grant names the user and tenant');
  const hdr = JSON.parse(Buffer.from(t.access_token.split('.')[0], 'base64url'));
  assert(hdr.alg === 'EdDSA', 'access tokens are EdDSA');
  const p = await api(base, '/v1/engine/policy', { token: t.access_token });
  assert(p.status === 200 && p.data.schema === 'aico.control.policy/1' && p.data.user.email === 'dev@acme.test', 'GET /v1/engine/policy works with the token');
  const again = await poll('whatever');
  assert(again.data.error === 'invalid_grant', 'an unknown device code is invalid_grant');
  const dev = app.store.listDevices(seed.tenant.id);
  assert(dev.length >= 1 && dev[0].name === 'test-laptop', 'a device row exists');
});

await block('access tokens: tampering, expiry, wrong algorithm', async () => {
  const t = await enrol(base, idp, 'acme', 'dev@acme.test', { name: 'second' });
  const [h, p, s] = t.access_token.split('.');
  const flip = Buffer.from(p, 'base64url').toString().replace(seed.dev.id, seed.owner.id);
  assert((await api(base, '/v1/engine/policy', { token: `${h}.${Buffer.from(flip).toString('base64url')}.${s}` })).status === 401, 'a token with edited claims is refused');
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
  assert((await api(base, '/v1/engine/policy', { token: none })).status === 401, 'alg none is refused');
  assert((await api(base, '/v1/engine/policy', {})).status === 401, 'no token is refused');
  advance(901_000);
  assert((await api(base, '/v1/engine/policy', { token: t.access_token })).status === 401, 'an expired access token is refused');
});

await block('refresh token rotation, reuse detection, revocation', async () => {
  const t = await enrol(base, idp, 'acme', 'dev@acme.test', { name: 'rotating' });
  const refresh = rt => api(base, '/oauth/token', { method: 'POST', body: { client_id: 'aico-engine', grant_type: 'refresh_token', refresh_token: rt } });
  const r1 = await refresh(t.refresh_token);
  assert(r1.status === 200 && r1.data.refresh_token !== t.refresh_token, 'refreshing returns a new refresh token');
  assert((await api(base, '/v1/engine/policy', { token: r1.data.access_token })).status === 200, 'the new access token works');
  const r2 = await refresh(r1.data.refresh_token);
  assert(r2.status === 200, 'the rotated token can be used once');
  const stolen = await refresh(t.refresh_token);
  assert(stolen.status === 400 && stolen.data.error === 'invalid_grant', 'replaying the first (spent) refresh token fails');
  assert((await api(base, '/v1/engine/policy', { token: r2.data.access_token })).status === 401, 'reuse revoked the whole device: its access token stops working at once');
  assert((await refresh(r2.data.refresh_token)).data.error === 'invalid_grant', 'and its newest refresh token is dead too');
  const rows = app.store.queryAudit(seed.tenant.id, { kind: 'device', limit: 50 });
  assert(rows.some(r => r.action === 'revoke' && JSON.stringify(r.body).includes('reuse')), 'the reuse is in the audit chain');
});

await block('admin revocation and user disabling are immediate', async () => {
  const t = await enrol(base, idp, 'acme', 'contractor@acme.test', { name: 'to-revoke' });
  const admin = await signIn(base, idp, 'acme', 'admin@acme.test');
  const list = await api(base, '/v1/admin/devices', { browser: admin.browser });
  const dev = list.data.devices.find(d => d.name === 'to-revoke');
  assert(dev && !dev.revokedAt, 'the admin sees the device');
  const rev = await api(base, `/v1/admin/devices/${dev.id}/revoke`, { method: 'POST', browser: admin.browser, csrf: admin.csrf, body: {} });
  assert(rev.status === 200 && rev.data.changed, 'revoke succeeds');
  assert((await api(base, '/v1/engine/policy', { token: t.access_token })).status === 401, 'the device\'s still-valid access token is refused immediately');
  const rf = await api(base, '/oauth/token', { method: 'POST', body: { client_id: 'aico-engine', grant_type: 'refresh_token', refresh_token: t.refresh_token } });
  assert(rf.data.error === 'invalid_grant', 'its refresh token is refused');

  const t2 = await enrol(base, idp, 'acme', 'dev@acme.test', { name: 'to-disable' });
  app.store.updateUser(seed.tenant.id, seed.dev.id, { status: 'disabled' });
  assert((await api(base, '/v1/engine/policy', { token: t2.access_token })).status === 401, 'disabling a user stops their devices at once');
});

await close();
await idp.close();
finish('device-flow');
