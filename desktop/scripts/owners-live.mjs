/**
 * Live check of per-chat browser tabs in the real desktop app, with a real
 * model (COSTS MONEY — run only when asked):
 *
 *   node scripts/owners-live.mjs <outDir>
 *
 * Why it exists: every chat and the browser copilot used to drive the one tab
 * in front, so two chats (or a chat and the copilot) navigated and clicked on
 * each other's page — and on the page the person was reading. This drives the
 * fixed app the way a person would:
 *
 *   1  the person reads a page; two chats run AT THE SAME TIME, each told to
 *      open a different local page, report its heading and type into a field;
 *      meanwhile the copilot is asked about the page in front. Each chat must
 *      work in its own background tab, get the right answer, the front tab must
 *      never change, and the tab strip must badge each chat's tab with its owner;
 *   2  a forced conflict: the person hands the SAME tab to two new chats and
 *      both are told to click on it. Their clicks must be serialised (one
 *      chat's run of clicks, then the other's — or "busy"), never interleaved.
 *
 * Uses an isolated AICO_HOME with settings.json copied in (for the provider
 * key) and local test pages; the person's actions (opening tabs, the tab
 * menu's hand-over) go through the same channels the interface uses.
 *
 * @module desktop/scripts/owners-live
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
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'aico-owners-live'));
fs.mkdirSync(outDir, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-owners-live-home-'));
const realSettings = path.join(os.homedir(), '.aico', 'settings.json');
if (fs.existsSync(realSettings)) fs.copyFileSync(realSettings, path.join(home, 'settings.json'));
console.log(`AICO_HOME=${home}`);

const results = [];
const check = (ok, label, detail) => { results.push({ ok: Boolean(ok), label, detail }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shot = async (page, name) => { const f = path.join(outDir, `owners-${name}.png`); await page.screenshot({ path: f }).catch(() => {}); console.log(`  shot ${f}`); };

// ── Local pages ──
const clicks = [];
const page = (title, h1, body = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;padding:40px"><h1>${h1}</h1>${body}</body></html>`;
const PAGES = {
  '/front': page('The page I am reading', 'Front Page Heading 5150', '<p>This is the article the person is reading while the chats work.</p>'),
  '/alpha': page('Alpha', 'Alpha Heading 7731', '<label>City <input name="city" id="city"></label>'),
  '/beta': page('Beta', 'Beta Heading 4402', '<label>City <input name="city" id="city"></label>'),
  '/shared': page('Shared counter', 'Shared counter', `<p>Count: <b id="n">0</b></p>
<button id="addc" onclick="hit('C')">Add C</button> <button id="addd" onclick="hit('D')">Add D</button>
<script>function hit(w){document.getElementById('n').textContent=String(Number(document.getElementById('n').textContent)+1);fetch('/hit?w='+w);}</script>`),
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/hit') { clicks.push({ who: url.searchParams.get('w'), at: Date.now() }); res.writeHead(204); res.end(); return; }
  const body = PAGES[url.pathname];
  if (!body) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const U = (p) => `${ORIGIN}${p}`;
console.log(`pages at ${ORIGIN}`);

// ── The app ──
const exe = path.join(desktop, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = await electron.launch({ executablePath: exe, args: [desktop], env: { ...process.env, AICO_HOME: home }, timeout: 90_000 });
const win = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w?.unmaximize(); w?.setContentSize(1440, 900); }).catch(() => {});
await win.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 120_000 }).catch(() => {});
const consoleLog = [];
win.on('console', m => consoleLog.push(`[${m.type()}] ${m.text()}`));
const invoke = (channel, ...args) => win.evaluate(([c, a]) => window.aicoDesktop.invoke(c, ...a), [channel, args]);
const state = () => invoke('browser:state');
const openView = async (id) => { await win.evaluate((v) => window.dispatchEvent(new CustomEvent('aico:open-view', { detail: { id: v } })), id); await sleep(1500); };
// The person's tab menu: a native menu cannot be clicked from a test, so the next popup picks the named item itself.
await app.evaluate(({ Menu }) => {
  const orig = Menu.prototype.popup;
  Menu.prototype.popup = function (opts) {
    const want = globalThis.__autoMenu;
    if (!want) return orig.call(this, opts);
    globalThis.__autoMenu = null;
    const item = this.items.find(i => i.label === want);
    globalThis.__menuPicked = item ? item.label : `(no "${want}" in: ${this.items.map(i => i.label).filter(Boolean).join(' | ')})`;
    if (item) item.click();
    setTimeout(() => opts?.callback?.(), 10);
  };
});
const handToOpenChat = async (tabId) => {
  await app.evaluate((_e, label) => { globalThis.__autoMenu = label; }, 'Let the open chat use this tab');
  await invoke('browser:tabMenu', tabId, { bookmarked: false });
  await sleep(1500);
  return app.evaluate(() => globalThis.__menuPicked);
};

/** A new chat in the main window, sent `text`; resolves its session id. */
const startChat = async (text) => {
  await openView('chat');
  await win.keyboard.press('Control+n');
  await sleep(1200);
  const before = await win.evaluate(() => localStorage.getItem('aico.session'));
  await win.evaluate((t) => window.dispatchEvent(new CustomEvent('aico:ask', { detail: { text: t, send: true } })), text);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const now = await win.evaluate(() => localStorage.getItem('aico.session'));
    if (now && now !== before) return now;
  }
  return win.evaluate(() => localStorage.getItem('aico.session'));
};
const sessionOf = (sid) => win.evaluate(async (id) => fetch(`aico://app/api/session?id=${encodeURIComponent(id)}`).then(r => r.json()).catch(e => ({ error: String(e) })), sid);
const transcript = (sid) => win.evaluate(async (id) => fetch(`aico://app/api/session/export?id=${encodeURIComponent(id)}&format=md`).then(r => r.text()).catch(() => ''), sid);
const waitIdle = async (sid, timeoutMs = 300_000) => {
  const end = Date.now() + timeoutMs;
  await sleep(3000);
  while (Date.now() < end) {
    const s = await sessionOf(sid);
    if (s && s.busy === false) return true;
    await sleep(2000);
  }
  return false;
};
const lastAnswer = (md) => {
  const parts = md.split(/\n(?=#+ )/);
  const mine = parts.filter(p => /^#+ (AICO|Assistant)/i.test(p));
  return (mine.pop() ?? md.slice(-1500)).replace(/\s+/g, ' ');
};
const browserCalls = (md) => [...md.matchAll(/mcp__aico-desktop__(browser_\w+)/g)].map(m => m[1]);
/** Field value and URL of every test page, read straight from the tabs' web contents. */
const pagesNow = () => app.evaluate(async ({ webContents }, origin) => {
  const out = [];
  for (const wc of webContents.getAllWebContents()) {
    const url = wc.getURL();
    if (!url.startsWith(origin)) continue;
    const city = await wc.executeJavaScript('document.getElementById("city") ? document.getElementById("city").value : null').catch(() => null);
    out.push({ url, city });
  }
  return out;
}, ORIGIN);

// ── 1: the person reads a page; two chats and the copilot work at once ──
await openView('browser');
await invoke('browser:open', U('/front'), true);
await sleep(2000);
const front0 = await state();
const frontId = front0.activeId;
const frontTab = front0.tabs.find(t => t.id === frontId);
check(frontTab && frontTab.url.endsWith('/front'), '1: the person has /front in front', `${frontId} ${frontTab?.url}`);

const fronts = new Set();
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const s = await state().catch(() => null);
    if (s) fronts.add(s.activeId);
    await sleep(300);
  }
})();

