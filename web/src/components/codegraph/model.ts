/**
 * The Code map's view model: the engine's graph payload (src/codegraph/view)
 * turned into what a picture needs — adjacency, filters, impact layers, paths,
 * search, the overview (communities collapsed), colours, and SVG export. The
 * layered Architecture and Focus views are built in modules.ts / flow.ts.
 *
 * Pure: no DOM, no React, no fetch, so the web unit suite runs it as is and
 * the desktop page, the web workspace page and any later client share one
 * set of answers. The engine stays the authority for anything about symbols
 * (who uses `formatAmount`); this module only re-derives what the payload's
 * file edges already say, so the picture and the agent never disagree.
 *
 * @module web/components/codegraph/model
 */

export interface CgFile {
  path: string;
  lang: string;
  loc: number;
  size: number;
  fanIn: number;
  fanOut: number;
  churn: number;
  hotspot: number;
  community: number;
  test?: 1;
  entry?: string;
  exports: number;
}

/** [from, to, kind code, symbols used, passThrough 0/1, inferred 0/1, through an interface 0/1] — engine EDGE_KIND_CODE. */
export type CgEdge = [number, number, number, number, number, number, number?];

export interface CgPayload {
  version: string;
  root: string;
  builtAt: number;
  files: CgFile[];
  edges: CgEdge[];
  communities: Array<{ id: number; label: string; files: number[] }>;
  cochange: Array<[number, number, number, number]>;
  cycles: number[][];
  orphans: number[];
  violations: Array<{ from: number; to: number; rule: string }>;
  external: Array<[string, number]>;
  git: { available: boolean; head?: string; commits: number; skippedLarge: number };
  stats: {
    indexed: number; parsed: number; skipped: number; truncated: boolean; buildMs: number; resolveMs: number;
    /** How TS/JS method calls were resolved (engine codegraph/ts-check). */
    methods?: { ts: 'checker' | 'lexical' | 'pending'; note?: string; calls: number };
  };
  implementations?: { total: number; structural: number };
}

/** One interface → implementation pair, with why (engine codegraph/view ImplView). */
export interface CgImpl {
  iface: { id: number; name: string };
  impl: { id: number; name: string };
  how: 'declared' | 'structural';
  pointer?: boolean;
  methods: Array<{ name: string; id: number; line: number; ptr?: boolean }>;
  why: string;
}

export interface CgFileDetail {
  id: number;
  path: string;
  lang: string;
  loc: number;
  size: number;
  entry?: string;
  test: boolean;
  churn: number;
  hotspot: number;
  community: string;
  authors: Array<[string, number]>;
  exports: Array<{ name: string; kind: string; line: number; sig: string; users: number }>;
  importers: Array<{ id: number; names: string[]; kind: string; inferred: boolean; viaInterface?: boolean }>;
  imports: Array<{ id: number; names: string[]; kind: string; inferred: boolean; viaInterface?: boolean }>;
  implementedBy?: CgImpl[];
  implementing?: CgImpl[];
  external: string[];
  cochange: Array<{ id: number; count: number; confidence: number }>;
  commits: Array<{ hash: string; at: number; author: string; subject: string }>;
}

export interface CgSymbolDetail {
  file: number;
  name: string;
  sig?: string;
  line?: number;
  kind?: string;
  users: Array<{ id: number; local: string; lines: number[]; via: string }>;
  /** Users found exactly on demand by the TypeScript language service, or that attempt timed out (partial). */
  exactness?: { mode: 'on-demand' | 'partial'; ms: number; cached: boolean; note?: string };
  implementations?: CgImpl[];
  implementing?: CgImpl[];
}

export const EDGE_KINDS = ['import', 'reexport', 'package', 'inferred', 'dynamic', 'call'] as const;

export type Mode = 'architecture' | 'focus' | 'overview' | 'files' | 'impact' | 'path' | 'cycles' | 'hotspots' | 'cochange' | 'changes' | 'symbol';

