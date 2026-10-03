/**
 * The AICO Docs page: the document drawn block by block, each block edited in
 * place, the agent's work in progress shown where it happens, and comment
 * threads beside the words they are about.
 *
 * ## Editing keeps Markdown exact
 *
 * The page is `splitBlocks(text)` rendered with the chat's own renderer, one
 * block at a time. Opening a block puts an editor over exactly that block's
 * source span (the "region"); every change the editor reports replaces that
 * span and nothing else, and is recorded as a block edit so it survives a
 * concurrent write by the agent (`useCanvasDoc`). The bytes outside the
 * region — other paragraphs, spacing, odd list markers, tables — never pass
 * through any serialiser. That is the promise `CanvasEditor`'s header makes
 * for the source editor, kept for rich editing.
 *
 * ## The agent at work
 *
 * `canvas-activity` frames say which section the agent is writing: a pending
 * placeholder shimmers, and the section gets the accent edge and an "AICO"
 * label. When the write lands, the blocks it changed are briefly highlighted.
 * "Follow AICO" scrolls to where it is writing — never while the person has a
 * block open, and nothing here ever moves focus except the person's click.
 * If the agent rewrites the very block the person is editing, the editor
 * closes (their text is kept in the edit record) and the conflict banner
 * offers to keep theirs or take the agent's.
 *
 * ## Ask AICO on a part (ADR 0024)
 *
 * A selection's pill, a block's sparkle button, a right-click or Ctrl+K /
 * Ctrl+I open the inline panel (`InlineEdit`) under the part — a selection,
 * a block, a table's cell/row/column, a chart, a diagram, a section. While a
 * proposal is reviewed the part is drawn as its diff in place; Accept goes
 * through `applyPart` (nothing outside the part may change) as one block
 * edit, saved as one version with a note, with an Undo on the page.
 *
 * ## Page width, centring and the document's theme (round 3)
 *
 * The page is drawn at the document's chosen width (Narrow / Normal / Wide /
 * Full, `doc-themes.PAGE_WIDTHS`) and always centred: the sheet is a
 * three-column grid (gutter · page · gutter) and the comment margin lives in
 * the right gutter only when both gutters can hold it — so opening comments
 * never pushes the page off-centre (the owner's full-screen screenshot showed
 * exactly that). The document's theme (`doc-themes`) sets the page's data
 * attributes and variables; the generated rules and the block styles are
 * injected once, the same rules the exports print with.
 *
 * @module shared/ui/canvas/DocPage
 */

import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import {
  blockKeys, changedBlocks, findSection, headingText, insertBlockAfter, insertTemplate, removeBlock, replaceBlock, splitBlocks,
  type Block, type InsertKind,
} from './blocks';
import { richEditable } from './rich-md';
import { RichBlockEditor, SourceBlockEditor, type BlockEditorApi } from './BlockEditors';
import {
  CalloutEditor, CalloutView, ChartEditor, chartModelOf, ImageBlock, InfographicEditor, infographicOf, InfographicView,
  TableEditor, TocView,
} from './VisualBlocks';
import { imageLine, isToc, parseCallout, parseFence, parseImageLine, parseTable, tocEntries } from './visual';
import { anchorForSelection, CommentLayer, type Composer, type CommentsState } from './DocComments';
import { altFromName, imageDataUrl } from './export';
import type { CanvasActivity, CanvasHost } from './host';
import type { CanvasDocController } from './useCanvasDoc';
import { CvIcon } from './icons';
import { DocBlockEditor, DocBlockView, docBlockOf } from './DocBlocks';
import { InlineEdit, type InlineAccept, type InlineScope } from './InlineEdit';
import { applyPart, locateSelection, resolveTarget } from './scoped-edit';
import { DOC_BLOCK_CSS } from './doc-blocks';
import { pageWidthPx, themeAttrs, themeRules, type PageWidth, type ResolvedLook } from './doc-themes';
import { typedNumbering } from './doc-layout';

/** The generated theme rules and block styles, scoped to the page (one string for every page). */
const PAGE_CSS = `${DOC_BLOCK_CSS}
${themeRules('.aw article.adoc-page')}`;
/** The comment margin's width and the gap beside it (keep in step with canvas.css). */
const MARGIN_W = 290;
const MARGIN_GAP = 28;

export interface DocPageHandle {
  insert(kind: InsertKind, template?: string): void;
  /** Insert any Markdown block after the current one; it opens in the editor that suits it. */
  insertMarkdown(markdown: string): void;
  insertImage(file: File): Promise<void>;
  editor(): BlockEditorApi | null;
  /** Comment on the current selection. False when there is none. */
  commentOnSelection(): boolean;
  /** Ask AICO to edit the selection, or the block last clicked (ADR 0024). False when there is neither, or no engine route. */
  inlineEdit(): boolean;
  closeEditor(): void;
}

interface InlineState { scopes: InlineScope[]; scope: InlineScope; reviewing: boolean; seq: number; autoRun?: string }
interface Applied { before: string; after: string; at: number; index: number; label: string }

interface Region {
  key: string;
  start: number;
  text: string;
  /** The text when editing began — the "before" of the block edit. */
  original: string;
  index: number;
  mode: EditMode;
  caret?: { x: number; y: number };
  lang?: string;
}

type EditMode = 'rich' | 'source' | 'table' | 'chart' | 'callout' | 'infographic' | 'docblock';

