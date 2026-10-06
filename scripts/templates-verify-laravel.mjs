/**
 * Proves the `web-app-laravel` starter works, end to end, using only Docker.
 *
 * Why this exists: `scripts/templates-live.mjs` (the rot check for the Node
 * templates) cannot cover a PHP template, and AICO must never install PHP or
 * Composer on the host. So this script runs EVERY PHP and Composer command inside
 * containers built from the template's own Dockerfile (`tools` stage), with the
 * working tree mounted, `vendor/` in a named volume (a bind-mounted vendor/ took
 * minutes on Windows) and Composer's cache in another.
 *
 * What it checks, in order: the template ships clean (no vendor/, node_modules/,
 * .env, built assets, real APP_KEY); `composer validate`; install from the lockfile;
 * Pint; PHPStan/Larastan at level 10; the test suite with coverage (gate >= 85%);
 * the same suite again on real PostgreSQL; `composer audit`; the CycloneDX SBOM;
 * the committed OpenAPI document equals the generated one; the production image
 * builds; `scripts/smoke.sh` passes against it (read-only, non-root, healthz, sign-up,
 * items API); and the compose stack (db + migrate + app + queue + scheduler + mailpit)
 * comes up and answers a real sign-up over HTTP from the host.
 *
 * What it deliberately does not do: touch the template directory (it works on a
 * scratch copy, with the `substitute` tokens replaced the way AICO does it), touch
 * ~/.aico, spend money, or leave containers/volumes behind.
 *
 * Run: node scripts/templates-verify-laravel.mjs [--keep] [--skip-stack]
 * Needs: Docker (with the daemon running) and network access to pull images/packages.
 */

import './lib/test-home.mjs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.resolve(here, '..', 'templates', 'web-app-laravel');
const keep = process.argv.includes('--keep');
const skipStack = process.argv.includes('--skip-stack');

let passed = 0, failed = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; fails.push(label); console.log(`  FAIL ${label}${detail ? `\n${detail}` : ''}`); }
}
const tail = (s, n = 25) => String(s ?? '').trim().split('\n').slice(-n).join('\n');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, encoding: 'utf8', timeout: opts.timeout ?? 15 * 60_000, input: opts.input,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', ...(opts.env ?? {}) }, maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: r.status === 0, code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------
console.log('-- preflight --');
const docker = run('docker', ['version', '--format', '{{.Server.Version}}']);
if (!docker.ok) {
  console.error('docker is not available: start Docker Desktop / the Docker daemon. This script needs nothing else, but it needs that.');
  process.exit(2);
}
console.log(`  docker ${docker.out.trim()}`);

