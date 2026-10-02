/**
 * Live check of the morning brief in the real desktop app (one real ranking
 * call to the cheapest model of the configured provider — COSTS MONEY, well
 * under a cent; run only when asked):
 *
 *   node scripts/brief-live.mjs <outDir>
 *
 * Why it exists: the collectors, the ranking and the card each pass their
 * own tests; this proves the brief a person actually sees on Home is the one
 * the engine built — urgent first, with its actions — from a real model call.
 *
 *   1  an isolated AICO_HOME (settings.json copied in for the provider key);
 *   2  a brief generated from the recorded `gh` fixtures
 *      (scripts/fixtures/brief-gh) for a scratch project, one inbox-free,
 *      advisory-free store — and the ranking call made for real;
 *   3  the desktop launched on that store: Home must show the card with the
 *      model's summary, the urgent items first and their action buttons,
 *      and History must list the brief.
 *
 * Requires `npm run build` at the root (dist-test) and the desktop build.
 * Screenshots: <outDir>/brief-*.png.
 *
 * @module desktop/scripts/brief-live
 */

import '../../scripts/lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fakeRunner } from '../../scripts/lib/brief-fake-gh.mjs';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'aico-brief-live'));
fs.mkdirSync(outDir, { recursive: true });

const T = await import('../../dist-test/test-exports.js');
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'payments-api '));
process.on('exit', () => { try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ } });

let failed = 0;
const check = (cond, name) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) failed++; };

// 1–2. The brief, from fixtures, ranked by a real model.
const brief = await T.briefService.generateBrief('manual', {
  run: fakeRunner().run,
  projects: [project],
  audit: async () => undefined,
});
console.log(`  brief ${brief.id}: ${brief.items.length} items, ranked by ${brief.rankedBy} (${brief.model ?? '-'}), $${(brief.costUsd ?? 0).toFixed(5)}`);
console.log(`  summary: ${brief.summary}`);
for (const n of brief.notes) console.log(`  note: ${n}`);
check(brief.rankedBy === 'model', 'the one ranking call answered usably');
check((brief.costUsd ?? 1) <= 0.01, `cost ≤ $0.01 (was $${(brief.costUsd ?? NaN).toFixed(5)})`);
check(brief.items[0]?.urgency === 'urgent', 'urgent first');

// 3. The desktop on that store.
const exe = process.env.AICO_EXE ?? path.join(desktop, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = await electron.launch({ executablePath: exe, args: process.env.AICO_EXE ? [] : [desktop], env: { ...process.env }, timeout: 60_000 });
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w?.unmaximize(); w?.setContentSize(1440, 1000); }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 90_000 }).catch(() => {});
  await page.waitForSelector('[data-brief-card] [data-brief-summary]', { timeout: 60_000 });
  const card = page.locator('[data-brief-card]');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, 'brief-home.png') });
  await card.screenshot({ path: path.join(outDir, 'brief-card.png') });
  const text = await card.innerText();
  check(text.includes(brief.summary.slice(0, 40)), 'the card shows the model summary');
  const levels = await page.$$eval('[data-brief-item]', els => els.map(e => e.getAttribute('data-brief-item')));
  check(levels.length > 0 && levels[0] === 'urgent' && levels.lastIndexOf('urgent') < (levels.findIndex(l => l !== 'urgent') === -1 ? Infinity : levels.findIndex(l => l !== 'urgent')), `urgent rows first (${levels.join(',')})`);
  check(/Review requested: acme\/payments-api#412/.test(text) && /CI failing on main/.test(text), 'GitHub items from the fixtures are on the card');
  check(/Open PR/.test(text) && /Start a fix/.test(text), 'one-click actions are on the rows');
  await page.click('[data-brief-card] button:has-text("History")');
  await page.waitForTimeout(800);
  await card.screenshot({ path: path.join(outDir, 'brief-history.png') });
  check((await card.innerText()).includes('Brief history') || (await page.locator('[aria-label="Brief history"] li').count()) >= 1, 'History lists the brief');
} finally {
  await app.close().catch(() => {});
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
console.log(`screenshots: ${outDir}`);
process.exit(failed ? 1 : 0);
