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
 *   `TOC \o "1-3"` field over bookmarked headings. `settings.xml` asks Word to
 *   refresh fields on open; the pre-filled entries carry page numbers from a
 *   printed layout when a browser was available (ADR 0022), else none.
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
 * - Design (ADR 0022, `canvas/doc-plan` + `shared/ui/canvas/doc-blueprints`):
 *   the top section is Heading 1; Heading 1–4 carry a multilevel outline list
 *   (numbering.xml abstractNum 10, appendices 11) instead of typed numbers;
 *   the family's faces and sizes; a cover drawn with page-anchored text boxes
 *   in a section of its own, a document-control page and contents in a front
 *   section numbered i, ii, the body numbered from 1 ("of SECTIONPAGES");
 *   captions as SEQ fields; table widths from content; a TOC pre-filled with
 *   PAGEREF results from a printed layout; core/app properties.
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
import { DEFAULT_SETTINGS, PAGE_MM, expandFields, expandRunning, type DocSettings } from './doc-settings.js';
import type { HeadingInfo } from './doc-model.js';
import { isTocMarker } from './doc-model.js';
import { CALLOUT_COLORS, infographicKind, parseImageAttrs, parseInfographic, type ImageAttrs, type Infographic } from './infographics.js';
import { visualForCode, visualKey, type RenderedVisual } from './visuals.js';
import {
  ICON_GLYPHS, RATING_COLORS, computeTotals, docBlockKind, formatMoney, formatQty, parseDocBlock, plainInline, riskRating,
  statValueSize, type DocBlock, type DocBlockKind,
} from '../../shared/ui/canvas/doc-blocks.js';
import { DOCX_FONTS, resolveLook, tint, type ResolvedLook } from '../../shared/ui/canvas/doc-themes.js';
import { apportion } from '../../shared/ui/canvas/doc-layout.js';
import type { Blueprint } from '../../shared/ui/canvas/doc-blueprints.js';
import { frontModel, planDocument, type Caption, type DocPlan, type FrontModel } from './doc-plan.js';

/** Fixed numbering instances: the heading outline and the appendix outline (list numIds count up from 1). */
const HEADING_NUM = 900;
const APPENDIX_NUM = 901;

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
  /** The layout plan (levels, numbering, captions, table widths, front matter). */
  readonly plan: DocPlan;
  readonly bp: Blueprint;
  /** Point sizes: the blueprint's, with table text a step smaller than body text. */
  readonly sizes: Blueprint['sizes'] & { table: number };
  /** The title has been drawn (by the cover, the masthead or a Title paragraph). */
  titleShown = false;

  constructor(private readonly resolveImage: ImageResolver, readonly settings: DocSettings,
    readonly visuals: Map<string, RenderedVisual>, headings: HeadingInfo[], plan: DocPlan) {
    for (const h of headings) this.headingIds.set(h.node, h);
    this.plan = plan;
    this.bp = plan.blueprint;
    this.sizes = { ...this.bp.sizes, table: Math.max(8.5, this.bp.sizes.body - 1) };
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

  private nextShape = 1;
  shapeId(): number { return this.nextShape++; }

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
  const cap = b.plan.captions.get(n);
  // The picture keeps with its caption below it.
  const keep = cap || img.title ? '<w:keepNext/>' : '';
  if (media) {
    const { cx, cy } = b.fit(media.width, media.height, attrs.width);
    // keepNext belongs right after any pStyle (pPr is a sequence).
    const ppr = blockPPr(ctx).replace(/^((?:<w:pStyle[^>]*\/>)?)/, `$1${keep}`);
    b.body.push(para(b.drawing(media, cx, cy, cap?.text ?? (img.alt || '')), `${ppr}${jc}`));
  } else {
    b.body.push(para(placeholderRuns(`[${img.alt || "image"}]`), `${keep}${jc}`));
  }
  if (cap) b.body.push(captionXml(cap, jc));
  else if (img.title) b.body.push(para(run(img.title, {}), `<w:pStyle w:val="Caption"/>${jc}`));
  return true;
}

/** "Table 3 — …" / "Figure 2 — …" with a live SEQ field, so Word renumbers when things move. */
function captionXml(cap: Caption, extra = ''): string {
  const label = cap.kind === 'table' ? 'Table' : 'Figure';
  return para(`${run(`${label} `, { bold: true })}${field(`SEQ ${label} \\* ARABIC`, String(cap.n), { bold: true })}${run(` — ${cap.text}`, {})}`,
    `<w:pStyle w:val="Caption"/>${cap.kind === 'table' ? '<w:keepNext/>' : ''}${extra}`);
}

