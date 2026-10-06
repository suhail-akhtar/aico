/**
 * Multi-stack apps (ADR 0031), offline and free: the shared artifact list,
 * toolchain probes with injected runners, env-file secret formats, manifest
 * and bundle validation, manifest-driven start (a fake stack that runs on
 * node), the Docker fallback and compose paths against a fake `docker`, bundle
 * planning and native start of two real processes, per-stack checks, the audit
 * parsers, and the per-app git workflow including the human gate on releases.
 *
 * What each block proves is in its title; none of it touches ~/.aico (the
 * store is a temp one, see scripts/lib/test-home.mjs) or the network.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import { testHome } from './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const T = await import('../dist-test/test-exports.js');
const here = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
async function block(title, fn) {
  console.log(`\n══ ${title} ══`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}
const tmp = (label) => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `aico-ms-${label}-`));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20_000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  return undefined;
}

// ──────────────────────────────────────────────────────────────
await block('One artifact list serves every filter', async () => {
  for (const n of ['node_modules', '.venv', '__pycache__', 'target', 'bin', 'obj', 'vendor', '.gradle', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'build']) {
    assert(T.isArtifactName(n), `${n} is an artefact`);
  }
  assert(!T.isArtifactName('src') && !T.isArtifactName('data') && !T.isArtifactName('app'), 'source names are not (data is only legacy-Node, handled per template)');
  assert(!T.isArtifactName('bin', { keep: ['bin'] }), 'keepDirs rescues a legitimate source directory');
  assert(T.isArtifactName('uploads', { extra: ['uploads'] }), 'artifactDirs adds a template-specific one');
  assert(T.hasArtifactSegment('storage/logs/laravel.log') && T.hasArtifactSegment('src/.venv/lib/x.py') && !T.hasArtifactSegment('src/main/java/App.java'), 'path and segment forms');
  // The package filter reads each template's own manifest.
  const root = tmp('pkg');
  write(root, 'py-x/template.json', JSON.stringify({ id: 'py-x', toolchain: { id: 'python' }, keepDirs: ['bin'] }));
  write(root, 'node-x/template.json', JSON.stringify({ id: 'node-x' }));
  const f = T.templatePackageFilter(root);
  assert(f(path.join(root, 'py-x', 'src', 'a.py')) && !f(path.join(root, 'py-x', '.venv', 'x')) && f(path.join(root, 'py-x', 'bin', 'cli')) && f(path.join(root, 'py-x', 'data', 'seed.json')),
    'a Python template keeps bin/ and data/ but never .venv/');
  assert(!f(path.join(root, 'node-x', 'data', 'x')) && !f(path.join(root, 'node-x', 'node_modules', 'x')) && f(path.join(root, 'node-x', 'src', 'i.ts')), 'a Node template keeps its historical data/ drop');
  // The nine shipped templates lose nothing they used to ship.
  const tpl = path.join(path.dirname(here), 'templates');
  const tracked = execFileSync('git', ['ls-files', 'templates'], { cwd: path.dirname(here), encoding: 'utf8' }).split('\n').filter(Boolean);
  const nine = ['agent-service-node', 'api-service-hono', 'cli-node', 'dashboard-next', 'docs-astro', 'landing-static', 'mobile-expo', 'page-records', 'web-saas-next'];
  const pf = T.templatePackageFilter(tpl);
  const lost = tracked.filter(t => nine.some(id => t.startsWith(`templates/${id}/`))).filter(t => !pf(path.join(path.dirname(here), t)));
  assert(lost.length === 0, `no tracked file of the nine templates is dropped by the package filter (${lost.slice(0, 3).join(', ')})`);
});

// ──────────────────────────────────────────────────────────────
await block('Toolchain probes are real, versioned and honest', async () => {
  assert(T.versionSatisfies('>=3.12', '3.14.8') && !T.versionSatisfies('>=3.12', '3.11.9') && T.versionSatisfies('>=3.12 <4', '3.12.0') && !T.versionSatisfies('>=3.12 <4', '4.0.1'), 'comparators and ranges');
  assert(T.versionSatisfies('=3.12', '3.12.7') && !T.versionSatisfies('=3.12', '3.13.0') && T.versionSatisfies(undefined, '1.0.0') && T.versionSatisfies('garbage', '1.0.0'), 'exact line, no range, unreadable range never refuses');
  assert(T.parseVersion('go version go1.27.1 windows/amd64', 'go(\\d+\\.\\d+(?:\\.\\d+)?)') === '1.27.1', 'go version parses');
  // go has no --version; java prints on stderr with a single dash.
  const seen = [];
  const runner = (cmd, args) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'go' && args[0] === 'version') return { status: 0, stdout: 'go version go1.27.1 linux/amd64\n', stderr: '' };
    if (cmd === 'java' && args[0] === '-version') return { status: 0, stdout: '', stderr: 'openjdk version "25.0.4" 2026-07-21 LTS\n' };
    if (cmd === 'python') return { status: 9009, stdout: '', stderr: 'Python was not found' }; // the Windows Store stub
    if (cmd === 'py' && args[0] === '-3') return { status: 0, stdout: 'Python 3.14.8\n', stderr: '' };
    if (cmd === 'docker') return { status: 0, stdout: 'Docker version 29.7.2, build x\n', stderr: '' };
    return { status: 127, stdout: '', stderr: 'not found' };
  };
  const go = T.probeTool({ id: 'go' }, runner);
  assert(go.found && go.version === '1.27.1' && seen.includes('go version') && !seen.includes('go --version'), 'go is probed with `go version`, never `--version`');
  const java = T.probeTool({ id: 'java' }, runner);
  assert(java.found && java.version === '25.0.4', 'java reads its version from stderr');
  const py = T.probeTool({ id: 'python' }, runner);
  assert(py.found && py.version === '3.14.8' && py.command === 'py -3', 'a broken `python` stub falls through to `py -3`');
  assert(T.aliasCommand('python -m uvicorn app:app', [py]) === 'py -3 -m uvicorn app:app' && T.aliasCommand('uv run pytest', [py]) === 'uv run pytest', 'a `python …` command is rewritten to the one that answered, nothing else');
  const missing = T.checkRequirements({ toolchain: { id: 'php', version: '>=8.3' } }, runner);
  assert(!missing.ok && missing.problems[0].kind === 'missing' && /php 8\.3\+ was not found/.test(missing.message) && /php\.net/.test(missing.message), 'a missing toolchain names itself and where to get it');
  assert(missing.dockerAvailable && /docker: true/.test(missing.message), 'and, with Docker present, offers the container (never takes it)');
  const old = T.checkRequirements({ toolchain: { id: 'go', version: '>=1.30' } }, runner);
  assert(!old.ok && old.problems[0].kind === 'too-old' && old.problems[0].found === '1.27.1' && /1\.27\.1 is installed but 1\.30\+ is required/.test(old.message), 'too old says which version it found');
  const ok = T.checkRequirements({ toolchain: { id: 'java', version: '>=21', tools: [{ id: 'docker', optional: true }, { id: 'mvn', optional: true }] } }, runner);
  assert(ok.ok && ok.message === '', 'optional tools never create problems');
  assert(T.validateProbe({ command: 'go', args: ['version'], parse: 'go(\\d+)' }).length === 0, 'a plain probe validates');
  assert(T.validateProbe({ command: 'go; rm -rf /', args: [], parse: 'x' }).length > 0 && T.validateProbe({ command: 'go', args: ['$(x)'], parse: 'x' }).length > 0 && T.validateProbe({ command: 'go', args: [], parse: '(' }).length > 0, 'a probe with shell characters or a bad regex is rejected');
  assert(T.DEFAULT_DOCKER_IMAGES.python === 'python:3.14-slim' && T.DEFAULT_DOCKER_IMAGES.java.includes('eclipse-temurin-25') && /^mcr\.microsoft\.com\/dotnet\/sdk:10/.test(T.DEFAULT_DOCKER_IMAGES.dotnet), 'pinned default images per toolchain');
  assert(T.toolAvailable('node') === true && T.toolAvailable('definitely-not-a-tool-xyz') === false, 'toolAvailable uses the probes (real node answers, a made-up tool does not)');
});

// ──────────────────────────────────────────────────────────────
await block('Env files: the right file, the right secret formats, never committed', async () => {
  const g = (f) => T.generateSecret(f).value;
  assert(/^[0-9a-f]{48}$/.test(g('hex')) && /^[0-9a-f]{64}$/.test(g('hex:32')), 'hex default 24 bytes, hex:32 is 64 chars');
  assert(/^base64:[A-Za-z0-9+/]{43}=$/.test(g('laravel-app-key')), 'laravel-app-key is base64: + 32 random bytes');
  assert(Buffer.from(g('laravel-app-key').slice(7), 'base64').length === 32, 'which decodes to 32 bytes');
  assert(/^[A-Za-z0-9_-]{86}$/.test(g('jwt-secret')), 'jwt-secret is 64 random bytes base64url');
  assert(/^[A-Za-z0-9]{24}$/.test(g('password')) && /^[A-Za-z0-9]{12}$/.test(g('password:12')), 'password is alphanumeric');
  assert(/^[0-9a-f-]{36}$/.test(g('uuid')), 'uuid');
  assert(g('hex') !== g('hex'), 'values are random');
  let threw = false; try { T.generateSecret('rot13'); } catch { threw = true; }
  assert(threw, 'an unknown format throws rather than producing an empty secret');
  threw = false; try { T.generateSecret('path:../outside'); } catch { threw = true; }
  assert(threw, 'path: refuses traversal');

  const dir = tmp('env');
  write(dir, '.env.example', 'APP_NAME=Demo\nAPP_KEY=\nSESSION_SECRET=change-me-please\nDATABASE_URL=sqlite:///x.db\nDATA_PROTECTION_KEYS=\n');
  const r = await T.writeAppEnv(dir, { file: '.env', generate: { APP_KEY: 'laravel-app-key', DATA_PROTECTION_KEYS: 'aspnet-dp-key-path', JWT_SECRET: 'jwt-secret' } });
  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert(r.file.endsWith('.env') && !fs.existsSync(path.join(dir, '.env.local')), 'written to the declared file (.env), not .env.local');
  assert(/^APP_KEY=base64:/m.test(env) && /^SESSION_SECRET=[0-9a-f]{48}$/m.test(env) && /^DATA_PROTECTION_KEYS=\.aspnet\/keys$/m.test(env), 'listed keys use their format; unlisted change-me falls back to hex:24');
  assert(/^JWT_SECRET=/m.test(env), 'a listed key missing from the example is appended');
  assert(/^APP_NAME=Demo$/m.test(env) && /^DATABASE_URL=sqlite/m.test(env), 'other lines are untouched');
  assert(fs.existsSync(path.join(dir, '.aspnet', 'keys')), 'the ASP.NET key directory is created');
  assert(r.generated.includes('APP_KEY') && !JSON.stringify(r).includes('base64:'), 'only key NAMES are returned, never values');
  assert(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').includes('.env'), 'the env file is gitignored before anything can commit it');
  assert(await T.writeAppEnv(dir, { file: '.env' }) === undefined, 'an existing env file is never overwritten');
  // The nine Node templates' behaviour: .env.local, hex.
  const nodeDir = tmp('envnode');
  write(nodeDir, '.env.example', 'SESSION_SECRET=change-me\nPORT=3000\n');
  await T.writeLocalEnv(nodeDir);
  assert(/^SESSION_SECRET=[0-9a-f]{48}$/m.test(fs.readFileSync(path.join(nodeDir, '.env.local'), 'utf8')), 'default stays .env.local with 24 random bytes as hex');
});

// ──────────────────────────────────────────────────────────────
await block('Manifest validation says what is wrong', async () => {
  const base = { id: 'py-api', version: '1.0.0', name: 'Py', category: 'api', kind: 'process', summary: 's' };
  const good = {
    ...base, toolchain: { id: 'python', version: '>=3.12', tools: [{ id: 'uv', version: '>=0.5' }] }, manifestFile: 'pyproject.toml',
    envFile: { file: '.env', generate: { SECRET_KEY: 'hex:32' } }, docker: { image: 'python:3.14-slim', containerPort: 8000, cache: ['/root/.cache/uv'] },
    run: { dev: 'uv run uvicorn app.main:app --port {port}', test: 'uv run pytest -q', installedMarker: '.venv', health: '/healthz', portEnv: 'PORT', env: { APP_ENV: 'development' }, win32: { dev: 'x' } },
    verify: { env: { A: 'b' }, skip: ['audit'] },
  };
  assert(T.validateManifest(good).length === 0, `a complete Python manifest validates (${T.validateManifest(good).join('; ')})`);
  const bad = (patch) => T.validateManifest({ ...good, ...patch });
  assert(bad({ toolchain: { id: 'cobol' } }).some(m => /toolchain\.id/.test(m)), 'unknown toolchain id');
  assert(bad({ manifestFile: undefined }).some(m => /manifestFile/.test(m)), 'a non-node template must declare manifestFile');
  assert(bad({ run: { ...good.run, dev: 'cd app && uvicorn x' } }).some(m => /chains commands/.test(m)), 'a shell chain in a command is named');
  assert(bad({ run: { ...good.run, health: 'healthz' } }).some(m => /health/.test(m)), 'health must be a path');
  assert(bad({ run: { ...good.run, installedMarker: '../x' } }).some(m => /installedMarker/.test(m)), 'installedMarker cannot leave the app');
  assert(bad({ envFile: { file: '.env.example' } }).some(m => /envFile\.file/.test(m)), 'envFile cannot be the example');
  assert(bad({ envFile: { file: '.env', generate: { A: 'rot13' } } }).some(m => /unknown format/.test(m)), 'unknown secret format');
  assert(bad({ docker: { image: '--privileged' } }).some(m => /image/.test(m)) && bad({ docker: { image: 'x', cache: ['rel/path'] } }).some(m => /cache/.test(m)), 'docker image and cache paths are checked');
  assert(bad({ toolchain: { id: 'python', probe: { command: 'x;y', args: [], parse: '.' } } }).some(m => /probe/.test(m)), 'a probe with shell characters');
  const bundle = {
    id: 'saas-bundle', version: '1.0.0', name: 'B', category: 'bundle', kind: 'bundle', summary: 's',
    services: [
      { id: 'api', role: 'api', path: 'services/api', port: 8000, healthPath: '/healthz' },
      { id: 'web', role: 'frontend', template: 'web-saas-next', port: 3000, dependsOn: ['api'], env: { API_URL: '{service.api.url}' } },
      { id: 'db', role: 'db' },
    ],
    preview: 'web', compose: { file: 'compose.yaml', generate: true },
  };
  assert(T.validateManifest(bundle).length === 0, `a bundle validates (${T.validateManifest(bundle).join('; ')})`);
  const badB = (services, extra = {}) => T.validateManifest({ ...bundle, services, ...extra });
  assert(badB([bundle.services[0]]).some(m => /at least two/.test(m)), 'a bundle needs two services');
  assert(badB([{ ...bundle.services[0], dependsOn: ['web'] }, { ...bundle.services[1], dependsOn: ['api'] }]).some(m => /loop/.test(m)), 'a dependency loop is named');
  assert(badB([{ ...bundle.services[0], dependsOn: ['ghost'] }, bundle.services[1]]).some(m => /unknown service "ghost"/.test(m)), 'an unknown dependency is named');
  assert(badB(bundle.services, { preview: 'nope' }).some(m => /preview/.test(m)), 'preview must be a service');
  assert(badB([...bundle.services.slice(0, 2), { id: 'cache2', role: 'cache', compose: { volumes: ['/host/path:/data'] } }]).some(m => /named volumes/.test(m)), 'a bind mount in compose hints is refused');
  assert(badB([bundle.services[0], { id: 'x', role: 'frontend' }]).some(m => /needs a template or a path/.test(m)), 'a code role with no source is refused');
  assert(T.validateManifest({ ...base, services: [] }).some(m => /kind "bundle"/.test(m)), 'services belong to bundles');
  assert(T.dependencyOrder([{ id: 'web', dependsOn: ['api'] }, { id: 'api' }, { id: 'db' }]).map(s => s.id).join(',') === 'api,web,db', 'dependency order puts needs first, keeps declaration order otherwise');
});

// ──────────────────────────────────────────────────────────────
await block('A process app starts from its manifest, not from package.json', async () => {
  const dir = tmp('stack');
  write(dir, 'server.mjs', `import http from 'node:http';
const port = Number(process.env.APP_PORT);
http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ port, env: process.env.APP_ENV ?? null, nodeEnv: process.env.NODE_ENV ?? null, leaked: process.env.OPENAI_API_KEY ?? null })); }).listen(port, '127.0.0.1');
`);
  write(dir, 'install.mjs', `import fs from 'node:fs'; fs.appendFileSync('installs.txt', 'x'); fs.mkdirSync('.installed', { recursive: true });`);
  const app = {
    kind: 'process',
    stack: { toolchain: { id: 'node', version: '>=18' }, manifestFile: 'app.manifest' },
    run: { install: 'node install.mjs', installedMarker: '.installed', dev: 'node server.mjs', portEnv: 'APP_PORT', health: '/healthz', env: { APP_ENV: 'development' } },
  };
  // Not scaffolded: the declared manifest file is named.
  const early = await T.startApp('ms-stack', dir, app);
  assert(early.state === 'failed' && /app\.manifest/.test(early.error) && !/package\.json/.test(early.error), `a missing manifest file is named (${early.error})`);
  await T.stopApp('ms-stack');
  write(dir, 'app.manifest', 'x');
  process.env.OPENAI_API_KEY = 'sk-should-not-leak'; // standards-allow: secret (obviously fake test canary)
  await T.startApp('ms-stack', dir, app);
  const rec = await until(() => { const r = T.appState('ms-stack'); return r && (r.state === 'running' || r.state === 'failed') ? r : undefined; });
  assert(rec?.state === 'running' && /^http:\/\/127\.0\.0\.1:\d+$/.test(rec.url), `running via the HTTP health poll alone, no ready line (${rec?.state} ${rec?.error ?? ''})`);
  assert(fs.readFileSync(path.join(dir, 'installs.txt'), 'utf8') === 'x', 'install ran once');
  const body = await (await fetch(`${rec.url}/anything`)).json();
  assert(body.port === rec.port && body.env === 'development', 'the port arrived on the declared portEnv and run.env reached the process');
  assert(body.leaked === null, 'the scrubbed environment still applies');
  delete process.env.OPENAI_API_KEY;
  await T.stopApp('ms-stack');
  await T.startApp('ms-stack', dir, app);
  await until(() => T.appState('ms-stack')?.state === 'running');
  assert(fs.readFileSync(path.join(dir, 'installs.txt'), 'utf8') === 'x', 'a second start skips install because installedMarker exists');
  await T.stopApp('ms-stack');

  // A toolchain that is not here: the refusal says what to install, and starts nothing.
  const goApp = { ...app, stack: { toolchain: { id: 'go', version: '>=99.0' }, manifestFile: 'app.manifest' } };
  const refused = await T.startApp('ms-go', dir, goApp);
  assert(refused.state === 'failed' && /go/i.test(refused.error) && /(install|Install)/.test(refused.error), `a missing or too-old toolchain is a plain "install it" (${refused.error})`);
  await T.stopApp('ms-go');
  // `built` follows the stack's manifest file, for any stack.
  const ws = tmp('built');
  const made = await T.createMiniApp({ title: 'Go Thing', kind: 'process', stack: { manifestFile: 'go.mod' } }, { workspace: { path: ws } }, ws);
  assert(made.built === false, 'not built before the manifest file exists');
  write(path.join(ws, 'miniapps', made.slug), 'go.mod', 'module x');
  assert((await T.getMiniApp(made.slug, { workspace: { path: ws } }, ws)).built === true, 'built once go.mod exists, with no package.json anywhere');
  const custom = await T.createMiniApp({ title: 'Custom Py', kind: 'process' }, { workspace: { path: ws } }, ws);
  write(path.join(ws, 'miniapps', custom.slug), 'pyproject.toml', '[project]\nname="x"');
  assert((await T.getMiniApp(custom.slug, { workspace: { path: ws } }, ws)).built === true, 'a custom app with any known project manifest reads as built');
  // Defaults: a declared non-Node stack must not inherit `npm install`.
  const py = T.runProfileFor({ kind: 'process', run: { dev: 'x' }, stack: { toolchain: { id: 'python' } } });
  assert(py.install === undefined && !!py.ready, 'a Python stack gets no npm install default');
  assert(T.runProfileFor({ kind: 'process', run: { dev: 'x' } }).install === 'npm install --no-audit --no-fund', 'an app with no stack keeps the npm default (the nine templates)');
  assert(T.applyPlatform({ dev: './mvnw run', win32: { dev: 'mvnw run' } }, 'win32').dev === 'mvnw run' && T.applyPlatform({ dev: './mvnw run', win32: { dev: 'mvnw run' } }, 'linux').dev === './mvnw run', 'win32 overrides apply on Windows only');
});

// ──────────────────────────────────────────────────────────────
await block('The Docker fallback is the same surface, in a constrained container', async () => {
  const plan = T.dockerRunPlan({ slug: 'demo', dir: '/home/u/app', image: 'python:3.14-slim', command: 'uvicorn app:app --port 8000', setup: 'pip install -e .', env: { APP_ENV: 'development' }, port: { host: 7341, container: 8000 }, cache: ['/root/.cache/pip'], name: 'aico-demo-abc' });
  const joined = plan.args.join(' ');
  assert(plan.args.includes('-v') && plan.args[plan.args.indexOf('-v') + 1] === '/home/u/app:/work', 'the only bind mount is the engine-computed app directory');
  assert(plan.args[plan.args.indexOf('-p') + 1] === '127.0.0.1:7341:8000', 'the port is published on loopback only');
  assert(!/--privileged|--network|docker\.sock|--cap-add|--pid|--device/.test(joined), 'no privileged flags of any kind');
  assert(plan.args.at(-3) === 'sh' && plan.args.at(-2) === '-c' && plan.args.at(-1) === 'pip install -e . && uvicorn app:app --port 8000', 'setup and command run through sh -c in the container');
  assert(plan.args.includes('--rm') && plan.args.includes('--init'), 'removed on exit, with an init process');
  assert(plan.args.some(a => /^aico-demo-[0-9a-f]{8}:\/root\/\.cache\/pip$/.test(a)), 'dependency caches are named volumes');
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  assert(throws(() => T.dockerRunPlan({ slug: 'd', dir: '/a', image: '--privileged', command: 'x' })), 'a flag-shaped image is refused');
  assert(throws(() => T.dockerRunPlan({ slug: 'd', dir: '/a', image: 'x', command: 'x', env: { 'A B': '1' } })), 'a bad env name is refused');
  assert(throws(() => T.dockerRunPlan({ slug: 'd', dir: '/a', image: 'x', command: 'x', cache: ['rel'] })), 'a relative cache path is refused');
  assert(T.isValidImage('mcr.microsoft.com/dotnet/sdk:10.0') && T.isValidImage('golang:1.27.1-bookworm@sha256:abc') && !T.isValidImage('a b'), 'image references');

  // Through the fake docker.
  const log = path.join(tmp('dockerlog'), 'docker.log');
  process.env.FAKE_DOCKER_LOG = log;
  T.setDockerCommandForTests({ file: process.execPath, prefix: [path.join(here, 'fixtures', 'fake-docker.mjs')] });
  const dir = tmp('dockerapp');
  write(dir, 'pyproject.toml', '[project]\nname="x"\n');
  const app = { kind: 'process', stack: { toolchain: { id: 'python', version: '>=3.12' }, manifestFile: 'pyproject.toml', docker: { image: 'python:3.14-slim', containerPort: 8000, dev: 'uvicorn app:app --host 0.0.0.0 --port 8000' } }, run: { dev: 'uvicorn app:app --port {port}', health: '/healthz' } };
  await T.startApp('ms-docker', dir, app, { docker: true });
  const rec = await until(() => { const r = T.appState('ms-docker'); return r && (r.state === 'running' || r.state === 'failed') ? r : undefined; });
  assert(rec?.state === 'running' && rec.mode === 'docker', `starts in a container and reports it (${rec?.state} ${rec?.error ?? ''})`);
  const runLine = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(a => a[0] === 'run');
  assert(runLine && runLine.includes('python:3.14-slim') && runLine.some(a => /^127\.0\.0\.1:\d+:8000$/.test(a)), 'the recorded docker run uses the declared image and a loopback port mapping');
  await T.stopApp('ms-docker');
  assert(fs.readFileSync(log, 'utf8').split('\n').some(l => l.includes('"rm","-f"') && l.includes('aico-')), 'stopping removes the container by name');
  // docker: true without an image anywhere is a refusal, not a guess.
  const none = await T.startApp('ms-docker2', dir, { kind: 'process', run: { dev: 'x' } }, { docker: true });
  assert(none.state === 'failed' && /no container image/.test(none.error), 'no toolchain, no image: refused');
  await T.stopApp('ms-docker2');
  T.setDockerCommandForTests(undefined);
});

// ──────────────────────────────────────────────────────────────
await block('Checks and labels for stacks that have no template', async () => {
  const mk = (files) => { const d = tmp('chk'); for (const [k, v] of Object.entries(files)) write(d, k, v); return d; };
  const names = (cs) => cs.map(c => `${c.name}:${c.command}`).join(' | ');
  const mvn = mk({ 'pom.xml': '<project><groupId>g</groupId><artifactId>a</artifactId><version>1.2.3</version><parent></parent><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>', mvnw: '#!/bin/sh', 'mvnw.cmd': '@echo' });
  assert(names(T.detectStackChecks(mvn, 'linux')).includes('build:./mvnw -B -ntp -q compile') && names(T.detectStackChecks(mvn, 'linux')).includes('test:./mvnw -B -ntp test'), 'Maven uses the wrapper on POSIX');
  assert(names(T.detectStackChecks(mvn, 'win32')).includes('test:mvnw -B -ntp test'), 'and without ./ on Windows');
  assert(T.detectStackLabel(mvn).stack === 'Java / Spring Boot (Maven)', 'label names Spring Boot');
  const mvnNoWrap = mk({ 'pom.xml': '<project/>' });
  assert(names(T.detectStackChecks(mvnNoWrap, 'linux')).includes('test:mvn -B -ntp test'), 'no wrapper: global mvn');
  const gradle = mk({ 'build.gradle.kts': 'plugins { id("org.springframework.boot") version "4.1.1" }', gradlew: '#!/bin/sh' });
  assert(names(T.detectStackChecks(gradle, 'linux')).includes('test:./gradlew --console=plain test') && T.detectStackLabel(gradle).stack === 'Java / Spring Boot (Gradle)', 'Gradle wrapper and label');
  const dotnet = mk({ 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' });
  assert(names(T.detectStackChecks(dotnet)).includes('build:dotnet build --nologo -v q') && names(T.detectStackChecks(dotnet)).includes('test:dotnet test --nologo') && T.detectStackLabel(dotnet).stack === 'C# / ASP.NET Core', '.NET build, test and label');
  const php = mk({ 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^13' }, scripts: { test: 'pest', lint: 'pint --test', analyse: 'phpstan analyse' } }) });
  assert(names(T.detectStackChecks(php)) === 'typecheck:composer analyse | lint:composer lint | test:composer test' && T.detectStackLabel(php).stack === 'PHP / Laravel', 'PHP uses the project\'s own composer scripts');
  const py = mk({ 'pyproject.toml': '[project]\nname="x"\ndependencies=["fastapi"]\n[tool.ruff]\nline-length=100\n[tool.mypy]\nstrict=true\n', 'uv.lock': '' });
  write(py, 'tests/test_a.py', 'def test_a(): pass');
  assert(names(T.detectChecks(py)) === 'typecheck:uv run mypy . | lint:uv run ruff check . | test:uv run pytest -q', `Python with uv: runner prefix, ruff and mypy only because configured (${names(T.detectChecks(py))})`);
  const pyPlain = mk({ 'pyproject.toml': '[project]\nname="x"\n', 'tests/test_a.py': '' });
  assert(names(T.detectChecks(pyPlain)) === 'test:pytest -q', 'an unconfigured Python project keeps the plain pytest (no unconfigured mypy to block every turn)');
  const go = mk({ 'go.mod': 'module x\ngo 1.27\nrequire github.com/gin-gonic/gin v1.10.0' });
  assert(names(T.detectChecks(go)) === 'typecheck:go vet ./... | build:go build ./... | test:go test ./...', `Go gains go vet (${names(T.detectChecks(go))})`);
  assert(T.detectChecksFor([path.join(mvn, 'src', 'A.java')], mvn)[0].root === path.resolve(mvn), 'a Java file resolves to the Maven project root');
  assert(T.detectStyleTools(php).length === 0 && T.detectStyleTools(mk({ 'composer.json': '{"require-dev":{"laravel/pint":"^1"}}' })).some(t => t.tool === 'pint'), 'Pint is offered only when the project has it');
  assert(T.detectStyleTools(mk({ 'pom.xml': '<project><build><plugins><plugin><artifactId>spotless-maven-plugin</artifactId></plugin></plugins></build></project>' })).some(t => t.tool === 'spotless'), 'Spotless for Maven');

  // Container checks: only when the toolchain is missing and Docker answers.
  const log = path.join(tmp('chkdocker'), 'd.log');
  process.env.FAKE_DOCKER_LOG = log;
  T.setDockerCommandForTests({ file: process.execPath, prefix: [path.join(here, 'fixtures', 'fake-docker.mjs')] });
  const app = mk({ 'app.json': JSON.stringify({ slug: 'x', stack: { toolchain: { id: 'go', version: '>=99.0' }, docker: { image: 'golang:1.27.1-bookworm' } }, run: { install: 'go mod download' } }) });
  const wrapped = T.containerizeChecks(app, [{ name: 'test', command: 'go test ./...', weight: 4 }]);
  assert(/docker|node/.test(wrapped[0].command) && wrapped[0].command.includes('golang:1.27.1-bookworm') && wrapped[0].command.includes('go mod download && go test ./...') && !wrapped[0].command.includes('--name'), 'a missing toolchain with Docker present wraps the check in a one-shot container that installs first');
  const plainApp = mk({ 'app.json': JSON.stringify({ slug: 'y' }) });
  assert(T.containerizeChecks(plainApp, [{ name: 'test', command: 'npm test', weight: 4 }])[0].command === 'npm test', 'an app with no declared toolchain is left alone');
  const nodeStack = mk({ 'app.json': JSON.stringify({ slug: 'z', stack: { toolchain: { id: 'node', version: '>=18' } } }) });
  assert(T.containerizeChecks(nodeStack, [{ name: 'test', command: 'npm test', weight: 4 }])[0].command === 'npm test', 'a present toolchain runs natively');
  T.setDockerCommandForTests(undefined);
});

// ──────────────────────────────────────────────────────────────
await block('Audit: Composer, OSV for Maven/Gradle, and honesty when the scanner is absent', async () => {
  const composer = T.parseComposerAudit({ advisories: { 'vendor/pkg': [{ advisoryId: 'PKSA-1', packageName: 'vendor/pkg', affectedVersions: '>=1.0,<1.4.2', title: 'XSS', cve: 'CVE-2026-1111', link: 'https://x/GHSA-abcd-efgh-ijkl', severity: 'high' }] }, abandoned: {} });
  assert(composer.advisories.length === 1 && composer.advisories[0].severity === 'high' && composer.advisories[0].fix === '>=1.4.2' && composer.counts.high === 1, 'composer audit JSON is read with its fix version');
  assert(T.parseComposerAudit({ advisories: [] }).advisories.length === 0, 'an empty composer report is clean');
  const osv = T.parseOsvScanner({ results: [{ packages: [{ package: { name: 'org.apache.logging.log4j:log4j-core', version: '2.14.0', ecosystem: 'Maven' }, groups: [{ ids: ['GHSA-jfh8-c2jp-5v3q'], max_severity: '10.0' }], vulnerabilities: [{ id: 'GHSA-jfh8-c2jp-5v3q', summary: 'Log4Shell', affected: [{ ranges: [{ events: [{ introduced: '2.0' }, { fixed: '2.15.0' }] }] }] }] }] }] });
  assert(osv.advisories[0].severity === 'critical' && osv.advisories[0].fix === '>=2.15.0' && osv.counts.critical === 1, 'osv-scanner JSON: CVSS band and fix');
  const dir = tmp('mvnaudit');
  write(dir, 'pom.xml', '<project/>');
  write(dir, 'composer.json', '{}');
  assert(['maven', 'composer'].every(e => T.detectEcosystems(dir).includes(e)), 'detectEcosystems sees Maven and Composer');
  const savedPath = process.env.PATH;
  process.env.PATH = path.dirname(process.execPath); // only node: no osv-scanner, no composer
  const a = await T.auditOne('maven', dir);
  const c = await T.auditOne('composer', dir);
  process.env.PATH = savedPath;
  assert(a.status === 'missing' && /NOT audited/.test(a.message) && /osv-scanner/.test(a.message), `Maven without a scanner says it was NOT audited (${a.status}: ${a.message})`);
  assert(c.status === 'skipped' && /composer\.lock/.test(c.message), 'Composer without a lock file says why it did not run');
  write(dir, 'composer.lock', '{}');
  process.env.PATH = path.dirname(process.execPath);
  const c2 = await T.auditOne('composer', dir);
  process.env.PATH = savedPath;
  assert(c2.status === 'missing' && /Composer/.test(c2.message), 'Composer missing is a note with the install link, not a pass');
  // The security check says so aloud about languages it has no rules for.
  const proj = tmp('sec');
  write(proj, 'src/App.java', 'public class App { }');
  const sec = await T.securityCheck(proj, ['src/App.java'], { external: false });
  assert(sec.passed && /no code rules for those languages/.test(sec.output), 'a clean Java pass is labelled as having no code rules');
});

// ──────────────────────────────────────────────────────────────
await block('Bundles: ordering, wiring, compose text, native start of real processes', async () => {
  const services = [
    { id: 'web', role: 'frontend', path: 'services/web', port: 3000, dependsOn: ['api'], env: { API_URL: '{service.api.url}', PUBLIC: '{service.api.host}:{service.api.port}' }, run: { dev: 'node web.mjs', health: '/healthz', installedMarker: '.' }, stack: { toolchain: { id: 'node', version: '>=18' } } },
    { id: 'api', role: 'api', path: 'services/api', port: 8000, dependsOn: ['db'], env: { DATABASE_URL: 'postgres://app:{secret.db}@db:5432/app', SELF: '{port}' }, run: { dev: 'node api.mjs', ready: 'listening on', health: '/healthz', installedMarker: '.' }, stack: { toolchain: { id: 'node', version: '>=18' } } },
    { id: 'db', role: 'db' },
  ];
  const app = { slug: 'shop', kind: 'bundle', services, preview: 'web', compose: { file: 'compose.yaml', generate: true } };
  const plan = T.planNative({ slug: 'shop', services, preview: 'web' }, (id) => ({ web: 4001, api: 4002 }[id]));
  assert(plan.steps.map(s => s.service.id).join(',') === 'api,web' && plan.skipped.length === 1 && plan.skipped[0].id === 'db', 'native plan: dependencies first, the bare image is reported as skipped');
  assert(plan.steps[1].env.API_URL === 'http://127.0.0.1:4002' && plan.steps[1].env.PUBLIC === '127.0.0.1:4002' && plan.steps[0].env.SELF === '4002', 'wiring resolves {service.x.url|host|port} and {port}');
  assert(T.nativeBlockers({ slug: 's', services }).some(b => /api depends on db/.test(b)), 'native start is blocked when code depends on a container-only service');

  const rc = T.renderCompose({ slug: 'shop', services, preview: 'web' });
  const text = rc.compose;
  assert(/postgres:18-alpine/.test(text) && /traefik:v3\.7/.test(text) && !/redis|minio|latest/.test(text), 'pinned images from the research table; no Redis, MinIO or :latest');
  assert(rc.proxy && rc.files['deploy/traefik/dynamic.yml'].includes('PathPrefix(`/api`)') && !text.includes('docker.sock'), 'single origin through Traefik from files, never the Docker socket');
  assert(/no-new-privileges/.test(text) && /cap_drop/.test(text) && /127\.0\.0\.1:\$\{AICO_PREVIEW_PORT:-8080\}:80/.test(text), 'dropped capabilities, one published port on loopback');
  assert(!/\n\s+- \/|\.\/\.\.|:\/var\/run/.test(text.replace(/\.\/deploy\/traefik:\/etc\/traefik:ro/, '')) && /pgdata:\/var\/lib\/postgresql\/data/.test(text), 'named volumes only (the one bind is the read-only Traefik config)');
  assert(/\$\{DB_PASSWORD:\?/.test(text) && !/hunter|password123/i.test(text) && rc.secretKeys.join() === 'DB_PASSWORD' && (text.match(/\$\{DB_PASSWORD:\?/g) ?? []).length === 2, 'secrets are interpolations, never values, and the API and the database share the one');
  assert(/http:\/\/api:8000/.test(text), 'compose wiring uses service DNS names');
  let threw = false;
  try { T.renderCompose({ slug: 's', services: [{ id: 'db', role: 'db', compose: { volumes: ['/etc:/data'] } }, { id: 'a', role: 'api', path: 'a' }] }); } catch { threw = true; }
  assert(threw, 'a bind-mount volume is refused at render time too');
  const dir = tmp('compose');
  const w = await T.writeGeneratedCompose(app, dir);
  assert(w.wrote && fs.existsSync(path.join(dir, 'compose.yaml')) && fs.existsSync(path.join(dir, 'deploy', 'traefik', 'traefik.yml')), 'the generator writes compose.yaml and the proxy config');
  const envText = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert(/^DB_PASSWORD=[0-9a-f]{48}$/m.test(envText) && fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('.env'), 'the secrets it interpolates are generated into a gitignored .env');
  assert((await T.writeGeneratedCompose(app, dir)).wrote === false, 'an existing compose file is never regenerated');
  assert(T.toYaml({ a: { b: ['x', 'y'], c: 1, d: true }, e: [] }).split('\n').join('|') === 'a:|  b:|    - "x"|    - "y"|  c: 1|  d: true|e: []', 'the YAML emitter');

  // Native start with two real processes.
  const root = tmp('bundle');
  write(root, 'services/api/api.mjs', `import http from 'node:http';
http.createServer((q, r) => r.end('api-ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening on ' + process.env.PORT));`);
  write(root, 'services/web/web.mjs', `import http from 'node:http';
http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ apiUrl: process.env.API_URL, port: process.env.PORT })); }).listen(Number(process.env.PORT), '127.0.0.1');`);
  const nativeApp = { ...app, services: services.filter(s => s.id !== 'db').map(s => ({ ...s, dependsOn: s.id === 'api' ? [] : s.dependsOn, env: s.id === 'api' ? { SELF: '{port}' } : s.env })) };
  await T.startApp('ms-bundle', root, nativeApp, { mode: 'native' });
  const rec = await until(() => { const r = T.appState('ms-bundle'); return r && (r.state === 'running' || r.state === 'failed') ? r : undefined; }, 30_000);
  assert(rec?.state === 'running' && rec.services.length === 2 && rec.services.every(s => s.state === 'running'), `both services run (${rec?.state} ${rec?.error ?? ''})`);
  const apiSvc = rec.services.find(s => s.id === 'api');
  const webBody = await (await fetch(`${rec.url}/x`)).json();
  assert(rec.url === `http://127.0.0.1:${rec.services.find(s => s.id === 'web').port}` && webBody.apiUrl === `http://127.0.0.1:${apiSvc.port}`, 'the preview is the frontend, and it was handed the API\'s real URL');
  assert(apiSvc.output.some(l => /listening on/.test(l)) && rec.output.some(l => l.startsWith('[api] ')), 'each service has its own log, and the app log is prefixed');
  await T.stopApp('ms-bundle');
  const dead = await until(async () => { try { await fetch(`http://127.0.0.1:${apiSvc.port}/`, { signal: AbortSignal.timeout(800) }); return false; } catch { return true; } }, 8000);
  assert(dead, 'stopping the bundle stops every service');
  // Native start refuses a bundle with a container-only dependency and says why.
  const blocked = await T.startApp('ms-bundle2', root, app, { mode: 'native' });
  assert(blocked.state === 'failed' && /depends on db/.test(blocked.error), `native refuses what it cannot run (${blocked.error})`);
  await T.stopApp('ms-bundle2');

  // Compose path through the fake docker.
  const log = path.join(tmp('composelog'), 'd.log');
  process.env.FAKE_DOCKER_LOG = log;
  T.setDockerCommandForTests({ file: process.execPath, prefix: [path.join(here, 'fixtures', 'fake-docker.mjs')] });
  const cdir = tmp('composeapp');
  write(cdir, 'compose.yaml', 'services: {}\n');
  await T.startApp('ms-compose', cdir, app, { mode: 'compose' });
  const crec = await until(() => { const r = T.appState('ms-compose'); return r && r.state === 'running' && r.services?.find(s => s.id === 'api')?.output.length ? r : (r?.state === 'failed' ? r : undefined); }, 15_000);
  assert(crec?.state === 'running' && crec.mode === 'compose' && /^http:\/\/127\.0\.0\.1:\d+$/.test(crec.url), `compose up reports the preview URL (${crec?.state} ${crec?.error ?? ''})`);
  assert(crec.services.find(s => s.id === 'api').output.includes('hello from api'), 'compose logs are routed to each service');
  const up = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(a => a[0] === 'compose' && a.includes('up'));
  assert(up && up.includes('-p') && up[up.indexOf('-p') + 1] === 'aico-ms-compose' && up.includes('--wait') && up.includes('-d'), 'docker compose up -d --build --wait under a project named for the app');
  await T.stopApp('ms-compose');
  assert(fs.readFileSync(log, 'utf8').split('\n').some(l => l.includes('"down"') && l.includes('--remove-orphans') && !l.includes('"-v"')), 'stopping brings the project down without deleting its volumes');
  T.setDockerCommandForTests(undefined);
});

// ──────────────────────────────────────────────────────────────
await block('Templates: instantiate a non-Node starter and a bundle', async () => {
  const tdir = path.join(testHome, 'templates');
  const pyDir = path.join(tdir, 'ms-py-api');
  const files = {
    'template.json': JSON.stringify({
      id: 'ms-py-api', version: '1.2.0', name: 'Py API', category: 'api', kind: 'process', summary: 'A test Python API',
      toolchain: { id: 'python', version: '>=3.11' }, manifestFile: 'pyproject.toml', envFile: { file: '.env', generate: { SECRET_KEY: 'hex:32' } },
      run: { dev: 'python -m app', test: 'pytest -q' }, docker: { image: 'python:3.14-slim', containerPort: 8000 }, substitute: ['README.md'],
    }),
    'pyproject.toml': '[project]\nname="__APP_SLUG__"\nversion="0.1.0"\n', 'README.md': '# __APP_TITLE__\n', 'AICO.md': '# x', '.aico/backlog.md': '- [x] a', '.aico/decisions.md': 'd', 'docs/EXTENDING.md': 'e',
    '.env.example': 'SECRET_KEY=change-me\nDEBUG=0\n', '.gitignore': '.venv/\n', 'data/seed.json': '{}', 'bin/tool': 'x', '.venv/lib/x': 'x', '__pycache__/a.pyc': 'x', 'src/app.py': 'print(1)\n',
  };
  for (const [k, v] of Object.entries(files)) write(pyDir, k, v);
  const t = T.getTemplate('ms-py-api');
  assert(t && t.toolchain.id === 'python', 'a user template with the new schema loads (invalid ones are dropped)');
  assert(T.getTemplate('definitely-not-here') === undefined, 'no such template');
  const ws = tmp('inst');
  const settings = { workspace: { path: ws } };
  const app = await T.instantiateTemplate({ template: t, title: 'Orders API' }, settings, ws);
  const dir = T.miniAppDir(app.slug, settings, ws);
  const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
  assert(appJson.stack?.toolchain?.id === 'python' && appJson.stack.manifestFile === 'pyproject.toml' && appJson.stack.docker.image === 'python:3.14-slim', 'the stack is snapshotted into app.json');
  assert(app.built === true, 'built is true from pyproject.toml alone');
  assert(!fs.existsSync(path.join(dir, '.venv')) && !fs.existsSync(path.join(dir, '__pycache__')) && !fs.existsSync(path.join(dir, 'bin')), 'artefact directories do not travel (bin/ is ambiguous: dropped unless keepDirs)');
  assert(fs.existsSync(path.join(dir, 'data', 'seed.json')), 'a stack with a toolchain keeps data/');
  assert(!fs.existsSync(path.join(dir, 'template.json')) && fs.readFileSync(path.join(dir, 'README.md'), 'utf8').includes('Orders API'), 'template.json stays behind, tokens are substituted');
  assert(/^SECRET_KEY=[0-9a-f]{64}$/m.test(fs.readFileSync(path.join(dir, '.env'), 'utf8')) && !fs.existsSync(path.join(dir, '.env.local')), 'secrets go to .env in the declared format');
  const gitLog = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim();
  assert(gitLog === 'chore: scaffold Py API (aico template ms-py-api@1.2.0)', `the scaffold commit names the template and version (${gitLog})`);
  const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' });
  assert(!/\.env$/m.test(tracked) && /\.env\.example/.test(tracked), 'the generated .env is not in the scaffold commit');
  const prof = JSON.parse(fs.readFileSync(path.join(dir, '.aico', 'profile.json'), 'utf8'));
  assert(prof.commands.test.command === 'pytest -q' && prof.commands.test.source === 'template', 'the profile is seeded from the template');
  const req = T.checkTemplateRequirements({ id: 'x', kind: 'process', toolchain: { id: 'go', version: '>=99' } });
  assert(typeof req.message === 'string' && (req.ok === false ? /cannot run/.test(req.message) : /Note:/.test(req.message)), 'requirements: refuse without Docker, or allow with a note when Docker could stand in');

  // A bundle made of two templates and a database.
  const nodeApiDir = path.join(tdir, 'ms-node-api');
  for (const [k, v] of Object.entries({
    'template.json': JSON.stringify({ id: 'ms-node-api', version: '1.0.0', name: 'Node API', category: 'api', kind: 'process', summary: 's', run: { dev: 'node api.mjs' }, requires: { node: '>=18' } }),
    'api.mjs': '1', 'package.json': '{}', 'AICO.md': 'x',
  })) write(nodeApiDir, k, v);
  const bdir = path.join(tdir, 'ms-bundle-tpl');
  for (const [k, v] of Object.entries({
    'template.json': JSON.stringify({
      id: 'ms-bundle-tpl', version: '1.0.0', name: 'Stack Bundle', category: 'bundle', kind: 'bundle', summary: 'bundle',
      services: [
        { id: 'api', role: 'api', template: 'ms-node-api', port: 8000 },
        { id: 'web', role: 'frontend', path: 'services/web', port: 3000, dependsOn: ['api'], env: { API_URL: '{service.api.url}' } },
        { id: 'db', role: 'db' },
      ],
      preview: 'web', compose: { file: 'compose.yaml', generate: true }, envFile: { file: '.env' },
    }),
    'README.md': '# b', 'AICO.md': 'b', '.aico/backlog.md': '- [x] a', '.aico/decisions.md': 'd', 'docs/EXTENDING.md': 'e', 'services/web/package.json': '{}', 'services/web/Dockerfile': 'FROM scratch\n',
  })) write(bdir, k, v);
  const bt = T.getTemplate('ms-bundle-tpl');
  assert(bt?.kind === 'bundle', 'a bundle template loads');
  const bapp = await T.instantiateTemplate({ template: bt, title: 'Shop' }, settings, ws);
  const bd = T.miniAppDir(bapp.slug, settings, ws);
  const bj = JSON.parse(fs.readFileSync(path.join(bd, 'app.json'), 'utf8'));
  assert(bj.kind === 'bundle' && bj.services.length === 3 && bj.services[0].template.id === 'ms-node-api' && bj.services[0].run.dev === 'node api.mjs' && bj.preview === 'web', 'app.json carries the services with each one\'s own run profile snapshotted');
  assert(fs.existsSync(path.join(bd, 'services', 'api', 'api.mjs')) && !fs.existsSync(path.join(bd, 'services', 'api', 'template.json')), 'a template service is copied into services/<id>/');
  assert(fs.existsSync(path.join(bd, 'compose.yaml')) && /postgres:18-alpine/.test(fs.readFileSync(path.join(bd, 'compose.yaml'), 'utf8')), 'compose.yaml is generated from the services');
  assert(/^DB_PASSWORD=[0-9a-f]{48}$/m.test(fs.readFileSync(path.join(bd, '.env'), 'utf8')) && !execFileSync('git', ['ls-files'], { cwd: bd, encoding: 'utf8' }).split('\n').includes('.env'), 'the bundle secret exists in .env and is not committed');
  assert(bapp.built === true && (await T.getMiniApp(bapp.slug, settings, ws)).built === true, 'a bundle is built when its service directories exist');
  assert(T.hasProcess({ kind: 'bundle' }) && T.effectiveKind({ kind: 'bundle' }) === 'bundle', 'a bundle has a process');
  let missingErr = '';
  const orphan = { ...bt, services: [{ id: 'a', role: 'api', template: 'no-such-template' }, { id: 'b', role: 'frontend', path: 'b' }] };
  try { await T.instantiateTemplate({ template: orphan, title: 'Orphan' }, settings, ws); } catch (e) { missingErr = String(e.message); }
  assert(/no-such-template/.test(missingErr) && T.listMiniApps(settings, ws) !== undefined && !(await T.listMiniApps(settings, ws)).some(a => a.title === 'Orphan'), 'a missing service template refuses cleanly and leaves no half-made app');
  // A template with a typo in the new fields is dropped, as before, and the validator says why.
  const badDir = path.join(tdir, 'ms-bad');
  write(badDir, 'template.json', JSON.stringify({ id: 'ms-bad', version: '1.0.0', name: 'Bad', category: 'api', kind: 'process', summary: 's', toolchain: { id: 'python' }, run: { dev: 'x && y', test: 't' } }));
  assert(T.getTemplate('ms-bad') === undefined, 'an invalid manifest is not offered');
  // The AppManage tool: requirement message, create, start refusal naming docker.
  const created = await T.runInContext({ cwd: ws, sessionId: 's1', settings }, () => T.executeAppManage({ action: 'create', name: 'Via Tool', template: 'ms-py-api' }));
  assert(/Created "via-tool"/.test(created) || /cannot run on this machine/.test(created), `AppManage create goes through the requirement check (${created.slice(0, 80)})`);
});

// ──────────────────────────────────────────────────────────────
await block('Suggestions do not hand a stack nobody asked for', async () => {
  const mk = (id, extra) => ({ id, version: '1.0.0', name: id, category: 'api', kind: 'process', summary: 's', match: ['api', 'rest', 'service', 'endpoint', 'backend', 'json', 'server'], tags: ['api', 'rest', 'service'], ...extra });
  const node = mk('rank-hono', { requires: { node: '>=22' } });
  const py = mk('rank-fastapi', { toolchain: { id: 'python', version: '>=3.12' }, match: [...mk('x').match, 'python', 'fastapi', 'openapi', 'postgres'], tags: ['api', 'rest', 'service', 'python', 'openapi'] });
  const bundle = mk('rank-bundle', { kind: 'bundle', category: 'bundle', match: [...mk('x').match, 'bundle', 'saas', 'platform'] });
  const all = [py, bundle, node];
  assert(T.suggestTemplates('A REST API service with endpoints for orders', all)[0].id === 'rank-hono', 'a brief that names no stack gets the Node default, however many generic words another stack shares');
  assert(T.suggestTemplates('A Python REST API service with endpoints', all)[0].id === 'rank-fastapi', 'naming the stack picks it');
  assert(T.suggestTemplates('A bundle with an API service and a database', all)[0].id === 'rank-bundle', 'asking for a bundle picks the bundle');
  assert(T.suggestTemplates('a REST API', [py]).length === 1, 'a stack is still offered when it is all there is');
});

// ──────────────────────────────────────────────────────────────
await block('Git workflow: story commits, the commit gate, baseline and release behind a person', async () => {
  const ws = tmp('git');
  const settings = { workspace: { path: ws } };
  const made = await T.createMiniApp({ title: 'Ledger', kind: 'process' }, settings, ws);
  const dir = T.miniAppDir(made.slug, settings, ws);
  write(dir, 'package.json', JSON.stringify({ name: 'ledger', version: '0.1.0' }, null, 2) + '\n');
  write(dir, '.gitignore', '.env\n');
  await T.initAppGit(dir, 'chore: scaffold Ledger (aico template ledger@1.0.0)');
  assert(T.validateCommit({ type: 'oops', subject: 'x' }) !== null && T.validateCommit({ type: 'feat', subject: 'a\nb' }) !== null && T.validateCommit({ type: 'feat', subject: 'x'.repeat(80) }) !== null && T.validateCommit({ type: 'feat', scope: 'a b', subject: 'x' }) !== null, 'commit type, subject and scope are validated');
  assert(T.validateCommit({ type: 'feat', scope: 'items', subject: 'Add item list' }) === null && T.formatCommit({ type: 'feat', scope: 'items', subject: 'Add item list.', body: 'Done when: lists' }).subject === 'feat(items): Add item list', 'a Conventional Commit is formatted');

  // The gate: source touched + dirty tree.
  assert(T.appCommitGate(dir, 0).ok, 'no source written: silent');
  write(dir, 'src/a.ts', 'export const a = 1;\n');
  const gate = T.appCommitGate(dir, 1);
  assert(!gate.ok && /AppManage \{"action":"commit"/.test(gate.message) && gate.message.includes(made.slug), 'dirty tree after source changes: the objection names the exact call');
  assert(T.appCommitGate(path.join(ws), 1).ok, 'outside an app (no app.json): silent');
  write(dir, '.aico/profile.json', '{}');
  const secretTry = await T.commitAll(dir, { type: 'feat', subject: 'Add a' });
  assert(secretTry.ok && /feat: Add a/.test(secretTry.subject), 'commit works');
  write(dir, '.env.production', 'X=1');
  const refused = await T.commitAll(dir, { type: 'chore', subject: 'oops' });
  assert(!refused.ok && /credentials file/.test(refused.message), 'a credentials-looking file refuses the commit');
  fs.rmSync(path.join(dir, '.env.production'));
  assert(!(await T.commitAll(dir, { type: 'chore', subject: 'again' })).ok, 'nothing to commit is said plainly (the engine profile file never counts)');
  assert(T.appCommitGate(dir, 1).ok, 'a clean tree satisfies the gate');
  const author = execFileSync('git', ['log', '-1', '--format=%an'], { cwd: dir, encoding: 'utf8' }).trim();
  assert(author === 'AICO Agent', 'authored by the repo-local identity, never the person\'s global one');

  // Versions.
  assert(T.bumpVersion('1.2.3', 'major') === '2.0.0' && T.bumpVersion('1.2.3', 'minor') === '1.3.0' && T.bumpVersion('1.2.3', 'patch') === '1.2.4', 'SemVer bumps');
  assert(T.inferBump([{ sha: 'a', subject: 'fix: x' }], '1.0.0') === 'patch' && T.inferBump([{ sha: 'a', subject: 'feat: x' }], '1.0.0') === 'minor' && T.inferBump([{ sha: 'a', subject: 'feat!: x' }], '1.0.0') === 'major' && T.inferBump([{ sha: 'a', subject: 'feat!: x' }], '0.4.0') === 'minor', 'bump inferred from Conventional Commits (breaking in 0.x is minor)');
  const vdir = tmp('ver');
  const probe = (file, text, expect) => { const d = tmp('v'); write(d, file, text); const f = T.findVersion(d); T.writeVersion(d, f.source, f.version, '9.8.7'); return f.version === expect && T.findVersion(d).version === '9.8.7'; };
  assert(probe('package.json', '{\n  "name": "x",\n  "version": "1.2.3"\n}\n', '1.2.3'), 'package.json version round-trips');
  assert(probe('pyproject.toml', '[project]\nname = "x"\nversion = "1.2.3"\n', '1.2.3'), 'pyproject.toml');
  assert(probe('pom.xml', '<project><parent><version>3.0.0</version></parent><artifactId>a</artifactId><version>1.2.3-SNAPSHOT</version><dependencies><dependency><version>5.5.5</version></dependency></dependencies></project>', '1.2.3'), 'pom.xml: the project version, not the parent\'s or a dependency\'s');
  assert(probe('build.gradle', "plugins {}\nversion = '1.2.3'\n", '1.2.3') && probe('gradle.properties', 'version=1.2.3\n', '1.2.3'), 'Gradle');
  assert(probe('App.csproj', '<Project><PropertyGroup><Version>1.2.3</Version></PropertyGroup></Project>', '1.2.3') && probe('composer.json', '{"name":"a/b","version":"1.2.3"}', '1.2.3'), '.NET and Composer');
  assert(T.findVersion(vdir) === null, 'a stack with no version (Go) is versioned by tags alone');
  const cl = T.releaseChangelog('# Changelog\n\n## [Unreleased]\n\n### Added\n- thing\n\n## [0.1.0] - 2026-01-01\n\n- first\n', '0.2.0', '2026-10-06', '');
  assert(/## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-10-06\n\n### Added\n- thing/.test(cl.text) && cl.text.includes('## [0.1.0]'), 'CHANGELOG: Unreleased becomes the version, a fresh Unreleased opens');
  assert(/## \[1\.0\.0\] - 2026-10-06\n\n### Fixed\n- \*\*api:\*\* x/.test(T.releaseChangelog(undefined, '1.0.0', '2026-10-06', T.changelogFromCommits([{ sha: 'a', subject: 'fix(api): x' }, { sha: 'b', subject: 'chore: y' }])).text), 'an empty Unreleased is filled from the commits (chores skipped)');

  // Baseline and release, behind a person.
  await T.commitAll(dir, { type: 'feat', scope: 'items', subject: 'Add item list', body: 'Done when: lists' }).catch(() => undefined);
  write(dir, 'src/b.ts', 'export const b = 2;\n');
  await T.commitAll(dir, { type: 'feat', subject: 'Add b' });
  const noAsk = await T.runInContext({ cwd: ws, sessionId: 's', settings }, () => T.executeAppManage({ action: 'release', name: made.slug, baseline: true, confirm: true }));
  assert(/nobody can be asked/.test(noAsk) && execFileSync('git', ['tag'], { cwd: dir, encoding: 'utf8' }).trim() === '', 'with nobody to ask, no tag is made');
  const declined = await T.runInContext({ cwd: ws, sessionId: 's', settings, approve: async () => false }, () => T.executeAppManage({ action: 'release', name: made.slug, baseline: true, confirm: true }));
  assert(/declined/.test(declined) && execFileSync('git', ['tag'], { cwd: dir, encoding: 'utf8' }).trim() === '', 'a person saying no creates nothing');
  const asked = [];
  const baseline = await T.runInContext({ cwd: ws, sessionId: 's', settings, approve: async (t, d) => { asked.push(d); return true; } }, () => T.executeAppManage({ action: 'release', name: made.slug, baseline: true, confirm: true }));
  assert(/Tagged v0\.1\.0/.test(baseline) && /v0\.1\.0/.test(asked[0]) && execFileSync('git', ['cat-file', '-t', 'v0.1.0'], { cwd: dir, encoding: 'utf8' }).trim() === 'tag', `baseline is an annotated tag after the person approved (${baseline.slice(0, 60)})`);
  const dup = await T.tagBaseline(dir);
  assert(!dup.ok && /never moved/.test(dup.message), 'tags are never moved');
  write(dir, 'src/d.ts', 'export const d = 4;');
  await T.commitAll(dir, { type: 'feat', scope: 'items', subject: 'Add item list', body: 'Done when: lists' });
  const planText = await T.runInContext({ cwd: ws, sessionId: 's', settings }, () => T.executeAppManage({ action: 'release', name: made.slug }));
  assert(/0\.1\.0 → 0\.2\.0/.test(planText) && /confirm: true/.test(planText), 'release without confirm is a plan: feat commits since the tag mean a minor bump');
  write(dir, 'src/c.ts', 'export const c = 3;\n');
  const dirtyPlan = await T.runInContext({ cwd: ws, sessionId: 's', settings, approve: async () => true }, () => T.executeAppManage({ action: 'release', name: made.slug, confirm: true }));
  assert(/Blocked: 1 uncommitted/.test(dirtyPlan) && !/Released/.test(dirtyPlan), 'a dirty tree blocks a release');
  await T.commitAll(dir, { type: 'fix', subject: 'Fix c' });
  const released = await T.runInContext({ cwd: ws, sessionId: 's', settings, approve: async () => true }, () => T.executeAppManage({ action: 'release', name: made.slug, confirm: true }));
  assert(/Released v0\.2\.0/.test(released) && /Nothing was pushed/.test(released), `release performed (${released.slice(0, 80)})`);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert(pkg.version === '0.2.0', 'package.json bumped');
  assert(/## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}/.test(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')) && fs.existsSync(path.join(dir, 'docs', 'releases', '0.2.0.md')), 'CHANGELOG moved and release notes written');
  assert(execFileSync('git', ['cat-file', '-t', 'v0.2.0'], { cwd: dir, encoding: 'utf8' }).trim() === 'tag' && execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim() === 'chore(release): v0.2.0', 'an annotated tag and a release commit');
  assert(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim() === '', 'the release leaves a clean tree');
  const commitTool = await T.runInContext({ cwd: ws, sessionId: 's', settings }, () => T.executeAppManage({ action: 'commit', name: made.slug, type: 'feat', message: 'Nothing here' }));
  assert(/Nothing to commit/.test(commitTool), 'AppManage commit on a clean tree says so');
});

// ──────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.map(f => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
