/**
 * AICO Control, the engine side (ADR 0040), against a mock control server.
 *
 * Why it exists: the organisation's policy is only worth anything if the
 * engine (a) enrols without ever putting a token anywhere but the vault,
 * (b) applies what it is served as more deny-only layers that cannot loosen the
 * system policy file, (c) keeps applying the last policy when the server is
 * unreachable, then restricts once the offline allowance is spent, (d) uploads
 * audit and usage at least once without duplicating or losing records, and
 * (e) never trips the server's refresh-token theft detection by racing itself.
 * Each block asserts one of those. The real server and its portal have their
 * own suites (npm run test:control).
 *
 * Offline and free: a loopback mock server, a memory vault, an isolated
 * AICO_HOME; backoff sleeps are injected so nothing waits.
 */

// A store of this process's own: nothing below may touch ~/.aico. Must stay first.
import { testHome } from './lib/test-home.mjs';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];
fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');

const T = await import(process.env.AICO_TEST_DIST
  ? pathToFileURL(path.join(process.env.AICO_TEST_DIST, 'test-exports.js')).href
  : new URL('../dist-test/test-exports.js', import.meta.url).href);
const { Control: C } = T;

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; failures.push(name); console.log(`  FAIL ${name}`); }
}
async function block(title, fn) {
  console.log(`\n== ${title} ==`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}

if (fs.existsSync(T.systemPolicyPath())) {
  console.log(`This machine has a managed policy at ${T.systemPolicyPath()}; this suite needs an unmanaged one. Skipped.`);
  process.exit(0);
}

T.configureVault({ dir: path.join(testHome, 'vault'), keyProvider: T.memoryKeyProvider() });
const noSleep = async () => undefined;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-control-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── the mock control server ─────────────────────────────────────────

const mock = {
  pendingPolls: 2, expiresIn: 900, refreshCount: 0, tokenSeq: 0, usedRefresh: new Set(), validRefresh: new Set(), revoked: false,
  layers: [{ scope: 'tenant', scopeId: '*', name: 'Org baseline', policy: { deniedTools: ['Bash(rm *)'], message: 'Org rules', contact: 'it@acme.test' } }],
  lease: { blocked: false, limits: [] }, graceHours: 72, pollSeconds: 60, hash: 'h1', policyFailures: 0, auditFailures: 0,
  audit: [], usage: [], auditPosts: 0, hostile: false, offline: false, role: 'developer',
};
let baseUrl = '';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (mock.offline) { req.socket.destroy(); return; }
    const body = raw ? JSON.parse(raw) : {};
    const issue = () => {
      const n = ++mock.tokenSeq;
      const refresh = `refresh-${n}`;
      mock.validRefresh.add(refresh);
      return { access_token: `access-${n}`, token_type: 'Bearer', expires_in: mock.expiresIn, refresh_token: refresh, tenant: { slug: 'acme', name: 'Acme Inc' }, user: { email: 'dev@acme.test', name: 'Dev', role: mock.role }, device_id: 'dev_1' };
    };
    if (req.url === '/oauth/device_authorization') {
      const origin = mock.hostile ? 'https://evil.example' : baseUrl;
      return send(200, { device_code: 'DEVCODE', user_code: 'BCDF-2346', verification_uri: `${origin}/device`, verification_uri_complete: `${origin}/device?code=BCDF-2346`, expires_in: 600, interval: 5 });
    }
    if (req.url === '/oauth/token') {
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (mock.pendingPolls-- > 0) return send(400, { error: mock.pendingPolls === 1 ? 'slow_down' : 'authorization_pending' });
        return send(200, issue());
      }
      mock.refreshCount++;
      if (mock.revoked) return send(400, { error: 'invalid_grant', error_description: 'This device was revoked.' });
      if (mock.usedRefresh.has(body.refresh_token)) { mock.revoked = true; return send(400, { error: 'invalid_grant', error_description: 'reuse detected' }); }
      if (!mock.validRefresh.has(body.refresh_token)) return send(400, { error: 'invalid_grant' });
      mock.usedRefresh.add(body.refresh_token);
      return send(200, issue());
    }
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer access-')) return send(401, { error: 'invalid_token' });
    if (req.url === '/v1/engine/policy') {
      if (mock.policyFailures > 0) { mock.policyFailures--; return send(503, { error: 'busy' }, { 'retry-after': '1' }); }
      return send(200, { schema: 'aico.control.policy/1', tenant: { slug: 'acme', name: 'Acme Inc' }, user: { email: 'dev@acme.test' }, role: mock.role, team: { name: 'Platform' }, issuedAt: new Date().toISOString(), graceHours: mock.graceHours, pollSeconds: mock.pollSeconds, layers: mock.layers, lease: mock.lease, hash: mock.hash });
    }
    if (req.url === '/v1/engine/audit') {
      mock.auditPosts++;
      if (mock.auditFailures > 0) { mock.auditFailures--; return send(503, { error: 'busy' }); }
      let fresh = 0;
      for (const r of body.records) if (!mock.audit.some(x => x.id === r.id)) { mock.audit.push(r); fresh++; }
      return send(200, { accepted: fresh, duplicates: body.records.length - fresh, rejected: 0 });
    }
    if (req.url === '/v1/engine/usage') {
      for (const e of body.events) if (!mock.usage.some(x => x.id === e.id)) mock.usage.push(e);
      return send(200, { accepted: body.events.length, lease: mock.lease });
    }
    send(404, { error: 'not_found' });
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
baseUrl = `http://127.0.0.1:${server.address().port}`;
process.on('exit', () => server.close());

