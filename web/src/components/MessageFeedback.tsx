/**
 * Rating one assistant reply.
 *
 * Offered only on *finalized* messages — a reply keyed by its log seq. A
 * streaming partial has no seq to attach a rating to, and rating something
 * still being written is not a judgement anyone means.
 *
 * The note is optional and only appears after a rating is given. Asking for
 * prose up front turns a one-click signal into a form, and the click alone is
 * the part people actually do.
 *
 * @module components/MessageFeedback
 */

import React, { useState } from 'react';
import type { Feedback } from '../api';
import { useStore } from '../store';

export interface MessageFeedbackProps {
  /** Log seq of the message being rated. */
  seq: number;
  current?: Feedback;
  /**
   * Rendered inside a shared actions row rather than owning its own.
   *
   * Without this the controls brought their own hover-reveal wrapper, so a
   * message with both copy and rating had two independent rows appearing at
   * slightly different moments.
   */
  inline?: boolean;
}

export function MessageFeedback({ seq, current, inline = false }: MessageFeedbackProps): React.ReactElement {
  const rate = useStore(s => s.rate);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(current?.note ?? '');

  const set = (rating: 'up' | 'down'): void => {
    // Clicking the rating you already gave withdraws it, which is the only
    // sensible meaning of pressing an active toggle.
    const next = current?.rating === rating ? 'none' : rating;
    void rate(seq, next, next === 'none' ? undefined : note || undefined);
    if (next === 'none') { setNoteOpen(false); setNote(''); }
    else setNoteOpen(true);
  };

  const saveNote = (): void => {
    setNoteOpen(false);
    if (current?.rating) void rate(seq, current.rating, note.trim() || undefined);
  };

  return (
    <div className={inline ? 'contents' : 'mt-1.5'}>
      <div className={inline
        ? 'flex items-center gap-1'
        : 'flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100'}>
        <button
          onClick={() => set('up')}
          title="This reply was good"
          aria-pressed={current?.rating === 'up'}
          className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
            current?.rating === 'up'
              ? 'bg-aico-success/20 text-aico-success'
              : 'text-aico-muted hover:bg-aico-hover hover:text-aico-secondary'
          }`}
        >
          ▲
        </button>
        <button
          onClick={() => set('down')}
          title="This reply missed"
          aria-pressed={current?.rating === 'down'}
          className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
            current?.rating === 'down'
              ? 'bg-aico-danger/20 text-aico-danger'
              : 'text-aico-muted hover:bg-aico-hover hover:text-aico-secondary'
          }`}
        >
          ▼
        </button>
        {current && !noteOpen && (
          <button
            onClick={() => setNoteOpen(true)}
            className="rounded px-1.5 py-0.5 text-[10px] text-aico-muted hover:text-aico-secondary"
          >
            {current.note ? 'Edit note' : 'Add note'}
          </button>
        )}
        {current?.note && !noteOpen && (
          <span className="truncate text-[10px] text-aico-muted" title={current.note}>
            “{current.note}”
          </span>
        )}
      </div>

      {noteOpen && (
        <input
          value={note}
          onChange={e => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={e => {
            if (e.key === 'Enter') saveNote();
            if (e.key === 'Escape') { setNote(current?.note ?? ''); setNoteOpen(false); }
          }}
          autoFocus
          placeholder="What was wrong, or right?"
          className="mt-1 w-full max-w-md rounded-md border border-aico-hover bg-aico-elevated px-2 py-1
                     text-xs text-aico-primary placeholder:text-aico-muted focus:border-aico-accent/50 focus:outline-none"
        />
      )}
    </div>
  );
}
