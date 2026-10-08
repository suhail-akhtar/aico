/**
 * What the Code map's two layered views draw: boxes with routed edges.
 *
 *  - **Architecture**: the folder boxes of modules.ts laid out top to bottom by
 *    layered.ts, dependents above dependencies, aggregated edges with counts,
 *    back edges (cycles) flagged.
 *  - **Focus**: one file in the middle, the files that use it in columns to its
 *    left (up to two hops out), the files it uses in columns to its right — a
 *    neighbourhood read left to right, not a graph to untangle.
 *
 * ## Why Focus is not just the layered layout of a neighbourhood
 *
 * A longest-path layering of the neighbourhood would put a file two hops away
 * in column one whenever some shorter chain reaches it, so "left = users, right
 * = dependencies, distance = column" would stop being true. Here the column
 * *is* the hop count; only the order inside a column is optimised (barycentre,
 * then least-squares packing from layered.ts).
 *
 * Pure: a scene is data (positions, sizes, routes, tints). Colours that depend
 * on the theme and everything that depends on the pointer (hover, selection)
 * are applied when drawing (render-flow.ts), so moving the mouse never
 * re-runs a layout.
 *
 * @module web/components/codegraph/flow
 */

import { basename, CATEGORICAL, dirname, type GraphModel } from './model';
import { aggregateEdges, cutFor, topOf, type ModuleTree, type Unit } from './modules';
import { layered, packLine } from './layered';

export interface FlowNode {
  key: string;
  kind: 'module' | 'file' | 'more';
  /** The file id (files), or -1. */
  ref: number;
  /** Files inside (modules). */
  files: number;
  /** Centre and size, world units. */
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  tint: string;
  /** Focus: the file in the middle. */
  role?: 'focus' | 'in' | 'out';
  /** Focus: columns from the middle (negative: users, positive: dependencies). */
  hop?: number;
  /** Appeared by opening a module. */
  fresh?: boolean;
  /** Part of an import cycle (files). */
  cycle?: boolean;
}

export interface FlowEdge {
  a: number;
  b: number;
  /** [x0, y0, x1, y1, …] source port → target port. */
  pts: Float32Array;
  count: number;
  /** Points against the flow: part of a cycle. */
  back: boolean;
  /** Focus: reaches a file two or more hops out; drawn fainter so the near ones read first. */
  far?: boolean;
  bbox: [number, number, number, number];
}

export interface FlowScene {
  dir: 'down' | 'right';
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
  /** Node index by file id (file nodes only). */
  fileIndex: Map<number, number>;
  keyIndex: Map<string, number>;
}

export const EMPTY_FLOW: FlowScene = { dir: 'down', nodes: [], edges: [], width: 0, height: 0, fileIndex: new Map(), keyIndex: new Map() };

const tints = new WeakMap<GraphModel, Map<string, string>>();

/**
 * A colour per top-level folder: palette order over the sorted names, so two folders never share one
 * until there are more folders than colours, and the same project always looks the same.
 */
export function tintFor(model: GraphModel, top: string): string {
  let m = tints.get(model);
  if (!m) {
    const names = [...new Set(model.payload.files.map(f => topOf(f.path)))].sort();
    m = new Map(names.map((t, i) => [t, CATEGORICAL[i % CATEGORICAL.length]!]));
    tints.set(model, m);
  }
  return m.get(top) ?? '#94a3b8';
}

const CHAR = 7.2;

function bboxOf(pts: Float32Array): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]!); x1 = Math.max(x1, pts[i]!); y0 = Math.min(y0, pts[i + 1]!); y1 = Math.max(y1, pts[i + 1]!); }
  return [x0, y0, x1, y1];
}

function finish(dir: 'down' | 'right', nodes: FlowNode[], edges: FlowEdge[]): FlowScene {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x - n.w / 2); x1 = Math.max(x1, n.x + n.w / 2); y0 = Math.min(y0, n.y - n.h / 2); y1 = Math.max(y1, n.y + n.h / 2); }
  const fileIndex = new Map<number, number>();
  const keyIndex = new Map<string, number>();
  nodes.forEach((n, i) => { keyIndex.set(n.key, i); if (n.kind === 'file') fileIndex.set(n.ref, i); });
  return { dir, nodes, edges, width: isFinite(x1) ? x1 - x0 : 0, height: isFinite(y1) ? y1 - y0 : 0, fileIndex, keyIndex };
}

// ── Architecture ──────────────────────────────────────────────────────────────

/**
 * `keyLinks`: leave out a dependency that a longer chain already implies (a→c beside a→b→c). On a
 * folder-level graph those are most of the lines and none of the information: the layers say
 * "a is above c" already. `hidden` counts what was left out.
 */
