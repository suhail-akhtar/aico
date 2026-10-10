/**
 * Policy documents (validated with the engine's own schema), layering, and
 * budgets/usage leases.
 */
import { assert, block, finish, startApp, startIdp, seedTenant, signIn, api, enrol, advance, clock } from './harness.mjs';

const idp = await startIdp();
const { app, base, close } = await startApp();
const S = seedTenant(app, idp, 'acme');
let admin = await signIn(base, idp, 'acme', 'admin@acme.test');
const fresh = async t => (await api(base, '/oauth/token', { method: 'POST', body: { client_id: 'aico-engine', grant_type: 'refresh_token', refresh_token: t.refresh_token } })).data;
const put = (body) => api(base, '/v1/admin/policies', { method: 'PUT', browser: admin.browser, csrf: admin.csrf, body });
const validate = (doc) => api(base, '/v1/admin/policies/validate', { method: 'POST', browser: admin.browser, csrf: admin.csrf, body: { doc } });

await block('validation is the engine\'s own', async () => {
  const good = await validate({ deniedTools: ['Bash'], maxAutonomyLevel: 'L2', network: { mode: 'allow-list', domains: ['github.com'] } });
  assert(good.data.ok === true && good.data.problems.length === 0, 'a valid document passes with no problems');
  const bad = await validate({ maxAutonomyLevel: 'L9', localOnly: 'yes', budget: { perDayUsd: -3 } });
  assert(bad.data.ok === false && bad.data.problems.filter(p => p.level === 'error').length >= 3, 'three invalid values are three errors');
  assert(bad.data.problems.some(p => p.key === 'maxAutonomyLevel'), 'the problem names the key');
  const unknown = await validate({ deniedTools: ['Bash'], futureKey: 1 });
  assert(unknown.data.ok === true && unknown.data.problems.some(p => p.level === 'warning' && p.key === 'futureKey'), 'an unknown key is a warning, as in the engine');
  assert((await validate([1, 2])).data.ok === false && (await validate('x')).data.ok === false, 'non-objects are refused');
  const big = await validate({ message: 'x', deniedTools: Array.from({ length: 500 }, (_, i) => `T${'y'.repeat(190)}${i}`) });
  assert(big.data.ok === false, 'a document over 64 KB is refused');
});

await block('saving', async () => {
  const bad = await put({ scope: 'tenant', name: 'broken', doc: { maxAutonomyLevel: 'L9' } });
  assert(bad.status === 422 && bad.data.error === 'invalid_policy' && bad.data.problems.length > 0, 'an invalid policy is not saved (422 with the problems)');
  assert(app.store.listPolicies(S.tenant.id).length === 0, '... nothing stored');
  assert((await put({ scope: 'planet', doc: {} })).status === 400, 'bad scope');
  assert((await put({ scope: 'role', scopeId: 'wizard', doc: {} })).status === 400, 'unknown role');
  const ok = await put({ scope: 'tenant', name: 'Org baseline', doc: { deniedTools: ['Bash(rm *)'], message: 'Org rules', contact: 'it@acme.test' } });
  assert(ok.status === 200, 'tenant policy saved');
  await put({ scope: 'tenant', name: 'Org baseline v2', doc: { deniedTools: ['Bash(rm *)'], message: 'Org rules', contact: 'it@acme.test', maxAutonomyLevel: 'L3' } });
  assert(app.store.listPolicies(S.tenant.id).length === 1, 'saving the same scope replaces it');
  assert(app.store.queryAudit(S.tenant.id, { q: 'policy.save' }).length === 2, 'each save is in the audit chain');
});

