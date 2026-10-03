/**
 * The deck layout engine — turns a slide's content into positioned frames
 * (text boxes with explicit font sizes, shapes, pictures, tables, charts,
 * diagrams) on a 960×540 pt (16:9) or 720×540 pt (4:3) slide, and reports
 * what does not fit.
 *
 * ## One engine, two renderers
 *
 * The HTML renderer (`deck-render.ts`: the editor, present mode, PDF and PNG)
 * and the PowerPoint writer (`src/canvas/deck-pptx.ts`) both draw *these
 * frames* and nothing else, so the three agree by construction. Text carries
 * an explicit size and an exact line pitch (PowerPoint `spcPts`, CSS
 * `line-height` in the same points), boxes have no insets, and wrapping is
 * computed here from measured glyph advances (`deck-fonts.ts`) with a small
 * safety margin — so a line that fits here fits in both.
 *
 * ## Fitting text
 *
 * Every text box has a design size and a floor. The engine wraps the text at
 * the design size and steps down a point at a time until it fits the box;
 * boxes that belong together (two columns, KPI cards, timeline labels) share
 * one size so a slide never mixes 22 pt and 17 pt bullets. Text that does not
 * fit at the floor is drawn at the floor and reported as an overflow, with a
 * rough number of words to cut. The problems — overflow, too many bullets,
 * a missing title, an empty chart, a table too big to read — are what the
 * Canvas tool returns to the model after every write (ADR 0023: enforced in
 * the loop, not asked for in the prompt).
 *
 * ## The grid
 *
 * Safe margins of 56 pt (44 pt on 4:3); a title zone whose text sits on the
 * zone's bottom edge, so content always starts at the same height whether
 * the title takes one line or two; a footer band for the footer text and the
 * slide number. The themes vary treatments (title, section, motif), not the
 * grid — that is what makes slides of one deck look like one deck.
 *
 * @module shared/ui/canvas/deck-layout
 */

import { isPending, layoutInfo, parseRuns, plainOf, type Bullet, type Deck, type DeckChart, type Slide, type TextRun } from './deck-model';
import { deckTheme, roles, type ColorRef, type DeckTheme } from './deck-themes';
import { deckTypeById } from './deck-types';
import { textWidth } from './deck-fonts';

export type Color = ColorRef | string;

export interface Run extends TextRun { color?: Color; br?: boolean }

export interface Para {
  runs: Run[];
  /** Points. */
  size: number;
  /** Exact line pitch, points. */
  lh: number;
  font: 'h' | 'b';
  bold: boolean;
  italic?: boolean;
  color: Color;
  align: 'l' | 'c' | 'r';
  /** Bullet text ("•", "–", "1."), hung left of `indent`. */
  bullet?: string;
  bulletColor?: Color;
  /** Left margin of the text, points. */
  indent: number;
  /** Space before, points (ignored on the first paragraph). */
  before: number;
  caps?: boolean;
  /** Letter spacing, points. */
  tracking?: number;
}

interface Box { x: number; y: number; w: number; h: number }

export interface TextFrame extends Box {
  kind: 'text';
  name: string;
  paras: Para[];
  anchor: 't' | 'm' | 'b';
  /** The slide field this text edits (the editor focuses it on click). */
  field?: string;
  /** PowerPoint placeholder this box is (slide titles are, for outline and accessibility). */
  ph?: 'title' | 'ctrTitle' | 'subTitle' | 'body';
  overflow?: boolean;
}

export interface ShapeFrame extends Box {
  kind: 'shape';
  name: string;
  geom: 'rect' | 'roundRect' | 'topRound' | 'ellipse' | 'corner';
  fill?: Color;
  /** A vertical gradient from transparent to this colour at `a` (photo scrims). */
  gradient?: ColorRef;
  line?: { color: Color; w: number; dash?: boolean };
  radius?: number;
  field?: string;
}

export interface ImageFrame extends Box {
  kind: 'image';
  name: string;
  src: string;
  alt: string;
  fit: 'cover' | 'contain';
  field: string;
}

export interface TableCell { paras: Para[]; fill?: Color }

export interface TableFrame extends Box {
  kind: 'table';
  name: string;
  cols: number[];
  rows: number[];
  cells: TableCell[][];
  /** Cell padding, points. */
  pad: { x: number; y: number };
  line: Color;
  field: string;
  overflow?: boolean;
}

export interface ChartFrame extends Box { kind: 'chart'; name: string; chart: DeckChart; field: string }
export interface DiagramFrame extends Box { kind: 'diagram'; name: string; source: string; field: string }

export type Frame = TextFrame | ShapeFrame | ImageFrame | TableFrame | ChartFrame | DiagramFrame;

export interface Problem {
  slide: string;
  /** 1-based position, for messages. */
  n: number;
  severity: 'error' | 'warn';
  field?: string;
  message: string;
}

export interface SlideLayout {
  slide: Slide;
  n: number;
  w: number;
  h: number;
  background: Color;
  frames: Frame[];
  problems: Problem[];
  /** The slide is still a plan (an intent, no content). */
  pending: boolean;
}

export const SLIDE_SIZE = { '16:9': { w: 960, h: 540 }, '4:3': { w: 720, h: 540 } } as const;

/** Wrap a little before the measured width: kerning and rasterising differ slightly between the browser and PowerPoint. */
const SAFETY = 0.955;
const LH_BODY = 1.22;
const LH_HEAD = 1.1;

// ── Measuring ────────────────────────────────────────────────────────

function fontName(theme: DeckTheme, f: 'h' | 'b'): string {
  return f === 'h' ? theme.fonts.heading : theme.fonts.body;
}

/** Lines a paragraph takes in `width` points. */
export function lineCount(p: Para, theme: DeckTheme, width: number): number {
  const avail = Math.max(10, (width - p.indent) * SAFETY);
  const font = fontName(theme, p.font);
  let lines = 1;
  let x = 0;
  const track = p.tracking ?? 0;
  for (const run of p.runs) {
    if (run.br) { lines++; x = 0; continue; }
    const text = p.caps ? run.text.toUpperCase() : run.text;
    const bold = p.bold || Boolean(run.b);
    const face = run.c ? 'Consolas' : font;
    const parts = text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      const w = textWidth(part, face, p.size, bold) + track * part.length;
      if (/^\s+$/.test(part)) { x += w; continue; }
      if (x > 0 && x + w > avail) { lines++; x = 0; }
      if (w > avail) {
        // A word longer than the line breaks inside itself.
        lines += Math.floor(w / avail);
        x = w % avail;
      } else x += w;
    }
  }
  return lines;
}

function paraHeight(paras: Para[], theme: DeckTheme, width: number): { height: number; lines: number[] } {
  let height = 0;
  const lines = paras.map((p, i) => {
    const n = lineCount(p, theme, width);
    height += (i === 0 ? 0 : p.before) + n * p.lh;
    return n;
  });
  return { height, lines };
}

interface ParaSpec {
  text: string;
  /** Size relative to the box's size. */
  rel?: number;
  font?: 'h' | 'b';
  bold?: boolean;
  italic?: boolean;
  color: Color;
  align?: 'l' | 'c' | 'r';
  bullet?: string;
  bulletColor?: Color;
  /** Indent in ems of the paragraph's size. */
  indentEm?: number;
  /** Space before in ems of the box size. */
  beforeEm?: number;
  lhf?: number;
  caps?: boolean;
  trackingEm?: number;
}

function runsOf(text: string, color?: Color): Run[] {
  const out: Run[] = [];
  for (const r of parseRuns(text)) {
    const pieces = r.text.split('\n');
    pieces.forEach((piece, i) => {
      if (i > 0) out.push({ text: '', br: true });
      if (piece) out.push({ ...r, text: piece, ...(color ? { color } : {}) });
    });
  }
  return out.length ? out : [{ text: '' }];
}

