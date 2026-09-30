/**
 * Live check of the credential scenario in the real desktop app, with a real
 * model (COSTS MONEY — run only when asked):
 *
 *   node scripts/vault-live.mjs <outDir>
 *
 *   b  a 0.28.0 browser password store is moved into the one vault
 *   a  the agent generates a portal's admin credential (CredentialGenerate);
 *      later "open the portal and sign in" → browser_login fills it from the
 *      vault; the local portal receives the right password; a canary scan of
 *      the store (session logs, audit, desktop logs), a transcript export, the
 *      event stream, the app renderer's DOM and storage, the main↔renderer IPC
 *      traffic and the app's console finds the value nowhere
 *   e  an agent click on "Place order" waits for the person's Allow
 *   c  CredentialRequest opens the secure prompt; a simulated person types a
 *      token into it and it is stored
 *   d  Credential Manager: add (secure prompt), reveal, rotate, delete, audit
 *
 * The human is simulated in main: native confirmations are answered by a
 * stand-in for `dialog.showMessageBox` (recording what was asked), the secure
 * prompt and the in-app purchase prompt are driven like any window. Uses an
 * isolated AICO_HOME with settings.json copied in (for the provider key).
 *
 * @module desktop/scripts/vault-live
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'aico-vault-live'));
fs.mkdirSync(outDir, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-vault-live-home-'));
const realSettings = path.join(os.homedir(), '.aico', 'settings.json');
if (fs.existsSync(realSettings)) fs.copyFileSync(realSettings, path.join(home, 'settings.json'));
console.log(`AICO_HOME=${home}`);

const results = [];
const check = (ok, label, detail) => { results.push({ ok: Boolean(ok), label, detail }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shot = async (page, name) => { const f = path.join(outDir, `vaultui-${name}.png`); await page.screenshot({ path: f }).catch(() => {}); console.log(`  shot ${f}`); };

// ── The portal and the shop (a local test server) ──
const portal = { expected: null, received: [], orders: [] };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const html = (body, title = 'Probe portal') => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><title>${title}</title><body style="font-family:sans-serif;padding:40px">${body}</body>`); };
  if (req.method === 'POST') {
    let buf = '';
    req.on('data', c => { buf += c; });
    req.on('end', () => {
      const f = new URLSearchParams(buf);
      if (url.pathname === '/login') {
        portal.received.push({ username: f.get('username'), password: f.get('password') });
        if (portal.expected && f.get('username') === 'admin' && f.get('password') === portal.expected) { res.writeHead(302, { location: '/dashboard' }); res.end(); return; }
        html('<h1>Sign in</h1><p style="color:red">Wrong username or password.</p><form method="post" action="/login"><input name="username" autocomplete="username"><input type="password" name="password" autocomplete="current-password"><button type="submit">Sign in</button></form>');
        return;
      }
      if (url.pathname === '/shop/placeOrder') { portal.orders.push(Date.now()); html('<h1>Order placed</h1><p>Thank you.</p>', 'Order placed'); return; }
      res.writeHead(404); res.end();
    });
    return;
  }
  if (url.pathname === '/login') return html('<h1>Probe portal — Sign in</h1><form method="post" action="/login"><label>Username <input name="username" autocomplete="username"></label><br><label>Password <input type="password" name="password" autocomplete="current-password"></label><br><button type="submit">Sign in</button></form>', 'Sign in');
  if (url.pathname === '/dashboard') return html('<h1>Welcome, admin</h1><p>Portal dashboard.</p>', 'Dashboard');
  if (url.pathname === '/shop/checkout') return html('<h1>Checkout</h1><h2>Order summary</h2><p>Probe widget — $12.00</p><form method="post" action="/shop/placeOrder"><button type="submit">Place order</button></form>', 'Checkout');
  res.writeHead(404); res.end('not found');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;
console.log(`portal at ${ORIGIN}`);

const exe = path.join(desktop, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const launch = async () => {
  const app = await electron.launch({ executablePath: exe, args: [desktop], env: { ...process.env, AICO_HOME: home }, timeout: 90_000 });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w?.unmaximize(); w?.setContentSize(1440, 900); }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 120_000 }).catch(() => {});
  return { app, page };
};

// ── Phase 0: a 0.28.0 password store, sealed with this app's own safeStorage ──
const LEGACY = [
  { id: 'p1', origin: 'https://github.com', username: 'probe-user', password: 'Legacy-Pw-Alpha-7731', created: 1, updated: 1 }, // standards-allow: secret
  { id: 'p2', origin: 'https://example.org', username: 'someone@example.org', password: 'Legacy-Pw-Bravo-2208', note: 'recovery code 1234-5678', created: 1, updated: 1 }, // standards-allow: secret
  { id: 'p3', origin: 'http://localhost:3000', username: '', password: 'Legacy-Pw-Charlie-9912', created: 1, updated: 1 }, // standards-allow: secret
];
{
  const { app } = await launch();
  const sealed = await app.evaluate(({ safeStorage }, data) => safeStorage.encryptString(data).toString('base64'), JSON.stringify({ v: 1, entries: LEGACY, never: ['https://never.example'] }));
  const dir = path.join(home, 'desktop', 'browser');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vault.bin'), Buffer.concat([Buffer.from('AICOVAULT1\n', 'utf8'), Buffer.from(sealed, 'base64')]));
  await app.close();
}

// ── Launch for real, with the simulated person and the IPC trace ──
const { app, page } = await launch();
const consoleLog = [];
page.on('console', m => consoleLog.push(`[${m.type()}] ${m.text()}`));
const mainOut = [];
app.process().stdout?.on('data', d => mainOut.push(String(d)));
app.process().stderr?.on('data', d => mainOut.push(String(d)));
await app.evaluate(({ dialog, ipcMain, BrowserWindow, app: eapp }) => {
  const g = globalThis.__probe = { boxes: [], reveals: [], ipc: [], next: [] };
  const orig = dialog.showMessageBox.bind(dialog);
  dialog.showMessageBox = async (a, b) => {
    const o = b ?? a;
    g.boxes.push({ title: o.title, message: o.message, buttons: o.buttons, detail: o.buttons?.[0] === 'Copy' ? '(value shown)' : o.detail });
    if (o.buttons?.[0] === 'Copy') { g.reveals.push(o.detail); return { response: 1, checkboxChecked: false }; }
    const r = g.next.length ? g.next.shift() : 0;
    return { response: r, checkboxChecked: false };
  };
  void orig;
  const wrap = (w) => {
    const wc = w.webContents;
    if (wc.__probeWrapped) return;
    wc.__probeWrapped = true;
    const send = wc.send.bind(wc);
    wc.send = (ch, ...args) => { try { g.ipc.push(JSON.stringify(['send', ch, args]).slice(0, 200_000)); } catch { /* unserialisable */ } return send(ch, ...args); };
  };
  BrowserWindow.getAllWindows().forEach(wrap);
  eapp.on('browser-window-created', (_e, w) => wrap(w));
  const handlers = ipcMain._invokeHandlers;
  if (handlers) {
    for (const [ch, fn] of [...handlers.entries()]) {
      handlers.set(ch, async (e, ...args) => {
        const r = await fn(e, ...args);
        try { g.ipc.push(JSON.stringify(['invoke', ch, args, r]).slice(0, 200_000)); } catch { /* unserialisable */ }
        return r;
      });
    }
  }
});
const probe = (fn, arg) => app.evaluate(fn, arg);
const invoke = (channel, ...args) => page.evaluate(([c, a]) => window.aicoDesktop.invoke(c, ...a), [channel, args]);
await sleep(1500);

