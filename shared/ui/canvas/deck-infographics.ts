/**
 * The infographic library — 26 parametric slide diagrams (chevron process,
 * cycle, pyramid, funnel, hexagons, rings, SWOT, team cards…) laid out by the
 * deck layout engine as native shapes and fitted text.
 *
 * ## Why parametric layouts, not templates or pictures
 *
 * Commercial infographic templates are fixed drawings: three steps, then a
 * fourth step means redrawing. Pictures of diagrams are not editable in
 * PowerPoint. So each kind here is a function of its items (3–7, with titles,
 * short text, a value and an icon each) that places PowerPoint *preset*
 * shapes (`deck-geometry.ts` — chevron, block arc, hexagon, trapezoid,
 * donut…) and fitted text boxes in the content area, the same grid as every
 * other slide. The HTML renderer and the PowerPoint writer draw these frames
 * like any others, so a cycle is a cycle of editable block arcs whose text
 * the person can retype, in the editor, the PDF and PowerPoint alike. Each
 * item's frames share a group id, so in PowerPoint an item moves as one.
 *
 * ## The rules it enforces
 *
 * - Item counts per kind (a cycle of two is a line; a SWOT has four) and the
 *   overflow of every label are reported as problems the agent must fix.
 * - Item colours run through accents 1–5 in order: at most five colours on a
 *   slide, the same order on every slide of the deck.
 * - Text on a coloured shape takes the theme's light or dark slot by measured
 *   contrast (`inkOn`), never "white because it is usually white".
 * - Labels are not set below 12 pt (titles 13 pt): below that is a problem,
 *   not a smaller font.
 *
 * The engine's helpers arrive as a `Kit` argument (see `deck-layout.ts`
 * `KIT`) so this module imports only types from the engine.
 *
 * @module shared/ui/canvas/deck-infographics
 */

import type { Box, Ctx, FitResult, Kit, ParaSpec } from './deck-layout';
import { infographicInfo, plainOf, type InfoItem } from './deck-model';
import type { ColorRef } from './deck-themes';

const F = 'infographic';
const TITLE_MIN = 13;
const TEXT_MIN = 12;

interface Area extends Box { cx: number; cy: number }

function areaOf(c: Ctx, k: Kit): Area {
  const bottom = k.contentBottom(c);
  let top = k.Y0;
  const s = c.slide;
  if (s.body?.trim()) {
    const f = k.fit([{ text: s.body, color: c.r.muted }], c.theme, c.CW, 28, 18, 14, 1);
    k.text(c, 'Lead', { x: c.MX, y: top - 4, w: c.CW, h: 28 }, f, { field: 'body' });
    if (f.overflow) k.problem(c, 'error', 'the lead line over the infographic is longer than one line — shorten it', 'body');
    top += 38;
  }
  const h = bottom - top;
  return { x: c.MX, y: top, w: c.CW, h, cx: c.MX + c.CW / 2, cy: top + h / 2 };
}

/** Title + text specs for an item. */
function specs(c: Ctx, it: InfoItem, o: { color?: ColorRef; textColor?: ColorRef; align?: 'l' | 'c' | 'r'; title?: boolean; text?: boolean; value?: boolean; valueColor?: ColorRef } = {}): ParaSpec[] {
  const out: ParaSpec[] = [];
  const align = o.align ?? 'c';
  if (o.value && it.value) out.push({ text: it.value, font: 'h', bold: true, rel: 1.5, color: o.valueColor ?? o.color ?? c.r.accent, align, lhf: 1.05 });
  if (o.title !== false && it.title) out.push({ text: it.title, font: 'h', bold: true, color: o.color ?? c.r.title, align, ...(out.length ? { beforeEm: 0.15 } : {}) });
  if (o.text !== false && it.text) out.push({ text: it.text.replace(/\n+/g, ' · '), rel: 0.84, color: o.textColor ?? c.r.muted, align, beforeEm: out.length ? 0.35 : 0 });
  return out;
}

/** Fit several items' boxes at one shared size, reporting each that does not fit. */
function fitItems(c: Ctx, k: Kit, items: InfoItem[], groups: { specs: ParaSpec[]; w: number; h: number }[], size: number, min = TEXT_MIN, grow = 3): FitResult[] {
  // Light items are set larger (up to grow points more) while they use little of their box, like the bullets slide.
  const shared = grow > 0 ? k.growShared(groups, c.theme, size, min, size + grow) : k.fitShared(groups, c.theme, size, min);
  shared.results.forEach((r, i) => {
    if (r.overflow) k.problem(c, 'error', `item ${i + 1} ("${plainOf(items[i]?.title ?? '').slice(0, 30)}") does not fit at ${min} pt — cut its text to a short title and one line`, F);
  });
  return shared.results;
}

function icon(c: Ctx, k: Kit, name: string | undefined, box: Box, color: ColorRef, group: string): boolean {
  if (!name) return false;
  if (!k.isIcon(name)) {
    k.problem(c, 'warn', `icon "${name}" is not in the icon set — find_icons lists real ones`, F);
    return false;
  }
  k.shape(c, `Icon ${name}`, box, { geom: 'icon', icon: name, line: { color, w: Math.max(0.75, (box.w / 24) * 2) }, field: F, group });
  return true;
}

/** A number or icon badge centred in a box. */
function badge(c: Ctx, k: Kit, it: InfoItem, i: number, box: Box, fill: ColorRef, ink: ColorRef, group: string, geom: 'ellipse' | 'roundRect' | 'hexagon' = 'ellipse'): void {
  k.shape(c, `Badge ${i + 1}`, box, { geom, fill, field: F, group, ...(geom === 'roundRect' ? { radius: Math.min(12, box.w / 4) } : {}), ...(geom === 'hexagon' ? { adj: [box.w / 4] } : {}) });
  const s = box.w * 0.5;
  if (icon(c, k, it.icon, { x: box.x + (box.w - s) / 2, y: box.y + (box.h - s) / 2, w: s, h: s }, ink, group)) return;
  const f = k.fit([{ text: String(i + 1).padStart(2, '0'), font: 'h', bold: true, color: ink, align: 'c', lhf: 1 }], c.theme, box.w, box.h, Math.round(box.h * 0.4), 10, 1);
  k.text(c, `Badge text ${i + 1}`, box, f, { anchor: 'm', field: F, group });
}

/** A percentage from "72%", "0.72", "72" — rings and stat bars. */
export function percentOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /(-?\d+(?:[.,]\d+)?)/.exec(value.replace(/,(?=\d{3}\b)/g, ''));
  if (!m) return undefined;
  let n = Number(m[1]!.replace(',', '.'));
  if (!/%/.test(value) && n > 0 && n <= 1 && /\./.test(m[1]!)) n *= 100;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : undefined;
}

const tint = (ref: ColorRef, a: number): ColorRef => ({ ...ref, a });

/** Labels down two columns beside a round diagram, evenly spaced in the order of their angles. */
function columnLabels(c: Ctx, k: Kit, a: Area, items: InfoItem[], angles: number[], radius: number, colors: ColorRef[]): void {
  const left: number[] = [];
  const right: number[] = [];
  angles.forEach((ang, i) => {
    const cos = Math.cos((ang * Math.PI) / 180);
    (cos > 0.01 || (Math.abs(cos) <= 0.01 && right.length <= left.length) ? right : left).push(i);
  });
  const sideW = Math.max(120, a.w / 2 - radius - 30);
  const place = (ids: number[], side: 'l' | 'r'): void => {
    ids.sort((p, q) => Math.sin((angles[p]! * Math.PI) / 180) - Math.sin((angles[q]! * Math.PI) / 180));
    const slot = a.h / Math.max(1, ids.length);
    const groups = ids.map(i => ({ specs: specs(c, items[i]!, { align: side === 'l' ? 'r' : 'l', color: k.readable(c, colors[i]!) }), w: sideW, h: Math.min(slot - 8, 110) }));
    const fitted = fitItems(c, k, ids.map(i => items[i]!), groups, 16);
    ids.forEach((i, j) => {
      const x = side === 'r' ? a.cx + radius + 26 : a.cx - radius - 26 - sideW;
      const y = a.y + j * slot + (slot - groups[j]!.h) / 2;
      k.text(c, `Label ${i + 1}`, { x, y, w: sideW, h: groups[j]!.h }, fitted[j]!, { anchor: 'm', field: F, group: `g${i + 1}` });
    });
  };
  place(right, 'r');
  place(left, 'l');
}

