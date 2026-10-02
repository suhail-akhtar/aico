/**
 * Markdown → .docx, written as WordprocessingML and zipped with `fflate`.
 *
 * ## Why not the `docx` package
 *
 * It is the obvious choice and was the first one considered (ADR 0008). It
 * would add a runtime dependency several times the size of this module for a
 * one-way conversion that needs a bounded set of element types. `fflate` is
 * already a dependency, and the OOXML for those elements is stable and
 * documented (ECMA-376).
 *
 * ## What it covers
 *
 * - Text: Word's own Heading 1–6 styles (so the navigation pane and the TOC
 *   field work), paragraphs, bold/italic/strikethrough/inline code, links,
 *   nested bulleted/numbered lists (each numbered list restarts), task lists,
 *   tables with a shaded repeating header row and column alignment, code
 *   blocks, quotes, rules.
 * - Pictures: images from data URLs or project files with the canvas's
 *   `{width=… align=…}` and caption; charts, Mermaid diagrams and maths as the
 *   2× PNGs `canvas/visuals` drew (inline maths inline), or a labelled
 *   placeholder with the source when they could not be drawn.
 * - Infographics (`canvas/infographics`) as styled tables and shaded cells.
 * - Document setup (`canvas/doc-settings`): page size, orientation, margins,
 *   font, header/footer with PAGE/NUMPAGES fields, a cover page (its own first
 *   page with no header text), a diagonal watermark, and a real, updatable
 *   `TOC \o "1-4"` field over bookmarked headings. `settings.xml` asks Word to
 *   refresh fields on open, which is what fills in the TOC page numbers — the
 *   pre-filled entries carry the headings but no numbers, since only a layout
 *   engine knows them.
 *
 * - Themes (round 3, `shared/ui/canvas/doc-themes`): body and heading faces,
 *   accent, heading style (classic / rule / bar / caps, numbered 1 · 1.1),
 *   table style (grid / lined / banded / minimal), cover variant (classic /
 *   band / minimal), a letterhead on the first page for letters, and a
 *   classification banner in every header and footer.
 * - Document blocks (`shared/ui/canvas/doc-blocks`): signature lines,
 *   key-value boxes, line items with computed subtotal/tax/total, the risk
 *   matrix and register, action items, two/three columns, cover band, meta
 *   line and references — the same parsed values the app and HTML show.
 * - KPI tiles wrap to more rows rather than squeeze: each row holds as many
 *   tiles as fit the longest word of a value at its size.
 *
 * Element order inside `pPr`/`rPr`/`sectPr` follows the schema's sequence:
 * Word opens out-of-order files, but stricter readers do not always.
 *
 * @module canvas/docx
 */

import { zipSync, strToU8 } from 'fflate';
import type {
  BlockContent, Code, DefinitionContent, Heading, List, ListItem, Paragraph, PhrasingContent, Root, RootContent, Table,
} from 'mdast';
import { imageDimensions } from '../server/image-dimensions.js';
import { parseMarkdown, type ImageResolver } from './markdown.js';
import { DEFAULT_SETTINGS, PAGE_MM, expandFields, type DocSettings } from './doc-settings.js';
import type { HeadingInfo } from './doc-model.js';
import { isTocMarker } from './doc-model.js';
import { CALLOUT_COLORS, infographicKind, parseImageAttrs, parseInfographic, type ImageAttrs, type Infographic } from './infographics.js';
import { visualForCode, visualKey, type RenderedVisual } from './visuals.js';
import {
  ICON_GLYPHS, RATING_COLORS, computeTotals, docBlockKind, formatMoney, formatQty, parseDocBlock, plainInline, riskRating,
  statValueSize, type DocBlock, type DocBlockKind,
} from '../../shared/ui/canvas/doc-blocks.js';
import { DOCX_FONTS, resolveLook, tint, type ResolvedLook } from '../../shared/ui/canvas/doc-themes.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU_PER_PX = 9525;
const EMU_PER_TWIP = 635;
const twips = (mm: number): number => Math.round(mm * 1440 / 25.4);

export function xmlEscape(value: string): string {
  return value
    // Characters XML 1.0 forbids outright; a stray one makes Word refuse the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
  color?: string;
  size?: number;
}

interface Media { rid: string; name: string; bytes: Uint8Array; width: number; height: number }

class Builder {
  body: string[] = [];
  rels: { id: string; type: string; target: string; external?: boolean }[] = [];
  media: Media[] = [];
  /** `w:num` instances: numId → abstractNumId + start. */
  nums: { numId: number; abstract: number; start?: number }[] = [{ numId: 1, abstract: 0 }];
  private nextRel = 10;
  private nextPic = 1;
  private nextBookmark = 1;
  private images = new Map<string, Media | null>();
  readonly headingIds = new Map<Heading, HeadingInfo>();
  /** The TOC field, placed where the text has `<!-- aico:toc -->`. */
  tocXml?: string;
  /** Text width in twips. */
  readonly textWidth: number;
  /** Text height in twips (a picture taller than this is scaled down to fit a page). */
  readonly textHeight: number;
  /** The document's theme, accent and faces. */
  readonly look: ResolvedLook;
  /** Accent without `#`; the plain look keeps the historical blue. */
  readonly accent: string;
  /** A light tint of the accent for fills. */
  readonly tintFill: string;
  /** H2/H3 counters for numbered themes. */
  readonly counters = { h2: 0, h3: 0 };

  constructor(private readonly resolveImage: ImageResolver, readonly settings: DocSettings,
    readonly visuals: Map<string, RenderedVisual>, headings: HeadingInfo[]) {
    for (const h of headings) this.headingIds.set(h.node, h);
    this.look = resolveLook(settings);
    this.accent = this.look.accent.slice(1).toUpperCase();
    this.tintFill = this.look.theme ? tint(this.look.accent, 0.08) : 'F4F4F5';
    const page = pageTwips(settings);
    this.textWidth = page.w - twips(settings.margins.left) - twips(settings.margins.right);
    this.textHeight = page.h - twips(settings.margins.top) - twips(settings.margins.bottom) - 720;
  }

  rel(type: string, target: string, external = false): string {
    const id = `rId${this.nextRel++}`;
    this.rels.push({ id, type, target, ...(external ? { external } : {}) });
    return id;
  }

  bookmarkId(): number { return this.nextBookmark++; }

  newNum(ordered: boolean, start = 1): number {
    if (!ordered) return 1;
    const numId = this.nums.length + 1;
    this.nums.push({ numId, abstract: 1, start });
    return numId;
  }

  addMedia(bytes: Uint8Array, ext: string): Media {
    const name = `image${this.media.length + 1}${ext}`;
    const rid = this.rel(`${R_NS}/image`, `media/${name}`);
    const dims = imageDimensions(ext, Buffer.from(bytes)) ?? { width: 480, height: 320 };
    const media: Media = { rid, name, bytes, width: dims.width, height: dims.height };
    this.media.push(media);
    return media;
  }

  /** Pre-load every image (and the cover logo) so rendering stays synchronous. */
  async loadImages(tree: Root, extra: string[] = []): Promise<void> {
    const srcs: string[] = [...extra];
    const walk = (node: { type: string; url?: string; children?: unknown[] }): void => {
      if (node.type === 'image' && node.url) srcs.push(node.url);
      for (const child of (node.children ?? []) as never[]) walk(child);
    };
    walk(tree as never);
    for (const src of srcs) {
      if (this.images.has(src)) continue;
      const data = await this.resolveImage(src).catch(() => undefined);
      if (!data || !['.png', '.jpeg', '.gif'].includes(data.ext)) { this.images.set(src, null); continue; }
      this.images.set(src, this.addMedia(new Uint8Array(data.bytes), data.ext));
    }
  }

  image(src: string): Media | undefined { return this.images.get(src) ?? undefined; }

