/**
 * The ops tools with a REAL model, end to end, fully local and isolated.
 *
 * Costs money (one model turn, a few cents on deepseek-v4-flash) — run only
 * when asked: `npm run build && npx tsup src/test-exports.ts --format esm
 * --outDir dist-test --target node22 --silent && node scripts/ops-live.mjs`.
 *
 * What it proves that the offline suite cannot: that a model, given only
 * credential NAMES, drives the tools to do a real setup — connect, create a
 * service user with a generated password it never sees, write its config,
 * verify, and call an API — through `aico serve` exactly as a client would,
 * with the approvals answered the way a person answers them (the grant
 * passphrase over /api/vault/approve), and that afterwards no secret is
 * anywhere it should not be.
 *
 * The "server" is scripts/lib/ssh-test-server.mjs: a real SSH server on
 * 127.0.0.1 whose commands run in a throwaway Alpine container
 * (`--network none`, removed at the end) when Docker and the image are
 * already present — never pulled — and in a local POSIX shell otherwise. The
 * API is a local HTTP server requiring a bearer token. The store is this
 * process's own AICO_HOME (settings.json copied in for the model's key).
 *
 * The canary scan decodes every file under AICO_HOME (session logs, spill
 * files, the work ledger, the vault's audit log, run logs, known_hosts), the
 * captured SSE stream and the server log, for every secret involved —
 * including the values the agent generated, which this script (as the owner)
 * reveals in memory after the run solely to search for them. Nothing is
 * printed but names, counts and verdicts.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import { testHome } from './lib/test-home.mjs';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { configureVault } from '../dist-test/test-exports.js';
import { startSshServer, localBackend, dockerBackend, sha256 } from './lib/ssh-test-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'index.js');
const MODEL = process.env.LIVE_MODEL || 'deepseek-v4-flash';
if (!fs.existsSync(entry)) { console.error('No build: run npm run build first.'); process.exit(1); }

let passed = 0; let failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

const SSH_PW = `Live-Ssh-${crypto.randomBytes(9).toString('base64url')}`;
const API_TOKEN = `Live-Api-${crypto.randomBytes(12).toString('base64url')}`;
const GRANT_PW = `Live-Grant-${crypto.randomBytes(9).toString('base64url')}`;

function encodingsOf(v) {
  const b = Buffer.from(v);
  return [v, b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), b.toString('hex'),
    encodeURIComponent(v), JSON.stringify(v).slice(1, -1)];
}
function leaks(text, canaries) {
  for (const c of canaries) {
    if (encodingsOf(c).some(e => text.includes(e))) return 'literal';
    for (const run of text.match(/[A-Za-z0-9+/_=-]{12,}/g) ?? []) {
      for (let skip = 0; skip < 4; skip++) {
        for (const alphabet of ['base64', 'base64url']) if (Buffer.from(run.slice(skip), alphabet).toString('latin1').includes(c)) return 'base64';
      }
    }
    for (const run of text.match(/(?:[0-9a-fA-F]{2}){8,}/g) ?? []) {
      for (const s of [run, run.slice(1)]) if (Buffer.from(s, 'hex').toString('latin1').includes(c)) return 'hex';
    }
    try { if (decodeURIComponent(text.replace(/\+/g, ' ')).includes(c)) return 'url-encoded'; } catch { /* malformed escapes */ }
  }
  return null;
}
const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];

// ── the "remote machine" and the API ─────────────────────────────────
const backend = dockerBackend('alpine:3.22') ?? localBackend();
if (!backend) { console.error('Neither Docker (with alpine:3.22 present) nor a POSIX shell is available.'); process.exit(1); }
console.log(`\n  remote machine: ${backend.kind}${backend.container ? ` (${backend.container}, --network none)` : ''}`);
const ssh = await startSshServer({ backend, users: { deploy: { password: SSH_PW } } });
ssh.env.FAKE_SUDO_SHA256 = sha256(SSH_PW);

