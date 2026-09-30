/**
 * The canvas editor — a document or code file the agent writes and the person
 * edits, beside the chat (desktop) or in place of its card (browser, VS Code).
 * Documents open as **AICO Docs**: a page drawn block by block, edited in
 * place, with tabs, comments and the agent's live writing shown where it
 * happens; the Markdown source stays one click away.
 *
 * ## Why the document stays Markdown, edited by exact spans
 *
 * The document's one true form is Markdown text, and the agent edits it by
 * exact find/replace against what it last read. A WYSIWYG editor (TipTap,
 * ProseMirror, Milkdown) holds a tree and re-serialises the whole document on
 * every save: list markers, emphasis characters, table padding, escapes and
 * line breaks come back normalised. A one-word edit by the person would then
 * rewrite lines they never touched — every version in the history would be a
 * whole-document diff, and the passage the agent copied for its next `find`
 * would no longer exist.
 *
 * So the page (`DocPage`) never serialises the document. It cuts the text
 * into top-level blocks with their source spans (`blocks.ts`) and opens an
 * editor over one block at a time: prose in a small rich editor that turns
 * only that block back into Markdown — and only if it round-trips byte for
 * byte to begin with (`rich-md.ts`) — and everything else as source with a
 * live preview. Saving replaces that block's span; every other byte is copied
 * through. The Markdown source mode (the original editor: a textarea, the
 * browser's own undo, IME and spell-check, and the chat's renderer as preview)
 * is still here for anyone who prefers it. None of this costs a dependency in
 * the three builds (web, desktop, the VS Code webview).
 *
 * Formatting is a toolbar and the usual shortcuts, applied through the
 * browser's editing commands so Ctrl+Z undoes a toolbar action like typing.
 *
 * ## Saving and conflicts
 *
 * Autosave 800 ms after the last change, per tab, always with the version the
 * text was based on (`useCanvasDoc`). If the agent wrote in between, the save
 * is refused (409); block edits are re-applied to the agent's version when
 * their block is still there, and otherwise a banner offers "Keep mine" or
 * "Take the agent's". When the agent writes while nothing is pending here,
 * the new version simply replaces the text — live, from the session stream.
 *
 * @module shared/ui/canvas/CanvasEditor
 */

import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { copyText, downloadText } from '../rich/common';
import { markdownToPlain } from '../rich/specs';
import {
  getCanvasHost, onCanvasActivity, type CanvasActivity, type CanvasHost, type CanvasRef, type CanvasVersion, type DocSettings,
  type ExportFormat,
} from './host';
import {
  applySplice, askMessage, authorLabel, canvasFileName, CODE_ACTIONS, continueList, DOCUMENT_ACTIONS, fileBase,
  formatSplice, relativeTime, standaloneHtml, wordCount, type FormatOp, type QuickAction, type Splice,
} from './core';
import { stripPending, tableMarkdown, type InsertKind } from './blocks';
import {
  CALLOUTS, MERMAID_TEMPLATES, TOC_LINE, calloutMarkdown, chartTemplate, infographicTemplate, mermaidTemplate,
  type ChartType, type InfographicKind,
} from './visual';
import { ExportDialog, rememberSettings, storedSettings, TemplatePicker } from './DocDialogs';
import { longDate, templateById } from './templates';
import { useCanvasDoc } from './useCanvasDoc';
import { DocPage, type DocPageHandle } from './DocPage';
import { useComments } from './DocComments';
import type { EditOp } from './BlockEditors';
import { desktopPdf, EXPORT_TYPES, pickImage, saveBlob } from './export';
import { CodeArea } from './CodeArea';
import { CvIcon, type CanvasIconName } from './icons';
import './canvas.css';

export interface CanvasEditorProps {
  id: string;
  /** What the card already knows, drawn while the document loads. */
  initial?: CanvasRef;
  /** `panel` fills its parent; `inline` is a bordered block in the transcript. */
  variant?: 'panel' | 'inline';
  onClose?: () => void;
}

type Mode = 'write' | 'split' | 'preview';
type View = 'page' | 'source';
const MODE_KEY = 'aico.canvas.mode';
const VIEW_KEY = 'aico.docs.view';
const FOLLOW_KEY = 'aico.docs.follow';
const ACTIVITY_TIMEOUT_MS = 180_000;

function stored<T extends string>(key: string, allowed: readonly T[]): T | null {
  try {
    const m = localStorage.getItem(key);
    return m && (allowed as readonly string[]).includes(m) ? m as T : null;
  } catch { return null; }
}