  /** An inline picture of `media` at `cx`×`cy` EMU. */
  drawing(media: Media, cx: number, cy: number, alt: string): string {
    const id = this.nextPic++;
    const a = xmlEscape(alt || media.name);
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
      + `<wp:docPr id="${id}" name="Picture ${id}" descr="${a}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
      + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${media.name}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${media.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  }

  /** Size a picture: natural pixels, an optional requested width, capped to the text width. */
  fit(pxWidth: number, pxHeight: number, want?: string, maxTwips = this.textWidth): { cx: number; cy: number } {
    const max = maxTwips * EMU_PER_TWIP;
    let cx = pxWidth * EMU_PER_PX;
    if (want?.endsWith('%')) cx = max * Math.min(100, Number.parseFloat(want)) / 100;
    else if (want?.endsWith('px')) cx = Number.parseFloat(want) * EMU_PER_PX;
    cx = Math.min(cx, max);
    let cy = cx * (pxHeight / Math.max(1, pxWidth));
    const maxH = this.textHeight * EMU_PER_TWIP;
    if (cy > maxH) { cx *= maxH / cy; cy = maxH; }
    return { cx: Math.round(cx), cy: Math.round(cy) };
  }

  /** Run `fn` with the body swapped out; return what it wrote. */
  capture(fn: () => void): string {
    const saved = this.body;
    this.body = [];
    try { fn(); return this.body.join(''); } finally { this.body = saved; }
  }
}

function pageTwips(settings: DocSettings): { w: number; h: number } {
  const mm = PAGE_MM[settings.pageSize] ?? PAGE_MM.A4;
  const w = twips(mm.w);
  const h = twips(mm.h);
  return settings.orientation === 'landscape' ? { w: h, h: w } : { w, h };
}

function run(text: string, style: RunStyle): string {
  if (!text) return '';
  const props: string[] = [];
  if (style.code) props.push('<w:rStyle w:val="CodeChar"/>');
  else if (style.link) props.push('<w:rStyle w:val="Hyperlink"/>');
  if (style.bold) props.push('<w:b/><w:bCs/>');
  if (style.italic) props.push('<w:i/><w:iCs/>');
  if (style.strike) props.push('<w:strike/>');
  if (style.color) props.push(`<w:color w:val="${style.color}"/>`);
  if (style.size) props.push(`<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function field(instr: string, placeholder = '1', style: RunStyle = {}): string {
  // The result takes the formatting of the field's first run, so every run carries it.
  const rPr = /<w:rPr>.*<\/w:rPr>/.exec(run('x', style))?.[0] ?? '';
  return `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r>`
    + `<w:r>${rPr}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>`
    + `<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r>${run(placeholder, style)}<w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`;
}

function placeholderRuns(label: string): string {
  return run(label, { italic: true, color: '71717A' });
}

function inline(b: Builder, nodes: PhrasingContent[], style: RunStyle = {}): string {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    switch (n.type) {
      case 'text': {
        // An attribute block left over from a preceding image is not text.
        const v = i > 0 && nodes[i - 1]!.type === 'image' ? (parseImageAttrs(n.value)?.rest ?? n.value) : n.value;
        out += run(v.replace(/\r?\n/g, ' '), style);
        break;
      }
      case 'strong': out += inline(b, n.children, { ...style, bold: true }); break;
      case 'emphasis': out += inline(b, n.children, { ...style, italic: true }); break;
      case 'delete': out += inline(b, n.children, { ...style, strike: true }); break;
      case 'inlineCode': out += run(n.value, { ...style, code: true }); break;
      case 'break': out += '<w:r><w:br/></w:r>'; break;
      case 'link': {
        const url = n.url ?? '';
        if (/^(https?:|mailto:)/i.test(url)) {
          const rid = b.rel(`${R_NS}/hyperlink`, url, true);
          out += `<w:hyperlink r:id="${rid}" w:history="1">${inline(b, n.children, { ...style, link: true })}</w:hyperlink>`;
        } else {
          out += inline(b, n.children, style);
        }
        break;
      }
      case 'image': {
        const media = b.image(n.url);
        const next = nodes[i + 1];
        const attrs = next?.type === 'text' ? parseImageAttrs(next.value)?.attrs : undefined;
        if (media) {
          const { cx, cy } = b.fit(media.width, media.height, attrs?.width);
          out += b.drawing(media, cx, cy, n.alt ?? '');
        } else {
          out += run(`[${n.alt || 'image'}]`, { ...style, italic: true });
        }
        break;
      }
      case 'inlineMath': {
        const v = b.visuals.get(visualKey('math-inline', n.value));
        if (v?.png && !v.error) {
          const media = b.addMedia(new Uint8Array(v.png), '.png');
          // Drawn at 16px; body text is 11pt (~14.7px), so scale to sit on the line.
          out += b.drawing(media, Math.round(v.width * EMU_PER_PX * 0.85), Math.round(v.height * EMU_PER_PX * 0.85), n.value);
        } else {
          out += run(n.value, { ...style, italic: true });
        }
        break;
      }
      case 'html': break; // raw HTML (and pending markers) has no place in a Word file
      case 'footnoteReference': out += run(`[${n.identifier}]`, style); break;
      default:
        if ('children' in n) out += inline(b, (n as { children: PhrasingContent[] }).children, style);
        else if ('value' in n) out += run(String((n as { value: unknown }).value), style);
    }
  }
  return out;
}

function para(content: string, pPr = ''): string {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
}

interface Ctx {
  /** List nesting depth (0 = not in a list). */
  depth: number;
  quote: boolean;
  /** The numId of the enclosing list item's paragraph, if any. */
  numId?: number;
  /** Paragraphs in a list item after the first align with its text. */
  indentOnly?: boolean;
  tight?: boolean;
}

function blockPPr(ctx: Ctx, extra = ''): string {
  const parts: string[] = [];
  if (ctx.quote) parts.push('<w:pStyle w:val="Quote"/>');
  else if (ctx.depth > 0) parts.push('<w:pStyle w:val="ListParagraph"/>');
  if (ctx.numId !== undefined && !ctx.indentOnly) {
    parts.push(`<w:numPr><w:ilvl w:val="${ctx.depth - 1}"/><w:numId w:val="${ctx.numId}"/></w:numPr>`);
  }
  if (ctx.tight && ctx.depth > 0) parts.push('<w:spacing w:after="40"/>');
  if (ctx.depth > 0 && (ctx.numId === undefined || ctx.indentOnly)) {
    parts.push(`<w:ind w:left="${720 * ctx.depth}"/>`);
  }
  return parts.join('') + extra;
}

function blocks(b: Builder, nodes: (RootContent | BlockContent | DefinitionContent)[], ctx: Ctx): void {
  for (const n of nodes) block(b, n as RootContent, ctx);
}

const JC: Record<string, string> = { left: 'left', center: 'center', right: 'right' };

/** A paragraph holding only an image (+ attributes): a figure with alignment and caption. */
function figure(b: Builder, n: Paragraph, ctx: Ctx): boolean {
  const kids = n.children.filter(c => !(c.type === 'text' && !c.value.trim()));
  const img = kids[0];
  if (!img || img.type !== 'image') return false;
  let attrs: ImageAttrs = {};
  if (kids.length === 2 && kids[1]!.type === 'text') {
    const parsed = parseImageAttrs(kids[1]!.value.trim());
    if (!parsed || parsed.rest.trim()) return false;
    attrs = parsed.attrs;
  } else if (kids.length !== 1) return false;
  const media = b.image(img.url);
  const jc = `<w:jc w:val="${JC[attrs.align ?? 'center']}"/>`;
  if (media) {
    const { cx, cy } = b.fit(media.width, media.height, attrs.width);
    b.body.push(para(b.drawing(media, cx, cy, img.alt ?? ''), `${blockPPr(ctx)}${jc}`));
  } else {
    b.body.push(para(placeholderRuns(`[${img.alt || "image"}]`), jc));
  }
  if (img.title) b.body.push(para(run(img.title, {}), `<w:pStyle w:val="Caption"/>${jc}`));
  return true;
}

function visualBlock(b: Builder, kind: 'chart' | 'diagram' | 'math', source: string, ctx: Ctx): void {
  const v = b.visuals.get(visualKey(kind, source));
  if (v?.png && !v.error) {
    const media = b.addMedia(new Uint8Array(v.png), '.png');
    // The PNG is 2×: its CSS size is the size it was drawn at.
    const { cx, cy } = b.fit(v.width, v.height, undefined, b.textWidth - 720 * ctx.depth);
    b.body.push(para(b.drawing(media, cx, cy, `${kind}`), '<w:jc w:val="center"/>'));
    return;
  }
  const label = kind === 'chart' ? 'Chart' : kind === 'diagram' ? 'Diagram' : 'Formula';
  b.body.push(para(placeholderRuns(`[${label} not rendered${v?.error ? ` — ${v.error}` : ''}. Source:]`), '<w:keepNext/>'));
  codeBlock(b, source, ctx);
}

function codeBlock(b: Builder, value: string, ctx: Ctx): void {
  const lines = value.replace(/\t/g, '    ').split('\n');
  const content = lines.map((line, i) => (i ? '<w:r><w:br/></w:r>' : '') + run(line, {})).join('');
  const ind = ctx.depth > 0 ? `<w:ind w:left="${720 * ctx.depth}"/>` : '';
  b.body.push(para(content || run(' ', {}), `<w:pStyle w:val="CodeBlock"/>${ind}`));
}

function block(b: Builder, n: RootContent, ctx: Ctx): void {
  switch (n.type) {
    case 'heading': {
      const info = b.headingIds.get(n);
      let content = inline(b, n.children);
      if (b.look.theme?.numbered && (n.depth === 2 || n.depth === 3)) {
        if (n.depth === 2) { b.counters.h2++; b.counters.h3 = 0; } else b.counters.h3++;
        const label = n.depth === 2 ? `${b.counters.h2}.` : `${b.counters.h2}.${b.counters.h3}`;
        content = run(`${label}\u00a0\u00a0`, { color: b.accent }) + content;
      }
      if (info) {
        const id = b.bookmarkId();
        b.body.push(para(`<w:bookmarkStart w:id="${id}" w:name="${bookmarkName(info.id)}"/>${content}<w:bookmarkEnd w:id="${id}"/>`,
          `<w:pStyle w:val="Heading${n.depth}"/>`));
      } else {
        b.body.push(para(content, `<w:pStyle w:val="Heading${n.depth}"/>`));
      }
      return;
    }
    case 'paragraph': {
      if (figure(b, n, ctx)) return;
      b.body.push(para(inline(b, n.children), blockPPr(ctx)));
      return;
    }
    case 'thematicBreak':
      b.body.push(para('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D4D4D8"/></w:pBdr>'));
      return;
    case 'blockquote':
      blocks(b, n.children, { ...ctx, quote: true, numId: undefined });
      return;
    case 'math':
      visualBlock(b, 'math', n.value, ctx);
      return;
    case 'code': {
      const visual = visualForCode(n.lang, n.value);
      if (visual && visual.kind !== 'math-inline') { visualBlock(b, visual.kind, visual.source, ctx); return; }
      const ig = infographicKind(n.lang);
      if (ig) { infographic(b, n, ig, ctx); return; }
      const db = docBlockKind(n.lang);
      if (db) { docBlock(b, n, db, ctx); return; }
      codeBlock(b, n.value, ctx);
      return;
    }
    case 'list':
      list(b, n, ctx);
      return;
    case 'table':
      table(b, n, ctx);
      return;
    case 'html':
      if (isTocMarker(n) && b.tocXml) b.body.push(b.tocXml);
      return;
    case 'definition':
    case 'yaml':
      return;
    case 'footnoteDefinition':
      blocks(b, n.children, ctx);
      return;
    default:
      if ('children' in n) blocks(b, (n as { children: RootContent[] }).children, ctx);
  }
}

function list(b: Builder, n: List, ctx: Ctx): void {
  const depth = ctx.depth + 1;
  const numId = b.newNum(Boolean(n.ordered), n.start ?? 1);
  for (const item of n.children) listItem(b, item, n, { ...ctx, depth, numId, indentOnly: false, tight: n.spread === false });
}

function listItem(b: Builder, item: ListItem, parent: List, ctx: Ctx): void {
  const isTask = typeof item.checked === 'boolean';
  let first = true;
  for (const child of item.children) {
    if (child.type === 'paragraph' && first) {
      first = false;
      if (isTask) {
        const box = run(item.checked ? '☒ ' : '☐ ', {});
        b.body.push(para(box + inline(b, child.children), blockPPr({ ...ctx, numId: undefined })));
      } else {
        b.body.push(para(inline(b, child.children), blockPPr(ctx)));
      }
      continue;
    }
    if (first && child.type !== 'list') {
      // An item that opens with a code block or table still gets its bullet.
      b.body.push(para('', blockPPr(isTask ? { ...ctx, numId: undefined } : ctx)));
    }
    first = false;
    if (child.type === 'list') {
      // A nested bulleted list continues the bullet scheme at a deeper level.
      const sameKind = Boolean(child.ordered) === Boolean(parent.ordered) && !parent.ordered;
      if (sameKind) {
        for (const sub of child.children) listItem(b, sub, child, { ...ctx, depth: ctx.depth + 1, tight: child.spread === false });
      } else {
        list(b, child, { ...ctx, numId: undefined });
      }
    } else {
      block(b, child as RootContent, { ...ctx, indentOnly: true });
    }
  }
  if (first) b.body.push(para('', blockPPr(ctx)));
}

const BORDER = (color = 'E4E4E7', sz = 4): string =>
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="${sz}" w:space="0" w:color="${color}"/>`).join('');
const NO_BORDER = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="nil"/>`).join('');

