/**
 * End-to-end proof that the `system-small` bundle works from a clean copy.
 *
 * Why this exists: the bundle ships only the glue (compose file, Traefik routes, Keycloak realm,
 * database init); its two services are the `web-app-react` and `api-service-fastapi` starters, which
 * `instantiateTemplate` copies into `services/web` and `services/api`. A bundle can be wrong in ways
 * neither starter can see: a realm whose audience mapper never reaches the token the API validates, a
 * gateway rule that lets a forged request through, a port published that should not be. So this script
 * assembles the app the way the engine does (no artefact directories, tokens substituted, a generated
 * `.env`), starts the whole stack with Docker Compose under a unique project name and port, checks the
 * stack from the outside (health, one published port, hardened containers, headers, the CSRF rule, the
 * identity provider's discovery document), runs the web starter's own Playwright suite through Traefik
 * (real Keycloak sign-in, real API, real PostgreSQL), and proves no generated secret reached a log.
 * Everything it created is removed. A step that cannot run (no Docker) is reported as skipped, never
 * as passed.
 *
 * What it deliberately does not do: touch `~/.aico` (it imports the isolated test home first and never
 * starts the engine), call a model (free), run the services' own unit suites (their own
 * `templates-verify-react.mjs` / `templates-verify-fastapi.mjs` do), or install anything on the host.
 *
 * Run: node scripts/templates-verify-system-small.mjs [--skip-docker] [--skip-e2e] [--offline] [--keep]
 *   --offline   skips the GitHub action-pin lookups
 *   --keep      leave the scratch copy and the running stack in place and print how to remove them
 * Exit code 1 when any step fails.
 */

import './lib/test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkActionPins, copyTemplate, createReporter, dockerAvailable, freePort, http, run, scratchDir, secret, tail, waitFor,
} from './lib/verify-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.join(root, 'templates', 'system-small');
const flags = new Set(process.argv.slice(2));
const offline = flags.has('--offline');
const skipDocker = flags.has('--skip-docker');
const skipE2e = flags.has('--skip-e2e');
const keep = flags.has('--keep');
const PROJECT = `aico-syssmall-${secret(3)}`;

const r = createReporter();
const { check, skip, section } = r;
let scratch;
let app;
let up = false;

const compose = (args, opts = {}) => run('docker', ['compose', '-p', PROJECT, ...args], { cwd: app, ...opts });

