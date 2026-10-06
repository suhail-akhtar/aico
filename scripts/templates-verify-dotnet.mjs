/**
 * Proves the api-service-dotnet starter end to end with the real .NET SDK and Docker.
 *
 * Why this exists: a starter is a promise that what it copies in builds, passes its own gate and runs today.
 * `scripts/templates-live.mjs` (the rot check) is Node-only and silently skips every template without a
 * package.json, and `npm test` only checks that the manifest is well formed. This script is the .NET
 * counterpart: it copies the template to a scratch directory exactly as the engine does (artefact
 * directories skipped, `substitute` tokens replaced, `.env.local` written with random secrets), then runs
 * the commands the manifest itself declares, so a typo in `template.json` fails here and not in a user's app.
 *
 * What it runs, in order, and what each proves:
 *   manifest        scripts/validate-template.mjs accepts it; AICO.md fits the inlined cap; required files exist
 *   restore         `dotnet restore --locked-mode`: packages.lock.json matches the projects
 *   typecheck       run.typecheck (`dotnet build -warnaserror`, every analyzer an error)
 *   format / lint   run.format and run.lint (`dotnet format --verify-no-changes`)
 *   test            run.test, then the coverage gate (85 % lines) and a negative control: the same gate set to
 *                   100 % must FAIL, otherwise the gate is decoration
 *   audit           run.audit (NuGet Audit re-run) and `dotnet list package --vulnerable --include-transitive`;
 *                   negative control: a copy with a package that has a known high advisory must FAIL the audit
 *   sbom            CycloneDX document of what ships
 *   dev             run.dev on a free port: the `ready` regex matches, /healthz answers, the seeded demo user logs in
 *   postgres        (Docker) the whole suite against a real PostgreSQL 18 (TEST_POSTGRES=1)
 *   container       (Docker) image builds, compose migrates PostgreSQL and serves, scripts/smoke.sh passes,
 *                   the process is non-root, `docker stop` exits 0
 *   makefile        (Docker) `make -n check` parses in a container, since this machine may lack make
 *
 * What it deliberately does not do: touch ~/.aico (it imports nothing from the engine, so it needs no
 * AICO_HOME), change anything in the template directory (everything happens in a scratch copy), push an
 * image anywhere, or spend money. Network is required (NuGet, container registries).
 *
 * Run: node scripts/templates-verify-dotnet.mjs [--skip-docker] [--skip-postgres] [--keep]
 */

import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import net from 'net';
import path from 'path';
import fs from 'fs';
import os from 'os';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const templateDir = path.join(root, 'templates', 'api-service-dotnet');
const args = new Set(process.argv.slice(2));
const skipDocker = args.has('--skip-docker');
const skipPostgres = args.has('--skip-postgres') || skipDocker;
const keep = args.has('--keep');

const manifest = JSON.parse(fs.readFileSync(path.join(templateDir, 'template.json'), 'utf8'));
const SLUG = 'dotnet-verify';
const TITLE = 'Dotnet Verify';
const results = [];
let failed = 0;

function check(ok, label, detail) {
  results.push({ ok, label });
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n${indent(detail)}` : ''}`);
  return ok;
}
function indent(text) { return String(text).split('\n').map(l => `      ${l}`).join('\n'); }
function tail(text, n = 25) { return String(text ?? '').trim().split('\n').slice(-n).join('\n'); }
function section(name) { console.log(`\n-- ${name} --`); }

/** Same tokenizer as the engine's splitCommand: quotes group, no pipes, no chaining. */
function split(command) {
  const tokens = [];
  let cur = '', quote = null, has = false;
  for (const ch of command) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) tokens.push(cur); cur = ''; has = false; }
    else cur += ch;
  }
  if (cur || has) tokens.push(cur);
  return tokens;
}