// ── b: migration ──
{
  const migFile = path.join(home, 'desktop', 'browser', 'vault-migration.json');
  for (let i = 0; i < 60 && !fs.existsSync(migFile); i++) await sleep(1000);
  const report = fs.existsSync(migFile) ? JSON.parse(fs.readFileSync(migFile, 'utf8')) : null;
  check(report?.verified && report.created === 3 && report.found === 3, 'b: the 0.28.0 store (3 logins) moved into the vault, verified', JSON.stringify(report));
  check(!fs.existsSync(path.join(home, 'desktop', 'browser', 'vault.bin')) && fs.readdirSync(path.join(home, 'desktop', 'browser')).some(f => f.startsWith('vault.bin.migrated-')), 'b: the old file is kept as a backup beside itself');
  const list = await invoke('vault:list', { kind: 'login' });
  const gh = list.find(c => c.url === 'https://github.com');
  check(list.length >= 3 && gh && JSON.stringify(gh.policy.allowedOrigins) === '["https://github.com"]' && gh.policy.allowedTools.includes('browser_login'), 'b: logins bound to their exact origin, browser tools only', gh ? JSON.stringify(gh.policy) : 'missing');
  const notes = (await invoke('vault:list', { kind: 'note' }));
  check(notes.length === 1, 'b: the note became its own note credential');
  // Idempotent: a second run (e.g. after a crash) creates nothing.
  check((await invoke('vault:list')).length === 4, 'b: 3 logins + 1 note, nothing twice');
  await page.keyboard.press('Control+,');
  await sleep(800);
  await page.click('text=Credentials & passwords', { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  await shot(page, 'b-credential-manager-after-migration');
  await page.keyboard.press('Escape');
  await sleep(500);
}

// ── Helpers to talk to the agent in the UI ──
const ask = async (text, { timeoutMs = 240_000 } = {}) => {
  const box = page.locator('textarea').first();
  await box.click();
  await box.fill(text);
  await page.keyboard.press('Enter');
  await page.waitForSelector('button[aria-label="Stop"]', { timeout: 30_000 }).catch(() => {});
  await page.waitForSelector('button[aria-label="Stop"]', { state: 'detached', timeout: timeoutMs }).catch(() => {});
  await sleep(1200);
};
const newestSession = async () => page.evaluate(async () => {
  const r = await fetch('aico://app/api/sessions').then(x => x.json());
  const rows = Array.isArray(r) ? r : (r.sessions ?? []);
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null;
});

// ── a: generate, then sign in from the vault ──
await page.keyboard.press('Control+n');
await sleep(800);
await ask(`Use CredentialGenerate to create the admin login for my portal: name "portal-admin", kind "login", username "admin", url "${ORIGIN}". Do nothing else, then tell me its name.`);
const sessionId = await newestSession();
console.log(`session ${sessionId}`);
// A second reader of the session's event stream, recording every frame the renderer is sent.
await page.evaluate((sid) => {
  window.__streamCap = '';
  void (async () => {
    const res = await fetch(`aico://app/api/events?session=${encodeURIComponent(sid)}&since=0`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; window.__streamCap += dec.decode(value, { stream: true }); }
  })();
}, sessionId);
const creds = await invoke('vault:list');
const pa = creds.find(c => c.name === 'portal-admin');
check(pa && pa.createdBy.startsWith('agent:') && pa.policy.approval === 'auto', 'a: the agent generated portal-admin (created by AICO, auto within scope)', pa ? `${pa.createdBy} · ${pa.url}` : 'not found');
// The installer (this probe) sets the portal up with the value — through the owner's own path: Reveal.
const revealed = pa ? await invoke('vault:reveal', pa.id) : false;
const box = await probe(() => globalThis.__probe.reveals.pop());
const secretA = /password:\n([^\n]+)/.exec(box ?? '')?.[1] ?? null;
check(revealed && secretA && secretA.length >= 16, 'd: Reveal (native confirm → grant) shows the value in a main-owned dialog only');
portal.expected = secretA;
await ask(`Open the portal at ${ORIGIN}/login in the built-in browser and sign in as admin.`, { timeoutMs: 300_000 });
const signedIn = portal.received.some(r => r.username === 'admin' && r.password === secretA);
check(signedIn, 'a: the portal received the right username and password from browser_login', `${portal.received.length} POST(s)`);
await shot(page, 'a-signed-in');
const transcript = await page.evaluate(async (sid) => fetch(`aico://app/api/session/export?id=${encodeURIComponent(sid)}&format=md`).then(r => r.text()), sessionId);
const toolsUsed = /browser_login/.test(transcript);
check(toolsUsed, 'a: the agent used browser_login (not typing)');

// ── e: the purchase gate ──
const ordersBefore = portal.orders.length;
const gateAsk = ask(`Open ${ORIGIN}/shop/checkout in the built-in browser and click the "Place order" button.`, { timeoutMs: 240_000 });
let sawPrompt = false;
for (let i = 0; i < 120 && !sawPrompt; i++) {
  await sleep(1000);
  sawPrompt = await page.locator('[role="alertdialog"]:has-text("buy or pay")').count().catch(() => 0) > 0;
}
check(sawPrompt, 'e: an agent click on "Place order" raised the AICO purchase prompt');
check(portal.orders.length === ordersBefore, 'e: nothing was ordered while the prompt waited');
await shot(page, 'e-purchase-gate');
if (sawPrompt) await page.click('[role="alertdialog"] button:has-text("Allow purchase")').catch(() => {});
await gateAsk;
check(portal.orders.length === ordersBefore + 1, 'e: after the person allowed it, the order went through once');

// ── c: CredentialRequest through the secure prompt ──
const secretC = `Probe-Token-${Math.random().toString(36).slice(2, 10)}-Zq9`;
const cAsk = ask('Use CredentialRequest to ask me for an API token: name "probe-token", kind "api-token", host "api.internal.test", reason "live probe of the secure prompt". Then tell me what it returned.');
let promptPage = null;
for (let i = 0; i < 90 && !promptPage; i++) {
  await sleep(1000);
  for (const w of app.windows()) { if (await w.title().catch(() => '') === 'The agent needs a credential') promptPage = w; }
}
check(Boolean(promptPage), 'c: the secure prompt window opened (main-owned, not the app renderer)');
if (promptPage) {
  await promptPage.screenshot({ path: path.join(outDir, 'vaultui-c-secure-prompt.png') }).catch(() => {});
  await promptPage.fill('input[type="password"]', secretC);
  await promptPage.click('button[type="submit"]');
}
await cAsk;
const pt = (await invoke('vault:list')).find(c => c.name === 'probe-token');
check(pt && pt.createdBy === 'user' && pt.host === 'api.internal.test', 'c: the typed token was stored as probe-token, bound to its host');

// ── d: Credential Manager — add (secure prompt), rotate, delete, audit ──
const secretD = `Probe-Added-${Math.random().toString(36).slice(2, 10)}-Kx4`;
await page.keyboard.press('Control+,');
await sleep(600);
await page.click('text=Credentials & passwords', { timeout: 8000 }).catch(() => {});
await sleep(1200);
await page.click('button:has-text("Add")', { timeout: 8000 }).catch(() => {});
await sleep(500);
await page.selectOption('#cm-kind', 'api-token').catch(() => {});
await page.fill('#cm-name', 'probe-added').catch(() => {});
await page.fill('#cm-where', 'https://api.example.test').catch(() => {});
await shot(page, 'd-add-form');
await page.click('button:has-text("Continue")').catch(() => {});
let addPrompt = null;
for (let i = 0; i < 20 && !addPrompt; i++) { await sleep(500); for (const w of app.windows()) if (await w.title().catch(() => '') === 'Add a credential') addPrompt = w; }
if (addPrompt) { await addPrompt.fill('input[type="password"]', secretD); await addPrompt.click('button[type="submit"]'); }
await sleep(1500);
const pd = (await invoke('vault:list')).find(c => c.name === 'probe-added');
check(pd, 'd: Add stored a credential through the secure prompt');
if (pd) {
  await invoke('vault:reveal', pd.id);
  const shown = await probe(() => globalThis.__probe.reveals.pop());
  check(typeof shown === 'string' && shown.includes(secretD), 'd: Reveal shows the value that was typed (main-owned dialog)');
  await invoke('vault:rotate', pd.id, 'generate');
  await invoke('vault:reveal', pd.id);
  const rotated = await probe(() => globalThis.__probe.reveals.pop());
  check(typeof rotated === 'string' && !rotated.includes(secretD), 'd: Rotate → Generate replaced the value');
  await page.click('text=probe-added').catch(() => {});
  await sleep(800);
  await shot(page, 'd-details-and-history');
  const audit = await invoke('vault:audit', { id: pd.id, limit: 50 });
  const actions = new Set(audit.map(e => e.action));
  check(['create', 'reveal', 'rotate'].every(a => actions.has(a)), 'd: the audit log records create, reveal and rotate', [...actions].join(', '));
  await invoke('vault:delete', pd.id);
  check(!(await invoke('vault:list')).some(c => c.name === 'probe-added'), 'd: Delete (native confirm → grant) removed it');
}
const asked = await probe(() => globalThis.__probe.boxes.map(b => `${b.title}: ${b.message}`));
console.log(`  native dialogs the person saw:\n    ${asked.join('\n    ')}`);

// ── The canary scan ──
const canaries = [secretA, secretC, secretD, ...LEGACY.map(l => l.password)].filter(Boolean);
const encodings = (v) => { const b = Buffer.from(v); return [v, b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), b.toString('hex'), encodeURIComponent(v), JSON.stringify(v).slice(1, -1)]; };
const leaks = (text) => {
  for (const c of canaries) {
    if (encodings(c).some(e => text.includes(e))) return c.slice(0, 6);
    for (const run of text.match(/[A-Za-z0-9+/_=-]{16,}/g) ?? []) {
      for (let skip = 0; skip < 4; skip++) {
        for (const alphabet of ['base64', 'base64url']) if (Buffer.from(run.slice(skip), alphabet).toString('latin1').includes(c)) return `${c.slice(0, 6)} (base64)`;
      }
    }
  }
  return null;
};
const sinks = {};
const locked = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/[\\/](electron|node_modules)$/.test(p)) walk(p); continue; }
    // A file the running app holds open (a Chromium profile database) is read after it closes, below.
    try { if (fs.statSync(p).size < 30_000_000) sinks[`file:${path.relative(home, p)}`] = fs.readFileSync(p).toString('latin1'); } catch { locked.push(p); }
  }
};
walk(home);
// The vault's own files are sealed; the 0.28.0 backup is safeStorage-sealed. Their ciphertext is not a leak.
for (const k of Object.keys(sinks)) if (/^file:vault[\\/](vault|key)\.json$|vault\.bin\.migrated-|vault-key\.bin$/.test(k)) delete sinks[k];
sinks.transcript = await page.evaluate(async (sid) => fetch(`aico://app/api/session/export?id=${encodeURIComponent(sid)}&format=md`).then(r => r.text()), sessionId);
sinks.stream = await page.evaluate(() => window.__streamCap ?? '');
sinks.rendererDom = await page.content();
sinks.rendererStorage = await page.evaluate(() => JSON.stringify({ ls: { ...localStorage }, ss: { ...sessionStorage } }));
sinks.ipc = (await probe(() => globalThis.__probe.ipc)).join('\n');
sinks.console = consoleLog.join('\n');
sinks.mainStdout = mainOut.join('');
const hits = Object.entries(sinks).map(([k, v]) => [k, leaks(v)]).filter(([, h]) => h);
check(sinks.stream.length > 1000 && sinks.ipc.length > 1000 && sinks.transcript.length > 200, 'scan: the captures are real (stream, IPC, transcript non-trivial)', `stream ${sinks.stream.length} B, ipc ${sinks.ipc.length} B, transcript ${sinks.transcript.length} B, ${Object.keys(sinks).length} sinks`);
check(hits.length === 0, `scan: zero canary hits across ${Object.keys(sinks).length} sinks (${canaries.length} canaries)`, hits.map(([k, h]) => `${k}: ${h}`).join('; '));
await app.close().catch(() => {});
// The files the app held open, now that it has closed (the browser profile's databases).
const lateHits = [];
for (const p of locked) { try { const t = fs.readFileSync(p).toString('latin1'); sinks[`file:${path.relative(home, p)}`] = t; const h = leaks(t); if (h) lateHits.push(`${path.relative(home, p)}: ${h}`); } catch { /* still locked */ } }
check(lateHits.length === 0, `scan: zero hits in the ${locked.length} file(s) the running app held open`, lateHits.join('; '));
fs.writeFileSync(path.join(outDir, 'vault-live-results.json'), JSON.stringify({ results, sinks: Object.fromEntries(Object.entries(sinks).map(([k, v]) => [k, v.length])) }, null, 1));
server.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed. Store kept at ${home}`);
process.exit(failed ? 1 : 0);
