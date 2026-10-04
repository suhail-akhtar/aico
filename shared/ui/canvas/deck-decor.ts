/**
 * Theme motifs and generated illustrations — the decoration a deck carries
 * beyond its text: each theme's signature motif (waves, shards, an arch, corner
 * triangles, a dot grid, soft blobs, stripes) and the vector scenes (landscape,
 * city, network, data, people, a civic building, water) that stand in for a
 * picture the deck does not have.
 *
 * ## Why motifs are placed around the text, not drawn at fixed spots
 *
 * Commercial templates the owner showed draw their decoration at fixed spots
 * and, with a longer title or a section label, it runs under the words (a
 * kicker on top of a wave, a subtitle cut by a band). Here a motif is placed
 * *after* the slide's text: {@link decorShapes} is given every box that must
 * stay clear (text, pictures, content) and tries the motif's anchors (bottom
 * band, right side, a corner) at shrinking sizes until no shape touches one —
 * a real polygon/rectangle intersection, not bounding boxes. If nothing fits,
 * it draws the small corner variant, and if even that does not fit, nothing:
 * decoration is never worth an overlap. The layout engine also checks the
 * result (`deck-layout.ts` `overlapChecks`), so a regression is a reported
 * problem, not a quiet one.
 *
 * ## Why illustrations are polygons clipped to the cut
 *
 * An empty picture slot used to be an abstract gradient: fine, but it says
 * nothing. A small vector scene picked from the slide's words (a water
 * programme gets water, a ministry gets a building) says something, costs
 * nothing, needs no licence or credit, and stays editable: every element is a
 * freeform (`a:custGeom`) in theme colours, clipped (Sutherland–Hodgman, every
 * cut is convex) to the picture's circle, hexagon, diagonal or rounded outline,
 * so PowerPoint and the editor draw exactly the same thing.
 *
 * It deliberately does not draw people's faces, text or logos, does not use
 * colours outside the theme's slots, and is not a substitute for a real
 * picture the person asks for.
 *
 * @module shared/ui/canvas/deck-decor
 */

import type { Box } from './deck-layout';
import type { ColorRef, Decor } from './deck-themes';
import { clipToRect, polyPath, type Pt } from './deck-geometry';

/** One decorative shape: an absolute polygon (or open stroke) on the slide. */
export interface DecorShape {
  name: string;
  /** Absolute slide points (for a multi-part shape: the outline that must stay clear). */
  pts: Pt[];
  /** Several disjoint polygons drawn as one freeform (a dot grid); `pts` is then their hull for the clearance test. */
  parts?: Pt[][];
  /** Leave the path open (a stroked arc). */
  open?: boolean;
  fill?: ColorRef;
  line?: { color: ColorRef; w: number };
}

export interface DecorRequest {
  /** Where the motif may go (the slide, or inside a frame). */
  bounds: Box;
  /** Boxes no motif shape may touch. */
  protect: Box[];
  /** Light tints (on a coloured or gradient field) or accent tints (on a plain background). */
  light: boolean;
  /** Content slides: only the small corner variant. */
  small: boolean;
}

/** Clearance between a motif and any protected box, points. */
export const DECOR_PAD = 10;

// ── Geometry ─────────────────────────────────────────────────────────

function ellipsePts(cx: number, cy: number, rx: number, ry: number, n = 40): Pt[] {
  return Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((i / n) * Math.PI * 2), cy + ry * Math.sin((i / n) * Math.PI * 2)] as Pt);
}

function segHit(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a); const d2 = o(c, d, b); const d3 = o(a, b, c); const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function inPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!; const [xj, yj] = poly[j]!;
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Does a polygon touch a rectangle (any vertex inside, any corner inside, or crossing edges)? */
export function polyHitsBox(poly: Pt[], b: Box): boolean {
  if (poly.length < 2) return false;
  const xs = poly.map(p => p[0]); const ys = poly.map(p => p[1]);
  if (Math.max(...xs) <= b.x || Math.min(...xs) >= b.x + b.w || Math.max(...ys) <= b.y || Math.min(...ys) >= b.y + b.h) return false;
  if (poly.some(([x, y]) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h)) return true;
  const rc: Pt[] = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
  if (poly.length >= 3 && rc.some(p => inPoly(p, poly))) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!; const c = poly[(i + 1) % poly.length]!;
    for (let k = 0; k < 4; k++) if (segHit(a, c, rc[k]!, rc[(k + 1) % 4]!)) return true;
  }
  return false;
}

