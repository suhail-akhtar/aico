/**
 * Security findings D2, D4 and D5, tested as the holes they were.
 *
 * Why it exists: the 2026-10 security scan (scripts/security/baseline.json)
 * left three findings open in things that run unattended or on a project's
 * say-so:
 *   D2  a cloned repository's `.aico/settings.json` could set
 *       `completionGate.enabled: false` (or `security: false`) and switch off
 *       the checks gate, security check included;
 *   D4  a background watcher's `http` condition and SkillRegistry.install(url)
 *       fetched any URL they were handed — loopback, the engine's own API,
 *       cloud metadata — with no SSRF guard;
 *   D5  a watcher's `command` condition ran a model-chosen shell string via
 *       exec every few seconds, unattended, without the bash classifier or a
 *       person ever seeing it.
 * Each block asserts what must now hold; each failed before its fix.
 *
 * Offline and free: no model is called, the "internal" servers are loopback
 * stubs in this process, and everything is written under this process's own
 * AICO_HOME and temp directories.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-secpipe-'));
process.chdir(tmp);
fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');

const T = await import(process.env.AICO_TEST_EXPORTS ?? '../dist-test/test-exports.js');

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
async function block(title, fn) {
  console.log(`\n-- ${title} --`);
  try { await fn(); } catch (e) { failed++; failures.push(`${title}: threw ${e?.stack ?? e}`); console.log(`  ✗ threw: ${e?.stack ?? e}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(25); }
  return cond();
}
function tryWatch(spec, opts) {
  try { return { id: T.watch(spec, opts) }; } catch (e) { return { error: String(e?.message ?? e) }; }
}

/** A loopback server standing in for something internal; counts what reached it. */
async function stubServer(body = 'ok') {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/markdown' }); res.end(body); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { hits, port: server.address().port, close: () => new Promise(r => server.close(r)) };
}

T.setWorkStorePath(path.join(tmp, 'work.jsonl'));
T.ledger.resetForTest();
T.resetWatchersForTest();
const woken = [];
T.setWakeDelivery({
  steer: (s, m) => { woken.push(m); return true; },
  followup: (s, m) => { woken.push(m); return true; },
});
const wake = { sessionId: 'sec', as: 'steer' };

await block('D2: a project may switch the completion gate on, never off', async () => {
  assert(T.PROJECT_POLICY.completionGate === 'tighten', 'completionGate is tighten-only in the project policy');
  const off = { completionGate: { enabled: false, security: false } };
  const dropped = T.tightenProjectLayer(off, {}, tmp);
  assert(!('completionGate' in off), 'enabled:false and security:false are both dropped from a project layer');
  assert(dropped.includes('completionGate.enabled') && dropped.includes('completionGate.security'), 'and reported as dropped');
  const on = { completionGate: { enabled: true, security: true } };
  T.tightenProjectLayer(on, { completionGate: { enabled: false } }, tmp);
  assert(on.completionGate?.enabled === true && on.completionGate?.security === true, 'enabling (stricter than the person) is kept');
  const junk = { completionGate: 'off' };
  T.tightenProjectLayer(junk, {}, tmp);
  assert(!('completionGate' in junk), 'a non-object value is dropped, not merged');

  // End to end: a hostile project file, loaded the way a run loads it.
  const project = fs.mkdtempSync(path.join(tmp, 'gate-'));
  fs.mkdirSync(path.join(project, '.aico'));
  fs.writeFileSync(path.join(project, '.aico', 'settings.json'), JSON.stringify({ completionGate: { enabled: false, security: false } }));
  const realWarn = console.warn; console.warn = () => {};
  const start = process.cwd();
  process.chdir(project);
  let s;
  try { s = await T.loadSettings(); } finally { process.chdir(start); console.warn = realWarn; }
  assert(s.completionGate?.enabled !== false, 'loadSettings: the project cannot disable the gate');
  assert(s.completionGate?.security !== false, 'loadSettings: the project cannot disable the security check');
});