const modelA = { model: 'claude-sonnet-4', providerType: 'anthropic' };

await block('not enrolled: nothing changes', async () => {
  assert(C.readControlState() === undefined, 'no state');
  assert(!T.managedPolicy().active && T.modelDecision(modelA).ok && T.toolDecision('Bash').ok, 'no policy is active and nothing is denied');
  const r = await C.syncOnce();
  assert(r.skipped === 'not-enrolled' && r.ok, 'sync is a no-op');
});

await block('the server address is validated', async () => {
  assert(C.normaliseControlUrl('https://aico.example.com/x?y#z') === 'https://aico.example.com', 'https is accepted and reduced to an origin');
  assert(C.normaliseControlUrl('http://127.0.0.1:7350') === 'http://127.0.0.1:7350', 'plain http only to this machine');
  for (const bad of ['http://aico.example.com', 'https://user:pw@aico.example.com', 'http://169.254.169.254', 'ftp://x', 'not a url', 'https://169.254.169.254/']) {
    let msg = '';
    try { C.normaliseControlUrl(bad); } catch (e) { msg = e.message; }
    assert(msg !== '', `refused: ${bad}`);
  }
  mock.hostile = true;
  let msg = '';
  try { await C.startLogin(baseUrl); } catch (e) { msg = e.message; }
  mock.hostile = false;
  assert(/different site/.test(msg), 'a verification address on another site is refused (phishing shape)');
});

await block('device-flow sign-in: tokens only in the vault', async () => {
  const start = await C.startLogin(baseUrl, { deviceName: 'test-box' });
  assert(start.userCode === 'BCDF-2346' && start.verificationUriComplete.startsWith(baseUrl), 'the code and the address are returned');
  const waits = [];
  const state = await C.completeLogin(start, { sleep: async ms => { waits.push(ms); } });
  assert(state.user.email === 'dev@acme.test' && state.tenant.name === 'Acme Inc' && state.role === 'developer', 'state names the person and organisation');
  assert(waits[0] === 5000 && waits.includes(10000), 'polls at the interval and slows down by 5 s on slow_down');
  const file = fs.readFileSync(C.controlStatePath(), 'utf8');
  assert(!/access-\d|refresh-\d/.test(file), 'state.json holds no token');
  assert(process.platform === 'win32' || (fs.statSync(C.controlStatePath()).mode & 0o077) === 0, 'state.json is private to the user');
  const creds = T.getVault().list ? await T.getVault().list() : [];
  assert(JSON.stringify(creds).includes(state.credential) && !JSON.stringify(creds).includes('access-1'), 'the vault lists the credential by name, never its value');
  assert(!/access-\d|refresh-\d/.test(fs.existsSync(T.auditEventsFile()) ? fs.readFileSync(T.auditEventsFile(), 'utf8') : ''), 'no token reached the audit log');
});

