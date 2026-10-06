/**
 * End-to-end proof that the `api-service-go` starter works from a clean copy,
 * with every Go command run inside Docker.
 *
 * Why this exists: Go is not assumed to be installed (and AICO never installs a
 * toolchain onto the host, ADR 0027), and `scripts/templates-live.mjs` only knows
 * npm, so a Go starter that nothing checks would rot unseen. This script copies
 * the template to a scratch directory the way `instantiateTemplate` does (no
 * artefact directories, tokens substituted, `.env` generated from `.env.example`,
 * a git repository with the scaffold commit), builds the pinned tools image from
 * the template's own Dockerfile, and then runs what the starter promises through
 * `docker compose run tools make <verb>`: format check, lint (golangci-lint v2),
 * vet and build, `go mod tidy` cleanliness, generated-code freshness (oapi-codegen
 * and sqlc), the test suite with the race detector, real PostgreSQL and the 85%
 * coverage gate, govulncheck, the SBOM, and the audit allow-list logic. It then
 * builds the production image (distroless, non-root, version stamped, healthcheck)
 * and starts the compose stack to drive the API over HTTP: the account and item
 * flow, cross-user isolation, logout, security headers, no secret in the logs,
 * the seed command, and a graceful SIGTERM shutdown. A step that cannot run (no
 * Docker, offline) is reported as skipped, never as passed.
 *
 * What it deliberately does not do: touch `~/.aico` (it imports the isolated test
 * home first and never starts the engine), call a model (free, no tokens), or
 * install anything outside the scratch directory and Docker's own image/volume
 * caches (named volumes `aico-go-verify_*`, removed at the end).
 *
 * Run: node scripts/templates-verify-go.mjs [--skip-image] [--skip-checks] [--keep]
 *   --skip-checks  skip the tools-image steps (lint, tests, audit, ...)
 *   --skip-image   skip the production image and compose stack
 *   --keep         leave the scratch copy and Docker volumes in place and print the path
 * Exit code 1 when any step fails.
 */

import './lib/test-home.mjs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.join(root, 'templates', 'api-service-go');
const flags = new Set(process.argv.slice(2));
const skipImage = flags.has('--skip-image');
const skipChecks = flags.has('--skip-checks');
const keep = flags.has('--keep');
const PROJECT = 'aico-go-verify';
const IMAGE = `${PROJECT}:test`;

