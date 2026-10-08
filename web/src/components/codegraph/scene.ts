/**
 * What the Code map draws for a given mode: nodes and edges with colour,
 * size and emphasis, built from the view model and the current layout.
 *
 * Pure (no canvas), so each mode's meaning — which files light up for an
 * impact, which edges form a path, how a collapsed module aggregates its
 * dependencies — is unit-tested rather than eyeballed.
 *
 * Emphasis is three levels: 0 dimmed context, 1 normal, 2 the answer. A mode
 * that answers a question dims everything that is not the answer instead of
 * hiding it, so the person keeps their bearings.
 *
 * The layered Architecture and Focus views are not scenes of this kind (their
 * boxes and routed edges are flow.ts); this file draws the force-map modes,
 * including the Overview (the old Architecture bubbles).
 *
 * @module web/components/codegraph/scene
 */

import { communityColor, DEPTH_COLORS, heat, LANG_COLORS, basename, type GraphModel, type Mode } from './model';

export type Emph = 0 | 1 | 2;

export interface SceneNode {
  kind: 'file' | 'group';
  /** File id, or community id for a group. */
  ref: number;
  x: number;
  y: number;
  r: number;
  color: string;
  emph: Emph;
  label?: string;
  /** Outline colour (a cycle member, a changed file). */
  ring?: string;
  /** Files in a group (for label priority). */
  weight?: number;
}

export interface SceneEdge {
  a: number;
  b: number;
  width: number;
  emph: Emph;
  color?: string;
  dashed?: boolean;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** Scene index of a file id (files mode and expanded groups). */
  fileIndex: Map<number, number>;
}

export type ColorBy = 'module' | 'language' | 'hotspot';

export interface SceneInput {
  model: GraphModel;
  pos: Float32Array;
  mask: Uint8Array;
  mode: Mode;
  colorBy: ColorBy;
  selected: number;
  /** Communities opened in the overview. */
  expanded: Set<number>;
  /** Impact/changes/symbol: file → depth (0 = the subject). */
  depths?: Map<number, number>;
  path?: number[];
  cycle?: number[];
  /** Files in any cycle. */
  inCycle?: Set<number>;
  accent: string;
  danger: string;
  warning: string;
  muted: string;
}

export function fileRadius(loc: number, fanIn: number): number {
  return Math.min(16, 2.6 + Math.sqrt(Math.max(0, loc)) / 5 + Math.log2(1 + fanIn) * 0.9);
}

function fileColor(inp: SceneInput, id: number): string {
  const f = inp.model.file(id);
  if (inp.colorBy === 'language') return LANG_COLORS[f.lang] ?? '#94a3b8';
  if (inp.colorBy === 'hotspot') return heat(f.hotspot);
  return communityColor(f.community);
}

