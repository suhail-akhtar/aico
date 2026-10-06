/**
 * End-to-end proof that the `system-medium` bundle works from a clean copy.
 *
 * Why this exists: `templates-live.mjs` only knows single Node projects, and a bundle is a whole
 * system (React app, Spring Modulith API, gateway, identity provider, database, cache, object
 * store, flags, mail). Its compose file had never been run, and "the unit tests pass" says nothing
 * about whether Traefik routes, the Keycloak issuer URL, the init scripts and the images agree.
 * This script copies the bundle to a scratch directory the way `instantiateTemplate` does (no
 * `target/`, `node_modules/`, `.env`), generates `.env` from `.env.example` with random values and
 * free host ports, then runs what the bundle promises, naming each check:
 *
 *   1. the manifest validator, SHA-pinned Actions, digest-pinned images, LF line endings;
 *   2. the web app: locked install, format, lint, types, tests with coverage, npm audit, build;
 *   3. the API in the pinned Maven + Temurin 25 image with the Docker socket mounted (so the
 *      integration tests get real PostgreSQL and Valkey): `mvnw verify`, the test counts read from the
 *      surefire/failsafe XML, the JaCoCo 85% gate read from the CSV, SpotBugs read from its XML;
 *   4. the dependency audit (OSV-Scanner on the SBOM);
 *   5. `docker compose up --build --wait` under a unique project name on free ports, every service
 *      healthy, then `scripts/smoke.mjs` (sign in through Keycloak, create a task, the outbox mail
 *      reaches Mailpit, the audit row exists), then `down -v` and removal of the images it built.
 *
 * It never touches the real ~/.aico (test home is imported first), calls no model, edits nothing in
 * the template, and only removes the containers, volumes and images it created itself (the Maven
 * cache volume `aico-sysmedium-m2` is kept on purpose, like the other Spring verify script's).
 * A step that cannot run (no Docker, offline) is reported as skipped, never as passed.
 *
 * Run: node scripts/templates-verify-system-medium.mjs [--skip-docker] [--offline] [--keep]
 *   --skip-docker   only the manifest, static and web checks (no API build, audit, or compose)
 *   --offline       skip the dependency audit and the GitHub tag lookups of the action pins
 *   --keep          leave the scratch copy (and the running stack) in place and print how to remove it
 * Exit code 1 when any check fails.
 */

import './lib/test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkActionPins, copyTemplate, createReporter, dockerAvailable, freePort, run, scratchDir, secret, tail } from './lib/verify-kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'templates', 'system-medium');
const flags = new Set(process.argv.slice(2));
const offline = flags.has('--offline');
const skipDocker = flags.has('--skip-docker');
const keep = flags.has('--keep');
const PROJECT = `aico-sysmedium-verify-${secret(3)}`;
const MAVEN_IMAGE = 'maven:3.9-eclipse-temurin-25@sha256:93b8a14ea2f412782e4e842651273b4d903e35cc496284f178fbbe2d67d00976';
const isWin = process.platform === 'win32';
// Node refuses to spawn .cmd shims without a shell; run npm's own entry point with this node instead.
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npm = isWin && fs.existsSync(npmCli) ? process.execPath : 'npm';
const npmArgs = (args) => (npm === process.execPath ? [npmCli, ...args] : args);

const r = createReporter();
const { check, skip, section } = r;
let scratch;
let stackUp = false;
const images = [`${PROJECT}-api:test`, `${PROJECT}-web:test`];

const compose = (args, opts = {}) => run('docker', ['compose', '-p', PROJECT, '-f', 'compose.yaml', '-f', 'compose.verify.yaml', ...args], { cwd: path.join(scratch, 'app'), ...opts });

