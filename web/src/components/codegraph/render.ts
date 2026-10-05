/**
 * Drawing a {@link Scene} on a 2D canvas, fast enough for 5,000 files and
 * tens of thousands of edges: edges batched into one path per style, nodes
 * drawn dim-first so the answer sits on top, labels only where they fit,
 * level of detail by zoom.
 *
 * Canvas rather than SVG or DOM because the browser lays out every SVG
 * element; at this size that is the difference between 60 frames a second
 * and a page that freezes on pan.
 *
 * @module web/components/codegraph/render
 */

import type { Scene } from './scene';

export interface Camera { x: number; y: number; k: number }

export interface Theme {
  bg: string;
  surface: string;
  fg: string;
  muted: string;
  border: string;
  accent: string;
  danger: string;
  warning: string;
  success: string;
  dark: boolean;
}

export function toScreen(cam: Camera, w: number, h: number, x: number, y: number): [number, number] {
  return [(x - cam.x) * cam.k + w / 2, (y - cam.y) * cam.k + h / 2];
}

export function toWorld(cam: Camera, w: number, h: number, sx: number, sy: number): [number, number] {
  return [(sx - w / 2) / cam.k + cam.x, (sy - h / 2) / cam.k + cam.y];
}

/** A camera that fits the given nodes (all when `only` is empty) with padding. */
export function fit(scene: Scene, w: number, h: number, only?: number[], pad = 48): Camera {
  const list = only?.length ? only.map(i => scene.nodes[i]!).filter(Boolean) : scene.nodes;
  if (!list.length) return { x: 0, y: 0, k: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of list) {
    minX = Math.min(minX, n.x - n.r); minY = Math.min(minY, n.y - n.r);
    maxX = Math.max(maxX, n.x + n.r); maxY = Math.max(maxY, n.y + n.r);
  }
  const k = Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY), list.length <= 12 ? 3.2 : 2.2);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, k: Math.max(0.02, k) };
}

/** The scene node under a screen point, or −1. */
export function hitTest(scene: Scene, cam: Camera, w: number, h: number, sx: number, sy: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const n = scene.nodes[i]!;
    const [x, y] = toScreen(cam, w, h, n.x, n.y);
    const r = Math.max(4, n.r * cam.k) + 3;
    const d = (x - sx) ** 2 + (y - sy) ** 2;
    if (d <= r * r && d < bestD && (n.emph > 0 || best === -1)) { best = i; bestD = d; }
  }
  return best;
}

export interface DrawOptions {
  hover: number;
  /** Scene indices to label regardless of zoom. */
  forceLabels?: Set<number>;
  dpr: number;
}

