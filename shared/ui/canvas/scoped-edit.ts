/**
 * Scoped ("inline") AI edits: change ONE part of a document — a selection in
 * a paragraph, a block, a table or some of its cells, a chart, a diagram, an
 * image caption, a section — and provably nothing else. ADR 0024.
 *
 * ## Why this exists
 *
 * "Ask AICO" on a selection (0.30) sent a chat message quoting the passage;
 * the agent then re-read the whole canvas and edited it with find/replace or a
 * whole-tab `update`. Nothing held it to the passage: a request to fix one
 * sentence could re-word the next paragraph, normalise a table, drop a
 * citation or renumber headings, and the person only found out afterwards.
 * The scope was a request in the prompt, which is exactly what this codebase
 * does not rely on (AGENTS.md §4.6).
 *
 * So the scope is enforced here, in code, by construction and by check:
 *
 * - **Resolve**: a target names whole blocks (by `blockKeys` — content
 *   hashes, so they survive edits elsewhere) plus an optional range inside
 *   one block, a cell range of a table, or a block's caption. It resolves to
 *   a {@link ResolvedPart}: the exact source span and the structured form the
 *   model edits (table rows, chart option, mermaid source, the inner text of
 *   a heading or callout — never the markup around it).
 * - **Contract**: the model answers with a patch for exactly that kind
 *   ({@link PartPatch}); {@link renderPatch} turns it back into Markdown for
 *   the span only. Heading marks and numbering, fence lines and the text
 *   around a selection are put back as they were, so the model cannot touch
 *   them even if it tries.
 * - **Validate**: {@link validatePatch} rejects a patch that changes the block
 *   type without being asked, breaks a table's shape, invents or drops
 *   numbers, loses links/citations/footnotes/cross-references, adds
 *   formatting nobody asked for, produces a chart ECharts cannot draw or a
 *   diagram that does not parse ({@link checkMermaid}), or merges with a
 *   neighbouring block ({@link applyPart} re-splits the result and compares
 *   every block outside the span).
 *
 * What the instruction allows is read deterministically from its words
 * ({@link intentOf}): "turn into a table" allows a type change, "add a
 * column" a shape change, "update the Q3 figure" a data change. A quick action
 * is just a well-worded instruction, so the same rules hold for typed ones.
 *
 * ## Shared by the engine, the editor and decks
 *
 * DOM-free and dependency-free: the engine (`src/canvas/inline-edit.ts`, the
 * route and the Canvas tool's `edit_part`) and the editor (`InlineEdit.tsx`,
 * which applies an accepted patch) run the same code. A presentation resolves
 * its own element into a `ResolvedPart` (kind `text`/`table`/`chart`/
 * `mermaid`/`caption`, `span` over its own field) and reuses the contract,
 * validator and model call unchanged — the generic target is
 * `{docId, blockIds | slideId+elementId, range?}` ({@link PartTarget}).
 *
 * Deliberately not here: the model call and its prompt (engine data,
 * `src/canvas/inline-edit.ts`), and rendering (the editor).
 *
 * @module shared/ui/canvas/scoped-edit
 */

import { blockKeys, headingText, sectionPath, splitBlocks, type Block, type BlockKind } from './blocks';
import {
  fenced, imageLine, parseCallout, parseFence, parseImageLine, parseTable, tableToMarkdown,
  type ColAlign, type ImageModel, type TableModel,
} from './visual';
import { DIAGRAM_TYPES } from '../../widgets/diagram-types';

// ── Targets ──────────────────────────────────────────────────────────

/** A cell range of a table: body rows `r0..r1` (inclusive; -1 is the header row), columns `c0..c1`. */
export interface CellRange { r0: number; r1: number; c0: number; c1: number }

/**
 * What to edit. Documents name blocks; decks name a slide and an element.
 * `range` is character offsets into the (single) block's Markdown source.
 */
export interface PartTarget {
  docId: string;
  tab?: string;
  /** `blockKeys()` of the contiguous blocks targeted (documents). */
  blockIds?: string[];
  /** Presentations (decks): the slide, and the element on it. */
  slideId?: string;
  elementId?: string;
  range?: { start: number; end: number };
  cells?: CellRange;
  /** `section`: a heading plus every block under it. `caption`: an image's caption. */
  part?: 'section' | 'caption';
}

export type PartKind = 'text' | 'blocks' | 'table' | 'cells' | 'chart' | 'mermaid' | 'caption' | 'json';

export interface ResolvedPart {
  kind: PartKind;
  /** What the person sees: "Paragraph", "Table · rows 2–3", "Section “Scope” · 4 blocks". */
  label: string;
  /** A noun for the prompt: "paragraph", "table", "bar chart"… */
  what: string;
  /** The source span the patch replaces (always whole blocks for a document). */
  span: { start: number; end: number };
  /** Exactly `text.slice(span.start, span.end)`. */
  before: string;
  /** Block indexes `[from, to)` covered. */
  blocks: { from: number; to: number };
  blockKinds: BlockKind[];
  /** The text the model edits: inner text, table/chart/diagram source, JSON body. */
  editable: string;
  /** A selection inside `editable` (kind `text`): only this range changes. */
  selection?: { start: number; end: number };
  /** Markup put back around `editable` exactly as it was (heading marks and numbering, fence lines). */
  wrap?: { head: string; tail: string };
  table?: TableModel;
  cells?: CellRange;
  chart?: Record<string, unknown>;
  image?: ImageModel;
  /** A section target: its heading's level and text. */
  section?: { level: number; heading: string };
  /** The block's section path ("2 Scope › 2.1 Services") — where it is. */
  where: string;
  /**
   * How the target is shown to the model, when its kind's default wording does
   * not fit (a deck element: "The slide's title", with its layout limits).
   */
  describe?: string;
  /** The part's kind never changes (a deck element): the prompt offers no Markdown alternative. */
  fixedKind?: boolean;
}

/** Longest part an inline edit takes; anything bigger is a job for the chat. */
export const MAX_PART_CHARS = 16_000;

const JSON_FENCES = new Set(['stats', 'timeline', 'steps', 'process', 'comparison', 'keyvalue', 'lineitems', 'riskmatrix', 'actions',
  'references', 'signature', 'meta', 'cover']);
