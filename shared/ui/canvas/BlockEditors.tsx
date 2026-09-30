/**
 * The two ways one block of an AICO Docs page is edited in place.
 *
 * **Rich** — headings, paragraphs, lists, checklists and quotes: a
 * contentEditable seeded from the block's Markdown (`rich-md`), with the
 * browser's own editing commands for bold, italic, lists and headings so
 * Ctrl+Z undoes a toolbar action like typing. It serialises only its own
 * DOM back to Markdown, and only when that differs from what it opened with.
 *
 * **Source** — tables, code, maths, charts, diagrams, HTML and anything the
 * rich model would not keep byte-for-byte: a textarea with the chat's
 * renderer as a live preview underneath.
 *
 * Neither ever takes focus on its own: they focus once, when the person opens
 * them. A write from the agent re-renders the page around an open editor but
 * never remounts it (the page keys it by editing session, not by content).
 *
 * @module shared/ui/canvas/BlockEditors
 */

import React, { useDeferredValue, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { applySplice, continueList, formatSplice, type FormatOp, type Splice } from './core';
import { blocksToHtml, domToBlocks, parseRichRegion, serializeBlocks } from './rich-md';

export type EditOp =
  | 'bold' | 'italic' | 'strike' | 'code' | 'p' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'task' | 'quote';

/** What the toolbar can ask of the open block editor. */
export interface BlockEditorApi {
  kind: 'rich' | 'source';
  run(op: EditOp): void;
  /** Remember the selection before a popover takes focus; returns the selected text. */
  holdSelection(): string;
  /** Make the held selection a link (or insert one). */
  link(url: string): void;
  /** The block style at the caret, for the toolbar's style picker. */
  style(): 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'list' | 'quote' | 'other';
}

interface CommonProps {
  initial: string;
  onChange: (markdown: string) => void;
  onDone: () => void;
  onSave?: () => void;
  onLinkRequest?: () => void;
  onPasteImage?: (file: File) => void;
  /** Where the person clicked, to put the caret there. */
  caret?: { x: number; y: number };
  label: string;
}

const KEEP_FOCUS = '[data-adoc-keep-focus]';

function leavingTo(e: React.FocusEvent, box: HTMLElement | null): boolean {
  const next = e.relatedTarget as Node | null;
  if (!next) return true;
  if (box?.contains(next)) return false;
  return !(next instanceof Element && next.closest(KEEP_FOCUS));
}

function imageFrom(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith('image/')) return f;
  return null;
}

// ── Rich ─────────────────────────────────────────────────────────────

