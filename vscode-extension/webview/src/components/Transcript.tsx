/**
 * The conversation.
 *
 * Every message is rendered by `MessageBubble` from `shared/ui` — the same
 * component the browser client uses, including the tool cards and their diffs.
 * That is the reuse that makes this panel worth building rather than a second
 * product to maintain: a fix to how a failed `Edit` is drawn lands in both
 * surfaces, because there is only one place it is drawn.
 *
 * What is local to the panel is the *scroll behaviour*, and it has to be, because
 * a side bar behaves differently from a page. The rule everywhere is the same:
 * follow the stream while the reader is at the bottom, and stop the instant they
 * scroll up. An agent transcript that yanks you back down while you are reading
 * an earlier tool result is unusable, and it is the single most common way a
 * streaming chat UI gets this wrong.
 *
 * @module components/Transcript
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessageBubble } from '@aico/ui';
import { composeMessages } from '@web/reduce';
import { applyVersions, editMarker, seqOf } from '@web/message-versions';
import { useStore } from '@web/store';
import { host } from '../host';
import { MessageActions, MessageEditor, VersionArrows } from './MessageActions';

/**
 * How close to the bottom still counts as "at the bottom".
 *
 * Zero would be wrong: sub-pixel layout, a growing composer and the last line of
 * a streaming message all leave a few pixels of slack, and a reader who never
 * touched the scrollbar would be treated as having scrolled away.
 */
const STICK_THRESHOLD_PX = 48;