const CHART_FENCES = new Set(['chart', 'echarts']);
const HEADING_HEAD = /^( {0,3}#{1,6}[ \t]+(?:(?:\d+(?:\.\d+)*\.?|[A-Z]\.|[IVXLC]+\.)[ \t]+)?)/;

type Resolve = { ok: true; part: ResolvedPart } | { ok: false; error: string };

/** A section: the heading at `h` and every block until the next heading of the same or a higher level. */
export function sectionEnd(blocks: readonly Block[], h: number): number {
  const level = blocks[h]!.level ?? 1;
  let to = h + 1;
  while (to < blocks.length && !(blocks[to]!.kind === 'heading' && (blocks[to]!.level ?? 1) <= level) && blocks[to]!.kind !== 'pending') to++;
  return to;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function rowsLabel(r: CellRange, t: TableModel): string {
  const allCols = r.c0 === 0 && r.c1 === t.header.length - 1;
  const allRows = r.r0 <= 0 && r.r1 === t.rows.length - 1;
  const col = r.c0 === r.c1 ? `column “${t.header[r.c0] ?? r.c0 + 1}”` : `columns ${r.c0 + 1}–${r.c1 + 1}`;
  const row = r.r0 === r.r1 ? (r.r0 < 0 ? 'header row' : `row ${r.r0 + 1}`) : `rows ${r.r0 < 0 ? 'header' : r.r0 + 1}–${r.r1 + 1}`;
  if (allRows) return col;
  if (allCols) return row;
  return `${row} · ${col}`;
}

/**
 * Resolve a document target against the tab's current text. Fails with a
 * reason a person (or the model, through `edit_part`) can act on.
 */
export function resolveTarget(text: string, target: Pick<PartTarget, 'blockIds' | 'range' | 'cells' | 'part'>): Resolve {
  const blocks = splitBlocks(text);
  const keys = blockKeys(blocks);
  const ids = target.blockIds ?? [];
  if (!ids.length) return { ok: false, error: 'no block named — select text or a block first' };
  const idx = ids.map(id => keys.indexOf(id));
  if (idx.some(i => i < 0)) return { ok: false, error: 'that part of the document changed since it was selected — select it again' };
  idx.sort((a, b) => a - b);
  for (let k = 1; k < idx.length; k++) if (idx[k] !== idx[k - 1]! + 1) return { ok: false, error: 'the selected blocks are not next to each other' };
  let from = idx[0]!;
  let to = idx[idx.length - 1]! + 1;
  if (target.part === 'section') {
    if (blocks[from]!.kind !== 'heading') return { ok: false, error: 'a section starts at a heading' };
    to = Math.max(to, sectionEnd(blocks, from));
  }
  const covered = blocks.slice(from, to);
  if (covered.some(b => b.kind === 'pending')) return { ok: false, error: 'part of that is still a placeholder AICO has not written — write it first' };
  const span = { start: covered[0]!.start, end: covered[covered.length - 1]!.end };
  const before = text.slice(span.start, span.end);
  if (before.length > MAX_PART_CHARS) {
    return { ok: false, error: `that part is ${before.length.toLocaleString()} characters; an inline edit takes up to ${MAX_PART_CHARS.toLocaleString()} — ask in the chat instead` };
  }
  const where = sectionPath(blocks, from);
  const base = { span, before, blocks: { from, to }, blockKinds: covered.map(b => b.kind), where };

  if (covered.length > 1 || target.part === 'section') {
    if (target.range || target.cells) return { ok: false, error: 'a range or cells can only be given for one block' };
    const head = covered[0]!;
    const section = target.part === 'section' ? { level: head.level ?? 1, heading: headingText(head) } : undefined;
    return {
      ok: true,
      part: {
        ...base, kind: 'blocks', editable: before,
        label: section ? `Section “${section.heading}” · ${covered.length} block${covered.length === 1 ? '' : 's'}` : `${covered.length} blocks`,
        what: section ? 'section' : 'passage of several blocks',
        ...(section ? { section } : {}),
      },
    };
  }

  const b = covered[0]!;
  const one = (p: Omit<ResolvedPart, keyof typeof base>): Resolve => {
    const part: ResolvedPart = { ...base, ...p };
    if (target.range) {
      if (part.kind !== 'text') return { ok: false, error: `a text range cannot be edited inside a ${part.what} — target the whole block` };
      const head = part.wrap?.head.length ?? 0;
      const s = target.range.start - head;
      const e = target.range.end - head;
      if (!(Number.isInteger(s) && Number.isInteger(e)) || s < 0 || e > part.editable.length || e <= s) {
        return { ok: false, error: 'the selected range is not inside the block\'s text' };
      }
      if (/\n[ \t]*\n/.test(part.editable.slice(s, e))) return { ok: false, error: 'the selection crosses a paragraph break — target the blocks instead' };
      part.selection = { start: s, end: e };
      part.label = `Selection in ${part.what}`;
    }
    if (target.cells && part.kind !== 'cells') return { ok: false, error: 'cells can only be given for a table' };
    return { ok: true, part };
  };

  switch (b.kind) {
    case 'heading': {
      const atx = HEADING_HEAD.exec(b.text);
      if (atx) {
        const closing = /[ \t]+#+[ \t]*$/.exec(b.text);
        const tail = closing ? closing[0] : '';
        return one({ kind: 'text', label: `Heading ${b.level ?? 1}`, what: 'heading', editable: b.text.slice(atx[1]!.length, b.text.length - tail.length), wrap: { head: atx[1]!, tail } });
      }
      const nl = b.text.lastIndexOf('\n');
      return one({ kind: 'text', label: `Heading ${b.level ?? 1}`, what: 'heading', editable: b.text.slice(0, nl), wrap: { head: '', tail: b.text.slice(nl) } });
    }
    case 'paragraph': {
      const img = parseImageLine(b.text);
      if (img) return one({ kind: 'caption', label: 'Image caption', what: 'image caption', editable: img.caption ?? '', image: img });
      if (target.part === 'caption') return { ok: false, error: 'that block is not an image' };
      return one({ kind: 'text', label: 'Paragraph', what: 'paragraph', editable: b.text });
    }
    case 'list':
      return one({ kind: 'text', label: 'List', what: /^\s*\d/.test(b.text) ? 'numbered list' : 'bulleted list', editable: b.text });
    case 'quote':
      return one({ kind: 'text', label: parseCallout(b.text) ? 'Callout' : 'Quote', what: parseCallout(b.text) ? 'callout' : 'quotation', editable: b.text });
    case 'table': {
      const t = parseTable(b.text);
      if (!t) return { ok: false, error: 'that table does not parse — edit its source' };
      if (target.cells) {
        const n = t.header.length;
        const r1 = Math.min(target.cells.r1, t.rows.length - 1);
        const c = { r0: Math.max(-1, target.cells.r0), r1, c0: Math.max(0, target.cells.c0), c1: Math.min(n - 1, target.cells.c1) };
        if (c.r0 > c.r1 || c.c0 > c.c1) return { ok: false, error: 'that cell range is outside the table' };
        const whole = c.r0 <= 0 && c.r1 === t.rows.length - 1 && c.c0 === 0 && c.c1 === n - 1;
        if (!whole) {
          return one({ kind: 'cells', label: `Table · ${rowsLabel(c, t)}`, what: 'table cells', editable: b.text, table: t, cells: c });
        }
      }
      return one({ kind: 'table', label: `Table · ${t.rows.length} rows × ${t.header.length} columns`, what: 'table', editable: b.text, table: t });
    }
    case 'code':
    case 'math': {
      const f = parseFence(b.text);
      if (!f) return one({ kind: 'text', label: b.kind === 'math' ? 'Maths' : 'Code', what: b.kind === 'math' ? 'maths block' : 'code block', editable: b.text });
      const lines = b.text.split('\n');
      const wrap = { head: `${lines[0]!}\n`, tail: `\n${lines[lines.length - 1]!}` };
      const inner = b.text.slice(wrap.head.length, b.text.length - wrap.tail.length);
      if (CHART_FENCES.has(f.lang)) {
        try {
          const spec = JSON.parse(inner) as unknown;
          if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
            const types = chartTypes(spec as Record<string, unknown>);
            return one({ kind: 'chart', label: `Chart · ${types.join(', ') || 'chart'}`, what: `${types[0] ?? ''} chart`.trim(), editable: inner, wrap, chart: spec as Record<string, unknown> });
          }
        } catch { /* not JSON: edited as text below */ }
      }
      if (f.lang === 'mermaid') {
        const kind = mermaidKind(inner);
        return one({ kind: 'mermaid', label: `Diagram · ${kind ?? 'mermaid'}`, what: `${kind ?? 'mermaid'} diagram`, editable: inner, wrap });
      }
      if (f.lang === 'callout') return one({ kind: 'text', label: 'Callout', what: 'callout', editable: inner, wrap });
      if (JSON_FENCES.has(f.lang)) {
        try {
          JSON.parse(inner);
          return one({ kind: 'json', label: cap(f.lang), what: `${f.lang} block`, editable: inner, wrap });
        } catch { /* line form: as text */ }
      }
      return one({ kind: 'text', label: f.lang ? `${cap(f.lang)} block` : 'Code', what: f.lang ? `${f.lang} block` : 'code block', editable: inner, wrap });
    }
    default:
      return { ok: false, error: `a ${b.kind === 'html' ? 'contents marker or HTML block' : b.kind} cannot be edited inline` };
  }
}

// ── The wire: editor ⇄ engine (`POST /api/canvas/edit-part`) ─────────

export interface PartEditRequest {
  tab?: string;
  /** A document names blocks; a deck names `slideId` and `elementId` (`deck-scoped-edit.ts`). */
  target: Pick<PartTarget, 'blockIds' | 'range' | 'cells' | 'part' | 'slideId' | 'elementId'>;
  instruction: string;
  /** The thread so far, oldest first: each instruction and what it proposed. */
  history?: Array<{ instruction: string; patch?: PartPatch }>;
  /** A problem the editor found in the last proposal (the browser's Mermaid parser). */
  retryError?: string;
}

export interface PartEditResponse {
  ok: boolean;
  error?: string;
  /** The resolved part (span, the exact text it replaces). */
  part?: Pick<ResolvedPart, 'kind' | 'label' | 'what' | 'span' | 'before' | 'blocks'> & { slideId?: string; elementId?: string };
  /** The span's new Markdown. */
  after?: string;
  patch?: PartPatch;
  note?: string;
  warnings: string[];
  errors: string[];
  unchanged?: boolean;
  attempts: number;
  model?: string;
  costUsd?: number;
  tabVersion?: number;
  /** Decks: the whole slide as it would be after the edit (the review draws it beside the current one). */
  slide?: Record<string, unknown>;
}

// ── Patches ──────────────────────────────────────────────────────────

export type PartPatch =
  | { kind: 'text'; text: string }
  | { kind: 'blocks'; markdown: string }
  | { kind: 'table'; header: string[]; rows: string[][]; align?: ColAlign[] }
  | { kind: 'cells'; cells: string[][] }
  | { kind: 'chart'; spec: Record<string, unknown> }
  | { kind: 'mermaid'; source: string }
  | { kind: 'caption'; caption: string }
  | { kind: 'json'; json: unknown };

/** The JSON a model must answer with, per part kind — the output contract, stated once. */
export function partContract(part: Pick<ResolvedPart, 'kind' | 'selection' | 'cells'>): string {
  switch (part.kind) {
    case 'text': return part.selection
      ? '{"text": "<the replacement for the selected passage ONLY — not the rest of the block>", "note": "<one short sentence>"}'
      : '{"text": "<the whole new text of the block, same kind of block, Markdown>", "note": "<one short sentence>"}';
    case 'blocks': return '{"markdown": "<the new Markdown for exactly these blocks>", "note": "<one short sentence>"}';
    case 'table': return '{"header": ["…"], "rows": [["…"]], "note": "<one short sentence>"} — every row has exactly as many cells as the header';
    case 'cells': {
      const c = part.cells!;
      return `{"cells": [["…"]], "note": "<one short sentence>"} — exactly ${c.r1 - c.r0 + 1} row(s) of ${c.c1 - c.c0 + 1} cell(s): the new values of the marked cells, in order`;
    }
    case 'chart': return '{"spec": {<the complete ECharts option>}, "note": "<one short sentence>"}';
    case 'mermaid': return '{"source": "<the complete Mermaid source, no ``` fence>", "note": "<one short sentence>"}';
    case 'caption': return '{"caption": "<the new caption, one line>", "note": "<one short sentence>"}';
    case 'json': return '{"json": {<the complete new block body>}, "note": "<one short sentence>"}';
  }
}

/** Read a model's answer. `markdown` is accepted for any kind — it is a type change, allowed only when asked. */
export function parsePatch(raw: string, part: Pick<ResolvedPart, 'kind'>): { ok: true; patch: PartPatch; note?: string } | { ok: false; error: string } {
  const json = extractJson(raw);
  if (!json) return { ok: false, error: 'the answer was not a JSON object' };
  const o = json as Record<string, unknown>;
  const note = typeof o.note === 'string' && o.note.trim() ? { note: o.note.trim().slice(0, 300) } : {};
  const str = (v: unknown): v is string => typeof v === 'string';
  if (part.kind !== 'blocks' && str(o.markdown) && o[keyFor(part.kind)] === undefined) return { ok: true, patch: { kind: 'blocks', markdown: o.markdown }, ...note };
  switch (part.kind) {
    case 'text': return str(o.text) ? { ok: true, patch: { kind: 'text', text: o.text }, ...note } : { ok: false, error: 'missing "text" (a string)' };
    case 'blocks': return str(o.markdown) ? { ok: true, patch: { kind: 'blocks', markdown: o.markdown }, ...note } : { ok: false, error: 'missing "markdown" (a string)' };
    case 'caption': return str(o.caption) ? { ok: true, patch: { kind: 'caption', caption: o.caption }, ...note } : { ok: false, error: 'missing "caption" (a string)' };
    case 'mermaid': return str(o.source) ? { ok: true, patch: { kind: 'mermaid', source: stripFence(o.source) }, ...note } : { ok: false, error: 'missing "source" (a string)' };
    case 'chart': {
      const spec = str(o.spec) ? safeJson(o.spec) : o.spec;
      return spec && typeof spec === 'object' && !Array.isArray(spec)
        ? { ok: true, patch: { kind: 'chart', spec: spec as Record<string, unknown> }, ...note } : { ok: false, error: 'missing "spec" (an ECharts option object)' };
    }
    case 'json': return o.json !== undefined && o.json !== null ? { ok: true, patch: { kind: 'json', json: o.json }, ...note } : { ok: false, error: 'missing "json"' };
    case 'table': {
      if (!Array.isArray(o.header) || !Array.isArray(o.rows)) return { ok: false, error: 'missing "header" and "rows" arrays' };
      const row = (r: unknown): string[] | null => (Array.isArray(r) ? r.map(c => (c === null || c === undefined ? '' : String(c))) : null);
      const header = row(o.header)!;
      const rows = (o.rows as unknown[]).map(row);
      if (rows.some(r => !r)) return { ok: false, error: 'every row must be an array of cells' };
      const align = Array.isArray(o.align) ? (o.align as unknown[]).map(a => (a === 'left' || a === 'center' || a === 'right' ? a : 'none') as ColAlign) : undefined;
      return { ok: true, patch: { kind: 'table', header, rows: rows as string[][], ...(align ? { align } : {}) }, ...note };
    }
    case 'cells': {
      if (!Array.isArray(o.cells) || !(o.cells as unknown[]).every(Array.isArray)) return { ok: false, error: 'missing "cells" (an array of rows)' };
      return { ok: true, patch: { kind: 'cells', cells: (o.cells as unknown[][]).map(r => r.map(c => (c === null || c === undefined ? '' : String(c)))) }, ...note };
    }
  }
}

function keyFor(kind: PartKind): string {
  return ({ text: 'text', blocks: 'markdown', table: 'rows', cells: 'cells', chart: 'spec', mermaid: 'source', caption: 'caption', json: 'json' } as const)[kind];
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

/** The first JSON object in a reply (a ```json fence, or prose around it, is tolerated). */
export function extractJson(raw: string): unknown {
  const t = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  const direct = safeJson(t);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  const start = t.indexOf('{');
  if (start < 0) return undefined;
  // Balanced braces outside strings: the object, even with prose after it.
  let depth = 0;
  let inStr = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i]!;
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      const v = safeJson(t.slice(start, i + 1));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
    }
  }
  return undefined;
}

