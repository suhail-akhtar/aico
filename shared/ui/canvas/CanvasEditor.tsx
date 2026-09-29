/**
 * The canvas editor — a document or code file the agent writes and the person
 * edits, beside the chat (desktop) or in place of its card (browser, VS Code).
 *
 * ## Why Markdown source with a live preview, not a rich-text editor
 *
 * The document's one true form is Markdown text, and the agent edits it by
 * exact find/replace against what it last read. A WYSIWYG editor (TipTap,
 * ProseMirror, Milkdown) holds a tree and re-serialises the whole document on
 * every save: list markers, emphasis characters, table padding, escapes and
 * line breaks come back normalised. A one-word edit by the person would then
 * rewrite lines they never touched — every version in the history would be a
 * whole-document diff, and the passage the agent copied for its next `find`
 * would no longer exist. Editing the source keeps each save to exactly what
 * was typed. It also costs no dependency in three builds (web, desktop, the
 * VS Code webview), and a textarea brings the browser's own undo, IME and
 * spell-check. The preview is the chat's own renderer, so tables, code,
 * maths and charts look exactly as they do in the transcript.
 *
 * Formatting is a toolbar and the usual shortcuts, applied through the
 * browser's insert command so Ctrl+Z undoes a toolbar action like typing.
 *
 * ## Saving and conflicts
 *
 * Autosave 800 ms after the last keystroke, always with the version the text
 * was based on. If the agent wrote in between, the save is refused (409) and a
 * banner offers "Keep mine" (save on top of the agent's version) or "Take the
 * agent's". When the agent writes while nothing is pending here, the new
 * version simply replaces the text — live, from the session stream.
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
  getCanvasHost, onCanvasEvent, type CanvasDoc, type CanvasHost, type CanvasRef, type CanvasVersion,
} from './host';
import {
  applySplice, askMessage, authorLabel, canvasFileName, CODE_ACTIONS, continueList, DOCUMENT_ACTIONS,
  formatSplice, relativeTime, standaloneHtml, wordCount, type FormatOp, type QuickAction, type Splice,
} from './core';
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
const MODE_KEY = 'aico.canvas.mode';
const AUTOSAVE_MS = 800;

function storedMode(): Mode | null {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === 'write' || m === 'split' || m === 'preview' ? m : null;
  } catch { return null; }
}

function rememberMode(m: Mode): void {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* private mode: just not remembered */ }
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
  return <Editor key={props.id} host={host} {...props} />;
}

interface Point { x: number; y: number }

