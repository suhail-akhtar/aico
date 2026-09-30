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

export interface DocPageHandle {
  insert(kind: InsertKind, template?: string): void;
  /** Insert any Markdown block after the current one; it opens in the editor that suits it. */
  insertMarkdown(markdown: string): void;
  insertImage(file: File): Promise<void>;
  editor(): BlockEditorApi | null;
  /** Comment on the current selection. False when there is none. */
  commentOnSelection(): boolean;
  closeEditor(): void;
}

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

type EditMode = 'rich' | 'source' | 'table' | 'chart' | 'callout' | 'infographic';

/** Which editor a block opens in: the visual one when its Markdown is a shape that editor reads back. */
function modeFor(b: Pick<Block, 'kind' | 'text' | 'lang'>): EditMode | null {
  if (b.kind === 'pending' || (b.kind === 'html' && isToc(b.text))) return null;
  if (b.kind === 'paragraph' && parseImageLine(b.text)) return null;
  if ((b.kind === 'quote' || (b.kind === 'code' && b.lang === 'callout')) && parseCallout(b.text)) return 'callout';
  if (b.kind === 'table' && parseTable(b.text)) return 'table';
  if (b.kind === 'code' && b.lang === 'chart' && chartModelOf(b.text)) return 'chart';
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
}

let regionSeq = 0;

export const DocPage = React.forwardRef<DocPageHandle, DocPageProps>(function DocPage(props, ref) {
  const { host, canvasId, ctl, readOnlyText, activity, follow, comments, drawerOpen, setDrawerOpen, onEditorChange, onLinkRequest, onAsk, onError, instance, agentBusy = false, outlineOpen = false, onCloseOutline } = props;
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

  const setRegion = useCallback((r: Region | null) => {
    regionRef.current = r;
    setRegionTick(n => n + 1);
    onEditorChange(r ? (r.mode === 'rich' ? 'rich' : 'source') : null);
  }, [onEditorChange]);

  // ── Layout: a comment margin when there is room for one ──
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setWide(el.clientWidth >= 1040);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

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
    closeEditor: close,
  }), [insertText, insertImage, commentOnSelection, close]);

  const toc = useMemo(() => tocEntries(blocks), [blocks]);

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
      ) : (
        <SourceBlockEditor ref={editorApi} initial={region.text} lang={region.lang}
          side={SIDE_LANGS.has(region.lang ?? '') || /^\s*\$\$/.test(region.text)} onChange={commit} onDone={close}
          onSave={() => { void ctl.save(); }} onLinkRequest={onLinkRequest} onPasteImage={(f) => { void insertImage(f); }} label="Edit block source" />
      )}
    </div>
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
    const inSection = section && i >= section.from && i < section.to;
    const labelHere = (section && i === section.from) || (!writing && fresh.size > 0 && fresh.has(key) && keys.findIndex(k => fresh.has(k)) === i);
    const cls = `adoc-block is-${b.kind}${inSection ? ' is-agent' : ''}${fresh.has(key) ? ' is-fresh' : ''}${lastTouched.current === key && !region ? ' is-touched' : ''}`;
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
    const callout = (b.kind === 'quote' || (b.kind === 'code' && b.lang === 'callout')) && parseCallout(b.text);
    const tocHere = b.kind === 'html' && isToc(b.text);
    const mode = modeFor(b);
    // Prose opens with a click; everything drawn (charts, tables, infographics) with its Edit button or a double-click.
    const clickToEdit = mode === 'rich';
    rendered.push(
      <div key={key} className={cls} data-block={i} data-block-key={key} data-kind={b.kind}
        data-visual={img ? 'image' : infographic ? infographic.kind : callout ? 'callout' : tocHere ? 'toc' : b.lang || undefined}
        data-click-edit={clickToEdit ? '1' : undefined}
        tabIndex={readOnly ? undefined : 0}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); open(key); } }}
        onDoubleClick={() => { if (!clickToEdit && mode) open(key); }}>
        {labelHere && <AgentLabel />}
        {!readOnly && !clickToEdit && (mode || tocHere) && (
          <span className="adoc-block-edit" data-adoc-ui>
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
        ) : callout ? (
          <CalloutView text={b.text} />
        ) : tocHere ? (
          <TocView entries={toc} onGo={(idx) => { const k = keys[idx]; if (k) scrollToBlock(k); }} />
        ) : (
          <MarkdownRenderer content={b.text} />
        )}
      </div>,
    );
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
      <div ref={sheet} className={`adoc-sheet${wide ? ' is-wide' : ''}${outlineOpen ? ' has-outline' : ''}`}>
        <article ref={page} className="adoc-page" onMouseUp={onPageMouseUp} onClick={onPageClick} aria-label="Document">
          {writing && !section && <div className="adoc-writing-top" data-adoc-ui><AgentLabel inline /> AICO is editing this tab…</div>}
          {blocks.length === 0 && !region ? (
            <button type="button" className="adoc-empty-page" data-adoc-ui disabled={readOnly}
              onClick={() => insertText('', 'rich')}>
              {readOnly ? 'This version is empty.' : 'Empty page — click to start writing, or ask AICO in the chat.'}
            </button>
          ) : (
            <div className="markdown-body adoc-body">{rendered}</div>
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
            <button type="button" className="acv-pill" onClick={() => { onAsk(pill.selection, pill.at); setPill(null); }}>
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
