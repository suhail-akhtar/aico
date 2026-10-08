/**
 * Drawing a {@link FlowScene} on a 2D canvas: rounded boxes with a colour bar,
 * routed edges with arrowheads, counts on the heavy edges, a minimap.
 *
 * ## Labels that cannot collide
 *
 * The force map has to decide which labels fit; here every label lives inside
 * its own box, and boxes never overlap (the layout guarantees it). So the only
 * rule is legibility: text is clamped to 9.5–14 px however far out the camera
 * is, cut with an ellipsis to the box's width, and dropped when the box is too
 * small to hold a line at all — at that zoom the box colour and position carry
 * the picture, and zooming in brings the words back. Edge counts are the one
 * thing that can collide, so they are placed greedily, heaviest first, and
 * skipped when they would overlap one already placed.
 *
 * Everything pointer-dependent (hover, selection) is applied here from the
 * scene's fixed geometry, so moving the mouse redraws and never re-lays-out.
 *
 * @module web/components/codegraph/render-flow
 */

import type { Camera, Theme } from './render';
import { toScreen, toWorld } from './render';
import type { FlowEdge, FlowNode, FlowScene } from './flow';

const FONT = 'Inter, ui-sans-serif, system-ui, sans-serif';

export function flowBounds(scene: FlowScene, only?: number[]): { x0: number; y0: number; x1: number; y1: number } {
  const list = only?.length ? only.map(i => scene.nodes[i]!).filter(Boolean) : scene.nodes;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of list) { x0 = Math.min(x0, n.x - n.w / 2); x1 = Math.max(x1, n.x + n.w / 2); y0 = Math.min(y0, n.y - n.h / 2); y1 = Math.max(y1, n.y + n.h / 2); }
  return isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 1, y1: 1 };
}

/** A camera showing the given nodes (all when none given), never larger than life. */
export function fitFlow(scene: FlowScene, w: number, h: number, only?: number[], pad = 36, maxK = 1.1, minK = 0.04): Camera {
  const b = flowBounds(scene, only);
  const k = Math.min((w - pad * 2) / Math.max(1, b.x1 - b.x0), (h - pad * 2) / Math.max(1, b.y1 - b.y0), maxK);
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, k: Math.max(minK, k) };
}

/** The box under a screen point, or −1. */
export function hitFlow(scene: FlowScene, cam: Camera, w: number, h: number, sx: number, sy: number): number {
  const [wx, wy] = toWorld(cam, w, h, sx, sy);
  const slack = 3 / cam.k;
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const n = scene.nodes[i]!;
    if (Math.abs(wx - n.x) <= n.w / 2 + slack && Math.abs(wy - n.y) <= n.h / 2 + slack) return i;
  }
  return -1;
}

export interface FlowDrawOptions {
  hover: number;
  /** Selected node indices. */
  selected: Set<number>;
  dpr: number;
}

