/**
 * Unit tests for the Code map's pure logic (web/src/components/codegraph):
 * the view model (filters, impact layers, directed paths, search, the
 * architecture aggregation, Mermaid, arrow-key navigation), the force layout
 * (deterministic seeding, Barnes-Hut stays bounded and separates, speed on
 * 5,000 nodes), the scene each mode builds (what is emphasised, what is
 * dimmed), SVG export — and the layered views: the Sugiyama layout (edges point
 * down, cycles broken, deterministic, 5,000 nodes in seconds), the folder
 * modules (cut, open, reveal, aggregate) and the Focus neighbourhood.
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
const Ly = await load('layered');
const Md = await load('modules');
const Fl = await load('flow');

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

test('scene: overview collapses modules, opens one on request', () => {
  const m = new M.GraphModel(payload);
  const closed = S.buildScene(sceneInput(m, { mode: 'overview' }));
  assert.equal(closed.nodes.filter(n => n.kind === 'group').length, 4);
  assert.ok(closed.edges.length >= 1);
  const open = S.buildScene(sceneInput(m, { mode: 'overview', expanded: new Set([1]) }));
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

test('exact only: links through an interface or a unique name are dropped before anything is drawn', () => {
  const withIface = { ...payload, edges: [...payload.edges, [1, 8, 3, 1, 0, 1, 1], [0, 2, 5, 1, 0, 0, 0]] };
  const all = new M.GraphModel(withIface);
  const exact = new M.GraphModel(M.exactPayload(withIface));
  assert.ok(all.out[1].includes(8) && !exact.out[1].includes(8), 'the interface edge is gone');
  assert.ok(exact.out[0].includes(2), 'a resolved method-call edge (kind call) stays');
  assert.equal(M.DEFAULT_FILTERS.exactOnly, false);
  assert.ok(M.EDGE_KINDS.includes('call'));
});

test('symbol users: certain ones, through an interface, re-exports — and exact only', () => {
  const users = [
    { id: 1, local: 'Svc.run', lines: [3], via: 'call' },
    { id: 2, local: 'Port.run', lines: [9], via: 'interface' },
    { id: 3, local: 'run', lines: [], via: 'reexport' },
    { id: 4, local: 'Svc', lines: [], via: 'inferred' },
  ];
  const loose = M.splitUsers(users, false);
  assert.deepEqual(loose.direct.map(u => u.id), [1, 4]);
  assert.deepEqual(loose.viaInterface.map(u => u.id), [2]);
  assert.deepEqual(loose.reexports.map(u => u.id), [3]);
  const exact = M.splitUsers(users, true);
  assert.deepEqual(exact.direct.map(u => u.id), [1]);
  assert.deepEqual(exact.viaInterface, []);
});

const B = await (async () => {
  const outfile = path.join(tmp, 'brief.mjs');
  await build({ entryPoints: [path.join(here, 'src', 'brief.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
})();
const F = await (async () => {
  // file-open imports the API client; only its pure part is under test here.
  const outfile = path.join(tmp, 'file-open.mjs');
  await build({ entryPoints: [path.join(here, 'src', 'file-open.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error', define: { 'import.meta.env': '{}' } });
  return import(pathToFileURL(outfile).href);
})();

test('brief: a code-graph notice offers "Show in Code map" and "Ask AICO to fix"; the monitor has a Code switch', () => {
  const n = { key: 'k', project: '/p', kind: 'codegraph', title: 'New import cycle (2 files)', body: 'a → b → a', at: 1, file: 'src/a.ts', mode: 'cycles', prompt: 'Break it' };
  const acts = B.noticeActions(n);
  assert.deepEqual(acts.map(a => a.kind), ['open-codemap', 'start-fix']);
  assert.equal(acts[0].file, 'src/a.ts');
  assert.equal(acts[0].mode, 'cycles');
  assert.equal(acts[1].prompt, 'Break it');
  assert.deepEqual(B.noticeActions({ ...n, kind: 'ci', url: 'https://x' }).map(a => a.kind), ['open-url']);
  assert.deepEqual([...B.MONITOR_FLAGS], ['ci', 'reviews', 'advisories', 'codeGraph']);
  assert.equal(B.MONITOR_LABEL.codeGraph, 'Code');
});

test('the file viewer numbers lines and finds the target', () => {
  const v = F.numbered('a\r\nb\nc\n', 2);
  assert.deepEqual(v.lines, ['a', 'b', 'c']);
  assert.equal(v.index, 1);
  assert.equal(F.numbered('x', 99).index, 0, 'a line past the end lands on the last line');
  assert.equal(F.numbered('x').index, -1);
});


// ── The layered views: layout, folder modules, focus neighbourhood ─────────────

/** A small deterministic generator, so "random" graphs are the same every run. */
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function layout(n, edges, opts = {}) {
  return Ly.layered({
    n, breadth: new Float64Array(n).fill(opts.w ?? 100), depth: new Float64Array(n).fill(opts.h ?? 40),
    from: edges.map(e => e[0]), to: edges.map(e => e[1]), weight: edges.map(e => e[2] ?? 1), ...opts.rest,
  });
}
/** Direction of an edge's route along the flow: +1 down, −1 up. */
const flowDir = (p) => Math.sign(p[p.length - 1] - p[1]);

