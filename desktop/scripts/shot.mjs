/**
 * Launch AICO Desktop under Playwright, run a few steps, and save screenshots.
 *
 *   node scripts/shot.mjs <outDir> [steps.json]
 *
 * Uses an isolated AICO_HOME (never the real ~/.aico). Steps are small JSON
 * actions so a walkthrough can be scripted without editing this file:
 *   { "click": "text=Settings" } | { "press": "Control+K" } | { "type": "hello" }
 *   { "wait": 800 } | { "shot": "name" } | { "eval": "js expression" } | { "fill": ["selector", "text"] }
 *
 * @module desktop/scripts/shot
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'aico-desktop-shots'));
const steps = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : [{ shot: 'home' }];
fs.mkdirSync(outDir, { recursive: true });

const home = process.env.AICO_HOME ?? path.join(os.tmpdir(), 'aico-desktop-test-home');
fs.mkdirSync(home, { recursive: true });

// AICO_EXE runs a packaged build instead of the development one.
const exe = process.env.AICO_EXE ?? path.join(desktop, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = await electron.launch({
  executablePath: exe,
  args: process.env.AICO_EXE ? [] : [desktop],
  env: { ...process.env, AICO_HOME: home },
  timeout: 60_000,
});
const log = [];
const page = await app.firstWindow();
page.on('console', m => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});

// Wait for the engine gate to go.
try {
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 90_000 });
} catch { log.push('[shot] engine gate still up after 90s'); }
await page.waitForTimeout(800);

let n = 0;
for (const s of steps) {
  try {
    if (s.click) await page.click(s.click, { timeout: 8000 });
    else if (s.dblclick) await page.dblclick(s.dblclick, { timeout: 8000 });
    else if (s.press) await page.keyboard.press(s.press);
    else if (s.type) await page.keyboard.type(s.type, { delay: 10 });
    else if (s.fill) await page.fill(s.fill[0], s.fill[1], { timeout: 8000 });
    else if (s.wait) await page.waitForTimeout(s.wait);
    else if (s.waitFor) await page.waitForSelector(s.waitFor, { timeout: s.timeout ?? 60_000 });
    else if (s.eval) log.push(`[eval] ${JSON.stringify(await page.evaluate(s.eval))}`);
    else if (s.shot) {
      const file = path.join(outDir, `${String(++n).padStart(2, '0')}-${s.shot}.png`);
      await page.screenshot({ path: file });
      log.push(`[shot] ${file}`);
    }
  } catch (err) {
    log.push(`[step-error] ${JSON.stringify(s)}: ${err.message.split('\n')[0]}`);
    const file = path.join(outDir, `${String(++n).padStart(2, '0')}-error.png`);
    await page.screenshot({ path: file }).catch(() => {});
  }
}
fs.writeFileSync(path.join(outDir, 'log.txt'), log.join('\n'));
console.log(log.filter(l => !l.includes('[debug]')).slice(-60).join('\n'));
await app.close();