function remember(key: string, v: string): void {
  try { localStorage.setItem(key, v); } catch { /* private mode: just not remembered */ }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Render Markdown to HTML with the chat's renderer, for copy and export. */
function renderHtml(markdown: string): string {
  const div = document.createElement('div');
  const root = createRoot(div);
  flushSync(() => root.render(<MarkdownRenderer content={markdown} />));
  div.querySelectorAll('button, figcaption').forEach(el => el.remove());
  const html = div.innerHTML;
  root.unmount();
  return html;
}

export function CanvasEditor(props: CanvasEditorProps): React.ReactElement {
  const host = getCanvasHost();
  if (!host) {
    return (
      <div className="aw acv" data-variant={props.variant ?? 'panel'}>
        <div className="acv-empty">Canvases open in the AICO app, where the chat that made them is running.</div>
      </div>
    );
  }
  return <Switchable host={host} {...props} />;
}

/** The open document can change under the editor (a new one from a template) where the client has no panel to open it in. */
function Switchable(props: CanvasEditorProps & { host: CanvasHost }): React.ReactElement {
  const [current, setCurrent] = useState<{ id: string; initial?: CanvasRef }>({ id: props.id, ...(props.initial ? { initial: props.initial } : {}) });
  useEffect(() => { setCurrent({ id: props.id, ...(props.initial ? { initial: props.initial } : {}) }); }, [props.id, props.initial]);
  const openOther = (ref: CanvasRef): void => {
    if (props.host.openPanel) props.host.openPanel(ref);
    else setCurrent({ id: ref.id, initial: ref });
  };
  return <Editor key={current.id} {...props} id={current.id} {...(current.initial ? { initial: current.initial } : {})} openOther={openOther} />;
}

interface Point { x: number; y: number }

let editorSeq = 0;

function Editor({ host, id, initial, variant = 'panel', onClose, openOther }: CanvasEditorProps & { host: CanvasHost; openOther: (ref: CanvasRef) => void }): React.ReactElement {
  const [viewing, setViewing] = useState<CanvasVersion | null>(null);
  const ctl = useCanvasDoc(host, id, { paused: Boolean(viewing) });
  const { doc, loadError, text, conflict, saveError, flash, showFlash } = ctl;
  const comments = useComments(host, id);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [mode, setMode] = useState<Mode | null>(() => stored(MODE_KEY, ['write', 'split', 'preview'] as const));
  const [view, setView] = useState<View>(() => stored(VIEW_KEY, ['page', 'source'] as const) ?? 'page');
  const [follow, setFollow] = useState(() => stored(FOLLOW_KEY, ['on', 'off'] as const) !== 'off');
  const [focusMode, setFocusMode] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [selection, setSelection] = useState('');
  const [pill, setPill] = useState<Point | null>(null);
  const [ask, setAsk] = useState<{ at: Point; selection: string } | null>(null);
  const [activity, setActivity] = useState<CanvasActivity | null>(null);
  const [editorKind, setEditorKind] = useState<'rich' | 'source' | null>(null);
  const [linkBox, setLinkBox] = useState<{ text: string } | null>(null);
  const [blockStyle, setBlockStyle] = useState<string>('p');
  const [turnBusy, setTurnBusy] = useState(() => host.turnBusy?.() ?? false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  useEffect(() => host.onTurn?.(setTurnBusy), [host]);

  const root = useRef<HTMLDivElement | null>(null);
  const source = useRef<HTMLTextAreaElement | null>(null);
  const preview = useRef<HTMLDivElement | null>(null);
  const docPage = useRef<DocPageHandle | null>(null);
  const lastPointer = useRef<{ p: Point; at: number } | null>(null);
  const instance = useRef(`e${++editorSeq}`).current;

  // ── The agent at work ──
  useEffect(() => {
    let timer: number | undefined;
    const off = onCanvasActivity((a) => {
      if (a.canvasId !== id) return;
      window.clearTimeout(timer);
      if (a.status === 'writing') {
        setActivity(a);
        // A turn that dies mid-write sends no "done"; the label must not stay forever.
        timer = window.setTimeout(() => setActivity(null), ACTIVITY_TIMEOUT_MS);
      } else {
        setActivity(cur => (!cur || !a.section || cur.section === a.section ? null : cur));
      }
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [id]);

  // ── Layout ──
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= 860));
    ro.observe(el);
    setWide(el.clientWidth >= 860);
    return () => ro.disconnect();
  }, []);
  const effectiveMode: Mode = mode ?? (wide ? 'split' : 'write');
  const chooseMode = (m: Mode): void => { setMode(m); remember(MODE_KEY, m); };
  const chooseView = (v: View): void => {
    docPage.current?.closeEditor();
    setView(v);
    remember(VIEW_KEY, v);
  };
  const toggleFollow = (): void => { setFollow(f => { remember(FOLLOW_KEY, f ? 'off' : 'on'); return !f; }); };

  const isCode = (doc?.kind ?? initial?.kind) === 'code';
  const title = doc?.title ?? initial?.title ?? 'Canvas';
  const language = doc?.language ?? initial?.language;
  const deferred = useDeferredValue(text);
  const shownText = viewing ? viewing.content : text;
  const dirty = ctl.dirty;
  const isPage = !isCode && view === 'page';
  const tabs = ctl.tabs;
  const tab = tabs.find(t => t.id === ctl.tabId);

  // The toolbar's style picker follows the caret in the open block.
  useEffect(() => {
    if (!editorKind) return;
    const update = (): void => { const s = docPage.current?.editor()?.style(); if (s) setBlockStyle(s); };
    document.addEventListener('selectionchange', update);
    update();
    return () => document.removeEventListener('selectionchange', update);
  }, [editorKind]);

  // ── Formatting in the Markdown source mode ──
  const splice = useCallback((s: Splice) => {
    const t = source.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(s.from, s.to);
    let done = false;
    try { done = s.insert ? document.execCommand('insertText', false, s.insert) : document.execCommand('delete'); } catch { done = false; }
    if (!done) {
      ctl.setText(applySplice(ctl.getText(), s));
      requestAnimationFrame(() => t.setSelectionRange(s.selStart, s.selEnd));
      return;
    }
    t.setSelectionRange(s.selStart, s.selEnd);
  }, [ctl]);

  const format = useCallback((op: FormatOp) => {
    const t = source.current;
    if (!t || viewing) return;
    splice(formatSplice(ctl.getText(), t.selectionStart, t.selectionEnd, op));
  }, [splice, viewing, ctl]);

  /** One formatting command, for whichever editor is open. */
  const run = (op: EditOp | 'link'): void => {
    if (viewing) return;
    if (!isPage) {
      if (op === 'p') return;
      format(op as FormatOp);
      return;
    }
    const ed = docPage.current?.editor();
    if (!ed) { showFlash('Click a paragraph to edit it, then format'); return; }
    if (op === 'link') { setLinkBox({ text: ed.holdSelection() }); return; }
    ed.run(op);
  };

  const history = (dir: 'undo' | 'redo'): void => {
    if (!isPage) source.current?.focus();
    try { document.execCommand(dir); } catch { /* not supported: the keyboard still works */ }
  };

  const insert = (kind: InsertKind, template?: string): void => {
    if (viewing) return;
    if (!isPage) {
      const t = source.current;
      if (!t) return;
      if (kind === 'table' && template) {
        const at = t.selectionEnd;
        const before = at === 0 ? '' : ctl.getText()[at - 1] === '\n' ? '\n' : '\n\n';
        splice({ from: at, to: at, insert: `${before}${template}\n`, selStart: at + before.length, selEnd: at + before.length });
        return;
      }
      const map: Partial<Record<InsertKind, FormatOp>> = { table: 'table', checklist: 'task', divider: 'rule', code: 'codeblock', quote: 'quote', bullets: 'bullet', numbers: 'number', heading: 'h2' };
      const op = map[kind];
      if (op) format(op);
      else showFlash('Switch to the page view to insert this');
      return;
    }
    docPage.current?.insert(kind, template);
  };

  /** Insert a visual block (chart, diagram, infographic, callout, contents) — the page view only. */
  const insertMarkdown = (md: string): void => {
    if (viewing) return;
    if (!isPage) { chooseView('page'); showFlash('Inserted in the page view'); window.setTimeout(() => docPage.current?.insertMarkdown(md), 50); return; }
    docPage.current?.insertMarkdown(md);
  };

  const insertImage = async (): Promise<void> => {
    if (viewing) return;
    const file = await pickImage();
    if (!file) return;
    if (isPage) { await docPage.current?.insertImage(file); return; }
    showFlash('Switch to the page view to insert an image');
  };

  // ── Selection and Ask AI ──
  const relative = (clientX: number, clientY: number): Point => {
    const r = root.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left, y: clientY - r.top } : { x: 0, y: 0 };
  };
  const defaultPoint = (): Point => {
    const r = root.current;
    return { x: (r?.clientWidth ?? 400) / 2 - 50, y: (r?.clientHeight ?? 400) - 90 };
  };
  const pointerPoint = (): Point => {
    const p = lastPointer.current;
    return p && Date.now() - p.at < 800 ? { x: p.p.x + 8, y: p.p.y + 14 } : defaultPoint();
  };

  const noteSelection = useCallback((sel: string, at?: Point) => {
    setSelection(sel);
    if (!sel.trim()) { setPill(null); return; }
    setPill(at ?? pointerPoint());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSourceSelect = (): void => {
    const t = source.current;
    if (!t) return;
    noteSelection(t.selectionStart === t.selectionEnd ? '' : t.value.slice(t.selectionStart, t.selectionEnd));
  };

  const onPreviewMouseUp = (): void => {
    const s = window.getSelection();
    const node = preview.current;
    if (!s || !node || s.isCollapsed || !s.anchorNode || !node.contains(s.anchorNode)) { noteSelection(''); return; }
    const rect = s.getRangeAt(0).getBoundingClientRect();
    noteSelection(s.toString(), relative(rect.left + Math.min(rect.width, 240) / 2, rect.bottom + 6));
  };

  const openAsk = (at?: Point, sel = selection): void => {
    setPill(null);
    setAsk({ at: at ?? pointerPoint(), selection: sel });
  };

  const askFromToolbar = (): void => {
    const sel = window.getSelection();
    const s = isPage && sel && !sel.isCollapsed ? sel.toString() : selection;
    openAsk({ x: Math.max(8, (root.current?.clientWidth ?? 440) - 440), y: 90 }, s);
  };

  const send = async (instruction: string, sel: string): Promise<void> => {
    if (!instruction.trim()) return;
    setAsk(null);
    setPill(null);
    await ctl.save();
    const tabNote = tabs.length > 1 && tab ? ` (tab "${tab.title}")` : '';
    host.ask(askMessage({ id, title: `${title}${tabNote}`, instruction, selection: sel }));
    showFlash('Sent to AICO — the page updates here while it works');
  };

  const comment = (): void => {
    if (!isPage) { chooseView('page'); showFlash('Select text on the page to comment on it'); return; }
    if (!docPage.current?.commentOnSelection()) {
      if (!wide) setDrawerOpen(true);
      showFlash('Select the text you want to comment on');
    }
  };

  useEffect(() => {
    if (!ask && !pill && !historyOpen && !focusMode && !linkBox) return;
    const esc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (linkBox) setLinkBox(null);
      else if (ask) setAsk(null);
      else if (pill) setPill(null);
      else if (historyOpen) setHistoryOpen(false);
      else if (focusMode && !(e.target as HTMLElement).closest?.('[contenteditable="true"], textarea')) setFocusMode(false);
      else return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [ask, pill, historyOpen, focusMode, linkBox]);

  // ── Keyboard in the Markdown source ──
  const onSourceKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const mod = e.ctrlKey || e.metaKey;
    const t = e.currentTarget;
    let op: FormatOp | null = null;
    if (mod && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); void ctl.save(); return; }
      op = k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'k' ? 'link' : k === 'e' ? 'code' : null;
    } else if (mod && e.altKey && !e.shiftKey) {
      op = e.code === 'Digit1' ? 'h1' : e.code === 'Digit2' ? 'h2' : e.code === 'Digit3' ? 'h3' : null;
    } else if (mod && e.shiftKey && !e.altKey) {
      if (e.code === 'KeyA') { e.preventDefault(); openAsk(); return; }
      op = e.code === 'Digit8' ? 'bullet' : e.code === 'Digit7' ? 'number' : e.code === 'Digit9' ? 'quote'
        : e.code === 'KeyX' ? 'strike' : null;
    }
    if (op) { e.preventDefault(); format(op); return; }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && t.selectionStart === t.selectionEnd) {
      const s = continueList(t.value, t.selectionStart);
      if (s) { e.preventDefault(); splice(s); }
      return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      // Indent list items only; elsewhere Tab leaves the editor as it should.
      const a = t.selectionStart;
      const lineStart = t.value.lastIndexOf('\n', a - 1) + 1;
      const line = t.value.slice(lineStart, t.value.indexOf('\n', a) < 0 ? undefined : t.value.indexOf('\n', a));
      if (!/^\s*([-*+]|\d+[.)])\s/.test(line)) return;
      e.preventDefault();
      if (e.shiftKey) {
        const n = /^ {1,2}/.exec(line)?.[0].length ?? 0;
        if (n) splice({ from: lineStart, to: lineStart + n, insert: '', selStart: a - n, selEnd: a - n });
      } else {
        splice({ from: lineStart, to: lineStart, insert: '  ', selStart: a + 2, selEnd: a + 2 });
      }
    }
  };

  // Shortcuts on the page that are not about one block.
  const onRootKey = (e: React.KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    if (!isPage || !mod) return;
    if (e.shiftKey && !e.altKey && e.code === 'KeyA') { e.preventDefault(); askFromToolbar(); }
    else if (e.altKey && !e.shiftKey && e.code === 'KeyM') { e.preventDefault(); comment(); }
  };

  // ── Copy, export, download ──
  const tabText = (): string => (viewing ? viewing.content : ctl.getText());
  const copy = async (how: 'rich' | 'markdown' | 'plain'): Promise<void> => {
    const body = isCode ? tabText() : stripPending(tabText());
    let ok: boolean;
    if (isCode || how === 'markdown') ok = await copyText(body);
    else if (how === 'plain') ok = await copyText(markdownToPlain(body));
    else ok = await copyText(body, renderHtml(body));
    showFlash(ok ? 'Copied' : 'Could not copy');
  };

  const exportName = (format: ExportFormat): string => {
    const base = fileBase(tabs.length > 1 && tab ? `${title} ${tab.title}` : title);
    return `${base}.${EXPORT_TYPES[format].ext}`;
  };

  /** Save a tab as a file — the engine's export, or a local fallback when this engine has none. */
  const exportAs = async (format: ExportFormat, settings?: DocSettings): Promise<void> => {
    if (dirty) await ctl.save();
    showFlash(`Preparing ${EXPORT_TYPES[format].label}…`);
    let where: string | null | undefined;
    try {
      if (!host.exportFile) throw Object.assign(new Error('no export route'), { status: 404 });
      const file = await host.exportFile(id, format, doc?.tabs ? ctl.tabId : undefined, settings ?? currentSettings());
      where = await saveBlob(file.name || exportName(format), file.blob, format);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) { showFlash(`Could not export: ${message(err)}`); return; }
      const body = stripPending(tabText());
      if (format === 'md') where = await saveBlob(exportName('md'), new Blob([body], { type: 'text/markdown' }), 'md');
      else if (format === 'html') where = await saveBlob(exportName('html'), new Blob([standaloneHtml(title, renderHtml(body))], { type: 'text/html' }), 'html');
      else if (format === 'pdf') {
        where = await desktopPdf(standaloneHtml(title, renderHtml(body)), exportName('pdf'));
        if (where === undefined) { showFlash('PDF export needs a newer AICO engine here — try Web page, then print'); return; }
      } else { showFlash('Word export needs a newer AICO engine'); return; }
    }
    if (where === null) { showFlash('Export cancelled'); return; }
    showFlash(where === 'downloaded' || !where ? `Downloaded ${EXPORT_TYPES[format].label}` : `Saved to ${where}`);
  };

  /** The document's export settings: stored with it, else remembered here, else none. */
  const currentSettings = (): DocSettings | undefined => doc?.docSettings ?? storedSettings(id) ?? undefined;
  const saveSettings = (settings: DocSettings): void => {
    rememberSettings(id, settings);
    // Stored with the document where the engine can; this browser's copy covers the rest.
    void host.saveSettings?.(id, settings).catch(() => undefined);
  };
  const previewExport = host.exportFile
    ? async (settings: DocSettings): Promise<string | null> => {
      const f = await host.exportFile!(id, 'html', doc?.tabs ? ctl.tabId : undefined, settings);
      return f.blob.text();
    }
    : undefined;

  const createFromTemplate = async ({ template, title: name, draft }: { template: string; title: string; draft: boolean }): Promise<void> => {
    const content = templateById(template).build(name, longDate());
    const fill = `Draft every pending section of the canvas, in order, with write_section — keep each concise.`;
    if (host.create) {
      try {
        const made = await host.create({ title: name, content });
        openOther({ id: made.id, title: made.title, kind: 'document' });
        if (draft) host.ask(`Canvas ${made.id} ("${made.title}") was just created from the ${templateById(template).label} template. ${fill}`);
        return;
      } catch (err) {
        if ((err as { status?: number }).status !== 404) { showFlash(`Could not create it: ${message(err)}`); return; }
      }
    }
    // No create route: the agent makes it with the engine's own template (its sections and export defaults).
    const engineId = templateById(template).engineId;
    host.ask(engineId
      ? `Create a new document titled "${name}" with the Canvas outline action and template "${engineId}".${draft ? ` Then ${fill.toLowerCase()}` : ' Leave the sections as placeholders for me.'}`
      : `Create a new, empty canvas document titled "${name}" (Canvas create, kind document).`);
    showFlash('Asked AICO to create it — it opens here when it is ready');
  };

  const download = (as: 'txt' | 'source'): void => {
    const body = tabText();
    if (as === 'source') { downloadText(canvasFileName(title, 'code', language), body); return; }
    downloadText(canvasFileName(title, 'document', undefined, 'txt'), isCode ? body : markdownToPlain(stripPending(body)));
  };

  const restore = async (v: CanvasVersion): Promise<void> => {
    if (await ctl.restore(v)) { setViewing(null); setHistoryOpen(false); }
  };

  // ── Tabs ──
  const tabOp = async (op: { op: 'add' | 'rename' | 'delete'; tab?: string; title?: string }): Promise<void> => {
    if (!host.tabs) { showFlash('Tabs need a newer AICO engine'); return; }
    if (dirty && !(await ctl.save())) return;
    try {
      const next = await host.tabs(id, op);
      const all = next.tabs ?? [];
      const want = op.op === 'add' ? all[all.length - 1]?.id : op.op === 'delete' ? all[0]?.id : ctl.tabId;
      ctl.adoptDoc(next, want);
      setViewing(null);
      showFlash(op.op === 'add' ? 'Tab added' : op.op === 'delete' ? 'Tab deleted' : 'Tab renamed');
    } catch (err) {
      showFlash(`Could not change tabs: ${message(err)}`);
    }
  };

  // ── Status ──
  const tabVersions = doc ? doc.versions.filter(v => !doc.tabs || (v.tab ?? 't1') === ctl.tabId) : [];
  const last = tabVersions[tabVersions.length - 1];
  const conflictWho = conflict ? (() => {
    const vs = conflict.latest.versions.filter(v => !conflict.latest.tabs || (v.tab ?? 't1') === ctl.tabId);
    return vs[vs.length - 1]?.author;
  })() : undefined;
  let status: { text: string; tone?: 'dirty' | 'warn' };
  if (loadError) status = { text: 'Not available', tone: 'warn' };
  else if (!doc) status = { text: 'Loading…' };
  else if (conflict) status = { text: `Edited by ${conflictWho === 'user' ? 'you elsewhere' : 'the agent'} — choose`, tone: 'warn' };
  else if (saveError) status = { text: 'Not saved', tone: 'warn' };
  else if (activity && activity.status === 'writing') status = { text: 'AICO is writing…', tone: 'dirty' };
  else if (ctl.saving) status = { text: 'Saving…', tone: 'dirty' };
  else if (dirty) status = { text: 'Edited', tone: 'dirty' };
  else status = { text: flash ?? 'Saved' };

  const actions: readonly QuickAction[] = isCode ? CODE_ACTIONS : DOCUMENT_ACTIONS;
  const showSource = !isCode && !isPage && (effectiveMode === 'write' || effectiveMode === 'split');
  const showPreview = !isCode && !isPage && (effectiveMode === 'preview' || effectiveMode === 'split');
  const CodeEditor = host.CodeEditor;
  const openComments = comments.comments.filter(c => (c.tabId ?? 't1') === ctl.tabId && !c.resolved).length;
  const pageEditing = isPage && editorKind !== null;
  const fmtDisabled = Boolean(viewing) || (isPage && !pageEditing);

  return (
    <div
      ref={root}
      className="aw acv"
      data-variant={variant}
      data-canvas-id={id}
      data-view={isCode ? 'code' : view}
      data-focus={focusMode ? '1' : undefined}
      onKeyDown={onRootKey}
      onMouseUpCapture={(e) => { lastPointer.current = { p: relative(e.clientX, e.clientY), at: Date.now() }; }}
    >
      <header className="acv-head" data-adoc-keep-focus>
        <div className="acv-head-title">
          <CvIcon name={isCode ? 'code' : 'doc'} size={16} className="acv-kind-icon" />
          <span className="acv-head-name" title={title}>{title}</span>
          {doc && <span className="acv-badge" title={`Version ${ctl.tabVersion}`}>v{ctl.tabVersion}</span>}
          <span className={`acv-status${status.tone ? ` is-${status.tone}` : ''}`} role="status" aria-live="polite">{status.text}</span>
        </div>
        <div className="acv-head-actions">
          {isCode && (
            <button type="button" className="aw-btn acv-ai-btn" onClick={() => openAsk({ x: Math.max(8, (root.current?.clientWidth ?? 440) - 440), y: 50 })}
              disabled={!doc} title="Ask AI to edit (Ctrl+Shift+A) — the selection, or the whole canvas">
              <CvIcon name="sparkle" size={14} /> <span className="aw-hide-narrow">Ask AI</span>
            </button>
          )}
          {!isCode && (
            <button type="button" className="aw-icon-btn" onClick={() => setNewOpen(true)} disabled={!doc}
              title="New document from a template" aria-label="New document">
              <CvIcon name="plus" size={15} />
            </button>
          )}
          {!isCode && comments.supported !== false && (
            <button type="button" className={`aw-icon-btn adoc-count-btn${drawerOpen ? ' is-on' : ''}`} onClick={() => setDrawerOpen(v => !v)}
              disabled={!doc} title="Comments" aria-label={`Comments (${openComments} open)`}>
              <CvIcon name="comment" size={15} />{openComments > 0 && <span className="adoc-count">{openComments}</span>}
            </button>
          )}
          <button type="button" className={`aw-icon-btn${historyOpen ? ' is-on' : ''}`} onClick={() => setHistoryOpen(v => !v)} disabled={!doc} title="Version history" aria-label="Version history">
            <CvIcon name="history" size={15} />
          </button>
          {isCode ? (
            <>
              <Menu icon="copy" label="Copy" disabled={!doc} items={[{ label: 'Copy code', run: () => void copy('markdown') }]} />
              <Menu icon="download" label="Download" disabled={!doc} items={[
                { label: `Download ${canvasFileName(title, 'code', language)}`, run: () => download('source') },
                { label: 'Plain text (.txt)', run: () => download('txt') },
              ]} />
            </>
          ) : (
            <Menu icon="share" label="Share and export" text="Share" disabled={!doc} items={[
              { label: 'Export…', run: () => setExportOpen(true) },
              { separator: true },
              { label: 'Download as Word (.docx)', run: () => void exportAs('docx') },
              { label: 'Download as PDF', run: () => void exportAs('pdf') },
              { label: 'Download as Markdown (.md)', run: () => void exportAs('md') },
              { label: 'Download as web page (.html)', run: () => void exportAs('html') },
              { label: 'Plain text (.txt)', run: () => download('txt') },
              { separator: true },
              { label: 'Copy as rich text', run: () => void copy('rich') },
              { label: 'Copy as Markdown', run: () => void copy('markdown') },
              { label: 'Copy as plain text', run: () => void copy('plain') },
            ]} />
          )}
          <button type="button" className="aw-icon-btn" onClick={() => setFocusMode(v => !v)}
            title={focusMode ? 'Exit full screen (Esc)' : 'Full screen'} aria-label={focusMode ? 'Exit full screen' : 'Full screen'} aria-pressed={focusMode}>
            <CvIcon name={focusMode ? 'shrink' : 'fullscreen'} size={15} />
          </button>
          {onClose && (
            <button type="button" className="aw-icon-btn" onClick={onClose} title="Close canvas" aria-label="Close canvas">
              <CvIcon name="close" size={15} />
            </button>
          )}
        </div>
      </header>

      {!isCode && doc && (
        <div className="acv-tools" role="toolbar" aria-label="Formatting" data-adoc-keep-focus>
          <TabMenu tabs={tabs} tabId={ctl.tabId} canEdit={Boolean(host.tabs) && !viewing}
            onSelect={(t) => { setViewing(null); docPage.current?.closeEditor(); void ctl.selectTab(t); }}
            onAdd={() => void tabOp({ op: 'add', title: `Tab ${tabs.length + 1}` })}
            onRename={(t, name) => void tabOp({ op: 'rename', tab: t, title: name })}
            onDelete={(t) => void tabOp({ op: 'delete', tab: t })} />
          <span className="acv-sep" />
          {!viewing && (
            <>
              <Tb icon="undo" label="Undo (Ctrl+Z)" onClick={() => history('undo')} />
              <Tb icon="redo" label="Redo (Ctrl+Y)" onClick={() => history('redo')} />
              <span className="acv-sep" />
              {isPage ? (
                <select className="adoc-style" aria-label="Text style" disabled={fmtDisabled}
                  value={editorKind === 'rich' && ['p', 'h1', 'h2', 'h3'].includes(blockStyle) ? blockStyle : ''}
                  onChange={(e) => { if (e.target.value) run(e.target.value as EditOp); }}>
                  <option value="" disabled>Style</option>
                  <option value="p">Paragraph</option>
                  <option value="h1">Heading 1</option>
                  <option value="h2">Heading 2</option>
                  <option value="h3">Heading 3</option>
                </select>
              ) : (
                <>
                  <Tb text="H1" label="Heading 1 (Ctrl+Alt+1)" onClick={() => format('h1')} />
                  <Tb text="H2" label="Heading 2 (Ctrl+Alt+2)" onClick={() => format('h2')} />
                  <Tb text="H3" label="Heading 3 (Ctrl+Alt+3)" onClick={() => format('h3')} />
                </>
              )}
              <span className="acv-sep" />
              <Tb icon="bold" label="Bold (Ctrl+B)" onClick={() => run('bold')} disabled={fmtDisabled} />
              <Tb icon="italic" label="Italic (Ctrl+I)" onClick={() => run('italic')} disabled={fmtDisabled} />
              <Tb icon="strike" label="Strikethrough (Ctrl+Shift+X)" onClick={() => run('strike')} disabled={fmtDisabled} />
              <Tb icon="inline-code" label="Inline code (Ctrl+E)" onClick={() => run('code')} disabled={fmtDisabled} />
              <Tb icon="link" label="Link (Ctrl+K)" onClick={() => (isPage ? run('link') : format('link'))} disabled={fmtDisabled} />
              <span className="acv-sep" />
              <Tb icon="bullet" label="Bulleted list (Ctrl+Shift+8)" onClick={() => run('bullet')} disabled={fmtDisabled} />
              <Tb icon="number" label="Numbered list (Ctrl+Shift+7)" onClick={() => run('number')} disabled={fmtDisabled} />
              <Tb icon="task" label="Checklist" onClick={() => (pageEditing || !isPage ? run('task') : insert('checklist'))} />
              <Tb icon="quote" label="Quote (Ctrl+Shift+9)" onClick={() => run('quote')} disabled={fmtDisabled} />
              <span className="acv-sep" />
              <TablePicker onPick={(r, c) => insert('table', tableMarkdown(r, c))} />
              <Tb icon="image" label="Image (or paste / drop one)" onClick={() => { void insertImage(); }} />
              <InsertMenu onInsert={insert} onMarkdown={insertMarkdown} onImage={() => { void insertImage(); }} />
            </>
          )}
          <span className="aw-grow" />
          {isPage && (
            <button type="button" className={`acv-tb${outlineOpen ? ' is-on' : ''}`} aria-pressed={outlineOpen} title="Outline" aria-label="Outline"
              onMouseDown={e => e.preventDefault()} onClick={() => setOutlineOpen(v => !v)}>
              <CvIcon name="number" size={15} />
            </button>
          )}
          {isPage && !viewing && (
            <>
              {comments.supported !== false && <Tb icon="comment" label="Comment on the selection (Ctrl+Alt+M)" onClick={comment} />}
              <button type="button" className="acv-tb adoc-ask" title="Ask AICO to edit (Ctrl+Shift+A) — the selection, or the whole tab"
                onMouseDown={e => e.preventDefault()} onClick={askFromToolbar}>
                <CvIcon name="sparkle" size={14} /> <span className="aw-hide-narrow">Ask AICO</span>
              </button>
              <button type="button" className={`acv-tb adoc-follow${follow ? ' is-on' : ''}`} aria-pressed={follow} onMouseDown={e => e.preventDefault()}
                title={follow ? 'Following AICO as it writes — click to stop' : 'Follow AICO as it writes'} onClick={toggleFollow}>
                <CvIcon name="follow" size={14} /> <span className="aw-hide-narrow">Follow</span>
              </button>
            </>
          )}
          {!isPage && !viewing && (
            <div className="acv-seg" role="group" aria-label="Source view">
              {([['write', 'write', 'Write'], ['split', 'split', 'Write and preview'], ['preview', 'eye', 'Preview']] as Array<[Mode, CanvasIconName, string]>).map(([m, icon, label]) => (
                <button key={m} type="button" className={effectiveMode === m ? 'is-on' : ''} aria-pressed={effectiveMode === m} title={label} aria-label={label} onClick={() => chooseMode(m)}>
                  <CvIcon name={icon} size={13} />
                </button>
              ))}
            </div>
          )}
          <div className="acv-seg" role="group" aria-label="View">
            <button type="button" className={isPage ? 'is-on' : ''} aria-pressed={isPage} title="Page" aria-label="Page view" onClick={() => chooseView('page')}>
              <CvIcon name="page" size={13} />
            </button>
            <button type="button" className={!isPage ? 'is-on' : ''} aria-pressed={!isPage} title="Markdown source" aria-label="Markdown source" onClick={() => chooseView('source')}>
              <CvIcon name="markdown" size={14} />
            </button>
          </div>
        </div>
      )}

      {linkBox && (
        <LinkBox initialText={linkBox.text} onCancel={() => setLinkBox(null)}
          onApply={(url) => { setLinkBox(null); docPage.current?.editor()?.link(url); }} />
      )}

      {conflict && (
        <div className="acv-banner is-warn" role="alert">
          <CvIcon name="warn" size={14} />
          <span>
            {conflictWho === 'user' ? 'This canvas was changed elsewhere' : 'AICO changed this canvas'}
            {' '}(version {tabsOfConflict(conflict.latest, ctl.tabId)}) while you were editing
            {conflict.failed ? ' — including the block you were editing' : ''}. Your edits are not saved yet.
          </span>
          <button type="button" className="aw-btn is-primary" onClick={() => { void ctl.keepMine(); }}>Keep mine</button>
          <button type="button" className="aw-btn" onClick={() => { docPage.current?.closeEditor(); ctl.takeTheirs(); }}>
            Take {conflictWho === 'user' ? 'theirs' : "the agent's"}
          </button>
        </div>
      )}
      {saveError && !conflict && (
        <div className="acv-banner is-error" role="alert">
          <CvIcon name="warn" size={14} />
          <span>Could not save: {saveError}</span>
          <button type="button" className="aw-btn" onClick={() => { ctl.clearSaveError(); void ctl.save(); }}>Retry</button>
        </div>
      )}
      {viewing && doc && (
        <div className="acv-banner">
          <CvIcon name="history" size={14} />
          <span>Viewing version {viewing.version} · {authorLabel(viewing.author)} · {relativeTime(viewing.at)}{viewing.note ? ` · ${viewing.note}` : ''}</span>
          {viewing.version !== ctl.tabVersion && (
            <button type="button" className="aw-btn is-primary" onClick={() => { void restore(viewing); }}><CvIcon name="restore" size={12} /> Restore this version</button>
          )}
          <button type="button" className="aw-btn" onClick={() => setViewing(null)}>Back to current</button>
        </div>
      )}

      <div className="acv-body">
        {loadError ? (
          <div className="acv-empty">This canvas could not be opened: {loadError}</div>
        ) : !doc ? (
          <div className="acv-empty">Loading {title}…</div>
        ) : isCode ? (
          <div className="acv-pane">
            {CodeEditor ? (
              <CodeEditor key={viewing ? `v${viewing.version}` : 'live'} value={shownText} language={language}
                readOnly={Boolean(viewing)} onChange={viewing ? () => undefined : (v) => ctl.setText(v)}
                onSelection={s => noteSelection(s)} onSave={() => { void ctl.save(); }} />
            ) : (
              <CodeArea value={shownText} language={language} readOnly={Boolean(viewing)}
                onChange={viewing ? () => undefined : (v) => ctl.setText(v)} onSelection={s => noteSelection(s)} onSave={() => { void ctl.save(); }} />
            )}
          </div>
        ) : isPage ? (
          <DocPage ref={docPage} host={host} canvasId={id} ctl={ctl} {...(viewing ? { readOnlyText: viewing.content } : {})}
            activity={activity} follow={follow} comments={comments} drawerOpen={drawerOpen} setDrawerOpen={setDrawerOpen}
            onEditorChange={setEditorKind} onLinkRequest={() => run('link')}
            onAsk={(sel, at) => openAsk({ x: at.x, y: at.y + 40 }, sel)} onError={showFlash} instance={instance}
            agentBusy={turnBusy} outlineOpen={outlineOpen} onCloseOutline={() => setOutlineOpen(false)} />
        ) : (
          <>
            {showSource && (
              <div className={`acv-pane${viewing ? ' is-old' : ''}`}>
                <textarea
                  ref={source}
                  className="acv-source"
                  value={shownText}
                  readOnly={Boolean(viewing)}
                  onChange={e => ctl.setText(e.target.value)}
                  onKeyDown={onSourceKey}
                  onSelect={onSourceSelect}
                  onMouseUp={onSourceSelect}
                  onKeyUp={onSourceSelect}
                  spellCheck
                  placeholder="Start writing — Markdown works: # heading, **bold**, - list…"
                  aria-label={`${title} (Markdown)`}
                />
              </div>
            )}
            {showPreview && (
              <div className={`acv-pane${viewing ? ' is-old' : ''}`} onMouseUp={onPreviewMouseUp}>
                <div className="acv-preview" ref={preview}>
                  {(viewing ? viewing.content : deferred).trim()
                    ? <MarkdownRenderer content={viewing ? viewing.content : deferred} />
                    : <p className="acv-preview-empty">Nothing here yet.</p>}
                </div>
              </div>
            )}
          </>
        )}

        {historyOpen && doc && (
          <aside className="acv-history" aria-label="Version history">
            <div className="acv-history-head">
              <CvIcon name="history" size={14} /> Versions{tabs.length > 1 && tab ? ` · ${tab.title}` : ''}
              <span className="aw-grow" />
              <button type="button" className="aw-icon-btn" onClick={() => setHistoryOpen(false)} aria-label="Close history"><CvIcon name="close" size={14} /></button>
            </div>
            <ol>
              {[...tabVersions].reverse().map(v => {
                const current = v.version === ctl.tabVersion;
                const on = viewing ? viewing.version === v.version : current;
                return (
                  <li key={v.version}>
                    <button type="button" className={`acv-ver${on ? ' is-on' : ''}`} onClick={() => setViewing(current ? null : v)}>
                      <span className="acv-ver-top">
                        <b>v{v.version}</b>
                        <span className={`acv-who is-${v.author}`}>{authorLabel(v.author)}</span>
                        <span className="aw-grow" />
                        <span className="aw-muted">{current ? 'current' : relativeTime(v.at)}</span>
                      </span>
                      <span className="acv-ver-note" title={v.note}>{v.note ?? `${wordCount(v.content).toLocaleString()} words`}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            {tabVersions.length > 0 && tabVersions[0]!.version > 1 && (
              <div className="acv-foot">Only the last {tabVersions.length} versions are kept.</div>
            )}
          </aside>
        )}

        {pill && !ask && !viewing && !isPage && (
          <button type="button" className="acv-pill" style={clampPill(pill, root.current)} onMouseDown={e => e.preventDefault()}
            onClick={() => openAsk(pill)}>
            <CvIcon name="sparkle" size={13} /> Ask AI to edit
          </button>
        )}
      </div>

      {exportOpen && doc && (
        <ExportDialog title={tabs.length > 1 && tab ? `${title} — ${tab.title}` : title} coverTitle={title} initial={currentSettings() ?? {}}
          {...(previewExport ? { preview: previewExport } : {})}
          onExport={(format, settings) => exportAs(format, settings)} onSave={saveSettings} onClose={() => setExportOpen(false)} />
      )}
      {newOpen && (
        <TemplatePicker canCreate={Boolean(host.create)} onCreate={createFromTemplate} onClose={() => setNewOpen(false)} />
      )}

      {ask && (
        <AskBox at={ask.at} selection={ask.selection} actions={actions} host={root.current}
          onSend={(instruction) => { void send(instruction, ask.selection); }} onClose={() => setAsk(null)} />
      )}

      <footer className="acv-foot">
        {doc && (isCode ? (
          <span>{shownText.split('\n').length.toLocaleString()} lines{language ? ` · ${language}` : ''}</span>
        ) : (
          <span>{wordCount(stripPending(shownText)).toLocaleString()} words</span>
        ))}
        {last && doc && <><span className="aw-dot">·</span><span>Last edited by {authorLabel(last.author)} {relativeTime(last.at)}</span></>}
        {flash && status.text !== flash && <><span className="aw-dot">·</span><span className="adoc-flash">{flash}</span></>}
      </footer>
    </div>
  );
}

function tabsOfConflict(doc: import('./host').CanvasDoc, tabId: string): number {
  return (doc.tabs?.find(t => t.id === tabId) ?? doc).version;
}

function clampPill(p: Point, root: HTMLElement | null): React.CSSProperties {
  const w = root?.clientWidth ?? 600;
  const h = root?.clientHeight ?? 600;
  return { left: Math.max(8, Math.min(p.x, w - 150)), top: Math.max(52, Math.min(p.y - 44, h - 80)) };
}

function Tb({ icon, text, label, onClick, disabled }: { icon?: CanvasIconName; text?: string; label: string; onClick: () => void; disabled?: boolean }): React.ReactElement {
  return (
    <button type="button" className="acv-tb" title={label} aria-label={label} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={onClick}>
      {icon ? <CvIcon name={icon} size={15} /> : text}
    </button>
  );
}

/** Close a popover on a click elsewhere or Escape. */
function useDismiss(open: boolean, box: React.RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => { if (!box.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc, true); };
  }, [open, box, close]);
}

type MenuItem = { label: string; run: () => void; separator?: false } | { separator: true };

function Menu({ icon, label, text, items, disabled }: {
  icon: CanvasIconName; label: string; text?: string; disabled?: boolean; items: MenuItem[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, box, close);
  return (
    <div className="aw-menu" ref={box}>
      <button type="button" className={text ? 'aw-btn adoc-share' : 'aw-icon-btn'} disabled={disabled} onClick={() => setOpen(v => !v)}
        title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open}>
        <CvIcon name={icon} size={text ? 13 : 15} />{text && <span className="aw-hide-narrow">{text}</span>}
      </button>
      {open && (
        <div className="aw-menu-list" role="menu">
          {items.map((it, i) => (it.separator
            ? <div key={`s${i}`} className="adoc-menu-sep" role="separator" />
            : <button key={it.label} type="button" role="menuitem" onClick={() => { setOpen(false); it.run(); }}>{it.label}</button>))}
        </div>
      )}
    </div>
  );
}

function TabMenu({ tabs, tabId, canEdit, onSelect, onAdd, onRename, onDelete }: {
  tabs: Array<{ id: string; title: string }>; tabId: string; canEdit: boolean;
  onSelect: (id: string) => void; onAdd: () => void; onRename: (id: string, title: string) => void; onDelete: (id: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const box = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => { setOpen(false); setRenaming(null); setConfirming(null); }, []);
  useDismiss(open, box, close);
  const current = tabs.find(t => t.id === tabId) ?? tabs[0];
  return (
    <div className="aw-menu adoc-tabmenu" ref={box}>
      <button type="button" className="adoc-tab-btn" onClick={() => setOpen(v => !v)} aria-haspopup="menu" aria-expanded={open}
        title="Tabs" aria-label={`Tab: ${current?.title ?? 'Tab 1'}`}>
        <span className="adoc-tab-name">{current?.title ?? 'Tab 1'}</span>
        <CvIcon name="chevron" size={12} />
      </button>
      {open && (
        <div className="aw-menu-list adoc-tab-list" role="menu">
          {tabs.map(t => (renaming === t.id ? (
            <form key={t.id} className="adoc-tab-rename" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onRename(t.id, name.trim()); close(); }}>
              <input autoFocus value={name} onChange={e => setName(e.target.value)} aria-label="Tab name" />
              <button type="submit" className="aw-btn is-primary adoc-mini">Save</button>
            </form>
          ) : (
            <div key={t.id} className={`adoc-tab-row${t.id === tabId ? ' is-on' : ''}`}>
              <button type="button" role="menuitemradio" aria-checked={t.id === tabId} onClick={() => { close(); onSelect(t.id); }}>
                {t.id === tabId ? <CvIcon name="check" size={12} /> : <span className="adoc-tab-dot" />} {t.title}
              </button>
              {canEdit && (
                <span className="adoc-tab-acts">
                  <button type="button" className="aw-icon-btn" title="Rename tab" aria-label={`Rename ${t.title}`} onClick={() => { setRenaming(t.id); setName(t.title); }}>
                    <CvIcon name="pencil" size={12} />
                  </button>
                  {tabs.length > 1 && (confirming === t.id ? (
                    // Two clicks rather than window.confirm, which a VS Code webview does not show.
                    <button type="button" className="aw-btn adoc-mini is-danger" onClick={() => { close(); onDelete(t.id); }}>Delete?</button>
                  ) : (
                    <button type="button" className="aw-icon-btn" title="Delete tab (and its comments)" aria-label={`Delete ${t.title}`}
                      onClick={() => setConfirming(t.id)}>
                      <CvIcon name="trash" size={12} />
                    </button>
                  ))}
                </span>
              )}
            </div>
          )))}
          <div className="adoc-menu-sep" role="separator" />
          <button type="button" role="menuitem" disabled={!canEdit} onClick={() => { close(); onAdd(); }}
            title={canEdit ? undefined : 'Tabs need a newer AICO engine'}>
            <CvIcon name="plus" size={12} /> Add tab
          </button>
        </div>
      )}
    </div>
  );
}