/** Clip a polygon to a convex polygon (Sutherland–Hodgman); the clip may run either way round. */
export function clipConvex(poly: Pt[], clip: Pt[]): Pt[] {
  let area = 0;
  for (let i = 0; i < clip.length; i++) { const a = clip[i]!; const b = clip[(i + 1) % clip.length]!; area += a[0] * b[1] - b[0] * a[1]; }
  const sign = area >= 0 ? 1 : -1;
  let out = poly;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i]!; const b = clip[(i + 1) % clip.length]!;
    const side = (p: Pt): number => sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const cut = (p: Pt, q: Pt): Pt => { const sp = side(p); const t = sp / (sp - side(q)); return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; };
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j]!; const prev = input[(j + input.length - 1) % input.length]!;
      if (side(cur) >= 0) { if (side(prev) < 0) out.push(cut(prev, cur)); out.push(cur); }
      else if (side(prev) >= 0) out.push(cut(prev, cur));
    }
  }
  return out;
}

/** Seeded pseudo-random numbers (the same slide always gets the same drawing). */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x6d2b79f5) >>> 0; return (h % 10000) / 10000; };
}

/** A shape as a frame-relative path: its bounding box and the path inside it. */
export function toFramePath(s: DecorShape): { box: Box; path: string } {
  const all = s.parts ? s.parts.flat() : s.pts;
  const xs = all.map(p => p[0]); const ys = all.map(p => p[1]);
  const x = Math.min(...xs); const y = Math.min(...ys);
  const box = { x, y, w: Math.max(0.5, Math.max(...xs) - x), h: Math.max(0.5, Math.max(...ys) - y) };
  const loc = (pts: Pt[]): Pt[] => pts.map(([px, py]) => [px - x, py - y] as Pt);
  const path = s.parts ? s.parts.map(q => polyPath(loc(q))).join('')
    : s.open ? `M${loc(s.pts).map(([px, py]) => `${Math.round(px * 100) / 100} ${Math.round(py * 100) / 100}`).join('L')}` : polyPath(loc(s.pts));
  return { box, path };
}

// ── Motifs ───────────────────────────────────────────────────────────

interface Tones { t: (a: number) => ColorRef; strong: ColorRef; pop: ColorRef }

function tonesOf(light: boolean): Tones {
  return light
    ? { t: a => ({ s: 'lt1', a: Math.round(a * 0.8 * 100) / 100 }), strong: { s: 'lt1', a: 0.5 }, pop: { s: 'lt1', a: 0.85 } }
    : { t: a => ({ s: 'accent1', a }), strong: { s: 'accent1', a: 0.9 }, pop: { s: 'accent2', a: 0.9 } };
}

type Anchor = 'bottom' | 'bottom-right' | 'right' | 'left' | 'tr+bl' | 'tr' | 'br' | 'bl' | 'corner';

const FULL: Record<Decor, Anchor[]> = {
  waves: ['bottom', 'bottom-right'],
  shards: ['right', 'left'],
  arch: ['right', 'left'],
  triangle: ['tr+bl', 'tr', 'br'],
  dots: ['tr', 'br', 'bl'],
  blobs: ['tr+bl', 'tr', 'br'],
  stripes: ['tr', 'br'],
};

function wave(x0: number, x1: number, base: (x: number) => number, amp: number, phase: number, bottom: number, n = 28): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    pts.push([x, base(x) + Math.sin(phase + (i / n) * Math.PI * 2.1) * amp]);
  }
  pts.push([x1, bottom], [x0, bottom]);
  return pts;
}