export function architectureFlow(tree: ModuleTree, model: GraphModel, mask: Uint8Array | undefined, open: string[], inCycle?: Set<number>, keyLinks = true): { scene: FlowScene; units: Unit[]; hidden: number } {
  const units = cutFor(tree, model, open);
  const edges = aggregateEdges(model, mask, units);
  const n = units.length;
  const w = new Float64Array(n);
  const h = new Float64Array(n);
  // Many boxes (a folder opened) are drawn smaller, so the whole picture is not too big to read.
  const s = n > 45 ? 0.78 : n > 30 ? 0.88 : 1;
  units.forEach((u, i) => {
    if (u.kind === 'module') { w[i] = s * Math.max(136, Math.min(240, 30 + Math.max(u.title.length * 8, Math.min(u.sub.length, 26) * 6.2))); h[i] = s * 50; }
    else { w[i] = s * Math.max(120, Math.min(260, 28 + Math.max(u.title.length * CHAR, Math.min(u.sub.length, 30) * 5.8))); h[i] = s * 42; }
  });
  const res = layered({ n, breadth: w, depth: h, from: edges.map(e => e.a), to: edges.map(e => e.b), weight: edges.map(e => e.count), nodeGap: 30 * s, layerGap: 84 * s, reduce: keyLinks });
  const nodes: FlowNode[] = units.map((u, i) => ({
    key: u.key, kind: u.kind, ref: u.file, files: u.files.length, x: res.b[i]!, y: res.d[i]!, w: w[i]!, h: h[i]!,
    title: u.title, sub: u.sub, tint: tintFor(model, u.top), ...(u.fresh ? { fresh: true } : {}),
    ...(u.kind === 'file' && inCycle?.has(u.file) ? { cycle: true } : {}),
  }));
  const out: FlowEdge[] = [];
  let hidden = 0;
  edges.forEach((e, i) => {
    if (res.redundant[i]) { hidden++; return; }
    out.push({ a: e.a, b: e.b, pts: res.paths[i]!, count: e.count, back: res.feedback[i] === 1, bbox: bboxOf(res.paths[i]!) });
  });
  return { scene: finish('down', nodes, out), units, hidden };
}

// ── Focus ─────────────────────────────────────────────────────────────────────

export interface Neighbourhood {
  center: number;
  /** hop < 0: files that use the centre (−1 directly); hop > 0: files it uses. */
  nodes: Array<{ id: number; hop: number }>;
  edges: Array<[number, number]>;
  /** Neighbours left out by the limits, per side. */
  hidden: { left: number; right: number };
}

export interface FocusOptions {
  hops?: number;
  /** Visible files; the centre is always shown. */
  mask?: Uint8Array;
  /** Most files in the first / second column of a side. */
  limit1?: number;
  limit2?: number;
}

export function focusNeighbourhood(model: GraphModel, center: number, opts: FocusOptions = {}): Neighbourhood {
  const hops = Math.max(1, Math.min(3, opts.hops ?? 2));
  const limit1 = opts.limit1 ?? 16;
  const limit2 = opts.limit2 ?? 24;
  const rank = (a: number, b: number): number => {
    const fa = model.file(a); const fb = model.file(b);
    return (fb.fanIn + fb.fanOut - fa.fanIn - fa.fanOut) || (fa.path < fb.path ? -1 : fa.path > fb.path ? 1 : 0);
  };
  const placed = new Map<number, number>([[center, 0]]);
  const hidden = { left: 0, right: 0 };
  for (const side of [-1, 1] as const) {
    const adj = side < 0 ? model.inn : model.out;
    let frontier = [center];
    for (let hop = 1; hop <= hops; hop++) {
      const seen = new Set<number>();
      for (const f of frontier) for (const t of adj[f]!) if (!placed.has(t) && (!opts.mask || opts.mask[t]) && t !== center) seen.add(t);
      const sorted = [...seen].sort(rank);
      const cap = hop === 1 ? limit1 : limit2;
      const kept = sorted.slice(0, cap);
      if (side < 0) hidden.left += sorted.length - kept.length; else hidden.right += sorted.length - kept.length;
      for (const t of kept) placed.set(t, side * hop);
      frontier = kept;
      if (!kept.length) break;
    }
  }
  const nodes = [...placed.entries()].map(([id, hop]) => ({ id, hop }));
  const edges: Array<[number, number]> = [];
  for (const { id } of nodes) {
    for (const t of model.out[id]!) {
      if (t === id || !placed.has(t)) continue;
      // Only between neighbouring columns: a line across the middle column would run behind the centre.
      if (Math.abs(placed.get(id)! - placed.get(t)!) !== 1) continue;
      edges.push([id, t]);
    }
  }
  edges.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]));
  return { center, nodes, edges: edges.slice(0, 800), hidden };
}