let passed = 0, failed = 0, skipped = 0;
const failures = [];
function check(cond, label, detail) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? `\n${indent(detail)}` : ''}`); }
  return Boolean(cond);
}
function skip(label, why) { skipped++; console.log(`  skip ${label} (${why})`); }
function indent(text) { return String(text).split('\n').map(l => `       ${l}`).join('\n'); }
function tail(text, n = 30) { return String(text).trim().split('\n').slice(-n).join('\n'); }
function section(name) { console.log(`\n-- ${name} --`); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const secret = (bytes) => crypto.randomBytes(bytes).toString('hex');

function run(cmd, args, { cwd, env = {}, timeout = 25 * 60_000 } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ...env },
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

async function http(method, url, { body, headers = {}, timeout = 10_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

// ---------------------------------------------------------------- the copy

/** Directories and files an instantiated app never receives (shared/apps/artifact-dirs.mjs and the template filter). */
const SKIP = new Set(['template.json', '.env', '.env.local', 'bin', 'coverage.out', 'coverage.raw', 'sbom.cdx.json', '.git']);

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (/\.(go|sql|ya?ml|json|md|sh|mjs|toml|mod|sum)$|^(Makefile|Dockerfile|\.[a-z-]+)$/i.test(entry.name) || !entry.name.includes('.')) {
      // Normalise CRLF so a Windows checkout cannot fail the formatter for the wrong reason.
      fs.writeFileSync(dst, fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n'));
    } else fs.copyFileSync(src, dst);
  }
}

function substitute(dir, patterns, tokens) {
  const matches = (rel) => patterns.some(p => {
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
    return re.test(rel.split(path.sep).join('/'));
  });
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!matches(path.relative(dir, p))) continue;
      let text = fs.readFileSync(p, 'utf8');
      for (const [k, v] of Object.entries(tokens)) text = text.split(k).join(v);
      fs.writeFileSync(p, text);
    }
  })(dir);
}

/** `.env.example` -> `.env` the way writeEnvFile does: change-me values get generated secrets. */
function writeEnv(dir, manifest) {
  const generate = manifest.envFile?.generate ?? {};
  const lines = fs.readFileSync(path.join(dir, manifest.envFile?.example ?? '.env.example'), 'utf8').split('\n').map(line => {
    const m = /^([A-Z][A-Z0-9_]*)=(change-me.*)$/.exec(line);
    if (!m) return line;
    const fmt = generate[m[1]] ?? 'hex:24';
    const [kind, n] = fmt.split(':');
    const len = Number(n) || 24;
    return `${m[1]}=${kind === 'password' ? secret(len).slice(0, len) : secret(len)}`;
  });
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n'));
}

// ---------------------------------------------------------------- static checks

function staticChecks() {
  section('manifest and version agreement');
  const validator = run(process.execPath, [path.join(root, 'scripts', 'validate-template.mjs'), source], { timeout: 60_000 });
  check(validator.ok, 'scripts/validate-template.mjs accepts template.json', tail(validator.out));

  const read = (f) => fs.readFileSync(path.join(source, f), 'utf8');
  const makefile = read('Makefile'), dockerfile = read('Dockerfile'), ci = read('.github/workflows/ci.yml');
  const compose = read('compose.yaml'), gomod = read('go.mod');
  const mk = (name) => new RegExp(`^${name}\\s*:=\\s*(\\S+)`, 'm').exec(makefile)?.[1];

  const golangci = mk('GOLANGCI_LINT_VERSION');
  check(dockerfile.includes(`golangci/golangci-lint:${golangci}@sha256:`) && ci.includes(`GOLANGCI_LINT_VERSION: ${golangci}`),
    `golangci-lint ${golangci} is the same in Makefile, Dockerfile and ci.yml`);
  check(dockerfile.includes(`govulncheck@${mk('GOVULNCHECK_VERSION')}`), `govulncheck ${mk('GOVULNCHECK_VERSION')} matches the Dockerfile`);
  check(dockerfile.includes(`cyclonedx-gomod@${mk('CYCLONEDX_VERSION')}`), `cyclonedx-gomod ${mk('CYCLONEDX_VERSION')} matches the Dockerfile`);
  check(dockerfile.includes(`oapi-codegen@${mk('OAPI_CODEGEN_VERSION')}`), `oapi-codegen ${mk('OAPI_CODEGEN_VERSION')} matches the Dockerfile`);
  check(dockerfile.includes(`sqlc/sqlc:${mk('SQLC_VERSION').replace(/^v/, '')}@sha256:`), `sqlc ${mk('SQLC_VERSION')} matches the Dockerfile`);
  const goVer = /^go (\d+\.\d+)/m.exec(gomod)?.[1];
  const goImage = /golang:(\d+\.\d+\.\d+)-bookworm/.exec(dockerfile)?.[1];
  check(goVer && goImage?.startsWith(`${goVer}.`) && ci.includes(`GO_VERSION: "${goImage}"`), `Go ${goImage} (go.mod says ${goVer}) is the same in Dockerfile and ci.yml`);
  check(/postgres:\d+\.\d+-alpine@sha256:/.test(compose) && /postgres:\d+\.\d+-alpine@sha256:/.test(ci), 'PostgreSQL is pinned by version and digest in compose and CI');
  const unpinned = [...ci.matchAll(/uses:\s*([^\s@]+)@([^\s#]+)/g)].filter(m => !/^[0-9a-f]{40}$/.test(m[2]));
  check(unpinned.length === 0, 'every GitHub Action is pinned to a full commit SHA', unpinned.map(m => m[0]).join('\n'));
  const unpinnedImages = [...dockerfile.matchAll(/^(?:FROM|COPY --from=)\s*(\S+)/gm)].map(m => m[1]).filter(i => i.includes('/') || i.includes(':')).filter(i => !i.includes('@sha256:') && !['tools', 'build'].includes(i));
  check(unpinnedImages.length === 0, 'every Dockerfile base image is pinned by digest', unpinnedImages.join('\n'));
}

// ---------------------------------------------------------------- the API flow

async function apiFlow(base, tag) {
  const email = `verify-${secret(4)}@example.com`;
  const password = `pw-${secret(12)}`;
  const health = await http('GET', `${base}/healthz`);
  check(health.status === 200 && health.json?.status === 'ok', `${tag}: /healthz is ok`, health.text);
  const ready = await http('GET', `${base}/readyz`);
  check(ready.status === 200 && ready.json?.status === 'ok', `${tag}: /readyz is ok (database answers)`, ready.text);
  const unauth = await http('GET', `${base}/v1/items`);
  check(unauth.status === 401 && unauth.headers.get('content-type')?.startsWith('application/problem+json') && unauth.headers.get('www-authenticate')?.startsWith('Bearer'),
    `${tag}: no token is a 401 problem+json with WWW-Authenticate`);
  const reg = await http('POST', `${base}/v1/auth/register`, { body: { email, password } });
  check(reg.status === 201 && !reg.text.includes(password) && !reg.text.includes('argon2'), `${tag}: register answers 201 without credentials`, reg.text);
  const dup = await http('POST', `${base}/v1/auth/register`, { body: { email: email.toUpperCase(), password } });
  check(dup.status === 409, `${tag}: a duplicate email (any case) is a 409`, dup.text);
  const wrong = await http('POST', `${base}/v1/auth/login`, { body: { email, password: 'definitely-not-it-1234' } });
  check(wrong.status === 401, `${tag}: a wrong password is a 401`);
  const login = await http('POST', `${base}/v1/auth/login`, { body: { email, password } });
  const token = login.json?.access_token;
  check(login.status === 200 && token && login.json?.token_type === 'Bearer', `${tag}: login gives a bearer token`, login.text);
  const auth = { authorization: `Bearer ${token}` };
  const created = await http('POST', `${base}/v1/items`, { body: { name: 'pen', description: 'blue', quantity: 3 }, headers: auth });
  check(created.status === 201 && created.json?.name === 'pen' && created.headers.get('location') === `/v1/items/${created.json?.id}`, `${tag}: POST /v1/items creates with a Location`, created.text);
  const bad = await http('POST', `${base}/v1/items`, { body: { name: ' ', quantity: -1 }, headers: auth });
  check(bad.status === 422 && bad.json?.errors?.some(e => e.field === 'name') && bad.json?.errors?.some(e => e.field === 'quantity'), `${tag}: a bad body names every field`, bad.text);
  const text = await fetch(`${base}/v1/items`, { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: '{"name":"x"}' });
  check(text.status === 415, `${tag}: a text/plain body is a 415`);
  const list = await http('GET', `${base}/v1/items`, { headers: auth });
  check(list.status === 200 && list.json?.items?.length === 1, `${tag}: GET /v1/items lists it`, list.text);
  const got = await http('GET', `${base}/v1/items/${created.json?.id}`, { headers: auth });
  check(got.status === 200 && got.json?.id === created.json?.id, `${tag}: GET /v1/items/{id}`);
  const put = await http('PUT', `${base}/v1/items/${created.json?.id}`, { body: { name: 'marker', quantity: 1 }, headers: auth });
  check(put.status === 200 && put.json?.name === 'marker', `${tag}: PUT replaces`, put.text);

  // Another user must not see, change or delete it.
  const other = { email: `other-${secret(4)}@example.com`, password: `pw-${secret(12)}` };
  await http('POST', `${base}/v1/auth/register`, { body: other });
  const otherToken = (await http('POST', `${base}/v1/auth/login`, { body: other })).json?.access_token;
  const oh = { authorization: `Bearer ${otherToken}` };
  const peek = await http('GET', `${base}/v1/items/${created.json?.id}`, { headers: oh });
  const steal = await http('PUT', `${base}/v1/items/${created.json?.id}`, { body: { name: 'stolen' }, headers: oh });
  const wipe = await http('DELETE', `${base}/v1/items/${created.json?.id}`, { headers: oh });
  check(peek.status === 404 && steal.status === 404 && wipe.status === 404, `${tag}: another user's item is a 404 for GET, PUT and DELETE`);
  const stillThere = await http('GET', `${base}/v1/items/${created.json?.id}`, { headers: auth });
  check(stillThere.json?.name === 'marker', `${tag}: ...and is untouched`);

  const headers = list.headers;
  check(headers.get('x-content-type-options') === 'nosniff' && headers.get('cache-control') === 'no-store' && headers.get('x-request-id') && !headers.get('server') && !headers.get('x-powered-by'),
    `${tag}: security headers, a request id, no fingerprinting headers`);
  const nf = await http('GET', `${base}/no/such/route`);
  check(nf.status === 404 && nf.headers.get('content-type')?.startsWith('application/problem+json'), `${tag}: an unknown route is a 404 problem+json`);
  const spec = await http('GET', `${base}/openapi.yaml`);
  check(spec.status === 200 && spec.text.startsWith('openapi: 3'), `${tag}: /openapi.yaml is served`);

  const del = await http('DELETE', `${base}/v1/items/${created.json?.id}`, { headers: auth });
  check(del.status === 204, `${tag}: DELETE answers 204`);
  const out = await http('POST', `${base}/v1/auth/logout`, { headers: auth });
  const after = await http('GET', `${base}/v1/auth/me`, { headers: auth });
  check(out.status === 204 && after.status === 401, `${tag}: logout revokes the token`);
  return { leaks: (logs) => [password, token, otherToken, other.password].filter(Boolean).filter(s => logs.includes(s)).length };
}

