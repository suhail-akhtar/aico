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

import { isPending, layoutInfo, parseRuns, plainOf, type Bullet, type Deck, type DeckChart, type DeckImage, type ImageMask, type Slide, type TextRun } from './deck-model';
import { contrastRatio, inkOn, resolveHex, roles, themeContrastProblems, themeOfDeck, type ColorRef, type DeckTheme, type SchemeSlot } from './deck-themes';
import { deckTypeById } from './deck-types';
import { textWidth } from './deck-fonts';
import { clipToRect, pathCommands, polyPath, type PresetGeom, type Pt } from './deck-geometry';
import { isDeckIcon } from './deck-icons';
import { layoutInfographic } from './deck-infographics';
import { deckRuleProblems } from './deck-rules';
import { SCENES, decorShapes, pickScene, polyHitsBox, sceneShapes, seeded as seededRnd, toFramePath, type Scene } from './deck-decor';

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

export interface Box { x: number; y: number; w: number; h: number }

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
  /** Frames sharing a group id are one PowerPoint group (an infographic item: its shape, icon and text). */
  group?: string;
  /** The smallest size this text may be set at by the rules (body ≥ 18 pt…); below it the validator reports it. */
  minRule?: number;
}

export interface ShapeFrame extends Box {
  kind: 'shape';
  name: string;
  /** A PowerPoint preset, a freeform `path` (absolute M/L/C/Z in the box), or an `icon` from the deck icon set. */
  geom: PresetGeom | 'path' | 'icon';
  /** Preset adjust values in slide units (deck-geometry `presetPath`). */
  adj?: number[];
  path?: string;
  icon?: string;
  /** Clockwise degrees about the box centre. */
  rot?: number;
  flipV?: boolean;
  fill?: Color;
  /** A vertical gradient from transparent to this colour at `a` (photo scrims). */
  gradient?: ColorRef;
  /** A two-colour linear gradient; `angle` in degrees, 0 = left to right, clockwise. */
  grad?: { from: ColorRef; to: ColorRef; angle: number };
  line?: { color: Color; w: number; dash?: boolean };
  radius?: number;
  field?: string;
  group?: string;
}

