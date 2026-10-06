/**
 * End-to-end proof that the `api-service-fastapi` starter works from a clean copy.
 *
 * Why this exists: `scripts/templates-live.mjs` (the rot check) only knows npm, so a
 * Python starter would be silently skipped and could rot unseen. This script copies the
 * template to a scratch directory the way `instantiateTemplate` does (no artefact
 * directories, tokens substituted, `.env` generated from `.env.example`), then runs
 * everything the starter promises: the manifest validator, a locked install, format,
 * lint, mypy --strict, bandit, the OpenAPI freshness check, the test suite with its 85%
 * coverage gate, the dependency audit, the dev server exactly as the manifest's `run.dev`
 * starts it (readiness regex included), the production image (non-root, read-only,
 * fail-fast on bad config, `/healthz`), the compose stack with PostgreSQL (register, log
 * in, create an item, no secret in the logs), and the same test suite against that
 * PostgreSQL. A step that cannot run (no Docker, offline) is reported as skipped, never
 * as passed.
 *
 * What it deliberately does not do: touch `~/.aico` (it imports the isolated test home
 * first, and never starts the engine), call a model (free, no tokens), or install
 * anything outside the scratch directory and Docker's own image/volume caches.
 *
 * Run: node scripts/templates-verify-fastapi.mjs [--skip-docker] [--skip-audit]
 *        [--skip-pg] [--offline] [--keep]
 *   --offline   UV_OFFLINE=1, and skips the audit and every Docker build (needs a warm cache)
 *   --keep      leave the scratch copy in place and print its path
 * Exit code 1 when any step fails.
 */

import './lib/test-home.mjs';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.join(root, 'templates', 'api-service-fastapi');
const flags = new Set(process.argv.slice(2));
const offline = flags.has('--offline');
const skipDocker = flags.has('--skip-docker') || offline;
const skipAudit = flags.has('--skip-audit') || offline;
const skipPg = flags.has('--skip-pg') || skipDocker;
const PROJECT = 'aico-fastapi-verify';
const IMAGE = `${PROJECT}:test`;
const isWin = process.platform === 'win32';