test('layered: a chain is one node per layer, dependents above dependencies', () => {
  const r = layout(4, [[0, 1], [1, 2], [2, 3]]);
  assert.deepEqual([...r.layer], [0, 1, 2, 3]);
  assert.ok(r.d[0] < r.d[1] && r.d[1] < r.d[2] && r.d[2] < r.d[3]);
  assert.ok(r.feedback.every(f => f === 0));
  for (const p of r.paths) assert.equal(flowDir(p), 1);
});

test('layered: every kept edge points down, nodes in a layer never overlap, long edges route through the layers', () => {
  const rnd = lcg(7);
  const n = 220;
  const edges = [];
  for (let i = 0; i < 600; i++) { const a = Math.floor(rnd() * (n - 1)); const b = a + 1 + Math.floor(rnd() * Math.min(12, n - a - 1)); edges.push([a, b]); }
  const r = layout(n, edges);
  edges.forEach((e, i) => { assert.equal(r.feedback[i], 0); assert.ok(r.d[e[0]] < r.d[e[1]], `edge ${e} goes down`); assert.ok(r.paths[i].length >= 4); });
  const byLayer = new Map();
  for (let i = 0; i < n; i++) (byLayer.get(r.layer[i]) ?? byLayer.set(r.layer[i], []).get(r.layer[i])).push(i);
  for (const list of byLayer.values()) {
    list.sort((a, b) => r.b[a] - r.b[b]);
    for (let i = 1; i < list.length; i++) assert.ok(r.b[list[i]] - r.b[list[i - 1]] >= 100 + 24 - 1e-6, 'a gap between neighbours in a layer');
  }
  const long = edges.findIndex((e, i) => r.layer[e[1]] - r.layer[e[0]] > 2);
  assert.ok(long >= 0 && r.paths[long].length > 4, 'a long edge has waypoints in the layers it crosses');
});

test('layered: deterministic - the same input gives the same picture', () => {
  const rnd = lcg(11);
  const edges = [];
  for (let i = 0; i < 300; i++) edges.push([Math.floor(rnd() * 90), Math.floor(rnd() * 90), 1 + Math.floor(rnd() * 4)]);
  const a = layout(90, edges);
  const b = layout(90, edges);
  assert.deepEqual([...a.b], [...b.b]);
  assert.deepEqual([...a.d], [...b.d]);
  assert.deepEqual([...a.feedback], [...b.feedback]);
  assert.deepEqual(a.paths.map(p => [...p]), b.paths.map(p => [...p]));
});