await block('the served policy applies as restrict-only layers', async () => {
  const r = await C.syncOnce({ sleep: noSleep });
  assert(r.ok && r.policyChanged, 'first sync fetched a policy');
  const lp = T.managedPolicy();
  assert(lp.active && lp.layers.some(l => l.origin === 'control' && l.name === 'Org baseline'), 'managedPolicy() carries the control layer');
  const d = T.toolDecision('Bash(rm -rf x)');
  assert(!d.ok && /Org rules/.test(d.message) && /it@acme.test/.test(d.message), 'the denial names the organisation\'s message and contact');
  assert(T.toolDecision('Read').ok, 'other tools are untouched');
  assert(T.describeRules(lp).some(l => /Tools blocked/.test(l)), 'the rules list shows it');
  const pub = T.publicPolicy(lp);
  assert(pub.managed && pub.sources.some(s => s.origin === 'control' && s.path === baseUrl) && !pub.sources.find(s => s.origin === 'control')?.weakness, 'publicPolicy lists the control source, not as a weak lock');
  assert(lp.hash !== '' && lp.problems.length === 0, 'a hash and no problems');
});

await block('a control layer can never loosen the system policy file', async () => {
  const sys = path.join(tmp, 'system-policy.json');
  fs.writeFileSync(sys, JSON.stringify({ allowedModels: ['claude-haiku*'], deniedTools: ['WebFetch'], maxAutonomyLevel: 'L2' }));
  process.env.AICO_POLICY_FILE = sys;
  // The loosest thing a hostile or careless server could send: allow everything, deny nothing.
  mock.layers = [{ scope: 'tenant', name: 'Allow all', policy: { allowedModels: ['*'], allowedProviders: ['*'], deniedTools: [], maxAutonomyLevel: 'L4', mcp: { mode: 'any' }, network: { mode: 'off', domains: [] } } }];
  mock.hash = 'h-loose';
  await C.syncOnce({ sleep: noSleep });
  T.resetManagedPolicyCache();
  assert(!T.modelDecision({ model: 'claude-sonnet-4', providerType: 'anthropic' }).ok, 'a model the file excludes stays excluded');
  assert(T.modelDecision({ model: 'claude-haiku-4', providerType: 'anthropic' }).ok, 'and one it allows still works');
  assert(!T.toolDecision('WebFetch').ok, 'a tool the file denies stays denied');
  assert(T.policyCeiling() === 'L2', 'the autonomy ceiling is still the file\'s');
  // And in the other direction: the organisation's server can tighten what the file left open.
  mock.layers = [{ scope: 'role', name: 'Contractors', policy: { allowedModels: ['claude-haiku-4'], maxAutonomyLevel: 'L1' } }];
  mock.hash = 'h-tight';
  await C.syncOnce({ sleep: noSleep });
  T.resetManagedPolicyCache();
  assert(T.policyCeiling() === 'L1', 'the server can lower the ceiling below the file\'s');
  // An invalid value in a served document becomes its most restrictive form, like a file's.
  mock.layers = [{ scope: 'tenant', name: 'Typo', policy: { maxAutonomyLevel: 'L9', localOnly: 'yes' } }];
  mock.hash = 'h-typo';
  await C.syncOnce({ sleep: noSleep });
  T.resetManagedPolicyCache();
  const lp = T.managedPolicy();
  assert(T.policyCeiling() === 'L0' && lp.problems.some(p => /Typo/.test(p.message)), 'invalid served values fail closed and are reported with the document\'s name');
  delete process.env.AICO_POLICY_FILE;
  mock.layers = [{ scope: 'tenant', scopeId: '*', name: 'Org baseline', policy: { deniedTools: ['Bash(rm *)'], message: 'Org rules', contact: 'it@acme.test' } }];
  mock.hash = 'h1';
  await C.syncOnce({ sleep: noSleep });
  T.resetManagedPolicyCache();
});

