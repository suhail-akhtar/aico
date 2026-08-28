/**
 * Select any part of a reply and ask about that part.
 *
 * The alternative is describing what you mean — "the third row of that table",
 * "where you said the cache is invalidated" — which is slower to write than the
 * question and frequently lands on the wrong thing. Selecting is unambiguous by
 * construction: the quote *is* the reference.
 *
 * ## The failure this deliberately avoids
 *
 * The obvious design is a comment pinned to the selection, shown in a margin.
 * Claude Code shipped that and it is a documented trap: the sidebar invites you
 * to "select any text to leave a comment", and the assistant has no way to
 * discover the comments. People reasonably expect a comment to reach the thing
 * they are commenting to.
 *
 * So this does not store anything. The selection is quoted into the composer,
 * where it is visibly part of the message about to be sent — the reader can see
 * exactly what the agent will receive, and it reaches the agent because it *is*
 * the message. No second channel to keep in step, and nothing to discover.
 *
 * @module components/SelectionAsk
 */

import React, { useEffect, useState } from 'react';

/** Longer than this and the quote is the message rather than a reference to it. */
const MAX_QUOTE = 600;

interface Anchor { x: number; y: number; text: string }

/** The selected text, if it sits inside a rendered reply and is worth quoting. */
function readSelection(root: HTMLElement | null): Anchor | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const text = selection.toString().trim();
  // A stray click registers as a one-character selection often enough that
  // without a floor the button flickers on every click in the transcript.
  if (text.length < 3) return null;

  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const element = container.nodeType === Node.ELEMENT_NODE
    ? container as HTMLElement
    : container.parentElement;
  // Only inside the transcript. Selecting the sidebar or the composer should do
  // nothing, and without this check every selection on the page offers to ask
  // about itself.
  if (!element || !root?.contains(element)) return null;

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  return {
    // Above the selection's start, so the button never covers what was selected.
    x: rect.left + rect.width / 2,
    y: rect.top,
    text: text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text,
  };
}

export interface SelectionAskProps {
  /** The transcript element. Selections outside it are ignored. */
  scrollRoot: React.RefObject<HTMLElement | null>;
  /** Put the quote in the composer, ready for the reader to add a question. */
  onAsk: (quote: string) => void;
}

export function SelectionAsk({ scrollRoot, onAsk }: SelectionAskProps): React.ReactElement | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    // `selectionchange` rather than mouseup: it also covers keyboard selection
    // and double-click-to-select-word, both of which people use.
    const onChange = (): void => setAnchor(readSelection(scrollRoot.current));
    document.addEventListener('selectionchange', onChange);
    // A selection that scrolls out of view leaves the button floating over
    // unrelated content, pointing at nothing.
    const onScroll = (): void => setAnchor(current => (current ? readSelection(scrollRoot.current) : null));
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('selectionchange', onChange);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [scrollRoot]);

  if (!anchor) return null;

  return (
    <button
      // mousedown, not click: clicking clears the selection before the handler
      // runs, so by the time we read it there is nothing to quote.
      onMouseDown={(event) => {
        event.preventDefault();
        onAsk(anchor.text);
        window.getSelection()?.removeAllRanges();
        setAnchor(null);
      }}
      style={{
        left: anchor.x,
        top: anchor.y - 8,
        transform: 'translate(-50%, -100%)',
      }}
      className="fixed z-50 rounded-lg border border-aico-border bg-aico-bg px-2 py-1
                 text-[11px] text-aico-secondary shadow-lg transition-colors
                 hover:bg-aico-hover hover:text-aico-primary"
    >
      Ask about this
    </button>
  );
}

/**
 * The quote, as it goes into the composer.
 *
 * Block-quoted so the agent can tell the reference from the question, and
 * followed by a blank line the caret lands after — the reader types their
 * question, they do not have to make room for it first.
 */
export function quoteForComposer(text: string): string {
  const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
  return `${quoted}\n\n`;
}