test('layered: cycles are broken - a back edge is flagged and drawn upward, the rest still point down', () => {
  const r = layout(3, [[0, 1], [1, 2], [2, 0]]);
  assert.equal(r.feedback.reduce((s, f) => s + f, 0), 1, 'a three-cycle needs exactly one back edge');
  r.paths.forEach((p, i) => assert.equal(flowDir(p), r.feedback[i] ? -1 : 1));
  assert.equal(new Set([...r.layer]).size, 3, 'still three layers');
});

test('layered: of a mutual pair the lighter edge is the back edge', () => {
  const r = layout(2, [[0, 1, 5], [1, 0, 1]]);
  assert.deepEqual([...r.feedback], [0, 1]);
  assert.ok(r.d[0] < r.d[1]);
  assert.equal(flowDir(r.paths[1]), -1);
  const tie = layout(2, [[1, 0, 2], [0, 1, 2]]);
  assert.deepEqual([...tie.feedback], [1, 0], 'a tie keeps the edge from the lower index');
});

test('layered: self loops get no route; parallel edges are summed, not drawn twice apart', () => {
  const r = layout(2, [[0, 0], [0, 1], [0, 1, 3]]);
  assert.equal(r.paths[0].length, 0);
  assert.deepEqual([...r.paths[1]], [...r.paths[2]]);
});

test('layered: a node with no edges is packed below the layering, not into its top row', () => {
  const r = layout(5, [[0, 1]]);
  assert.equal(r.layer[2], r.layers);
  for (const i of [2, 3, 4]) assert.ok(r.d[i] > r.d[1], 'isolated nodes sit below the layered part');
});

test('layered: barycentre sweeps remove crossings a naive order has', () => {
  // Edges a_i -> b_(2-i): drawn in index order every pair crosses; flipping one row fixes it.
  const r = layout(6, [[0, 5], [1, 4], [2, 3]]);
  assert.equal(r.crossings, 0);
  const ranked = layout(8, [[0, 4], [0, 5], [1, 6], [1, 7], [2, 4], [3, 7]]);
  assert.ok(ranked.crossings <= 2, `crossings ${ranked.crossings}`);
});

test('layered: 5,000 nodes and 15,000 edges lay out in seconds', () => {
  const rnd = lcg(3);
  const n = 5000;
  const edges = [];
  for (let i = 0; i < 15000; i++) { const a = Math.floor(rnd() * (n - 1)); const b = a + 1 + Math.floor(rnd() * Math.min(300, n - a - 1)); edges.push([a, b]); }
  const t0 = performance.now();
  const r = layout(n, edges);
  const ms = performance.now() - t0;
  assert.equal(r.paths.length, 15000);
  assert.ok(Number.isFinite(r.breadthSpan) && Number.isFinite(r.depthSpan) && Number.isFinite(r.crossings), 'no NaN from long edges when dummies are dropped');
  assert.ok(ms < 8000, `took ${Math.round(ms)} ms`);
  console.log(`        (5,000 nodes / 15,000 edges: ${Math.round(ms)} ms, ${r.layers} layers)`);
});

test('layered: 3,000 nodes with edges in every direction (dense cycles) still lay out', () => {
  const rnd = lcg(5);
  const n = 3000;
  const edges = [];
  for (let i = 0; i < 9000; i++) edges.push([Math.floor(rnd() * n), Math.floor(rnd() * n)]);
  const t0 = performance.now();
  const r = layout(n, edges);
  const ms = performance.now() - t0;
  assert.ok(r.feedback.some(f => f === 1));
  assert.ok(r.paths.every((p, i) => edges[i][0] === edges[i][1] || p.length >= 4));
  assert.ok(ms < 12000, `took ${Math.round(ms)} ms`);
  console.log(`        (3,000 nodes / 9,000 cyclic edges: ${Math.round(ms)} ms)`);
});

