/**
 * Roles and permissions: the table itself, then the same rules through HTTP.
 */
import { assert, block, finish, startApp, startIdp, seedTenant, signIn, api } from './harness.mjs';
import { PERMISSIONS, ROLES, can, canAssign, permissionsOf, hasPortalAccess } from '../dist/lib.js';

const EXPECT = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter(p => p !== 'tenant.manage'),
  auditor: ['tenant.read', 'users.read', 'teams.read', 'roles.read', 'policies.read', 'devices.read', 'audit.read', 'audit.export', 'usage.read', 'engine.use'],
  'team-lead': ['users.read', 'teams.read', 'roles.read', 'devices.read', 'usage.read', 'engine.use'],
  developer: ['engine.use'],
  contractor: ['engine.use'],
};

await block('the role -> permission table, exhaustively', async () => {
  for (const role of ROLES) for (const perm of PERMISSIONS) {
    assert(can(role, perm) === EXPECT[role].includes(perm), `${role} ${EXPECT[role].includes(perm) ? 'has' : 'lacks'} ${perm}`);
  }
  assert(permissionsOf('superuser').length === 0 && !can('', 'engine.use') && !can('OWNER', 'engine.use'), 'an unknown role has no permission at all');
  assert(!hasPortalAccess('developer') && !hasPortalAccess('contractor') && hasPortalAccess('team-lead') && hasPortalAccess('auditor'), 'portal access');
  assert(canAssign('owner', 'owner') && !canAssign('admin', 'owner') && canAssign('admin', 'auditor') && !canAssign('auditor', 'developer') && !canAssign('admin', 'wizard'), 'who may assign which role');
});

const idp = await startIdp();
const { app, base, close } = await startApp();
const S = seedTenant(app, idp, 'acme');
const who = {};
for (const [k, e] of [['owner', 'owner'], ['admin', 'admin'], ['auditor', 'auditor'], ['lead', 'lead'], ['dev', 'dev'], ['contractor', 'contractor']]) who[k] = await signIn(base, idp, 'acme', `${e}@acme.test`);
// A second team with its own member, so team scoping has something to hide.
const other = app.store.createTeam(S.tenant.id, 'Data');
app.store.createUser(S.tenant.id, { email: 'dana@acme.test', role: 'developer', teamId: other.id });
const get = (k, p) => api(base, p, { browser: who[k].browser });
const send = (k, method, p, body = {}) => api(base, p, { method, browser: who[k].browser, csrf: who[k].csrf, body });

await block('read endpoints by role', async () => {
  const table = {
    '/v1/admin/tenant': { owner: 200, admin: 200, auditor: 200, lead: 403, dev: 403, contractor: 403 },
    '/v1/admin/users': { owner: 200, admin: 200, auditor: 200, lead: 200, dev: 403, contractor: 403 },
    '/v1/admin/roles': { owner: 200, admin: 200, auditor: 200, lead: 200, dev: 403, contractor: 403 },
    '/v1/admin/policies': { owner: 200, admin: 200, auditor: 200, lead: 403, dev: 403, contractor: 403 },
    '/v1/admin/devices': { owner: 200, admin: 200, auditor: 200, lead: 200, dev: 403, contractor: 403 },
    '/v1/admin/audit': { owner: 200, admin: 200, auditor: 200, lead: 403, dev: 403, contractor: 403 },
    '/v1/admin/audit/verify': { owner: 200, admin: 200, auditor: 200, lead: 403, dev: 403, contractor: 403 },
    '/v1/admin/audit/export': { owner: 200, admin: 200, auditor: 200, lead: 403, dev: 403, contractor: 403 },
    '/v1/admin/usage?by=user': { owner: 200, admin: 200, auditor: 200, lead: 200, dev: 403, contractor: 403 },
  };
  for (const [p, rows] of Object.entries(table)) for (const [k, want] of Object.entries(rows)) {
    const r = await get(k, p);
    assert(r.status === want, `${k} GET ${p} -> ${want} (got ${r.status})`);
  }
  assert((await api(base, '/v1/admin/users')).status === 401, 'no session -> 401');
});