try {
  section('toolchain');
  const docker = dockerAvailable();
  if (skipDocker) skip('docker daemon', '--skip-docker');
  else if (!check(Boolean(docker), 'the docker daemon is reachable')) throw new Error('docker is required (or pass --skip-docker)');
  else r.note(`docker ${docker}`);
  const node = run(process.execPath, ['--version']);
  r.note(`node ${node.out.trim()} (the web image builds with Node 24; the host version only runs the web checks)`);

  section('manifest and static checks');
  const v = run(process.execPath, [path.join(root, 'scripts', 'validate-template.mjs'), source]);
  check(v.ok, 'template.json validates and the template is complete', tail(v.out));

  scratch = scratchDir('aico-sysmedium-verify-');
  const app = path.join(scratch, 'app');
  copyTemplate(source, app, { substitutions: { __APP_TITLE__: 'Verify System', __APP_SLUG__: 'verify-system', __APP_DESCRIPTION__: 'verification copy' } });
  r.note(`scratch copy: ${app}`);

  const pins = checkActionPins(app, { offline });
  check(pins.problems.length === 0, 'every GitHub Action is pinned to a commit SHA with its version comment', pins.problems.join('\n'));
  if (pins.skipped) skip('action SHAs match their tags', offline ? '--offline' : 'gh CLI not available');
  else check(true, `action SHAs are the commits of their tags (${pins.verified.length} verified)`);

  const composeText = fs.readFileSync(path.join(app, 'compose.yaml'), 'utf8');
  const unpinned = [...composeText.matchAll(/^\s+image:\s+(\S+)/gm)].map((m) => m[1]).filter((i) => !i.startsWith('system-') && !/@sha256:[0-9a-f]{64}$/.test(i));
  check(unpinned.length === 0, 'every third-party image in compose.yaml is pinned by digest', unpinned.join(', '));
  const crlf = ['services/api/mvnw', 'infra/postgres/init/10-roles-and-databases.sh', 'infra/seaweedfs/entrypoint.sh', 'compose.yaml'].filter((f) => fs.readFileSync(path.join(app, f), 'utf8').includes('\r'));
  check(crlf.length === 0, 'shell scripts, mvnw and compose.yaml have LF line endings', crlf.join(', '));
  const ex = fs.readFileSync(path.join(app, '.env.example'), 'utf8');
  check(!fs.existsSync(path.join(app, '.env')) && /=change-me/.test(ex), '.env.example holds only change-me placeholders and no .env is shipped');

  section('web app (services/web)');
  const web = path.join(app, 'services', 'web');
  const ci = run(npm, npmArgs(['ci', '--no-audit', '--no-fund']), { cwd: web, timeout: 10 * 60_000 });
  check(ci.ok, 'npm ci from the lockfile', tail(ci.out));
  if (ci.ok) {
    for (const [script, label] of [['fmt:check', 'format (biome)'], ['lint', 'lint (biome)'], ['typecheck', 'types (tsc)']]) {
      const s = run(npm, npmArgs(['run', script]), { cwd: web });
      check(s.ok, label, tail(s.out));
    }
    const cov = run(npm, npmArgs(['run', 'cov']), { cwd: web });
    const m = /Tests\s+(\d+) passed/.exec(cov.out);
    check(cov.ok && m && Number(m[1]) >= 31, `unit and component tests with coverage thresholds (${m ? m[1] : '?'} passed, >= 31 expected)`, tail(cov.out));
    if (offline) skip('npm audit (high, production)', '--offline');
    else {
      const a = run(npm, npmArgs(['audit', '--audit-level=high', '--omit=dev']), { cwd: web });
      check(a.ok, 'npm audit finds no high or critical production vulnerability', tail(a.out));
    }
    const b = run(npm, npmArgs(['run', 'build']), { cwd: web });
    check(b.ok && fs.existsSync(path.join(web, 'dist', 'index.html')), 'production build', tail(b.out));
  }

  const api = path.join(app, 'services', 'api');
  if (skipDocker) {
    for (const what of ['API build, tests, coverage, SpotBugs', 'dependency audit', 'docker compose up --wait', 'end-to-end smoke']) skip(what, '--skip-docker');
  } else {
    section('API (services/api), in the pinned Maven + Temurin 25 image');
    const mvn = run(
      'docker',
      ['run', '--rm', '-v', `${api}:/src`, '-v', 'aico-sysmedium-m2:/root/.m2', '-v', '/var/run/docker.sock:/var/run/docker.sock',
        '-e', 'TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal', '-w', '/src', MAVEN_IMAGE, 'sh', './mvnw', '-B', '-ntp', 'verify'],
      { timeout: 40 * 60_000 },
    );
    check(mvn.ok, 'mvnw verify (format, Error Prone + NullAway, unit + integration tests, coverage gate, SpotBugs, SBOM)', tail(mvn.out, 40));

    const sum = (dir) => {
      const d = path.join(api, 'target', dir);
      if (!fs.existsSync(d)) return { tests: 0, bad: 0 };
      let tests = 0;
      let bad = 0;
      for (const f of fs.readdirSync(d).filter((n) => /^TEST-.*\.xml$/.test(n))) {
        const head = fs.readFileSync(path.join(d, f), 'utf8').slice(0, 2000);
        const g = (k) => Number(new RegExp(`<testsuite[^>]*\\s${k}="(\\d+)"`).exec(head)?.[1] ?? 0);
        tests += g('tests');
        bad += g('failures') + g('errors');
      }
      return { tests, bad };
    };
    const unit = sum('surefire-reports');
    const it = sum('failsafe-reports');
    check(unit.tests >= 100 && unit.bad === 0, `unit and architecture tests (${unit.tests} run, ${unit.bad} failed, >= 100 expected)`);
    check(it.tests >= 60 && it.bad === 0, `integration tests on real PostgreSQL and Valkey (${it.tests} run, ${it.bad} failed, >= 60 expected)`);

    const csv = path.join(api, 'target', 'site', 'jacoco', 'jacoco.csv');
    if (fs.existsSync(csv)) {
      const rows = fs.readFileSync(csv, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
      const missed = rows.reduce((n, x) => n + Number(x[7]), 0);
      const covered = rows.reduce((n, x) => n + Number(x[8]), 0);
      const pct = (100 * covered) / (covered + missed);
      check(pct >= 85, `line coverage read from jacoco.csv (>= 85% required)`, `${pct.toFixed(1)}% = ${covered}/${covered + missed}`);
      r.note(`line coverage ${pct.toFixed(1)}%`);
    } else check(false, 'JaCoCo report exists', 'target/site/jacoco/jacoco.csv missing');

    const sb = path.join(api, 'target', 'spotbugsXml.xml');
    check(fs.existsSync(sb) && (fs.readFileSync(sb, 'utf8').match(/<BugInstance /g) ?? []).length === 0, 'SpotBugs + FindSecBugs report no bug (read from spotbugsXml.xml)');
    check(fs.existsSync(path.join(api, 'target', 'classes', 'META-INF', 'sbom', 'application.cdx.json')), 'the CycloneDX SBOM was produced');

    section('dependency audit');
    if (offline) skip('OSV-Scanner on the SBOM', '--offline');
    else {
      const a = run(process.execPath, ['scripts/audit.mjs', '--no-build'], { cwd: api, timeout: 10 * 60_000 });
      check(a.ok, 'OSV-Scanner finds no vulnerable dependency in the API SBOM', tail(a.out));
    }

    section('the whole system (docker compose)');
    const env = Object.fromEntries(ex.split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
    for (const k of Object.keys(env)) if (env[k].startsWith('change-me')) env[k] = secret(16);
    env.APP_PORT = String(await freePort());
    env.IDP_PORT = String(await freePort());
    env.MAILPIT_PORT = String(await freePort());
    fs.writeFileSync(path.join(app, '.env'), `${Object.entries(env).map(([k, val]) => `${k}=${val}`).join('\n')}\n`);
    // Distinct image names, so a concurrent run (or the developer's own stack) is never overwritten.
    fs.writeFileSync(
      path.join(app, 'compose.verify.yaml'),
      `services:\n  web:\n    image: ${images[1]}\n  api:\n    image: ${images[0]}\n  worker:\n    image: ${images[0]}\n`,
    );
    r.note(`project ${PROJECT}, ports app ${env.APP_PORT} idp ${env.IDP_PORT} mail ${env.MAILPIT_PORT}`);

    const cfg = compose(['config', '-q']);
    check(cfg.ok, 'compose.yaml is valid with the generated .env', tail(cfg.out));
    stackUp = true;
    const up = compose(['up', '--build', '--wait', '--wait-timeout', '300'], { timeout: 25 * 60_000 });
    check(up.ok, 'docker compose up --build --wait: every service healthy', tail(up.out, 40));
    if (!up.ok) {
      const ps = compose(['ps', '-a']);
      r.note(tail(ps.out, 20));
      const logs = compose(['logs', '--no-color', '--tail=40']);
      r.note(tail(logs.out, 80));
    } else {
      const ps = compose(['ps', '--format', '{{.Service}} {{.Health}} {{.State}}']);
      const rows = ps.out.trim().split('\n').filter(Boolean).map((l) => l.split(' '));
      const names = rows.map((x) => x[0]).sort().join(',');
      const bad = rows.filter((x) => x[2] !== 'running' || (x[1] && x[1] !== 'healthy'));
      check(bad.length === 0 && rows.length >= 10, `all ${rows.length} services running and healthy (${names})`, bad.map((x) => x.join(' ')).join('\n'));
      const smoke = run(process.execPath, ['scripts/smoke.mjs'], { cwd: app, timeout: 5 * 60_000 });
      console.log(smoke.out.trimEnd().split('\n').map((l) => `       ${l}`).join('\n'));
      check(smoke.ok, 'end-to-end smoke: Keycloak sign-in, task through the gateway, outbox mail in Mailpit, audit row', tail(smoke.out, 30));
    }
  }
} catch (e) {
  check(false, 'the verification ran to the end', e.stack ?? String(e));
} finally {
  if (scratch && stackUp) {
    if (keep) r.note(`stack left running: docker compose -p ${PROJECT} -f ${path.join(scratch, 'app', 'compose.yaml')} -f ${path.join(scratch, 'app', 'compose.verify.yaml')} down -v`);
    else {
      const d = compose(['down', '-v', '--remove-orphans'], { timeout: 5 * 60_000 });
      check(d.ok, 'the stack and its volumes were removed', tail(d.out));
      for (const img of images) run('docker', ['rmi', img], { timeout: 60_000 });
    }
  }
  if (scratch && !keep) {
    try {
      // The API build ran as root in a container: files it wrote may need a retry on Windows.
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      r.note(`could not remove ${scratch}: ${e.message}`);
    }
  } else if (scratch) r.note(`kept scratch copy: ${scratch}`);
}
const code = r.finish('system-medium');
process.exit(code);