test('packLine: order and spacing hold, and items sit as near their wish as that allows', () => {
  const p = Ly.packLine([0, 0, 0], [10, 10, 10], () => 5);
  assert.deepEqual(p.map(Math.round), [-15, 0, 15]);
  const q = Ly.packLine([100, 0], [10, 10], () => 0);
  assert.ok(q[1] - q[0] >= 10 - 1e-9, 'order kept even when the wishes are reversed');
  const free = Ly.packLine([0, 500], [10, 10], () => 5);
  assert.deepEqual(free, [0, 500], 'no pressure, no movement');
});

// A project with two folders that depend on each other, one direction much more than the other.
function folderPayload() {
  const files = [];
  const edges = [];
  const add = (p, extra = {}) => { files.push(file(p, extra)); return files.length - 1; };
  const a = [0, 1, 2].map(i => add(`app/a${i}.ts`));
  const b = [0, 1, 2].map(i => add(`lib/sub/b${i}.ts`));
  const c = add('lib/c.ts');
  const root = add('main.ts');
  for (let i = 0; i < 3; i++) edges.push([a[i], b[i], 0, 1, 0, 0]);
  edges.push([a[0], c, 0, 1, 0, 0], [b[0], a[1], 0, 1, 0, 0], [root, a[0], 0, 1, 0, 0]);
  return { ...payload, files, edges, communities: [{ id: 0, label: 'all', files: files.map((_, i) => i) }], cochange: [], cycles: [], orphans: [], stats: { ...payload.stats, indexed: files.length } };
}

test('modules: folders are the boxes; every visible file is in exactly one; single-child chains merge', () => {
  const pl = folderPayload();
  const m = new M.GraphModel(pl);
  const tree = new Md.ModuleTree(m);
  const units = Md.autoCut(tree);
  const all = units.flatMap(u => u.files).sort((x, y) => x - y);
  assert.deepEqual(all, [...Array(pl.files.length).keys()]);
  assert.deepEqual(units.map(u => u.title).sort(), ['app', 'lib', 'root files']);
  const lib = tree.byKey.get('lib');
  assert.equal(lib.kids[0].name, 'sub');
  const masked = new Md.ModuleTree(m, Uint8Array.from(pl.files.map(f => (f.path.startsWith('app/') ? 1 : 0))));
  assert.deepEqual(Md.autoCut(masked).map(u => u.title), ['app'], 'a filtered-out folder has no box');
});

test('modules: opening a box swaps it for its contents; ancestors say what to open to reveal a file', () => {
  const pl = folderPayload();
  const m = new M.GraphModel(pl);
  const tree = new Md.ModuleTree(m);
  const opened = Md.cutFor(tree, m, ['lib']);
  assert.deepEqual(opened.map(u => u.title).sort(), ['app', 'c.ts', 'root files', 'sub']);
  assert.ok(opened.find(u => u.title === 'sub').fresh && opened.find(u => u.title === 'c.ts').fresh);
  assert.ok(!opened.find(u => u.title === 'app').fresh);
  const deeper = Md.cutFor(tree, m, ['lib', 'lib/sub']);
  assert.equal(deeper.filter(u => u.kind === 'file' && u.title.startsWith('b')).length, 3);
  const keys = tree.ancestors(4);
  assert.deepEqual(keys.slice(0, 1), ['lib']);
  assert.deepEqual(Md.cutFor(tree, m, keys).map(u => u.key).includes('f4'), true, 'opening the ancestors reveals the file');
  assert.deepEqual(Md.cutFor(tree, m, ['no/such/folder']).map(u => u.title).sort(), ['app', 'lib', 'root files'], 'a stale key is ignored');
});

test('modules: edges between boxes are summed, inside a box they vanish', () => {
  const pl = folderPayload();
  const m = new M.GraphModel(pl);
  const units = Md.autoCut(new Md.ModuleTree(m));
  const ix = (t) => units.findIndex(u => u.title === t);
  const agg = Md.aggregateEdges(m, undefined, units);
  const get = (a, b) => agg.find(e => e.a === ix(a) && e.b === ix(b))?.count;
  assert.equal(get('app', 'lib'), 4);
  assert.equal(get('lib', 'app'), 1);
  assert.equal(get('root files', 'app'), 1);
  assert.equal(agg.length, 3);
});