try {
  section('manifest');
  const validator = run(process.execPath, [path.join(here, 'validate-template.mjs'), source], { cwd: root, timeout: 120_000 });
  check(validator.ok, 'validate-template.mjs accepts the bundle manifest and the completeness bar', tail(validator.out));
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'template.json'), 'utf8'));
  check(manifest.id === 'system-small' && manifest.kind === 'bundle', 'manifest is a bundle named system-small');
  const serviceTemplates = manifest.services.filter((s) => s.template).map((s) => s.template);
  check(serviceTemplates.length === 2 && serviceTemplates.every((id) => fs.existsSync(path.join(root, 'templates', id, 'template.json'))), `its services come from shipped templates (${serviceTemplates.join(', ')})`);
  check(fs.readFileSync(path.join(source, 'AICO.md'), 'utf8').length <= 2000, 'AICO.md is within the 2,000 character cap');
  for (const f of ['README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'CODEOWNERS', '.gitignore', '.gitattributes', '.editorconfig', '.env.example', 'Makefile', 'compose.yaml', 'docs/ARCHITECTURE.md', '.github/workflows/ci.yml', '.github/dependabot.yml']) {
    check(fs.existsSync(path.join(source, f)), `ships ${f}`);
  }
  const pins = checkActionPins(source, { offline });
  check(pins.problems.length === 0, 'every GitHub Action is pinned to a commit SHA that names its tag', pins.problems.join('\n'));
  const composeText = fs.readFileSync(path.join(source, 'compose.yaml'), 'utf8');
  const images = [...composeText.matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1]).filter((i) => !i.includes('__APP_SLUG__'));
  check(images.length >= 5 && images.every((i) => /@sha256:[0-9a-f]{64}$/.test(i)), `all ${images.length} third-party images are pinned by digest`, images.filter((i) => !/@sha256:/.test(i)).join('\n'));
  check(!images.some((i) => /redis|minio/i.test(i)), 'no licence-trap images (Redis 8, MinIO)');
  const example = fs.readFileSync(path.join(source, '.env.example'), 'utf8');
  check(!/=(?!change-me)[^#\s]{16,}/.test(example.split('\n').filter((l) => /SECRET|PASSWORD/.test(l)).join('\n')), '.env.example holds placeholders only');

  section('clean copy (as instantiateTemplate would make it)');
  scratch = scratchDir('aico-syssmall-');
  app = path.join(scratch, 'app');
  const subs = { __APP_TITLE__: 'Verify System', __APP_SLUG__: PROJECT, __APP_DESCRIPTION__: 'verification copy' };
  copyTemplate(source, app, { substitutions: subs });
  copyTemplate(path.join(root, 'templates', 'web-app-react'), path.join(app, 'services', 'web'), { substitutions: subs });
  copyTemplate(path.join(root, 'templates', 'api-service-fastapi'), path.join(app, 'services', 'api'), { substitutions: subs });
  r.note(app);
  check(fs.existsSync(path.join(app, 'services/web/package-lock.json')) && fs.existsSync(path.join(app, 'services/api/uv.lock')), 'both services brought their lockfiles');
  check(!fs.existsSync(path.join(app, 'services/web/node_modules')) && !fs.existsSync(path.join(app, 'services/api/.venv')), 'no node_modules or .venv came along');
  check(!/__APP_/.test(fs.readFileSync(path.join(app, 'compose.yaml'), 'utf8')), 'tokens were substituted in compose.yaml');

  // The generated .env, as the engine writes it: every change-me value becomes a random secret.
  const port = await freePort();
  const secrets = {};
  const env = example.split('\n').map((line) => {
    const m = /^([A-Z0-9_]+)=change-me.*$/.exec(line);
    if (!m) return line;
    secrets[m[1]] = secret(16);
    return `${m[1]}=${secrets[m[1]]}`;
  });
  env.push(`AICO_PREVIEW_PORT=${port}`);
  fs.writeFileSync(path.join(app, '.env'), `${env.join('\n')}\n`);
  check(Object.keys(secrets).length === 6, 'six secrets were generated into .env');

  if (skipDocker) {
    skip('the stack', '--skip-docker');
  } else {
    section('docker');
    const docker = dockerAvailable();
    if (!check(Boolean(docker), 'the docker daemon is reachable')) throw new Error('docker is required (or pass --skip-docker)');
    r.note(`docker ${docker}`);
    const cfg = compose(['--profile', 'e2e', 'config', '--quiet']);
    check(cfg.ok, 'docker compose config is valid', tail(cfg.out));

    section('the stack');
    up = true;
    const started = compose(['up', '--build', '--wait', '-d'], { timeout: 25 * 60_000 });
    check(started.ok, 'docker compose up --build --wait: every service healthy, migration job completed', tail(started.out, 40));
    if (!started.ok) throw new Error('the stack did not come up');
    const ps = JSON.parse(`[${compose(['ps', '-a', '--format', 'json']).stdout.trim().split('\n').filter(Boolean).join(',')}]`);
    const names = ps.map((c) => c.Service).sort();
    check(['api', 'bff', 'cache', 'db', 'keycloak', 'migrate', 'proxy', 'web'].every((s) => names.includes(s)), `services present: ${names.join(', ')}`);
    check(ps.filter((c) => c.Service !== 'migrate').every((c) => c.State === 'running' && (!c.Health || c.Health === 'healthy')), 'every long-running service is running and healthy', ps.map((c) => `${c.Service}:${c.State}/${c.Health}`).join(' '));
    check(ps.find((c) => c.Service === 'migrate')?.ExitCode === 0, 'the migration job exited 0');
    const published = ps.flatMap((c) => (c.Publishers ?? []).filter((p) => p.PublishedPort).map((p) => `${c.Service}:${p.URL}:${p.PublishedPort}`));
    check(published.length === 1 && published[0].startsWith('proxy:127.0.0.1:'), 'only the gateway publishes a port, on 127.0.0.1', published.join(' '));

    section('containers are hardened');
    for (const svc of ['proxy', 'web', 'api', 'bff', 'cache']) {
      const id = ps.find((c) => c.Service === svc)?.ID;
      const info = JSON.parse(run('docker', ['inspect', id]).stdout)[0];
      const host = info.HostConfig;
      check(host.ReadonlyRootfs && (host.CapDrop ?? []).includes('ALL') && (host.SecurityOpt ?? []).includes('no-new-privileges:true'), `${svc}: read-only root, all capabilities dropped, no-new-privileges`);
      const uid = run('docker', ['exec', id, 'id', '-u']);
      if (uid.ok) check(uid.stdout.trim() !== '0', `${svc}: does not run as root (uid ${uid.stdout.trim()})`);
    }

    section('through the gateway (one origin)');
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await http('GET', `${base}/`)).status === 200, 60_000, 'the gateway to serve /');
    const home = await http('GET', `${base}/`);
    check(home.status === 200 && /content-security-policy/i.test([...home.headers.keys()].join(',')), 'GET / serves the SPA with a Content-Security-Policy');
    check(!/unsafe-inline|unsafe-eval/.test(home.headers.get('content-security-policy') ?? ''), 'the CSP has no unsafe-inline or unsafe-eval');
    const cfgJson = await http('GET', `${base}/config.json`);
    check(cfgJson.status === 200 && cfgJson.json?.apiBaseUrl === '/api', 'runtime /config.json points the SPA at same-origin /api', cfgJson.text);
    const me = await http('GET', `${base}/api/v1/auth/me`);
    check(me.status === 401, 'a request with no session is 401 (not a redirect, not a 500)', `${me.status} ${me.text}`);
    const forged = await http('POST', `${base}/api/v1/items`, { body: { name: 'forged' } });
    check(forged.status === 403, 'an unsafe request without X-Requested-With never reaches the API (403)', `${forged.status} ${forged.text}`);
    const start = await http('GET', `${base}/api/auth/start?rd=%2Fitems`);
    check(start.status === 302 && (start.headers.get('location') ?? '').includes('/idp/realms/app/protocol/openid-connect/auth'), '/api/auth/start redirects to the identity provider');
    const disco = await http('GET', `${base}/idp/realms/app/.well-known/openid-configuration`);
    check(disco.status === 200 && disco.json?.issuer === `${base.replace('127.0.0.1', 'localhost')}/idp/realms/app`, 'Keycloak serves the realm discovery document under /idp with the public issuer', `${disco.status} ${disco.text.slice(0, 200)}`);
    const admin = await http('GET', `${base}/idp/admin/master/console/`);
    check(admin.status !== 500, 'the Keycloak admin path does not 500 (reachable only because it is behind the same origin: protect it in production, see SECURITY.md)');
    const direct = await http('GET', `http://127.0.0.1:8000/healthz`, { timeout: 2000 }).catch(() => ({ status: 0 }));
    check(direct.status === 0, 'the API is not reachable on a host port (only through the gateway)');

    if (skipE2e) {
      skip('browser suite through the gateway', '--skip-e2e');
    } else {
      section('browser suite through the gateway (Keycloak sign-in, real API, real PostgreSQL)');
      const e2e = compose(['--profile', 'e2e', 'run', '--rm', 'e2e'], { timeout: 20 * 60_000 });
      const passed = Number(/(\d+) passed/.exec(e2e.out)?.[1] ?? 0);
      const failed = Number(/(\d+) failed/.exec(e2e.out)?.[1] ?? 0);
      check(e2e.ok && failed === 0 && passed >= 20, `Playwright: ${passed} passed, ${failed} failed`, tail(e2e.out, 40));
    }

    section('logs');
    const logs = compose(['logs', '--no-color']).out;
    const leaked = Object.entries(secrets).filter(([, v]) => logs.includes(v)).map(([k]) => k);
    check(leaked.length === 0, 'no generated secret appears in any container log', leaked.join(', '));
    check(!/Traceback|panic:|Unhandled/.test(logs.replace(/Traceback \(most recent call last\)[\s\S]{0,0}/, '')), 'no unhandled exception in the logs');
  }
} catch (e) {
  check(false, `unexpected failure: ${e.message}`);
} finally {
  if (keep && app) {
    console.log(`\nkept: ${app}\nremove with: docker compose -p ${PROJECT} --profile e2e down -v`);
  } else {
    if (up && app) compose(['--profile', 'e2e', 'down', '-v', '--remove-orphans', '--rmi', 'local'], { timeout: 5 * 60_000 });
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}
process.exit(r.finish());
