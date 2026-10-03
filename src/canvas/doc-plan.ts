/**
 * The layout plan of one export: every decision the Word writer and the
 * HTML/PDF writer must make *the same way*, made once.
 *
 * - **Heading levels.** Sections are written as `##` (the canvas title is the
 *   document's title, not a heading), so a document's top level is usually 2.
 *   The owner's export had no Heading 1 at all — Word's navigation pane, its
 *   TOC and every numbering scheme start at Heading 1. The plan shifts the
 *   levels so the top section *is* level 1, and closes skipped levels (an H2
 *   followed by an H4 is a level-1 then a level-2), and reads an opening H1
 *   that repeats the title as the title.
 * - **Numbering.** The family's scheme (`doc-blueprints`), or decimal when the
 *   theme numbers or the author typed numbers into most top-level headings
 *   (then the typed ones are removed — `doc-layout` `stripHeadingNumber`).
 *   "Appendix A — …" top-level headings are lettered.
 * - **Captions.** A paragraph `Table: …` beside a table, `Figure: …` beside a
 *   diagram, chart or picture (or a picture's title) becomes its numbered
 *   caption — "Table 3 — …" — and is not printed again as a paragraph.
 * - **Tables.** Variant (grid / key-value / matrix), numeric columns, a total
 *   row and content-based column widths (`doc-layout`).
 * - **Front matter.** Whether this document gets the family's cover page,
 *   control page and contents. A short document (a one-page flow diagram that
 *   happens to be "technical") does not: a cover and a control page in front
 *   of one page of content is ceremony, not design. A cover the document's own
 *   settings ask for is always drawn.
 *
 * Pure: no I/O, no rendering.
 *
 * @module canvas/doc-plan
 */

import type { Code, Heading, Paragraph, Root, RootContent, Table } from 'mdast';
import { plainText, isTocMarker, type HeadingInfo } from './doc-model.js';
import { controlValues, type DocSettings } from './doc-settings.js';
import { docTypeById } from './doc-types.js';
import { visualForCode } from './visuals.js';
import { parseImageAttrs } from './infographics.js';
import { docBlockKind } from '../../shared/ui/canvas/doc-blocks.js';
import { coverIsPage, resolveBlueprint, type Blueprint, type NumberingScheme } from '../../shared/ui/canvas/doc-blueprints.js';
import {
  appendixHeading, columnWidths, headingLabels, isTotalRow, numericColumns, stripHeadingNumber, tableVariant, typedNumbering,
  UNNUMBERED_SECTIONS, type TableVariant,
} from '../../shared/ui/canvas/doc-layout.js';
import { themeById } from '../../shared/ui/canvas/doc-themes.js';

export interface PlannedHeading {
  info: HeadingInfo;
  /** Logical level, 1 = a top-level section. */
  level: number;
  /** The text to show (a typed number removed when the export numbers). */
  text: string;
  /** The number shown before it ("1.2", "Appendix A"), if numbered. */
  label?: string;
  /** Appendix letter, for a top-level appendix heading. */
  appendix?: string;
  /** Inside an appendix (numbered A.1 …). */
  inAppendix?: string;
  /** The opening H1 that repeats the title — shown as the title, not a section. */
  isTitle?: boolean;
  /** Outside the numbering (Abstract, References and their subsections). */
  unnumbered?: boolean;
}

export interface Caption { kind: 'table' | 'figure'; n: number; text: string }

export interface TablePlan {
  variant: TableVariant;
  /** Fractions of the table width, summing to 1. */
  widths: number[];
  numeric: boolean[];
  /** The last row is a total. */
  total: boolean;
}

export interface DocPlan {
  blueprint: Blueprint;
  numbering: NumberingScheme;
  headings: PlannedHeading[];
  byNode: Map<Heading, PlannedHeading>;
  /** Keyed by the table / visual code block / figure paragraph. */
  captions: Map<unknown, Caption>;
  /** Caption paragraphs that are printed as captions instead. */
  consumed: Set<unknown>;
  tables: Map<Table, TablePlan>;
  /** The cover is its own page (the family's layout, or a classic cover the settings ask for). */
  coverPage: boolean;
  /** The document-control page / box. */
  control: 'page' | 'inline' | 'none';
  /** Contents in the front matter (after the cover/control), not at a marker in the text. */
  tocFront: boolean;
  /** A TOC at a marker inside the text. */
  tocAtMarker: boolean;
  /** Each top-level section starts a page: the family's choice, for a document with a cover page (else page one would hold only the title). */
  h1PageBreak: boolean;
  /** The document opens with its own ```cover block. */
  ownCover: boolean;
  /** About how many words of prose. */
  words: number;
}

const CAPTION = /^\s*(table|figure|fig\.?|diagram|chart)\s*\d*\s*[:.—–-]\s*(\S.*)$/i;