export function buildScene(inp: SceneInput): Scene {
  if (inp.mode === 'overview') return architectureScene(inp);
  const { model, pos, mask } = inp;
  const nodes: SceneNode[] = [];
  const fileIndex = new Map<number, number>();
  const edges: SceneEdge[] = [];
  const answer = answerSet(inp);
  for (let i = 0; i < model.n; i++) {
    if (!mask[i] && !answer?.has(i)) continue;
    const f = model.file(i);
    let color = fileColor(inp, i);
    let emph: Emph = answer ? (answer.has(i) ? 2 : 0) : 1;
    let r = fileRadius(f.loc, f.fanIn);
    let ring: string | undefined;
    if (inp.mode === 'hotspots') { color = heat(f.hotspot); r = Math.min(20, 2.5 + Math.sqrt(f.churn) * 1.6); emph = f.hotspot > 0 ? (f.hotspot > 0.25 ? 2 : 1) : 0; }
    if ((inp.mode === 'impact' || inp.mode === 'changes' || inp.mode === 'symbol') && inp.depths?.has(i)) color = DEPTH_COLORS[Math.min(DEPTH_COLORS.length - 1, inp.depths.get(i)!)]!;
    if (inp.mode === 'path' && inp.path?.includes(i)) color = inp.accent;
    if (inp.mode === 'cycles') {
      if (inp.cycle?.includes(i)) color = inp.danger;
      else if (inp.inCycle?.has(i)) { ring = inp.danger; emph = Math.max(emph, 1) as Emph; }
    }
    if (inp.mode === 'changes' && inp.depths?.get(i) === 0) ring = inp.accent;
    if (i === inp.selected) { emph = 2; ring = inp.accent; }
    fileIndex.set(i, nodes.length);
    nodes.push({ kind: 'file', ref: i, x: pos[i * 2]!, y: pos[i * 2 + 1]!, r, color, emph, label: basename(f.path), ...(ring ? { ring } : {}) });
  }

  const pathEdges = new Set<string>();
  if (inp.mode === 'path' && inp.path) for (let k = 1; k < inp.path.length; k++) pathEdges.add(`${inp.path[k - 1]},${inp.path[k]}`);
  const cycleSet = new Set(inp.cycle ?? []);
  for (const [a, b, , names, pass, inferred] of model.payload.edges) {
    if (pass) continue;
    const ia = fileIndex.get(a);
    const ib = fileIndex.get(b);
    if (ia === undefined || ib === undefined) continue;
    let emph: Emph = 1;
    let color: string | undefined;
    const w = 0.6 + Math.min(2, Math.log2(1 + names) * 0.5);
    if (inp.mode === 'cochange') emph = 0;
    else if (inp.mode === 'path') {
      if (pathEdges.has(`${a},${b}`)) { emph = 2; color = inp.accent; } else emph = 0;
    } else if (inp.mode === 'cycles') {
      if (cycleSet.has(a) && cycleSet.has(b)) { emph = 2; color = inp.danger; } else emph = 0;
    } else if (inp.depths && (inp.mode === 'impact' || inp.mode === 'changes' || inp.mode === 'symbol')) {
      const da = inp.depths.get(a);
      const db = inp.depths.get(b);
      if (da !== undefined && db !== undefined && da === db + 1) { emph = 2; color = DEPTH_COLORS[Math.min(DEPTH_COLORS.length - 1, da)]; } else emph = 0;
    } else if (inp.selected >= 0) {
      if (a === inp.selected) { emph = 2; color = inp.accent; } else if (b === inp.selected) { emph = 2; color = inp.warning; } else emph = 0;
    } else if (inp.mode === 'hotspots') emph = 0;
    edges.push({ a: ia, b: ib, width: inferred ? w * 0.8 : w, emph, ...(color ? { color } : {}), ...(inferred ? { dashed: true } : {}) });
  }

  if (inp.mode === 'cochange') {
    const linked = new Set(model.payload.edges.map(e => `${Math.min(e[0], e[1])},${Math.max(e[0], e[1])}`));
    for (const [a, b, count, conf] of model.payload.cochange) {
      if (inp.selected >= 0 && a !== inp.selected && b !== inp.selected) continue;
      const ia = fileIndex.get(a);
      const ib = fileIndex.get(b);
      if (ia === undefined || ib === undefined) continue;
      const hidden = !linked.has(`${Math.min(a, b)},${Math.max(a, b)}`);
      edges.push({ a: ia, b: ib, width: 0.6 + Math.min(3, count * 0.3), emph: hidden ? 2 : 1, color: hidden ? inp.warning : inp.muted, dashed: true });
      if (conf >= 0.5) { nodes[ia]!.emph = Math.max(nodes[ia]!.emph, 1) as Emph; nodes[ib]!.emph = Math.max(nodes[ib]!.emph, 1) as Emph; }
      if (hidden) { nodes[ia]!.emph = 2; nodes[ib]!.emph = 2; }
    }
  }
  return { nodes, edges, fileIndex };
}