const cache = new Map<string, string>();
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 8) return '';
  const key = `${ctx.font}|${maxW | 0}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out = text;
  if (ctx.measureText(text).width > maxW) {
    let lo = 0; let hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid; else hi = mid - 1; }
    out = lo > 0 ? `${text.slice(0, lo)}…` : '';
  }
  if (cache.size > 4000) cache.clear();
  cache.set(key, out);
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The route through its points: an S-curve per segment, tangent to the flow at every box. */
function tracePath(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number, pts: Float32Array, dir: 'down' | 'right'): void {
  const [x0, y0] = toScreen(cam, w, h, pts[0]!, pts[1]!);
  ctx.moveTo(x0, y0);
  let px = x0; let py = y0;
  for (let i = 2; i < pts.length; i += 2) {
    const [x, y] = toScreen(cam, w, h, pts[i]!, pts[i + 1]!);
    if (dir === 'down') { const m = (y - py) / 2; ctx.bezierCurveTo(px, py + m, x, y - m, x, y); } else { const m = (x - px) / 2; ctx.bezierCurveTo(px + m, py, x - m, y, x, y); }
    px = x; py = y;
  }
}

function neighbours(scene: FlowScene, idx: number): Set<number> {
  const out = new Set<number>([idx]);
  for (const e of scene.edges) { if (e.a === idx) out.add(e.b); else if (e.b === idx) out.add(e.a); }
  return out;
}

export function drawFlow(ctx: CanvasRenderingContext2D, w: number, h: number, cam: Camera, scene: FlowScene, theme: Theme, opts: FlowDrawOptions): void {
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);
  const k = cam.k;
  const nodes = scene.nodes;
  const focus = opts.hover >= 0 ? opts.hover : [...opts.selected][0] ?? -1;
  // Hovering dims everything but the box and its neighbours; a selection only lights its own links.
  const hovering = opts.hover >= 0;
  const related = hovering ? neighbours(scene, focus) : null;
  const [vx0, vy0] = toWorld(cam, w, h, 0, 0);
  const [vx1, vy1] = toWorld(cam, w, h, w, h);
  const slate = theme.dark ? '148,163,184' : '100,116,139';

  // ── Edges, grouped by look so the canvas changes state a handful of times.
  const batches = new Map<string, { edges: FlowEdge[]; color: string; alpha: number; width: number }>();
  const incident: FlowEdge[] = [];
  for (const e of scene.edges) {
    const bb = e.bbox;
    if (bb[2] < vx0 || bb[0] > vx1 || bb[3] < vy0 || bb[1] > vy1) continue;
    const hot = focus >= 0 && (e.a === focus || e.b === focus);
    if (hot) incident.push(e);
    const quiet = hovering && !hot;
    const base = scene.nodes.length > 400 ? 0.3 : 0.48;
    const alpha = hot ? 0.95 : quiet ? 0.07 : (e.back ? 0.62 : base) * (e.far ? 0.5 : 1);
    const wd = Math.min(5, 1 + Math.log2(1 + e.count) * 0.8) * (e.back && !hot ? 0.7 : 1) * Math.min(1.5, Math.max(0.7, k)) * (hot ? 1.3 : 1);
    const color = e.back ? theme.danger : hot ? theme.accent : `rgb(${slate})`;
    const key = `${color}|${alpha}|${wd.toFixed(1)}`;
    let g = batches.get(key);
    if (!g) { g = { edges: [], color, alpha, width: wd }; batches.set(key, g); }
    g.edges.push(e);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const g of [...batches.values()].sort((a, b) => a.alpha - b.alpha)) {
    ctx.globalAlpha = g.alpha;
    ctx.strokeStyle = g.color;
    ctx.lineWidth = g.width;
    ctx.beginPath();
    for (const e of g.edges) tracePath(ctx, cam, w, h, e.pts, scene.dir);
    ctx.stroke();
    if (k >= 0.3) {
      ctx.fillStyle = g.color;
      const s = Math.min(9, Math.max(5.5, 7 * k + 1.5)) * (g.alpha > 0.5 ? 1 : 0.85);
      ctx.beginPath();
      for (const e of g.edges) {
        const p = e.pts; const L = p.length;
        const [tx, ty] = toScreen(cam, w, h, p[L - 2]!, p[L - 1]!);
        const sgn = scene.dir === 'down' ? Math.sign(p[L - 1]! - p[L - 3]!) || 1 : Math.sign(p[L - 2]! - p[L - 4]!) || 1;
        if (scene.dir === 'down') { ctx.moveTo(tx, ty); ctx.lineTo(tx - s * 0.6, ty - sgn * s); ctx.lineTo(tx + s * 0.6, ty - sgn * s); } else { ctx.moveTo(tx, ty); ctx.lineTo(tx - sgn * s, ty - s * 0.6); ctx.lineTo(tx - sgn * s, ty + s * 0.6); }
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  // ── Boxes.
  const radius = Math.max(3, Math.min(9, 8 * k));
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const [cx, cy] = toScreen(cam, w, h, n.x, n.y);
    const ww = n.w * k; const hh = n.h * k;
    if (cx + ww / 2 < 0 || cy + hh / 2 < 0 || cx - ww / 2 > w || cy - hh / 2 > h) continue;
    drawBox(ctx, n, cx - ww / 2, cy - hh / 2, ww, hh, radius, k, theme, {
      dim: related !== null && !related.has(i),
      selected: opts.selected.has(i),
      hover: i === opts.hover,
    });
  }

  // ── Counts on the edges that carry several dependencies.
  if (k >= 0.5 || focus >= 0) {
    ctx.font = `600 10.5px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const placed: Array<[number, number, number, number]> = [];
    const order = [...incident.filter(e => e.count >= 2), ...(focus >= 0 ? [] : scene.edges.filter(e => e.count >= 2).sort((a, b) => b.count - a.count))];
    let budget = 220;
    for (const e of order) {
      if (budget <= 0) break;
      const p = e.pts; const segs = p.length / 2 - 1;
      const i = Math.floor(segs / 2);
      const wx = segs % 2 === 1 ? (p[i * 2]! + p[i * 2 + 2]!) / 2 : p[i * 2]!;
      const wy = segs % 2 === 1 ? (p[i * 2 + 1]! + p[i * 2 + 3]!) / 2 : p[i * 2 + 1]!;
      const [x, y] = toScreen(cam, w, h, wx, wy);
      if (x < 0 || y < 0 || x > w || y > h) continue;
      const text = String(e.count);
      const tw = ctx.measureText(text).width + 10;
      const box: [number, number, number, number] = [x - tw / 2, y - 8, x + tw / 2, y + 8];
      if (placed.some(q => q[0] < box[2] && box[0] < q[2] && q[1] < box[3] && box[1] < q[3])) continue;
      placed.push(box); budget--;
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.bg;
      roundRect(ctx, box[0], box[1], tw, 16, 8);
      ctx.fill();
      ctx.strokeStyle = e.back ? theme.danger : theme.border;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = e.back ? theme.danger : theme.fg;
      ctx.fillText(text, x, y + 0.5);
    }
  }
  ctx.globalAlpha = 1;
}