test('architecture flow: dependents above dependencies, the lighter side of a mutual pair is the red back edge', () => {
  const pl = folderPayload();
  const m = new M.GraphModel(pl);
  const tree = new Md.ModuleTree(m);
  const { scene, units } = Fl.architectureFlow(tree, m, undefined, []);
  const at = (t) => scene.nodes[units.findIndex(u => u.title === t)];
  assert.ok(at('root files').y < at('app').y && at('app').y < at('lib').y);
  const back = scene.edges.filter(e => e.back);
  assert.equal(back.length, 1);
  assert.equal(scene.nodes[back[0].a].title, 'lib');
  assert.equal(back[0].count, 1);
  for (const n of scene.nodes) for (const o of scene.nodes) if (n !== o) assert.ok(Math.abs(n.x - o.x) >= (n.w + o.w) / 2 - 1e-6 || Math.abs(n.y - o.y) >= (n.h + o.h) / 2 - 1e-6, 'boxes never overlap');
  assert.equal(scene.keyIndex.get('app'), units.findIndex(u => u.title === 'app'));
});

test('focus: users on the left, dependencies on the right, up to two hops, column = hop', () => {
  const m = new M.GraphModel(payload);
  const nb = Fl.focusNeighbourhood(m, 2, { hops: 2 });
  const hop = new Map(nb.nodes.map(n => [n.id, n.hop]));
  assert.equal(hop.get(2), 0);
  assert.deepEqual([1, 3, 4].map(i => hop.get(i)), [-1, -1, -1]);
  assert.equal(hop.get(0), -2, 'two hops out: page.tsx uses a.ts which uses util.ts');
  assert.ok(!nb.nodes.some(n => n.hop > 0), 'util.ts uses nothing');
  const one = Fl.focusNeighbourhood(m, 2, { hops: 1 });
  assert.ok(!one.nodes.some(n => n.id === 0));
  const mid = Fl.focusNeighbourhood(m, 1, { hops: 2 });
  assert.deepEqual(mid.nodes.filter(n => n.hop > 0).map(n => n.id).sort(), [2], 'a.ts uses util.ts (the barrel import is pass-through, not a dependency)');
  assert.ok(mid.edges.every(([a, b]) => Math.abs(mid.nodes.find(n => n.id === a).hop - mid.nodes.find(n => n.id === b).hop) === 1));
});

test('focus: limits hide the long tail and say how much; the filter hides files; a cycle is a back edge', () => {
  const files = [file('hub.ts', { fanIn: 40 })];
  const edges = [];
  for (let i = 1; i <= 40; i++) { files.push(file(`u/u${String(i).padStart(2, '0')}.ts`)); edges.push([i, 0, 0, 1, 0, 0]); }
  const m = new M.GraphModel({ ...payload, files, edges, communities: [{ id: 0, label: 'x', files: files.map((_, i) => i) }], cochange: [], cycles: [] });
  const nb = Fl.focusNeighbourhood(m, 0, { limit1: 10 });
  assert.equal(nb.nodes.length, 11);
  assert.equal(nb.hidden.left, 30);
  const scene = Fl.focusFlow(m, nb);
  const more = scene.nodes.find(n => n.kind === 'more');
  assert.equal(more.files, 30);
  assert.ok(scene.nodes.filter(n => n.role === 'in').every(n => n.x < scene.nodes.find(c => c.role === 'focus').x));
  const mask = new Uint8Array(files.length).fill(1);
  mask[1] = 0; mask[2] = 0;
  assert.equal(Fl.focusNeighbourhood(m, 0, { mask, limit1: 100 }).nodes.length, 39);
  const cyc = new M.GraphModel(payload);
  const sc = Fl.focusFlow(cyc, Fl.focusNeighbourhood(cyc, 6), new Set([6, 7]));
  assert.equal(sc.edges.filter(e => e.back).length, 1, 'x.ts imports y.ts and y.ts imports x.ts: one of the two points back');
});

