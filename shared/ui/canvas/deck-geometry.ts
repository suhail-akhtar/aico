/**
 * Shape geometry for slides — the outlines of PowerPoint's preset shapes,
 * computed the way PowerPoint computes them, so the editor draws the same
 * chevron the .pptx contains.
 *
 * ## Why presets, and why compute them here
 *
 * An infographic exported as pictures is not editable; exported as freeform
 * outlines it is editable but awkward (a chevron that is "Edit Points" instead
 * of a chevron with a yellow adjustment handle). So infographic shapes are
 * PowerPoint *preset* geometries (`a:prstGeom` with adjust values): chevron,
 * home plate, hexagon, triangle, trapezoid, right arrow, block arc, donut, pie,
 * diamond. The PowerPoint writer emits the preset name and its adjust values;
 * the HTML renderer needs the outline itself, so {@link presetPath} implements
 * the formulas from ECMA-376's presetShapeDefinitions for exactly these shapes
 * (pins, the `ss` short side, angles clockwise from three o'clock) and returns
 * an SVG path. Adjust values are given in slide units (points, degrees) and
 * converted by {@link presetAdjust}, so layout code says "a 22 pt point", not
 * "adj 31428".
 *
 * Arcs (block arc, pie) are only ever used on square boxes: PowerPoint's
 * angles on an ellipse are not plain parametric angles, and nothing here needs
 * an elliptical arc.
 *
 * Freeforms (`path`) and icons are absolute M/L/C/Z paths in the shape's own
 * box, written as `a:custGeom` — used where no preset says it (a clipped art
 * polygon, a connector curve, an icon).
 *
 * @module shared/ui/canvas/deck-geometry
 */

export type PresetGeom =
  | 'rect' | 'roundRect' | 'topRound' | 'ellipse' | 'corner'
  | 'chevron' | 'homePlate' | 'hexagon' | 'triangle' | 'trapezoid' | 'rightArrow' | 'blockArc' | 'donut' | 'pie' | 'diamond';

const r = (n: number): number => Math.round(n * 100) / 100;
const deg = (a: number): number => (a * Math.PI) / 180;

/** Normalise degrees to [0, 360). */
export function normDeg(a: number): number {
  const v = a % 360;
  return v < 0 ? v + 360 : v;
}

function pt(cx: number, cy: number, rad: number, a: number): [number, number] {
  return [r(cx + rad * Math.cos(deg(a))), r(cy + rad * Math.sin(deg(a)))];
}

/** A circular arc from `a0` sweeping `sw` degrees (positive clockwise), as SVG commands continuing a path. */
function arc(cx: number, cy: number, rad: number, a0: number, sw: number): string {
  if (Math.abs(sw) >= 359.99) {
    // SVG cannot draw a full circle in one arc: two halves.
    const half = sw / 2;
    return arc(cx, cy, rad, a0, half) + arc(cx, cy, rad, a0 + half, sw - half);
  }
  const [x, y] = pt(cx, cy, rad, a0 + sw);
  return `A${r(rad)} ${r(rad)} 0 ${Math.abs(sw) > 180 ? 1 : 0} ${sw > 0 ? 1 : 0} ${x} ${y}`;
}

/** The clockwise sweep from `start` to `end`, PowerPoint's way (equal angles = a full turn). */
export function sweepOf(start: number, end: number): number {
  const s = normDeg(end) - normDeg(start);
  return s > 0 ? s : s + 360;
}

/**
 * An SVG path for a preset in a `w`×`h` box. `adj` is in slide units:
 * chevron/homePlate [point depth pt], hexagon [corner inset pt], triangle
 * [apex position 0–1], trapezoid [top inset pt], rightArrow [shaft fraction
 * 0–1, head length pt], blockArc [start°, end°, thickness pt], donut
 * [thickness pt], pie [start°, end°].
 */