export const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'architecture', label: 'Architecture', hint: 'Folders as boxes, dependents above what they depend on; click one to open it' },
  { id: 'focus', label: 'Focus', hint: 'One file in the middle: who uses it on the left, what it uses on the right' },
  { id: 'overview', label: 'Overview', hint: 'Every module as a bubble on a force-directed map' },
  { id: 'files', label: 'Files', hint: 'Every file and its imports' },
  { id: 'impact', label: 'Impact', hint: 'What depends on the selection, by distance' },
  { id: 'path', label: 'Path', hint: 'How one file reaches another' },
  { id: 'cycles', label: 'Cycles', hint: 'Import cycles' },
  { id: 'hotspots', label: 'Hotspots', hint: 'Recent churn × importers × size' },
  { id: 'cochange', label: 'Co-change', hint: 'Files that change together in git, import or not' },
  { id: 'changes', label: 'Changes', hint: 'What your uncommitted change affects' },
  { id: 'symbol', label: 'Symbol', hint: 'Who uses one exported symbol' },
];

export interface Filters {
  /** Languages shown; empty = all. */
  langs: string[];
  hideTests: boolean;
  /** Hide vendored, generated and template folders. */
  hideVendor: boolean;
  /** Only files under this folder (prefix); empty = all. */
  folder: string;
  /** Hide every link that rests on an interface or a unique name: only what is certain. */
  exactOnly: boolean;
}

export const DEFAULT_FILTERS: Filters = { langs: [], hideTests: false, hideVendor: true, folder: '', exactOnly: false };

/** The payload without inferred edges (through an interface, or a unique name in scope). */
export function exactPayload(p: CgPayload): CgPayload {
  return { ...p, edges: p.edges.filter(e => !e[5]) };
}

/** Users of a symbol, split into certain ones and those only reached through an interface. */
export function splitUsers(users: CgSymbolDetail['users'], exactOnly: boolean): { direct: CgSymbolDetail['users']; viaInterface: CgSymbolDetail['users']; reexports: CgSymbolDetail['users'] } {
  const certain = (u: { via: string }): boolean => u.via !== 'interface' && u.via !== 'inferred';
  return {
    direct: users.filter(u => u.via !== 'reexport' && u.via !== 'interface' && (!exactOnly || certain(u))),
    viaInterface: exactOnly ? [] : users.filter(u => u.via === 'interface'),
    reexports: users.filter(u => u.via === 'reexport'),
  };
}

const VENDOR = /(^|\/)(vendor|third[_-]?party|generated|__generated__|gen|templates?|fixtures?|examples?|chunks|media\/chunks)\//i;

export class GraphModel {
  readonly payload: CgPayload;
  readonly n: number;
  /** Dependency adjacency (pass-through barrel imports excluded). */
  readonly out: number[][];
  readonly inn: number[][];
  readonly langs: string[];
  private readonly lowerPaths: string[];

  constructor(payload: CgPayload) {
    this.payload = payload;
    this.n = payload.files.length;
    this.out = Array.from({ length: this.n }, () => []);
    this.inn = Array.from({ length: this.n }, () => []);
    for (const [a, b, , , pass] of payload.edges) {
      if (pass) continue;
      this.out[a]!.push(b);
      this.inn[b]!.push(a);
    }
    this.langs = [...new Set(payload.files.map(f => f.lang))].sort();
    this.lowerPaths = payload.files.map(f => f.path.toLowerCase());
  }

  file(id: number): CgFile { return this.payload.files[id]!; }

  /** 1 where a file passes the filters. */
  visible(f: Filters): Uint8Array {
    const mask = new Uint8Array(this.n);
    const folder = f.folder.replace(/^\.?\/+|\/+$/g, '').toLowerCase();
    for (let i = 0; i < this.n; i++) {
      const file = this.payload.files[i]!;
      if (f.langs.length && !f.langs.includes(file.lang)) continue;
      if (f.hideTests && file.test) continue;
      if (f.hideVendor && VENDOR.test(file.path)) continue;
      if (folder && !this.lowerPaths[i]!.startsWith(`${folder}/`) && this.lowerPaths[i] !== folder) continue;
      mask[i] = 1;
    }
    return mask;
  }

  /** Dependents of `seeds` by distance (1 = imports a seed directly). Seeds are depth 0. */
  impact(seeds: number[], maxDepth: number, firstLayer?: number[]): Map<number, number> {
    const depth = new Map<number, number>();
    for (const s of seeds) depth.set(s, 0);
    let frontier = seeds;
    for (let d = 1; d <= maxDepth; d++) {
      const next: number[] = [];
      const source = d === 1 && firstLayer ? firstLayer : frontier.flatMap(f => this.inn[f]!);
      for (const x of source) {
        if (depth.has(x)) continue;
        depth.set(x, d);
        next.push(x);
      }
      if (!next.length) break;
      frontier = next;
    }
    return depth;
  }

