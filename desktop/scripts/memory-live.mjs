/**
 * Live check of "Remember what I read" and always-on tab awareness in the real
 * desktop app, with a real model (COSTS MONEY — run only when asked):
 *
 *   node scripts/memory-live.mjs <outDir>
 *
 *   0  memory OFF (the default): a page read for 20 s leaves nothing on disk
 *   1  memory ON: four local test pages are read (a red leather jacket, a blue
 *      denim jacket, an article, a laptop) — the store holds them, sealed
 *   2  the Insights search finds the red leather jacket for "red leather
 *      jacket I looked at last week"
 *   3  the red jacket's tab is closed; the copilot is asked "where was that red
 *      leather jacket I looked at?" → it calls browser_memory_search and names
 *      the right page
 *   4  with three product tabs open (blue jacket, laptop, a scarf) the copilot
 *      is asked "which of my open tabs is cheapest?" → it answers the scarf
 *      without switching to or reading each tab (the tool calls are checked)
 *
 * "Reading" is simulated the way a person reads: the tab is in front of a
 * focused window and input arrives (sendInputEvent clicks on an empty spot).
 * If Windows refuses the test window the foreground, `isFocused` is stubbed
 * true on that window and the log says so. Isolated AICO_HOME with
 * settings.json copied in (for the provider key); the model is the default
 * in those settings.
 *
 * @module desktop/scripts/memory-live
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
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'aico-memory-live'));
fs.mkdirSync(outDir, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-memory-live-home-'));
const realSettings = path.join(os.homedir(), '.aico', 'settings.json');
if (fs.existsSync(realSettings)) fs.copyFileSync(realSettings, path.join(home, 'settings.json'));
console.log(`AICO_HOME=${home}`);

const results = [];
const check = (ok, label, detail) => { results.push({ ok: Boolean(ok), label, detail }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shot = async (page, name) => { const f = path.join(outDir, `memory-${name}.png`); await page.screenshot({ path: f }).catch(() => {}); console.log(`  shot ${f}`); };

// ── The shop and the news site (a local test server) ──
const product = (slug, name, price, desc, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${name} – Northwind Outfitters</title>
<meta name="description" content="${desc}">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name, description: desc, offers: { '@type': 'Offer', price, priceCurrency: 'USD' }, aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.4, reviewCount: 57 } })}</script></head>
<body style="font-family:sans-serif;padding:40px;min-height:2400px"><header><nav>Northwind · Women · Men · Sale</nav></header>
<main><h1>${name}</h1><p class="price">$${price}</p><p>${body}</p><p>Free delivery over $50. Returns accepted within 30 days of purchase in original condition.</p>
<button>Add to cart</button></main><footer>© Northwind Outfitters</footer></body></html>`;
const PAGES = {
  '/shop/red-leather-biker-jacket': product('red', 'Red Leather Biker Jacket', '189.00', 'Classic red leather biker jacket in soft lambskin with an asymmetric zip.', 'Cut from soft lambskin leather in a deep cherry red, this biker jacket has an asymmetric zip, quilted shoulders and zipped cuffs. Fully lined.'),
  '/shop/blue-denim-trucker-jacket': product('blue', 'Blue Denim Trucker Jacket', '79.00', 'Stonewashed blue denim trucker jacket with chest pockets.', 'A stonewashed blue denim trucker jacket with a button front, two chest pockets and adjustable waist tabs. Cotton, machine washable.'),
  '/shop/aero-14-laptop': product('laptop', 'Aero 14 Laptop', '1099.00', 'A light 14-inch laptop with 16 GB of memory and a 1 TB SSD.', 'The Aero 14 weighs 1.2 kg, has a 14-inch 2.8K display, 16 GB of memory, a 1 TB SSD and up to 14 hours of battery life.'),
  '/shop/grey-wool-scarf': product('scarf', 'Grey Wool Scarf', '35.00', 'A soft grey merino wool scarf.', 'Knitted from soft merino wool in heather grey, 180 cm long with fringed ends.'),
  '/news/sleep-and-caffeine': `<!doctype html><html><head><meta charset="utf-8"><title>What caffeine really does to your sleep – The Daily Test</title>
<meta name="description" content="A look at how an afternoon coffee delays sleep and reduces deep sleep."></head>
<body style="font-family:sans-serif;padding:40px;min-height:2400px"><article><h1>What caffeine really does to your sleep</h1>
${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i + 1}: caffeine blocks adenosine, the molecule that builds sleep pressure through the day. A coffee at four in the afternoon can still be half active at ten at night, delaying sleep and cutting the deep sleep that helps memory. Researchers suggest a cut-off about eight hours before bed.</p>`).join('\n')}
</article></body></html>`,
};
const server = http.createServer((req, res) => {
  const body = PAGES[new URL(req.url, 'http://x').pathname];
  if (!body) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const U = (p) => `${ORIGIN}${p}`;
console.log(`test pages at ${ORIGIN}`);

// ── Launch ──
const exe = path.join(desktop, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = await electron.launch({ executablePath: exe, args: [desktop], env: { ...process.env, AICO_HOME: home }, timeout: 90_000 });
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w?.unmaximize(); w?.setContentSize(1440, 900); }).catch(() => {});
await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 120_000 }).catch(() => {});
const invoke = (channel, ...args) => page.evaluate(([c, a]) => window.aicoDesktop.invoke(c, ...a), [channel, args]);
await page.evaluate(() => window.dispatchEvent(new CustomEvent('aico:open-view', { detail: { id: 'browser' } })));
await sleep(2500);

const focus = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find(x => !x.isDestroyed() && x.isVisible()) ?? BrowserWindow.getAllWindows()[0];
  w.show(); w.focus();
  const real = w.isFocused();
  // The person is "at the window" for the whole run: on a machine someone is using, the
  // foreground moves away mid-run and the reading tick (rightly) stops counting.
  w.isFocused = () => true;
  return real;
});
console.log(`  window ${focus ? 'focused for real at start' : 'not given the foreground'}; isFocused stubbed true for the reading ticks (simulated reader)`);

/** Read the page in front for `ms`: a click on an empty spot every few seconds, as a person scrolling and clicking would. */
const readFor = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await app.evaluate(({ webContents }, origin) => {
      // The tab in front is the one whose view is visible; clicking every test tab's blank margin is harmless.
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.getURL().startsWith(origin)) continue;
        wc.sendInputEvent({ type: 'mouseDown', x: 8, y: 600, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: 8, y: 600, button: 'left', clickCount: 1 });
      }
    }, ORIGIN).catch(() => {});
    await sleep(2500);
  }
};
const openTab = async (p) => { const t = await invoke('browser:open', U(p), true); await sleep(1500); return t; };
const memDir = path.join(home, 'desktop', 'browser', 'memory');
const pageFiles = () => { try { return fs.readdirSync(path.join(memDir, 'pages')).filter(f => f.endsWith('.bin')); } catch { return []; } };