await block('a spent budget arrives as a deny-only layer; the daily cap is enforced locally', async () => {
  mock.layers.push({ scope: 'budget', name: 'Daily budget', policy: { budget: { perDayUsd: 2 } } });
  mock.hash = 'h-budget';
  await C.syncOnce({ sleep: noSleep });
  T.resetManagedPolicyCache();
  assert(T.dayBudgetCap() === 2 && T.dayBudgetRefusal(2.5) && !T.dayBudgetRefusal(1), 'the day cap works offline (the engine\'s own budget machinery)');
  mock.layers.push({ scope: 'lease', name: 'Budget reached', policy: { allowedModels: [], allowedProviders: [], message: 'You reached the daily AICO budget.' } });
  mock.lease = { blocked: true, reason: 'You reached the daily AICO budget.', limits: [] };
  mock.hash = 'h-blocked';
  await C.syncOnce({ sleep: noSleep });
  T.resetManagedPolicyCache();
  const d = T.modelDecision(modelA);
  assert(!d.ok && /daily AICO budget/.test(d.message), 'model calls are refused with the server\'s reason');
  assert(C.controlView().budget.blocked === true, 'the status view says so');
  mock.layers.pop(); mock.layers.pop(); mock.lease = { blocked: false, limits: [] }; mock.hash = 'h1';
  await C.syncOnce({ sleep: noSleep });
  T.resetManagedPolicyCache();
  assert(T.modelDecision(modelA).ok, 'when the period resets the block lifts');
});

await block('offline: the last policy keeps applying, then the allowance runs out', async () => {
  mock.offline = true;
  const r = await C.syncOnce({ sleep: noSleep, retries: 2 });
  assert(!r.ok && /Could not reach/.test(r.error), 'an unreachable server is reported');
  T.resetManagedPolicyCache();
  assert(!T.toolDecision('Bash(rm x)').ok && T.modelDecision(modelA).ok, 'the cached policy still applies, and nothing extra is blocked yet');
  assert(C.readControlState().lastError && C.readControlState().policy.layers.length === 1, 'the failure is recorded; the policy is kept');
  const s = C.readControlState();
  const stale = { ...s, lastContactAt: Date.now() - 80 * 3_600_000 };
  fs.writeFileSync(C.controlStatePath(), JSON.stringify(stale));
  C.resetControlStateCache(); T.resetManagedPolicyCache();
  const d = T.modelDecision(modelA);
  assert(!d.ok && /could not reach Acme Inc for more than 72 hours/.test(d.message), 'after 72 hours without contact model calls are refused, with a plain reason');
  assert(C.statusLines().some(l => /offline allowance used up/.test(l)), 'the CLI status says so');
  mock.offline = false;
  await C.syncOnce({ sleep: noSleep });
  T.resetManagedPolicyCache();
  assert(T.modelDecision(modelA).ok, 'reconnecting lifts it');
});

await block('audit and usage upload: batches, retries, no duplicates, no loss', async () => {
  for (let i = 0; i < 1200; i++) T.recordSettingsChange(`ui.thing${i}`, i);
  const base = mock.audit.length;
  mock.auditFailures = 2;
  const r = await C.syncOnce({ sleep: noSleep });
  assert(r.ok && r.auditPushed >= 1200, `${r.auditPushed} records uploaded in several batches`);
  assert(mock.auditPosts >= 3 + 2 && mock.audit.length - base >= 1200, 'two 503s were retried, and every record arrived');
  const ids = new Set(mock.audit.map(x => x.id));
  assert(ids.size === mock.audit.length, 'the server received each record id once');
  assert(mock.audit.every(x => x.schema === 'aico.audit/1' && !('prompt' in x)), 'records are aico.audit/1');
  const posts = mock.auditPosts;
  const again = await C.syncOnce({ sleep: noSleep });
  assert(again.auditPushed === 0 && mock.auditPosts === posts, 'an idle sync sends nothing (records sharing a millisecond are not re-sent)');
  T.recordSettingsChange('ui.late', 1);
  const late = await C.syncOnce({ sleep: noSleep });
  assert(late.auditPushed === 1, 'only the new record goes up');
  mock.auditFailures = 99;
  T.recordSettingsChange('ui.pending', 1);
  const fail = await C.syncOnce({ sleep: noSleep });
  assert(!fail.ok && C.readControlState().lastError, 'a persistent failure is reported');
  mock.auditFailures = 0;
  const ok = await C.syncOnce({ sleep: noSleep });
  assert(ok.ok && ok.auditPushed === 1, 'and the cursor did not move, so the record is sent once the server is back');
});

