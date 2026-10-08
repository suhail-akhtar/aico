/**
 * Modules for the Code map's Architecture view: the folder tree of the
 * visible files, cut at a depth that gives a readable number of boxes, and
 * opened one box at a time.
 *
 * ## Why folders, not the engine's communities
 *
 * The payload's `communities` are label-propagation clusters named after
 * their most common folder. On a real repository the biggest one is simply
 * "src" with a third of the files in it, and two of its neighbours are "src"
 * and "src/codegraph" — names that do not tell a person where anything is.
 * Folders are what people already navigate by, so the architecture is drawn
 * with them: a long single-child chain (`a/b/c`) is one box, the largest box is
 * split into its sub-folders until there are about √files of them, and a
 * folder's loose files travel together as one "files" box.
 *
 * Pure (no DOM, no layout): the cut and the aggregation are unit-tested, the
 * drawing is flow.ts.
 *
 * @module web/components/codegraph/modules
 */

import { basename, dirname, type GraphModel } from './model';

/** One folder (or a folder's loose files) in the tree. */
export interface TNode {
  /** Unique: the folder path, or `<path>#files` for its loose files. */
  key: string;
  path: string;
  /** This folder's name below its parent; `a/b` when single-child folders were merged. */
  name: string;
  /** Every file below, including sub-folders'. */
  files: number[];
  /** Files directly in this folder. */
  direct: number[];
  kids: TNode[];
  loose?: boolean;
}

/** One box on the map: a module, or (once opened far enough) a single file. */
export interface Unit {
  key: string;
  kind: 'module' | 'file';
  title: string;
  sub: string;
  files: number[];
  /** The file id (files only). */
  file: number;
  /** First path segment, for colour. */
  top: string;
  /** Appeared by opening a module just now. */
  fresh?: boolean;
}

export class ModuleTree {
  readonly root: TNode;
  readonly byKey = new Map<string, TNode>();
  /** Folder path (as in `TNode.key` chain) per file, root first. */
  private readonly chain = new Map<number, string[]>();

  constructor(model: GraphModel, mask?: Uint8Array) {
    interface Raw { name: string; path: string; kids: Map<string, Raw>; direct: number[] }
    const rawRoot: Raw = { name: '', path: '', kids: new Map(), direct: [] };
    for (let i = 0; i < model.n; i++) {
      if (mask && !mask[i]) continue;
      const segs = model.file(i).path.split('/');
      segs.pop();
      let node = rawRoot;
      for (const s of segs) {
        let kid = node.kids.get(s);
        if (!kid) { kid = { name: s, path: node.path ? `${node.path}/${s}` : s, kids: new Map(), direct: [] }; node.kids.set(s, kid); }
        node = kid;
      }
      node.direct.push(i);
    }
    const convert = (raw: Raw, isRoot: boolean): TNode => {
      let cur = raw;
      let name = raw.name;
      // a/b/c with nothing else in a or b is one box.
      while (!isRoot && cur.kids.size === 1 && cur.direct.length === 0) {
        cur = [...cur.kids.values()][0]!;
        name = `${name}/${cur.name}`;
      }
      const kids = [...cur.kids.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(k => convert(k, false));
      const direct = cur.direct;
      const files = [...direct];
      for (const k of kids) for (const f of k.files) files.push(f);
      const node: TNode = { key: cur.path, path: cur.path, name, files, direct, kids };
      this.byKey.set(node.key, node);
      return node;
    };
    this.root = convert(rawRoot, true);
    const walk = (n: TNode, trail: string[]): void => {
      const here = n === this.root ? trail : [...trail, n.key];
      for (const f of n.direct) this.chain.set(f, here);
      for (const k of n.kids) walk(k, here);
    };
    walk(this.root, []);
  }

  /** The loose files of a folder as a node of their own (cached by key). */
  looseOf(n: TNode): TNode {
    const key = `${n.path}#files`;
    let l = this.byKey.get(key);
    if (!l) {
      l = { key, path: n.path, name: n === this.root ? 'root files' : `${basename(n.path)} (files)`, files: n.direct, direct: n.direct, kids: [], loose: true };
      this.byKey.set(key, l);
    }
    return l;
  }

  /** Folder keys that contain the file, outermost first (the keys to open to reveal it). */
  ancestors(file: number): string[] {
    const trail = this.chain.get(file) ?? [];
    const out: string[] = [];
    for (const k of trail) out.push(k);
    // The loose-files box of its own folder is the last thing to open.
    const last = trail[trail.length - 1];
    out.push(`${last ?? ''}#files`);
    return out;
  }
}

const LOOSE_AT_MOST_SHOWN = 6;

/** The first folder of a path ("root" for a file at the top), the key a box is coloured by. */
export function topOf(path: string): string {
  const i = path.indexOf('/');
  return i < 0 ? 'root' : path.slice(0, i);
}

function moduleUnit(n: TNode, fresh?: boolean): Unit {
  const parent = n.loose ? n.path : n.path.slice(0, Math.max(0, n.path.length - n.name.length - 1));
  const count = `${n.files.length} file${n.files.length === 1 ? '' : 's'}`;
  return {
    key: n.key, kind: 'module', title: n.name, sub: parent ? `${parent} · ${count}` : count, files: n.files, file: -1,
    top: topOf(n.path), ...(fresh ? { fresh } : {}),
  };
}

function fileUnit(model: GraphModel, id: number, fresh?: boolean): Unit {
  const f = model.file(id);
  return { key: `f${id}`, kind: 'file', title: basename(f.path), sub: dirname(f.path), files: [id], file: id, top: topOf(f.path), ...(fresh ? { fresh } : {}) };
}

/** What a module turns into when opened: its sub-folders, and its loose files (few: one by one; many: as a box). */
export function expandUnit(tree: ModuleTree, model: GraphModel, key: string, fresh = true): Unit[] {
  const n = tree.byKey.get(key);
  if (!n) return [];
  const out: Unit[] = n.kids.map(k => moduleUnit(k, fresh));
  if (n.direct.length) {
    if (n.loose || n.kids.length === 0 || n.direct.length <= LOOSE_AT_MOST_SHOWN) for (const f of n.direct) out.push(fileUnit(model, f, fresh));
    else out.push(moduleUnit(tree.looseOf(n), fresh));
  }
  return out;
}

/** About half a √files boxes (8 to 20: what fits on a screen with its names readable), by splitting the biggest splittable folder again and again. */
export function autoCut(tree: ModuleTree): Unit[] {
  const total = tree.root.files.length;
  const target = Math.max(8, Math.min(20, Math.round(Math.sqrt(total) * 0.45)));
  let nodes: TNode[] = [];
  const rootUnits = (): TNode[] => {
    const r = tree.root;
    const list = [...r.kids];
    if (r.direct.length) list.push(tree.looseOf(r));
    return list;
  };
  nodes = rootUnits();
  // Split the biggest box that can be split without blowing the budget (a folder with 25 sub-folders
  // would turn a readable map into a hairball: it stays one box, and opening it shows them).
  const dead = new Set<string>();
  for (let guard = 0; guard < 200 && nodes.length < target; guard++) {
    let pick = -1;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.loose || n.kids.length === 0 || n.files.length < 14 || dead.has(n.key)) continue;
      if (nodes.length - 1 + n.kids.length + (n.direct.length ? 1 : 0) > target + 3) { dead.add(n.key); continue; }
      if (pick < 0 || n.files.length > nodes[pick]!.files.length) pick = i;
    }
    if (pick < 0) break;
    const n = nodes[pick]!;
    const parts = [...n.kids];
    if (n.direct.length) parts.push(tree.looseOf(n));
    nodes = [...nodes.slice(0, pick), ...parts, ...nodes.slice(pick + 1)];
  }
  return nodes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.loose ? -1 : 1)).map(n => moduleUnit(n));
}

