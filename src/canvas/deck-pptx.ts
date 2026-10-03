/**
 * AICO Slides → PowerPoint: a `.pptx` written by hand with `fflate`, from
 * the layout engine's frames (`shared/ui/canvas/deck-layout`).
 *
 * ## Why by hand
 *
 * ADR 0023 (and 0008 before it for Word): a presentation library is a new
 * runtime dependency that still leaves the hard part — layout and text fitting
 * — to us, and a .pptx is a zip of a few dozen XML parts. What this writes,
 * and why each piece is there:
 *
 * - **A theme part made from the deck theme** — its ten colour slots and its
 *   heading/body fonts. Every text run and shape below refers to the slots
 *   (`schemeClr`, with PowerPoint's own `lumMod`/`lumOff`/`alpha`) and to the
 *   theme fonts (`+mj-lt`, `+mn-lt`), so choosing another colour or font
 *   variant in PowerPoint's Design tab restyles the whole deck.
 * - **A slide master and five layouts** (Title Slide, Title and Content,
 *   Section Header, Title Only, Blank) with matching placeholders. Slide
 *   titles are title placeholders and the main bullets a body placeholder, so
 *   the outline view, "Reset slide", accessibility checks and screen readers
 *   see real titles and content.
 * - **Native, editable text**: explicit sizes from the fitter, exact line
 *   pitch (`spcPts`) and zero insets so the text sits where the app drew it;
 *   `normAutofit` so PowerPoint shrinks it if the person later types more.
 * - **Native shapes, tables (`a:tbl`) and charts** — `c:chart` parts with
 *   cached values *and* an embedded workbook (written by the sheet exporter),
 *   so a chart opens with *Edit Data* working. Charts that are not plain
 *   category charts (an ECharts option kept as is) and Mermaid diagrams are
 *   pictures: PNGs drawn at 3× by the export browser.
 * - **Speaker notes** as `notesSlide` parts under a notes master, and the
 *   per-slide **fade** transition.
 *
 * Pictures must be PNG, JPEG or GIF (what every PowerPoint opens); anything
 * else is drawn as a labelled placeholder and reported.
 *
 * @module canvas/deck-pptx
 */

import { zipSync, strToU8 } from 'fflate';
import type { Deck, DeckChart } from '../../shared/ui/canvas/deck-model.js';
import type { Color, Frame, ImageFrame, Para, ShapeFrame, SlideLayout, TableFrame, TextFrame } from '../../shared/ui/canvas/deck-layout.js';
import { chartKey, diagramKey } from '../../shared/ui/canvas/deck-render.js';
import { deckTheme, roles, type ColorRef, type DeckTheme, type SchemeSlot } from '../../shared/ui/canvas/deck-themes.js';
import { applyOp, emptyBook, type SheetBook } from '../../shared/ui/canvas/sheet-model.js';
import { bookToXlsx } from './sheet-xlsx.js';

export interface PptxPicture { png: Buffer; width: number; height: number }

export interface PptxImage { bytes: Buffer; ext: '.png' | '.jpeg' | '.gif'; width: number; height: number }

export interface PptxInput {
  title: string;
  deck: Deck;
  layouts: SlideLayout[];
  /** Image src → bytes and size (PNG/JPEG/GIF); a missing entry is drawn as a placeholder. */
  images: Map<string, PptxImage | undefined>;
  /** Visual key (`chartKey`/`diagramKey`) → a rendered picture, for diagrams and non-native charts. */
  pictures: Map<string, PptxPicture>;
  author?: string;
  date?: Date;
}

export interface PptxResult { bytes: Uint8Array; warnings: string[] }

const EMU = 12700;
const e = (pt: number): number => Math.round(pt * EMU);
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const LANG = 'en-GB';