function TablePicker({ onPick }: { onPick: (rows: number, cols: number) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<[number, number]>([2, 3]);
  const box = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, box, close);
  return (
    <div className="aw-menu" ref={box}>
      <button type="button" className="acv-tb" title="Insert table" aria-label="Insert table" aria-haspopup="dialog" aria-expanded={open}
        onMouseDown={e => e.preventDefault()} onClick={() => setOpen(v => !v)}>
        <CvIcon name="table" size={15} />
      </button>
      {open && (
        <div className="aw-menu-list adoc-grid-pick" role="dialog" aria-label="Table size">
          <div className="adoc-grid" onMouseLeave={() => setHover([2, 3])}>
            {Array.from({ length: 6 }, (_, r) => Array.from({ length: 8 }, (_, c) => (
              <button key={`${r}-${c}`} type="button" aria-label={`${r + 1} by ${c + 1}`}
                className={r < hover[0] && c < hover[1] ? 'is-on' : ''}
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setHover([r + 1, c + 1])} onFocus={() => setHover([r + 1, c + 1])}
                onClick={() => { close(); onPick(r + 1, c + 1); }} />
            )))}
          </div>
          <div className="adoc-grid-label">{hover[0]} × {hover[1]} (body rows × columns)</div>
        </div>
      )}
    </div>
  );
}

