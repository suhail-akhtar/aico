#!/usr/bin/env node
/**
 * Dynamic security tests: start the REAL engine (`node dist/index.js serve`)
 * in a throwaway store and attack it over HTTP, the way a page in the
 * person's browser, another local process, or a model that learned the token
 * would (ADR 0026).
 *
 * Unit tests prove a guard does what its author meant on the inputs its
 * author thought of. This proves the assembled server holds on the inputs an
 * attacker would send: every route without the token, with a foreign Origin,
 * with a rebinding Host; traversal in every file-serving parameter; oversized
 * and malformed bodies; URLs pointed at loopback and metadata; human-only
 * decisions attempted with the token alone; and planted canary secrets
 * hunted for in every response, the event stream and every file the server
 * wrote. The route list comes from the source (scripts/lib/api-routes.mjs),
 * so a route added tomorrow is attacked tomorrow.
 *
 * Every FAIL is a finding. A confirmed finding that cannot be fixed in the
 * same change may be recorded in scripts/security/dast-known.json (id, reason,
 * status: open); it then prints as KNOWN and does not fail the run — and stops
 * being excused the moment the attack no longer succeeds (it prints FIXED so
 * the entry is removed). Nothing else is ever excused.
 *
 * Offline, free, deterministic (seeded fuzz), < 2 minutes. Needs `npm run
 * build` first. Never touches ~/.aico: AICO_HOME is a temp directory, removed
 * afterwards; the vault uses the passphrase key provider off Windows so no OS
 * keyring is written.
 *
 *   node scripts/security-dast.mjs [--verbose] [--keep]
 */

import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractRoutes } from './lib/api-routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const entry = path.join(repo, 'dist', 'index.js');
const verbose = process.argv.includes('--verbose');
const keep = process.argv.includes('--keep');
const started = Date.now();

if (!fs.existsSync(entry)) { console.error('security-dast: dist/index.js missing — run `npm run build` first'); process.exit(2); }

// ── the throwaway world ──────────────────────────────────────────────────────

const world = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-dast-'));
const home = path.join(world, 'home', '.aico');
const project = path.join(world, 'project');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'README.md'), '# dast project\n');
/** A credentials file in the project: the file viewer (editor/file) must never return it. */
const DOTENV_MARK = `DOTENV-${crypto.randomBytes(8).toString('hex')}`;
fs.writeFileSync(path.join(project, '.env'), `TOKEN=${DOTENV_MARK}\n`);

/** A file outside the project that no route may ever return. */
const OUTSIDE_MARK = `OUTSIDE-${crypto.randomBytes(8).toString('hex')}`;
const outsideFile = path.join(world, 'outside-secret.txt');
fs.writeFileSync(outsideFile, OUTSIDE_MARK);

/** Canary secrets: assembled at runtime, unique per run, obviously fake. */
const tag = crypto.randomBytes(12).toString('hex');
const CANARY = {
  providerKey: ['sk', 'or', 'v1', `dastcanary${tag}${'0'.repeat(20)}`].join('-'),
  instanceKey: `dast-instance-canary-${tag}`,
  envToken: `dast-env-canary-${tag}`,
  mcpKey: `dast-mcp-canary-${tag}`,
  hookToken: `dast-hook-canary-${tag}`,
  vault: `dast-vault-canary-${tag}`,
};
const canaryValues = Object.values(CANARY);
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
  provider: 'openrouter',
  model: 'deepseek/deepseek-v4-flash',
  providers: { openrouter: { apiKey: CANARY.providerKey } },
  providerInstances: [{ id: 'dast', type: 'openai', name: 'DAST', baseUrl: 'http://127.0.0.1:9/v1', apiKey: CANARY.instanceKey }],
  env: { DAST_SERVICE_TOKEN: CANARY.envToken },
  mcpServers: { dastmcp: { command: 'node', args: ['-e', '0'], env: { API_KEY: CANARY.mcpKey }, disabled: true } },
  hooks: { PreToolUse: [{ matcher: 'NeverMatches', command: `echo ${CANARY.hookToken}` }] },
  autoApprove: false,
}, null, 2));

