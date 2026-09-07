/**
 * Deploy, against a real server: the refusal without Docker, the build with it.
 *
 * Creates a static app from the landing template on a scratch store and asks
 * the server to deploy it. Without Docker on this machine the answer must be a
 * plain 400 naming the missing tool and nothing started; with Docker, the
 * deploy record must move from `working` to `done` and the output must show
 * the build. The second half is skipped cleanly — reported, not failed — when
 * Docker is absent, so the probe passes on every machine and says which half
 * it proved.
 *
 * Run: npm run build && node scripts/apps-deploy-live.mjs
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const entry = path.join(root, 'dist', 'index.js');

let passed = 0, failed = 0, skipped = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

if (!fs.existsSync(entry)) { console.error(`\nNo build at ${entry}. Run: npm run build\n`); process.exit(1); }

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-deploy-live-'));
const workspace = path.join(workdir, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const settingsFile = path.join(process.env.AICO_HOME, 'settings.json');
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
settings.workspace = { ...(settings.workspace ?? {}), path: workspace };
settings.miniApps = { ...(settings.miniApps ?? {}), enabled: true };
delete settings.projects;
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

const dockerHere = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', shell: process.platform === 'win32' }).status === 0;

let server;
function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}
function startServe() {
  return new Promise((resolve, reject) => {
    const logFile = path.join(workdir, 'serve.log');
    const out = fs.openSync(logFile, 'a');
    const proc = spawn(process.execPath, [entry, 'serve', '--no-open'], { cwd: workdir, stdio: ['ignore', out, out], env: { ...process.env } });
    const deadline = Date.now() + 90_000;
    const poll = setInterval(() => {
      const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(text);
      if (match) { clearInterval(poll); resolve({ proc, token: match[2], port: Number(match[1]) }); }
      else if (Date.now() > deadline) { clearInterval(poll); reject(new Error(`server never became ready:\n${text.slice(-500)}`)); }
    }, 500);
  });
}
async function api(route, init = {}) {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/${route}`, {
    ...init, headers: { 'x-aico-token': server.token, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const post = (route, body) => api(route, { method: 'POST', body: JSON.stringify(body) });

try {
  server = await startServe();
  const made = await post('apps/create', { template: 'landing-static', title: 'Launch Site', install: false });
  check(made.status === 200 && made.json?.slug === 'launch-site', 'a static app is created from the landing template');
  const slug = made.json?.slug ?? 'launch-site';

  console.log('\n-- the refusals --');
  const unknown = await post('apps/deploy', { slug, target: 'kubernetes' });
  check(unknown.status === 404 && /No deploy target "kubernetes"/.test(unknown.json?.error ?? ''), 'an unknown target is a 404 that lists the real ones');
  const missing = await post('apps/deploy', { slug: 'no-such-app' });
  check(missing.status === 404, 'an unknown app is a 404');

  if (!dockerHere) {
    console.log('\n-- without Docker: a plain answer, nothing started --');
    const r = await post('apps/deploy', { slug });
    check(r.status === 400 && r.json?.reason === 'missing' && (r.json?.missing ?? []).includes('docker'), `the deploy is refused naming docker (${r.text.slice(0, 80)})`);
    const state = await api(`apps/deploy?slug=${slug}`);
    check(state.status === 200 && state.json?.deploy === null, 'and no deploy record exists');
    skipped++;
    console.log('  – Docker is not available here; the build half of this probe is skipped.');
  } else {
    console.log('\n-- with Docker: the image builds --');
    const r = await post('apps/deploy', { slug });
    check(r.status === 200 && r.json?.deploy?.state === 'working', `the deploy starts (${r.text.slice(0, 60)})`);
    const deadline = Date.now() + 10 * 60_000;
    let rec = r.json?.deploy;
    while (rec && rec.state === 'working' && Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 2000));
      rec = (await api(`apps/deploy?slug=${slug}`)).json?.deploy;
    }
    check(rec?.state === 'done', `the deploy finishes (${rec?.state}${rec?.error ? `: ${rec.error}` : ''})`);
    check((rec?.output ?? []).some(l => /Built\. Run it with|docker run/.test(l)), 'and the script printed the run command');
    const again = await post('apps/deploy', { slug });
    check(again.status === 200, 'a second deploy after the first finished is allowed');
    spawnSync('docker', ['rmi', '-f', slug], { shell: process.platform === 'win32' });
  }
} catch (err) {
  failed++; fails.push(err instanceof Error ? err.message : String(err)); console.error(err);
} finally {
  if (server) killPid(server.proc.pid);
  await new Promise(r => setTimeout(r, 500));
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ }
}

console.log(`\napps deploy: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} half skipped (no Docker)` : ''}`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(failed ? 1 : 0);