// ── 0: OFF by default — nothing kept ──
{
  const st = await invoke('browser:memory:status');
  check(st && st.enabled === false, '0: memory is off by default', JSON.stringify(st));
  await openTab('/shop/red-leather-biker-jacket');
  await readFor(21_000);
  check(pageFiles().length === 0 && (await invoke('browser:memory:status')).pages === 0, '0: memory OFF — a page read for 21 s stored nothing', `${pageFiles().length} files`);
}

// ── 1: ON — read four pages ──
let redTabId = null;
{
  const st = await invoke('browser:memory:set', { enabled: true });
  check(st.enabled === true, '1: turned on ("Remember what I read (on this device)")');
  const red = await invoke('browser:state').then(s => s.tabs.find(t => t.url.includes('red-leather')));
  redTabId = red?.id ?? null;
  await invoke('browser:select', redTabId);
  await readFor(20_000);
  for (const p of ['/shop/blue-denim-trucker-jacket', '/news/sleep-and-caffeine', '/shop/aero-14-laptop']) { await openTab(p); await readFor(20_000); }
  await sleep(1500);
  const files = pageFiles();
  const st2 = await invoke('browser:memory:status');
  check(files.length === 4 && st2.pages === 4, '1: four pages read → four remembered', `${files.length} files; status ${JSON.stringify(st2)}`);
  const sealed = files.every(f => { const b = fs.readFileSync(path.join(memDir, 'pages', f)); return b.subarray(0, 9).toString() === 'AICOMEM1\n' && !b.includes(Buffer.from('lambskin')) && !b.includes(Buffer.from('caffeine')); });
  check(sealed && st2.encrypted, '1: sealed at rest with the OS keychain (no page text in the files)');
}