function stripFence(s: string): string {
  const f = parseFence(s.trim());
  return (f ? f.body : s).replace(/^\n+|\s+$/g, '');
}

/** The Markdown that replaces the part's span. */
export function renderPatch(part: ResolvedPart, patch: PartPatch): string {
  const wrap = (inner: string): string => `${part.wrap?.head ?? ''}${inner}${part.wrap?.tail ?? ''}`;
  switch (patch.kind) {
    case 'blocks': return patch.markdown.replace(/^\s*\n/, '').replace(/\s+$/, '');
    case 'text': {
      if (part.selection) {
        const e = part.editable;
        return wrap(e.slice(0, part.selection.start) + patch.text + e.slice(part.selection.end));
      }
      const t = part.wrap ? patch.text.replace(/^\n+|\n+$/g, '') : patch.text.replace(/^\s*\n/, '').replace(/\s+$/, '');
      return wrap(t);
    }
    case 'table': {
      const n = patch.header.length;
      const align = Array.from({ length: n }, (_, i) => patch.align?.[i] ?? alignFor(part.table, patch.header[i]!, i));
      return tableToMarkdown({ header: patch.header, rows: patch.rows, align });
    }
    case 'cells': {
      const t = part.table!;
      const c = part.cells!;
      const header = [...t.header];
      const rows = t.rows.map(r => [...r]);
      patch.cells.forEach((row, i) => row.forEach((v, j) => {
        const r = c.r0 + i;
        const col = c.c0 + j;
        if (r > c.r1 || col > c.c1) return;
        if (r < 0) header[col] = v; else rows[r]![col] = v;
      }));
      return tableToMarkdown({ header, rows, align: t.align });
    }
    case 'chart': return wrap(JSON.stringify(patch.spec, null, 2));
    case 'mermaid': return wrap(patch.source.replace(/\s+$/, ''));
    case 'json': return wrap(JSON.stringify(patch.json, null, 2));
    case 'caption': return imageLine({ ...part.image!, caption: patch.caption.replace(/\s+/g, ' ').trim() });
  }
}

/** A kept column keeps its alignment; a new one has none. */
function alignFor(t: TableModel | undefined, header: string, i: number): ColAlign {
  if (!t) return 'none';
  const at = t.header.findIndex(h => h.trim().toLowerCase() === header.trim().toLowerCase());
  return t.align[at >= 0 ? at : i] ?? 'none';
}

// ── What the instruction allows ──────────────────────────────────────

export interface EditIntent {
  /** Change the kind of block: "turn into a table", "make it a list". */
  convert: boolean;
  rows: boolean;
  columns: boolean;
  /** Rename headers, headings, titles. */
  rename: boolean;
  /** Change numbers, values or series. */
  data: boolean;
  chartType: boolean;
  diagramType: boolean;
  /** Remove or drop content. */
  remove: boolean;
  add: boolean;
  shorten: boolean;
  expand: boolean;
  translate: boolean;
  /** Corrections only: grammar, spelling, punctuation, tone — the words' meaning and marks stay. */
  strict: boolean;
  /** Bold, italic, links, highlighting. */
  format: boolean;
  sort: boolean;
}

/** What a thread of instructions allows, read from their words. Deterministic; quick actions are worded to match. */
export function intentOf(instructions: readonly string[]): EditIntent {
  const t = instructions.join(' \n ').toLowerCase();
  const has = (re: RegExp): boolean => re.test(t);
  return {
    convert: has(/\b(turn|convert|change|make|transform|rewrite|reformat|present)\b[^.;\n]{0,30}\b(into|to|as)\b[^.;\n]{0,20}\b(a |an )?(table|list|bullets?|bullet points|numbered list|checklist|paragraphs?|prose|chart|graph|diagram|flowchart|callout|steps|timeline|quote)\b/)
      || has(/\b(tabulate|bulleti[sz]e|as a table|as bullets|as a list)\b/),
    rows: has(/\b(add|insert|remove|delete|drop|merge|split|append|new)\b[^.;\n]{0,25}\brows?\b|\brows?\b[^.;\n]{0,15}\b(for|per)\b|\btotal row\b/),
    columns: has(/\b(add|insert|remove|delete|drop|merge|split|append|new)\b[^.;\n]{0,25}\b(columns?|fields?)\b|\bcolumn (for|called|named)\b/),
    rename: has(/\b(rename|retitle|re-?title|relabel)\b|\b(title|heading|header|caption)s?\b/),
    data: has(/\b(update|change|correct|recalculate|replace|adjust|set|increase|decrease|round|convert)\b[^.;,\n]{0,30}\b(data|values?|numbers?|figures?|amounts?|totals?|percent(age)?s?|prices?|costs?|dates?)\b/)
      || has(/\b(add|new|another|second|extra)\b[^.;\n]{0,20}\b(series|data ?points?|values?|categor(y|ies)|bars?|slices?)\b/)
      || has(/\b(percentages?|as percent|round(ed)? to|in thousands|in millions)\b/),
    chartType: has(/\b(line|bar|column|pie|donut|doughnut|area|scatter|stacked|horizontal|radar|funnel)\b[^.;\n]{0,12}\b(chart|graph|plot)\b|\bchart type\b|\b(to|into|as) (a |an )?(line|bar|pie|area|scatter|donut)\b/),
    diagramType: has(/\b(sequence|state|class|er|entity|gantt|mind ?map|timeline|flowchart|journey)\b[^.;\n]{0,12}\bdiagram\b|\bdiagram type\b|\b(into|to) a (sequence|gantt|mindmap|flowchart)\b/),
    remove: has(/\b(remove|delete|drop|cut|omit|strip|exclude|get rid of|without)\b/),
    add: has(/\b(add|insert|include|append|new|another|more)\b/),
    shorten: has(/\b(shorten|shorter|concise|tighten|trim|condense|summari[sz]e|summary|brief|briefer|simplif(y|ied)|simpler|reduce|cut down|fewer words|less wordy)\b/),
    expand: has(/\b(expand|longer|elaborate|more detail|add detail|flesh out|lengthen|develop)\b/),
    translate: has(/\b(translate|translation|in (french|german|spanish|italian|portuguese|dutch|arabic|chinese|japanese|korean|hindi|urdu|russian|polish|turkish|swedish))\b/),
    strict: has(/\b(grammar|grammatical|spelling|spell|typos?|punctuation|proofread|proof-read|correct(ions?)?|fix (the )?(errors|mistakes|wording))\b/)
      || has(/\b(formal|informal|casual|friendlier|professional|tone|polite|plain english|active voice|passive voice)\b/),
    format: has(/\b(bold|italic|italics|emphasi[sz]e|emphasis|highlight|link|links|hyperlink|underline|format(ting)?|code format)\b/),
    sort: has(/\b(sort|order|reorder|re-order|alphabeti[sz]e|rank)\b/),
  };
}

// ── Facts read from the text ─────────────────────────────────────────

const NUMBER = /(?<![\w.\-−])[-−]?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g;
/** Numbers as written, normalised (thousands separators removed). Dates and list numbers count too — they must not drift either. */
export function numbersIn(s: string): string[] {
  return (s.match(NUMBER) ?? []).map(n => n.replace(/,(?=\d{3}\b)/g, '').replace(/^−/, '-'));
}

const XREF = /\b(?:Sections?|Tables?|Figures?|Fig\.|Appendix|Appendices|Annex|Clauses?|Chapters?|Exhibits?|Schedules?|§)\s*\d+(?:\.\d+)*[a-z]?\b/gi;
export function crossRefs(s: string): string[] { return (s.match(XREF) ?? []).map(x => x.replace(/\s+/g, ' ')); }
export function linkTargets(s: string): string[] {
  const md = [...s.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(m => m[1]!);
  const auto = [...s.matchAll(/<(https?:\/\/[^>\s]+)>/g)].map(m => m[1]!);
  const bare = [...s.replace(/\]\([^)]*\)|<https?:[^>]*>/g, ' ').matchAll(/\bhttps?:\/\/[^\s)<>\]]+/g)].map(m => m[0]!.replace(/[.,;:]+$/, ''));
  return [...md, ...auto, ...bare];
}
export function citations(s: string): string[] {
  return [...(s.match(/\[\^[^\]\s]+\]/g) ?? []), ...(s.match(/\[\d+(?:\s*[,–-]\s*\d+)*\](?!\()/g) ?? []), ...(s.match(/\{#[\w-]+\}/g) ?? [])];
}
function marks(s: string): { strong: number; em: number; code: number } {
  const noCode = s.replace(/`[^`\n]+`/g, '');
  return {
    strong: (noCode.match(/\*\*[^*\n]+?\*\*|__[^_\n]+?__/g) ?? []).length,
    em: (noCode.replace(/\*\*[^*\n]+?\*\*|__[^_\n]+?__/g, '').match(/(?<![*\w])\*(?!\s)[^*\n]+?\*(?![*\w])|(?<![_\w])_(?!\s)[^_\n]+?_(?![_\w])/g) ?? []).length,
    code: (s.match(/`[^`\n]+`/g) ?? []).length,
  };
}

/** Elements of `a` (with multiplicity) that `b` lacks. */
function missing(a: readonly string[], b: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1); else out.push(x);
  }
  return out;
}
const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];
const list = (xs: readonly string[], n = 6): string => `${uniq(xs).slice(0, n).join(', ')}${uniq(xs).length > n ? '…' : ''}`;

/**
 * Terms the document defines and should keep using exactly: `**Term** means…`,
 * `(the "Term")`, `Full Name (ABC)`, and the first column of a glossary,
 * definitions or abbreviations table. First occurrences, in order, capped.
 */
