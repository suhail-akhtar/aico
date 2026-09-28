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

fs.rmSync(out, { recursive: true, force: true });
console.log(`\n  DESKTOP UNIT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
