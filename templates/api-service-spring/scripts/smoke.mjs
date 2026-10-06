// Smoke test of the BUILT container: start the compose stack (this image plus PostgreSQL), then
// walk the real HTTP API from outside, the way a client would, and tear everything down.
// Why Node: one cross-platform script for Windows, macOS, Linux and CI (no make, no bash, no curl).
//
// What it proves that the unit and integration tests cannot: the image starts as a non-root user
// on a read-only filesystem, the production profile boots against a real database, probes answer,
// login works end to end, and the process stops on SIGTERM. Exit 0 = all passed, 1 = a check
// failed, 2 = Docker is not available (not verified).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = `apisvc-smoke-${randomBytes(3).toString('hex')}`;
const win = process.platform === 'win32';

const docker = spawnSync('docker', ['--version'], { stdio: 'ignore', shell: win });
if (docker.status !== 0) {
  console.error('smoke: Docker is not available. NOT verified.');
  process.exit(2);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const port = await freePort();
const dbPort = await freePort();
const dir = mkdtempSync(join(tmpdir(), 'api-smoke-'));
const envFile = join(dir, 'smoke.env');
writeFileSync(
  envFile,
  [
    `PORT=${port}`,
    `DB_PORT=${dbPort}`,
    'DATABASE_USER=app',
    `DATABASE_PASSWORD=${randomBytes(18).toString('hex')}`,
    `APP_JWT_SECRET=${randomBytes(48).toString('base64url')}`,
    '',
  ].join('\n'),
);

function compose(args, opts = {}) {
  return spawnSync('docker', ['compose', '--env-file', envFile, '-p', project, ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    ...opts,
  });
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures += 1;
}

async function call(method, path, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, json, text };
}

let exitCode = 1;
try {
  console.log(`smoke: building and starting ${project} on port ${port} (this builds the image)`);
  const up = compose(['up', '-d', '--build', '--wait', '--wait-timeout', '240'], { stdio: 'inherit' });
  check('compose stack starts healthy', up.status === 0, `exit ${up.status}`);
  if (up.status !== 0) throw new Error('stack did not start');

  const live = await call('GET', '/healthz');
  check('GET /healthz -> 200 UP', live.status === 200 && live.json?.status === 'UP', live.text);
  const ready = await call('GET', '/readyz');
  check('GET /readyz -> 200 UP (database reachable)', ready.status === 200 && ready.json?.status === 'UP', ready.text);

  const anon = await call('GET', '/api/v1/items');
  check('unauthenticated request -> 401 problem+json', anon.status === 401 && anon.json?.code === 'unauthenticated');
  check('security headers present', anon.headers.get('x-content-type-options') === 'nosniff' && !!anon.headers.get('content-security-policy') && !!anon.headers.get('x-request-id'));
  check('no Server header leaked', anon.headers.get('server') === null);

  const email = `smoke-${randomBytes(4).toString('hex')}@example.com`;
  const password = `smoke-${randomBytes(9).toString('hex')}`;
  const reg = await call('POST', '/api/v1/auth/register', { body: { email, password } });
  check('register -> 201', reg.status === 201, reg.text);
  const login = await call('POST', '/api/v1/auth/login', { body: { email, password } });
  check('login -> 200 with a bearer token (snake_case access_token)', login.status === 200 && !!login.json?.access_token && login.json?.token_type === 'Bearer', login.text);
  const token = login.json?.access_token;
  const bad = await call('POST', '/api/v1/auth/login', { body: { email, password: 'definitely wrong password' } });
  check('wrong password -> 401', bad.status === 401 && bad.json?.code === 'invalid_credentials');

  const created = await call('POST', '/api/v1/items', { token, body: { name: 'smoke item' } });
  check('create item -> 201 with quantity and created_at', created.status === 201 && created.json?.name === 'smoke item' && created.json?.quantity === 0 && !!created.json?.created_at, created.text);
  const list = await call('GET', '/api/v1/items', { token });
  check('list items -> 1 item and no next_cursor', list.status === 200 && list.json?.items?.length === 1 && list.json?.next_cursor == null, list.text);
  const invalid = await call('POST', '/api/v1/items', { token, body: { name: '   ' } });
  check('invalid item -> 400 with field errors', invalid.status === 400 && invalid.json?.errors?.[0]?.field === 'name', invalid.text);

  const id = compose(['exec', '-T', 'app', 'id', '-u']);
  check('process runs as non-root (uid 10001)', id.stdout?.trim() === '10001', `got ${id.stdout?.trim()}`);

  const stop = compose(['stop', '--timeout', '30', 'app']);
  const state = spawnSync('docker', ['inspect', '--format', '{{.State.ExitCode}}', `${project}-app-1`], { encoding: 'utf8', shell: false });
  const code = state.stdout?.trim();
  check('SIGTERM stops the app cleanly (exit 0 or 143)', stop.status === 0 && (code === '0' || code === '143'), `exit code ${code}`);

  exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error(`smoke: ${err.message}`);
  const logs = compose(['logs', '--no-color', '--tail', '60']);
  console.error(logs.stdout ?? '');
  exitCode = 1;
} finally {
  compose(['down', '-v', '--remove-orphans'], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
}
console.log(exitCode === 0 ? 'smoke: all checks passed' : `smoke: ${failures} check(s) failed`);
process.exit(exitCode);
