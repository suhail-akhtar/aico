/**
 * End-to-end proof that the `web-app-react` starter works from a clean copy.
 *
 * Why this exists: `scripts/templates-live.mjs` (the rot check) runs `npm ci` and the
 * `typecheck`/`lint`/`test`/`build` scripts of the Node templates against the host's Node,
 * and has no idea about a browser suite, a generated client or an nginx image. This script
 * copies the starter to a scratch directory the way `instantiateTemplate` does (no artefact
 * directories, tokens substituted), then runs everything the starter promises in pinned
 * containers, so the result does not depend on the Node on the machine (the starter needs
 * Node 24; a host with 22 still gets a real answer): the manifest validator, a locked
 * install, format, lint, `tsc`, the generated-code freshness check, the unit and component
 * suite with its coverage gate, `npm audit`, the production build, the SBOM, the dev server
 * exactly as the manifest starts it (readiness regex included) with the mock gateway's
 * sign-in flow over HTTP, the production image (non-root, read-only, headers, config
 * written from the environment, hostile configuration refused), the image scan, and the
 * Playwright suite at 1280 and 390 against the built app. A step that cannot run (no
 * Docker, offline) is reported as skipped, never as passed.
 *
 * What it deliberately does not do: touch `~/.aico` (it imports the isolated test home
 * first, and never starts the engine), call a model (free, no tokens), or install anything
 * on the host: tools run in containers and the only things left behind are Docker's own
 * image and volume caches (the per-run `node_modules` volume is removed).
 *
 * Run: node scripts/templates-verify-react.mjs [--skip-image] [--skip-e2e] [--offline] [--keep]
 *   --offline     skips the audit, the image scan and the action-pin lookups (needs warm caches)
 *   --keep        leave the scratch copy in place and print its path
 * Exit code 1 when any step fails.
 */

import './lib/test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkActionPins, copyTemplate, createReporter, dockerAvailable, freePort, http, run, scratchDir, secret, sleep, startProcess, tail, waitFor,
} from './lib/verify-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.join(root, 'templates', 'web-app-react');
const flags = new Set(process.argv.slice(2));
const offline = flags.has('--offline');
const skipImage = flags.has('--skip-image');
const skipE2e = flags.has('--skip-e2e');
const PROJECT = `aico-react-verify-${secret(3)}`;
const IMAGE = `${PROJECT}:test`;
const TRIVY = 'ghcr.io/aquasecurity/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa';
const PLAYWRIGHT = 'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27';

const r = createReporter();
const { check, skip, section } = r;
const cleanup = [];
const versions = {};
let scratch;