function build(specs: ParaSpec[], size: number): Para[] {
  return specs.map((s) => {
    const sz = Math.max(6, Math.round(size * (s.rel ?? 1) * 2) / 2);
    const lh = Math.round(sz * (s.lhf ?? (s.font === 'h' ? LH_HEAD : LH_BODY)) * 2) / 2;
    return {
      runs: runsOf(s.text), size: sz, lh, font: s.font ?? 'b', bold: Boolean(s.bold), ...(s.italic ? { italic: true } : {}),
      color: s.color, align: s.align ?? 'l',
      ...(s.bullet ? { bullet: s.bullet, ...(s.bulletColor ? { bulletColor: s.bulletColor } : {}) } : {}),
      indent: Math.round((s.indentEm ?? 0) * sz),
      before: Math.round((s.beforeEm ?? 0) * size),
      ...(s.caps ? { caps: true } : {}), ...(s.trackingEm ? { tracking: Math.round(s.trackingEm * sz * 10) / 10 } : {}),
    };
  });
}

interface FitResult { paras: Para[]; size: number; height: number; overflow: boolean; lines: number }

/** The largest size from `size` down to `min` at which the paragraphs fit `box`. */
function fit(specs: ParaSpec[], theme: DeckTheme, w: number, h: number, size: number, min: number, maxLines?: number): FitResult {
  let s = size;
  for (;;) {
    const paras = build(specs, s);
    const m = paraHeight(paras, theme, w);
    const total = m.lines.reduce((a, b) => a + b, 0);
    const ok = m.height <= h + 0.5 && (maxLines === undefined || total <= maxLines);
    if (ok || s <= min) return { paras, size: s, height: m.height, overflow: !ok, lines: total };
    s = Math.max(min, s - (s > 30 ? 2 : 1));
  }
}

/** Several boxes at one size: the size is the smallest any of them needs. */
function fitShared(groups: { specs: ParaSpec[]; w: number; h: number }[], theme: DeckTheme, size: number, min: number): { results: FitResult[]; size: number } {
  let s = size;
  for (const g of groups) if (g.specs.length) s = Math.min(s, fit(g.specs, theme, g.w, g.h, size, min).size);
  const results = groups.map(g => {
    const paras = build(g.specs, s);
    const m = paraHeight(paras, theme, g.w);
    return { paras, size: s, height: m.height, overflow: g.specs.length > 0 && m.height > g.h + 0.5, lines: m.lines.reduce((a, b) => a + b, 0) };
  });
  return { results, size: s };
}

/**
 * Light content gets more room: when the text fits at its design size using
 * little of the box, it is set larger (up to `max`) with more space between
 * bullets, as long as it stays within ~60% of the box. Three short bullets at
 * 24 pt under a title leave a slide two-thirds empty; at 28 pt with air
 * between them they read as a designed slide.
 */
function airier(specs: ParaSpec[], spread: number): ParaSpec[] {
  return specs.map(p => (p.beforeEm ? { ...p, beforeEm: p.beforeEm * spread } : p));
}

function fitAiry(specs: ParaSpec[], theme: DeckTheme, w: number, h: number, size: number, min: number, max: number): FitResult {
  const base = fit(specs, theme, w, h, size, min);
  if (base.overflow || base.size < size) return base;
  let best = base;
  for (let s = size + 2; s <= max; s += 2) {
    const paras = build(airier(specs, 1.45), s);
    const m = paraHeight(paras, theme, w);
    if (m.height > h * 0.62) break;
    best = { paras, size: s, height: m.height, overflow: false, lines: m.lines.reduce((a, b) => a + b, 0) };
  }
  return best;
}

function growShared(groups: { specs: ParaSpec[]; w: number; h: number }[], theme: DeckTheme, size: number, min: number, max: number): { results: FitResult[]; size: number } {
  const base = fitShared(groups, theme, size, min);
  if (base.size < size || base.results.some(r => r.overflow)) return base;
  let best = base;
  for (let s = size + 2; s <= max; s += 2) {
    const results = groups.map((g) => {
      const paras = build(airier(g.specs, 1.4), s);
      const m = paraHeight(paras, theme, g.w);
      return { paras, size: s, height: m.height, overflow: false, lines: m.lines.reduce((a, b) => a + b, 0), h: g.h };
    });
    if (results.some(r => r.height > r.h * 0.62)) break;
    best = { results, size: s };
  }
  return best;
}

// ── The engine ───────────────────────────────────────────────────────

interface Ctx {
  deck: Deck;
  slide: Slide;
  theme: DeckTheme;
  r: ReturnType<typeof roles>;
  W: number;
  H: number;
  MX: number;
  CW: number;
  frames: Frame[];
  problems: Problem[];
  n: number;
  maxBullets: number;
  /** Section number (1-based) when the slide is a section. */
  section: number;
  draft: boolean;
}

const TOP = 34;
const TITLE_H = 80;
const Y0 = TOP + TITLE_H + 20;

function problem(c: Ctx, severity: Problem['severity'], message: string, field?: string): void {
  c.problems.push({ slide: c.slide.id, n: c.n, severity, message, ...(field ? { field } : {}) });
}

function text(c: Ctx, name: string, box: Box, fitted: FitResult, opts: { anchor?: TextFrame['anchor']; field?: string; ph?: TextFrame['ph'] } = {}): TextFrame {
  const f: TextFrame = {
    kind: 'text', name, ...box, paras: fitted.paras, anchor: opts.anchor ?? 't',
    ...(opts.field ? { field: opts.field } : {}), ...(opts.ph ? { ph: opts.ph } : {}), ...(fitted.overflow ? { overflow: true } : {}),
  };
  c.frames.push(f);
  return f;
}

function shape(c: Ctx, name: string, box: Box, s: Omit<ShapeFrame, 'kind' | 'name' | 'x' | 'y' | 'w' | 'h'>): void {
  c.frames.push({ kind: 'shape', name, ...box, ...s });
}

function wordsToCut(f: FitResult, h: number): number {
  if (!f.overflow || f.height <= 0) return 0;
  const words = f.paras.reduce((n, p) => n + p.runs.reduce((m, r) => m + (r.text.match(/\S+/g)?.length ?? 0), 0), 0);
  return Math.max(1, Math.ceil(words * (1 - h / f.height)));
}

function overflowNote(c: Ctx, what: string, f: FitResult, h: number, field: string): void {
  if (!f.overflow) return;
  problem(c, 'error', `${what} does not fit even at ${f.size} pt — cut about ${wordsToCut(f, h)} words or split the slide`, field);
}

/** The content slide title, on the bottom of the title zone, plus the theme's motif. */
function contentTitle(c: Ctx, x = c.MX, w = c.CW): void {
  const t = c.theme;
  const title = c.slide.title?.trim();
  const motifIndent = t.motif === 'dot' ? 24 : 0;
  if (title) {
    const size = c.W === 960 ? 30 : 28;
    const f = fit([{ text: title, font: 'h', bold: t.headingBold, color: c.r.title }], t, w - motifIndent, TITLE_H, size, 22, 2);
    text(c, 'Title', { x: x + motifIndent, y: TOP, w: w - motifIndent, h: TITLE_H }, f, { anchor: 'b', field: 'title', ph: 'title' });
    if (f.overflow) problem(c, 'error', `the title is too long for two lines at 22 pt (${plainOf(title).length} characters) — shorten it`, 'title');
  }
  const bottom = TOP + TITLE_H;
  switch (t.motif) {
    case 'bar': shape(c, 'Accent bar', { x: x - 22, y: bottom - 34, w: 6, h: 32 }, { geom: 'rect', fill: c.r.accent }); break;
    case 'underline': shape(c, 'Accent rule', { x, y: bottom + 8, w: 56, h: 4 }, { geom: 'rect', fill: c.r.accent }); break;
    case 'rule': shape(c, 'Rule', { x, y: bottom + 9, w, h: 1.25 }, { geom: 'rect', fill: c.r.accent }); break;
    case 'band': shape(c, 'Top band', { x: 0, y: 0, w: c.W, h: 8 }, { geom: 'rect', fill: c.r.accent }); break;
    case 'side': shape(c, 'Side band', { x: 0, y: 0, w: 12, h: c.H }, { geom: 'rect', fill: c.r.titleBg }); shape(c, 'Side accent', { x: 0, y: TOP + 20, w: 12, h: 60 }, { geom: 'rect', fill: c.r.accent }); break;
    case 'corner': shape(c, 'Corner', { x: c.W - 84, y: 0, w: 84, h: 84 }, { geom: 'corner', fill: c.r.accent }); break;
    case 'dot': shape(c, 'Accent dot', { x, y: bottom - 25, w: 14, h: 14 }, { geom: 'ellipse', fill: c.r.accent }); break;
  }
}

