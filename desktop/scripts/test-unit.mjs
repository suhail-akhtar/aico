/**
 * AICO Desktop unit tests — the pure modules, bundled with esbuild and run in
 * Node: the widget kit's parser, the maths core (plot, geometry, calc), the
 * plugin manifest validator, the prefs merge, the turn grouping and the theme
 * derivation.
 *
 *   node scripts/test-unit.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-unit-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error', jsx: 'automatic', external: ['react', 'react-dom', 'echarts'] });
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

// ── Maths ──
const math = await load(path.join(repo, 'shared/kit/math/core.ts'), 'math');
{
  const r = math.evaluateCalc('mass = 1200 kg\nspeed = 90 km/h\nKE = 1/2 * mass * speed^2\nKE to kJ\nf(x) = 3x^2 + 2\nf(4)\n# heading\nh1 = 20 m\nt1 = sqrt(2*h1/g0)\nbad = 3 +');
  ok(r[0].result === '1200 kg', 'calc: a written quantity keeps its prefix', r[0].result);
  ok(r[3].result === '375 kJ', 'calc: KE of a 1200 kg car at 90 km/h is 375 kJ', r[3].result);
  ok(r[5].result === '50', 'calc: user functions work', r[5].result);
  ok(r[6].comment === 'heading' && !r[6].tex, 'calc: a # line is a heading');
  ok(/2\.019/.test(r[8].result ?? ''), 'calc: g0 is standard gravity (fall time from 20 m ≈ 2.019 s)', r[8].result);
  ok(Boolean(r[9].error), 'calc: a broken line reports its own error and does not stop the rest');
  ok(typeof r[2].tex === 'string' && r[2].tex.includes('frac'), 'calc: working is typeset', r[2].tex);
}
{
  const p = math.parsePlotSpec('y = sin(x)\nx: -2pi..2pi');
  ok(Math.abs(p.x[0] + 2 * Math.PI) < 1e-9 && Math.abs(p.x[1] - 2 * Math.PI) < 1e-9, 'plot: line syntax reads a pi range', p.x);
  ok(p.functions.length === 1 && p.functions[0].fn === 'sin(x)', 'plot: y = f(x) lines become functions', p.functions);
  const s = math.samplePlot({ ...p, derivatives: true, integral: [0, Math.PI] });
  ok(s.series.length === 2 && /cos/.test(s.series[1].name), 'plot: derivative is symbolic (d/dx sin = cos)', s.series.map(x => x.name));
  ok(Math.abs(s.area.value - 2) < 1e-6, 'plot: ∫₀^π sin x dx = 2 (Simpson)', s.area.value);
  const t = math.samplePlot({ ...math.parsePlotSpec('{"functions":["tan(x)"],"x":[-3,3],"y":[-5,5]}') });
  ok(t.series[0].data.some(([, y]) => y === null), 'plot: tan(x) is broken at its asymptotes, not joined');
  throws(() => math.parsePlotSpec('{"title":"nothing"}'), /nothing to plot/, 'plot: an empty plot says what is missing');
}
{
  const g = math.parseGeometry(JSON.stringify({ points: { A: [0, 0], B: [4, 0], C: [0, 3] }, polygons: [['A', 'B', 'C']], angles: [['B', 'A', 'C'], ['A', 'B', 'C']], segments: [['B', 'C']] }));
  const m = math.measurements(g);
  ok(m.includes('|BC| = 5'), 'geometry: 3-4-5 hypotenuse is 5', m);
  ok(m.includes('∠BAC = 90°'), 'geometry: right angle measured', m);
  ok(m.some(x => /area 6, perimeter 12/.test(x)), 'geometry: area 6 and perimeter 12', m);
  throws(() => math.parseGeometry('{"points":{"A":[0,0]},"segments":[["A","Z"]]}'), /point "Z"/, 'geometry: an undefined point is named');
}

// ── Widget kit envelope ──
const kitCatalog = await load(path.join(repo, 'shared/kit/catalog.ts'), 'kitcat');
const contracts = await load(path.join(repo, 'shared/kit/contracts.ts'), 'contracts');
ok(kitCatalog.KIT_CATALOG.length === 54, 'kit: 54 widgets catalogued', kitCatalog.KIT_CATALOG.length);
ok(kitCatalog.KIT_CATALOG.every(w => contracts.OPTION_CONTRACTS[w.id]), 'kit: every widget has an option contract (what the model reads)',
  kitCatalog.KIT_CATALOG.filter(w => !contracts.OPTION_CONTRACTS[w.id]).map(w => w.id));
ok(kitCatalog.kitEntry('gauge@1.0.0')?.id === 'gauge', 'kit: an id with @version resolves');

// ── Widget catalog: the model's view ──
const catalog = await load(path.join(repo, 'shared/widgets/catalog.ts'), 'catalog');
for (const id of ['widgets', 'plot', 'geometry', 'calc']) ok(Boolean(catalog.widgetById(id)), `catalog: ${id} is a block kind`);
ok(catalog.widgetForLanguage('physics')?.id === 'calc', 'catalog: ```physics selects calc');
ok(catalog.widgetForLanguage('plot')?.id === 'chart', 'catalog: ```plot still means an ECharts chart (unchanged)');
ok(/stat — /.test(catalog.widgetById('widgets').spec), 'catalog: widgets spec lists the kit by purpose');

// ── Plugin manifests ──
const plugins = await load(path.join(desktop, 'shared/plugin-types.ts'), 'plugins');
{
  const m = plugins.validateManifest({ id: 'me.board', name: 'Board', contributes: { views: [{ id: 'v', title: 'V', kind: 'markdown', markdown: '# hi' }], commands: [{ id: 'c', title: 'C', action: { type: 'prompt', prompt: 'x' } }] } });
  ok(m.id === 'me.board' && m.version === '0.1.0', 'plugins: a minimal manifest validates, version defaulted');
  throws(() => plugins.validateManifest({ id: 'Bad Id', name: 'x' }), /lower-case/, 'plugins: a bad id is refused with the rule');
  throws(() => plugins.validateManifest({ id: 'a.b', name: 'x', contributes: { views: [{ id: 'v', title: 'V', kind: 'nope' }] } }), /unknown kind/, 'plugins: an unknown view kind is refused');
  throws(() => plugins.validateManifest({ id: 'a.b', name: 'x', contributes: { themes: [{ id: 't', label: 'T', mode: 'dark', background: 'black', foreground: '#fff', accent: '#00f' }] } }), /#hex/, 'plugins: theme colours must be hex');
  throws(() => plugins.validateManifest({ id: 'a.b', name: 'x', contributes: { views: [{ id: 'v', title: 'V', kind: 'frame', entry: '../../etc/passwd' }] } }), /inside the plugin/, 'plugins: a frame entry cannot climb out');
  ok(plugins.manifestHasScript(plugins.validateManifest({ id: 'a.b', name: 'x', contributes: { views: [{ id: 'v', title: 'V', kind: 'frame', entry: 'v.html' }] } })), 'plugins: a frame view counts as script (needs trust)');
}

// ── Prefs ──
const prefs = await load(path.join(desktop, 'shared/prefs.ts'), 'prefs');
{
  const merged = prefs.mergePrefs(prefs.DEFAULT_PREFS, { theme: 'dark', notifications: { sound: true }, fontSize: 'huge', bogus: 1 });
  ok(merged.theme === 'dark', 'prefs: a valid value merges');
  ok(merged.notifications.sound === true && merged.notifications.turnEnd === true, 'prefs: nested objects merge, siblings kept');
  ok(merged.fontSize === 14, 'prefs: a wrong type is ignored', merged.fontSize);
  ok(!('bogus' in merged), 'prefs: unknown keys are dropped');
}

// ── Turn grouping ──
const turns = await load(path.join(desktop, 'renderer/src/chat/turns.ts'), 'turns');
{
  const msgs = [
    { id: 'u1', type: 'user', content: 'hi', timestamp: 1 },
    { id: 'r1', type: 'reasoning', content: 'think', timestamp: 2 },
    { id: 'a1', type: 'assistant', content: 'let me look', timestamp: 3 },
    { id: 't1', type: 'tool', content: '', toolName: 'Read', toolArgs: { file_path: 'src/a.ts' }, timestamp: 4 },
    { id: 'a2', type: 'assistant', content: 'done', timestamp: 5 },
    { id: 'e1', type: 'error', content: 'oops', timestamp: 6 },
  ];
  const g = turns.groupTurns(msgs, false);
  ok(g.length === 1 && g[0].work.length === 3, 'turns: reasoning, commentary and tools fold under the work line', g[0]?.work.map(m => m.id));
  ok(g[0].answer.map(m => m.id).join() === 'a2,e1', 'turns: the reply after the last tool is the answer; errors are never folded');
  ok(turns.describeTool(msgs[3]) === 'Reading src/a.ts', 'turns: a tool call reads as what it is doing', turns.describeTool(msgs[3]));
  ok(turns.groupTurns([{ id: 'u', type: 'user', content: 'x', timestamp: 1 }, { id: 'r', type: 'reasoning', content: 'y', timestamp: 2 }, { id: 'a', type: 'assistant', content: 'z', timestamp: 3 }], false)[0].onlyThought, 'turns: thinking alone says "Thought", not "Worked"');
}

// ── Theme ──
const theme = await load(path.join(desktop, 'renderer/src/theme.ts'), 'theme');
{
  const t = theme.tokensFor({ preset: 'x', background: '#171717', foreground: '#ECECEC', accent: '#3B82F6' }, false);
  ok(t['--aico-bg'] === '#171717' && t['--aico-accent'] === '#3b82f6', 'theme: the three colours come through');
  ok(t['--aico-text-muted'] !== t['--aico-text-primary'] && t['--aico-text-muted'].startsWith('#'), 'theme: muted text is derived, not a copy');
  ok(theme.isDarkColors({ background: '#0b1020' }) && !theme.isDarkColors({ background: '#ffffff' }), 'theme: light/dark is read from the background');
}

// ── Composer menus ──
const sug = await load(path.join(desktop, 'renderer/src/chat/suggest-core.ts'), 'suggest');
{
  ok(sug.triggerAt('/pl', 3)?.kind === 'slash' && sug.triggerAt('/pl', 3).query === 'pl', 'composer: "/" at the start opens actions, filtered by what follows');
  ok(sug.triggerAt('half 1/2', 8) === null, 'composer: a "/" mid-sentence is not a command');
  ok(sug.triggerAt('/plan now', 9) === null, 'composer: typing past the command closes the menu');
  const m = sug.triggerAt('look at @src/ap', 15);
  ok(m?.kind === 'mention' && m.query === 'src/ap' && m.from === 8, 'composer: "@" after a space mentions, and the query can be a path', m);
  ok(sug.triggerAt('mail me@host', 12) === null, 'composer: name@host is not a mention');
  const items = [{ title: 'New chat' }, { title: 'Plan first' }, { title: 'Change model…' }, { title: 'Think: high', keywords: 'reasoning effort' }];
  ok(sug.rankItems(items, 'pl')[0].title === 'Plan first', 'composer: what starts with the typed text ranks first');
  ok(sug.rankItems(items, 'model')[0].title === 'Change model…', 'composer: a word inside the title matches');
  ok(sug.rankItems(items, 'effort')[0].title === 'Think: high', 'composer: hidden keywords match');
  ok(sug.rankItems(items, 'nwc')[0]?.title === 'New chat', 'composer: letters in order match ("nwc" finds New chat)');
  ok(sug.rankItems(items, 'zzz').length === 0, 'composer: nothing matching shows nothing');
  ok(sug.rankItems([{ title: 'Restart the engine', keywords: 'Application' }, { title: 'Open in the web client' }], 'pl').length === 0, 'composer: two letters do not match scattered letters ("pl" is not in "Restart the engine")');
  const d = sug.dedupe([{ title: 'New chat' }, { title: 'Plan first' }, { title: 'New chat' }, { title: 'Plan first (toggle)' }]);
  const g = sug.groupRanked([{ group: 'A', title: '1' }, { group: 'B', title: '2' }, { group: 'A', title: '3' }]);
  ok(g.map(x => x.title).join() === '1,3,2', 'composer: a filtered menu keeps each group together (no repeated headings)', g);
  ok(d.length === 2, 'composer: the same action is listed once ("Plan first (toggle)" is Plan first)', d.map(x => x.title));
  ok(sug.mentionPath('E:\\repo\\src\\app.ts', 'e:\\repo') === 'src/app.ts', 'composer: a file in the project is mentioned relative to it, whatever the drive case');
  ok(sug.mentionPath('C:\\Other Place\\a.ts', 'E:\\repo') === '"C:/Other Place/a.ts"', 'composer: a path with spaces outside the project is quoted');
}

// ── Projects ──
const pp = await load(path.join(desktop, 'renderer/src/lib/project-paths.ts'), 'project-paths');
{
  const list = pp.uniqueProjects([
    { path: 'e:\\github\\aetnic-ai', exists: true },
    { path: 'E:\\github\\aetnic-ai', exists: true },
    { path: 'E:\\github\\other', exists: true },
  ]);
  ok(list.length === 2 && list[0].path === 'E:\\github\\aetnic-ai', 'projects: one Windows folder under two drive spellings is one project, shown as Explorer spells it', list.map(p => p.path));
  ok(pp.uniqueProjects([{ path: '/home/a/Repo' }, { path: '/home/a/repo' }]).length === 2, 'projects: on Linux, case is significant');
  ok(pp.samePath('E:\\repo\\', 'e:/repo') && !pp.samePath('/a/B', '/a/b'), 'projects: path identity ignores separators and Windows case only');
}

// ── ZIP ──
const zip = await load(path.join(desktop, 'electron/zip.ts'), 'zip');
{
  const big = 'lorem ipsum dolor sit amet '.repeat(400);
  const bin = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7919) % 256));
  const buf = zip.zipSync([
    { name: 'a/', dir: true },
    { name: 'a/SKILL.md', data: big },
    { name: 'a/bin.dat', data: bin },
    { name: 'ünïcødé/日本語.txt', data: 'héllo' },
    { name: 'empty.txt', data: '' },
  ]);
  const back = zip.unzipSync(buf);
  const by = Object.fromEntries(back.map(e => [e.name, e]));
  ok(back.length === 5 && by['a'].dir, 'zip: sync round trip keeps every entry, folders included', back.map(e => e.name));
  ok(by['a/SKILL.md'].data.toString() === big && by['a/SKILL.md'].method === 8 && by['a/SKILL.md'].compressedSize < big.length / 10, 'zip: text is deflated and comes back byte for byte');
  ok(Buffer.compare(by['a/bin.dat'].data, bin) === 0, 'zip: binary data round trips');
  ok(by['ünïcødé/日本語.txt']?.data.toString() === 'héllo', 'zip: UTF-8 names survive (language-encoding flag)');
  ok(by['empty.txt'].data.length === 0 && by['empty.txt'].method === 0, 'zip: an empty file is stored, not deflated');
  ok(zip.crc32(Buffer.from('123456789')) === 0xcbf43926, 'zip: CRC-32 check value');

  const corrupt = Buffer.from(buf);
  corrupt[corrupt.indexOf(Buffer.from('héllo'))] ^= 0xff; // a stored entry, so its bytes are there as written
  throws(() => zip.unzipSync(corrupt), /checksum|corrupt/i, 'zip: a flipped byte is caught by the checksum');
  throws(() => zip.unzipSync(Buffer.from('not a zip at all')), /Not a zip/, 'zip: a non-zip says so');

  ok(zip.safeEntryPath('/root', '../etc/passwd') === null && zip.safeEntryPath('/root', 'C:/x') === null && zip.safeEntryPath('/root', '/abs') === null, 'zip: entries escaping the destination are refused (zip slip)');
  ok(zip.safeEntryPath(path.resolve('/root'), 'a/b.txt') === path.resolve('/root', 'a/b.txt'), 'zip: an ordinary entry lands under the destination');

  // Streaming writer + file reader, and zipDirectory with a root folder (the .skill layout).
  const src = path.join(out, 'zipsrc');
  fs.mkdirSync(path.join(src, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(src, 'empty-dir'), { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: my-skill\n---\nBody');
  fs.writeFileSync(path.join(src, 'scripts', 'run.py'), 'print(1)\n'.repeat(100));
  const dest = path.join(out, 'my-skill.skill');
  const res = await zip.zipDirectory(src, dest, 'my-skill');
  const r = await zip.ZipReader.open(dest);
  const names = r.entries.map(e => e.name + (e.dir ? '/' : '')).sort();
  ok(JSON.stringify(names) === JSON.stringify(['my-skill/', 'my-skill/SKILL.md', 'my-skill/empty-dir/', 'my-skill/scripts/', 'my-skill/scripts/run.py']), 'zip: zipDirectory puts everything under the root folder', names);
  ok((await r.read('my-skill/scripts/run.py')).toString() === 'print(1)\n'.repeat(100), 'zip: the file reader inflates what the writer deflated');
  await r.close();
  ok(res.entries === 5 && res.bytes === fs.statSync(dest).size, 'zip: zipDirectory reports entries and size', res);
  const plain = await zip.zipDirectory(src, path.join(out, 'plain.zip'));
  const pr = await zip.ZipReader.open(plain.file);
  ok(pr.find('SKILL.md') && !pr.find('my-skill'), 'zip: without a root name the folder\'s contents are at the top');
  await pr.close();
  const unpacked = path.join(out, 'unpacked');
  await zip.extractZip(dest, unpacked);
  ok(fs.readFileSync(path.join(unpacked, 'my-skill', 'SKILL.md'), 'utf8').endsWith('Body') && fs.statSync(path.join(unpacked, 'my-skill', 'empty-dir')).isDirectory(), 'zip: extractZip restores files and empty folders');

  // A zip made by another tool: PowerShell's Compress-Archive on Windows, `zip` elsewhere.
  const { spawnSync } = await import('node:child_process');
  const foreign = path.join(out, 'foreign.zip');
  const fsrc = path.join(out, 'foreign-src');
  fs.mkdirSync(path.join(fsrc, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(fsrc, 'top.txt'), 'top '.repeat(500));
  fs.writeFileSync(path.join(fsrc, 'sub', 'inner.json'), '{"a":1}');
  const made = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${fsrc}\\*' -DestinationPath '${foreign}' -Force`], { encoding: 'utf8' })
    : spawnSync('zip', ['-qr', foreign, '.'], { cwd: fsrc, encoding: 'utf8' });
  if (made.status === 0 && fs.existsSync(foreign)) {
    const fr = await zip.ZipReader.open(foreign);
    const top = fr.entries.find(e => e.name === 'top.txt');
    const inner = fr.entries.find(e => e.name === 'sub/inner.json');
    ok(Boolean(top && inner), 'zip: reads a zip made by another tool (names normalised to forward slashes)', fr.entries.map(e => e.name));
    ok(top && (await fr.read(top)).toString() === 'top '.repeat(500) && inner && (await fr.read(inner)).toString() === '{"a":1}', 'zip: and its deflated contents are right');
    await fr.close();
  } else {
    console.log('  skip  zip: no Compress-Archive / zip available to make a foreign archive');
  }
  // …and the other way round: Windows can open ours.
  if (process.platform === 'win32') {
    const target = path.join(out, 'ps-expand');
    const asZip = dest.replace(/\.skill$/, '-skill.zip'); // Expand-Archive insists on the .zip extension
    fs.copyFileSync(dest, asZip);
    const x = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Path '${asZip}' -DestinationPath '${target}' -Force`], { encoding: 'utf8' });
    ok(x.status === 0 && fs.readFileSync(path.join(target, 'my-skill', 'scripts', 'run.py'), 'utf8') === 'print(1)\n'.repeat(100), 'zip: PowerShell Expand-Archive opens what we wrote', x.stderr);
  }
}

// ── Backup ──
const bk = await load(path.join(desktop, 'electron/backup-core.ts'), 'backup');
{
  const settings = {
    theme: 'dark',
    providers: { anthropic: { apiKey: 'sk-ant-1', defaultModel: 'x', maxTokens: 4000 }, openai: { apiKey: 'sk-oa' } },
    providerInstances: [{ id: 'work', type: 'openai', apiKey: 'sk-work', baseUrl: 'https://x' }],
    mcpServers: { gh: { command: 'gh-mcp', env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_1', LOG_LEVEL: 'info' }, headers: { Authorization: 'Bearer z' } } },
    projects: [{ path: 'E:\\repo' }],
  };
  const s = bk.stripCredentials(settings);
  const json = JSON.stringify(s.value);
  ok(s.removed === 5 && !/sk-|ghp_|Bearer/.test(json), 'backup: every credential-shaped key is stripped', { removed: s.removed, json });
  ok(s.value.providers.anthropic.maxTokens === 4000 && s.value.mcpServers.gh.env.LOG_LEVEL === 'info' && s.value.projects.length === 1, 'backup: stripping keeps everything else (maxTokens is not a token)');
  const cur = { providers: { anthropic: { apiKey: 'sk-here' }, gemini: { apiKey: 'g-here' } }, providerInstances: [{ id: 'other', apiKey: 'no' }, { id: 'work', apiKey: 'sk-work-here' }] };
  const merged = bk.restoreCredentials(s.value, cur);
  ok(merged.value.providers.anthropic.apiKey === 'sk-here' && merged.value.providerInstances[0].apiKey === 'sk-work-here', 'backup: restoring a stripped backup keeps this machine\'s keys, matched by id', merged.value);
  ok(!merged.value.providers.gemini && merged.kept === 2, 'backup: a provider the backup does not have is not brought back', merged.kept);
  ok(bk.categoryOf('skills/x/SKILL.md') === 'skills' && bk.categoryOf('workspace/projects/p-1/sessions/a/x.json') === 'chats'
    && bk.categoryOf('workspace/projects/p-1/src/app.ts') === null && bk.categoryOf('codemap/x.json') === null && bk.categoryOf('settings.json') === 'settings',
  'backup: paths are sorted into categories; caches and workspace code are not backed up');

  // A whole round trip between two homes.
  const homeA = path.join(out, 'homeA');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(homeA, rel)), { recursive: true }); fs.writeFileSync(path.join(homeA, rel), text); };
  put('settings.json', JSON.stringify(settings));
  put('desktop/prefs.json', '{"theme":"dark"}');
  put('desktop/plugins/hello/aico-plugin.json', '{"id":"hello"}');
  put('skills/my-skill/SKILL.md', 'skill body');
  put('agents/reviewer.md', 'agent');
  put('memories/global/m1.json', '{}');
  put('cron.json', '[]');
  put('projects/abc/sessions/s1.jsonl', '{"e":1}\n');
  put('workspace/projects/p-1/sessions/s1/attachments/a.txt', 'att');
  put('workspace/projects/p-1/app.ts', 'user code');
  put('codemap/cache.json', 'cache');
  const meta = { app: '9.9.9', engine: '9.9.9' };
  const plain = await bk.exportBackup(homeA, path.join(out, 'b1.zip'), {}, meta);
  const plainReader = await zip.ZipReader.open(plain.file);
  const plainNames = plainReader.entries.map(e => e.name);
  await plainReader.close();
  ok(plain.manifest.includes.join() === 'settings,desktop,plugins,skills,agents,memory,schedules' && !plainNames.some(n => n.includes('sessions') || n.includes('codemap') || n.includes('app.ts')), 'backup: default export leaves out chats, caches and workspace code', plainNames);
  const withChats = await bk.exportBackup(homeA, path.join(out, 'b2.zip'), { includeChats: true, includeApiKeys: true }, meta);
  ok(withChats.manifest.chats && withChats.manifest.counts.chats === 2 && withChats.manifest.apiKeys, 'backup: chats and keys are included on request', withChats.manifest.counts);
  const pv = await bk.readBackup(withChats.file);
  ok(pv.summary.find(x => x.id === 'chats')?.files === 2 && pv.ignored === 0, 'backup: a preview says what will be restored', pv.summary);

  const homeB = path.join(out, 'homeB');
  fs.mkdirSync(path.join(homeB, 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(homeB, 'skills', 'mine', 'SKILL.md'), 'keep me');
  fs.writeFileSync(path.join(homeB, 'skills', 'my-skill.txt'), 'x');
  fs.writeFileSync(path.join(homeB, 'settings.json'), JSON.stringify({ providers: { anthropic: { apiKey: 'sk-B' } }, theme: 'light' }));
  const rs = await bk.restoreBackup(homeB, plain.file, meta);
  const restoredSettings = JSON.parse(fs.readFileSync(path.join(homeB, 'settings.json'), 'utf8'));
  ok(restoredSettings.theme === 'dark' && restoredSettings.providers.anthropic.apiKey === 'sk-B' && rs.keptKeys === 1, 'backup: restore replaces settings but keeps this machine\'s key', restoredSettings.providers);
  ok(fs.readFileSync(path.join(homeB, 'skills', 'my-skill', 'SKILL.md'), 'utf8') === 'skill body' && fs.readFileSync(path.join(homeB, 'skills', 'mine', 'SKILL.md'), 'utf8') === 'keep me', 'backup: restore merges — new skills arrive, existing ones stay');
  ok(fs.existsSync(path.join(homeB, 'desktop', 'plugins', 'hello', 'aico-plugin.json')) && fs.existsSync(path.join(homeB, 'agents', 'reviewer.md')), 'backup: plugins and agents are restored');
  const safety = await bk.readBackup(rs.safetyCopy);
  ok(fs.existsSync(rs.safetyCopy) && safety.manifest.apiKeys && safety.summary.some(x => x.id === 'skills'), 'backup: the files it replaced were saved to backups/pre-restore-*.zip first', rs.safetyCopy);
  ok(!fs.readdirSync(homeB).some(n => n.startsWith('.restore-')), 'backup: the staging folder is cleaned up');

  // A hostile archive: a manifest, and an entry trying to escape the home.
  const evil = zip.zipSync([
    { name: 'manifest.json', data: JSON.stringify({ format: 'aico-backup', version: 1, includes: ['skills'], apiKeys: false, chats: false, createdAt: '', app: '', engine: '', platform: 'x', files: 2, counts: {} }) },
    { name: 'home/../../escape.txt', data: 'bad' },
    { name: 'home/skills/ok/SKILL.md', data: 'fine' },
    { name: 'home/codemap/x.json', data: 'cache' },
  ]);
  fs.writeFileSync(path.join(out, 'evil.zip'), evil);
  const ev = await bk.readBackup(path.join(out, 'evil.zip'));
  ok(ev.ignored === 2 && ev.summary.length === 1, 'backup: entries outside the known categories (or escaping the home) are skipped', ev);
  await bk.restoreBackup(homeB, path.join(out, 'evil.zip'), meta);
  ok(!fs.existsSync(path.join(out, 'escape.txt')) && !fs.existsSync(path.join(homeB, 'codemap')) && fs.existsSync(path.join(homeB, 'skills', 'ok', 'SKILL.md')), 'backup: and are never written');
  fs.writeFileSync(path.join(out, 'nomanifest.zip'), zip.zipSync([{ name: 'x.txt', data: 'x' }]));
  let msg = '';
  try { await bk.readBackup(path.join(out, 'nomanifest.zip')); } catch (e) { msg = e.message; }
  ok(/not an AICO backup/.test(msg), 'backup: a zip without a manifest is refused', msg);
}

// ── Context menus ──
const cm = await load(path.join(desktop, 'electron/context-menu-template.ts'), 'context-menu');
{
  const base = { linkURL: '', srcURL: '', mediaType: 'none', hasImageContents: false, isEditable: false, selectionText: '', misspelledWord: '', dictionarySuggestions: [],
    editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false, canEditRichly: false } };
  const app = { surface: 'app', inspect: false };
  const labels = (m) => m.map(x => x.type === 'separator' ? '|' : x.label).join(',');
  const noEdgeSeps = (m) => m.length === 0 || (m[0].type !== 'separator' && m[m.length - 1].type !== 'separator' && !m.some((x, i) => x.type === 'separator' && m[i + 1]?.type === 'separator'));

  ok(cm.buildContextMenuTemplate(base, app).length === 0, 'menu: a plain click in the app shows nothing (its own menus stay its own)');
  const edit = cm.buildContextMenuTemplate({ ...base, isEditable: true, editFlags: { ...base.editFlags, canPaste: true, canSelectAll: true, canUndo: true } }, app);
  ok(labels(edit) === 'Undo,Redo,|,Cut,Copy,Paste,|,Select all', 'menu: an editable field gets the edit commands', labels(edit));
  ok(edit.find(x => x.label === 'Cut').enabled === false && edit.find(x => x.label === 'Paste').enabled === true, 'menu: edit commands follow editFlags');
  const rich = cm.buildContextMenuTemplate({ ...base, isEditable: true, editFlags: { ...base.editFlags, canPaste: true, canEditRichly: true } }, app);
  ok(rich.some(x => x.label === 'Paste as plain text'), 'menu: a rich editor also offers Paste as plain text');
  const spell = cm.buildContextMenuTemplate({ ...base, isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'tea', 'tech', 'then', 'thee'] }, app);
  ok(spell[0].type === 'spelling' && spell[0].word === 'the' && spell.filter(x => x.type === 'spelling').length === 5 && spell.some(x => x.label === 'Add to dictionary'), 'menu: a misspelling puts up to 5 suggestions first, then Add to dictionary', labels(spell));
  const nosug = cm.buildContextMenuTemplate({ ...base, isEditable: true, misspelledWord: 'qzxv' }, app);
  ok(nosug[0].label === 'No suggestions' && nosug[0].enabled === false, 'menu: no suggestions says so (disabled)');
  const sel = cm.buildContextMenuTemplate({ ...base, selectionText: 'hello', editFlags: { ...base.editFlags, canCopy: true } }, app);
  ok(labels(sel) === 'Copy', 'menu: a selection in the transcript gets Copy', labels(sel));
  const link = cm.buildContextMenuTemplate({ ...base, linkURL: 'https://example.com' }, app);
  ok(labels(link) === 'Open link,Open in built-in browser,Copy link address', 'menu: a link in the app opens outside or in the built-in browser', labels(link));
  ok(cm.buildContextMenuTemplate({ ...base, linkURL: 'aico://app/#x' }, app).length === 0, 'menu: an internal app link gets nothing');
  const blink = cm.buildContextMenuTemplate({ ...base, linkURL: 'https://example.com' }, { surface: 'browser', inspect: false });
  ok(labels(blink) === 'Open link in new tab,Open link in your browser,Copy link address', 'menu: a link in the built-in browser opens a new tab', labels(blink));
  const img = cm.buildContextMenuTemplate({ ...base, mediaType: 'image', srcURL: 'https://x/y.png', hasImageContents: true, linkURL: 'https://x' }, app);
  ok(labels(img) === 'Open link,Open in built-in browser,Copy link address,|,Copy image,Copy image address,Save image as…' && noEdgeSeps(img), 'menu: a linked image gets link and image groups, one separator between', labels(img));
  const page = cm.buildContextMenuTemplate(base, { surface: 'browser', inspect: false, canGoBack: true, canGoForward: false });
  ok(labels(page) === 'Back,Forward,Reload' && page[1].enabled === false, 'menu: a plain browser page gets Back / Forward / Reload', labels(page));
  const dev = cm.buildContextMenuTemplate(base, { surface: 'app', inspect: true });
  ok(labels(dev) === 'Inspect element', 'menu: in development, Inspect element is always there');
  const devEdit = cm.buildContextMenuTemplate({ ...base, isEditable: true }, { surface: 'browser', inspect: true });
  ok(devEdit[devEdit.length - 1].label === 'Inspect element' && devEdit[devEdit.length - 2].type === 'separator' && noEdgeSeps(devEdit) && !devEdit.some(x => x.label === 'Back'), 'menu: Inspect goes last after a separator; editing a field hides page navigation');
}

// ── Update safety ──
const busy = await load(path.join(desktop, 'electron/engine-busy.ts'), 'engine-busy');
{
  const lines = busy.summariseBusy(
    { sessions: [{ id: 'a', title: 'Fix login', running: true }, { id: 'b', title: 'Old', running: false }] },
    { work: [
      { id: 'w1', kind: 'agent', title: 'Research', state: 'running' },
      { id: 'w2', kind: 'process', title: 'npm run dev', state: 'running' },
      { id: 'w3', kind: 'watcher', title: 'CI', state: 'running' },
      { id: 'w4', kind: 'schedule', title: 'Nightly', state: 'queued' },
      { id: 'w5', kind: 'schedule', title: 'Hourly', state: 'running' },
      { id: 'w6', kind: 'agent', title: 'Done one', state: 'done' },
    ] },
  );
  ok(lines.length === 3 && /Fix login/.test(lines[0]) && /Research/.test(lines[1]) && /Hourly/.test(lines[2]), 'update: running chats, agents and firing jobs hold a restart; dev servers, watchers and idle schedules do not', lines);
  ok(busy.summariseBusy(null, null).length === 0, 'update: an engine that does not answer is not busy');
  ok(busy.summariseBusy({}, { backgroundAgents: [{ agentId: 'x', description: 'Old engine agent', status: 'running' }] }).length === 1, 'update: an engine without the work ledger still reports background agents');
}
{
  const merged = prefs.mergePrefs(prefs.DEFAULT_PREFS, { autoUpdate: { enabled: false } });
  ok(merged.autoUpdate.enabled === false && merged.autoUpdate.channel === 'latest' && merged.autoUpdate.lastCheckedAt === 0 && merged.developerMenus === false, 'prefs: autoUpdate merges over its defaults', merged.autoUpdate);
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`\n  DESKTOP UNIT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
