/**
 * A local AICO Control with a seeded organisation and a mock identity provider,
 * for looking at the portal and enrolling an engine by hand:
 *
 *   npm --prefix control run build && node control/test/demo.mjs [--port 7350] [--idp-port 7351]
 *
 * The mock IdP signs in whoever `login_hint` names, else the owner, with no
 * password. It is for a developer's machine only; never point a real
 * deployment at anything like it.
 */
import { ControlApp } from '../dist/lib.js';
import { startIdp, clock } from './harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(arg('port', 7350));
// The harness clock is frozen for tests; a demo that runs for hours needs real time or its ID tokens look expired.
setInterval(() => { clock.t = Date.now(); }, 1000).unref();

const idp = await startIdp({ clientId: 'aico-control-demo' });
const app = new ControlApp({ allowInsecureIdp: true, portalDir: path.join(here, '../dist/portal') });
await app.listen(port, '127.0.0.1');

const { tenant } = app.createTenant({
  slug: 'acme', name: 'Acme Industries', ownerEmail: 'owner@acme.test', ownerName: 'Olga Owner',
  settings: { idp: { issuer: idp.issuer, clientId: 'aico-control-demo' } },
});
const s = app.store;
const platform = s.createTeam(tenant.id, 'Platform');
const data = s.createTeam(tenant.id, 'Data');
const mk = (email, name, role, team) => s.createUser(tenant.id, { email, name, role, teamId: team?.id ?? null });
const dev = mk('dev@acme.test', 'Dana Developer', 'developer', platform);
const con = mk('contractor@acme.test', 'Chris Contractor', 'contractor', data);
mk('admin@acme.test', 'Ada Admin', 'admin');
mk('auditor@acme.test', 'Aud Itor', 'auditor');
mk('lead@acme.test', 'Lee Lead', 'team-lead', platform);
mk('sam@acme.test', 'Sam Smith', 'developer', data);

s.upsertPolicy(tenant.id, { scope: 'tenant', scopeId: '*', name: 'Everyone in the organisation', by: 'owner@acme.test', doc: { message: 'Acme IT policy.', contact: 'it@acme.test', deniedTools: ['Bash(rm -rf *)'], maxAutonomyLevel: 'L3', requiredGates: ['checks', 'security'] } });
s.upsertPolicy(tenant.id, { scope: 'role', scopeId: 'contractor', name: 'Role: contractor', by: 'owner@acme.test', doc: { allowedProviders: ['anthropic', 'ollama'], maxAutonomyLevel: 'L2', mcp: { mode: 'forbid' }, network: { mode: 'allow-list', domains: ['github.com', 'npmjs.org'] } } });
s.upsertBudget(tenant.id, { scope: 'tenant', scopeId: '*', period: 'month', limitUsd: 500 });
s.upsertBudget(tenant.id, { scope: 'user', scopeId: dev.id, period: 'day', limitUsd: 15 });

const now = Date.now();
for (let i = 0; i < 40; i++) {
  const u = i % 3 === 0 ? con : dev;
  s.insertUsage(tenant.id, { eventId: `seed${i}`, userId: u.id, teamId: u.teamId, deviceId: null, atMs: now - i * 6 * 3_600_000, model: i % 4 ? 'claude-sonnet-4' : 'deepseek-v4-flash', provider: 'x', inputTokens: 20_000 + i * 900, outputTokens: 2_000 + i * 70, costUsd: 0.12 + (i % 7) * 0.09, project: 'shop' });
}
const rec = (i, kind, action, outcome, who) => ({
  recordId: `seed-${i}`, tsMs: now - i * 1_800_000, source: 'engine', userId: who.id, userEmail: who.email, deviceId: null, kind, action, outcome,
  body: { schema: 'aico.audit/1', id: `seed-${i}`, time: new Date(now - i * 1_800_000).toISOString(), kind, action, outcome, user: who.email, tenant: 'acme', tool: action, target: outcome === 'denied' ? 'rm -rf /' : 'npm test', stage: outcome === 'denied' ? 'managed-policy' : undefined },
});
s.appendAudit(tenant.id, Array.from({ length: 24 }, (_, i) => rec(i, i % 5 === 0 ? 'turn.end' : 'tool.call', i % 5 === 0 ? 'turn' : i % 3 === 0 ? 'Bash' : 'Edit', i % 7 === 0 ? 'denied' : 'ok', i % 2 ? dev : con)));

console.log(`AICO Control demo\n  portal  ${app.publicUrl}/\n  idp     ${idp.issuer} (mock; signs in the owner by default)\n  enrol   aico control login ${app.publicUrl} --tenant acme\n  stop    Ctrl+C`);