// ── results ──────────────────────────────────────────────────────────────────

const known = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, 'security/dast-known.json'), 'utf8')); } catch { return []; } })();
const results = [];
let sectionAt = Date.now();
function section(title) {
  if (verbose) console.log(`  (${((Date.now() - sectionAt) / 1000).toFixed(1)}s)`);
  sectionAt = Date.now();
  console.log(`\n── ${title} ──`);
}
function check(id, pass, detail = '') {
  const k = known.find(x => x.id === id);
  const status = pass ? (k ? 'FIXED' : 'PASS') : (k ? 'KNOWN' : 'FAIL');
  results.push({ id, status, detail: String(detail).slice(0, 300) });
  if (verbose || status !== 'PASS') console.log(`  ${status.padEnd(5)} ${id}${detail && status !== 'PASS' ? ` — ${String(detail).slice(0, 300)}` : ''}`);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

let port = 0; let token = ''; let uiKey = '';
const sseBuffers = [];

/** Raw request: we choose every header, including Host. */
function request({ method = 'GET', pathname = '/', headers = {}, body, timeout = 15_000, host = '127.0.0.1', toPort = port }) {
  return new Promise(resolve => {
    // What arrived before a deadline still counts: an event stream never ends,
    // and its first frames are exactly where a leaked secret would be.
    const chunks = [];
    let status = -1;
    const req = http.request({ host, port: toPort, method, path: pathname, headers, timeout }, res => {
      status = res.statusCode;
      let size = 0;
      res.on('data', c => { size += c.length; if (size < 4 * 1024 * 1024) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve({ status: 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: status === -1 ? -1 : status, timedOut: true, text: Buffer.concat(chunks).toString('utf8') || 'timeout' }); });
    req.on('error', err => resolve({ status: 0, text: String(err.code ?? err.message) }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const H = (extra = {}) => ({ host: `127.0.0.1:${port}`, 'x-aico-token': token, ...extra });
const api = (route, { method = 'GET', query = '', json, headers = {}, raw, timeout } = {}) => request({
  method, timeout,
  pathname: `/api/${route}${query ? `?${query}` : ''}`,
  headers: { ...H(headers), ...(json !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: raw ?? (json !== undefined ? JSON.stringify(json) : undefined),
});

const allResponses = [];
function remember(where, r) { allResponses.push({ where, text: r.text ?? '' }); return r; }

const STACK = /\n\s+at [\w.<>]+ \(|\bat (?:async )?[\w.]+ \([^)]*:\d+:\d+\)/;
function leaksInternals(text) {
  if (!text) return null;
  if (STACK.test(text)) return 'stack trace';
  const t = text.replace(/\\\\/g, '\\');
  for (const p of [world, home, project, os.homedir(), repo]) {
    if (p && (t.includes(p) || t.toLowerCase().includes(p.toLowerCase()))) return `absolute path ${path.basename(p)}`;
  }
  return null;
}

// ── start the engine ─────────────────────────────────────────────────────────

const logFile = path.join(world, 'serve.log');
const env = { ...process.env, AICO_HOME: home, AICO_DISABLE_UPDATE_CHECK: '1', CI: '1' };
for (const k of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY']) delete env[k];
if (process.platform !== 'win32') env.AICO_VAULT_KEY_PROVIDER = 'passphrase';
const out = fs.openSync(logFile, 'a');
const proc = spawn(process.execPath, [entry, 'serve', '--no-open', '--port', '0'], { cwd: project, env, stdio: ['ignore', out, out], windowsHide: true });

function stop() {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGKILL');
  } catch { /* already gone */ }
}
process.on('exit', stop);

await new Promise((resolve, reject) => {
  const deadline = Date.now() + 60_000;
  const poll = setInterval(() => {
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)#ui=([A-Za-z0-9_-]+)/.exec(text);
    if (m) { clearInterval(poll); port = Number(m[1]); token = m[2]; uiKey = m[3]; resolve(); }
    else if (proc.exitCode !== null || Date.now() > deadline) { clearInterval(poll); reject(new Error(`engine did not start:\n${text.slice(-800)}`)); }
  }, 200);
}).catch(err => { console.error(`security-dast: ${err.message}`); stop(); process.exit(2); });

console.log(`security-dast: engine up on 127.0.0.1:${port} (store ${path.basename(world)})`);

// A session the stream and session routes can name.
const SESSION = `dast-${tag.slice(0, 8)}`;

// ── 1. authentication on every route ─────────────────────────────────────────

const routes = extractRoutes(repo).map(r => (r.prefix ? `${r.route}x` : r.route));
routes.push('definitely-not-a-route');
section(`1. token and Origin on ${routes.length} routes`);
for (const route of routes) {
  for (const method of ['GET', 'POST']) {
    const none = await request({ method, pathname: `/api/${route}`, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    check(`auth:no-token ${method} ${route}`, none.status === 401, `status ${none.status}`);
    const wrong = await request({ method, pathname: `/api/${route}?token=${'A'.repeat(32)}`, headers: { host: `127.0.0.1:${port}`, 'x-aico-token': token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A') }, body: method === 'POST' ? '{}' : undefined });
    check(`auth:wrong-token ${method} ${route}`, wrong.status === 401, `status ${wrong.status}`);
  }
  const foreign = await request({ method: 'POST', pathname: `/api/${route}`, headers: H({ origin: 'http://evil.example', 'content-type': 'application/json' }), body: '{}' });
  check(`origin:foreign POST ${route}`, foreign.status === 403, `status ${foreign.status}`);
}

// ── 2. Origin and Host tricks ────────────────────────────────────────────────

section('2. Origin / Host (DNS rebinding)');
for (const origin of ['null', `http://127.0.0.1:${port}.evil.example`, `http://127.0.0.1:${port}0`, `http://localhost:${port}@evil.example`, `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`, `http://127.0.0.1.evil.example:${port}`]) {
  const r = await request({ pathname: '/api/sessions', headers: H({ origin }) });
  check(`origin:${origin}`, r.status === 403, `status ${r.status}`);
}
for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
  const r = await request({ pathname: '/api/sessions', headers: H({ origin }) });
  check(`origin:control own ${origin} accepted`, r.status === 200, `status ${r.status}`);
}
for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.nip.io:${port}`, `localhost.evil.example:${port}`]) {
  const withToken = await request({ pathname: '/api/sessions', headers: H({ host }) });
  check(`host:${host} refused on /api`, withToken.status === 403 || withToken.status === 421 || withToken.status === 400, `status ${withToken.status}`);
  const page = await request({ pathname: '/', headers: { host } });
  check(`host:${host} refused on the static client`, page.status === 403 || page.status === 421 || page.status === 400, `status ${page.status}`);
}
// An SSH port-forward: a loopback Host on another port. Served with the token
// when the Origin is absent or names that same host; nothing else changes.
{
  const fwd = `localhost:${port + 11}`;
  const ok = await request({ pathname: '/api/sessions', headers: H({ host: fwd }) });
  check(`host:forwarded ${fwd} with the token accepted`, ok.status === 200, `status ${ok.status}`);
  const same = await request({ pathname: '/api/sessions', headers: H({ host: fwd, origin: `http://${fwd}` }) });
  check(`host:forwarded ${fwd} with its own Origin accepted`, same.status === 200, `status ${same.status}`);
  const noToken = await request({ pathname: '/api/sessions', headers: { host: fwd } });
  check(`host:forwarded ${fwd} without the token refused`, noToken.status === 401, `status ${noToken.status}`);
  for (const origin of [`http://127.0.0.1:${port}`, 'http://evil.example', `http://${fwd}.evil.example`, `https://${fwd}`]) {
    const r = await request({ pathname: '/api/sessions', headers: H({ host: fwd, origin }) });
    check(`host:forwarded ${fwd} with Origin ${origin} refused`, r.status === 403, `status ${r.status}`);
  }
}

// ── 3. CSRF-shaped requests ──────────────────────────────────────────────────

section('3. CSRF simple requests');
for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
  const r = await request({ method: 'POST', pathname: '/api/submit', headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.example', 'content-type': ct }, body: 'sessionId=x&text=hi' });
  check(`csrf:${ct.split(';')[0]} without token`, r.status === 401 || r.status === 403, `status ${r.status}`);
}
{
  const r = await request({ method: 'POST', pathname: `/api/submit?token=${token}`, headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.example', 'content-type': 'text/plain' }, body: '{"sessionId":"x","text":"hi"}' });
  check('csrf:token in query + foreign Origin', r.status === 403, `status ${r.status}`);
  const r2 = await api('permission', { method: 'POST', json: { sessionId: SESSION, id: 'p1', allow: true }, headers: { 'sec-fetch-site': 'cross-site', 'x-aico-ui-key': uiKey } });
  check('csrf:cross-site permission allow refused even with the UI key', r2.status === 403, `status ${r2.status}`);
}

// ── 4. path traversal ────────────────────────────────────────────────────────

section('4. path traversal');
const rel = path.relative(project, outsideFile);
const traversal = [
  rel, rel.replace(/\\/g, '/'), `../${path.basename(outsideFile)}`, `..\\${path.basename(outsideFile)}`,
  encodeURIComponent(`../${path.basename(outsideFile)}`), `..%252f${path.basename(outsideFile)}`, `%2e%2e%2f${path.basename(outsideFile)}`,
  outsideFile, outsideFile.replace(/\\/g, '/'), `file:///${outsideFile.replace(/\\/g, '/')}`,
  process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd',
  `\\\\127.0.0.1\\${outsideFile.replace(':', '$')}`, '....//....//outside-secret.txt',
];
const fileRoutes = [
  ['attachments/file', v => `session=${SESSION}&id=${encodeURIComponent(v)}`],
  ['attachments/file', v => `session=${encodeURIComponent(v)}&id=x`],
  ['artifacts/file', v => `session=${SESSION}&path=${encodeURIComponent(v)}`],
  ['artifacts/preview', v => `session=${SESSION}&path=${encodeURIComponent(v)}`],
  ['apps/file', v => `slug=${encodeURIComponent(v)}&path=x`],
  ['apps/file', v => `slug=dast&path=${encodeURIComponent(v)}`],
  ['changes/diff', v => `id=${SESSION}&path=${encodeURIComponent(v)}`],
  ['session', v => `id=${encodeURIComponent(v)}`],
  ['session/export', v => `id=${encodeURIComponent(v)}&format=md`],
  ['trajectory', v => `id=${encodeURIComponent(v)}`],
  ['canvas/get', v => `session=${SESSION}&id=${encodeURIComponent(v)}`],
  ['editor/file', v => `path=${encodeURIComponent(project)}&file=${encodeURIComponent(v)}`],
  ['editor/file', v => `file=${encodeURIComponent(v)}`],
  ['editor/file', v => `path=${encodeURIComponent(v)}&file=README.md`],
];
let traversalLeaks = 0;
for (const [route, q] of fileRoutes) {
  for (const v of traversal) {
    const r = remember(`${route}?${v}`, await api(route, { query: q(v) }));
    const leaked = r.text.includes(OUTSIDE_MARK) || /\[fonts\]|root:x:0:0/.test(r.text);
    if (leaked) traversalLeaks++;
    check(`traversal:${route} ${q(v).slice(0, 60)}`, !leaked && r.status !== 500, `status ${r.status}${leaked ? ' — returned a file outside the project' : ''}`);
  }
}
{
  const env = await api('editor/file', { query: `path=${encodeURIComponent(project)}&file=.env` });
  check('editor/file: a credentials file in the project is not shown', !env.text.includes(DOTENV_MARK) && env.status === 403, `status ${env.status}`);
  const ok = await api('editor/file', { query: `path=${encodeURIComponent(project)}&file=README.md` });
  check('editor/file: control — a project file is shown (the refusals are not vacuous)', ok.status === 200 && ok.text.includes('dast project'), `status ${ok.status}`);
}
for (const raw of [`/api/deck-media/..%2f..%2f${path.basename(outsideFile)}`, `/api/deck-media/${encodeURIComponent(outsideFile)}`]) {
  const r = await request({ pathname: raw, headers: H() });
  check(`traversal:${raw.slice(0, 50)}`, !r.text.includes(OUTSIDE_MARK), `status ${r.status}`);
}
for (const raw of ['/../outside-secret.txt', '/%2e%2e/outside-secret.txt', '/..%5coutside-secret.txt', '/%2e%2e%2f%2e%2e%2fpackage.json', '/..%2f..%2fpackage.json', '//etc/passwd', `/${outsideFile.replace(/\\/g, '/')}`]) {
  const r = await request({ pathname: raw, headers: { host: `127.0.0.1:${port}` } });
  check(`traversal:static ${raw}`, !r.text.includes(OUTSIDE_MARK) && !/"name":\s*"@suhail-akhtar\/aico"/.test(r.text) && !/root:x:0:0/.test(r.text), `status ${r.status}`);
}
// Session ids reach file paths (session/persistence eventLogPath): writing routes must refuse traversal ids.
for (const id of ['../../dast-escape', '..\\..\\dast-escape', `${world}${path.sep}dast-abs`]) {
  await api('session/rename', { method: 'POST', json: { sessionId: id, title: 'x' } });
  const escaped = fs.readdirSync(world).concat(fs.readdirSync(path.dirname(home))).some(n => /dast-escape|dast-abs/.test(n))
    || fs.existsSync(path.join(world, 'dast-abs.events.jsonl'));
  check(`traversal:session id ${id} creates nothing outside the sessions folder`, !escaped, 'a *.events.jsonl appeared outside the store');
}

// ── 5. bodies ────────────────────────────────────────────────────────────────

section('5. oversized and malformed bodies');
{
  const big = Buffer.alloc(60 * 1024 * 1024, 0x61);
  const r = await request({ method: 'POST', pathname: '/api/session/rename', headers: H({ 'content-type': 'application/json' }), body: big, timeout: 60_000 });
  check('body:60 MB to a JSON route is refused with 413/400', r.status === 413 || r.status === 400 || r.status === 0, `status ${r.status}`);
  let alive = { status: 0 };
  for (let i = 0; i < 5 && alive.status !== 200; i++) { alive = await api('sessions'); if (alive.status !== 200) await new Promise(r => setTimeout(r, 500)); }
  check('body:server alive after a 60 MB body', alive.status === 200, `status ${alive.status}`);
  for (const route of ['session/rename', 'settings', 'canvas/create', 'vault/create', 'submit', 'permission']) {
    const m = remember(`malformed ${route}`, await api(route, { method: 'POST', raw: '{"a": [1, 2,,, }' }));
    check(`body:malformed JSON on ${route} → 400`, m.status === 400, `status ${m.status} ${m.text.slice(0, 80)}`);
    const leak = leaksInternals(m.text);
    check(`body:malformed JSON on ${route} leaks nothing`, !leak, leak);
  }
}

// ── 6. SSRF ──────────────────────────────────────────────────────────────────

section('6. SSRF');
const captured = [];
const capture = http.createServer((req, res) => {
  captured.push({ url: req.url, auth: String(req.headers.authorization ?? '') + String(req.headers['x-api-key'] ?? '') });
  if (req.url?.startsWith('/redirect')) { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}');
});
await new Promise(r => capture.listen(0, '127.0.0.1', r));
const capPort = capture.address().port;
{
  // The stored key must never be sent to a URL the caller picked.
  captured.length = 0;
  const r = remember('providers/test', await api('providers/test', { method: 'POST', json: { type: 'openrouter', baseUrl: `http://127.0.0.1:${capPort}/api/v1` } }));
  const exfil = captured.some(c => c.auth.includes(CANARY.providerKey));
  check('ssrf:providers/test never sends the stored key to a caller-chosen baseUrl', !exfil, `status ${r.status}; capture server received the stored key in ${captured.length} request(s)`);
  for (const target of [
    `http://127.0.0.1:${port}/api/sessions`, `http://[::1]:${port}/`, `http://2130706433:${port}/`, `http://0x7f.1:${port}/`,
    `http://0177.0.0.1:${port}/`, 'http://169.254.169.254/latest/meta-data/', `http://127.0.0.1:${capPort}/redirect`, 'http://metadata.google.internal/',
  ]) {
    captured.length = 0;
    const brand = remember(`deck/brand ${target}`, await api('deck/brand', { method: 'POST', json: { url: target } }));
    check(`ssrf:deck/brand ${target}`, captured.length === 0 && !/"colors"\s*:\s*\[\s*"/.test(brand.text) && brand.status !== -1, `status ${brand.status}; ${captured.length} request(s) reached the target`);
    captured.length = 0;
    const place = await api('deck/images/place', { method: 'POST', json: { session: SESSION, url: target, candidate: { url: target, full: target } } });
    check(`ssrf:deck/images/place ${target}`, captured.length === 0 && place.status !== -1, `status ${place.status}; ${captured.length} request(s) reached the target`);
  }
}

// ── 7. human-only decisions with the token alone ─────────────────────────────

section('7. human-gated routes with only the token');
{
  const humanOnly = [
    ['permission', { sessionId: SESSION, id: 'p1', allow: true }],
    ['inbox/decide', { id: 'x', decision: 'approve', approve: true }],
    ['longjob/decide', { id: 'x', decision: 'approve' }],
    ['learning/preferences/act', { id: 'x', action: 'activate' }],
    ['skills/install', { name: 'x', enable: true }],
    ['settings', { autoApprove: true }],
    ['settings', { sandbox: { mode: 'danger-full-access' } }],
    ['settings', { sentinel: { mode: 'off' } }],
    ['settings', { hooks: { PreToolUse: [{ matcher: '.*', command: 'echo pwned' }] } }],
    ['editor/open', { path: project, file: 'README.md', line: 1 }],
    ['delivery/dispatch', { project, action: 'start' }],
    ['delivery/tasks/00000000/approve', { project }],
    ['delivery/tasks/00000000/request-changes', { project, comment: 'no' }],
    ['delivery/tasks/00000000/comment', { project, text: 'no' }],
    ['delivery/approve-batch', { project, ids: ['00000000'] }],
    ['delivery/releases', { project }],
    ['delivery/releases/1.0.0/deploy', { project }],
    ['delivery/releases/1.0.0/rollback', { project }],
  ];
  for (const [route, body] of humanOnly) {
    const r = remember(`human ${route}`, await api(route, { method: 'POST', json: body }));
    const applied = r.status === 200 && !/human-required|needs a person/i.test(r.text);
    check(`human:${route} ${JSON.stringify(body).slice(0, 60)} refused without a person`, !applied, `status ${r.status} ${r.text.slice(0, 120)}`);
  }
  const settingsNow = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  check('human:no weakening setting reached settings.json', settingsNow.autoApprove !== true && settingsNow.sandbox?.mode !== 'danger-full-access', JSON.stringify({ autoApprove: settingsNow.autoApprove, sandbox: settingsNow.sandbox }));
  const control = await api('permission', { method: 'POST', json: { sessionId: SESSION, id: 'nope', allow: true }, headers: { 'x-aico-ui-key': uiKey } });
  check('human:control — the UI key is accepted (the refusals above are not vacuous)', control.status === 200, `status ${control.status}`);
  const no = await api('permission', { method: 'POST', json: { sessionId: SESSION, id: 'nope', allow: false } });
  check('human:a "no" needs only the token', no.status === 200, `status ${no.status}`);
  for (const [route, body] of [['vault/reveal', { id: 'x' }], ['vault/export', { passphrase: 'whatever-long' }], ['vault/grant', { action: 'reveal', passphrase: 'wrong passphrase' }], ['vault/delete', { id: 'x' }]]) {
    const r = await api(route, { method: 'POST', json: body });
    check(`human:${route} without a grant refused`, r.status !== 200, `status ${r.status}`);
  }
}

// ── 8. secrets never leave ───────────────────────────────────────────────────

section('8. canary secrets in responses, the stream and the store');
{
  // A vault credential (best effort: needs a key provider on this OS).
  if (process.platform !== 'win32') await api('vault/unlock', { method: 'POST', json: { passphrase: `dast passphrase ${tag}` } });
  const created = await api('vault/create', { method: 'POST', json: { name: 'dast-canary', kind: 'api-token', secret: { token: CANARY.vault } } });
  const vaultPlanted = created.status === 200;
  if (!vaultPlanted) console.log(`  note  vault canary not planted (status ${created.status}: ${created.text.slice(0, 120)}) — vault leg not tested`);

  // Open the session's stream while the GETs run.
  const sse = http.request({ host: '127.0.0.1', port, path: `/api/events?session=${SESSION}&token=${token}`, headers: { host: `127.0.0.1:${port}` } }, res => res.on('data', c => sseBuffers.push(String(c))));
  sse.on('error', () => {});
  sse.end();

  const queries = { session: SESSION, id: SESSION, project: project, path: project, slug: 'dast', sessionId: SESSION, name: 'dast-canary' };
  const qs = new URLSearchParams(queries).toString();
  // Some GETs reach out (provider catalogues, model probes); a short deadline
  // keeps the sweep fast — a request that times out returned nothing to leak.
  const slow = [];
  for (const route of routes) {
    for (const query of ['', qs]) {
      const t0 = Date.now();
      const r = remember(`GET ${route}${query ? '?q' : ''}`, await api(route, { query, timeout: 2500 }));
      if (r.status === -1 || Date.now() - t0 > 2000) slow.push(route);
    }
  }
  if (verbose && slow.length) console.log(`  note  slow GETs (deadline hit): ${[...new Set(slow)].join(', ')}`);
  for (const r of ['settings', 'providers', 'system', 'vault/list', 'vault/status', 'vault/get', 'vault/audit', 'vault/match', 'mcp/validate', 'custom-tools']) {
    remember(`GET ${r}`, await api(r, { query: qs }));
  }
  await new Promise(r => setTimeout(r, 1500));
  sse.destroy();

  for (const [name, value] of Object.entries(CANARY)) {
    if (name === 'vault' && !vaultPlanted) continue;
    const hits = allResponses.filter(x => x.text.includes(value)).map(x => x.where);
    check(`secrets:${name} in no HTTP response`, hits.length === 0, `found in: ${hits.slice(0, 6).join(', ')}`);
    check(`secrets:${name} not on the event stream`, !sseBuffers.join('').includes(value));
  }
  // Every file the server wrote, except the two places a secret is meant to live.
  const allowed = new Set([path.join(home, 'settings.json')]);
  const leaks = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (allowed.has(p) || /[\\/]vault[\\/]/.test(p)) continue;
      let text = '';
      try { text = fs.readFileSync(p).toString('latin1'); } catch { continue; }
      for (const [name, value] of Object.entries(CANARY)) if (text.includes(value)) leaks.push(`${name} in ${path.relative(home, p)}`);
    }
  };
  walk(home);
  for (const [name, value] of Object.entries(CANARY)) {
    const vaultFiles = [];
    const v = path.join(home, 'vault');
    if (fs.existsSync(v)) for (const f of fs.readdirSync(v)) { try { if (fs.readFileSync(path.join(v, f)).toString('latin1').includes(value)) vaultFiles.push(f); } catch { /* unreadable */ } }
    if (name === 'vault' && vaultPlanted) check('secrets:vault canary is not stored in plaintext in the vault', vaultFiles.length === 0, vaultFiles.join(', '));
  }
  const log = fs.readFileSync(logFile, 'utf8');
  for (const [name, value] of Object.entries(CANARY)) if (log.includes(value)) leaks.push(`${name} in the server's console output`);
  check('secrets:no canary in any file under AICO_HOME or the server log', leaks.length === 0, leaks.slice(0, 8).join('; '));
}

// ── 9. fuzz ──────────────────────────────────────────────────────────────────

section('9. seeded fuzz (no 5xx that leaks internals; server stays up)');
{
  let seed = 0x5eed;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const value = depth => {
    const k = rnd();
    if (depth > 2 || k < 0.2) return pick([null, true, false, 0, -1, 1e308, NaN, '', 'x'.repeat(Math.floor(rnd() * 5000)), '../../../etc/passwd', '\u0000', '<script>alert(1)</script>', '${process.exit()}', SESSION]);
    if (k < 0.5) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth + 1));
    const o = {};
    for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) o[pick(['id', 'sessionId', 'session', 'path', 'name', 'url', 'type', 'kind', 'action', 'value', 'body', 'text', '__proto__', 'constructor', 'prototype', 'title', 'slug'])] = value(depth + 1);
    return o;
  };
  // Routes that start model turns or long processes are auth-tested above, not fuzzed.
  const SKIP = /^(?:submit|steer|followup|goal|answer|edit|brief\/|profile\/|apps\/run|miniapps\/run|apps\/deploy|apps\/create|skill-eval\/run|skill-eval\/optimize|models\/probe|provider-test|providers\/test|providers\/models|deck\/images\/search|chat\/handoff|mcp\/reload|mcp\/add|project\/git-action|vault\/lock|agents\/resume|longjob\/control|recall\/)/;
  let fuzzed = 0; const bad = [];
  for (const route of routes.filter(r => !SKIP.test(r))) {
    for (let i = 0; i < 5; i++) {
      const body = JSON.stringify(value(0)).replace(/"__proto__"/g, '"__proto__"');
      const r = await api(route, { method: 'POST', raw: body });
      fuzzed++;
      if (r.status >= 500) {
        const leak = leaksInternals(r.text);
        if (leak) bad.push(`${route} → ${r.status} (${leak})`);
      }
      if (r.status === -1) bad.push(`${route} → timeout`);
    }
    const g = await api(route, { query: `id=${encodeURIComponent(String(value(3)))}&path=%00&session=${'%'.repeat(3)}` });
    fuzzed++;
    if (g.status >= 500 && leaksInternals(g.text)) bad.push(`GET ${route} → ${g.status} (${leaksInternals(g.text)})`);
  }
  check(`fuzz:${fuzzed} requests — no 5xx with a stack trace or an absolute path, no hang`, bad.length === 0, bad.slice(0, 10).join('; '));
  const alive = await api('sessions');
  check('fuzz:server still answering', alive.status === 200, `status ${alive.status}`);
  check('fuzz:Object.prototype not polluted (server still refuses a bad token)', (await request({ pathname: '/api/sessions', headers: { host: `127.0.0.1:${port}` } })).status === 401);
}

// ── report ───────────────────────────────────────────────────────────────────

section('done');
capture.close();
stop();
const count = s => results.filter(r => r.status === s).length;
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nsecurity-dast: ${results.length} checks in ${secs}s — PASS ${count('PASS')}, FAIL ${count('FAIL')}, KNOWN ${count('KNOWN')}, FIXED ${count('FIXED')}`);
if (count('FIXED')) console.log('  FIXED entries: the attack no longer works — remove them from scripts/security/dast-known.json.');
if (keep) console.log(`  kept: ${world}`);
else { try { fs.rmSync(world, { recursive: true, force: true }); } catch { /* the engine may still hold a file for a moment */ } }
process.exit(count('FAIL') ? 1 : 0);