function Editor({ host, id, initial, variant = 'panel', onClose }: CanvasEditorProps & { host: CanvasHost }): React.ReactElement {
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setTextState] = useState('');
  const [baseContent, setBaseContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflictState] = useState<CanvasDoc | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [viewing, setViewing] = useState<CanvasVersion | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mode, setMode] = useState<Mode | null>(storedMode);
  const [wide, setWide] = useState(false);
  const [selection, setSelection] = useState('');
  const [pill, setPill] = useState<Point | null>(null);
  const [ask, setAsk] = useState<{ at: Point; selection: string } | null>(null);

  const root = useRef<HTMLDivElement | null>(null);
  const source = useRef<HTMLTextAreaElement | null>(null);
  const preview = useRef<HTMLDivElement | null>(null);
  const textRef = useRef('');
  const baseRef = useRef(0);
  const baseContentRef = useRef('');
  const savingRef = useRef(false);
  const recheckRef = useRef(false);
  const conflictRef = useRef<CanvasDoc | null>(null);
  const lastPointer = useRef<{ p: Point; at: number } | null>(null);

  const setText = useCallback((v: string) => { textRef.current = v; setTextState(v); }, []);
  const setConflict = useCallback((d: CanvasDoc | null) => { conflictRef.current = d; setConflictState(d); }, []);
  /** Make a document the baseline: what is shown, and what the next save builds on. */
  const adopt = useCallback((d: CanvasDoc) => {
    setDoc(d);
    baseRef.current = d.version;
    baseContentRef.current = d.content;
    setBaseContent(d.content);
    setText(d.content);
  }, [setText]);

  const showFlash = useCallback((s: string) => {
    setFlash(s);
    window.setTimeout(() => setFlash(f => (f === s ? null : f)), 3200);
  }, []);

  // ── Load ──
  useEffect(() => {
    let live = true;
    host.get(id).then(d => { if (live) adopt(d); }, err => { if (live) setLoadError(message(err)); });
    return () => { live = false; };
  }, [host, id, adopt]);

  // ── Save ──
  const save = useCallback(async (note?: string): Promise<boolean> => {
    if (conflictRef.current) return false;
    if (savingRef.current) return false;
    const content = textRef.current;
    if (content === baseContentRef.current) return true;
    savingRef.current = true;
    setSaving(true);
    try {
      const r = await host.save(id, content, baseRef.current, note);
      if (r.ok) {
        baseRef.current = r.canvas.version;
        baseContentRef.current = content;
        setBaseContent(content);
        setDoc(r.canvas);
        setSaveError(null);
        return true;
      }
      setDoc(r.canvas);
      setConflict(r.canvas);
      return false;
    } catch (err) {
      setSaveError(message(err));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (recheckRef.current) { recheckRef.current = false; void recheck(); }
    }
    // `recheck` is declared below and stable; listing it would be a cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, id, setConflict]);

  useEffect(() => {
    if (text === baseContent || conflict || viewing) return;
    const t = window.setTimeout(() => { void save(); }, AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [text, baseContent, conflict, viewing, save]);

  // Leaving with edits still pending: send them, best effort.
  useEffect(() => () => {
    if (textRef.current !== baseContentRef.current && !conflictRef.current && !savingRef.current) {
      void host.save(id, textRef.current, baseRef.current).catch(() => undefined);
    }
  }, [host, id]);

  // ── Live changes from the other side ──
  const recheck = useCallback(async (): Promise<void> => {
    let latest: CanvasDoc;
    try { latest = await host.get(id); } catch { return; }
    if (latest.version <= baseRef.current) return;
    if (savingRef.current) { recheckRef.current = true; return; }
    // Our own write, announced before its response arrived.
    if (latest.content === textRef.current) {
      setDoc(latest);
      baseRef.current = latest.version;
      baseContentRef.current = latest.content;
      setBaseContent(latest.content);
      return;
    }
    const pending = textRef.current !== baseContentRef.current;
    const who = latest.versions[latest.versions.length - 1]?.author;
    if (!pending) {
      adopt(latest);
      setViewing(null);
      showFlash(who === 'user' ? `Updated to version ${latest.version}` : `AICO updated it — version ${latest.version}`);
    } else {
      setDoc(latest);
      setConflict(latest);
    }
  }, [host, id, adopt, setConflict, showFlash]);

  useEffect(() => onCanvasEvent((change) => {
    if (change.id !== id) return;
    const sid = host.sessionId();
    if (change.sessionId && sid && change.sessionId !== sid) return;
    if (change.version <= baseRef.current) return;
    if (savingRef.current) { recheckRef.current = true; return; }
    void recheck();
  }), [host, id, recheck]);

  const keepMine = async (): Promise<void> => {
    const latest = conflictRef.current;
    if (!latest) return;
    baseRef.current = latest.version;
    baseContentRef.current = latest.content;
    setBaseContent(latest.content);
    setConflict(null);
    if (await save('Kept my edits over a newer version')) showFlash('Your edits are saved on top');
  };
  const takeTheirs = (): void => {
    const latest = conflictRef.current;
    if (!latest) return;
    setConflict(null);
    adopt(latest);
    showFlash(`Showing version ${latest.version}`);
  };

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
  const chooseMode = (m: Mode): void => { setMode(m); rememberMode(m); };

  const isCode = (doc?.kind ?? initial?.kind) === 'code';
  const title = doc?.title ?? initial?.title ?? 'Canvas';
  const language = doc?.language ?? initial?.language;
  const deferred = useDeferredValue(text);
  const shownText = viewing ? viewing.content : text;
  const dirty = text !== baseContent;

  // ── Formatting ──
  const splice = useCallback((s: Splice) => {
    const t = source.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(s.from, s.to);
    let done = false;
    try { done = s.insert ? document.execCommand('insertText', false, s.insert) : document.execCommand('delete'); } catch { done = false; }
    if (!done) {
      setText(applySplice(textRef.current, s));
      requestAnimationFrame(() => t.setSelectionRange(s.selStart, s.selEnd));
      return;
    }
    t.setSelectionRange(s.selStart, s.selEnd);
  }, [setText]);

  const format = useCallback((op: FormatOp) => {
    const t = source.current;
    if (!t || viewing) return;
    splice(formatSplice(textRef.current, t.selectionStart, t.selectionEnd, op));
  }, [splice, viewing]);

  const history = (dir: 'undo' | 'redo'): void => {
    const t = source.current;
    if (!t) return;
    t.focus();
    try { document.execCommand(dir); } catch { /* not supported: the keyboard still works */ }
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

  const send = async (instruction: string, sel: string): Promise<void> => {
    if (!instruction.trim()) return;
    setAsk(null);
    setPill(null);
    await save();
    host.ask(askMessage({ id, title, instruction, selection: sel }));
    showFlash('Sent to AICO — the canvas updates here when it is done');
  };

  useEffect(() => {
    if (!ask && !pill && !historyOpen) return;
    const esc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (ask) setAsk(null); else if (pill) setPill(null); else setHistoryOpen(false);
      e.stopPropagation();
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [ask, pill, historyOpen]);

  // ── Keyboard in the Markdown source ──
  const onSourceKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const mod = e.ctrlKey || e.metaKey;
    const t = e.currentTarget;
    let op: FormatOp | null = null;
    if (mod && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); void save(); return; }
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

  // ── Actions ──
  const copy = async (how: 'rich' | 'markdown' | 'plain'): Promise<void> => {
    const body = shownText;
    let ok: boolean;
    if (isCode || how === 'markdown') ok = await copyText(body);
    else if (how === 'plain') ok = await copyText(markdownToPlain(body));
    else ok = await copyText(body, renderHtml(body));
    showFlash(ok ? 'Copied' : 'Could not copy');
  };

  const download = (as: 'md' | 'html' | 'txt' | 'source'): void => {
    const body = shownText;
    if (as === 'source') { downloadText(canvasFileName(title, 'code', language), body); return; }
    if (as === 'md') { downloadText(canvasFileName(title, 'document', undefined, 'md'), body, 'text/markdown'); return; }
    if (as === 'txt') { downloadText(canvasFileName(title, 'document', undefined, 'txt'), isCode ? body : markdownToPlain(body)); return; }
    downloadText(canvasFileName(title, 'document', undefined, 'html'), standaloneHtml(title, renderHtml(body)), 'text/html');
  };

  const restore = async (v: CanvasVersion): Promise<void> => {
    if (dirty && !(await save())) return;
    try {
      const r = await host.restore(id, v.version, baseRef.current);
      if (r.ok) {
        adopt(r.canvas);
        setViewing(null);
        setHistoryOpen(false);
        showFlash(`Restored version ${v.version} (now version ${r.canvas.version})`);
      } else {
        setDoc(r.canvas);
        setConflict(r.canvas);
      }
    } catch (err) {
      setSaveError(message(err));
    }
  };

  // ── Status ──
  const last = doc?.versions[doc.versions.length - 1];
  let status: { text: string; tone?: 'dirty' | 'warn' };
  if (loadError) status = { text: 'Not available', tone: 'warn' };
  else if (!doc) status = { text: 'Loading…' };
  else if (conflict) status = { text: `Edited by ${conflict.versions[conflict.versions.length - 1]?.author === 'user' ? 'you elsewhere' : 'the agent'} — reload`, tone: 'warn' };
  else if (saveError) status = { text: 'Not saved', tone: 'warn' };
  else if (saving) status = { text: 'Saving…', tone: 'dirty' };
  else if (dirty) status = { text: 'Edited', tone: 'dirty' };
  else status = { text: flash ?? 'Saved' };

  const actions: readonly QuickAction[] = isCode ? CODE_ACTIONS : DOCUMENT_ACTIONS;
  const showSource = !isCode && (effectiveMode === 'write' || effectiveMode === 'split');
  const showPreview = !isCode && (effectiveMode === 'preview' || effectiveMode === 'split');
  const CodeEditor = host.CodeEditor;

  return (
    <div
      ref={root}
      className="aw acv"
      data-variant={variant}
      data-canvas-id={id}
      onMouseUpCapture={(e) => { lastPointer.current = { p: relative(e.clientX, e.clientY), at: Date.now() }; }}
    >
      <header className="acv-head">
        <div className="acv-head-title">
          <CvIcon name={isCode ? 'code' : 'doc'} size={16} className="acv-kind-icon" />
          <span className="acv-head-name" title={title}>{title}</span>
          {doc && <span className="acv-badge" title={`Version ${doc.version}`}>v{doc.version}</span>}
          <span className={`acv-status${status.tone ? ` is-${status.tone}` : ''}`} role="status" aria-live="polite">{status.text}</span>
        </div>
        <div className="acv-head-actions">
          <button type="button" className="aw-btn acv-ai-btn" onClick={() => openAsk({ x: Math.max(8, (root.current?.clientWidth ?? 440) - 440), y: 50 })}
            disabled={!doc} title="Ask AI to edit (Ctrl+Shift+A) — the selection, or the whole canvas">
            <CvIcon name="sparkle" size={14} /> <span className="aw-hide-narrow">Ask AI</span>
          </button>
          {!isCode && (
            <div className="acv-seg" role="group" aria-label="View">
              {([['write', 'write', 'Write'], ['split', 'split', 'Write and preview'], ['preview', 'eye', 'Preview']] as Array<[Mode, CanvasIconName, string]>).map(([m, icon, label]) => (
                <button key={m} type="button" className={effectiveMode === m ? 'is-on' : ''} aria-pressed={effectiveMode === m} title={label} aria-label={label} onClick={() => chooseMode(m)}>
                  <CvIcon name={icon} size={13} />
                </button>
              ))}
            </div>
          )}
          <button type="button" className={`aw-icon-btn${historyOpen ? ' is-on' : ''}`} onClick={() => setHistoryOpen(v => !v)} disabled={!doc} title="Version history" aria-label="Version history">
            <CvIcon name="history" size={15} />
          </button>
          <Menu icon="copy" label="Copy" disabled={!doc} items={isCode
            ? [{ label: 'Copy code', run: () => void copy('markdown') }]
            : [
              { label: 'Copy (formatted)', run: () => void copy('rich') },
              { label: 'Copy as Markdown', run: () => void copy('markdown') },
              { label: 'Copy as plain text', run: () => void copy('plain') },
            ]} />
          <Menu icon="download" label="Download" disabled={!doc} items={isCode
            ? [
              { label: `Download ${canvasFileName(title, 'code', language)}`, run: () => download('source') },
              { label: 'Plain text (.txt)', run: () => download('txt') },
            ]
            : [
              { label: 'Markdown (.md)', run: () => download('md') },
              { label: 'Web page (.html)', run: () => download('html') },
              { label: 'Plain text (.txt)', run: () => download('txt') },
            ]} />
          {onClose && (
            <button type="button" className="aw-icon-btn" onClick={onClose} title="Close canvas" aria-label="Close canvas">
              <CvIcon name="close" size={15} />
            </button>
          )}
        </div>
      </header>

      {showSource && !viewing && doc && (
        <div className="acv-tools" role="toolbar" aria-label="Formatting">
          <Tb icon="undo" label="Undo (Ctrl+Z)" onClick={() => history('undo')} />
          <Tb icon="redo" label="Redo (Ctrl+Y)" onClick={() => history('redo')} />
          <span className="acv-sep" />
          <Tb text="H1" label="Heading 1 (Ctrl+Alt+1)" onClick={() => format('h1')} />
          <Tb text="H2" label="Heading 2 (Ctrl+Alt+2)" onClick={() => format('h2')} />
          <Tb text="H3" label="Heading 3 (Ctrl+Alt+3)" onClick={() => format('h3')} />
          <span className="acv-sep" />
          <Tb icon="bold" label="Bold (Ctrl+B)" onClick={() => format('bold')} />
          <Tb icon="italic" label="Italic (Ctrl+I)" onClick={() => format('italic')} />
          <Tb icon="strike" label="Strikethrough (Ctrl+Shift+X)" onClick={() => format('strike')} />
          <Tb icon="inline-code" label="Inline code (Ctrl+E)" onClick={() => format('code')} />
          <Tb icon="link" label="Link (Ctrl+K)" onClick={() => format('link')} />
          <span className="acv-sep" />
          <Tb icon="bullet" label="Bulleted list (Ctrl+Shift+8)" onClick={() => format('bullet')} />
          <Tb icon="number" label="Numbered list (Ctrl+Shift+7)" onClick={() => format('number')} />
          <Tb icon="task" label="Checklist" onClick={() => format('task')} />
          <Tb icon="quote" label="Quote (Ctrl+Shift+9)" onClick={() => format('quote')} />
          <span className="acv-sep" />
          <Tb icon="codeblock" label="Code block" onClick={() => format('codeblock')} />
          <Tb icon="table" label="Table" onClick={() => format('table')} />
          <Tb icon="rule" label="Divider" onClick={() => format('rule')} />
        </div>
      )}

      {conflict && (
        <div className="acv-banner is-warn" role="alert">
          <CvIcon name="warn" size={14} />
          <span>
            {conflict.versions[conflict.versions.length - 1]?.author === 'user' ? 'This canvas was changed elsewhere' : 'AICO changed this canvas'}
            {' '}(version {conflict.version}) while you were editing. Your edits are not saved yet.
          </span>
          <button type="button" className="aw-btn is-primary" onClick={() => { void keepMine(); }}>Keep mine</button>
          <button type="button" className="aw-btn" onClick={takeTheirs}>
            Take {conflict.versions[conflict.versions.length - 1]?.author === 'user' ? 'theirs' : "the agent's"}
          </button>
        </div>
      )}
      {saveError && !conflict && (
        <div className="acv-banner is-error" role="alert">
          <CvIcon name="warn" size={14} />
          <span>Could not save: {saveError}</span>
          <button type="button" className="aw-btn" onClick={() => { setSaveError(null); void save(); }}>Retry</button>
        </div>
      )}
      {viewing && doc && (
        <div className="acv-banner">
          <CvIcon name="history" size={14} />
          <span>Viewing version {viewing.version} · {authorLabel(viewing.author)} · {relativeTime(viewing.at)}{viewing.note ? ` · ${viewing.note}` : ''}</span>
          {viewing.version !== doc.version && (
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
                readOnly={Boolean(viewing)} onChange={viewing ? () => undefined : setText}
                onSelection={s => noteSelection(s)} onSave={() => { void save(); }} />
            ) : (
              <CodeArea value={shownText} language={language} readOnly={Boolean(viewing)}
                onChange={viewing ? () => undefined : setText} onSelection={s => noteSelection(s)} onSave={() => { void save(); }} />
            )}
          </div>
        ) : (
          <>
            {showSource && (
              <div className={`acv-pane${viewing ? ' is-old' : ''}`}>
                <textarea
                  ref={source}
                  className="acv-source"
                  value={shownText}
                  readOnly={Boolean(viewing)}
                  onChange={e => setText(e.target.value)}
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
              <CvIcon name="history" size={14} /> Versions
              <span className="aw-grow" />
              <button type="button" className="aw-icon-btn" onClick={() => setHistoryOpen(false)} aria-label="Close history"><CvIcon name="close" size={14} /></button>
            </div>
            <ol>
              {[...doc.versions].reverse().map(v => {
                const current = v.version === doc.version;
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
            {doc.versions.length > 0 && doc.versions[0]!.version > 1 && (
              <div className="acv-foot">Only the last {doc.versions.length} versions are kept.</div>
            )}
          </aside>
        )}

        {pill && !ask && !viewing && (
          <button type="button" className="acv-pill" style={clampPill(pill, root.current)} onMouseDown={e => e.preventDefault()}
            onClick={() => openAsk(pill)}>
            <CvIcon name="sparkle" size={13} /> Ask AI to edit
          </button>
        )}
      </div>

      {ask && (
        <AskBox at={ask.at} selection={ask.selection} actions={actions} host={root.current}
          onSend={(instruction) => { void send(instruction, ask.selection); }} onClose={() => setAsk(null)} />
      )}

      <footer className="acv-foot">
        {doc && (isCode ? (
          <span>{shownText.split('\n').length.toLocaleString()} lines{language ? ` · ${language}` : ''}</span>
        ) : (
          <span>{wordCount(shownText).toLocaleString()} words · {shownText.length.toLocaleString()} characters</span>
        ))}
        {last && doc && <><span className="aw-dot">·</span><span>Last edited by {authorLabel(last.author)} {relativeTime(last.at)}</span></>}
        {flash && status.text !== flash && <><span className="aw-dot">·</span><span>{flash}</span></>}
      </footer>
    </div>
  );
}

function clampPill(p: Point, root: HTMLElement | null): React.CSSProperties {
  const w = root?.clientWidth ?? 600;
  const h = root?.clientHeight ?? 600;
  return { left: Math.max(8, Math.min(p.x, w - 150)), top: Math.max(52, Math.min(p.y - 44, h - 80)) };
}

function Tb({ icon, text, label, onClick }: { icon?: CanvasIconName; text?: string; label: string; onClick: () => void }): React.ReactElement {
  return (
    <button type="button" className="acv-tb" title={label} aria-label={label} onMouseDown={e => e.preventDefault()} onClick={onClick}>
      {icon ? <CvIcon name={icon} size={15} /> : text}
    </button>
  );
}

function Menu({ icon, label, items, disabled }: {
  icon: CanvasIconName; label: string; disabled?: boolean; items: Array<{ label: string; run: () => void }>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="aw-menu" ref={box}>
      <button type="button" className="aw-icon-btn" disabled={disabled} onClick={() => setOpen(v => !v)} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open}>
        <CvIcon name={icon} size={15} />
      </button>
      {open && (
        <div className="aw-menu-list" role="menu">
          {items.map(it => (
            <button key={it.label} type="button" role="menuitem" onClick={() => { setOpen(false); it.run(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
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