await block('write endpoints by role', async () => {
  const doc = { deniedTools: ['Bash'] };
  const cases = [
    ['PUT', '/v1/admin/policies', { scope: 'tenant', doc }, { owner: 200, admin: 200, auditor: 403, lead: 403, dev: 403 }],
    ['POST', '/v1/admin/teams', { name: `T-${Math.random().toString(36).slice(2, 7)}` }, { owner: 201, admin: 201, auditor: 403, lead: 403, dev: 403 }],
    ['PUT', '/v1/admin/budgets', { scope: 'tenant', period: 'month', limitUsd: 100 }, { owner: 200, admin: 200, auditor: 403, lead: 403, dev: 403 }],
    ['PUT', '/v1/admin/tenant', { graceHours: 72 }, { owner: 200, admin: 403, auditor: 403, lead: 403, dev: 403 }],
  ];
  for (const [method, p, body, rows] of cases) for (const [k, want] of Object.entries(rows)) {
    const b = { ...body };
    if (b.name) b.name = `T-${Math.random().toString(36).slice(2, 7)}`;
    const r = await send(k, method, p, b);
    assert(r.status === want, `${k} ${method} ${p} -> ${want} (got ${r.status})`);
  }
});

await block('team-lead sees only their own team', async () => {
  const users = (await get('lead', '/v1/admin/users')).data.users;
  assert(users.length > 0 && users.every(u => u.teamId === S.team.id), 'users of their team only');
  assert(!users.some(u => u.email === 'dana@acme.test'), 'not the other team\'s members');
  const teams = (await get('lead', '/v1/admin/teams')).data.teams;
  assert(teams.length === 1 && teams[0].id === S.team.id, 'only their team');
  const full = (await get('admin', '/v1/admin/users')).data.users;
  assert(full.length > users.length, 'an admin sees everyone');
});

await block('who may grant what', async () => {
  const d = S.dev.id;
  assert((await send('admin', 'PATCH', `/v1/admin/users/${d}`, { role: 'owner' })).status === 403, 'an admin cannot make an owner');
  assert((await send('admin', 'PATCH', `/v1/admin/users/${S.owner.id}`, { role: 'developer' })).status === 403, 'an admin cannot demote an owner');
  assert((await send('admin', 'PATCH', `/v1/admin/users/${S.owner.id}`, { status: 'disabled' })).status === 403, 'an admin cannot disable an owner');
  assert((await send('admin', 'PATCH', `/v1/admin/users/${S.admin.id}`, { role: 'owner' })).status === 403, 'nobody changes their own role (admin)');
  assert((await send('owner', 'PATCH', `/v1/admin/users/${S.owner.id}`, { role: 'admin' })).status === 403, 'nobody changes their own role (owner)');
  assert((await send('admin', 'PATCH', `/v1/admin/users/${d}`, { role: 'auditor' })).status === 200, 'an admin can assign auditor');
  assert(app.store.getUser(S.tenant.id, d).role === 'auditor', '... and it took effect');
  assert((await send('admin', 'PATCH', `/v1/admin/users/${d}`, { role: 'wizard' })).status === 403, 'unknown roles are refused');
  assert((await send('owner', 'PATCH', `/v1/admin/users/${d}`, { role: 'owner' })).status === 200, 'an owner can make another owner');
  assert((await send('owner', 'PATCH', `/v1/admin/users/${S.owner.id}`, { status: 'disabled' })).status === 403, 'an owner cannot disable themselves');
  assert((await send('owner', 'PATCH', `/v1/admin/users/${d}`, { status: 'disabled' })).status === 200, 'with two owners, one can disable the other');
  app.store.updateUser(S.tenant.id, d, { role: 'developer', status: 'active' });
  const one = await send('admin', 'POST', '/v1/admin/users', { email: 'new@acme.test', role: 'contractor' });
  assert(one.status === 201, 'an admin can invite');
  assert((await send('admin', 'POST', '/v1/admin/users', { email: 'new@acme.test', role: 'contractor' })).status === 409, 'a duplicate email is a conflict');
  assert((await send('admin', 'POST', '/v1/admin/users', { email: 'not-an-email', role: 'contractor' })).status === 400, 'a bad email is refused');
});

await block('a disabled owner loses access at once', async () => {
  // Only one owner is left (S.owner); make a second admin try via direct store check of the rule.
  const second = app.store.createUser(S.tenant.id, { email: 'o2@acme.test', role: 'owner' });
  const o2 = await signIn(base, idp, 'acme', 'o2@acme.test');
  assert((await api(base, `/v1/admin/users/${S.owner.id}`, { method: 'PATCH', browser: o2.browser, csrf: o2.csrf, body: { status: 'disabled' } })).status === 200, 'with two owners one may be disabled');
  assert((await api(base, `/v1/admin/users/${second.id}`, { method: 'PATCH', browser: who.owner.browser, csrf: who.owner.csrf, body: { status: 'disabled' } })).status === 401, 'the disabled owner\'s session is dead at once');
});

await close();
await idp.close();
finish('rbac');