const INSERTS: Array<{ kind: InsertKind; label: string; icon: CanvasIconName }> = [
  { kind: 'heading', label: 'Heading', icon: 'heading' },
  { kind: 'paragraph', label: 'Paragraph', icon: 'doc' },
  { kind: 'checklist', label: 'Checklist', icon: 'task' },
  { kind: 'bullets', label: 'Bulleted list', icon: 'bullet' },
  { kind: 'numbers', label: 'Numbered list', icon: 'number' },
  { kind: 'quote', label: 'Quote', icon: 'quote' },
  { kind: 'divider', label: 'Divider', icon: 'rule' },
  { kind: 'code', label: 'Code block', icon: 'codeblock' },
  { kind: 'math', label: 'Maths', icon: 'math' },
];

const VISUALS: Array<{ group: string; items: Array<{ label: string; icon: CanvasIconName; md: () => string }> }> = [
  { group: 'Callout', items: CALLOUTS.map(c => ({ label: c.label, icon: 'callout' as CanvasIconName, md: () => calloutMarkdown({ type: c.type, body: `${c.label}: something the reader should not miss.` }) })) },
  { group: 'Chart', items: (['bar', 'line', 'area', 'pie'] as ChartType[]).map(t => ({ label: `${t[0]!.toUpperCase()}${t.slice(1)} chart`, icon: 'chart' as CanvasIconName, md: () => chartTemplate(t) })) },
  { group: 'Diagram', items: MERMAID_TEMPLATES.map(t => ({ label: t.label, icon: 'diagram' as CanvasIconName, md: () => mermaidTemplate(t.id) })) },
  { group: 'Infographic', items: ([['stats', 'KPI stats'], ['timeline', 'Timeline'], ['steps', 'Steps / process'], ['comparison', 'Comparison']] as Array<[InfographicKind, string]>).map(([k, label]) => ({ label, icon: 'chart' as CanvasIconName, md: () => infographicTemplate(k) })) },
];

