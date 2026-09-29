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
  ok(labels(blink) === 'Open link in new tab,Open link in new background tab,Open link in your browser,|,Save link as…,Copy link address,|,Ask AICO about this link,|,Inspect', 'menu: a link in the built-in browser opens a new tab (as in Chrome, with AICO)', labels(blink));
  const img = cm.buildContextMenuTemplate({ ...base, mediaType: 'image', srcURL: 'https://x/y.png', hasImageContents: true, linkURL: 'https://x' }, app);
  ok(labels(img) === 'Open link,Open in built-in browser,Copy link address,|,Copy image,Copy image address,Save image as…' && noEdgeSeps(img), 'menu: a linked image gets link and image groups, one separator between', labels(img));
  const page = cm.buildContextMenuTemplate(base, { surface: 'browser', inspect: false, canGoBack: true, canGoForward: false });
  ok(labels(page).startsWith('Back,Forward,Reload,|,Save page as…,Print…') && page[1].enabled === false, 'menu: a plain browser page gets Back / Forward / Reload, then save and print', labels(page));
  const dev = cm.buildContextMenuTemplate(base, { surface: 'app', inspect: true });
  ok(labels(dev) === 'Inspect element', 'menu: in development, Inspect element is always there');
  const devEdit = cm.buildContextMenuTemplate({ ...base, isEditable: true }, { surface: 'browser', inspect: true });
  ok(devEdit[devEdit.length - 1].label === 'Inspect' && devEdit[devEdit.length - 2].type === 'separator' && noEdgeSeps(devEdit) && !devEdit.some(x => x.label === 'Back'), 'menu: Inspect goes last after a separator; editing a field hides page navigation');
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

// ── Sources behind an answer ──
const src = await load(path.join(desktop, 'renderer/src/chat/sources.ts'), 'sources');
{
  const msgs = [
    { type: 'tool', toolName: 'WebSearch', toolArgs: { query: 'kabli pulao abbottabad' }, toolResult: JSON.stringify({ results: [
      { title: 'Afghan Chopan menu', url: 'https://www.foodpanda.pk/a', snippet: 'Kabuli pulao…' },
      { title: 'Yum Foody', url: 'https://yumfoody.com/ikr', snippet: 'Inam Khan Tikka' },
      { title: 'Bad', url: 'javascript:alert(1)' },
    ] }) },
    { type: 'tool', toolName: 'WebFetch', toolArgs: { url: 'https://yumfoody.com/ikr' }, toolResult: 'Title: Yum Foody | Inam Khan Tikka\n\nMenu…' },
    { type: 'tool', toolName: 'mcp__aico-desktop__browser_open', toolArgs: { url: 'https://maps.example.org/x' }, toolResult: 'ok' },
    { type: 'assistant', content: 'done' },
  ];
  const s = src.extractSources(msgs);
  ok(s.length === 3, 'sources: each URL once, non-web URLs dropped', s.map(x => x.url));
  ok(s[0].url === 'https://yumfoody.com/ikr' && s[0].via === 'read' && s[0].snippet === 'Inam Khan Tikka', 'sources: pages the agent opened come first, keeping the search snippet', s[0]);
  ok(s[0].title === 'Yum Foody | Inam Khan Tikka', 'sources: a fetched page keeps the title it read', s[0].title);
  ok(s.some(x => x.host === 'maps.example.org' && x.via === 'read'), 'sources: the built-in browser counts as reading');
  ok(s[s.length - 1].via === 'search' && s[s.length - 1].host === 'foodpanda.pk', 'sources: results seen but not opened are listed after, as search');
  ok(src.readableTitle('https://www.youtube.com/results?search_query=kabuli+pulao+recipe') === 'Search: kabuli pulao recipe', 'sources: a search page reads as what was searched', src.readableTitle('https://www.youtube.com/results?search_query=kabuli+pulao+recipe'));
  ok(src.readableTitle('https://example.com/menus/afghan-chopan_abbottabad.html') === 'afghan chopan abbottabad', 'sources: an untitled page reads as its path, not a raw URL');
  ok(src.extractSources([{ type: 'tool', toolName: 'WebFetch', toolArgs: { url: 'https://lite.duckduckgo.com/lite/?q=kabuli%20pulao' }, toolResult: 'no title here' }])[0].title === 'Search: kabuli pulao', 'sources: every listed source has a readable title');
  ok(src.siteName('foodpanda.pk') === 'Foodpanda' && src.siteName('www.news.bbc.co.uk') === 'Bbc', 'sources: a site name reads as a name', [src.siteName('foodpanda.pk'), src.siteName('www.news.bbc.co.uk')]);
}

// ── Browser chrome: the address bar ──
const urls = await load(path.join(desktop, 'renderer/src/browser/urls.ts'), 'browser-urls');
{
  const p = (s) => urls.parseOmnibox(s);
  ok(p('example.com').kind === 'url' && p('example.com').url === 'https://example.com', 'omnibox: a bare domain is an address (https)', p('example.com'));
  ok(p('news.ycombinator.com/item?id=1').url === 'https://news.ycombinator.com/item?id=1', 'omnibox: a domain with a path and query is an address');
  ok(p('localhost:3000/app').url === 'http://localhost:3000/app', 'omnibox: localhost is http', p('localhost:3000/app'));
  ok(p('192.168.1.10:8080').url === 'http://192.168.1.10:8080', 'omnibox: an IP address is http');
  ok(p('999.1.1.1').kind === 'search', 'omnibox: not-an-IP is a search', p('999.1.1.1'));
  ok(p('https://en.wikipedia.org/wiki/Abbottabad').url === 'https://en.wikipedia.org/wiki/Abbottabad', 'omnibox: a full URL is kept as typed');
  ok(p('what is rust').kind === 'search' && p('what is rust').url === 'https://www.google.com/search?q=what%20is%20rust', 'omnibox: words are a Google search', p('what is rust'));
  ok(p('rust').kind === 'search', 'omnibox: one word without a dot is a search');
  ok(p('rust-lang.org').kind === 'url', 'omnibox: a hyphenated domain is an address');
  ok(p('?example.com').kind === 'search' && p('?example.com').text === 'example.com', 'omnibox: a leading ? forces a search');
  ok(p('about:blank').kind === 'url' && p('about rust').kind === 'search', 'omnibox: about: is a scheme, "about rust" is a search');
  ok(p('file:///C:/My Files/a.html').kind === 'url' && p('file:///C:/My Files/a.html').url.includes('%20'), 'omnibox: a pasted file URL with a space stays an address');
  ok(p('   ') === null, 'omnibox: blank input does nothing');
  ok(p('version 1.2.3').kind === 'search' && p('3.14').kind === 'search', 'omnibox: numbers with dots are not domains', [p('version 1.2.3').kind, p('3.14').kind]);
  ok(urls.displayUrl('https://example.com/') === 'example.com' && urls.displayUrl('http://example.com/a') === 'http://example.com/a' && urls.displayUrl('about:blank') === '', 'omnibox: display hides https:// and a bare trailing slash, keeps http://');
  ok(urls.isBlankUrl('about:blank') && urls.isBlankUrl('') && !urls.isBlankUrl('https://x.com'), 'omnibox: the new tab page is about:blank');

  const now = Date.UTC(2026, 8, 29);
  const history = [
    { url: 'https://news.ycombinator.com/', title: 'Hacker News', visits: 40, lastVisit: now - 3600e3 },
    { url: 'https://www.nature.com/news', title: 'Latest science news', visits: 2, lastVisit: now - 20 * 86400e3 },
    { url: 'https://example.com/newsletter', title: 'Newsletter', visits: 1, lastVisit: now - 86400e3 },
    { url: 'https://github.com/', title: 'GitHub', visits: 90, lastVisit: now },
  ];
  const marks = [{ url: 'https://www.nature.com/news', title: 'Nature — News', addedAt: now - 100 * 86400e3 }];
  const s = urls.rankSuggestions('news', history, marks, { now });
  ok(s[0].kind === 'search' && /Search Google for/.test(s[0].detail), 'suggest: a word puts "Search Google for …" first', s[0]);
  ok(s[1].url === 'https://news.ycombinator.com/', 'suggest: a host that starts with the text, visited often, ranks first', s.map(x => x.url));
  ok(s.filter(x => x.url.includes('nature.com')).length === 1 && s.find(x => x.url.includes('nature.com')).kind === 'bookmark', 'suggest: a bookmarked page appears once, as the bookmark');
  ok(!s.some(x => x.url === 'https://github.com/'), 'suggest: pages that do not match are left out');
  const d = urls.rankSuggestions('github.com', history, marks, { now });
  ok(d[0].kind === 'go' && d[0].url === 'https://github.com' && d[d.length - 1].kind === 'search', 'suggest: an address offers "go" first and the search last', d.map(x => x.kind));
  ok(!d.slice(1).some(x => x.kind === 'history' && x.url === 'https://github.com/'), 'suggest: the page Enter would open is not listed twice', d.map(x => x.url));
  ok(urls.rankSuggestions('', history, marks).length === 0, 'suggest: nothing typed, nothing suggested');
  ok(urls.rankSuggestions('hacker news', history, [], { now }).some(x => x.url === 'https://news.ycombinator.com/'), 'suggest: every word must match somewhere (title words count)');
  ok(urls.rankSuggestions('n', history, marks, { now, limit: 3 }).length === 3, 'suggest: the limit holds');
  ok(urls.searchTermsOf('https://www.google.com/search?q=kabuli+pulao') === 'kabuli pulao' && urls.searchTermsOf('https://example.com/?q=x') === null, 'omnibox: search terms are read back from a results page');
}