/** Run a manifest command the way the engine spawns it (shell only on Windows). */
function runCommand(command, cwd, env = {}, timeoutMs = 15 * 60_000) {
  const [exe, ...rest] = split(command);
  const r = spawnSync(exe, rest, {
    cwd, encoding: 'utf8', shell: process.platform === 'win32', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', ...env },
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, status: r.status };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function copyTemplate(dest) {
  const skip = new Set(['bin', 'obj', 'artifacts', 'TestResults', 'data', '.vs', '.idea', 'node_modules']);
  fs.cpSync(templateDir, dest, {
    recursive: true,
    filter: (p) => {
      const name = path.basename(p);
      if (skip.has(name)) return false;
      if (name === 'template.json') return false; // the engine never copies it
      if (name === '.env' || name === '.env.local') return false;
      return true;
    },
  });
}

/** What instantiateTemplate does to the copy: substitute tokens in the listed files, write .env.local with random secrets. */
function instantiate(dir) {
  for (const rel of manifest.substitute ?? []) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) { check(false, `substitute file exists: ${rel}`); continue; }
    const text = fs.readFileSync(file, 'utf8')
      .replaceAll('__APP_TITLE__', TITLE).replaceAll('__APP_SLUG__', SLUG).replaceAll('__APP_DESCRIPTION__', 'Verification copy');
    fs.writeFileSync(file, text);
  }
  const example = fs.readFileSync(path.join(dir, manifest.envFile.example), 'utf8');
  const env = example.split('\n').map(line => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(change-me.*)$/);
    return m ? `${m[1]}=${crypto.randomBytes(24).toString('hex')}` : line;
  }).join('\n');
  fs.writeFileSync(path.join(dir, manifest.envFile.file), env);
  return Object.fromEntries(env.split('\n').filter(l => /^[A-Za-z_]\w*=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

function findShell() {
  for (const candidate of ['sh', 'bash']) {
    const r = spawnSync(candidate, ['-c', 'command -v curl >/dev/null && echo yes'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.includes('yes')) return candidate;
  }
  return null;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } }
}

async function waitFor(fn, ms, stepMs = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, stepMs));
  }
  return null;
}

const scratchRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-dotnet-verify-'));
const work = path.join(scratchRoot, 'app');
const cleanups = [];
const started = Date.now();