const MD_SHORTCUTS: Array<[RegExp, EditOp]> = [
  [/^#$/, 'h1'], [/^##$/, 'h2'], [/^###$/, 'h3'], [/^[-*+]$/, 'bullet'], [/^1[.)]$/, 'number'], [/^\[\s?\]$/, 'task'], [/^>$/, 'quote'],
];

export const RichBlockEditor = React.forwardRef<BlockEditorApi, CommonProps>(function RichBlockEditor(
  { initial, onChange, onDone, onSave, onLinkRequest, onPasteImage, caret, label }, ref,
) {
  const el = useRef<HTMLDivElement | null>(null);
  const last = useRef(initial);
  const timer = useRef<number | undefined>(undefined);
  const held = useRef<Range | null>(null);
  const done = useRef(false);

  const flush = (): void => {
    window.clearTimeout(timer.current);
    const node = el.current;
    if (!node) return;
    normaliseTasks(node);
    const md = serializeBlocks(domToBlocks(node));
    if (md !== last.current) { last.current = md; onChange(md); }
  };
  const later = (): void => { window.clearTimeout(timer.current); timer.current = window.setTimeout(flush, 220); };
  const finish = (): void => {
    if (done.current) return;
    done.current = true;
    flush();
    onDone();
  };

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const parsed = parseRichRegion(initial);
    node.innerHTML = parsed ? blocksToHtml(parsed) : '<p><br></p>';
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* older engines use <div>, which reads the same */ }
    node.focus({ preventScroll: true });
    const sel = window.getSelection();
    let placed = false;
    if (caret && sel) {
      const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
      const r = doc.caretRangeFromPoint?.(caret.x, caret.y);
      if (r && node.contains(r.startContainer)) { sel.removeAllRanges(); sel.addRange(r); placed = true; }
    }
    if (!placed && sel) {
      const r = document.createRange();
      r.selectNodeContents(node);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    // Opened by the person (a click, Enter, an insert): make sure they can see it.
    node.scrollIntoView({ block: 'nearest' });
    return () => window.clearTimeout(timer.current);
    // Seeded once per editing session: re-seeding would throw away the caret and the undo stack.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closest = (tagNames: string): HTMLElement | null => {
    const sel = window.getSelection();
    let n: Node | null = sel?.anchorNode ?? null;
    while (n && n !== el.current) {
      if (n instanceof HTMLElement && n.matches(tagNames)) return n;
      n = n.parentNode;
    }
    return null;
  };

  const toggleTasks = (): void => {
    let list = closest('ul, ol');
    if (!list) { document.execCommand('insertUnorderedList'); list = closest('ul, ol'); }
    if (!list) return;
    if (list.getAttribute('data-tasks') === '1') {
      list.removeAttribute('data-tasks');
      list.querySelectorAll(':scope > li > input[type=checkbox]').forEach(b => b.remove());
      list.querySelectorAll(':scope > li').forEach(li => li.removeAttribute('data-task'));
    } else {
      list.setAttribute('data-tasks', '1');
      normaliseTasks(list);
    }
  };

  const toggleCode = (): void => {
    const code = closest('code');
    if (code) { code.replaceWith(document.createTextNode(code.textContent ?? '')); return; }
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : 'code';
    document.execCommand('insertHTML', false, `<code>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>&#8203;`);
  };

  const run = (op: EditOp): void => {
    const node = el.current;
    if (!node) return;
    if (document.activeElement !== node) node.focus({ preventScroll: true });
    switch (op) {
      case 'bold': document.execCommand('bold'); break;
      case 'italic': document.execCommand('italic'); break;
      case 'strike': document.execCommand('strikeThrough'); break;
      case 'code': toggleCode(); break;
      case 'p': case 'h1': case 'h2': case 'h3': {
        if (closest('li')) document.execCommand(closest('ol') ? 'insertOrderedList' : 'insertUnorderedList');
        document.execCommand('formatBlock', false, op);
        break;
      }
      case 'bullet': document.execCommand('insertUnorderedList'); break;
      case 'number': document.execCommand('insertOrderedList'); break;
      case 'task': toggleTasks(); break;
      case 'quote': document.execCommand('formatBlock', false, closest('blockquote') ? 'p' : 'blockquote'); break;
    }
    flush();
  };

  useImperativeHandle(ref, () => ({
    kind: 'rich' as const,
    run,
    holdSelection: () => {
      const sel = window.getSelection();
      held.current = sel && sel.rangeCount && el.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
      return held.current?.toString() ?? '';
    },
    link: (url: string) => {
      const node = el.current;
      if (!node || !url.trim()) return;
      node.focus({ preventScroll: true });
      const sel = window.getSelection();
      if (held.current && sel) { sel.removeAllRanges(); sel.addRange(held.current); }
      if (sel && !sel.isCollapsed) document.execCommand('createLink', false, url.trim());
      else document.execCommand('insertHTML', false, `<a href="${url.trim().replace(/"/g, '&quot;')}">${url.trim().replace(/</g, '&lt;')}</a>`);
      held.current = null;
      flush();
    },
    style: () => {
      if (closest('li')) return 'list';
      if (closest('blockquote')) return 'quote';
      const h = closest('h1, h2, h3, h4, h5, h6');
      if (h) return (h.tagName.toLowerCase() === 'h1' || h.tagName.toLowerCase() === 'h2' || h.tagName.toLowerCase() === 'h3' ? h.tagName.toLowerCase() : 'h4') as 'h1';
      return 'p';
    },
  }));

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape' || (mod && e.key === 'Enter')) { e.preventDefault(); e.stopPropagation(); finish(); return; }
    if (mod && !e.altKey && !e.shiftKey) {
      if (k === 's') { e.preventDefault(); flush(); onSave?.(); return; }
      if (k === 'k') { e.preventDefault(); onLinkRequest?.(); return; }
      if (k === 'e') { e.preventDefault(); run('code'); return; }
      if (k === 'b' || k === 'i') { e.preventDefault(); run(k === 'b' ? 'bold' : 'italic'); return; }
    }
    if (mod && e.altKey && !e.shiftKey) {
      const op = e.code === 'Digit1' ? 'h1' : e.code === 'Digit2' ? 'h2' : e.code === 'Digit3' ? 'h3' : e.code === 'Digit0' ? 'p' : null;
      if (op) { e.preventDefault(); run(op); return; }
    }
    if (mod && e.shiftKey && !e.altKey) {
      const op = e.code === 'Digit8' ? 'bullet' : e.code === 'Digit7' ? 'number' : e.code === 'Digit9' ? 'quote' : e.code === 'KeyX' ? 'strike' : null;
      if (op) { e.preventDefault(); run(op); return; }
    }
    if (e.key === 'Tab' && closest('li')) {
      e.preventDefault();
      document.execCommand(e.shiftKey ? 'outdent' : 'indent');
      later();
      return;
    }
    // Markdown habits: "## " makes a heading, "- " a list, "[] " a checklist.
    if (e.key === ' ' && !mod) {
      const sel = window.getSelection();
      const block = closest('p, div');
      if (sel && sel.isCollapsed && block && block !== el.current && !closest('li, blockquote')) {
        const r = sel.getRangeAt(0).cloneRange();
        r.setStart(block, 0);
        const typed = r.toString();
        const hit = MD_SHORTCUTS.find(([re]) => re.test(typed));
        if (hit) {
          e.preventDefault();
          sel.removeAllRanges();
          sel.addRange(r);
          document.execCommand('delete');
          run(hit[1]);
        }
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>): void => {
    const img = imageFrom(e.clipboardData);
    if (img && onPasteImage) { e.preventDefault(); onPasteImage(img); return; }
    const html = e.clipboardData.getData('text/html');
    const plain = e.clipboardData.getData('text/plain');
    e.preventDefault();
    if (html && typeof DOMParser !== 'undefined') {
      // Pasted HTML goes through the model: what survives is what Markdown can say, escaped.
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const blocks = domToBlocks(parsed.body as unknown as Parameters<typeof domToBlocks>[0]);
      if (blocks.length) { document.execCommand('insertHTML', false, blocksToHtml(blocks)); later(); return; }
    }
    document.execCommand('insertText', false, plain);
    later();
  };

  return (
    <div
      ref={el}
      className="adoc-rich markdown-body"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      spellCheck
      onInput={later}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onClick={(e) => { if ((e.target as HTMLElement).matches('input[type=checkbox]')) window.setTimeout(flush, 0); }}
      onBlur={(e) => { if (leavingTo(e, el.current)) finish(); }}
    />
  );
});

/** Every item of a checklist starts with its box — the browser's Enter makes items without one. */
function normaliseTasks(root: HTMLElement): void {
  const lists = root.matches('[data-tasks="1"]') ? [root] : Array.from(root.querySelectorAll<HTMLElement>('[data-tasks="1"]'));
  for (const list of lists) {
    for (const li of Array.from(list.children)) {
      if (li.tagName !== 'LI' || li.querySelector(':scope > input[type=checkbox]')) continue;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.setAttribute('contenteditable', 'false');
      li.insertBefore(box, li.firstChild);
    }
  }
}

// ── Source ───────────────────────────────────────────────────────────

const SOURCE_OPS: Partial<Record<EditOp, FormatOp>> = {
  bold: 'bold', italic: 'italic', strike: 'strike', code: 'code', h1: 'h1', h2: 'h2', h3: 'h3',
  bullet: 'bullet', number: 'number', task: 'task', quote: 'quote',
};

export const SourceBlockEditor = React.forwardRef<BlockEditorApi, CommonProps & { lang?: string; side?: boolean }>(function SourceBlockEditor(
  { initial, onChange, onDone, onSave, onLinkRequest, onPasteImage, label, side = false }, ref,
) {
  const [value, setValue] = useState(initial);
  const box = useRef<HTMLDivElement | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const valueRef = useRef(initial);
  const held = useRef<[number, number] | null>(null);
  const deferred = useDeferredValue(value);
  const done = useRef(false);

  const set = (v: string): void => { valueRef.current = v; setValue(v); onChange(v); };
  const finish = (): void => { if (!done.current) { done.current = true; onDone(); } };

  useLayoutEffect(() => {
    const t = area.current;
    if (!t) return;
    t.focus({ preventScroll: true });
    t.setSelectionRange(t.value.length, t.value.length);
    box.current?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grow with the text, so the block reads as part of the page rather than a scrolling box.
  useLayoutEffect(() => {
    const t = area.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight + 2}px`;
  }, [value]);

  const splice = (s: Splice): void => {
    const t = area.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(s.from, s.to);
    let ok = false;
    try { ok = s.insert ? document.execCommand('insertText', false, s.insert) : document.execCommand('delete'); } catch { ok = false; }
    if (!ok) set(applySplice(valueRef.current, s));
    requestAnimationFrame(() => t.setSelectionRange(s.selStart, s.selEnd));
  };

  useImperativeHandle(ref, () => ({
    kind: 'source' as const,
    run: (op: EditOp) => {
      const t = area.current;
      if (!t) return;
      if (op === 'p') {
        const start = valueRef.current.lastIndexOf('\n', t.selectionStart - 1) + 1;
        const m = /^#{1,6}\s+/.exec(valueRef.current.slice(start));
        if (m) splice({ from: start, to: start + m[0].length, insert: '', selStart: start, selEnd: start });
        return;
      }
      const f = SOURCE_OPS[op];
      if (f) splice(formatSplice(valueRef.current, t.selectionStart, t.selectionEnd, f));
    },
    holdSelection: () => {
      const t = area.current;
      held.current = t ? [t.selectionStart, t.selectionEnd] : null;
      return t ? t.value.slice(t.selectionStart, t.selectionEnd) : '';
    },
    link: (url: string) => {
      const [a, b] = held.current ?? [valueRef.current.length, valueRef.current.length];
      const label = valueRef.current.slice(a, b) || url;
      const insert = `[${label}](${url.trim()})`;
      splice({ from: a, to: b, insert, selStart: a + insert.length, selEnd: a + insert.length });
    },
    style: () => 'other',
  }));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const mod = e.ctrlKey || e.metaKey;
    const t = e.currentTarget;
    if (e.key === 'Escape' || (mod && e.key === 'Enter')) { e.preventDefault(); e.stopPropagation(); finish(); return; }
    if (mod && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); onSave?.(); return; }
      if (k === 'k') { e.preventDefault(); onLinkRequest?.(); return; }
      const op = k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'e' ? 'code' : null;
      if (op) { e.preventDefault(); splice(formatSplice(t.value, t.selectionStart, t.selectionEnd, op)); return; }
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && t.selectionStart === t.selectionEnd) {
      const s = continueList(t.value, t.selectionStart);
      if (s) { e.preventDefault(); splice(s); }
      return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const a = t.selectionStart;
      splice({ from: a, to: t.selectionEnd, insert: '  ', selStart: a + 2, selEnd: a + 2 });
    }
  };

  return (
    // Diagrams, charts and maths read best with source and preview side by side (when there is room).
    <div ref={box} className={`adoc-source-edit${side ? ' adoc-side' : ''}`} onBlur={(e) => { if (leavingTo(e, box.current)) finish(); }}>
      <textarea
        ref={area}
        className="adoc-source-area"
        value={value}
        spellCheck={false}
        aria-label={label}
        onChange={e => set(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => { const img = imageFrom(e.clipboardData); if (img && onPasteImage) { e.preventDefault(); onPasteImage(img); } }}
      />
      <div className="adoc-source-preview" tabIndex={-1} aria-label="Preview">
        {deferred.trim() ? <MarkdownRenderer content={deferred} /> : <p className="acv-preview-empty">Empty — this block will be removed.</p>}
      </div>
      <div className="adoc-source-hint">Markdown source · Esc or Ctrl+Enter to finish</div>
    </div>
  );
});