// ── The kinds ────────────────────────────────────────────────────────

function processKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const depth = Math.max(16, Math.min(26, a.w / n / 6));
  const gap = 6;
  const cw = (a.w + (depth - gap) * (n - 1)) / n;
  const bandH = Math.max(66, Math.min(84, a.h * 0.22));
  const hasIcons = items.some(it => it.icon);
  const iconD = hasIcons ? 64 : 0;
  const textH = Math.min(150, a.h - iconD - (hasIcons ? 18 : 0) - bandH - 18);
  const blockH = iconD + (hasIcons ? 18 : 0) + bandH + 18 + textH;
  const y0 = a.y + Math.max(0, (a.h - blockH) / 2);
  const bandY = y0 + iconD + (hasIcons ? 18 : 0);
  const inner = (i: number): number => cw - depth - (i ? depth : 14) - 8;
  const titles = fitItems(c, k, items, items.map((it, i) => ({ specs: [{ text: it.title, font: 'h' as const, bold: true, color: k.ink(c, k.accent(i)), align: 'c' as const }], w: inner(i), h: bandH - 10 })), 19, TITLE_MIN, 0);
  const texts = fitItems(c, k, items, items.map(it => ({ specs: it.text ? [{ text: it.text, color: c.r.text, align: 'c' as const }] : [], w: cw - depth - 6, h: textH })), 16);
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const x = a.x + i * (cw - depth + gap);
    const acc = k.accent(i);
    const visualCx = x + (i ? depth : 0) / 2 + (cw - depth) / 2;
    if (hasIcons) {
      k.shape(c, `Icon disc ${i + 1}`, { x: visualCx - iconD / 2, y: y0, w: iconD, h: iconD }, { geom: 'ellipse', fill: tint(acc, 0.16), field: F, group: g });
      icon(c, k, it.icon, { x: visualCx - 16, y: y0 + iconD / 2 - 16, w: 32, h: 32 }, acc, g);
    }
    k.shape(c, `Step ${i + 1}`, { x, y: bandY, w: cw, h: bandH }, { geom: i ? 'chevron' : 'homePlate', adj: [depth], fill: acc, field: F, group: g });
    k.text(c, `Step title ${i + 1}`, { x: x + (i ? depth : 14) + 4, y: bandY + 5, w: inner(i), h: bandH - 10 }, titles[i]!, { anchor: 'm', field: F, group: g });
    if (it.text) k.text(c, `Step text ${i + 1}`, { x: visualCx - (cw - depth - 6) / 2, y: bandY + bandH + 18, w: cw - depth - 6, h: textH }, texts[i]!, { field: F, group: g });
  });
}

function arrowsKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const gap = 12;
  const rowH = Math.min(70, (a.h - gap * (n - 1)) / n);
  const total = n * rowH + gap * (n - 1);
  const y0 = a.y + (a.h - total) / 2;
  const stagger = Math.min(26, (a.w * 0.14) / Math.max(1, n - 1));
  const bw = a.w * 0.46;
  const numW = rowH * 0.9;
  const titles = fitItems(c, k, items, items.map((it, i) => ({ specs: [{ text: it.title, font: 'h' as const, bold: true, color: k.ink(c, k.accent(i)) }], w: bw - numW - rowH * 0.45 - 16, h: rowH - 10 })), 18, TITLE_MIN);
  const descW = a.w - bw - stagger * (n - 1) - 22;
  const texts = fitItems(c, k, items, items.map(it => ({ specs: it.text ? [{ text: it.text, color: c.r.text }] : [], w: descW, h: rowH })), 16);
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const ink = k.ink(c, acc);
    const x = a.x + i * stagger;
    const y = y0 + i * (rowH + gap);
    k.shape(c, `Arrow ${i + 1}`, { x, y, w: bw, h: rowH }, { geom: 'homePlate', adj: [rowH * 0.45], fill: acc, field: F, group: g });
    k.shape(c, `Number field ${i + 1}`, { x, y, w: numW, h: rowH }, { geom: 'rect', fill: { s: 'dk1', a: 0.14 }, field: F, group: g });
    if (!icon(c, k, it.icon, { x: x + (numW - rowH * 0.42) / 2, y: y + rowH * 0.29, w: rowH * 0.42, h: rowH * 0.42 }, ink, g)) {
      const nf = k.fit([{ text: String(i + 1).padStart(2, '0'), font: 'h', bold: true, color: ink, align: 'c', lhf: 1 }], c.theme, numW, rowH, Math.round(rowH * 0.42), 12, 1);
      k.text(c, `Number ${i + 1}`, { x, y, w: numW, h: rowH }, nf, { anchor: 'm', field: F, group: g });
    }
    k.text(c, `Arrow title ${i + 1}`, { x: x + numW + 12, y: y + 5, w: bw - numW - rowH * 0.45 - 16, h: rowH - 10 }, titles[i]!, { anchor: 'm', field: F, group: g });
    if (it.text) k.text(c, `Arrow text ${i + 1}`, { x: x + bw + 22, y, w: descW, h: rowH }, texts[i]!, { anchor: 'm', field: F, group: g });
  });
}

function cycleKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const D = Math.min(a.h, 310, a.w * 0.4);
  const R = D / 2;
  const thick = D * 0.17;
  const box = { x: a.cx - R, y: a.cy - R, w: D, h: D };
  const step = 360 / n;
  const gapDeg = 5;
  const mids: number[] = [];
  const colors = items.map((_, i) => k.accent(i));
  const centre = c.slide.infographic?.centre;
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const start = -90 + i * step + gapDeg / 2;
    const end = start + step - gapDeg;
    mids.push((start + end) / 2);
    k.shape(c, `Segment ${i + 1}`, box, { geom: 'blockArc', adj: [start, end, thick], fill: colors[i], field: F, group: g });
    // Arrowhead at the segment's end, pointing clockwise.
    const ah = thick * 1.35;
    const at = ((end + 1.5) * Math.PI) / 180;
    const rr = R - thick / 2;
    k.shape(c, `Arrowhead ${i + 1}`, { x: a.cx + rr * Math.cos(at) - ah / 2, y: a.cy + rr * Math.sin(at) - (ah * 0.62) / 2, w: ah, h: ah * 0.62 }, { geom: 'triangle', rot: end + 1.5 + 180, fill: colors[i], field: F, group: g });
    const m = (((start + end) / 2) * Math.PI) / 180;
    const is = thick * 0.56;
    if (!icon(c, k, it.icon, { x: a.cx + rr * Math.cos(m) - is / 2, y: a.cy + rr * Math.sin(m) - is / 2, w: is, h: is }, k.ink(c, colors[i]!), g)) {
      const nf = k.fit([{ text: String(i + 1), font: 'h', bold: true, color: k.ink(c, colors[i]!), align: 'c', lhf: 1 }], c.theme, is * 1.4, is * 1.2, Math.round(thick * 0.45), 10, 1);
      k.text(c, `Number ${i + 1}`, { x: a.cx + rr * Math.cos(m) - is * 0.7, y: a.cy + rr * Math.sin(m) - is * 0.6, w: is * 1.4, h: is * 1.2 }, nf, { anchor: 'm', field: F, group: g });
    }
  });
  const hub = D - 2 * thick - 26;
  k.shape(c, 'Hub', { x: a.cx - hub / 2, y: a.cy - hub / 2, w: hub, h: hub }, { geom: 'ellipse', fill: c.r.surface, field: F });
  if (centre) {
    const f = k.fit([{ text: centre, font: 'h', bold: true, color: c.r.title, align: 'c' }], c.theme, hub * 0.72, hub * 0.6, 20, TITLE_MIN);
    k.text(c, 'Hub label', { x: a.cx - hub * 0.36, y: a.cy - hub * 0.3, w: hub * 0.72, h: hub * 0.6 }, f, { anchor: 'm', field: F });
    if (f.overflow) k.problem(c, 'error', 'the centre label is too long — two or three words', F);
  }
  columnLabels(c, k, a, items, mids, R, colors);
}

function semicircleKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const labelH = 70;
  const R = Math.min(a.w * 0.26, a.h - labelH - 16);
  const thick = R * 0.34;
  const cy = a.y + a.h - 8;
  const cx = a.cx;
  const box = { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R };
  const step = 180 / n;
  const colors = items.map((_, i) => k.accent(i));
  const lw = Math.min(190, (a.w - 2 * R) / 2 + 60);
  const groups = items.map((it, i) => ({ specs: specs(c, it, { color: k.readable(c, colors[i]!), align: 'c' }), w: lw, h: labelH }));
  const fitted = fitItems(c, k, items, groups, 15);
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const start = 180 + i * step + 1;
    const end = start + step - 2;
    k.shape(c, `Segment ${i + 1}`, box, { geom: 'blockArc', adj: [start, end, thick], fill: colors[i], field: F, group: g });
    const m = (((start + end) / 2) * Math.PI) / 180;
    const rr = R - thick / 2;
    const is = thick * 0.5;
    if (!icon(c, k, it.icon, { x: cx + rr * Math.cos(m) - is / 2, y: cy + rr * Math.sin(m) - is / 2, w: is, h: is }, k.ink(c, colors[i]!), g)) {
      const nf = k.fit([{ text: String(i + 1), font: 'h', bold: true, color: k.ink(c, colors[i]!), align: 'c', lhf: 1 }], c.theme, is * 1.6, is * 1.2, Math.round(thick * 0.42), 10, 1);
      k.text(c, `Number ${i + 1}`, { x: cx + rr * Math.cos(m) - is * 0.8, y: cy + rr * Math.sin(m) - is * 0.6, w: is * 1.6, h: is * 1.2 }, nf, { anchor: 'm', field: F, group: g });
    }
    // The label outside the arc: right of it on the right, left on the left, above near the top.
    const ax = cx + (R + 14) * Math.cos(m);
    const ay = cy + (R + 14) * Math.sin(m);
    const cos = Math.cos(m);
    let lx = ax - lw / 2;
    let ly = ay - labelH;
    if (cos < -0.35) { lx = ax - lw; ly = ay - labelH * 0.75; }
    else if (cos > 0.35) { lx = ax; ly = ay - labelH * 0.75; }
    lx = Math.max(a.x, Math.min(a.x + a.w - lw, lx));
    ly = Math.max(a.y - 8, ly);
    k.text(c, `Label ${i + 1}`, { x: lx, y: ly, w: lw, h: labelH }, fitted[i]!, { anchor: cos < -0.35 || cos > 0.35 ? 'm' : 'b', field: F, group: g });
  });
  const centre = c.slide.infographic?.centre;
  if (centre) {
    const f = k.fit([{ text: centre, font: 'h', bold: true, color: c.r.title, align: 'c' }], c.theme, (R - thick) * 1.5, (R - thick) * 0.6, 20, TITLE_MIN);
    k.text(c, 'Centre label', { x: cx - (R - thick) * 0.75, y: cy - (R - thick) * 0.68, w: (R - thick) * 1.5, h: (R - thick) * 0.6 }, f, { anchor: 'b', field: F });
  }
}

function radialKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const hub = Math.min(a.h * 0.36, 128);
  const L = Math.min(a.h / 2 - hub * 0.2, 150);
  const colors = items.map((_, i) => k.accent(i));
  const angles: number[] = [];
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const ang = -90 + (i * 360) / n;
    angles.push(ang);
    const t = (ang * Math.PI) / 180;
    const rc = hub * 0.3 + L / 2;
    const pw = L;
    const ph = Math.min(L * 0.52, ((2 * Math.PI * (hub * 0.3 + L * 0.6)) / n) * 0.8);
    k.shape(c, `Petal ${i + 1}`, { x: a.cx + rc * Math.cos(t) - pw / 2, y: a.cy + rc * Math.sin(t) - ph / 2, w: pw, h: ph }, { geom: 'ellipse', rot: ang, fill: colors[i], field: F, group: g });
    const ir = hub * 0.3 + L * 0.7;
    const is = Math.min(ph * 0.5, 30);
    if (!icon(c, k, it.icon, { x: a.cx + ir * Math.cos(t) - is / 2, y: a.cy + ir * Math.sin(t) - is / 2, w: is, h: is }, k.ink(c, colors[i]!), g)) {
      const nf = k.fit([{ text: String(i + 1), font: 'h', bold: true, color: k.ink(c, colors[i]!), align: 'c', lhf: 1 }], c.theme, is * 1.4, is * 1.2, Math.round(is * 0.8), 10, 1);
      k.text(c, `Number ${i + 1}`, { x: a.cx + ir * Math.cos(t) - is * 0.7, y: a.cy + ir * Math.sin(t) - is * 0.6, w: is * 1.4, h: is * 1.2 }, nf, { anchor: 'm', field: F, group: g });
    }
  });
  k.shape(c, 'Core ring', { x: a.cx - hub / 2 - 6, y: a.cy - hub / 2 - 6, w: hub + 12, h: hub + 12 }, { geom: 'ellipse', fill: c.r.bg, field: F });
  k.shape(c, 'Core', { x: a.cx - hub / 2, y: a.cy - hub / 2, w: hub, h: hub }, { geom: 'ellipse', fill: c.r.title, field: F });
  const centre = c.slide.infographic?.centre;
  if (centre) {
    const f = k.fit([{ text: centre, font: 'h', bold: true, color: k.ink(c, c.r.title), align: 'c' }], c.theme, hub * 0.74, hub * 0.6, 19, TITLE_MIN);
    k.text(c, 'Core label', { x: a.cx - hub * 0.37, y: a.cy - hub * 0.3, w: hub * 0.74, h: hub * 0.6 }, f, { anchor: 'm', field: F });
    if (f.overflow) k.problem(c, 'error', 'the centre label is too long — two or three words', F);
  }
  columnLabels(c, k, a, items, angles, hub * 0.3 + L, colors);
}

function layersKind(c: Ctx, k: Kit, a: Area, items: InfoItem[], funnel: boolean): void {
  const n = items.length;
  const gap = 6;
  const PW = Math.min(a.w * 0.46, a.h * (funnel ? 1.3 : 1.15));
  const lh = (a.h - gap * (n - 1)) / n;
  const px = a.x + 10;
  const widthAt = (y: number): number => (funnel ? PW * (1 - 0.72 * ((y - a.y) / a.h)) : PW * ((y - a.y) / a.h));
  const lx = px + PW + 40;
  const lw = a.x + a.w - lx;
  const labels = fitItems(c, k, items, items.map((it, i) => ({ specs: specs(c, it, { align: 'l', color: k.readable(c, k.accent(i)) }), w: lw, h: lh })), 16);
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const y = a.y + i * (lh + gap);
    const tw = widthAt(y);
    const bw = widthAt(y + lh);
    const w = Math.max(tw, bw);
    const x = px + (PW - w) / 2;
    const inset = Math.abs(tw - bw) / 2;
    if (!funnel && i === 0) k.shape(c, `Layer ${i + 1}`, { x, y, w, h: lh }, { geom: 'triangle', fill: acc, field: F, group: g });
    else k.shape(c, `Layer ${i + 1}`, { x, y, w, h: lh }, { geom: 'trapezoid', adj: [inset], ...(funnel ? { flipV: true } : {}), fill: acc, field: F, group: g });
    const ink = k.ink(c, acc);
    const inner = Math.min(tw, bw) * 0.8;
    const label = funnel && it.value ? it.value : String(i + 1);
    const nf = k.fit([{ text: label, font: 'h', bold: true, color: ink, align: 'c', lhf: 1 }], c.theme, Math.max(30, inner), lh * 0.8, Math.min(26, Math.round(lh * 0.42)), 11, 1);
    k.text(c, `Layer label ${i + 1}`, { x: px + PW / 2 - Math.max(30, inner) / 2, y: y + (!funnel && i === 0 ? lh * 0.25 : lh * 0.1), w: Math.max(30, inner), h: lh * (!funnel && i === 0 ? 0.7 : 0.8) }, nf, { anchor: 'm', field: F, group: g });
    // A leader from the layer's edge to its label.
    const edge = px + (PW + Math.max(tw, bw)) / 2;
    k.shape(c, `Leader ${i + 1}`, { x: edge + 8, y: y + lh / 2 - 1, w: lx - edge - 16, h: 2 }, { geom: 'rect', fill: tint(acc, 0.6), field: F, group: g });
    k.shape(c, `Leader dot ${i + 1}`, { x: lx - 12, y: y + lh / 2 - 4, w: 8, h: 8 }, { geom: 'ellipse', fill: acc, field: F, group: g });
    k.text(c, `Layer text ${i + 1}`, { x: lx, y, w: lw, h: lh }, labels[i]!, { anchor: 'm', field: F, group: g });
  });
}

function hexKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const textH = 74;
  const hw = Math.min(a.w / (0.75 * (n - 1) + 1) - 6, (a.h - 2 * textH - 10) / (1.5 * 0.866), 176);
  const hh = hw * 0.866;
  const total = hw * (0.75 * (n - 1) + 1) + 6 * (n - 1);
  const x0 = a.x + (a.w - total) / 2;
  const rowTop = a.y + textH + Math.max(0, (a.h - 2 * textH - 1.5 * hh - 6) / 2);
  const tw = Math.min(hw * 1.45, (a.w / n) * 1.9);
  const inside = fitItems(c, k, items, items.map((it, i) => ({ specs: [{ text: it.title, font: 'h' as const, bold: true, color: k.ink(c, k.accent(i)), align: 'c' as const }], w: hw * 0.66, h: hh * (it.icon ? 0.4 : 0.6) })), 16, TITLE_MIN);
  const texts = fitItems(c, k, items, items.map(it => ({ specs: it.text ? [{ text: it.text, color: c.r.text, align: 'c' as const }] : [], w: tw, h: textH - 8 })), 14);
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const ink = k.ink(c, acc);
    const x = x0 + i * (hw * 0.75 + 6);
    const y = rowTop + (i % 2 ? hh / 2 + 6 : 0);
    k.shape(c, `Hexagon ${i + 1}`, { x, y, w: hw, h: hh }, { geom: 'hexagon', adj: [hw / 4], fill: acc, field: F, group: g });
    const is = hh * 0.26;
    const hasIcon = icon(c, k, it.icon, { x: x + hw / 2 - is / 2, y: y + hh * 0.16, w: is, h: is }, ink, g);
    k.text(c, `Hexagon title ${i + 1}`, { x: x + hw * 0.17, y: hasIcon ? y + hh * 0.46 : y + hh * 0.2, w: hw * 0.66, h: hh * (hasIcon ? 0.4 : 0.6) }, inside[i]!, { anchor: hasIcon ? 't' : 'm', field: F, group: g });
    if (it.text) {
      const above = i % 2 === 0;
      k.text(c, `Hexagon text ${i + 1}`, { x: x + hw / 2 - tw / 2, y: above ? y - textH + 2 : y + hh + 8, w: tw, h: textH - 8 }, texts[i]!, { anchor: above ? 'b' : 't', field: F, group: g });
    }
  });
}

function stairsKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const gap = 10;
  const sw = (a.w - gap * (n - 1)) / n;
  const minH = Math.min(a.h * 0.5, 170);
  const groups = items.map((it, i) => ({ specs: specs(c, it, { color: k.ink(c, k.accent(i)), textColor: k.ink(c, k.accent(i)), align: 'l' }), w: sw - 28, h: minH - 70 }));
  const fitted = fitItems(c, k, items, groups, 16);
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const h = n === 1 ? a.h : minH + ((a.h - minH) * i) / (n - 1);
    const x = a.x + i * (sw + gap);
    const y = a.y + a.h - h;
    k.shape(c, `Step ${i + 1}`, { x, y, w: sw, h }, { geom: c.theme.radius ? 'topRound' : 'rect', radius: Math.min(12, c.theme.radius), fill: acc, field: F, group: g });
    const ink = k.ink(c, acc);
    if (!icon(c, k, it.icon, { x: x + 14, y: y + 16, w: 30, h: 30 }, ink, g)) {
      const nf = k.fit([{ text: String(i + 1).padStart(2, '0'), font: 'h', bold: true, color: ink, lhf: 1 }], c.theme, sw - 28, 36, 28, 14, 1);
      k.text(c, `Step number ${i + 1}`, { x: x + 14, y: y + 12, w: sw - 28, h: 36 }, nf, { anchor: 'm', field: F, group: g });
    }
    k.text(c, `Step text ${i + 1}`, { x: x + 14, y: y + 60, w: sw - 28, h: minH - 70 }, fitted[i]!, { field: F, group: g });
  });
}

function alternating(c: Ctx, k: Kit, a: Area, items: InfoItem[], road: boolean): void {
  const n = items.length;
  const slot = a.w / n;
  const axisY = a.cy;
  const markD = road ? 28 : Math.min(64, slot * 0.5);
  const lw = Math.min(slot * (road ? 1.6 : 1.8), a.w / Math.ceil(n / 2) - (road ? 24 : 12));
  const lh = a.h / 2 - markD / 2 - (road ? 34 : 18);
  if (road) k.shape(c, 'Road', { x: a.x, y: axisY - 24, w: a.w, h: 48 }, { geom: 'rightArrow', adj: [0.62, 40], fill: c.r.title, field: F });
  else k.shape(c, 'Axis', { x: a.x, y: axisY - 2, w: a.w, h: 4 }, { geom: 'rect', fill: c.r.line, field: F });
  const groups = items.map((it, i) => ({ specs: specs(c, it, { value: true, color: c.r.title, valueColor: k.readable(c, k.accent(i)), align: 'c' }).map(s => (s.rel === 1.5 ? { ...s, rel: 1.15 } : s)), w: lw - (road ? 20 : 0), h: lh - (road ? 20 : 0) }));
  const fitted = fitItems(c, k, items, groups, 16);
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const cx = a.x + slot * i + slot / 2;
    const above = i % 2 === 0;
    const ly = above ? axisY - markD / 2 - (road ? 26 : 12) - lh : axisY + markD / 2 + (road ? 26 : 12);
    const lx = Math.max(a.x, Math.min(a.x + a.w - lw, cx - lw / 2));
    if (road) {
      k.shape(c, `Stem ${i + 1}`, { x: cx - 1, y: above ? ly + lh : axisY + 13, w: 2, h: above ? axisY - 13 - (ly + lh) : ly - axisY - 13 }, { geom: 'rect', fill: acc, field: F, group: g });
      k.shape(c, `Card ${i + 1}`, { x: lx, y: ly, w: lw, h: lh }, { geom: 'roundRect', radius: Math.min(10, c.theme.radius || 4), fill: c.r.surface, field: F, group: g });
      k.shape(c, `Card edge ${i + 1}`, { x: lx, y: above ? ly + lh - 4 : ly, w: lw, h: 4 }, { geom: 'rect', fill: acc, field: F, group: g });
      k.shape(c, `Marker ${i + 1}`, { x: cx - markD / 2, y: axisY - markD / 2, w: markD, h: markD }, { geom: 'ellipse', fill: c.r.bg, line: { color: acc, w: 5 }, field: F, group: g });
      k.text(c, `Milestone ${i + 1}`, { x: lx + 10, y: ly + 10, w: lw - 20, h: lh - 20 }, fitted[i]!, { anchor: 'm', field: F, group: g });
    } else {
      k.shape(c, `Tick ${i + 1}`, { x: cx - 1, y: above ? axisY - markD / 2 - 12 : axisY + markD / 2, w: 2, h: 12 }, { geom: 'rect', fill: acc, field: F, group: g });
      badge(c, k, it, i, { x: cx - markD / 2, y: axisY - markD / 2, w: markD, h: markD }, acc, k.ink(c, acc), g);
      k.text(c, `Event ${i + 1}`, { x: lx, y: ly, w: lw, h: lh }, fitted[i]!, { anchor: above ? 'b' : 't', field: F, group: g });
    }
  });
}