/** Footer text and slide number on content slides. */
function footer(c: Ctx, onDark = false): void {
  const color = onDark ? c.r.titleMuted : c.r.muted;
  const y = c.H - 34;
  if (c.deck.footer) {
    const f = fit([{ text: c.deck.footer, color }], c.theme, c.CW * 0.7, 16, 10, 8, 1);
    text(c, 'Footer', { x: c.MX, y, w: c.CW * 0.7, h: 16 }, f, { anchor: 'm' });
  }
  if (c.deck.slideNumbers !== false) {
    const f = fit([{ text: String(c.n), color, align: 'r' }], c.theme, 60, 16, 10, 8, 1);
    text(c, 'Slide number', { x: c.W - c.MX - 60, y, w: 60, h: 16 }, f, { anchor: 'm' });
  }
}

/** The bottom of the content area, leaving room for a source line. */
function contentBottom(c: Ctx): number {
  const s = c.slide.source?.trim();
  const bottom = c.H - 56;
  if (!s) return bottom;
  const f = fit([{ text: s, color: c.r.muted, italic: true }], c.theme, c.CW, 16, 10, 8, 1);
  text(c, 'Source', { x: c.MX, y: bottom - 14, w: c.CW, h: 16 }, f, { anchor: 'b', field: 'source' });
  return bottom - 24;
}

function bulletSpecs(c: Ctx, bullets: Bullet[] | undefined, opts: { color?: Color; level0?: string } = {}): ParaSpec[] {
  const color = opts.color ?? c.r.text;
  return (bullets ?? []).map((b, i) => (b.level === 1
    ? { text: b.text, rel: 0.86, color, bullet: '–', bulletColor: c.r.muted, indentEm: 2.4, beforeEm: 0.28 }
    : { text: b.text, color, bullet: opts.level0 ?? '•', bulletColor: c.r.accent, indentEm: 1.1, beforeEm: i === 0 ? 0 : 0.55 }));
}

function checkBullets(c: Ctx, bullets: Bullet[] | undefined, field: string, limit = c.maxBullets): void {
  const top = (bullets ?? []).filter(b => b.level !== 1).length;
  if (top > limit) problem(c, 'error', `${top} bullets — at most ${limit} on one slide here; keep the strongest or split into two slides`, field);
  for (const b of bullets ?? []) {
    const words = plainOf(b.text).split(/\s+/).filter(Boolean).length;
    if (words > 28) { problem(c, 'warn', `a bullet of ${words} words reads as a paragraph — cut it to one line (about 12 words)`, field); break; }
  }
}

function requireTitle(c: Ctx): void {
  if (!c.slide.title?.trim()) problem(c, 'error', `${layoutInfo(c.slide.layout).label} slide has no title — every content slide needs one (it is what the audience reads first, and PowerPoint's outline and screen readers use it)`, 'title');
}

// ── Layouts ──────────────────────────────────────────────────────────

function titleSlide(c: Ctx, closing = false): Color {
  const { theme: t, r, W, H, MX, slide: s } = c;
  const style = closing ? 'field' : t.title;
  const center = closing || style === 'frame';
  let bg: Color = r.bg;
  let titleColor: Color = r.title;
  let subColor: Color = r.muted;
  let box = { x: MX, y: 110, w: W * 0.78, h: 210 };
  let ruleAt = { x: MX, y: 338, w: 96, h: 6 };
  let sub = { x: MX, y: 358, w: W * 0.72, h: 76 };
  let body = { x: MX, y: H - 78, w: W * 0.7, h: 26 };
  let size = c.W === 960 ? 50 : 44;
  switch (style) {
    case 'field':
      bg = r.titleBg; titleColor = r.titleText; subColor = r.titleMuted;
      if (!closing) {
        // A large ring breaking the top edge, a solid accent disc breaking the right, one small dot: crisp on any dark field.
        shape(c, 'Ring', { x: W - 360, y: -230, w: 520, h: 520 }, { geom: 'ellipse', line: { color: { ...r.accent, a: 0.75 } as ColorRef, w: 2.5 } });
        shape(c, 'Disc', { x: W - 150, y: H - 250, w: 300, h: 300 }, { geom: 'ellipse', fill: r.accent });
        shape(c, 'Dot', { x: W - 214, y: H - 268, w: 30, h: 30 }, { geom: 'ellipse', fill: r.accent2 });
      }
      break;
    case 'split': {
      const pw = W * 0.5;
      shape(c, 'Title panel', { x: 0, y: 0, w: pw, h: H }, { geom: 'rect', fill: r.titleBg });
      shape(c, 'Disc', { x: pw + (W - pw) * 0.18, y: 64, w: (W - pw) * 0.66, h: (W - pw) * 0.66 }, { geom: 'ellipse', fill: r.accent });
      shape(c, 'Disc 2', { x: pw + (W - pw) * 0.52, y: 64 + (W - pw) * 0.42, w: (W - pw) * 0.4, h: (W - pw) * 0.4 }, { geom: 'ellipse', fill: { ...r.accent2, a: 0.9 } as ColorRef });
      shape(c, 'Ring', { x: pw + (W - pw) * 0.08, y: H - 120, w: 56, h: 56 }, { geom: 'ellipse', line: { color: r.title, w: 2 } });
      titleColor = r.titleText; subColor = r.titleMuted;
      box = { x: MX, y: 100, w: pw - MX - 36, h: 230 }; size = c.W === 960 ? 42 : 36;
      ruleAt = { x: MX, y: 346, w: 72, h: 6 };
      sub = { x: MX, y: 366, w: pw - MX - 36, h: 90 };
      body = { x: MX, y: H - 74, w: pw - MX - 36, h: 26 };
      break;
    }
    case 'band': {
      const by = Math.round(H * 0.6);
      shape(c, 'Band', { x: 0, y: by, w: W, h: H - by }, { geom: 'rect', fill: r.titleBg });
      shape(c, 'Band accent', { x: 0, y: by, w: W, h: 8 }, { geom: 'rect', fill: r.accent });
      box = { x: MX, y: 70, w: W - 2 * MX, h: by - 96 };
      ruleAt = { x: MX, y: by - 18, w: 0, h: 0 };
      sub = { x: MX, y: by + 34, w: W * 0.8, h: 70 }; subColor = r.titleText;
      body = { x: MX, y: H - 60, w: W * 0.7, h: 24 };
      break;
    }
    case 'minimal':
      shape(c, 'Mark', { x: MX, y: 60, w: 16, h: 16 }, { geom: 'rect', fill: r.accent });
      size = c.W === 960 ? 56 : 46;
      ruleAt = { x: MX, y: 340, w: 140, h: 6 };
      break;
    case 'frame':
      shape(c, 'Frame', { x: 26, y: 26, w: W - 52, h: H - 52 }, { geom: 'rect', line: { color: r.accent, w: 1.5 } });
      shape(c, 'Frame inner', { x: 34, y: 34, w: W - 68, h: H - 68 }, { geom: 'rect', line: { color: r.line, w: 0.75 } });
      box = { x: MX + 40, y: 100, w: W - 2 * MX - 80, h: 210 }; size = c.W === 960 ? 46 : 40;
      ruleAt = { x: W / 2 - 40, y: 330, w: 80, h: 3 };
      sub = { x: MX + 40, y: 350, w: W - 2 * MX - 80, h: 70 };
      body = { x: MX + 40, y: H - 96, w: W - 2 * MX - 80, h: 26 };
      break;
  }
  if (closing) {
    box = { x: MX, y: 120, w: W - 2 * MX, h: 190 };
    ruleAt = { x: W / 2 - 40, y: 328, w: 80, h: 5 };
    sub = { x: MX, y: 350, w: W - 2 * MX, h: 70 };
    body = { x: MX, y: H - 92, w: W - 2 * MX, h: 30 };
    size = c.W === 960 ? 48 : 42;
  }
  const align = center ? 'c' : 'l';
  if (s.title?.trim()) {
    const f = fit([{ text: s.title, font: 'h', bold: t.headingBold, color: titleColor, align }], t, box.w, box.h, size, 28, 4);
    text(c, 'Title', box, f, { anchor: 'b', field: 'title', ph: 'ctrTitle' });
    overflowNote(c, 'The title', f, box.h, 'title');
  } else problem(c, 'error', `${closing ? 'closing' : 'title'} slide has no title`, 'title');
  if (ruleAt.w > 0) shape(c, 'Accent rule', ruleAt, { geom: 'rect', fill: r.accent });
  if (s.subtitle?.trim()) {
    const f = fit([{ text: s.subtitle, color: subColor, align }], t, sub.w, sub.h, c.W === 960 ? 22 : 20, 14);
    text(c, 'Subtitle', sub, f, { field: 'subtitle', ph: 'subTitle' });
    overflowNote(c, 'The subtitle', f, sub.h, 'subtitle');
  }
  if (s.body?.trim()) {
    const f = fit([{ text: s.body, color: subColor, align }], t, body.w, body.h, 15, 10);
    text(c, 'Presenter', body, f, { anchor: 'b', field: 'body' });
    overflowNote(c, 'The presenter line', f, body.h, 'body');
  }
  return bg;
}

