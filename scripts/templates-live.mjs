/**
 * Every process template still installs, typechecks, tests and builds from a
 * clean copy — the rot check.
 *
 * A template is a promise that what it copies in works today. Dependencies
 * move under it, so before a release each `process` template is copied to a
 * scratch directory (without its node_modules), installed from its lockfile
 * with `npm ci`, and put through its own `typecheck`, `test` and `build`.
 * Network is required; this is not part of `npm test`.
 *
 * Run: node scripts/templates-live.mjs [template-id …]
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const templatesDir = path.join(root, 'templates');

let passed = 0, failed = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}${detail ? `\n${detail}` : ''}`); }
}

const only = process.argv.slice(2);
const ids = fs.readdirSync(templatesDir).filter(id => {
  if (only.length && !only.includes(id)) return false;
  const manifest = path.join(templatesDir, id, 'template.json');
  return fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).kind === 'process';
});

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(cwd, args, env = {}) {
  const r = spawnSync(npm, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, CI: '1', ...env }, timeout: 15 * 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n') };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-templates-'));
try {
  for (const id of ids) {
    console.log(`\n-- ${id} --`);
    const src = path.join(templatesDir, id);
    const dir = path.join(scratch, id);
    fs.cpSync(src, dir, {
      recursive: true,
      filter: (p) => !/[\\/](node_modules|\.next|dist|coverage|data)([\\/]|$)/.test(p),
    });
    check(fs.existsSync(path.join(dir, 'package-lock.json')), `${id}: has a lockfile`);
    const ci = run(dir, ['ci', '--no-audit', '--no-fund']);
    check(ci.ok, `${id}: npm ci from the lockfile`, ci.out);
    if (!ci.ok) continue;
    const env = { SESSION_SECRET: 'templates-live-secret-long-enough', DATABASE_PATH: ':memory:' };
    for (const script of ['typecheck', 'lint', 'test', 'build']) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (!pkg.scripts?.[script]) { check(script !== 'typecheck' && script !== 'test' && script !== 'build', `${id}: has a "${script}" script`); continue; }
      const r = run(dir, ['run', script], env);
      check(r.ok, `${id}: npm run ${script}`, r.out);
    }
  }
} finally {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ }
}

console.log(`\ntemplates: ${passed} passed, ${failed} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(failed ? 1 : 0);