/** The boxes on screen: the automatic cut with each opened module replaced by its contents, in order. */
export function cutFor(tree: ModuleTree, model: GraphModel, open: string[]): Unit[] {
  let units = autoCut(tree);
  for (let i = 0; i < open.length; i++) {
    const at = units.findIndex(u => u.kind === 'module' && u.key === open[i]);
    if (at < 0) continue;
    const kids = expandUnit(tree, model, open[i]!, i === open.length - 1);
    units = [...units.slice(0, at), ...kids, ...units.slice(at + 1)];
  }
  // Two boxes with one name ("shared" in desktop and at the top) are told apart by their path.
  const seen = new Map<string, number>();
  for (const u of units) seen.set(u.title, (seen.get(u.title) ?? 0) + 1);
  return units.map(u => {
    if (u.kind !== 'module' || (seen.get(u.title) ?? 0) < 2) return u;
    const node = tree.byKey.get(u.key);
    const path = node?.path ?? u.title;
    const segs = path.split('/');
    return { ...u, title: node?.loose ? `${segs.slice(-2).join('/')} (files)` : segs.slice(-2).join('/') };
  });
}

export interface UnitEdge { a: number; b: number; count: number }

/** Dependencies between boxes, summed: how many file-to-file imports cross from one to the other. */
export function aggregateEdges(model: GraphModel, mask: Uint8Array | undefined, units: Unit[]): UnitEdge[] {
  const unitOf = new Int32Array(model.n).fill(-1);
  units.forEach((u, i) => { for (const f of u.files) unitOf[f] = i; });
  const U = units.length;
  const sums = new Map<number, number>();
  for (const [a, b, , , pass] of model.payload.edges) {
    if (pass || (mask && (!mask[a] || !mask[b]))) continue;
    const ua = unitOf[a]!;
    const ub = unitOf[b]!;
    if (ua < 0 || ub < 0 || ua === ub) continue;
    const k = ua * U + ub;
    sums.set(k, (sums.get(k) ?? 0) + 1);
  }
  const out: UnitEdge[] = [];
  for (const [k, count] of sums) out.push({ a: Math.floor(k / U), b: k % U, count });
  return out.sort((x, y) => (x.a - y.a) || (x.b - y.b));
}