await block('layers: tenant, then role, then team - never merged', async () => {
  await put({ scope: 'role', scopeId: 'contractor', name: 'Contractors', doc: { allowedProviders: ['ollama'], localOnly: true, mcp: { mode: 'forbid' } } });
  await put({ scope: 'team', scopeId: S.team.id, name: 'Platform team', doc: { network: { mode: 'allow-list', domains: ['github.com'] } } });
  const dev = await enrol(base, idp, 'acme', 'dev@acme.test');
  const con = await enrol(base, idp, 'acme', 'contractor@acme.test');
  const pd = (await api(base, '/v1/engine/policy', { token: dev.access_token })).data;
  const pc = (await api(base, '/v1/engine/policy', { token: con.access_token })).data;
  assert(pd.layers.map(l => l.scope).join() === 'tenant,team' && pd.team.name === 'Platform', 'developer in Platform: tenant, team');
  assert(pc.layers.map(l => l.scope).join() === 'tenant,role', 'contractor with no team: tenant, role');
  assert(pc.layers[1].policy.localOnly === true && pc.layers[0].policy.maxAutonomyLevel === 'L3', 'each layer keeps its own document untouched');
  assert(!pd.layers.some(l => l.policy.localOnly), 'the contractor role document does not leak to developers');
  assert(pd.role === 'developer' && pd.graceHours === 168 && pd.pollSeconds === 300 && /^[0-9a-f]{16}$/.test(pd.hash), 'envelope: role, grace, poll interval, hash');
  const h1 = pd.hash;
  await put({ scope: 'team', scopeId: S.team.id, name: 'Platform team', doc: { network: { mode: 'allow-list', domains: ['github.com', 'npmjs.org'] } } });
  const h2 = (await api(base, '/v1/engine/policy', { token: dev.access_token })).data.hash;
  assert(h1 !== h2, 'the hash changes when a layer does');
  const del = await api(base, `/v1/admin/policies/${app.store.listPolicies(S.tenant.id).find(p => p.scope === 'team').id}`, { method: 'DELETE', browser: admin.browser, csrf: admin.csrf, body: {} });
  assert(del.status === 200 && (await api(base, '/v1/engine/policy', { token: dev.access_token })).data.layers.length === 1, 'deleting a policy removes the layer');
  // Moving a user to a team applies that team's policy to their next fetch.
  await put({ scope: 'team', scopeId: S.team.id, name: 'Platform team', doc: { deniedTools: ['WebFetch'] } });
  app.store.updateUser(S.tenant.id, S.contractor.id, { teamId: S.team.id });
  assert((await api(base, '/v1/engine/policy', { token: con.access_token })).data.layers.map(l => l.scope).join() === 'tenant,role,team', 'team membership is read at fetch time');
});

await block('budgets: per-user daily cap, fleet-wide block, reset', async () => {
  const dev = await enrol(base, idp, 'acme', 'dev@acme.test', { name: 'budget-dev' });
  const set = (b) => api(base, '/v1/admin/budgets', { method: 'PUT', browser: admin.browser, csrf: admin.csrf, body: b });
  assert((await set({ scope: 'user', scopeId: S.dev.id, period: 'day', limitUsd: 1 })).status === 200, 'a $1/day budget for the developer');
  assert((await set({ scope: 'user', scopeId: S.dev.id, period: 'day', limitUsd: 0 })).status === 400, 'a zero budget is refused');
  const usage = (events) => api(base, '/v1/engine/usage', { method: 'POST', token: dev.access_token, body: { events } });
  const ev = (id, cost) => ({ id, at: clock.t, model: 'claude-x', provider: 'anthropic', inputTokens: 1000, outputTokens: 200, costUsd: cost, project: 'p' });
  let r = await usage([ev('e1', 0.6)]);
  assert(r.data.accepted === 1 && r.data.lease.blocked === false, '$0.60 of $1: not blocked');
  let pol = (await api(base, '/v1/engine/policy', { token: dev.access_token })).data;
  const budgetLayer = pol.layers.find(l => l.scope === 'budget');
  assert(budgetLayer && budgetLayer.policy.budget.perDayUsd === 1 && !pol.layers.some(l => l.scope === 'lease'), 'the engine is given perDayUsd to enforce offline');
  r = await usage([ev('e1', 0.6), ev('e2', 0.5)]);
  assert(r.data.accepted === 1 && r.data.duplicates === 1, 'a repeated event id is not double counted');
  assert(r.data.lease.blocked === true && /reached the daily AICO budget/.test(r.data.lease.reason), '$1.10 of $1: blocked, with a plain reason');
  pol = (await api(base, '/v1/engine/policy', { token: dev.access_token })).data;
  const lease = pol.layers.find(l => l.scope === 'lease');
  assert(lease && Array.isArray(lease.policy.allowedModels) && lease.policy.allowedModels.length === 0 && lease.policy.message === pol.lease.reason, 'the block is a deny-only layer (allowedModels: [])');
  assert(!Object.keys(lease.policy).some(k => !['allowedModels', 'allowedProviders', 'message'].includes(k)), 'which says nothing but "allow nothing"');
  advance(86_400_000);
  const dev2 = await fresh(dev);
  pol = (await api(base, '/v1/engine/policy', { token: dev2.access_token })).data;
  assert(pol.lease.blocked === false && !pol.layers.some(l => l.scope === 'lease'), 'the next UTC day it resets');
  const usage2 = (events) => api(base, '/v1/engine/usage', { method: 'POST', token: dev2.access_token, body: { events } });
  assert((await usage2([{ id: 'neg', at: clock.t, costUsd: -5 }, { id: 'huge', at: clock.t, costUsd: 1e9 }, { at: clock.t }, 'x'])).data.rejected === 4, 'negative, absurd, id-less and non-object events are rejected');
  const forged = await usage2([{ ...ev('spoof', 0.01), userId: S.owner.id, user: 'owner@acme.test', teamId: 'x' }]);
  assert(forged.data.accepted === 1 && app.store.usageSummary(S.tenant.id, 'user', {}).every(u => u.label !== 'owner@acme.test'), 'usage is attributed to the token\'s user, whatever the body says');
});

