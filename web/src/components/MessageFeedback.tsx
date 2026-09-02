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
import { api, type Feedback } from '../api';
import { useStore } from '../store';
import { suggestKnowledge } from '../knowledge-suggest';

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
  /**
   * What the user asked that produced this reply.
   *
   * Pre-fills the trigger of a kept correction, because knowledge is matched
   * against the *next request's* wording — and the next request that goes
   * wrong will resemble this one, not its answer.
   */
  askedFor?: string;
}

export function MessageFeedback({ seq, current, inline = false, askedFor }: MessageFeedbackProps): React.ReactElement {
  const rate = useStore(s => s.rate);
  const sessionId = useStore(s => s.sessionId);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(current?.note ?? '');
  /*
    Three states rather than a boolean: closed, editing the pre-filled entry,
    and kept. "Kept" stays on screen so the reader can see the lesson landed —
    a button that vanishes on click is indistinguishable from one that failed.
  */
  const [remember, setRemember] = useState<'closed' | 'editing' | 'kept'>('closed');
  const [trigger, setTrigger] = useState('');
  const [guidance, setGuidance] = useState('');
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [keepError, setKeepError] = useState<string | null>(null);

  const openRemember = (): void => {
    const suggested = suggestKnowledge(askedFor, current?.note ?? note);
    setTrigger(suggested.trigger);
    setGuidance(suggested.content);
    setKeepError(null);
    setRemember('editing');
  };

  const keep = async (): Promise<void> => {
    if (!trigger.trim() || !guidance.trim()) return;
    try {
      await api.addKnowledge(sessionId, { trigger, content: guidance, scope });
      setRemember('kept');
    } catch (err) {
      setKeepError((err as Error).message);
    }
  };

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
        {/*
          Only for a thumbs-down with a note. A thumbs-up has nothing to
          correct, and a thumbs-down without words has nothing to keep — the
          note *is* the lesson.
        */}
        {current?.rating === 'down' && current.note && !noteOpen && remember === 'closed' && (
          <button
            onClick={openRemember}
            title="Turn this correction into guidance the agent sees on similar tasks"
            className="rounded px-1.5 py-0.5 text-[10px] text-aico-accent hover:bg-aico-accent-soft"
          >
            Remember this
          </button>
        )}
        {remember === 'kept' && (
          <span className="text-[10px] text-aico-success" title="Saved as knowledge">
            Remembered · applies to {scope === 'project' ? 'this project' : 'every project'}
          </span>
        )}
      </div>

      {remember === 'editing' && (
        <div className="mt-1.5 max-w-md rounded-lg border border-aico-accent/30 bg-aico-elevated p-2.5">
          <label className="block text-[10px] uppercase tracking-wide text-aico-muted">When</label>
          <input
            value={trigger}
            onChange={e => setTrigger(e.target.value)}
            autoFocus
            placeholder="Words that describe the task this applies to"
            className="mt-0.5 w-full rounded-md border border-aico-hover bg-aico-bg px-2 py-1 text-xs
                       text-aico-primary placeholder:text-aico-muted focus:border-aico-accent/50 focus:outline-none"
          />
          <label className="mt-2 block text-[10px] uppercase tracking-wide text-aico-muted">Then</label>
          <textarea
            value={guidance}
            onChange={e => setGuidance(e.target.value)}
            rows={2}
            className="mt-0.5 w-full resize-none rounded-md border border-aico-hover bg-aico-bg px-2 py-1 text-xs
                       text-aico-primary focus:border-aico-accent/50 focus:outline-none"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void keep()}
              disabled={!trigger.trim() || !guidance.trim()}
              className="rounded-md bg-aico-accent px-2.5 py-1 text-xs font-medium text-aico-on-accent
                         hover:bg-aico-accent-hover disabled:opacity-40"
            >
              Keep
            </button>
            <button
              onClick={() => setRemember('closed')}
              className="rounded-md px-2 py-1 text-xs text-aico-secondary hover:bg-aico-hover"
            >
              Cancel
            </button>
            <span className="flex-1" />
            {/*
              Project by default. A convention is almost always about one
              codebase, and stored globally it follows you into repositories
              where it is wrong — a failure nobody can see from a transcript.
            */}
            <label className="flex items-center gap-1.5 text-[11px] text-aico-muted">
              <input
                type="checkbox"
                checked={scope === 'global'}
                onChange={e => setScope(e.target.checked ? 'global' : 'project')}
              />
              Every project
            </label>
          </div>
          {keepError && <p className="mt-1.5 text-[11px] text-aico-danger">{keepError}</p>}
        </div>
      )}

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
