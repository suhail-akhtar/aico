/**
 * Unit tests for the Code map's pure logic (web/src/components/codegraph):
 * the view model (filters, impact layers, directed paths, search, the
 * architecture aggregation, Mermaid, arrow-key navigation), the layout
 * (deterministic seeding, Barnes-Hut stays bounded and separates, speed on
 * 5,000 nodes), the scene each mode builds (what is emphasised, what is
 * dimmed), and SVG export.
 *
 * Bundles its own subjects with esbuild, so it runs on its own:
 *   node web/test-codegraph.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-codegraph-unit-'));
async function load(name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({ entryPoints: [path.join(here, 'src', 'components', 'codegraph', `${name}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}
const M = await load('model');
const L = await load('layout');
const S = await load('scene');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); } catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`); }
}

// A small project: app → feature → util; a barrel pass-through; a test; a vendor file; a cycle.
const file = (path, extra = {}) => ({ path, lang: path.endsWith('.py') ? 'py' : 'ts', loc: 40, size: 800, fanIn: 0, fanOut: 0, churn: 0, hotspot: 0, community: 0, exports: 1, ...extra });
const payload = {
  version: 'v1', root: '/p', builtAt: 0,
  files: [
    file('src/app/page.tsx', { community: 0, entry: 'page' }), // 0
    file('src/features/a.ts', { community: 0 }), // 1
    file('src/lib/util.ts', { community: 1, fanIn: 3, hotspot: 1, churn: 9 }), // 2
    file('src/lib/index.ts', { community: 1 }), // 3
    file('test/util.test.ts', { community: 1, test: 1 }), // 4
    file('vendor/lodash.js', { community: 2 }), // 5
    file('src/cyc/x.ts', { community: 3 }), // 6
    file('src/cyc/y.ts', { community: 3 }), // 7
    file('tools/gen.py', { community: 2 }), // 8
  ],
  edges: [
    [0, 1, 0, 1, 0, 0],
    [1, 2, 0, 1, 0, 0],
    [1, 3, 0, 0, 1, 0], // pass-through to the barrel
    [3, 2, 1, 0, 0, 0],
    [4, 2, 0, 1, 0, 0],
    [6, 7, 0, 1, 0, 0],
    [7, 6, 0, 1, 0, 0],
  ],
  communities: [{ id: 0, label: 'src/app', files: [0, 1] }, { id: 1, label: 'src/lib', files: [2, 3, 4] }, { id: 2, label: 'vendor', files: [5, 8] }, { id: 3, label: 'src/cyc', files: [6, 7] }],
  cochange: [[2, 8, 4, 1]],
  cycles: [[6, 7]], orphans: [5], violations: [], external: [['react', 2]],
  git: { available: true, commits: 10, skippedLarge: 0 },
  stats: { indexed: 9, parsed: 9, skipped: 0, truncated: false, buildMs: 1, resolveMs: 1 },
};

test('adjacency skips barrel pass-through imports', () => {
  const m = new M.GraphModel(payload);
  assert.deepEqual(m.out[1].sort(), [2]);
  assert.deepEqual(m.inn[2].sort((a, b) => a - b), [1, 3, 4]);
});

test('filters: tests, vendor, languages, folder', () => {
  const m = new M.GraphModel(payload);
  const on = (f) => [...m.visible({ ...M.DEFAULT_FILTERS, ...f })].map((v, i) => (v ? i : -1)).filter(i => i >= 0);
  assert.ok(!on({}).includes(5), 'vendor hidden by default');
  assert.ok(on({ hideVendor: false }).includes(5));
  assert.ok(!on({ hideTests: true }).includes(4));
  assert.deepEqual(on({ langs: ['py'], hideVendor: false }), [8]);
  assert.deepEqual(on({ folder: 'src/lib/' }), [2, 3]);
});

test('impact: dependents by distance, the subject at 0', () => {
  const m = new M.GraphModel(payload);
  const d = m.impact([2], 3);
  assert.equal(d.get(2), 0);
  assert.equal(d.get(1), 1);
  assert.equal(d.get(4), 1);
  assert.equal(d.get(3), 1);
  assert.equal(d.get(0), 2);
  assert.ok(!d.has(5));
  const sym = m.impact([2], 2, [4]);
  assert.deepEqual([...sym.keys()].sort(), [2, 4], 'a symbol impact starts from its users only');
});

test('path: directed only, shortest', () => {
  const m = new M.GraphModel(payload);
  assert.deepEqual(m.path(0, 2), [0, 1, 2]);
  assert.equal(m.path(2, 0), undefined, 'never against the dependency direction');
  assert.deepEqual(m.path(6, 7), [6, 7]);
});

test('search: basename first, then path, then subsequence', () => {
  const m = new M.GraphModel(payload);
  assert.equal(m.search('util')[0], 2);
  assert.ok(m.search('lib/index').includes(3));
  assert.ok(m.search('srcfa').includes(1), 'subsequence');
  assert.deepEqual(m.search(''), []);
});

test('architecture aggregates dependencies between modules; Mermaid names them', () => {
  const m = new M.GraphModel(payload);
  const a = m.architecture();
  assert.equal(a.groups.length, 4);
  const link = a.links.find(l => l.a === 0 && l.b === 1);
  assert.equal(link?.weight, 1);
  assert.ok(!a.links.some(l => l.a === l.b), 'no self links');
  const mer = m.mermaid();
  assert.match(mer, /^flowchart LR/);
  assert.match(mer, /c0 -->\|1\| c1/);
});

test('arrow-key navigation follows edges in the direction pressed', () => {
  const m = new M.GraphModel(payload);
  const pos = new Float32Array(payload.files.length * 2);
  pos.set([0, 0, 100, 0, 200, 0, 200, 100, 300, 0, 500, 500, 0, 300, 50, 300, 600, 600]);
  assert.equal(m.neighbourInDirection(1, 1, 0, pos), 2, 'right of a.ts is util.ts');
  assert.equal(m.neighbourInDirection(1, -1, 0, pos), 0, 'left of a.ts is page.tsx');
});

test('layout: deterministic seeding, modules kept apart', () => {
  const groups = Int32Array.from([0, 0, 0, 0, 1, 1, 1, 1]);
  const input = { n: 8, edges: Int32Array.from([0, 1, 1, 2, 4, 5]), groups };
  const a = L.initialPositions(input).pos;
  const b = L.initialPositions(input).pos;
  assert.deepEqual([...a], [...b]);
  const ca = L.initialPositions(input).centers;
  assert.ok(Math.hypot(ca.get(0)[0] - ca.get(1)[0], ca.get(0)[1] - ca.get(1)[1]) > 20);
});

test('layout: Barnes-Hut separates coincident nodes and stays finite', () => {
  const n = 50;
  const layout = new L.ForceLayout({ n, edges: new Int32Array(), groups: new Int32Array(n) }, new Float32Array(n * 2));
  layout.run(120);
  const ok = [...layout.pos].every(Number.isFinite);
  assert.ok(ok, 'no NaN/Infinity');
  const b = L.bounds(layout.pos, n);
  assert.ok(b.maxX - b.minX > 5, 'they spread out');
  assert.ok(b.maxX - b.minX < 5000, 'and stay near the map (distance cap)');
});

test('layout: 5,000 nodes tick fast enough for a worker', () => {
  const n = 5000;
  const groups = Int32Array.from({ length: n }, (_, i) => i % 40);
  const edges = Int32Array.from({ length: n * 4 }, (_, i) => (i % 2 === 0 ? (i / 2) % n : ((i * 7919) % n)));
  const layout = new L.ForceLayout({ n, edges, groups });
  const t = performance.now();
  for (let k = 0; k < 10; k++) layout.tick();
  const per = (performance.now() - t) / 10;
  console.log(`        5,000 nodes / 10,000 edges: ${per.toFixed(1)} ms per tick`);
  assert.ok(per < 120, `a tick takes ${per.toFixed(1)} ms`);
});

const sceneInput = (m, extra) => ({
  model: m, pos: L.initialPositions({ n: m.n, edges: new Int32Array(), groups: Int32Array.from(payload.files.map(f => f.community)) }).pos,
  mask: m.visible({ ...M.DEFAULT_FILTERS, hideVendor: false }), mode: 'files', colorBy: 'module', selected: -1, expanded: new Set(),
  inCycle: new Set([6, 7]), accent: '#00f', danger: '#f00', warning: '#fa0', muted: '#888', ...extra,
});

test('scene: files mode emphasises a selection and its neighbours, dims the rest', () => {
  const m = new M.GraphModel(payload);
  const s = S.buildScene(sceneInput(m, { selected: 1 }));
  const emph = (id) => s.nodes[s.fileIndex.get(id)].emph;
  assert.equal(emph(1), 2);
  assert.equal(emph(0), 2);
  assert.equal(emph(2), 2);
  assert.equal(emph(6), 0);
  assert.ok(!s.edges.some(e => s.nodes[e.a].ref === 1 && s.nodes[e.b].ref === 3), 'pass-through edges are not drawn');
});

test('scene: impact colours by depth and lights only the chain', () => {
  const m = new M.GraphModel(payload);
  const depths = m.impact([2], 2);
  const s = S.buildScene(sceneInput(m, { mode: 'impact', selected: 2, depths }));
  const node = (id) => s.nodes[s.fileIndex.get(id)];
  assert.equal(node(1).emph, 2);
  assert.equal(node(6).emph, 0);
  const lit = s.edges.filter(e => e.emph === 2).map(e => `${s.nodes[e.a].ref}>${s.nodes[e.b].ref}`).sort();
  assert.deepEqual(lit, ['0>1', '1>2', '3>2', '4>2']);
});

test('scene: path and cycles light exactly their edges', () => {
  const m = new M.GraphModel(payload);
  const p = S.buildScene(sceneInput(m, { mode: 'path', path: [0, 1, 2] }));
  assert.deepEqual(p.edges.filter(e => e.emph === 2).map(e => `${p.nodes[e.a].ref}>${p.nodes[e.b].ref}`).sort(), ['0>1', '1>2']);
  const c = S.buildScene(sceneInput(m, { mode: 'cycles', cycle: [6, 7] }));
  assert.deepEqual(c.edges.filter(e => e.emph === 2).map(e => `${c.nodes[e.a].ref}>${c.nodes[e.b].ref}`).sort(), ['6>7', '7>6']);
});

test('scene: co-change draws dashed links, warning colour when no import links the pair', () => {
  const m = new M.GraphModel(payload);
  const s = S.buildScene(sceneInput(m, { mode: 'cochange' }));
  const co = s.edges.find(e => e.dashed && s.nodes[e.a].ref === 2 && s.nodes[e.b].ref === 8);
  assert.ok(co && co.color === '#fa0' && co.emph === 2);
});

test('scene: architecture collapses modules, opens one on request', () => {
  const m = new M.GraphModel(payload);
  const closed = S.buildScene(sceneInput(m, { mode: 'architecture' }));
  assert.equal(closed.nodes.filter(n => n.kind === 'group').length, 4);
  assert.ok(closed.edges.length >= 1);
  const open = S.buildScene(sceneInput(m, { mode: 'architecture', expanded: new Set([1]) }));
  assert.equal(open.nodes.filter(n => n.kind === 'group').length, 3);
  assert.ok(open.fileIndex.has(2) && open.fileIndex.has(3));
  assert.equal(S.shortLabel('scripts/eng-bench/tasks/delegation-security/hidden'), '…/delegation-security/hidden');
});

test('SVG export is standalone, escaped and bounded', () => {
  const svg = M.toSvg([{ x: 0, y: 0, r: 5, color: '#123', label: 'a<b>' }, { x: 50, y: 20, r: 3, color: '#456' }], [{ a: 0, b: 1, color: '#999', width: 1 }], { bg: '#fff', fg: '#000' }, 'Map & more');
  assert.match(svg, /^<svg xmlns=/);
  assert.ok(svg.includes('a&lt;b&gt;') && svg.includes('Map &amp; more'));
  assert.ok(svg.includes('<line') && svg.includes('<circle'));
});

test('heat is a ramp; colours are stable per module', () => {
  assert.equal(M.heat(0), 'rgb(148,163,184)');
  assert.equal(M.heat(1), 'rgb(220,38,38)');
  assert.equal(M.communityColor(3), M.communityColor(3 + M.CATEGORICAL.length));
});

console.log(`\ncodegraph view: ${passed} passed, ${failures.length} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) process.exit(1);
