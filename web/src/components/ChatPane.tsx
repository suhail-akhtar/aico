/**
 * The transcript.
 *
 * A reading column — one fixed width, centred, the same width as the composer
 * below it so the two read as one surface rather than two stacked panels.
 * Nothing is boxed: replies are prose set on the page, and the only surfaces
 * are the ones that carry a different *kind* of thing (a tool call, a diagram,
 * the user's own message).
 *
 * Two behaviours exist because their absence is what makes a streaming chat
 * unpleasant:
 *
 * **Autoscroll yields to the reader.** Following the stream is right until
 * someone scrolls up to read something, at which point yanking them back every
 * frame makes the transcript unusable. Autoscroll applies only while the view
 * is already near the bottom.
 *
 * **The anchor is measured before the DOM updates.** Asking "are we at the
 * bottom" after new content has been inserted always answers no, because the
 * content that just arrived is what pushed us away from it.
 *
 * @module components/ChatPane
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageBubble } from '@aico/ui';
import { useStore } from '../store';
import { composeMessages } from '../reduce';
import { TurnSummary } from './TurnSummary';
import { MessageActions } from './MessageActions';

/** How close to the bottom still counts as "following the stream". */
const FOLLOW_THRESHOLD_PX = 140;

export function ChatPane(): React.ReactElement {
  // Each slice is subscribed to individually and the list derived here.
  // Subscribing to a selector that builds the array would hand zustand a new
  // value on every render and loop forever.
  const logged = useStore(s => s.logged);
  const draft = useStore(s => s.draft);
  const busy = useStore(s => s.busy);
  const messages = useMemo(() => composeMessages(logged, draft, busy), [logged, draft, busy]);

  const status = useStore(s => s.status);
  const error = useStore(s => s.error);
  const clearError = useStore(s => s.clearError);
  const turnSummary = useStore(s => s.turnSummary);
  const feedback = useStore(s => s.feedback);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  const wasFollowing = useRef(true);
  useLayoutEffect(() => { wasFollowing.current = following; });

  const lastContent = messages[messages.length - 1]?.content;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !wasFollowing.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, lastContent, busy]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollowing(distance <= FOLLOW_THRESHOLD_PX);
  };

  const jumpToLatest = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setFollowing(true);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-5 py-6">
        <div className="mx-auto w-full max-w-column">
          {status === 'lost' && (
            <div className="mb-4 rounded-xl border border-aico-warning/30 bg-aico-warning/8 px-4 py-2 text-[13px] text-aico-warning">
              Connection lost — reconnecting. The run keeps going on the server; nothing is lost.
            </div>
          )}

          {error && (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-aico-danger/30 bg-aico-danger/8 px-4 py-2">
              <div className="flex-1 text-[13px] text-aico-danger">{error}</div>
              <button
                onClick={clearError}
                className="text-aico-danger/70 hover:text-aico-danger"
                aria-label="Dismiss error"
              >
                ✕
              </button>
            </div>
          )}

          {messages.length === 0 && !busy && <EmptyState />}

          {messages.map(message => {
            // Only a finalized reply can be rated: its id encodes the log seq
            // the rating attaches to, and a streaming partial has none.
            const seq = seqOf(message.id);
            const rateable = message.type === 'assistant' && !message.streaming && seq !== null;
            // Copy is offered on anything with words in it — including your own
            // messages, which is the case that was missing.
            const copyable = (message.type === 'assistant' || message.type === 'user')
              && !message.streaming && message.content.trim().length > 0;
            return (
              <div key={message.id} className="group/message">
                <MessageBubble message={message} />
                {copyable && (
                  <div className={message.type === 'user' ? 'flex justify-end' : ''}>
                    <MessageActions
                      text={message.content}
                      {...(rateable ? { seq } : {})}
                      {...(rateable && feedback[seq] ? { feedback: feedback[seq] } : {})}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {/* The live state moved to ActivityLine, which is pinned above the
              composer and shows while busy regardless of what is streaming.
              This one only appeared when *nothing* was streaming, so the
              worst case — text arrived, then silence — showed nothing. */}
          {busy && messages.length === 0 && <Working />}

          {!busy && <TurnSummary summary={turnSummary} />}

          {/* Breathing room so the last line never sits against the composer. */}
          <div className="h-6" />
        </div>
      </div>

      {!following && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-aico-border
                     bg-aico-bg px-3.5 py-1.5 text-[13px] text-aico-secondary shadow-sm
                     transition-colors hover:bg-aico-hover hover:text-aico-primary"
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}

/** Recover the log seq a finalized message was keyed by. */
function seqOf(id: string): number | null {
  const match = /^seq-(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

/** Shown between "the turn started" and "anything has arrived". */
function Working(): React.ReactElement {
  return (
    <div className="my-5 flex items-center gap-2 text-[13px] text-aico-muted">
      <span className="aico-thinking">✳</span>
      <span className="aico-thinking">Working…</span>
    </div>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <div className="mt-24 text-center">
      <h1 className="text-[28px] font-semibold tracking-tight text-aico-primary">
        What are we building?
      </h1>
      <p className="mx-auto mt-2 max-w-md text-[15px] text-aico-secondary">
        Ask for something. Steer it while it runs. Close the tab and come back — the run keeps going.
      </p>
    </div>
  );
}