export function definedTerms(text: string, max = 25): string[] {
  const out: string[] = [];
  const add = (t: string): void => {
    const v = t.replace(/\*|_|`/g, '').trim();
    if (v.length >= 2 && v.length <= 60 && !out.includes(v)) out.push(v);
  };
  for (const m of text.matchAll(/\*\*([^*\n]{2,60})\*\*\s*(?:means|is defined as|refers to|shall mean|—|–|:)/g)) add(m[1]!);
  for (const m of text.matchAll(/\((?:the\s+|each\s+a\s+|together\s+the\s+)?["“]([^"”\n]{2,60})["”]\)/gi)) add(m[1]!);
  for (const m of text.matchAll(/\b((?:[A-Z][a-z]+\s+){1,5}[A-Z][a-z]+)\s+\(([A-Z][A-Z0-9&]{1,9})\)/g)) { add(m[2]!); add(m[1]!); }
  const blocks = splitBlocks(text);
  blocks.forEach((b, i) => {
    if (b.kind !== 'table') return;
    const h = [...blocks.slice(0, i)].reverse().find(x => x.kind === 'heading');
    if (!h || !/glossary|definitions?|terms|abbreviations|acronyms/i.test(headingText(h))) return;
    for (const r of parseTable(b.text)?.rows ?? []) if (r[0]) add(r[0]);
  });
  return out.slice(0, max);
}

/**
 * The house style the document already follows, as short rules: spelling,
 * heading numbering, voice, how dates and money are written. Read from the
 * text so a model matches the document instead of its own defaults.
 */
export function styleRules(text: string): string[] {
  const rules: string[] = [];
  const uk = (text.match(/\b(colour|behaviour|organis|centre|analys(e|ing)|programme|favour|optimis|prioritis|licence|catalogue|labour|recognis|minimis|utilis)\w*/gi) ?? []).length;
  const us = (text.match(/\b(color|behavior|organiz|center|analyz|favor|optimiz|prioritiz|catalog\b|labor|recogniz|minimiz|utiliz)\w*/gi) ?? []).length;
  if (uk > us && uk >= 1) rules.push('British spelling (organise, colour, centre)');
  else if (us > uk && us >= 1) rules.push('American spelling (organize, color, center)');
  const numbered = (text.match(/^ {0,3}#{1,6}[ \t]+\d+(?:\.\d+)*\.?[ \t]/gm) ?? []).length;
  if (numbered >= 2) rules.push('headings are numbered ("2.1 Scope") — never renumber');
  const we = (text.match(/\b(we|our|us)\b/gi) ?? []).length;
  const words = Math.max(1, (text.match(/\S+/g) ?? []).length);
  if (we / words > 0.01) rules.push('written as "we/our"');
  const party = /\bthe (Supplier|Client|Customer|Company|Contractor|Vendor|Provider|Buyer|Licensee|Licensor)\b/.exec(text);
  if (party) rules.push(`refers to parties by role ("the ${party[1]}")`);
  const date = /\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b|\b\d{4}-\d{2}-\d{2}\b/.exec(text);
  if (date) rules.push(`dates written like "${date[0]}"`);
  const money = /(?:[£$€¥₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion))?)|\b\d[\d,]*(?:\.\d+)? ?(?:GBP|USD|EUR)\b/.exec(text);
  if (money) rules.push(`money written like "${money[0]}"`);
  if (/\boxford comma\b/i.test(text)) rules.push('uses the Oxford comma');
  return rules;
}

// ── Context for the model ────────────────────────────────────────────

export interface EditContext {
  title: string;
  /** "Technical proposal — persuasive, formal" (from the document type). */
  docType?: string;
  typeNote?: string;
  where: string;
  style: string[];
  /** Headings, the one holding the target marked with "→". */
  outline: string[];
  terms: string[];
  before: string[];
  after: string[];
  /** The whole document, when it is small enough to send. */
  whole?: string;
}

/** Bounds: the context is sized by these, never by the document. */
export const CONTEXT_LIMITS = { neighbours: 2, neighbourChars: 700, outline: 40, outlineChars: 90, whole: 3000 } as const;

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.65);
  return `${s.slice(0, head)} … ${s.slice(s.length - (n - head - 3))}`;
}

/**
 * What the model sees besides the target: the document's type and style, its
 * outline, defined terms and the blocks either side — bounded and
 * deterministic (the same document and target give the same context).
 */
export function buildEditContext(text: string, part: Pick<ResolvedPart, 'blocks' | 'where'>, doc: { title: string; docType?: string; typeNote?: string }): EditContext {
  const blocks = splitBlocks(text);
  const L = CONTEXT_LIMITS;
  const visible = blocks.filter(b => b.kind !== 'pending');
  let holder = -1;
  for (let i = 0; i <= part.blocks.from && i < blocks.length; i++) if (blocks[i]!.kind === 'heading') holder = i;
  const outline = blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.kind === 'heading' || (b.kind === 'pending' && b.pending))
    .slice(0, L.outline)
    .map(({ b, i }) => `${i === holder ? '→ ' : '  '}${'  '.repeat(Math.max(0, (b.level ?? 2) - 1))}${clip(b.kind === 'heading' ? headingText(b) : `(to write) ${b.pending!.heading ?? b.pending!.intent}`, L.outlineChars)}`);
  const ctx: EditContext = {
    title: doc.title, ...(doc.docType ? { docType: doc.docType } : {}), ...(doc.typeNote ? { typeNote: doc.typeNote } : {}),
    where: part.where, style: styleRules(text), outline, terms: definedTerms(text), before: [], after: [],
  };
  if (text.length <= L.whole && visible.length > 1) {
    ctx.whole = text;
    return ctx;
  }
  ctx.before = blocks.slice(Math.max(0, part.blocks.from - L.neighbours), part.blocks.from).filter(b => b.kind !== 'pending').map(b => clip(b.text, L.neighbourChars));
  ctx.after = blocks.slice(part.blocks.to, part.blocks.to + L.neighbours).filter(b => b.kind !== 'pending').map(b => clip(b.text, L.neighbourChars));
  return ctx;
}

/** The target as the model sees it: its structured form, with a selection or cell range marked. */
export function describeTarget(part: ResolvedPart): string {
  if (part.describe) return part.describe;
  switch (part.kind) {
    case 'text':
      if (part.selection) {
        const e = part.editable;
        return `The ${part.what}, with the passage to change between ⟦ and ⟧:\n${e.slice(0, part.selection.start)}⟦${e.slice(part.selection.start, part.selection.end)}⟧${e.slice(part.selection.end)}`;
      }
      return part.wrap?.head
        ? `The ${part.what}'s text (its markup "${part.wrap.head.trim()}" is kept for you — do not repeat it):\n${part.editable}`
        : `The ${part.what} (Markdown):\n${part.editable}`;
    case 'table': return `The table as JSON:\n${JSON.stringify({ header: part.table!.header, rows: part.table!.rows })}`;
    case 'cells': {
      const t = part.table!;
      const c = part.cells!;
      const marked = [t.header, ...t.rows].map((r, ri) => r.map((v, ci) => (ri - 1 >= c.r0 && ri - 1 <= c.r1 && ci >= c.c0 && ci <= c.c1 ? `⟦${v}⟧` : v)));
      return `The table as JSON rows (the first row is the header); the cells to change are marked ⟦…⟧:\n${JSON.stringify(marked)}`;
    }
    case 'chart': return `The chart's ECharts option:\n${JSON.stringify(part.chart)}`;
    case 'mermaid': return `The Mermaid source:\n${part.editable}`;
    case 'caption': return `The image's caption: ${JSON.stringify(part.editable)} (image: ${JSON.stringify(part.image?.alt ?? '')})`;
    case 'json': return `The block's JSON body:\n${part.editable}`;
    case 'blocks': return `The ${part.what} (Markdown):\n${part.editable}`;
  }
}

// ── Validation ───────────────────────────────────────────────────────

export interface Verdict {
  ok: boolean;
  /** Each a sentence the model can act on when retried. */
  errors: string[];
  /** Kept but shown to the person (a defined term no longer used, say). */
  warnings: string[];
  /** The span's new Markdown. */
  after: string;
  /** Nothing changed. */
  unchanged: boolean;
}

const KNOWN_SERIES = new Set(['line', 'bar', 'pie', 'scatter', 'effectScatter', 'radar', 'tree', 'treemap', 'sunburst', 'boxplot', 'candlestick',
  'heatmap', 'map', 'parallel', 'lines', 'graph', 'sankey', 'funnel', 'gauge', 'pictorialBar', 'themeRiver', 'custom']);

function chartTypes(spec: Record<string, unknown>): string[] {
  const s = Array.isArray(spec.series) ? spec.series : spec.series && typeof spec.series === 'object' ? [spec.series] : [];
  return uniq((s as Array<Record<string, unknown>>).map(x => (x && typeof x.type === 'string' ? (x.type === 'line' && x.areaStyle ? 'area' : x.type) : '')).filter(Boolean));
}

function chartNumbers(spec: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number') out.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object' && 'value' in (v as object)) walk((v as { value: unknown }).value);
  };
  const s = Array.isArray(spec.series) ? spec.series : [spec.series];
  for (const x of s as Array<{ data?: unknown }>) if (x && typeof x === 'object') walk(x.data);
  return out;
}

function chartLabels(spec: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const axis of [spec.xAxis, spec.yAxis]) {
    for (const a of (Array.isArray(axis) ? axis : [axis]) as Array<{ data?: unknown }>) {
      if (a && Array.isArray(a.data)) out.push(...a.data.map(d => String(d && typeof d === 'object' ? (d as { value?: unknown }).value : d)));
    }
  }
  const s = Array.isArray(spec.series) ? spec.series : [spec.series];
  for (const x of s as Array<{ type?: string; data?: unknown }>) {
    if (x?.type === 'pie' && Array.isArray(x.data)) out.push(...x.data.map(d => String((d as { name?: unknown })?.name ?? '')));
  }
  return out;
}

const titleOf = (spec: Record<string, unknown>): string => {
  const t = Array.isArray(spec.title) ? spec.title[0] : spec.title;
  return t && typeof t === 'object' && typeof (t as { text?: unknown }).text === 'string' ? (t as { text: string }).text : '';
};

/** Structural problems with an ECharts option, or none. Exported for decks and tests. */
export function checkChart(spec: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const size = JSON.stringify(spec).length;
  if (size > 60_000) errs.push(`the chart option is ${size} characters — too large`);
  const series = Array.isArray(spec.series) ? spec.series as unknown[] : null;
  if (!series || !series.length) return [...errs, 'the option needs a non-empty "series" array'];
  const cartesian = series.some(s => ['line', 'bar', 'scatter', 'effectScatter', 'boxplot', 'candlestick', 'pictorialBar'].includes(String((s as { type?: unknown })?.type)));
  series.forEach((raw, i) => {
    const s = raw as { type?: unknown; data?: unknown };
    if (!s || typeof s !== 'object') { errs.push(`series[${i}] is not an object`); return; }
    if (typeof s.type !== 'string' || !KNOWN_SERIES.has(s.type)) errs.push(`series[${i}].type ${JSON.stringify(s.type)} is not an ECharts series type`);
    if (s.data !== undefined && !Array.isArray(s.data)) errs.push(`series[${i}].data must be an array`);
    if (s.type === 'pie' && Array.isArray(s.data) && !s.data.every(d => typeof d === 'number' || (d && typeof d === 'object' && typeof (d as { value?: unknown }).value === 'number'))) {
      errs.push(`series[${i}] is a pie: data must be [{"name", "value": <number>}]`);
    }
  });
  if (cartesian) {
    const axes = [spec.xAxis, spec.yAxis];
    if (axes.some(a => a === undefined)) errs.push('a line/bar/scatter chart needs both xAxis and yAxis');
    const cat = axes.flatMap(a => (Array.isArray(a) ? a : [a])).find(a => a && typeof a === 'object' && Array.isArray((a as { data?: unknown }).data)) as { data: unknown[] } | undefined;
    if (cat) {
      series.forEach((raw, i) => {
        const s = raw as { type?: unknown; data?: unknown[] };
        if (Array.isArray(s?.data) && ['line', 'bar'].includes(String(s.type)) && s.data.length !== cat.data.length && !s.data.some(d => Array.isArray(d))) {
          errs.push(`series[${i}] has ${s.data.length} values but the category axis has ${cat.data.length}`);
        }
      });
    }
  }
  return errs;
}