const apiLog = [];
const services = [];
const api = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const authed = req.headers.authorization === `Bearer ${API_TOKEN}`;
  apiLog.push({ method: req.method, url: req.url, authed });
  res.setHeader('content-type', 'application/json');
  if (!authed) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
  if (req.url === '/api/services' && req.method === 'POST') {
    try { services.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { res.writeHead(400); res.end('{}'); return; }
    res.writeHead(201); res.end(JSON.stringify({ id: services.length, ...services.at(-1) })); return;
  }
  if (req.url === '/api/services') { res.end(JSON.stringify({ services })); return; }
  if (req.url === '/api/health') { res.end('{"status":"ok"}'); return; }
  res.writeHead(404); res.end('{}');
});
await new Promise(r => api.listen(0, '127.0.0.1', r));
const apiPort = api.address().port;

// ── the owner stores two credentials and a grant passphrase ─────────
let vault = configureVault({});
await vault.create({ name: 'test-box', kind: 'ssh-password', secret: { password: SSH_PW }, username: 'deploy', host: '127.0.0.1', createdBy: 'user', description: 'Test server (sudo with the same password).' });
await vault.create({ name: 'test-api', kind: 'api-token', secret: { token: API_TOKEN }, url: `http://127.0.0.1:${apiPort}`, createdBy: 'user', description: 'Inventory API.' });
vault.store.setGrantPassphrase(GRANT_PW);
vault.lock();
console.log(`  vault: ${vault.status().provider ?? 'default'} provider, 2 credentials, grant passphrase set`);

// ── aico serve, isolated ────────────────────────────────────────────
const serveLog = path.join(testHome, 'serve.log');
const out = fs.openSync(serveLog, 'a');
const proc = spawn(process.execPath, [entry, 'serve', '--no-open'], { cwd: testHome, stdio: ['ignore', out, out], env: { ...process.env } });
const server = await new Promise((resolve, reject) => {
  const deadline = Date.now() + 90_000;
  const t = setInterval(() => {
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(fs.readFileSync(serveLog, 'utf8'));
    if (m) { clearInterval(t); resolve({ port: Number(m[1]), token: m[2] }); }
    else if (Date.now() > deadline) { clearInterval(t); reject(new Error('serve never became ready')); }
  }, 300);
});
const base = `http://127.0.0.1:${server.port}/api`;
const H = { 'x-aico-token': server.token, 'content-type': 'application/json' };
console.log(`  aico serve on ${server.port}, AICO_HOME ${testHome}`);

const sessionId = `ops-live-${Date.now()}`;
const streamFile = path.join(testHome, 'stream-capture.txt');
const streamOut = fs.createWriteStream(streamFile);
let turnEnded = false;
const ac = new AbortController();
fetch(`${base}/events?session=${sessionId}`, { headers: H, signal: ac.signal }).then(async (res) => {
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = Buffer.from(value).toString('utf8');
    streamOut.write(text);
    if (/event: turn-end/.test(text)) turnEnded = true;
  }
}).catch(() => { /* aborted at the end */ });
await new Promise(r => setTimeout(r, 500));

// Answer approvals as the person would: read the description, then decide.
const approvals = [];
const poller = setInterval(async () => {
  try {
    const st = await (await fetch(`${base}/vault/status`, { headers: H })).json();
    for (const a of st.pendingApprovals ?? []) {
      if (approvals.some(x => x.id === a.id)) continue;
      const destructive = /DESTRUCTIVE/.test(a.description);
      approvals.push({ id: a.id, tool: a.tool, credential: a.credential?.name, description: a.description, answer: destructive ? 'declined' : 'approved' });
      await fetch(`${base}/vault/approve`, { method: 'POST', headers: H, body: JSON.stringify({ id: a.id, approve: !destructive, ...(destructive ? {} : { passphrase: GRANT_PW }) }) });
    }
  } catch { /* the server may be busy */ }
}, 400);

