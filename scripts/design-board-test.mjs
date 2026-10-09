/**
 * Design boards (ADR 0037), tested offline: the board format and its path
 * rules, the DesignBoard tool's actions, the routes the viewer uses, screen
 * composition, the on-demand tool group and the skill.
 *
 * Why a script of its own: the rules that matter are about files — a frame
 * pointing out of the board folder, a link inside the folder leading out, a
 * screen that loads from the network — so they are checked against a real
 * folder, not a mock. Export to PNG/PDF runs only when Chrome or Edge is
 * installed (and says when it was skipped); the zip always runs.
 *
 * Part of `npm test`. No model, no network.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

import {
  designBoardIn, designBoardTool, designBoardDefinition, insideBoard, readBoardAt, exportBoard, handleBoardRoute, listArtifacts,
  parseBoard, serializeBoard, safeRelPath, resolveHref, frameForHref, linkReport, networkProblems, frameSize, composeScreen,
  runInContext, getWorkspaceInfo, findBrowser, groupsForRequest, groupsLoadedBy, toolDefinitions, TOOL_GROUPS, executeTool,
} from '../dist-test/test-exports.js';

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ''}`); }
}
const errOf = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };
const tmp = (tag) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `aico-${tag}-`)));

const page = (title, body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="styles.css">${extra}</head><body>${body}</body></html>`;

console.log('\n── The format: paths stay in the board, sizes are sane ──');
{
  for (const bad of ['../x.html', '%2e%2e/x.html', 'a/../../x.html', '/abs.html', 'C:/x.html', 'a\\b.html', '.hidden.html', 'a//b.html', 'x\0.html', 'a/./b.html']) {
    ok(safeRelPath(bad) === null, `safeRelPath refuses ${JSON.stringify(bad)}`);
  }
  ok(safeRelPath('screens/Today.html') === 'screens/Today.html' && safeRelPath('Today.html') === 'Today.html', 'plain relative paths pass');
  const { board, problems } = parseBoard({
    title: 'Notes', sections: [
      { title: 'Start', frames: [
        { id: 'today', title: 'Today', file: 'Today.html', device: 'desktop' },
        { title: 'Evil', file: '../../evil.html' },
        { id: 'today', title: 'Today again', file: 'Today2.html', width: 390, height: 844 },
        { title: 'Huge', file: 'Huge.html', width: 99999, height: 10 },
        { title: 'Dup file', file: 'today.html' },
      ] },
    ],
    notes: [{ text: 'tighten the header', x: 10, y: 20, frame: 'today' }, { text: '', x: 0, y: 0 }],
  });
  ok(board.sections[0].frames.map(f => f.id).join() === 'today,today-2', 'a traversal, an out-of-range size and a duplicate file are dropped; a duplicate id is renamed', board.sections[0].frames);
  ok(problems.some(p => /evil\.html/.test(p)) && problems.some(p => /width must be/.test(p)) && problems.some(p => /already another frame/.test(p)), 'and each is a named problem', problems);
  ok(board.sections[0].frames[0].width === 1440 && board.sections[0].frames[1].width === 390, 'device names become sizes');
  ok(board.notes.length === 1 && board.notes[0].frame === 'today', 'notes: empty ones dropped, frame kept when it exists');
  ok(parseBoard(JSON.parse(serializeBoard(board))).problems.length === 0, 'what serializeBoard writes reads back clean');
  ok('error' in frameSize({ device: 'watch' }) && frameSize({ device: 'Mobile' }).width === 390, 'unknown device refused, names are case-insensitive');
  ok(resolveHref('Today.html', '../x.html') === null && resolveHref('screens/a.html', '../Other.html') === 'Other.html' && resolveHref('a.html', 'https://x.io') === null
    && resolveHref('a.html', 'B.html?tab=2#top') === 'B.html' && resolveHref('a.html', '#top') === null, 'resolveHref: relative only, never past the board folder');
  ok(frameForHref(board, 'Today.html', 'today2.HTML')?.id === 'today-2', 'a link finds its screen case-insensitively');
  const net = networkProblems('<img src="https://images.example.com/a.png"><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><img src="https://unpkg.com/x.png"><style>a{background:url(http://x.io/b.png)}</style><script>fetch("/api")</script>');
  ok(net.length === 4 && net.some(n => /images\.example\.com/.test(n)) && net.some(n => /unpkg\.com\/x\.png/.test(n)) && net.some(n => /x\.io/.test(n)) && net.some(n => /fetch/.test(n)) && !net.some(n => /chart\.js/.test(n)),
    'networkProblems: remote picture, CDN picture, CSS url and fetch named; a CDN script allowed', net);
  const rep = linkReport(board, new Map([['Today.html', '<a href="Missing.html">x</a><a href="#top">t</a><a href="mailto:a@b.c">m</a>'], ['Today2.html', '<a href="Today.html">back</a>']]));
  ok(rep.broken.length === 1 && rep.broken[0].href === 'Missing.html' && rep.unreachable.join() === 'today-2', 'linkReport: one broken link, one unreachable screen', rep);
}

console.log('\n── The tool: build a board, refuse what would not work ──');
const root = tmp('boards');
const t = (input) => designBoardIn(root, input);
let id;
{
  const created = await t({ action: 'create', title: 'Notes app — first mockup' });
  id = /Created board ([a-z0-9-]+)/.exec(created)?.[1];
  ok(id === 'notes-app-first-mockup' && fs.existsSync(path.join(root, id, 'board.json')), 'create: a folder named for the title with board.json', created);
  ok(/Created board notes-app-first-mockup-2/.test(await t({ action: 'create', title: 'Notes app — first mockup' })), 'a second board of the same title gets its own folder');
  ok(/Wrote styles\.css/.test(await t({ action: 'write_file', board: id, path: 'styles.css', content: ':root{--accent:#0a7}body{font:16px/1.5 system-ui;margin:0}.logo{background:url(img/logo.svg)}' })), 'write_file: the shared stylesheet');
  ok(/Wrote img\/logo\.svg/.test(await t({ action: 'write_file', board: id, path: 'img/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#0a7"/></svg>' })), 'write_file: a picture in a subfolder');
  for (const [p, why] of [['../../escape.css', 'traversal'], ['/abs.css', 'absolute'], ['C:/x.css', 'drive'], ['board.json', 'board.json itself'], ['Other.html', 'a screen'], ['x.exe', 'a binary']]) {
    ok(/./.test(await errOf(() => t({ action: 'write_file', board: id, path: p, content: 'x' }))) && !fs.existsSync(path.join(root, 'escape.css')), `write_file refuses ${why} (${p})`);
  }
  ok(/no network/.test(await errOf(() => t({ action: 'write_file', board: id, path: 'remote.css', content: '@import url("https://fonts.googleapis.com/css2?family=Inter");' }))), 'write_file refuses a stylesheet that loads from the network');

  const today = await t({ action: 'add_frame', board: id, section: 'Today and the start', title: 'Today', file: 'Today.html', device: 'desktop', note: 'first run, three notes',
    html: page('Today', '<header class="logo"></header><nav><a href="Workspace.html">Workspace</a> <a href="Settings.html">Settings</a></nav><h1>Today</h1>') });
  ok(/Added screen today "Today" \(Today\.html, 1440×900\)/.test(today) && /Links to screens not on the board yet: Workspace\.html, Settings\.html/.test(today), 'add_frame writes the screen and says which links wait for screens', today);
  const ws = await t({ action: 'add_frame', board: id, section: 'Workspace — making things', title: 'Workspace', file: 'Workspace.html',
    html: '<main><a href="Today.html">Back</a><a href="WorkspaceDocument.html">Open doc</a></main>' });
  ok(/fragment, so it was wrapped/.test(ws) && fs.readFileSync(path.join(root, id, 'Workspace.html'), 'utf8').includes('<link rel="stylesheet" href="styles.css">'), 'a fragment is wrapped in a document that links the board stylesheet', ws);
  ok(/1440×900/.test(ws), 'a screen without a size takes the previous screen\'s');
  await t({ action: 'add_frame', board: id, section: 'Workspace — making things', title: 'Workspace document', file: 'WorkspaceDocument.html', device: 'desktop',
    html: page('Doc', '<a href="Workspace.html">Back to workspace</a><img src="img/logo.svg" alt="">') });
  const remote = await errOf(() => t({ action: 'add_frame', board: id, section: 'X', title: 'Remote', file: 'Remote.html', html: page('R', '<img src="https://images.unsplash.com/photo.jpg">') }));
  ok(/Not written/.test(remote) && /images\.unsplash\.com/.test(remote) && !fs.existsSync(path.join(root, id, 'Remote.html')), 'add_frame refuses a remote picture and writes nothing', remote);
  ok(/relative \.html/.test(await errOf(() => t({ action: 'add_frame', board: id, title: 'Evil', file: '../Evil.html', html: page('E', 'x') }))) && !fs.existsSync(path.join(root, 'Evil.html')), 'add_frame refuses a file outside the board');
  ok(/already a screen/.test(await errOf(() => t({ action: 'add_frame', board: id, title: 'Again', file: 'today.html', html: page('A', 'x') }))), 'add_frame refuses a second frame on one file');
  ok(/device must be one of/.test(await errOf(() => t({ action: 'add_frame', board: id, title: 'W', file: 'W.html', device: 'watch', html: page('W', 'x') }))), 'add_frame names the devices');
  const mob = await t({ action: 'add_frame', board: id, section: 'Today and the start', title: 'Today on a phone', file: 'TodayMobile.html', device: 'mobile', after: 'today', html: page('M', '<a href="Today.html">Desktop</a>') });
  ok(/390×844/.test(mob), 'add_frame with a device preset', mob);

  let got = await t({ action: 'get', board: id });
  ok(/Settings\.html", which is not a screen/.test(got) && /nothing links to: .*today-on-a-phone/.test(got), 'get: broken links and unreachable screens are problems', got);
  ok(/Today and the start/.test(got) && /- today: "Today" Today\.html 1440×900 — first run, three notes → links to workspace/.test(got), 'get: sections, screens, sizes, notes and links', got);
  const order = (await readBoardAt(path.join(root, id))).board.sections[0].frames.map(f => f.id).join();
  ok(order === 'today,today-on-a-phone', 'after puts a screen next to the one named', order);

  await t({ action: 'add_frame', board: id, section: 'Settings', title: 'Settings', file: 'Settings.html', html: page('S', '<a href="Today.html">Today</a>') });
  ok(/Updated today \(html\)/.test(await t({ action: 'update_frame', board: id, frame: 'today', html: page('Today', '<nav><a href="Workspace.html">Workspace</a><a href="Settings.html">Settings</a><a href="TodayMobile.html">Phone</a></nav>') })), 'update_frame replaces the HTML');
  got = await t({ action: 'get', board: id });
  ok(/No problems/.test(got), 'with every link answered, get reports no problems', got);
  ok(/Updated workspace \(title, size\)/.test(await t({ action: 'update_frame', board: id, frame: 'workspace', title: 'Workspace home', device: 'laptop' })), 'update_frame renames and resizes');
  ok(/Updated settings \(section\)/.test(await t({ action: 'update_frame', board: id, frame: 'settings', section: 'Today and the start' })) && (await readBoardAt(path.join(root, id))).board.sections.length === 2,
    'moving the last screen out of a section removes the empty section');
  ok(/every screen must be placed; missing/.test(await errOf(() => t({ action: 'reorder', board: id, order: [{ section: 'A', frames: ['today'] }] }))), 'reorder must place every screen');
  ok(/Reordered: Workspace — making things \(workspace, workspace-document\) · Today and the start \(today, today-on-a-phone, settings\)/.test(
    await t({ action: 'reorder', board: id, order: [{ section: 'Workspace — making things', frames: ['workspace', 'workspace-document'] }, { section: 'Today and the start', frames: ['today', 'today-on-a-phone', 'settings'] }] })),
  'reorder moves sections and screens');
  ok(/must be a board id/.test(await errOf(() => t({ action: 'get', board: '../x' }))) && /must be a board id/.test(await errOf(() => t({ action: 'get', board: 'A B' }))), 'a board id is never a path');

  // A link (junction) inside the board that leads out of it: a write through it is refused.
  const outside = tmp('outside');
  let linked = false;
  try { fs.symlinkSync(outside, path.join(root, id, 'out'), 'junction'); linked = true; } catch { /* no permission to make links here */ }
  if (linked) {
    const msg = await errOf(() => t({ action: 'write_file', board: id, path: 'out/x.css', content: 'a{}' }));
    ok(/leads outside/.test(msg) && !fs.existsSync(path.join(outside, 'x.css')), 'a link inside the board cannot lead a write out of it', msg);
    ok(/leads outside/.test(await errOf(() => insideBoard(path.join(root, id), 'out/y.css'))), 'insideBoard checks the real path');
    fs.rmSync(path.join(root, id, 'out'), { recursive: true, force: true });
  } else console.log('  skip  link-escape check (cannot create a junction here)');

  const tmpScreen = await t({ action: 'add_frame', board: id, section: 'Settings', title: 'Temp', file: 'Temp.html', html: page('T', 'x') });
  ok(/Added screen temp/.test(tmpScreen), 'a screen to remove');
  ok(/Removed temp from the board and deleted Temp\.html/.test(await t({ action: 'remove_frame', board: id, frame: 'temp', delete_file: true })) && !fs.existsSync(path.join(root, id, 'Temp.html')), 'remove_frame takes it off and deletes its file');
  ok(/Design boards in this chat:\n- notes-app-first-mockup: "Notes app — first mockup" — 5 screens/.test(await t({ action: 'list' })), 'list');
  ok(/Unknown action/.test(await errOf(() => t({ action: 'draw' }))), 'an unknown action names the real ones');
}