function x(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Colours ──────────────────────────────────────────────────────────

/** Slide XML names the scheme through the master's colour map (bg1/tx1/bg2/tx2), as PowerPoint itself writes it. */
const MAPPED: Record<SchemeSlot, string> = {
  dk1: 'tx1', lt1: 'bg1', dk2: 'tx2', lt2: 'bg2',
  accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6',
};

function clr(c: Color, alphaOverride?: number): string {
  if (typeof c === 'string') {
    const a = alphaOverride;
    return `<a:srgbClr val="${c.replace('#', '').toUpperCase()}">${a !== undefined && a < 1 ? `<a:alpha val="${Math.round(a * 100000)}"/>` : ''}</a:srgbClr>`;
  }
  const mods = [
    ...(c.mod !== undefined ? [`<a:lumMod val="${Math.round(c.mod * 100000)}"/>`] : []),
    ...(c.off !== undefined ? [`<a:lumOff val="${Math.round(c.off * 100000)}"/>`] : []),
  ];
  const a = alphaOverride ?? c.a;
  if (a !== undefined && a < 1) mods.push(`<a:alpha val="${Math.round(a * 100000)}"/>`);
  return `<a:schemeClr val="${MAPPED[c.s]}">${mods.join('')}</a:schemeClr>`;
}

const fill = (c: Color | undefined): string => (c === undefined ? '<a:noFill/>' : `<a:solidFill>${clr(c)}</a:solidFill>`);

// ── Text ─────────────────────────────────────────────────────────────

function rPr(p: Para, run: { b?: boolean; i?: boolean; c?: boolean; color?: Color }, tag = 'a:rPr'): string {
  const attrs = [`lang="${LANG}"`, `sz="${Math.round(p.size * 100)}"`];
  if (p.bold || run.b) attrs.push('b="1"'); else attrs.push('b="0"');
  if (p.italic || run.i) attrs.push('i="1"');
  if (p.caps) attrs.push('cap="all"');
  if (p.tracking) attrs.push(`spc="${Math.round(p.tracking * 100)}"`);
  attrs.push('dirty="0"');
  const face = p.font === 'h' ? '+mj' : '+mn';
  // Inline code is the one run not in a theme font: a monospace face the layout engine measured it in.
  const fonts = run.c ? '<a:latin typeface="Consolas"/><a:cs typeface="Consolas"/>' : `<a:latin typeface="${face}-lt"/><a:ea typeface="${face}-ea"/><a:cs typeface="${face}-cs"/>`;
  return `<${tag} ${attrs.join(' ')}>${fill(run.color ?? p.color)}${fonts}</${tag}>`;
}

function paraXml(p: Para): string {
  const algn = p.align === 'c' ? 'ctr' : p.align === 'r' ? 'r' : 'l';
  const hang = Math.min(p.indent, Math.round(p.size * 1.1));
  const bu = p.bullet
    ? `<a:buClr>${clr(p.bulletColor ?? p.color)}</a:buClr><a:buSzPct val="100000"/><a:buFont typeface="Arial"/><a:buChar char="${x(p.bullet)}"/>`
    : '<a:buNone/>';
  const pPr = `<a:pPr marL="${e(p.indent)}" indent="${p.bullet ? -e(hang) : 0}" algn="${algn}">`
    + `<a:lnSpc><a:spcPts val="${Math.round(p.lh * 100)}"/></a:lnSpc><a:spcBef><a:spcPts val="${Math.round(p.before * 100)}"/></a:spcBef>${bu}</a:pPr>`;
  const runs = p.runs.map((r) => (r.br ? `<a:br>${rPr(p, r)}</a:br>` : r.text ? `<a:r>${rPr(p, r)}<a:t>${x(r.text)}</a:t></a:r>` : '')).join('');
  return `<a:p>${pPr}${runs}${rPr(p, {}, 'a:endParaRPr')}</a:p>`;
}

function txBody(paras: Para[], anchor: 't' | 'm' | 'b', autofit: boolean, tag = 'p:txBody'): string {
  const a = anchor === 'm' ? 'ctr' : anchor === 'b' ? 'b' : 't';
  // A table cell's body takes its margins and anchor from tcPr; its bodyPr stays empty, as PowerPoint writes it.
  const bodyPr = tag === 'a:txBody' ? '<a:bodyPr/>'
    : `<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${a}" rtlCol="0">${autofit ? '<a:normAutofit/>' : '<a:noAutofit/>'}</a:bodyPr>`;
  return `<${tag}>${bodyPr}<a:lstStyle/>`
    + `${paras.length ? paras.map(paraXml).join('') : '<a:p><a:endParaRPr lang="en-GB" dirty="0"/></a:p>'}</${tag}>`;
}

// ── Slide parts ──────────────────────────────────────────────────────

interface SlideCtx {
  id: number;
  rels: string[];
  media: { name: string; bytes: Buffer; ext: string }[];
  charts: { name: string; xml: string; workbook: Uint8Array }[];
  warnings: string[];
  theme: DeckTheme;
  input: PptxInput;
  counters: { media: number; chart: number };
}

function nextId(s: SlideCtx): number { return ++s.id; }

function rel(s: SlideCtx, type: string, target: string): string {
  const id = `rId${s.rels.length + 1}`;
  s.rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${x(target)}"/>`);
  return id;
}

function xfrm(f: { x: number; y: number; w: number; h: number }, flip = ''): string {
  return `<a:xfrm${flip}><a:off x="${e(f.x)}" y="${e(f.y)}"/><a:ext cx="${Math.max(1, e(f.w))}" cy="${Math.max(1, e(f.h))}"/></a:xfrm>`;
}

function textSp(f: TextFrame, s: SlideCtx): string {
  const id = nextId(s);
  const ph = f.ph === 'title' ? '<p:ph type="title"/>' : f.ph === 'ctrTitle' ? '<p:ph type="ctrTitle"/>'
    : f.ph === 'subTitle' ? '<p:ph type="subTitle" idx="1"/>' : f.ph === 'body' ? '<p:ph idx="1"/>' : '';
  const nv = ph
    ? `<p:nvSpPr><p:cNvPr id="${id}" name="${x(f.name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>`
    : `<p:nvSpPr><p:cNvPr id="${id}" name="${x(f.name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`;
  return `<p:sp>${nv}<p:spPr>${xfrm(f)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
    + `${txBody(f.paras, f.anchor, f.paras.length > 0 && f.h >= 30)}</p:sp>`;
}

function geomXml(f: ShapeFrame): { prst: string; av: string; flip: string } {
  const short = Math.max(1, Math.min(f.w, f.h));
  const adj = (r: number): number => Math.max(0, Math.min(50000, Math.round((r / short) * 100000)));
  switch (f.geom) {
    case 'ellipse': return { prst: 'ellipse', av: '', flip: '' };
    case 'roundRect': return { prst: 'roundRect', av: `<a:gd name="adj" fmla="val ${adj(f.radius ?? 8)}"/>`, flip: '' };
    case 'topRound': return { prst: 'round2SameRect', av: `<a:gd name="adj1" fmla="val ${adj(f.radius ?? 8)}"/><a:gd name="adj2" fmla="val 0"/>`, flip: '' };
    case 'corner': return { prst: 'rtTriangle', av: '', flip: ' flipH="1" flipV="1"' };
    default: return { prst: 'rect', av: '', flip: '' };
  }
}

function shapeSp(f: ShapeFrame, s: SlideCtx): string {
  const id = nextId(s);
  const g = geomXml(f);
  let fillXml = fill(f.fill);
  if (f.gradient) {
    fillXml = `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0">${clr(f.gradient, 0)}</a:gs><a:gs pos="100000">${clr(f.gradient)}</a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>`;
  }
  const line = f.line
    ? `<a:ln w="${e(f.line.w)}"><a:solidFill>${clr(f.line.color)}</a:solidFill>${f.line.dash ? '<a:prstDash val="dash"/>' : ''}</a:ln>`
    : '<a:ln><a:noFill/></a:ln>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${x(f.name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(f, g.flip)}<a:prstGeom prst="${g.prst}"><a:avLst>${g.av}</a:avLst></a:prstGeom>${fillXml}${line}</p:spPr></p:sp>`;
}

