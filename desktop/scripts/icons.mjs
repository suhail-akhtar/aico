/**
 * Render the AICO app icon to PNG with Electron itself — no image tooling to
 * install. Writes build/icon.png (1024², which electron-builder turns into the
 * Windows .ico and the Linux icon set) and dist/icon.png (window and tray).
 *
 *   node scripts/icons.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const exe = path.join(desktop, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3B82F6"/>
      <stop offset="1" stop-color="#111827"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="220" fill="url(#g)"/>
  <path d="M322 736 512 272l190 464" fill="none" stroke="#fff" stroke-width="84" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M396 576h232" stroke="#fff" stroke-width="84" stroke-linecap="round"/>
</svg>`;

const renderer = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const html = '<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent">' + process.env.AICO_ICON_SVG + '</body></html>';
  await w.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise(r => setTimeout(r, 400));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  for (const out of JSON.parse(process.env.AICO_ICON_OUT)) {
    fs.mkdirSync(require('path').dirname(out.file), { recursive: true });
    fs.writeFileSync(out.file, (out.size === 1024 ? img : img.resize({ width: out.size, height: out.size, quality: 'best' })).toPNG());
  }
  app.quit();
});`;

// The icons are committed. Rendering needs a display, which CI runners do not
// have, so render only when asked (--force) or when an icon is missing; a
// normal build just copies the window icon into dist/.
const have = fs.existsSync(path.join(desktop, 'build', 'icon.png')) && fs.existsSync(path.join(desktop, 'build', 'icons', '256x256.png'));
if (have && !process.argv.includes('--force')) {
  fs.mkdirSync(path.join(desktop, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(desktop, 'build', 'icons', '256x256.png'), path.join(desktop, 'dist', 'icon.png'));
  console.log('icons: using the committed build/icon.png (pass --force to re-render)');
  process.exit(0);
}

const tmp = path.join(desktop, 'build', '.icon-render.cjs');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, renderer);
const outputs = [
  { file: path.join(desktop, 'build', 'icon.png'), size: 1024 },
  { file: path.join(desktop, 'dist', 'icon.png'), size: 256 },
  ...[16, 32, 48, 64, 128, 256, 512].map(size => ({ file: path.join(desktop, 'build', 'icons', `${size}x${size}.png`), size })),
];
const r = spawnSync(exe, [tmp], { env: { ...process.env, AICO_ICON_SVG: svg, AICO_ICON_OUT: JSON.stringify(outputs), ELECTRON_ENABLE_LOGGING: '0' }, stdio: 'inherit', timeout: 60_000 });
fs.rmSync(tmp, { force: true });
if (r.status !== 0) { console.error('icon render failed'); process.exit(1); }
console.log(`icons: ${outputs.map(o => path.relative(desktop, o.file)).join(', ')}`);
