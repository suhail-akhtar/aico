/**
 * What you can do to a single message.
 *
 * Copy, branch, rate — and, for something you sent, edit it and send it again.
 * The browser client has had all four since early on; the panel had none, which
 * made a wrong prompt unrecoverable except by retyping it, and made a good reply
 * unrateable so the feedback log only ever saw the web surface.
 *
 * ## Hidden until hovered
 *
 * A 300px column cannot afford a permanent toolbar under every message: it
 * doubles the vertical cost of a two-line reply and turns a transcript into a
 * list of buttons with prose between them. The row appears on hover and on
 * keyboard focus — the second half matters, because `opacity-0` alone would put
 * these controls permanently out of reach of anyone tabbing.
 *
 * ## Editing resends rather than rewrites
 *
 * The log is append-only, so an edited message is a *new* message carrying a
 * marker naming the one it replaces (`editMarker`). The projection in
 * `@web/message-versions` folds them back into one row with version arrows. The
 * panel reuses that projection rather than re-deriving it — the alternative is
 * two surfaces disagreeing about which version of a prompt is current.
 *
 * @module components/MessageActions
 */

import React, { useEffect, useRef, useState } from 'react';
import { api, type Feedback } from '@web/api';
import { useStore } from '@web/store';
import { suggestKnowledge } from '@web/knowledge-suggest';

export function MessageActions({
  text, seq, feedback, onBranch, onEdit, onRate, askedFor,
}: {
  /** The message's own source, not its rendered form. */
  text: string;
  /** Log seq, present once the message is finalized. Only then can it be rated. */
  seq?: number;
  feedback?: Feedback;
  /** Continue from here in a session of its own. Absent while a turn runs. */
  onBranch?: () => void;
  /** Only for messages you sent. */
  onEdit?: () => void;
  /** A rating, and for a thumbs-down, the reason. */
  onRate?: (rating: 'up' | 'down' | 'none', note?: string) => void;
  /** What was asked that produced this reply — the trigger of a kept correction. */
  askedFor?: string;
}): React.ReactElement {
  const sessionId = useStore(s => s.sessionId);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState(feedback?.note ?? '');
  const [kept, setKept] = useState<'no' | 'keeping' | 'yes' | 'failed'>('no');

  /*
    A thumbs-down opens the question straight away.

    The browser client waits for a click on "Add note". In a 300px column that
    second click is the one nobody makes, and a thumbs-down with no words is a
    signal the log stores and nothing can act on — the note is the lesson.
  */
  const rateDown = (): void => {
    if (feedback?.rating === 'down') { onRate?.('none'); setAsking(false); return; }
    onRate?.('down');
    setAsking(true);
  };

  const saveNote = (): void => {
    setAsking(false);
    const trimmed = note.trim();
    if (trimmed) onRate?.('down', trimmed);
  };

  const suggestion = suggestKnowledge(askedFor, feedback?.note ?? note);

  const keep = async (): Promise<void> => {
    setKept('keeping');
    try {
      await api.addKnowledge(sessionId, { trigger: suggestion.trigger, content: suggestion.content });
      setKept('yes');
    } catch {
      setKept('failed');
    }
  };

  return (
    <div className="mt-0.5">
    <div
      className="flex items-center gap-0.5 opacity-0 transition-opacity
                 focus-within:opacity-100 group-hover/message:opacity-100"
    >
      <CopyButton text={text} />
      {onEdit && <Action label="Edit" title="Edit this message and send it again" onPick={onEdit} />}
      {onBranch && (
        <Action
          label="Branch"
          title="Continue from here in a new session, keeping everything above it"
          onPick={onBranch}
        />
      )}
      {seq !== undefined && onRate && (
        <>
          <span className="flex-1" />
          <Rate
            title="Helpful"
            glyph="▲"
            on={feedback?.rating === 'up'}
            onPick={() => onRate(feedback?.rating === 'up' ? 'none' : 'up')}
          />
          <Rate
            title="Not helpful"
            glyph="▼"
            on={feedback?.rating === 'down'}
            onPick={rateDown}
          />
        </>
      )}
    </div>

    {asking && (
      <input
        autoFocus
        value={note}
        onChange={e => setNote(e.target.value)}
        onBlur={saveNote}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); saveNote(); }
          if (e.key === 'Escape') { e.preventDefault(); setAsking(false); }
        }}
        placeholder="What went wrong?"
        aria-label="Why this reply missed"
        className="mt-1 w-full rounded border border-aico-border bg-aico-elevated px-1.5 py-0.5
                   text-[11px] text-aico-primary placeholder:text-aico-muted focus:border-aico-accent
                   focus:outline-none"
      />
    )}

    {/*
      Keep it, with the trigger shown before the click.

      One button rather than the browser client's editable form — the column is
      too narrow for a form, and the full editor is a tab away. But the
      suggestion is on screen first, because a lesson adopted unread is exactly
      the confidently wrong rule this is meant to avoid. The user is the gate.
    */}
    {feedback?.rating === 'down' && feedback.note && !asking && kept !== 'yes' && (
      <div className="mt-1 flex items-start gap-1.5 text-[10px] leading-snug">
        <button
          type="button"
          disabled={kept === 'keeping'}
          onClick={() => void keep()}
          title="Save this correction as knowledge the agent sees on similar tasks in this project"
          className="shrink-0 rounded px-1.5 py-0.5 text-aico-accent hover:bg-aico-accent-soft
                     disabled:opacity-50"
        >
          {kept === 'keeping' ? 'Keeping…' : kept === 'failed' ? 'Retry keeping' : 'Remember this'}
        </button>
        <span className="min-w-0 truncate text-aico-muted" title={suggestion.trigger}>
          when: {suggestion.trigger}
        </span>
      </div>
    )}
    {kept === 'yes' && (
      <p className="mt-1 text-[10px] text-aico-success">Remembered for this project.</p>
    )}
    </div>
  );
}