function tableXml(b: Builder, rows: string[][], opts: {
  widths: number[]; header?: boolean; borders?: string; shade?: (r: number, c: number) => string | undefined;
  cellBorders?: (r: number, c: number) => string | undefined; indent?: number;
}): string {
  const total = opts.widths.reduce((a, w) => a + w, 0);
  const trs = rows.map((cells, ri) => {
    const tcs = cells.map((content, ci) => {
      const fill = opts.shade?.(ri, ci);
      const borders = opts.cellBorders?.(ri, ci);
      return `<w:tc><w:tcPr><w:tcW w:w="${opts.widths[ci]}" w:type="dxa"/>${borders ? `<w:tcBorders>${borders}</w:tcBorders>` : ''}`
        + `${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}</w:tcPr>${content || para('')}</w:tc>`;
    }).join('');
    return `<w:tr>${ri === 0 && opts.header ? '<w:trPr><w:tblHeader/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}${tcs}</w:tr>`;
  }).join('');
  const ind = opts.indent ? `<w:tblInd w:w="${opts.indent}" w:type="dxa"/>` : '';
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${total}" w:type="dxa"/>${ind}`
    + `<w:tblBorders>${opts.borders ?? BORDER()}</w:tblBorders><w:tblLayout w:type="fixed"/>`
    + '<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>'
    + '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
    + `<w:tblGrid>${opts.widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${trs}</w:tbl>`
    // Two tables back to back merge into one in Word; a paragraph keeps them apart.
    + para('', '<w:spacing w:after="120"/>');
}

/** Borders, header fill and banding for a theme's table style (the plain look: light grid, grey header). */
function tableLook(b: Builder): {
  borders: string; header: RunStyle; shade: (r: number) => string | undefined; cell?: (r: number, last: boolean) => string | undefined;
} {
  const style = b.look.theme?.table;
  const line = (side: string, sz: number, color: string): string => `<w:${side} w:val="single" w:sz="${sz}" w:space="0" w:color="${color}"/>`;
  const nil = (...sides: string[]): string => sides.map(x => `<w:${x} w:val="nil"/>`).join('');
  switch (style) {
    case 'banded': return {
      borders: nil('top', 'left', 'right', 'insideV') + line('bottom', 4, 'E4E4E7') + line('insideH', 4, 'E4E4E7'),
      header: { bold: true, color: 'FFFFFF' }, shade: r => (r === 0 ? b.accent : r % 2 === 0 ? b.tintFill : undefined),
    };
    case 'lined': return {
      borders: line('top', 12, '1A1A1A') + line('bottom', 12, '1A1A1A') + nil('left', 'right', 'insideV') + line('insideH', 4, 'E4E4E7'),
      header: { bold: true }, shade: () => undefined, cell: r => (r === 0 ? line('bottom', 6, '1A1A1A') : undefined),
    };
    case 'minimal': return {
      borders: nil('top', 'left', 'right', 'insideV') + line('bottom', 4, 'E4E4E7') + line('insideH', 4, 'E4E4E7'),
      header: { bold: true }, shade: () => undefined, cell: r => (r === 0 ? line('bottom', 12, b.accent) : undefined),
    };
    case 'grid': return { borders: BORDER(), header: { bold: true }, shade: r => (r === 0 ? b.tintFill : undefined) };
    default: return { borders: BORDER(), header: { bold: true }, shade: r => (r === 0 ? 'F4F4F5' : undefined) };
  }
}

