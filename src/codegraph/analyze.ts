/**
 * Questions asked of a built graph: impact, paths, cycles, orphans, hotspots,
 * communities, entry points, layering rules.
 *
 * Every function here is pure over a {@link CodeGraph} — no I/O, no clock —
 * so the agent's tool, the HTTP routes and the tests ask the same thing and
 * get the same answer.
 *
 * Two choices that come straight from the Phase 0 benchmark (ADR 0028):
 *
 * - **Impact skips barrel pass-through.** A file that imports `formatAmount`
 *   through `@/lib` depends on `currency.ts`, not on everything else the
 *   barrel re-exports; following the literal import would make every file
 *   that touches the barrel "depend" on every file behind it.
 * - **Paths are directed, or there is no path.** An undirected path between
 *   two files through a shared `context.Context` is an answer, and a wrong one.
 *
 * @module codegraph/analyze
 */

import type { CodeGraph, Community, FileEdge, GraphFile } from './types.js';
import { dirOf } from './paths.js';

// ── Adjacency ───────────────────────────────────────────────────────────────

export interface Adjacency {
  out: number[][];
  in: number[][];
}

/** Dependency adjacency for analysis: pass-through barrel edges excluded. */
export function adjacency(g: Pick<CodeGraph, 'files' | 'edges'>, opts: { includePassThrough?: boolean; kinds?: Set<string> } = {}): Adjacency {
  const out: number[][] = g.files.map(() => []);
  const inn: number[][] = g.files.map(() => []);
  for (const e of g.edges) {
    if (e.passThrough && !opts.includePassThrough) continue;
    if (opts.kinds && !opts.kinds.has(e.kind)) continue;
    out[e.from]!.push(e.to);
    inn[e.to]!.push(e.from);
  }
  return { out, in: inn };
}

export function computeDegrees(files: GraphFile[], edges: FileEdge[]): void {
  for (const f of files) { f.fanIn = 0; f.fanOut = 0; }
  for (const e of edges) {
    if (e.passThrough) continue;
    files[e.to]!.fanIn++;
    files[e.from]!.fanOut++;
  }
}

// ── Impact ──────────────────────────────────────────────────────────────────

export interface ImpactLayer { depth: number; files: number[] }

/**
 * Files that depend on `seeds`, by distance. For a symbol, `firstLayer` gives
 * the direct users (from symbol references) and the closure continues by file.
 */
export function impactLayers(g: CodeGraph, seeds: number[], maxDepth = 3, firstLayer?: number[]): ImpactLayer[] {
  const adj = adjacency(g);
  const seen = new Set<number>(seeds);
  const layers: ImpactLayer[] = [];
  let frontier = seeds;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: number[] = [];
    const source = depth === 1 && firstLayer ? firstLayer : frontier.flatMap(f => adj.in[f]!);
    for (const d of source) {
      if (seen.has(d)) continue;
      seen.add(d);
      next.push(d);
    }
    if (next.length === 0) break;
    next.sort((a, b) => g.files[a]!.path.localeCompare(g.files[b]!.path));
    layers.push({ depth, files: next });
    frontier = next;
  }
  return layers;
}

// ── Paths ───────────────────────────────────────────────────────────────────

/** Shortest directed dependency path from `a` to `b` (a imports … imports b), or undefined. */
export function shortestPath(g: CodeGraph, a: number, b: number, opts: { includePassThrough?: boolean } = {}): number[] | undefined {
  if (a === b) return [a];
  const adj = adjacency(g, { includePassThrough: opts.includePassThrough ?? true });
  const prev = new Map<number, number>([[a, -1]]);
  const queue = [a];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    for (const nx of adj.out[cur]!) {
      if (prev.has(nx)) continue;
      prev.set(nx, cur);
      if (nx === b) {
        const path = [b];
        let p = cur;
        while (p !== -1) { path.push(p); p = prev.get(p)!; }
        return path.reverse();
      }
      queue.push(nx);
    }
  }
  return undefined;
}

// ── Cycles (Tarjan) ─────────────────────────────────────────────────────────

