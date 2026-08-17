/**
 * A fenced code block: highlighted, labelled, and copyable.
 *
 * The copy button is the point. An agent's most common output is a command to
 * run or a snippet to paste, and selecting text out of a scrolling transcript
 * with a mouse is where that flow breaks.
 *
 * Languages without a registered grammar still render — as plain monospace
 * inside the same chrome. That covers the long tail deliberately left out of
 * the grammar set, and the spreadsheet and formula languages that have no Prism
 * grammar at all but are perfectly readable unhighlighted.
 *
 * @module shared/ui/CodeBlock
 */

import React, { useState } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { HIGHLIGHT_LANGUAGES, LANGUAGE_LABELS } from './languages';

export interface CodeBlockProps {
  code: string;
  language?: string;
  /** Shown instead of the language, for a file the block came from. */
  filename?: string;
}

export const CodeBlock = React.memo(function CodeBlock({
  code, language = '', filename,
}: CodeBlockProps): React.ReactElement {
  // Read once per mount rather than subscribed: a theme switch reloads the
  // page, and watching for it would cost a listener on every code block.
  const dark = typeof document !== 'undefined'
    && document.documentElement.dataset.theme === 'dark';
  const [copied, setCopied] = useState(false);
  const known = Boolean(language && HIGHLIGHT_LANGUAGES[language]);
  const label = filename ?? LANGUAGE_LABELS[language] ?? language ?? 'text';

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused; the text is still selectable, so
      // failing loudly here would be worse than the button doing nothing.
    }
  };

  const body = code.replace(/\n$/, '');

  return (
    <figure className="group/code my-4 overflow-hidden rounded-xl bg-aico-code">
      <figcaption className="flex items-center gap-2 px-4 pb-1 pt-3 text-[12px] text-aico-muted">
        <span>{label}</span>
        <div className="flex-1" />
        <button
          onClick={() => void copy()}
          className="rounded px-2 py-0.5 text-[12px] text-aico-muted opacity-0 transition-opacity
                     hover:text-aico-primary focus:opacity-100 group-hover/code:opacity-100"
          aria-label="Copy code"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>

      {known ? (
        <SyntaxHighlighter
          language={language}
          style={dark ? oneDark : oneLight}
          customStyle={{
            margin: 0,
            background: 'transparent',
            borderRadius: 0,
            fontSize: '13px',
            lineHeight: '22px',
            padding: '4px 16px 16px',
          }}
          codeTagProps={{ style: { fontFamily: 'var(--aico-font-mono)' } }}
        >
          {body}
        </SyntaxHighlighter>
      ) : (
        <pre className="overflow-x-auto px-4 pb-4 pt-1">
          <code className="font-mono text-[13px] leading-[22px] text-aico-primary">{body}</code>
        </pre>
      )}
    </figure>
  );
});