function table(b: Builder, n: Table, ctx: Ctx): void {
  const cols = Math.max(1, ...n.children.map(r => r.children.length));
  const total = b.textWidth - 720 * ctx.depth;
  const width = Math.floor(total / cols);
  const align = n.align ?? [];
  const tl = tableLook(b);
  const rows = n.children.map((row, ri) => Array.from({ length: cols }, (_, ci) => {
    const cell = row.children[ci];
    const jc = align[ci] === 'center' ? '<w:jc w:val="center"/>' : align[ci] === 'right' ? '<w:jc w:val="right"/>' : '';
    const content = cell ? inline(b, cell.children, ri === 0 ? tl.header : {}) : '';
    return para(content, `<w:spacing w:before="0" w:after="0"/>${jc}`);
  }));
  b.body.push(tableXml(b, rows, {
    widths: Array(cols).fill(width), header: true, indent: ctx.depth > 0 ? 720 * ctx.depth : 0,
    borders: tl.borders, shade: r => tl.shade(r), ...(tl.cell ? { cellBorders: (r: number) => tl.cell!(r, r === rows.length - 1) } : {}),
  }));
}

function infographic(b: Builder, n: Code, kind: NonNullable<ReturnType<typeof infographicKind>>, ctx: Ctx): void {
  const parsed = parseInfographic(kind, n.value, n.meta);
  if (!parsed.ok) {
    b.body.push(para(placeholderRuns(`[${parsed.error}. Source:]`)));
    codeBlock(b, n.value, ctx);
    return;
  }
  renderInfographic(b, parsed.value);
}

function tight(content: string, extra = ''): string {
  return para(content, `<w:spacing w:before="0" w:after="40"/>${extra}`);
}

function renderInfographic(b: Builder, g: Infographic): void {
  const W = b.textWidth;
  switch (g.kind) {
    case 'stats': {
      // Half-points per value, by length (as the app's px sizes); a row holds as many tiles as fit
      // the longest unbroken word at that size, so Word never splits "Desktop" or "$100/mo".
      const sizeOf = (v: string): number => Math.round(statValueSize(v) * 1.3);
      const need = Math.max(2160, ...g.items.map((i) => {
        const longest = Math.max(0, ...i.value.split(/\s+/).map(t => t.length));
        return Math.ceil(longest * (sizeOf(i.value) / 2) * 0.66 * 20) + 2 * 120 + 96;
      }));
      const perRow = Math.max(1, Math.min(g.items.length, Math.floor(W / need)));
      for (let at = 0; at < g.items.length; at += perRow) {
        const chunk = g.items.slice(at, at + perRow);
        const n = chunk.length;
        const w = Math.floor(W / perRow);
        const cells = chunk.map(i => tight(run(i.value, { bold: true, size: sizeOf(i.value) }))
          + tight(run(i.label, { color: '52525B', size: 18 }))
          + (i.delta ? tight(run(`${i.trend === 'up' ? '▲' : i.trend === 'down' ? '▼' : '■'} ${i.delta}`,
            { bold: true, size: 18, color: i.trend === 'up' ? '15803D' : i.trend === 'down' ? 'B91C1C' : '71717A' })) : ''));
        // Tiles: shaded cells separated by white borders; a short last row keeps the tile width.
        b.body.push(tableXml(b, [cells], {
          widths: Array(n).fill(w), borders: BORDER('FFFFFF', 24), shade: () => b.tintFill,
          ...(b.look.theme ? { cellBorders: () => `<w:top w:val="single" w:sz="24" w:space="0" w:color="${b.accent}"/>` } : {}),
        }));
      }
      return;
    }
    case 'timeline': {
      const rows = g.items.map(i => [
        tight(run(i.date, { bold: true, color: b.accent })),
        tight(run(i.title, { bold: true })) + (i.text ? tight(run(i.text, { color: '3F3F46' })) : ''),
      ]);
      const left = Math.round(W * 0.24);
      b.body.push(tableXml(b, rows, {
        widths: [left, W - left], borders: NO_BORDER,
        cellBorders: (_r, c) => (c === 1 ? `<w:left w:val="single" w:sz="16" w:space="0" w:color="${b.accent}"/>` : undefined),
      }));
      return;
    }
    case 'steps': {
      const rows = g.items.map((i, k) => [
        tight(run(String(k + 1), { bold: true, color: 'FFFFFF', size: 26 }), '<w:jc w:val="center"/>'),
        tight(run(i.title, { bold: true })) + (i.text ? tight(run(i.text, { color: '3F3F46' })) : ''),
      ]);
      b.body.push(tableXml(b, rows, {
        widths: [600, W - 600], borders: BORDER('FFFFFF', 12), shade: (_r, c) => (c === 0 ? b.accent : b.look.theme ? b.tintFill : 'F8FAFC'),
      }));
      return;
    }
    case 'comparison': {
      const n = g.columns.length;
      const w = Math.floor(W / n);
      const head = g.columns.map(c => tight(run(c.title, { bold: true, color: c.highlight ? 'FFFFFF' : '1A1A1A' })));
      const bodyRow = g.columns.map(c => c.items.map(x => tight(run(`• ${x}`, {}))).join(''));
      const rows = [head, bodyRow];
      if (g.columns.some(c => c.footer)) rows.push(g.columns.map(c => tight(run(c.footer ?? '', { italic: true, color: '52525B' }))));
      b.body.push(tableXml(b, rows, {
        widths: Array(n).fill(w), header: true,
        shade: (r, c) => (r === 0 ? (g.columns[c]!.highlight ? b.accent : 'F4F4F5') : g.columns[c]!.highlight ? (b.look.theme ? b.tintFill : 'EFF6FF') : undefined),
      }));
      return;
    }
    case 'callout': {
      const c = CALLOUT_COLORS[g.callout.type];
      const inner = b.capture(() => {
        const glyph = g.callout.icon ? `${ICON_GLYPHS[g.callout.icon]}  ` : '';
        b.body.push(tight((glyph ? `<w:r><w:rPr><w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol"/><w:color w:val="${c.border}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(glyph)}</w:t></w:r>` : '')
          + run(g.callout.title ?? c.label, { bold: true, color: c.ink })));
        blocks(b, parseMarkdown(g.callout.body).children, { depth: 0, quote: false });
      });
      b.body.push(tableXml(b, [[inner]], {
        widths: [W], borders: NO_BORDER, shade: () => c.fill,
        cellBorders: () => `<w:left w:val="single" w:sz="36" w:space="0" w:color="${c.border}"/>`,
      }));
      return;
    }
  }
}

// ── Document blocks (round 3) ───────────────────────────────────────

/** Inline Markdown in a block field, as runs. */
function mdRuns(b: Builder, text: string, style: RunStyle = {}): string {
  const first = parseMarkdown(text).children[0];
  return first?.type === 'paragraph' ? inline(b, first.children, style) : run(plainInline(text), style);
}

interface GridCell { xml: string; span?: number; fill?: string; borders?: string }

/** A table whose cells may span columns (line-item sections and totals, the risk matrix). */
function gridTable(widths: number[], rows: Array<{ cells: GridCell[]; header?: boolean }>, opts: { borders?: string; jc?: 'left' | 'right' | 'center' } = {}): string {
  const trs = rows.map((r) => {
    let col = 0;
    const tcs = r.cells.map((c) => {
      const span = c.span ?? 1;
      const w = widths.slice(col, col + span).reduce((a, x) => a + x, 0);
      col += span;
      return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}`
        + `${c.borders ? `<w:tcBorders>${c.borders}</w:tcBorders>` : ''}${c.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${c.fill}"/>` : ''}`
        + '<w:vAlign w:val="center"/></w:tcPr>'
        + `${c.xml || para('')}</w:tc>`;
    }).join('');
    return `<w:tr>${r.header ? '<w:trPr><w:tblHeader/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}${tcs}</w:tr>`;
  }).join('');
  const total = widths.reduce((a, w) => a + w, 0);
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${total}" w:type="dxa"/>${opts.jc ? `<w:jc w:val="${opts.jc}"/>` : ''}`
    + `<w:tblBorders>${opts.borders ?? BORDER()}</w:tblBorders><w:tblLayout w:type="fixed"/>`
    + '<w:tblCellMar><w:top w:w="70" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="70" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar>'
    + '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
    + `<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${trs}</w:tbl>`
    + para('', '<w:spacing w:after="120"/>');
}