export interface ImageFrame extends Box {
  kind: 'image';
  name: string;
  src: string;
  alt: string;
  fit: 'cover' | 'contain';
  field: string;
  mask?: ImageMask;
  /** The diagonal cut on the right edge instead of the left. */
  maskFlip?: boolean;
  group?: string;
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

export interface ParaSpec {
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

export interface FitResult { paras: Para[]; size: number; height: number; overflow: boolean; lines: number }

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

export interface Ctx {
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

function text(c: Ctx, name: string, box: Box, fitted: FitResult, opts: { anchor?: TextFrame['anchor']; field?: string; ph?: TextFrame['ph']; group?: string; minRule?: number } = {}): TextFrame {
  const f: TextFrame = {
    kind: 'text', name, ...box, paras: fitted.paras, anchor: opts.anchor ?? 't',
    ...(opts.field ? { field: opts.field } : {}), ...(opts.ph ? { ph: opts.ph } : {}), ...(fitted.overflow ? { overflow: true } : {}),
    ...(opts.group ? { group: opts.group } : {}), ...(opts.minRule ? { minRule: opts.minRule } : {}),
  };
  c.frames.push(f);
  return f;
}

/**
 * The body-size rule (ADR 0025): text the audience must read is not set
 * below `min` points — 18 for a slide's main text at 16:9, a little less for
 * two columns. The fitter may still shrink to its floor so nothing spills;
 * the rule turns "it fits at 14 pt" into a problem to fix (cut or split).
 */
function sizeRule(c: Ctx, what: string, f: FitResult, min: number, field: string): void {
  if (f.overflow || !f.paras.length) return;
  const size = f.size;
  const floor = c.W === 960 ? min : min - 2;
  if (size < floor) problem(c, 'error', `${what} is set at ${size} pt to fit — below the ${floor} pt minimum for reading at a distance; cut words, split the slide, or make it visual (make_visual)`, field);
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
  if (s.image?.src) {
    if (s.image.mask && s.image.mask !== 'rect' && !closing) return heroTitle(c, false);
    return photoField(c, closing ? 'closing' : 'title');
  }
  const style = closing ? 'field' : t.title;
  // Gradient themes run their field from one slot to the other (ADR 0025).
  if (style === 'field' && t.gradient) shape(c, 'Gradient field', { x: 0, y: 0, w: W, h: H }, { geom: 'rect', grad: gradOf(c, 35) });
  if (style === 'split' && t.gradient) shape(c, 'Gradient panel', { x: 0, y: 0, w: W * 0.5, h: H }, { geom: 'rect', grad: gradOf(c, 60) });
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
      // The decoration is the theme's signature motif (`decorate`), placed around the text after it is laid out.
      bg = r.titleBg; titleColor = r.titleText; subColor = r.titleMuted;
      break;
    case 'split': {
      const pw = W * 0.5;
      if (!t.gradient) shape(c, 'Title panel', { x: 0, y: 0, w: pw, h: H }, { geom: 'rect', fill: r.titleBg });
      // The right half carries the theme's motif (`decorate`); an image here is the cover's picture.
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
  // Room for the theme's motif (ADR 0025): a side motif keeps the right third free, waves the bottom band.
  const side = (t.decor === 'shards' || t.decor === 'arch') && style !== 'split' ? Math.round(W * 0.34) : 0;
  if (side) {
    for (const b of [box, sub, body]) b.w = Math.min(b.w, W - side - b.x);
    if (center) ruleAt.x = box.x + box.w / 2 - ruleAt.w / 2;
  }
  if (t.decor === 'waves') {
    if (style === 'band' && !closing) body.y = sub.y + sub.h + 4;
    else for (const b of [box, ruleAt, sub, body]) b.y -= 64;
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
  if (s.image?.src) return photoField(c, 'section');
  if (t.section === 'field' && t.gradient) shape(c, 'Gradient field', { x: 0, y: 0, w: W, h: H }, { geom: 'rect', grad: gradOf(c, 20) });
  const num = String(c.section).padStart(2, '0');
  // Big section numbers (01, 02… by section order) unless the deck turns them off (ADR 0025).
  const numbers = c.deck.sectionNumbers !== false;
  let bg: Color = r.bg;
  const kicker = (color: Color, box: Box): void => {
    const f = fit([{ text: 'Section', color, caps: true, trackingEm: 0.14, bold: true }], t, box.w, box.h, 13, 10, 1);
    text(c, 'Kicker', box, f, { anchor: 'b' });
  };
  let titleBox = { x: MX, y: H * 0.4, w: W - 2 * MX, h: 130 };
  let titleColor: Color = r.title;
  let subColor: Color = r.muted;
  switch (t.section) {
    case 'field':
      bg = r.sectionBg; titleColor = r.sectionText; subColor = { ...r.titleMuted };
      if (numbers) {
        // The number sits above the kicker with its own clearance: the label never runs into the number or the title.
        const nf = fit([{ text: num, font: 'h', bold: true, color: { ...r.sectionText, a: 0.9 } as ColorRef, lhf: 1.05 }], t, 360, 136, 124, 80, 1);
        text(c, 'Number', { x: MX - 6, y: 32, w: 360, h: 136 }, nf, { anchor: 'b' });
      }
      kicker(r.sectionText, { x: MX, y: H * 0.4 - 34, w: 300, h: 22 });
      shape(c, 'Rule', { x: MX, y: H * 0.4 - 6, w: 64, h: 4 }, { geom: 'rect', fill: t.dark ? r.accent : r.onFill });
      titleBox = { x: MX, y: H * 0.4 + 10, w: W - 2 * MX, h: 130 };
      break;
    case 'number': {
      if (numbers) {
        const nf = fit([{ text: num, font: 'h', bold: true, color: { ...r.accent, a: 0.9 } as ColorRef }], t, 300, 170, 150, 100, 1);
        text(c, 'Number', { x: MX - 6, y: 70, w: 300, h: 170 }, nf, { anchor: 'b' });
      }
      titleBox = { x: MX, y: 262, w: W - 2 * MX, h: 120 };
      shape(c, 'Rule', { x: MX, y: 254, w: 64, h: 4 }, { geom: 'rect', fill: r.accent });
      break;
    }
    case 'side': {
      const pw = W * 0.34;
      shape(c, 'Panel', { x: 0, y: 0, w: pw, h: H }, { geom: 'rect', fill: r.titleBg });
      if (numbers) {
        const nf = fit([{ text: num, font: 'h', bold: true, color: r.accent }], t, pw - 2 * MX + 20, 150, 110, 70, 1);
        text(c, 'Number', { x: MX, y: H / 2 - 110, w: pw - MX - 20, h: 150 }, nf, { anchor: 'b' });
      }
      const kf = fit([{ text: 'Section', color: r.titleMuted, caps: true, trackingEm: 0.14, bold: true }], t, pw - MX, 22, 13, 10, 1);
      text(c, 'Kicker', { x: MX, y: H / 2 + 46, w: pw - MX - 20, h: 22 }, kf);
      titleBox = { x: pw + 48, y: H * 0.3, w: W - pw - 48 - MX, h: 160 };
      break;
    }
  }
  // A side motif keeps the right third of a full-width section free (ADR 0025).
  if ((t.decor === 'shards' || t.decor === 'arch') && t.section !== 'side') titleBox.w = Math.min(titleBox.w, Math.round(W * 0.66) - titleBox.x);
  if (s.title?.trim()) {
    const f = fit([{ text: s.title, font: 'h', bold: t.headingBold, color: titleColor }], t, titleBox.w, titleBox.h, c.W === 960 ? 42 : 36, 26, 3);
    text(c, 'Title', titleBox, f, { anchor: t.section === 'side' ? 'b' : 't', field: 'title', ph: 'title' });
    overflowNote(c, 'The section title', f, titleBox.h, 'title');
  } else requireTitle(c);
  if (s.subtitle?.trim()) {
    const sb = t.section === 'side' ? { x: titleBox.x, y: titleBox.y + titleBox.h + 14, w: titleBox.w, h: 80 } : { x: MX, y: titleBox.y + titleBox.h + 4, w: Math.min((W - 2 * MX) * 0.8, titleBox.w), h: 70 };
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
  text(c, 'Content', { x: MX, y: Y0, w: CW, h }, f, { field: s.bullets ? 'bullets' : 'body', ph: 'body', minRule: 18 });
  overflowNote(c, 'The text', f, h, 'bullets');
  sizeRule(c, 'The text', f, 18, s.bullets ? 'bullets' : 'body');
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
  if (bodies.results.some(b => b.paras.length)) sizeRule(c, 'The column text', bodies.results.find(b => b.paras.length)!, 16, 'left');
}

// ── Pictures (ADR 0025) ──────────────────────────────────────────────

/** The scrim colour: the theme's darkest slot. White text over it is checked to keep 4.5:1 on a white photo. */
const INK: ColorRef = { s: 'dk1' };
/** Overlay on the whole photo, then a gradient under the text: their composite at the top of the text is ≥ 0.66. */
export const SCRIM = { base: 0.32, from: 0.5, to: 0.88 } as const;

/** The worst-case contrast of the theme's light text over a photo behind the scrim (a pure white photo). */
export function scrimContrast(theme: DeckTheme): number {
  const a = 1 - (1 - SCRIM.base) * (1 - SCRIM.from);
  const ink = resolveHex(theme, INK);
  const mix = (ch: number): number => Math.round(255 * (1 - a) + parseInt(ink.slice(ch, ch + 2), 16) * a);
  const bg = `#${[1, 3, 5].map(i => mix(i).toString(16).padStart(2, '0')).join('')}`;
  return contrastRatio(resolveHex(theme, { s: 'lt1' }), bg);
}

function scrim(c: Ctx, box: Box, textTop: number, group?: string): void {
  shape(c, 'Photo overlay', box, { geom: 'rect', fill: { ...INK, a: SCRIM.base }, ...(group ? { group } : {}) });
  const top = Math.max(box.y, textTop - 36);
  shape(c, 'Scrim', { x: box.x, y: top, w: box.w, h: box.y + box.h - top }, { geom: 'rect', grad: { from: { ...INK, a: SCRIM.from }, to: { ...INK, a: SCRIM.to }, angle: 90 }, ...(group ? { group } : {}) });
}

/**
 * The theme's gradient (or dk2 → accent1) for fields and art. White text sits
 * on fields, so each stop is darkened (PowerPoint `lumMod`) until white keeps
 * 4.5:1 on it — a cyan end that would wash out the subtitle is deepened, not
 * trusted.
 */
export function gradOf(c: { theme: DeckTheme }, angle = 35): { from: ColorRef; to: ColorRef; angle: number } {
  const g: [SchemeSlot, SchemeSlot] = c.theme.gradient ?? ['dk2', 'accent1'];
  const light = resolveHex(c.theme, { s: 'lt1' });
  const stop = (s: SchemeSlot): ColorRef => {
    for (const mod of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
      const ref: ColorRef = mod === 1 ? { s } : { s, mod };
      if (contrastRatio(light, resolveHex(c.theme, ref)) >= 4.5) return ref;
    }
    return { s, mod: 0.25 };
  };
  return { from: stop(g[0]), to: stop(g[1]), angle };
}

function maskGeom(mask: ImageMask | undefined): PresetGeom | 'path' {
  return mask === 'circle' ? 'ellipse' : mask === 'hexagon' ? 'hexagon' : mask === 'rounded' ? 'roundRect' : mask === 'diagonal' ? 'path' : 'rect';
}

/** The diagonal cut: the long edge slants in by 18% of the width (left edge, or right when `flip`). */
export function diagonalPoints(w: number, h: number, flip = false): Pt[] {
  const k = w * 0.18;
  return flip ? [[0, 0], [w, 0], [w - k, h], [0, h]] : [[k, 0], [w, 0], [w, h], [0, h]];
}

/** Seeded pseudo-random numbers: the same slide always gets the same art. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x6d2b79f5) >>> 0; return (h % 10000) / 10000; };
}

/** A picture cut as a convex outline in its own box (the illustration is clipped to it). */
function maskPoly(mask: ImageMask | undefined, w: number, h: number, flip = false): Pt[] {
  switch (maskGeom(mask)) {
    case 'ellipse': return Array.from({ length: 72 }, (_, i) => [w / 2 + (w / 2) * Math.cos((i / 72) * Math.PI * 2), h / 2 + (h / 2) * Math.sin((i / 72) * Math.PI * 2)] as Pt);
    case 'hexagon': return [[0, h / 2], [w / 4, 0], [(3 * w) / 4, 0], [w, h / 2], [(3 * w) / 4, h], [w / 4, h]];
    case 'path': return diagonalPoints(w, h, flip);
    case 'roundRect': {
      const k = Math.min(18, w / 2, h / 2);
      const pts: Pt[] = [];
      for (const [cx, cy, a0] of [[w - k, k, -90], [w - k, h - k, 0], [k, h - k, 90], [k, k, 180]] as [number, number, number][]) {
        for (let i = 0; i <= 6; i++) { const a = ((a0 + (i / 6) * 90) * Math.PI) / 180; pts.push([cx + k * Math.cos(a), cy + k * Math.sin(a)]); }
      }
      return pts;
    }
    default: return [[0, 0], [w, 0], [w, h], [0, h]];
  }
}

/** The scene an empty or `art:scene` slot draws: picked from the slide's own words, then the deck's brief. */
function sceneFor(c: Ctx, img: DeckImage | undefined, style?: string): Scene {
  if (style && (SCENES as readonly string[]).includes(style)) return style as Scene;
  const s = c.slide;
  const brief = c.deck.brief;
  const own = [s.title, s.subtitle, img?.alt, img?.caption, s.body].filter(Boolean).join(' · ');
  return pickScene(own, [c.deck.slides[0]?.title, brief?.industry, brief?.notes, brief?.audience].filter(Boolean).join(' · '));
}

/**
 * A generated illustration (ADR 0025): a vector scene in the theme's gradient
 * and light tints, every element a freeform clipped to the picture's cut —
 * native, editable, and needing no credit (it is the deck's own drawing).
 * One PowerPoint group, named "Illustration".
 */
function illustrationFrames(c: Ctx, box: Box, scene: Scene, mask: ImageMask | undefined, field: string, group?: string, flip = false): void {
  const g = { group: group ?? 'Illustration', field };
  const geom = maskGeom(mask);
  const base = geom === 'path'
    ? { geom: 'path' as const, path: polyPath(diagonalPoints(box.w, box.h, flip)) }
    : { geom, ...(geom === 'roundRect' ? { radius: 18 } : {}), ...(geom === 'hexagon' ? { adj: [box.w / 4] } : {}) };
  shape(c, `Illustration: ${scene}`, box, { ...base, grad: gradOf(c, 40), ...g });
  for (const el of sceneShapes(scene, box.w, box.h, maskPoly(mask, box.w, box.h, flip), seededRnd(`${c.slide.id}|${scene}|${Math.round(box.w)}`))) {
    const f = toFramePath({ name: el.name, pts: el.pts.map(([x, y]) => [box.x + x, box.y + y] as Pt) });
    shape(c, `Illustration ${el.name.toLowerCase()}`, f.box, { geom: 'path', path: f.path, fill: el.fill, ...g });
  }
}

/**
 * Generated art for a picture slot (`art:mesh|circles|waves|grid|blocks`):
 * the theme's gradient and a few light shapes, all native and all inside the
 * box — the fallback when there is no licensed photo, and never a stock cliché.
 */
function artFrames(c: Ctx, box: Box, style: string, mask: ImageMask | undefined, field: string, group?: string, flip = false): void {
  // art:scene and art:<scene> are illustrations, not abstract art.
  if (style === 'scene' || (SCENES as readonly string[]).includes(style)) { illustrationFrames(c, box, sceneFor(c, undefined, style), mask, field, group, flip); return; }
  const g = { ...(group ? { group } : {}), field };
  const geom = maskGeom(mask);
  const base = geom === 'path'
    ? { geom: 'path' as const, path: polyPath(diagonalPoints(box.w, box.h, flip)) }
    : { geom, ...(geom === 'roundRect' ? { radius: 18 } : {}), ...(geom === 'hexagon' ? { adj: [box.w / 4] } : {}) };
  shape(c, 'Art', box, { ...base, grad: gradOf(c, 40), ...g });
  // Decorations stay inside the shape: a circle or hexagon gets its inscribed square.
  const inset = geom === 'ellipse' || geom === 'hexagon' ? 0.16 : geom === 'path' ? 0.2 : geom === 'roundRect' ? 0.04 : 0;
  const ib: Box = { x: box.x + box.w * inset, y: box.y + box.h * (geom === 'path' ? 0.04 : inset), w: box.w * (1 - 2 * inset), h: box.h * (1 - (geom === 'path' ? 0.08 : 2 * inset)) };
  const rnd = seeded(`${c.slide.id}|${style}|${Math.round(box.w)}`);
  const light = (a: number): ColorRef => ({ s: 'lt1', a });
  const clipped = (pts: Pt[]): string => polyPath(clipToRect(pts, 0, 0, ib.w, ib.h));
  switch (style) {
    case 'circles': {
      const d = Math.min(ib.w, ib.h);
      for (let i = 0; i < 3; i++) {
        const s = d * (0.9 - i * 0.25);
        shape(c, `Art ring ${i + 1}`, { x: ib.x + ib.w * (0.55 + rnd() * 0.1) - s / 2, y: ib.y + ib.h / 2 - s / 2, w: s, h: s }, { geom: 'donut', adj: [Math.max(2, s * 0.035)], fill: light(0.18 + i * 0.06), ...g });
      }
      const ds = d * 0.22;
      shape(c, 'Art disc', { x: ib.x + ib.w * 0.12, y: ib.y + ib.h * 0.62, w: ds, h: ds }, { geom: 'ellipse', fill: { s: 'accent2', a: 0.85 }, ...g });
      break;
    }
    case 'waves': {
      for (let k = 0; k < 3; k++) {
        const pts: Pt[] = [];
        const y0 = ib.h * (0.45 + k * 0.17);
        const amp = ib.h * (0.06 + rnd() * 0.04);
        const ph = rnd() * Math.PI * 2;
        for (let i = 0; i <= 24; i++) pts.push([(ib.w * i) / 24, y0 + Math.sin(ph + (i / 24) * Math.PI * 2.2) * amp]);
        pts.push([ib.w, ib.h], [0, ib.h]);
        shape(c, `Art wave ${k + 1}`, ib, { geom: 'path', path: clipped(pts), fill: light(0.12 + k * 0.08), ...g });
      }
      break;
    }
    case 'grid': {
      const cols = 9;
      const step = ib.w / cols;
      const rows = Math.floor(ib.h / step);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if (rnd() < 0.35) continue;
          const s = step * (0.12 + rnd() * 0.14);
          shape(c, 'Art dot', { x: ib.x + x * step + (step - s) / 2, y: ib.y + y * step + (step - s) / 2, w: s, h: s }, { geom: 'ellipse', fill: light(0.25 + rnd() * 0.3), ...g });
        }
      }
      break;
    }
    case 'blocks': {
      for (let i = 0; i < 4; i++) {
        const w = ib.w * (0.3 + rnd() * 0.3);
        const h = ib.h * (0.18 + rnd() * 0.16);
        shape(c, `Art block ${i + 1}`, { x: ib.x + rnd() * (ib.w - w), y: ib.y + (i / 4) * (ib.h - h) + rnd() * 10, w, h }, { geom: 'roundRect', radius: 10, fill: i === 1 ? { s: 'accent2', a: 0.75 } : light(0.14 + i * 0.05), ...g });
      }
      break;
    }
    default: { // mesh: diagonal bands
      for (let k = 0; k < 4; k++) {
        const x0 = ib.w * (-0.3 + k * 0.32 + rnd() * 0.08);
        const bw = ib.w * (0.12 + rnd() * 0.12);
        shape(c, `Art band ${k + 1}`, ib, { geom: 'path', path: clipped([[x0, ib.h], [x0 + bw, ib.h], [x0 + bw + ib.h * 0.8, 0], [x0 + ib.h * 0.8, 0]]), fill: light(0.08 + k * 0.05), ...g });
      }
    }
  }
}

/** Sharpness, alt text and credit — the picture rules (ADR 0025). */
function imageChecks(c: Ctx, img: DeckImage, box: Box, field: string): void {
  if (img.src.startsWith('art:')) return;
  if (!img.alt?.trim()) problem(c, 'error', 'a picture has no alt text — set image.alt to what it shows (screen readers and PowerPoint\'s accessibility check read it)', field);
  if (img.px) {
    // Pixels per point the slot gets once the picture is cropped to cover it; 1.25 px/pt is a 1200 px wide full-bleed picture.
    const ppp = Math.max(box.w / img.px[0], box.h / img.px[1]);
    if (1 / ppp < 1.25) problem(c, 'warn', `a picture of ${img.px[0]}×${img.px[1]} px is soft in a ${Math.round(box.w)}×${Math.round(box.h)} pt slot (it needs about ${Math.round(box.w * 1.25)}×${Math.round(box.h * 1.25)} px to cover it) — choose a larger one`, field);
  }
  if (img.sourceUrl && !img.credit && !img.license) problem(c, 'error', 'a fetched picture has no credit or licence — keep the credit find_images returned', field);
}

/** "Photo: Jane Doe · CC BY 2.0", small, inside the picture's corner (or under it when the corner is cut away). */
function creditFrame(c: Ctx, img: DeckImage, box: Box, field: string, group?: string): void {
  if (!img.credit && !img.license) return;
  const label = `${img.credit ? `Photo: ${img.credit}` : 'Photo'}${img.license ? ` · ${img.license}` : ''}`;
  const cut = img.mask === 'circle' || img.mask === 'hexagon';
  const w = Math.min(box.w - 16, 240);
  const f = fit([{ text: label, color: cut ? c.r.muted : { s: 'lt1' }, align: 'r' }], c.theme, w - 8, 12, 7, 6, 1);
  const y = cut ? Math.min(c.H - 14, box.y + box.h + 4) : box.y + box.h - 18;
  if (!cut) shape(c, 'Credit backing', { x: box.x + box.w - w - 8, y, w: w + 4, h: 14 }, { geom: 'rect', fill: { ...INK, a: 0.45 }, field, ...(group ? { group } : {}) });
  text(c, 'Picture credit', { x: box.x + box.w - w - 6, y: y + 1, w, h: 12 }, f, { anchor: 'm', field, ...(group ? { group } : {}) });
}

/** A picture (or its art, or a placeholder) in a box. Returns whether something real is drawn. */
function imageFrame(c: Ctx, box: Box, opts: { img?: DeckImage; mask?: ImageMask; field?: string; name?: string; credit?: boolean; group?: string; warnEmpty?: boolean } = {}): boolean {
  const img = opts.img ?? c.slide.image;
  const field = opts.field ?? 'image';
  const mask = opts.mask ?? img?.mask;
  const group = opts.group ? { group: opts.group } : {};
  if (img?.src?.startsWith('art:')) { artFrames(c, box, img.src.slice(4), mask, field, opts.group); return true; }
  if (img?.src) {
    c.frames.push({
      kind: 'image', name: opts.name ?? 'Picture', ...box, src: img.src, alt: img.alt ?? c.slide.title ?? '', fit: img.fit ?? 'cover', field,
      ...(mask && mask !== 'rect' ? { mask } : {}), ...group,
    });
    if (opts.credit !== false) creditFrame(c, { ...img, ...(mask ? { mask } : {}) }, box, field, opts.group);
    imageChecks(c, img, box, field);
    return true;
  }
  // No picture (none found, none licensed, none given): a generated illustration from the slide's words stands in (ADR 0025).
  illustrationFrames(c, box, sceneFor(c, img), mask, field, opts.group);
  if (opts.warnEmpty !== false) problem(c, 'warn', 'no picture yet — a generated illustration stands in; set image.src (find_images for a licensed photo, a project file, "art:scene" to keep an illustration, or "art:mesh|circles|waves|grid|blocks"), or choose another layout', field);
  return false;
}

/**
 * A full-height picture with one slanted edge facing the text (`flip`: the
 * right edge slants, for a picture on the left), and an accent stripe along
 * the cut. Art takes the same cut.
 */
function diagonalPicture(c: Ctx, img: DeckImage, box: Box, flip: boolean): void {
  const k = box.w * 0.18;
  if (img.src.startsWith('art:')) artFrames(c, box, img.src.slice(4), 'diagonal', 'image', undefined, flip);
  else {
    c.frames.push({ kind: 'image', name: 'Picture', ...box, src: img.src, alt: img.alt ?? c.slide.title ?? '', fit: img.fit ?? 'cover', field: 'image', mask: 'diagonal', ...(flip ? { maskFlip: true } : {}) });
    // The credit sits in the corner the cut keeps.
    creditFrame(c, img, flip ? { ...box, w: box.w * 0.8 } : box, 'image');
    imageChecks(c, img, box, 'image');
  }
  const stripe: Pt[] = flip
    ? [[box.w - 3, 0], [box.w + 9, 0], [box.w - k + 9, box.h], [box.w - k - 3, box.h]]
    : [[k - 9, 0], [k + 3, 0], [3, box.h], [-9, box.h]];
  const xs = stripe.map(p => p[0]);
  const x0 = Math.min(...xs);
  shape(c, 'Edge accent', { x: box.x + x0, y: box.y, w: Math.max(...xs) - x0, h: box.h }, { geom: 'path', path: polyPath(stripe.map(([x, y]) => [x - x0, y] as Pt)), fill: c.r.accent, field: 'image' });
}

/** A decorative accent behind a cut-out picture: an offset disc or ring in the accent colour. */
function photoAccent(c: Ctx, box: Box, mask: ImageMask | undefined): void {
  const off = Math.round(Math.min(box.w, box.h) * 0.06);
  if (mask === 'circle') {
    shape(c, 'Photo ring', { x: box.x - off, y: box.y - off, w: box.w + off * 2, h: box.h + off * 2 }, { geom: 'donut', adj: [3], fill: c.r.accent });
    shape(c, 'Photo dot', { x: box.x + box.w * 0.82, y: box.y + box.h * 0.8, w: off * 3, h: off * 3 }, { geom: 'ellipse', fill: c.r.accent2 });
  } else if (mask === 'hexagon') {
    shape(c, 'Photo hexagon', { x: box.x + off * 1.4, y: box.y + off * 1.4, w: box.w, h: box.h }, { geom: 'hexagon', adj: [box.w / 4], fill: { ...c.r.accent, a: 0.9 } as ColorRef });
  } else if (mask === 'rounded') {
    shape(c, 'Photo block', { x: box.x + off * 1.5, y: box.y + off * 1.5, w: box.w, h: box.h }, { geom: 'roundRect', radius: 18, fill: { ...c.r.accent, a: 0.9 } as ColorRef });
  }
}

function imageTextSlide(c: Ctx): void {
  const { theme: t, r, W, H, MX, slide: s } = c;
  requireTitle(c);
  const img = s.image;
  const right = img?.side === 'right';
  const mask = img?.mask;
  const iw = Math.round(W * 0.44);
  let x: number;
  if (!mask || mask === 'diagonal') {
    const box = { x: right ? W - iw : 0, y: 0, w: iw, h: H };
    if (mask === 'diagonal' && img?.src) diagonalPicture(c, img, box, !right);
    else imageFrame(c, box);
    x = right ? MX : iw + 44;
  } else {
    const d = Math.min(iw - 70, H - 150);
    const bw = mask === 'hexagon' ? Math.round(d * 1.1547) : d;
    const box = { x: right ? W - iw + (iw - bw) / 2 - 10 : (iw - bw) / 2 + 10, y: (H - d) / 2, w: bw, h: d };
    if (img?.src) photoAccent(c, box, mask);
    imageFrame(c, box);
    x = right ? MX : iw + 30;
  }
  const w = right ? W - iw - MX - 40 : W - x - MX;
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
  text(c, 'Content', { x, y: Y0, w, h: bottom - Y0 }, f, { field: s.bullets ? 'bullets' : 'body', minRule: 16 });
  overflowNote(c, 'The text', f, bottom - Y0, 'bullets');
  sizeRule(c, 'The text', f, 16, s.bullets ? 'bullets' : 'body');
}

function fullImageSlide(c: Ctx): Color {
  const { theme: t, r, W, H, MX, slide: s } = c;
  imageFrame(c, { x: 0, y: 0, w: W, h: H }, { credit: false });
  if (s.title?.trim() || s.subtitle?.trim()) scrim(c, { x: 0, y: 0, w: W, h: H }, H - 186);
  const white: ColorRef = { s: 'lt1' };
  if (s.title?.trim()) {
    const f = fit([{ text: s.title, font: 'h', bold: t.headingBold, color: white }], t, W * 0.75, 110, 36, 22, 2);
    text(c, 'Title', { x: MX, y: H - 186, w: W * 0.75, h: 110 }, f, { anchor: 'b', field: 'title', ph: 'title' });
    overflowNote(c, 'The caption', f, 110, 'title');
  }
  if (s.subtitle?.trim()) {
    const f = fit([{ text: s.subtitle, color: { s: 'lt1', mod: 0.9 } }], t, W * 0.7, 48, 18, 12);
    text(c, 'Subtitle', { x: MX, y: H - 70, w: W * 0.7, h: 48 }, f, { field: 'subtitle' });
  }
  if (s.image) creditFrame(c, s.image, { x: 0, y: 0, w: W, h: H }, 'image');
  return r.titleBg;
}

/** Title, section or closing over a full-bleed photo (or art), with the scrim that keeps white text at AA. */
function photoField(c: Ctx, kind: 'title' | 'section' | 'closing'): Color {
  const { theme: t, r, W, H, MX, slide: s } = c;
  const full = { x: 0, y: 0, w: W, h: H };
  const art = s.image?.src.startsWith('art:');
  imageFrame(c, full, { credit: false, mask: 'rect' });
  const center = kind === 'closing';
  const titleBox = kind === 'section' ? { x: MX, y: H * 0.36, w: W * 0.8, h: 140 } : center ? { x: MX, y: H * 0.26, w: W - 2 * MX, h: 150 } : { x: MX, y: H * 0.3, w: W * 0.8, h: 170 };
  if (!art) scrim(c, full, titleBox.y); else shape(c, 'Art overlay', full, { geom: 'rect', fill: { ...INK, a: 0.18 } });
  const white: ColorRef = { s: 'lt1' };
  const soft: ColorRef = { s: 'lt1', mod: 0.9 };
  const align = center ? 'c' : 'l';
  if (kind === 'section') {
    const kf = fit([{ text: c.deck.sectionNumbers === false ? 'Section' : `Section ${String(c.section).padStart(2, '0')}`, color: white, caps: true, trackingEm: 0.14, bold: true }], t, 300, 22, 13, 10, 1);
    text(c, 'Kicker', { x: MX, y: titleBox.y - 40, w: 300, h: 22 }, kf, { anchor: 'b' });
  }
  shape(c, 'Accent rule', { x: center ? W / 2 - 40 : MX, y: titleBox.y - 12, w: 80, h: 5 }, { geom: 'rect', fill: r.accent });
  if (s.title?.trim()) {
    const f = fit([{ text: s.title, font: 'h', bold: t.headingBold, color: white, align }], t, titleBox.w, titleBox.h, kind === 'section' ? 42 : c.W === 960 ? 48 : 42, 26, 3);
    text(c, 'Title', titleBox, f, { anchor: 't', field: 'title', ph: kind === 'title' ? 'ctrTitle' : 'title' });
    overflowNote(c, 'The title', f, titleBox.h, 'title');
  } else problem(c, 'error', `${kind} slide has no title`, 'title');
  const subY = titleBox.y + titleBox.h + 8;
  if (s.subtitle?.trim()) {
    const f = fit([{ text: s.subtitle, color: soft, align }], t, titleBox.w * (center ? 1 : 0.9), 70, 21, 13);
    text(c, 'Subtitle', { x: titleBox.x, y: subY, w: titleBox.w * (center ? 1 : 0.9), h: 70 }, f, { field: 'subtitle', ...(kind === 'title' ? { ph: 'subTitle' as const } : {}) });
    overflowNote(c, 'The subtitle', f, 70, 'subtitle');
  }
  if (s.body?.trim() && kind !== 'section') {
    const f = fit([{ text: s.body, color: soft, align }], t, W - 2 * MX, 26, 15, 10);
    text(c, 'Presenter', { x: MX, y: H - 70, w: W - 2 * MX, h: 26 }, f, { anchor: 'b', field: 'body' });
  }
  if (s.image) creditFrame(c, s.image, full, 'image');
  return r.titleBg;
}

/** A title slide with a cut-out photo (circle, hexagon, diagonal, rounded) beside the title. */
function heroTitle(c: Ctx, closing: boolean): Color {
  const { theme: t, r, W, H, MX, slide: s } = c;
  const img = s.image!;
  const mask = img.mask!;
  const right = img.side !== 'left';
  let box: Box;
  if (mask === 'diagonal') box = { x: right ? W * 0.46 : 0, y: 0, w: W * 0.54, h: H };
  else if (mask === 'rounded') box = { x: right ? W * 0.52 : 40, y: 46, w: W * 0.48 - 46, h: H - 92 };
  else {
    const d = Math.min(H * 0.74, W * 0.4);
    const bw = mask === 'hexagon' ? d * 1.1547 : d;
    box = { x: right ? W * 0.73 - bw / 2 : W * 0.27 - bw / 2, y: (H - d) / 2, w: bw, h: d };
  }
  // A colour field from the photo's centre to the edge: the cut-out sits half on it, as in a printed layout.
  if (mask === 'circle' || mask === 'hexagon') {
    const fx = right ? box.x + box.w / 2 : 0;
    const fw = right ? W - fx : box.x + box.w / 2;
    shape(c, 'Photo field', { x: fx, y: 0, w: fw, h: H }, t.gradient ? { geom: 'rect', grad: gradOf(c, 90) } : { geom: 'rect', fill: r.titleBg });
  }
  if (mask !== 'diagonal') photoAccent(c, box, mask);
  if (mask === 'diagonal') diagonalPicture(c, img, box, !right);
  else imageFrame(c, box);
  const tx = right ? MX : box.x + box.w + 50;
  const tw = (right ? box.x - 50 : W - MX) - tx;
  const align = 'l';
  shape(c, 'Accent rule', { x: tx, y: 330, w: 84, h: 6 }, { geom: 'rect', fill: r.accent });
  if (s.title?.trim()) {
    const f = fit([{ text: s.title, font: 'h', bold: t.headingBold, color: r.title, align }], t, tw, 200, closing ? 44 : c.W === 960 ? 46 : 40, 26, 4);
    text(c, 'Title', { x: tx, y: 112, w: tw, h: 200 }, f, { anchor: 'b', field: 'title', ph: 'ctrTitle' });
    overflowNote(c, 'The title', f, 200, 'title');
  } else problem(c, 'error', 'title slide has no title', 'title');
  if (s.subtitle?.trim()) {
    const f = fit([{ text: s.subtitle, color: r.muted, align }], t, tw, 80, 21, 13);
    text(c, 'Subtitle', { x: tx, y: 352, w: tw, h: 80 }, f, { field: 'subtitle', ph: 'subTitle' });
    overflowNote(c, 'The subtitle', f, 80, 'subtitle');
  }
  if (s.body?.trim()) {
    const f = fit([{ text: s.body, color: r.muted, align }], t, tw, 26, 15, 10);
    text(c, 'Presenter', { x: tx, y: H - 78, w: tw, h: 26 }, f, { anchor: 'b', field: 'body' });
  }
  return r.bg;
}

/** 2–4 pictures in a row (or two rows of two), each with an optional caption. */
function imageGridSlide(c: Ctx): void {
  const { theme: t, r, MX, CW, slide: s } = c;
  requireTitle(c);
  contentTitle(c);
  const bottom = contentBottom(c);
  const imgs = s.images ?? [];
  if (imgs.length < 2) problem(c, 'error', 'a picture grid needs images: [{src, alt, caption?}] — 2 to 4', 'images');
  if (imgs.length > 4) problem(c, 'error', `${imgs.length} pictures — at most 4 read on one slide`, 'images');
  const shown = imgs.slice(0, 4);
  if (!shown.length) return;
  let top = Y0;
  if (s.body?.trim()) {
    const f = fit([{ text: s.body, color: r.muted }], t, CW, 30, 18, 13, 1);
    text(c, 'Lead', { x: MX, y: Y0, w: CW, h: 30 }, f, { field: 'body' });
    top += 42;
  }
  const n = shown.length;
  const cols = n;
  const gap = 20;
  const capH = shown.some(i => i.caption) ? 40 : 0;
  const cw = (CW - gap * (cols - 1)) / cols;
  const ch = bottom - top - capH;
  const caps = fitShared(shown.map(i => ({ specs: i.caption ? [{ text: i.caption, color: r.text, align: 'c' as const }] : [], w: cw, h: capH - 8 })), t, 15, 11);
  shown.forEach((im, i) => {
    const box = { x: MX + i * (cw + gap), y: top, w: cw, h: ch };
    imageFrame(c, box, { img: im, field: 'images', name: `Picture ${i + 1}`, mask: im.mask ?? (t.radius >= 8 ? 'rounded' : undefined) });
    if (im.caption) text(c, `Caption ${i + 1}`, { x: box.x, y: top + ch + 8, w: cw, h: capH - 8 }, caps.results[i]!, { field: 'images' });
  });
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
  // A portrait beside the quote (ADR 0025): a circle with an accent ring, the quote moved right of it.
  const portrait = Boolean(s.image?.src);
  const pd = 230;
  if (portrait) {
    const box = { x: MX + 6, y: (H - pd) / 2 + 6, w: pd, h: pd };
    photoAccent(c, box, 'circle');
    imageFrame(c, box, { mask: 'circle' });
  }
  const shift = portrait ? pd + 60 : 0;
  const mark = fit([{ text: '“', font: 'h', color: { ...r.accent, a: 0.85 } as ColorRef, lhf: 1 }], t, 120, 150, 140, 140, 1);
  text(c, 'Quote mark', { x: MX - 8 + shift, y: 70, w: 120, h: 150 }, mark);
  const qx = MX + 70 + shift;
  const qw = CW - 110 - shift;
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

// ── The theme's motif and the overlap checks (ADR 0025) ──────────────

/** Frames a motif must keep clear of: text, pictures, content, and small accents (rules, marks) — not background panels. */
function keepsClear(f: Frame, area: number): boolean {
  if (f.kind === 'text') return f.paras.some(p => p.runs.some(r => r.text.trim()));
  if (f.kind !== 'shape') return true;
  if (f.group === 'Motif') return false;
  return Boolean(f.field) || f.geom === 'icon' || f.w * f.h < area * 0.04;
}

/**
 * Draw the theme's signature motif (`deck-decor.ts`) around what the slide
 * already holds: the full motif on cover, section and closing slides, the
 * small corner variant on content slides. Its shapes go under the text (just
 * before the first frame they keep clear of) and form one PowerPoint group.
 */
function decorate(c: Ctx, where: 'cover' | 'section' | 'closing' | 'content'): void {
  const t = c.theme;
  const area = c.W * c.H;
  const first = c.frames.findIndex(f => keepsClear(f, area));
  const protect = c.frames.filter(f => keepsClear(f, area)).map(f => ({ x: f.x, y: f.y, w: f.w, h: f.h }));
  const framed = where === 'cover' && t.title === 'frame' && !c.slide.image?.src;
  const bounds = framed ? { x: 42, y: 42, w: c.W - 84, h: c.H - 84 } : { x: 0, y: 0, w: c.W, h: c.H };
  // Light tints on a coloured field (an accent or a gradient behind), accent tints on a plain background.
  const light = where === 'section' ? t.section === 'field' : where === 'content' ? false : Boolean(t.gradient) && (where === 'closing' || t.title === 'field');
  const shapes = decorShapes(t.decor, { bounds, protect, light, small: where === 'content' }, `${c.slide.id}|${where}`);
  const frames: ShapeFrame[] = shapes.map((sh) => {
    const fp = toFramePath(sh);
    return { kind: 'shape', name: sh.name, ...fp.box, geom: 'path', path: fp.path, group: 'Motif', ...(sh.fill ? { fill: sh.fill } : {}), ...(sh.line ? { line: sh.line } : {}) };
  });
  c.frames.splice(first < 0 ? c.frames.length : first, 0, ...frames);
}

/** Where a text frame's lines actually are (its anchor decides where the measured height sits in the box). */
function textExtent(theme: DeckTheme, f: TextFrame): Box {
  const h = paraHeight(f.paras, theme, f.w).height;
  const y = f.anchor === 'b' ? f.y + f.h - h : f.anchor === 'm' ? f.y + (f.h - h) / 2 : f.y;
  return { x: f.x, y, w: f.w, h };
}

const meets = (a: Box, b: Box, pad = 0): boolean => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/**
 * Overlap checks (ADR 0025), on a slide's frames: a label, number or icon
 * never runs into the slide title; no motif shape touches text; and on cover,
 * section and closing slides no text straddles the edge of a band or panel
 * (half on the dark band, half off it). Text already reported as overflowing
 * is skipped — its fix is the same.
 */
export function overlapProblems(frames: Frame[], theme: DeckTheme, layout: Slide['layout']): { message: string; field?: string }[] {
  const out: { message: string; field?: string }[] = [];
  const texts = frames.filter((f): f is TextFrame => f.kind === 'text' && !f.overflow && f.paras.some(p => p.runs.some(r => r.text.trim())));
  const title = texts.find(f => f.name === 'Title');
  const label = (f: Frame): string => (f.name === 'Kicker' ? 'section label' : f.name === 'Number' ? 'section number' : f.name.toLowerCase());
  if (title) {
    const te = textExtent(theme, title);
    for (const f of texts) {
      if (f === title) continue;
      if (meets(te, textExtent(theme, f))) out.push({ message: `the ${label(f)} overlaps the title — shorten the title or the ${label(f)}`, field: 'title' });
    }
    for (const f of frames) {
      if (f.kind === 'shape' && f.geom === 'icon' && meets(te, f)) out.push({ message: `an icon (${f.icon}) overlaps the title — shorten the title`, field: 'title' });
    }
  }
  const motif = frames.filter((f): f is ShapeFrame => f.kind === 'shape' && f.group === 'Motif');
  outer: for (const m of motif) {
    // The shape itself, not its box: a corner triangle may come close to a title its box would overlap.
    const polys = (m.path ?? '').split('M').filter(Boolean).map(seg => pathCommands(`M${seg}`).filter(cm => cm[0] !== 'Z').map(cm => [m.x + (cm[cm.length - 2] as number), m.y + (cm[cm.length - 1] as number)] as Pt));
    for (const f of texts) {
      const e = textExtent(theme, f);
      if (meets(e, m) && polys.some(poly => polyHitsBox(m.line ? [...poly, poly[0]!] : poly, e))) { out.push({ message: `the theme motif touches the ${label(f)} — report this (the motif should move out of the way)` }); break outer; }
    }
  }
  if (layout === 'title' || layout === 'section' || layout === 'closing') {
    const panels = frames.filter(f => f.kind === 'shape' && ['Band', 'Title panel', 'Gradient panel', 'Panel'].includes(f.name));
    for (const p of panels) {
      for (const f of texts) {
        const e = textExtent(theme, f);
        const inside = e.x >= p.x - 0.5 && e.x + e.w <= p.x + p.w + 0.5 && e.y >= p.y - 0.5 && e.y + e.h <= p.y + p.h + 0.5;
        if (meets(e, p) && !inside) out.push({ message: `the ${label(f)} crosses the edge of the ${p.name.toLowerCase()} — shorten it so it sits wholly on or off it`, ...(f.field ? { field: f.field } : {}) });
      }
    }
  }
  return out;
}

function overlapChecks(c: Ctx): void {
  for (const p of overlapProblems(c.frames, c.theme, c.slide.layout)) problem(c, 'error', p.message, p.field);
}

// ── Entry points ─────────────────────────────────────────────────────

export interface LayoutOptions {
  /** The editor: draw planned slides' intent as a placeholder. */
  draft?: boolean;
}

/** Lay out one slide of a deck. */
export function layoutSlide(deck: Deck, index: number, opts: LayoutOptions = {}): SlideLayout {
  const slide = deck.slides[index]!;
  const theme = themeOfDeck(deck);
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
      case 'infographic': requireTitle(c); contentTitle(c); layoutInfographic(c, KIT); break;
      case 'image-grid': imageGridSlide(c); break;
    }
  }
  if (chrome) footer(c);
  // The theme's motif goes in last, around everything else; then nothing may overlap the title.
  if (slide.layout === 'title' || slide.layout === 'closing' || slide.layout === 'section') decorate(c, slide.layout === 'title' ? 'cover' : slide.layout);
  else if (chrome) decorate(c, 'content');
  overlapChecks(c);
  return { slide, n: c.n, w: W, h: c.H, background: bg, frames: c.frames, problems: c.problems, pending };
}

export function layoutDeck(deck: Deck, opts: LayoutOptions = {}): SlideLayout[] {
  return deck.slides.map((_, i) => layoutSlide(deck, i, opts));
}

/**
 * What the infographic library (`deck-infographics.ts`) builds with — the
 * engine's own fitting and frame helpers, handed over rather than imported so
 * the two modules do not import each other.
 */
export const KIT = {
  fit, fitShared, growShared, text, shape, problem, overflowNote, contentBottom, imageFrame, photoAccent, gradOf, sizeRule,
  Y0, LH_BODY,
  /** Item `i`'s colour: accents 1–5 in order (accent 6 is kept for neutrals), so one slide stays within five colours. */
  accent: (i: number): ColorRef => ({ s: (['accent1', 'accent2', 'accent3', 'accent4', 'accent5'] as const)[i % 5]! }),
  ink: (c: Ctx, fill: ColorRef): ColorRef => inkOn(c.theme, fill),
  /** An accent for bold label text on the slide background — or the title colour when the accent would be under 3:1 there. */
  readable: (c: Ctx, ref: ColorRef): ColorRef => (contrastRatio(resolveHex(c.theme, ref), resolveHex(c.theme, c.r.bg)) >= 3 ? ref : c.r.title),
  isIcon: isDeckIcon,
};
export type Kit = typeof KIT;

/** Every problem in the deck, slide problems first, then the deck's own. */
export function validateDeck(deck: Deck): { problems: Problem[]; pending: string[] } {
  const layouts = layoutDeck(deck);
  const problems = layouts.flatMap(l => l.problems);
  problems.push(...deckRuleProblems(deck, layouts));
  const theme = themeOfDeck(deck);
  for (const m of themeContrastProblems(theme)) problems.push({ slide: deck.slides[0]?.id ?? '-', n: 1, severity: 'error', message: `the palette fails contrast — ${m}; adjust the brand colours (palette) or pick another theme` });
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