// ── Browser chrome: what the copilot tells the agent ──
const bctx = await load(path.join(desktop, 'renderer/src/browser/context.ts'), 'browser-context');
{
  const h = bctx.buildContextHeader({ url: 'https://en.wikipedia.org/wiki/Abbottabad', title: 'Abbottabad - Wikipedia', selection: '  a   city in\nKhyber Pakhtunkhwa ', humanCheck: false });
  ok(h.startsWith(bctx.CONTEXT_OPEN) && h.endsWith(bctx.CONTEXT_CLOSE), 'context: the header is fenced', h);
  ok(/^URL: https:\/\/en\.wikipedia\.org\/wiki\/Abbottabad$/m.test(h) && /^Title: Abbottabad - Wikipedia$/m.test(h), 'context: it names the URL and title');
  ok(/Selected text: "a city in Khyber Pakhtunkhwa"/.test(h), 'context: the selection is included, whitespace collapsed', h);
  ok(/browser_read/.test(h) && /not the page content/.test(h), 'context: it tells the agent to read the page with its tools rather than guess');
  ok(!/human check/i.test(h), 'context: no human-check line when there is none');
  const long = bctx.buildContextHeader({ url: 'https://x.com', title: 'T', selection: 'x'.repeat(5000) });
  ok(long.length < 1500, 'context: a long selection is clipped — the header stays short', long.length);
  const hc = bctx.buildContextHeader({ url: 'https://x.com', title: 'T', humanCheck: true, loginWall: true });
  ok(/Do not try to solve it/.test(hc) && /browser_handoff/.test(hc) && /Never type passwords/.test(hc), 'context: a human check or sign-in wall tells the agent to hand over', hc);
  const msg = bctx.withContext('Summarize this', { url: 'https://x.com/a', title: 'A page' });
  ok(bctx.stripContextHeader(msg) === 'Summarize this', 'context: the header is stripped for display', bctx.stripContextHeader(msg));
  ok(bctx.stripContextHeader('no header here') === 'no header here', 'context: a message without a header is unchanged');
  ok(bctx.contextPageOf(msg)?.url === 'https://x.com/a' && bctx.contextPageOf(msg)?.title === 'A page', 'context: the page a message was about is read back');
  ok(bctx.withContext('hi', null) === 'hi', 'context: a detached page sends the message alone');
  const tabsHdr = bctx.buildContextHeader({ url: 'https://a.com', title: 'A', otherTabs: [{ title: 'B', url: 'https://b.com' }] });
  ok(/Other open tabs: B <https:\/\/b\.com>/.test(tabsHdr), 'context: other tabs are listed for comparisons', tabsHdr);

  const byId = Object.fromEntries(bctx.QUICK_ACTIONS.map(q => [q.id, q]));
  ok(['summarize', 'keypoints', 'explain', 'tables', 'prices', 'form', 'compare', 'translate', 'whatcan'].every(id => byId[id]), 'quick actions: all nine are there', Object.keys(byId));
  ok(/browser_read/.test(byId.summarize.prompt) && /reader/.test(byId.summarize.prompt) && /Source:/.test(byId.summarize.prompt), 'quick actions: summarize reads in reader mode and names its source');
  ok(/browser_forms/.test(byId.form.prompt) && /browser_fill/.test(byId.form.prompt) && /Do NOT submit/.test(byId.form.prompt), 'quick actions: fill form reads the form, fills, and does not submit');
  ok(/passwords/.test(byId.form.prompt) && /one-time codes/.test(byId.form.prompt) && /CAPTCHA/.test(byId.form.prompt) && /browser_handoff/.test(byId.form.prompt), 'quick actions: fill form never types secrets and hands over instead');
  ok(/Do not add anything to a cart or buy/.test(byId.prices.prompt), 'quick actions: finding prices never buys');
  ok(bctx.QUICK_STARTS.length === 4 && bctx.QUICK_STARTS.every(q => q.prompt.endsWith(': ') || q.prompt.endsWith(' ')), 'quick starts: four, each ready for the person to finish');
  ok(!bctx.QUICK_ACTIONS.some(q => /solve the captcha|enter (your|the) password/i.test(q.prompt)), 'quick actions: nothing promises to solve a check or type a password');

  const d = bctx.describeAgentAction;
  ok(d({ action: 'click', label: 'Add to cart', status: 'start' }) === 'Clicking “Add to cart”…', 'agent line: clicking a labelled element', d({ action: 'click', label: 'Add to cart', status: 'start' }));
  ok(d({ action: 'browser_open', label: 'news.ycombinator.com', status: 'start' }) === 'Opening news.ycombinator.com…', 'agent line: opening a site (tool-name prefix dropped)', d({ action: 'browser_open', label: 'news.ycombinator.com', status: 'start' }));
  ok(d({ action: 'read', status: 'start' }) === 'Reading the page…', 'agent line: reading with no label reads "the page"');
  ok(d({ action: 'type', label: 'Search', status: 'done' }) === 'Typed into “Search”', 'agent line: done is past tense');
  ok(d({ action: 'click', label: 'Pay now', status: 'blocked', detail: 'payment' }).startsWith('Stopped before clicking “Pay now”'), 'agent line: a blocked action says it stopped', d({ action: 'click', label: 'Pay now', status: 'blocked', detail: 'payment' }));
  ok(d({ action: 'type', label: 'Email', status: 'error', detail: 'not found' }) === 'Couldn\u2019t type into “Email” — not found'.replace('\u2019', "'"), 'agent line: an error says what failed', d({ action: 'type', label: 'Email', status: 'error', detail: 'not found' }));
  ok(d({ action: 'teleport', status: 'start' }) === 'Teleport…', 'agent line: an unknown action still reads');
}

