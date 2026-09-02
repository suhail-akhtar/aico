/**
 * The row of actions under a message.
 *
 * Copy is here for *both* sides of the conversation. Copying your own message
 * sounds redundant until you want to re-run a long prompt in a new session,
 * paste it into a ticket, or edit and resend it — at which point selecting it
 * out of a scrolling transcript by hand is the thing standing in the way.
 *
 * Actions stay hidden until the message is hovered or something in the row has
 * focus. A transcript with a permanent toolbar under every message is a
 * transcript you read past rather than read.
 *
 * @module components/MessageActions
 */

import React, { useState } from 'react';
import type { Feedback } from '../api';
import { MessageFeedback } from './MessageFeedback';

export interface MessageActionsProps {
  /** The raw text to copy — the message's own source, not its rendered form. */
  text: string;
  /** Log seq, when this message can be rated. Absent for user messages. */
  seq?: number;
  feedback?: Feedback;
  /**
   * Continue from here in a session of its own.
   *
   * Absent while a turn is running — the history being copied is still being
   * written, so a branch taken now would be cut mid-sentence.
   */
  onBranch?: () => void;
  /** What was asked that produced this reply — pre-fills a kept correction. */
  askedFor?: string;
}

export function MessageActions({
  text, seq, feedback, onBranch, askedFor,
}: MessageActionsProps): React.ReactElement {
  return (
    <div
      className="mt-1 flex items-center gap-1 opacity-0 transition-opacity
                 focus-within:opacity-100 group-hover/message:opacity-100"
    >
      <CopyButton text={text} />
      {onBranch && (
        <button
          onClick={onBranch}
          title="Continue from this reply in a new session, keeping everything above it"
          className="rounded px-1.5 py-0.5 text-[11px] text-aico-muted transition-colors
                     hover:bg-aico-hover hover:text-aico-primary"
        >
          Branch
        </button>
      )}
      {seq !== undefined && (
        <MessageFeedback
          seq={seq}
          {...(feedback ? { current: feedback } : {})}
          {...(askedFor ? { askedFor } : {})}
          inline
        />
      )}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused. The text is selectable either way, so
      // a silent no-op beats an error about something the reader can still do.
    }
  };

  return (
    <button
      onClick={() => void copy()}
      title="Copy this message"
      className="rounded px-1.5 py-0.5 text-[11px] text-aico-muted transition-colors
                 hover:bg-aico-hover hover:text-aico-primary"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
