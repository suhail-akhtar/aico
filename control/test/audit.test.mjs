/**
 * The audit trail: ingestion, the per-tenant hash chain, tamper detection,
 * search and export.
 */
import { assert, block, finish, startApp, startIdp, seedTenant, signIn, api, enrol } from './harness.mjs';
import { GENESIS, chainHash } from '../dist/lib.js';

const idp = await startIdp();
const { app, base, close } = await startApp();
const S = seedTenant(app, idp, 'acme');
const admin = await signIn(base, idp, 'acme', 'admin@acme.test');
const dev = await enrol(base, idp, 'acme', 'dev@acme.test');
const rec = (id, extra = {}) => ({ schema: 'aico.audit/1', id, time: new Date().toISOString(), kind: 'tool.call', action: 'Bash', outcome: 'ok', tool: 'Bash', target: 'npm test', aicoVersion: '0.51.0', ...extra });
const post = (records, token = dev.access_token) => api(base, '/v1/engine/audit', { method: 'POST', token, body: { records } });

await block('ingestion', async () => {
  const before = app.store.verifyAudit(S.tenant.id).count;
  const r = await post([rec('a1'), rec('a2', { outcome: 'denied', decision: 'deny', stage: 'managed-policy', tool: 'WebFetch', target: 'https://x.test/p' }), rec('a3', { kind: 'turn.end', action: 'turn', model: 'claude-x', inputTokens: 10, outputTokens: 5, costUsd: 0.01 })]);
  assert(r.status === 200 && r.data.accepted === 3 && r.data.duplicates === 0 && r.data.rejected === 0, 'three records accepted');
  assert(r.data.head.seq === before + 3 && /^[0-9a-f]{64}$/.test(r.data.head.hash), 'the head advances and is returned');
  const again = await post([rec('a1'), rec('a4')]);
  assert(again.data.accepted === 1 && again.data.duplicates === 1, 'a re-sent record is a duplicate, not a second row (retries are safe)');
  const bad = await post([{ id: 'x' }, 'str', { id: 'y', kind: 'k', action: 'a', outcome: 'ok', time: 'not a date' }, rec('ok1')]);
  assert(bad.data.accepted === 1 && bad.data.rejected === 3, 'malformed records are rejected individually');
  assert((await post(Array.from({ length: 1001 }, (_, i) => rec(`n${i}`)))).status === 400, 'more than 1000 per batch is refused');
  assert((await api(base, '/v1/engine/audit', { method: 'POST', token: dev.access_token, body: {} })).status === 400, 'a body without records is refused');
  assert((await api(base, '/v1/engine/audit', { method: 'POST', body: { records: [] } })).status === 401, 'no token, no ingestion');
});

await block('what is stored: a whitelist, the token\'s identity, bounded strings', async () => {
  await post([rec('w1', { prompt: 'SECRET PROMPT', fileBody: 'top secret', apiKey: 'sk-live', target: 'x'.repeat(5000), user: 'ceo@acme.test', tenant: 'other' })]);
  const row = app.store.queryAudit(S.tenant.id, { q: 'w1' }).find(r => r.recordId.endsWith(':w1'));
  assert(row && !('prompt' in row.body) && !('fileBody' in row.body) && !('apiKey' in row.body), 'fields outside aico.audit/1 are dropped');
  assert(row.body.target.length === 2000, 'long strings are cut');
  assert(row.body.user === 'dev@acme.test' && row.body.tenant === 'acme' && row.userEmail === 'dev@acme.test', 'user and tenant come from the token');
  assert(row.recordId === `${S.dev.id}:w1`, 'record ids are namespaced by user, so one engine cannot pre-claim another\'s ids');
  const con = await enrol(base, idp, 'acme', 'contractor@acme.test');
  const r = await post([rec('w1')], con.access_token);
  assert(r.data.accepted === 1, 'the same raw id from another person is a separate record');
});

await block('the chain verifies and is deterministic', async () => {
  const v = app.store.verifyAudit(S.tenant.id);
  assert(v.ok && v.count > 10, `chain of ${v.count} records verifies`);
  const rows = app.store.queryAudit(S.tenant.id, { limit: 5000 }).reverse();
  assert(rows[0].prevHash === GENESIS && rows.every((r, i) => i === 0 || r.prevHash === rows[i - 1].hash), 'each record points at the previous hash, the first at genesis');
  assert(rows.every(r => chainHash(r.prevHash, S.tenant.id, r.seq, r) === r.hash), 'every hash recomputes from the visible fields');
  assert(rows.some(r => r.source === 'control') && rows.some(r => r.source === 'engine'), 'server events and engine events share one chain');
  const api1 = await api(base, '/v1/admin/audit/verify', { browser: admin.browser });
  assert(api1.data.ok && api1.data.head.hash === v.head.hash, 'the verify endpoint returns the head hash for external anchoring');
});

await block('append-only at the storage layer', async () => {
  let blocked = 0;
  try { app.store.db.prepare('UPDATE audit SET outcome = ? WHERE tenant_id = ?').run('ok', S.tenant.id); } catch { blocked++; }
  try { app.store.db.prepare('DELETE FROM audit WHERE tenant_id = ?').run(S.tenant.id); } catch { blocked++; }
  assert(blocked === 2, 'UPDATE and DELETE are aborted by triggers');
});