const sidA = await startChat(`Use the built-in browser (the aico-desktop browser tools). Open ${U('/alpha')}, read the page's main heading, and type "Lisbon" into its City field (do not submit anything). Then reply with the exact heading text and nothing else.`);
const sidB = await startChat(`Use the built-in browser (the aico-desktop browser tools). Open ${U('/beta')}, read the page's main heading, and type "Oslo" into its City field (do not submit anything). Then reply with the exact heading text and nothing else.`);
console.log(`  chat A ${sidA}\n  chat B ${sidB}`);
check(sidA && sidB && sidA !== sidB, '1: two chats started', `${sidA} / ${sidB}`);

// The copilot, about the page in front, while both chats run.
await openView('browser');
await sleep(1500);
let copilotSid = null;
{
  const open = await win.locator('aside[aria-label="AICO copilot"]').count();
  if (!open) await win.click('.bx-ai-btn').catch(() => {});
  await win.waitForSelector('aside[aria-label="AICO copilot"] textarea', { timeout: 15_000 }).catch(() => {});
  const box = win.locator('aside[aria-label="AICO copilot"] textarea');
  await box.click().catch(() => {});
  await box.fill('What is the main heading of this page? Read it with the browser tools and answer with the heading text only.').catch(() => {});
  await win.keyboard.press('Enter');
  await sleep(3000);
  copilotSid = await win.evaluate(() => localStorage.getItem('aico.browser.copilot.session'));
  console.log(`  copilot ${copilotSid}`);
}
await shot(win, '1-while-working');
// A mid-run look at the strip: whose tabs are open.
let midStrip = [];
for (let i = 0; i < 40; i++) {
  await sleep(1500);
  const s = await state();
  midStrip = s.tabs.filter(t => t.owner).map(t => ({ id: t.id, url: t.url, owner: t.owner.title, driver: t.driver, released: t.owner.released }));
  if (midStrip.length >= 2) break;
}
await shot(win, '1-strip-with-chat-tabs');
const domOwners = await win.evaluate(() => [...document.querySelectorAll('[role="tab"][data-owner]')].map(e => ({ id: e.getAttribute('data-tab'), owner: e.getAttribute('data-owner'), title: e.getAttribute('title') })));