const task = [
  `You are operating my test server over SSH: host 127.0.0.1, port ${ssh.port}, stored credential "test-box" (user deploy; sudo works with the same credential).`,
  'Please:',
  '1. Create a system user "svcapp" and give it a strong generated password. Store that password in the vault as "svcapp-login" bound to host 127.0.0.1 — I never want to see it.',
  '2. Write its config file /srv/svcapp/app.env with APP_USER=svcapp, APP_PORT=8080 and APP_PASSWORD set to that same password. Only the svcapp user may read it (mode 600, owned by svcapp).',
  '3. Verify: the user exists, the file exists with mode 600 and owner svcapp, and the password in the file is the one the account really has — without revealing it.',
  `4. Register the service with my inventory API: POST http://127.0.0.1:${apiPort}/api/services with JSON {"name":"svcapp","host":"127.0.0.1","user":"svcapp"}, authenticating with the stored credential "test-api". Then GET the same URL to confirm it is listed.`,
  'Finish with a short handover: what you did, how you verified it, and which credential names hold which access.',
].join('\n');
const submitted = await fetch(`${base}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ sessionId, task, model: MODEL, approval: 'auto', project: testHome }) });
check(submitted.status === 202, `turn submitted (model ${MODEL})`);
const t0 = Date.now();
while (!turnEnded && Date.now() - t0 < 15 * 60_000) await new Promise(r => setTimeout(r, 1000));
clearInterval(poller);
check(turnEnded, `the turn ended (${Math.round((Date.now() - t0) / 1000)}s)`);
await new Promise(r => setTimeout(r, 1500));
ac.abort();
streamOut.end();

// ── what happened ────────────────────────────────────────────────────
const eventFiles = walk(path.join(testHome, 'projects')).filter(f => f.endsWith('.events.jsonl') && f.includes(sessionId));
const events = eventFiles.flatMap(f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })).filter(Boolean);
const calls = events.filter(e => e.type === 'tool/call');
console.log(`\n  tool calls (${calls.length}):`);
for (const c of calls) {
  const d = c.data ?? c;
  let args = {};
  try { args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : (d.arguments ?? {}); } catch { /* malformed */ }
  const brief = args.command ?? args.script ?? args.remote_path ?? args.url ?? args.name ?? '';
  console.log(`    ${d.name}${args.credential ? ` [cred ${args.credential}]` : ''}: ${String(brief).replace(/\s+/g, ' ').slice(0, 150)}`);
}
const finalText = events.filter(e => e.type === 'assistant/message').map(e => (e.data ?? e).content).filter(t => typeof t === 'string').join('\n');
console.log(`\n  approvals answered (${approvals.length}):`);
for (const a of approvals) console.log(`    ${a.answer}: ${a.description.slice(0, 260)}`);
const workLog = path.join(testHome, 'work.jsonl');
const ledgerLines = fs.existsSync(workLog) ? fs.readFileSync(workLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const opsRecords = ledgerLines.filter(e => e.t === 'add' && /^(Ssh|HttpRequest|WinRm|Snmp)/.test(e.record.title)).map(e => e.record);
const finalState = (id) => ledgerLines.filter(e => (e.t === 'patch' && e.id === id && e.patch.state)).map(e => e.patch.state).at(-1) ?? 'running';
console.log(`\n  ledger records for ops calls (${opsRecords.length}):`);
for (const r of opsRecords) console.log(`    ${r.id} [${finalState(r.id)}] ${r.title.slice(0, 150)}`);

const usedTools = new Set(calls.map(c => (c.data ?? c).name));
check(usedTools.has('SshExec'), 'the model used SshExec');
check(usedTools.has('CredentialGenerate'), 'the model generated the service password with CredentialGenerate');
check(usedTools.has('HttpRequest'), 'the model called the API with HttpRequest');
check(opsRecords.length >= 3 && opsRecords.every(r => /\[cred [\w-]+\]/.test(r.title)), 'every ops call is a ledger record naming its credential');
check(approvals.some(a => /FIRST CONNECTION/.test(a.description)), 'the first SSH connection was shown to a person with the host key fingerprint');

// ── independent verification of the result, as the owner ────────────
vault = configureVault({});
const creds = await vault.list({});
const svc = creds.find(c => c.name === 'svcapp-login');
check(Boolean(svc) && svc.createdBy.startsWith('agent:') && (svc.host === '127.0.0.1' || (svc.policy.allowedHosts ?? []).includes('127.0.0.1')), 'svcapp-login exists, created by the agent, bound to 127.0.0.1');
const secrets = [SSH_PW, API_TOKEN, GRANT_PW];
let svcPw;
if (svc) {
  const revealed = await vault.revealForOwner('svcapp-login', 'reveal', 'ops-live-verification');
  svcPw = Object.values(revealed.secret)[0];
  secrets.push(...Object.values(revealed.secret));
}
for (const c of creds.filter(c => c.createdBy.startsWith('agent:') && c.name !== 'svcapp-login')) {
  const r = await vault.revealForOwner(c.name, 'reveal', 'ops-live-verification');
  secrets.push(...Object.values(r.secret));
}
if (backend.kind === 'docker' && svcPw) {
  const sh = (script, input) => spawnSync('docker', ['exec', '-i', backend.container, 'sh', '-c', script], { input, encoding: 'utf8' });
  check(sh('id -u svcapp').status === 0, 'on the server: user svcapp exists');
  const st = sh("stat -c '%a %U' /srv/svcapp/app.env").stdout.trim();
  check(st === '600 svcapp', `on the server: /srv/svcapp/app.env is mode 600 owned by svcapp (${st || 'missing'})`);
  const envFile = sh('cat /srv/svcapp/app.env').stdout;
  check(new RegExp(`^APP_PASSWORD=["']?${svcPw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?$`, 'm').test(envFile) && /APP_USER=svcapp/.test(envFile), 'on the server: the config holds the generated password (compared in memory, not printed)');
  const shadowCheck = sh(`IFS= read -r p; h=$(grep '^svcapp:' /etc/shadow | cut -d: -f2); m=$(echo "$h" | cut -d'$' -f2); s=$(echo "$h" | cut -d'$' -f3);
    case "$m" in 1) a=md5;; 5) a=sha256;; 6) a=sha512;; *) echo NOHASH; exit 0;; esac;
    [ "$(cryptpw -m "$a" -S "$s" "$p")" = "$h" ] && echo MATCH || echo DIFFERENT`, `${svcPw}\n`).stdout.trim();
  check(shadowCheck === 'MATCH', `on the server: the account's real password is the generated one (${shadowCheck})`);
} else if (svcPw) {
  console.log('  (local backend: no real accounts; account checks skipped)');
}
check(services.some(s => s.name === 'svcapp') && apiLog.filter(l => l.url === '/api/services').every(l => l.authed), 'the API received the registration, authenticated');

// ── the canary scan ─────────────────────────────────────────────────
console.log(`\n  canary scan: ${secrets.length} secret values × every encoding`);
const files = walk(testHome).filter(f => !/[\\/]vault[\\/](vault|key)\.json$/.test(f) && !/[\\/]settings\.json$/.test(f));
let hits = 0;
const byKind = {};
for (const f of files) {
  const text = fs.readFileSync(f, 'latin1');
  const hit = leaks(text, secrets);
  const kind = /\.events\.jsonl$/.test(f) ? 'session event logs' : /spill/.test(f) ? 'spill files' : /work\.jsonl$/.test(f) ? 'work ledger'
    : /audit\.jsonl$/.test(f) ? 'vault audit log' : /stream-capture/.test(f) ? 'SSE stream capture' : /serve\.log$/.test(f) ? 'server log'
    : /[\\/]ops[\\/]/.test(f) ? 'ops files (known_hosts, run logs)' : 'other store files';
  byKind[kind] = (byKind[kind] ?? 0) + 1;
  if (hit) { hits++; console.log(`    HIT (${hit}) in ${path.relative(testHome, f)}`); }
}
for (const [k, n] of Object.entries(byKind)) console.log(`    ${k}: ${n} file(s)`);
check(hits === 0, `zero hits across ${files.length} files (sealed vault.json/key.json and the copied settings.json excluded)`);
check(!leaks(finalText, secrets) && !leaks(JSON.stringify(approvals), secrets), 'nor in the final answer or any approval text');
if (finalText) console.log(`\n  final answer (first 900 chars):\n${finalText.slice(0, 900).split('\n').map(l => `    ${l}`).join('\n')}`);

// ── cleanup ──────────────────────────────────────────────────────────
try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']); else proc.kill('SIGKILL'); } catch { /* gone */ }
await ssh.close();
api.close();
backend.close();
console.log(`\n${failed ? '✗' : '✓'} ops live: ${passed} passed, ${failed} failed`);
if (failed) for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(failed ? 1 : 0);