function blob(cx: number, cy: number, r: number, rnd: () => number, n = 64): Pt[] {
  const p1 = rnd() * 6.28; const p2 = rnd() * 6.28;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.11 * Math.sin(3 * a + p1) + 0.06 * Math.sin(5 * a + p2);
    return [cx + r * k * Math.cos(a), cy + r * k * Math.sin(a)] as Pt;
  });
}

/** The arch outline: straight sides rising from `bottom`, a half circle on top. */
function archPts(cx: number, bottom: number, w: number, h: number): Pt[] {
  const r = w / 2;
  const top = bottom - h + r;
  const pts: Pt[] = [[cx - r, bottom], [cx - r, top]];
  for (let i = 1; i < 24; i++) { const a = Math.PI + (i / 24) * Math.PI; pts.push([cx + r * Math.cos(a), top + r * Math.sin(a)]); }
  pts.push([cx + r, top], [cx + r, bottom]);
  return pts;
}

/** The motif at one anchor and scale (`k` ≤ 1), in absolute slide points. */
function motifAt(decor: Decor, anchor: Anchor, k: number, B: Box, tone: Tones, rnd: () => number): DecorShape[] {
  const x0 = B.x; const y0 = B.y; const x1 = B.x + B.w; const y1 = B.y + B.h;
  const out: DecorShape[] = [];
  const add = (name: string, pts: Pt[], fill?: ColorRef, line?: DecorShape['line'], open = false): void => {
    const clipped = open ? pts : clipToRect(pts, x0, y0, x1, y1);
    if (clipped.length >= (open ? 2 : 3)) out.push({ name, pts: clipped, ...(fill ? { fill } : {}), ...(line ? { line } : {}), ...(open ? { open } : {}) });
  };
  if (anchor === 'corner') {
    // The small variant: one quiet accent in the bottom-right corner of content slides.
    const s = 60 * k;
    const cx = x1; const cy = y1;
    switch (decor) {
      case 'waves':
        for (let i = 0; i < 2; i++) add(`Motif wave ${i + 1}`, clipToRect(wave(cx - s, cx, () => cy - s * (0.62 - i * 0.3), s * 0.07, 1 + i * 1.7, cy, 12), cx - s, cy - s, cx, cy), tone.t(0.28 + i * 0.3));
        break;
      case 'shards':
        add('Motif shard 1', [[cx, cy - s], [cx, cy], [cx - s * 0.7, cy]], tone.t(0.4));
        add('Motif shard 2', [[cx - s, cy], [cx - s * 0.5, cy - s * 0.75], [cx - s * 0.28, cy]], tone.strong);
        break;
      case 'arch':
        for (let i = 0; i < 2; i++) {
          const r = s * (0.92 - i * 0.36);
          add(`Motif arc ${i + 1}`, Array.from({ length: 13 }, (_, j) => [cx - r * Math.cos((j / 12) * Math.PI / 2), cy - r * Math.sin((j / 12) * Math.PI / 2)] as Pt), undefined, { color: i ? tone.strong : tone.t(0.5), w: 2.5 }, true);
        }
        break;
      case 'triangle':
        add('Motif triangle 1', [[cx, cy - s], [cx, cy], [cx - s, cy]], tone.t(0.3));
        add('Motif triangle 2', [[cx, cy - s * 0.58], [cx, cy], [cx - s * 0.58, cy]], tone.strong);
        break;
      case 'dots': {
        const sp = s / 4;
        const d = s / 11;
        const parts: Pt[][] = [];
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (r + c >= 3) parts.push(ellipsePts(cx - s + sp * (c + 0.5), cy - s + sp * (r + 0.5), d / 2, d / 2, 12));
        out.push({ name: 'Motif dots', pts: [[cx - s, cy], [cx, cy - s], [cx, cy]], parts, fill: tone.strong });
        break;
      }
      case 'blobs':
        add('Motif blob 1', blob(cx, cy, s * 0.82, rnd, 48), tone.t(0.32));
        add('Motif blob 2', ellipsePts(cx - s * 0.72, cy - s * 0.62, s * 0.09, s * 0.09, 20), tone.pop);
        break;
      case 'stripes':
        for (let i = 0; i < 4; i++) {
          const c1 = s * (0.14 + i * 0.22); const c2 = c1 + s * 0.09;
          add(`Motif stripe ${i + 1}`, [[cx - c1, cy], [cx - c2, cy], [cx, cy - c2], [cx, cy - c1]], i % 2 ? tone.t(0.4) : tone.strong);
        }
        break;
    }
    return out;
  }
  switch (decor) {
    case 'waves': {
      const bh = 140 * k;
      const top = y1 - bh;
      const xa = anchor === 'bottom' ? x0 : x0 + B.w * 0.42;
      for (let i = 0; i < 3; i++) {
        const yb = top + bh * (0.3 + 0.24 * i);
        const amp = bh * 0.09;
        // A half-width wave rises out of the bottom edge instead of starting at a hard vertical edge.
        const base = anchor === 'bottom' ? () => yb : (x: number) => y1 - (y1 - yb) * Math.pow((x - xa) / (x1 - xa), 0.55);
        add(`Motif wave ${i + 1}`, wave(xa, x1, base, anchor === 'bottom' ? amp : amp * 0.6, rnd() * 6.28, y1), i === 2 ? tone.strong : tone.t(0.16 + i * 0.14));
      }
      break;
    }
    case 'shards': {
      const bw = 330 * k;
      const X = (u: number): number => (anchor === 'right' ? x1 - bw + u * bw : x0 + bw - u * bw);
      const Y = (v: number): number => y0 + v * B.h;
      const P = (uv: [number, number][]): Pt[] => uv.map(([u, v]) => [X(u), Y(v)] as Pt);
      add('Motif shard 1', P([[0.35, 0], [1, 0], [1, 0.7]]), tone.t(0.16));
      add('Motif shard 2', P([[0.06, 1], [0.62, 0], [0.9, 0], [0.38, 1]]), tone.t(0.28));
      add('Motif shard 3', P([[1, 0.38], [1, 1], [0.48, 1]]), tone.strong);
      add('Motif shard 4', P([[0.12, 0.14], [0.3, 0.06], [0.22, 0.3]]), tone.pop);
      break;
    }
    case 'arch': {
      const aw = 220 * k;
      const ah = Math.min(B.h * 0.8, aw * 1.85);
      const cx = anchor === 'right' ? x1 - aw / 2 - 40 * k : x0 + aw / 2 + 40 * k;
      add('Motif arch', archPts(cx, y1, aw, ah), tone.t(0.2));
      const off = 18 * k * (anchor === 'right' ? -1 : 1);
      add('Motif arch outline', archPts(cx + off, y1 - 1.5, aw, ah + 18 * k), undefined, { color: tone.strong, w: 3 }, true);
      add('Motif sun', ellipsePts(cx, y1 - ah + aw / 2, aw * 0.17, aw * 0.17), tone.pop);
      break;
    }
    case 'triangle': {
      const s1 = 250 * k;
      const s2 = 170 * k;
      if (anchor !== 'br') {
        add('Motif triangle 1', [[x1 - s1 * 1.3, y0], [x1, y0], [x1, y0 + s1 * 1.3]], tone.t(0.16));
        add('Motif triangle 2', [[x1 - s1, y0], [x1, y0], [x1, y0 + s1]], tone.strong);
      } else {
        add('Motif triangle 1', [[x1 - s1 * 1.3, y1], [x1, y1], [x1, y1 - s1 * 1.3]], tone.t(0.16));
        add('Motif triangle 2', [[x1 - s1, y1], [x1, y1], [x1, y1 - s1]], tone.strong);
      }
      if (anchor === 'tr+bl') {
        add('Motif triangle 3', [[x0, y1 - s2], [x0, y1], [x0 + s2, y1]], tone.t(0.26));
        add('Motif triangle 4', [[x0, y1 - s2 * 0.5], [x0, y1], [x0 + s2 * 0.5, y1]], tone.pop);
      }
      break;
    }
    case 'dots': {
      const cols = 8; const rows = 5;
      const sp = 21 * k; const d = 7 * k;
      const gw = cols * sp; const gh = rows * sp;
      const gx = anchor === 'bl' ? x0 + 40 * k : x1 - 40 * k - gw;
      const gy = anchor === 'tr' ? y0 + 40 * k : y1 - 40 * k - gh;
      const rcx = anchor === 'bl' ? gx + gw : gx;
      const rcy = anchor === 'tr' ? gy + gh : gy;
      add('Motif disc', ellipsePts(rcx, rcy, 54 * k, 54 * k, 48), tone.t(0.22));
      const parts: Pt[][] = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) parts.push(ellipsePts(gx + sp * (c + 0.5), gy + sp * (r + 0.5), d / 2, d / 2, 12));
      out.push({ name: 'Motif dots', pts: [[gx, gy], [gx + gw, gy], [gx + gw, gy + gh], [gx, gy + gh]], parts, fill: tone.strong });
      break;
    }
    case 'blobs': {
      // Soft shapes growing out of the corners: a large pale one, a smaller strong one inside it, a bright dot.
      const R = 230 * k;
      const cy = anchor === 'br' ? y1 : y0;
      const dir = anchor === 'br' ? -1 : 1;
      add('Motif blob 1', blob(x1, cy, R, rnd), tone.t(0.22));
      add('Motif blob 2', blob(x1 - R * 0.18, cy + dir * R * 0.16, R * 0.55, rnd, 48), tone.strong);
      add('Motif blob 3', ellipsePts(x1 - R * 0.86, cy + dir * R * 0.5, R * 0.07, R * 0.07, 24), tone.pop);
      if (anchor === 'tr+bl') {
        const r2 = 150 * k;
        add('Motif blob 4', blob(x0, y1, r2, rnd), tone.t(0.18));
        add('Motif blob 5', blob(x0 + r2 * 0.12, y1 - r2 * 0.1, r2 * 0.5, rnd, 40), tone.t(0.4));
      }
      break;
    }
    case 'stripes': {
      const s = 240 * k;
      const top = anchor === 'tr';
      const yc = top ? y0 : y1;
      const sy = top ? 1 : -1;
      for (let i = 0; i < 6; i++) {
        const c1 = s * (0.12 + i * 0.15); const c2 = c1 + s * 0.06;
        add(`Motif stripe ${i + 1}`, [[x1 - c1, yc], [x1 - c2, yc], [x1, yc + sy * c2], [x1, yc + sy * c1]], i % 2 ? tone.t(0.3) : tone.strong);
      }
      add('Motif stripe corner', [[x1 - s * 0.09, yc], [x1, yc], [x1, yc + sy * s * 0.09]], tone.pop);
      break;
    }
  }
  return out;
}