try {
  section('toolchain');
  const sdk = spawnSync('dotnet', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const sdkVersion = sdk.stdout?.trim() ?? '';
  console.log(`  dotnet SDK ${sdkVersion}`);
  if (!check(/^10\./.test(sdkVersion), '.NET 10 SDK is available')) throw new Error('no .NET 10 SDK');
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const haveDocker = !skipDocker && docker.status === 0;
  console.log(haveDocker ? `  docker ${docker.stdout.trim()}` : '  docker not used (missing or --skip-docker): container, postgres and makefile checks skipped');

  section('manifest');
  copyTemplate(work);
  const secrets = instantiate(work);
  const v = spawnSync(process.execPath, [path.join(here, 'validate-template.mjs'), templateDir], { encoding: 'utf8' });
  check(v.status === 0, 'scripts/validate-template.mjs accepts the manifest', tail(`${v.stdout}${v.stderr}`));
  for (const rel of ['AICO.md', 'README.md', 'docs/EXTENDING.md', 'docs/ARCHITECTURE.md', 'docs/RELEASING.md', '.aico/backlog.md', '.aico/decisions.md',
    '.gitignore', '.gitattributes', '.editorconfig', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'CODEOWNERS',
    '.github/workflows/ci.yml', '.github/dependabot.yml', '.pre-commit-config.yaml', 'Dockerfile', 'compose.yaml', '.dockerignore', '.env.example', 'Makefile',
    'src/ApiService/packages.lock.json', 'tests/ApiService.Tests/packages.lock.json', 'tests/ApiService.Tests/Snapshots/openapi.v1.json']) {
    check(fs.existsSync(path.join(templateDir, rel)), `ships ${rel}`);
  }
  const aico = fs.readFileSync(path.join(templateDir, 'AICO.md'), 'utf8');
  check(aico.length <= 2000, `AICO.md is ${aico.length} characters (cap 2,000)`);
  check(/- \[x\]/.test(fs.readFileSync(path.join(templateDir, '.aico/backlog.md'), 'utf8')), 'backlog has a ticked story');
  const leftovers = [];
  for (const f of fs.readdirSync(work, { recursive: true })) {
    const p = path.join(work, String(f));
    if (!fs.statSync(p).isFile() || /[\\/](\.git|bin|obj)[\\/]/.test(p) || p.endsWith('.png')) continue;
    if (/__APP_(TITLE|SLUG|DESCRIPTION)__/.test(fs.readFileSync(p, 'utf8'))) leftovers.push(path.relative(work, p));
  }
  check(leftovers.length === 0, 'no substitution token is left in a file the manifest does not list', leftovers.join(', '));
  const lockLf = !fs.readFileSync(path.join(templateDir, 'Makefile'), 'utf8').includes('\r');
  check(lockLf, 'Makefile has LF line endings');

  section('restore (locked)');
  const tools = runCommand('dotnet tool restore', work);
  check(tools.ok, 'dotnet tool restore', tail(tools.out));
  const restore = runCommand('dotnet restore ApiService.slnx --locked-mode', work);
  check(restore.ok, 'dotnet restore --locked-mode (lockfiles match the projects)', tail(restore.out));

  section('typecheck, format, lint (commands from template.json)');
  const run = manifest.run;
  for (const key of ['typecheck', 'format', 'lint']) {
    const r = runCommand(run[key], work);
    check(r.ok, `run.${key}: ${run[key]}`, tail(r.out));
  }

  section('test and coverage gate');
  const test = runCommand(run.test, work);
  const summary = test.out.match(/total: (\d+)[\s\S]*?failed: (\d+)[\s\S]*?succeeded: (\d+)[\s\S]*?skipped: (\d+)/);
  check(test.ok && summary && Number(summary[2]) === 0, `run.test: ${summary ? `${summary[1]} total, ${summary[3]} passed, ${summary[4]} skipped, ${summary[2]} failed` : 'no summary'}`, tail(test.out));
  const covArgs = (threshold) => `dotnet test --solution ApiService.slnx --results-directory artifacts/coverage-${threshold} --coverlet --coverlet-include [ApiService]* --coverlet-exclude-by-file **/Migrations/**/*.cs --coverlet-output-format cobertura --coverlet-threshold ${threshold} --coverlet-threshold-type line --coverlet-threshold-stat total`;
  const cov = runCommand(covArgs(85), work);
  check(cov.ok, 'coverage gate at 85 % lines passes', tail(cov.out));
  const xml = fs.readdirSync(path.join(work, 'artifacts', 'coverage-85')).find(f => f.endsWith('.xml'));
  if (xml) {
    const rate = Number(fs.readFileSync(path.join(work, 'artifacts', 'coverage-85', xml), 'utf8').match(/<coverage[^>]*line-rate="([\d.]+)"/)?.[1]);
    console.log(`  line coverage ${(rate * 100).toFixed(1)} %`);
    check(rate >= 0.85, `measured line coverage ${(rate * 100).toFixed(1)} % >= 85 %`);
  } else check(false, 'cobertura report was written');
  const gate = runCommand(covArgs(100), work);
  check(!gate.ok, 'negative control: the same gate at 100 % FAILS (the gate is real)', tail(gate.out, 8));

  section('audit');
  const audit = runCommand(run.audit, work);
  check(audit.ok, `run.audit: ${run.audit}`, tail(audit.out));
  const vuln = runCommand('dotnet list ApiService.slnx package --vulnerable --include-transitive', work);
  check(vuln.ok && !/has the following vulnerable packages/.test(vuln.out), 'dotnet list package --vulnerable --include-transitive: none', tail(vuln.out));
  const depr = runCommand('dotnet list ApiService.slnx package --deprecated', work);
  check(depr.ok && !/has the following deprecated packages/.test(depr.out), 'dotnet list package --deprecated: none', tail(depr.out));
  // Negative control in a second copy: a package with a known high advisory must fail the audit.
  const bad = path.join(scratchRoot, 'vulnerable');
  copyTemplate(bad);
  const props = path.join(bad, 'Directory.Packages.props');
  fs.writeFileSync(props, fs.readFileSync(props, 'utf8').replace('</Project>', '  <ItemGroup><PackageVersion Include="Newtonsoft.Json" Version="12.0.3" /></ItemGroup>\n</Project>'));
  const csproj = path.join(bad, 'src', 'ApiService', 'ApiService.csproj');
  fs.writeFileSync(csproj, fs.readFileSync(csproj, 'utf8').replace('</Project>', '  <ItemGroup><PackageReference Include="Newtonsoft.Json" /></ItemGroup>\n</Project>'));
  const badAudit = runCommand('dotnet restore src/ApiService/ApiService.csproj --force', bad);
  check(!badAudit.ok && /NU190[34]/.test(badAudit.out), 'negative control: a package with a high advisory FAILS the audit (NU1903/NU1904)', tail(badAudit.out, 8));

  section('sbom');
  const sbom = runCommand('dotnet tool run dotnet-cyclonedx src/ApiService/ApiService.csproj -o artifacts/sbom -F Json', work);
  check(sbom.ok, 'CycloneDX generated', tail(sbom.out));
  try {
    const bom = JSON.parse(fs.readFileSync(path.join(work, 'artifacts', 'sbom', 'bom.json'), 'utf8'));
    check(bom.bomFormat === 'CycloneDX' && bom.components.length > 50, `SBOM lists ${bom.components?.length} components`);
    check(!bom.components.some(c => /xunit|coverlet|Testcontainers/i.test(c.name)), 'SBOM is of what ships (no test packages)');
  } catch (e) { check(false, 'SBOM parses', String(e)); }

  section('dev run (run.dev, ready regex, health, demo login)');
  {
    const port = await freePort();
    const command = run.dev.replaceAll('{port}', String(port));
    const [exe, ...rest] = split(command);
    const env = { ...process.env, ...run.env, PORT: String(port), DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
    for (const k of Object.keys(env)) if (/_API_KEY$|^AICO_|TOKEN|SECRET|_KEY$|PASSWORD|CREDENTIAL/.test(k)) delete env[k]; // what the engine scrubs
    const child = spawn(exe, rest, { cwd: work, env, shell: process.platform === 'win32', detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    cleanups.push(() => killTree(child));
    const ready = await waitFor(() => new RegExp(run.ready).test(output), 120_000);
    check(!!ready, `output matches the ready regex /${run.ready}/`, tail(output));
    if (ready) {
      const base = `http://127.0.0.1:${port}`;
      const health = await waitFor(async () => (await fetch(`${base}${run.health}`)).status === 200, 20_000);
      check(!!health, `${run.health} answers 200 on the port the runner chose`);
      const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.test', password: secrets.Seed__DemoPassword }) });
      const loginBody = await login.text();
      check(login.status === 200, '.env.local secrets reach the app: the seeded demo user logs in', loginBody);
      const tokens = login.status === 200 ? JSON.parse(loginBody) : null;
      const items = tokens ? await fetch(`${base}/items`, { headers: { authorization: `Bearer ${tokens.access_token}` } }) : null;
      const page = items ? await items.json() : null;
      check(page?.items?.length === 3, 'the seeded items are listed for the demo user');
      const docs = await fetch(`${base}/scalar/v1`);
      check(docs.status === 200, 'interactive docs are served in Development');
    }
    killTree(child);
    await new Promise(r => setTimeout(r, 1500));
  }

  if (haveDocker && !skipPostgres) {
    section('postgres (whole suite against PostgreSQL 18 in a container)');
    const pg = runCommand(run.test, work, { TEST_POSTGRES: '1' }, 20 * 60_000);
    const s = pg.out.match(/total: (\d+)[\s\S]*?failed: (\d+)[\s\S]*?succeeded: (\d+)[\s\S]*?skipped: (\d+)/);
    check(pg.ok && s && Number(s[2]) === 0 && Number(s[4]) === 0, `TEST_POSTGRES=1: ${s ? `${s[3]} passed, ${s[4]} skipped, ${s[2]} failed` : 'no summary'} (0 skipped means the Postgres test ran)`, tail(pg.out));
  }

  if (haveDocker) {
    section('container (build, compose with PostgreSQL, smoke)');
    const project = `aicodnv${process.pid}`;
    const hostPort = await freePort();
    fs.writeFileSync(path.join(work, '.env'), `POSTGRES_PASSWORD=${crypto.randomBytes(12).toString('hex')}\nJwt__SigningKey=${crypto.randomBytes(36).toString('base64')}\nAPP_PORT=${hostPort}\n`);
    const compose = (...a) => spawnSync('docker', ['compose', '-p', project, ...a], { cwd: work, encoding: 'utf8', timeout: 20 * 60_000 });
    cleanups.push(() => { compose('down', '-v', '--remove-orphans'); spawnSync('docker', ['rmi', '-f', SLUG], { stdio: 'ignore' }); });
    const up = compose('up', '--build', '-d');
    check(up.status === 0, 'docker compose up --build (image builds with analyzers as errors, locked restore, chiseled runtime)', tail(`${up.stdout}${up.stderr}`));
    if (up.status === 0) {
      const base = `http://127.0.0.1:${hostPort}`;
      const ready = await waitFor(async () => (await fetch(`${base}/readyz`)).status === 200, 90_000, 1000);
      check(!!ready, '/readyz answers 200 (PostgreSQL migrated by the one-shot job, then served)', tail(compose('logs', '--no-color').stdout));
      const shell = findShell();
      if (shell) {
        const smoke = spawnSync(shell, ['scripts/smoke.sh', base], { cwd: work, encoding: 'utf8', timeout: 5 * 60_000 });
        check(smoke.status === 0, 'scripts/smoke.sh passes against the container', tail(`${smoke.stdout}${smoke.stderr}`, 40));
        console.log(indent(tail(smoke.stdout, 30)));
      } else check(false, 'scripts/smoke.sh needs sh and curl on PATH');
      const apiId = compose('ps', '-q', 'api').stdout.trim();
      const inspect = spawnSync('docker', ['inspect', apiId, '--format', '{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{.State.Health.Status}}'], { encoding: 'utf8' });
      const [user, readonly, health] = inspect.stdout.trim().split('|');
      check(user && user !== '0' && user !== 'root', `container runs as non-root (uid ${user})`);
      check(readonly === 'true', 'root filesystem is read-only');
      await waitFor(() => spawnSync('docker', ['inspect', apiId, '--format', '{{.State.Health.Status}}'], { encoding: 'utf8' }).stdout.trim() === 'healthy', 60_000, 1000);
      const healthNow = spawnSync('docker', ['inspect', apiId, '--format', '{{.State.Health.Status}}'], { encoding: 'utf8' }).stdout.trim();
      check(healthNow === 'healthy', `HEALTHCHECK (the app probing itself, no curl in the image) reports ${healthNow}`);
      const size = Number(spawnSync('docker', ['image', 'inspect', SLUG, '--format', '{{.Size}}'], { encoding: 'utf8' }).stdout.trim());
      console.log(`  image size ${(size / 1e6).toFixed(0)} MB`);
      const t0 = Date.now();
      compose('stop', 'api');
      const code = spawnSync('docker', ['inspect', apiId, '--format', '{{.State.ExitCode}}'], { encoding: 'utf8' }).stdout.trim();
      check(code === '0', `docker stop shuts down gracefully (exit ${code} in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }

    section('makefile (parsed in a container: this machine may not have make)');
    const mk = spawnSync('docker', ['run', '--rm', '-v', `${work}:/w`, '-w', '/w', 'alpine:3.22', 'sh', '-c', 'apk add --no-cache make >/dev/null && make -n check && make help'], { encoding: 'utf8', timeout: 5 * 60_000 });
    check(mk.status === 0 && /dotnet format/.test(mk.stdout) && /dotnet test/.test(mk.stdout), 'make -n check and make help parse and expand to the dotnet commands', tail(`${mk.stdout}${mk.stderr}`));
  }
} catch (e) {
  check(false, `aborted: ${e instanceof Error ? e.message : e}`);
} finally {
  for (const c of cleanups.reverse()) { try { c(); } catch { /* best effort */ } }
  if (keep) console.log(`\nkept ${scratchRoot}`);
  else { try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ } }
}

const passed = results.filter(r => r.ok).length;
console.log(`\napi-service-dotnet: ${passed} passed, ${failed} failed in ${((Date.now() - started) / 1000).toFixed(0)} s`);
for (const r of results.filter(x => !x.ok)) console.log(`  ✗ ${r.label}`);
process.exit(failed ? 1 : 0);