// ── 2: the Insights search ──
{
  const a = await invoke('browser:memory:search', { query: 'red leather jacket I looked at last week' });
  check(a.hits[0]?.url === U('/shop/red-leather-biker-jacket'), '2: search finds the red leather jacket first', a.hits.map(h => `${h.title} (${h.score})`).join(' | '));
  await page.click('button[title="Browser menu"]').catch(() => {});
  await sleep(400);
  await page.click('text=Insights').catch(() => {});
  await sleep(1200);
  await page.fill('input[aria-label="Find something you read"]', 'red leather jacket I looked at last week').catch(() => {});
  await sleep(1200);
  const hitsUi = await page.locator('[data-testid="memory-hit"]').count().catch(() => 0);
  const firstUi = await page.locator('[data-testid="memory-hit"]').first().innerText().catch(() => '');
  check(hitsUi > 0 && /Red Leather Biker Jacket/.test(firstUi), '2: the Insights page\'s "Find something you read" shows it first', firstUi.split('\n')[0]);
  await shot(page, '2-insights-search');
  await page.keyboard.press('Escape').catch(() => {});
  await page.click('button[title="Close (Esc)"]').catch(() => {});
  await sleep(600);
}

// ── Copilot helpers ──
const openCopilot = async () => {
  const open = await page.locator('aside[aria-label="AICO copilot"]').count();
  if (!open) await page.click('.bx-ai-btn').catch(() => {});
  await page.waitForSelector('aside[aria-label="AICO copilot"] textarea', { timeout: 15_000 });
};
const askCopilot = async (text, timeoutMs = 240_000) => {
  const box = page.locator('aside[aria-label="AICO copilot"] textarea');
  await box.click();
  await box.fill(text);
  await page.keyboard.press('Enter');
  await page.waitForSelector('button[title^="Stop — also stops AICO"]', { timeout: 30_000 }).catch(() => {});
  await page.waitForSelector('button[title^="Stop — also stops AICO"]', { state: 'detached', timeout: timeoutMs }).catch(() => {});
  await sleep(2500);
};
const copilotSession = () => page.evaluate(() => localStorage.getItem('aico.browser.copilot.session'));
/** The session's log: every tool call made, and the last assistant text. */
const turnOf = async (sid) => {
  const snap = await page.evaluate(async (id) => fetch(`aico://app/api/session?id=${encodeURIComponent(id)}`).then(r => r.json()).catch(e => ({ error: String(e) })), sid);
  const md = await page.evaluate(async (id) => fetch(`aico://app/api/session/export?id=${encodeURIComponent(id)}&format=md`).then(r => r.text()).catch(() => ''), sid);
  return { snap, md };
};
/** The browser tools called in the LAST turn of the transcript (not names mentioned in the header text). */
const toolNames = (md) => [...md.slice(md.lastIndexOf('\n## You')).matchAll(/\*\*mcp__aico-desktop__(browser_\w+)\*\*/g)].map(m => m[1]);