/**
 * The motif for a slide: the first anchor and the largest scale at which no
 * shape touches a protected box (padded by {@link DECOR_PAD}); the small
 * corner variant when the full one does not fit (or `small` asks for it);
 * nothing when neither does.
 */
export function decorShapes(decor: Decor, req: DecorRequest, seed: string): DecorShape[] {
  const tone = tonesOf(req.light);
  const pad = req.protect.map(b => ({ x: b.x - DECOR_PAD, y: b.y - DECOR_PAD, w: b.w + 2 * DECOR_PAD, h: b.h + 2 * DECOR_PAD }));
  const clear = (shapes: DecorShape[]): boolean => shapes.length > 0 && shapes.every(s => {
    // An open arc in the corner stands for the quarter disc it bounds; an arch outline for the arch it encloses.
    const poly = s.open && s.name.startsWith('Motif arc') ? [...s.pts, [req.bounds.x + req.bounds.w, req.bounds.y + req.bounds.h] as Pt] : s.pts;
    return pad.every(b => !polyHitsBox(poly, b));
  });
  const fit = (anchor: Anchor, ks: number[]): { k: number; shapes: DecorShape[] } | undefined => {
    for (const k of ks) {
      const shapes = motifAt(decor, anchor, k, req.bounds, tone, seeded(`${seed}|${decor}`));
      if (clear(shapes)) return { k, shapes };
    }
    return undefined;
  };
  if (!req.small) {
    // Each anchor at its largest clear scale; the earlier (preferred) anchors win unless a later one is much larger.
    let best: { score: number; shapes: DecorShape[] } | undefined;
    FULL[decor].forEach((anchor, i) => {
      const got = fit(anchor, [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4]);
      if (got && (!best || got.k - i * 0.35 > best.score)) best = { score: got.k - i * 0.35, shapes: got.shapes };
    });
    if (best) return best.shapes;
  }
  return fit('corner', [1, 0.85, 0.7, 0.55])?.shapes ?? [];
}