const MERMAID_KEYWORDS = uniq([...DIAGRAM_TYPES.map(d => d.syntax), 'graph', 'stateDiagram', 'flowchart-elk', 'xychart', 'sankey', 'block', 'packet', 'architecture']);

/** The diagram type a Mermaid source declares ("flowchart", "sequenceDiagram"…), or null. */
export function mermaidKind(source: string): string | null {
  const lines = mermaidBody(source);
  const first = (lines[0] ?? '').trim().split(/\s+/)[0] ?? '';
  return MERMAID_KEYWORDS.includes(first) ? (first === 'graph' ? 'flowchart' : first) : null;
}

function mermaidBody(source: string): string[] {
  let s = source.replace(/\r\n/g, '\n');
  // Front matter (--- … ---) and %% comments do not count as the header.
  s = s.replace(/^\s*---\n[\s\S]*?\n---\s*\n/, '');
  return s.split('\n').filter(l => l.trim() && !/^\s*%%/.test(l));
}

/** Node ids of a flowchart or participants of a sequence diagram — what an edit must not lose by accident. */
export function mermaidIds(source: string): string[] {
  const kind = mermaidKind(source);
  const lines = mermaidBody(source).slice(1);
  const out: string[] = [];
  if (kind === 'flowchart') {
    for (const raw of lines) {
      const l = raw.trim();
      if (/^(subgraph|end\b|style|classDef|class\b|click|linkStyle|direction)/.test(l)) {
        const sg = /^subgraph\s+([A-Za-z_][\w-]*)/.exec(l);
        if (sg) out.push(sg[1]!);
        continue;
      }
      const bare = l.replace(/"[^"]*"/g, '""').replace(/\|[^|]*\|/g, '').replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|(?<=\w)>[^\]]*\]/g, '')
        .replace(/--[^->]*-->|==[^=>]*==>|-\.[^.]*\.->/g, ' --> ').replace(/:::\w+/g, '');
      for (const m of bare.matchAll(/(?:^|[\s&>-])([A-Za-z_][\w]*)(?=\s*(?:$|[\s&<>-]|-->|---|==>|-\.->|~~~))/g)) {
        if (!/^(o|x|end|subgraph)$/.test(m[1]!)) out.push(m[1]!);
      }
    }
  } else if (kind === 'sequenceDiagram') {
    for (const l of lines) {
      const p = /^\s*(?:participant|actor)\s+([^\s]+)/.exec(l);
      if (p) out.push(p[1]!);
      const msg = /^\s*([^\s:>-]+)\s*-[->x)]+[+-]?\s*([^\s:]+)\s*:/.exec(l);
      if (msg) out.push(msg[1]!, msg[2]!);
    }
  }
  return uniq(out);
}

/**
 * A syntax check for Mermaid that runs anywhere (no DOM): a known diagram
 * header, balanced brackets and quotes per line, no stray fence, no edge
 * without an end. The editor additionally runs the real `mermaid.parse` in
 * the browser before Accept; this is the engine's floor, not the whole check.
 */