// ── Browser chrome: shortcuts, tabs, the floating copilot ──
const bkeys = await load(path.join(desktop, 'renderer/src/browser/shortcuts.ts'), 'browser-keys');
{
  const k = (key, mods = {}) => bkeys.browserShortcut({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
  ok(k('t', { ctrlKey: true }) === 'newTab' && k('w', { ctrlKey: true }) === 'closeTab' && k('l', { ctrlKey: true }) === 'focusAddress', 'keys: Ctrl+T / Ctrl+W / Ctrl+L');
  ok(k('Tab', { ctrlKey: true }) === 'nextTab' && k('Tab', { ctrlKey: true, shiftKey: true }) === 'prevTab', 'keys: Ctrl+Tab and Ctrl+Shift+Tab cycle tabs');
  ok(k('A', { ctrlKey: true, shiftKey: true }) === 'copilot', 'keys: Ctrl+Shift+A toggles the copilot');
  ok(k('f', { ctrlKey: true }) === 'find' && k('d', { ctrlKey: true }) === 'bookmark' && k('h', { ctrlKey: true }) === 'history' && k('j', { ctrlKey: true }) === 'downloads', 'keys: Ctrl+F / D / H / J');
  ok(k('=', { ctrlKey: true }) === 'zoomIn' && k('+', { ctrlKey: true, shiftKey: true }) === 'zoomIn' && k('-', { ctrlKey: true }) === 'zoomOut' && k('0', { ctrlKey: true }) === 'zoomReset', 'keys: zoom');
  ok(k('ArrowLeft', { altKey: true }) === 'back' && k('ArrowRight', { altKey: true }) === 'forward', 'keys: Alt+← / Alt+→');
  ok(k('F5') === 'reload' && k('r', { ctrlKey: true }) === 'reload' && k('Escape') === 'escape', 'keys: F5, Ctrl+R, Esc');
  ok(k('t') === null && k('ArrowLeft') === null && k('t', { ctrlKey: true, altKey: true }) === null, 'keys: plain typing is never a shortcut');
  ok(bkeys.browserShortcut({ key: 't', ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }, true) === 'newTab', 'keys: ⌘ is the modifier on macOS');
  const ps = bkeys.parseShortcut('Ctrl+Shift+Tab');
  ok(bkeys.browserShortcut(ps) === 'prevTab', 'keys: a forwarded "Ctrl+Shift+Tab" parses', ps);
  ok(bkeys.browserShortcut(bkeys.parseShortcut('Ctrl++')) === 'zoomIn' && bkeys.browserShortcut(bkeys.parseShortcut('Ctrl+Shift++')) === 'zoomIn', 'keys: a forwarded "Ctrl++" is the plus key', bkeys.parseShortcut('Ctrl++'));
  ok(bkeys.browserShortcut(bkeys.parseShortcut('Alt+ArrowLeft')) === 'back' && bkeys.browserShortcut(bkeys.parseShortcut('F5')) === 'reload' && bkeys.browserShortcut(bkeys.parseShortcut('Ctrl+-')) === 'zoomOut', 'keys: forwarded Alt+←, F5 and Ctrl+- parse');
}
const btabs = await load(path.join(desktop, 'renderer/src/browser/tabs.ts'), 'browser-tabs');
{
  const st = btabs.fromLegacy([
    { id: 'b1', url: 'https://a.com/', title: 'A', loading: false, canGoBack: false, canGoForward: false, active: false, zoom: 1 },
    { id: 'b2', url: 'http://b.com/', title: 'B', loading: true, canGoBack: true, canGoForward: false, active: true, zoom: 1.1 },
  ]);
  ok(st.activeId === 'b2' && st.tabs[0].security === 'secure' && st.tabs[1].security === 'insecure' && st.tabs[1].zoom === 1.1, 'tabs: an older main\'s tab list is read as state', st);
  const tab = { ...st.tabs[0], loading: false };
  ok(btabs.tabError(tab, { b1: { code: -105, description: 'ERR_NAME_NOT_RESOLVED', url: 'https://a.com/' } })?.code === -105, 'tabs: a load error for the page on screen shows');
  ok(btabs.tabError(tab, { b1: { code: -105, description: 'x', url: 'https://old.com/' } }) === undefined, 'tabs: an error for a page since left does not');
  ok(btabs.isCertError({ code: -202, description: 'ERR_CERT_AUTHORITY_INVALID', url: '' }) && !btabs.isCertError({ code: -105, description: '', url: '' }), 'tabs: -200…-299 is a certificate error');
  const now = 1_000_000;
  const busy = (event, at, legacyAgentAt = 0, active = false) => btabs.agentBusy({ agent: { event, at }, state: { activeId: null, tabs: active ? [{ ...tab, agentActive: true }] : [tab], blocking: { enabled: true } }, legacyAgentAt }, now);
  ok(busy(null, 0, 0, true), 'agent: busy while main flags a tab');
  ok(busy({ tabId: 'b1', action: 'click', status: 'start' }, now - 5000) && !busy({ tabId: 'b1', action: 'click', status: 'done' }, now - 5000), 'agent: a started action counts for longer than a finished one');
  ok(!busy(null, 0) && busy(null, 0, now - 2000), 'agent: an older main\'s "agent active" ping counts for a few seconds');
}
const bgeo = await load(path.join(desktop, 'renderer/src/browser/geometry.ts'), 'browser-geo');
{
  const area = { width: 1000, height: 700 };
  const first = bgeo.clampFloat({ x: -1, y: 16, w: 400, h: 560 }, area);
  ok(first.x === 1000 - 400 - 16 && first.y === 16, 'copilot: first placement is top-right', first);
  const off = bgeo.clampFloat({ x: 5000, y: -50, w: 400, h: 560 }, area);
  ok(off.x === 1000 - 400 - 8 && off.y === 8, 'copilot: dragged off-screen, it is kept inside', off);
  const small = bgeo.clampFloat({ x: 10, y: 10, w: 900, h: 900 }, { width: 500, height: 400 });
  ok(small.w === 484 && small.h === 384, 'copilot: never larger than the area it floats over', small);
}

// ── Built-in browser: tracker blocking ──
const trk = await load(path.join(desktop, 'electron/browser-trackers.ts'), 'browser-trackers');
{
  const n = trk.trackerCount();
  ok(n >= 200 && n <= 500, 'browser/trackers: a compact curated list (200–500 domains)', n);
  ok(trk.trackerDomainFor('www.google-analytics.com') === 'google-analytics.com', 'browser/trackers: a subdomain matches its listed domain');
  ok(trk.trackerDomainFor('stats.g.doubleclick.net') === 'doubleclick.net' || trk.trackerDomainFor('stats.g.doubleclick.net') === 'stats.g.doubleclick.net', 'browser/trackers: deep subdomains match');
  ok(trk.trackerDomainFor('example.com') === null && trk.trackerDomainFor('notdoubleclick.net') === null, 'browser/trackers: look-alike and ordinary hosts do not match');
  ok(trk.registrableDomain('news.bbc.co.uk') === 'bbc.co.uk' && trk.registrableDomain('a.b.example.com') === 'example.com' && trk.registrableDomain('127.0.0.1') === '127.0.0.1', 'browser/trackers: registrable domain handles co.uk and IPs');
  const page = 'https://www.nytimes.com/2026/09/29/world/story.html';
  ok(trk.shouldBlock('https://www.google-analytics.com/g/collect?v=2', page, 'xhr').block === true, 'browser/trackers: third-party analytics on a news page is blocked');
  ok(trk.shouldBlock('https://securepubads.g.doubleclick.net/tag/js/gpt.js', page, 'script').tracker === 'securepubads.g.doubleclick.net', 'browser/trackers: the blocked host is reported');
  ok(trk.shouldBlock('https://www.doubleclick.net/', 'about:blank', 'mainFrame').block === false, 'browser/trackers: a main-frame navigation is never blocked');
  ok(trk.shouldBlock('https://analytics.twitter.com/i/adsct', 'https://twitter.com/home', 'script').block === false, 'browser/trackers: first party (same registrable domain) is exempt');
  ok(trk.shouldBlock('https://static.hotjar.com/c/hotjar-1.js', 'https://www.hotjar.com/pricing', 'script').block === false, 'browser/trackers: a tracker company\'s own site works');
  for (const u of ['https://www.google.com/recaptcha/api.js', 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', 'https://js.hcaptcha.com/1/api.js', 'https://challenges.cloudflare.com/turnstile/v0/api.js', 'https://cdn.jsdelivr.net/npm/x', 'https://fonts.googleapis.com/css2']) {
    ok(trk.shouldBlock(u, page, 'script').block === false, `browser/trackers: not blocked (sign-ins and CDNs keep working): ${new URL(u).hostname}`);
  }
  ok(trk.originOf('https://a.example.com:8443/x?y') === 'https://a.example.com:8443' && trk.originOf('about:blank') === '', 'browser/trackers: origins');
}

// ── Built-in browser: safety verdicts ──
const safety = await load(path.join(desktop, 'electron/browser-safety.ts'), 'browser-safety');
{
  const k = (f) => safety.classifySensitiveField(f)?.kind ?? null;
  ok(k({ type: 'password', name: 'pw' }) === 'password', 'browser/safety: type=password is a password');
  ok(k({ type: 'text', autocomplete: 'current-password' }) === 'password', 'browser/safety: autocomplete current-password (a show-password text field) is a password');
  ok(k({ type: 'text', autocomplete: 'cc-number' }) === 'card' && k({ type: 'tel', name: 'cardNumber' }) === 'card' && k({ type: 'text', label: 'Credit card number' }) === 'card', 'browser/safety: card numbers by autocomplete, name and label');
  ok(k({ type: 'text', autocomplete: 'cc-exp' }) === 'card' && k({ type: 'text', label: 'Expiry date (MM/YY)', name: 'card_expiry' }) === 'card', 'browser/safety: card expiry');
  ok(k({ type: 'text', name: 'cvc' }) === 'cvv' && k({ type: 'text', label: 'Security code' }) === 'cvv' && k({ type: 'text', autocomplete: 'cc-csc' }) === 'cvv', 'browser/safety: CVV / CVC / security code');
  ok(k({ type: 'text', autocomplete: 'one-time-code' }) === 'otp' && k({ type: 'text', name: 'otp' }) === 'otp' && k({ type: 'text', label: 'Enter the verification code we sent' }) === 'otp' && k({ type: 'number', name: 'mfaCode' }) === 'otp', 'browser/safety: one-time codes');
  ok(k({ type: 'password', name: 'pin' }) === 'password' && k({ type: 'text', label: 'PIN' }) === 'password', 'browser/safety: a PIN is a password');
  ok(k({ type: 'text', name: 'pincode', label: 'Pin code' }) === null && k({ type: 'text', name: 'postal_code' }) === null, 'browser/safety: a postal PIN code is not a password');
  ok(k({ type: 'email', name: 'email', label: 'Email' }) === null && k({ type: 'text', name: 'username' }) === null && k({ type: 'search', name: 'q' }) === null && k({ type: 'text', name: 'custname', label: 'Customer name' }) === null, 'browser/safety: ordinary fields are fine');
  ok(k({ type: 'checkbox', name: 'remember_password' }) === null, 'browser/safety: a "remember password" checkbox is not a password field');
  ok(/browser_handoff/.test(safety.sensitiveRefusal('password', 'Password')), 'browser/safety: a refusal says to hand over');

  const base = { url: 'https://example.com/login', title: 'Sign in', frames: [], widgets: [], text: 'Welcome back' };
  const anchor = 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Le-wvkS&co=aHR0cHM6&hl=en&v=abc&size=normal&cb=x';
  ok(safety.detectHumanCheck({ ...base, frames: [{ src: anchor, title: 'reCAPTCHA', width: 304, height: 78, visible: true }] }).kind === 'reCAPTCHA', 'browser/safety: a visible reCAPTCHA checkbox is a human check');
  ok(!safety.detectHumanCheck({ ...base, frames: [{ src: anchor.replace('size=normal', 'size=invisible'), title: 'reCAPTCHA', width: 256, height: 60, visible: true }] }).detected, 'browser/safety: invisible reCAPTCHA (v3 / badge) is not flagged — it asks nothing of anyone');
  ok(!safety.detectHumanCheck({ ...base, widgets: ['.grecaptcha-badge'] }).detected, 'browser/safety: the reCAPTCHA badge alone is not flagged');
  ok(safety.detectHumanCheck({ ...base, frames: [{ src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x', width: 300, height: 65, visible: true }] }).kind === 'Cloudflare Turnstile', 'browser/safety: a Turnstile frame is a human check');
  ok(safety.detectHumanCheck({ ...base, frames: [{ src: 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=0', width: 303, height: 78, visible: true }] }).kind === 'hCaptcha', 'browser/safety: an hCaptcha checkbox is a human check');
  ok(!safety.detectHumanCheck({ ...base, frames: [{ src: anchor, width: 0, height: 0, visible: false }] }).detected, 'browser/safety: a hidden frame is not flagged');
  ok(safety.detectHumanCheck({ ...base, title: 'Just a moment...' }).detected, 'browser/safety: the Cloudflare interstitial title');
  ok(safety.detectHumanCheck({ ...base, text: 'Please verify you are human by completing the action below.' }).detected, 'browser/safety: "verify you are human" wording');
  ok(safety.detectHumanCheck({ ...base, url: 'https://www.google.com/sorry/index?continue=x' }).detected, 'browser/safety: Google\'s unusual-traffic page');
  ok(safety.detectHumanCheck({ ...base, widgets: ['.cf-turnstile'] }).kind === 'Cloudflare Turnstile', 'browser/safety: a visible widget element');
  ok(!safety.detectHumanCheck({ ...base, text: 'Our robots.txt policy. We are not robots. Sign in to continue.' }).detected, 'browser/safety: an ordinary page is not flagged');
  ok(/browser_handoff/.test(safety.humanCheckRefusal({ detected: true, kind: 'reCAPTCHA' })) && /never solves/.test(safety.humanCheckRefusal({ detected: true })), 'browser/safety: the refusal explains and hands over');

  ok(['setup.exe', 'Tool.MSI', 'run.ps1', 'x.AppImage', 'pkg.deb', 'a.dmg', 'app.apk', 'install.sh', 'go.bat'].every(safety.isExecutableName), 'browser/safety: executables need the user');
  ok(!['report.pdf', 'data.csv', 'a.tar.gz', 'photo.jpeg', 'notes.txt', 'exe.pdf'].some(safety.isExecutableName), 'browser/safety: documents and archives do not');
  const taken = new Set(['report.pdf', 'report (1).pdf', 'archive.tar.gz']);
  ok(safety.uniqueName('report.pdf', n => taken.has(n)) === 'report (2).pdf', 'browser/safety: unique download names never overwrite', safety.uniqueName('report.pdf', n => taken.has(n)));
  ok(safety.uniqueName('archive.tar.gz', n => taken.has(n)) === 'archive (1).tar.gz' && safety.uniqueName('new.txt', () => false) === 'new.txt', 'browser/safety: a double extension stays together');
  ok(safety.uniqueName('a/b:c?.txt', () => false) === 'a_b_c_.txt' && safety.uniqueName('...', () => false) === 'download', 'browser/safety: unsafe file-name characters are replaced');

  const before = { url: 'https://x.test/form', title: 'Form', alerts: [], invalid: [], modals: [] };
  ok(/navigated from https:\/\/x\.test\/form/.test(safety.describeChange(before, { ...before, url: 'https://x.test/done', title: 'Thanks' })), 'browser/safety: an action result reports the navigation');
  const inv = safety.describeChange(before, { ...before, invalid: [{ label: 'Email', message: 'Please include an "@"' }], alerts: ['Fix the errors below'] });
  ok(/validation errors: Email: Please include/.test(inv) && /message shown: "Fix the errors below"/.test(inv), 'browser/safety: validation errors and messages are reported', inv);
  ok(/JavaScript confirm dialog is open/.test(safety.describeChange(before, null, { jsDialog: { type: 'confirm', message: 'Delete?' } })), 'browser/safety: a JS dialog is reported');
  ok(/No visible change/.test(safety.describeChange(before, before)), 'browser/safety: no change is said plainly');
}

// ── Built-in browser: history, bookmarks, settings ──
const bstore = await load(path.join(desktop, 'electron/browser-store.ts'), 'browser-store');
{
  let h = [];
  h = bstore.recordVisit(h, { url: 'https://a.test/page#top', title: 'A' }, 1000);
  h = bstore.recordVisit(h, { url: 'https://a.test/page#bottom', title: '' }, 2000);
  h = bstore.recordVisit(h, { url: 'https://b.test/', title: 'B site' }, 3000);
  h = bstore.recordVisit(h, { url: 'about:blank' }, 4000);
  h = bstore.recordVisit(h, { url: 'data:text/html,hi' }, 4000);
  h = bstore.recordVisit(h, { url: 'aico://app/' }, 4000);
  ok(h.length === 2 && h[0].url === 'https://b.test/', 'browser/history: newest first; about:, data: and aico: are not history', h.map(e => e.url));
  const a = h.find(e => e.url === 'https://a.test/page');
  ok(a && a.visits === 2 && a.lastVisit === 2000 && a.title === 'A', 'browser/history: one entry per URL (fragment ignored) with visit count, last visit, and the title kept', a);
  h = bstore.touchVisit(h, 'https://b.test/', { title: 'B — home' });
  ok(h[0].title === 'B — home' && h[0].visits === 1, 'browser/history: a late title updates without counting a visit');
  let big = [];
  for (let i = 0; i < 60; i++) big = bstore.recordVisit(big, { url: `https://s.test/${i}` }, i, 50);
  ok(big.length === 50 && !big.some(e => e.url === 'https://s.test/0') && big[0].url === 'https://s.test/59', 'browser/history: capped, oldest dropped');
  const q = [
    { url: 'https://docs.python.org/3/library/json.html', title: 'json — JSON encoder', visits: 9, lastVisit: 5e9 },
    { url: 'https://example.com/python-json-tips', title: 'Tips', visits: 1, lastVisit: 5e9 },
    { url: 'https://news.test/', title: 'News', visits: 50, lastVisit: 5e9 },
  ];
  const r = bstore.searchHistory(q, 'python json', 10);
  ok(r.length === 2 && r[0].url.startsWith('https://docs.python.org'), 'browser/history: search needs every word; host and visits rank', r.map(x => x.url));
  ok(bstore.searchHistory(q, '', 2).length === 2, 'browser/history: limit applies');
  ok(bstore.clearHistory([{ url: 'x', lastVisit: 10 }, { url: 'y', lastVisit: 20 }], 15).length === 1 && bstore.clearHistory(q).length === 0, 'browser/history: clear since a time, or everything');
  ok(bstore.removeHistory(q, 'https://news.test/').length === 2, 'browser/history: remove one URL');

  // The bookmark tree has its own suite: scripts/test-browser-bookmarks.mjs (run by `npm test`).
  const up = bstore.upsertBookmark(bstore.emptyTree(), { url: 'https://a.test', title: 'A' }, 1);
  ok(bstore.flattenBookmarks(up.tree)[0].url === 'https://a.test', 'browser/bookmarks: the flat add still works (see test-browser-bookmarks.mjs)');
  const s = bstore.normaliseSettings({ blocking: { enabled: 'yes', allowOrigins: ['https://a.test', 5, 'https://a.test'] }, zoom: { 'https://a.test': 1.5, 'https://b.test': 1, 'https://c.test': 99 }, permissions: { 'https://a.test': { notifications: 'allow', camera: 'maybe' } } });
  ok(s.blocking.enabled === true && s.blocking.allowOrigins.length === 1, 'browser/settings: blocking defaults on; allow list cleaned');
  ok(Object.keys(s.zoom).join() === 'https://a.test' && s.permissions['https://a.test'].notifications === 'allow' && !('camera' in s.permissions['https://a.test']), 'browser/settings: zoom and permissions keep only valid values');
  ok(bstore.normaliseSettings(null).blocking.enabled === true, 'browser/settings: a missing file means blocking on');
}

// ── Built-in browser: extraction and insights ──
const bx = await load(path.join(desktop, 'electron/browser-extract.ts'), 'browser-extract');
{
  ok(bx.parseAmount('1,299.99') === 1299.99 && bx.parseAmount('1.299,99') === 1299.99 && bx.parseAmount('12,50') === 12.5 && bx.parseAmount('1.299') === 1299 && bx.parseAmount('2,500') === 2500 && bx.parseAmount('1 299') === 1299 && bx.parseAmount('45') === 45, 'browser/extract: amounts in either decimal convention');
  const p = bx.findPrices([
    { text: 'Now $1,299.99 (was $1,499.00)', context: 'Laptop Pro 14' },
    { text: '€ 12,50 per month' }, { text: 'Rs. 2,500' }, { text: 'Total: 1.299 €' }, { text: 'USD 45' }, { text: 'Chapter 12 of 300' },
  ], [{ amount: '19.99', currency: 'GBP', context: 'Mug', source: 'json-ld' }]);
  const has = (cur, amt) => p.some(x => x.currency === cur && Math.abs(x.amount - amt) < 1e-9);
  ok(has('USD', 1299.99) && has('USD', 1499) && has('EUR', 12.5) && has('PKR', 2500) && has('EUR', 1299) && has('USD', 45) && has('GBP', 19.99), 'browser/extract: prices with currencies from symbols, codes and structured data', p.map(x => `${x.currency} ${x.amount}`));
  ok(p.length === 7 && p.find(x => x.amount === 1299.99).context === 'Laptop Pro 14', 'browser/extract: plain numbers are not prices; the product is the context', p.length);
  const c = bx.findContacts('Write to Sales@Example.com or call +44 20 7946 0958. Office hours 2026-09-29. Order 123456789012. logo@2x.png', [{ href: 'mailto:help@example.com?subject=Hi', text: 'Email us' }, { href: 'tel:+1-555-010-9999', text: 'Call' }]);
  ok(c.emails.includes('sales@example.com') && c.emails.includes('help@example.com') && !c.emails.some(e => e.endsWith('.png')), 'browser/extract: emails from text and mailto links', c.emails);
  ok(c.phones.includes('+442079460958') && c.phones.includes('+15550109999') && !c.phones.some(x => x.includes('2026')) && !c.phones.includes('123456789012'), 'browser/extract: phone numbers, not dates or bare ids', c.phones);
  ok(bx.tableToMarkdown({ caption: 'Scores', rows: [['Team', 'Pts'], ['A|B', '3'], ['C']] }) === '**Scores**\n\n| Team | Pts |\n| --- | --- |\n| A\\|B | 3 |\n| C |  |', 'browser/extract: tables as Markdown (pipes escaped, ragged rows padded)', bx.tableToMarkdown({ caption: 'Scores', rows: [['Team', 'Pts'], ['A|B', '3'], ['C']] }));
  const forms = bx.finishForms([{ index: 0, action: 'x', method: 'post', submit: [], fields: [
    { ref: 'e1', label: 'Email', name: 'email', type: 'email', required: true, value: 'a@b.c', raw: { type: 'email', name: 'email', label: 'Email' } },
    { ref: 'e2', label: 'Password', name: 'pw', type: 'password', required: true, value: '(filled)', raw: { type: 'password', name: 'pw' } },
    { ref: 'e3', label: 'Card number', name: 'cc', type: 'text', required: false, value: '4111 1111 1111 1111', raw: { type: 'text', name: 'cc', label: 'Card number', autocomplete: 'cc-number' } },
  ] }]);
  ok(!('raw' in forms[0].fields[0]) && forms[0].fields[0].value === 'a@b.c' && !forms[0].fields[0].sensitive, 'browser/forms: ordinary fields pass through');
  ok(forms[0].fields[1].sensitive === 'password' && forms[0].fields[2].sensitive === 'card' && forms[0].fields[2].value === '(filled)', 'browser/forms: sensitive fields are marked and their values never leave the page');
  ok(bx.matchField(forms, { label: 'email' })?.ref === 'e1' && bx.matchField(forms, { name: 'pw' })?.ref === 'e2' && bx.matchField(forms, { ref: 'e3' })?.ref === 'e3' && bx.matchField(forms, { label: 'nope' }) === null, 'browser/forms: fields are found by label, name or ref');
  const snap = bx.formatSnapshot({ title: 'Login', url: 'https://x.test', scroll: { y: 0, height: 900, viewport: 800 }, headings: [], total: 2, crossOriginFrames: [{ src: 'https://pay.test/frame', title: 'Payment' }], dialogs: [], text: 'hi', truncated: false,
    elements: [{ ref: 'e1', role: 'textbox', name: 'Email', value: 'me@x.test', field: { type: 'email' } }, { ref: 'e2', role: 'password', name: 'Password', value: 'secret', field: { type: 'password' } }] });
  ok(/\[e2\] password \[password — user only\] "Password" \(filled\)/.test(snap) && !snap.includes('secret') && /value="me@x\.test"/.test(snap), 'browser/snapshot: sensitive fields are marked "user only" and their values hidden', snap);
  ok(/Cross-origin frames .*Payment/.test(snap), 'browser/snapshot: cross-origin frames are reported');
  const sig = { url: 'https://news.test/2026/story', title: 'Big story', contentType: 'text/html', words: 1400, textStart: 'Big story. By A. Writer...', counts: { forms: 1, passwords: 0, inputs: 1, search: 1, links: 80, images: 5, videos: 0, tables: 0, articles: 1 }, h1: ['Big story'], ogType: 'article', jsonLdTypes: ['NewsArticle'], isAccessibleForFree: null, cartButton: '', cookieBanner: true, paywallElement: false, buttons: [{ label: 'Subscribe', area: 4000, top: 10, cls: 'btn-primary', tag: 'a' }], human: { url: 'https://news.test/2026/story', title: 'Big story', frames: [], widgets: [], text: '' } };
  const ins = bx.buildInsights(sig, { security: 'secure', trackersBlocked: 12 });
  ok(ins.kind === 'article' && ins.cookieBanner && !ins.humanCheck && ins.mainAction === 'Subscribe' && ins.trackersBlocked === 12, 'browser/insights: an article with a cookie banner and its main action', ins);
  ok(ins.summaryHints.some(h => /Reject/.test(h)) && ins.summaryHints.some(h => /12 tracker/.test(h)), 'browser/insights: hints say what to do');
  const pay = bx.buildInsights({ ...sig, textStart: 'Subscribe to continue reading. Already a subscriber? Sign in', isAccessibleForFree: false }, { security: 'secure', trackersBlocked: 0 });
  ok(pay.paywall, 'browser/insights: a paywall');
  const login = bx.buildInsights({ ...sig, url: 'https://x.test/login', words: 40, ogType: '', jsonLdTypes: [], counts: { ...sig.counts, passwords: 1, inputs: 2, articles: 0 }, textStart: 'Sign in to continue', cookieBanner: false }, { security: 'secure', trackersBlocked: 0 });
  ok(login.kind === 'login' && login.loginWall && login.summaryHints.some(h => /never type a password/.test(h)), 'browser/insights: a login page', login);
  const cap = bx.buildInsights({ ...sig, human: { url: 'https://x.test', title: 'Just a moment...', frames: [], widgets: [], text: '' } }, { security: 'secure', trackersBlocked: 0 });
  ok(cap.humanCheck && cap.kind === 'challenge' && /browser_handoff/.test(cap.summaryHints[0]), 'browser/insights: a human check leads the hints');
}

// ── Built-in browser: the in-page script, against real HTML (parsed by parse5) ──
{
  let parse5 = null;
  try { parse5 = await import('parse5'); } catch { /* optional: skipped where the engine's dependencies are not installed */ }
  const bpage = await load(path.join(desktop, 'electron/browser-page.ts'), 'browser-page');
  const src = bpage.aicoPage.toString();
  ok(!/\brequire\(|\bimport\(/.test(src) && src.startsWith('function aicoPage'), 'browser/page: the page script is self-contained (serialised with toString)');
  if (!parse5) {
    console.log('  skip  browser/page: parse5 not installed — DOM fixture tests skipped');
  } else {
    const dom = makeFakeDom(parse5);
    const article = `<!doctype html><html lang="en"><head><title>Story — Site</title><meta name="author" content="Ada Writer"><meta property="og:title" content="The Story"></head><body>
      <nav class="site-nav"><a href="/">Home</a> <a href="/news">News</a> <a href="/sport">Sport</a></nav>
      <header class="masthead"><a href="/">Site</a></header>
      <article class="post-content"><h1>The Story</h1><p>This is the <strong>first</strong> paragraph, with a <a href="/more">link to more</a>, and some commas, lots, of, them.</p>
      <h2>Details</h2><p>Second paragraph with <em>emphasis</em> and <code>code()</code>. It goes on long enough to be the main content of this page, clearly, for sure.</p>
      <ul><li>One</li><li>Two<ul><li>Two point one</li></ul></li></ul>
      <table><tr><th>Name</th><th>Score</th></tr><tr><td>Ann</td><td>9</td></tr><tr><td>Bo|b</td><td>7</td></tr></table>
      <pre><code class="language-js">const x = 1;\nconsole.log(x);</code></pre>
      <img src="/img/a.png" alt="A chart" width="400" height="300"><img src="/pixel.gif" width="1" height="1">
      <div class="share-tools"><a href="https://twitter.com/share">Tweet</a> <a href="https://facebook.com/share">Share</a></div>
      <p style="display:none">Hidden text should not appear.</p>
      </article>
      <aside class="sidebar"><h3>Related</h3><a href="/r1">Related one</a></aside>
      <footer><p>Copyright</p></footer></body></html>`;
    const env = dom(article, 'https://site.test/news/story');
    const r = bpage.aicoPage('read', { mode: 'reader' }, env);
    const md = r.markdown;
    ok(md.startsWith('# The Story') && /\n## Details\n/.test(md), 'browser/read: title and headings become Markdown headings', md.slice(0, 200));
    ok(/\*\*first\*\*/.test(md) && /_emphasis_/.test(md) && /`code\(\)`/.test(md) && /\[link to more\]\(https:\/\/site\.test\/more\)/.test(md), 'browser/read: bold, emphasis, code and absolute links');
    ok(/- One\n- Two\n {2}- Two point one/.test(md), 'browser/read: nested lists', md);
    ok(/\| Name \| Score \|\n\| --- \| --- \|\n\| Ann \| 9 \|\n\| Bo\\\|b \| 7 \|/.test(md), 'browser/read: tables as Markdown tables', md);
    ok(/```js\nconst x = 1;\nconsole\.log\(x\);\n```/.test(md), 'browser/read: code blocks keep their language and lines');
    ok(/!\[A chart\]\(https:\/\/site\.test\/img\/a\.png\)/.test(md) && !md.includes('pixel.gif'), 'browser/read: images kept, tracking pixels dropped');
    ok(!/Home|Related one|Copyright|Tweet|Hidden text/.test(md), 'browser/read: reader mode drops navigation, sidebars, footers, share bars and hidden text', md);
    ok(r.byline === 'Ada Writer' && r.words > 40 && r.headings.length === 2 && r.links.some(l => l.href === 'https://site.test/more'), 'browser/read: byline, word count, headings and links', { byline: r.byline, words: r.words, headings: r.headings });
    const full = bpage.aicoPage('read', { mode: 'full' }, dom(article, 'https://site.test/news/story'));
    ok(/Related one/.test(full.markdown) && /Copyright/.test(full.markdown) && !/Hidden text/.test(full.markdown), 'browser/read: full mode keeps the whole page (still not hidden text)');
    const cut = bpage.aicoPage('read', { mode: 'full', maxChars: 500 }, dom(article, 'https://site.test/news/story'));
    ok(cut.truncated && cut.markdown.length < 700, 'browser/read: maxChars cuts long pages');

    const form = `<html><head><title>Order</title></head><body><form action="/post" method="post">
      <p><label>Customer name: <input name="custname" required></label></p>
      <p><label for="tel">Telephone</label><input id="tel" type="tel" name="custtel"></p>
      <input type="email" name="custemail" placeholder="you@example.com">
      <input type="password" name="pw" autocomplete="current-password" value="hunter2">
      <fieldset><legend>Pizza Size</legend><label><input type="radio" name="size" value="small"> Small</label><label><input type="radio" name="size" value="large" checked> Large</label></fieldset>
      <select name="topping"><option value="">Choose</option><option value="ham">Ham</option><option value="cheese" selected>Cheese</option></select>
      <label><input type="checkbox" name="bacon" value="bacon"> Bacon</label>
      <textarea name="comments">Ring twice</textarea>
      <input type="hidden" name="csrf" value="x">
      <button>Submit order</button></form>
      <input name="loose" aria-label="Newsletter email"></body></html>`;
    const fm = bx.finishForms(bpage.aicoPage('forms', {}, dom(form, 'https://shop.test/order')));
    const f0 = fm[0];
    const byName = (n) => f0.fields.find(f => f.name === n);
    ok(fm.length === 2 && f0.method === 'post' && f0.action === 'https://shop.test/post' && f0.submit[0]?.label === 'Submit order', 'browser/forms: action, method and submit button; loose fields are their own group', fm.map(f => f.action));
    ok(byName('custname').label === 'Customer name:' && byName('custname').required && byName('custtel').label === 'Telephone' && byName('custemail').label === 'you@example.com', 'browser/forms: labels from wrapping label, label[for] and placeholder', f0.fields.map(f => f.label));
    ok(byName('pw').sensitive === 'password' && byName('pw').value === '(filled)', 'browser/forms: the password is marked and its value is never read out');
    const size = byName('size');
    ok(size.type === 'radio-group' && size.label === 'Pizza Size' && size.options.length === 2 && size.value === 'large' && size.options.every(o => /^e\d+$/.test(o.ref)), 'browser/forms: radios become one group with labelled options and refs', size);
    ok(byName('topping').value === 'cheese' && byName('topping').options.length === 3 && byName('bacon').checked === false && byName('comments').value === 'Ring twice' && !byName('csrf'), 'browser/forms: select, checkbox, textarea; hidden inputs skipped');
    ok(fm[1].fields[0].label === 'Newsletter email', 'browser/forms: aria-label');

    const cap = `<html><head><title>reCAPTCHA demo</title></head><body><form><div class="g-recaptcha" data-sitekey="6Le"><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?k=6Le&size=normal" width="304" height="78"></iframe></div><input type="submit"></form></body></html>`;
    const sigs = bpage.aicoPage('humanCheck', { humanSelectors: safety.HUMAN_CHECK_SELECTORS }, dom(cap, 'https://www.google.com/recaptcha/api2/demo'));
    ok(safety.detectHumanCheck(sigs).detected && sigs.frames.length === 1, 'browser/page: the reCAPTCHA demo page is detected from the page\'s own signals', sigs);
    const plain = bpage.aicoPage('humanCheck', { humanSelectors: safety.HUMAN_CHECK_SELECTORS }, dom(article, 'https://site.test/news/story'));
    ok(!safety.detectHumanCheck(plain).detected, 'browser/page: an ordinary article is not a human check');

    const outline = bpage.aicoPage('extract', { kind: 'outline' }, dom(article, 'https://site.test/'));
    ok(outline.outline.map(h => `${h.level}:${h.text}`).join('|') === '1:The Story|2:Details|3:Related', 'browser/extract: the heading outline', outline.outline);
    const tables = bpage.aicoPage('extract', { kind: 'tables' }, dom(article, 'https://site.test/'));
    ok(tables.tables.length === 1 && tables.tables[0].rows[2][0] === 'Bo|b', 'browser/extract: data tables as rows');
    const meta = bpage.aicoPage('extract', { kind: 'metadata' }, dom(article.replace('</head>', '<link rel="canonical" href="/news/story"><script type="application/ld+json">{"@type":"NewsArticle","headline":"The Story"}</script></head>'), 'https://site.test/news/story?utm=1'));
    ok(meta.lang === 'en' && meta.canonical === 'https://site.test/news/story' && meta.openGraph.title === 'The Story' && meta.jsonLd[0]['@type'] === 'NewsArticle' && meta.meta.author === 'Ada Writer', 'browser/extract: metadata, OpenGraph and JSON-LD', meta);
    const found = bpage.aicoPage('find', { text: 'second paragraph' }, dom(article, 'https://site.test/'));
    ok(found.count === 1 && /^e\d+$/.test(found.matches[0].ref) && /Second paragraph with/.test(found.matches[0].context), 'browser/find: matches with a ref and context', found);
    const sn = bpage.aicoPage('snapshot', {}, dom(form, 'https://shop.test/order'));
    ok(sn.elements.some(e => e.role === 'password' && e.value === '(filled)') && !JSON.stringify(sn).includes('hunter2') && sn.elements.some(e => e.name === 'Submit order'), 'browser/snapshot: the page script never reports a password value');
    const same = dom(form, 'https://shop.test/order');
    const fRefs = bpage.aicoPage('forms', {}, same)[0].fields.find(f => f.name === 'custemail').ref;
    const sRefs = bpage.aicoPage('snapshot', {}, same).elements.find(e => e.name === 'you@example.com')?.ref;
    const again = bpage.aicoPage('snapshot', {}, same).elements.find(e => e.name === 'you@example.com')?.ref;
    ok(fRefs === sRefs && sRefs === again, 'browser/snapshot: refs stay stable across browser_forms and repeated snapshots of one page', [fRefs, sRefs, again]);
  }
}

// ── The agent's manual and tools ──
const mcpMod = await load(path.join(desktop, 'electron/mcp.ts'), 'mcp');
{
  const stubCtx = { paths: { pluginsDir: 'C:\\Users\\Someone With A Long Name\\.aico\\desktop\\plugins', desktopDir: os.tmpdir() }, prefs: { get: () => ({ plugins: {} }) }, services: {} };
  const m = mcpMod.manual(stubCtx);
  ok(m.length < 5600, 'mcp: the manual fits the engine\'s 6000-character instruction cap with room for plugin instructions', m.length);
  ok(/never solve, bypass or work around a CAPTCHA/.test(m) && m.indexOf('BROWSER RULES') < 3000, 'mcp: the browser rules are in the manual, early (never cut)');
  const names = mcpMod.createTools(stubCtx).map(t => t.name);
  const want = ['browser_read', 'browser_forms', 'browser_fill', 'browser_extract', 'browser_insights', 'browser_dialog', 'browser_find', 'browser_scroll_to', 'browser_select_tab', 'browser_new_tab', 'browser_close_tab', 'browser_downloads', 'browser_upload', 'browser_upload_wait', 'browser_wait', 'browser_screenshot', 'browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_handoff', 'browser_handoff_wait', 'browser_tabs', 'browser_navigate', 'browser_evaluate', 'browser_console', 'browser_network', 'browser_text', 'browser_select', 'browser_press', 'browser_hover', 'browser_scroll'];
  ok(want.every(n => names.includes(n)), 'mcp: every browser tool is offered (old and new)', want.filter(n => !names.includes(n)));
  ok(new Set(names).size === names.length, 'mcp: tool names are unique');
}

// ── Built-in browser: shortcuts pressed inside a page ──
const bkeysMain = await load(path.join(desktop, 'electron/browser-keys.ts'), 'browser-keys-main');
{
  const k = (key, m = {}) => bkeysMain.browserShortcutSpec({ type: 'keyDown', key, control: false, meta: false, shift: false, alt: false, ...m }, false);
  ok(k('f', { control: true }) === 'Ctrl+f' && k('T', { control: true }) === 'Ctrl+t' && k('Tab', { control: true, shift: true }) === 'Ctrl+Shift+Tab', 'browser/keys: browser shortcuts are forwarded from the page');
  ok(k('ArrowLeft', { alt: true }) === 'Alt+ArrowLeft' && k('F5') === 'F5', 'browser/keys: Alt+← and F5');
  ok(k('a', { control: true }) === null && k('c', { control: true }) === null && k('v', { control: true }) === null && k('Escape') === null && k('x') === null, 'browser/keys: copy, paste, select-all, Escape and typing stay with the page');
  ok(bkeysMain.browserShortcutSpec({ type: 'keyDown', key: 'f', control: false, meta: true, shift: false, alt: false }, true) === 'Ctrl+f', 'browser/keys: Cmd on macOS is forwarded as Ctrl (the interface reads it platform-neutrally)');
  ok(bkeysMain.browserShortcutSpec({ type: 'keyUp', key: 'f', control: true, meta: false, shift: false, alt: false }, false) === null, 'browser/keys: only key-down');
}

/** A small DOM over parse5's tree — enough of the DOM API for the page script's walkers and selectors. */
function makeFakeDom(p5) {
  const splitTop = (s, ch) => { const out = []; let depth = 0; let cur = ''; let q = null; for (const c of s) { if (q) { if (c === q) q = null; cur += c; continue; } if (c === '"' || c === '\'') { q = c; cur += c; continue; } if (c === '(' || c === '[') depth++; if (c === ')' || c === ']') depth--; if (c === ch && depth === 0) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out.map(x => x.trim()).filter(Boolean); };
  const compound = (el, sel) => {
    let s = sel;
    const m = /^([a-zA-Z][\w-]*|\*)?/.exec(s);
    if (m[1] && m[1] !== '*' && el.tagName !== m[1].toUpperCase()) return false;
    s = s.slice(m[0].length);
    while (s) {
      let mm;
      if ((mm = /^#([\w-]+)/.exec(s))) { if (el.getAttribute('id') !== mm[1]) return false; }
      else if ((mm = /^\.([\w-]+)/.exec(s))) { if (!(el.getAttribute('class') || '').split(/\s+/).includes(mm[1])) return false; }
      else if ((mm = /^\[([\w-]+)(?:([*^$|~]?=)["']?([^\]"']*)["']?)?\]/.exec(s))) {
        const v = el.getAttribute(mm[1]);
        if (v === null) return false;
        const want = mm[3];
        if (mm[2] === '=' && v !== want) return false;
        if (mm[2] === '*=' && !v.includes(want)) return false;
        if (mm[2] === '^=' && !v.startsWith(want)) return false;
      } else if ((mm = /^:not\((.*?)\)(?![^(]*\))/.exec(s))) { if (compound(el, mm[1])) return false; }
      else if ((mm = /^:[\w-]+(\([^)]*\))?/.exec(s))) { return false; }
      else return false;
      s = s.slice(mm[0].length);
    }
    return true;
  };
  const matchOne = (el, sel) => {
    const parts = sel.split(/\s+/).filter(Boolean);
    if (!compound(el, parts[parts.length - 1])) return false;
    let node = el.parentNode; let i = parts.length - 2;
    while (i >= 0 && node && node.nodeType === 1) { if (compound(node, parts[i])) i--; node = node.parentNode; }
    return i < 0;
  };
  class Node {
    constructor(raw, doc, parent) {
      this.raw = raw; this.ownerDocument = doc; this.parentNode = parent;
      const n = raw.nodeName;
      this.nodeType = n === '#text' ? 3 : n === '#comment' ? 8 : n === '#document' ? 9 : n === '#documentType' ? 10 : 1;
      this.nodeValue = this.nodeType === 3 ? raw.value : null;
      if (this.nodeType === 1) this.tagName = raw.tagName.toUpperCase();
      this.childNodes = [];
    }
    get children() { return this.childNodes.filter(c => c.nodeType === 1); }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get previousElementSibling() { const sib = this.parentNode ? this.parentNode.children : []; const i = sib.indexOf(this); return i > 0 ? sib[i - 1] : null; }
    get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(c => (c.nodeType === 8 ? '' : c.textContent)).join(''); }
    get id() { return this.getAttribute('id') || ''; }
    get className() { return this.getAttribute('class') || ''; }
    getAttribute(name) { const a = (this.raw.attrs || []).find(x => x.name === name.toLowerCase()); return a ? a.value : null; }
    hasAttribute(name) { return this.getAttribute(name) !== null; }
    setAttribute(name, value) { const a = (this.raw.attrs || []).find(x => x.name === name); if (a) a.value = String(value); else (this.raw.attrs ||= []).push({ name, value: String(value) }); }
    removeAttribute(name) { this.raw.attrs = (this.raw.attrs || []).filter(x => x.name !== name); }
    matches(sel) { return splitTop(sel, ',').some(s => matchOne(this, s)); }
    closest(sel) { let n = this; while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentNode; } return null; }
    contains(o) { let n = o; while (n) { if (n === this) return true; n = n.parentNode; } return false; }
    querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    get value() {
      if (this.tagName === 'TEXTAREA') return this.textContent;
      if (this.tagName === 'SELECT') { const o = this.options.find(x => x.selected) || this.options[0]; return o ? o.value : ''; }
      if (this.tagName === 'OPTION') return this.getAttribute('value') ?? this.textContent.trim();
      const v = this.getAttribute('value'); return v === null ? (this.tagName === 'INPUT' ? '' : undefined) : v;
    }
    get options() { return this.tagName === 'SELECT' ? this.querySelectorAll('option') : undefined; }
    get selectedIndex() { return this.options ? this.options.findIndex(o => o.selected) : -1; }
    get selected() { return this.hasAttribute('selected'); }
    get text() { return this.textContent.trim(); }
    get checked() { return this.hasAttribute('checked'); }
    get required() { return this.hasAttribute('required'); }
    get disabled() { return this.hasAttribute('disabled'); }
    get multiple() { return this.hasAttribute('multiple'); }
  }
  return (html, url) => {
    const raw = p5.parse(html);
    const doc = new Node(raw, null, null);
    const build = (r, parent) => { const n = new Node(r, doc, parent); n.childNodes = (r.childNodes || []).map(c => build(c, n)); if (r.content) n.childNodes = []; return n; };
    doc.childNodes = raw.childNodes.map(c => build(c, doc));
    doc.documentElement = doc.childNodes.find(c => c.nodeType === 1);
    doc.body = doc.documentElement.querySelector('body');
    doc.head = doc.documentElement.querySelector('head');
    const t = doc.documentElement.querySelector('title');
    doc.title = t ? t.textContent.trim() : '';
    doc.contentType = 'text/html';
    doc.URL = url; doc.baseURI = url; doc.location = { href: url };
    doc.activeElement = doc.body;
    return { document: doc, window: {} };
  };
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`\n  DESKTOP UNIT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