// ── Illustrations ────────────────────────────────────────────────────

export type Scene = 'landscape' | 'city' | 'network' | 'data' | 'people' | 'civic' | 'water';
export const SCENES: readonly Scene[] = ['landscape', 'city', 'network', 'data', 'people', 'civic', 'water'];

/** Words that pick a scene, most specific first (a water ministry is water, not a building). */
const SCENE_WORDS: [Scene, RegExp][] = [
  ['water', /\b(water|river|flood|ocean|sea|marine|rain|drought|irrigat|sanitation|hydro|reservoir|coast|wastewater|aquifer)/i],
  ['civic', /\b(government|ministry|minister|council|public sector|parliament|civic|municipal|regulat|policy|law|court|department|treasury|state)\b/i],
  ['people', /\b(team|people|staff|hr|onboard|communit|customer|training|culture|welcome|citizen|patient|student|volunteer|hiring|talent)/i],
  ['network', /\b(network|platform|digital|cloud|integration|api|cyber|security|software|technology|ai|it|system|infrastructure as|sharepoint|server|data centre)\b/i],
  ['data', /\b(data|analytics|report|kpi|metric|finance|financial|revenue|budget|growth|performance|results|review|forecast|quarter|sales)/i],
  ['city', /\b(city|urban|transport|housing|real estate|property|retail|construction|smart city|infrastructure|logistics)/i],
  ['landscape', /\b(nature|environment|climate|sustainab|energy|farm|land|agri|green|renewable|travel|outdoor|mountain|park)/i],
];

