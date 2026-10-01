/**
 * Live check of the browser copilot handing work to a full chat, in the real
 * desktop app with a real model (COSTS MONEY — run only when asked):
 *
 *   node scripts/handoff-live.mjs <outDir> [a|b|c ...]   (default: all three)
 *
 *   a  on a local article, "summarize this page" is answered in the copilot —
 *      no HandOffToChat call, no new chat
 *   b  "write a Python script that scrapes the headings of this page into CSV
 *      and save it in a new project folder" → HandOffToChat is called; a new
 *      chat exists whose first message is the task plus the page URL; that
 *      chat starts working; the copilot shows the "Continued in chat" card
 *      and the main window the toast with Open
 *   c  an ambiguous request shows the one-line "here, or in a new chat?"
 *      choice as two buttons
 *
 * Isolated AICO_HOME with settings.json copied in (for the provider key); the
 * model is the default in those settings. Screenshots: <outDir>/handoff-*.png.
 *
 * @module desktop/scripts/handoff-live
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
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'aico-handoff-live'));
const only = new Set(process.argv.slice(3));
const runs = (step) => only.size === 0 || only.has(step);
fs.mkdirSync(outDir, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-handoff-live-home-'));
const realSettings = path.join(os.homedir(), '.aico', 'settings.json');
if (fs.existsSync(realSettings)) fs.copyFileSync(realSettings, path.join(home, 'settings.json'));
console.log(`AICO_HOME=${home}`);

const results = [];
const check = (ok, label, detail) => { results.push({ ok: Boolean(ok), label, detail }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shot = async (page, name) => { const f = path.join(outDir, `handoff-${name}.png`); await page.screenshot({ path: f }).catch(() => {}); console.log(`  shot ${f}`); };

// ── The article (a local test server) ──
const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>Growing Tomatoes at Home – The Garden Post</title>
<meta name="description" content="A practical guide to growing tomatoes in pots and beds."></head>
<body style="font-family:Georgia,serif;max-width:720px;margin:40px auto;line-height:1.6"><article>
<h1>Growing Tomatoes at Home</h1>
<p>Tomatoes are the most rewarding crop for a small garden: a few plants in pots on a sunny wall give fruit from July to October.</p>
<h2>Choosing a variety</h2><p>Cherry tomatoes such as Sungold ripen early and forgive mistakes; beefsteak types need a long, warm season.</p>
<h2>Sun and soil</h2><p>Give them at least six hours of sun and a rich, free-draining compost. A 20-litre pot per plant is the minimum.</p>
<h2>Watering and feeding</h2><p>Water at the base every day in summer, never the leaves. Feed weekly with a high-potash feed once the first truss sets.</p>
<h2>Pinching out side shoots</h2><p>On cordon varieties pinch out the shoots that grow between the main stem and the leaves, so the plant puts its energy into fruit.</p>
<h2>Harvest</h2><p>Pick when fully coloured and slightly soft. Green fruit at the end of the season ripens indoors next to a banana.</p>
</article></body></html>`;
const server = http.createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname !== '/garden/tomatoes') { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(ARTICLE);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ARTICLE = `http://127.0.0.1:${server.address().port}/garden/tomatoes`;
console.log(`article at ${URL_ARTICLE}`);

// ── Launch ──
const exe = path.join(desktop, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = await electron.launch({ executablePath: exe, args: [desktop], env: { ...process.env, AICO_HOME: home }, timeout: 90_000 });
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w?.unmaximize(); w?.setContentSize(1440, 900); }).catch(() => {});
await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 120_000 }).catch(() => {});
const invoke = (channel, ...args) => page.evaluate(([c, a]) => window.aicoDesktop.invoke(c, ...a), [channel, args]);
await page.evaluate(() => window.dispatchEvent(new CustomEvent('aico:open-view', { detail: { id: 'browser' } })));
await sleep(2500);
await invoke('browser:open', URL_ARTICLE, true);
await sleep(2500);

const COPILOT = 'aside[aria-label="AICO copilot"]';
const openCopilot = async () => {
  if (!await page.locator(COPILOT).count()) await page.click('.bx-ai-btn').catch(() => {});
  await page.waitForSelector(`${COPILOT} textarea`, { timeout: 15_000 });
};
const newCopilotChat = async () => { await page.click(`${COPILOT} button[title="New copilot chat"]`).catch(() => {}); await sleep(1200); };
const STOP = 'button[title^="Stop — also stops AICO"]';
const ask = async (text) => {
  const box = page.locator(`${COPILOT} textarea`);
  await box.click();
  await box.fill(text);
  await page.keyboard.press('Enter');
  await page.waitForSelector(STOP, { timeout: 30_000 }).catch(() => {});
};
const settle = async (timeoutMs = 300_000) => { await page.waitForSelector(STOP, { state: 'detached', timeout: timeoutMs }).catch(() => {}); await sleep(2500); };
const copilotSession = () => page.evaluate(() => localStorage.getItem('aico.browser.copilot.session'));
const api = (p) => page.evaluate(async (u) => fetch(`aico://app/api/${u}`).then(r => r.json()).catch(e => ({ error: String(e) })), p);
const exportMd = (id) => page.evaluate(async (i) => fetch(`aico://app/api/session/export?id=${encodeURIComponent(i)}&format=md`).then(r => r.text()).catch(() => ''), id);
const lastTurn = (md) => md.slice(md.lastIndexOf('\n## You'));
const listSessions = async () => (await api('sessions')).sessions ?? [];

await openCopilot();

// ── a: a page question stays in the copilot ──
if (runs('a')) {
  const before = (await listSessions()).length;
  await ask('Summarize this page');
  await settle();
  const sid = await copilotSession();
  const md = await exportMd(sid);
  fs.writeFileSync(path.join(outDir, 'handoff-a-transcript.md'), md);
  const turn = lastTurn(md);
  check(!/HandOffToChat/.test(turn), 'a: "summarize this page" did not hand off');
  check(/tomato/i.test(turn) && /(sun|water|pinch|variet)/i.test(turn), 'a: answered in the panel from the page', turn.replace(/\s+/g, ' ').slice(-240));
  const after = await listSessions();
  check(after.filter(s => s.id !== sid).length <= before, 'a: no new chat was created', `${before} → ${after.length} sessions (incl. the copilot)`);
  check(await page.locator(`${COPILOT} [data-handoff]`).count() === 0, 'a: no "Continued in chat" card');
  await shot(page, 'a-summary');
}

// ── b: coding work goes to a chat ──
if (runs('b')) {
  await newCopilotChat();
  const task = 'Write a Python script that scrapes the headings of this page into CSV and save it in a new project folder';
  await ask(task);
  // The toast lives ~15 s; watch for it while the copilot finishes its one-line reply.
  const toast = page.locator('[role="status"]:has-text("Continued in chat")');
  const toastSeen = await toast.first().waitFor({ timeout: 240_000 }).then(() => true).catch(() => false);
  if (toastSeen) await shot(page, 'b-toast');
  check(toastSeen, 'b: the main window shows the "Continued in chat" toast');
  check(toastSeen && await toast.first().locator('button:has-text("Open")').count() === 1, 'b: the toast has Open');
  await settle();
  const sid = await copilotSession();
  const md = await exportMd(sid);
  fs.writeFileSync(path.join(outDir, 'handoff-b-copilot-transcript.md'), md);
  check(/HandOffToChat/.test(lastTurn(md)), 'b: the copilot called HandOffToChat');
  check(!/\*\*(Bash|Edit|Terminal)\*\*/.test(lastTurn(md)), 'b: the copilot did not start the work itself');
  const card = page.locator(`${COPILOT} [data-handoff]`).first();
  const cardOk = await card.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  const chatId = cardOk ? await card.getAttribute('data-handoff') : null;
  const cardText = cardOk ? (await card.innerText()).replace(/\s+/g, ' ') : '';
  check(cardOk && /Continued in chat/.test(cardText) && /Open/.test(cardText), 'b: the copilot shows the "Continued in chat — Open" card', cardText);
  await shot(page, 'b-card');
  if (chatId) {
    const sessions = await listSessions();
    const row = sessions.find(s => s.id === chatId);
    check(Boolean(row), 'b: the new chat exists in the sessions list', row ? `${row.title} — ${row.project}` : 'missing');
    // Give the chat time to start working, then read its log.
    let chatMd = '';
    for (let i = 0; i < 40; i++) {
      chatMd = await exportMd(chatId);
      if (/\n## (AICO|Assistant)|\*\*(Write|Bash|Read|LS|Glob|TodoWrite)\*\*/.test(chatMd)) break;
      await sleep(3000);
    }
    fs.writeFileSync(path.join(outDir, 'handoff-b-chat-transcript.md'), chatMd);
    const first = chatMd.slice(chatMd.indexOf('## You'), chatMd.indexOf('## You') + 2500);
    check(/scrapes the headings/i.test(first) && first.includes(URL_ARTICLE), 'b: its first message is the task plus the page URL', first.replace(/\s+/g, ' ').slice(0, 300));
    check(/\n## (AICO|Assistant)|\*\*(Write|Bash|Read|LS|Glob|TodoWrite)\*\*/.test(chatMd) || row?.running, 'b: the chat started working', row?.running ? 'running' : 'has assistant/tool output');
    // Open it from the card and look.
    await card.locator('button:has-text("Open")').click().catch(() => {});
    await sleep(3000);
    await shot(page, 'b-chat-opened');
    // Stop the chat: the evidence is that it started, not what it builds.
    await page.evaluate(async (id) => fetch('aico://app/api/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id }) }).catch(() => {}), chatId);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('aico:open-view', { detail: { id: 'browser' } })));
    await sleep(2000);
    await openCopilot();
  }
}

// ── c: an ambiguous request asks, in one line, with two buttons ──
if (runs('c')) {
  await newCopilotChat();
  await ask('Make me a watering schedule tool based on this article');
  const choice = page.locator(`${COPILOT} [data-handoff-choice]`);
  const asked = await choice.waitFor({ timeout: 240_000 }).then(() => true).catch(() => false);
  const text = asked ? (await choice.innerText()).replace(/\s+/g, ' ') : '';
  check(asked && /Here/.test(text) && /New chat/.test(text), 'c: the copilot asked "here, or in a new chat?" with two buttons', text || 'not asked');
  await shot(page, 'c-choice');
  if (asked) {
    await choice.locator('button:has-text("Here")').click().catch(() => {});
    await settle();
    await shot(page, 'c-after-here');
    const md = await exportMd(await copilotSession());
    fs.writeFileSync(path.join(outDir, 'handoff-c-transcript.md'), md);
    check(!/HandOffToChat/.test(lastTurn(md)), 'c: answering "Here" kept it in the copilot');
  } else {
    await page.click(STOP).catch(() => {});
    const md = await exportMd(await copilotSession());
    fs.writeFileSync(path.join(outDir, 'handoff-c-transcript.md'), md);
  }
}

await app.close().catch(() => {});
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(path.join(outDir, 'handoff-live-results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
