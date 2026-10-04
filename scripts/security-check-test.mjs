/**
 * The agent's own `security` check (src/security/project-scan.ts, ADR 0026),
 * tested as the gate it feeds.
 *
 * The point of the check is that "done" stops being available to a turn that
 * wrote a key into a file or built a SQL string by interpolation. So the
 * cases are the ones that matter to that promise: such a turn FAILS and the
 * completion gate refuses it; a clean turn passes; a finding in code the turn
 * did not write never blocks it; a waiver on the line is honoured; and the
 * check is part of RunChecks only where the project already has checks.
 *
 * Offline: temp git repositories, no model, no network (no manifest is
 * written, so no auditor runs). Canary keys are assembled at runtime so no
 * key-shaped literal sits in this file.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const T = await import('../dist-test/test-exports.js');

let passed = 0; let failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600).replace(/\n/g, '\n      ')}` : ''}`); }
}

function repo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aico-seccheck-${name}-`));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  return { dir, git, write: (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); return path.join(dir, rel); } };
}

const fakeKey = ['sk', 'ant', 'api03', 'Hq4Zt8Wn2Lp6Rx9Ck3Vm7Bf1Jd5Gs0YaEuOiTyPlMkNjBh'].join('-');

console.log('\n── securityCheck on what a turn wrote ──');
{
  const r = repo('basic');
  r.write('old.js', "const { execSync } = require('child_process');\nexecSync('ls ' + dir);\n");
  r.git('add', '.'); r.git('commit', '-q', '-m', 'base');

  const clean = r.write('clean.ts', 'export const add = (a: number, b: number) => a + b;\n');
  let res = await T.securityCheck(r.dir, [clean], { external: false });
  ok(res.passed && res.counts.high === 0, 'a clean new file passes', res.output);

  const leaked = r.write('config.ts', `export const key = '${fakeKey}';\n`);
  res = await T.securityCheck(r.dir, [leaked], { external: false });
  ok(!res.passed && res.counts.secrets === 1, 'a key written into a file fails', res.output);
  ok(!res.output.includes(fakeKey) && !res.output.includes(fakeKey.slice(10, 30)), 'the report never contains the key', res.output);

  const sql = r.write('db.ts', 'export const find = (db: any, id: string) => db.query(`SELECT * FROM users WHERE id = ${id}`);\n');
  res = await T.securityCheck(r.dir, [sql], { external: false });
  ok(!res.passed && /sql-interpolated db\.ts:1/.test(res.output) && /placeholders/.test(res.output), 'SQL built by interpolation fails, with the fix named', res.output);

  const waived = r.write('db2.ts', 'export const n = (db: any, t: string) => db.query(`SELECT count(*) FROM ${t}`); // security-allow: sql-interpolated — t is from a fixed table list\n');
  res = await T.securityCheck(r.dir, [waived], { external: false });
  ok(res.passed, 'a waiver on the line is honoured', res.output);

  const warn = r.write('view.ts', 'export const show = (el: HTMLElement, s: string) => { el.innerHTML = s; };\n');
  res = await T.securityCheck(r.dir, [warn], { external: false });
  ok(res.passed && res.counts.medium === 1 && /inner-html/.test(res.output), 'a medium finding is reported but does not fail', res.output);

  // Pre-existing code: the turn appends a harmless line to old.js; the old
  // exec line must not be blamed on it.
  fs.appendFileSync(path.join(r.dir, 'old.js'), 'module.exports = 1;\n');
  res = await T.securityCheck(r.dir, [path.join(r.dir, 'old.js')], { external: false });
  ok(res.passed && res.counts.high === 0, 'a finding in lines the turn did not write never blocks it', res.output);
  fs.appendFileSync(path.join(r.dir, 'old.js'), "execSync('rm -rf ' + other);\n");
  res = await T.securityCheck(r.dir, [path.join(r.dir, 'old.js')], { external: false });
  ok(!res.passed && /old\.js:4/.test(res.output) && !/old\.js:2/.test(res.output), 'a finding the turn added to an old file is caught, and only that one', res.output);

  const py = r.write('app.py', 'import subprocess\nsubprocess.run(cmd, shell=True)\n');
  res = await T.securityCheck(r.dir, [py], { external: false });
  ok(!res.passed && /py-shell/.test(res.output), 'Python: shell=True fails', res.output);

  const outside = path.join(os.tmpdir(), 'aico-seccheck-outside.ts');
  fs.writeFileSync(outside, `export const k = '${fakeKey}';\n`);
  res = await T.securityCheck(r.dir, [outside], { external: false });
  ok(res.passed, 'files outside the project are not this check\'s business', res.output);
  fs.rmSync(outside, { force: true });
  fs.rmSync(r.dir, { recursive: true, force: true });
}

console.log('\n── no git: the whole file counts ──');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-seccheck-nogit-'));
  const f = path.join(dir, 'x.ts');
  fs.writeFileSync(f, 'https.request({ rejectUnauthorized: false });\n');
  const res = await T.securityCheck(dir, [f], { external: false });
  ok(!res.passed && /tls-verify-off/.test(res.output), 'without history every line is the turn\'s', res.output);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n── RunChecks and the completion gate ──');
{
  const r = repo('gate');
  r.write('package.json', JSON.stringify({ name: 'g', type: 'module', scripts: { test: 'node -e "process.exit(0)"' } }));
  r.write('index.ts', 'export const a = 1;\n');
  r.git('add', '.'); r.git('commit', '-q', '-m', 'base');
  await T.runInContext({ cwd: r.dir, sessionId: 'security-check-gate' }, async () => {
    T.resetChecks();
    ok(T.gateChecks().some(c => c.name === 'security' && c.builtin === 'security'), 'a project with checks gets the security check');
    const file = r.write('secrets.ts', `export const key = '${fakeKey}';\n`);
    T.noteSourceChanged(file);
    const out = await T.executeTool('RunChecks', {});
    ok(/^FAILED — security did not pass/.test(out) && /PASS\s+test/.test(out) && /FAIL\s+security\s+built-in/.test(out), 'RunChecks runs it after the project\'s own checks and reports it in the panel\'s line format', out);
    const gate = T.checkProjectGate(T.gateChecks());
    ok(!gate.ok && /security/.test(gate.message ?? ''), 'the completion gate refuses "done" while it is red', gate.message);
    r.write('secrets.ts', 'export const key = process.env.API_KEY;\n');
    T.noteSourceChanged(file);
    const fixed = await T.executeTool('RunChecks', {});
    ok(/^PASSED/.test(fixed) && /PASS\s+security/.test(fixed), 'fixed, it passes', fixed);
    ok(T.checkProjectGate(T.gateChecks()).ok, 'and the gate lets the turn finish');
  });
  await T.runInContext({ cwd: r.dir, sessionId: 'security-check-off', settings: { completionGate: { security: false } } }, async () => {
    ok(!T.gateChecks().some(c => c.name === 'security'), 'completionGate.security: false leaves it out');
  });
  fs.rmSync(r.dir, { recursive: true, force: true });

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-seccheck-bare-'));
  await T.runInContext({ cwd: bare, sessionId: 'security-check-bare' }, async () => {
    ok(T.gateChecks().length === 0, 'a project with no checks gets none — the gate stays silent there, as before');
  });
  fs.rmSync(bare, { recursive: true, force: true });
}

console.log(`\n  SECURITY CHECK: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