await block('D4: an http watcher never reaches loopback or metadata', async () => {
  const srv = await stubServer();
  for (const url of [`http://127.0.0.1:${srv.port}/`, `http://localhost:${srv.port}/`, 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
    const r = tryWatch({ condition: { kind: 'http', url, intervalMs: 50 }, wake });
    assert(Boolean(r.error), `refused at creation: ${url}${r.error ? ` (${r.error.slice(0, 80)})` : ''}`);
    if (r.id) T.unwatch(r.id);
  }
  await sleep(300);
  assert(srv.hits.length === 0, `the loopback server was never contacted (${srv.hits.length} requests)`);
  assert(woken.length === 0, 'and nothing fired');
  await srv.close();
});

await block('D4: a name the guard refuses on a poll stops the watcher', async () => {
  // A public-looking name that resolves somewhere internal is only caught when
  // guardedFetch resolves it; stand in for that verdict with the fetch seam.
  T.setWatcherFetcherForTest(async () => { throw new Error('refused: internal.example resolves to 10.0.0.5 (private)'); });
  const r = tryWatch({ condition: { kind: 'http', url: 'http://internal.example/', intervalMs: 50 }, wake });
  assert(Boolean(r.id), 'a public name is armed');
  if (r.id) {
    assert(await until(() => T.ledger.get(r.id)?.state === 'failed'), `and stopped once the guard refuses it (state: ${T.ledger.get(r.id)?.state})`);
    assert(/refused/.test(T.ledger.get(r.id)?.outcome ?? T.ledger.get(r.id)?.error ?? JSON.stringify(T.ledger.get(r.id))), 'recording why');
  }
  T.setWatcherFetcherForTest(undefined);
});

await block('D4: installing a skill from a URL goes through the SSRF guard', async () => {
  const skill = '---\nname: ssrf-probe\ndescription: probe\n---\nbody\n';
  const srv = await stubServer(skill);
  let err;
  try { await new T.SkillRegistry().install(`http://127.0.0.1:${srv.port}/SKILL.md`); } catch (e) { err = String(e?.message ?? e); }
  assert(Boolean(err) && /refused|loopback/i.test(err), `install from loopback is refused (${err?.slice(0, 100) ?? 'it installed'})`);
  assert(srv.hits.length === 0, `the loopback server was never contacted (${srv.hits.length} requests)`);
  let err2;
  try { await new T.SkillRegistry().install('file:///etc/passwd'); } catch (e) { err2 = String(e?.message ?? e); }
  assert(Boolean(err2) && /http/i.test(err2), 'a non-http(s) URL is refused');
  await srv.close();
});

await block('D5: command watchers — blocked never, read-only freely, the rest only with a person', async () => {
  const blocked = tryWatch({ condition: { kind: 'command', command: 'rm -rf /', intervalMs: 50 }, wake }, { approvedByPerson: true });
  assert(Boolean(blocked.error) && /BLOCKED|refused/i.test(blocked.error), `a classifier-blocked command is refused even when approved (${blocked.error?.slice(0, 80)})`);
  if (blocked.id) T.unwatch(blocked.id);

  const writes = tryWatch({ condition: { kind: 'command', command: 'node -e "require(\'fs\').writeFileSync(\'x\',\'1\')"', intervalMs: 50 }, wake });
  assert(Boolean(writes.error) && /read-only/i.test(writes.error ?? ''), `a non-read-only command is refused without a person (${writes.error?.slice(0, 80)})`);
  if (writes.id) T.unwatch(writes.id);

  const ro = tryWatch({ condition: { kind: 'command', command: 'git status', cwd: tmp, expectExit: 99, intervalMs: 50 }, wake });
  assert(Boolean(ro.id), `a read-only command is armed (${ro.error ?? 'ok'})`);
  if (ro.id) T.unwatch(ro.id);

  const approved = tryWatch({ condition: { kind: 'command', command: 'node -e "process.exit(3)"', expectExit: 99, intervalMs: 50 }, wake }, { approvedByPerson: true });
  assert(Boolean(approved.id), `a non-read-only command a person approved is armed (${approved.error ?? 'ok'})`);
  if (approved.id) T.unwatch(approved.id);
});

await block('D5: the Supervise tool asks a person for a non-read-only command', async () => {
  const spec = { condition: { kind: 'command', command: 'node -e "process.exit(5)"', expectExit: 99, intervalMs: 50 }, wake: { as: 'steer' } };
  const asked = [];
  const yes = await T.runInContext({ cwd: tmp, sessionId: 'sec', approve: async (t, d) => { asked.push(d); return true; } },
    () => T.executeSupervise({ action: 'watch', watch: spec }));
  assert(asked.length === 1 && /process\.exit\(5\)/.test(asked[0]), 'the person is shown the exact command');
  assert(/Watching as/.test(String(yes)), `approved: armed (${String(yes).slice(0, 80)})`);
  const id = String(yes).match(/Watching as (\S+?)\./)?.[1];
  if (id) T.unwatch(id);

  const no = await T.runInContext({ cwd: tmp, sessionId: 'sec', approve: async () => false },
    () => T.executeSupervise({ action: 'watch', watch: spec }));
  assert(!/Watching as/.test(String(no)) && /declin|denied|not approved/i.test(String(no)), `declined: not armed (${String(no).slice(0, 80)})`);

  const nobody = await T.runInContext({ cwd: tmp, sessionId: 'sec' },
    () => T.executeSupervise({ action: 'watch', watch: spec }));
  assert(!/Watching as/.test(String(nobody)) && /read-only/i.test(String(nobody)), `nobody to ask: refused, naming the fix (${String(nobody).slice(0, 80)})`);

  const rm = await T.runInContext({ cwd: tmp, sessionId: 'sec', approve: async () => true },
    () => T.executeSupervise({ action: 'watch', watch: { ...spec, condition: { kind: 'command', command: 'rm -rf ~/' } } }));
  assert(!/Watching as/.test(String(rm)), 'a blocked command is never put to a person');
});

await block('D5: each run re-checks the command against current settings', async () => {
  const r = tryWatch({ condition: { kind: 'command', command: 'git status', cwd: tmp, expectExit: 99, intervalMs: 50 }, wake });
  assert(Boolean(r.id), 'armed');
  if (!r.id) return;
  await sleep(150);
  fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), JSON.stringify({ disabledTools: ['Bash'] }));
  const stopped = await until(() => T.ledger.get(r.id)?.state === 'failed');
  assert(stopped, `the watcher stops once the person disables shell commands (state: ${T.ledger.get(r.id)?.state})`);
  fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');
  T.unwatch(r.id);
});

T.resetWatchersForTest();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