function cardsKind(c: Ctx, k: Kit, a: Area, items: InfoItem[], grid: boolean): void {
  const n = items.length;
  const cols = grid ? (n <= 4 ? n : Math.ceil(n / 2)) : n;
  const rows = Math.ceil(n / cols);
  const gap = 22;
  const cw = (a.w - gap * (cols - 1)) / cols;
  const ch = (a.h - gap * (rows - 1)) / rows;
  const badgeD = grid ? Math.min(rows === 1 ? 80 : 60, ch * 0.34) : 58;
  const textTop = grid ? badgeD + 22 : 92;
  const groups = items.map(it => ({ specs: specs(c, it, { align: grid ? 'c' : 'l', value: false }), w: cw - 40, h: ch - textTop - 18 }));
  const fitted = fitItems(c, k, items, groups, grid ? 17 : 19);
  const used = Math.max(...fitted.map(f => f.height));
  // Cards hug their content, centred in the area, so three short points do not sit in three tall empty boxes.
  const cardH = grid ? ch : Math.min(ch, Math.max(ch * 0.5, textTop + used + 30));
  // A single row of features sits in the middle of the area, not stuck under the title.
  const y0 = grid ? (rows === 1 ? a.y + Math.max(0, (a.h - (textTop + used + 10)) / 2) : a.y) : a.y + (a.h - cardH) / 2;
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = a.x + col * (cw + gap);
    const y = y0 + row * (ch + gap);
    if (grid) {
      badge(c, k, it, i, { x: x + cw / 2 - badgeD / 2, y: y + 4, w: badgeD, h: badgeD }, tint(acc, 0.16), acc, g);
      k.text(c, `Feature ${i + 1}`, { x: x + 20, y: y + textTop, w: cw - 40, h: Math.min(ch - textTop - 18, a.y + a.h - (y + textTop)) }, fitted[i]!, { field: F, group: g });
      return;
    }
    k.shape(c, `Card ${i + 1}`, { x, y, w: cw, h: cardH }, { geom: c.theme.radius ? 'roundRect' : 'rect', radius: c.theme.radius, fill: c.r.surface, field: F, group: g });
    k.shape(c, `Card bar ${i + 1}`, { x, y, w: cw, h: 6 }, { geom: c.theme.radius ? 'topRound' : 'rect', radius: Math.min(6, c.theme.radius), fill: acc, field: F, group: g });
    if (it.value) {
      const vf = k.fit([{ text: it.value, font: 'h', bold: true, color: k.readable(c, acc), lhf: 1 }], c.theme, cw - 40, 56, 40, 20, 1);
      k.text(c, `Card value ${i + 1}`, { x: x + 20, y: y + 24, w: cw - 40, h: 56 }, vf, { anchor: 'm', field: F, group: g });
    } else if (it.icon && k.isIcon(it.icon)) badge(c, k, it, i, { x: x + 20, y: y + 26, w: badgeD, h: badgeD }, tint(acc, 0.16), acc, g);
    else {
      const nf = k.fit([{ text: String(i + 1).padStart(2, '0'), font: 'h', bold: true, color: k.readable(c, acc), lhf: 1 }], c.theme, cw - 40, 56, 44, 20, 1);
      k.text(c, `Card number ${i + 1}`, { x: x + 20, y: y + 24, w: cw - 40, h: 56 }, nf, { anchor: 'm', field: F, group: g });
    }
    k.text(c, `Card text ${i + 1}`, { x: x + 20, y: y + textTop, w: cw - 40, h: cardH - textTop - 18 }, fitted[i]!, { field: F, group: g });
  });
}

/** Lines of an item's text as their own paragraphs, each with a mark. */
function lineSpecs(c: Ctx, text: string | undefined, mark: string, markColor: ColorRef, color: ColorRef = c.r.text): ParaSpec[] {
  return (text ?? '').split('\n').map(l => l.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, '').trim()).filter(Boolean)
    .map((l, i) => ({ text: l, color, bullet: mark, bulletColor: markColor, indentEm: 1.2, beforeEm: i ? 0.5 : 0 }));
}

function twoPanels(c: Ctx, k: Kit, a: Area, items: InfoItem[], mode: 'versus' | 'pros-cons' | 'before-after'): void {
  const mid = mode === 'pros-cons' ? 36 : 96;
  const pw = (a.w - mid) / 2;
  const headH = 64;
  // "Before" is the neutral grey of the theme's text, so the change reads as grey → colour whatever the palette.
  const colors: ColorRef[] = mode === 'before-after' ? [{ s: 'dk1', mod: 0.5, off: 0.38 }, k.accent(0)] : [k.accent(0), k.accent(1)];
  const marks = mode === 'pros-cons' ? ['✓', '×'] : ['•', '•'];
  const hasImg = mode === 'before-after' && items.some(it => it.image?.src);
  const imgH = hasImg ? Math.min(130, a.h * 0.36) : 0;
  const bodies = items.slice(0, 2).map((it, i) => ({ specs: lineSpecs(c, it.text, marks[i]!, colors[i]!), w: pw - 44, h: a.h - headH - imgH - 40 }));
  const fitted = k.growShared(bodies, c.theme, 18, TEXT_MIN, 22);
  fitted.results.forEach((r, i) => { if (r.overflow) k.problem(c, 'error', `the ${i ? 'second' : 'first'} panel's points do not fit at ${TEXT_MIN} pt — fewer or shorter lines`, F); });
  // Panels hug their points (at least 60% of the area), centred, so two short lists do not sit in two tall empty boxes.
  const used = Math.max(...fitted.results.map(r => r.height));
  const ph = Math.min(a.h, Math.max(a.h * 0.6, headH + imgH + used + 56));
  const py = a.y + (a.h - ph) / 2;
  items.slice(0, 2).forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = colors[i]!;
    const ink = k.ink(c, acc);
    const x = a.x + i * (pw + mid);
    k.shape(c, `Panel ${i + 1}`, { x, y: py, w: pw, h: ph }, { geom: c.theme.radius ? 'roundRect' : 'rect', radius: c.theme.radius, fill: c.r.surface, field: F, group: g });
    k.shape(c, `Panel head ${i + 1}`, { x, y: py, w: pw, h: headH }, { geom: c.theme.radius ? 'topRound' : 'rect', radius: c.theme.radius, fill: acc, field: F, group: g });
    const iconName = it.icon ?? (mode === 'pros-cons' ? (i ? 'circle-x' : 'circle-check') : undefined);
    const has = icon(c, k, iconName, { x: x + 20, y: py + headH / 2 - 14, w: 28, h: 28 }, ink, g);
    const hf = k.fit([{ text: it.title, font: 'h', bold: true, color: ink }], c.theme, pw - (has ? 80 : 40) - (it.value ? 110 : 0), headH - 12, 22, TITLE_MIN, 2);
    k.text(c, `Panel title ${i + 1}`, { x: x + (has ? 60 : 20), y: py + 6, w: pw - (has ? 80 : 40) - (it.value ? 110 : 0), h: headH - 12 }, hf, { anchor: 'm', field: F, group: g });
    if (it.value) {
      const vf = k.fit([{ text: it.value, font: 'h', bold: true, color: ink, align: 'r' }], c.theme, 100, headH - 12, 24, 13, 1);
      k.text(c, `Panel value ${i + 1}`, { x: x + pw - 120, y: py + 6, w: 100, h: headH - 12 }, vf, { anchor: 'm', field: F, group: g });
    }
    if (hasImg) k.imageFrame(c, { x: x + 22, y: py + headH + 18, w: pw - 44, h: imgH - 8 }, { img: it.image, field: F, name: `Panel picture ${i + 1}`, group: g, mask: 'rounded', warnEmpty: false });
    k.text(c, `Panel points ${i + 1}`, { x: x + 22, y: py + headH + 22 + imgH, w: pw - 44, h: ph - headH - imgH - 40 }, fitted.results[i]!, { field: F, group: g });
  });
  if (mode === 'versus') {
    const d = 72;
    k.shape(c, 'VS', { x: a.cx - d / 2, y: a.cy - d / 2, w: d, h: d }, { geom: 'ellipse', fill: c.r.title, line: { color: c.r.bg, w: 4 }, field: F });
    const f = k.fit([{ text: 'VS', font: 'h', bold: true, color: k.ink(c, c.r.title), align: 'c', lhf: 1 }], c.theme, d, d, 24, 14, 1);
    k.text(c, 'VS label', { x: a.cx - d / 2, y: a.cy - d / 2, w: d, h: d }, f, { anchor: 'm', field: F });
  } else if (mode === 'before-after') {
    k.shape(c, 'Change arrow', { x: a.cx - 30, y: a.cy - 28, w: 60, h: 56 }, { geom: 'chevron', adj: [26], fill: colors[1]!, field: F });
  }
}