export function presetPath(geom: PresetGeom, w: number, h: number, adj: number[] = [], radius = 8): string {
  const ss = Math.min(w, h);
  const hc = w / 2;
  const vc = h / 2;
  switch (geom) {
    case 'rect': return `M0 0H${r(w)}V${r(h)}H0Z`;
    case 'ellipse': return `M${r(w)} ${r(vc)}A${r(hc)} ${r(vc)} 0 1 1 0 ${r(vc)}A${r(hc)} ${r(vc)} 0 1 1 ${r(w)} ${r(vc)}Z`;
    case 'roundRect': {
      const k = Math.min(radius, ss / 2);
      return `M${r(k)} 0H${r(w - k)}A${r(k)} ${r(k)} 0 0 1 ${r(w)} ${r(k)}V${r(h - k)}A${r(k)} ${r(k)} 0 0 1 ${r(w - k)} ${r(h)}H${r(k)}A${r(k)} ${r(k)} 0 0 1 0 ${r(h - k)}V${r(k)}A${r(k)} ${r(k)} 0 0 1 ${r(k)} 0Z`;
    }
    case 'topRound': {
      const k = Math.min(radius, ss / 2);
      return `M${r(k)} 0H${r(w - k)}A${r(k)} ${r(k)} 0 0 1 ${r(w)} ${r(k)}V${r(h)}H0V${r(k)}A${r(k)} ${r(k)} 0 0 1 ${r(k)} 0Z`;
    }
    case 'corner': return `M0 0H${r(w)}V${r(h)}Z`;
    case 'diamond': return `M0 ${r(vc)}L${r(hc)} 0L${r(w)} ${r(vc)}L${r(hc)} ${r(h)}Z`;
    case 'homePlate': {
      const dx = Math.max(0, Math.min(adj[0] ?? ss / 2, w));
      return `M0 0L${r(w - dx)} 0L${r(w)} ${r(vc)}L${r(w - dx)} ${r(h)}L0 ${r(h)}Z`;
    }
    case 'chevron': {
      const dx = Math.max(0, Math.min(adj[0] ?? ss / 2, w / 2));
      return `M0 0L${r(w - dx)} 0L${r(w)} ${r(vc)}L${r(w - dx)} ${r(h)}L0 ${r(h)}L${r(dx)} ${r(vc)}Z`;
    }
    case 'hexagon': {
      const x1 = Math.max(0, Math.min(adj[0] ?? w / 4, w / 2));
      return `M0 ${r(vc)}L${r(x1)} 0L${r(w - x1)} 0L${r(w)} ${r(vc)}L${r(w - x1)} ${r(h)}L${r(x1)} ${r(h)}Z`;
    }
    case 'triangle': {
      const x1 = w * Math.max(0, Math.min(1, adj[0] ?? 0.5));
      return `M0 ${r(h)}L${r(x1)} 0L${r(w)} ${r(h)}Z`;
    }
    case 'trapezoid': {
      const x2 = Math.max(0, Math.min(adj[0] ?? ss / 4, w / 2));
      return `M0 ${r(h)}L${r(x2)} 0L${r(w - x2)} 0L${r(w)} ${r(h)}Z`;
    }
    case 'rightArrow': {
      const a1 = Math.max(0, Math.min(1, adj[0] ?? 0.5));
      const dx = Math.max(0, Math.min(adj[1] ?? ss / 2, w));
      const y1 = vc - (h * a1) / 2;
      const y2 = vc + (h * a1) / 2;
      return `M0 ${r(y1)}L${r(w - dx)} ${r(y1)}L${r(w - dx)} 0L${r(w)} ${r(vc)}L${r(w - dx)} ${r(h)}L${r(w - dx)} ${r(y2)}L0 ${r(y2)}Z`;
    }
    case 'blockArc': {
      const start = adj[0] ?? 180;
      const end = adj[1] ?? 0;
      const thick = Math.max(0, Math.min(adj[2] ?? ss / 4, ss / 2));
      const sw = sweepOf(start, end);
      const ro = ss / 2;
      const ri = ro - thick;
      const [sx, sy] = pt(hc, vc, ro, start);
      const [ex, ey] = pt(hc, vc, ri, start + sw);
      return `M${sx} ${sy}${arc(hc, vc, ro, start, sw)}L${ex} ${ey}${arc(hc, vc, ri, start + sw, -sw)}Z`;
    }
    case 'donut': {
      const thick = Math.max(0, Math.min(adj[0] ?? ss / 4, ss / 2));
      const ro = ss / 2;
      const ri = ro - thick;
      return `M${r(hc + ro)} ${r(vc)}${arc(hc, vc, ro, 0, 360)}ZM${r(hc + ri)} ${r(vc)}${arc(hc, vc, ri, 0, -360)}Z`;
    }
    case 'pie': {
      const start = adj[0] ?? 0;
      const sw = sweepOf(start, adj[1] ?? 270);
      const ro = ss / 2;
      const [sx, sy] = pt(hc, vc, ro, start);
      return `M${r(hc)} ${r(vc)}L${sx} ${sy}${arc(hc, vc, ro, start, sw)}Z`;
    }
  }
}