try {
  section('toolchain');
  const docker = dockerAvailable();
  if (!check(Boolean(docker), 'the docker daemon is reachable (every tool runs in a pinned container)')) throw new Error('docker is required');
  r.note(`docker ${docker}`);

  section('manifest');
  const validator = run(process.execPath, [path.join(here, 'validate-template.mjs'), source], { cwd: root, timeout: 120_000 });
  check(validator.ok, 'validate-template.mjs accepts the manifest and the completeness bar', tail(validator.out));
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'template.json'), 'utf8'));
  check(manifest.id === 'web-app-react' && manifest.kind === 'process' && manifest.toolchain?.id === 'node', 'manifest identifies a node process template');
  check(fs.readFileSync(path.join(source, 'AICO.md'), 'utf8').length <= 2000, 'AICO.md is within the 2,000 character cap');
  const NODE_IMAGE = manifest.docker.image;
  check(/@sha256:[0-9a-f]{64}$/.test(NODE_IMAGE) && /@sha256:[0-9a-f]{64}$/.test(PLAYWRIGHT), 'the tool images are pinned by digest');

  section('clean copy (as instantiateTemplate would make it)');
  scratch = scratchDir('aico-react-');
  const app = path.join(scratch, 'app');
  copyTemplate(source, app, { substitutions: { __APP_TITLE__: 'Verify App', __APP_SLUG__: PROJECT, __APP_DESCRIPTION__: 'verification copy' } });
  check(fs.existsSync(path.join(app, 'package-lock.json')), 'the lockfile is shipped');
  check(!fs.existsSync(path.join(app, 'node_modules')) && !fs.existsSync(path.join(app, 'dist')), 'no node_modules or build output came along');
  check(!fs.readFileSync(path.join(app, 'index.html'), 'utf8').includes('__APP_'), 'tokens were substituted in index.html');
  r.note(app);
  const lock = JSON.parse(fs.readFileSync(path.join(app, 'package-lock.json'), 'utf8')).packages;
  for (const name of ['vite', 'react', 'typescript', '@biomejs/biome', '@tanstack/react-router', '@tanstack/react-query', 'tailwindcss', '@hey-api/openapi-ts', 'vitest', 'msw', '@playwright/test', 'zod', 'jsdom', 'axe-core']) {
    versions[name] = lock[`node_modules/${name}`]?.version;
  }
  check(versions.typescript === '6.0.3', `TypeScript is 6.0.3, not 7 (resolved ${versions.typescript})`);

  section('github actions are pinned by SHA to the tag they name');
  {
    const pins = checkActionPins(app, { offline });
    check(pins.problems.length === 0, `ci.yml pins${pins.skipped ? '' : ` (${pins.verified.length} verified against the tags)`}`, pins.problems.join('\n'));
    if (pins.skipped) skip('tag lookups', offline ? '--offline' : 'gh is not available');
  }

  // ---------------------------------------------------------------- checks in the pinned Node image
  const nm = `${PROJECT}-nm`;
  cleanup.push(() => run('docker', ['volume', 'rm', '-f', nm]));
  const inNode = (args, { timeout = 15 * 60_000, extra = [] } = {}) =>
    run('docker', ['run', '--rm', '-v', `${app}:/app`, '-v', `${nm}:/app/node_modules`, '-v', 'aico-react-verify-npm:/root/.npm', '-w', '/app',
      '-e', 'CI=1', '-e', 'NO_COLOR=1', '-e', 'npm_config_update_notifier=false', ...extra, NODE_IMAGE, ...args], { timeout });

  section('install and static checks (Node 24 image)');
  {
    const node = inNode(['node', '--version']);
    versions.node = node.stdout.trim();
    check(/^v24\./.test(versions.node), `the tool image runs Node 24 (${versions.node})`);
    const install = inNode(['npm', 'ci', '--no-audit', '--no-fund']);
    if (!check(install.ok, 'npm ci installs from the lockfile', tail(install.out))) throw new Error('install failed');
    check(!/deprecated/i.test(install.out), 'no deprecated package is installed', install.out.split('\n').filter((l) => /deprecated/i.test(l)).join('\n'));
    for (const [label, script] of [['format check (Biome)', 'fmt:check'], ['lint incl. accessibility rules (Biome)', 'lint'], ['tsc, app and tooling', 'typecheck'], ['generated client and route tree are current', 'gen:check']]) {
      const out = inNode(['npm', 'run', script]);
      check(out.ok, label, tail(out.out, 30));
    }
  }

  section('unit and component tests with the coverage gate');
  {
    const out = inNode(['npm', 'run', 'cov']);
    const tests = /Tests\s+(\d+) passed/.exec(out.out);
    const cov = /All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(out.out);
    check(out.ok && tests, `vitest passes${tests ? ` (${tests[1]} tests)` : ''}`, tail(out.out, 40));
    check(cov && Number(cov[4]) >= 85, `line coverage ${cov ? `${cov[4]}%` : 'unknown'} meets the 85% gate`);
    versions.unitTests = tests?.[1];
    versions.coverage = cov?.[4];
  }

  section('dependency audit and SBOM');
  if (offline) skip('npm audit', '--offline');
  else {
    const out = inNode(['npm', 'run', 'audit']);
    check(out.ok && /no high or critical advisories/.test(out.out), 'npm audit: no high or critical advisory in the locked set', tail(out.out));
  }
  {
    const out = inNode(['npm', 'run', 'sbom']);
    let bom;
    try { bom = JSON.parse(fs.readFileSync(path.join(app, 'sbom.cdx.json'), 'utf8')); } catch { /* checked below */ }
    check(out.ok && bom?.bomFormat === 'CycloneDX' && bom.components?.length > 5, `npm sbom writes a CycloneDX BOM${bom ? ` (${bom.components.length} components)` : ''}`, tail(out.out));
  }

  section('production build');
  {
    const out = inNode(['npm', 'run', 'build']);
    check(out.ok, 'vite build', tail(out.out, 30));
    const dist = path.join(app, 'dist');
    const html = fs.existsSync(path.join(dist, 'index.html')) ? fs.readFileSync(path.join(dist, 'index.html'), 'utf8') : '';
    check(html && !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) && !/<style|\sstyle=/i.test(html), 'the built index.html has no inline script or style (strict-CSP friendly)');
    const assets = fs.existsSync(path.join(dist, 'assets')) ? fs.readdirSync(path.join(dist, 'assets')) : [];
    const kb = assets.filter((f) => f.endsWith('.js')).reduce((n, f) => n + fs.statSync(path.join(dist, 'assets', f)).size, 0) / 1024;
    check(kb > 0 && kb < 700, `JavaScript is ${kb.toFixed(0)} kB before compression (budget 700 kB)`);
    versions.jsKb = Math.round(kb);
  }

  // ---------------------------------------------------------------- dev server as the manifest starts it
  section('dev server (manifest run.dev) and the mock gateway');
  {
    const port = await freePort();
    const name = `${PROJECT}-dev`;
    const devCommand = manifest.docker.dev;
    const proc = startProcess('docker', ['run', '--rm', '--name', name, '-p', `127.0.0.1:${port}:5173`, '-v', `${app}:/app`, '-v', `${nm}:/app/node_modules`, '-w', '/app', '-e', 'NO_COLOR=1', NODE_IMAGE, 'sh', '-c', devCommand]);
    cleanup.push(() => run('docker', ['rm', '-f', name]));
    try {
      const ready = new RegExp(manifest.run.ready);
      await waitFor(() => ready.test(proc.output()), 120_000, 'run.ready to match the dev server output');
      check(true, 'the manifest readiness regex matches the dev server output');
      const base = `http://127.0.0.1:${port}`;
      await waitFor(async () => (await http('GET', `${base}${manifest.run.health}`)).status === 200, 30_000, manifest.run.health);
      check(true, `the manifest health path ${manifest.run.health} answers 200`);
      const page = await http('GET', `${base}/`);
      check(page.status === 200 && /<div id="root">/.test(page.text), 'the dev server serves the app shell');

      check((await http('GET', `${base}/api/v1/auth/me`)).status === 401, 'mock gateway: no session is a 401');
      const start = await http('GET', `${base}/api/auth/start?rd=/items`);
      check(start.status === 302 && start.headers.get('location') === '/mock-idp/login?rd=%2Fitems', 'mock gateway: /api/auth/start redirects to the identity page', start.headers.get('location'));
      const bad = await http('POST', `${base}/mock-idp/login`, { body: 'username=dev%40example.com&password=wrong&rd=%2F', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      check(bad.status === 401, 'mock gateway: a wrong password is refused');
      const login = await http('POST', `${base}/mock-idp/login`, { body: 'username=dev%40example.com&password=dev-password&rd=%2Fitems', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      const cookie = (login.setCookies[0] ?? '').split(';')[0];
      check(login.status === 302 && /^mock_session=/.test(cookie) && /HttpOnly/.test(login.setCookies[0] ?? ''), 'mock gateway: sign-in sets an HttpOnly session cookie and redirects');
      const me = await http('GET', `${base}/api/v1/auth/me`, { headers: { cookie } });
      check(me.status === 200 && me.json?.email === 'dev@example.com', 'mock gateway: /auth/me answers for the session', me.text);
      const forged = await http('POST', `${base}/api/v1/items`, { body: { name: 'x' }, headers: { cookie } });
      check(forged.status === 403, 'mock gateway: a state-changing request without the CSRF header is refused');
      const created = await http('POST', `${base}/api/v1/items`, { body: { name: 'pen', quantity: 2 }, headers: { cookie, 'x-requested-with': 'fetch' } });
      check(created.status === 201 && created.json?.name === 'pen', 'mock gateway: an item can be created with the header', created.text);
      const out = await http('GET', `${base}/api/auth/sign_out?rd=/`, { headers: { cookie } });
      check(out.status === 302 && /Max-Age=0/.test(out.setCookies[0] ?? ''), 'mock gateway: sign-out clears the cookie');
    } catch (e) {
      check(false, 'dev server starts and answers', `${e.message}\n${tail(proc.output(), 30)}`);
    }
    run('docker', ['rm', '-f', name]);
    proc.stop();
    await sleep(500);
  }

  // ---------------------------------------------------------------- image
  section('production image');
  if (skipImage) skip('image build and smoke tests', '--skip-image');
  else {
    const build = run('docker', ['build', '-t', IMAGE, '.'], { cwd: app, timeout: 20 * 60_000 });
    if (check(build.ok, 'docker build', tail(build.out))) {
      cleanup.push(() => run('docker', ['rmi', '-f', IMAGE]));
      const inspect = JSON.parse(run('docker', ['image', 'inspect', IMAGE]).stdout)[0];
      check(String(inspect.Config.User) === '101', 'the image runs as a non-root user (uid 101)');
      check(Boolean(inspect.Config.Healthcheck), 'the image declares a HEALTHCHECK');
      check(/^[A-Za-z0-9_/.:-]*entrypoint\.sh$/.test((inspect.Config.Entrypoint ?? []).join(' ')), 'the entrypoint is the config-writing script');
      if (offline) skip('trivy image scan', '--offline');
      else {
        const scan = run('docker', ['run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock', TRIVY, 'image', '--exit-code', '1', '--severity', 'HIGH,CRITICAL', '--ignore-unfixed', '--quiet', IMAGE], { timeout: 10 * 60_000 });
        if (!scan.ok && /pull access denied|Unable to find image|TLS handshake|no such host/i.test(scan.out)) skip('trivy image scan', 'scanner image not available');
        else check(scan.ok, 'trivy: no fixable HIGH or CRITICAL vulnerability in the image', tail(scan.out, 30));
      }

      // Hostile configuration must stop the container, whatever the value looks like.
      for (const [key, value] of [['API_BASE_URL', 'https://evil.example/api'], ['API_BASE_URL', '//evil.example'], ['LOGIN_URL', 'javascript:alert(1)'], ['LOGOUT_URL', '/a b'], ['API_BASE_URL', '/a"b'], ['LOGIN_URL', '/a\\b'], ['APP_ENVIRONMENT', 'x"y']]) {
        const bad = run('docker', ['run', '--rm', '-e', `${key}=${value}`, IMAGE], { timeout: 60_000 });
        check(bad.status === 64 && /entrypoint:/.test(bad.out), `the entrypoint refuses ${key}=${value}`, tail(bad.out, 4));
      }

      const port = await freePort();
      const name = `${PROJECT}-web`;
      const start = run('docker', ['run', '-d', '--name', name, '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '-p', `127.0.0.1:${port}:8080`, '-e', 'APP_ENVIRONMENT=verify', '-e', 'LOGIN_URL=/gateway/start', IMAGE]);
      cleanup.push(() => run('docker', ['rm', '-f', name]));
      if (check(start.ok, 'the hardened container starts (read-only, no capabilities)', tail(start.out))) {
        try {
          const base = `http://127.0.0.1:${port}`;
          await waitFor(async () => (await http('GET', `${base}/healthz`)).status === 200, 60_000, '/healthz');
          check(true, 'container: /healthz answers 200');
          const config = await http('GET', `${base}/config.json`);
          check(config.status === 200 && config.json?.environment === 'verify' && config.json?.loginUrl === '/gateway/start' && config.json?.apiBaseUrl === '/api' && /no-store/.test(config.headers.get('cache-control') ?? ''),
            'container: /config.json is written from the environment and never cached', config.text);
          const index = await http('GET', `${base}/items`);
          check(index.status === 200 && /<div id="root">/.test(index.text) && /no-cache/.test(index.headers.get('cache-control') ?? ''), 'container: a client-side route gets the app shell, uncached');
          const h = index.headers;
          check(/default-src 'self'/.test(h.get('content-security-policy') ?? '') && !/unsafe-/.test(h.get('content-security-policy') ?? '') && h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'DENY' && !/\d/.test(h.get('server') ?? ''),
            'container: strict CSP and security headers, no server version');
          const asset = /\/assets\/[^"]+\.js/.exec(index.text)?.[0];
          const js = asset ? await http('GET', `${base}${asset}`) : undefined;
          check(js?.status === 200 && /immutable/.test(js.headers.get('cache-control') ?? ''), 'container: fingerprinted assets are cached as immutable');
          check((await http('GET', `${base}${asset}.map`)).status === 404, 'container: source maps are not served');
          check((await http('GET', `${base}/.env`)).status === 404, 'container: dotfiles are not served');
          const api = await http('GET', `${base}/api/v1/items`);
          check(api.status === 404 && /problem\+json/.test(api.headers.get('content-type') ?? ''), 'container: /api answers 404 problem+json, not the app shell');
          const csrf = await http('GET', `${base}/__csrf_rejected`);
          check(csrf.status === 403 && /problem\+json/.test(csrf.headers.get('content-type') ?? ''), 'container: the gateway helper path answers 403 problem+json');
          const big = await http('POST', `${base}/`, { body: 'x'.repeat(4096), headers: { 'content-type': 'text/plain' } });
          check(big.status === 413 || big.status === 405, `container: a request body is refused (${big.status})`);
          check(run('docker', ['exec', name, 'id', '-u']).out.trim() === '101', 'container: the process runs as uid 101');
          check(!run('docker', ['exec', name, 'sh', '-c', 'touch /should-not-work']).ok, 'container: the root filesystem is read-only');
          await waitFor(() => run('docker', ['inspect', '--format', '{{.State.Health.Status}}', name]).out.trim() === 'healthy', 60_000, 'HEALTHCHECK to pass', 2000);
          check(true, 'container: the HEALTHCHECK reports healthy');
          const stop = Date.now();
          run('docker', ['stop', '-t', '15', name]);
          check(Date.now() - stop < 12_000, 'container: stops promptly on SIGTERM');
        } catch (e) { check(false, 'container answers', `${e.message}\n${tail(run('docker', ['logs', name]).out, 15)}`); }
      }
      run('docker', ['rm', '-f', name]);
    }
  }

  // ---------------------------------------------------------------- browser suite
  section('Playwright (desktop 1280, phone 390) against the built app and the mock gateway');
  if (skipE2e) skip('browser suite', '--skip-e2e');
  else {
    const out = run('docker', ['run', '--rm', '--ipc=host', '-v', `${app}:/app`, '-v', `${nm}:/app/node_modules`, '-w', '/app', '-e', 'CI=1', '-e', 'NO_COLOR=1', PLAYWRIGHT,
      'npx', 'playwright', 'test', '--reporter=line'], { timeout: 25 * 60_000 });
    const passedN = /(\d+) passed/.exec(out.out);
    const failedN = /(\d+) failed/.exec(out.out);
    const skippedN = /(\d+) skipped/.exec(out.out);
    check(out.ok && passedN && !failedN, `playwright: ${passedN ? passedN[1] : 0} passed, ${failedN ? failedN[1] : 0} failed${skippedN ? `, ${skippedN[1]} skipped by design` : ''}`, tail(out.out, 60));
    versions.e2e = passedN?.[1];
  }
} catch (e) {
  check(false, `aborted: ${e.message}`);
} finally {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* best effort */ } }
  if (scratch && !flags.has('--keep')) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a locked file on Windows: the OS temp cleaner takes it */ } }
  else if (scratch) console.log(`\nkept: ${scratch}`);
}

process.exit(r.finish(`resolved versions: ${JSON.stringify(versions)}`));