/** Strongly connected components of more than one file (or a self-loop), largest first. */
export function cycles(g: Pick<CodeGraph, 'files' | 'edges'>, opts: { ignoreTypeOnly?: boolean } = {}): number[][] {
  void opts;
  const adj = adjacency(g, { includePassThrough: true, kinds: new Set(['import', 'reexport', 'package']) });
  const n = g.files.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const out: number[][] = [];
  let counter = 0;
  // Iterative Tarjan: a deep import chain must not overflow the JS stack.
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    const work: Array<[number, number]> = [[s, 0]];
    while (work.length) {
      const top = work[work.length - 1]!;
      const [v, i] = top;
      if (i === 0) { index[v] = low[v] = counter++; stack.push(v); onStack[v] = 1; }
      const nbrs = adj.out[v]!;
      if (i < nbrs.length) {
        top[1] = i + 1;
        const w = nbrs[i]!;
        if (index[w] === -1) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
        continue;
      }
      if (low[v] === index[v]) {
        const comp: number[] = [];
        let w: number;
        do { w = stack.pop()!; onStack[w] = 0; comp.push(w); } while (w !== v);
        if (comp.length > 1) out.push(comp.sort((a, b) => a - b));
      }
      work.pop();
      if (work.length) { const parent = work[work.length - 1]![0]; low[parent] = Math.min(low[parent]!, low[v]!); }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

/** One concrete loop through a component, for showing a person: a → b → … → a. */
export function cycleWitness(g: Pick<CodeGraph, 'files' | 'edges'>, comp: number[]): number[] {
  const inComp = new Set(comp);
  const adj = adjacency(g, { includePassThrough: true });
  const start = comp[0]!;
  const prev = new Map<number, number>([[start, -1]]);
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    for (const nx of adj.out[cur]!) {
      if (!inComp.has(nx)) continue;
      if (nx === start) {
        const path = [start];
        let p = cur;
        while (p !== -1) { path.push(p); p = prev.get(p)!; }
        return path.reverse();
      }
      if (prev.has(nx)) continue;
      prev.set(nx, cur);
      queue.push(nx);
    }
  }
  return comp;
}

// ── Orphans, entry points, hotspots ─────────────────────────────────────────

const CONFIG_FILE = /(^|\/)(vite|vitest|jest|webpack|rollup|tsup|next|nuxt|svelte|astro|tailwind|postcss|babel|eslint|prettier|playwright|karma|metro|esbuild|drizzle|knexfile|gulpfile|gruntfile)[^/]*\.(c|m)?[jt]s$|(^|\/)(setup|conftest|noxfile|fabfile|tasks)\.py$|\.d\.ts$|(^|\/)(build\.rs|doc\.go)$/i;

/** Files nothing depends on that are not entry points, tests, configs or declarations. */
export function orphans(g: CodeGraph): number[] {
  const hasIn = new Uint8Array(g.files.length);
  for (const e of g.edges) hasIn[e.to] = 1;
  return g.files.filter(f => !hasIn[f.id] && !f.entry && !f.isTest && !CONFIG_FILE.test(f.path)).map(f => f.id);
}

/** Hotspot score in [0, 1]: churn × log fan-in × log size, normalised to the project's maximum. */
export function computeHotspots(files: GraphFile[]): void {
  let max = 0;
  const raw = files.map(f => {
    const v = f.churn * Math.log2(2 + f.fanIn) * Math.log2(2 + f.loc / 40);
    if (v > max) max = v;
    return v;
  });
  files.forEach((f, i) => { f.hotspot = max > 0 ? Math.round((raw[i]! / max) * 1000) / 1000 : 0; });
}

// ── Communities (Louvain with aggregation) ──────────────────────────────────

/**
 * Modularity communities over the undirected dependency graph, plus weak
 * same-folder edges so that a file with no imports still lands with its
 * neighbours. Deterministic: nodes are visited in path order, ties broken by
 * the lower community id.
 */
export function communities(g: Pick<CodeGraph, 'files' | 'edges'>): Community[] {
  const n = g.files.length;
  if (n === 0) return [];
  // Undirected weighted edge list.
  const w = new Map<string, number>();
  const addW = (a: number, b: number, x: number): void => {
    if (a === b) return;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    w.set(key, (w.get(key) ?? 0) + x);
  };
  for (const e of g.edges) addW(e.from, e.to, e.passThrough ? 0.25 : 1 + Math.min(3, e.names.length) * 0.25);
  const byDir = new Map<string, number[]>();
  for (const f of g.files) { const d = dirOf(f.path); const l = byDir.get(d); if (l) l.push(f.id); else byDir.set(d, [f.id]); }
  for (const ids of byDir.values()) {
    // A chain rather than a clique: O(n) edges that still connect the folder.
    for (let i = 1; i < ids.length; i++) addW(ids[i - 1]!, ids[i]!, 0.5);
  }

  let nodes = n;
  let edges: Array<[number, number, number]> = [...w.entries()].map(([k, x]) => { const [a, b] = k.split(',').map(Number); return [a!, b!, x]; });
  let membership = Array.from({ length: n }, (_, i) => i);

  for (let level = 0; level < 8; level++) {
    const { assignment, moved } = louvainPass(nodes, edges);
    if (!moved) break;
    // Relabel communities densely.
    const relabel = new Map<number, number>();
    for (const c of assignment) if (!relabel.has(c)) relabel.set(c, relabel.size);
    membership = membership.map(c => relabel.get(assignment[c]!)!);
    const agg = new Map<string, number>();
    for (const [a, b, x] of edges) {
      const ca = relabel.get(assignment[a]!)!;
      const cb = relabel.get(assignment[b]!)!;
      const key = ca <= cb ? `${ca},${cb}` : `${cb},${ca}`;
      agg.set(key, (agg.get(key) ?? 0) + x);
    }
    nodes = relabel.size;
    edges = [...agg.entries()].map(([k, x]) => { const [a, b] = k.split(',').map(Number); return [a!, b!, x]; });
    if (nodes <= 1) break;
  }

  const groups = new Map<number, number[]>();
  membership.forEach((c, i) => { const l = groups.get(c); if (l) l.push(i); else groups.set(c, [i]); });
  const list = [...groups.values()].sort((a, b) => b.length - a.length || a[0]! - b[0]!);
  const out = list.map((files, id) => ({ id, label: labelFor(files.map(f => g.files[f]!.path)), files }));
  // Several modules under one folder ("src", "src", "src") say nothing: name each by
  // the subfolders that make it up instead ("src: cart, checkout").
  const byLabel = new Map<string, typeof out>();
  for (const c of out) { const l = byLabel.get(c.label) ?? []; l.push(c); byLabel.set(c.label, l); }
  for (const [label, same] of byLabel) {
    if (same.length < 2) continue;
    for (const c of same) {
      const counts = new Map<string, number>();
      for (const f of c.files) {
        const p = g.files[f]!.path;
        const rest = label && label !== '.' && !label.includes(' + ') && p.startsWith(`${label}/`) ? p.slice(label.length + 1) : p;
        const seg = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest.replace(/\.[^.]+$/, '');
        counts.set(seg, (counts.get(seg) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([s]) => s);
      c.label = `${label}: ${top.join(', ')}`;
    }
  }
  // Still the same name twice: add each module's most depended-on file, which is what sets it apart.
  const seen = new Map<string, number>();
  for (const c of out) seen.set(c.label, (seen.get(c.label) ?? 0) + 1);
  for (const c of out) {
    if ((seen.get(c.label) ?? 0) < 2) continue;
    const fanIn = new Map<number, number>();
    for (const e of g.edges) if (!e.passThrough) fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
    const hub = [...c.files].sort((a, b) => (fanIn.get(b) ?? 0) - (fanIn.get(a) ?? 0))[0];
    if (hub !== undefined) c.label = `${c.label} · ${g.files[hub]!.path.split('/').pop()!.replace(/\.[^.]+$/, '')}`;
  }
  return out;
}

function louvainPass(n: number, edges: Array<[number, number, number]>): { assignment: number[]; moved: boolean } {
  const nbr: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  const k = new Float64Array(n);
  const selfLoop = new Float64Array(n);
  let m2 = 0;
  for (const [a, b, x] of edges) {
    if (a === b) { selfLoop[a]! += x; k[a]! += 2 * x; m2 += 2 * x; continue; }
    nbr[a]!.push([b, x]);
    nbr[b]!.push([a, x]);
    k[a]! += x; k[b]! += x; m2 += 2 * x;
  }
  if (m2 === 0) return { assignment: Array.from({ length: n }, (_, i) => i), moved: false };
  const comm = Array.from({ length: n }, (_, i) => i);
  const tot = Float64Array.from(k);
  let movedAny = false;
  for (let iter = 0; iter < 20; iter++) {
    let moved = false;
    for (let v = 0; v < n; v++) {
      const cv = comm[v]!;
      const links = new Map<number, number>();
      for (const [u, x] of nbr[v]!) links.set(comm[u]!, (links.get(comm[u]!) ?? 0) + x);
      tot[cv]! -= k[v]!;
      let best = cv;
      let bestGain = (links.get(cv) ?? 0) - (tot[cv]! * k[v]!) / m2;
      for (const [c, x] of links) {
        const gain = x - (tot[c]! * k[v]!) / m2;
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best && gain > 0)) { best = c; bestGain = gain; }
      }
      tot[best]! += k[v]!;
      if (best !== cv) { comm[v] = best; moved = true; movedAny = true; }
    }
    if (!moved) break;
  }
  return { assignment: comm, moved: movedAny };
}

/** A community's name: the deepest folder most of its files share. */
function labelFor(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const parts = dirOf(p).split('/').filter(Boolean);
    for (let k = 1; k <= parts.length; k++) {
      const pre = parts.slice(0, k).join('/');
      counts.set(pre, (counts.get(pre) ?? 0) + 1);
    }
  }
  let best = '';
  let bestScore = -1;
  for (const [pre, c] of counts) {
    if (c < paths.length * 0.6) continue;
    const score = pre.split('/').length;
    if (score > bestScore) { best = pre; bestScore = score; }
  }
  if (best) return best;
  // No folder holds most of them: the two most common top-level folders.
  const tops = new Map<string, number>();
  for (const p of paths) { const t = p.includes('/') ? p.slice(0, p.indexOf('/')) : '.'; tops.set(t, (tops.get(t) ?? 0) + 1); }
  return [...tops.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t).join(' + ');
}