function picXml(s: SlideCtx, name: string, alt: string, rid: string, box: { x: number; y: number; w: number; h: number }, crop?: { l: number; t: number; r: number; b: number }): string {
  const id = nextId(s);
  const src = crop && (crop.l || crop.t || crop.r || crop.b)
    ? `<a:srcRect l="${Math.round(crop.l * 100000)}" t="${Math.round(crop.t * 100000)}" r="${Math.round(crop.r * 100000)}" b="${Math.round(crop.b * 100000)}"/>` : '';
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${x(name)}" descr="${x(alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="${rid}"/>${src}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function addMedia(s: SlideCtx, bytes: Buffer, ext: string): string {
  const name = `image${++s.counters.media}${ext}`;
  s.media.push({ name, bytes, ext });
  return rel(s, 'image', `../media/${name}`);
}

/** Fit `iw`×`ih` into a box: cropped to cover it, or scaled to sit inside it. */
function placeImage(box: { x: number; y: number; w: number; h: number }, iw: number, ih: number, fit: 'cover' | 'contain'): { box: typeof box; crop?: { l: number; t: number; r: number; b: number } } {
  const ir = iw / ih;
  const br = box.w / box.h;
  if (fit === 'cover') {
    if (ir > br) { const keep = br / ir; const c = (1 - keep) / 2; return { box, crop: { l: c, r: c, t: 0, b: 0 } }; }
    const keep = ir / br; const c = (1 - keep) / 2; return { box, crop: { l: 0, r: 0, t: c, b: c } };
  }
  const w = ir > br ? box.w : box.h * ir;
  const h = ir > br ? box.w / ir : box.h;
  return { box: { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h } };
}

function placeholderSp(s: SlideCtx, f: { x: number; y: number; w: number; h: number }, label: string): string {
  const r = roles(s.theme);
  const shape: ShapeFrame = { kind: 'shape', name: 'Placeholder', ...f, geom: 'rect', fill: r.surface };
  const para: Para = { runs: [{ text: label }], size: 12, lh: 15, font: 'b', bold: false, italic: true, color: r.muted, align: 'c', indent: 0, before: 0 };
  return shapeSp(shape, s) + textSp({ kind: 'text', name: 'Placeholder label', x: f.x + 12, y: f.y, w: f.w - 24, h: f.h, paras: [para], anchor: 'm' }, s);
}

function imageXml(f: ImageFrame, s: SlideCtx): string {
  const img = s.input.images.get(f.src);
  if (!img) {
    s.warnings.push(`slide picture "${f.src.startsWith('data:') ? 'embedded image' : f.src}" could not be read (a PNG, JPEG or GIF in the project) — drawn as a placeholder`);
    return placeholderSp(s, f, f.alt ? `Image: ${f.alt}` : 'Image');
  }
  const rid = addMedia(s, img.bytes, img.ext);
  const placed = placeImage(f, img.width, img.height, f.fit);
  return picXml(s, f.name, f.alt, rid, placed.box, placed.crop);
}

function tableXml(f: TableFrame, s: SlideCtx): string {
  const id = nextId(s);
  const line = (tag: string, on: boolean): string => (on
    ? `<a:${tag} w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill>${clr(f.line)}</a:solidFill><a:prstDash val="solid"/></a:${tag}>`
    : `<a:${tag} w="0"><a:noFill/></a:${tag}>`);
  const rows = f.cells.map((row, ri) => `<a:tr h="${e(f.rows[ri]!)}">${row.map(cell => (
    `<a:tc>${txBody(cell.paras, 'm', false, 'a:txBody')}<a:tcPr marL="${e(f.pad.x)}" marR="${e(f.pad.x)}" marT="${e(f.pad.y)}" marB="${e(f.pad.y)}" anchor="ctr">`
    + `${line('lnL', false)}${line('lnR', false)}${line('lnT', false)}${line('lnB', true)}${fill(cell.fill)}</a:tcPr></a:tc>`
  )).join('')}</a:tr>`).join('');
  const h = f.rows.reduce((a, b) => a + b, 0);
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${x(f.name)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`
    + `<p:xfrm><a:off x="${e(f.x)}" y="${e(f.y)}"/><a:ext cx="${e(f.w)}" cy="${e(h)}"/></p:xfrm>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/>`
    + `<a:tblGrid>${f.cols.map(w => `<a:gridCol w="${e(w)}"/>`).join('')}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

// ── Charts ───────────────────────────────────────────────────────────

/** Can this chart be a native PowerPoint chart? */
export function nativeChart(c: DeckChart): boolean {
  return !c.echarts && c.categories.length > 0 && c.series.length > 0 && c.series.every(s => s.values.length === c.categories.length);
}

function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function chartBook(c: DeckChart): SheetBook {
  const cells: Record<string, unknown> = { A1: ' ' };
  c.series.forEach((s, j) => { cells[`${colName(j + 1)}1`] = s.name; });
  c.categories.forEach((cat, i) => {
    cells[`A${i + 2}`] = /^[=+\-@]/.test(cat) || /^\s*-?[\d.,]+%?\s*$/.test(cat) ? `'${cat}` : cat;
    c.series.forEach((s, j) => { cells[`${colName(j + 1)}${i + 2}`] = s.values[i] ?? 0; });
  });
  return applyOp(emptyBook('Sheet1'), { op: 'set', sheet: 'Sheet1', cells });
}

function numFormat(c: DeckChart): string {
  const ints = c.series.every(s => s.values.every(v => Number.isInteger(v)));
  const core = ints ? '#,##0' : '#,##0.0#';
  const u = c.unit ?? '';
  if (!u) return core;
  if (u === '%') return `${core}"%"`;
  if (/^[£$€¥₹]/.test(u)) return `"${u}"${core}`;
  return `${core}" ${u.replace(/"/g, '')}"`;
}

/** The value axis carries only % and currency units, as the app's chart does. */
function axisFormat(c: DeckChart): string {
  const u = c.unit ?? '';
  return u && u !== '%' && !/^[£$€¥₹]/.test(u) ? numFormat({ ...c, unit: '' }) : numFormat(c);
}

function chartTxPr(color: Color, size: number): string {
  return `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${Math.round(size * 100)}" b="0">${fill(color)}<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:pPr><a:endParaRPr lang="${LANG}"/></a:p></c:txPr>`;
}

const ACCENTS: SchemeSlot[] = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
function seriesColor(i: number): ColorRef {
  const s = ACCENTS[i % 6]!;
  return i < 6 ? { s } : { s, mod: 0.6 };
}

function strCache(ref: string, values: string[]): string {
  return `<c:strRef><c:f>${ref}</c:f><c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${x(v)}</c:v></c:pt>`).join('')}</c:strCache></c:strRef>`;
}

function numCache(ref: string, values: number[], fmt: string): string {
  return `<c:numRef><c:f>${ref}</c:f><c:numCache><c:formatCode>${x(fmt)}</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${Number.isFinite(v) ? v : 0}</c:v></c:pt>`).join('')}</c:numCache></c:numRef>`;
}

function dLbls(text: Color, fmt: string, opts: { pos?: string; pie?: boolean }): string {
  return `<c:dLbls><c:numFmt formatCode="${x(fmt)}" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${chartTxPr(text, 12)}`
    + `${opts.pos ? `<c:dLblPos val="${opts.pos}"/>` : ''}<c:showLegendKey val="0"/><c:showVal val="${opts.pie ? 0 : 1}"/><c:showCatName val="${opts.pie ? 1 : 0}"/>`
    + `<c:showSerName val="0"/><c:showPercent val="${opts.pie ? 1 : 0}"/><c:showBubbleSize val="0"/>${opts.pie ? '<c:separator>\n</c:separator><c:showLeaderLines val="1"/>' : ''}</c:dLbls>`;
}

export function chartXml(c: DeckChart, theme: DeckTheme): string {
  const r = roles(theme);
  const n = c.categories.length;
  const fmt = numFormat(c);
  const catRef = `Sheet1!$A$2:$A$${n + 1}`;
  const ser = (j: number, body: (color: ColorRef) => string): string => {
    const col = colName(j + 1);
    const color = seriesColor(j);
    return `<c:ser><c:idx val="${j}"/><c:order val="${j}"/><c:tx>${strCache(`Sheet1!$${col}$1`, [c.series[j]!.name])}</c:tx>${body(color)}`
      + `<c:cat>${strCache(catRef, c.categories)}</c:cat><c:val>${numCache(`Sheet1!$${col}$2:$${col}$${n + 1}`, c.series[j]!.values, fmt)}</c:val>`;
  };
  const multi = c.series.length > 1;
  const labels = !multi && n <= 10;
  let plot: string;
  if (c.type === 'pie' || c.type === 'doughnut') {
    const dpts = c.categories.map((_, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${fill(seriesColor(i))}<a:ln w="19050">${fill(r.bg)}</a:ln></c:spPr></c:dPt>`).join('');
    const s = ser(0, () => `${dpts}${dLbls(r.text, fmt, { pie: true, pos: c.type === 'pie' ? 'bestFit' : undefined })}`);
    plot = c.type === 'pie'
      ? `<c:pieChart><c:varyColors val="1"/>${s}</c:ser><c:firstSliceAng val="0"/></c:pieChart>`
      : `<c:doughnutChart><c:varyColors val="1"/>${s}</c:ser><c:firstSliceAng val="0"/><c:holeSize val="58"/></c:doughnutChart>`;
  } else {
    const ax = '<c:axId val="111111111"/><c:axId val="222222222"/>';
    if (c.type === 'line' || c.type === 'area') {
      const area = c.type === 'area';
      const series = c.series.map((_, j) => ser(j, color => (area
        ? `<c:spPr><a:solidFill>${clr(color, 0.35)}</a:solidFill><a:ln w="28575">${fill(color)}</a:ln></c:spPr>`
        : `<c:spPr><a:ln w="38100" cap="rnd">${fill(color)}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="7"/><c:spPr>${fill(color)}<a:ln w="9525">${fill(r.bg)}</a:ln></c:spPr></c:marker>`))
        + (area ? '</c:ser>' : '<c:smooth val="0"/></c:ser>')).join('');
      plot = area
        ? `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}${ax}</c:areaChart>`
        : `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${ax}</c:lineChart>`;
    } else {
      const stacked = c.type === 'stacked';
      const horizontal = c.type === 'bar';
      const series = c.series.map((_, j) => ser(j, color => `<c:spPr>${fill(color)}<a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>`
        + `${labels ? dLbls(r.text, fmt, stacked ? {} : { pos: 'outEnd' }) : ''}`) + '</c:ser>').join('');
      plot = `<c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="${stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${series}`
        + `<c:gapWidth val="${n > 8 ? 60 : 90}"/>${stacked ? '<c:overlap val="100"/>' : multi ? '<c:overlap val="-8"/>' : ''}${ax}</c:barChart>`;
    }
    const horizontal = c.type === 'bar';
    const lineSp = `<c:spPr><a:noFill/><a:ln w="9525">${fill(r.line)}</a:ln></c:spPr>`;
    plot += `<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="${horizontal ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/>`
      + `<c:axPos val="${horizontal ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/>`
      + `<c:tickLblPos val="nextTo"/>${lineSp}${chartTxPr(r.muted, 13)}<c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/>`
      + '<c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
      + `<c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'b' : 'l'}"/>`
      + `<c:majorGridlines><c:spPr><a:ln w="9525">${fill(r.line)}</a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${x(axisFormat(c))}" sourceLinked="0"/>`
      + `<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${chartTxPr(r.muted, 13)}`
      + `<c:crossAx val="111111111"/><c:crosses val="${horizontal ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`;
  }
  const legend = multi && c.type !== 'pie' && c.type !== 'doughnut'
    ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${chartTxPr(r.text, 13)}</c:legend>` : '';
  return `${XML}<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:date1904 val="0"/><c:lang val="${LANG}"/><c:roundedCorners val="0"/>`
    + `<c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>${plot}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>`
    + `<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${chartTxPr(r.text, 12)}<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;
}

function chartFrameXml(f: { x: number; y: number; w: number; h: number; name: string }, chart: DeckChart, s: SlideCtx): string {
  const n = ++s.counters.chart;
  s.charts.push({ name: `chart${n}.xml`, xml: chartXml(chart, s.theme), workbook: bookToXlsx(chartBook(chart)) });
  const rid = rel(s, 'chart', `../charts/chart${n}.xml`);
  const id = nextId(s);
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${x(f.name)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>`
    + `<p:xfrm><a:off x="${e(f.x)}" y="${e(f.y)}"/><a:ext cx="${e(f.w)}" cy="${e(f.h)}"/></p:xfrm>`
    + `<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;
}

function pictureFrame(f: { x: number; y: number; w: number; h: number; name: string }, key: string, label: string, s: SlideCtx, detail: string): string {
  const pic = s.input.pictures.get(key);
  if (!pic) {
    s.warnings.push(`${label} on "${f.name}" was not drawn (${detail}) — shown as a placeholder`);
    return placeholderSp(s, f, `${label} — open in AICO to draw it`);
  }
  const rid = addMedia(s, pic.png, '.png');
  const placed = placeImage(f, pic.width, pic.height, 'contain');
  return picXml(s, f.name, label, rid, placed.box);
}

function frameXml(f: Frame, s: SlideCtx): string {
  switch (f.kind) {
    case 'text': return textSp(f, s);
    case 'shape': return shapeSp(f, s);
    case 'image': return imageXml(f, s);
    case 'table': return tableXml(f, s);
    case 'chart':
      return nativeChart(f.chart)
        ? chartFrameXml(f, f.chart, s)
        : f.chart.echarts ? pictureFrame(f, chartKey(f.chart, s.theme, f.w, f.h), 'Chart', s, 'needs a browser to draw') : placeholderSp(s, f, 'Chart — no data');
    case 'diagram': return pictureFrame(f, diagramKey(f.source, s.theme), 'Diagram', s, 'needs a browser and the web build to draw Mermaid');
  }
}

const LAYOUT_FOR: Record<string, number> = {
  title: 1, closing: 1, bullets: 2, agenda: 4, section: 3,
};

function slideXml(layout: SlideLayout, s: SlideCtx): string {
  const body = layout.frames.map(f => frameXml(f, s)).join('');
  const fade = layout.slide.transition === 'fade' ? '<p:transition spd="med"><p:fade/></p:transition>' : '';
  return `${XML}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgPr>${fill(layout.background)}<a:effectLst/></p:bgPr></p:bg>`
    + `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`
    + `${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${fade}</p:sld>`;
}

function notesXml(text: string): string {
  const paras = text.split('\n').map(line => (line.trim()
    ? `<a:p><a:r><a:rPr lang="${LANG}" dirty="0"/><a:t>${x(line)}</a:t></a:r></a:p>` : `<a:p><a:endParaRPr lang="${LANG}" dirty="0"/></a:p>`)).join('');
  return `${XML}<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>'
    + `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

// ── Package parts ────────────────────────────────────────────────────

function themeXml(t: DeckTheme, name: string): string {
  const slot = (k: SchemeSlot): string => `<a:${k}><a:srgbClr val="${t.scheme[k].replace('#', '').toUpperCase()}"/></a:${k}>`;
  const font = (f: string): string => `<a:latin typeface="${x(f)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const ln = (w: number): string => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return `${XML}<a:theme xmlns:a="${NS_A}" name="${x(name)}"><a:themeElements>`
    + `<a:clrScheme name="${x(t.name)}">${slot('dk1')}${slot('lt1')}${slot('dk2')}${slot('lt2')}${(['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'] as SchemeSlot[]).map(slot).join('')}`
    + `<a:hlink><a:srgbClr val="${t.scheme.accent1.replace('#', '').toUpperCase()}"/></a:hlink><a:folHlink><a:srgbClr val="${t.scheme.accent2.replace('#', '').toUpperCase()}"/></a:folHlink></a:clrScheme>`
    + `<a:fontScheme name="${x(t.name)}"><a:majorFont>${font(t.fonts.heading)}</a:majorFont><a:minorFont>${font(t.fonts.body)}</a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="${x(t.name)}"><a:fillStyleLst>${solid}<a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill></a:fillStyleLst>`
    + `<a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst>`
    + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
    + `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function phSp(id: number, name: string, ph: string, box: { x: number; y: number; w: number; h: number }, prompt: string, anchor = 't'): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${x(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>`
    + `<p:spPr>${xfrm(box)}</p:spPr><p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>`
    + `<a:p><a:r><a:rPr lang="${LANG}"/><a:t>${x(prompt)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function masterXml(t: DeckTheme, W: number, H: number): string {
  const r = roles(t);
  const MX = W === 960 ? 56 : 44;
  const lvl = (n: number, sz: number, mar: number): string => `<a:lvl${n}pPr marL="${e(mar)}" indent="${-e(Math.min(mar, 24))}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">`
    + `<a:lnSpc><a:spcPct val="110000"/></a:lnSpc><a:spcBef><a:spcPts val="${n === 1 ? 1000 : 500}"/></a:spcBef><a:buClr>${clr(r.accent)}</a:buClr><a:buFont typeface="Arial"/><a:buChar char="${n % 2 ? '•' : '–'}"/>`
    + `<a:defRPr sz="${sz * 100}" kern="1200">${fill(r.text)}<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
  return `${XML}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgPr>${fill(r.bg)}<a:effectLst/></p:bgPr></p:bg><p:spTree>${GRP}`
    + phSp(2, 'Title Placeholder 1', '<p:ph type="title"/>', { x: MX, y: 34, w: W - 2 * MX, h: 80 }, 'Click to edit Master title style', 'b')
    + phSp(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', { x: MX, y: 134, w: W - 2 * MX, h: H - 190 }, 'Click to edit Master text styles')
    + `</p:spTree></p:cSld>${CLR_MAP}<p:sldLayoutIdLst>${[1, 2, 3, 4, 5].map(i => `<p:sldLayoutId id="${2147483648 + i}" r:id="rId${i}"/>`).join('')}</p:sldLayoutIdLst>`
    + `<p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="95000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/>`
    + `<a:defRPr sz="3000" b="${t.headingBold ? 1 : 0}" kern="1200">${fill(r.title)}<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>`
    + `<p:bodyStyle>${lvl(1, 22, 22)}${lvl(2, 19, 48)}${lvl(3, 17, 72)}${lvl(4, 16, 96)}${lvl(5, 16, 120)}</p:bodyStyle>`
    + `<p:otherStyle><a:defPPr><a:defRPr lang="${LANG}"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200">${fill(r.text)}<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle>`
    + '</p:txStyles></p:sldMaster>';
}

function layoutXml(i: number, W: number, H: number): string {
  const MX = W === 960 ? 56 : 44;
  const CW = W - 2 * MX;
  const defs: Record<number, { type: string; name: string; sps: string }> = {
    1: {
      type: 'title', name: 'Title Slide',
      sps: phSp(2, 'Title 1', '<p:ph type="ctrTitle"/>', { x: MX, y: 110, w: W * 0.78, h: 210 }, 'Click to edit title', 'b')
        + phSp(3, 'Subtitle 2', '<p:ph type="subTitle" idx="1"/>', { x: MX, y: 358, w: W * 0.72, h: 76 }, 'Click to edit subtitle'),
    },
    2: {
      type: 'obj', name: 'Title and Content',
      sps: phSp(2, 'Title 1', '<p:ph type="title"/>', { x: MX, y: 34, w: CW, h: 80 }, 'Click to edit title', 'b')
        + phSp(3, 'Content Placeholder 2', '<p:ph idx="1"/>', { x: MX, y: 134, w: CW, h: H - 190 }, 'Click to add text'),
    },
    3: {
      type: 'secHead', name: 'Section Header',
      sps: phSp(2, 'Title 1', '<p:ph type="title"/>', { x: MX, y: H * 0.4, w: CW, h: 130 }, 'Click to edit title')
        + phSp(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', { x: MX, y: H * 0.4 + 140, w: CW * 0.8, h: 70 }, 'Click to add text'),
    },
    4: { type: 'titleOnly', name: 'Title Only', sps: phSp(2, 'Title 1', '<p:ph type="title"/>', { x: MX, y: 34, w: CW, h: 80 }, 'Click to edit title', 'b') },
    5: { type: 'blank', name: 'Blank', sps: '' },
  };
  const d = defs[i]!;
  return `${XML}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="${d.type}" preserve="1"><p:cSld name="${x(d.name)}"><p:spTree>${GRP}${d.sps}</p:spTree></p:cSld>`
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
}

function notesMasterXml(): string {
  return `${XML}<p:notesMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}`
    + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>`
    + '<p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>'
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="${LANG}"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>`
    + `</p:spTree></p:cSld>${CLR_MAP}<p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;
}

function rels(list: string[]): string {
  return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.join('')}</Relationships>`;
}

const CT = {
  pres: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  master: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  layout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  notesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  notes: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  presProps: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  viewProps: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  tableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
};

export const PPTX_MEDIA = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Write the presentation. */
export function toPptx(input: PptxInput): PptxResult {
  const { deck, layouts } = input;
  const theme = deckTheme(deck.theme);
  const W = layouts[0]?.w ?? (deck.aspect === '4:3' ? 720 : 960);
  const H = 540;
  const files: Record<string, Uint8Array> = {};
  const put = (name: string, text: string): void => { files[name] = strToU8(text); };
  const overrides: string[] = [];
  const over = (part: string, type: string): void => { overrides.push(`<Override PartName="/${part}" ContentType="${type}"/>`); };
  const warnings: string[] = [];
  const counters = { media: 0, chart: 0 };
  const exts = new Set<string>();

  const presRels: string[] = [`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`];
  presRels.push(`<Relationship Id="rId2" Type="${REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/>`);
  presRels.push(`<Relationship Id="rId3" Type="${REL}/theme" Target="theme/theme1.xml"/>`);
  presRels.push(`<Relationship Id="rId4" Type="${REL}/presProps" Target="presProps.xml"/>`);
  presRels.push(`<Relationship Id="rId5" Type="${REL}/viewProps" Target="viewProps.xml"/>`);
  presRels.push(`<Relationship Id="rId6" Type="${REL}/tableStyles" Target="tableStyles.xml"/>`);

  let notesCount = 0;
  const sldIds: string[] = [];
  layouts.forEach((layout, i) => {
    const n = i + 1;
    const s: SlideCtx = { id: 1, rels: [], media: [], charts: [], warnings, theme, input, counters };
    const layoutNo = LAYOUT_FOR[layout.slide.layout] ?? (layout.frames.some(f => f.kind === 'text' && f.ph === 'title') ? 4 : 5);
    rel(s, 'slideLayout', `../slideLayouts/slideLayout${layoutNo}.xml`);
    const xml = slideXml(layout, s);
    const notes = layout.slide.notes?.trim();
    if (notes) {
      notesCount++;
      rel(s, 'notesSlide', `../notesSlides/notesSlide${n}.xml`);
      put(`ppt/notesSlides/notesSlide${n}.xml`, notesXml(notes));
      put(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, rels([
        `<Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/>`,
        `<Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${n}.xml"/>`,
      ]));
      over(`ppt/notesSlides/notesSlide${n}.xml`, CT.notes);
    }
    put(`ppt/slides/slide${n}.xml`, xml);
    put(`ppt/slides/_rels/slide${n}.xml.rels`, rels(s.rels));
    over(`ppt/slides/slide${n}.xml`, CT.slide);
    for (const m of s.media) { files[`ppt/media/${m.name}`] = new Uint8Array(m.bytes); exts.add(m.ext.slice(1)); }
    for (const c of s.charts) {
      put(`ppt/charts/${c.name}`, c.xml);
      const wb = `Microsoft_Excel_Worksheet${c.name.replace(/\D/g, '')}.xlsx`;
      files[`ppt/embeddings/${wb}`] = c.workbook;
      put(`ppt/charts/_rels/${c.name}.rels`, rels([`<Relationship Id="rId1" Type="${REL}/package" Target="../embeddings/${wb}"/>`]));
      over(`ppt/charts/${c.name}`, CT.chart);
      exts.add('xlsx');
    }
    const rid = `rId${presRels.length + 1}`;
    presRels.push(`<Relationship Id="${rid}" Type="${REL}/slide" Target="slides/slide${n}.xml"/>`);
    sldIds.push(`<p:sldId id="${255 + n}" r:id="${rid}"/>`);
  });

  put('ppt/theme/theme1.xml', themeXml(theme, `AICO ${theme.name}`));
  put('ppt/theme/theme2.xml', themeXml(theme, 'AICO Notes'));
  over('ppt/theme/theme1.xml', CT.theme);
  over('ppt/theme/theme2.xml', CT.theme);
  put('ppt/slideMasters/slideMaster1.xml', masterXml(theme, W, H));
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([
    ...[1, 2, 3, 4, 5].map(i => `<Relationship Id="rId${i}" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout${i}.xml"/>`),
    `<Relationship Id="rId6" Type="${REL}/theme" Target="../theme/theme1.xml"/>`,
  ]));
  over('ppt/slideMasters/slideMaster1.xml', CT.master);
  for (const i of [1, 2, 3, 4, 5]) {
    put(`ppt/slideLayouts/slideLayout${i}.xml`, layoutXml(i, W, H));
    put(`ppt/slideLayouts/_rels/slideLayout${i}.xml.rels`, rels([`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`]));
    over(`ppt/slideLayouts/slideLayout${i}.xml`, CT.layout);
  }
  put('ppt/notesMasters/notesMaster1.xml', notesMasterXml());
  put('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([`<Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/>`]));
  over('ppt/notesMasters/notesMaster1.xml', CT.notesMaster);

  const sz = deck.aspect === '4:3' ? `<p:sldSz cx="${e(720)}" cy="${e(540)}" type="screen4x3"/>` : `<p:sldSz cx="${e(960)}" cy="${e(540)}"/>`;
  put('ppt/presentation.xml', `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>'
    + `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>${sz}<p:notesSz cx="6858000" cy="9144000"/>`
    + `<p:defaultTextStyle><a:defPPr><a:defRPr lang="${LANG}"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle>`
    + '</p:presentation>');
  put('ppt/_rels/presentation.xml.rels', rels(presRels));
  over('ppt/presentation.xml', CT.pres);
  put('ppt/presProps.xml', `${XML}<p:presentationPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"/>`);
  put('ppt/viewProps.xml', `${XML}<p:viewPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  put('ppt/tableStyles.xml', `${XML}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  over('ppt/presProps.xml', CT.presProps);
  over('ppt/viewProps.xml', CT.viewProps);
  over('ppt/tableStyles.xml', CT.tableStyles);

  const when = (input.date ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  put('docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${x(input.title)}</dc:title><dc:creator>${x(input.author ?? 'AICO')}</dc:creator><cp:lastModifiedBy>AICO</cp:lastModifiedBy>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified></cp:coreProperties>`);
  put('docProps/app.xml', `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">`
    + `<Application>AICO</Application><PresentationFormat>${deck.aspect === '4:3' ? 'On-screen Show (4:3)' : 'Widescreen'}</PresentationFormat><Slides>${layouts.length}</Slides><Notes>${notesCount}</Notes></Properties>`);
  over('docProps/core.xml', CT.core);
  over('docProps/app.xml', CT.app);
  put('_rels/.rels', rels([
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>`,
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>`,
  ]));
  const MEDIA: Record<string, string> = {
    png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  put('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + [...exts].map(ext => `<Default Extension="${ext}" ContentType="${MEDIA[ext]}"/>`).join('')
    + `${overrides.join('')}</Types>`);
  return { bytes: zipSync(files, { level: 6 }), warnings };
}

// ── Picture sizes (for cropping) ─────────────────────────────────────

/** Width and height of a PNG, JPEG or GIF, or undefined for anything else. */
export function imageSize(bytes: Buffer): { width: number; height: number; ext: '.png' | '.jpeg' | '.gif' } | undefined {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), ext: '.png' };
  if (bytes.length > 10 && bytes.toString('ascii', 0, 3) === 'GIF') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), ext: '.gif' };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7), ext: '.jpeg' };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return undefined;
}