console.log('\n── Composition: one self-contained document per screen ──');
{
  const dir = path.join(root, id);
  const read = {
    text: async (rel) => { const s = safeRelPath(rel); return s && fs.existsSync(path.join(dir, s)) ? fs.readFileSync(path.join(dir, s), 'utf8') : undefined; },
    dataUrl: async (rel) => { const s = safeRelPath(rel); return s && fs.existsSync(path.join(dir, s)) ? `data:image/svg+xml;base64,${fs.readFileSync(path.join(dir, s)).toString('base64')}` : undefined; },
  };
  const asked = [];
  const spy = { text: async (r) => { asked.push(r); return read.text(r); }, dataUrl: async (r) => { asked.push(r); return read.dataUrl(r); } };
  const doc = await composeScreen(fs.readFileSync(path.join(dir, 'WorkspaceDocument.html'), 'utf8'), 'WorkspaceDocument.html', spy, { navigation: true, csp: true });
  ok(!/<link rel="stylesheet"/.test(doc) && /--accent:#0a7/.test(doc) && /url\("data:image\/svg\+xml;base64,/.test(doc) && /<img src="data:image\/svg\+xml;base64,/.test(doc), 'stylesheet inlined, CSS url() and <img> become data: URLs');
  ok(/Content-Security-Policy/.test(doc) && /connect-src 'none'/.test(doc) && /aicoBoard:'nav'/.test(doc), 'live documents carry the CSP and the navigation script');
  const plain = await composeScreen('<html><head><base href="https://evil.example/"></head><body><link rel="stylesheet" href="../../../secret.css"></body></html>', 'a.html', spy, { navigation: false, csp: false });
  ok(!/<base/i.test(plain) && !/aicoBoard/.test(plain) && !/Content-Security-Policy/.test(plain) && !asked.some(a => a.includes('secret')), 'a download has no script or CSP added; <base> removed; a path out of the board is never read', asked);
}

console.log('\n── Export ──');
{
  const dir = path.join(root, id);
  const { board } = await readBoardAt(dir);
  const zip = await exportBoard(dir, board, { format: 'zip' });
  const files = Object.keys(unzipSync(new Uint8Array(zip.bytes)));
  ok(zip.fileName === 'notes-app-first-mockup.zip' && files.includes('notes-app-first-mockup/board.json') && files.includes('notes-app-first-mockup/Today.html') && files.includes('notes-app-first-mockup/img/logo.svg'),
    'zip: the board folder, ready to open from disk', files);
  if (findBrowser()) {
    const png = await exportBoard(dir, board, { format: 'png', frame: 'today-on-a-phone' });
    ok(png.mediaType === 'image/png' && png.bytes.subarray(1, 4).toString() === 'PNG' && png.bytes.readUInt32BE(16) === 780 && png.bytes.readUInt32BE(20) === 1688, 'png: one screen at its size (a phone at 2×)', [png.bytes.readUInt32BE(16), png.bytes.readUInt32BE(20)]);
    const pdf = await exportBoard(dir, board, { format: 'pdf' });
    const pages = (pdf.bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    ok(pdf.mediaType === 'application/pdf' && pages === 5 && !pdf.warnings.length, `pdf: a page per screen (${pages})`, pdf.warnings);
    ok(/no screen "nope"/.test(await errOf(() => exportBoard(dir, board, { format: 'png', frame: 'nope' }))), 'png of an unknown screen names the screens');
  } else console.log('  skip  PNG/PDF export (no Chrome or Edge installed)');
}

console.log('\n── Through the session: tool, list and routes ──');
{
  const project = tmp('board-project');
  const sid = 'board-session';
  const settings = {};
  const run = (fn) => runInContext({ cwd: project, sessionId: sid, settings }, fn);
  const created = await run(() => executeTool('DesignBoard', { action: 'create', title: 'Shop' }));
  ok(/Created board shop/.test(String(created)), 'executeTool dispatches DesignBoard', created);
  await run(() => designBoardTool({ action: 'add_frame', board: 'shop', section: 'Browse', title: 'Home', file: 'Home.html', html: page('Home', '<a href="Home.html">Home</a>') }));
  const artifacts = getWorkspaceInfo({ settings, cwd: project, sessionId: sid }).artifactsDir;
  ok(fs.existsSync(path.join(artifacts, 'boards', 'shop', 'board.json')), 'boards live in the chat\'s artifacts folder');
  const listed = await listArtifacts({ cwd: project, sessionId: sid });
  const b = listed.find(a => a.kind === 'board');
  ok(b && b.title === 'Shop' && b.id === 'boards/shop/board.json' && listed.some(a => a.title === 'Home.html' && a.topic === 'Shop'), 'artifacts/list: one board row titled by the board; its screens grouped under it', listed.map(a => [a.kind, a.title, a.topic]));

  const call = async (route, { method = 'GET', query = {}, body } = {}) => {
    const url = new URL(`http://x/api/${route}?${new URLSearchParams({ session: sid, ...query })}`);
    const out = { status: 0, body: undefined, headers: {}, bytes: undefined };
    const res = { writeHead(s, h) { out.status = s; out.headers = h; }, end(bytes) { out.bytes = bytes; } };
    await handleBoardRoute(route, { method, headers: {} }, res, url, {
      resolveCwd: async () => project, readJson: async () => ({ session: sid, ...body }), send: (_r, s, bd) => { out.status = s; out.body = bd; },
    });
    return out;
  };
  const got = await call('boards/get', { query: { path: 'boards/shop/board.json' } });
  ok(got.status === 200 && got.body.board.title === 'Shop' && got.body.board.sections[0].frames[0].id === 'home', 'boards/get returns the board');
  ok((await call('boards/get', { query: { path: 'boards/shop' } })).status === 200, 'boards/get also takes the folder');
  const trav = await Promise.all(['../x/board.json', '../../board.json', 'boards/nope/board.json', 'C:/board.json'].map(p => call('boards/get', { query: { path: p } })));
  ok(trav.every(r => r.status === 404), 'a board outside the chat\'s artifacts is a 404', trav.map(r => r.status));
  const notes = await call('boards/notes', { method: 'POST', body: { path: 'boards/shop/board.json', notes: [{ id: 'n1', text: 'Make the CTA bigger', x: 100, y: 40, frame: 'home' }, { text: '' }], sections: [] , title: 'hacked' } });
  const after = (await readBoardAt(path.join(artifacts, 'boards', 'shop'))).board;
  ok(notes.status === 200 && after.notes.length === 1 && after.title === 'Shop' && after.sections[0].frames.length === 1, 'boards/notes changes only the notes', [notes.body, after]);
  ok(/Make the CTA bigger/.test(await run(() => designBoardTool({ action: 'get', board: 'shop' }))), 'the agent reads the person\'s notes with get');
  const zipped = await call('boards/export', { query: { path: 'boards/shop/board.json', format: 'zip' } });
  ok(zipped.status === 200 && zipped.headers['Content-Type'] === 'application/zip' && /attachment; filename="shop\.zip"/.test(zipped.headers['Content-Disposition']) && Object.keys(unzipSync(new Uint8Array(zipped.bytes))).includes('shop/Home.html'),
    'boards/export zip downloads the folder');
  ok((await call('boards/export', { query: { path: 'boards/shop/board.json', format: 'exe' } })).status === 400, 'an unknown export format is refused');
}

console.log('\n── On demand: the design group and the skill ──');
{
  ok(toolDefinitions.some(d => d.name === 'DesignBoard') && TOOL_GROUPS.some(g => g.id === 'design' && g.tools.includes('DesignBoard')), 'DesignBoard is a tool in the deferred design group');
  for (const yes of ['make me a mockup of a notes app', 'Wireframe the onboarding', 'a clickable prototype for the checkout', 'design the screens for settings', 'show me the user flow']) {
    ok(groupsForRequest(yes).includes('design'), `"${yes}" loads the design group`);
  }
  for (const no of ['mock the database in this test', 'fix the login bug', 'add a settings page to the app']) ok(!groupsForRequest(no).includes('design'), `"${no}" does not`);
  ok(groupsLoadedBy('Skill', { name: 'design-board' }).join() === 'design', 'opening the design-board skill loads the tool');
  const skill = fs.readFileSync(path.join('src', 'skills', 'builtin', 'design-board', 'SKILL.md'), 'utf8');
  const body = skill.replace(/^antiTrigger: .*\r?\n/m, '');
  ok(body.length <= 3_600, `the skill is under 3,600 chars (${body.length})`);
  const trigger = new RegExp(/^trigger: (.+)$/m.exec(skill)[1], 'i');
  const anti = new RegExp(/^antiTrigger: (.+)$/m.exec(skill)[1], 'i');
  ok(trigger.test('can you mock up the screens for a budgeting app') && trigger.test('I need a prototype of the onboarding flow') && !trigger.test('refactor the parser'), 'the skill triggers on mockups, not on code work');
  ok(anti.test('mock the api in the unit tests'), 'and stands down for test mocks');
  ok(/DesignBoard/.test(skill) && /ui-craft/.test(skill) && /lorem/.test(skill) && /export/.test(skill), 'it names the tool, the direction step, realistic content and the look-then-fix loop');
  ok(designBoardDefinition.description.length < 2_400, `the tool description stays short (${designBoardDefinition.description.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
