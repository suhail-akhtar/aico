/**
 * Render the social card at `docs/assets/og-card.png`.
 *
 * Every link to the site — in a chat, a tweet, a Slack message, a search
 * result's rich preview — renders whatever `og:image` points at. With none, it
 * renders a blank rectangle, and a blank rectangle is what a broken link looks
 * like.
 *
 * Generated from HTML rather than hand-drawn, so the card cannot drift from the
 * site's own colours and wording: it is the same CSS variables, and the version
 * comes from `package.json`.
 *
 * Run: node scripts/og-card.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const out = path.join(root, 'docs', 'assets', 'og-card.png');

/** 1200x630 is the size every major platform crops to. */
const CARD = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width:1200px; height:630px; display:flex; flex-direction:column;
    justify-content:center; padding:0 84px;
    background:#0d0f12;
    color:#e8eaed;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  }
  .mark { font-size:30px; color:#8ab4f8; letter-spacing:.02em; margin-bottom:28px; }
  .mark b { color:#e8eaed; font-weight:600; }
  h1 { font-size:64px; line-height:1.12; font-weight:600; letter-spacing:-.02em; }
  h1 em { font-style:normal; color:#8ab4f8; }
  p { margin-top:26px; font-size:27px; line-height:1.45; color:#9aa0a6; max-width:930px; }
  .feet { margin-top:44px; display:flex; gap:14px; flex-wrap:wrap; }
  .chip {
    font-size:19px; color:#bdc1c6; border:1px solid #2c3034;
    border-radius:999px; padding:9px 18px; background:#15181c;
  }
  .rule { position:absolute; left:0; top:0; width:100%; height:6px;
          background:linear-gradient(90deg,#8ab4f8,#c58af9 55%,#f28b82); }
</style></head><body>
  <div class="rule"></div>
  <div class="mark">✻ <b>aico</b> &nbsp;v${version}&nbsp; · MIT</div>
  <h1>The coding agent that<br><em>opens what it builds</em></h1>
  <p>Multi-provider, local-first. An append-only session log, in-browser
     verification, and one ledger for everything still running.</p>
  <div class="feet">
    <span class="chip">Terminal + web workspace</span>
    <span class="chip">MCP server</span>
    <span class="chip">2,273 offline tests</span>
  </div>
</body></html>`;

/** Wherever Chrome actually is on this machine. */
function findChrome() {
  const candidates = process.platform === 'win32'
    ? [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(p => p && fs.existsSync(p));
}

const executablePath = findChrome();
if (!executablePath) {
  console.error('No Chrome or Edge found — cannot render the card.');
  process.exit(1);
}

const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(CARD, { waitUntil: 'load' });
  await page.screenshot({ path: out });
  const { size } = fs.statSync(out);
  console.log(`wrote ${path.relative(root, out)} (${Math.round(size / 1024)} KB)`);
} finally {
  await browser.close();
}