await block('tamper detection (the triggers are removed on purpose to simulate a database-level attacker)', async () => {
  const db = app.store.db;
  const pick = (n) => db.prepare('SELECT seq FROM audit WHERE tenant_id = ? ORDER BY seq LIMIT 1 OFFSET ?').get(S.tenant.id, n).seq;
  db.exec('DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;');
  const seq = pick(6);

  const orig = db.prepare('SELECT outcome, body FROM audit WHERE tenant_id = ? AND seq = ?').get(S.tenant.id, seq);
  db.prepare("UPDATE audit SET outcome = 'ok' WHERE tenant_id = ? AND seq = ?").run(S.tenant.id, seq);
  db.prepare("UPDATE audit SET body = replace(body, '\"action\"', '\"actioN\"') WHERE tenant_id = ? AND seq = ?").run(S.tenant.id, seq);
  let v = app.store.verifyAudit(S.tenant.id);
  assert(!v.ok && v.brokenAt === seq && /content/.test(v.reason), `editing a record is detected at seq ${seq}`);
  db.prepare('UPDATE audit SET outcome = ?, body = ? WHERE tenant_id = ? AND seq = ?').run(orig.outcome, orig.body, S.tenant.id, seq);
  assert(app.store.verifyAudit(S.tenant.id).ok, 'restoring the original makes it verify again');

  const victim = pick(8);
  const saved = db.prepare('SELECT * FROM audit WHERE tenant_id = ? AND seq = ?').get(S.tenant.id, victim);
  db.prepare('DELETE FROM audit WHERE tenant_id = ? AND seq = ?').run(S.tenant.id, victim);
  v = app.store.verifyAudit(S.tenant.id);
  assert(!v.ok && v.brokenAt === victim && /gap/.test(v.reason), `deleting a record is detected as a sequence gap at ${victim}`);
  db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(saved));
  assert(app.store.verifyAudit(S.tenant.id).ok, 'putting it back verifies');

  // A forger who rewrites a record AND its own hash still breaks the link to the next record.
  const target = pick(10);
  const r = db.prepare('SELECT * FROM audit WHERE tenant_id = ? AND seq = ?').get(S.tenant.id, target);
  const forgedBody = JSON.stringify({ ...JSON.parse(r.body), action: 'Innocent' });
  const newHash = chainHash(r.prev_hash, S.tenant.id, r.seq, { recordId: r.record_id, tsMs: r.ts_ms, source: r.source, userId: r.user_id, userEmail: r.user_email, deviceId: r.device_id, kind: r.kind, action: r.action, outcome: r.outcome, body: JSON.parse(forgedBody) });
  db.prepare('UPDATE audit SET body = ?, hash = ? WHERE tenant_id = ? AND seq = ?').run(forgedBody, newHash, S.tenant.id, target);
  v = app.store.verifyAudit(S.tenant.id);
  assert(!v.ok && v.brokenAt === target + 1 && /previous-hash/.test(v.reason), 'rewriting a record and its hash breaks the next link');
  db.prepare('UPDATE audit SET body = ?, hash = ? WHERE tenant_id = ? AND seq = ?').run(r.body, r.hash, S.tenant.id, target);
  assert(app.store.verifyAudit(S.tenant.id).ok, 'chain restored');
  db.exec(`CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
           CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;`);
});

await block('search, filters and export', async () => {
  const q = async (qs) => (await api(base, `/v1/admin/audit?${qs}`, { browser: admin.browser })).data.records;
  assert((await q('kind=turn.end')).every(r => r.kind === 'turn.end') && (await q('kind=turn.end')).length >= 1, 'filter by kind');
  assert((await q('outcome=denied')).some(r => r.detail.stage === 'managed-policy'), 'filter by outcome finds the denial');
  assert((await q('user=dev@')).every(r => r.user.includes('dev@')), 'filter by user');
  assert((await q('q=WebFetch')).length >= 1, 'free-text search reaches the record body');
  assert((await q('source=control')).every(r => r.source === 'control'), 'filter by source');
  const page1 = await q('limit=5');
  const page2 = await q(`limit=5&before=${page1[page1.length - 1].seq}`);
  assert(page1.length === 5 && page2.length === 5 && page2[0].seq < page1[4].seq, 'paging by sequence');
  assert((await q('q=%25')).length >= 0, 'a LIKE wildcard in the query is neutralised');

  await post([rec('csv1', { target: '=HYPERLINK("http://evil","x")' })]);
  const csv = await (await admin.browser.req(`${base}/v1/admin/audit/export?format=csv`)).text();
  assert(csv.startsWith('seq,time,source,user,kind,action,outcome') && csv.includes("'=HYPERLINK"), 'CSV export neutralises spreadsheet formulas');
  const jl = await (await admin.browser.req(`${base}/v1/admin/audit/export`)).text();
  const first = JSON.parse(jl.split('\n')[0]);
  assert(first.seq === 1 && /^[0-9a-f]{64}$/.test(first.hash), 'JSONL export carries sequence and hash per line');
  assert(app.store.queryAudit(S.tenant.id, { q: 'audit.export' }).length >= 2, 'exporting the audit trail is itself audited');
});

await close();
await idp.close();
finish('audit');