const RIGHT = '<w:jc w:val="right"/>';
const CENTER = '<w:jc w:val="center"/>';
const LINES = (color = 'E4E4E7'): string => `<w:top w:val="nil"/><w:left w:val="nil"/><w:right w:val="nil"/><w:insideV w:val="nil"/>`
  + `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="${color}"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="${color}"/>`;

function docBlock(b: Builder, n: Code, kind: DocBlockKind, ctx: Ctx): void {
  const parsed = parseDocBlock(kind, n.value, `${n.lang ?? ''} ${n.meta ?? ''}`);
  if (!parsed.ok) {
    b.body.push(para(placeholderRuns(`[${parsed.error}. Source:]`)));
    codeBlock(b, n.value, ctx);
    return;
  }
  renderDocBlock(b, parsed.value);
}

function renderDocBlock(b: Builder, d: DocBlock): void {
  const W = b.textWidth;
  const A = b.accent;
  const muted = { color: '52525B', size: 19 };
  const headCell = (text: string, right = false): GridCell => ({
    xml: tight(run(text, { bold: true }), right ? RIGHT : ''), borders: `<w:bottom w:val="single" w:sz="12" w:space="0" w:color="${A}"/>`,
  });
  switch (d.kind) {
    case 'signature': {
      const n = d.parties.length;
      const w = Math.floor(W / n);
      const cells = d.parties.map(p => (p.label ? tight(run(p.label.toUpperCase(), { bold: true, color: '52525B', size: 16 })) : '')
        + para('', '<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="1" w:color="1A1A1A"/></w:pBdr><w:spacing w:before="720" w:after="60"/><w:ind w:right="360"/>')
        + tight(mdRuns(b, p.name || 'Name', { bold: true }))
        + (p.title ? tight(mdRuns(b, p.title, muted)) : '')
        + tight(run(`Date: ${p.date || '____________________'}`, muted)));
      b.body.push(tableXml(b, [cells], { widths: Array(n).fill(w), borders: NO_BORDER }));
      return;
    }
    case 'keyvalue': {
      if (d.title) b.body.push(tight(run(d.title.toUpperCase(), { bold: true, color: A, size: 17 }), '<w:keepNext/>'));
      const kw = Math.round(W * 0.32);
      const rows = d.items.map(i => [tight(mdRuns(b, i.key, { bold: true, color: '52525B' })), tight(mdRuns(b, i.value))]);
      b.body.push(tableXml(b, rows, {
        widths: [kw, W - kw], borders: LINES(), shade: (_r, c) => (c === 0 ? b.tintFill : undefined),
        cellBorders: (_r, c) => (c === 0 ? `<w:left w:val="single" w:sz="18" w:space="0" w:color="${A}"/>` : undefined),
      }));
      return;
    }
    case 'lineitems': {
      const t = computeTotals(d);
      const money = (x: number): string => formatMoney(x, d.currency);
      const units = d.items.some(r => r.unit);
      const fixed = [800, ...(units ? [900] : []), 1500, 1700];
      const widths = [W - fixed.reduce((a, x) => a + x, 0), ...fixed];
      const cols = widths.length;
      const rows: Array<{ cells: GridCell[]; header?: boolean }> = [{
        header: true,
        cells: [headCell('Item'), headCell('Qty', true), ...(units ? [headCell('Unit')] : []), headCell('Rate', true), headCell('Amount', true)],
      }];
      d.items.forEach((r, i) => {
        if (r.section !== undefined) {
          rows.push({ cells: [{ xml: tight(run(r.section.toUpperCase(), { bold: true, color: A, size: 17 })), span: cols, fill: b.tintFill }] });
          return;
        }
        rows.push({ cells: [
          { xml: (r.item ? tight(mdRuns(b, r.item, { bold: true })) : '') + (r.description ? tight(mdRuns(b, r.description, muted)) : '') },
          { xml: tight(run(formatQty(r.qty ?? 1), {}), RIGHT) },
          ...(units ? [{ xml: tight(run(r.unit ?? '', {})) }] : []),
          { xml: tight(run(money(r.rate ?? 0), {}), RIGHT) },
          { xml: tight(run(money(t.lines[i] ?? 0), {}), RIGHT) },
        ] });
      });
      const sum = (label: string, value: string, total = false): { cells: GridCell[] } => ({ cells: [
        { xml: tight(run(label, total ? { bold: true } : { color: '52525B' }), RIGHT), span: cols - 1, borders: '<w:top w:val="nil"/><w:bottom w:val="nil"/>' },
        { xml: tight(run(value, total ? { bold: true, size: 24 } : {}), RIGHT),
          borders: total ? '<w:top w:val="single" w:sz="12" w:space="0" w:color="1A1A1A"/><w:bottom w:val="nil"/>' : '<w:top w:val="nil"/><w:bottom w:val="nil"/>' },
      ] });
      rows.push(sum('Subtotal', money(t.subtotal)));
      if (t.discount) rows.push(sum(`Discount${t.discountLabel && /%/.test(t.discountLabel) ? ` (${t.discountLabel})` : ''}`, `−${money(t.discount)}`));
      if (d.taxRate) rows.push(sum(`${d.taxLabel || 'Tax'} (${formatQty(d.taxRate)}%)`, money(t.tax)));
      rows.push(sum('Total', money(t.total), true));
      b.body.push(gridTable(widths, rows, { borders: LINES() }));
      if (d.notes) b.body.push(para(mdRuns(b, d.notes, muted)));
      return;
    }
    case 'riskmatrix': {
      const axis = 560;
      const cw = Math.min(1100, Math.floor((Math.min(W, 6200) - axis) / 5));
      const rows: Array<{ cells: GridCell[] }> = [];
      for (let l = 5; l >= 1; l--) {
        rows.push({ cells: [
          { xml: tight(run(String(l), { bold: true, color: '52525B' }), CENTER) },
          ...[1, 2, 3, 4, 5].map((i) => {
            const r = riskRating(l * i);
            const ids = d.risks.filter(x => x.likelihood === l && x.impact === i).map(x => x.id).join(' ');
            return { xml: tight(run(ids || ' ', { bold: true, color: RATING_COLORS[r].ink, size: 18 }), CENTER), fill: RATING_COLORS[r].fill };
          }),
        ] });
      }
      rows.push({ cells: [{ xml: '' }, ...[1, 2, 3, 4, 5].map(i => ({ xml: tight(run(String(i), { bold: true, color: '52525B' }), CENTER) }))] });
      b.body.push(tight(run('RISK MATRIX — LIKELIHOOD × IMPACT', { bold: true, color: A, size: 17 }), '<w:keepNext/>'));
      b.body.push(gridTable([axis, ...Array(5).fill(cw)], rows, { borders: BORDER('FFFFFF', 18) }));
      const sorted = [...d.risks].sort((x, y) => y.likelihood * y.impact - x.likelihood * x.impact);
      const fixed = [700, 450, 450, 1500, 1300];
      const rest = W - fixed.reduce((a, x) => a + x, 0);
      const widths = [700, Math.round(rest * 0.45), 450, 450, 1500, 1300, rest - Math.round(rest * 0.45)];
      const reg: Array<{ cells: GridCell[]; header?: boolean }> = [{ header: true, cells: ['ID', 'Risk', 'L', 'I', 'Rating', 'Owner', 'Mitigation'].map(h => headCell(h, h === 'L' || h === 'I')) }];
      for (const x of sorted) {
        const r = riskRating(x.likelihood * x.impact);
        reg.push({ cells: [
          { xml: tight(run(x.id, { bold: true })) }, { xml: tight(mdRuns(b, x.title)) },
          { xml: tight(run(String(x.likelihood), {}), RIGHT) }, { xml: tight(run(String(x.impact), {}), RIGHT) },
          { xml: tight(run(`${r} · ${x.likelihood * x.impact}`, { bold: true, color: RATING_COLORS[r].ink, size: 18 })), fill: RATING_COLORS[r].fill },
          { xml: tight(mdRuns(b, x.owner ?? '')) }, { xml: tight(mdRuns(b, x.mitigation ?? '', { size: 19 })) },
        ] });
      }
      b.body.push(gridTable(widths, reg, { borders: LINES() }));
      return;
    }
    case 'actions': {
      const STATUS: Record<string, { label: string; color: string; fill: string }> = {
        open: { label: 'Open', color: '1E40AF', fill: 'DBEAFE' }, 'in progress': { label: 'In progress', color: '92400E', fill: 'FEF3C7' },
        done: { label: 'Done', color: '166534', fill: 'DCFCE7' }, blocked: { label: 'Blocked', color: '991B1B', fill: 'FEE2E2' },
      };
      const fixed = [450, 1700, 1400, 1400];
      const widths = [450, W - fixed.reduce((a, x) => a + x, 0), 1700, 1400, 1400];
      const rows: Array<{ cells: GridCell[]; header?: boolean }> = [{ header: true, cells: ['#', 'Action', 'Owner', 'Due', 'Status'].map(h => headCell(h, h === '#')) }];
      d.items.forEach((i, k) => {
        const st = STATUS[i.status]!;
        rows.push({ cells: [
          { xml: tight(run(String(k + 1), { color: '71717A' }), RIGHT) }, { xml: tight(mdRuns(b, i.action)) },
          { xml: tight(mdRuns(b, i.owner ?? '')) }, { xml: tight(mdRuns(b, i.due ?? '')) },
          { xml: tight(run(st.label, { bold: true, color: st.color, size: 18 })), fill: st.fill },
        ] });
      });
      b.body.push(gridTable(widths, rows, { borders: LINES() }));
      return;
    }
    case 'columns': {
      const n = d.columns.length;
      const sideAt = d.layout === 'sidebar' ? 0 : d.layout === 'sidebar-right' ? n - 1 : -1;
      // The sidebar is about a third of a main column's width, as in the app (1 : 2.1).
      const weight = d.columns.map((_, i) => (sideAt < 0 || i === sideAt ? 1 : 2.1));
      const sum = weight.reduce((a, x) => a + x, 0);
      const widths = weight.map(x => Math.floor(W * x / sum));
      const cells = d.columns.map(c => b.capture(() => blocks(b, parseMarkdown(c).children, { depth: 0, quote: false })));
      b.body.push(tableXml(b, [cells], {
        widths, borders: NO_BORDER, shade: (_r, c) => (c === sideAt ? b.tintFill : undefined),
      }));
      return;
    }
    case 'cover': {
      if (d.kicker) b.body.push(para(run(d.kicker.toUpperCase(), { bold: true, color: A, size: 18 }), '<w:spacing w:before="240" w:after="60"/>'));
      b.body.push(para(mdRuns(b, d.title), `<w:pStyle w:val="Title"/><w:pBdr><w:left w:val="single" w:sz="36" w:space="12" w:color="${A}"/></w:pBdr>`));
      if (d.subtitle) b.body.push(para(mdRuns(b, d.subtitle), '<w:pStyle w:val="Subtitle"/>'));
      if (d.meta.length) b.body.push(para(d.meta.map(m => mdRuns(b, m, muted)).join(run('    ', muted)), '<w:spacing w:after="360"/>'));
      if (d.pageBreak) b.body.push(para('<w:r><w:br w:type="page"/></w:r>'));
      return;
    }
    case 'meta':
      b.body.push(para(d.items.map(m => mdRuns(b, m, muted)).join(run('  ·  ', { color: 'A1A1AA', size: 19 })), '<w:spacing w:after="240"/>'));
      return;
    case 'references':
      d.items.forEach((r, i) => {
        let link = '';
        if (r.url && /^https?:/i.test(r.url)) {
          const rid = b.rel(`${R_NS}/hyperlink`, r.url, true);
          link = `${run(' ', {})}<w:hyperlink r:id="${rid}" w:history="1">${run(r.url, { link: true, size: 19 })}</w:hyperlink>`;
        }
        b.body.push(para(`${run(`[${i + 1}]`, { color: '71717A' })}<w:r><w:tab/></w:r>${mdRuns(b, r.text)}${link}`,
          '<w:spacing w:after="80"/><w:ind w:left="567" w:hanging="567"/>'));
      });
      return;
  }
}