function sectionSlide(c: Ctx): Color {
  const { theme: t, r, W, H, MX, slide: s } = c;
  const num = String(c.section).padStart(2, '0');
  let bg: Color = r.bg;
  const kicker = (color: Color, box: Box): void => {
    const f = fit([{ text: `Section ${num}`, color, caps: true, trackingEm: 0.14, bold: true }], t, box.w, box.h, 13, 10, 1);
    text(c, 'Kicker', box, f, { anchor: 'b' });
  };
  let titleBox = { x: MX, y: H * 0.4, w: W - 2 * MX, h: 130 };
  let titleColor: Color = r.title;
  let subColor: Color = r.muted;
  switch (t.section) {
    case 'field':
      bg = r.sectionBg; titleColor = r.sectionText; subColor = { ...r.titleMuted };
      kicker(r.sectionText, { x: MX, y: H * 0.4 - 34, w: 300, h: 22 });
      shape(c, 'Rule', { x: MX, y: H * 0.4 - 6, w: 64, h: 4 }, { geom: 'rect', fill: t.dark ? r.accent : r.onFill });
      titleBox = { x: MX, y: H * 0.4 + 10, w: W - 2 * MX, h: 130 };
      break;
    case 'number': {
      const nf = fit([{ text: num, font: 'h', bold: true, color: { ...r.accent, a: 0.9 } as ColorRef }], t, 300, 170, 150, 100, 1);
      text(c, 'Number', { x: MX - 6, y: 70, w: 300, h: 170 }, nf, { anchor: 'b' });
      titleBox = { x: MX, y: 262, w: W - 2 * MX, h: 120 };
      shape(c, 'Rule', { x: MX, y: 254, w: 64, h: 4 }, { geom: 'rect', fill: r.accent });
      break;
    }
    case 'side': {
      const pw = W * 0.34;
      shape(c, 'Panel', { x: 0, y: 0, w: pw, h: H }, { geom: 'rect', fill: r.titleBg });
      const nf = fit([{ text: num, font: 'h', bold: true, color: r.accent }], t, pw - 2 * MX + 20, 150, 110, 70, 1);
      text(c, 'Number', { x: MX, y: H / 2 - 110, w: pw - MX - 20, h: 150 }, nf, { anchor: 'b' });
      const kf = fit([{ text: 'Section', color: r.titleMuted, caps: true, trackingEm: 0.14, bold: true }], t, pw - MX, 22, 13, 10, 1);
      text(c, 'Kicker', { x: MX, y: H / 2 + 46, w: pw - MX - 20, h: 22 }, kf);
      titleBox = { x: pw + 48, y: H * 0.3, w: W - pw - 48 - MX, h: 160 };
      break;
    }
  }
  if (s.title?.trim()) {
    const f = fit([{ text: s.title, font: 'h', bold: t.headingBold, color: titleColor }], t, titleBox.w, titleBox.h, c.W === 960 ? 42 : 36, 26, 3);
    text(c, 'Title', titleBox, f, { anchor: t.section === 'side' ? 'b' : 't', field: 'title', ph: 'title' });
    overflowNote(c, 'The section title', f, titleBox.h, 'title');
  } else requireTitle(c);
  if (s.subtitle?.trim()) {
    const sb = t.section === 'side' ? { x: titleBox.x, y: titleBox.y + titleBox.h + 14, w: titleBox.w, h: 80 } : { x: MX, y: titleBox.y + titleBox.h + 4, w: (W - 2 * MX) * 0.8, h: 70 };
    const f = fit([{ text: s.subtitle, color: subColor }], t, sb.w, sb.h, 20, 13);
    text(c, 'Subtitle', sb, f, { field: 'subtitle' });
    overflowNote(c, 'The subtitle', f, sb.h, 'subtitle');
  }
  return bg;
}

function bulletsSlide(c: Ctx, agenda = false): void {
  const { theme: t, r, MX, CW, slide: s } = c;
  requireTitle(c);
  contentTitle(c);
  const bottom = contentBottom(c);
  const h = bottom - Y0;
  if (agenda) {
    const items = (s.bullets ?? []).filter(b => b.level !== 1);
    if (!items.length) { problem(c, 'error', 'agenda has no items (bullets)', 'bullets'); return; }
    checkBullets(c, s.bullets, 'bullets', 8);
    const cols = items.length > 5 ? 2 : 1;
    const per = Math.ceil(items.length / cols);
    const colW = cols === 2 ? (CW - 40) / 2 : CW * 0.8;
    const rowH = Math.min(84, h / per);
    const groups = items.map(() => ({ specs: [] as ParaSpec[], w: colW - 64, h: rowH - 10 }));
    items.forEach((b, i) => { groups[i]!.specs = [{ text: b.text, color: r.text }]; });
    const shared = fitShared(groups, t, c.W === 960 ? 22 : 20, 14);
    items.forEach((_, i) => {
      const col = Math.floor(i / per);
      const row = i % per;
      const x = MX + col * (colW + 40);
      const y = Y0 + row * rowH;
      shape(c, `Number ${i + 1}`, { x, y: y + (rowH - 40) / 2, w: 40, h: 40 }, { geom: t.radius >= 8 ? 'ellipse' : 'rect', fill: r.accent });
      const nf = fit([{ text: String(i + 1), color: r.onFill, align: 'c', bold: true, font: 'h' }], t, 40, 40, 17, 12, 1);
      text(c, `Number text ${i + 1}`, { x, y: y + (rowH - 40) / 2, w: 40, h: 40 }, nf, { anchor: 'm' });
      text(c, `Item ${i + 1}`, { x: x + 60, y: y + 5, w: colW - 64, h: rowH - 10 }, shared.results[i]!, { anchor: 'm', field: 'bullets' });
      if (shared.results[i]!.overflow) problem(c, 'error', `agenda item ${i + 1} is too long — keep items to a few words`, 'bullets');
    });
    return;
  }
  const specs: ParaSpec[] = [];
  if (s.body?.trim()) specs.push({ text: s.body, color: r.muted, rel: 0.95 });
  const bs = bulletSpecs(c, s.bullets);
  if (bs.length && specs.length) bs[0] = { ...bs[0]!, beforeEm: 0.9 };
  specs.push(...bs);
  checkBullets(c, s.bullets, 'bullets');
  if (!specs.length) { if (!c.draft) problem(c, 'error', 'this slide has a title but no content — add bullets or body, or use a section layout', 'bullets'); return; }
  const f = fitAiry(specs, t, CW, h, c.W === 960 ? 24 : 22, 14, 30);
  text(c, 'Content', { x: MX, y: Y0, w: CW, h }, f, { field: s.bullets ? 'bullets' : 'body', ph: 'body' });
  overflowNote(c, 'The text', f, h, 'bullets');
}