/** Which editor a block opens in: the visual one when its Markdown is a shape that editor reads back. */
function modeFor(b: Pick<Block, 'kind' | 'text' | 'lang'>): EditMode | null {
  if (b.kind === 'pending' || (b.kind === 'html' && isToc(b.text))) return null;
  if (b.kind === 'paragraph' && parseImageLine(b.text)) return null;
  if ((b.kind === 'quote' || (b.kind === 'code' && b.lang === 'callout')) && parseCallout(b.text)) return 'callout';
  if (b.kind === 'table' && parseTable(b.text)) return 'table';
  if (b.kind === 'code' && b.lang === 'chart' && chartModelOf(b.text)) return 'chart';
  if (b.kind === 'code' && docBlockOf(b.text)?.parsed.ok) return 'docblock';
  if (b.kind === 'code' && infographicOf(b.text)) return 'infographic';
  if (PROSE.has(b.kind) && richEditable(b.text)) return 'rich';
  return 'source';
}

/** Source editors that read best beside their preview. */
const SIDE_LANGS = new Set(['mermaid', 'chart', 'math', 'latex', 'tex']);

interface Point { x: number; y: number }

const PROSE = new Set(['heading', 'paragraph', 'list', 'quote']);
const TASK = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/gm;

export interface DocPageProps {
  host: CanvasHost;
  canvasId: string;
  ctl: CanvasDocController;
  /** Showing an old version: drawn, not editable. */
  readOnlyText?: string;
  activity: CanvasActivity | null;
  follow: boolean;
  comments: CommentsState;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  onEditorChange: (kind: 'rich' | 'source' | null) => void;
  onLinkRequest: () => void;
  onAsk: (selection: string, at: Point) => void;
  onError: (message: string) => void;
  instance: string;
  /** A turn is running in this chat — the first pending section is where the agent will write next. */
  agentBusy?: boolean;
  outlineOpen?: boolean;
  onCloseOutline?: () => void;
  /** The document's look (theme, accent, classification, watermark); absent = the plain page. */
  look?: ResolvedLook;
  /** The page width to draw (the document's choice, or the default for this view). */
  pageWidth?: PageWidth;
  /** A letter's letterhead text (the theme's header style). */
  letterhead?: string;
}

let regionSeq = 0;