// ---------------------------------------------------------------- main

let scratch;
let dbPort;
const composeEnv = () => ({ DB_PORT: String(dbPort) });
const compose = (...args) => run('docker', ['compose', '-p', PROJECT, ...args], { cwd: scratch, env: composeEnv(), timeout: 30 * 60_000 });
const tools = (...cmd) => compose('--profile', 'tools', 'run', '--rm', 'tools', ...cmd);

try {
  staticChecks();

  section('docker');
  const dockerProbe = run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 30_000 });
  if (!dockerProbe.ok) { check(false, 'the docker daemon is reachable (every Go command runs in a container)'); throw new Error('no docker'); }
  console.log(`       docker ${dockerProbe.out.trim().split('\n')[0]}`);
  const composeVersion = run('docker', ['compose', 'version', '--short']);
  console.log(`       compose ${composeVersion.out.trim().split('\n')[0]}`);

  section('scratch copy');
  dbPort = await freePort();
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'template.json'), 'utf8'));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-go-verify-'));
  copyTree(source, scratch);
  substitute(scratch, manifest.substitute ?? [], { __APP_TITLE__: 'Verify Service', __APP_SLUG__: 'verify-service', __APP_DESCRIPTION__: 'A verification copy.' });
  fs.writeFileSync(path.join(scratch, '.env'), '');
  writeEnv(scratch, manifest);
  const env = Object.fromEntries(fs.readFileSync(path.join(scratch, '.env'), 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  check(Boolean(env.POSTGRES_PASSWORD) && !/change-me/.test(JSON.stringify(env)), '.env was generated with secrets (no change-me left)');
  const git = (...args) => run('git', ['-c', 'user.name=AICO Agent', '-c', 'user.email=agent@aico.local', ...args], { cwd: scratch, timeout: 60_000 });
  git('init', '-b', 'main');
  git('add', '-A');
  const commit = git('commit', '-m', 'chore: scaffold verify-service (aico template api-service-go)');
  check(commit.ok, 'scaffold commit created (gen-check and tidy-check diff against it)', tail(commit.out));
  console.log(`       ${scratch}`);

  const versions = {};
  if (!skipChecks) {
    section('tools image and checks (docker compose run tools make <verb>)');
    const build = compose('--profile', 'tools', 'build', 'tools');
    if (!check(build.ok, 'the pinned tools image builds (golangci-lint, sqlc, govulncheck, cyclonedx-gomod, oapi-codegen)', tail(build.out))) throw new Error('tools image');
    const up = compose('up', '-d', '--wait', 'db');
    check(up.ok, 'PostgreSQL 18 starts healthy for the integration tests', tail(up.out));
    versions.go = tools('go', 'version').out.match(/go version (go[\d.]+)/)?.[1];
    versions.golangci = tools('golangci-lint', '--version').out.match(/version (v?[\d.]+)/)?.[1];
    versions.govulncheck = tools('govulncheck', '-version').out.match(/Scanner: (govulncheck@v[\d.]+)/)?.[1];
    versions.sqlc = tools('sqlc', 'version').stdout.trim().split('\n').pop();
    versions.postgres = compose('exec', '-T', 'db', 'postgres', '--version').out.trim().split('\n')[0];
    console.log(`       ${JSON.stringify(versions)}`);

    for (const [verb, label] of [
      ['fmt-check', 'formatting (gofumpt, goimports) is clean'],
      ['lint', 'golangci-lint reports no issues (staticcheck, gosec, errcheck, govet, revive, ...)'],
      ['vet', 'go build and go vet pass'],
      ['tidy-check', 'go.mod and go.sum are tidy'],
      ['gen-check', 'generated code (oapi-codegen, sqlc) is current'],
    ]) {
      const r = tools('make', verb);
      check(r.ok, label, tail(r.out));
    }
    const cov = tools('make', 'cov');
    const total = /total:\s+\(statements\)\s+([\d.]+)%/.exec(cov.out)?.[1];
    check(cov.ok && Number(total) >= 85, `tests pass with -race, PostgreSQL and the coverage gate (${total ?? '?'}% >= 85%)`, tail(cov.out, 40));
    if (cov.ok) {
      const counts = cov.out.match(/^ok\s+\S+/gm)?.length ?? 0;
      console.log(`       ${counts} packages ok, total coverage ${total}%`);
      const skippedDb = /TEST_DATABASE_URL not set|--- SKIP/.test(cov.out);
      check(!skippedDb, 'no PostgreSQL integration test was skipped');
    }
    const audit = tools('make', 'audit');
    check(audit.ok && /No vulnerabilities found/.test(audit.out), 'go mod verify and govulncheck: no vulnerabilities found', tail(audit.out));

    // The allow-list gate, with a stub scanner: unlisted fails, listed passes, expired fails.
    const gate = (allow, label, wantOk) => {
      const script = `cd /tmp && printf '%s\\n' ${JSON.stringify(allow)} > allow && ALLOWLIST=/tmp/allow GOVULNCHECK='sh -c "echo GO-2099-0001 reachable; exit 3" --' sh /src/scripts/audit.sh`;
      const r = tools('sh', '-c', script);
      check(r.ok === wantOk, `audit allow-list: ${label}`, tail(r.out, 8));
    };
    gate('# nothing', 'a finding that is not listed fails the audit', false);
    gate('GO-2099-0001 accepted for a test review-by 2099-01-01', 'a listed, unexpired exception passes', true);
    gate('GO-2099-0001 accepted for a test review-by 2000-01-01', 'an expired exception fails', false);
    gate('GO-2099-0001 no date here', 'an exception without a review date fails', false);

    const sbom = tools('make', 'sbom');
    let bom;
    try { bom = JSON.parse(fs.readFileSync(path.join(scratch, 'sbom.cdx.json'), 'utf8')); } catch { /* checked below */ }
    check(sbom.ok && bom?.bomFormat === 'CycloneDX' && (bom.components?.length ?? 0) > 5, `CycloneDX SBOM written (${bom?.specVersion ?? '?'}, ${bom?.components?.length ?? 0} components)`, tail(sbom.out));
    const stamped = tools('sh', '-c', 'make build VERSION=9.9.9-verify COMMIT=abc1234 >/dev/null && ./bin/server version');
    check(stamped.ok && stamped.out.includes('9.9.9-verify') && stamped.out.includes('abc1234'), 'make build stamps the version into the binary (-ldflags)', tail(stamped.out, 5));

    const lock = fs.readFileSync(path.join(scratch, 'go.mod'), 'utf8');
    const direct = [...lock.matchAll(/^\t(\S+) (v\S+)\s*$/gm)].map(m => `${m[1]} ${m[2]}`);
    const resolved = [];
    for (const dep of ['github.com/jackc/pgx/v5', 'github.com/pressly/goose/v3', 'golang.org/x/crypto', 'golang.org/x/time', 'go.opentelemetry.io/otel ', 'github.com/oapi-codegen/runtime', 'github.com/getkin/kin-openapi', 'github.com/google/go-cmp']) {
      const hit = direct.find(d => d.startsWith(dep));
      if (hit) resolved.push(hit);
    }
    console.log(`       resolved: ${resolved.join(', ')}`);
  } else skip('tools image and checks', '--skip-checks');

  if (!skipImage) {
    section('production image');
    const version = '0.0.0-verify';
    const build = run('docker', ['build', '--target', 'runtime', '--build-arg', `VERSION=${version}`, '--build-arg', 'COMMIT=abc1234', '-t', IMAGE, '.'], { cwd: scratch, timeout: 30 * 60_000 });
    if (!check(build.ok, 'the production image builds (CGO off, distroless static)', tail(build.out))) throw new Error('image build');
    const inspect = JSON.parse(run('docker', ['image', 'inspect', IMAGE]).stdout)[0];
    check(inspect.Config.User === 'nonroot:nonroot', `the image runs as a non-root user (${inspect.Config.User})`);
    check(inspect.Config.Healthcheck?.Test?.join(' ').includes('/server healthcheck'), 'the image has a HEALTHCHECK that needs no shell or curl');
    check(JSON.stringify(inspect.Config.Entrypoint) === '["/server"]' && !inspect.Config.Shell, 'the entrypoint is the binary itself (exec form, no shell)');
    console.log(`       ${(inspect.Size / 1048576).toFixed(1)} MiB`);
    const ver = run('docker', ['run', '--rm', IMAGE, 'version']);
    check(ver.ok && ver.out.includes(version) && ver.out.includes('abc1234'), 'the binary reports its stamped version', tail(ver.out, 3));
    const noDb = run('docker', ['run', '--rm', IMAGE]);
    check(!noDb.ok && noDb.status === 2 && /DATABASE_URL: is required/.test(noDb.out), 'fails fast (exit 2) naming the missing DATABASE_URL', tail(noDb.out, 4));
    const badCfg = run('docker', ['run', '--rm', '-e', 'DATABASE_URL=postgres://u:supersecretvalue@h/db', '-e', 'PORT=banana', '-e', 'APP_ENV=staging', IMAGE]);
    check(badCfg.status === 2 && /PORT/.test(badCfg.out) && /APP_ENV/.test(badCfg.out) && !badCfg.out.includes('supersecretvalue'), 'reports every bad setting at once and never echoes the database URL', tail(badCfg.out, 6));

    section('compose stack (PostgreSQL + API) over HTTP');
    const port = await freePort();
    const stackEnv = { PORT: String(port), AUTH_RATE_LIMIT_BURST: '30', AUTH_RATE_LIMIT_PER_MINUTE: '30' };
    const upStack = run('docker', ['compose', '-p', PROJECT, 'up', '-d', '--wait', '--wait-timeout', '180', 'db', 'api'], { cwd: scratch, env: { ...composeEnv(), ...stackEnv }, timeout: 10 * 60_000 });
    if (!check(upStack.ok, 'docker compose up --wait: db and api are healthy', tail(upStack.out))) throw new Error('compose up');
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await http('GET', `${base}/readyz`)).status === 200, 60_000, '/readyz');
    const flow = await apiFlow(base, 'compose');

    const cid = run('docker', ['compose', '-p', PROJECT, 'ps', '-q', 'api'], { cwd: scratch, env: { ...composeEnv(), ...stackEnv } }).stdout.trim();
    const ci = JSON.parse(run('docker', ['inspect', cid]).stdout)[0];
    check(ci.State.Health?.Status === 'healthy', `the container HEALTHCHECK reports healthy (${ci.State.Health?.Status})`);
    check(ci.HostConfig.ReadonlyRootfs === true && ci.HostConfig.CapDrop?.includes('ALL') && ci.HostConfig.SecurityOpt?.includes('no-new-privileges:true'), 'read-only root filesystem, all capabilities dropped, no-new-privileges');
    const logs = run('docker', ['compose', '-p', PROJECT, 'logs', '--no-color', 'api'], { cwd: scratch, env: { ...composeEnv(), ...stackEnv } }).out;
    check(flow.leaks(logs) === 0 && !logs.includes(env.POSTGRES_PASSWORD), 'no password, token or database secret appears in the logs');
    check(/"request_id":"[0-9a-f]{32}"/.test(logs) && /"msg":"request"/.test(logs) && /"msg":"server listening"/.test(logs), 'logs are JSON with request ids and the startup line');
    check(/"msg":"starting"[^\n]*"database":"postgres:\/\/app:xxxxx@db:5432\/app/.test(logs), 'the startup log shows the database URL with the password masked');

    section('seed command and graceful shutdown');
    const seed = run('docker', ['compose', '-p', PROJECT, '--profile', 'tools', 'run', '--rm', 'seed'], { cwd: scratch, env: { ...composeEnv(), ...stackEnv }, timeout: 5 * 60_000 });
    check(seed.ok && /seeded demo account|already exists/.test(seed.out), 'docker compose run seed creates the demo account', tail(seed.out, 6));
    const demo = await http('POST', `${base}/v1/auth/login`, { body: { email: 'demo@example.com', password: env.SEED_PASSWORD } });
    const demoItems = demo.json?.access_token ? await http('GET', `${base}/v1/items`, { headers: { authorization: `Bearer ${demo.json.access_token}` } }) : undefined;
    check(demo.status === 200 && demoItems?.json?.items?.length === 3, 'the seeded account can log in and sees 3 sample items', demo.text);

    const t0 = Date.now();
    const stop = run('docker', ['compose', '-p', PROJECT, 'stop', '-t', '30', 'api'], { cwd: scratch, env: { ...composeEnv(), ...stackEnv }, timeout: 120_000 });
    const exitCode = run('docker', ['inspect', '-f', '{{.State.ExitCode}}', cid]).stdout.trim();
    const stopLogs = run('docker', ['compose', '-p', PROJECT, 'logs', '--no-color', 'api'], { cwd: scratch, env: { ...composeEnv(), ...stackEnv } }).out;
    check(stop.ok && exitCode === '0' && Date.now() - t0 < 15_000 && /"msg":"shutting down"/.test(stopLogs) && /"msg":"server stopped"/.test(stopLogs),
      `SIGTERM triggers a graceful shutdown (exit ${exitCode}, ${Date.now() - t0} ms, logged)`, tail(stopLogs, 6));

    const restart = run('docker', ['compose', '-p', PROJECT, 'up', '-d', '--wait', '--wait-timeout', '120', 'api'], { cwd: scratch, env: { ...composeEnv(), ...stackEnv }, timeout: 5 * 60_000 });
    if (restart.ok) await waitFor(async () => (await http('GET', `${base}/readyz`)).status === 200, 60_000, '/readyz after the restart');
    const again = restart.ok ? await http('POST', `${base}/v1/auth/login`, { body: { email: 'demo@example.com', password: env.SEED_PASSWORD } }) : undefined;
    check(restart.ok && again?.status === 200, 'a restart migrates idempotently and the data survived', tail(restart.out, 6));

    // Brute force is throttled end to end: hammering login must hit a 429 with Retry-After.
    let throttled;
    for (let i = 0; i < 80 && !throttled; i++) {
      const r = await http('POST', `${base}/v1/auth/login`, { body: { email: 'demo@example.com', password: 'wrong-password-value-1' } });
      if (r.status === 429) throttled = r;
    }
    check(throttled?.headers.get('retry-after') && throttled.headers.get('content-type')?.startsWith('application/problem+json'), 'repeated failed logins are throttled with a 429 problem and Retry-After', throttled?.text);

    const smoke = run('sh', ['-c', 'command -v curl >/dev/null && sh scripts/smoke.sh'], { cwd: scratch, env: { PORT: String(await freePort()), COMPOSE_PROJECT_NAME: `${PROJECT}-smoke` }, timeout: 15 * 60_000 });
    if (smoke.error || smoke.status === 127 || smoke.status === null) skip('scripts/smoke.sh (the CI smoke script)', 'sh or curl not available on this machine');
    else check(smoke.ok && /smoke: ok/.test(smoke.out), 'scripts/smoke.sh (as CI runs it) passes', tail(smoke.out, 10));
  } else skip('production image and compose stack', '--skip-image');
} catch (e) {
  if (!['no docker', 'tools image', 'image build', 'compose up'].includes(e.message)) { failed++; failures.push(e.message); console.log(`  FAIL ${e.stack ?? e.message}`); }
} finally {
  section('cleanup');
  if (scratch && !keep) {
    run('docker', ['compose', '-p', PROJECT, '--profile', 'tools', 'down', '-v', '--remove-orphans'], { cwd: scratch, env: composeEnv(), timeout: 120_000 });
    run('docker', ['compose', '-p', `${PROJECT}-smoke`, 'down', '-v', '--remove-orphans'], { cwd: scratch, timeout: 120_000 });
    run('docker', ['image', 'rm', '-f', IMAGE, ...['', '-smoke'].flatMap(s => ['tools', 'api', 'seed'].map(n => `${PROJECT}${s}-${n}`))], { timeout: 60_000 });
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* the bind mount may hold files for a moment */ }
    console.log('  scratch copy and compose project removed');
  } else if (scratch) console.log(`  kept: ${scratch} (project ${PROJECT})`);
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failures.length) console.log(`FAILED:\n${failures.map(f => `  - ${f}`).join('\n')}`);
process.exit(failed ? 1 : 0);