const COL_W = 240;
const COL_GAP = 120;
const ROW_H = 40;
const ROW_GAP = 9;

export function focusFlow(model: GraphModel, nb: Neighbourhood, inCycle?: Set<number>): FlowScene {
  const cols = new Map<number, number[]>();
  for (const { id, hop } of nb.nodes) (cols.get(hop) ?? cols.set(hop, []).get(hop)!).push(id);
  const nodes: FlowNode[] = [];
  const indexOf = new Map<number, number>();
  const yOf = new Map<number, number>();
  const hops = [...cols.keys()].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
  const linked = new Map<number, number[]>();
  for (const [a, b] of nb.edges) { (linked.get(a) ?? linked.set(a, []).get(a)!).push(b); (linked.get(b) ?? linked.set(b, []).get(b)!).push(a); }
  const columnX = (hop: number): number => hop * (COL_W + COL_GAP);

  for (const hop of hops) {
    let ids = cols.get(hop)!;
    const inner = hop === 0 ? 0 : hop - Math.sign(hop);
    ids = ids.slice().sort((a, b) => (model.file(a).path < model.file(b).path ? -1 : 1));
    if (hop !== 0 && inner !== 0) {
      // Order by where the linked files of the inner column ended up.
      const bary = (id: number): number => {
        const ys = (linked.get(id) ?? []).map(x => yOf.get(x)).filter((v): v is number => v !== undefined);
        return ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : 0;
      };
      ids = ids.map(id => ({ id, k: bary(id) })).sort((x, y) => (x.k - y.k) || (model.file(x.id).path < model.file(y.id).path ? -1 : 1)).map(x => x.id);
    }
    const desired = ids.map(id => {
      if (hop === 0) return 0;
      const ys = (linked.get(id) ?? []).map(x => yOf.get(x)).filter((v): v is number => v !== undefined);
      return ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : 0;
    });
    const ys = packLine(desired, ids.map(() => ROW_H), () => ROW_GAP);
    // Keep the column centred on the file in the middle.
    const mid = ids.length ? (ys[0]! + ys[ids.length - 1]!) / 2 : 0;
    const shift = hop === 0 ? 0 : Math.abs(hop) === 1 ? -mid : 0;
    ids.forEach((id, i) => {
      const f = model.file(id);
      const y = ys[i]! + shift;
      yOf.set(id, y);
      indexOf.set(id, nodes.length);
      nodes.push({
        key: `f${id}`, kind: 'file', ref: id, files: 1, x: columnX(hop), y, w: COL_W, h: ROW_H,
        title: basename(f.path), sub: dirname(f.path), tint: tintFor(model, topOf(f.path)),
        hop, ...(hop === 0 ? { role: 'focus' as const } : { role: hop < 0 ? 'in' as const : 'out' as const }),
        ...(inCycle?.has(id) ? { cycle: true } : {}),
      });
    });
  }
  // "+N more" at the foot of each side's nearest column.
  for (const [side, count] of [[-1, nb.hidden.left], [1, nb.hidden.right]] as const) {
    if (count <= 0) continue;
    const col = cols.get(side) ?? [];
    const bottom = col.reduce((m, id) => Math.max(m, yOf.get(id) ?? 0), 0);
    nodes.push({ key: `more:${side < 0 ? 'left' : 'right'}`, kind: 'more', ref: -1, files: count, x: columnX(side), y: col.length ? bottom + ROW_H + ROW_GAP + 6 : 0, w: COL_W, h: 30, title: `+${count} more`, sub: 'click to show all', tint: '#94a3b8' });
  }
  const edges: FlowEdge[] = [];
  const colOf = new Map(nb.nodes.map(n => [n.id, n.hop]));
  for (const [a, b] of nb.edges) {
    const na = nodes[indexOf.get(a)!]!;
    const nbn = nodes[indexOf.get(b)!]!;
    const forward = colOf.get(a)! < colOf.get(b)!;
    const pts = forward
      ? Float32Array.of(na.x + na.w / 2, na.y, nbn.x - nbn.w / 2, nbn.y)
      : Float32Array.of(na.x - na.w / 2, na.y, nbn.x + nbn.w / 2, nbn.y);
    const far = Math.max(Math.abs(colOf.get(a)!), Math.abs(colOf.get(b)!)) >= 2;
    edges.push({ a: indexOf.get(a)!, b: indexOf.get(b)!, pts, count: 1, back: !forward, bbox: bboxOf(pts), ...(far ? { far: true } : {}) });
  }
  return finish('right', nodes, edges);
}
