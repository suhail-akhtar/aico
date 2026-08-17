/**
 * One burst of the model's reasoning.
 *
 * A turn that calls tools reasons *repeatedly* — once before the first call,
 * again after each result. Those are separate thoughts about different
 * information, and concatenating them into one block produces a wall of text
 * where a reader cannot tell which thought preceded which action. Each burst is
 * therefore its own block, ordered with the tool calls it sits between.
 *
 * While a burst is live it shows its tail, so there is something moving to
 * watch and the most recent line is the visible one. When the burst ends it
 * collapses to a single summary row — the reasoning stays available for anyone
 * auditing how the model got there, without burying the answer they asked for.
 *
 * @module shared/ui/ReasoningBlock
 */

import React, { useEffect, useRef, useState } from 'react';

export interface ReasoningBlockProps {
  text: string;
  /** True while this burst is still arriving. */
  streaming?: boolean;
  /** Seconds the burst took, shown once it has ended. */
  durationMs?: number;
}

/** Characters of the tail kept in view while streaming. */
const LIVE_TAIL = 600;

export function ReasoningBlock({
  text, streaming = false, durationMs,
}: ReasoningBlockProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const tail = useRef<HTMLDivElement>(null);

  // Follow the tail while it streams, so the newest line stays visible without
  // the reader chasing it.
  useEffect(() => {
    if (!streaming || !tail.current) return;
    tail.current.scrollTop = tail.current.scrollHeight;
  }, [text, streaming]);

  if (!text.trim()) return null;

  if (streaming) {
    return (
      <div className="my-3">
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-aico-muted">
          <span className="aico-thinking">✳</span>
          <span className="aico-thinking">Thinking…</span>
        </div>
        <div
          ref={tail}
          className="max-h-32 overflow-y-auto border-l-2 border-aico-border-subtle pl-3
                     text-[13px] leading-[22px] text-aico-muted"
        >
          <div className="whitespace-pre-wrap break-words">
            {/* Only the tail is mounted: a long burst re-rendering ten thousand
                characters on every delta is the difference between a smooth
                stream and a stuttering one. */}
            {text.length > LIVE_TAIL ? `…${text.slice(-LIVE_TAIL)}` : text}
          </div>
        </div>
      </div>
    );
  }

  const seconds = durationMs !== undefined ? Math.max(1, Math.round(durationMs / 1000)) : undefined;

  return (
    <div className="my-2">
      <button
        onClick={() => setOpen(v => !v)}
        className="group flex w-full items-center gap-2 text-left text-[13px] text-aico-muted
                   transition-colors hover:text-aico-secondary"
      >
        <span className="shrink-0 text-aico-muted">✳</span>
        <span className="shrink-0">
          {seconds !== undefined ? `Thought for ${seconds}s` : 'Thought'}
        </span>
        {!open && (
          // A one-line preview: enough to recognise which thought this was
          // without expanding every one of them.
          <span className="min-w-0 flex-1 truncate text-aico-muted/70">
            · {firstLine(text)}
          </span>
        )}
        <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div className="mt-2 border-l-2 border-aico-border-subtle pl-3 text-[13px] leading-[22px] text-aico-secondary">
          <div className="whitespace-pre-wrap break-words">{text}</div>
        </div>
      )}
    </div>
  );
}

/** The opening sentence, for the collapsed preview. */
function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/).find(l => l.trim()) ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