// ---------------------------------------------------------------------------
console.log('-- the template ships clean --');
const manifest = JSON.parse(fs.readFileSync(path.join(templateDir, 'template.json'), 'utf8'));
for (const forbidden of ['node_modules', '.env', 'public/build', 'public/hot', 'sbom.cdx.json', '.phpunit.cache', '.phpstan.cache']) {
  check(!fs.existsSync(path.join(templateDir, forbidden)), `no ${forbidden} in the template`);
}
const vendorDir = path.join(templateDir, 'vendor');
check(!fs.existsSync(vendorDir) || fs.readdirSync(vendorDir).length === 0, 'no vendor/ contents in the template');
const envExample = fs.readFileSync(path.join(templateDir, '.env.example'), 'utf8');
check(/^APP_KEY=\s*$/m.test(envExample), '.env.example has an empty APP_KEY (no real key)');
check(!/base64:[A-Za-z0-9+/]{40,}/.test(envExample), '.env.example contains no base64 secret');
for (const f of ['composer.lock', 'package-lock.json', 'docs/openapi.json', 'AICO.md', 'README.md', 'docs/EXTENDING.md', '.aico/backlog.md', '.aico/decisions.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'CODEOWNERS', '.github/workflows/ci.yml', '.github/dependabot.yml', '.editorconfig', '.gitattributes', 'Makefile', 'compose.yaml', 'Dockerfile', '.dockerignore']) {
  check(fs.existsSync(path.join(templateDir, f)), `has ${f}`);
}
check(fs.readFileSync(path.join(templateDir, 'AICO.md'), 'utf8').length <= 2000, 'AICO.md is at most 2,000 characters');

// ---------------------------------------------------------------------------
// A scratch copy with the substitution tokens replaced, the way AICO instantiates a template.
const scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-laravel-'));
const dir = path.join(scratch, 'verify-laravel');
const runId = crypto.randomBytes(3).toString('hex');
const vol = { vendor: `aico-lv-${runId}-vendor`, cache: `aico-lv-${runId}-cache` };
const toolsImage = `aico-lv-${runId}-tools`;
const appImage = `aico-lv-${runId}-app`;
const project = `aicolv${runId}`;

const SKIP = /(^|[\\/])(node_modules|vendor|\.git|coverage|\.phpunit\.cache|\.phpstan\.cache|\.env)([\\/]|$)/;
fs.cpSync(templateDir, dir, { recursive: true, filter: (p) => !SKIP.test(path.relative(templateDir, p)) });
fs.rmSync(path.join(dir, 'template.json'), { force: true });

function globToRegex(g) {
  const esc = g.replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{([^}]+)\}/g, (_, a) => `(?:${a.split(',').join('|')})`)
    .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`);
}
const subRes = (manifest.substitute ?? []).map(globToRegex);
function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}
for (const f of walk(dir)) {
  const rel = path.relative(dir, f).split(path.sep).join('/');
  if (!subRes.some((re) => re.test(rel))) continue;
  const text = fs.readFileSync(f, 'utf8')
    .replaceAll('__APP_TITLE__', 'Verify Laravel').replaceAll('__APP_SLUG__', 'verify-laravel')
    .replaceAll('__APP_DESCRIPTION__', 'A verification copy');
  fs.writeFileSync(f, text);
}
const leftovers = walk(dir).filter((f) => /__APP_(TITLE|SLUG|DESCRIPTION)__/.test(fs.readFileSync(f, 'utf8')) && !/templates-verify|\.md$/.test(f));
check(leftovers.length === 0, 'every substitution token in a code/config file is covered by template.json "substitute"', leftovers.join('\n'));

// ---------------------------------------------------------------------------
function tools(args, extra = {}) {
  const envArgs = Object.entries(extra.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return run('docker', [
    'run', '--rm', ...(extra.network ? ['--network', extra.network] : []),
    '-v', `${dir}:/app`, '-v', `${vol.vendor}:/app/vendor`, '-v', `${vol.cache}:/home/dev/.cache/composer`,
    '-w', '/app', ...envArgs, toolsImage, ...args,
  ], { timeout: extra.timeout });
}

let network = null, pg = null;
try {
  console.log('\n-- build the tools image (PHP 8.5 CLI + Composer + PCOV + pdo_pgsql) --');
  const build = run('docker', ['build', '--target', 'tools', '-t', toolsImage, '.'], { cwd: dir });
  check(build.ok, 'tools image builds', tail(build.out));
  if (!build.ok) throw new Error('cannot continue without the tools image');
  run('docker', ['volume', 'create', vol.vendor]); run('docker', ['volume', 'create', vol.cache]);

  const ver = tools(['sh', '-c', 'php -v | head -1; composer --version; php -m | grep -E "pdo_pgsql|pcov|sodium|intl" | tr "\\n" " "']);
  console.log(ver.out.trim().split('\n').map((l) => `  ${l}`).join('\n'));

  console.log('\n-- composer --');
  check(tools(['composer', 'validate', '--strict', '--no-check-publish']).ok, 'composer validate --strict');
  const install = tools(['composer', 'install', '--no-interaction', '--prefer-dist', '--no-progress']);
  check(install.ok, 'composer install --locked (from composer.lock)', tail(install.out));
  const versions = tools(['composer', 'show', '--format=json', '--direct']);
  try {
    const direct = JSON.parse(versions.out.slice(versions.out.indexOf('{'))).installed ?? [];
    console.log(`  resolved: ${direct.map((p) => `${p.name} ${p.version}`).join(', ')}`);
  } catch { /* informational only */ }

  console.log('\n-- format and static analysis --');
  const pint = tools(['composer', 'lint']);
  check(pint.ok, 'Pint: formatting is clean', tail(pint.out));
  const stan = tools(['composer', 'analyse']);
  check(stan.ok, 'PHPStan (Larastan) level 10: no errors', tail(stan.out, 40));

  console.log('\n-- tests with coverage (SQLite in memory) --');
  const cov = tools(['composer', 'cov'], { timeout: 20 * 60_000 });
  const total = /Total:\s+([\d.]+)\s*%/.exec(cov.out.replace(/\x1b\[[0-9;]*m/g, ''));
  const counts = /Tests:\s+(.*)/.exec(cov.out.replace(/\x1b\[[0-9;]*m/g, ''));
  check(cov.ok, `pest passes and coverage gate >= 85% holds (${total ? total[1] + '%' : 'n/a'}; ${counts ? counts[1].trim() : ''})`, tail(cov.out, 40));

  console.log('\n-- the same suite on real PostgreSQL 18 --');
  network = `aico-lv-${runId}-net`;
  run('docker', ['network', 'create', network]);
  pg = `aico-lv-${runId}-pg`;
  const pgRun = run('docker', ['run', '-d', '--name', pg, '--network', network, '-e', 'POSTGRES_PASSWORD=verify-only', '-e', 'POSTGRES_USER=app', '-e', 'POSTGRES_DB=app', 'postgres:18.6-alpine3.24@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873']);
  check(pgRun.ok, 'postgres container started', tail(pgRun.out));
  for (let i = 0; i < 40; i++) {
    if (run('docker', ['exec', pg, 'pg_isready', '-U', 'app', '-d', 'app']).ok) break;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
  }
  const pgEnv = { DB_CONNECTION: 'pgsql', DB_HOST: pg, DB_PORT: '5432', DB_DATABASE: 'app', DB_USERNAME: 'app', DB_PASSWORD: 'verify-only' };
  const pgTests = tools(['vendor/bin/pest', '--no-coverage'], { network, env: pgEnv, timeout: 20 * 60_000 });
  check(pgTests.ok, 'pest passes against PostgreSQL (migrations, cursor pagination, LIKE escaping)', tail(pgTests.out, 40));
  const migrate = tools(['sh', '-c', 'php artisan migrate:fresh --force --seed --no-interaction && php artisan migrate:status --no-interaction | tail -4'], { network, env: { ...pgEnv, APP_ENV: 'local' } });
  check(migrate.ok, 'migrate:fresh --seed on PostgreSQL', tail(migrate.out));

  console.log('\n-- supply chain --');
  const audit = tools(['composer', 'audit', '--locked', '--no-interaction']);
  check(audit.ok, 'composer audit --locked: no known vulnerabilities', tail(audit.out));
  const sbom = tools(['composer', 'sbom']);
  const sbomPath = path.join(dir, 'sbom.cdx.json');
  let sbomOk = false;
  try { const j = JSON.parse(fs.readFileSync(sbomPath, 'utf8')); sbomOk = j.bomFormat === 'CycloneDX' && j.components?.length > 20; console.log(`  SBOM: CycloneDX ${j.specVersion}, ${j.components?.length} components`); } catch { /* reported below */ }
  check(sbom.ok && sbomOk, 'CycloneDX SBOM generated (production dependencies)', tail(sbom.out));

  console.log('\n-- OpenAPI contract --');
  const before = fs.readFileSync(path.join(dir, 'docs', 'openapi.json'), 'utf8');
  const gen = tools(['composer', 'openapi']);
  const after = fs.readFileSync(path.join(dir, 'docs', 'openapi.json'), 'utf8');
  check(gen.ok && before === after, 'regenerating docs/openapi.json changes nothing (the committed document is current)', tail(gen.out));

  console.log('\n-- the production image --');
  const img = run('docker', ['build', '-t', appImage, '.'], { cwd: dir });
  check(img.ok, 'production image builds (assets in a Node stage, vendor without dev packages, FrankenPHP runtime)', tail(img.out));
  if (img.ok) {
    const size = run('docker', ['image', 'inspect', appImage, '--format', '{{.Size}}']);
    console.log(`  image size: ${(Number(size.out.trim()) / 1048576).toFixed(0)} MiB`);
    const sh = fs.existsSync('C:\\Program Files\\Git\\bin\\sh.exe') && process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\sh.exe' : 'sh';
    const smoke = run(sh, ['scripts/smoke.sh', appImage], { cwd: dir, timeout: 10 * 60_000 });
    console.log(tail(smoke.out, 40).split('\n').map((l) => `    ${l}`).join('\n'));
    check(smoke.ok && /SMOKE PASSED/.test(smoke.out), 'smoke test of the built container (read-only, non-root, /healthz, sign-up, items API, headers)');
    const noDev = run('docker', ['run', '--rm', '--entrypoint', 'sh', appImage, '-c', 'test ! -d vendor/pestphp && test ! -d vendor/phpunit && test ! -d tests && test ! -f .env && echo clean']);
    check(/clean/.test(noDev.out), 'the image contains no test tools, no tests and no .env');
    const badKey = run('docker', ['run', '--rm', '-e', 'APP_KEY=', appImage, 'true']);
    check(!badKey.ok && /APP_KEY is not set/.test(badKey.out), 'the container refuses to start without an APP_KEY (fails fast)');
    const debugOn = run('docker', ['run', '--rm', '-e', 'APP_DEBUG=true', '-e', `APP_KEY=base64:${crypto.randomBytes(32).toString('base64')}`, appImage, 'true']);
    check(!debugOn.ok && /APP_DEBUG must be false/.test(debugOn.out), 'the container refuses to start with APP_DEBUG=true in production');
  }

  // How AICO itself runs this template when the machine has no PHP: `docker run <docker.image> sh -c
  // "<setup> && <command>"` with the app directory mounted at /work (src/apps/docker-run.ts). The
  // vendor/ directory and Composer's cache are named volumes mounted over it, the way `docker.cache` asks.
  console.log('\n-- AICO docker mode (template.json: docker.image, run.*; no PHP on the host) --');
  {
    const dk = manifest.docker;
    const dkVol = { vendor: `aico-lv-${runId}-dkvendor`, cache: `aico-lv-${runId}-dkcache` };
    const mounts = ['-v', `${dir}:/work`, '-w', '/work', ...dk.cache.flatMap((p) => ['-v', `${p === '/work/vendor' ? dkVol.vendor : dkVol.cache}:${p}`])];
    const inDocker = (cmd, extra = []) => run('docker', ['run', '--rm', '--init', ...mounts, ...extra, dk.image, 'sh', '-c', `${dk.setup} && ${cmd}`], { timeout: 20 * 60_000 });
    const profile = manifest.run;
    check(inDocker(profile.lint).ok, `run.lint in ${dk.image.split('@')[0]}: ${profile.lint}`);
    check(inDocker(profile.typecheck).ok, `run.typecheck: ${profile.typecheck}`);
    const dkTest = inDocker(profile.test);
    check(dkTest.ok, `run.test: ${profile.test} (SQLite, no extra extensions needed)`, tail(dkTest.out, 30));
    check(inDocker(profile.audit).ok, `run.audit: ${profile.audit}`);

    // The dev runner: install, migrate, seed, serve on 0.0.0.0; no Node, so the stylesheet falls back.
    const key = tools(['php', 'artisan', 'key:generate', '--show']).out.trim().split('\n').pop().trim();
    fs.writeFileSync(path.join(dir, '.env'), fs.readFileSync(path.join(dir, '.env.example'), 'utf8').replace(/^APP_KEY=.*$/m, `APP_KEY=${key}`));
    const devEnv = Object.entries(profile.env).flatMap(([k, v]) => ['-e', `${k}=${String(v).replaceAll('{port}', '8000')}`]);
    const devName = `aico-lv-${runId}-dev`;
    const started = run('docker', ['run', '-d', '--init', '--name', devName, ...mounts, '-p', '127.0.0.1::8000', ...devEnv, dk.image, 'sh', '-c', `${dk.setup} && ${dk.dev}`]);
    check(started.ok, 'AICO dev command starts in the container', tail(started.out));
    if (started.ok) {
      const port = /:(\d+)\s*$/m.exec(run('docker', ['port', devName, '8000/tcp']).out.trim())?.[1];
      const base = `http://127.0.0.1:${port}`;
      let up = false, last = '';
      for (let i = 0; i < 120 && !up; i++) {
        try { up = (await fetch(`${base}${profile.health}`)).status === 200; } catch (e) { last = String(e); }
        if (!up) await new Promise((r) => setTimeout(r, 1000));
      }
      const logs = run('docker', ['logs', devName]).out;
      check(up, `dev server answers ${profile.health} (ready regex "${profile.ready}" ${new RegExp(profile.ready).test(logs) ? 'matched the log' : 'did NOT match the log'})`, last + '\n' + tail(logs, 20));
      check(new RegExp(profile.ready).test(logs), 'run.ready regex matches the dev server output');
      if (up) {
        const reg = await fetch(`${base}/register`);
        const html = await reg.text();
        check(reg.status === 200 && html.includes('css/fallback.css'), 'with no Vite build the page links the fallback stylesheet');
        check((await fetch(`${base}/css/fallback.css`)).status === 200, 'the fallback stylesheet is served');
        const demo = await fetch(`${base}/login`);
        check(demo.status === 200, 'GET /login -> 200 on the SQLite dev database (migrated and seeded by app:dev)');
      }
    }
    run('docker', ['rm', '-f', devName]);
    run('docker', ['volume', 'rm', '-f', dkVol.vendor, dkVol.cache]);
    fs.rmSync(path.join(dir, '.env'), { force: true });
  }

  if (!skipStack) {
    console.log('\n-- the compose stack (db, migrate, app, queue, scheduler, mailpit) --');
    fs.copyFileSync(path.join(dir, '.env.example'), path.join(dir, '.env'));
    const key = tools(['php', 'artisan', 'key:generate', '--show']).out.trim().split('\n').pop().trim();
    check(/^base64:/.test(key), 'APP_KEY generated by artisan key:generate');
    const envText = fs.readFileSync(path.join(dir, '.env'), 'utf8')
      .replace(/^APP_KEY=.*$/m, `APP_KEY=${key}`)
      .replace(/^DB_PASSWORD=.*$/m, `DB_PASSWORD=${crypto.randomBytes(12).toString('hex')}`)
      .replace(/^APP_PORT=.*$/m, 'APP_PORT=28080')
      .replace(/^MAILPIT_PORT=.*$/m, 'MAILPIT_PORT=28025');
    fs.writeFileSync(path.join(dir, '.env'), envText);
    const compose = (args, t) => run('docker', ['compose', '-p', project, '-f', 'compose.yaml', ...args], { cwd: dir, timeout: t });
    const config = compose(['config', '--quiet']);
    check(config.ok, 'docker compose config is valid', tail(config.out));
    const up = compose(['up', '-d', '--build', '--wait', '--wait-timeout', '240', 'app', 'queue', 'scheduler', 'mailpit'], 15 * 60_000);
    check(up.ok, 'compose up --wait: db healthy, migrations ran, app healthy', tail(up.out, 40));
    if (up.ok) {
      const base = 'http://127.0.0.1:28080';
      const h = await fetch(`${base}/healthz`); check(h.status === 200, 'GET /healthz from the host -> 200');
      const r = await fetch(`${base}/readyz`); check(r.status === 200, 'GET /readyz -> 200 (PostgreSQL reachable)');
      const jar = [];
      const cookieHeader = () => jar.map((c) => c.split(';')[0]).join('; ');
      const keepCookies = (res) => { for (const c of res.headers.getSetCookie()) { const name = c.split('=')[0]; const i = jar.findIndex((x) => x.startsWith(name + '=')); if (i >= 0) jar[i] = c; else jar.push(c); } };
      const page = await fetch(`${base}/register`); keepCookies(page);
      const csrf = /name="_token" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
      const email = `verify${runId}@example.test`, password = 'a long verification passphrase';
      const signup = await fetch(`${base}/register`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() }, body: new URLSearchParams({ _token: csrf, name: 'Verify User', email, password, password_confirmation: password }) });
      keepCookies(signup);
      check(signup.status === 302 && signup.headers.get('location')?.endsWith('/items'), 'sign-up over HTTP from the host redirects to /items');
      const items = await fetch(`${base}/items`, { headers: { cookie: cookieHeader() } });
      const html = await items.text();
      check(items.status === 200 && html.includes('Verify User') && html.includes('wire:id'), '/items renders the Livewire page for the new user');
      const nonce = /script-src 'self' 'nonce-([A-Za-z0-9]+)'/.exec(items.headers.get('content-security-policy') ?? '')?.[1];
      check(!!nonce && html.includes(`nonce="${nonce}"`), 'the page carries the same nonce as its CSP header (inline scripts are allowed only with it)');
      const tok = await fetch(`${base}/api/v1/auth/tokens`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ email, password, device_name: 'verify' }) });
      const bearer = (await tok.json()).data?.token;
      const created = await fetch(`${base}/api/v1/items`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ title: 'Created over HTTP', notes: 'verify script' }) });
      check(created.status === 201, 'POST /api/v1/items -> 201 against PostgreSQL');
      const after = await fetch(`${base}/items`, { headers: { cookie: cookieHeader() } });
      check((await after.text()).includes('Created over HTTP'), 'the API-created item is visible on the signed-in web page');
      const mail = await fetch('http://127.0.0.1:28025/api/v1/messages'); check(mail.status === 200, 'Mailpit is up and reachable');
      const ps = compose(['ps', '--format', '{{.Service}} {{.State}}']);
      check(/queue running/.test(ps.out) && /scheduler running/.test(ps.out), 'queue worker and scheduler containers are running', ps.out);
      const logs = compose(['logs', '--no-log-prefix', 'app']).out.split('\n').filter((l) => l.trim() && !/^\s*(INFO|WARN)/.test(l));
      const jsonLines = logs.filter((l) => { try { JSON.parse(l); return true; } catch { return false; } });
      check(jsonLines.length > 0 && jsonLines.length >= logs.length - 3, `application and web-server logs are JSON (${jsonLines.length}/${logs.length} lines)`, logs.slice(0, 5).join('\n'));
      const stop = compose(['stop', '-t', '30', 'queue']);
      check(stop.ok && /Exit|exited/i.test(compose(['ps', '-a', '--format', '{{.Service}} {{.Status}}', 'queue']).out), 'queue worker stops on SIGTERM within the grace period');
    }
  }
} catch (e) {
  check(false, `verification aborted: ${e.message}`);
} finally {
  if (!keep) {
    run('docker', ['compose', '-p', project, 'down', '-v', '--remove-orphans', '--rmi', 'local'], { cwd: dir });
    if (pg) run('docker', ['rm', '-f', pg]);
    if (network) run('docker', ['network', 'rm', network]);
    run('docker', ['volume', 'rm', '-f', vol.vendor, vol.cache]);
    run('docker', ['image', 'rm', '-f', toolsImage, appImage]);
    fs.rmSync(scratch, { recursive: true, force: true });
  } else console.log(`\nkept: ${dir} (volumes ${vol.vendor}, ${vol.cache}; compose project ${project})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(`failed:\n  - ${fails.join('\n  - ')}`); process.exit(1); }
process.exit(0);