function columnSpecs(c: Ctx, col: Slide['left'], headingColor: Color | null, textColor?: Color): ParaSpec[] {
  const specs: ParaSpec[] = [];
  if (col?.body) specs.push({ text: col.body, color: textColor ?? c.r.text, beforeEm: 0 });
  specs.push(...bulletSpecs(c, col?.bullets, textColor ? { color: textColor } : {}));
  if (specs.length > 1 && col?.body) specs[1] = { ...specs[1]!, beforeEm: 0.7 };
  void headingColor;
  return specs;
}

function columnsSlide(c: Ctx, cards: boolean): void {
  const { theme: t, r, MX, CW, slide: s } = c;
  requireTitle(c);
  contentTitle(c);
  const bottom = contentBottom(c);
  const gap = cards ? 32 : 48;
  const colW = (CW - gap) / 2;
  const cols = [s.left, s.right];
  if (!s.left && !s.right) { problem(c, 'error', 'two-column slide needs left and right {heading, bullets}', 'left'); return; }
  cols.forEach((col, i) => checkBullets(c, col?.bullets, i ? 'right' : 'left', Math.max(3, c.maxBullets - 1)));
  const headH = cards ? 52 : 36;
  const inset = cards ? 24 : 0;
  const bodyTop = Y0 + headH + (cards ? 18 : 12);
  const bodyH = bottom - bodyTop - (cards ? 20 : 0);
  // Headings share a size, bodies share a size.
  const heads = fitShared(cols.map(col => ({ specs: col?.heading ? [{ text: col.heading, font: 'h' as const, bold: true, color: cards ? r.onFill : r.accent }] : [], w: colW - 2 * inset, h: headH - (cards ? 12 : 0) })), t, 20, 14);
  const bodies = growShared(cols.map(col => ({ specs: columnSpecs(c, col, null), w: colW - 2 * inset, h: bodyH })), t, c.W === 960 ? 20 : 18, 13, 24);
  // Cards hug their content (at least a third of the area), so two short lists do not sit in two tall empty boxes.
  const used = Math.max(...bodies.results.map(b => b.height));
  const cardH = cards ? Math.min(bottom - Y0, Math.max((bottom - Y0) * 0.55, headH + 18 + used + 36)) : bottom - Y0;
  cols.forEach((col, i) => {
    const x = MX + i * (colW + gap);
    const field = i ? 'right' : 'left';
    if (cards) {
      shape(c, `Card ${i + 1}`, { x, y: Y0, w: colW, h: cardH }, { geom: t.radius ? 'roundRect' : 'rect', fill: r.surface, radius: t.radius, field });
      shape(c, `Card head ${i + 1}`, { x, y: Y0, w: colW, h: headH }, { geom: t.radius ? 'topRound' : 'rect', fill: i ? r.title : r.accent, radius: t.radius, field });
    } else if (col?.heading) {
      shape(c, `Column rule ${i + 1}`, { x, y: Y0 + headH + 3, w: colW, h: 2 }, { geom: 'rect', fill: i ? r.line : r.accent });
    }
    if (col?.heading) text(c, `Heading ${i + 1}`, { x: x + inset, y: Y0, w: colW - 2 * inset, h: headH }, heads.results[i]!, { anchor: cards ? 'm' : 'b', field });
    if (heads.results[i]!.overflow) problem(c, 'error', `the ${field} heading is too long — a few words`, field);
    text(c, `Column ${i + 1}`, { x: x + inset, y: bodyTop, w: colW - 2 * inset, h: cards ? cardH - (bodyTop - Y0) - 16 : bodyH }, bodies.results[i]!, { field });
    if (bodies.results[i]!.overflow) overflowNote(c, `The ${field} column`, bodies.results[i]!, bodyH, field);
  });
}

function imageFrame(c: Ctx, box: Box): void {
  const img = c.slide.image;
  if (img?.src) {
    c.frames.push({ kind: 'image', name: 'Picture', ...box, src: img.src, alt: img.alt ?? c.slide.title ?? '', fit: img.fit ?? 'cover', field: 'image' });
    return;
  }
  shape(c, 'Picture placeholder', box, { geom: 'rect', fill: c.r.surface, field: 'image' });
  const f = fit([{ text: 'Image — set image.src to a picture in the project', color: c.r.muted, align: 'c', italic: true }], c.theme, box.w - 40, 60, 14, 10);
  text(c, 'Picture label', { x: box.x + 20, y: box.y + box.h / 2 - 30, w: box.w - 40, h: 60 }, f, { anchor: 'm', field: 'image' });
  problem(c, 'warn', 'no image.src — add a picture (a PNG or JPEG in the project), or choose another layout', 'image');
}

function imageTextSlide(c: Ctx): void {
  const { theme: t, r, W, MX, slide: s } = c;
  requireTitle(c);
  const iw = Math.round(W * 0.44);
  imageFrame(c, { x: 0, y: 0, w: iw, h: c.H });
  const x = iw + 44;
  const w = W - x - MX;
  contentTitle(c, x, w);
  const bottom = c.H - 56;
  const specs: ParaSpec[] = [];
  if (s.body?.trim()) specs.push({ text: s.body, color: r.text });
  const bs = bulletSpecs(c, s.bullets);
  if (bs.length && specs.length) bs[0] = { ...bs[0]!, beforeEm: 0.8 };
  specs.push(...bs);
  checkBullets(c, s.bullets, 'bullets', Math.min(c.maxBullets, 5));
  if (!specs.length) return;
  const f = fitAiry(specs, t, w, bottom - Y0, 20, 13, 24);
  text(c, 'Content', { x, y: Y0, w, h: bottom - Y0 }, f, { field: s.bullets ? 'bullets' : 'body' });
  overflowNote(c, 'The text', f, bottom - Y0, 'bullets');
}

function fullImageSlide(c: Ctx): Color {
  const { theme: t, r, W, H, MX, slide: s } = c;
  imageFrame(c, { x: 0, y: 0, w: W, h: H });
  if (s.title?.trim() || s.subtitle?.trim()) {
    shape(c, 'Scrim', { x: 0, y: H * 0.42, w: W, h: H * 0.58 }, { geom: 'rect', gradient: { s: 'dk1', a: 0.78 } });
  }
  const white: ColorRef = { s: 'lt1' };
  if (s.title?.trim()) {
    const f = fit([{ text: s.title, font: 'h', bold: t.headingBold, color: white }], t, W * 0.75, 110, 36, 22, 2);
    text(c, 'Title', { x: MX, y: H - 186, w: W * 0.75, h: 110 }, f, { anchor: 'b', field: 'title', ph: 'title' });
    overflowNote(c, 'The caption', f, 110, 'title');
  }
  if (s.subtitle?.trim()) {
    const f = fit([{ text: s.subtitle, color: { s: 'lt1', mod: 0.86 } }], t, W * 0.7, 48, 18, 12);
    text(c, 'Subtitle', { x: MX, y: H - 70, w: W * 0.7, h: 48 }, f, { field: 'subtitle' });
  }
  return r.titleBg;
}