export function checkMermaid(source: string): string[] {
  const errs: string[] = [];
  if (/```/.test(source)) errs.push('the source contains a ``` fence — send the diagram source only');
  const lines = mermaidBody(source);
  if (!lines.length) return [...errs, 'the diagram is empty'];
  const head = lines[0]!.trim().split(/\s+/)[0]!;
  if (!MERMAID_KEYWORDS.includes(head)) errs.push(`the first line must declare the diagram type (e.g. "flowchart LR"), not "${lines[0]!.trim().slice(0, 40)}"`);
  const kind = mermaidKind(source);
  if (kind === 'flowchart' && !/^(flowchart|graph)(\s+(TB|TD|BT|RL|LR))?\s*;?$/.test(lines[0]!.trim())) errs.push(`"${lines[0]!.trim()}" is not a valid flowchart header (flowchart TD|LR|RL|BT)`);
  let depth = 0;
  lines.forEach((raw, i) => {
    const l = raw.replace(/"[^"]*"/g, '""');
    if ((raw.match(/"/g) ?? []).length % 2) errs.push(`line ${i + 1} has an unclosed quote: ${raw.trim().slice(0, 60)}`);
    if (kind === 'flowchart' || kind === 'stateDiagram-v2' || kind === 'classDiagram' || kind === 'erDiagram') {
      const bal = (o: string, c: string): number => (l.split(o).length - l.split(c).length);
      if (bal('[', ']') || bal('(', ')') || bal('{', '}')) errs.push(`line ${i + 1} has unbalanced brackets: ${raw.trim().slice(0, 60)}`);
    }
    if (kind === 'flowchart') {
      if (/(-->|---|==>|-\.->)\s*(\|[^|]*\|)?\s*;?$/.test(l.trim()) && !/^\s*%%/.test(l)) errs.push(`line ${i + 1} has an arrow with nothing after it: ${raw.trim().slice(0, 60)}`);
      if (/^\s*subgraph\b/.test(l)) depth++;
      if (/^\s*end\s*$/.test(l)) depth--;
    }
  });
  if (kind === 'flowchart' && depth !== 0) errs.push(depth > 0 ? 'a subgraph is not closed with "end"' : 'there is an "end" without a subgraph');
  return errs;
}

/**
 * The prose checks on their own (figures, links, citations, cross-references,
 * marks, shorten/expand) — for a part whose structure is checked elsewhere
 * (a deck's slide, its KPI tiles, its speaker notes).
 */
export function checkTextFacts(before: string, after: string, intent: EditIntent, opts: { inline?: boolean; glossary?: readonly string[] } = {}): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  textChecks(before, after, intent, errors, warnings, opts);
  return { errors, warnings };
}

/** Text-level checks shared by every kind that carries prose. */
function textChecks(before: string, after: string, intent: EditIntent, errors: string[], warnings: string[], opts: { inline?: boolean; glossary?: readonly string[] } = {}): void {
  const lost = (a: string[], b: string[]): string[] => missing(uniq(a), b);
  if (!intent.remove) {
    const links = lost(linkTargets(before), linkTargets(after));
    if (links.length && !intent.format) errors.push(`links were dropped (${list(links)}) — keep every link target exactly`);
    const cites = lost(citations(before), citations(after));
    if (cites.length) errors.push(`citations, footnotes or anchors were dropped or changed (${list(cites)}) — keep them exactly`);
    const refs = intent.translate
      ? lost(crossRefs(before).map(r => r.replace(/^\D+/, '')), crossRefs(after).map(r => r.replace(/^\D+/, '')).concat(numbersIn(after)))
      : lost(crossRefs(before), crossRefs(after));
    if (refs.length) errors.push(`cross-references were changed (${list(refs)}) — keep "Section 2.1", "Table 3" exactly`);
  }
  // Numbers: corrections, tone and translation keep every figure; nothing invents one unless asked.
  if (!intent.data) {
    const gone = missing(numbersIn(before), numbersIn(after));
    const added = missing(numbersIn(after), numbersIn(before));
    if (gone.length && !intent.remove && !intent.convert) {
      if (intent.shorten || intent.rows || intent.columns) warnings.push(`some figures no longer appear: ${list(gone)}`);
      else errors.push(`numbers were dropped or changed (${list(gone)}) — keep every figure exactly as written unless asked`);
    }
    if (added.length && !intent.add && !intent.rows && !intent.columns && !intent.convert) {
      if (intent.expand) warnings.push(`new figures appeared: ${list(added)} — check they are real`);
      else errors.push(`new numbers appeared (${list(added)}) that are not in the original — never invent figures`);
    }
  }
  const m0 = marks(before);
  const m1 = marks(after);
  if (!intent.format) {
    if ((intent.strict || intent.translate) && (m1.strong !== m0.strong || m1.em !== m0.em || m1.code !== m0.code)) {
      errors.push('bold/italic/code marks changed — a correction keeps the formatting exactly (same marked words)');
    } else if (m1.strong > m0.strong || m1.em > m0.em || m1.code > m0.code) {
      errors.push('formatting was added (bold, italic or code) that the original did not have and the instruction did not ask for');
    }
  }
  if (opts.inline) {
    if (/^ {0,3}#{1,6}\s/m.test(after) && !/^ {0,3}#{1,6}\s/m.test(before)) errors.push('a heading was added inside the text');
    if (/<\/?[a-z][^>]*>/i.test(after) && !/<\/?[a-z][^>]*>/i.test(before)) errors.push('HTML was added');
    if (/!\[[^\]]*\]\(/.test(after) && !/!\[[^\]]*\]\(/.test(before)) errors.push('an image was added');
    if (/```/.test(after) && !/```/.test(before)) errors.push('a code fence was added');
  }
  if (!intent.translate && !intent.rename && opts.glossary?.length) {
    const was = opts.glossary.filter(t => before.includes(t) && !after.includes(t));
    if (was.length) warnings.push(`defined term${was.length === 1 ? '' : 's'} no longer used here: ${list(was)}`);
  }
  if (intent.shorten && !intent.expand && after.length >= before.length && before.length > 40) errors.push('asked to shorten, but the result is not shorter');
  if (intent.expand && !intent.shorten && after.length <= before.length) errors.push('asked to expand, but the result is not longer');
}

function listItems(s: string): number {
  return (s.match(/^\s*(?:[-*+]|\d{1,9}[.)])\s/gm) ?? []).length;
}

/** The block kinds a type change was asked for ("into a table" → table). */
function conversionTarget(instructions: readonly string[]): BlockKind | 'chart' | 'mermaid' | 'callout' | null {
  const t = instructions.join(' ').toLowerCase();
  const m = /\b(?:into|to|as)\b[^.;\n]{0,20}?\b(table|list|bullets?|bullet points|numbered list|checklist|paragraphs?|prose|chart|graph|diagram|flowchart|callout|quote)\b/.exec(t)
    ?? /\b(tabulate|bulleti[sz]e)\b/.exec(t);
  if (!m) return null;
  const w = m[1]!;
  if (/table|tabulate/.test(w)) return 'table';
  if (/list|bullet|checklist/.test(w)) return 'list';
  if (/paragraph|prose/.test(w)) return 'paragraph';
  if (/chart|graph/.test(w)) return 'chart';
  if (/diagram|flowchart/.test(w)) return 'mermaid';
  if (/callout/.test(w)) return 'callout';
  if (/quote/.test(w)) return 'quote';
  return null;
}

/**
 * Check a patch against its part and what the instructions allow, and render
 * the span's new Markdown. `instructions` is the whole thread, oldest first —
 * a follow-up ("shorter still") keeps what the first instruction allowed.
 */
export function validatePatch(part: ResolvedPart, patch: PartPatch, instructions: readonly string[], opts: { glossary?: readonly string[] } = {}): Verdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const intent = intentOf(instructions);
  const done = (after: string): Verdict => {
    const unchanged = after === part.before;
    return { ok: errors.length === 0, errors, warnings, after, unchanged };
  };

  if (patch.kind === 'blocks' && part.kind !== 'blocks') {
    // A type change: only when the instruction asks for one, and into what it asked for.
    if (!intent.convert) {
      errors.push(`the ${part.what} must stay a ${part.what} — answer with ${keyFor(part.kind) === 'rows' ? '"header" and "rows"' : `"${keyFor(part.kind)}"`}, not "markdown" (the instruction does not ask to change its type)`);
      return done(part.before);
    }
  }

  let after: string;
  try { after = renderPatch(part, patch); } catch (err) {
    errors.push(`the answer could not be applied: ${err instanceof Error ? err.message : String(err)}`);
    return done(part.before);
  }
  if (!after.trim() && !intent.remove) errors.push('the result is empty');

  switch (patch.kind) {
    case 'text': {
      const t = patch.text;
      if (part.selection) {
        if (/\n[ \t]*\n/.test(t)) errors.push('the replacement for a selection must not contain a blank line (that would split the block)');
        if (!t.trim() && !intent.remove) errors.push('the replacement is empty');
        textChecks(part.editable.slice(part.selection.start, part.selection.end), t, intent, errors, warnings, { inline: true, ...(opts.glossary ? { glossary: opts.glossary } : {}) });
      } else {
        textChecks(part.editable, t, intent, errors, warnings, { inline: part.what !== 'code block', ...(opts.glossary ? { glossary: opts.glossary } : {}) });
        if (part.wrap?.head && /^ {0,3}#{1,6}\s/.test(t)) errors.push('send the heading text only — its "#" marks and numbering are kept for you');
        if (part.what === 'heading' && /\n/.test(t.trim())) errors.push('a heading is one line');
        if ((intent.strict || intent.translate) && /list/.test(part.what) && listItems(t) !== listItems(part.editable)) {
          errors.push(`the list had ${listItems(part.editable)} items and now has ${listItems(t)} — a correction keeps every item`);
        }
      }
      // Still exactly one block of the same kind: the type never changes by accident.
      const re = splitBlocks(after);
      if (part.blockKinds[0] && (re.length !== 1 || re[0]!.kind !== part.blockKinds[0])) {
        errors.push(re.length !== 1
          ? `the ${part.what} became ${re.length} blocks — keep it one ${part.what} (no blank lines inside)`
          : `the ${part.what} became a ${re[0]!.kind} — keep it a ${part.what}`);
      }
      if (part.blockKinds[0] === 'heading' && re[0]?.level !== undefined && splitBlocks(part.before)[0]?.level !== re[0].level) errors.push('the heading level changed');
      break;
    }
    case 'caption':
      if (/\n/.test(patch.caption.trim())) errors.push('a caption is one line');
      if (patch.caption.length > 300) errors.push('a caption is at most 300 characters');
      textChecks(part.editable, patch.caption, intent, errors, warnings, { inline: true });
      break;
    case 'table': {
      const t = part.table!;
      const n = patch.header.length;
      if (!n) errors.push('the table needs a header');
      patch.rows.forEach((r, i) => { if (r.length !== n) errors.push(`row ${i + 1} has ${r.length} cells but the header has ${n} — every row needs exactly ${n}`); });
      if (!intent.columns && !intent.convert && n !== t.header.length) errors.push(`the table had ${t.header.length} columns and now has ${n} — keep the columns unless asked to add or remove one`);
      if (!intent.rows && !intent.convert && !intent.remove && patch.rows.length !== t.rows.length) errors.push(`the table had ${t.rows.length} rows and now has ${patch.rows.length} — keep every row unless asked`);
      if (!intent.rename && !intent.translate && !intent.columns) {
        const changed = t.header.filter((h, i) => (patch.header[i] ?? '').trim() !== h.trim());
        if (changed.length) errors.push(`column headers changed (${list(changed)}) — keep them unless asked`);
      }
      // Adding a column or sorting must leave every existing cell as it was (rows may move).
      if ((intent.columns || intent.rows || intent.sort) && !intent.strict && !intent.translate && !intent.shorten && !intent.data && !intent.rename && !intent.expand) {
        const at = t.header.map(h => patch.header.findIndex(x => x.trim().toLowerCase() === h.trim().toLowerCase()));
        if (at.every(i => i >= 0)) {
          const oldRows = t.rows.map(r => JSON.stringify(r.map(c => c.trim())));
          const newRows = patch.rows.map(r => JSON.stringify(at.map(i => (r[i] ?? '').trim())));
          const lost = missing(oldRows, newRows);
          if (lost.length && !(intent.remove && newRows.length < oldRows.length && missing(newRows, oldRows).length === 0)) {
            errors.push(`${lost.length} existing row${lost.length === 1 ? '' : 's'} had cells changed — only ${intent.columns ? 'add/remove the column' : intent.sort ? 'reorder the rows' : 'add/remove rows'}; leave every other cell exactly as it was`);
          }
        }
      }
      const flat = (h: string[], rs: string[][]): string => [h, ...rs].map(r => r.join(' | ')).join('\n');
      textChecks(flat(t.header, t.rows), flat(patch.header, patch.rows), { ...intent, add: intent.add || intent.columns || intent.rows }, errors, warnings);
      break;
    }
    case 'cells': {
      const c = part.cells!;
      const rows = c.r1 - c.r0 + 1;
      const cols = c.c1 - c.c0 + 1;
      if (patch.cells.length !== rows || patch.cells.some(r => r.length !== cols)) {
        errors.push(`send exactly ${rows} row(s) of ${cols} cell(s) — the marked cells only (got ${patch.cells.length} row(s) of ${patch.cells.map(r => r.length).join('/')})`);
      } else {
        const t = part.table!;
        const old = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (c.r0 + i < 0 ? t.header : t.rows[c.r0 + i]!)[c.c0 + j] ?? ''));
        textChecks(old.map(r => r.join(' | ')).join('\n'), patch.cells.map(r => r.join(' | ')).join('\n'), intent, errors, warnings, { inline: true });
      }
      break;
    }
    case 'chart': {
      errors.push(...checkChart(patch.spec));
      const old = part.chart!;
      const t0 = chartTypes(old);
      const t1 = chartTypes(patch.spec);
      if (!intent.chartType && !intent.convert && t0.join() !== t1.join()) errors.push(`the chart type changed (${t0.join(', ')} → ${t1.join(', ')}) — keep it unless asked`);
      if (!intent.data) {
        const gone = missing(chartNumbers(old), chartNumbers(patch.spec));
        const added = missing(chartNumbers(patch.spec), chartNumbers(old));
        if (gone.length && !intent.remove) errors.push(`data values were dropped or changed (${list(gone)}) — keep the data exactly`);
        if (added.length) errors.push(`data values were added (${list(added)}) — never invent data`);
        const labels = missing(uniq(chartLabels(old)), chartLabels(patch.spec));
        if (labels.length && !intent.translate && !intent.rename && !intent.remove) errors.push(`categories were dropped or renamed (${list(labels)})`);
      }
      if (!intent.rename && !intent.translate && titleOf(old) && titleOf(old) !== titleOf(patch.spec)) errors.push(`the chart title changed ("${titleOf(old)}" → "${titleOf(patch.spec)}") — keep it unless asked`);
      break;
    }
    case 'mermaid': {
      errors.push(...checkMermaid(patch.source));
      const k0 = mermaidKind(part.editable);
      const k1 = mermaidKind(patch.source);
      if (k0 && k1 && k0 !== k1 && !intent.diagramType && !intent.convert) errors.push(`the diagram type changed (${k0} → ${k1}) — keep it unless asked`);
      if (!intent.remove && !intent.shorten && !intent.rename) {
        const gone = missing(mermaidIds(part.editable), mermaidIds(patch.source));
        if (gone.length) errors.push(`nodes or participants were removed or renamed (${list(gone)}) — keep every existing one unless asked`);
      }
      break;
    }
    case 'json': {
      const old = safeJson(part.editable) as Record<string, unknown> | undefined;
      const now = patch.json as Record<string, unknown>;
      if (!now || typeof now !== 'object') { errors.push('the body must be a JSON object'); break; }
      if (old && typeof old === 'object' && !Array.isArray(old) && !Array.isArray(now)) {
        const lostKeys = Object.keys(old).filter(k => !(k in now));
        if (lostKeys.length && !intent.remove) errors.push(`fields were removed (${list(lostKeys)}) — keep the block's structure`);
        for (const k of Object.keys(old)) {
          const a = old[k];
          const b = now[k];
          if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length && !intent.add && !intent.remove && !intent.shorten && !intent.rows) {
            errors.push(`"${k}" had ${a.length} entries and now has ${b.length} — keep every entry unless asked`);
          }
        }
      }
      textChecks(part.editable, JSON.stringify(now, null, 2), intent, errors, warnings);
      break;
    }
    case 'blocks': {
      const re = splitBlocks(after);
      if (re.some(b => b.kind === 'pending')) errors.push('placeholders cannot be added');
      if (part.kind !== 'blocks') {
        // A type change that was asked for: into what was asked.
        const want = conversionTarget(instructions);
        if (want === 'chart') {
          const f = re.length === 1 ? parseFence(re[0]!.text) : null;
          const spec = f && CHART_FENCES.has(f.lang) ? safeJson(f.body) : undefined;
          if (!spec || typeof spec !== 'object') errors.push('asked for a chart: answer with one ```chart block holding an ECharts option');
          else errors.push(...checkChart(spec as Record<string, unknown>));
        } else if (want === 'mermaid') {
          const f = re.length === 1 ? parseFence(re[0]!.text) : null;
          if (!f || f.lang !== 'mermaid') errors.push('asked for a diagram: answer with one ```mermaid block');
          else errors.push(...checkMermaid(f.body));
        } else if (want === 'callout') {
          if (!(re.length === 1 && parseCallout(re[0]!.text))) errors.push('asked for a callout: answer with one ```callout info|warn|success block');
        } else if (want && !re.some(b => b.kind === want)) {
          errors.push(`asked to turn it into a ${want}, but the result has no ${want}`);
        }
        textChecks(part.editable, after, { ...intent, add: true }, errors, warnings);
        // A new shape, the same facts: every figure must survive the conversion.
        const gone = intent.remove || intent.shorten || intent.data ? [] : missing(uniq(numbersIn(part.editable)), numbersIn(after));
        if (gone.length) errors.push(`figures were lost in the conversion (${list(gone)}) — carry every number over`);
        break;
      }
      const old = splitBlocks(part.before);
      if (part.section) {
        const h = re[0];
        if (!h || h.kind !== 'heading' || (h.level ?? 1) !== part.section.level) errors.push(`the section must start with its level-${part.section.level} heading`);
        else if (!intent.rename && !intent.translate && headingText(h) !== part.section.heading) errors.push(`the section heading changed ("${part.section.heading}" → "${headingText(h)}") — keep it unless asked`);
        else if (HEADING_HEAD.exec(old[0]!.text)?.[1] !== HEADING_HEAD.exec(h.text)?.[1]) errors.push('the heading\'s numbering changed — keep it exactly');
      }
      if (!intent.convert) {
        const kinds = (bs: Block[]): string[] => bs.map(b => (b.kind === 'code' ? `code:${b.lang ?? ''}` : b.kind));
        const structural = (bs: Block[]): string[] => kinds(bs).filter(k => !['paragraph', 'list', 'quote'].includes(k));
        if (intent.add || intent.remove || intent.expand || intent.shorten) {
          const gone = missing(structural(old), structural(re));
          if (gone.length && !intent.remove) errors.push(`blocks were removed (${list(gone)}) — keep every table, chart, diagram and heading unless asked`);
        } else if (kinds(old).join() !== kinds(re).join()) {
          errors.push(`the blocks changed from [${kinds(old).join(', ')}] to [${kinds(re).join(', ')}] — keep the same blocks in the same order unless asked`);
        }
      }
      for (const b of re) {
        const f = b.kind === 'code' ? parseFence(b.text) : null;
        if (f?.lang === 'mermaid' && !old.some(o => o.text === b.text)) errors.push(...checkMermaid(f.body).map(e => `diagram: ${e}`));
        if (f && CHART_FENCES.has(f.lang) && !old.some(o => o.text === b.text)) {
          const spec = safeJson(f.body);
          if (!spec || typeof spec !== 'object') errors.push('a chart block is not valid JSON');
          else errors.push(...checkChart(spec as Record<string, unknown>).map(e => `chart: ${e}`));
        }
      }
      textChecks(part.before, after, intent, errors, warnings, opts.glossary ? { glossary: opts.glossary } : {});
      break;
    }
  }
  return done(after);
}