// ── TOC, cover, header/footer ───────────────────────────────────────

/** Word bookmark names: letters, digits and underscores, at most 40 characters. */
function bookmarkName(id: string): string {
  return `_Toc_${id.replace(/[^A-Za-z0-9]/g, '_').slice(0, 34)}`;
}

function tocXml(b: Builder, headings: HeadingInfo[]): string {
  const right = b.textWidth;
  const entries = headings.filter(h => h.depth <= 4);
  const entry = (h: HeadingInfo, i: number): string => {
    const bm = bookmarkName(h.id);
    const begin = i === 0
      ? '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-4" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      : '';
    const end = i === entries.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : '';
    return para(`${begin}<w:hyperlink w:anchor="${bm}" w:history="1">${run(h.text, {})}<w:r><w:tab/></w:r></w:hyperlink>${end}`,
      `<w:pStyle w:val="TOC${h.depth}"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${right}"/></w:tabs>`);
  };
  const title = para(run('Contents', {}), '<w:pStyle w:val="TOCHeading"/>');
  if (!entries.length) {
    return title + para('<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-4" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + run('Update this field to build the table of contents.', { italic: true }) + '<w:r><w:fldChar w:fldCharType="end"/></w:r>');
  }
  return title + entries.map(entry).join('');
}

function coverXml(b: Builder, title: string, s: DocSettings, dateText: string): string {
  const c = s.cover!;
  const parts: string[] = [];
  const variant = b.look.theme?.cover ?? 'classic';
  if (variant === 'band') {
    // A full-width band in the accent, white type — the report/proposal cover.
    const logo = c.logo ? b.image(c.logo) : undefined;
    const lf = logo ? b.fit(logo.width, logo.height, `${Math.min(logo.width, 160)}px`) : undefined;
    const inner = (logo && lf ? para(b.drawing(logo, lf.cx, lf.cy, 'Logo'), '<w:spacing w:after="360"/>') : '')
      + para(run(c.title ?? title, { bold: true, color: 'FFFFFF', size: 56 }), '<w:spacing w:before="1600" w:after="200"/>')
      + (c.subtitle ? para(run(c.subtitle, { color: 'FFFFFF', size: 30 }), '<w:spacing w:after="480"/>') : '')
      + (c.author ? para(run(c.author, { color: 'FFFFFF', size: 24 }), '<w:spacing w:after="60"/>') : '')
      + para(run(c.date ?? dateText, { color: 'FFFFFF', size: 22 }), '<w:spacing w:after="600"/>');
    parts.push(para('', '<w:spacing w:before="600" w:after="0"/>'));
    parts.push(tableXml(b, [[inner]], { widths: [b.textWidth], borders: NO_BORDER, shade: () => b.accent }));
    parts.push(para('<w:r><w:br w:type="page"/></w:r>'));
    return parts.join('');
  }
  parts.push(para('', `<w:spacing w:before="${variant === 'minimal' ? 1200 : 2400}" w:after="0"/>`));
  const logo = c.logo ? b.image(c.logo) : undefined;
  if (logo) {
    const { cx, cy } = b.fit(logo.width, logo.height, `${Math.min(logo.width, 180)}px`);
    parts.push(para(b.drawing(logo, cx, cy, 'Logo'), '<w:spacing w:after="480"/>'));
  }
  parts.push(para(run(c.title ?? title, {}), '<w:pStyle w:val="Title"/>'));
  if (c.subtitle) parts.push(para(run(c.subtitle, {}), '<w:pStyle w:val="Subtitle"/>'));
  parts.push(para('', `<w:pBdr><w:bottom w:val="single" w:sz="${variant === 'minimal' ? 6 : 12}" w:space="1" w:color="${b.accent}"/></w:pBdr><w:spacing w:after="360"/>`));
  if (c.author) parts.push(para(run(c.author, { size: 26 })));
  parts.push(para(run(c.date ?? dateText, { color: '52525B', size: 24 })));
  parts.push(para('<w:r><w:br w:type="page"/></w:r>'));
  return parts.join('');
}

const VML_NS = 'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"';

function watermarkXml(text: string, font: string): string {
  return '<w:r><w:pict>'
    + '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e">'
    + '<v:formulas><v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/><v:f eqn="sum 0 0 @2"/>'
    + '<v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/>'
    + '<v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/><v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/></v:formulas>'
    + '<v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/>'
    + '<v:textpath on="t" fitshape="t"/><v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles>'
    + '<o:lock v:ext="edit" text="t" shapetype="t"/></v:shapetype>'
    + '<v:shape id="AicoWatermark" o:spid="_x0000_s2049" type="#_x0000_t136" '
    + 'style="position:absolute;margin-left:0;margin-top:0;width:468pt;height:117pt;rotation:315;z-index:-251657216;'
    + 'mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin" '
    + 'o:allowincell="f" fillcolor="#c8c8c8" stroked="f"><v:fill opacity=".5"/>'
    + `<v:textpath style="font-family:&quot;${font}&quot;;font-size:1pt" string="${xmlEscape(text)}"/></v:shape>`
    + '</w:pict></w:r>';
}

function hfPart(tag: 'hdr' | 'ftr', content: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${tag} xmlns:w="${W_NS}" xmlns:r="${R_NS}" ${VML_NS}>${content}</w:${tag}>`;
}

/** Header/footer text with `{page}`/`{pages}` as live fields. */
function hfText(template: string, values: { title: string; date: string }): string {
  const expanded = expandFields(template, values);
  return expanded.split(/(\{page\}|\{pages\})/i).map(part =>
    /^\{page\}$/i.test(part) ? field('PAGE', '1', { color: '71717A', size: 18 })
      : /^\{pages\}$/i.test(part) ? field('NUMPAGES', '1', { color: '71717A', size: 18 })
        : run(part, { color: '71717A', size: 18 })).join('');
}

// ── Package parts ───────────────────────────────────────────────────

function numberingXml(nums: Builder['nums']): string {
  const bullets = ['•', '◦', '▪'];
  const levels = (ordered: boolean): string => Array.from({ length: 9 }, (_, l) => {
    const fmt = ordered ? ['decimal', 'lowerLetter', 'lowerRoman'][l % 3]! : 'bullet';
    const text = ordered ? `%${l + 1}.` : bullets[l % 3]!;
    const font = ordered ? '' : '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>';
    return `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/>`
      + `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr>${font}</w:lvl>`;
  }).join('');
  const abstracts = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>`;
  const instances = nums.map(n => `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="${n.abstract}"/>`
    + (n.abstract === 1 ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n.start ?? 1}"/></w:lvlOverride>` : '')
    + '</w:num>').join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W_NS}">${abstracts}${instances}</w:numbering>`;
}