/**
 * The scene for some words, tried in order (the slide's own words, then the
 * deck's title and brief): the first group that names a scene wins; a
 * landscape when none does.
 */
export function pickScene(...texts: string[]): Scene {
  for (const text of texts) for (const [scene, re] of SCENE_WORDS) if (re.test(text)) return scene;
  return 'landscape';
}

/** A scene element in box-relative points, with its fill. */
export interface SceneShape { name: string; pts: Pt[]; fill: ColorRef }

/**
 * A scene drawn in a `w`×`h` box, every element clipped to `mask` (a convex
 * outline in the same box-relative points). Fills are the light slot at
 * several opacities over the slot's own gradient, plus accent 2 for the one
 * bright element (sun, highlight bar, hub) — theme colours only.
 */
export function sceneShapes(scene: Scene, w: number, h: number, mask: Pt[], rnd: () => number): SceneShape[] {
  const out: SceneShape[] = [];
  const m = Math.min(w, h);
  const L = (a: number): ColorRef => ({ s: 'lt1', a });
  const POP: ColorRef = { s: 'accent2', a: 0.92 };
  const P = (u: number, v: number): Pt => [u * w, v * h];
  const add = (name: string, pts: Pt[], fill: ColorRef): void => {
    const c = clipConvex(pts, mask);
    if (c.length >= 3) out.push({ name, pts: c, fill });
  };
  const circle = (u: number, v: number, r: number, n = 32): Pt[] => ellipsePts(u * w, v * h, r * m, r * m, n);
  const rect = (u0: number, v0: number, u1: number, v1: number): Pt[] => [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
  const waves = (base: number, amp: number, n: number, fill: (i: number) => ColorRef): void => {
    for (let i = 0; i < n; i++) {
      const yb = h * (base + i * 0.12);
      add(`Water ${i + 1}`, wave(0, w, () => yb, h * amp, rnd() * 6.28 + i, h, 30), fill(i));
    }
  };
  switch (scene) {
    case 'landscape':
      add('Sun', circle(0.7, 0.3, 0.11), POP);
      add('Far hills', [P(0, 0.62), P(0.18, 0.4), P(0.33, 0.55), P(0.5, 0.33), P(0.68, 0.53), P(0.83, 0.42), P(1, 0.58), P(1, 1), P(0, 1)], L(0.18));
      add('Near hills', [P(0, 0.76), P(0.22, 0.54), P(0.4, 0.72), P(0.6, 0.57), P(0.8, 0.78), P(1, 0.66), P(1, 1), P(0, 1)], L(0.3));
      add('Ground', wave(0, w, () => h * 0.86, h * 0.025, 0.6, h, 24), L(0.45));
      break;
    case 'city': {
      add('Sun', circle(0.78, 0.24, 0.08), POP);
      for (const [row, base, hMin, hMax, fill] of [[0, 0.88, 0.32, 0.58, L(0.16)], [1, 0.88, 0.18, 0.42, L(0.32)]] as [number, number, number, number, ColorRef][]) {
        const pts: Pt[] = [P(0, 1)];
        let u = row ? -0.03 : 0;
        const tops: [number, number, number][] = [];
        while (u < 1) {
          const bw = 0.06 + rnd() * 0.07;
          const top = base - (hMin + rnd() * (hMax - hMin));
          pts.push(P(u, top), P(Math.min(1.02, u + bw), top));
          tops.push([u, Math.min(1.02, u + bw), top]);
          u += bw;
        }
        pts.push(P(1.02, 1));
        add(row ? 'Skyline' : 'Far skyline', pts, fill);
        if (row) {
          // Windows: small lit squares on the front buildings, disjoint, in one colour.
          let n = 0;
          for (const [a, b, top] of tops) {
            if (b - a < 0.07) continue;
            for (let v = top + 0.04; v < base - 0.06; v += 0.07) {
              for (let x = a + 0.015; x + 0.018 < b - 0.01; x += 0.03) add(`Window ${++n}`, rect(x, v, x + 0.016, v + 0.03), L(0.55));
            }
          }
        }
      }
      add('Street', rect(0, 0.88, 1, 1), L(0.45));
      break;
    }
    case 'network': {
      const nodes: Pt[] = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) nodes.push([0.16 + c * 0.23 + (rnd() - 0.5) * 0.1, 0.22 + r * 0.28 + (rnd() - 0.5) * 0.1]);
      const seen = new Set<string>();
      let e = 0;
      nodes.forEach((a, i) => {
        const near = nodes.map((b, j) => [j, Math.hypot((a[0] - b[0]) * w, (a[1] - b[1]) * h)] as [number, number]).filter(([j]) => j !== i).sort((p, q) => p[1] - q[1]).slice(0, 2);
        for (const [j] of near) {
          const key = i < j ? `${i}-${j}` : `${j}-${i}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const [ax, ay] = P(a[0], a[1]); const [bx, by] = P(nodes[j]![0], nodes[j]![1]);
          const len = Math.hypot(bx - ax, by - ay) || 1;
          const t = Math.max(1.2, m * 0.007);
          const nx = (-(by - ay) / len) * t; const ny = ((bx - ax) / len) * t;
          add(`Link ${++e}`, [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]], L(0.35));
        }
      });
      const hub = 5;
      nodes.forEach((p, i) => add(i === hub ? 'Hub' : `Node ${i + 1}`, circle(p[0], p[1], i === hub ? 0.075 : 0.035 + rnd() * 0.015), i === hub ? POP : L(0.8)));
      add('Hub ring', ellipsePts(nodes[hub]![0] * w, nodes[hub]![1] * h, m * 0.12, m * 0.12, 40), L(0.14));
      break;
    }
    case 'data': {
      for (let i = 0; i < 4; i++) add(`Grid ${i + 1}`, rect(0.1, 0.25 + i * 0.16, 0.9, 0.25 + i * 0.16 + 0.006), L(0.18));
      const hs = [0.22, 0.34, 0.3, 0.46, 0.58];
      hs.forEach((v, i) => add(i === 4 ? 'Highlight bar' : `Bar ${i + 1}`, rect(0.14 + i * 0.15, 0.82 - v, 0.14 + i * 0.15 + 0.1, 0.82), i === 4 ? POP : L(0.3 + i * 0.05)));
      // The trend line as a ribbon (one simple polygon: x always increases).
      const line = hs.map((v, i) => P(0.19 + i * 0.15, 0.7 - v - 0.06));
      const t = Math.max(1.5, m * 0.012);
      add('Trend', [...line.map(([x, y]) => [x, y - t] as Pt), ...line.reverse().map(([x, y]) => [x, y + t] as Pt)], L(0.85));
      line.forEach(([x, y], i) => add(`Point ${i + 1}`, ellipsePts(x, y, m * 0.022, m * 0.022, 16), L(0.95)));
      add('Baseline', rect(0.08, 0.82, 0.92, 0.835), L(0.55));
      break;
    }
    case 'people': {
      // Busts standing on one ground line, side by side (never overlapping): a group, not a crowd of pillars.
      add('Halo', circle(0.5, 0.5, 0.3, 48), L(0.12));
      const ground = 0.84;
      const person = (name: string, u: number, s: number, fill: ColorRef): void => {
        const rx = (0.15 * s * m) / w; const ry = (0.2 * s * m) / h;
        const bust: Pt[] = [];
        for (let i = 0; i <= 24; i++) { const a = Math.PI + (i / 24) * Math.PI; bust.push(P(u + rx * Math.cos(a), ground + ry * Math.sin(a))); }
        add(`${name} body`, bust, fill);
        add(`${name} head`, ellipsePts(u * w, (ground - ry) * h - 0.1 * s * m, 0.075 * s * m, 0.075 * s * m, 32), fill);
      };
      person('Left', 0.22, 0.85, L(0.38));
      person('Right', 0.78, 0.85, L(0.38));
      person('Centre', 0.5, 1.1, L(0.78));
      add('Ground', rect(0, ground, 1, 1), L(0.3));
      add('Spark', circle(0.5, 0.15, 0.03), POP);
      break;
    }
    case 'civic': {
      add('Sun', circle(0.5, 0.33, 0.2, 48), { s: 'accent2', a: 0.45 });
      add('Pediment', [P(0.18, 0.37), P(0.5, 0.19), P(0.82, 0.37)], L(0.7));
      add('Entablature', rect(0.2, 0.385, 0.8, 0.43), L(0.7));
      for (let i = 0; i < 6; i++) add(`Column ${i + 1}`, rect(0.235 + i * 0.1, 0.45, 0.235 + i * 0.1 + 0.05, 0.74), L(0.5));
      add('Step 1', rect(0.16, 0.755, 0.84, 0.795), L(0.7));
      add('Step 2', rect(0.12, 0.81, 0.88, 0.85), L(0.7));
      add('Ground', rect(0, 0.865, 1, 1), L(0.22));
      break;
    }
    case 'water': {
      add('Sun', circle(0.74, 0.28, 0.1), POP);
      const drop: Pt[] = [];
      const [dx, dy] = P(0.3, 0.38); const dr = m * 0.08;
      drop.push([dx, dy - dr * 2.1]);
      for (let i = 0; i <= 16; i++) { const a = -Math.PI / 6 + (i / 16) * (Math.PI + Math.PI / 3); drop.push([dx + dr * Math.cos(a), dy + dr * Math.sin(a)]); }
      add('Drop', drop, L(0.8));
      waves(0.58, 0.035, 3, i => L(0.18 + i * 0.14));
      break;
    }
  }
  return out;
}
