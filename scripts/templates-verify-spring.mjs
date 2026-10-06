/**
 * Verify the `api-service-spring` starter end to end, from a clean copy, and print what passed.
 *
 * Why this exists: `npm run test:templates` (templates-live.mjs) is Node-only and silently skips a
 * Maven project, so nothing in the repo proved this starter still builds. This script is the
 * Spring starter's rot check. It copies the template to a scratch directory the way an app is
 * instantiated (no `target/`, no `.env`), so a stray local file cannot make a broken starter pass,
 * then runs the same gates a user's CI runs:
 *
 *   1. the manifest validator (scripts/validate-template.mjs);
 *   2. `./mvnw verify`: Spotless, Error Prone + NullAway, unit + architecture + integration tests
 *      on real PostgreSQL (Testcontainers), the 85% JaCoCo gate, SpotBugs + FindSecBugs, SBOM;
 *   3. the dependency audit (OSV-Scanner on the SBOM);
 *   4. the container: build the image, start it with PostgreSQL, walk the API from outside.
 *
 * The starter targets Java 25. With a local JDK 25 the build runs natively; otherwise it runs in
 * the pinned `maven:3.9-eclipse-temurin-25` image with the Docker socket mounted (so Testcontainers
 * still gets a real PostgreSQL). Force a mode with AICO_SPRING_VERIFY=native|docker. Docker is
 * required for steps 2 (docker mode), 3 and 4; a step that cannot run is reported NOT VERIFIED and
 * fails the script, never passes silently. Free (no model calls), takes 5-10 minutes cold.
 *
 * It never touches the real ~/.aico, and does not edit the template. Run:
 *   node scripts/templates-verify-spring.mjs [--keep]   (--keep leaves the scratch copy in place)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(root, 'templates', 'api-service-spring');
const win = process.platform === 'win32';
const keep = process.argv.includes('--keep');
const MAVEN_IMAGE =
  'maven:3.9-eclipse-temurin-25@sha256:93b8a14ea2f412782e4e842651273b4d903e35cc496284f178fbbe2d67d00976';

const results = [];
function record(step, status, detail = '') {
  results.push({ step, status, detail });
  console.log(`\n== ${status}  ${step}${detail ? `  (${detail})` : ''}`);
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  return spawnSync(cmd, args, { stdio: 'inherit', shell: false, env: process.env, ...opts });
}

function has(cmd, args = ['--version']) {
  return spawnSync(cmd, args, { stdio: 'ignore', shell: win }).status === 0;
}

function javaMajor() {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8', shell: win });
  const m = /version "(\d+)/.exec(`${r.stderr}${r.stdout}`);
  return m ? Number(m[1]) : 0;
}

// ---- 0. a clean copy, like instantiateTemplate ---------------------------------------------
const SKIP = new Set(['target', '.git', '.env', '.env.local', 'node_modules', '.idea', '.vscode']);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-spring-verify-'));
const app = path.join(scratch, 'app');
fs.cpSync(template, app, {
  recursive: true,
  filter: src => !SKIP.has(path.basename(src)) && path.basename(src) !== 'template.json',
});
console.log(`scratch copy: ${app}`);

const dockerOk = has('docker');
let exitCode = 0;
try {
  // ---- 1. manifest -------------------------------------------------------------------------
  const v = run(process.execPath, [path.join(root, 'scripts', 'validate-template.mjs'), template]);
  record('template.json validates and the template is complete', v.status === 0 ? 'PASS' : 'FAIL');

  // ---- 2. mvnw verify ----------------------------------------------------------------------
  const mode = process.env.AICO_SPRING_VERIFY || (javaMajor() >= 25 ? 'native' : 'docker');
  let verify;
  if (mode === 'native') {
    verify = run(win ? 'cmd' : 'sh', win ? ['/c', 'mvnw', '-B', '-ntp', 'verify'] : ['./mvnw', '-B', '-ntp', 'verify'], {
      cwd: app,
      env: { ...process.env, AICO_TEST_DB: dockerOk ? 'postgres' : 'h2' },
    });
  } else if (dockerOk) {
    const cwd = app;
    verify = run(
      'docker',
      [
        'run', '--rm',
        '-v', `${cwd}:/src`,
        '-v', 'aico-spring-m2:/root/.m2',
        '-v', '/var/run/docker.sock:/var/run/docker.sock',
        '-e', 'AICO_TEST_DB=postgres',
        '-e', 'TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal',
        '-w', '/src',
        MAVEN_IMAGE,
        'sh', './mvnw', '-B', '-ntp', 'verify',
      ],
      { env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
  } else {
    record('mvnw verify', 'NOT VERIFIED', 'needs JDK 25 or Docker');
    exitCode = 1;
  }
  if (verify) {
    record(`mvnw verify (${mode}, Java 25)`, verify.status === 0 ? 'PASS' : 'FAIL', `exit ${verify.status}`);
    if (verify.status !== 0) exitCode = 1;
  }

  // Coverage, read from the JaCoCo CSV rather than trusting the build's own message.
  const csv = path.join(app, 'target', 'site', 'jacoco', 'jacoco.csv');
  if (fs.existsSync(csv)) {
    const rows = fs.readFileSync(csv, 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
    const missed = rows.filter(r => !r[2].endsWith('Application')).reduce((n, r) => n + Number(r[7]), 0);
    const covered = rows.filter(r => !r[2].endsWith('Application')).reduce((n, r) => n + Number(r[8]), 0);
    const pct = (100 * covered) / (covered + missed);
    record('line coverage (application code, >= 85% required)', pct >= 85 ? 'PASS' : 'FAIL', `${pct.toFixed(1)}% = ${covered}/${covered + missed} lines`);
    if (pct < 85) exitCode = 1;
  } else {
    record('line coverage report', 'FAIL', 'target/site/jacoco/jacoco.csv missing');
    exitCode = 1;
  }

  // ---- 3. audit ----------------------------------------------------------------------------
  if (!dockerOk) {
    record('dependency audit', 'NOT VERIFIED', 'needs Docker for the scanner');
    exitCode = 1;
  } else {
    const a = run(process.execPath, ['scripts/audit.mjs', '--no-build'], { cwd: app });
    record('dependency audit (OSV-Scanner on the SBOM)', a.status === 0 ? 'PASS' : 'FAIL', `exit ${a.status}`);
    if (a.status !== 0) exitCode = 1;
  }

  // ---- 4. container smoke ------------------------------------------------------------------
  if (!dockerOk) {
    record('container smoke test', 'NOT VERIFIED', 'needs Docker');
    exitCode = 1;
  } else {
    const s = run(process.execPath, ['scripts/smoke.mjs'], { cwd: app });
    record('container smoke test (image, PostgreSQL, API walk, SIGTERM)', s.status === 0 ? 'PASS' : 'FAIL', `exit ${s.status}`);
    if (s.status !== 0) exitCode = 1;
  }
} finally {
  if (!keep) fs.rmSync(scratch, { recursive: true, force: true });
  else console.log(`\nkept scratch copy: ${scratch}`);
}

console.log('\n---- summary ----');
for (const r of results) console.log(`${r.status.padEnd(12)} ${r.step}${r.detail ? `  (${r.detail})` : ''}`);
if (results.some(r => r.status === 'FAIL')) exitCode = 1;
console.log(exitCode === 0 ? '\napi-service-spring: all checks passed' : '\napi-service-spring: NOT all checks passed');
// Scripts that load engine modules end with an explicit exit; this one keeps the habit.
process.exit(exitCode);