/**
 * The longest chain of boxes in a flowchart — how many columns a left-to-right
 * layout needs, which is what makes it too wide (a branching diagram of eight
 * boxes in four columns is fine; a chain of eight is not).
 */
export function flowRanks(src: string): number {
  const next = new Map<string, Set<string>>();
  const ARROW = /\s*(?:<?-->|<?---|<?==>|<?-\.->|-\.-|~~~)\s*(?:\|[^|]*\|\s*)?/;
  for (const line of src.split('\n')) {
    const ids = line.split(ARROW).map(seg => /^\s*([A-Za-z][\w-]*)/.exec(seg)?.[1]).filter((x): x is string => Boolean(x));
    if (ids.length < 2 || /^\s*(?:flowchart|graph|subgraph|style|classDef|class|click|linkStyle)\b/.test(line)) continue;
    for (let i = 1; i < ids.length; i++) {
      if (!next.has(ids[i - 1]!)) next.set(ids[i - 1]!, new Set());
      next.get(ids[i - 1]!)!.add(ids[i]!);
    }
  }
  const memo = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    let d = 1;
    for (const n of next.get(id) ?? []) d = Math.max(d, 1 + depth(n, seen));
    seen.delete(id);
    memo.set(id, d);
    return d;
  };
  let best = 0;
  for (const id of next.keys()) best = Math.max(best, depth(id, new Set()));
  return best;
}

function visualSlide(c: Ctx, kind: 'chart' | 'diagram'): void {
  const { theme: t, r, MX, CW, slide: s } = c;
  requireTitle(c);
  contentTitle(c);
  const bottom = contentBottom(c);
  const h = bottom - Y0;
  const hasBullets = (s.bullets?.length ?? 0) > 0;
  // A left-to-right flowchart is wide: beside bullets it would shrink to unreadable type, so its takeaways go underneath as a row.
  const wide = kind === 'diagram' && /^\s*(?:%%\{[\s\S]*?\}%%\s*)?(?:flowchart|graph)\s+(?:LR|RL)\b/.test(s.diagram ?? '');
  const side = hasBullets && !wide;
  const below = hasBullets && wide;
  const rowH = 78;
  const vw = side ? Math.round(CW * 0.64) : CW;
  const box = { x: MX, y: Y0, w: vw, h: below ? h - rowH - 16 : h };
  if (kind === 'chart') {
    const ch = s.chart;
    if (!ch) problem(c, 'error', 'chart slide has no chart {type, categories, series:[{name, values}]}', 'chart');
    else if (!ch.echarts) {
      if (!ch.categories.length || !ch.series.length || ch.series.every(x => !x.values.length)) problem(c, 'error', 'the chart has no data — give categories and series values', 'chart');
      else if (ch.series.some(x => x.values.length !== ch.categories.length)) problem(c, 'error', `chart series must have one value per category (${ch.categories.length})`, 'chart');
      if ((ch.type === 'pie' || ch.type === 'doughnut') && ch.categories.length > 8) problem(c, 'warn', `a pie with ${ch.categories.length} slices is unreadable — group the small ones as "Other" or use a bar chart`, 'chart');
      if (ch.categories.length > 16) problem(c, 'warn', `${ch.categories.length} categories is a lot for one slide — aggregate them`, 'chart');
    }
    if (ch) c.frames.push({ kind: 'chart', name: 'Chart', ...box, chart: ch, field: 'chart' });
  } else {
    const src = s.diagram?.trim();
    if (!src) problem(c, 'error', 'diagram slide has no diagram (Mermaid source, e.g. "flowchart LR\\n  A --> B")', 'diagram');
    else {
      if (!/^\s*(%%\{[\s\S]*?\}%%\s*)?(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|mindmap|timeline|quadrantChart|gitGraph|C4\w+|block-beta|architecture-beta|xychart-beta|sankey-beta)\b/.test(src)) {
        problem(c, 'warn', 'the diagram does not start with a Mermaid diagram type (flowchart LR, sequenceDiagram, …) — it may not render', 'diagram');
      }
      const nodes = (src.match(/-->|---|==>|-\.->|->>|-->>/g) ?? []).length;
      const ranks = wide ? flowRanks(src) : 0;
      if (ranks >= 7) problem(c, 'warn', `a left-to-right flowchart ${ranks} boxes long is too wide to read on a slide — use flowchart TD, or split the flow into two rows with subgraphs`, 'diagram');
      if (nodes > 24) problem(c, 'warn', `the diagram has ${nodes} connections — over ~20 it is unreadable on a slide; simplify or split it`, 'diagram');
      c.frames.push({ kind: 'diagram', name: 'Diagram', ...box, source: src, field: 'diagram' });
    }
  }
  if (below) {
    checkBullets(c, s.bullets, 'bullets', 4);
    const items = (s.bullets ?? []).filter(x => x.level !== 1).slice(0, 4);
    const gap = 28;
    const iw = (CW - gap * (items.length - 1)) / items.length;
    const y = Y0 + h - rowH;
    const shared = fitShared(items.map(b => ({ specs: [{ text: b.text, color: r.text }], w: iw, h: rowH - 14 })), t, 17, 11);
    items.forEach((b, i) => {
      const x = MX + i * (iw + gap);
      shape(c, `Takeaway mark ${i + 1}`, { x, y, w: 36, h: 4 }, { geom: 'rect', fill: i % 2 ? r.accent2 : r.accent });
      text(c, `Takeaway ${i + 1}`, { x, y: y + 14, w: iw, h: rowH - 14 }, shared.results[i]!, { field: 'bullets' });
      if (shared.results[i]!.overflow) problem(c, 'error', `takeaway ${i + 1} under the diagram is too long — one short line`, 'bullets');
      void b;
    });
  }
  if (side) {
    checkBullets(c, s.bullets, 'bullets', 4);
    const x = MX + vw + 36;
    const w = CW - vw - 36;
    shape(c, 'Divider', { x: x - 18, y: Y0 + 6, w: 1.25, h: h - 12 }, { geom: 'rect', fill: r.line });
    const f = fitAiry(bulletSpecs(c, s.bullets), t, w, h, 18, 12, 22);
    text(c, 'Takeaways', { x, y: Y0, w, h }, f, { anchor: 'm', field: 'bullets' });
    overflowNote(c, 'The takeaways', f, h, 'bullets');
  }
}