// ── Layering rules ──────────────────────────────────────────────────────────

export interface LayerRule { from: string; to: string; reason?: string }

/** A glob (`*`, `**`, `?`) to a RegExp over forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '');
}

export interface Violation { rule: LayerRule; from: number; to: number; names: string[] }

/** Edges that break a configured "files matching `from` must not depend on files matching `to`" rule. */
export function layerViolations(g: CodeGraph, rules: LayerRule[]): Violation[] {
  const compiled = rules.map(rule => ({ rule, from: globToRegExp(rule.from), to: globToRegExp(rule.to) }));
  const out: Violation[] = [];
  for (const e of g.edges) {
    if (e.passThrough) continue;
    const a = g.files[e.from]!.path;
    const b = g.files[e.to]!.path;
    for (const c of compiled) if (c.from.test(a) && c.to.test(b)) out.push({ rule: c.rule, from: e.from, to: e.to, names: e.names });
  }
  return out;
}

// ── Architecture (communities collapsed) ────────────────────────────────────

export interface ArchEdge { a: number; b: number; weight: number }

export function architectureEdges(g: CodeGraph): ArchEdge[] {
  const comm = new Int32Array(g.files.length);
  for (const c of g.communities) for (const f of c.files) comm[f] = c.id;
  const agg = new Map<string, number>();
  for (const e of g.edges) {
    if (e.passThrough) continue;
    const a = comm[e.from]!;
    const b = comm[e.to]!;
    if (a === b) continue;
    agg.set(`${a},${b}`, (agg.get(`${a},${b}`) ?? 0) + 1);
  }
  return [...agg.entries()].map(([k, weight]) => { const [a, b] = k.split(',').map(Number); return { a: a!, b: b!, weight }; }).sort((x, y) => y.weight - x.weight);
}

/** A Mermaid flowchart of the architecture: communities and their strongest dependencies. */
export function mermaidArchitecture(g: CodeGraph, opts: { maxNodes?: number; maxEdges?: number } = {}): string {
  const maxNodes = opts.maxNodes ?? 18;
  const maxEdges = opts.maxEdges ?? 40;
  const shown = g.communities.filter(c => c.files.length > 0).slice(0, maxNodes);
  const ids = new Set(shown.map(c => c.id));
  const edges = architectureEdges(g).filter(e => ids.has(e.a) && ids.has(e.b)).slice(0, maxEdges);
  const safe = (s: string): string => s.replace(/["\n[\]{}|<>]/g, ' ').trim() || 'root';
  const lines = ['flowchart LR'];
  for (const c of shown) lines.push(`  c${c.id}["${safe(c.label)}<br/>${c.files.length} files"]`);
  for (const e of edges) lines.push(`  c${e.a} -->|${e.weight}| c${e.b}`);
  return lines.join('\n');
}