/** The files a mode's answer consists of, or undefined when nothing is singled out. */
function answerSet(inp: SceneInput): Set<number> | undefined {
  switch (inp.mode) {
    case 'impact':
    case 'changes':
    case 'symbol':
      return inp.depths && inp.depths.size ? new Set(inp.depths.keys()) : undefined;
    case 'path':
      return inp.path?.length ? new Set(inp.path) : undefined;
    case 'cycles':
      return inp.cycle?.length ? new Set(inp.cycle) : inp.inCycle?.size ? inp.inCycle : undefined;
    case 'cochange':
      return new Set(inp.model.payload.cochange.flatMap(([a, b]) => (inp.selected < 0 || a === inp.selected || b === inp.selected ? [a, b] : [])));
    case 'files':
      if (inp.selected < 0) return undefined;
      return new Set([inp.selected, ...inp.model.out[inp.selected]!, ...inp.model.inn[inp.selected]!]);
    default:
      return undefined;
  }
}

function architectureScene(inp: SceneInput): Scene {
  const { model, pos, mask } = inp;
  const { groups } = model.architecture(mask);
  const nodes: SceneNode[] = [];
  const fileIndex = new Map<number, number>();
  const groupIndex = new Map<number, number>();
  for (const g of groups) {
    if (inp.expanded.has(g.id)) {
      for (const f of g.files) {
        const file = model.file(f);
        fileIndex.set(f, nodes.length);
        nodes.push({ kind: 'file', ref: f, x: pos[f * 2]!, y: pos[f * 2 + 1]!, r: fileRadius(file.loc, file.fanIn), color: communityColor(g.id), emph: f === inp.selected ? 2 : 1, label: basename(file.path), ...(f === inp.selected ? { ring: inp.accent } : {}) });
      }
      continue;
    }
    let x = 0; let y = 0;
    for (const f of g.files) { x += pos[f * 2]!; y += pos[f * 2 + 1]!; }
    groupIndex.set(g.id, nodes.length);
    const cx = x / g.files.length;
    const cy = y / g.files.length;
    // The bubble covers the area its files occupy in the file view, so modes agree on where things are.
    let spread = 0;
    for (const f of g.files) spread += (pos[f * 2]! - cx) ** 2 + (pos[f * 2 + 1]! - cy) ** 2;
    const r = Math.max(7 + Math.sqrt(g.files.length) * 3.4, Math.sqrt(spread / g.files.length) * 0.85);
    nodes.push({ kind: 'group', ref: g.id, x: cx, y: cy, r, color: communityColor(g.id), emph: 1, label: `${shortLabel(g.label)} · ${g.files.length}`, weight: g.files.length });
  }
  const agg = new Map<string, number>();
  for (const [a, b, , , pass] of model.payload.edges) {
    if (pass || !mask[a] || !mask[b]) continue;
    const sa = fileIndex.get(a) ?? groupIndex.get(model.file(a).community);
    const sb = fileIndex.get(b) ?? groupIndex.get(model.file(b).community);
    if (sa === undefined || sb === undefined || sa === sb) continue;
    const key = `${sa},${sb}`;
    agg.set(key, (agg.get(key) ?? 0) + 1);
  }
  const edges: SceneEdge[] = [...agg.entries()].map(([k, count]) => {
    const [a, b] = k.split(',').map(Number);
    return { a: a!, b: b!, width: 0.7 + Math.min(6, Math.log2(1 + count) * 0.9), emph: 1 as Emph };
  });
  return { nodes, edges, fileIndex };
}

/** A module name short enough to sit on its bubble: the last two folders of a long path. */
export function shortLabel(label: string): string {
  if (label.length <= 28) return label;
  const [head, tail] = label.split(': ');
  const parts = head!.split('/');
  const short = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : head!;
  const text = tail ? `${short}: ${tail}` : short;
  return text.length > 34 ? `${text.slice(0, 33)}…` : text;
}