function captionOf(node: RootContent | undefined): { kind: 'table' | 'figure'; text: string } | undefined {
  if (!node || node.type !== 'paragraph') return undefined;
  const t = plainText(node as never).replace(/\s+/g, ' ').trim();
  const m = CAPTION.exec(t);
  if (!m || t.length > 300) return undefined;
  return { kind: /^table/i.test(m[1]!) ? 'table' : 'figure', text: m[2]!.trim() };
}

/** A paragraph holding only one picture (and its `{width=…}` attributes). */
export function figureImage(n: Paragraph): { url: string; alt?: string | null; title?: string | null } | undefined {
  const kids = n.children.filter(c => !(c.type === 'text' && !c.value.trim()));
  const img = kids[0];
  if (!img || img.type !== 'image') return undefined;
  if (kids.length === 2 && kids[1]!.type === 'text') {
    const parsed = parseImageAttrs(kids[1]!.value.trim());
    if (!parsed || parsed.rest.trim()) return undefined;
  } else if (kids.length !== 1) return undefined;
  return img;
}

function isFigure(node: RootContent): boolean {
  if (node.type === 'code') {
    const v = visualForCode((node as Code).lang, (node as Code).value);
    return Boolean(v && (v.kind === 'chart' || v.kind === 'diagram'));
  }
  return node.type === 'paragraph' && Boolean(figureImage(node));
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export interface PlanInput {
  title: string;
  settings: DocSettings;
  /** What the document itself stores (to tell an asked-for cover from a family default). */
  stored?: Partial<DocSettings>;
  headings: HeadingInfo[];
  /** Characters of table text across the text width (for column widths). */
  capacity?: number;
}

export function planDocument(tree: Root, input: PlanInput): DocPlan {
  const s = input.settings;
  const bp = resolveBlueprint(s);
  const theme = themeById(s.theme) ?? themeById(bp.theme);
  const kids = tree.children;
  const firstContent = kids.find(n => n.type !== 'definition' && !(n.type === 'html' && !isTocMarker(n)));
  const ownCover = firstContent?.type === 'code' && docBlockKind((firstContent as Code).lang) === 'cover';

  // ── Headings: title, levels, numbering, labels ──
  const titleNode = firstContent?.type === 'heading' && (firstContent as Heading).depth === 1
    && norm(plainText(firstContent as never)) === norm(input.title) ? firstContent as Heading : undefined;
  const body = input.headings.filter(h => h.node !== titleNode);
  const top = Math.min(6, ...body.map(h => h.depth));
  const shift = Number.isFinite(top) ? top - 1 : 0;
  const levels: number[] = [];
  let prev = 0;
  for (const h of body) {
    const lv = Math.max(1, Math.min(h.depth - shift, prev + 1));
    levels.push(lv);
    prev = lv;
  }
  const topTexts = body.filter((_, i) => levels[i] === 1).map(h => h.text);
  let scheme: NumberingScheme = bp.numbering;
  if (scheme === 'none' && (theme?.numbered || typedNumbering(topTexts))) scheme = 'decimal';
  let appendix: string | undefined;
  const planned: PlannedHeading[] = body.map((info, i) => {
    const level = levels[i]!;
    if (level === 1) appendix = undefined;
    const app = scheme !== 'none' && level === 1 ? appendixHeading(info.text) : undefined;
    if (app) appendix = app.letter;
    const text = app ? (app.rest || info.text) : scheme !== 'none' ? stripHeadingNumber(info.text) : info.text;
    return { info, level, text, ...(app ? { appendix: app.letter } : {}), ...(appendix && !app ? { inAppendix: appendix } : {}) };
  });
  // Abstract and References stand outside a paper's numbering (any family: they are never "section 7").
  let outside = false;
  for (const p of planned) {
    if (p.level === 1) outside = !p.appendix && UNNUMBERED_SECTIONS.test(p.text);
    if (outside) p.unnumbered = true;
  }
  const labels = headingLabels(planned.map(p => ({
    level: p.level, ...(p.appendix ? { appendix: p.appendix } : {}), ...(p.unnumbered ? { unnumbered: true } : {}),
  })), scheme);
  planned.forEach((p, i) => { if (labels[i]) p.label = labels[i]; });
  const headings: PlannedHeading[] = [
    ...(titleNode ? [{ info: input.headings.find(h => h.node === titleNode)!, level: 0, text: plainText(titleNode as never), isTitle: true }] : []),
    ...planned,
  ];

  // ── Captions and tables ──
  const captions = new Map<unknown, Caption>();
  const consumed = new Set<unknown>();
  const tables = new Map<Table, TablePlan>();
  const count = { table: 0, figure: 0 };
  kids.forEach((node, i) => {
    const want: 'table' | 'figure' | undefined = node.type === 'table' ? 'table' : isFigure(node) ? 'figure' : undefined;
    if (!want) return;
    // A table's caption sits above it (the convention), a figure's below; either side is accepted.
    const order = want === 'table' ? [i - 1, i + 1] : [i + 1, i - 1];
    let found: { kind: 'table' | 'figure'; text: string } | undefined;
    for (const j of order) {
      const c = captionOf(kids[j]);
      if (c && c.kind === want && !consumed.has(kids[j])) { found = c; consumed.add(kids[j]); break; }
    }
    if (!found && want === 'figure' && node.type === 'paragraph') {
      const title = figureImage(node)?.title;
      if (title) found = { kind: 'figure', text: title };
    }
    if (found) captions.set(node, { kind: want, n: ++count[want], text: found.text });
  });
  const walkTables = (n: { type: string; children?: unknown[] }): void => {
    if (n.type === 'table') {
      const t = n as unknown as Table;
      const rows = t.children.map(r => r.children.map(c => plainText(c as never).replace(/\s+/g, ' ').trim()));
      const variant = tableVariant(rows);
      tables.set(t, {
        variant, widths: columnWidths(rows, { capacity: input.capacity ?? 95, variant }), numeric: numericColumns(rows),
        total: rows.length > 2 && isTotalRow(rows[rows.length - 1]!),
      });
    }
    for (const c of (n.children ?? []) as never[]) walkTables(c);
  };
  walkTables(tree as never);

  // ── Front matter ──
  let words = 0;
  const countWords = (n: { type: string; value?: string; children?: unknown[] }): void => {
    if (n.type === 'text' && n.value) words += n.value.split(/\s+/).filter(Boolean).length;
    if (n.type === 'code') return;
    for (const c of (n.children ?? []) as never[]) countWords(c);
  };
  countWords(tree as never);
  const topCount = planned.filter(p => p.level === 1).length;
  const substantial = words >= 700 || topCount >= 5;
  const askedCover = input.stored?.cover?.enabled === true;
  const coverOn = Boolean(s.cover?.enabled) && !ownCover && (substantial || askedCover);
  const coverPage = coverOn && coverIsPage(bp.cover);
  const control: DocPlan['control'] = bp.front.control === 'page' ? (coverPage ? 'page' : 'none')
    : bp.front.control === 'inline' && !ownCover ? 'inline' : 'none';
  // A marker is the author asking for contents: honoured where it stands (at the top, it joins the front matter).
  // Without one, the family's or the document's `toc` adds contents only to a document long enough to need them.
  const markerFirst = firstContent !== undefined && isTocMarker(firstContent);
  const hasMarker = kids.some(n => isTocMarker(n));
  const tocFront = markerFirst ? planned.length > 0
    : !hasMarker && Boolean(s.toc) && planned.length >= 3 && (substantial || input.stored?.toc === true);
  return {
    blueprint: bp, numbering: scheme, headings, byNode: new Map(headings.map(h => [h.info.node, h])), captions, consumed, tables,
    coverPage, control, tocFront, tocAtMarker: hasMarker && !markerFirst,
    // A page per section only where sections are long enough to fill one: five short sections of a short report
    // each alone on a page is padding, not design.
    h1PageBreak: bp.h1PageBreak && coverPage && (words >= 900 || words / Math.max(1, topCount) >= 150), ownCover, words,
  };
}

/** What the cover, the control page and the running text say. */
export interface FrontModel {
  kicker: string;
  title: string;
  subtitle?: string;
  date: string;
  values: ReturnType<typeof controlValues>;
  /** Document information rows (label, value), empty values left out except version/status/date. */
  info: [string, string][];
  revisions: string[][];
  approvals: string[][];
  distribution: string[][];
}

export function frontModel(plan: DocPlan, s: DocSettings, title: string, dateText: string): FrontModel {
  const v = controlValues(s);
  const c = s.control ?? {};
  const kicker = (docTypeById(s.docType)?.title.split(' / ')[0] ?? plan.blueprint.kicker ?? '').toUpperCase();
  const date = s.cover?.date ?? dateText;
  const info: [string, string][] = ([
    ['Client', v.client], ['Reference', v.reference], ['Version', v.version], ['Status', v.status],
    ['Classification', v.classification], ['Prepared by', v.preparedBy], ['Owner', c.owner ?? ''], ['Date', date],
  ] as [string, string][]).filter(([, x]) => x.trim());
  const revisions = (c.revisions?.length ? c.revisions : [{ version: v.version, date, author: v.preparedBy, description: 'Initial draft' }])
    .map(r => [r.version, r.date ?? '', r.author ?? '', r.description ?? '']);
  const roles: { role: string; name?: string; date?: string }[] = c.approvals ?? plan.blueprint.front.approvals.map(role => ({ role }));
  const approvals = roles.map(a => [a.name ?? '', a.role, '', a.date ?? '']);
  const distribution = (c.distribution ?? []).map(d => [d.name, d.organisation ?? '', d.role ?? '']);
  return {
    kicker, title: s.cover?.title ?? title, ...(s.cover?.subtitle ? { subtitle: s.cover.subtitle } : {}), date, values: v,
    info, revisions, approvals, distribution,
  };
}
