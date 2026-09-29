/**
 * The built-in browser as an everyday browser — unit tests for its pure
 * rules: tab order (drag, pin, openers, close), the closed-tab stack, the
 * session file, the profile migration, kept session cookies, the user agent,
 * the page's right-click menu, keyboard shortcuts, what kind of page this is
 * (with real-looking JSON-LD) and autofill (including the fields it must
 * never fill).
 *
 *   node scripts/test-browser-tabs.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-tabs-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error', jsx: 'automatic', external: ['react', 'react-dom', 'electron'] });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const core = await load(path.join(desktop, 'electron/browser-session-core.ts'), 'core');
const rtabs = await load(path.join(desktop, 'renderer/src/browser/tabs.ts'), 'rtabs');
const menu = await load(path.join(desktop, 'electron/context-menu-template.ts'), 'menu');
const keys = await load(path.join(desktop, 'electron/browser-keys.ts'), 'keys');
const shortcuts = await load(path.join(desktop, 'renderer/src/browser/shortcuts.ts'), 'shortcuts');
const suggest = await load(path.join(desktop, 'renderer/src/browser/suggest.ts'), 'suggest');
const af = await load(path.join(desktop, 'electron/browser-autofill.ts'), 'autofill');

// ── Tab order ──
console.log('\nTab order');
{
  const pinned = new Set(['p1', 'p2']);
  const order = ['p1', 'p2', 'a', 'b', 'c', 'd'];
  ok(eq(core.moveTab(order, pinned, 'a', 3), ['p1', 'p2', 'b', 'a', 'c', 'd']), 'drag: a tab moves to the slot it is dropped on');
  ok(eq(core.moveTab(order, pinned, 'd', 0), ['p1', 'p2', 'd', 'a', 'b', 'c']), 'drag: an unpinned tab stops at the pinned group edge');
  ok(eq(core.moveTab(order, pinned, 'p1', 5), ['p2', 'p1', 'a', 'b', 'c', 'd']), 'drag: a pinned tab stays among the pinned');
  ok(eq(core.moveTab(order, pinned, 'zz', 2), order), 'drag: an unknown tab changes nothing');
  const pin = core.setPinned(order, pinned, 'c', true);
  ok(eq(pin.order, ['p1', 'p2', 'c', 'a', 'b', 'd']) && pin.pinned.has('c'), 'pin: goes to the end of the pinned group', pin.order);
  const unpin = core.setPinned(order, pinned, 'p1', false);
  ok(eq(unpin.order, ['p2', 'p1', 'a', 'b', 'c', 'd']) && !unpin.pinned.has('p1'), 'unpin: goes to the start of the others', unpin.order);
  ok(eq(core.pinnedFirst([{ id: 'a' }, { id: 'b', pinned: true }, { id: 'c' }, { id: 'd', pinned: true }]).map(t => t.id), ['b', 'd', 'a', 'c']), 'pinned tabs always come first (stable)');

  const openers = { x1: 'a', x2: 'a' };
  const of = (id) => openers[id];
  ok(core.insertIndex(['a', 'b', 'c'], 'a', of) === 1, 'a link opened from a tab lands just after it');
  ok(core.insertIndex(['a', 'x1', 'x2', 'b'], 'a', of) === 3, 'several links opened in a row keep their order (after the earlier ones)');
  ok(core.insertIndex(['a', 'b'], undefined, of) === 2, 'Ctrl+T goes at the end');
  ok(core.insertIndex(['p', 'a'], 'p', of, new Set(['p'])) === 1, 'a link from a pinned tab lands after the pinned group');
  ok(eq(core.placeAt(['a', 'b', 'c', 'n'], 'n', 1), ['a', 'n', 'b', 'c']), 'placeAt moves a tab to an index');

  ok(core.nextActive(['a', 'b', 'c'], 'b', 'b') === 'c', 'closing the tab in front brings its right neighbour forward');
  ok(core.nextActive(['a', 'b', 'c'], 'c', 'c') === 'b', 'closing the last tab brings the left one forward');
  ok(core.nextActive(['a', 'b', 'c'], 'a', 'c') === 'c', 'closing a background tab keeps the one in front');
  ok(core.nextActive(['a'], 'a', 'a') === null, 'closing the only tab leaves none');

  ok(core.tabForDigit(['a', 'b', 'c'], 2) === 'b' && core.tabForDigit(['a', 'b', 'c'], 9) === 'c' && core.tabForDigit(['a', 'b'], 5) === null, 'Ctrl+1…8 pick a tab, Ctrl+9 the last');
  ok(rtabs.tabForDigit(['a', 'b', 'c'], 9) === 'c' && rtabs.tabForDigit(['a', 'b', 'c'], 1) === 'a', 'renderer: the same digit rule');
  const t = [{ id: 'p', pinned: true }, { id: 'a' }, { id: 'b' }];
  ok(rtabs.moveTarget(t, 'a', 1) === 2 && rtabs.moveTarget(t, 'a', -1) === null && rtabs.moveTarget(t, 'p', 1) === null, 'Ctrl+Shift+PgUp/PgDn stop at the group edge');
  const boxes = [{ id: 'p', left: 0, width: 40, pinned: true }, { id: 'a', left: 40, width: 200 }, { id: 'b', left: 240, width: 200 }, { id: 'c', left: 440, width: 200 }];
  ok(rtabs.dropIndex(boxes, 'a', 500) === 2, 'drag preview: past the middle of the next tabs', rtabs.dropIndex(boxes, 'a', 500));
  ok(rtabs.dropIndex(boxes, 'c', 10) === 1, 'drag preview: an unpinned tab cannot land among the pinned');
  ok(rtabs.dropIndex(boxes, 'p', 600) === 0, 'drag preview: a pinned tab cannot land among the others');
  ok(eq(rtabs.previewOrder(boxes, 'a', 2).map(b => b.id), ['p', 'b', 'a', 'c']), 'drag preview order');
}

// ── Closed tabs and the session file ──
console.log('\nSession');
{
  let stack = [];
  for (let i = 0; i < 30; i++) stack = core.pushClosed(stack, { url: `https://e.com/${i}`, title: `${i}`, closedAt: i, position: i });
  ok(stack.length === 25 && stack[0].url === 'https://e.com/29', 'the closed-tab stack keeps the newest 25');
  ok(core.pushClosed([], { url: 'about:blank', title: '', closedAt: 1, position: 0 }).length === 0, 'a blank tab is not worth reopening');
  ok(core.pushClosed([], { url: 'chrome-error://chromewebdata/', title: '', closedAt: 1, position: 0 }).length === 0, 'an error page is not reopened');

  const entries = Array.from({ length: 50 }, (_, i) => ({ url: `https://s.com/p${i}`, title: `P${i}`, pageState: 'x' }));
  entries[10] = { url: 'chrome-error://chromewebdata/', title: 'err' };
  const tr = core.trimEntries(entries, 40);
  ok(tr.entries.length === core.ENTRY_CAP && tr.entries[tr.index].url === 'https://s.com/p40', 'back/forward stack: capped around the current entry', { n: tr.entries.length, cur: tr.entries[tr.index]?.url });
  ok(!tr.entries.some(e => e.url.startsWith('chrome-error')), 'back/forward stack: error pages dropped');
  const big = core.trimEntries([{ url: 'https://a.com', title: 'a', pageState: 'y'.repeat(core.PAGE_STATE_CAP + 1) }], 0);
  ok(big.entries[0] && big.entries[0].pageState === undefined, 'an oversized page state is not kept (the page still is)');

  const s = core.normaliseSession({
    active: 7, closed: [{ url: 'https://c.com', title: 'c', closedAt: 5, position: 2 }, { url: 'javascript:alert(1)' }],
    tabs: [{ url: 'https://a.com', title: 'A' }, { url: 'devtools://x' }, 'junk', { url: 'https://b.com', title: 'B', pinned: true, entries: [{ url: 'https://b.com/1', title: '1' }, { url: 'https://b.com', title: 'B' }], index: 1 }],
  });
  ok(s.tabs.length === 2 && s.tabs[0].url === 'https://b.com' && s.tabs[0].pinned, 'session file: junk dropped, pinned first', s.tabs.map(t => t.url));
  ok(s.tabs[0].entries.length === 2 && s.tabs[0].index === 1, 'session file: the back/forward stack survives');
  ok(s.active === 0, 'session file: an out-of-range active index falls back to the first tab');
  ok(s.closed.length === 1 && s.closed[0].position === 2, 'session file: closed tabs kept, unsafe ones dropped');
  ok(eq(core.normaliseSession(null).tabs, []) && eq(core.normaliseSession('x').closed, []), 'session file: a missing or damaged file is an empty session');
  ok(core.isRestorable('https://x.com') && core.isRestorable('about:blank') && !core.isRestorable('javascript:1') && !core.isRestorable('') && core.isRestorable('view-source:https://x.com'), 'restorable addresses');

  const menuSpec = core.tabMenuTemplate({ blank: false, pinned: true, muted: false, bookmarked: false, count: 3, isLast: true, closedCount: 0 });
  const labels = menuSpec.filter(x => x.type === 'item').map(x => x.label);
  ok(labels.includes('Unpin') && labels.includes('Duplicate') && labels.includes('Mute site') && labels.includes('Close other tabs'), 'tab menu: pin/duplicate/mute/close others', labels);
  ok(menuSpec.find(x => x.action === 'closeRight')?.enabled === false && menuSpec.find(x => x.action === 'reopenClosed')?.enabled === false, 'tab menu: nothing to the right of the last tab; nothing to reopen yet');
}

// ── Profile migration ──
console.log('\nProfile');
{
  ok(core.migrationPlan({ markerExists: false, newHasData: false, oldHasData: true }) === 'copy', 'migration: an old profile is copied into an empty new one');
  ok(core.migrationPlan({ markerExists: true, newHasData: false, oldHasData: true }) === 'none', 'migration: only once');
  ok(core.migrationPlan({ markerExists: false, newHasData: true, oldHasData: true }) === 'none', 'migration: never over a profile that has data');
  ok(core.migrationPlan({ markerExists: false, newHasData: false, oldHasData: false }) === 'none', 'migration: nothing to copy on a fresh install');
  ok(core.skipOnCopy('GPUCache') && core.skipOnCopy(path.join('GPUCache', 'data_0')) && core.skipOnCopy(path.join('Local Storage', 'leveldb', 'LOCK')) && !core.skipOnCopy(path.join('Network', 'Cookies')) && !core.skipOnCopy('Cache'), 'migration: GPU caches and lock files skipped, cookies and cache kept');
  ok(core.profileHasData(['Network', 'Preferences']) && !core.profileHasData(['.aico-profile']), 'a profile with a cookie store has data');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-prof-'));
  const oldDir = path.join(tmp, 'electron', 'Partitions', 'aico-browser');
  const newDir = path.join(tmp, 'browser', 'profile');
  fs.mkdirSync(path.join(oldDir, 'Network'), { recursive: true });
  fs.mkdirSync(path.join(oldDir, 'Local Storage', 'leveldb'), { recursive: true });
  fs.mkdirSync(path.join(oldDir, 'GPUCache'), { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'Network', 'Cookies'), 'cookie-db');
  fs.writeFileSync(path.join(oldDir, 'Local Storage', 'leveldb', '000003.log'), 'ls');
  fs.writeFileSync(path.join(oldDir, 'Local Storage', 'leveldb', 'LOCK'), '');
  fs.writeFileSync(path.join(oldDir, 'GPUCache', 'data_0'), 'gpu');
  ok(core.migrateProfile(oldDir, newDir) === 'copied', 'migration (real folders): copied');
  ok(fs.readFileSync(path.join(newDir, 'Network', 'Cookies'), 'utf8') === 'cookie-db' && fs.existsSync(path.join(newDir, 'Local Storage', 'leveldb', '000003.log')), 'migration: cookies and localStorage arrive');
  ok(!fs.existsSync(path.join(newDir, 'GPUCache')) && !fs.existsSync(path.join(newDir, 'Local Storage', 'leveldb', 'LOCK')), 'migration: GPU cache and LOCK not copied');
  ok(fs.existsSync(path.join(oldDir, 'Network', 'Cookies')), 'migration: the old profile is left in place');
  fs.writeFileSync(path.join(newDir, 'Network', 'Cookies'), 'newer');
  ok(core.migrateProfile(oldDir, newDir) === 'none' && fs.readFileSync(path.join(newDir, 'Network', 'Cookies'), 'utf8') === 'newer', 'migration: a second run changes nothing');
  const fresh = path.join(tmp, 'fresh', 'profile');
  ok(core.migrateProfile(path.join(tmp, 'nope'), fresh) === 'none' && fs.existsSync(path.join(fresh, '.aico-profile')), 'migration: a fresh install just gets the marker');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Session cookies and the user agent ──
console.log('\nCookies and user agent');
{
  const all = [
    { name: 'sid', value: '1', domain: 'shop.example.com', hostOnly: true, path: '/', secure: true, httpOnly: true, session: true, sameSite: 'lax' },
    { name: 'keep', value: '2', domain: '.example.com', path: '/', session: false, expirationDate: 2e9 },
    { name: 'dom', value: '3', domain: '.example.com', hostOnly: false, path: '/app', session: true, sameSite: 'no_restriction', secure: true },
  ];
  const sc = core.sessionCookies(all);
  ok(sc.length === 2 && sc.every(c => c.session), 'only session cookies are saved (persistent ones are in the store already)');
  const a = core.cookieToSet(all[0]);
  ok(a.url === 'https://shop.example.com/' && a.domain === undefined && a.secure && a.httpOnly && a.sameSite === 'lax' && a.expirationDate === undefined, 'a host-only session cookie comes back host-only, still a session cookie', a);
  const b = core.cookieToSet(all[2]);
  ok(b.domain === '.example.com' && b.url === 'https://example.com/app', 'a domain cookie keeps its domain and path', b);
  ok(core.cookieToSet({ name: 'x', value: '1', domain: 'a.com', sameSite: 'no_restriction', secure: false }) === null, 'SameSite=None without Secure is not recreated');
  const host = core.cookieToSet({ name: '__Host-t', value: '1', domain: '.a.com', path: '/' });
  ok(host.secure && host.domain === undefined, '__Host- cookies stay secure and host-only');
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AICO/0.27.0 Chrome/144.0.7559.60 Electron/44.4.5 Safari/537.36';
  const clean = core.cleanUserAgent(ua);
  ok(clean === 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36', 'the user agent reads as Chrome (no Electron / AICO tokens)', clean);
  ok(core.cleanUserAgent(clean) === clean, 'cleaning is idempotent');
}

// ── The page's right-click menu ──
console.log('\nContext menu');
{
  const base = { linkURL: '', srcURL: '', pageURL: 'https://news.example.com/a', mediaType: 'none', hasImageContents: false, isEditable: false, selectionText: '', misspelledWord: '', dictionarySuggestions: [], editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: true } };
  const B = { surface: 'browser', inspect: false, canGoBack: true, canGoForward: false };
  const items = (p, o = B) => menu.buildContextMenuTemplate({ ...base, ...p }, o).filter(x => x.type !== 'separator');
  const acts = (p, o) => items(p, o).map(x => x.action);
  const link = acts({ linkURL: 'https://example.com/x', linkText: 'X' });
  ok(['openLinkNewTab', 'openLinkBackground', 'saveLink', 'copyLink', 'askLink', 'inspect'].every(a => link.includes(a)), 'link: new tab, background tab, save, copy, ask AICO, inspect', link);
  ok(!link.includes('back'), 'link: no page navigation items');
  const img = acts({ mediaType: 'image', srcURL: 'https://cdn.example.com/p.jpg', hasImageContents: true });
  ok(['openImageNewTab', 'saveImage', 'copyImage', 'copyImageAddress', 'askImage'].every(a => img.includes(a)), 'image: open, save, copy, copy address, ask AICO', img);
  const sel = items({ selectionText: 'quantum entanglement is spooky action at a distance', editFlags: { ...base.editFlags, canCopy: true } });
  ok(sel.some(x => x.action === 'searchWeb' && /^Search the web for “quantum entanglement is/.test(x.label) && x.label.endsWith('…”')), 'selection: search the web, label clipped', sel.map(x => x.label));
  ok(['copy', 'askSelection', 'translateSelection'].every(a => sel.map(x => x.action).includes(a)), 'selection: copy, ask AICO, translate');
  const ed = items({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
  ok(ed[0].type === 'spelling' && ed[0].word === 'the' && ed.some(x => x.action === 'addToDictionary'), 'editable: spelling suggestions first');
  ok(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].every(a => ed.map(x => x.action).includes(a)) && !ed.some(x => x.action === 'askSelection'), 'editable: undo … select all, no AICO items on your own typing');
  const page = items({});
  ok(['back', 'forward', 'reload', 'savePage', 'print', 'summarizePage', 'viewSource', 'inspect'].every(a => page.map(x => x.action).includes(a)), 'page: back/forward/reload, save, print, summarize, view source, inspect', page.map(x => x.action));
  ok(page.find(x => x.action === 'forward').enabled === false, 'page: forward greyed with no forward history');
  const vid = acts({ mediaType: 'video', srcURL: 'https://v.example.com/a.mp4', mediaFlags: { canShowPictureInPicture: true, canToggleControls: true, canLoop: true } });
  ok(['pictureInPicture', 'toggleLoop', 'toggleControls', 'openMediaNewTab', 'saveMedia', 'copyMediaAddress'].every(a => vid.includes(a)), 'video: picture in picture, loop, controls, open, save, copy', vid);
  const app = acts({ linkURL: 'https://example.com' }, { surface: 'app', inspect: false });
  ok(eq(app, ['openLinkExternal', 'openLinkInBrowser', 'copyLink']), 'the app window keeps its own short link menu', app);
  ok(acts({}, { surface: 'app', inspect: false }).length === 0, 'the app window: nothing on a plain right-click');
  const ask = menu.askFor('askSelection', { ...base, selectionText: 'a\nb' });
  ok(ask && !ask.send && ask.text.includes('> a\n> b'), '"Ask AICO" puts the quote in the box to finish');
  ok(menu.askFor('summarizePage', base).send === true && menu.askFor('translateSelection', { ...base, selectionText: 'hola' }).send === true, 'Summarize / Translate go straight to the copilot');
  ok(menu.clipLabel('Tom & Jerry') === 'Tom && Jerry', '"&" is escaped in native menu labels');
}

// ── Shortcuts ──
console.log('\nShortcuts');
{
  const K = (key, m = {}) => ({ type: 'keyDown', key, control: false, meta: false, shift: false, alt: false, ...m });
  ok(keys.browserShortcutSpec(K('T', { control: true, shift: true }), false) === 'Ctrl+Shift+t', 'from the page: Ctrl+Shift+T is the browser\'s');
  ok(keys.browserShortcutSpec(K('3', { control: true }), false) === 'Ctrl+3', 'from the page: Ctrl+3');
  ok(keys.browserShortcutSpec(K('F11'), false) === 'F11' && keys.browserShortcutSpec(K('F11', { shift: true }), false) === 'Shift+F11', 'from the page: F11 / Shift+F11');
  ok(keys.browserShortcutSpec(K('PageDown', { control: true }), false) === 'Ctrl+PageDown', 'from the page: Ctrl+PgDn');
  ok(keys.browserShortcutSpec(K('s', { control: true }), false) === null && keys.browserShortcutSpec(K('u', { control: true }), false) === null, 'Ctrl+S / Ctrl+U stay with the page (editors use them)');
  ok(keys.browserShortcutSpec(K('Escape'), false) === null, 'Esc stays with the page');
  const S = (spec) => shortcuts.browserShortcut(shortcuts.parseShortcut(spec), false);
  ok(S('Ctrl+Shift+t') === 'reopenTab' && S('Ctrl+1') === 'tab1' && S('Ctrl+9') === 'tab9', 'reopen closed tab, Ctrl+1 / Ctrl+9');
  ok(S('F11') === 'fullscreen' && S('Shift+F11') === 'fullView', 'F11 full screen, Shift+F11 full view');
  ok(S('Ctrl+PageDown') === 'nextTab' && S('Ctrl+PageUp') === 'prevTab' && S('Ctrl+Shift+PageUp') === 'moveTabLeft', 'Ctrl+PgUp/PgDn cycle, with Shift move the tab');
  ok(S('Ctrl+Tab') === 'nextTab' && S('Ctrl+Shift+Tab') === 'prevTab', 'Ctrl+Tab / Ctrl+Shift+Tab');
}

// ── What kind of page ──
console.log('\nPage kinds');
{
  const sig = (p = {}) => ({
    url: 'https://www.example.com/', title: '', ld: [], microdata: [], og: {},
    fields: { total: 0, personal: 0, address: 0, email: 0, password: 0, card: 0, search: 0, textarea: 0 },
    editor: false, video: { present: false }, text: { paragraphs: 0, words: 0, article: false },
    cues: { addToCart: false, checkout: false, placeOrder: false, cart: false, signIn: false, results: false }, prices: 0, ...p,
  });
  // Real-looking JSON-LD, as the collector reports it (types and a few fields), from shapes seen on retail, news and recipe sites.
  const product = sig({ url: 'https://www.bestbuy.com/site/sony-wh-1000xm5/6505727.p', ld: [{ type: ['Product'], name: 'Sony WH-1000XM5 Wireless Headphones', price: '329.99', currency: 'USD', rating: 4.73, reviews: 5432 }], cues: { ...sig().cues, addToCart: true }, prices: 6 });
  const p = suggest.classifyPage(product);
  ok(p.kind === 'product' && p.confidence >= 0.9 && p.detail === '$329.99 · 4.7★', 'Product JSON-LD → product, with price and rating', p);
  const chips = suggest.suggestionsFor(p).map(c => c.label);
  ok(chips.includes('Compare prices') && chips.includes('Summarize reviews') && chips.includes('Is this a good deal?'), 'product chips', chips);
  ok(suggest.suggestionsFor(p).every(c => /do not (add anything to a cart|buy)/i.test(c.prompt) || c.id === 'sg-specs' || c.id === 'sg-reviews'), 'product chips never buy');

  const news = sig({ url: 'https://www.theguardian.com/science/2026/sep/28/x', ld: [{ type: ['WebPage'] }, { type: ['NewsArticle'], name: 'Scientists find…', org: 'The Guardian', date: '2026-09-28T10:00:00Z' }, { type: ['Organization'], name: 'The Guardian' }], text: { paragraphs: 14, words: 1200, article: true } });
  const n = suggest.classifyPage(news);
  ok(n.kind === 'article' && n.detail === 'The Guardian', 'NewsArticle inside a Yoast-style @graph → article', n);
  ok(suggest.suggestionsFor(n).map(c => c.label).join('|') === 'Summarize|Key points|Fact-check|Explain simply', 'article chips');

  const recipe = sig({ url: 'https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/', ld: [{ type: ['Recipe'], name: 'Best Chocolate Chip Cookies', yield: '24', rating: 4.6 }] });
  ok(suggest.classifyPage(recipe).kind === 'recipe' && suggest.suggestionsFor(suggest.classifyPage(recipe)).some(c => c.label === 'Scale to 2 servings'), 'Recipe → recipe, with "Scale to 2 servings"');
  const job = sig({ url: 'https://boards.greenhouse.io/acme/jobs/123', ld: [{ type: ['JobPosting'], name: 'Senior Engineer', org: 'Acme', date: '2026-09-01' }], fields: { ...sig().fields, total: 8, personal: 5, email: 1 } });
  const j = suggest.classifyPage(job);
  ok(j.kind === 'job' && suggest.suggestionsFor(j).some(c => c.label === 'Draft a cover letter') && suggest.suggestionsFor(j).some(c => c.label === 'Match to my skills'), 'JobPosting → job chips');
  ok(suggest.pageSuggestions(job).chips.some(c => c.id === 'sg-fill-profile'), 'a job page with an application form also offers "Fill this form with my profile"');
  ok(suggest.classifyPage(sig({ ld: [{ type: ['MusicEvent'], name: 'Gig', date: '2026-10-10T20:00' }] })).kind === 'event', 'MusicEvent → event');
  ok(suggest.classifyPage(sig({ url: 'https://www.youtube.com/watch?v=abc', video: { present: true, duration: 600 } })).kind === 'video', 'YouTube watch page → video');
  ok(suggest.classifyPage(sig({ url: 'https://www.youtube.com/' })).kind !== 'video', 'YouTube home is not a video');
  ok(suggest.classifyPage(sig({ url: 'https://news.site.com/a', ld: [{ type: ['NewsArticle'] }, { type: ['VideoObject'] }] })).kind === 'article', 'an article with an embedded video is an article');
  ok(suggest.classifyPage(sig({ microdata: ['product', 'offer'] })).kind === 'product', 'microdata Product → product');
  ok(suggest.classifyPage(sig({ og: { type: 'product', price: '19.99', currency: 'GBP' } })).detail === '£19.99', 'OpenGraph product price');

  const checkout = sig({ url: 'https://shop.example.com/checkout/payment', ld: [{ type: ['Product'] }], cues: { ...sig().cues, checkout: true, placeOrder: true }, fields: { ...sig().fields, total: 12, address: 5, card: 3, personal: 7 } });
  const c = suggest.classifyPage(checkout);
  ok(c.kind === 'checkout', 'a checkout page outranks the product data on it', c);
  const cchips = suggest.suggestionsFor(c);
  ok(cchips[0].label === 'Review this order before I pay' && /do not click pay/i.test(cchips[0].prompt), 'checkout: "Review this order before I pay" — never pay');
  ok(cchips.every(x => !/^(pay|place order|buy)/i.test(x.label)), 'checkout: no chip pays or places the order');
  ok(suggest.classifyPage(sig({ url: 'https://shop.example.com/cart', cues: { ...sig().cues, cart: true } })).kind === 'cart', 'a cart page');

  ok(suggest.classifyPage(sig({ url: 'https://accounts.example.com/login', fields: { ...sig().fields, total: 3, password: 1, email: 1, personal: 1 }, cues: { ...sig().cues, signIn: true } })).kind === 'login', 'a sign-in page');
  const form = suggest.classifyPage(sig({ url: 'https://forms.example.org/contact', fields: { ...sig().fields, total: 6, personal: 5, email: 1, address: 2, textarea: 1 } }));
  ok(form.kind === 'form' && suggest.suggestionsFor(form)[0].label === 'Fill this form with my profile', 'a personal form → "Fill this form with my profile"');
  ok(/browser_autofill/.test(suggest.suggestionsFor(form)[0].prompt) && /do not submit/i.test(suggest.suggestionsFor(form)[0].prompt), 'the form chip uses browser_autofill and does not submit');
  ok(suggest.classifyPage(sig({ url: 'https://mail.google.com/mail/u/0/#inbox/abc' })).kind === 'email', 'Gmail → mail');
  ok(suggest.suggestionsFor(suggest.classifyPage(sig({ url: 'https://mail.google.com/mail/u/0/' })))[0].label === 'Draft a reply', 'mail: "Draft a reply"');
  ok(suggest.classifyPage(sig({ url: 'https://app.slack.com/client/T1/C1' })).kind === 'chat', 'Slack → chat');
  ok(suggest.classifyPage(sig({ url: 'https://github.com/electron/electron' })).kind === 'code', 'a GitHub repo → code');
  ok(suggest.classifyPage(sig({ url: 'https://stackoverflow.com/questions/123/how' })).kind === 'qa', 'a Stack Overflow question → Q&A');
  ok(suggest.classifyPage(sig({ url: 'https://developer.mozilla.org/en-US/docs/Web/API/fetch' })).kind === 'docs', 'MDN → docs');
  ok(suggest.classifyPage(sig({ url: 'https://www.google.com/search?q=x', cues: { ...sig().cues, results: true }, fields: { ...sig().fields, search: 1, total: 1 } })).kind === 'search', 'search results');
  ok(suggest.classifyPage(sig({ url: 'https://blog.example.com/p', text: { paragraphs: 9, words: 900, article: false } })).kind === 'article', 'a long read with no metadata → article (lower confidence)');
  ok(suggest.classifyPage(sig()).kind === 'page' && suggest.suggestionsFor(suggest.classifyPage(sig())).length === 0, 'a plain page: no chips (the copilot\'s own actions stand)');
  ok(suggest.classifyPage(null).kind === 'page' && suggest.classifyPage(sig({ url: 'about:blank' })).kind === 'page', 'no signals / not a web page');
  const merged = suggest.mergeActions(suggest.suggestionsFor(n), [{ id: 'summarize', label: 'Summarize this page' }, { id: 'tables', label: 'Extract tables' }]);
  ok(merged.map(m => m.id).join(',') === 'sg-summarize,sg-keypoints,sg-factcheck,sg-explain,tables', 'chips replace the copilot actions they cover, others follow', merged.map(m => m.id));
}

// ── Autofill ──
console.log('\nAutofill');
{
  const F = (o) => ({ key: o.key ?? 'k', tag: 'input', type: 'text', value: '', ...o });
  const kind = (o) => af.classifyAutofillField(F(o))?.key ?? null;
  ok(kind({ autocomplete: 'given-name' }) === 'given-name' && kind({ autocomplete: 'shipping postal-code' }) === 'postal-code', 'autocomplete tokens (with sections)');
  ok(af.classifyAutofillField(F({ autocomplete: 'section-a shipping address-line1' })).section === 'shipping', 'shipping section read from autocomplete');
  ok(kind({ label: 'First name' }) === 'given-name' && kind({ name: 'lname' }) === 'family-name' && kind({ label: 'Full name' }) === 'name', 'name fields by label / name');
  ok(kind({ type: 'email', name: 'contact' }) === 'email' && kind({ label: 'E-mail address' }) === 'email', 'email (type or label; "email address" is not an address)');
  ok(kind({ type: 'tel', name: 'x' }) === 'tel' && kind({ label: 'Mobile number' }) === 'tel', 'phone');
  ok(kind({ label: 'Company name' }) === 'organization' && kind({ placeholder: 'Apartment, suite, etc.' }) === 'address-line2', 'company / address line 2');
  ok(kind({ name: 'billing_address_1' }) === 'address-line1' && kind({ label: 'Town / City' }) === 'address-level2' && kind({ label: 'ZIP code' }) === 'postal-code' && kind({ label: 'PIN code' }) === 'postal-code', 'address parts (incl. an Indian PIN code)');
  ok(kind({ tag: 'select', type: 'select', label: 'Country / Region' }) === 'country', 'country select');
  ok(kind({ label: 'Username' }) === null && kind({ label: 'Search' }) === null && kind({ name: 'q' }) === null && kind({ label: 'Coupon code' }) === null, 'username, search and coupon boxes are not ours');
  ok(kind({ type: 'number', label: 'Quantity' }) === null && kind({ type: 'number', label: 'ZIP' }) === 'postal-code', 'a number box takes only a postcode or phone');
  // Never: passwords, cards, CVVs, codes — by type, autocomplete and label.
  const never = [
    { type: 'password', name: 'pw' }, { autocomplete: 'current-password' }, { autocomplete: 'new-password', label: 'Name' },
    { autocomplete: 'cc-number', label: 'Name on card' }, { autocomplete: 'cc-csc' }, { autocomplete: 'cc-exp' }, { autocomplete: 'one-time-code', label: 'Phone' },
    { label: 'Card number' }, { label: 'Security code' }, { name: 'cvv' }, { label: 'Verification code' }, { label: 'Name on card' }, { label: 'PIN' },
  ];
  ok(never.every(f => kind(f) === null), 'never matched: password, card number/expiry/CVV, one-time code, name on card, PIN', never.filter(f => kind(f) !== null));

  const profile = af.normaliseProfile({
    fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+44 20 7946 0000', company: 'Analytical Engines Ltd', jobTitle: 'Engineer',
    addresses: [
      { id: 'home', label: 'Home', line1: '12 St James Square', city: 'London', postalCode: 'SW1Y 4JH', country: 'United Kingdom', region: 'Greater London' },
      { id: 'work', label: 'Work', line1: '1 Science Park', line2: 'Unit 4', city: 'Cambridge', postalCode: 'CB4 0FZ', country: 'GB', name: 'Ada L. (office)' },
    ],
    defaultAddress: 'home', shippingAddress: 'work', deliveryNotes: 'Reception desk',
  });
  ok(profile.addresses.length === 2 && profile.defaultAddress === 'home', 'profile normalised');
  ok(af.normaliseProfile({ fullName: '4111 1111 1111 1111', phone: '4111111111111111' }).fullName === '' && af.normaliseProfile({ phone: '4111111111111111' }).phone === '', 'a card number typed into the profile is dropped');
  ok(af.profileIsEmpty(af.normaliseProfile({})) && !af.profileIsEmpty(profile), 'empty profile detected');

  const fields = [
    F({ key: 'f1', label: 'First name', autocomplete: 'given-name' }),
    F({ key: 'f2', label: 'Last name' }),
    F({ key: 'f3', type: 'email', label: 'Email' }),
    F({ key: 'f4', type: 'password', label: 'Password' }),
    F({ key: 'f5', autocomplete: 'shipping address-line1', label: 'Street' }),
    F({ key: 'f6', autocomplete: 'shipping postal-code', label: 'Postcode' }),
    F({ key: 'f7', tag: 'select', type: 'select', autocomplete: 'shipping country', label: 'Country', value: '', options: [{ value: '', label: 'Choose…' }, { value: 'US', label: 'United States' }, { value: 'GB', label: 'United Kingdom' }] }),
    F({ key: 'f8', label: 'Card number', autocomplete: 'cc-number' }),
    F({ key: 'f9', label: 'Phone', type: 'tel', value: '+1 555 0100' }),
    F({ key: 'f10', label: 'CVC', name: 'cvc' }),
    F({ key: 'f11', label: 'One-time code', autocomplete: 'one-time-code' }),
    F({ key: 'f12', tag: 'textarea', type: 'textarea', label: 'Delivery instructions' }),
  ];
  const plan = af.planAutofill(fields, profile);
  const put = Object.fromEntries(plan.fills.map(f => [f.key, f.value]));
  ok(put.f1 === 'Ada' && put.f2 === 'Lovelace' && put.f3 === 'ada@example.com', 'names split from the full name; email');
  ok(put.f5 === '1 Science Park' && put.f6 === 'CB4 0FZ' && put.f7 === 'GB', 'shipping fields use the shipping address; the country select gets its option value', put);
  ok(put.f12 === 'Reception desk', 'delivery instructions');
  ok(!('f4' in put) && !('f8' in put) && !('f10' in put) && !('f11' in put), 'password, card, CVC and one-time-code fields are never filled', put);
  ok(['f4', 'f8', 'f10', 'f11'].every(k => plan.skipped.some(s => s.key === k && /never autofilled/.test(s.reason))), 'and they are reported as refused', plan.skipped);
  ok(!('f9' in put) && plan.skipped.some(s => s.key === 'f9' && s.reason === 'already filled'), 'a field that already holds something is left alone');
  const home = Object.fromEntries(af.planAutofill(fields, profile, { addressId: 'home' }).fills.map(f => [f.key, f.value]));
  ok(home.f5 === '12 St James Square' && home.f7 === 'GB', 'a chosen address overrides the shipping one (and "United Kingdom" finds GB by label)', home);
  ok(af.pickOption([{ value: 'us', label: 'United States of America' }], 'United States') === 'us' && af.pickOption([{ value: 'x', label: 'Y' }], 'zz') === null, 'select options: by value, label, or label prefix');
  ok(af.planAutofill(fields, af.normaliseProfile({})).fills.length === 0, 'an empty profile fills nothing');
  ok(!/password|cc-/.test(JSON.stringify(af.planAutofill([F({ key: 'x', type: 'password', autocomplete: 'username' })], profile).fills)), 'a password box marked autocomplete=username is still a password box');
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`\n  BROWSER TABS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