  /** Shortest directed dependency path a → b, or undefined (never undirected). */
  path(a: number, b: number): number[] | undefined {
    if (a === b) return [a];
    const prev = new Int32Array(this.n).fill(-2);
    prev[a] = -1;
    const queue = [a];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi]!;
      for (const nx of this.out[cur]!) {
        if (prev[nx] !== -2) continue;
        prev[nx] = cur;
        if (nx === b) {
          const path = [b];
          let p = cur;
          while (p !== -1) { path.push(p); p = prev[p]!; }
          return path.reverse();
        }
        queue.push(nx);
      }
    }
    return undefined;
  }

  /**
   * Files matching a query: the basename first, then a path prefix, then a
   * subsequence (`fmtcur` finds `format/currency.ts`). Ranked, bounded.
   */
  search(query: string, limit = 12): number[] {
    const q = query.trim().toLowerCase().replace(/\\/g, '/');
    if (!q) return [];
    const scored: Array<[number, number]> = [];
    for (let i = 0; i < this.n; i++) {
      const p = this.lowerPaths[i]!;
      const base = p.slice(p.lastIndexOf('/') + 1);
      let s = 0;
      if (base === q || p === q) s = 100;
      else if (base.startsWith(q)) s = 80 - base.length / 100;
      else if (p.endsWith(q)) s = 70;
      else if (base.includes(q)) s = 60 - base.indexOf(q);
      else if (p.includes(q)) s = 40 - p.indexOf(q) / 100;
      else if (subsequence(q, p)) s = 10 - p.length / 1000;
      if (s > 0) scored.push([i, s + Math.min(5, this.payload.files[i]!.fanIn / 20)]);
    }
    return scored.sort((x, y) => y[1] - x[1]).slice(0, limit).map(([i]) => i);
  }

  /** Communities as nodes, dependencies between them aggregated. */
  architecture(mask?: Uint8Array): { groups: Array<{ id: number; label: string; files: number[] }>; links: Array<{ a: number; b: number; weight: number }> } {
    const groups = this.payload.communities
      .map(c => ({ id: c.id, label: c.label, files: mask ? c.files.filter(f => mask[f]) : c.files }))
      .filter(c => c.files.length > 0);
    const agg = new Map<string, number>();
    for (const [a, b, , , pass] of this.payload.edges) {
      if (pass || (mask && (!mask[a] || !mask[b]))) continue;
      const ca = this.payload.files[a]!.community;
      const cb = this.payload.files[b]!.community;
      if (ca === cb) continue;
      const key = `${ca},${cb}`;
      agg.set(key, (agg.get(key) ?? 0) + 1);
    }
    const links = [...agg.entries()].map(([k, weight]) => { const [a, b] = k.split(',').map(Number); return { a: a!, b: b!, weight }; });
    return { groups, links };
  }

  /** Mermaid flowchart of the architecture (what the engine's `CodeGraph diagram` returns). */
  mermaid(maxNodes = 18): string {
    const { groups, links } = this.architecture();
    const shown = groups.slice(0, maxNodes);
    const ids = new Set(shown.map(g => g.id));
    const safe = (s: string): string => s.replace(/["\n[\]{}|<>]/g, ' ').trim() || 'root';
    const lines = ['flowchart LR', ...shown.map(g => `  c${g.id}["${safe(g.label)}<br/>${g.files.length} files"]`)];
    for (const l of links.filter(x => ids.has(x.a) && ids.has(x.b)).sort((x, y) => y.weight - x.weight).slice(0, 40)) lines.push(`  c${l.a} -->|${l.weight}| c${l.b}`);
    return lines.join('\n');
  }

  /** The neighbour of `from` in a screen direction, for arrow-key navigation. */
  neighbourInDirection(from: number, dx: number, dy: number, pos: Float32Array, mask?: Uint8Array): number | undefined {
    const cands = [...new Set([...this.out[from]!, ...this.inn[from]!])].filter(c => !mask || mask[c]);
    const pool = cands.length ? cands : [...Array(this.n).keys()].filter(i => i !== from && (!mask || mask[i]));
    const x0 = pos[from * 2]!;
    const y0 = pos[from * 2 + 1]!;
    let best: number | undefined;
    let bestScore = Infinity;
    for (const c of pool) {
      const vx = pos[c * 2]! - x0;
      const vy = pos[c * 2 + 1]! - y0;
      const dist = Math.hypot(vx, vy) || 1e-6;
      const cos = (vx * dx + vy * dy) / dist;
      if (cos < 0.35) continue;
      const score = dist / (cos * cos);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }
}

function subsequence(q: string, s: string): boolean {
  let j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) if (s[i] === q[j]) j++;
  return j === q.length;
}

// ── Colour ──────────────────────────────────────────────────────────────────

/** A categorical palette readable on light and dark backgrounds. */
export const CATEGORICAL = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#b07aa1', '#edc948', '#9c755f', '#ff9da7', '#5fa2ce', '#8cd17d', '#d37295', '#a0cbe8', '#c49c94', '#86bcb6', '#d4a6c8'];

export const LANG_COLORS: Record<string, string> = {
  ts: '#3178c6', js: '#e8b400', py: '#3e7cb1', go: '#00a7d0', java: '#e76f00', kotlin: '#a97bff', cs: '#68217a', php: '#777bb4', rb: '#cc342d', rs: '#c46a2a',
};

export function communityColor(id: number): string {
  return CATEGORICAL[((id % CATEGORICAL.length) + CATEGORICAL.length) % CATEGORICAL.length]!;
}

/** Sequential heat for t in [0, 1]: cool grey-blue → amber → red. */
export function heat(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  const stops: Array<[number, [number, number, number]]> = [[0, [148, 163, 184]], [0.35, [250, 204, 21]], [0.7, [249, 115, 22]], [1, [220, 38, 38]]];
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1]![0]) i++;
  const [t0, c0] = stops[i]!;
  const [t1, c1] = stops[i + 1]!;
  const u = (x - t0) / (t1 - t0 || 1);
  const c = c0.map((v, k) => Math.round(v + (c1[k]! - v) * u));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Impact depth colours: the selection, then near-to-far. */