function InsertMenu({ onInsert, onMarkdown, onImage }: { onInsert: (kind: InsertKind) => void; onMarkdown: (md: string) => void; onImage: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, box, close);
  const item = (key: string, icon: CanvasIconName, label: string, run: () => void): React.ReactElement => (
    <button key={key} type="button" role="menuitem" onMouseDown={e => e.preventDefault()} onClick={() => { close(); run(); }}>
      <CvIcon name={icon} size={14} /> {label}
    </button>
  );
  return (
    <div className="aw-menu" ref={box}>
      <button type="button" className="acv-tb" title="Insert…" aria-label="Insert" aria-haspopup="menu" aria-expanded={open}
        onMouseDown={e => e.preventDefault()} onClick={() => setOpen(v => !v)}>
        <CvIcon name="plus" size={15} />
      </button>
      {open && (
        <div className="aw-menu-list adoc-insert-list" role="menu">
          <div className="adoc-insert-group">
            <div className="adoc-insert-head">Text</div>
            {INSERTS.map(it => item(it.kind, it.icon, it.label, () => onInsert(it.kind)))}
            {item('image', 'image', 'Image…', onImage)}
            {item('toc', 'number', 'Table of contents', () => onMarkdown(TOC_LINE))}
          </div>
          {VISUALS.map(g => (
            <div key={g.group} className="adoc-insert-group">
              <div className="adoc-insert-head">{g.group}</div>
              {g.items.map(it => item(`${g.group}-${it.label}`, it.icon, it.label, () => onMarkdown(it.md())))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkBox({ initialText, onApply, onCancel }: { initialText: string; onApply: (url: string) => void; onCancel: () => void }): React.ReactElement {
  const [url, setUrl] = useState('https://');
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  return (
    <form className="adoc-linkbox" data-adoc-keep-focus onSubmit={(e) => { e.preventDefault(); onApply(url); }}>
      <CvIcon name="link" size={14} />
      <span className="adoc-linkbox-text">{initialText ? `Link “${initialText.slice(0, 40)}” to` : 'Insert link'}</span>
      <input ref={input} value={url} onChange={e => setUrl(e.target.value)} aria-label="Link address"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }} />
      <button type="submit" className="aw-btn is-primary adoc-mini" disabled={!/^\S+$/.test(url) || url === 'https://'}>Apply</button>
      <button type="button" className="aw-btn adoc-mini" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function AskBox({ at, selection, actions, host, onSend, onClose }: {
  at: Point; selection: string; actions: readonly QuickAction[]; host: HTMLElement | null;
  onSend: (instruction: string) => void; onClose: () => void;
}): React.ReactElement {
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const away = (e: MouseEvent): void => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const t = window.setTimeout(() => document.addEventListener('mousedown', away), 0);
    return () => { window.clearTimeout(t); document.removeEventListener('mousedown', away); };
  }, [onClose]);
  const w = host?.clientWidth ?? 600;
  const h = host?.clientHeight ?? 600;
  const width = Math.min(420, w - 24);
  const style: React.CSSProperties = {
    left: Math.max(12, Math.min(at.x, w - width - 12)),
    top: Math.max(52, Math.min(at.y, h - 230)),
  };
  const target = selection.trim() ? 'the selection' : 'the whole canvas';
  return (
    <div className="acv-ask" style={style} ref={box} role="dialog" aria-label="Ask AI to edit">
      {selection.trim() && <p className="acv-ask-quote">“{selection.trim().slice(0, 240)}{selection.trim().length > 240 ? '…' : ''}”</p>}
      <form className="acv-ask-row" onSubmit={(e) => { e.preventDefault(); onSend(value); }}>
        <input ref={input} value={value} onChange={e => setValue(e.target.value)} placeholder={`How should AICO change ${target}?`} aria-label="Instruction" />
        <button type="submit" className="acv-ask-send" disabled={!value.trim()} aria-label="Send"><CvIcon name="send" size={15} /></button>
      </form>
      <div className="acv-ask-chips">
        {actions.map(a => (
          <button key={a.id} type="button" className="aw-chip" onClick={() => onSend(a.instruction)}>{a.label}</button>
        ))}
      </div>
      <div className="acv-ask-hint">Sends a message in this chat; AICO edits the canvas with its Canvas tool.</div>
    </div>
  );
}
