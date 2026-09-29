/**
 * The browser's own window — unit tests for its pure rules: where it opens
 * (remembered, kept on a screen that still exists, cascaded from the AICO
 * window, never larger than the screen), what is remembered, which window
 * hears which event while the browser is popped out, and the ways in and
 * out (Ctrl+Shift+N from the chrome and from inside a page, the tab menu).
 *
 *   node scripts/test-browser-window.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-window-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error', external: ['electron'] });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const core = await load(path.join(desktop, 'electron/browser-window-core.ts'), 'core');
const session = await load(path.join(desktop, 'electron/browser-session-core.ts'), 'session');
const keys = await load(path.join(desktop, 'electron/browser-keys.ts'), 'keys');
const shortcuts = await load(path.join(desktop, 'renderer/src/browser/shortcuts.ts'), 'shortcuts');

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };
const inside = (r, a) => r.x >= a.x && r.y >= a.y && r.x + r.width <= a.x + a.width && r.y + r.height <= a.y + a.height;

// ── What is remembered ──
console.log('\nSaved state');
{
  ok(eq(core.normaliseWindowState(undefined), core.DEFAULT_WINDOW), 'nothing saved: the defaults');
  ok(eq(core.normaliseWindowState('junk'), core.DEFAULT_WINDOW), 'a damaged file: the defaults');
  const s = core.normaliseWindowState({ x: 100.4, y: 50, width: 1000, height: 700, maximized: true, open: true });
  ok(eq(s, { x: 100, y: 50, width: 1000, height: 700, maximized: true, open: true }), 'a saved window round-trips (rounded)', s);
  const tiny = core.normaliseWindowState({ width: 10, height: 10 });
  ok(tiny.width === core.MIN_SIZE.width && tiny.height === core.MIN_SIZE.height, 'never smaller than the minimum size', tiny);
  const half = core.normaliseWindowState({ x: 5, width: 900, height: 600 });
  ok(half.x === undefined && half.y === undefined, 'a place needs both x and y', half);
  ok(core.normaliseWindowState({ open: 'yes', maximized: 1 }).open === false && core.normaliseWindowState({ maximized: 1 }).maximized === false, 'flags are only ever true when saved as true');
}

// ── Where it opens ──
console.log('\nPlacement');
{
  const saved = { x: 200, y: 120, width: 1200, height: 800, maximized: false, open: false };
  ok(eq(core.placeWindow(saved, [primary]), { x: 200, y: 120, width: 1200, height: 800 }), 'where it was left, when that is on a screen');
  const onRight = { ...saved, x: 2100, y: 100 };
  ok(eq(core.placeWindow(onRight, [primary, right]), { x: 2100, y: 100, width: 1200, height: 800 }), 'on the second monitor while it is attached');
  const gone = core.placeWindow(onRight, [primary]);
  ok(inside(gone, primary), 'its monitor unplugged: it comes back onto a screen that exists', gone);
  const offTop = core.placeWindow({ ...saved, y: -600 }, [primary]);
  ok(inside(offTop, primary), 'a title bar above the screen (cannot be grabbed): moved back on', offTop);
  const sliver = core.placeWindow({ ...saved, x: 1880 }, [primary]);
  ok(inside(sliver, primary), 'only a sliver of the title bar on screen: moved back on', sliver);
  const huge = core.placeWindow({ ...saved, width: 5000, height: 3000 }, [primary]);
  ok(huge.width <= primary.width && huge.height <= primary.height, 'never larger than the screen it opens on', huge);

  const fresh = { ...core.DEFAULT_WINDOW };
  const main = { x: 100, y: 80, width: 1400, height: 900 };
  const p = core.placeWindow(fresh, [primary], main);
  ok(p.x === main.x + core.CASCADE && p.y === main.y + core.CASCADE, 'first time: just below and right of the AICO window', p);
  ok(inside(p, primary), 'first time: on the screen', p);
  const mainRight = { x: 2200, y: 200, width: 1600, height: 1000 };
  const pr = core.placeWindow(fresh, [primary, right], mainRight);
  ok(inside(pr, right), 'first time: on the AICO window\'s own monitor', pr);
  const corner = core.placeWindow(fresh, [primary], { x: 1500, y: 700, width: 400, height: 300 });
  ok(inside(corner, primary), 'an AICO window in the corner: the new window is pulled back onto the screen', corner);
  const centred = core.placeWindow(fresh, [primary], null);
  ok(centred.x === Math.round((primary.width - centred.width) / 2), 'no AICO window on screen: centred', centred);
  const small = core.placeWindow(fresh, [{ x: 0, y: 0, width: 800, height: 600 }], null);
  ok(small.width === 800 && small.height === 600 && small.x === 0 && small.y === 0, 'a small screen: filled, not overflowed', small);
  ok(core.placeWindow(fresh, []).width > 0, 'no screens reported: still a sensible size');
}

// ── Who hears what ──
console.log('\nEvent routing');
{
  const r = core.eventRoute;
  ok(eq(r('browser:permission', false), { main: true, browser: false }), 'in the AICO window: everything goes there');
  ok(eq(r('command:run', false), { main: true, browser: false }), 'in the AICO window: commands too');
  for (const ch of ['browser:permission', 'browser:dialog', 'browser:confirm', 'browser:handoff', 'browser:shortcut', 'browser:found', 'browser:download', 'browser:ask', 'browser:focus-address', 'browser:agent', 'browser:htmlFullscreen', 'browser:vault:offer', 'win:fullscreen']) {
    ok(eq(r(ch, true), { main: false, browser: true }), `popped out: ${ch} goes only to the browser's window`);
  }
  for (const ch of ['browser:state', 'browser:tabs', 'browser:bookmarks', 'prefs:changed', 'engine:status', 'plugins:changed']) {
    ok(eq(r(ch, true), { main: true, browser: true }), `popped out: ${ch} goes to both windows`);
  }
  for (const ch of ['browser:import:open', 'browser:import:progress', 'command:run', 'win:maximized', 'win:focus', 'term:data', 'updates:state', 'notify:click', 'activity:tool']) {
    ok(eq(r(ch, true), { main: true, browser: false }), `popped out: ${ch} stays with the AICO window`);
  }
  ok(r('browser:stateful', true).main === false, 'only the exact state channels are shared');
}

// ── Ways in and out ──
console.log('\nShortcut and menu');
{
  const press = (key, mods = {}) => ({ type: 'keyDown', key, control: false, meta: false, shift: false, alt: false, ...mods });
  const spec = keys.browserShortcutSpec(press('N', { control: true, shift: true }), false);
  ok(spec === 'Ctrl+Shift+n', 'Ctrl+Shift+N inside a page is forwarded to the chrome', spec);
  ok(shortcuts.browserShortcut(shortcuts.parseShortcut(spec)) === 'popOut', 'the forwarded key is "pop out"');
  const ev = (key, m = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...m });
  ok(shortcuts.browserShortcut(ev('N', { ctrlKey: true, shiftKey: true })) === 'popOut', 'Ctrl+Shift+N in the chrome is "pop out"');
  ok(shortcuts.browserShortcut(ev('n', { ctrlKey: true })) === null, 'Ctrl+N stays the app\'s (new chat)');
  ok(keys.browserShortcutSpec(press('n', { control: true }), false) === null, 'Ctrl+N inside a page stays the page\'s');

  const base = { blank: false, pinned: false, muted: false, bookmarked: false, count: 2, isLast: false, closedCount: 0 };
  const items = (m) => m.filter(x => x.type === 'item').map(x => x.action);
  ok(!items(session.tabMenuTemplate(base)).some(a => a === 'popOut' || a === 'popIn'), 'tab menu: no window item when there is no pop-out support');
  const inMain = session.tabMenuTemplate({ ...base, window: 'main' });
  ok(items(inMain).includes('popOut') && !items(inMain).includes('popIn'), 'tab menu in the AICO window: "Open browser in its own window"');
  ok(inMain.find(x => x.action === 'popOut')?.label === 'Open browser in its own window', 'tab menu: the label says what happens');
  const inOwn = session.tabMenuTemplate({ ...base, window: 'own' });
  ok(items(inOwn).includes('popIn') && !items(inOwn).includes('popOut'), 'tab menu in its own window: "Move browser back"');
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