function tableSlide(c: Ctx): void {
  const { theme: t, r, MX, CW, slide: s } = c;
  requireTitle(c);
  contentTitle(c);
  const bottom = contentBottom(c);
  const avail = bottom - Y0;
  const tb = s.table;
  if (!tb || !tb.header.length) { problem(c, 'error', 'table slide has no table {header:[…], rows:[[…]]}', 'table'); return; }
  const ncol = tb.header.length;
  if (ncol > 6) problem(c, 'error', `${ncol} columns — at most 6 fit a slide; drop or merge columns`, 'table');
  if (tb.rows.length > 8) problem(c, 'error', `${tb.rows.length} rows — at most 8 are readable on a slide; split it or keep the top rows`, 'table');
  const pad = { x: 10, y: 7 };
  const all = [tb.header, ...tb.rows];
  // Column widths in proportion to their longest text (bounded), so a short "Owner" column does not take a quarter of the slide.
  const want = tb.header.map((_, ci) => Math.min(320, Math.max(64, ...all.map((row, ri) => textWidth(row[ci] ?? '', t.fonts.body, 14, ri === 0) + 2 * pad.x))));
  const total = want.reduce((a, b) => a + b, 0);
  const cols = want.map(w => Math.floor((w / total) * CW));
  cols[cols.length - 1]! += CW - cols.reduce((a, b) => a + b, 0);
  let size = tb.rows.length <= 4 ? 17 : tb.rows.length <= 6 ? 15 : 14;
  for (;;) {
    const cells = all.map((row, ri) => tb.header.map((_, ci) => build([{
      text: row[ci] ?? '', color: ri === 0 ? r.onFill : r.text, bold: ri === 0, ...(ri === 0 ? { font: 'h' as const } : {}),
    }], ri === 0 ? size * 0.95 : size)));
    const rows = cells.map(rowCells => Math.max(...rowCells.map((p, ci) => paraHeight(p, t, cols[ci]! - 2 * pad.x).height)) + 2 * pad.y);
    const height = rows.reduce((a, b) => a + b, 0);
    if (height <= avail || size <= 10) {
      const overflow = height > avail;
      // Spare height becomes row padding (up to 15 pt), so a short table fills its slide instead of hugging the title.
      if (!overflow && height < avail) {
        const extra = Math.min(8, (avail - height) / (2 * rows.length));
        pad.y += extra;
        for (let i = 0; i < rows.length; i++) rows[i]! += 2 * extra;
      }
      const total = rows.reduce((a, b) => a + b, 0);
      const fills = all.map((_, ri) => (ri === 0 ? r.titleBg : ri % 2 === 0 ? r.surface : undefined));
      c.frames.push({
        kind: 'table', name: 'Table', x: MX, y: Y0, w: CW, h: Math.min(total, avail), cols, rows, pad, line: r.line, field: 'table',
        cells: cells.map((rowCells, ri) => rowCells.map(p => ({ paras: p, ...(fills[ri] ? { fill: fills[ri] } : {}) }))),
        ...(overflow ? { overflow: true } : {}),
      });
      if (overflow) problem(c, 'error', `the table does not fit even at ${size} pt — shorten cell text or split it over two slides`, 'table');
      return;
    }
    size -= 1;
  }
}

function kpiSlide(c: Ctx): void {
  const { theme: t, r, MX, CW, slide: s } = c;
  requireTitle(c);
  contentTitle(c);
  const bottom = contentBottom(c);
  const kpis = s.kpis ?? [];
  if (!kpis.length) { problem(c, 'error', 'big-numbers slide has no kpis [{value, label, delta?}]', 'kpis'); return; }
  if (kpis.length > 4) problem(c, 'error', `${kpis.length} KPIs — at most 4 read as big numbers; move the rest to a table`, 'kpis');
  const shown = kpis.slice(0, 4);
  const n = shown.length;
  const gap = 24;
  const cw = (CW - gap * (n - 1)) / n;
  const hasBody = Boolean(s.body?.trim());
  const ch = hasBody ? Math.min(210, bottom - Y0 - 90) : Math.min(250, bottom - Y0);
  const cy = hasBody ? Y0 : Y0 + (bottom - Y0 - ch) / 2;
  const inset = 22;
  const iw = cw - 2 * inset;
  const values = fitShared(shown.map(k => ({ specs: [{ text: k.value, font: 'h' as const, bold: true, color: r.accent, lhf: 1.05 }], w: iw, h: ch * 0.4 })), t, n <= 2 ? 64 : n === 3 ? 54 : 46, 26);
  const labels = fitShared(shown.map(k => ({ specs: [{ text: k.label, color: r.text }], w: iw, h: ch * 0.3 - 30 })), t, 17, 11);
  shown.forEach((k, i) => {
    const x = MX + i * (cw + gap);
    shape(c, `Card ${i + 1}`, { x, y: cy, w: cw, h: ch }, { geom: t.radius ? 'roundRect' : 'rect', fill: r.surface, radius: t.radius, field: 'kpis' });
    shape(c, `Card accent ${i + 1}`, { x: x + inset, y: cy + 22, w: 40, h: 4 }, { geom: 'rect', fill: i % 2 ? r.accent2 : r.accent });
    text(c, `Value ${i + 1}`, { x: x + inset, y: cy + 28, w: iw, h: ch * 0.4 }, values.results[i]!, { anchor: 'b', field: 'kpis' });
    text(c, `Label ${i + 1}`, { x: x + inset, y: cy + 36 + ch * 0.4, w: iw, h: ch * 0.3 - 30 }, labels.results[i]!, { field: 'kpis' });
    if (values.results[i]!.overflow) problem(c, 'error', `KPI "${k.value}" is too long to show as a big number — use a short figure ("£4.2m", "38%")`, 'kpis');
    if (labels.results[i]!.overflow) problem(c, 'error', `KPI label "${k.label.slice(0, 40)}" is too long — a few words`, 'kpis');
    if (k.delta) {
      const color = k.trend === 'down' ? r.bad : k.trend === 'up' ? r.good : r.muted;
      const arrow = k.trend === 'down' ? '▼ ' : k.trend === 'up' ? '▲ ' : '';
      const f = fit([{ text: `${arrow}${k.delta}`, color, bold: true }], t, iw, 22, 14, 10, 1);
      text(c, `Delta ${i + 1}`, { x: x + inset, y: cy + ch - 40, w: iw, h: 22 }, f, { anchor: 'b', field: 'kpis' });
    }
  });
  if (hasBody) {
    const by = cy + ch + 24;
    const f = fit([{ text: s.body!, color: r.text }], t, CW, bottom - by, 18, 12);
    text(c, 'Commentary', { x: MX, y: by, w: CW, h: bottom - by }, f, { field: 'body' });
    overflowNote(c, 'The commentary', f, bottom - by, 'body');
  }
}

function quoteSlide(c: Ctx): void {
  const { theme: t, r, MX, CW, H, slide: s } = c;
  if (!s.quote?.trim()) problem(c, 'error', 'quote slide has no quote', 'quote');
  if (s.title?.trim()) {
    const f = fit([{ text: s.title, color: r.accent, caps: true, trackingEm: 0.12, bold: true }], t, CW, 22, 13, 10, 1);
    text(c, 'Label', { x: MX, y: 56, w: CW, h: 22 }, f, { field: 'title', ph: 'title' });
  }
  const mark = fit([{ text: '“', font: 'h', color: { ...r.accent, a: 0.85 } as ColorRef, lhf: 1 }], t, 120, 150, 140, 140, 1);
  text(c, 'Quote mark', { x: MX - 8, y: 70, w: 120, h: 150 }, mark);
  const qx = MX + 70;
  const qw = CW - 110;
  const qy = 140;
  const qh = H - qy - 130;
  if (s.quote?.trim()) {
    const f = fit([{ text: s.quote, font: 'h', italic: true, color: r.title, lhf: 1.22 }], t, qw, qh, c.W === 960 ? 32 : 28, 18);
    text(c, 'Quote', { x: qx, y: qy, w: qw, h: qh }, f, { anchor: 'm', field: 'quote' });
    overflowNote(c, 'The quote', f, qh, 'quote');
  }
  if (s.attribution?.trim()) {
    shape(c, 'Rule', { x: qx, y: H - 108, w: 40, h: 3 }, { geom: 'rect', fill: r.accent });
    const f = fit([{ text: s.attribution, color: r.muted, bold: true }], t, qw, 40, 17, 12, 2);
    text(c, 'Attribution', { x: qx, y: H - 96, w: qw, h: 40 }, f, { field: 'attribution' });
  }
}

