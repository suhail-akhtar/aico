/**
 * A code editor without a code editor: a transparent textarea over the same
 * Prism highlighter the chat's code blocks use.
 *
 * The browser portal and the VS Code panel have no Monaco (the desktop lends
 * its own through the canvas host), and a plain textarea for code loses the
 * one thing that makes code readable. Layering keeps the native textarea —
 * its caret, selection, IME, spell-check-off and undo stack — and only paints
 * colour underneath. Both layers share one font, padding and line height, and
 * scroll together, so the colours stay under the characters they belong to.
 *
 * @module shared/ui/canvas/CodeArea
 */

import React, { useDeferredValue, useLayoutEffect, useRef } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { HIGHLIGHT_LANGUAGES } from '../languages';
import type { CanvasCodeEditorProps } from './host';

/** Past this, colouring every keystroke costs more than it helps. */
const HIGHLIGHT_LIMIT = 120_000;

export function CodeArea({
  value, language, readOnly, onChange, onSelection, onSave, areaRef,
}: CanvasCodeEditorProps & { areaRef?: React.MutableRefObject<HTMLTextAreaElement | null> }): React.ReactElement {
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const pre = useRef<HTMLDivElement | null>(null);
  const gutter = useRef<HTMLDivElement | null>(null);
  const shown = useDeferredValue(value);
  const lang = (language ?? '').toLowerCase();
  const known = Boolean(lang && HIGHLIGHT_LANGUAGES[lang]) && value.length <= HIGHLIGHT_LIMIT;
  const dark = typeof document !== 'undefined'
    && (document.documentElement.dataset.theme === 'dark' || document.documentElement.classList.contains('dark')
      || document.body.classList.contains('vscode-dark'));
  const lines = value.split('\n').length;

  const sync = (): void => {
    const t = ta.current;
    if (!t) return;
    if (pre.current) { pre.current.scrollTop = t.scrollTop; pre.current.scrollLeft = t.scrollLeft; }
    if (gutter.current) gutter.current.scrollTop = t.scrollTop;
  };
  useLayoutEffect(sync, [shown]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const t = e.currentTarget;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); onSave?.(); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !readOnly) {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b } = t;
      const start = value.lastIndexOf('\n', a - 1) + 1;
      if (a === b && !e.shiftKey) { insert(t, '  ', a, b); return; }
      // Indent or outdent every selected line.
      const end = b;
      const block = value.slice(start, end);
      const next = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
      insert(t, next, start, end);
      t.setSelectionRange(start, start + next.length);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !readOnly) {
      // Keep the indentation of the line above — the least an editor does.
      const a = t.selectionStart;
      const start = value.lastIndexOf('\n', a - 1) + 1;
      const indent = /^[ \t]*/.exec(value.slice(start, a))![0];
      const opener = /[{[(:]\s*$/.test(value.slice(start, a)) ? '  ' : '';
      if (indent || opener) { e.preventDefault(); insert(t, `\n${indent}${opener}`, a, t.selectionEnd); }
    }
  };

  const reportSelection = (): void => {
    const t = ta.current;
    if (!t || !onSelection) return;
    onSelection(t.selectionStart === t.selectionEnd ? '' : value.slice(t.selectionStart, t.selectionEnd));
  };

  const common: React.CSSProperties = {
    margin: 0, padding: '12px 14px 40px', fontFamily: 'var(--aico-font-mono)', fontSize: 13, lineHeight: '20px',
    whiteSpace: 'pre', tabSize: 2, wordWrap: 'normal', overflowWrap: 'normal',
  };

  return (
    <div className="acv-code">
      <div className="acv-gutter" ref={gutter} aria-hidden="true">
        <div style={{ padding: '12px 0 40px', lineHeight: '20px' }}>
          {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
        </div>
      </div>
      <div className="acv-code-stack">
        <div className="acv-code-paint" ref={pre} aria-hidden="true">
          {known ? (
            <SyntaxHighlighter
              language={lang}
              style={dark ? oneDark : oneLight}
              customStyle={{ ...common, background: 'transparent', overflow: 'visible', borderRadius: 0 }}
              codeTagProps={{ style: { fontFamily: 'var(--aico-font-mono)', fontSize: 13, lineHeight: '20px' } }}
            >
              {shown.endsWith('\n') ? `${shown} ` : shown || ' '}
            </SyntaxHighlighter>
          ) : (
            <pre style={{ ...common, color: 'var(--aico-text-primary)' }}>{shown.endsWith('\n') ? `${shown} ` : shown || ' '}</pre>
          )}
        </div>
        <textarea
          ref={(el) => { ta.current = el; if (areaRef) areaRef.current = el; }}
          className={`acv-code-input${known ? ' is-painted' : ''}`}
          style={common}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          aria-label="Code"
          onChange={e => onChange(e.target.value)}
          onScroll={sync}
          onKeyDown={onKeyDown}
          onSelect={reportSelection}
          onMouseUp={reportSelection}
          onKeyUp={reportSelection}
        />
      </div>
    </div>
  );
}

/** Insert through the browser's own command, so Ctrl+Z undoes it like typing. */
function insert(t: HTMLTextAreaElement, text: string, from: number, to: number): void {
  t.setSelectionRange(from, to);
  let done = false;
  try { done = document.execCommand('insertText', false, text); } catch { done = false; }
  if (!done) {
    t.setRangeText(text, from, to, 'end');
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
