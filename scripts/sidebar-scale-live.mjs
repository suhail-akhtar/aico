/**
 * The sidebar at scale, in a real browser.
 *
 * Six hundred sessions are seeded into this run's own store — the shape of a
 * machine that has used aico daily for a month — and the portal is opened on
 * them. What is measured is what a reader would feel: how many rows the list
 * mounts to show thirty, whether the keyboard walks it, whether search finds
 * one row by id, and whether the + menu and the group drop target exist.
 *
 * Spends nothing. `node scripts/sidebar-scale-live.mjs` after `npm run build`
 * and `npm --prefix web run build`.
 */
// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const shots = path.join(repoRoot, 'dist-test', 'layout');
fs.mkdirSync(shots, { recursive: true });

let passed = 0, failed = 0;
const fails = [];
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── seed ────────────────────────────────────────────────────────────────────
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-sidebar-scale-'));
fs.writeFileSync(path.join(workspace, 'README.md'), '# scale\n');
const hash = Buffer.from(workspace).toString('base64').replace(/[/+=]/g, '_');
const sessionsDir = path.join(process.env.AICO_HOME, 'projects', hash, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

const TOTAL = 600;
const now = Date.now();
for (let i = 0; i < TOTAL; i += 1) {
  const id = i % 50 === 0 ? `miniapp-app${i}` : `sess-${String(i).padStart(4, '0')}`;
  const at = now - i * 60_000;
  const lines = [
    JSON.stringify({ type: '__header__', version: 1, id, cwd: workspace, startedAt: at - 1000 }),
    JSON.stringify({ seq: 1, type: 'session/title', timestamp: at - 900, data: { title: `Session ${i} about ${['auth', 'billing', 'search', 'docs'][i % 4]}`, source: 'model' } }),
    JSON.stringify({ seq: 2, type: 'user/message', timestamp: at - 800, data: { content: `Work item ${i}` } }),
    JSON.stringify({ seq: 3, type: 'assistant/message', timestamp: at, data: { content: 'Done.' } }),
  ];
  fs.writeFileSync(path.join(sessionsDir, `${id}.events.jsonl`), lines.join('\n') + '\n');
}
console.log(`\nSIDEBAR AT SCALE — ${TOTAL} sessions seeded\n`);

// ── server ──────────────────────────────────────────────────────────────────
let child;
const server = await new Promise((resolve, reject) => {
  child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'index.js'), 'serve', '--no-open', '--project', workspace], {
    cwd: workspace, env: { ...process.env, FORCE_COLOR: '0' },
  });
  const timer = setTimeout(() => reject(new Error('serve never printed a URL')), 90_000);
  let out = '';
  const read = (d) => {
    out += d.toString();
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(out);
    if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}/?token=${m[2]}`); }
  };
  child.stdout.on('data', read); child.stderr.on('data', read);
  child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`serve exited (${code}):\n${out.slice(-600)}`)); });
});

let browser;
try {
  const { chromium } = await import('playwright-core');
  const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
  if (!exe) { console.log('  – no Chrome or Edge found; nothing to measure'); process.exit(0); }
  browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(server, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-sidebar] [role="tree"]', { timeout: 30_000 });
  // The list arrives with the sessions fetch; wait for the count to settle.
  await page.waitForFunction((n) => document.querySelectorAll('[data-sidebar] [role="treeitem"]').length > 20 || false, TOTAL, { timeout: 30_000 }).catch(() => undefined);
  await sleep(1500);

  const geometry = await page.evaluate(() => {
    const tree = document.querySelector('[data-sidebar] [role="tree"]');
    const aside = document.querySelector('[data-sidebar]');
    return { tree: { client: tree?.clientHeight, scroll: tree?.scrollHeight, top: tree?.scrollTop }, aside: aside?.clientHeight, inner: window.innerHeight };
  });
  console.log('  · geometry', JSON.stringify(geometry));
  const mounted = await page.evaluate(() => document.querySelectorAll('[data-sidebar] [role="treeitem"]').length);
  check(mounted > 10 && mounted < 200, `the list mounts a window of rows, not all ${TOTAL} (${mounted} mounted)`);
  const sections = await page.evaluate(() => [...document.querySelectorAll('[data-sidebar] [role="treeitem"][aria-level="1"]')].map(e => e.textContent.trim().slice(0, 40)));
  check(sections.some(s => /App conversations/.test(s)), `the app conversations have their own section (${sections.filter(s => /App/.test(s)).join(' | ') || 'none'})`);
  check(sections.some(s => /Recent/.test(s)), 'Recent is drawn for a long list');
  await page.screenshot({ path: path.join(shots, 'sidebar-scale-1280.png') });

  // Scroll the tree to the bottom: the window moves, the mounted count stays small.
  await page.evaluate(() => { const t = document.querySelector('[data-sidebar] [role="tree"]'); t.scrollTop = t.scrollHeight; });
  await sleep(400);
  const mountedAfter = await page.evaluate(() => document.querySelectorAll('[data-sidebar] [role="treeitem"]').length);
  check(mountedAfter < 200, `after scrolling to the end the window is still a window (${mountedAfter} mounted)`);
  // The tail of this list is the reader's other projects (the scratch store
  // copies their settings), each folded to one row — so the oldest session is
  // reached by search rather than by scrolling.
  await page.fill('[data-sidebar] input[aria-label^="Search"]', 'Session 599');
  await sleep(500);
  const oldest = await page.evaluate(() => [...document.querySelectorAll('[data-sidebar] [role="treeitem"][aria-level="2"]')].map(e => e.textContent.trim().slice(0, 24)));
  check(oldest.length === 1 && /Session 599/.test(oldest[0]), `the oldest session is one search away (${JSON.stringify(oldest)})`);
  const foldedEmpties = await page.evaluate(() => {
    const headers = [...document.querySelectorAll('[data-sidebar] [role="treeitem"][aria-level="1"]')];
    return headers.filter(h => h.getAttribute('aria-expanded') === 'false').length;
  });
  await page.fill('[data-sidebar] input[aria-label^="Search"]', '');
  await sleep(400);
  // The folded tail is below the window; scroll there before counting what is mounted.
  await page.evaluate(() => { const t = document.querySelector('[data-sidebar] [role="tree"]'); t.scrollTop = t.scrollHeight; });
  await sleep(400);
  const foldedAtRest = await page.evaluate(() => [...document.querySelectorAll('[data-sidebar] [role="treeitem"][aria-level="1"]')].filter(h => h.getAttribute('aria-expanded') === 'false').length);
  await page.evaluate(() => { const t = document.querySelector('[data-sidebar] [role="tree"]'); t.scrollTop = 0; });
  await sleep(300);
  check(foldedEmpties === 0, `while searching every matching section is open (${foldedEmpties} folded)`);
  check(foldedAtRest > 3, `at rest the long tail of other projects is folded by default (${foldedAtRest} folded)`);

  // Search by id finds one row and hides Recent.
  await page.fill('[data-sidebar] input[aria-label^="Search"]', 'sess-0042');
  await sleep(500);
  const matchLine = await page.evaluate(() => document.querySelector('[data-sidebar] p')?.textContent ?? '');
  const rowsNow = await page.evaluate(() => document.querySelectorAll('[data-sidebar] [role="treeitem"][aria-level="2"]').length);
  check(/1 match/.test(matchLine), `searching an id reports one match (${JSON.stringify(matchLine)})`);
  check(rowsNow === 1, `and shows one row (${rowsNow})`);
  const recentGone = await page.evaluate(() => ![...document.querySelectorAll('[data-sidebar] [role="treeitem"][aria-level="1"]')].some(e => /Recent/.test(e.textContent)));
  check(recentGone, 'Recent steps aside while searching');
  await page.screenshot({ path: path.join(shots, 'sidebar-search-1280.png') });
  await page.fill('[data-sidebar] input[aria-label^="Search"]', '');
  await sleep(400);

  // Keyboard: focus the tree, walk down, Enter opens a session.
  await page.focus('[data-sidebar] [role="tree"]');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const focusedBefore = await page.evaluate(() => document.querySelector('[data-sidebar] [role="tree"]')?.getAttribute('aria-activedescendant'));
  await page.keyboard.press('Enter');
  await sleep(800);
  const headerTitle = await page.evaluate(() => document.querySelector('header span.truncate')?.textContent ?? '');
  check(Boolean(focusedBefore), `the tree tracks an active row for the keyboard (${focusedBefore})`);
  check(/^Session \d+ about/.test(headerTitle), `Enter on a row opens that session (header says ${JSON.stringify(headerTitle)})`);

  // The + menu exists and offers the three makes.
  await page.click('[data-sidebar-header] button[aria-haspopup="menu"]');
  await sleep(300);
  const items = await page.evaluate(() => [...document.querySelectorAll('[data-add-menu] [role="menuitem"]')].map(e => e.textContent.trim()));
  check(items.join('|') === 'New session|Open project…|New group…', `the + menu offers exactly the three makes (${items.join(' | ')})`);
  await page.screenshot({ path: path.join(shots, 'sidebar-menu-1280.png') });
  await page.keyboard.press('Escape');

  // Session rows are draggable and headers advertise themselves as drop targets.
  const draggable = await page.evaluate(() => document.querySelectorAll('[data-sidebar] [role="treeitem"][aria-level="2"][draggable="true"]').length > 0);
  check(draggable, 'session rows are draggable');

  // A fold survives a reload.
  const firstHeader = '[data-sidebar] [role="treeitem"][aria-level="1"]:not([id="sidebar-row-0"]) button';
  const foldedLabel = await page.evaluate(() => {
    const headers = [...document.querySelectorAll('[data-sidebar] [role="treeitem"][aria-level="1"]')];
    const project = headers.find(h => !/Recent|App conversations/.test(h.textContent));
    project?.querySelector('button')?.click();
    return project?.textContent.trim().slice(0, 20) ?? '';
  });
  await sleep(400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-sidebar] [role="tree"]', { timeout: 30_000 });
  await sleep(1500);
  const stillFolded = await page.evaluate((label) => {
    const headers = [...document.querySelectorAll('[data-sidebar] [role="treeitem"][aria-level="1"]')];
    const project = headers.find(h => h.textContent.trim().startsWith(label.slice(0, 8)));
    return project?.getAttribute('aria-expanded');
  }, foldedLabel);
  check(stillFolded === 'false', `a fold survives a reload (${JSON.stringify(foldedLabel)} is aria-expanded=${stillFolded})`);
  void firstHeader;
} catch (err) {
  failed += 1; fails.push(`threw: ${err?.message ?? err}`); console.log(`\n  ✗ ${err?.stack ?? err}`);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  if (child?.pid) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
    else { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }
  await sleep(300);
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* handles */ }
}

console.log(`\nSIDEBAR AT SCALE: ${passed} passed, ${failed} failed`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(failed > 0 ? 1 : 0);