test('focus flow: columns are ordered and tidy - same column never overlaps, edges join neighbouring columns', () => {
  const m = new M.GraphModel(payload);
  const sc = Fl.focusFlow(m, Fl.focusNeighbourhood(m, 2));
  const centre = sc.nodes.find(n => n.role === 'focus');
  assert.equal(centre.x, 0);
  const cols = new Map();
  for (const n of sc.nodes) (cols.get(n.x) ?? cols.set(n.x, []).get(n.x)).push(n);
  for (const list of cols.values()) { list.sort((a, b) => a.y - b.y); for (let i = 1; i < list.length; i++) assert.ok(list[i].y - list[i - 1].y >= list[i].h, 'rows do not overlap'); }
  assert.equal(sc.dir, 'right');
});


test('layered: reduce sets aside an edge a longer chain already implies, and only that one', () => {
  const edges = [[0, 1], [1, 2], [0, 2], [2, 3], [0, 3], [1, 3]];
  const r = layout(4, edges, { rest: { reduce: true } });
  assert.deepEqual([...r.redundant], [0, 0, 1, 0, 1, 1]);
  assert.equal(r.paths[2].length, 0, 'a set-aside edge has no route');
  const all = layout(4, edges);
  assert.ok(all.redundant.every(x => x === 0), 'off by default');
  assert.deepEqual([...all.layer], [...r.layer], 'the layers are the same either way');
  const back = layout(3, [[0, 1], [1, 2], [2, 0]], { rest: { reduce: true } });
  assert.equal(back.redundant.reduce((x, y) => x + y, 0), 0, 'a cycle is not mistaken for redundancy');
});

test('architecture flow: key links drop the implied dependency and say how many; two boxes of one name are told apart', () => {
  const files = [];
  const edges = [];
  const add = p => { files.push(file(p)); return files.length - 1; };
  const a = add('a/x.ts'); const b = add('b/x.ts'); const c = add('c/x.ts'); const d = add('d/shared/x.ts'); const e = add('shared/x.ts');
  edges.push([a, b, 0, 1, 0, 0], [b, c, 0, 1, 0, 0], [a, c, 0, 1, 0, 0], [c, d, 0, 1, 0, 0], [d, e, 0, 1, 0, 0]);
  const m = new M.GraphModel({ ...payload, files, edges, communities: [{ id: 0, label: 'x', files: files.map((_, i) => i) }], cochange: [], cycles: [] });
  const tree = new Md.ModuleTree(m);
  const key = Fl.architectureFlow(tree, m, undefined, [], undefined, true);
  const all = Fl.architectureFlow(tree, m, undefined, [], undefined, false);
  assert.equal(all.scene.edges.length, 5);
  assert.equal(key.scene.edges.length, 4);
  assert.equal(key.hidden, 1);
  assert.deepEqual(key.units.map(u => u.title), ['a', 'b', 'c', 'd/shared', 'shared']);
  add('d/other.ts');
  const m2 = new M.GraphModel({ ...payload, files, edges, communities: [{ id: 0, label: 'x', files: files.map((_, i) => i) }], cochange: [], cycles: [] });
  const opened = Md.cutFor(new Md.ModuleTree(m2), m2, ['d']).map(u => u.title);
  assert.ok(opened.includes('d/shared') && opened.includes('shared') && opened.includes('other.ts'), `told apart once opened: ${opened}`);
});

test('tints: one colour per top-level folder, stable, never shared while the palette lasts', () => {
  const m = new M.GraphModel(payload);
  const names = ['src', 'test', 'tools', 'vendor'];
  const colours = names.map(n => Fl.tintFor(m, n));
  assert.equal(new Set(colours).size, names.length);
  assert.equal(Fl.tintFor(m, 'src'), Fl.tintFor(m, 'src'));
  assert.equal(Fl.tintFor(m, 'nope'), '#94a3b8');
});

console.log(`\ncodegraph view: ${passed} passed, ${failures.length} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) process.exit(1);