export const DEPTH_COLORS = ['#2563eb', '#dc2626', '#f97316', '#eab308', '#a3a3a3'];

// ── Export ──────────────────────────────────────────────────────────────────

export interface SvgNode { x: number; y: number; r: number; color: string; label?: string; dim?: boolean }
export interface SvgEdge { a: number; b: number; color: string; width: number; dashed?: boolean; dim?: boolean }

/** A standalone SVG of what is on screen (nodes and edges in world coordinates). */
export function toSvg(nodes: SvgNode[], edges: SvgEdge[], theme: { bg: string; fg: string }, title: string): string {
  if (!nodes.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><text x="10" y="40">${esc(title)}: nothing to show</text></svg>`;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x - n.r); minY = Math.min(minY, n.y - n.r); maxX = Math.max(maxX, n.x + n.r); maxY = Math.max(maxY, n.y + n.r); }
  const pad = 40;
  const w = Math.ceil(maxX - minX + pad * 2);
  const h = Math.ceil(maxY - minY + pad * 2 + 24);
  const tx = (x: number): string => (x - minX + pad).toFixed(1);
  const ty = (y: number): string => (y - minY + pad + 24).toFixed(1);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="Inter, system-ui, sans-serif">`,
    `<rect width="100%" height="100%" fill="${theme.bg}"/>`,
    `<text x="${pad}" y="22" font-size="14" font-weight="600" fill="${theme.fg}">${esc(title)}</text>`];
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    if (!a || !b) continue;
    parts.push(`<line x1="${tx(a.x)}" y1="${ty(a.y)}" x2="${tx(b.x)}" y2="${ty(b.y)}" stroke="${e.color}" stroke-width="${e.width}" stroke-opacity="${e.dim ? 0.12 : 0.55}"${e.dashed ? ' stroke-dasharray="4 3"' : ''}/>`);
  }
  for (const n of nodes) {
    parts.push(`<circle cx="${tx(n.x)}" cy="${ty(n.y)}" r="${n.r.toFixed(1)}" fill="${n.color}" fill-opacity="${n.dim ? 0.25 : 0.95}"/>`);
    if (n.label) parts.push(`<text x="${tx(n.x)}" y="${(Number(ty(n.y)) + n.r + 11).toFixed(1)}" font-size="10" text-anchor="middle" fill="${theme.fg}" fill-opacity="${n.dim ? 0.4 : 0.9}">${esc(n.label)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** "Ask AICO about this": a chat prompt carrying the selection and its neighbourhood. */
export function askPrompt(context: string, what: string): string {
  return `About ${what} in this project — the code graph says:\n\n${context.trim()}\n\n`;
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