const idleA = await waitIdle(sidA);
const idleB = await waitIdle(sidB);
const idleC = copilotSid ? await waitIdle(copilotSid, 180_000) : false;
sampling = false;
await sampler;
check(idleA && idleB, '1: both chats finished');

const mdA = await transcript(sidA); const mdB = await transcript(sidB); const mdC = copilotSid ? await transcript(copilotSid) : '';
fs.writeFileSync(path.join(outDir, 'owners-1-chatA.md'), mdA);
fs.writeFileSync(path.join(outDir, 'owners-1-chatB.md'), mdB);
fs.writeFileSync(path.join(outDir, 'owners-1-copilot.md'), mdC);
const ansA = lastAnswer(mdA); const ansB = lastAnswer(mdB); const ansC = lastAnswer(mdC);
check(/Alpha Heading 7731/.test(ansA) && !/Beta Heading/.test(ansA), '1: chat A reported its own page\'s heading', ansA.slice(0, 200));
check(/Beta Heading 4402/.test(ansB) && !/Alpha Heading/.test(ansB), '1: chat B reported its own page\'s heading', ansB.slice(0, 200));
check(copilotSid && idleC && /Front Page Heading 5150/.test(ansC), '1: the copilot answered about the page in front', ansC.slice(0, 200));
check(browserCalls(mdA).length > 0 && browserCalls(mdB).length > 0, '1: both chats used the browser tools', `A: ${[...new Set(browserCalls(mdA))].join(',')} · B: ${[...new Set(browserCalls(mdB))].join(',')}`);
check(fronts.size === 1 && fronts.has(frontId), '1: the person\'s tab in front never changed while they worked', [...fronts].join(','));
const after1 = await state();
check(after1.activeId === frontId && after1.tabs.find(t => t.id === frontId)?.url.endsWith('/front'), '1: /front is still in front, on the same page');
const pages = await pagesNow();
const alpha = pages.find(p => p.url.endsWith('/alpha')); const beta = pages.find(p => p.url.endsWith('/beta'));
check(alpha?.city === 'Lisbon' && beta?.city === 'Oslo', '1: each chat typed into its own page\'s field', JSON.stringify(pages));
const tA = after1.tabs.find(t => t.url.endsWith('/alpha')); const tB = after1.tabs.find(t => t.url.endsWith('/beta'));
check(tA && tB && tA.id !== tB.id && tA.id !== frontId && tB.id !== frontId, '1: each chat worked in a tab of its own, not the person\'s', `alpha ${tA?.id} · beta ${tB?.id} · front ${frontId}`);
check(tA?.owner && tB?.owner && tA.owner.title !== tB.owner.title && tA.owner.hue !== undefined, '1: the tabs carry their owners (different chats)', `${tA?.owner?.title} / ${tB?.owner?.title}`);
check(midStrip.length >= 2 && domOwners.length >= 2 && domOwners.every(d => /Opened by the chat/.test(d.title ?? '')), '1: the tab strip badges each chat\'s tab with its owner (tooltip names the chat)', JSON.stringify(domOwners));
const frontState = after1.tabs.find(t => t.id === frontId);
check(!frontState?.owner, '1: the person\'s tab has no owner badge');

