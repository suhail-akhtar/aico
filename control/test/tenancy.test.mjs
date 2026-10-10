/**
 * Tenant isolation (ADR 0040): two organisations with identical emails, team
 * names and policy scopes on one server. Nothing of one is reachable from the
 * other through the admin API, the engine API, tokens, sessions or the store.
 */
import { assert, block, finish, startApp, startIdp, seedTenant, signIn, api, enrol } from './harness.mjs';

const idp = await startIdp();
const { app, base, close } = await startApp();
const A = seedTenant(app, idp, 'acme');
const B = seedTenant(app, idp, 'globex');
// The same person in both organisations, with the same team name.
app.store.createUser(A.tenant.id, { email: 'shared@both.test', role: 'developer' });
app.store.createUser(B.tenant.id, { email: 'shared@both.test', role: 'developer' });

const adminA = await signIn(base, idp, 'acme', 'admin@acme.test');
const adminB = await signIn(base, idp, 'globex', 'admin@globex.test');
const doc = { deniedTools: ['Bash'], message: 'tenant policy' };
await api(base, '/v1/admin/policies', { method: 'PUT', browser: adminA.browser, csrf: adminA.csrf, body: { scope: 'tenant', name: 'A policy', doc } });
await api(base, '/v1/admin/policies', { method: 'PUT', browser: adminB.browser, csrf: adminB.csrf, body: { scope: 'tenant', name: 'B policy', doc: { deniedTools: ['Write'], message: 'B only' } } });
await api(base, '/v1/admin/budgets', { method: 'PUT', browser: adminB.browser, csrf: adminB.csrf, body: { scope: 'tenant', period: 'day', limitUsd: 50 } });

const tokA = await enrol(base, idp, 'acme', 'dev@acme.test', { name: 'a-laptop' });
const tokB = await enrol(base, idp, 'globex', 'dev@globex.test', { name: 'b-laptop' });
const mut = (a, method, path, body = {}) => api(base, path, { method, browser: a.browser, csrf: a.csrf, body });

await block('lists contain only the caller\'s tenant', async () => {
  const users = (await api(base, '/v1/admin/users', { browser: adminA.browser })).data.users;
  assert(users.length > 0 && users.every(u => u.email.endsWith('@acme.test') || u.email === 'shared@both.test'), 'users');
  assert(!users.some(u => u.email.endsWith('@globex.test')), 'no globex user appears');
  const pols = (await api(base, '/v1/admin/policies', { browser: adminA.browser })).data.policies;
  assert(pols.length === 1 && pols[0].name === 'A policy', 'policies');
  const devs = (await api(base, '/v1/admin/devices', { browser: adminA.browser })).data.devices;
  assert(devs.every(d => d.user.endsWith('@acme.test')) && !devs.some(d => d.name === 'b-laptop'), 'devices');
  assert((await api(base, '/v1/admin/budgets', { browser: adminA.browser })).data.budgets.length === 0, 'budgets');
  assert((await api(base, '/v1/admin/teams', { browser: adminA.browser })).data.teams.length === 1, 'teams (same name "Platform" in both)');
});

await block('ids from the other tenant are simply not found', async () => {
  const bUser = B.dev.id;
  const bDevice = app.store.listDevices(B.tenant.id)[0].id;
  const bPolicy = app.store.listPolicies(B.tenant.id)[0].id;
  const bBudget = app.store.listBudgets(B.tenant.id)[0].id;
  assert((await mut(adminA, 'PATCH', `/v1/admin/users/${bUser}`, { status: 'disabled' })).status === 404, 'PATCH a foreign user');
  assert(app.store.getUser(B.tenant.id, bUser).status === 'active', '... and it did not change');
  assert((await mut(adminA, 'POST', `/v1/admin/devices/${bDevice}/revoke`)).status === 404, 'revoke a foreign device');
  assert(!app.store.getDevice(B.tenant.id, bDevice).revokedAt, '... and it stays enrolled');
  assert((await mut(adminA, 'DELETE', `/v1/admin/policies/${bPolicy}`)).status === 404, 'delete a foreign policy');
  assert(app.store.listPolicies(B.tenant.id).length === 1, '... and it is still there');
  assert((await mut(adminA, 'DELETE', `/v1/admin/budgets/${bBudget}`)).status === 404, 'delete a foreign budget');
  assert((await mut(adminA, 'PATCH', `/v1/admin/teams/${B.team.id}`, { name: 'hijacked' })).status === 404, 'rename a foreign team');
  assert((await mut(adminA, 'DELETE', `/v1/admin/teams/${B.team.id}`)).status === 404, 'delete a foreign team');
  assert((await mut(adminA, 'PUT', '/v1/admin/policies', { scope: 'team', scopeId: B.team.id, doc })).status === 400, 'policy scoped to a foreign team');
  assert((await mut(adminA, 'PUT', '/v1/admin/budgets', { scope: 'user', scopeId: bUser, period: 'day', limitUsd: 1 })).status === 400, 'budget for a foreign user');
  assert((await mut(adminA, 'POST', '/v1/admin/users', { email: 'x@acme.test', role: 'developer', teamId: B.team.id })).status === 400, 'create a user in a foreign team');
});

