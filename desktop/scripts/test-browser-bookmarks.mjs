/**
 * Unit tests for the built-in browser's bookmarks: the tree operations
 * (shared/bookmark-tree.ts, through electron/browser-store.ts), the migration
 * from the earlier flat list, and import/export (electron/browser-bookmarks-io.ts).
 *
 *   node scripts/test-browser-bookmarks.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-bm-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error' });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}
function throws(fn, pattern, label) {
  try { fn(); ok(false, label, 'did not throw'); }
  catch (err) { ok(pattern.test(err.message), label, err.message); }
}

const S = await load(path.join(desktop, 'electron/browser-store.ts'), 'store');
const IO = await load(path.join(desktop, 'electron/browser-bookmarks-io.ts'), 'io');
const titles = (tree, id) => S.getNode(tree, id).children.map(c => c.title);

// ── Building a tree ──
{
  let t = S.emptyTree();
  ok(t.roots.map(r => r.id).join() === 'bar,other' && t.roots.every(r => r.children.length === 0), 'tree: starts with an empty bar and Other bookmarks');
  const a = S.createBookmark(t, { parentId: 'bar', url: ' https://a.test/ ', title: '  A   site ' }, 10); t = a.tree;
  const w = S.createFolder(t, { parentId: 'bar', title: 'Work' }, 11); t = w.tree;
  const b = S.createBookmark(t, { parentId: w.node.id, url: 'https://b.test/', title: '' }, 12); t = b.tree;
  const sub = S.createFolder(t, { parentId: w.node.id, title: '' }, 13); t = sub.tree;
  const c = S.createBookmark(t, { parentId: 'bar', index: 0, url: 'https://c.test/', title: 'C' }, 14); t = c.tree;
  ok(titles(t, 'bar').join() === 'C,A site,Work', 'tree: insert at an index; titles are tidied', titles(t, 'bar'));
  ok(S.getNode(t, b.node.id).title === 'https://b.test/' && S.getNode(t, sub.node.id).title === 'New folder', 'tree: an untitled bookmark shows its URL, an untitled folder is "New folder"');
  ok(S.pathOf(t, sub.node.id).join('/') === 'Bookmarks bar/Work', 'tree: the path of a node is the folders above it', S.pathOf(t, sub.node.id));
  ok(S.findByUrl(t, 'https://b.test/')?.id === b.node.id && !S.findByUrl(t, 'https://zzz.test/'), 'tree: find by URL');
  ok(S.countBookmarks(S.getNode(t, 'bar')) === 3 && S.directUrls(S.getNode(t, 'bar')).length === 2, 'tree: count (recursive) and the bookmarks directly in a folder ("Open all")');
  ok(S.folderList(t).map(f => `${f.depth}:${f.title}`).join() === '0:Bookmarks bar,1:Work,2:New folder,0:Other bookmarks', 'tree: folder list for pickers, indented', S.folderList(t));
  const flat = S.flattenBookmarks(t);
  ok(flat.length === 3 && flat.find(x => x.url === 'https://b.test/').folder === 'Bookmarks bar/Work' && flat.find(x => x.url === 'https://b.test/').parentId === w.node.id, 'tree: flattened for suggestions, with folder path and parent', flat);
  ok(S.searchTree(t, 'work').length === 1 && S.searchTree(t, 'b.test').length === 1 && S.searchTree(t, '').length === 0, 'tree: search titles and URLs');
  throws(() => S.createBookmark(t, { parentId: b.node.id, url: 'https://x.test' }, 1), /folder/, 'tree: a bookmark cannot go inside a bookmark');
  throws(() => S.createBookmark(t, { parentId: 'bar', url: '  ' }, 1), /URL/, 'tree: a bookmark needs a URL');
  throws(() => S.createBookmark(t, { parentId: 'nope', url: 'https://x.test' }, 1), /no longer exists/, 'tree: a missing folder is reported');

  // Pure: the input is untouched.
  const before = JSON.stringify(t);
  S.moveNodes(t, [c.node.id], 'other'); S.removeNodes(t, [w.node.id]); S.updateNode(t, a.node.id, { title: 'x' }); S.sortFolder(t, 'bar');
  ok(JSON.stringify(t) === before, 'tree: every operation leaves its input unchanged');

  // ── Update ──
  let u = S.updateNode(t, a.node.id, { title: 'Alpha', url: 'https://alpha.test/' });
  ok(S.getNode(u, a.node.id).title === 'Alpha' && S.getNode(u, a.node.id).url === 'https://alpha.test/', 'update: rename and re-point a bookmark');
  u = S.updateNode(u, 'bar', { title: 'Mine' });
  ok(S.getNode(u, 'bar').title === 'Bookmarks bar', 'update: the roots keep their names');
  u = S.updateNode(u, w.node.id, { url: 'https://no.test' });
  ok(S.getNode(u, w.node.id).url === undefined, 'update: a folder has no URL');

  // ── Move ──
  let m = S.moveNodes(t, [c.node.id], 'bar', 3);
  ok(titles(m, 'bar').join() === 'A site,Work,C', 'move: reorder to the end (index before the move)', titles(m, 'bar'));
  m = S.moveNodes(t, [w.node.id], 'bar', 0);
  ok(titles(m, 'bar').join() === 'Work,C,A site', 'move: reorder to the front', titles(m, 'bar'));
  m = S.moveNodes(t, [c.node.id], 'bar', 2);
  ok(titles(m, 'bar').join() === 'A site,C,Work', 'move: reorder within the same folder, dropping between later items', titles(m, 'bar'));
  m = S.moveNodes(t, [c.node.id, a.node.id], w.node.id, 1);
  ok(titles(m, 'bar').join() === 'Work' && titles(m, w.node.id).join() === 'https://b.test/,C,A site,New folder', 'move: several into a folder at an index, in the order given', titles(m, w.node.id));
  m = S.moveNodes(t, [w.node.id, b.node.id], 'other');
  ok(titles(m, 'other').join() === 'Work' && titles(m, w.node.id).includes('https://b.test/'), 'move: a node chosen with its folder moves with the folder');
  throws(() => S.moveNodes(t, [w.node.id], sub.node.id), /inside itself/, 'move: a folder cannot go inside itself');
  throws(() => S.moveNodes(t, [w.node.id], w.node.id), /inside itself/, 'move: … or into itself');
  throws(() => S.moveNodes(t, ['bar'], 'other'), /cannot be moved/, 'move: the roots stay put');

  // ── Delete ──
  let d = S.removeNodes(t, [w.node.id]);
  ok(titles(d, 'bar').join() === 'C,A site' && !S.getNode(d, b.node.id) && !S.getNode(d, sub.node.id), 'delete: a folder goes with everything in it');
  throws(() => S.removeNodes(t, ['other']), /cannot be deleted/, 'delete: the roots cannot be deleted');
  let dup = S.createBookmark(t, { parentId: 'other', url: 'https://c.test/', title: 'C again' }, 20).tree;
  dup = S.removeByUrl(dup, 'https://c.test/');
  ok(!S.findByUrl(dup, 'https://c.test/') && S.removeByUrl(dup, 'https://none.test/') === dup, 'delete: by URL removes every copy (and changes nothing when there is none)');

  // ── Sort ──
  const s = S.sortFolder(S.createBookmark(t, { parentId: 'bar', url: 'https://z.test', title: 'item 10' }, 1).tree, 'bar');
  const s2 = S.sortFolder(S.createBookmark(s, { parentId: 'bar', url: 'https://y.test', title: 'item 9' }, 1).tree, 'bar');
  ok(titles(s2, 'bar').join() === 'Work,A site,C,item 9,item 10', 'sort: folders first, then by name, numbers in order', titles(s2, 'bar'));

  // ── Folder paths and the flat "add" ──
  const e = S.ensureFolderPath(t, 'bar', ['work', 'Reading', ' '], 30);
  ok(S.getNode(e.tree, e.folderId).title === 'Reading' && S.pathOf(e.tree, e.folderId).join('/') === 'Bookmarks bar/Work', 'folders: a path is found case-insensitively and the rest created', S.pathOf(e.tree, e.folderId));
  let up = S.upsertBookmark(t, { url: 'https://b.test/', title: 'B renamed' }, 40);
  ok(up.node.id === b.node.id && up.node.title === 'B renamed' && S.flattenBookmarks(up.tree).length === 3, 'add: bookmarking a URL again updates the bookmark it has');
  up = S.upsertBookmark(t, { url: 'https://n.test/', title: 'N', folder: 'Work/Later' }, 41);
  ok(S.pathOf(up.tree, up.node.id).join('/') === 'Bookmarks bar/Work/Later', 'add: a folder path puts it there (under the bar)');
  up = S.upsertBookmark(t, { url: 'https://b.test/', title: 'B twice', parentId: 'other' }, 42);
  ok(up.node.id !== b.node.id && S.flattenBookmarks(up.tree).length === 4, 'add: with a folder given, a second bookmark of the same URL is made');
  up = S.upsertBookmark(t, { url: 'https://new.test/', title: 'New' }, 43);
  ok(S.getNode(up.tree, 'bar').children.at(-1).id === up.node.id, 'add: a new bookmark goes at the end of the bar');
}

// ── Migration from the flat list ──
{
  const legacy = [
    { url: 'https://a.test', title: 'A', favicon: 'https://a.test/f.ico', addedAt: 100 },
    { url: 'https://b.test', title: 'B', addedAt: 200, folder: 'Work' },
    { url: 'https://c.test', title: 'C', addedAt: 300, folder: 'Work/Deep' },
    { url: '', title: 'broken' },
    { title: 'no url' },
  ];
  const t = S.normaliseTree(legacy, 999);
  const flat = S.flattenBookmarks(t);
  ok(flat.length === 3, 'migrate: every valid bookmark is kept (the broken ones are dropped)', flat.length);
  const a = flat.find(x => x.url === 'https://a.test');
  ok(a.title === 'A' && a.favicon === 'https://a.test/f.ico' && a.addedAt === 100 && a.folder === 'Bookmarks bar', 'migrate: title, icon and date are kept; a short list goes on the bar', a);
  ok(flat.find(x => x.url === 'https://c.test').folder === 'Bookmarks bar/Work/Deep', 'migrate: a folder becomes a real folder, "A/B" nests');
  ok(titles(t, 'bar').join() === 'A,Work', 'migrate: order is kept, one folder per name', titles(t, 'bar'));
  const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://s${i}.test`, title: `S${i}`, addedAt: i }));
  const tm = S.normaliseTree(many, 1);
  ok(S.getNode(tm, 'bar').children.length === 0 && S.getNode(tm, 'other').children.length === 20 && titles(tm, 'other')[0] === 'S0', 'migrate: a list too long for the bar goes to Other bookmarks, in order');
  ok(S.normaliseTree([], 1).roots.every(r => r.children.length === 0) && S.normaliseTree(null).roots.length === 2 && S.normaliseTree('junk').roots.length === 2, 'migrate: empty, missing or damaged files start clean');
}

// ── A damaged tree ──
{
  const raw = { version: 2, roots: [
    { id: 'bar', title: 'Renamed?', children: [
      { id: 'x', title: 'X', url: 'https://x.test', addedAt: 1 },
      { id: 'x', title: 'X again', url: 'https://x2.test', addedAt: 2 },
      { id: 'y', title: 'No URL', addedAt: 3 },
      { id: 'other', title: 'Fake root', children: [] },
      null,
    ] },
  ] };
  const t = S.normaliseTree(raw, 5);
  const bar = S.getNode(t, 'bar');
  ok(bar.title === 'Bookmarks bar' && S.getNode(t, 'other')?.children.length === 0, 'normalise: roots are put back with their own names');
  ok(bar.children.length === 3 && new Set(bar.children.map(c => c.id)).size === 3 && !bar.children.some(c => c.id === 'other'), 'normalise: repeated ids renumbered, bad nodes dropped, no second root', bar.children.map(c => c.id));
  const again = S.normaliseTree(JSON.parse(JSON.stringify(t)), 6);
  ok(JSON.stringify(again) === JSON.stringify(t), 'normalise: a sound tree comes back unchanged');
}

// ── Import: Chromium ──
{
  const webkit = ms => String((ms + 11_644_473_600_000) * 1000);
  const json = JSON.stringify({ version: 1, roots: {
    bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [
      { type: 'url', name: 'Docs', url: 'https://docs.test/', date_added: webkit(1_700_000_000_000) },
      { type: 'folder', name: 'Dev', children: [{ type: 'url', name: 'Repo', url: 'https://git.test/r' }, { type: 'url', name: 'JS', url: 'javascript:alert(1)' }] },
    ] },
    other: { type: 'folder', name: 'Other bookmarks', children: [{ type: 'url', name: 'Later', url: 'https://later.test/' }] },
    synced: { type: 'folder', name: 'Mobile bookmarks', children: [{ type: 'url', name: 'Phone', url: 'https://m.test/' }] },
  } });
  const p = IO.parseChromiumBookmarks(`\uFEFF${json}`);
  ok(p.bar.length === 2 && p.bar[0].addedAt === 1_700_000_000_000 && p.bar[1].children.length === 1, 'import/chromium: the bar, folders and dates (WebKit time) are read', p.bar);
  ok(p.skipped === 1, 'import/chromium: a javascript: bookmarklet is skipped and counted');
  ok(p.other.length === 2 && p.other[1].title === 'Mobile bookmarks' && p.other[1].children[0].url === 'https://m.test/', 'import/chromium: Other and Mobile bookmarks come too', p.other);
  const items = IO.importContents(p);
  ok(items.length === 3 && items[2].title === 'Other bookmarks' && items[2].children.length === 2, 'import: bar items first, the rest in their own folder', items.map(i => i.title));
  const r = S.addImported(S.emptyTree(), 'bar', 'Imported from Chrome', items, 50);
  ok(r.count === 4 && r.folder.title === 'Imported from Chrome' && S.getNode(r.tree, 'bar').children[0].id === r.folder.id, 'import: lands as one "Imported from …" folder on the bar', r.count);
  throws(() => IO.parseChromiumBookmarks('{"x":1}'), /not a Chromium/, 'import/chromium: another JSON file is refused');
}

// ── Import: Netscape HTML (Firefox's export) ──
{
  const firefox = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks Menu</H1>
<DL><p>
    <DT><H3 ADD_DATE="1600000000" LAST_MODIFIED="1600000001">Mozilla Firefox</H3>
    <DL><p>
        <DT><A HREF="https://support.mozilla.org/products/firefox" ADD_DATE="1600000002" ICON="data:image/png;base64,AAAA">Get Help</A>
        <DT><A HREF="place:sort=8&amp;maxResults=10">Recent Tags</A>
    </DL><p>
    <DT><H3 ADD_DATE="1600000003" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Toolbar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/?a=1&amp;b=2" ADD_DATE="1600000004">Tom &amp; Jerry&#39;s &lt;page&gt;</A>
        <DD>A description that is ignored
        <DT><H3>Empty</H3>
        <DL><p>
        </DL><p>
        <DT><H3>Nested</H3>
        <DL><p>
            <DT><A HREF="https://deep.test/">Deep</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://top.test/">Top level</A>
</DL>`;
  const p = IO.parseNetscapeHtml(firefox);
  ok(p.bar.length === 3 && p.bar[0].title === "Tom & Jerry's <page>" && p.bar[0].url === 'https://example.com/?a=1&b=2', 'import/html: the toolbar folder becomes the bar; entities decoded', p.bar);
  ok(p.bar[0].addedAt === 1_600_000_004_000, 'import/html: ADD_DATE seconds become milliseconds');
  ok(p.bar[1].title === 'Empty' && p.bar[1].children.length === 0 && p.bar[2].children[0].url === 'https://deep.test/', 'import/html: empty and nested folders', p.bar.slice(1));
  ok(p.other.length === 2 && p.other[0].title === 'Mozilla Firefox' && p.other[0].children.length === 1 && p.other[1].url === 'https://top.test/', 'import/html: everything else keeps its folders', p.other);
  ok(p.other[0].children[0].favicon === 'data:image/png;base64,AAAA' && p.skipped === 1, 'import/html: data: icons kept; place: queries skipped and counted');
  throws(() => IO.parseNetscapeHtml('<html><body>hello</body></html>'), /not a bookmarks HTML/, 'import/html: another HTML file is refused');
  const loose = IO.parseNetscapeHtml('<DL><DT><A HREF="https://a.test">A</A><DT><H3>F</H3><DL><DT><A HREF="https://b.test">B</A></DL></DL>');
  ok(loose.bar.length === 0 && loose.other.length === 2 && loose.other[1].children[0].title === 'B', 'import/html: no toolbar folder — all of it is "other"; tags on one line');
}

// ── Export, and back again ──
{
  let t = S.emptyTree();
  const w = S.createFolder(t, { parentId: 'bar', title: 'R&D <team>' }, 1_000_000); t = w.tree;
  t = S.createBookmark(t, { parentId: w.node.id, url: 'https://x.test/?q="1"&r=2', title: 'Quote "x" & <y>' }, 2_000_000).tree;
  t = S.createBookmark(t, { parentId: 'bar', url: 'https://bar.test/', title: 'On the bar', favicon: 'data:image/png;base64,QUJD' }, 3_000_000).tree;
  t = S.createBookmark(t, { parentId: 'bar', url: 'https://bar2.test/', title: 'Web icon', favicon: 'https://bar2.test/favicon.ico' }, 3_000_000).tree;
  t = S.createBookmark(t, { parentId: 'other', url: 'https://other.test/', title: 'Elsewhere' }, 4_000_000).tree;
  const html = IO.toNetscapeHtml(t);
  ok(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>') && /PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar<\/H3>/.test(html), 'export: Netscape format, the bar marked as the toolbar');
  ok(html.includes('R&amp;D &lt;team&gt;') && html.includes('HREF="https://x.test/?q=&quot;1&quot;&amp;r=2"') && !html.includes('favicon.ico'), 'export: titles and URLs escaped; only data: icons written');
  ok(/ADD_DATE="3000"/.test(html), 'export: dates in seconds');
  const back = IO.parseNetscapeHtml(html);
  ok(back.bar.length === 3 && back.bar[0].title === 'R&D <team>' && back.bar[0].children[0].url === 'https://x.test/?q="1"&r=2' && back.bar[0].children[0].title === 'Quote "x" & <y>', 'round trip: folders, titles and URLs survive', back.bar);
  ok(back.bar[1].favicon === 'data:image/png;base64,QUJD' && back.bar[1].addedAt === 3_000_000, 'round trip: icons and dates survive');
  ok(back.other.length === 1 && back.other[0].url === 'https://other.test/', 'round trip: Other bookmarks come back as the rest');
}

// ── Where other browsers keep bookmarks ──
{
  const win = IO.chromiumInstalls('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me');
  ok(win.map(i => i.browser).join() === 'Chrome,Edge,Brave' && win[0].dir === 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data' && win[2].dir.endsWith('BraveSoftware\\Brave-Browser\\User Data'), 'profiles: Windows locations', win);
  const mac = IO.chromiumInstalls('darwin', {}, '/Users/me');
  ok(mac[1].dir === '/Users/me/Library/Application Support/Microsoft Edge', 'profiles: macOS locations', mac);
  const lin = IO.chromiumInstalls('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/me');
  ok(lin[0].dir === '/cfg/google-chrome' && lin.some(i => i.browser === 'Chromium'), 'profiles: Linux locations follow XDG_CONFIG_HOME', lin);
  ok(IO.isProfileDir('Default') && IO.isProfileDir('Profile 12') && !IO.isProfileDir('System Profile') && !IO.isProfileDir('Crashpad'), 'profiles: only profile folders');
  const names = IO.profileNames(JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' }, 'Profile 2': { name: ' Work ' }, 'Profile 3': {} } } }));
  ok(names.Default === 'Person 1' && names['Profile 2'] === 'Work' && !('Profile 3' in names) && Object.keys(IO.profileNames('garbage')).length === 0, 'profiles: names from Local State', names);
}

// ── Settings: the bar ──
{
  ok(S.normaliseSettings({ bookmarksBar: 'newtab' }).bookmarksBar === 'newtab' && S.normaliseSettings({ bookmarksBar: 'sometimes' }).bookmarksBar === undefined, 'settings: the bookmarks bar setting is kept when valid');
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`\n  BOOKMARKS UNIT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
