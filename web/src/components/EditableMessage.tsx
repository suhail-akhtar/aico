/**
 * A question you can reword and ask again.
 *
 * Rewording is the most ordinary thing in a chat and was the most tedious:
 * copy the message, scroll to the bottom, paste, edit, send — and end up with a
 * transcript holding both attempts and both answers, with nothing saying which
 * one you meant.
 *
 * Here the bubble becomes a textarea in place, and sending records a *version*
 * of that message rather than a new one at the end. The log is untouched; the
 * projection in `message-versions.ts` decides which version, and which of its
 * answers, are drawn.
 *
 * ## The control says how many, not just that there are some
 *
 * `‹ 2/2 ›` rather than a bare pair of arrows, because the useful question is
 * "is there an earlier attempt and how many" and an arrow that might be a no-op
 * answers neither.
 *
 * @module components/EditableMessage
 */

import React, { useEffect, useRef, useState } from 'react';

export interface EditableMessageProps {
  content: string;
  /** Absent while a turn is running: resending mid-turn would race it. */
  onResend?: (text: string) => void;
  /** Version navigation, when this message has been asked more than one way. */
  versions?: { total: number; current: number; onSelect: (index: number) => void };
}

export function EditableMessage({
  content, onResend, versions,
}: EditableMessageProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  // Reset when the shown version changes underneath, or a half-typed edit of
  // version 2 would appear over version 1 after navigating back.
  useEffect(() => { setDraft(content); setEditing(false); }, [content]);

  useEffect(() => {
    const node = area.current;
    if (!editing || !node) return;
    node.focus();
    // Caret at the end rather than the start: an edit is usually an addition or
    // a correction near what you last wrote, not a rewrite from the first word.
    node.setSelectionRange(node.value.length, node.value.length);
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [editing]);

  const send = (): void => {
    const text = draft.trim();
    // An unchanged edit is a cancel. Sending it would spend a turn to produce a
    // second version identical to the first.
    if (!text || text === content.trim()) { setEditing(false); setDraft(content); return; }
    setEditing(false);
    onResend?.(text);
  };

  if (editing) {
    return (
      <div className="my-6 flex justify-end">
        <div className="w-full max-w-[85%] rounded-2xl border border-aico-accent/40
                        bg-aico-elevated px-3 py-2.5">
          <textarea
            ref={area}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              // Enter sends, matching the composer. Escape abandons, which is
              // what every editable field in every application does.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              if (e.key === 'Escape') { setEditing(false); setDraft(content); }
            }}
            rows={1}
            className="block max-h-64 w-full resize-none bg-transparent text-[15px]
                       leading-[26px] text-aico-primary focus:outline-none"
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              onClick={() => { setEditing(false); setDraft(content); }}
              className="rounded-lg px-2 py-1 text-[12px] text-aico-muted
                         transition-colors hover:bg-aico-hover hover:text-aico-primary"
            >
              Cancel
            </button>
            <button
              onClick={send}
              className="rounded-lg bg-aico-accent px-2.5 py-1 text-[12px] font-medium
                         text-white transition-opacity hover:opacity-90"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group/edit my-6 flex flex-col items-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-aico-elevated px-4 py-2.5 selectable">
        <p className="whitespace-pre-wrap break-words text-[15px] leading-[26px] text-aico-primary">
          {content}
        </p>
      </div>

      <div className="mt-1 flex items-center gap-1 text-[11px] text-aico-muted
                      opacity-0 transition-opacity focus-within:opacity-100
                      group-hover/edit:opacity-100">
        {versions && versions.total > 1 && (
          <span className="mr-1 flex items-center gap-0.5">
            <button
              onClick={() => versions.onSelect(versions.current - 1)}
              disabled={versions.current === 0}
              className="rounded px-1 hover:bg-aico-hover hover:text-aico-primary
                         disabled:opacity-30 disabled:hover:bg-transparent"
              title="Previous version of this message"
            >
              ‹
            </button>
            <span className="tabular-nums">{versions.current + 1}/{versions.total}</span>
            <button
              onClick={() => versions.onSelect(versions.current + 1)}
              disabled={versions.current === versions.total - 1}
              className="rounded px-1 hover:bg-aico-hover hover:text-aico-primary
                         disabled:opacity-30 disabled:hover:bg-transparent"
              title="Next version of this message"
            >
              ›
            </button>
          </span>
        )}
        {/*
          Copy lives here rather than in the shared actions row: a sent message
          now owns its whole footer, and two rows of controls under one bubble —
          one for versions and edit, another for copy — reads as a mistake.
        */}
        <button
          onClick={() => {
            void navigator.clipboard.writeText(content).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          className="rounded px-1.5 py-0.5 transition-colors hover:bg-aico-hover
                     hover:text-aico-primary"
          title="Copy this message"
        >
          {copied ? 'copied' : 'copy'}
        </button>
        {onResend && (
          <button
            onClick={() => setEditing(true)}
            className="rounded px-1.5 py-0.5 transition-colors hover:bg-aico-hover
                       hover:text-aico-primary"
            title="Edit this message and ask again"
          >
            edit
          </button>
        )}
      </div>
    </div>
  );
}