const HEADING_SIZES = [36, 30, 26, 24, 22, 22];

/** Paragraph borders, colour, size and case for a heading level under a theme (undefined = the plain look). */
function headingLook(look: ResolvedLook | undefined, l: number, accent: string): { bdr: string; color: string; size: number; caps: boolean; font?: string } {
  const plain = { bdr: '', color: '1A1A1A', size: HEADING_SIZES[l - 1]!, caps: false };
  const t = look?.theme;
  if (!t) return plain;
  const font = DOCX_FONTS[look!.faces.heading];
  const base = { ...plain, font, size: l === 1 ? 40 : plain.size };
  switch (t.headingStyle) {
    case 'classic':
      if (l === 1) return { ...base, bdr: `<w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="${accent}"/></w:pBdr>` };
      return l === 2 ? { ...base, color: accent } : base;
    case 'rule':
      return l === 2 ? { ...base, color: accent, bdr: '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="3" w:color="D4D4D8"/></w:pBdr>' } : base;
    case 'bar':
      if (l === 1) return { ...base, color: accent };
      return l === 2 ? { ...base, bdr: `<w:pBdr><w:left w:val="single" w:sz="30" w:space="8" w:color="${accent}"/></w:pBdr>` } : base;
    case 'caps':
      return l === 2 ? { ...base, color: accent, size: 22, caps: true, bdr: `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="${accent}"/></w:pBdr>` } : base;
  }
}

function stylesXml(font: string, textWidth: number, look?: ResolvedLook, accent = '2563EB'): string {
  const f = xmlEscape(font);
  const justify = look?.theme?.justify ? '<w:jc w:val="both"/>' : '';
  const heading = (l: number): string => {
    const hl = headingLook(look, l, accent);
    const hf = hl.font ? `<w:rFonts w:ascii="${xmlEscape(hl.font)}" w:hAnsi="${xmlEscape(hl.font)}" w:cs="${xmlEscape(hl.font)}"/>` : '';
    const center = l === 1 && look?.theme?.centerTitle ? '<w:jc w:val="center"/>' : '';
    return `<w:style w:type="paragraph" w:styleId="Heading${l}"><w:name w:val="heading ${l}"/>`
      + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>'
      + `<w:pPr><w:keepNext/><w:keepLines/>${hl.bdr}<w:spacing w:before="${l <= 2 ? 360 : 240}" w:after="120"/>${center}<w:outlineLvl w:val="${l - 1}"/></w:pPr>`
      + `<w:rPr>${hf}<w:b/><w:bCs/>${hl.caps ? '<w:caps/>' : ''}<w:color w:val="${hl.color}"/><w:sz w:val="${hl.size}"/><w:szCs w:val="${hl.size}"/></w:rPr></w:style>`;
  };
  const toc = (l: number): string => `<w:style w:type="paragraph" w:styleId="TOC${l}"><w:name w:val="toc ${l}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>`
    + `<w:uiPriority w:val="39"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${textWidth}"/></w:tabs>`
    + `<w:spacing w:after="60"/><w:ind w:left="${(l - 1) * 240}"/></w:pPr>${l === 1 ? '<w:rPr><w:b/></w:rPr>' : ''}</w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${f}" w:eastAsia="${f}" w:hAnsi="${f}" w:cs="${f}"/>`
    + '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>${justify ? `<w:pPr>${justify}</w:pPr>` : ''}<w:rPr><w:color w:val="1A1A1A"/></w:rPr></w:style>`
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + `<w:pPr><w:spacing w:after="240"/>${look?.theme?.centerTitle ? '<w:jc w:val="center"/>' : ''}</w:pPr><w:rPr>`
    + `${look?.theme ? `<w:rFonts w:ascii="${xmlEscape(DOCX_FONTS[look.faces.heading])}" w:hAnsi="${xmlEscape(DOCX_FONTS[look.faces.heading])}" w:cs="${xmlEscape(DOCX_FONTS[look.faces.heading])}"/>` : ''}`
    + '<w:b/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="52525B"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>'
    + [1, 2, 3, 4, 5, 6].map(heading).join('')
    + '<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:next w:val="Normal"/>'
    + '<w:uiPriority w:val="39"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>'
    + [1, 2, 3, 4].map(toc).join('')
    + '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:spacing w:before="60" w:after="200"/></w:pPr><w:rPr><w:i/><w:color w:val="52525B"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D4D4D8"/></w:pBdr><w:ind w:left="360"/></w:pPr>'
    + '<w:rPr><w:color w:val="52525B"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:spacing w:after="80"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>'
    + '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/></w:pPr>'
    + '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/>'
    + '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/></w:rPr></w:style>'
    + `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="${accent}"/><w:u w:val="single"/></w:rPr></w:style>`
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>'
    + '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="E4E4E7"/>`).join('')
    + '</w:tblBorders></w:tblPr></w:style>'
    + '</w:styles>';
}