/** The `a:avLst` guide values PowerPoint stores for a preset, from the same slide-unit `adj`. */
export function presetAdjust(geom: PresetGeom, w: number, h: number, adj: number[] = [], radius = 8): { name: string; val: number }[] {
  const ss = Math.max(1, Math.min(w, h));
  const rel = (v: number, max = 100000): number => Math.max(0, Math.min(max, Math.round((v / ss) * 100000)));
  const ang = (a: number): number => Math.round(normDeg(a) * 60000) % 21600000;
  switch (geom) {
    case 'roundRect': return [{ name: 'adj', val: rel(Math.min(radius, ss / 2), 50000) }];
    case 'topRound': return [{ name: 'adj1', val: rel(Math.min(radius, ss / 2), 50000) }, { name: 'adj2', val: 0 }];
    case 'homePlate': return [{ name: 'adj', val: rel(adj[0] ?? ss / 2, Math.round((100000 * w) / ss)) }];
    case 'chevron': return [{ name: 'adj', val: rel(adj[0] ?? ss / 2, Math.round((100000 * w) / ss)) }];
    case 'hexagon': return [{ name: 'adj', val: rel(adj[0] ?? w / 4, Math.round((50000 * w) / ss)) }, { name: 'vf', val: 115470 }];
    case 'triangle': return [{ name: 'adj', val: Math.round(Math.max(0, Math.min(1, adj[0] ?? 0.5)) * 100000) }];
    case 'trapezoid': return [{ name: 'adj', val: rel(adj[0] ?? ss / 4, Math.round((50000 * w) / ss)) }];
    case 'rightArrow': return [
      { name: 'adj1', val: Math.round(Math.max(0, Math.min(1, adj[0] ?? 0.5)) * 100000) },
      { name: 'adj2', val: rel(adj[1] ?? ss / 2, Math.round((100000 * w) / ss)) },
    ];
    case 'blockArc': return [{ name: 'adj1', val: ang(adj[0] ?? 180) }, { name: 'adj2', val: ang(adj[1] ?? 0) }, { name: 'adj3', val: rel(adj[2] ?? ss / 4, 50000) }];
    case 'donut': return [{ name: 'adj', val: rel(adj[0] ?? ss / 4, 50000) }];
    case 'pie': return [{ name: 'adj1', val: ang(adj[0] ?? 0) }, { name: 'adj2', val: ang(adj[1] ?? 270) }];
    default: return [];
  }
}

/** PowerPoint's preset name for a geometry. */
export const PRST: Record<PresetGeom, string> = {
  rect: 'rect', roundRect: 'roundRect', topRound: 'round2SameRect', ellipse: 'ellipse', corner: 'rtTriangle', chevron: 'chevron',
  homePlate: 'homePlate', hexagon: 'hexagon', triangle: 'triangle', trapezoid: 'trapezoid', rightArrow: 'rightArrow', blockArc: 'blockArc',
  donut: 'donut', pie: 'pie', diamond: 'diamond',
};

// ── Freeform helpers ─────────────────────────────────────────────────

export type Pt = [number, number];

/** A closed polygon as an absolute M/L/Z path. */
export function polyPath(points: Pt[]): string {
  return points.length ? `M${points.map(([x, y]) => `${r(x)} ${r(y)}`).join('L')}Z` : '';
}

/** Clip a polygon to a rectangle (Sutherland–Hodgman): art that never spills out of its box, in PowerPoint too. */
export function clipToRect(poly: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  type Edge = [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt];
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const edges: Edge[] = [
    [p => p[0] >= x0, (a, b) => lerp(a, b, (x0 - a[0]) / (b[0] - a[0]))],
    [p => p[0] <= x1, (a, b) => lerp(a, b, (x1 - a[0]) / (b[0] - a[0]))],
    [p => p[1] >= y0, (a, b) => lerp(a, b, (y0 - a[1]) / (b[1] - a[1]))],
    [p => p[1] <= y1, (a, b) => lerp(a, b, (y1 - a[1]) / (b[1] - a[1]))],
  ];
  let out = poly;
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!;
      const prev = input[(i + input.length - 1) % input.length]!;
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cut(prev, cur));
    }
    if (!out.length) break;
  }
  return out;
}

/** Absolute M/L/C/Z path data → commands (what the PowerPoint writer emits). */
export function pathCommands(d: string): (['M' | 'L', number, number] | ['C', number, number, number, number, number, number] | ['Z'])[] {
  const out: (['M' | 'L', number, number] | ['C', number, number, number, number, number, number] | ['Z'])[] = [];
  for (const m of d.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
    const v = m[2]!.trim() ? m[2]!.trim().split(/[\s,]+/).map(Number) : [];
    if (m[1] === 'Z') out.push(['Z']);
    else if (m[1] === 'C') { for (let i = 0; i + 5 < v.length; i += 6) out.push(['C', v[i]!, v[i + 1]!, v[i + 2]!, v[i + 3]!, v[i + 4]!, v[i + 5]!]); }
    else { for (let i = 0; i + 1 < v.length; i += 2) out.push([i === 0 ? m[1] as 'M' | 'L' : 'L', v[i]!, v[i + 1]!]); }
  }
  return out;
}

/** Scale and shift absolute M/L/C/Z path data. */
export function transformPath(d: string, sx: number, sy: number, dx = 0, dy = 0): string {
  return pathCommands(d).map((c) => {
    if (c[0] === 'Z') return 'Z';
    const v = c.slice(1) as number[];
    return `${c[0]}${v.map((n, i) => r(i % 2 ? n * sy + dy : n * sx + dx)).join(' ')}`;
  }).join('');
}