export function Transcript(): React.ReactElement {
  const logged = useStore(s => s.logged);
  const draft = useStore(s => s.draft);
  const busy = useStore(s => s.busy);
  const sessionId = useStore(s => s.sessionId);
  const error = useStore(s => s.error);
  const clearError = useStore(s => s.clearError);
  const feedback = useStore(s => s.feedback);
  const rate = useStore(s => s.rate);
  const submit = useStore(s => s.submit);
  const forkSession = useStore(s => s.forkSession);

  const scroller = useRef<HTMLDivElement>(null);
  /** Whether new output should pull the view down. Cleared by scrolling up. */
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  /** Seq of the sent message being reworked, if any. One at a time. */
  const [editing, setEditing] = useState<number | null>(null);
  /** Version a reader has navigated to, by the seq of the message it replaces. */
  const [versionChoice, setVersionChoice] = useState<Map<number, number>>(new Map());

  const composed = React.useMemo(
    () => composeMessages(logged, draft, busy),
    [logged, draft, busy],
  );

  /*
    Edited prompts folded back into the message they replaced.

    Same projection the browser client uses, over the same log. Doing it here
    rather than in the store is deliberate — which version is on screen is a
    property of *this view*, and two open surfaces should be able to look at
    different attempts at the same question.
  */
  const versioned = React.useMemo(
    () => applyVersions(composed, versionChoice), [composed, versionChoice],
  );
  const messages = versioned.messages;

  // A conversation being switched away from should not carry its open editor,
  // its scroll stickiness or its version choices into the next one.
  useEffect(() => {
    setEditing(null);
    setVersionChoice(new Map());
  }, [sessionId]);

  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = distance <= STICK_THRESHOLD_PX;
    setShowJump(!stick.current);
  };

  /*
    `useLayoutEffect`, not `useEffect`.

    The scroll has to happen in the same frame as the paint that made the
    content taller. Deferring it to a passive effect lets the browser show the
    un-scrolled frame first, which reads as a visible jolt on every token of a
    streaming reply.
  */
  useLayoutEffect(() => {
    if (!stick.current) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Switching conversations starts at the bottom, where the newest message is.
  useEffect(() => {
    stick.current = true;
    setShowJump(false);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId]);

  const jump = (): void => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setShowJump(false);
    el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="relative min-h-0 flex-1">
      {/*
        `overflow-x-hidden` is the important half.

        Setting only `overflow-y` computes the other axis to `auto`, so anything
        too wide — a long shell command in a tool card, an unbreakable path —
        gave the whole transcript a horizontal scrollbar and shifted every
        message sideways. Wide content is supposed to scroll inside its own box;
        the column itself never should.

        `min-w-0` on the inner div is what makes that possible rather than merely
        hidden: without it a flex/grid child takes its width from its widest
        content, so the overflow is pushed outward and clipped instead of being
        handled by the block that owns it.
      */}
      <div
        ref={scroller}
        onScroll={onScroll}
        className="h-full overflow-y-auto overflow-x-hidden px-3 py-3"
      >
        {messages.length === 0 && !busy && <Blank />}

        <div className="w-full min-w-0 max-w-column">
          {messages.map((message) => {
            /*
              Only a settled message has a seq, and only a seq can be rated,
              edited or branched from: a streaming partial has no place in the
              log to attach any of the three to yet.
            */
            const seq = seqOf(message.id);
            const settled = seq !== null && !message.streaming;
            const mine = message.type === 'user';
            const versions = versioned.groups.get(message.id);

            return (
              <div key={message.id} className="group/message">
                {editing !== null && seq === editing ? (
                  <MessageEditor
                    initial={message.content}
                    onCancel={() => setEditing(null)}
                    onSend={(text) => {
                      setEditing(null);
                      // Back to the newest version, which is the one about to
                      // arrive — leaving the reader pinned to an older attempt
                      // while its replacement streams in below is the most
                      // confusing possible outcome of pressing Send.
                      setVersionChoice((current) => {
                        const next = new Map(current);
                        next.delete(versions?.originalSeq ?? seq);
                        return next;
                      });
                      void submit(`${text}\n${editMarker(versions?.originalSeq ?? seq)}`);
                    }}
                  />
                ) : (
                  <>
                    <MessageBubble message={message} />
                    {versions && (
                      <div className="-mt-1 mb-1">
                        <VersionArrows
                          total={versions.total}
                          current={versions.current}
                          onSelect={index => setVersionChoice((current) => {
                            const next = new Map(current);
                            next.set(versions.originalSeq, index);
                            return next;
                          })}
                        />
                      </div>
                    )}
                    {settled && message.content.trim().length > 0 && (
                      <MessageActions
                        text={message.content}
                        {...(mine ? {} : { seq, onRate: (r) => void rate(seq, r) })}
                        {...(mine && !busy ? { onEdit: () => setEditing(seq) } : {})}
                        {...(!busy && message.turn !== undefined ? {
                          onBranch: () => void (mine
                            ? forkSession(sessionId, message.turn! - 1, message.content)
                            : forkSession(sessionId, message.turn!)),
                        } : {})}
                        {...(!mine && feedback[seq] ? { feedback: feedback[seq] } : {})}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="absolute inset-x-2 bottom-2 flex items-start gap-2 rounded border border-aico-danger/40 bg-aico-elevated px-2.5 py-2">
          <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-aico-danger">
            {error}
          </span>
          <button
            type="button"
            onClick={clearError}
            aria-label="Dismiss"
            className="shrink-0 text-[11px] text-aico-muted hover:text-aico-primary"
          >
            ✕
          </button>
        </div>
      )}

      {showJump && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-aico-border bg-aico-elevated px-2.5 py-1 text-[11px] text-aico-secondary shadow hover:text-aico-primary"
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

/**
 * What an empty conversation says.
 *
 * The workspace link is here rather than only on the toolbar because this is
 * the moment it is useful: a panel is 300px wide and is the wrong shape for
 * Mini Apps, the trajectory view, changes review and the full settings screens.
 * Somebody looking at an empty chat is deciding where to work, and an icon they
 * have not learned yet does not tell them there is a second surface at all.
 */
function Blank(): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-[12px] text-aico-secondary">Ask for something small first.</p>
      <p className="text-[11px] leading-relaxed text-aico-muted">
        Select code and press the ask shortcut, or type below. The file and line
        numbers travel with the question.
      </p>
      <p className="mt-3 text-[11px] leading-relaxed text-aico-muted">
        <button
          type="button"
          onClick={host.openWorkspace}
          className="text-aico-accent underline-offset-2 hover:underline"
        >
          Open the full workspace
        </button>
        {' '}for Mini Apps, the trajectory view and every setting.
      </p>
    </div>
  );
}