export const DocPage = React.forwardRef<DocPageHandle, DocPageProps>(function DocPage(props, ref) {
  const { host, canvasId, ctl, readOnlyText, activity, follow, comments, drawerOpen, setDrawerOpen, onEditorChange, onLinkRequest, onAsk, onError, instance, agentBusy = false, outlineOpen = false, onCloseOutline, look, pageWidth = 'normal', letterhead } = props;
  const pagePx = pageWidthPx(pageWidth);
  const readOnly = readOnlyText !== undefined;
  const text = readOnly ? readOnlyText : ctl.text;
  const blocks = useMemo(() => splitBlocks(text), [text]);
  const keys = useMemo(() => blockKeys(blocks), [blocks]);
  const tab = ctl.tabs.find(t => t.id === ctl.tabId);

  const scroll = useRef<HTMLDivElement | null>(null);
  const sheet = useRef<HTMLDivElement | null>(null);
  const page = useRef<HTMLDivElement | null>(null);
  const editorApi = useRef<BlockEditorApi | null>(null);
  const regionRef = useRef<Region | null>(null);
  const [, setRegionTick] = useState(0);
  const lastTouched = useRef<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [pill, setPill] = useState<{ at: Point; selection: string } | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [wide, setWide] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [inline, setInline] = useState<InlineState | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const canInline = Boolean(host.editPart) && !readOnly;

  const setRegion = useCallback((r: Region | null) => {
    regionRef.current = r;
    setRegionTick(n => n + 1);
    onEditorChange(r ? (r.mode === 'rich' ? 'rich' : 'source') : null);
  }, [onEditorChange]);

  // ── Layout: a comment margin when there is room for one on BOTH sides (the page stays centred) ──
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setWide(pagePx !== null && el.clientWidth >= pagePx + 2 * (MARGIN_W + MARGIN_GAP) + 48);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [pagePx]);

  // ── The region follows its text when the document changes around it ──
  useLayoutEffect(() => {
    const r = regionRef.current;
    if (!r || readOnly) return;
    if (text.slice(r.start, r.start + r.text.length) === r.text) return;
    const at = text.indexOf(r.text);
    if (r.text && at >= 0 && text.indexOf(r.text, at + 1) < 0) {
      regionRef.current = { ...r, start: at };
      setRegionTick(n => n + 1);
      return;
    }
    // The agent rewrote the block being edited. The person's text lives on in the
    // edit record (the conflict banner offers it back); the stale editor goes.
    setRegion(null);
    if (!ctl.conflict) onError('AICO rewrote the block you had open — showing its version.');
  }, [text, readOnly, setRegion, ctl.conflict, onError]);

  const commit = useCallback((md: string) => {
    const r = regionRef.current;
    if (!r) return;
    const cur = ctl.getText();
    let start = r.start;
    if (cur.slice(start, start + r.text.length) !== r.text) {
      const at = cur.indexOf(r.text);
      if (at < 0) return;
      start = at;
    }
    const next = cur.slice(0, start) + md + cur.slice(start + r.text.length);
    regionRef.current = { ...r, start, text: md };
    ctl.setText(next, { key: r.key, before: r.original, after: md, index: r.index });
  }, [ctl]);

  const close = useCallback(() => {
    const r = regionRef.current;
    if (!r) return;
    lastTouched.current = null;
    setRegion(null);
    editorApi.current = null;
    const cur = ctl.getText();
    if (!r.text.trim() && cur.slice(r.start, r.start + r.text.length) === r.text) {
      // An emptied block goes, with its blank line, rather than leaving a gap.
      ctl.setText(removeBlock(cur, { start: r.start, end: r.start + r.text.length }), { key: r.key, before: r.original, after: '', index: r.index });
    }
    const after = splitBlocks(ctl.getText());
    const k = blockKeys(after);
    const i = after.findIndex(b => b.start >= r.start);
    lastTouched.current = k[Math.max(0, (i < 0 ? after.length : i) - (r.text.trim() ? 0 : 1))] ?? null;
  }, [ctl, setRegion]);

  const open = useCallback((key: string, caret?: Point, asSource = false) => {
    if (readOnly) return;
    if (regionRef.current) close();
    const all = splitBlocks(ctl.getText());
    const i = blockKeys(all).indexOf(key);
    const b = all[i];
    if (!b || b.kind === 'pending') return;
    lastTouched.current = key;
    const mode = asSource ? 'source' : modeFor(b);
    if (!mode) return;
    setPill(null);
    setInline(null);
    setRegion({ key: `r${++regionSeq}`, start: b.start, text: b.text, original: b.text, index: i, mode, ...(caret ? { caret } : {}), ...(b.lang ? { lang: b.lang } : {}) });
  }, [readOnly, close, ctl, setRegion]);

  /** Replace one block outright (image options, TOC removal), recorded as a block edit. */
  const replaceWhole = useCallback((key: string, next: string) => {
    const cur = ctl.getText();
    const all = splitBlocks(cur);
    const i = blockKeys(all).indexOf(key);
    const b = all[i];
    if (!b || b.text === next) return;
    const text = next ? replaceBlock(cur, b, next) : removeBlock(cur, b);
    ctl.setText(text, { key: `blk${++regionSeq}`, before: b.text, after: next, index: i });
  }, [ctl]);

  // ── Inserting ──
  const insertText = useCallback((template: string, openAs: EditMode | null) => {
    if (readOnly) return;
    const touched = regionRef.current ? null : lastTouched.current;
    if (regionRef.current) close();
    const cur = ctl.getText();
    const all = splitBlocks(cur);
    const k = blockKeys(all);
    let ai = touched ? k.indexOf(touched) : -1;
    if (ai < 0) ai = all.length - 1;
    const anchor = ai >= 0 ? all[ai]! : null;
    const ins = insertBlockAfter(cur, anchor, template);
    const edit = anchor
      ? { key: `ins${++regionSeq}`, before: anchor.text, after: `${anchor.text}\n\n${template}`, index: ai }
      : { key: `ins${++regionSeq}`, before: '', after: template, index: 0 };
    ctl.setText(ins.source, edit);
    if (openAs) {
      const lang = parseFence(template)?.lang;
      setRegion({ key: `r${++regionSeq}`, start: ins.start, text: template, original: template, index: ai + 1, mode: openAs, ...(lang ? { lang } : {}) });
    } else {
      lastTouched.current = blockKeys(splitBlocks(ins.source))[ai + 1] ?? null;
    }
  }, [readOnly, close, ctl, setRegion]);

  const insertImage = useCallback(async (file: File) => {
    try {
      const url = await imageDataUrl(file);
      insertText(`![${altFromName(file.name)}](${url})`, null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [insertText, onError]);

  const commentOnSelection = useCallback((): boolean => {
    const p = page.current;
    const s = sheet.current;
    if (!p || !s || readOnly) return false;
    const anchor = anchorForSelection(p);
    if (!anchor) return false;
    const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    setComposer({ anchor, top: rect.top - s.getBoundingClientRect().top });
    setPill(null);
    if (!wide) setDrawerOpen(true);
    return true;
  }, [readOnly, wide, setDrawerOpen]);

  // ── Ask AICO on a part (ADR 0024) ──
  const openInline = useCallback((scopes: InlineScope[], autoRun?: string): boolean => {
    if (!canInline || !scopes.length) return false;
    if (regionRef.current) close();
    setPill(null);
    setApplied(null);
    setInline(cur => ({ scopes, scope: scopes[0]!, reviewing: false, seq: (cur?.seq ?? 0) + 1, ...(autoRun ? { autoRun } : {}) }));
    return true;
  }, [canInline, close]);

  /** The ways to scope an edit that starts at one block (and maybe one table cell). */
  const blockScopes = useCallback((key: string, cell?: { r: number; c: number }): InlineScope[] => {
    const all = splitBlocks(ctl.getText());
    const i = blockKeys(all).indexOf(key);
    const b = all[i];
    if (!b) return [];
    const one = { blockIds: [key] };
    if (b.kind === 'heading') return [{ label: 'Heading', target: one }, { label: 'Whole section', target: { ...one, part: 'section' } }];
    if (b.kind === 'table' && cell) {
      const t = parseTable(b.text);
      if (t) {
        const last = t.rows.length - 1;
        const n = t.header.length - 1;
        return [
          ...(cell.r >= 0 ? [{ label: 'This cell', target: { ...one, cells: { r0: cell.r, r1: cell.r, c0: cell.c, c1: cell.c } } }] : []),
          ...(cell.r >= 0 ? [{ label: 'Row', target: { ...one, cells: { r0: cell.r, r1: cell.r, c0: 0, c1: n } } }] : []),
          { label: 'Column', target: { ...one, cells: { r0: 0, r1: last, c0: cell.c, c1: cell.c } } },
          { label: 'Whole table', target: one },
        ];
      }
    }
    return [{ label: b.kind === 'paragraph' && parseImageLine(b.text) ? 'Caption' : 'This block', target: one }];
  }, [ctl]);

  /** Scopes for the page's current selection: the passage itself, then its block(s). */
  const selectionScopes = useCallback((): InlineScope[] => {
    const sel = window.getSelection();
    const p = page.current;
    if (!sel || sel.isCollapsed || !p || !sel.anchorNode || !p.contains(sel.anchorNode)) return [];
    const range = sel.getRangeAt(0);
    const elOf = (n: Node): HTMLElement | null => (n.nodeType === 1 ? n as HTMLElement : n.parentElement);
    const from = elOf(range.startContainer)?.closest<HTMLElement>('[data-block-key]');
    const to = elOf(range.endContainer)?.closest<HTMLElement>('[data-block-key]');
    if (!from || !to) return [];
    const all = splitBlocks(ctl.getText());
    const k = blockKeys(all);
    let i0 = k.indexOf(from.dataset.blockKey!);
    let i1 = k.indexOf(to.dataset.blockKey!);
    if (i0 < 0 || i1 < 0) return [];
    if (i0 > i1) [i0, i1] = [i1, i0];
    if (i0 !== i1) return [{ label: `${i1 - i0 + 1} blocks`, target: { blockIds: k.slice(i0, i1 + 1) } }];
    const b = all[i0]!;
    const key = k[i0]!;
    if (b.kind === 'table') {
      const cellOf = (n: Node): { r: number; c: number } | null => {
        const td = elOf(n)?.closest<HTMLTableCellElement>('td, th');
        const tr = td?.parentElement as HTMLTableRowElement | null;
        if (!td || !tr) return null;
        const head = tr.parentElement?.tagName === 'THEAD';
        const body = tr.closest('table')?.tBodies[0];
        return { r: head ? -1 : body ? Array.from(body.rows).indexOf(tr) : -1, c: td.cellIndex };
      };
      const a = cellOf(range.startContainer);
      const z = cellOf(range.endContainer);
      if (a && z) {
        const cells = { r0: Math.min(a.r, z.r), r1: Math.max(a.r, z.r), c0: Math.min(a.c, z.c), c1: Math.max(a.c, z.c) };
        return [{ label: 'Selected cells', target: { blockIds: [key], cells } }, { label: 'Whole table', target: { blockIds: [key] } }];
      }
      return blockScopes(key);
    }
    const whole = blockScopes(key);
    const found = locateSelection(b.text, sel.toString());
    if (!found || (found.start === 0 && found.end === b.text.length)) return whole;
    // A selection that cannot be edited on its own (a chart, a caption) falls back to the block.
    const r = resolveTarget(ctl.getText(), { blockIds: [key], range: found });
    return r.ok ? [{ label: 'Selection', target: { blockIds: [key], range: found } }, ...whole] : whole;
  }, [ctl, blockScopes]);

  const inlineFromSelection = useCallback((): boolean => {
    const scopes = selectionScopes();
    if (scopes.length) return openInline(scopes);
    const key = lastTouched.current;
    return key ? openInline(blockScopes(key)) : false;
  }, [selectionScopes, openInline, blockScopes]);

  const acceptInline = useCallback((a: InlineAccept): string | null => {
    const cur = ctl.getText();
    const r = applyPart(cur, a.part, a.after);
    if (!r.ok) return r.error;
    ctl.setText(r.text, { key: `ai${++regionSeq}`, before: a.part.before, after: a.after, index: a.part.blocks.from });
    void ctl.save(`AICO edit: ${a.instruction.slice(0, 120)}`);
    setApplied({ before: a.part.before, after: a.after, at: r.start, index: a.part.blocks.from, label: a.part.label });
    setInline(null);
    // What changed glows, as the agent's writes do.
    const now = splitBlocks(r.text);
    const nk = blockKeys(now);
    setFresh(new Set(now.map((b, n) => ({ b, n })).filter(({ b }) => b.start >= r.start && b.end <= r.start + a.after.length).map(({ n }) => nk[n]!)));
    window.setTimeout(() => setFresh(new Set()), 2600);
    return null;
  }, [ctl]);

  const undoInline = useCallback((): void => {
    if (!applied) return;
    const cur = ctl.getText();
    const r = applyPart(cur, { span: { start: applied.at, end: applied.at + applied.after.length }, before: applied.after }, applied.before);
    setApplied(null);
    if (!r.ok || !applied.after) { onError('Could not undo — that part changed since. The version history still has it.'); return; }
    ctl.setText(r.text, { key: `ai${++regionSeq}`, before: applied.after, after: applied.before, index: applied.index });
    void ctl.save('Undid an AICO edit');
  }, [applied, ctl, onError]);

  useEffect(() => {
    if (!applied) return;
    const t = window.setTimeout(() => setApplied(null), 15_000);
    return () => window.clearTimeout(t);
  }, [applied]);

  // A cell-range edit marks its cells in the page's table, so "This cell" is visible.
  useLayoutEffect(() => {
    const p = page.current;
    if (!p) return;
    p.querySelectorAll('[data-ai-cell]').forEach(el => el.removeAttribute('data-ai-cell'));
    const t = inline && !inline.reviewing ? inline.scope.target : null;
    if (!t?.cells || !t.blockIds?.[0]) return;
    const table = p.querySelector(`[data-block-key="${CSS.escape(t.blockIds[0])}"] table`) as HTMLTableElement | null;
    if (!table) return;
    const c = t.cells;
    const rows = [...(table.tHead ? Array.from(table.tHead.rows).slice(0, 1) : []), ...Array.from(table.tBodies[0]?.rows ?? [])];
    rows.forEach((tr, i) => {
      const r = table.tHead ? i - 1 : i;
      if (r < c.r0 || r > c.r1) return;
      Array.from(tr.cells).forEach((cell, ci) => { if (ci >= c.c0 && ci <= c.c1) cell.setAttribute('data-ai-cell', ''); });
    });
  });

  // A part that is no longer in the document (the agent rewrote it) closes its panel.
  useEffect(() => {
    if (!inline || inline.reviewing) return;
    if (!resolveTarget(text, inline.scope.target).ok && !inline.scope.target.range) setInline(null);
  }, [text, inline]);

  const onPageContextMenu = (e: React.MouseEvent): void => {
    if (!canInline || e.shiftKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-adoc-ui], .adoc-editing, .adoc-pending, a, input, textarea')) return;
    const blockEl = target.closest<HTMLElement>('[data-block-key]');
    if (!blockEl) return;
    const fromSel = selectionScopes();
    let scopes = fromSel;
    if (!scopes.length) {
      const td = target.closest<HTMLTableCellElement>('td, th');
      const tr = td?.parentElement as HTMLTableRowElement | null;
      const cell = td && tr ? { r: tr.parentElement?.tagName === 'THEAD' ? -1 : Array.from(tr.closest('table')?.tBodies[0]?.rows ?? []).indexOf(tr), c: td.cellIndex } : undefined;
      scopes = blockScopes(blockEl.dataset.blockKey!, cell);
    }
    if (!scopes.length) return;
    e.preventDefault();
    lastTouched.current = blockEl.dataset.blockKey!;
    openInline(scopes);
  };

  useImperativeHandle(ref, () => ({
    insert: (kind, template) => {
      const t = template ?? insertTemplate(kind);
      const [b] = splitBlocks(t);
      insertText(t, kind === 'divider' || !b ? null : modeFor(b));
    },
    insertMarkdown: (md) => {
      const [b] = splitBlocks(md);
      insertText(md, b ? modeFor(b) : null);
    },
    insertImage,
    editor: () => editorApi.current,
    commentOnSelection,
    inlineEdit: inlineFromSelection,
    closeEditor: close,
  }), [insertText, insertImage, commentOnSelection, inlineFromSelection, close]);

  const toc = useMemo(() => tocEntries(blocks), [blocks]);
  // Headings the author numbered by hand: the page shows their numbers, not a second set (the export replaces them, ADR 0022).
  const typedNumbers = useMemo(() => {
    const top = Math.min(...toc.map(e => e.level));
    return typedNumbering(toc.filter(e => e.level === top).map(e => e.text));
  }, [toc]);
  const themed = useMemo(() => {
    if (!look) return { attrs: {}, style: undefined };
    const t = themeAttrs(look);
    if (typedNumbers) delete t.attrs['data-dt-numbered'];
    // Unthemed, the page keeps the app's own accent (canvas.css); a theme brings its accent and faces.
    return { attrs: t.attrs, style: (look.theme ? t.vars : undefined) as React.CSSProperties | undefined };
  }, [look, typedNumbers]);

  // ── The agent at work ──
  const writing = activity && activity.status === 'writing' && (!activity.tabId || activity.tabId === ctl.tabId) ? activity : null;
  const section = useMemo(() => {
    if (writing) {
      const found = findSection(blocks, writing.section, tab?.sectionIds) ?? findSection(blocks, writing.heading, tab?.sectionIds);
      if (found) return found;
    }
    // Tool arguments are not streamed, so "writing" arrives only as the section lands. While a
    // turn runs and placeholders remain, the next one (they are written in order) is where AICO is.
    if (agentBusy && !readOnly) {
      const p = blocks.findIndex(b => b.kind === 'pending');
      if (p >= 0) return { from: p, to: p + 1 };
    }
    return null;
  }, [writing, blocks, tab?.sectionIds, agentBusy, readOnly]);

  // What the agent just wrote glows for a moment.
  const agentAt = ctl.agentWrite?.at;
  useEffect(() => {
    if (!agentAt || !ctl.agentWrite || readOnly) return;
    const changed = changedBlocks(ctl.agentWrite.before, blocks);
    if (!changed.length) return;
    setFresh(new Set(changed.map(i => keys[i]!)));
    const t = window.setTimeout(() => setFresh(new Set()), 2600);
    if (follow && !regionRef.current) scrollToBlock(keys[changed[0]!]!);
    return () => window.clearTimeout(t);
    // Only a new agent write starts a highlight; the blocks are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentAt]);

  const sectionKey = section ? keys[section.from] : null;
  useEffect(() => {
    if (follow && sectionKey && !regionRef.current) scrollToBlock(sectionKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, sectionKey, writing?.section]);

  function scrollToBlock(key: string): void {
    const s = scroll.current;
    const el = s?.querySelector<HTMLElement>(`[data-block-key="${CSS.escape(key)}"]`);
    if (!s || !el) return;
    const top = s.scrollTop + el.getBoundingClientRect().top - s.getBoundingClientRect().top - 96;
    s.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  // ── Pointer: click to edit, select to comment ──
  const onPageMouseUp = (e: React.MouseEvent): void => {
    if (readOnly) {
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('[data-adoc-ui], .adoc-editing, .adoc-pending')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && page.current?.contains(sel.anchorNode)) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const s = sheet.current!.getBoundingClientRect();
      setPill({ at: { x: rect.left - s.left + Math.min(rect.width, 280) / 2, y: rect.bottom - s.top + 8 }, selection: sel.toString() });
      return;
    }
    setPill(null);
    const blockEl = target.closest<HTMLElement>('[data-block-key]');
    if (!blockEl || e.button !== 0) return;
    const key = blockEl.dataset.blockKey!;
    lastTouched.current = key;
    if (target.closest('input[type=checkbox]')) return;
    if (target.closest('a') && (e.ctrlKey || e.metaKey)) return;
    // Charts, diagrams, code and tables are interactive: they open with their Edit button or a double-click.
    if (blockEl.dataset.clickEdit === '1') open(key, { x: e.clientX, y: e.clientY });
  };

  const onPageClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement;
    const a = target.closest('a');
    if (a && page.current?.contains(a) && !a.closest('.adoc-editing') && !(e.ctrlKey || e.metaKey)) e.preventDefault();
    const box = target.closest<HTMLInputElement>('input[type=checkbox]');
    const blockEl = target.closest<HTMLElement>('[data-block-key]');
    if (box && blockEl && !readOnly && !box.closest('.adoc-editing')) {
      e.preventDefault();
      toggleTask(blockEl.dataset.blockKey!, Array.from(blockEl.querySelectorAll('input[type=checkbox]')).indexOf(box));
    }
  };

  const toggleTask = (key: string, n: number): void => {
    const cur = ctl.getText();
    const all = splitBlocks(cur);
    const i = blockKeys(all).indexOf(key);
    const b = all[i];
    if (!b || n < 0) return;
    let seen = -1;
    const next = b.text.replace(TASK, (m, lead: string, mark: string) => (++seen === n ? `${lead}[${mark === ' ' ? 'x' : ' '}]` : m));
    if (next !== b.text) ctl.setText(replaceBlock(cur, b, next), { key: `task${++regionSeq}`, before: b.text, after: next, index: i });
  };

  const onDrop = (e: React.DragEvent): void => {
    setDropping(false);
    const file = Array.from(e.dataTransfer.files ?? []).find(f => f.type.startsWith('image/'));
    if (!file || readOnly) return;
    e.preventDefault();
    const blockEl = (e.target as HTMLElement).closest<HTMLElement>('[data-block-key]');
    if (blockEl) lastTouched.current = blockEl.dataset.blockKey!;
    void insertImage(file);
  };

  const onPaste = (e: React.ClipboardEvent): void => {
    if (readOnly || regionRef.current) return;
    const file = Array.from(e.clipboardData.files ?? []).find(f => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); void insertImage(file); }
  };

  useEffect(() => {
    if (!pill) return;
    const away = (e: MouseEvent): void => { if (!(e.target as HTMLElement).closest('.acv-pill-row')) setPill(null); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [pill]);

  // ── Drawing ──
  const region = regionRef.current;
  const pendingAction = (b: Block, how: 'self' | 'ask'): void => {
    if (!b.pending) return;
    if (how === 'ask') {
      host.ask(`Write section ${b.pending.id}${b.pending.heading ? ` ("${b.pending.heading}")` : ''} of canvas ${canvasId} now.`);
      return;
    }
    const cur = ctl.getText();
    const heading = `## ${b.pending.heading || b.pending.intent.split(/[:.—-]/)[0]!.trim() || 'New section'}`;
    const i = blocks.indexOf(b);
    ctl.setText(replaceBlock(cur, b, heading), { key: `pend${++regionSeq}`, before: b.text, after: heading, index: i });
    setRegion({ key: `r${++regionSeq}`, start: b.start, text: heading, original: heading, index: i, mode: 'rich' });
  };

  const editorEl = region && !readOnly ? (
    <div key={region.key} className={`adoc-block adoc-editing is-${region.mode}`} data-adoc-editing>
      {region.mode === 'rich' ? (
        <RichBlockEditor ref={editorApi} initial={region.text} onChange={commit} onDone={close} onSave={() => { void ctl.save(); }}
          onLinkRequest={onLinkRequest} onPasteImage={(f) => { void insertImage(f); }} caret={region.caret} label="Edit block" />
      ) : region.mode === 'table' ? (
        <TableEditor initial={region.text} onChange={commit} onDone={close} />
      ) : region.mode === 'chart' ? (
        <ChartEditor initial={region.text} onChange={commit} onDone={close} />
      ) : region.mode === 'callout' ? (
        <CalloutEditor initial={region.text} onChange={commit} onDone={close} />
      ) : region.mode === 'infographic' ? (
        <InfographicEditor initial={region.text} onChange={commit} onDone={close} />
      ) : region.mode === 'docblock' ? (
        <DocBlockEditor initial={region.text} onChange={commit} onDone={close} />
      ) : (
        <SourceBlockEditor ref={editorApi} initial={region.text} lang={region.lang}
          side={SIDE_LANGS.has(region.lang ?? '') || /^\s*\$\$/.test(region.text)} onChange={commit} onDone={close}
          onSave={() => { void ctl.save(); }} onLinkRequest={onLinkRequest} onPasteImage={(f) => { void insertImage(f); }} label="Edit block source" />
      )}
    </div>
  ) : null;

  const inlineRange = inline && !readOnly ? (() => {
    const r = resolveTarget(text, inline.scope.target);
    return r.ok ? r.part.blocks : null;
  })() : null;
  const inlinePanel = inline && inlineRange ? (
    <InlineEdit key={`aie${inline.seq}`} host={host} canvasId={canvasId} {...(ctl.doc?.tabs ? { tabId: ctl.tabId } : {})} getText={ctl.getText}
      scopes={inline.scopes} {...(inline.autoRun ? { autoRun: inline.autoRun } : {})}
      saveFirst={() => ctl.save()} onAccept={acceptInline}
      onReviewing={(reviewing) => setInline(cur => (cur && cur.reviewing !== reviewing ? { ...cur, reviewing } : cur))}
      onScope={(scope) => setInline(cur => (cur ? { ...cur, scope } : cur))}
      onClose={() => setInline(null)} />
  ) : null;

  const rendered: React.ReactNode[] = [];
  let placed = false;
  const rs = region?.start ?? -1;
  const re = region ? region.start + region.text.length : -1;
  blocks.forEach((b, i) => {
    if (region && !readOnly) {
      if (region.text.length > 0 && b.start >= rs && b.end <= re) {
        if (!placed) { rendered.push(editorEl); placed = true; }
        return;
      }
      if (!placed && b.start >= re) { rendered.push(editorEl); placed = true; }
    }
    const key = keys[i]!;
    const aiTarget = inlineRange && i >= inlineRange.from && i < inlineRange.to;
    if (aiTarget && inline!.reviewing) {
      // Under review, the part is drawn as its proposal (inside the panel), not twice.
      if (i === inlineRange!.to - 1) rendered.push(<React.Fragment key={`aie-${key}`}>{inlinePanel}</React.Fragment>);
      return;
    }
    const inSection = section && i >= section.from && i < section.to;
    const labelHere = (section && i === section.from) || (!writing && fresh.size > 0 && fresh.has(key) && keys.findIndex(k => fresh.has(k)) === i);
    const cls = `adoc-block is-${b.kind}${inSection ? ' is-agent' : ''}${fresh.has(key) ? ' is-fresh' : ''}${lastTouched.current === key && !region ? ' is-touched' : ''}${aiTarget ? ' is-ai-target' : ''}`;
    if (b.kind === 'pending' && b.pending) {
      const busy = Boolean(inSection);
      rendered.push(
        <div key={key} className={cls} data-block={i} data-block-key={key} data-kind="pending">
          {busy && <AgentLabel />}
          <div className={`adoc-pending${busy ? ' is-writing' : ''}`} data-adoc-ui>
            <div className="adoc-pending-head">
              <CvIcon name="sparkle" size={14} />
              <span className="adoc-pending-title">{b.pending.heading || 'Section to write'}</span>
            </div>
            {b.pending.intent && <p className="adoc-pending-intent">{b.pending.intent}</p>}
            <div className="adoc-pending-foot">
              <span>{busy ? 'AICO is writing this section…' : 'AICO will write this'}</span>
              {!readOnly && !busy && (
                <span className="adoc-pending-actions">
                  <button type="button" className="aw-btn adoc-mini" onClick={() => pendingAction(b, 'self')}>Write it myself</button>
                  <button type="button" className="aw-btn adoc-mini" onClick={() => pendingAction(b, 'ask')}>Ask AICO now</button>
                </span>
              )}
            </div>
          </div>
        </div>,
      );
      return;
    }
    const img = b.kind === 'paragraph' ? parseImageLine(b.text) : null;
    const infographic = b.kind === 'code' ? infographicOf(b.text) : null;
    const docBlock = b.kind === 'code' && !infographic ? docBlockOf(b.text) : null;
    const callout = (b.kind === 'quote' || (b.kind === 'code' && b.lang === 'callout')) && parseCallout(b.text);
    const tocHere = b.kind === 'html' && isToc(b.text);
    const mode = modeFor(b);
    // Prose opens with a click; everything drawn (charts, tables, infographics) with its Edit button or a double-click.
    const clickToEdit = mode === 'rich';
    rendered.push(
      <div key={key} className={cls} data-block={i} data-block-key={key} data-kind={b.kind}
        data-visual={img ? 'image' : infographic ? infographic.kind : docBlock ? docBlock.kind : callout ? 'callout' : tocHere ? 'toc' : b.lang || undefined}
        data-click-edit={clickToEdit ? '1' : undefined}
        tabIndex={readOnly ? undefined : 0}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); open(key); } }}
        onDoubleClick={() => { if (!clickToEdit && mode) open(key); }}>
        {labelHere && <AgentLabel />}
        {canInline && clickToEdit && !aiTarget && (
          <span className="adoc-block-edit" data-adoc-ui>
            <button type="button" className="adoc-ai-btn" onClick={() => openInline(blockScopes(key))} title="Ask AICO to edit this (Ctrl+K)" aria-label="Ask AICO to edit this block">
              <CvIcon name="sparkle" size={12} />
            </button>
          </span>
        )}
        {!readOnly && !clickToEdit && (mode || tocHere) && (
          <span className="adoc-block-edit" data-adoc-ui>
            {canInline && mode && !aiTarget && (
              <button type="button" className="adoc-ai-btn" onClick={() => openInline(blockScopes(key))} title="Ask AICO to edit this (Ctrl+K)" aria-label="Ask AICO to edit this block">
                <CvIcon name="sparkle" size={12} /> Ask AICO
              </button>
            )}
            {mode && mode !== 'source' && (
              <button type="button" onClick={() => open(key)} title="Edit" aria-label="Edit block"><CvIcon name="pencil" size={12} /> Edit</button>
            )}
            {mode && (
              <button type="button" onClick={() => open(key, undefined, true)} title="Edit the Markdown source of this block" aria-label="Edit block source">
                <CvIcon name="markdown" size={13} /> {mode === 'source' ? 'Edit' : 'Source'}
              </button>
            )}
            {tocHere && (
              <button type="button" onClick={() => replaceWhole(key, '')} title="Remove the table of contents" aria-label="Remove table of contents">
                <CvIcon name="trash" size={12} /> Remove
              </button>
            )}
          </span>
        )}
        {img ? (
          <ImageBlock img={img} readOnly={readOnly} onChange={(next) => replaceWhole(key, imageLine(next))} />
        ) : infographic ? (
          <InfographicView kind={infographic.kind} body={infographic.body} />
        ) : docBlock ? (
          <DocBlockView text={b.text} />
        ) : callout ? (
          <CalloutView text={b.text} />
        ) : tocHere ? (
          <TocView entries={toc} onGo={(idx) => { const k = keys[idx]; if (k) scrollToBlock(k); }} />
        ) : (
          <MarkdownRenderer content={b.text} />
        )}
      </div>,
    );
    if (aiTarget && i === inlineRange!.to - 1) rendered.push(<React.Fragment key={`aie-${key}`}>{inlinePanel}</React.Fragment>);
  });
  if (region && !readOnly && !placed) rendered.push(editorEl);

  return (
    <div className="adoc-wrap">
      {outlineOpen && (
      <nav className="adoc-outline" aria-label="Document outline" data-adoc-ui>
        <div className="adoc-outline-head">
          Outline
          <button type="button" className="aw-icon-btn" onClick={onCloseOutline} aria-label="Close outline"><CvIcon name="close" size={13} /></button>
        </div>
        {blocks.some(b => b.kind === 'heading' || b.kind === 'pending') ? (
          <ol>
            {blocks.map((b, i) => (b.kind === 'heading' ? (
              <li key={keys[i]} style={{ paddingLeft: `${((b.level ?? 1) - 1) * 12}px` }}>
                <button type="button" onClick={() => scrollToBlock(keys[i]!)}>{headingText(b) || 'Untitled'}</button>
              </li>
            ) : b.kind === 'pending' ? (
              <li key={keys[i]} className="is-pending" style={{ paddingLeft: '12px' }}>
                <button type="button" onClick={() => scrollToBlock(keys[i]!)}>{b.pending?.heading || b.pending?.intent || 'Section'}</button>
              </li>
            ) : null))}
          </ol>
        ) : <p className="adoc-empty-note">Headings appear here.</p>}
      </nav>
    )}
    <div ref={scroll} className={`adoc-scroll${dropping ? ' is-dropping' : ''}`}
      onDragOver={(e) => { if (!readOnly && Array.from(e.dataTransfer.items ?? []).some(it => it.kind === 'file')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      onPaste={onPaste}>
      <style>{PAGE_CSS}</style>
      <div ref={sheet} className={`adoc-sheet${wide ? ' is-wide' : ''}${outlineOpen ? ' has-outline' : ''}`} data-width={pageWidth}
        style={{ '--adoc-page-w': pagePx === null ? '100%' : `${pagePx}px` } as React.CSSProperties}>
        <article ref={page} className="adoc-page" onMouseUp={onPageMouseUp} onClick={onPageClick} onContextMenu={onPageContextMenu} aria-label="Document"
          {...themed.attrs} style={themed.style}>
          {look?.watermark && <div className="adoc-watermark" aria-hidden="true" data-adoc-ui><span>{look.watermark}</span></div>}
          {look?.classification && <div className="adoc-classification" data-adoc-ui>{look.classification}</div>}
          {letterhead && <div className="adoc-letterhead" data-adoc-ui><span className="adoc-lh-name">{letterhead}</span></div>}
          {writing && !section && <div className="adoc-writing-top" data-adoc-ui><AgentLabel inline /> AICO is editing this tab…</div>}
          {blocks.length === 0 && !region ? (
            <button type="button" className="adoc-empty-page" data-adoc-ui disabled={readOnly}
              onClick={() => insertText('', 'rich')}>
              {readOnly ? 'This version is empty.' : 'Empty page — click to start writing, or ask AICO in the chat.'}
            </button>
          ) : (
            <div className="markdown-body adoc-body">{rendered}</div>
          )}
          {look?.classification && <div className="adoc-classification is-bottom" data-adoc-ui>{look.classification}</div>}
          {applied && (
            <div className="aie-toast" role="status" data-adoc-ui>
              <CvIcon name="sparkle" size={13} /> AICO edited the {applied.label.toLowerCase().replace(/ ·.*$/, '')}
              <button type="button" className="aw-btn adoc-mini" onClick={undoInline}><CvIcon name="undo" size={12} /> Undo</button>
              <button type="button" className="aw-icon-btn" onClick={() => setApplied(null)} aria-label="Dismiss"><CvIcon name="close" size={12} /></button>
            </div>
          )}
        </article>
        {!readOnly && (
          <CommentLayer state={comments} page={page.current} sheet={sheet.current} tabId={ctl.tabId} text={text}
            wide={wide} drawerOpen={drawerOpen} onCloseDrawer={() => setDrawerOpen(false)}
            composer={composer} onComposerDone={() => setComposer(null)} activeId={activeComment} onActivate={setActiveComment}
            showResolved={showResolved} onToggleResolved={() => setShowResolved(v => !v)} instance={instance} />
        )}
        {pill && (
          <div className="acv-pill-row" style={{ left: Math.max(8, pill.at.x - 90), top: pill.at.y }} data-adoc-ui
            onMouseDown={e => e.preventDefault()}>
            {comments.supported !== false && (
              <button type="button" className="acv-pill" onClick={() => { commentOnSelection(); }}>
                <CvIcon name="comment" size={13} /> Comment
              </button>
            )}
            <button type="button" className="acv-pill" onClick={() => {
              if (!inlineFromSelection()) onAsk(pill.selection, pill.at);
              setPill(null);
            }}>
              <CvIcon name="sparkle" size={13} /> Ask AICO
            </button>
          </div>
        )}
      </div>
    </div>
    </div>
  );
});

function AgentLabel({ inline = false }: { inline?: boolean }): React.ReactElement {
  return <span className={`adoc-agent-label${inline ? ' is-inline' : ''}`} data-adoc-ui aria-label="AICO is writing here">AICO</span>;
}