function visualBlock(b: Builder, kind: 'chart' | 'diagram' | 'math', source: string, ctx: Ctx, node?: unknown): void {
  const v = b.visuals.get(visualKey(kind, source));
  const cap = node ? b.plan.captions.get(node) : undefined;
  if (v?.png && !v.error) {
    const media = b.addMedia(new Uint8Array(v.png), '.png');
    // The PNG is 2×: its CSS size is the size it was drawn at.
    const { cx, cy } = b.fit(v.width, v.height, undefined, b.textWidth - 720 * ctx.depth);
    // Alt text: the caption, else what the diagram is (its first line names the kind: flowchart, sequenceDiagram…).
    const alt = cap?.text ?? `${kind === 'chart' ? 'Chart' : kind === 'diagram' ? `Diagram (${source.trim().split(/\s/)[0]})` : 'Formula'}`;
    b.body.push(para(b.drawing(media, cx, cy, alt), `${cap ? '<w:keepNext/>' : ''}<w:spacing w:before="120" w:after="${cap ? 0 : 200}"/><w:jc w:val="center"/>`));
    if (cap) b.body.push(captionXml(cap, '<w:jc w:val="center"/>'));
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
      const p = b.plan.byNode.get(n);
      if (p?.isTitle) {
        // The opening H1 that repeats the title: the cover or masthead already shows it.
        if (!b.titleShown) b.body.push(para(inline(b, n.children), '<w:pStyle w:val="Title"/>'));
        b.titleShown = true;
        return;
      }
      const level = Math.min(6, p?.level ?? n.depth);
      // A typed number the export replaced with real numbering: the text without it (inline marks dropped with it).
      const content = p && p.text !== info?.text ? run(p.text, {}) : inline(b, n.children);
      const numbered = b.plan.numbering !== 'none';
      const style = p?.appendix && numbered ? 'AppendixHeading' : `Heading${level}`;
      let numPr = '';
      if (numbered && !p?.appendix) {
        if (p?.unnumbered || (!p?.label && level <= 4)) numPr = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>';
        else if (p?.inAppendix && level <= 3) numPr = `<w:numPr><w:ilvl w:val="${level - 1}"/><w:numId w:val="${APPENDIX_NUM}"/></w:numPr>`;
      }
      const ppr = `<w:pStyle w:val="${style}"/>${numPr}`;
      if (info) {
        const id = b.bookmarkId();
        b.body.push(para(`<w:bookmarkStart w:id="${id}" w:name="${bookmarkName(info.id)}"/>${content}<w:bookmarkEnd w:id="${id}"/>`, ppr));
      } else {
        b.body.push(para(content, ppr));
      }
      return;
    }
    case 'paragraph': {
      if (b.plan.consumed.has(n)) return; // printed as a caption
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
      if (visual && visual.kind !== 'math-inline') { visualBlock(b, visual.kind, visual.source, ctx, n); return; }
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
  /** Cell padding in twips (default 80 top/bottom, 120 sides). */
  padding?: number;
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
    + `<w:tblCellMar><w:top w:w="${opts.padding ?? 80}" w:type="dxa"/><w:left w:w="${opts.padding ?? 120}" w:type="dxa"/><w:bottom w:w="${opts.padding ?? 80}" w:type="dxa"/><w:right w:w="${opts.padding ?? 120}" w:type="dxa"/></w:tblCellMar>`
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
  const tp = b.plan.tables.get(n);
  // Content-based widths (`doc-layout` columnWidths): ID columns narrow, prose columns wide.
  const widths = tp && tp.widths.length === cols ? apportion(tp.widths, total) : apportion(Array(cols).fill(1 / cols), total);
  const align = n.align ?? [];
  const tl = tableLook(b);
  const variant = tp?.variant ?? 'grid';
  const last = n.children.length - 1;
  const size = Math.round(b.sizes.table * 2);
  const rows = n.children.map((row, ri) => Array.from({ length: cols }, (_, ci) => {
    const cell = row.children[ci];
    const want = align[ci] ?? (ri > 0 && tp?.numeric[ci] ? 'right' : variant === 'matrix' && ci > 0 ? 'center' : null);
    const jc = want === 'center' ? '<w:jc w:val="center"/>' : want === 'right' ? '<w:jc w:val="right"/>' : '';
    const style: RunStyle = ri === 0 ? { ...tl.header, size } : { size,
      ...((variant === 'keyvalue' && ci === 0) || (tp?.total && ri === last) || (variant === 'matrix' && ci === 0) ? { bold: true } : {}) };
    const content = cell ? inline(b, cell.children, style) : '';
    return para(content, `<w:spacing w:before="0" w:after="0" w:line="252" w:lineRule="auto"/>${jc}`);
  }));
  const cap = b.plan.captions.get(n);
  if (cap) b.body.push(captionXml(cap));
  const rule = `<w:top w:val="single" w:sz="12" w:space="0" w:color="${b.look.theme ? '1A1A1A' : '52525B'}"/>`;
  b.body.push(tableXml(b, rows, {
    widths, header: true, indent: ctx.depth > 0 ? 720 * ctx.depth : 0,
    borders: tl.borders,
    shade: (r, c) => tl.shade(r) ?? (variant === 'keyvalue' && c === 0 && r > 0 ? b.tintFill : undefined),
    cellBorders: (r: number) => [tl.cell?.(r, r === last), tp?.total && r === last && r > 0 ? rule : undefined].filter(Boolean).join('') || undefined,
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

/** The TOC's levels: three, as a reader scans it (Heading 4 stays in the navigation pane). */
const TOC_DEPTH = 3;
const TOC_INSTR = ` TOC \\o "1-${TOC_DEPTH}" \\h \\z \\u `;

/**
 * A real TOC field, pre-filled so it reads right before Word refreshes it:
 * each entry is number, text and a PAGEREF to the heading's bookmark whose
 * cached result is the page the PDF pass found (`pages`, heading id → page of
 * the body). Without a PDF pass the page slot is left empty rather than "1".
 */
function tocXml(b: Builder, pages?: Map<string, number>): string {
  const entries = b.plan.headings.filter(h => !h.isTitle && h.level <= TOC_DEPTH);
  const begin = `<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve">${TOC_INSTR}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`;
  const entry = (h: DocPlan['headings'][number], i: number): string => {
    const bm = bookmarkName(h.info.id);
    const pg = pages?.get(h.info.id);
    // An appendix's label is words ("Appendix A"), not a number in the number column.
    const num = h.label ? (h.appendix ? run(`${h.label} — `, {}) : `${run(h.label, {})}<w:r><w:tab/></w:r>`) : '';
    const pageRef = pg !== undefined ? field(`PAGEREF ${bm} \\h`, String(pg)) : '';
    const end = i === entries.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : '';
    const style = h.appendix ? 'TOC1' : `TOC${h.level}`;
    return para(`${i === 0 ? begin : ''}<w:hyperlink w:anchor="${bm}" w:history="1">${num}${run(h.text, {})}<w:r><w:tab/></w:r>${pageRef}</w:hyperlink>${end}`,
      `<w:pStyle w:val="${style}"/>`);
  };
  const title = para(run('Contents', {}), '<w:pStyle w:val="TOCHeading"/>');
  if (!entries.length) {
    return title + para(`${begin}${run('Update this field to build the table of contents.', { italic: true })}<w:r><w:fldChar w:fldCharType="end"/></w:r>`);
  }
  return title + entries.map(entry).join('');
}

// ── Covers and front matter (ADR 0022) ──────────────────────────────

const WHITE = 'FFFFFF';

/** A run in a named face (the cover sets its type directly; styles cover the body). */
function faceRun(text: string, face: string, style: RunStyle & { spacing?: number; caps?: boolean }): string {
  if (!text) return '';
  const base = /<w:rPr>(.*)<\/w:rPr>/.exec(run('x', style))?.[1] ?? '';
  const f = xmlEscape(face);
  return `<w:r><w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>${base}${style.caps ? '<w:caps/>' : ''}`
    + `${style.spacing ? `<w:spacing w:val="${style.spacing}"/>` : ''}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

const WPS_NS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

/**
 * A text box anchored to the page (not the text): the only way Word puts a
 * colour block exactly at the paper's edge. The first attempt was a table of
 * exact-height rows in a zero-margin section; Word still kept an undocumented
 * strip of the page for the header and footer and pushed the second row onto
 * a page of its own. A page-relative shape has no such negotiation.
 */
function pageBox(b: Builder, box: { x: number; y: number; w: number; h: number; fill?: string; anchor: 't' | 'b'; ins: [number, number, number, number]; content: string }): string {
  const id = b.shapeId();
  const emu = (tw: number): number => Math.round(tw * EMU_PER_TWIP);
  const [l, t, r, bt] = box.ins.map(emu);
  const fill = box.fill ? `<a:solidFill><a:srgbClr val="${box.fill}"/></a:solidFill>` : '<a:noFill/>';
  return `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251658240 + id}" behindDoc="0" locked="1" layoutInCell="1" allowOverlap="1">`
    + `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(box.x)}</wp:posOffset></wp:positionH>`
    + `<wp:positionV relativeFrom="page"><wp:posOffset>${emu(box.y)}</wp:posOffset></wp:positionV><wp:extent cx="${emu(box.w)}" cy="${emu(box.h)}"/>`
    + `<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${1000 + id}" name="Cover ${id}"/><wp:cNvGraphicFramePr/>`
    + `<a:graphic><a:graphicData uri="${WPS_NS}"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(box.w)}" cy="${emu(box.h)}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}<a:ln><a:noFill/></a:ln></wps:spPr>`
    + `<wps:txbx><w:txbxContent>${box.content || para('')}</w:txbxContent></wps:txbx>`
    + `<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="${l}" tIns="${t}" rIns="${r}" bIns="${bt}" anchor="${box.anchor}" anchorCtr="0"><a:noAutofit/></wps:bodyPr>`
    + '</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback/></mc:AlternateContent></w:r>';
}

/** Label/value pairs as a quiet two-column table (cover metadata, document information). */
function metaTable(b: Builder, pairs: [string, string][], width: number, opts: { onFill?: boolean; labelW?: number } = {}): string {
  if (!pairs.length) return '';
  const lw = opts.labelW ?? Math.round(width * 0.3);
  const label = (t: string): string => tight(run(t.toUpperCase(), { bold: true, size: 15, color: opts.onFill ? tint(b.look.accent, 0.25) : '71717A' }));
  const value = (t: string): string => tight(run(t, { size: 20, color: opts.onFill ? WHITE : '1A1A1A' }));
  return tableXml(b, pairs.map(([k, v]) => [label(k), value(v)]), {
    widths: [lw, width - lw], borders: opts.onFill ? NO_BORDER : LINES(), cellBorders: () => undefined,
  });
}

function coverPairs(f: FrontModel): [string, string][] {
  const v = f.values;
  return ([
    ['Prepared for', v.client], ['Prepared by', v.preparedBy], ['Date', f.date],
    ['Version', [v.version, v.status].filter(Boolean).join(' · ')], ['Reference', v.reference], ['Classification', v.classification],
  ] as [string, string][]).filter(([, x]) => x.trim());
}

/**
 * The band cover, full bleed. `top` (proposals): a deep band holding the
 * title, the metadata on white below; `bottom` (reports): the title on white
 * above a band holding the metadata. Both are page-anchored text boxes
 * (`pageBox`) on a page of their own.
 */
function bandCover(b: Builder, f: FrontModel, page: { w: number; h: number }, at: 'top' | 'bottom'): string {
  const head = b.look.fonts.heading.word;
  const side = 1134;
  const logo = b.settings.cover?.logo ? b.image(b.settings.cover.logo) : undefined;
  const lf = logo ? b.fit(logo.width, logo.height, `${Math.min(logo.width, 180)}px`) : undefined;
  const logoXml = logo && lf ? para(b.drawing(logo, lf.cx, lf.cy, 'Logo'), '<w:spacing w:after="480"/>') : '';
  const titleSize = Math.round(b.sizes.title * 2);
  const inner = page.w - side * 2;
  let shapes: string;
  if (at === 'top') {
    const bandH = Math.round(page.h * 0.56);
    const band = logoXml
      + para(faceRun(f.kicker, head, { color: tint(b.look.accent, 0.3), size: 20, bold: true, spacing: 40 }), '<w:spacing w:after="160"/>')
      + para(faceRun(f.title, head, { color: WHITE, size: titleSize, bold: !b.look.fonts.heading.ownWeight }), '<w:spacing w:after="200" w:line="216" w:lineRule="auto"/>')
      + (f.subtitle ? para(faceRun(f.subtitle, head, { color: tint(b.look.accent, 0.18), size: 30 }), '<w:spacing w:after="0"/>') : '');
    shapes = pageBox(b, { x: 0, y: 0, w: page.w, h: bandH, fill: b.accent, anchor: 'b', ins: [side, side, side, 1000], content: band })
      + pageBox(b, { x: side, y: bandH + 900, w: inner, h: page.h - bandH - 1800, anchor: 't', ins: [0, 0, 0, 0], content: metaTable(b, coverPairs(f), inner, { labelW: 2400 }) });
  } else {
    const upperH = Math.round(page.h * 0.62);
    const upper = logoXml
      + para(faceRun(f.kicker, head, { color: b.accent, size: 20, bold: true, spacing: 40 }), '<w:spacing w:after="200"/>')
      + para(faceRun(f.title, head, { color: '1A1A1A', size: titleSize, bold: !b.look.fonts.heading.ownWeight }), '<w:spacing w:after="240" w:line="216" w:lineRule="auto"/>')
      + (f.subtitle ? para(faceRun(f.subtitle, head, { color: '52525B', size: 30 }), '<w:spacing w:after="240"/>') : '')
      + para('', `<w:pBdr><w:top w:val="single" w:sz="36" w:space="1" w:color="${b.accent}"/></w:pBdr><w:spacing w:after="0"/><w:ind w:right="${inner - 1700}"/>`);
    shapes = pageBox(b, { x: side, y: 0, w: inner, h: upperH - 700, anchor: 'b', ins: [0, 0, 0, 0], content: upper })
      + pageBox(b, { x: 0, y: upperH, w: page.w, h: page.h - upperH, fill: b.accent, anchor: 't', ins: [side, 900, side, side],
        content: metaTable(b, coverPairs(f), inner, { onFill: true, labelW: 2400 }) });
  }
  // One paragraph carries the shapes; the page is otherwise empty.
  return para(shapes, '<w:spacing w:before="0" w:after="0"/>');
}

/** The technical / manual cover: a white page, an accent bar, the title and a metadata table. */
function titleBlockCover(b: Builder, f: FrontModel): string {
  const head = b.look.fonts.heading.word;
  const logo = b.settings.cover?.logo ? b.image(b.settings.cover.logo) : undefined;
  const lf = logo ? b.fit(logo.width, logo.height, `${Math.min(logo.width, 180)}px`) : undefined;
  return para(faceRun(f.kicker, head, { color: b.accent, size: 19, bold: true, spacing: 30 }),
    `<w:pBdr><w:top w:val="single" w:sz="48" w:space="10" w:color="${b.accent}"/></w:pBdr><w:spacing w:after="0"/>`)
    + (logo && lf ? para(b.drawing(logo, lf.cx, lf.cy, 'Logo'), '<w:jc w:val="right"/><w:spacing w:before="240"/>') : '')
    + para(faceRun(f.title, head, { color: '1A1A1A', size: Math.round(b.sizes.title * 2), bold: !b.look.fonts.heading.ownWeight }),
      `<w:spacing w:before="${logo ? 1600 : 2800}" w:after="240" w:line="216" w:lineRule="auto"/>`)
    + (f.subtitle ? para(faceRun(f.subtitle, head, { color: '52525B', size: 28 }), '<w:spacing w:after="0"/>') : '')
    + para('', '<w:spacing w:before="1400" w:after="0"/>')
    + metaTable(b, coverPairs(f), b.textWidth, { labelW: 2600 });
}

/** A title band at the top of page one (policies, marketing, invoices): not a cover page. */
function mastheadXml(b: Builder, f: FrontModel): string {
  const head = b.look.fonts.heading.word;
  const inner = (f.kicker ? para(faceRun(f.kicker, head, { color: tint(b.look.accent, 0.3), size: 17, bold: true, spacing: 30 }), '<w:spacing w:after="80"/>') : '')
    + para(faceRun(f.title, head, { color: WHITE, size: Math.round(b.sizes.title * 2), bold: !b.look.fonts.heading.ownWeight }), '<w:spacing w:after="60" w:line="228" w:lineRule="auto"/>')
    + (f.subtitle ? para(faceRun(f.subtitle, head, { color: tint(b.look.accent, 0.18), size: 24 }), '<w:spacing w:after="0"/>') : '');
  return tableXml(b, [[inner]], { widths: [b.textWidth], borders: NO_BORDER, shade: () => b.accent, cellBorders: () => undefined, padding: 300 });
}

/** The control box under a policy's masthead: reference, version, owner, dates in two label/value pairs per row. */
function controlBox(b: Builder, f: FrontModel): string {
  const v = f.values;
  const pairs: [string, string][] = ([
    ['Reference', v.reference], ['Version', v.version], ['Status', v.status], ['Owner', f.info.find(([k]) => k === 'Owner')?.[1] ?? v.preparedBy],
    ['Effective', f.date], ['Classification', v.classification],
  ] as [string, string][]).filter(([, x]) => x.trim());
  const W = b.textWidth;
  const lw = Math.round(W * 0.15);
  const vw = Math.round(W / 2) - lw;
  const rows: string[][] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const cell = (p?: [string, string]): string[] => (p
      ? [tight(run(p[0].toUpperCase(), { bold: true, size: 15, color: '71717A' })), tight(run(p[1], { size: 19 }))] : [para(''), para('')]);
    rows.push([...cell(pairs[i]), ...cell(pairs[i + 1])]);
  }
  return tableXml(b, rows, { widths: [lw, vw, lw, W - 2 * lw - vw], borders: LINES(), shade: (_r, c) => (c % 2 === 0 ? b.tintFill : undefined) });
}

/** A small accent label over a front-matter table. */
function frontLabel(b: Builder, text: string): string {
  return para(run(text.toUpperCase(), { bold: true, color: b.accent, size: 17 }), '<w:keepNext/><w:spacing w:before="280" w:after="100"/>');
}

/** A front-matter grid: header row in the document's table look, fixed column shares. */
function frontGrid(b: Builder, head: string[], rows: string[][], shares: number[], rowHeight?: number): string {
  const tl = tableLook(b);
  const widths = apportion(shares, b.textWidth);
  const cells = [head.map(h => tight(run(h, { ...tl.header, size: 18 }))), ...rows.map(r => r.map(x => tight(run(x, { size: 18 }))))];
  let xml = tableXml(b, cells, { widths, header: true, borders: tl.borders, shade: r => tl.shade(r), ...(tl.cell ? { cellBorders: (r: number) => tl.cell!(r, false) } : {}) });
  // Signature rows need room to sign.
  if (rowHeight) xml = xml.replace(/<w:trPr><w:cantSplit\/><\/w:trPr>/g, `<w:trPr><w:cantSplit/><w:trHeight w:val="${rowHeight}"/></w:trPr>`);
  return xml;
}

/** The document-control page: information, revision history, approvals, distribution. */
function controlPage(b: Builder, f: FrontModel): string {
  return para(run('Document control', {}), '<w:pStyle w:val="TOCHeading"/>')
    + frontLabel(b, 'Document information') + metaTable(b, [['Title', f.title], ...f.info], b.textWidth, { labelW: 2600 })
    + frontLabel(b, 'Revision history') + frontGrid(b, ['Version', 'Date', 'Author', 'Description'], f.revisions, [0.12, 0.2, 0.22, 0.46])
    + (f.approvals.length ? frontLabel(b, 'Approvals') + frontGrid(b, ['Name', 'Role', 'Signature', 'Date'], f.approvals, [0.27, 0.27, 0.28, 0.18], 560) : '')
    + (f.distribution.length && b.bp.front.distribution ? frontLabel(b, 'Distribution') + frontGrid(b, ['Name', 'Organisation', 'Role'], f.distribution, [0.34, 0.33, 0.33]) : '');
}

/** The end matter of a document with an inline control box: its history and approvals. */
function controlEnd(b: Builder, f: FrontModel): string {
  return para(run('Document history', {}), '<w:pStyle w:val="TOCHeading"/><w:pageBreakBefore w:val="0"/><w:spacing w:before="480"/>')
    + frontGrid(b, ['Version', 'Date', 'Author', 'Description'], f.revisions, [0.12, 0.2, 0.22, 0.46])
    + (f.approvals.length ? frontLabel(b, 'Approvals') + frontGrid(b, ['Name', 'Role', 'Signature', 'Date'], f.approvals, [0.27, 0.27, 0.28, 0.18], 560) : '');
}

/** A paper's title block: centred title, authors, date. */
function academicTitle(b: Builder, f: FrontModel): string {
  const author = b.settings.cover?.author ?? f.values.preparedBy;
  return para(run(f.title, {}), '<w:pStyle w:val="Title"/><w:jc w:val="center"/>')
    + (f.subtitle ? para(run(f.subtitle, { italic: true, color: '3F3F46', size: 24 }), '<w:spacing w:after="120"/><w:jc w:val="center"/>') : '')
    + (author ? para(run(author, { size: 22 }), '<w:spacing w:after="60"/><w:jc w:val="center"/>') : '')
    + para(run(f.date, { color: '52525B', size: 20 }), '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="12" w:color="A1A1AA"/></w:pBdr><w:spacing w:after="360"/><w:jc w:val="center"/>');
}

/** The round-1 cover (plain documents and themes without a family): its own page. */
function coverXml(b: Builder, title: string, s: DocSettings, dateText: string): string {
  const c = s.cover!;
  const parts: string[] = [];
  const variant = b.look.theme?.cover ?? 'classic';
  if (variant === 'band') {
    // A full-width band in the accent, white type.
    const logo = c.logo ? b.image(c.logo) : undefined;
    const lf = logo ? b.fit(logo.width, logo.height, `${Math.min(logo.width, 160)}px`) : undefined;
    const inner = (logo && lf ? para(b.drawing(logo, lf.cx, lf.cy, 'Logo'), '<w:spacing w:after="360"/>') : '')
      + para(run(c.title ?? title, { bold: true, color: 'FFFFFF', size: 56 }), '<w:spacing w:before="1600" w:after="200"/>')
      + (c.subtitle ? para(run(c.subtitle, { color: 'FFFFFF', size: 30 }), '<w:spacing w:after="480"/>') : '')
      + (c.author ? para(run(c.author, { color: 'FFFFFF', size: 24 }), '<w:spacing w:after="60"/>') : '')
      + para(run(c.date ?? dateText, { color: 'FFFFFF', size: 22 }), '<w:spacing w:after="600"/>');
    parts.push(para('', '<w:spacing w:before="600" w:after="0"/>'));
    parts.push(tableXml(b, [[inner]], { widths: [b.textWidth], borders: NO_BORDER, shade: () => b.accent }));
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

/**
 * Header/footer text with `{page}`/`{pages}` as live fields. `{pages}` is
 * SECTIONPAGES in a document whose body is its own section (after a cover or
 * front matter), so "Page 3 of 40" counts the body, as its page numbers do.
 */
function hfText(expanded: string, pagesField = 'NUMPAGES', pageFormat = ''): string {
  const style = { color: '71717A', size: 16 };
  return expanded.split(/(\{page\}|\{pages\})/i).map(part =>
    /^\{page\}$/i.test(part) ? field(`PAGE${pageFormat}`, '1', style)
      : /^\{pages\}$/i.test(part) ? field(pagesField, '1', style)
        : run(part, style)).join('');
}

// ── Package parts ───────────────────────────────────────────────────

function numberingXml(nums: Builder['nums'], scheme: DocPlan['numbering'] = 'none', accent = '1A1A1A'): string {
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
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W_NS}">${abstracts}${outlineAbstracts(scheme, accent)}${instances}`
    + (scheme !== 'none' ? `<w:num w:numId="${HEADING_NUM}"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="${APPENDIX_NUM}"><w:abstractNumId w:val="11"/></w:num>` : '')
    + '</w:numbering>';
}

/** Hanging indents of the heading numbers per level (twips): the text of a heading lines up whatever its number. */
export const HEADING_INDENT = [567, 794, 964, 1134];

/**
 * The heading outline as Word multilevel lists: abstractNum 10 numbers
 * Heading 1–4 (decimal 1 · 1.1 · 1.1.1 · 1.1.1.1, or legal 1. · 1.1 · (a)),
 * abstractNum 11 the appendices (Appendix A · A.1 · A.1.1). Each level names
 * its style, and each style names the list (`stylesXml`), so a heading added
 * in Word numbers itself.
 */
function outlineAbstracts(scheme: DocPlan['numbering'], accent: string): string {
  if (scheme === 'none') return '';
  // Element order follows CT_Lvl: start, numFmt, pStyle, suff, lvlText, lvlJc, pPr, rPr.
  const lvl = (i: number, fmt: string, text: string, style: string | undefined, ind: number, suff = ''): string =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>${style ? `<w:pStyle w:val="${style}"/>` : ''}`
    + `${suff ? `<w:suff w:val="${suff}"/>` : ''}<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>`
    + `<w:pPr><w:ind w:left="${ind}" w:hanging="${ind}"/></w:pPr><w:rPr><w:color w:val="${accent}"/></w:rPr></w:lvl>`;
  const legal = scheme === 'legal';
  const levels = legal
    ? [lvl(0, 'decimal', '%1.', 'Heading1', HEADING_INDENT[0]!), lvl(1, 'decimal', '%1.%2', 'Heading2', HEADING_INDENT[1]!), lvl(2, 'lowerLetter', '(%3)', 'Heading3', HEADING_INDENT[2]!)]
    : [lvl(0, 'decimal', '%1', 'Heading1', HEADING_INDENT[0]!), lvl(1, 'decimal', '%1.%2', 'Heading2', HEADING_INDENT[1]!),
      lvl(2, 'decimal', '%1.%2.%3', 'Heading3', HEADING_INDENT[2]!), lvl(3, 'decimal', '%1.%2.%3.%4', 'Heading4', HEADING_INDENT[3]!)];
  // "Appendix A" then a space-separated title (an em dash would be typed text); subsections A.1, A.1.1.
  const app = [lvl(0, 'upperLetter', 'Appendix %1 —', 'AppendixHeading', 0, 'space').replace('w:hanging="0"', 'w:firstLine="0"'),
    lvl(1, 'decimal', '%1.%2', undefined, HEADING_INDENT[1]!), lvl(2, 'decimal', '%1.%2.%3', undefined, HEADING_INDENT[2]!)];
  return `<w:abstractNum w:abstractNumId="10"><w:multiLevelType w:val="multilevel"/>${levels.join('')}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="11"><w:multiLevelType w:val="multilevel"/>${app.join('')}</w:abstractNum>`;
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


interface StyleInput {
  look: ResolvedLook;
  bp: Blueprint;
  numbering: DocPlan['numbering'];
  /** Markdown depth − logical level: the theme's ornaments are keyed on Markdown levels. */
  shift: number;
  textWidth: number;
  accent: string;
  /** The round-3 faces apply (no theme): the plain look's sizes and Calibri/Georgia. */
  plain: boolean;
  h1PageBreak: boolean;
}

/**
 * The style sheet: the blueprint's faces and sizes, Title/Subtitle, Heading
 * 1–6 with outline levels, keep-with-next and (numbered families) the outline
 * list, an Appendix heading, TOC 1–3 with number and page tab stops, Caption,
 * header/footer, quote, list, code and table styles. Body text keeps widow and
 * orphan control on.
 */
function stylesXml(si: StyleInput): string {
  const { look, bp, numbering } = si;
  const bodyFace = xmlEscape(look.fonts.body.word);
  const headFace = xmlEscape(look.fonts.heading.word);
  const fonts = (f: string): string => `<w:rFonts w:ascii="${f}" w:eastAsia="${f}" w:hAnsi="${f}" w:cs="${f}"/>`;
  const hp = (pt: number): number => Math.round(pt * 2);
  const justify = look.theme?.justify ? '<w:jc w:val="both"/>' : '';
  const headingSize = (l: number): number => (si.plain ? HEADING_SIZES[l - 1]!
    : hp(l === 1 ? bp.sizes.h1 : l === 2 ? bp.sizes.h2 : l === 3 ? bp.sizes.h3 : l === 4 ? bp.sizes.body + 1 : bp.sizes.body));
  const numberedLevels = numbering === 'legal' ? 3 : numbering === 'decimal' ? 4 : 0;
  const heading = (l: number): string => {
    const hl = headingLook(look.theme ? look : undefined, Math.min(6, l + si.shift), si.accent);
    const size = hl.caps ? Math.min(headingSize(l), hp(bp.sizes.body + 1)) : headingSize(l);
    const bold = look.fonts.heading.ownWeight && !si.plain ? '' : '<w:b/><w:bCs/>';
    const face = si.plain ? (hl.font ? fonts(xmlEscape(hl.font)) : '') : fonts(headFace);
    const center = l === 1 && look.theme?.centerTitle ? '<w:jc w:val="center"/>' : '';
    const pageBreak = l === 1 && si.h1PageBreak ? '<w:pageBreakBefore/>' : '';
    const numPr = l <= numberedLevels ? `<w:numPr>${l > 1 ? `<w:ilvl w:val="${l - 1}"/>` : ''}<w:numId w:val="${HEADING_NUM}"/></w:numPr>` : '';
    const before = l === 1 ? (si.h1PageBreak ? 0 : 400) : l === 2 ? 320 : 220;
    return `<w:style w:type="paragraph" w:styleId="Heading${l}"><w:name w:val="heading ${l}"/>`
      + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>'
      + `<w:pPr><w:keepNext/><w:keepLines/>${pageBreak}${numPr}${hl.bdr}<w:spacing w:before="${before}" w:after="${l === 1 ? 160 : 100}" w:line="240" w:lineRule="auto"/>${center}<w:outlineLvl w:val="${l - 1}"/></w:pPr>`
      + `<w:rPr>${face}${bold}${hl.caps ? '<w:caps/>' : ''}<w:color w:val="${hl.color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  };
  // TOC entries: the number at the left, the text at a tab, the page at a dotted right tab.
  const toc = (l: number): string => {
    const ind = HEADING_INDENT[l - 1]!;
    const left = 284 * (l - 1); // where the entry starts; its text starts one number-width further in
    const tabs = numbering !== 'none'
      ? `<w:tabs><w:tab w:val="left" w:pos="${left + ind}"/><w:tab w:val="right" w:leader="dot" w:pos="${si.textWidth}"/></w:tabs>`
      : `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${si.textWidth}"/></w:tabs>`;
    const indXml = numbering !== 'none' ? `<w:ind w:left="${left + ind}" w:hanging="${ind}"/>` : `<w:ind w:left="${(l - 1) * 284}"/>`;
    return `<w:style w:type="paragraph" w:styleId="TOC${l}"><w:name w:val="toc ${l}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>`
      + `<w:uiPriority w:val="39"/><w:unhideWhenUsed/><w:pPr>${tabs}<w:spacing w:before="${l === 1 ? 120 : 0}" w:after="${l === 1 ? 40 : 30}"/>${indXml}</w:pPr>`
      + `${l === 1 ? '<w:rPr><w:b/><w:bCs/></w:rPr>' : ''}</w:style>`;
  };
  const appendix = numbering !== 'none'
    ? '<w:style w:type="paragraph" w:styleId="AppendixHeading"><w:name w:val="Appendix Heading"/><w:basedOn w:val="Heading1"/><w:next w:val="Normal"/><w:qFormat/>'
      + `<w:pPr><w:numPr><w:numId w:val="${APPENDIX_NUM}"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style>` : '';
  const titleSize = si.plain ? 48 : hp(Math.min(28, bp.sizes.title));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr>${fonts(bodyFace)}`
    + `<w:sz w:val="${si.plain ? 22 : hp(bp.sizes.body)}"/><w:szCs w:val="${si.plain ? 22 : hp(bp.sizes.body)}"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl/>${justify}</w:pPr><w:rPr><w:color w:val="1A1A1A"/></w:rPr></w:style>`
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + `<w:pPr><w:spacing w:after="240" w:line="240" w:lineRule="auto"/>${look.theme?.centerTitle ? '<w:jc w:val="center"/>' : ''}</w:pPr><w:rPr>`
    + `${si.plain ? (look.theme ? fonts(xmlEscape(DOCX_FONTS[look.faces.heading])) : '') : fonts(headFace)}`
    + `${look.fonts.heading.ownWeight && !si.plain ? '' : '<w:b/>'}<w:sz w:val="${titleSize}"/><w:szCs w:val="${titleSize}"/></w:rPr></w:style>`
    + '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="52525B"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>'
    + [1, 2, 3, 4, 5, 6].map(heading).join('')
    + appendix
    // Front-matter headings (Contents, Document control): heading looks, outside the outline and the numbering.
    + '<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:next w:val="Normal"/>'
    + '<w:uiPriority w:val="39"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:pageBreakBefore w:val="0"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>'
    + '<w:spacing w:before="0" w:after="240"/><w:outlineLvl w:val="9"/></w:pPr></w:style>'
    + [1, 2, 3, 4].map(toc).join('')
    + '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + `<w:pPr><w:spacing w:before="80" w:after="200"/></w:pPr><w:rPr><w:color w:val="3F3F46"/><w:sz w:val="${si.plain ? 18 : hp(Math.max(8, bp.sizes.body - 1.5))}"/><w:szCs w:val="18"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>`
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D4D4D8"/></w:pBdr><w:ind w:left="360"/></w:pPr>'
    + '<w:rPr><w:color w:val="52525B"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:spacing w:after="80"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>'
    + '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr>'
    + '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/>'
    + '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/><w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/></w:rPr></w:style>'
    + `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="${si.accent}"/><w:u w:val="single"/></w:rPr></w:style>`
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>'
    + '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0"/><w:jc w:val="left"/></w:pPr><w:tblPr><w:tblBorders>'
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
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
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
  /** What the document stores (a cover it asked for is drawn even for a short document). */
  stored?: Partial<DocSettings>;
  visuals?: Map<string, RenderedVisual>;
  headings?: HeadingInfo[];
  /** Insert the TOC after the title/cover (settings.toc without a marker in the text). */
  tocAtStart?: boolean;
  /** Body page of each heading (heading id → page), from a PDF pass — the TOC's page numbers. */
  pageNumbers?: Map<string, number>;
  /** The layout plan, when the caller already made it (the PDF pass uses the same one). */
  plan?: DocPlan;
}

/** Characters of table text that fit across `twipsWide` at `pt` (an average lowercase glyph of Segoe UI or Calibri is about 0.53 em). */
export function tableCapacity(twipsWide: number, pt: number): number {
  return Math.round(twipsWide / 20 / (pt * 0.53));
}

export async function toDocx(input: DocxInput): Promise<Uint8Array> {
  const s = input.settings ?? DEFAULT_SETTINGS;
  const headings = input.headings ?? [];
  const date = input.date ?? new Date();
  const dateText = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const page = pageTwips(s);
  const textWidth = page.w - twips(s.margins.left) - twips(s.margins.right);
  const plan = input.plan ?? planDocument(input.tree, {
    title: input.title, settings: s, headings, ...(input.stored ? { stored: input.stored } : {}),
    capacity: tableCapacity(textWidth, Math.max(8.5, resolveLook(s).blueprint.sizes.body - 1)),
  });
  const b = new Builder(input.resolveImage, s, input.visuals ?? new Map(), headings, plan);
  const f = frontModel(plan, s, input.title, dateText);
  const look = b.look;
  const bp = b.bp;
  const plain = bp.id === 'general' && !look.theme;
  await b.loadImages(input.tree, s.cover?.enabled && s.cover.logo ? [s.cover.logo] : []);
  b.tocXml = tocXml(b, input.pageNumbers);
  const values = { title: input.title, date: dateText, ...f.values };

  // ── Front: cover page, control page, contents — each a section of its own ──
  const sections: { content: string; kind: 'cover' | 'front' | 'body'; bleed?: boolean }[] = [];
  const hasCover = plan.coverPage && Boolean(s.cover?.enabled);
  if (hasCover) {
    const layout = bp.cover;
    const content = layout === 'band' ? bandCover(b, f, page, bp.band ?? 'top')
      : layout === 'title-block' ? titleBlockCover(b, f)
        : coverXml(b, input.title, s, dateText);
    sections.push({ content, kind: 'cover', bleed: layout === 'band' });
    b.titleShown = true;
  }
  const front: string[] = [];
  if (plan.control === 'page') front.push(controlPage(b, f));
  if (plan.tocFront && hasCover) {
    if (front.length) front.push(para('<w:r><w:br w:type="page"/></w:r>'));
    front.push(b.tocXml);
  }
  if (front.length) sections.push({ content: front.join(''), kind: 'front' });

  // ── Body ──
  const top: string[] = [];
  if (!hasCover) {
    const layout = bp.cover;
    if (layout === 'masthead' && !plan.ownCover) { top.push(mastheadXml(b, f)); b.titleShown = true; }
    else if (layout === 'academic' && !plan.ownCover) { top.push(academicTitle(b, f)); b.titleShown = true; }
    else if ((layout === 'band' || layout === 'title-block') && !plan.ownCover) {
      // A family cover suppressed for a short document: its title and metadata head page one instead.
      top.push(para(run(input.title, {}), '<w:pStyle w:val="Title"/>'));
      const meta = coverPairs(f).filter(([k]) => k !== 'Classification');
      if (meta.length) top.push(para(meta.map(([k, v]) => run(`${k}: `, { color: '71717A', size: 18 }) + run(v, { size: 18 })).join(run('   ·   ', { color: 'A1A1AA', size: 18 })), '<w:spacing w:after="360"/>'));
      b.titleShown = true;
    } else if (input.showTitle && input.title && !plan.ownCover) {
      top.push(para(run(input.title, {}), `<w:pStyle w:val="Title"/>${bp.id === 'legal' ? '<w:jc w:val="center"/>' : ''}`));
      b.titleShown = true;
    }
    if (plan.control === 'inline') top.push(controlBox(b, f));
    if (plan.tocFront || input.tocAtStart) top.push(b.tocXml + (bp.front.tocPage || plain ? para('<w:r><w:br w:type="page"/></w:r>') : ''));
  }
  b.body.push(...top);
  b.tocXml = plan.tocAtMarker ? b.tocXml : undefined;
  blocks(b, input.tree.children, { depth: 0, quote: false });
  if (plan.control === 'inline') b.body.push(controlEnd(b, f));
  if (b.body.length === 0) b.body.push(para(''));
  let bodyXml0 = b.body.join('');
  // The spacer after a table (which keeps two tables from merging) can spill onto a page of its own when the
  // table ends at the foot of a page and the next section starts a page anyway — a blank page. Drop it there.
  if (plan.h1PageBreak) bodyXml0 = bodyXml0.replace(/<w:p><w:pPr><w:spacing w:after="120"\/><\/w:pPr><\/w:p>(?=<w:p><w:pPr><w:pStyle w:val="(?:Heading1|AppendixHeading)"\/>)/g, '');
  sections.push({ content: bodyXml0, kind: 'body' });
  const sectioned = sections.length > 1;

  // ── Headers and footers ──
  const parts: Record<string, string> = {};
  const right = textWidth;
  const font = look.fonts.body.word;
  const ruled = look.theme?.header === 'rule' || Boolean(bp.header);
  const hfPara = (content: string, style: 'Header' | 'Footer', rule = false): string =>
    para(content, `<w:pStyle w:val="${style}"/>${rule ? `<w:pBdr><w:${style === 'Header' ? 'bottom' : 'top'} w:val="single" w:sz="4" w:space="4" w:color="D4D4D8"/></w:pBdr>` : ''}`
      + `<w:tabs><w:tab w:val="right" w:pos="${right}"/></w:tabs>`);
  const watermark = s.watermark ? watermarkXml(s.watermark, font) : '';
  // A letter's header text is its letterhead, on the first page only.
  const letterhead = look.theme?.header === 'letterhead' && Boolean(s.header);
  const banner = look.classification
    ? para(run(look.classification, { bold: true, color: 'B91C1C', size: 16 }), '<w:pStyle w:val="Header"/><w:spacing w:after="60"/><w:jc w:val="center"/>') : '';
  const footerBanner = banner.replace('w:val="Header"', 'w:val="Footer"').replace('<w:spacing w:after="60"/>', '<w:spacing w:before="60" w:after="0"/>');
  const pagesField = sectioned ? 'SECTIONPAGES' : 'NUMPAGES';
  // Slots: the document's own header/footer text takes the left slot; the family fills the rest.
  const headLeft = s.header && !letterhead ? expandFields(s.header, values) : s.header ? '' : expandRunning(bp.header?.left, values);
  const headRight = letterhead ? '' : expandRunning(bp.header?.right, values);
  const footLeft = s.footer ? expandFields(s.footer, values) : expandRunning(bp.footer?.left, values);
  const pageSlot = /\{page\}/i.test(s.footer ?? '') ? '' : s.pageNumbers ? (bp.footer?.right ?? 'Page {page} of {pages}') : '';
  const footRight = expandRunning(pageSlot, values);
  const twoSlots = (l: string, r: string, pf: string, fmt = ''): string =>
    hfText(l, pf, fmt) + (r ? `<w:r><w:tab/></w:r>${hfText(r, pf, fmt)}` : '');
  const headerBody = headLeft || headRight ? twoSlots(headLeft, headRight, pagesField) : '';
  const footerBody = footLeft || footRight ? twoSlots(footLeft, footRight, pagesField) : '';
  const refs: Record<string, string[]> = { cover: [], front: [], body: [] };
  // Numbered per kind (header1, footer1, header2 …): the body's own come first, so their names are stable.
  const partNo = { hdr: 0, ftr: 0 };
  const addPart = (kind: 'cover' | 'front' | 'body', tag: 'hdr' | 'ftr', content: string, type: 'default' | 'first'): void => {
    const name = `${tag === 'hdr' ? 'header' : 'footer'}${++partNo[tag]}.xml`;
    parts[name] = hfPart(tag, content);
    const rid = b.rel(`${R_NS}/${tag === 'hdr' ? 'header' : 'footer'}`, name);
    refs[kind]!.push(`<w:${tag === 'hdr' ? 'headerReference' : 'footerReference'} w:type="${type}" r:id="${rid}"/>`);
  };
  addPart('body', 'hdr', banner + hfPara(watermark + headerBody, 'Header', ruled && Boolean(headerBody)), 'default');
  addPart('body', 'ftr', hfPara(footerBody, 'Footer', ruled && Boolean(footerBody)) + footerBanner, 'default');
  if (letterhead && !sectioned) {
    const name = expandFields(s.header!, values).replace(/\{page\}|\{pages\}/gi, '');
    const lh = para(`${watermark}${run(name, { bold: true, color: b.accent, size: 36 })}<w:r><w:tab/></w:r>${run(dateText, { color: '71717A', size: 18 })}`,
      `<w:pStyle w:val="Header"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" w:color="${b.accent}"/></w:pBdr>`
      + `<w:tabs><w:tab w:val="right" w:pos="${right}"/></w:tabs><w:spacing w:after="240"/>`);
    addPart('body', 'hdr', banner + lh, 'first');
    addPart('body', 'ftr', hfPara(footerBody, 'Footer') + footerBanner, 'first');
  }
  if (sections.some(x => x.kind === 'cover')) {
    // The cover: no running text — only the watermark and a classification. A full-bleed cover has no room for a
    // banner (the band would be pushed onto a second page); its metadata names the classification instead.
    // A full-bleed cover's header and footer stay empty (a banner would sit on the band); the metadata names the classification.
    const bleed = sections.some(x => x.kind === 'cover' && x.bleed);
    const hairline = (style: string): string => para(watermark && style === 'Header' ? watermark : '',
      `<w:pStyle w:val="${style}"/><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr>`);
    addPart('cover', 'hdr', bleed ? hairline('Header') : banner + hfPara(watermark, 'Header'), 'default');
    addPart('cover', 'ftr', bleed ? hairline('Footer') : hfPara('', 'Footer') + footerBanner, 'default');
  }
  if (sections.some(x => x.kind === 'front')) {
    // Front matter: the running header, a roman page number.
    addPart('front', 'hdr', banner + hfPara(watermark + headerBody, 'Header', ruled && Boolean(headerBody)), 'default');
    addPart('front', 'ftr', hfPara(s.pageNumbers ? twoSlots('', '{page}', pagesField, ' \\* roman') : '', 'Footer') + footerBanner, 'default');
  }
  // headerReference elements precede footerReference ones in sectPr.
  for (const k of Object.keys(refs)) refs[k]!.sort((x, y) => Number(y.startsWith('<w:headerReference')) - Number(x.startsWith('<w:headerReference')));

  const m = s.margins;
  const sectPr = (kind: 'cover' | 'front' | 'body'): string => {
    const mar = `<w:pgMar w:top="${twips(m.top)}" w:right="${twips(m.right)}" w:bottom="${twips(m.bottom)}" w:left="${twips(m.left)}" w:header="567" w:footer="567" w:gutter="0"/>`;
    const num = kind === 'front' ? '<w:pgNumType w:fmt="lowerRoman" w:start="1"/>' : kind === 'body' && sectioned ? '<w:pgNumType w:start="1"/>' : '';
    return `<w:sectPr>${refs[kind]!.join('')}<w:type w:val="nextPage"/><w:pgSz w:w="${page.w}" w:h="${page.h}"${s.orientation === 'landscape' ? ' w:orient="landscape"' : ''}/>`
      + `${mar}${num}${kind === 'body' && letterhead && !sectioned ? '<w:titlePg/>' : ''}</w:sectPr>`;
  };
  // Every section but the last ends in a paragraph that carries its sectPr; the last one's is the body's own.
  const bodyXml = sections.map((x, i) => (i < sections.length - 1
    ? `${x.content}<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${sectPr(x.kind)}</w:pPr></w:p>`
    : x.content + sectPr(x.kind))).join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" `
    + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    + `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="${WPS_NS}" xmlns:mc="${MC_NS}" ${VML_NS}>`
    + `<w:body>${bodyXml}</w:body></w:document>`;

  const hasToc = bodyXml.includes(' TOC \\o ');
  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${W_NS}">`
    // Word refreshes fields on open (TOC page numbers, NUMPAGES) — it asks the reader first.
    + `${hasToc ? '<w:updateFields w:val="true"/>' : ''}<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>`
    + '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';

  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/>`
    + `<Relationship Id="rId2" Type="${R_NS}/numbering" Target="numbering.xml"/>`
    + `<Relationship Id="rId3" Type="${R_NS}/settings" Target="settings.xml"/>`
    + b.rels.map(r => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlEscape(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')
    + '</Relationships>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/>`
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>';

  const when = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const kind = f.kicker ? f.kicker.charAt(0) + f.kicker.slice(1).toLowerCase() : '';
  const keywords = [kind, bp.id !== 'general' ? bp.label : '', f.values.client].filter(Boolean).join(', ');
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties '
    + 'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" '
    + 'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${xmlEscape(input.title)}</dc:title>${kind ? `<dc:subject>${xmlEscape(kind)}</dc:subject>` : ''}`
    + `${f.values.preparedBy ? `<dc:creator>${xmlEscape(f.values.preparedBy)}</dc:creator>` : ''}`
    + `${keywords ? `<cp:keywords>${xmlEscape(keywords)}</cp:keywords>` : ''}`
    + `${s.cover?.subtitle ? `<dc:description>${xmlEscape(s.cover.subtitle)}</dc:description>` : ''}`
    + `<cp:revision>1</cp:revision>${f.values.status ? `<cp:contentStatus>${xmlEscape(f.values.status)}</cp:contentStatus>` : ''}`
    + `<cp:version>${xmlEscape(f.values.version)}</cp:version>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified>`
    + '</cp:coreProperties>';
  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
    + `<Application>AICO</Application>${f.values.client ? `<Company>${xmlEscape(f.values.client)}</Company>` : ''}</Properties>`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes(b.media, Object.keys(parts))),
    '_rels/.rels': strToU8(rootRels),
    'docProps/core.xml': strToU8(core),
    'docProps/app.xml': strToU8(app),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(stylesXml({
      look, bp, numbering: plan.numbering, shift: shiftOf(plan), textWidth, accent: b.accent, plain, h1PageBreak: plan.h1PageBreak,
    })),
    'word/numbering.xml': strToU8(numberingXml(b.nums, plan.numbering, b.accent)),
    'word/settings.xml': strToU8(settingsXml),
    'word/_rels/document.xml.rels': strToU8(docRels),
  };
  for (const [name, xml] of Object.entries(parts)) files[`word/${name}`] = strToU8(xml);
  for (const media of b.media) files[`word/media/${media.name}`] = media.bytes;
  return zipSync(files, { level: 6 });
}

/** Markdown depth minus logical level of the first section heading (0 when the text has none). */
function shiftOf(plan: DocPlan): number {
  const h = plan.headings.find(x => !x.isTitle);
  return h ? h.info.depth - h.level : 0;
}