export function draw(ctx: CanvasRenderingContext2D, w: number, h: number, cam: Camera, scene: Scene, theme: Theme, opts: DrawOptions): void {
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);
  const nodes = scene.nodes;
  const anyAnswer = nodes.some(n => n.emph === 2);
  const groupScene = nodes.some(n => n.kind === 'group');
  const edgeBase = theme.dark ? 'rgba(203,213,225,' : 'rgba(71,85,105,';

  // Edges, batched: [emph][dashed] with a default colour; coloured ones grouped by colour.
  const k = cam.k;
  const groups = new Map<string, { width: number; alpha: number; color: string; dashed: boolean; segs: number[] }>();
  const big = scene.edges.length > 8_000;
  for (const e of scene.edges) {
    if (e.emph === 0 && (big || k < 0.25)) continue;
    const alpha = e.emph === 2 ? 0.85 : e.emph === 1 ? (groupScene ? 0.32 : anyAnswer ? 0.1 : big ? 0.07 : 0.16) : 0.045;
    const color = e.color ?? `${edgeBase}1)`;
    const width = Math.max(0.5, Math.min(e.width * (e.emph === 2 ? 1.6 : 1), 8) * Math.min(1.6, Math.max(0.6, k)));
    const key = `${color}|${alpha}|${width.toFixed(1)}|${e.dashed ? 1 : 0}`;
    let g = groups.get(key);
    if (!g) { g = { width, alpha, color, dashed: Boolean(e.dashed), segs: [] }; groups.set(key, g); }
    const a = nodes[e.a]!;
    const b = nodes[e.b]!;
    g.segs.push(a.x, a.y, b.x, b.y);
  }
  ctx.lineCap = 'round';
  const ordered = [...groups.values()].sort((x, y) => x.alpha - y.alpha);
  for (const g of ordered) {
    ctx.globalAlpha = g.alpha;
    ctx.strokeStyle = g.color;
    ctx.lineWidth = g.width;
    ctx.setLineDash(g.dashed ? [4, 3] : []);
    ctx.beginPath();
    for (let i = 0; i < g.segs.length; i += 4) {
      const [x1, y1] = toScreen(cam, w, h, g.segs[i]!, g.segs[i + 1]!);
      const [x2, y2] = toScreen(cam, w, h, g.segs[i + 2]!, g.segs[i + 3]!);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Arrowheads on emphasised edges when zoomed in enough to read direction.
  if (k > 0.6) {
    for (const e of scene.edges) {
      if (e.emph !== 2) continue;
      const a = nodes[e.a]!;
      const b = nodes[e.b]!;
      const [x1, y1] = toScreen(cam, w, h, a.x, a.y);
      const [x2, y2] = toScreen(cam, w, h, b.x, b.y);
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 24) continue;
      const ux = (x2 - x1) / len; const uy = (y2 - y1) / len;
      const tipX = x2 - ux * (Math.max(3, b.r * k) + 2);
      const tipY = y2 - uy * (Math.max(3, b.r * k) + 2);
      const s = 6;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = e.color ?? theme.muted;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * s - uy * s * 0.55, tipY - uy * s + ux * s * 0.55);
      ctx.lineTo(tipX - ux * s + uy * s * 0.55, tipY - uy * s - ux * s * 0.55);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Nodes: dim first, the answer last.
  for (const level of [0, 1, 2] as const) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.emph !== level) continue;
      const [x, y] = toScreen(cam, w, h, n.x, n.y);
      const r = Math.max(n.kind === 'group' ? 6 : 1.6, n.r * k);
      if (x + r < 0 || y + r < 0 || x - r > w || y - r > h) continue;
      ctx.globalAlpha = level === 0 ? (theme.dark ? 0.22 : 0.28) : n.kind === 'group' ? 0.62 : 0.95;
      ctx.fillStyle = n.color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (n.kind === 'group') {
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = theme.bg;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (n.ring || i === opts.hover) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = i === opts.hover ? theme.fg : n.ring!;
        ctx.lineWidth = i === opts.hover ? 2 : 2.5;
        ctx.beginPath();
        ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // Labels: groups always; files when zoomed in, emphasised, or forced; never overlapping.
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const placed: Array<[number, number, number, number]> = [];
  const answerCount = nodes.reduce((c, n) => c + (n.emph === 2 ? 1 : 0), 0);
  const order = nodes.map((_, i) => i).sort((a, b) => (nodes[b]!.emph - nodes[a]!.emph) || ((nodes[b]!.weight ?? 0) - (nodes[a]!.weight ?? 0)) || (nodes[b]!.r - nodes[a]!.r));
  let budget = 450;
  for (const i of order) {
    const n = nodes[i]!;
    if (!n.label || budget <= 0) continue;
    const forced = opts.forceLabels?.has(i) || i === opts.hover;
    const want = forced || (n.kind === 'group' && ((n.weight ?? 3) >= 3 || k > 1)) || (n.emph === 2 && answerCount <= 300) || (n.emph === 1 && k > 1.1);
    if (!want) continue;
    const [x, y] = toScreen(cam, w, h, n.x, n.y);
    const r = Math.max(n.kind === 'group' ? 6 : 1.6, n.r * k);
    if (x < -50 || y < -20 || x > w + 50 || y > h + 20) continue;
    const size = n.kind === 'group' ? 12.5 : 11;
    ctx.font = `${n.kind === 'group' || n.emph === 2 ? 600 : 500} ${size}px Inter, ui-sans-serif, system-ui, sans-serif`;
    const text = n.label.length > 42 ? `${n.label.slice(0, 40)}…` : n.label;
    const tw = ctx.measureText(text).width;
    const top = n.kind === 'group' ? y - size / 2 : y + r + 3;
    const box: [number, number, number, number] = [x - tw / 2 - 3, top - 1, x + tw / 2 + 3, top + size + 2];
    if (!forced && placed.some(p => p[0] < box[2] && box[0] < p[2] && p[1] < box[3] && box[1] < p[3])) continue;
    placed.push(box);
    budget--;
    if (n.kind === 'group') {
      // A pill so a module name reads over its own bubble and over edges.
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = theme.surface;
      roundRect(ctx, box[0] - 2, box[1] - 1, box[2] - box[0] + 4, box[3] - box[1] + 2, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.fg;
    } else {
      ctx.globalAlpha = n.emph === 0 ? 0.45 : 1;
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme.bg;
      ctx.strokeText(text, x, top);
      ctx.fillStyle = n.emph === 0 ? theme.muted : theme.fg;
    }
    ctx.fillText(text, x, top);
  }
  ctx.globalAlpha = 1;
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

/** The overview in the corner: every node as a dot, the visible area as a frame. */
export function drawMinimap(ctx: CanvasRenderingContext2D, mw: number, mh: number, scene: Scene, cam: Camera, viewW: number, viewH: number, theme: Theme, dpr: number): Camera {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, mw, mh);
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, mw, mh);
  const mini = fit(scene, mw, mh, undefined, 8);
  for (const n of scene.nodes) {
    const [x, y] = toScreen(mini, mw, mh, n.x, n.y);
    ctx.globalAlpha = n.emph === 0 ? 0.25 : 0.85;
    ctx.fillStyle = n.color;
    const r = Math.max(n.kind === 'group' ? 2.5 : 0.9, n.r * mini.k);
    ctx.fillRect(x - r / 2, y - r / 2, r, r);
  }
  const [x0, y0] = toWorld(cam, viewW, viewH, 0, 0);
  const [x1, y1] = toWorld(cam, viewW, viewH, viewW, viewH);
  const [a, b] = toScreen(mini, mw, mh, x0, y0);
  const [c, d] = toScreen(mini, mw, mh, x1, y1);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(Math.max(1, a), Math.max(1, b), Math.min(mw - 2, c) - Math.max(1, a), Math.min(mh - 2, d) - Math.max(1, b));
  return mini;
}