// ── 3: "where was that red leather jacket?" — from memory, not the open tabs ──
{
  await invoke('browser:close', redTabId);
  await sleep(800);
  const open = (await invoke('browser:state')).tabs.map(t => t.url);
  check(!open.some(u => u.includes('red-leather')), '3: the red jacket tab is closed (the answer must come from memory)');
  await openCopilot();
  await askCopilot('Where was that red leather jacket I looked at?');
  const sid = await copilotSession();
  const { md } = await turnOf(sid);
  fs.writeFileSync(path.join(outDir, 'memory-3-transcript.md'), md);
  const tools = toolNames(md);
  const answer = md.split(/\n#+ /).filter(s => /^(AICO|Assistant)/i.test(s)).pop() ?? md.slice(-2000);
  check(tools.includes('browser_memory_search'), '3: the copilot called browser_memory_search', [...new Set(tools)].join(', '));
  check(/red-leather-biker-jacket|Red Leather Biker Jacket/i.test(answer), '3: its answer names the right page', answer.replace(/\s+/g, ' ').slice(0, 300));
  await shot(page, '3-copilot-memory');
}

// ── 4: "which of my open tabs is cheapest?" — from the tab summaries ──
{
  await openTab('/shop/grey-wool-scarf');
  await sleep(2500);
  // Put the laptop in front, so the cheapest is not the page being looked at.
  const st = await invoke('browser:state');
  let laptop = st.tabs.find(t => t.url.includes('aero-14'));
  if (!laptop) { laptop = await openTab('/shop/aero-14-laptop'); console.log('  NOTE: the laptop tab was gone (closed by someone) — reopened'); }
  for (const p of ['/shop/blue-denim-trucker-jacket']) if (!st.tabs.some(t => t.url.includes(p))) await openTab(p);
  await invoke('browser:select', laptop.id);
  await sleep(1500);
  const view = await invoke('browser:tabs:summary');
  fs.writeFileSync(path.join(outDir, 'memory-4-tab-lines.txt'), view.lines.join('\n'));
  check(view.lines.some(l => /Grey Wool Scarf.*\$35\.00/.test(l)) && view.lines.some(l => /Aero 14.*\$1099\.00/.test(l)), '4: main keeps a line per tab with its price', view.lines.length + ' lines');
  await page.click('aside[aria-label="AICO copilot"] button[title="New copilot chat"]').catch(() => {});
  await sleep(1200);
  await page.click('aside[aria-label="AICO copilot"] .cp-page-chip:has-text("open tabs")').catch(() => {});
  await sleep(600);
  await shot(page, '4-tabs-chip');
  await page.click('aside[aria-label="AICO copilot"] .cp-page-chip:has-text("open tabs")').catch(() => {});
  const before = (await invoke('browser:state')).activeId;
  await askCopilot('Which of my open tabs is cheapest?');
  const sid = await copilotSession();
  const { md } = await turnOf(sid);
  fs.writeFileSync(path.join(outDir, 'memory-4-transcript.md'), md);
  const tools = toolNames(md);
  const switched = tools.filter(t => ['browser_select_tab', 'browser_read', 'browser_text', 'browser_snapshot', 'browser_open', 'browser_extract', 'browser_insights'].includes(t));
  check(/scarf/i.test(md.slice(md.lastIndexOf('Which of my open tabs'))) && /\$?35/.test(md.slice(md.lastIndexOf('Which of my open tabs'))), '4: the answer is the grey wool scarf at $35');
  check(switched.length === 0, '4: answered without switching to or reading each tab', tools.length ? [...new Set(tools)].join(', ') : 'no browser tools called');
  check((await invoke('browser:state')).activeId === before, '4: the tab in front did not change');
  await shot(page, '4-copilot-cheapest');
}

// ── Clear browsing data clears memory ──
{
  await invoke('browser:history:clear');
  await sleep(500);
  check(pageFiles().length === 0 && (await invoke('browser:memory:status')).pages === 0, '5: clearing browsing data deletes the remembered pages');
}

await app.close().catch(() => {});
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(path.join(outDir, 'memory-live-results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
