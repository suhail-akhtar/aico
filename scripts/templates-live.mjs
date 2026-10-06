/**
 * Every process template still installs, formats, lints, typechecks, tests and
 * builds from a clean copy — the rot check, for every stack.
 *
 * A template is a promise that what it copies in works today. Dependencies move
 * under it, so before a release each `process` template (Node, Python, Java,
 * .NET, Go, PHP) is copied to a scratch directory *without* its installs and
 * artefacts (the shared artefact list, ADR 0031), installed from its lockfile,
 * and put through the checks its own manifest declares (`run.format`, `lint`,
 * `typecheck`, `test`, `build`, and `audit` unless `verify.skip` says otherwise).
 *
 * Node templates run `npm ci` and their npm scripts exactly as before. Any
 * other stack runs on the machine's own toolchain when the manifest's
 * `toolchain` probe passes (real version probes: `go version`, `java -version`),
 * else in the template's pinned container image when Docker answers
 * (the same constrained `docker run` the engine builds), else it is reported as
 * NOT VERIFIED and the run fails — a starter that nothing could check is not
 * green. Network is required; this is not part of `npm test` and not in CI.
 *
 * Run: node scripts/templates-live.mjs [--docker|--native] [template-id …]
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { templatePackageFilter } from '../shared/apps/artifact-dirs.mjs';
import { loadEngineModule } from './lib/engine-module.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const templatesDir = path.join(root, 'templates');

let passed = 0, failed = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}${detail ? `\n${detail}` : ''}`); }
}

const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const forceDocker = flags.includes('--docker');
const forceNative = flags.includes('--native');

const { checkRequirements, dockerImageFor } = await loadEngineModule('apps/toolchain.ts');
const { dockerRunPlan, dockerReady } = await loadEngineModule('apps/docker-run.ts');
const { validateManifest } = await loadEngineModule('apps/templates.ts');

const ids = fs.readdirSync(templatesDir).filter(id => {
  if (only.length && !only.includes(id)) return false;
  const manifest = path.join(templatesDir, id, 'template.json');
  if (!fs.existsSync(manifest)) return false;
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  // Node: anything with a package.json (process apps, CLIs, mobile). Other stacks: every process starter.
  return m.kind === 'process' && m.toolchain && m.toolchain.id !== 'node'
    || (fs.existsSync(path.join(templatesDir, id, 'package.json')) && ['process', 'cli', 'mobile'].includes(m.kind));
});

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function runNpm(cwd, args, env = {}) {
  const r = spawnSync(npm, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, CI: '1', ...env }, timeout: 15 * 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n') };
}

/** One declared command, on this machine (through the shell, as the engine's own runner does for checks). */
function runNative(cwd, command, env) {
  const r = spawnSync(command, { cwd, encoding: 'utf8', shell: true, env: { ...process.env, CI: '1', ...env }, timeout: 20 * 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n') };
}

/** The same command in the template's container image: app directory mounted at /work, nothing published. */
function runDocker(slug, cwd, command, template, env) {
  const plan = dockerRunPlan({
    slug, dir: cwd, image: dockerImageFor(template), command, env,
    ...(template.docker?.setup ? { setup: template.docker.setup } : {}),
    ...(template.docker?.cache ? { cache: template.docker.cache } : {}),
  });
  const args = plan.args.filter((a, i, all) => a !== '--name' && all[i - 1] !== '--name');
  const r = spawnSync(plan.file, args, { encoding: 'utf8', shell: false, timeout: 40 * 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n') };
}

// The long path, not the 8.3 one: a temp directory under `SUHAIL~1` reaches
// vite-node as `SUHAIL%7E1`, and its module resolution cannot find itself.
const scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-templates-'));
try {
  for (const id of ids) {
    console.log(`\n-- ${id} --`);
    const src = path.join(templatesDir, id);
    const template = JSON.parse(fs.readFileSync(path.join(src, 'template.json'), 'utf8'));
    const problems = validateManifest(template);
    check(problems.length === 0, `${id}: manifest validates`, problems.join('\n'));
    const dir = path.join(scratch, id);
    // The packaging filter, so what is verified is what ships.
    fs.cpSync(src, dir, { recursive: true, filter: templatePackageFilter(templatesDir) });

    if (!template.toolchain || template.toolchain.id === 'node') {
      check(fs.existsSync(path.join(dir, 'package-lock.json')), `${id}: has a lockfile`);
      const ci = runNpm(dir, ['ci', '--no-audit', '--no-fund']);
      check(ci.ok, `${id}: npm ci from the lockfile`, ci.out);
      if (!ci.ok) continue;
      const env = { SESSION_SECRET: 'templates-live-secret-long-enough', DATABASE_PATH: ':memory:', ...(template.verify?.env ?? {}) };
      for (const script of ['typecheck', 'lint', 'test', 'build']) {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (!pkg.scripts?.[script]) { check(script !== 'typecheck' && script !== 'test' && script !== 'build', `${id}: has a "${script}" script`); continue; }
        const r = runNpm(dir, ['run', script], env);
        check(r.ok, `${id}: npm run ${script}`, r.out);
      }
      continue;
    }

    // Another stack: the toolchain it declares, natively or in its container.
    const run = { ...(template.run ?? {}), ...(process.platform === 'win32' ? (template.run?.win32 ?? {}) : {}) };
    const report = checkRequirements({ toolchain: template.toolchain });
    const dockerOk = dockerReady().ok;
    let mode;
    if (forceDocker) mode = dockerOk ? 'docker' : undefined;
    else if (forceNative) mode = report.ok ? 'native' : undefined;
    else mode = report.ok ? 'native' : dockerOk ? 'docker' : undefined;
    if (!mode) {
      check(false, `${id}: NOT VERIFIED — no ${template.toolchain.id} ${template.toolchain.version ?? ''} toolchain and no running Docker`, report.message);
      continue;
    }
    console.log(`  (${mode === 'native' ? 'native toolchain' : `container ${dockerImageFor(template)}`})`);
    const env = { ...(run.env ?? {}), ...(template.verify?.env ?? {}) };
    const skip = new Set(template.verify?.skip ?? []);
    const steps = ['install', 'format', 'lint', 'typecheck', 'test', 'build', 'audit'].filter(s => run[s] && !skip.has(s));
    check(!!run.test, `${id}: declares a test command`);
    for (const step of steps) {
      const command = run[step];
      const r = mode === 'native' ? runNative(dir, command, env) : runDocker(id, dir, command, template, env);
      check(r.ok, `${id}: ${step} (${command})`, r.out);
      if (!r.ok && step === 'install') break;
    }
  }
} finally {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ }
}

console.log(`\ntemplates: ${passed} passed, ${failed} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(failed ? 1 : 0);