await block('team and tenant budgets, monthly period', async () => {
  admin = await signIn(base, idp, 'acme', 'admin@acme.test');
  const lead = await enrol(base, idp, 'acme', 'lead@acme.test', { name: 'lead-laptop' });
  const dev = await enrol(base, idp, 'acme', 'dev@acme.test', { name: 'dev-2' });
  const set = (b) => api(base, '/v1/admin/budgets', { method: 'PUT', browser: admin.browser, csrf: admin.csrf, body: b });
  await set({ scope: 'team', scopeId: S.team.id, period: 'month', limitUsd: 2 });
  await set({ scope: 'tenant', period: 'day', limitUsd: 500 });
  await api(base, '/v1/engine/usage', { method: 'POST', token: lead.access_token, body: { events: [{ id: 'l1', at: clock.t, model: 'm', costUsd: 2.5 }] } });
  const pd = (await api(base, '/v1/engine/policy', { token: dev.access_token })).data;
  assert(pd.lease.blocked && /Your team reached the monthly/.test(pd.lease.reason), 'the team\'s monthly cap blocks a teammate who spent nothing');
  const other = await enrol(base, idp, 'acme', 'auditor@acme.test', { name: 'aud' });
  const po = (await api(base, '/v1/engine/policy', { token: other.access_token })).data;
  assert(!po.lease.blocked && po.lease.limits.length === 1 && po.lease.limits[0].scope === 'tenant', 'a person outside the team is not blocked and sees only the tenant budget');
  assert(po.layers.find(l => l.scope === 'budget').policy.budget.perDayUsd === 500, 'the tenant day cap becomes their local cap');
});

await block('usage reports', async () => {
  admin = await signIn(base, idp, 'acme', 'admin@acme.test');
  const by = async k => (await api(base, `/v1/admin/usage?by=${k}`, { browser: admin.browser })).data;
  const byUser = await by('user');
  assert(byUser.estimated === true && byUser.rows.length >= 2 && byUser.totalUsd > 3, 'by user: estimated, several rows');
  assert((await by('team')).rows.some(r => r.label === 'Platform'), 'by team');
  assert((await by('model')).rows.some(r => r.key === 'claude-x' && r.inputTokens >= 1000), 'by model, with tokens');
  assert((await by('day')).rows.length >= 1, 'by day');
  assert((await api(base, '/v1/admin/usage?by=planet', { browser: admin.browser })).status === 400, 'bad grouping');
  const lead = await signIn(base, idp, 'acme', 'lead@acme.test');
  const mine = (await api(base, '/v1/admin/usage?by=user', { browser: lead.browser })).data;
  assert(mine.rows.length > 0 && mine.rows.every(r => ['lead@acme.test', 'dev@acme.test', 'contractor@acme.test'].includes(r.label)) && !mine.rows.some(r => r.label === 'auditor@acme.test') && mine.totalUsd <= byUser.totalUsd, 'a team lead gets a team-scoped report');
  const budgets = (await api(base, '/v1/admin/budgets', { browser: admin.browser })).data.budgets;
  assert(budgets.length === 3 && budgets.every(b => typeof b.spentUsd === 'number'), 'budgets list shows spend');
});

await close();
await idp.close();
finish('policy');