// ── Applying ─────────────────────────────────────────────────────────

/**
 * Put a validated part back into the tab's text. Locates the span by its
 * exact old text (at its offset, else uniquely anywhere — the person may have
 * typed elsewhere since), then re-splits the result and checks every block
 * outside the span is byte-identical: an edit that would merge into a
 * neighbour (a list swallowing the next paragraph) is refused here.
 */
export function applyPart(text: string, part: Pick<ResolvedPart, 'span' | 'before'>, after: string):
  { ok: true; text: string; start: number } | { ok: false; error: string } {
  let start = part.span.start;
  if (text.slice(start, start + part.before.length) !== part.before) {
    const at = text.indexOf(part.before);
    if (at < 0 || text.indexOf(part.before, at + 1) >= 0) return { ok: false, error: 'that part changed since AICO read it — try again' };
    start = at;
  }
  const end = start + part.before.length;
  const next = text.slice(0, start) + after + text.slice(end);
  const keyOf = (b: Block): string => b.text;
  const old = splitBlocks(text);
  const now = splitBlocks(next);
  const head = old.filter(b => b.end <= start).map(keyOf);
  const tail = old.filter(b => b.start >= end).map(keyOf);
  const nowHead = now.filter(b => b.end <= start).map(keyOf);
  const nowTail = now.filter(b => b.start >= start + after.length).map(keyOf);
  if (head.join('\u0000') !== nowHead.join('\u0000') || tail.join('\u0000') !== nowTail.join('\u0000')) {
    return { ok: false, error: 'the edit would merge with the blocks around it — nothing outside the selected part may change' };
  }
  return { ok: true, text: next, start };
}

/** Hashes of every block outside a span — what an eval (or a paranoid caller) compares before and after. */
export function outsideHashes(text: string, span: { start: number; end: number }): string[] {
  return splitBlocks(text).filter(b => b.end <= span.start || b.start >= span.end).map(b => blockKeys([b])[0]!);
}

// ── Quick actions ────────────────────────────────────────────────────

export interface PartAction {
  id: string;
  label: string;
  instruction: string;
  /** Opens the box prefilled instead of sending (it needs a word from the person: a language, a column name). */
  ask?: boolean;
  /** Runs on another part than the one open (a slide's "Punchier title" edits its title): its element and label. */
  target?: { elementId: string; label: string };
}

const PROSE_ACTIONS: PartAction[] = [
  { id: 'grammar', label: 'Fix grammar', instruction: 'Fix spelling, grammar and punctuation only. Change nothing else.' },
  { id: 'shorten', label: 'Shorten', instruction: 'Shorten it to about two-thirds of its length — keep every fact, figure and reference.' },
  { id: 'expand', label: 'Expand', instruction: 'Expand it with useful detail from the document — no padding and no invented facts.' },
  { id: 'formal', label: 'Make formal', instruction: 'Make the tone more formal and professional.' },
  { id: 'simplify', label: 'Simplify', instruction: 'Simplify the wording into plain English — same meaning.' },
  { id: 'translate', label: 'Translate…', instruction: 'Translate it into ', ask: true },
];

/** Quick actions for a kind of part. */
export function partActions(part: Pick<ResolvedPart, 'kind' | 'what' | 'selection'>): PartAction[] {
  switch (part.kind) {
    case 'text':
      if (part.what === 'heading') return [PROSE_ACTIONS[0]!, { id: 'shorten', label: 'Shorten', instruction: 'Shorten the heading.' }, PROSE_ACTIONS[5]!];
      if (/code|maths/.test(part.what) && !part.selection) return [{ id: 'comments', label: 'Explain in comments', instruction: 'Add brief comments where the code is not self-explanatory.' }];
      return [
        ...PROSE_ACTIONS,
        ...(part.selection ? [] : [
          { id: 'table', label: 'Turn into table', instruction: 'Turn it into a table.' },
          ...(/list/.test(part.what) ? [] : [{ id: 'list', label: 'Turn into list', instruction: 'Turn it into a bulleted list.' }]),
        ]),
      ];
    case 'blocks': return [PROSE_ACTIONS[0]!, PROSE_ACTIONS[1]!, PROSE_ACTIONS[3]!, PROSE_ACTIONS[4]!, PROSE_ACTIONS[5]!];
    case 'table': return [
      { id: 'grammar', label: 'Fix grammar', instruction: 'Fix spelling, grammar and punctuation in the cells only. Change nothing else.' },
      { id: 'column', label: 'Add a column…', instruction: 'Add a column for ', ask: true },
      { id: 'row', label: 'Add a row…', instruction: 'Add a row for ', ask: true },
      { id: 'sort', label: 'Sort…', instruction: 'Sort the rows by ', ask: true },
      { id: 'shorten', label: 'Shorten cells', instruction: 'Shorten the text in the cells — keep every figure.' },
      { id: 'chart', label: 'Turn into chart', instruction: 'Turn it into a chart of its figures.' },
    ];
    case 'cells': return [
      { id: 'grammar', label: 'Fix grammar', instruction: 'Fix spelling, grammar and punctuation only.' },
      { id: 'shorten', label: 'Shorten', instruction: 'Shorten the text — keep every figure.' },
      { id: 'formal', label: 'Make formal', instruction: 'Make the wording more formal.' },
    ];
    case 'chart': return [
      { id: 'line', label: 'Line chart', instruction: 'Change it to a line chart.' },
      { id: 'bar', label: 'Bar chart', instruction: 'Change it to a bar chart.' },
      { id: 'pie', label: 'Pie chart', instruction: 'Change it to a pie chart.' },
      { id: 'series', label: 'Add data series…', instruction: 'Add a data series for ', ask: true },
      { id: 'title', label: 'Better title', instruction: 'Give it a clear, specific title.' },
      { id: 'labels', label: 'Clearer labels', instruction: 'Make the axis labels and legend clearer — keep the data.' },
    ];
    case 'mermaid': return [
      { id: 'simplify', label: 'Simplify diagram', instruction: 'Simplify the diagram: fewer crossing edges and shorter labels — keep its meaning.' },
      { id: 'node', label: 'Add a node…', instruction: 'Add a node for ', ask: true },
      { id: 'direction', label: 'Left to right', instruction: 'Lay it out left to right (flowchart LR).' },
      { id: 'labels', label: 'Label the arrows', instruction: 'Label each arrow with what flows along it.' },
      { id: 'fix', label: 'Fix syntax', instruction: 'Fix any Mermaid syntax problems; change nothing else.' },
    ];
    case 'caption': return [
      { id: 'improve', label: 'Improve caption', instruction: 'Rewrite the caption so it says what the image shows and why it matters.' },
      { id: 'shorten', label: 'Shorten', instruction: 'Shorten the caption.' },
      PROSE_ACTIONS[5]!,
    ];
    case 'json': return [
      PROSE_ACTIONS[0]!,
      { id: 'shorten', label: 'Shorten text', instruction: 'Shorten the text in it — keep every figure and entry.' },
      PROSE_ACTIONS[3]!,
    ];
  }
}

// ── The agent's way in: naming a part in words ───────────────────────

/** How the agent (Canvas `edit_part`) names a part: what kind, under which heading, containing what, which one. */
export interface PartQuery {
  /** paragraph | heading | list | quote | table | chart | diagram | callout | image | code | section */
  kind?: string;
  /** A heading's text (exact, else case-insensitive, else contained): the part is in that section. */
  section?: string;
  /** Text the block contains (as written, or as read with the Markdown marks removed). */
  quote?: string;
  /** 1-based, when several blocks still match. */
  nth?: number;
  /** Tables: 1-based body rows `[from, to]`. */
  rows?: [number, number];
  /** Tables: column names or 1-based numbers. */
  columns?: Array<string | number>;
  /** Decks: the slide (its id "s3", or its 1-based number). */
  slide?: string | number;
  /** Decks: the element on it ("title", "bullets", "bullets.2", "table", "notes"…); default the whole slide. */
  element?: string;
}