let passed = 0, failed = 0, skipped = 0;
const failures = [];
function check(cond, label, detail) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? `\n${indent(detail)}` : ''}`); }
  return Boolean(cond);
}
function skip(label, why) { skipped++; console.log(`  skip ${label} (${why})`); }
function indent(text) { return String(text).split('\n').map(l => `       ${l}`).join('\n'); }
function tail(text, n = 25) { return String(text).trim().split('\n').slice(-n).join('\n'); }
function section(name) { console.log(`\n-- ${name} --`); }

function run(cmd, args, { cwd, env = {}, timeout = 15 * 60_000, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout, input,
    env: { ...process.env, CI: '1', PYTHONUTF8: '1', ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  return { ok: r.status === 0, status: r.status, out, stdout: r.stdout ?? '', error: r.error };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const secret = (bytes) => crypto.randomBytes(bytes).toString('hex');

async function http(method, url, { body, headers = {}, timeout = 10_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

/** The account -> item -> refresh flow every running instance must support. */
async function apiFlow(base, tag) {
  const email = `verify-${secret(4)}@example.com`;
  const password = `pw-${secret(12)}`;
  const health = await http('GET', `${base}/healthz`);
  check(health.status === 200 && health.json?.status === 'ok', `${tag}: /healthz is ok`);
  const ready = await http('GET', `${base}/readyz`);
  check(ready.status === 200 && ready.json?.database === 'ok', `${tag}: /readyz is ok (database answers)`, ready.text);
  const unauth = await http('GET', `${base}/v1/items`);
  check(unauth.status === 401 && unauth.headers.get('content-type')?.startsWith('application/problem+json'), `${tag}: no token is a 401 problem+json`);
  const reg = await http('POST', `${base}/v1/auth/register`, { body: { email, password } });
  check(reg.status === 201 && !reg.text.includes(password), `${tag}: register answers 201 without the password`, reg.text);
  const login = await http('POST', `${base}/v1/auth/login`, { body: { email, password } });
  check(login.status === 200 && login.json?.access_token, `${tag}: login gives a token pair`, login.text);
  const auth = { authorization: `Bearer ${login.json?.access_token}` };
  const created = await http('POST', `${base}/v1/items`, { body: { name: 'pen', quantity: 3 }, headers: auth });
  check(created.status === 201 && created.json?.name === 'pen', `${tag}: POST /v1/items creates`, created.text);
  const bad = await http('POST', `${base}/v1/items`, { body: { name: ' ' }, headers: auth });
  check(bad.status === 422 && bad.json?.errors?.[0]?.loc?.join('.') === 'body.name', `${tag}: a bad body names the field`, bad.text);
  const list = await http('GET', `${base}/v1/items`, { headers: auth });
  check(list.status === 200 && list.json?.items?.length === 1, `${tag}: GET /v1/items lists it`, list.text);
  const refreshed = await http('POST', `${base}/v1/auth/refresh`, { body: { refresh_token: login.json?.refresh_token } });
  check(refreshed.status === 200 && refreshed.json?.refresh_token !== login.json?.refresh_token, `${tag}: refresh rotates the token`, refreshed.text);
  const replay = await http('POST', `${base}/v1/auth/refresh`, { body: { refresh_token: login.json?.refresh_token } });
  check(replay.status === 401, `${tag}: a used refresh token is refused`);
  const hdrs = list.headers;
  check(hdrs.get('x-content-type-options') === 'nosniff' && hdrs.get('x-request-id') && !hdrs.get('server'), `${tag}: security headers, a request id, no Server header`);
  const spec = await http('GET', `${base}/openapi.json`);
  check(spec.status === 200 && spec.json?.openapi?.startsWith('3.1'), `${tag}: /openapi.json is served`);
  return { email, password, jwtLeak: (text) => [password, login.json?.refresh_token].filter(Boolean).some(s => text.includes(s)) };
}

const cleanup = [];
let scratch;
const versions = {};

try {
  // ---------------------------------------------------------------- toolchain
  section('toolchain');
  const uvVersion = run('uv', ['--version']);
  if (!check(uvVersion.ok, 'uv is installed', 'Install uv: https://docs.astral.sh/uv/getting-started/installation/')) throw new Error('uv missing');
  versions.uv = uvVersion.out.trim().split('\n')[0];
  console.log(`       ${versions.uv}`);
  const dockerProbe = skipDocker ? { ok: false } : run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 30_000 });
  const docker = dockerProbe.ok;
  if (docker) console.log(`       docker ${dockerProbe.out.trim().split('\n')[0]}`);
  else if (!skipDocker) check(false, 'docker daemon is reachable (or pass --skip-docker)');
  else skip('docker steps', offline ? '--offline' : '--skip-docker');

  // ---------------------------------------------------------------- manifest
  section('manifest');
  const validator = path.join(here, 'validate-template.mjs');
  if (fs.existsSync(validator)) {
    const v = run(process.execPath, [validator, source], { cwd: root, timeout: 120_000 });
    check(v.ok, 'validate-template.mjs accepts the manifest and completeness bar', tail(v.out));
  } else skip('validate-template.mjs', 'not present in this checkout');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'template.json'), 'utf8'));
  check(manifest.id === 'api-service-fastapi' && manifest.kind === 'process' && manifest.toolchain?.id === 'python', 'manifest identifies a python process template');
  check(fs.statSync(path.join(source, 'AICO.md')).size <= 2000 && fs.readFileSync(path.join(source, 'AICO.md'), 'utf8').length <= 2000, 'AICO.md is within the 2,000 character cap');

  // ---------------------------------------------------------------- scratch copy
  section('clean copy (as instantiateTemplate would make it)');
  scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-fastapi-'));
  const app = path.join(scratch, 'app');
  const artefact = /[\\/](\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.hypothesis|htmlcov|data|\.git)([\\/]|$)|[\\/]\.env$|[\\/]\.coverage$|[\\/]coverage\.xml$/;
  fs.cpSync(source, app, { recursive: true, filter: (p) => p === source || !artefact.test(p.slice(source.length)) });
  fs.rmSync(path.join(app, 'template.json'));
  check(fs.existsSync(path.join(app, 'uv.lock')), 'the lockfile is shipped');
  check(!fs.existsSync(path.join(app, '.venv')) && !fs.existsSync(path.join(app, '.env')), 'no virtualenv and no .env came along');
  const subs = { __APP_TITLE__: 'Verify App', __APP_SLUG__: PROJECT, __APP_DESCRIPTION__: 'verification copy' };
  for (const rel of manifest.substitute ?? []) {
    const dir = path.dirname(rel), pattern = path.basename(rel);
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    const abs = path.join(app, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter(n => re.test(n))) {
      const full = path.join(abs, f);
      if (!fs.statSync(full).isFile()) continue;
      let text = fs.readFileSync(full, 'utf8');
      for (const [k, val] of Object.entries(subs)) text = text.split(k).join(val);
      fs.writeFileSync(full, text);
    }
  }
  // writeLocalEnv: every `change-me...` value becomes a random one (the manifest's formats where listed).
  const gen = manifest.envFile?.generate ?? {};
  const envText = fs.readFileSync(path.join(app, '.env.example'), 'utf8').split(/\r?\n/).map((line) => {
    const m = /^([A-Z0-9_]+)=(change-me.*)$/.exec(line);
    if (!m) return line;
    const fmt = gen[m[1]] ?? 'hex:24';
    const [kind, n] = fmt.split(':');
    const value = kind === 'password' ? crypto.randomBytes(Number(n ?? 24)).toString('base64url').slice(0, Number(n ?? 24)) : secret(Number(n ?? 24));
    return `${m[1]}=${value}`;
  }).join('\n');
  fs.writeFileSync(path.join(app, '.env'), envText);
  const envValues = Object.fromEntries(envText.split('\n').filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  check(!envText.split('\n').some(l => /^[A-Z0-9_]+=change-me/.test(l)), '.env was generated with random secrets (no placeholder value left)');
  console.log(`       ${app}`);

  // ---------------------------------------------------------------- native checks
  section('install and static checks');
  const uvEnv = { UV_PROJECT_ENVIRONMENT: path.join(app, '.venv'), ...(offline ? { UV_OFFLINE: '1' } : {}) };
  const sync = run('uv', ['sync', '--locked'], { cwd: app, env: uvEnv });
  if (!check(sync.ok, 'uv sync --locked installs from the lockfile', tail(sync.out))) throw new Error('install failed');
  const lockText = fs.readFileSync(path.join(app, 'uv.lock'), 'utf8');
  for (const name of ['fastapi', 'starlette', 'pydantic', 'sqlalchemy', 'psycopg', 'alembic', 'pwdlib', 'pyjwt', 'structlog', 'uvicorn', 'limits', 'ruff', 'mypy', 'pytest', 'hypothesis', 'schemathesis']) {
    const m = new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`).exec(lockText);
    if (m) versions[name] = m[1];
  }
  const py = run('uv', ['run', 'python', '-c', 'import platform;print(platform.python_version())'], { cwd: app, env: uvEnv });
  versions.python = py.out.trim().split('\n')[0];
  const uvr = (args, extra = {}) => run('uv', ['run', '--locked', ...args], { cwd: app, env: { ...uvEnv, ...extra } });
  check(uvr(['ruff', 'format', '--check', '.']).ok, 'ruff format --check');
  { const r = uvr(['ruff', 'check', '.']); check(r.ok, 'ruff check (lint + security rules)', tail(r.out)); }
  { const r = uvr(['mypy']); check(r.ok, 'mypy --strict', tail(r.out)); }
  { const r = uvr(['bandit', '-q', '-c', 'pyproject.toml', '-r', 'src']); check(r.ok, 'bandit', tail(r.out)); }
  { const r = uvr(['python', '-m', 'app.cli', 'openapi', '--check']); check(r.ok, 'openapi.json matches the app', tail(r.out)); }

  section('tests with the coverage gate');
  {
    const r = uvr(['pytest', '-q', '--cov', '--cov-fail-under=85', '--cov-report=term']);
    const cov = /Total coverage: ([\d.]+)%/.exec(r.out);
    const count = /(\d+) passed/.exec(r.out);
    check(r.ok && count, `pytest passes${count ? ` (${count[1]} tests)` : ''}`, tail(r.out, 40));
    check(cov && Number(cov[1]) >= 85, `coverage ${cov ? `${cov[1]}%` : 'unknown'} meets the 85% gate`);
    versions.tests = count?.[1];
    versions.coverage = cov?.[1];
  }

  section('dependency audit');
  if (skipAudit) skip('pip-audit', offline ? '--offline' : '--skip-audit');
  else { const r = uvr(['python', 'scripts/audit.py']); check(r.ok && /No known vulnerabilities/.test(r.out), 'pip-audit: no known vulnerabilities in the locked set', tail(r.out)); }

  // ---------------------------------------------------------------- dev server, as the manifest starts it
  section('dev server (manifest run.dev)');
  {
    const port = await freePort();
    const parts = manifest.run.dev.replace('{port}', String(port)).split(/\s+/);
    // The manifest's readiness regex must match what uvicorn actually prints.
    const ready = new RegExp(manifest.run.ready);
    const child = spawn(parts[0], parts.slice(1), {
      cwd: app, env: { ...process.env, ...uvEnv, PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let sawReady = false;
    for (const s of [child.stdout, child.stderr]) s.on('data', d => { output += d; if (ready.test(output)) sawReady = true; });
    const kill = () => { try { isWin ? spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']) : child.kill('SIGTERM'); } catch { /* already gone */ } };
    cleanup.push(kill);
    try {
      await waitFor(() => sawReady, 120_000, 'run.ready to match the dev server output');
      check(true, 'the manifest readiness regex matches the dev server output');
      const base = `http://127.0.0.1:${port}`;
      await waitFor(async () => (await http('GET', `${base}/healthz`)).status === 200, 30_000, '/healthz');
      const flow = await apiFlow(base, 'dev');
      check((await http('GET', `${base}/docs`)).status === 200, 'dev: /docs serves the interactive API page');
      check(fs.existsSync(path.join(app, 'data', 'app.db')), 'dev: the SQLite database was created and migrated by AUTO_MIGRATE');
      void flow;
    } catch (e) { check(false, 'dev server starts and answers', `${e.message}\n${tail(output, 30)}`); }
    kill();
    await sleep(500);
  }

  // ---------------------------------------------------------------- container
  section('production image');
  if (!docker) skip('image build and smoke test', 'no docker');
  else {
    const build = run('docker', ['build', '-t', IMAGE, '.'], { cwd: app, timeout: 20 * 60_000 });
    if (check(build.ok, 'docker build (runtime target)', tail(build.out))) {
      cleanup.push(() => run('docker', ['rmi', '-f', IMAGE]));
      const inspect = JSON.parse(run('docker', ['image', 'inspect', IMAGE]).stdout)[0];
      check(inspect.Config.User === '10001', 'the image runs as a non-root user (uid 10001)');
      check(Boolean(inspect.Config.Healthcheck), 'the image declares a HEALTHCHECK');
      check(!JSON.stringify(inspect.Config.Env).includes('JWT_SECRET'), 'no secret is baked into the image environment');
      // The same image scan CI runs: fixable HIGH or CRITICAL findings fail it. Skipped (not
      // passed) when the scanner image cannot be pulled.
      const TRIVY = 'ghcr.io/aquasecurity/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa';
      const scan = run('docker', ['run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock', TRIVY, 'image', '--exit-code', '1', '--severity', 'HIGH,CRITICAL', '--ignore-unfixed', '--quiet', IMAGE], { timeout: 10 * 60_000 });
      if (/pull access denied|Unable to find image|TLS handshake|no such host/i.test(scan.out) && !scan.ok) skip('trivy image scan', 'scanner image not available');
      else check(scan.ok, 'trivy: no fixable HIGH or CRITICAL vulnerability in the image', tail(scan.out, 30));
      // Fail fast: production refuses to start without its configuration.
      const bare = run('docker', ['run', '--rm', IMAGE], { timeout: 60_000 });
      check(!bare.ok && /jwt_secret|JWT_SECRET/i.test(bare.out) && !/Traceback \(most recent call last\)[\s\S]*Internal/.test(bare.out), 'with no configuration the container exits non-zero and names the missing setting', tail(bare.out, 8));
      // Running, hardened, with a database that is not there: alive but not ready.
      const port = await freePort();
      const name = `${PROJECT}-solo`;
      const start = run('docker', ['run', '-d', '--name', name, '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '-p', `127.0.0.1:${port}:8000`, '-e', `JWT_SECRET=${secret(32)}`, '-e', 'DATABASE_URL=postgresql+psycopg://u:p@127.0.0.1:1/none', IMAGE]);
      cleanup.push(() => run('docker', ['rm', '-f', name]));
      if (check(start.ok, 'the hardened container starts (read-only, no capabilities)', tail(start.out))) {
        try {
          const base = `http://127.0.0.1:${port}`;
          await waitFor(async () => (await http('GET', `${base}/healthz`)).status === 200, 60_000, 'container /healthz');
          check(true, 'container: /healthz answers 200');
          const ready = await http('GET', `${base}/readyz`);
          check(ready.status === 503 && ready.headers.get('content-type')?.startsWith('application/problem+json') && ready.json?.code === 'unavailable', 'container: /readyz is a 503 problem+json when the database is down', ready.text);
          check(run('docker', ['exec', name, 'id', '-u']).out.trim() === '10001', 'container: the process runs as uid 10001');
          check(!run('docker', ['exec', name, 'sh', '-c', 'touch /should-not-work']).ok, 'container: the root filesystem is read-only');
          const hc = run('docker', ['exec', name, ...inspect.Config.Healthcheck.Test.slice(1)]);
          check(hc.ok, 'container: the HEALTHCHECK command succeeds');
          const logs = run('docker', ['logs', name]).out;
          check(logs.split('\n').filter(l => l.startsWith('{')).every(l => { try { JSON.parse(l); return true; } catch { return false; } }) && /"event"/.test(logs), 'container: logs are JSON lines');
        } catch (e) { check(false, 'container answers', e.message); }
      }
      run('docker', ['rm', '-f', name]);
    }

    section('compose stack (PostgreSQL + migration + API)');
    const apiPort = await freePort();
    const composeEnv = { ...Object.fromEntries(Object.entries(envValues).filter(([k]) => ['POSTGRES_PASSWORD', 'JWT_SECRET'].includes(k))), API_PORT: String(apiPort), COMPOSE_PROJECT_NAME: PROJECT };
    const compose = (args, opts = {}) => run('docker', ['compose', ...args], { cwd: app, env: composeEnv, timeout: 25 * 60_000, ...opts });
    cleanup.push(() => run('docker', ['rmi', '-f', PROJECT, `${PROJECT}-tools`]));
    cleanup.push(() => compose(['--profile', 'tools', 'down', '-v', '--remove-orphans', '--timeout', '5']));
    const up = compose(['up', '-d', '--build', '--wait', '--wait-timeout', '240']);
    if (check(up.ok, 'docker compose up --wait: db healthy, migration completed, api healthy', tail(up.out, 40))) {
      const base = `http://127.0.0.1:${apiPort}`;
      const flow = await apiFlow(base, 'compose');
      const logs = compose(['logs', 'api', 'migrate', '--no-color']).out;
      check(/"event": ?"http\.request"/.test(logs), 'compose: the API logs structured request events');
      check(!flow.jwtLeak(logs) && !logs.includes(envValues.JWT_SECRET) && !logs.includes(envValues.POSTGRES_PASSWORD), 'compose: no password, token or secret appears in the logs');
      const apiId = compose(['ps', '-q', 'api']).out.trim();
      const ro = run('docker', ['inspect', '--format', '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}', apiId]).out.trim();
      check(/^true \[ALL\] \[no-new-privileges:true\]/.test(ro), 'compose: api runs read-only, with every capability dropped and no-new-privileges', ro);

      section('the same test suite against PostgreSQL');
      if (skipPg) skip('tests on PostgreSQL', '--skip-pg');
      else {
        const pg = compose(['--profile', 'tools', 'run', '--rm', '--build', 'tools'], { env: composeEnv });
        const count = /(\d+) passed/.exec(pg.out);
        const cov = /Total coverage: ([\d.]+)%/.exec(pg.out);
        check(pg.ok && count, `tools stage on PostgreSQL: format, lint, mypy, bandit, tests${count ? ` (${count[1]} passed, ${cov?.[1]}% coverage)` : ''}, audit`, tail(pg.out, 40));
        versions.pgTests = count?.[1];
      }
    }
    compose(['--profile', 'tools', 'down', '-v', '--remove-orphans', '--timeout', '5']);
  }
} catch (e) {
  check(false, `aborted: ${e.message}`);
} finally {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* best effort */ } }
  if (scratch && !flags.has('--keep')) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a locked file on Windows: the OS temp cleaner takes it */ } }
  else if (scratch) console.log(`\nkept: ${scratch}`);
}

console.log('\nresolved versions:', JSON.stringify(versions));
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed) console.log(`failed:\n${failures.map(f => `  - ${f}`).join('\n')}`);
process.exit(failed ? 1 : 0);