function swotKind(c: Ctx, k: Kit, a: Area, items: InfoItem[], matrix: boolean): void {
  const axes = c.slide.infographic?.axes;
  const axisW = matrix ? 40 : 0;
  const gx = a.x + axisW;
  const gw = a.w - axisW;
  const gh = a.h - (matrix ? 46 : 0);
  const gap = 14;
  const qw = (gw - gap) / 2;
  const qh = (gh - gap) / 2;
  const tile = Math.min(56, qh * 0.4);
  const bodies = items.slice(0, 4).map(it => ({ specs: matrix ? specs(c, it, { align: 'l', title: false, color: c.r.text }) : lineSpecs(c, it.text, '•', c.r.muted), w: qw - tile - 52, h: qh - 58 }));
  const fitted = k.fitShared(bodies, c.theme, 16, TEXT_MIN);
  fitted.results.forEach((r, i) => { if (r.overflow) k.problem(c, 'error', `quadrant ${i + 1} ("${plainOf(items[i]?.title ?? '').slice(0, 24)}") does not fit at ${TEXT_MIN} pt — fewer, shorter points`, F); });
  items.slice(0, 4).forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const x = gx + (i % 2) * (qw + gap);
    const y = a.y + Math.floor(i / 2) * (qh + gap);
    const strong = matrix && i === 1;
    k.shape(c, `Quadrant ${i + 1}`, { x, y, w: qw, h: qh }, { geom: c.theme.radius ? 'roundRect' : 'rect', radius: c.theme.radius, fill: strong ? acc : tint(acc, 0.13), field: F, group: g });
    const ink = strong ? k.ink(c, acc) : c.r.title;
    let tx = x + 20;
    if (!matrix) {
      k.shape(c, `Letter tile ${i + 1}`, { x: x + 18, y: y + 18, w: tile, h: tile }, { geom: c.theme.radius ? 'roundRect' : 'rect', radius: Math.min(10, c.theme.radius), fill: acc, field: F, group: g });
      const lf = k.fit([{ text: (it.title.trim()[0] ?? '?').toUpperCase(), font: 'h', bold: true, color: k.ink(c, acc), align: 'c', lhf: 1 }], c.theme, tile, tile, Math.round(tile * 0.6), 14, 1);
      k.text(c, `Letter ${i + 1}`, { x: x + 18, y: y + 18, w: tile, h: tile }, lf, { anchor: 'm', field: F, group: g });
      tx = x + tile + 34;
    }
    const tf = k.fit([{ text: it.title, font: 'h', bold: true, color: strong ? ink : k.readable(c, acc) }], c.theme, x + qw - tx - 16, 34, 20, TITLE_MIN, 1);
    k.text(c, `Quadrant title ${i + 1}`, { x: tx, y: y + 16, w: x + qw - tx - 16, h: 34 }, tf, { anchor: 'm', field: F, group: g });
    const body = strong ? { ...fitted.results[i]!, paras: fitted.results[i]!.paras.map(p => ({ ...p, color: ink })) } : fitted.results[i]!;
    k.text(c, `Quadrant text ${i + 1}`, { x: tx, y: y + 56, w: x + qw - tx - 16, h: qh - 64 }, body, { field: F, group: g });
  });
  if (matrix) {
    // Axes: an arrow up the left (a right arrow turned −90° about its centre) and one along the bottom, labelled at their heads.
    const ax = a.x + 16;
    k.shape(c, 'Y axis', { x: ax - gh / 2, y: a.y + gh / 2 - 9, w: gh, h: 18 }, { geom: 'rightArrow', adj: [0.3, 14], rot: -90, fill: c.r.muted, field: F });
    k.shape(c, 'X axis', { x: gx, y: a.y + gh + 8, w: gw, h: 18 }, { geom: 'rightArrow', adj: [0.3, 14], fill: c.r.muted, field: F });
    if (axes?.[0]) {
      const f = k.fit([{ text: `${axes[0]} →`, color: c.r.muted, bold: true, align: 'r', caps: true, trackingEm: 0.08 }], c.theme, gw * 0.6, 18, 12, 10, 1);
      k.text(c, 'X label', { x: gx + gw * 0.4, y: a.y + gh + 26, w: gw * 0.6, h: 18 }, f, { anchor: 'm', field: F });
    }
    if (axes?.[1]) {
      const f = k.fit([{ text: `↑ ${axes[1]}`, color: c.r.muted, bold: true, caps: true, trackingEm: 0.08 }], c.theme, 200, 16, 12, 10, 1);
      k.text(c, 'Y label', { x: gx + 4, y: a.y - 20, w: 200, h: 16 }, f, { anchor: 'm', field: F });
    }
  }
}

function vennKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = Math.min(3, items.length);
  const D = n === 3 ? Math.min(a.h * 0.64, 230) : Math.min(a.h * 0.86, 290);
  const pos: [number, number][] = n === 3
    ? [[a.cx - D * 0.3, a.cy - D * 0.2], [a.cx + D * 0.3, a.cy - D * 0.2], [a.cx, a.cy + D * 0.32]]
    : [[a.cx - D * 0.32, a.cy], [a.cx + D * 0.32, a.cy]];
  const groups = items.slice(0, n).map(it => ({ specs: specs(c, it, { color: c.r.title, align: 'c' }), w: D * 0.46, h: D * 0.34 }));
  const fitted = fitItems(c, k, items.slice(0, n), groups, 17);
  items.slice(0, n).forEach((it, i) => {
    const g = `g${i + 1}`;
    const [x, y] = pos[i]!;
    k.shape(c, `Set ${i + 1}`, { x: x - D / 2, y: y - D / 2, w: D, h: D }, { geom: 'ellipse', fill: tint(k.accent(i), c.theme.dark ? 0.42 : 0.3), line: { color: k.accent(i), w: 2 }, field: F, group: g });
    // Each label sits in its circle's own part, away from the overlap.
    const ox = n === 3 ? (i === 0 ? -D * 0.2 : i === 1 ? D * 0.2 : 0) : (i === 0 ? -D * 0.2 : D * 0.2);
    const oy = n === 3 ? (i === 2 ? D * 0.2 : -D * 0.14) : 0;
    k.text(c, `Set label ${i + 1}`, { x: x + ox - D * 0.23, y: y + oy - D * 0.17, w: D * 0.46, h: D * 0.34 }, fitted[i]!, { anchor: 'm', field: F, group: g });
  });
  const centre = c.slide.infographic?.centre;
  if (centre) {
    const cyy = n === 3 ? a.cy - D * 0.02 : a.cy;
    const f = k.fit([{ text: centre, font: 'h', bold: true, color: c.r.title, align: 'c' }], c.theme, D * 0.3, D * 0.22, 15, 11, 2);
    k.text(c, 'Overlap label', { x: a.cx - D * 0.15, y: cyy - D * 0.11, w: D * 0.3, h: D * 0.22 }, f, { anchor: 'm', field: F });
  }
}

function ringsKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const slot = a.w / n;
  const d = Math.min(slot - 36, a.h - 120, 196);
  const thick = Math.max(8, d * 0.13);
  const groups = items.map(it => ({ specs: specs(c, it, { align: 'c', color: c.r.title }), w: slot - 24, h: a.h - d - 22 }));
  const fitted = fitItems(c, k, items, groups, 16);
  const y = a.y + Math.max(0, (a.h - d - 22 - Math.max(...fitted.map(f => f.height))) / 2);
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const cx = a.x + slot * i + slot / 2;
    const box = { x: cx - d / 2, y, w: d, h: d };
    const pct = percentOf(it.value);
    if (pct === undefined) k.problem(c, 'error', `ring ${i + 1} ("${plainOf(it.title).slice(0, 24)}") needs a percentage value ("72%")`, F);
    k.shape(c, `Track ${i + 1}`, box, { geom: 'donut', adj: [thick], fill: tint(acc, 0.16), field: F, group: g });
    const p = pct ?? 0;
    if (p >= 99.95) k.shape(c, `Progress ${i + 1}`, box, { geom: 'donut', adj: [thick], fill: acc, field: F, group: g });
    else if (p > 0) k.shape(c, `Progress ${i + 1}`, box, { geom: 'blockArc', adj: [-90, -90 + (p / 100) * 360, thick], fill: acc, field: F, group: g });
    const vf = k.fit([{ text: it.value ?? '—', font: 'h', bold: true, color: c.r.title, align: 'c', lhf: 1 }], c.theme, d - 2 * thick - 10, d * 0.4, Math.round(d * 0.24), 12, 1);
    k.text(c, `Ring value ${i + 1}`, { x: cx - (d - 2 * thick - 10) / 2, y: y + d * 0.3, w: d - 2 * thick - 10, h: d * 0.4 }, vf, { anchor: 'm', field: F, group: g });
    k.text(c, `Ring label ${i + 1}`, { x: cx - (slot - 24) / 2, y: y + d + 18, w: slot - 24, h: a.y + a.h - (y + d + 18) }, fitted[i]!, { field: F, group: g });
  });
}

function tilesKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const gap = 20;
  const tw = (a.w - gap * (n - 1)) / n;
  const th = Math.min(a.h, 260);
  const y = a.y + (a.h - th) / 2;
  const values = k.fitShared(items.map(it => ({ specs: [{ text: it.value ?? '—', font: 'h' as const, bold: true, color: { s: 'lt1' } as ColorRef, lhf: 1.05 }], w: tw - 44, h: th * 0.34 })), c.theme, n <= 2 ? 64 : n === 3 ? 56 : 48, 26);
  const labels = fitItems(c, k, items, items.map(it => ({ specs: specs(c, it, { align: 'l', color: { s: 'lt1' }, textColor: { s: 'lt1' } }), w: tw - 44, h: th * 0.36 })), 16);
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const ink = k.ink(c, acc);
    const x = a.x + i * (tw + gap);
    k.shape(c, `Tile ${i + 1}`, { x, y, w: tw, h: th }, { geom: c.theme.radius ? 'roundRect' : 'rect', radius: c.theme.radius + 4, fill: acc, field: F, group: g });
    if (!it.value) k.problem(c, 'error', `tile ${i + 1} has no value — a tile is a big number ("£4.2m", "38%")`, F);
    icon(c, k, it.icon, { x: x + 22, y: y + 22, w: 30, h: 30 }, ink, g);
    const recolour = (f: FitResult): FitResult => ({ ...f, paras: f.paras.map(p => ({ ...p, color: ink })) });
    k.text(c, `Tile value ${i + 1}`, { x: x + 22, y: y + 58, w: tw - 44, h: th * 0.34 }, recolour(values.results[i]!), { anchor: 'm', field: F, group: g });
    if (values.results[i]!.overflow) k.problem(c, 'error', `tile ${i + 1}'s value "${it.value}" is too long for a big number`, F);
    k.text(c, `Tile label ${i + 1}`, { x: x + 22, y: y + 66 + th * 0.34, w: tw - 44, h: th * 0.36 }, recolour(labels[i]!), { field: F, group: g });
  });
}

function statBarsKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const rowH = Math.min(70, a.h / n);
  const y0 = a.y + (a.h - rowH * n) / 2;
  const lw = a.w * 0.3;
  const vw = 90;
  const bx = a.x + lw + 20;
  const bw = a.w - lw - 20 - vw - 16;
  const barH = Math.min(22, rowH * 0.34);
  const labels = fitItems(c, k, items, items.map(it => ({ specs: specs(c, it, { align: 'r', color: c.r.title }), w: lw, h: rowH - 6 })), 17);
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const y = y0 + i * rowH;
    const pct = percentOf(it.value);
    if (pct === undefined) k.problem(c, 'error', `bar ${i + 1} ("${plainOf(it.title).slice(0, 24)}") needs a percentage value ("64%")`, F);
    k.text(c, `Bar label ${i + 1}`, { x: a.x, y: y + 3, w: lw, h: rowH - 6 }, labels[i]!, { anchor: 'm', field: F, group: g });
    k.shape(c, `Bar track ${i + 1}`, { x: bx, y: y + (rowH - barH) / 2, w: bw, h: barH }, { geom: 'roundRect', radius: barH / 2, fill: tint(acc, 0.15), field: F, group: g });
    if ((pct ?? 0) > 0) k.shape(c, `Bar ${i + 1}`, { x: bx, y: y + (rowH - barH) / 2, w: Math.max(barH, (bw * (pct ?? 0)) / 100), h: barH }, { geom: 'roundRect', radius: barH / 2, fill: acc, field: F, group: g });
    const vf = k.fit([{ text: it.value ?? '—', font: 'h', bold: true, color: k.readable(c, acc) }], c.theme, vw, rowH - 6, 24, 14, 1);
    k.text(c, `Bar value ${i + 1}`, { x: bx + bw + 16, y: y + 3, w: vw, h: rowH - 6 }, vf, { anchor: 'm', field: F, group: g });
  });
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';
}

function teamKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const slot = a.w / n;
  const d = Math.min(slot - 40, a.h - 110, 170);
  const groups = items.map(it => ({ specs: specs(c, it, { align: 'c', color: c.r.title }), w: slot - 16, h: a.h - d - 30 }));
  const fitted = fitItems(c, k, items, groups, 17);
  const y = a.y + Math.max(0, (a.h - d - 30 - Math.max(...fitted.map(f => f.height))) / 2);
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const cx = a.x + slot * i + slot / 2;
    const box = { x: cx - d / 2, y, w: d, h: d };
    k.shape(c, `Photo ring ${i + 1}`, { x: box.x - 7, y: box.y - 7, w: d + 14, h: d + 14 }, { geom: 'donut', adj: [3], fill: acc, field: F, group: g });
    if (it.image?.src) k.imageFrame(c, box, { img: it.image, mask: 'circle', field: F, name: `Photo ${i + 1}`, group: g, credit: true });
    else {
      k.shape(c, `Initials disc ${i + 1}`, box, { geom: 'ellipse', fill: tint(acc, 0.2), field: F, group: g });
      const f = k.fit([{ text: initials(it.title), font: 'h', bold: true, color: acc, align: 'c', lhf: 1 }], c.theme, d, d, Math.round(d * 0.34), 14, 1);
      k.text(c, `Initials ${i + 1}`, box, f, { anchor: 'm', field: F, group: g });
    }
    k.text(c, `Person ${i + 1}`, { x: cx - (slot - 16) / 2, y: y + d + 24, w: slot - 16, h: a.y + a.h - (y + d + 24) }, fitted[i]!, { field: F, group: g });
  });
}

function quotePhotoKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const it = items[0]!;
  const d = Math.min(a.h - 20, 280);
  const box = { x: a.x + 16, y: a.cy - d / 2, w: d, h: d };
  k.photoAccent(c, box, 'circle');
  if (it.image?.src) k.imageFrame(c, box, { img: it.image, mask: 'circle', field: F, name: 'Portrait', group: 'g1' });
  else {
    k.shape(c, 'Portrait', box, { geom: 'ellipse', fill: tint(c.r.accent, 0.2), field: F, group: 'g1' });
    const f = k.fit([{ text: initials(it.title), font: 'h', bold: true, color: c.r.accent, align: 'c', lhf: 1 }], c.theme, d, d, Math.round(d * 0.3), 14, 1);
    k.text(c, 'Initials', box, f, { anchor: 'm', field: F, group: 'g1' });
  }
  const x = box.x + d + 64;
  const w = a.x + a.w - x;
  const mark = k.fit([{ text: '“', font: 'h', color: c.r.accent, lhf: 1 }], c.theme, 90, 100, 110, 110, 1);
  k.text(c, 'Quote mark', { x: x - 10, y: a.y - 6, w: 90, h: 100 }, mark, { field: F });
  const qf = k.fit([{ text: it.text ?? '', font: 'h', italic: true, color: c.r.title, lhf: 1.25 }], c.theme, w, a.h - 150, 28, 16);
  k.text(c, 'Quote', { x, y: a.y + 70, w, h: a.h - 150 }, qf, { anchor: 'm', field: F, group: 'g1' });
  if (qf.overflow) k.problem(c, 'error', 'the quote does not fit at 16 pt — shorten it to a sentence or two', F);
  if (!it.text) k.problem(c, 'error', 'quote-photo needs the quote in item text', F);
  k.shape(c, 'Rule', { x, y: a.y + a.h - 70, w: 44, h: 4 }, { geom: 'rect', fill: c.r.accent, field: F });
  const nf = k.fit([{ text: it.title, bold: true, color: c.r.title }, ...(it.value ? [{ text: it.value, color: c.r.muted, rel: 0.85 }] : [])], c.theme, w, 56, 18, 12);
  k.text(c, 'Attribution', { x, y: a.y + a.h - 58, w, h: 56 }, nf, { field: F, group: 'g1' });
}

function agendaKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const cols = n > 4 ? 2 : 1;
  const per = Math.ceil(n / cols);
  const gap = 36;
  const cw = cols === 2 ? (a.w - gap) / 2 : a.w * 0.82;
  const rowH = Math.min(86, a.h / per);
  const tile = Math.min(56, rowH - 16);
  const groups = items.map(it => ({ specs: specs(c, it, { align: 'l', color: c.r.title }), w: cw - tile - 24, h: rowH - 8 }));
  const fitted = fitItems(c, k, items, groups, 20);
  const y0 = a.y + (a.h - per * rowH) / 2;
  items.forEach((it, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const col = Math.floor(i / per);
    const row = i % per;
    const x = a.x + col * (cw + gap) + (cols === 1 ? (a.w - cw) / 2 : 0);
    const y = y0 + row * rowH;
    k.shape(c, `Number tile ${i + 1}`, { x, y: y + (rowH - tile) / 2, w: tile, h: tile }, { geom: c.theme.radius >= 10 ? 'ellipse' : 'roundRect', radius: 8, fill: acc, field: F, group: g });
    const ink = k.ink(c, acc);
    if (!icon(c, k, it.icon, { x: x + tile * 0.25, y: y + (rowH - tile) / 2 + tile * 0.25, w: tile * 0.5, h: tile * 0.5 }, ink, g)) {
      const nf = k.fit([{ text: String(i + 1).padStart(2, '0'), font: 'h', bold: true, color: ink, align: 'c', lhf: 1 }], c.theme, tile, tile, Math.round(tile * 0.4), 11, 1);
      k.text(c, `Number ${i + 1}`, { x, y: y + (rowH - tile) / 2, w: tile, h: tile }, nf, { anchor: 'm', field: F, group: g });
    }
    k.text(c, `Agenda item ${i + 1}`, { x: x + tile + 20, y: y + 4, w: cw - tile - 24, h: rowH - 8 }, fitted[i]!, { anchor: 'm', field: F, group: g });
    if (row < per - 1 && i < n - 1) k.shape(c, `Divider ${i + 1}`, { x: x + tile + 20, y: y + rowH - 0.75, w: cw - tile - 24, h: 1 }, { geom: 'rect', fill: c.r.line, field: F, group: g });
  });
}

/**
 * Decision cards (ADR 0025): the "what we ask you to decide" slide — one
 * full-width card per decision, a big 01–05 on an accent block, the decision in
 * bold with one line of why, and an empty check ring for the room to tick.
 */
function decisionsKind(c: Ctx, k: Kit, a: Area, items: InfoItem[]): void {
  const n = items.length;
  const gap = n >= 5 ? 10 : 14;
  const rowH = Math.min(n <= 3 ? 104 : 88, (a.h - gap * (n - 1)) / n);
  const y0 = a.y + (a.h - (rowH * n + gap * (n - 1))) / 2;
  const numW = Math.round(Math.min(110, rowH * 1.15));
  const mark = Math.min(30, rowH * 0.4);
  const tx = numW + 24;
  const tw = a.w - tx - mark - 44;
  const groups = items.map(it => ({ specs: specs(c, it, { align: 'l', color: c.r.title, textColor: c.r.muted }), w: tw, h: rowH - 14 }));
  const fitted = fitItems(c, k, items, groups, n >= 5 ? 18 : n === 4 ? 20 : 22, TEXT_MIN, 2);
  const radius = Math.min(c.theme.radius, 12);
  items.forEach((_, i) => {
    const g = `g${i + 1}`;
    const acc = k.accent(i);
    const y = y0 + i * (rowH + gap);
    k.shape(c, `Decision card ${i + 1}`, { x: a.x, y, w: a.w, h: rowH }, { geom: radius ? 'roundRect' : 'rect', radius, fill: c.r.surface, field: F, group: g });
    k.shape(c, `Decision block ${i + 1}`, { x: a.x, y, w: numW, h: rowH }, { geom: radius ? 'roundRect' : 'rect', radius, fill: acc, field: F, group: g });
    const nf = k.fit([{ text: String(i + 1).padStart(2, '0'), font: 'h', bold: true, color: k.ink(c, acc), align: 'c', lhf: 1 }], c.theme, numW, rowH, Math.round(Math.min(rowH * 0.5, 46)), 16, 1);
    k.text(c, `Decision number ${i + 1}`, { x: a.x, y, w: numW, h: rowH }, nf, { anchor: 'm', field: F, group: g });
    k.text(c, `Decision ${i + 1}`, { x: a.x + tx, y: y + 7, w: tw, h: rowH - 14 }, fitted[i]!, { anchor: 'm', field: F, group: g });
    k.shape(c, `Decision check ${i + 1}`, { x: a.x + a.w - mark - 22, y: y + (rowH - mark) / 2, w: mark, h: mark }, { geom: 'donut', adj: [2.5], fill: k.readable(c, acc), field: F, group: g });
  });
}

/** Lay out an infographic slide's content (its title is already placed). */
export function layoutInfographic(c: Ctx, k: Kit): void {
  const ig = c.slide.infographic;
  if (!ig) { k.problem(c, 'error', 'infographic slide has no infographic {kind, items:[{title, text?, value?, icon?}]}', F); return; }
  const info = infographicInfo(ig.kind);
  const all = ig.items;
  if (all.length < info.min) k.problem(c, 'error', `a ${info.label.toLowerCase()} needs at least ${info.min} item${info.min === 1 ? '' : 's'} (has ${all.length})`, F);
  if (all.length > info.max) k.problem(c, 'error', `a ${info.label.toLowerCase()} shows at most ${info.max} items (has ${all.length}) — merge items, split the slide, or use another kind`, F);
  const items = all.slice(0, info.max);
  if (!items.length) return;
  for (const [i, it] of items.entries()) {
    const words = plainOf(`${it.title} ${it.text ?? ''}`).split(/\s+/).filter(Boolean).length;
    if (words > 30) k.problem(c, 'warn', `item ${i + 1} has ${words} words — an infographic item is a few words and one line; move detail to the notes`, F);
  }
  const a = areaOf(c, k);
  switch (ig.kind) {
    case 'process': processKind(c, k, a, items); break;
    case 'arrows': arrowsKind(c, k, a, items); break;
    case 'cycle': cycleKind(c, k, a, items); break;
    case 'semicircle': semicircleKind(c, k, a, items); break;
    case 'radial': radialKind(c, k, a, items); break;
    case 'pyramid': layersKind(c, k, a, items, false); break;
    case 'funnel': layersKind(c, k, a, items, true); break;
    case 'hexagons': hexKind(c, k, a, items); break;
    case 'stairs': stairsKind(c, k, a, items); break;
    case 'timeline': alternating(c, k, a, items, false); break;
    case 'roadmap': alternating(c, k, a, items, true); break;
    case 'cards': cardsKind(c, k, a, items, false); break;
    case 'icon-grid': cardsKind(c, k, a, items, true); break;
    case 'versus': twoPanels(c, k, a, items, 'versus'); break;
    case 'pros-cons': twoPanels(c, k, a, items, 'pros-cons'); break;
    case 'before-after': twoPanels(c, k, a, items, 'before-after'); break;
    case 'swot': swotKind(c, k, a, items, false); break;
    case 'matrix': swotKind(c, k, a, items, true); break;
    case 'venn': vennKind(c, k, a, items); break;
    case 'rings': ringsKind(c, k, a, items); break;
    case 'tiles': tilesKind(c, k, a, items); break;
    case 'stat-bars': statBarsKind(c, k, a, items); break;
    case 'team': teamKind(c, k, a, items); break;
    case 'quote-photo': quotePhotoKind(c, k, a, items); break;
    case 'agenda': agendaKind(c, k, a, items); break;
    case 'decisions': decisionsKind(c, k, a, items); break;
  }
}