const plainOf = (s: string): string => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function kindMatches(b: Block, kind: string): boolean {
  const k = kind.toLowerCase().replace(/s$/, '');
  const f = b.kind === 'code' ? parseFence(b.text) : null;
  switch (k) {
    case 'paragraph': case 'text': return b.kind === 'paragraph' && !parseImageLine(b.text);
    case 'heading': case 'title': return b.kind === 'heading';
    case 'list': case 'bullet': return b.kind === 'list';
    case 'quote': return b.kind === 'quote' && !parseCallout(b.text);
    case 'table': return b.kind === 'table';
    case 'chart': case 'graph': return Boolean(f && CHART_FENCES.has(f.lang));
    case 'diagram': case 'mermaid': case 'flowchart': return f?.lang === 'mermaid';
    case 'callout': case 'note': return Boolean(parseCallout(b.text));
    case 'image': case 'caption': case 'figure': return b.kind === 'paragraph' && Boolean(parseImageLine(b.text));
    case 'code': return b.kind === 'code' && !(f && (CHART_FENCES.has(f.lang) || f.lang === 'mermaid' || f.lang === 'callout'));
    case 'section': return b.kind === 'heading';
    default: return Boolean(f && f.lang === k);
  }
}

function describeBlock(blocks: readonly Block[], i: number): string {
  const b = blocks[i]!;
  const f = b.kind === 'code' ? parseFence(b.text) : null;
  const kind = f ? (CHART_FENCES.has(f.lang) ? 'chart' : f.lang === 'mermaid' ? 'diagram' : f.lang || 'code') : b.kind;
  const where = sectionPath(blocks, i);
  return `${kind}${where ? ` in "${where}"` : ''}: "${clip(plainOf(b.text), 70)}"`;
}

/**
 * Find the one part a query names, as a target. Ambiguity is an error that
 * lists the candidates — guessing which table was meant is how the wrong one
 * gets rewritten.
 */
export function findPart(text: string, q: PartQuery): { ok: true; target: Pick<PartTarget, 'blockIds' | 'cells' | 'part'> } | { ok: false; error: string } {
  const blocks = splitBlocks(text);
  const keys = blockKeys(blocks);
  const isSection = Boolean(q.kind && /^sections?$/i.test(q.kind));
  let from = 0;
  let to = blocks.length;
  if (q.section?.trim()) {
    const want = plainOf(q.section.replace(/^#+\s*/, ''));
    const heads = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.kind === 'heading');
    const h = heads.find(({ b }) => headingText(b) === q.section!.trim())
      ?? heads.find(({ b }) => plainOf(headingText(b)) === want)
      ?? heads.find(({ b }) => plainOf(headingText(b)).includes(want));
    if (!h) return { ok: false, error: `no heading matches "${q.section}". Headings: ${heads.slice(0, 20).map(({ b }) => `"${headingText(b)}"`).join(', ')}` };
    from = h.i;
    to = sectionEnd(blocks, h.i);
    if (isSection) return { ok: true, target: { blockIds: [keys[h.i]!], part: 'section' } };
  }
  let idx = Array.from({ length: to - from }, (_, k) => from + k).filter(i => blocks[i]!.kind !== 'pending' && blocks[i]!.kind !== 'rule');
  if (q.kind) idx = idx.filter(i => kindMatches(blocks[i]!, q.kind!));
  else if (q.section) idx = idx.filter(i => i !== from); // "in section X" means its content, not its heading
  if (q.quote?.trim()) {
    const raw = q.quote.trim();
    const plain = plainOf(raw);
    idx = idx.filter(i => blocks[i]!.text.includes(raw) || plainOf(blocks[i]!.text).includes(plain));
  }
  if (q.nth !== undefined) {
    const n = Math.floor(q.nth);
    if (n < 1 || n > idx.length) return { ok: false, error: `nth ${q.nth} is out of range: ${idx.length} block(s) match` };
    idx = [idx[n - 1]!];
  }
  if (!idx.length) return { ok: false, error: `nothing matches${q.kind ? ` a ${q.kind}` : ''}${q.section ? ` in "${q.section}"` : ''}${q.quote ? ` containing "${clip(q.quote, 60)}"` : ''}` };
  if (idx.length > 1) {
    return { ok: false, error: `${idx.length} blocks match — name one with part.nth or part.quote:\n${idx.slice(0, 8).map((i, n) => `${n + 1}) ${describeBlock(blocks, i)}`).join('\n')}` };
  }
  const i = idx[0]!;
  const target: Pick<PartTarget, 'blockIds' | 'cells' | 'part'> = { blockIds: [keys[i]!], ...(isSection ? { part: 'section' as const } : {}) };
  if ((q.rows || q.columns) && blocks[i]!.kind === 'table') {
    const t = parseTable(blocks[i]!.text)!;
    const cols = (q.columns ?? []).map(c => (typeof c === 'number' ? c - 1 : t.header.findIndex(h => plainOf(h) === plainOf(String(c)))));
    if (cols.some(c => c < 0 || c >= t.header.length)) return { ok: false, error: `columns must be among: ${t.header.map(h => `"${h}"`).join(', ')}` };
    const r = q.rows ?? [1, t.rows.length];
    target.cells = {
      r0: Math.max(0, r[0] - 1), r1: Math.min(t.rows.length - 1, r[1] - 1),
      c0: cols.length ? Math.min(...cols) : 0, c1: cols.length ? Math.max(...cols) : t.header.length - 1,
    };
  }
  return { ok: true, target };
}

/**
 * A replacement the agent wrote itself as Markdown, read as the part's own
 * patch kind so the same validator applies (a table as header/rows, a chart
 * as its option, a heading as its text). Anything that is not the part's
 * kind stays Markdown — a type change, allowed only when the instruction asks.
 */
export function patchFromMarkdown(part: ResolvedPart, md: string): PartPatch {
  const text = md.replace(/^\s*\n/, '').replace(/\s+$/, '');
  const one = splitBlocks(text);
  const f = one.length === 1 && one[0]!.kind === 'code' ? parseFence(one[0]!.text) : null;
  switch (part.kind) {
    case 'table': case 'cells': {
      const t = one.length === 1 && one[0]!.kind === 'table' ? parseTable(text) : null;
      return t ? { kind: 'table', header: t.header, rows: t.rows, align: t.align } : { kind: 'blocks', markdown: text };
    }
    case 'chart': {
      const spec = safeJson(f && CHART_FENCES.has(f.lang) ? f.body : text);
      return spec && typeof spec === 'object' && !Array.isArray(spec) ? { kind: 'chart', spec: spec as Record<string, unknown> } : { kind: 'blocks', markdown: text };
    }
    case 'mermaid':
      return f && f.lang !== 'mermaid' ? { kind: 'blocks', markdown: text } : { kind: 'mermaid', source: stripFence(text) };
    case 'json': {
      const j = safeJson(f ? f.body : text);
      return j !== undefined ? { kind: 'json', json: j } : { kind: 'blocks', markdown: text };
    }
    case 'caption': {
      const img = parseImageLine(text);
      return { kind: 'caption', caption: img ? img.caption ?? '' : text };
    }
    case 'text': {
      const head = part.wrap?.head.trim() ?? '';
      const tail = part.wrap?.tail.trim() ?? '';
      if (part.wrap && head && text.startsWith(head) && text.endsWith(tail)) {
        return { kind: 'text', text: text.slice(head.length, text.length - tail.length).replace(/^[ \t]*\n?|\n?[ \t]*$/g, '') };
      }
      if (part.blockKinds[0] === 'heading' && /^ {0,3}#{1,6}\s/.test(text)) {
        return { kind: 'text', text: text.replace(/^ {0,3}#{1,6}\s+(?:\d+(?:\.\d+)*\.?\s+)?/, '').replace(/\s+#+\s*$/, '') };
      }
      if (part.wrap) return f ? { kind: 'blocks', markdown: text } : { kind: 'text', text };
      return one.length === 1 && one[0]!.kind === part.blockKinds[0] ? { kind: 'text', text } : { kind: 'blocks', markdown: text };
    }
    case 'blocks':
      return { kind: 'blocks', markdown: text };
  }
}

// ── From what the person selected on the page ────────────────────────

/**
 * Where a selection made on the rendered page sits in a block's Markdown
 * source. The page shows `bold`, the source says `**bold**`; a link shows its
 * text, the source carries `[text](url)`. So the selected text is matched
 * with Markdown marks allowed between its characters, and must match exactly
 * once. The range is then widened until it cuts no mark or link in half — a
 * replacement that split `**…**` would change formatting outside the
 * selection. Null when it cannot be placed (the caller targets the block).
 */
export function locateSelection(source: string, selected: string): { start: number; end: number } | null {
  const want = selected.replace(/\s+/g, ' ').trim();
  if (!want || want.length > 4000) return null;
  let found: { start: number; end: number } | null = null;
  const exact = source.indexOf(want);
  if (exact >= 0 && source.indexOf(want, exact + 1) < 0) found = { start: exact, end: exact + want.length };
  if (!found) {
    const gap = '(?:[*_~`\\\\]|\\[|\\]\\([^)\\n]*\\)|<[^>\\n]*>)*';
    const parts = [...want].map(ch => (/\s/.test(ch) ? '\\s+(?:(?:[-*+]|\\d{1,9}[.)]|>)\\s+(?:\\[[ xX]\\]\\s+)?)?' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    let re: RegExp;
    try { re = new RegExp(parts.join(gap), 'g'); } catch { return null; }
    const hits = [...source.matchAll(re)];
    if (hits.length !== 1) return null;
    found = { start: hits[0]!.index!, end: hits[0]!.index! + hits[0]![0].length };
  }
  return balance(source, found.start, found.end);
}

/** Widen `[start, end)` until every emphasis mark, code span and link inside it is whole. */
function balance(src: string, start: number, end: number): { start: number; end: number } {
  for (let guard = 0; guard < 8; guard++) {
    const s = src.slice(start, end);
    let moved = false;
    for (const mark of ['**', '__', '~~', '`']) {
      const n = s.split(mark).length - 1;
      if (n % 2 === 0) continue;
      // Odd: one end of a pair is outside. Take the nearer side that closes it.
      const before = src.lastIndexOf(mark, start - 1);
      const after = src.indexOf(mark, end);
      const openBefore = before >= 0 && (src.slice(0, start).split(mark).length - 1) % 2 === 1;
      if (openBefore) start = before;
      else if (after >= 0) end = after + mark.length;
      moved = true;
    }
    // A link cut in half: "[text" without "](url)", or "](url)" without its "[".
    const open = s.lastIndexOf('[');
    if (open >= 0 && s.indexOf(']', open) < 0) {
      const close = /^[^\]\n]*\]\([^)\n]*\)/.exec(src.slice(end));
      if (close) { end += close[0].length; moved = true; }
    }
    const tail = /^[^[\n]*\]\([^)\n]*\)/.exec(s);
    if (tail) {
      const at = src.lastIndexOf('[', start);
      if (at >= 0) { start = at; moved = true; }
    } else if (/^\]\([^)\n]*\)/.test(src.slice(end))) {
      // Ends exactly at the link text's end: take the target too, so the link stays whole.
      end += /^\]\([^)\n]*\)/.exec(src.slice(end))![0].length;
      const at = src.lastIndexOf('[', start);
      if (at >= 0 && at < start && !src.slice(at, start).includes(']')) start = at;
      moved = true;
    }
    if (!moved) break;
  }
  return { start, end };
}