// ── 2: forced conflict — the same tab handed to two chats ──
await invoke('browser:open', U('/shared'), true);
await sleep(1500);
const sharedId = (await state()).activeId;
await openView('chat');
await win.keyboard.press('Control+n');
await sleep(1200);
const pickedC = await handToOpenChat(sharedId);
const conflictPrompt = (who) => `The user handed you the browser tab with id "${sharedId}" (it shows a counter). Pass tabId "${sharedId}" to every browser tool. Take one browser_snapshot, then click the button labelled "Add ${who}" exactly 4 times — one browser_click call per click, each with that tabId. If a call says the tab is busy, wait about 10 seconds and try that click again (up to 3 tries). Then reply DONE.`;
await win.evaluate((t) => window.dispatchEvent(new CustomEvent('aico:ask', { detail: { text: t, send: true } })), conflictPrompt('C'));
await sleep(2500);
const sidC = await win.evaluate(() => localStorage.getItem('aico.session'));
await win.keyboard.press('Control+n');
await sleep(1200);
const pickedD = await handToOpenChat(sharedId);
await win.evaluate((t) => window.dispatchEvent(new CustomEvent('aico:ask', { detail: { text: t, send: true } })), conflictPrompt('D'));
await sleep(2500);
const sidD = await win.evaluate(() => localStorage.getItem('aico.session'));
console.log(`  hand-over C: ${pickedC} · D: ${pickedD}; chats ${sidC} / ${sidD}`);
check(pickedC === 'Let the open chat use this tab' && pickedD === pickedC && sidC && sidD && sidC !== sidD, '2: the person handed the same tab to two chats (tab menu)');
await openView('browser');
const idle2 = (await waitIdle(sidC)) && (await waitIdle(sidD));
const mdC2 = await transcript(sidC); const mdD2 = await transcript(sidD);
fs.writeFileSync(path.join(outDir, 'owners-2-chatC.md'), mdC2);
fs.writeFileSync(path.join(outDir, 'owners-2-chatD.md'), mdD2);
await shot(win, '2-after-conflict');
const seq = clicks.map(c => c.who).join('');
console.log(`  click order on the shared page: ${seq}`);
const runs = seq.replace(/(.)\1*/g, '$1');
check(idle2, '2: both chats finished');
check(seq.length >= 2 && runs.length <= 2, '2: the two chats\' clicks were serialised, not interleaved', `${seq} (runs ${runs})`);
const busySeen = /is busy: the chat/.test(mdC2) || /is busy: the chat/.test(mdD2);
check(busySeen || runs.length <= 2, '2: the chat that had to wait was told the tab was busy (or the other had finished)', busySeen ? 'busy message in a transcript' : 'no overlap happened');
check((await state()).activeId === sharedId, '2: the tab in front stayed where the person left it');

// ── Not the person's tab: a chat naming a tab it was not handed is refused ──
{
  const mcpLog = path.join(home, 'desktop', 'logs', 'mcp.log');
  const log = fs.existsSync(mcpLog) ? fs.readFileSync(mcpLog, 'utf8') : '';
  fs.writeFileSync(path.join(outDir, 'owners-mcp.log'), log);
}

fs.writeFileSync(path.join(outDir, 'owners-live-results.json'), JSON.stringify({ results, clicks, midStrip, domOwners, fronts: [...fronts] }, null, 1));
await app.close().catch(() => {});
server.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed. Store kept at ${home}`);
process.exit(failed ? 1 : 0);