function timelineSlide(c: Ctx): void {
  const { theme: t, r, MX, CW, slide: s } = c;
  requireTitle(c);
  contentTitle(c);
  const bottom = contentBottom(c);
  const items = s.timeline ?? [];
  if (items.length < 2) { problem(c, 'error', 'timeline needs at least 2 items [{date, title, text?}]', 'timeline'); if (!items.length) return; }
  if (items.length > 6) problem(c, 'error', `${items.length} milestones — at most 6 fit; group them or split the timeline`, 'timeline');
  const shown = items.slice(0, 6);
  const n = shown.length;
  const slot = CW / n;
  const gap = 14;
  const cw = slot - gap;
  const inset = 14;
  // The axis, the dates above it and a card per milestone below, as one block centred in the content area.
  const area = bottom - Y0;
  const room = Math.min(196, area - 104);
  const dates = fitShared(shown.map(m => ({ specs: [{ text: m.date, color: r.accent, bold: true, align: 'c' as const }], w: cw, h: 52 })), t, 18, 11);
  const below = growShared(shown.map(m => ({
    specs: [
      { text: m.title, font: 'h' as const, bold: true, color: r.title },
      ...(m.text ? [{ text: m.text, rel: 0.8, color: r.muted, beforeEm: 0.45 }] : []),
    ], w: cw - 2 * inset, h: room - 2 * inset,
  })), t, 17, 11, 20);
  // Cards as tall as the longest milestone needs, and the block centred in the content area.
  const cardH = Math.max(84, Math.min(room, Math.max(...below.results.map(x => x.height)) + 2 * inset + 8));
  const top = Y0 + Math.max(0, (area - (70 + 26 + cardH)) / 2);
  const axis = top + 70;
  shape(c, 'Axis', { x: MX, y: axis - 1.5, w: CW, h: 3 }, { geom: 'rect', fill: r.line });
  shown.forEach((m, i) => {
    const cx = MX + slot * i + slot / 2;
    const last = i === n - 1;
    shape(c, `Card ${i + 1}`, { x: cx - cw / 2, y: axis + 26, w: cw, h: cardH }, { geom: t.radius ? 'roundRect' : 'rect', fill: r.surface, radius: Math.min(t.radius, 10), field: 'timeline' });
    shape(c, `Tick ${i + 1}`, { x: cx - 1, y: axis + 8, w: 2, h: 18 }, { geom: 'rect', fill: last ? r.accent2 : r.accent });
    shape(c, `Dot ${i + 1}`, { x: cx - 10, y: axis - 10, w: 20, h: 20 }, { geom: 'ellipse', fill: last ? r.accent2 : r.accent, line: { color: r.bg, w: 3 } });
    text(c, `Date ${i + 1}`, { x: cx - cw / 2, y: axis - 66, w: cw, h: 52 }, dates.results[i]!, { anchor: 'b', field: 'timeline' });
    text(c, `Milestone ${i + 1}`, { x: cx - cw / 2 + inset, y: axis + 26 + inset, w: cw - 2 * inset, h: cardH - 2 * inset }, below.results[i]!, { field: 'timeline' });
    if (below.results[i]!.overflow || dates.results[i]!.overflow) problem(c, 'error', `milestone ${i + 1} ("${m.title.slice(0, 30)}") has too much text — a short title and one line`, 'timeline');
  });
}

// ── Entry points ─────────────────────────────────────────────────────

export interface LayoutOptions {
  /** The editor: draw planned slides' intent as a placeholder. */
  draft?: boolean;
}

/** Lay out one slide of a deck. */
export function layoutSlide(deck: Deck, index: number, opts: LayoutOptions = {}): SlideLayout {
  const slide = deck.slides[index]!;
  const theme = deckTheme(deck.theme);
  const size = SLIDE_SIZE[deck.aspect] ?? SLIDE_SIZE['16:9'];
  const W = size.w;
  const MX = W === 960 ? 56 : 44;
  const type = deckTypeById(deck.type);
  const c: Ctx = {
    deck, slide, theme, r: roles(theme), W, H: size.h, MX, CW: W - 2 * MX, frames: [], problems: [], n: index + 1,
    maxBullets: type?.maxBullets ?? 6,
    section: deck.slides.slice(0, index + 1).filter(s => s.layout === 'section').length,
    draft: Boolean(opts.draft),
  };
  const pending = isPending(slide);
  let bg: Color = c.r.bg;
  let chrome = true;
  if (pending) {
    // A planned slide: its title where the layout puts titles, and the plan.
    if (slide.layout === 'title' || slide.layout === 'closing') { bg = titleSlide(c, slide.layout === 'closing'); chrome = false; }
    else if (slide.layout === 'section') { bg = sectionSlide(c); chrome = false; }
    else contentTitle(c);
    c.problems = c.problems.filter(p => p.field === 'title' && /does not fit|too long/.test(p.message));
    if (opts.draft) {
      const box = { x: c.MX, y: Y0, w: c.CW, h: c.H - 56 - Y0 };
      if (chrome) {
        shape(c, 'Plan', box, { geom: 'roundRect', radius: 10, line: { color: c.r.muted, w: 1, dash: true } });
        const f = fit([{ text: `Planned · ${layoutInfo(slide.layout).label}`, color: c.r.accent, bold: true, caps: true, trackingEm: 0.1 },
          { text: slide.intent!, color: c.r.muted, italic: true, beforeEm: 0.6 }], theme, box.w - 60, box.h - 40, 18, 11);
        text(c, 'Plan text', { x: box.x + 30, y: box.y + 20, w: box.w - 60, h: box.h - 40 }, f, { anchor: 'm' });
      }
    }
  } else {
    switch (slide.layout) {
      case 'title': bg = titleSlide(c); chrome = false; break;
      case 'closing': bg = titleSlide(c, true); chrome = false; break;
      case 'section': bg = sectionSlide(c); chrome = false; break;
      case 'bullets': bulletsSlide(c); break;
      case 'agenda': bulletsSlide(c, true); break;
      case 'two-column': columnsSlide(c, false); break;
      case 'comparison': columnsSlide(c, true); break;
      case 'image-text': imageTextSlide(c); break;
      case 'image': bg = fullImageSlide(c); chrome = false; break;
      case 'chart': visualSlide(c, 'chart'); break;
      case 'diagram': visualSlide(c, 'diagram'); break;
      case 'table': tableSlide(c); break;
      case 'kpi': kpiSlide(c); break;
      case 'quote': quoteSlide(c); break;
      case 'timeline': timelineSlide(c); break;
    }
  }
  if (chrome) footer(c);
  return { slide, n: c.n, w: W, h: c.H, background: bg, frames: c.frames, problems: c.problems, pending };
}

export function layoutDeck(deck: Deck, opts: LayoutOptions = {}): SlideLayout[] {
  return deck.slides.map((_, i) => layoutSlide(deck, i, opts));
}

/** Every problem in the deck, slide problems first, then the deck's own. */
export function validateDeck(deck: Deck): { problems: Problem[]; pending: string[] } {
  const layouts = layoutDeck(deck);
  const problems = layouts.flatMap(l => l.problems);
  const pending = layouts.filter(l => l.pending).map(l => l.slide.id);
  if (deck.slides.length && deck.slides[0]!.layout !== 'title' && !pending.includes(deck.slides[0]!.id)) {
    problems.push({ slide: deck.slides[0]!.id, n: 1, severity: 'warn', message: 'a deck usually opens with a title slide (layout "title")' });
  }
  const titles = new Map<string, number>();
  for (const s of deck.slides) {
    const k = plainOf(s.title ?? '').trim().toLowerCase();
    if (k && !['title', 'closing', 'section'].includes(s.layout)) titles.set(k, (titles.get(k) ?? 0) + 1);
  }
  for (const [k, n] of titles) {
    if (n > 1) {
      const first = deck.slides.findIndex(s => plainOf(s.title ?? '').trim().toLowerCase() === k);
      problems.push({ slide: deck.slides[first]!.id, n: first + 1, severity: 'warn', message: `${n} slides are titled "${k}" — titles should say what each slide shows` });
    }
  }
  return { problems, pending };
}

/** Problems as the lines the tool and the editor show. */
export function problemLines(problems: Problem[], max = 30): string[] {
  const lines = problems.slice(0, max).map(p => `${p.severity === 'error' ? 'FIX' : 'warn'} ${p.slide} (slide ${p.n})${p.field ? ` ${p.field}` : ''}: ${p.message}`);
  if (problems.length > max) lines.push(`(+${problems.length - max} more)`);
  return lines;
}