await block('the same email and team name coexist', async () => {
  assert(app.store.findUserByEmail(A.tenant.id, 'shared@both.test').id !== app.store.findUserByEmail(B.tenant.id, 'shared@both.test').id, 'two distinct accounts');
  assert(app.store.getTeam(A.tenant.id, B.team.id) === undefined && app.store.getUser(A.tenant.id, B.dev.id) === undefined, 'store lookups with the wrong tenant return nothing');
  const s = await signIn(base, idp, 'acme', 'shared@both.test');
  assert(s.me.tenant.slug === 'acme', 'signing in to acme gives an acme session');
  const t = await api(base, '/v1/admin/tenant', { browser: adminA.browser });
  assert(t.data.slug === 'acme', 'tenant endpoint answers for the session\'s tenant only');
  assert((await mut(adminA, 'PUT', '/v1/admin/tenant', { name: 'hijack' })).status === 403, 'an admin cannot even change their own tenant\'s settings');
  assert(app.store.getTenant(B.tenant.id).name === 'globex Inc', 'globex untouched');
});

await block('engine API is scoped by the token', async () => {
  const pA = (await api(base, '/v1/engine/policy', { token: tokA.access_token })).data;
  const pB = (await api(base, '/v1/engine/policy', { token: tokB.access_token })).data;
  assert(pA.tenant.slug === 'acme' && pA.layers.length === 1 && pA.layers[0].policy.message === 'tenant policy', 'acme device gets acme policy');
  assert(pB.tenant.slug === 'globex' && pB.layers.some(l => l.policy.message === 'B only'), 'globex device gets globex policy');
  const rec = id => ({ schema: 'aico.audit/1', id, time: new Date().toISOString(), kind: 'tool.call', action: 'Bash', outcome: 'ok', tenant: 'globex', user: 'ceo@globex.test' });
  const post = await api(base, '/v1/engine/audit', { method: 'POST', token: tokA.access_token, body: { records: [rec('same-id'), rec('x2')] } });
  assert(post.data.accepted === 2, 'acme engine posts audit');
  const post2 = await api(base, '/v1/engine/audit', { method: 'POST', token: tokB.access_token, body: { records: [rec('same-id')] } });
  assert(post2.data.accepted === 1 && post2.data.duplicates === 0, 'the same record id in another tenant is not a duplicate');
  const aRows = app.store.queryAudit(A.tenant.id, { kind: 'tool.call' });
  assert(aRows.length === 2 && aRows.every(r => r.userEmail === 'dev@acme.test' && r.body.tenant === 'acme' && r.body.user === 'dev@acme.test'), 'identity and tenant are the token\'s, not the record\'s claim');
  assert(app.store.queryAudit(B.tenant.id, { kind: 'tool.call' }).length === 1, 'globex has exactly its own record');
  assert(app.store.verifyAudit(A.tenant.id).ok && app.store.verifyAudit(B.tenant.id).ok, 'each tenant has its own valid chain');
  assert(app.store.verifyAudit(A.tenant.id).head.hash !== app.store.verifyAudit(B.tenant.id).head.hash, 'with different heads');
});

await block('usage and budgets do not cross', async () => {
  await api(base, '/v1/engine/usage', { method: 'POST', token: tokA.access_token, body: { events: [{ id: 'u1', at: Date.now(), model: 'm', costUsd: 3, inputTokens: 10, outputTokens: 5 }] } });
  const u = (await api(base, '/v1/admin/usage?by=model', { browser: adminB.browser })).data;
  assert(u.rows.length === 0 && u.totalUsd === 0, 'globex sees none of acme\'s spend');
  assert((await api(base, '/v1/admin/usage?by=model', { browser: adminA.browser })).data.totalUsd === 3, 'acme sees its own');
  const lease = (await api(base, '/v1/engine/policy', { token: tokB.access_token })).data.lease;
  assert(lease.limits.length === 1 && lease.limits[0].spentUsd === 0 && !lease.blocked, 'globex\'s $50 budget has seen no spend');
});

await block('a token cannot be re-pointed at another tenant', async () => {
  const [h, p, s] = tokA.access_token.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  claims.tid = B.tenant.id; claims.sub = B.dev.id;
  const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
  assert((await api(base, '/v1/engine/policy', { token: forged })).status === 401, 'edited tid/sub fails the signature');
  const row = app.store.db.prepare('SELECT tenant_id FROM sessions LIMIT 1').get();
  assert(row.tenant_id.startsWith('ten_'), 'sessions carry their tenant');
});

await block('schema: every table except meta and tenants has tenant_id', async () => {
  const tables = app.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  const missing = tables.filter(t => !['meta', 'tenants'].includes(t) && !app.store.db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'tenant_id'));
  assert(tables.length >= 10 && missing.length === 0, `no table lacks tenant_id (${missing.join(', ') || 'all have it'})`);
});

await close();
await idp.close();
finish('tenancy');