await block('tokens: refresh rotates, and racing processes do not trip reuse detection', async () => {
  // Start from a sign-in whose access token is already stale, then let five callers race.
  mock.expiresIn = 30;
  mock.revoked = false;
  const start = await C.startLogin(baseUrl);
  mock.pendingPolls = 0;
  await C.completeLogin(start, { sleep: noSleep });
  mock.expiresIn = 900;
  mock.refreshCount = 0;
  const replies = await Promise.all(Array.from({ length: 5 }, () => C.authedCall('/v1/engine/policy')));
  assert(replies.every(r => r.status === 200), 'five concurrent calls all succeed');
  assert(mock.refreshCount === 1, `exactly one refresh happened (${mock.refreshCount})`);
  assert(!mock.revoked, 'the server never saw a reused refresh token');
  const before = mock.refreshCount;
  await C.authedCall('/v1/engine/policy');
  assert(mock.refreshCount === before, 'a fresh access token is reused without refreshing');
  assert(!fs.existsSync(path.join(path.dirname(C.controlStatePath()), 'refresh.lock')), 'the lock file is released');
  assert(!/access-\d|refresh-\d/.test(fs.readFileSync(C.controlStatePath(), 'utf8')), 'still no token in state.json');
});

await block('revoked by the server: the engine forgets the organisation', async () => {
  mock.expiresIn = 30;
  const start = await C.startLogin(baseUrl);
  mock.pendingPolls = 0;
  await C.completeLogin(start, { sleep: noSleep });
  mock.revoked = true;
  const r = await C.syncOnce({ sleep: noSleep });
  assert(!r.ok && r.revoked && /no longer managed by Acme Inc/.test(r.error), 'sync reports the revocation plainly');
  assert(C.readControlState() === undefined, 'the state is gone');
  T.resetManagedPolicyCache();
  assert(!T.managedPolicy().active, 'and so are the organisation\'s layers');
});

await block('routes and CLI output: no secrets, a person for sign-in and sign-out', async () => {
  mock.revoked = false; mock.expiresIn = 900; mock.pendingPolls = 0;
  const nobody = async () => ({ ok: false });
  const person = async () => ({ ok: true });
  let r = await C.handleControlRoute('control', 'GET', {}, nobody);
  assert(r.status === 200 && r.body.enrolled === false, 'GET control when not enrolled');
  r = await C.handleControlRoute('control/login', 'POST', { url: baseUrl }, nobody);
  assert(r.status === 403 && r.body.code === 'human-required', 'login without a person is refused');
  r = await C.handleControlRoute('control/login', 'POST', { url: 'http://evil.example' }, person);
  assert(r.status === 400, 'login to an insecure address is refused even with a person');
  r = await C.handleControlRoute('control/login', 'POST', { url: baseUrl }, person);
  assert(r.status === 200 && r.body.userCode === 'BCDF-2346' && r.body.verificationUriComplete.startsWith(baseUrl), 'with a person, the code is returned');
  r = await C.handleControlRoute('control/login', 'GET', {}, nobody);
  assert(r.body.state === 'pending', 'the sign-in is polled as pending until approved');
  r = await C.handleControlRoute('control/logout', 'POST', {}, nobody);
  assert(r.status === 403, 'sign-out without a person is refused (it would shed the restrictions)');
  r = await C.handleControlRoute('control/logout', 'POST', {}, person);
  assert(r.status === 200 && r.body.wasEnrolled === false, 'with a person it is accepted (and cancels the pending sign-in)');
  assert((await C.handleControlRoute('control/sync', 'POST', {}, nobody)).body.skipped === 'not-enrolled', 'sync needs only the token and is a no-op when not enrolled');
  assert((await C.handleControlRoute('nope', 'GET', {}, nobody)) === undefined, 'other routes are not claimed');
});

server.close();
console.log(`\ncontrol client: ${passed} passed, ${failed} failed`);
if (failed) { console.log(`Failures:\n - ${failures.join('\n - ')}`); process.exit(1); }
process.exit(0);