function drawBox(ctx: CanvasRenderingContext2D, n: FlowNode, x: number, y: number, w: number, h: number, r: number, k: number, theme: Theme, st: { dim: boolean; selected: boolean; hover: boolean }): void {
  const isFocus = n.role === 'focus';
  ctx.globalAlpha = st.dim ? 0.5 : 1;
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = theme.surface;
  ctx.fill();
  if (isFocus || st.selected) { ctx.globalAlpha = (st.dim ? 0.5 : 1) * 0.14; ctx.fillStyle = theme.accent; ctx.fill(); ctx.globalAlpha = st.dim ? 0.5 : 1; }
  // Colour bar, clipped to the box.
  if (n.kind !== 'more') {
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.fillStyle = n.tint;
    ctx.fillRect(x, y, Math.max(3, Math.min(5, 4 * k)), h);
    ctx.restore();
  }
  if (n.kind === 'more') ctx.setLineDash([4, 3]);
  roundRect(ctx, x, y, w, h, r);
  ctx.lineWidth = isFocus || st.selected ? 2 : st.hover ? 1.6 : n.fresh ? 1.5 : 1;
  ctx.strokeStyle = isFocus || st.selected || n.fresh ? theme.accent : st.hover ? theme.fg : theme.border;
  ctx.stroke();
  ctx.setLineDash([]);

  if (n.cycle && w > 24) {
    ctx.fillStyle = theme.danger;
    ctx.beginPath();
    ctx.arc(x + w - 7, y + 7, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Words: clamped to a legible size, cut to the box, dropped when the box cannot hold a line.
  const big = n.kind === 'module' || isFocus;
  const fs = Math.max(9.5, Math.min(big ? 14 : 13, (big ? 13 : 12) * k));
  if (w < 34 || h < fs + 5) { ctx.globalAlpha = 1; return; }
  const sfs = Math.max(9.5, fs - 1.8);
  const twoLines = h >= fs + sfs + 12 && n.sub !== '';
  const padL = Math.max(3, Math.min(5, 4 * k)) + 8;
  const maxW = w - padL - 8;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const total = twoLines ? fs + sfs + 3 : fs;
  const top = y + h / 2 - total / 2;
  ctx.font = `${big || st.selected ? 600 : 500} ${fs}px ${FONT}`;
  ctx.fillStyle = n.kind === 'more' ? theme.muted : theme.fg;
  const title = fitText(ctx, n.title, maxW);
  if (title) ctx.fillText(title, x + padL, top + fs / 2);
  if (twoLines) {
    ctx.font = `400 ${sfs}px ${FONT}`;
    ctx.fillStyle = theme.muted;
    const sub = fitText(ctx, n.sub, maxW);
    if (sub) ctx.fillText(sub, x + padL, top + fs + 3 + sfs / 2);
  }
  ctx.globalAlpha = 1;
}

/** The whole drawing in the corner, with the visible area as a frame; returns the camera that maps it. */
export function drawFlowMinimap(ctx: CanvasRenderingContext2D, mw: number, mh: number, scene: FlowScene, cam: Camera, viewW: number, viewH: number, theme: Theme, dpr: number): Camera {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, mw, mh);
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, mw, mh);
  const mini = fitFlow(scene, mw, mh, undefined, 8, 4);
  for (const n of scene.nodes) {
    const [x, y] = toScreen(mini, mw, mh, n.x, n.y);
    ctx.globalAlpha = n.role === 'focus' ? 1 : 0.8;
    ctx.fillStyle = n.role === 'focus' ? theme.accent : n.tint;
    ctx.fillRect(x - Math.max(1, n.w * mini.k) / 2, y - Math.max(1, n.h * mini.k) / 2, Math.max(1.5, n.w * mini.k), Math.max(1.5, n.h * mini.k));
  }
  const [x0, y0] = toWorld(cam, viewW, viewH, 0, 0);
  const [x1, y1] = toWorld(cam, viewW, viewH, viewW, viewH);
  const [a, b] = toScreen(mini, mw, mh, x0, y0);
  const [c, d] = toScreen(mini, mw, mh, x1, y1);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(Math.max(1, a), Math.max(1, b), Math.max(2, Math.min(mw - 2, c) - Math.max(1, a)), Math.max(2, Math.min(mh - 2, d) - Math.max(1, b)));
  return mini;
}