function Action({ label, title, onPick }: {
  label: string; title: string; onPick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={onPick}
      className="rounded px-1 py-0.5 text-[10px] text-aico-muted
                 hover:bg-aico-hover hover:text-aico-primary"
    >
      {label}
    </button>
  );
}

/**
 * A rating that says what it is in words.
 *
 * The glyphs are triangles rather than thumbs because a thumb at 10px is a
 * smudge, and because `title`/`aria-label` carry the meaning either way — the
 * shape is the affordance, not the message.
 */
function Rate({ title, glyph, on, onPick }: {
  title: string; glyph: string; on: boolean; onPick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={onPick}
      className={[
        'rounded px-1 py-0.5 text-[9px] leading-none',
        on ? 'text-aico-accent' : 'text-aico-muted hover:bg-aico-hover hover:text-aico-primary',
      ].join(' ')}
    >
      {glyph}
    </button>
  );
}

export function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /*
        A webview's clipboard write can be refused, and there is nothing useful
        to say about it: the text is selectable, so an error toast would be
        noise about something the reader can still do by hand.
      */
    }
  };

  return (
    <button
      type="button"
      title="Copy this message"
      onClick={() => void copy()}
      className="rounded px-1 py-0.5 text-[10px] text-aico-muted
                 hover:bg-aico-hover hover:text-aico-primary"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * A sent message, in a field, ready to be sent again.
 *
 * `Escape` abandons and `Ctrl`/`Cmd`+`Enter` sends — plain `Enter` inserts a
 * newline, matching the composer directly below it. Getting that pair backwards
 * is how an editor loses a paragraph somebody was halfway through rewriting.
 */
export function MessageEditor({ initial, onSend, onCancel }: {
  initial: string;
  onSend: (text: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Grows with the text, like the composer. A fixed three rows would hide most
  // of a long prompt at exactly the moment it is being reworked.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [value]);

  const send = (): void => {
    const next = value.trim();
    if (next) onSend(next);
    else onCancel();
  };

  return (
    <div className="my-1 rounded border border-aico-accent bg-aico-elevated p-1.5">
      <textarea
        ref={field}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
        }}
        aria-label="Edit this message"
        className="block w-full resize-none bg-transparent text-[12px] leading-relaxed
                   text-aico-primary focus:outline-none"
      />
      <div className="mt-1 flex items-center gap-1.5">
        <button
          type="button"
          onClick={send}
          className="rounded bg-aico-accent px-2 py-0.5 text-[11px] text-aico-on-accent
                     hover:bg-aico-accent-hover"
        >
          Send again
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-0.5 text-[11px] text-aico-secondary hover:bg-aico-hover"
        >
          Cancel
        </button>
        <span className="ml-auto text-[9px] text-aico-muted">Ctrl+Enter</span>
      </div>
    </div>
  );
}

/**
 * Which version of an edited message you are looking at.
 *
 * Shown only when there is more than one. Without it an edit silently replaces
 * what was asked before, and the earlier attempt — often the one that was
 * right — becomes unreachable even though the log still holds it.
 */
export function VersionArrows({ total, current, onSelect }: {
  total: number; current: number; onSelect: (index: number) => void;
}): React.ReactElement | null {
  if (total < 2) return null;
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 align-middle text-[9px] text-aico-muted">
      <button
        type="button"
        aria-label="Previous version"
        disabled={current === 0}
        onClick={() => onSelect(current - 1)}
        className="px-0.5 hover:text-aico-primary disabled:opacity-30"
      >
        ‹
      </button>
      <span className="tabular-nums">{current + 1}/{total}</span>
      <button
        type="button"
        aria-label="Next version"
        disabled={current >= total - 1}
        onClick={() => onSelect(current + 1)}
        className="px-0.5 hover:text-aico-primary disabled:opacity-30"
      >
        ›
      </button>
    </span>
  );
}