function contentTypes(media: Media[], parts: string[]): string {
  const exts = new Set(media.map(m => m.name.split('.').pop()!));
  const mime: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' };
  const WML = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + [...exts].map(e => `<Default Extension="${e}" ContentType="${mime[e]}"/>`).join('')
    + `<Override PartName="/word/document.xml" ContentType="${WML}.document.main+xml"/>`
    + `<Override PartName="/word/styles.xml" ContentType="${WML}.styles+xml"/>`
    + `<Override PartName="/word/numbering.xml" ContentType="${WML}.numbering+xml"/>`
    + `<Override PartName="/word/settings.xml" ContentType="${WML}.settings+xml"/>`
    + parts.map(p => `<Override PartName="/word/${p}" ContentType="${WML}.${p.startsWith('header') ? 'header' : 'footer'}+xml"/>`).join('')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '</Types>';
}

export interface DocxInput {
  title: string;
  tree: Root;
  /** Put the title as a Title paragraph first (when there is no cover and the text does not open with it). */
  showTitle: boolean;
  resolveImage: ImageResolver;
  /** For docProps and `{date}`; defaults to now. */
  date?: Date;
  settings?: DocSettings;
  visuals?: Map<string, RenderedVisual>;
  headings?: HeadingInfo[];
  /** Insert the TOC after the title/cover (settings.toc without a marker in the text). */
  tocAtStart?: boolean;
}

export async function toDocx(input: DocxInput): Promise<Uint8Array> {
  const s = input.settings ?? DEFAULT_SETTINGS;
  const headings = input.headings ?? [];
  const font = DOCX_FONTS[s.font === 'serif' ? 'serif' : 'sans'];
  const date = input.date ?? new Date();
  const dateText = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const b = new Builder(input.resolveImage, s, input.visuals ?? new Map(), headings);
  await b.loadImages(input.tree, s.cover?.enabled && s.cover.logo ? [s.cover.logo] : []);
  b.tocXml = tocXml(b, headings);

  const cover = Boolean(s.cover?.enabled);
  if (cover) b.body.push(coverXml(b, input.title, s, dateText));
  else if (input.showTitle && input.title) b.body.push(para(run(input.title, {}), '<w:pStyle w:val="Title"/>'));
  if (input.tocAtStart) b.body.push(b.tocXml + para('<w:r><w:br w:type="page"/></w:r>'));
  blocks(b, input.tree.children, { depth: 0, quote: false });
  if (b.body.length === 0) b.body.push(para(''));

  // Headers and footers.
  const parts: Record<string, string> = {};
  const hfRefs: string[] = [];
  const values = { title: input.title, date: dateText };
  const right = b.textWidth;
  const hfPara = (content: string, style: string, rule = false): string =>
    para(content, `<w:pStyle w:val="${style}"/>${rule ? `<w:pBdr><w:${style === 'Header' ? 'bottom' : 'top'} w:val="single" w:sz="4" w:space="4" w:color="D4D4D8"/></w:pBdr>` : ''}`
      + `<w:tabs><w:tab w:val="right" w:pos="${right}"/></w:tabs>`);
  const watermark = s.watermark ? watermarkXml(s.watermark, font) : '';
  const look = b.look;
  // A letter's header text is its letterhead, on the first page only.
  const letterhead = look.theme?.header === 'letterhead' && Boolean(s.header);
  const banner = look.classification
    ? para(run(look.classification, { bold: true, color: 'B91C1C', size: 16 }), '<w:pStyle w:val="Header"/><w:spacing w:after="60"/><w:jc w:val="center"/>') : '';
  const ruled = look.theme?.header === 'rule';
  const headerText = s.header && !letterhead ? hfText(s.header, values) : '';
  let footerText = s.footer ? hfText(s.footer, values) : '';
  if (s.pageNumbers && !/\{page\}/i.test(s.footer ?? '')) {
    footerText += `<w:r><w:tab/></w:r>${run('Page ', { color: '71717A', size: 18 })}${field('PAGE', '1', { color: '71717A', size: 18 })}`
      + `${run(' of ', { color: '71717A', size: 18 })}${field('NUMPAGES', '1', { color: '71717A', size: 18 })}`;
  }
  const addPart = (name: string, tag: 'hdr' | 'ftr', content: string, type: 'default' | 'first'): void => {
    parts[name] = hfPart(tag, content);
    const rid = b.rel(`${R_NS}/${tag === 'hdr' ? 'header' : 'footer'}`, name);
    hfRefs.push(`<w:${tag === 'hdr' ? 'headerReference' : 'footerReference'} w:type="${type}" r:id="${rid}"/>`);
  };
  const footerBanner = banner.replace('w:val="Header"', 'w:val="Footer"').replace('<w:spacing w:after="60"/>', '<w:spacing w:before="60" w:after="0"/>');
  if (headerText || watermark || banner) addPart('header1.xml', 'hdr', banner + hfPara(watermark + headerText, 'Header', ruled && Boolean(headerText)), 'default');
  if (footerText || banner) addPart('footer1.xml', 'ftr', hfPara(footerText, 'Footer', ruled && Boolean(footerText)) + footerBanner, 'default');
  if (cover) {
    // The cover is its own first page: no header text, no footer — only the watermark (and a classification).
    addPart('header2.xml', 'hdr', banner + hfPara(watermark, 'Header'), 'first');
    addPart('footer2.xml', 'ftr', hfPara('', 'Footer') + footerBanner, 'first');
  } else if (letterhead) {
    const name = expandFields(s.header!, values).replace(/\{page\}|\{pages\}/gi, '');
    const lh = para(`${watermark}${run(name, { bold: true, color: b.accent, size: 36 })}<w:r><w:tab/></w:r>${run(dateText, { color: '71717A', size: 18 })}`,
      `<w:pStyle w:val="Header"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" w:color="${b.accent}"/></w:pBdr>`
      + `<w:tabs><w:tab w:val="right" w:pos="${right}"/></w:tabs><w:spacing w:after="240"/>`);
    addPart('header2.xml', 'hdr', banner + lh, 'first');
    addPart('footer2.xml', 'ftr', hfPara(footerText, 'Footer') + footerBanner, 'first');
  }
  // headerReference elements precede footerReference ones in sectPr.
  hfRefs.sort((x, y) => Number(y.startsWith('<w:headerReference')) - Number(x.startsWith('<w:headerReference')));

  const page = pageTwips(s);
  const m = s.margins;
  const sectPr = `<w:sectPr>${hfRefs.join('')}<w:pgSz w:w="${page.w}" w:h="${page.h}"${s.orientation === 'landscape' ? ' w:orient="landscape"' : ''}/>`
    + `<w:pgMar w:top="${twips(m.top)}" w:right="${twips(m.right)}" w:bottom="${twips(m.bottom)}" w:left="${twips(m.left)}" w:header="567" w:footer="567" w:gutter="0"/>`
    + `${cover || letterhead ? '<w:titlePg/>' : ''}</w:sectPr>`;

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" `
    + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    + `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ${VML_NS}>`
    + `<w:body>${b.body.join('')}${sectPr}</w:body></w:document>`;

  const hasToc = b.body.some(x => x.includes(' TOC \\o '));
  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${W_NS}">`
    // Word refreshes fields on open (TOC page numbers, NUMPAGES) — it asks the reader first.
    + `${hasToc ? '<w:updateFields w:val="true"/>' : ''}<w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/>`
    + `<Relationship Id="rId2" Type="${R_NS}/numbering" Target="numbering.xml"/>`
    + `<Relationship Id="rId3" Type="${R_NS}/settings" Target="settings.xml"/>`
    + b.rels.map(r => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlEscape(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')
    + '</Relationships>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/>`
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '</Relationships>';

  const when = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties '
    + 'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" '
    + 'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${xmlEscape(input.title)}</dc:title>${s.cover?.author ? `<dc:creator>${xmlEscape(s.cover.author)}</dc:creator>` : ''}`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified>`
    + '</cp:coreProperties>';

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes(b.media, Object.keys(parts))),
    '_rels/.rels': strToU8(rootRels),
    'docProps/core.xml': strToU8(core),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(stylesXml(font, b.textWidth, look.theme ? look : undefined, b.accent)),
    'word/numbering.xml': strToU8(numberingXml(b.nums)),
    'word/settings.xml': strToU8(settingsXml),
    'word/_rels/document.xml.rels': strToU8(docRels),
  };
  for (const [name, xml] of Object.entries(parts)) files[`word/${name}`] = strToU8(xml);
  for (const media of b.media) files[`word/media/${media.name}`] = media.bytes;
  return zipSync(files, { level: 6 });
}