function escXml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** A standalone SVG of the whole layered drawing (not just what is on screen). */
export function flowToSvg(scene: FlowScene, theme: { bg: string; fg: string; muted: string; danger: string }, title: string): string {
  if (!scene.nodes.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><text x="10" y="40">${escXml(title)}: nothing to show</text></svg>`;
  const b = flowBounds(scene);
  const pad = 40;
  const top = 28;
  const w = Math.ceil(b.x1 - b.x0 + pad * 2);
  const h = Math.ceil(b.y1 - b.y0 + pad * 2 + top);
  const tx = (x: number): string => (x - b.x0 + pad).toFixed(1);
  const ty = (y: number): string => (y - b.y0 + pad + top).toFixed(1);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="Inter, system-ui, sans-serif">`,
    `<rect width="100%" height="100%" fill="${theme.bg}"/>`,
    `<text x="${pad}" y="24" font-size="14" font-weight="600" fill="${theme.fg}">${escXml(title)}</text>`];
  for (const e of scene.edges) {
    const p = e.pts;
    let d = `M${tx(p[0]!)} ${ty(p[1]!)}`;
    for (let i = 2; i < p.length; i += 2) {
      const x0 = p[i - 2]!; const y0 = p[i - 1]!; const x1 = p[i]!; const y1 = p[i + 1]!;
      d += scene.dir === 'down'
        ? ` C${tx(x0)} ${ty(y0 + (y1 - y0) / 2)} ${tx(x1)} ${ty(y1 - (y1 - y0) / 2)} ${tx(x1)} ${ty(y1)}`
        : ` C${tx(x0 + (x1 - x0) / 2)} ${ty(y0)} ${tx(x1 - (x1 - x0) / 2)} ${ty(y1)} ${tx(x1)} ${ty(y1)}`;
    }
    out.push(`<path d="${d}" fill="none" stroke="${e.back ? theme.danger : theme.muted}" stroke-opacity="0.6" stroke-width="${Math.min(5, 1 + Math.log2(1 + e.count) * 0.8).toFixed(1)}"/>`);
  }
  for (const n of scene.nodes) {
    out.push(`<rect x="${tx(n.x - n.w / 2)}" y="${ty(n.y - n.h / 2)}" width="${n.w}" height="${n.h}" rx="8" fill="${theme.bg}" stroke="${n.tint}" stroke-width="1.5"/>`);
    out.push(`<text x="${tx(n.x - n.w / 2 + 12)}" y="${ty(n.y - (n.sub ? 2 : -4))}" font-size="13" font-weight="600" fill="${theme.fg}">${escXml(n.title)}</text>`);
    if (n.sub) out.push(`<text x="${tx(n.x - n.w / 2 + 12)}" y="${ty(n.y + 13)}" font-size="10.5" fill="${theme.muted}">${escXml(n.sub)}</text>`);
  }
  out.push('</svg>');
  return out.join('\n');
}
