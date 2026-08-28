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

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageBubble } from '@aico/ui';
import type { ChatMessage } from '@aico/ui';
import { useStore } from '../store';
import { collectWidgetFixes, fixMarker, widgetHash } from '../widget-fixes';
import { applyVersions, editMarker } from '../message-versions';
import { EditableMessage } from './EditableMessage';
import { SelectionAsk, quoteForComposer } from './SelectionAsk';
import { composeMessages } from '../reduce';
import { TurnSummary } from './TurnSummary';
import { MessageActions } from './MessageActions';

/** How close to the bottom still counts as "following the stream". */
const FOLLOW_THRESHOLD_PX = 140;

/**
 * How long "connecting" may last before it needs explaining.
 *
 * A healthy stream is live in well under a second, so anything past this is not
 * slowness — it is a connection that is never going to open, and the usual
 * reason is worth naming rather than leaving as a small grey word.
 */
const CONNECT_PATIENCE_MS = 6000;

export function ChatPane(): React.ReactElement {
  // Each slice is subscribed to individually and the list derived here.
  // Subscribing to a selector that builds the array would hand zustand a new
  // value on every render and loop forever.
  const logged = useStore(s => s.logged);
  const draft = useStore(s => s.draft);
  const busy = useStore(s => s.busy);
  const submit = useStore(s => s.submit);
  const prefillComposer = useStore(s => s.prefillComposer);

  /**
   * Hand a widget that would not render back to the agent to correct.
   *
   * The transcript is append-only, so this cannot literally rewrite the message
   * that failed — and should not: the broken spec is what the agent wrote and
   * the record of that is the point. What it does instead is give the agent
   * everything it needs to get it right on the second try, which is the part
   * the reader actually wanted. Without this the reader has to copy the block,
   * paste the error and describe the problem themselves.
   *
   * The failing source is included verbatim rather than referred to. The agent
   * wrote it, but that was potentially many turns and a compaction ago, and
   * "the chart you emitted earlier" is not something it can reliably resolve.
   */
  const fixWidget = useCallback(({ kind, source, error }: {
    kind: string; source: string; error: string;
  }): void => {
    void submit([
      `The ${kind} you produced does not render. The error was:`,
      '',
      error,
      '',
      'This is the block that failed:',
      '',
      '```' + (kind === 'chart' ? 'chart' : kind),
      source,
      '```',
      '',
      `Send back a corrected \`${kind}\` block and nothing else — no explanation `
      + 'unless the fix needs one. Do not change what it is meant to show.',
      // Names the block being repaired, so the correction can be drawn where
      // the broken one stands rather than several messages further down.
      // Hidden from the reader by MessageBubble; kept in the log because that
      // is what makes the pairing survive a reload.
      fixMarker(source, kind),
    ].join('\n'));
    // Stable identity. Every message receives this as a prop, and a new
    // function each render defeats MessageBubble's memo — which during a
    // stream means re-rendering the whole transcript on every chunk.
  }, [submit]);
  const composed = useMemo(() => composeMessages(logged, draft, busy), [logged, draft, busy]);

  // Which version of an edited message the reader is looking at, by the seq of
  // the message every version replaces. Empty means "the newest of each", which
  // is what you want after editing: you changed it because the first attempt
  // was wrong.
  const [versionChoice, setVersionChoice] = useState<Map<number, number>>(new Map());
  const versioned = useMemo(
    () => applyVersions(composed, versionChoice), [composed, versionChoice],
  );
  const messages = versioned.messages;

  /**
   * Ask the same question a different way.
   *
   * The re-send names the message it replaces, so the projection can show it as
   * a version in place rather than a second question at the bottom — and so the
   * answers that came back from each attempt stay with the attempt that
   * produced them.
   */
  const resend = useCallback((originalSeq: number, text: string): void => {
    // Back to the newest, which is the one about to arrive. Leaving the reader
    // pinned to an older version while a new one streams in below would be the
    // most confusing possible outcome of pressing Send.
    setVersionChoice((current) => {
      const next = new Map(current);
      next.delete(originalSeq);
      return next;
    });
    void submit(`${text}\n${editMarker(originalSeq)}`);
  }, [submit]);

  /**
   * Take the conversation a second way from a point in it.
   *
   * The reason this is worth a button rather than "start a new session and
   * paste" is that the value of a conversation is mostly the part you would
   * have to reproduce: the files read, the reasoning, the dead ends already
   * ruled out. Branching keeps all of it and changes only what comes next.
   *
   * The two sides mean different things and behave differently:
   *
   * - From a **reply**, the branch ends *with* that reply. You keep the answer
   *   and ask something else from there.
   * - From **your own message**, the branch ends just *before* it, and the
   *   message comes back in the composer. Branching there means "ask this
   *   differently", so leaving it in the transcript would leave you re-asking
   *   a question the branch already contains.
   *
   * Distinct from edit-and-resend, which is the same intent in one session:
   * versions keep both attempts in one place under a `2/2` control, and a
   * branch gives the new attempt a session of its own. Short reword, stay;
   * two directions worth developing separately, branch.
   */
  const forkSession = useStore(s => s.forkSession);
  const sessionId = useStore(s => s.sessionId);
  const branchFrom = useCallback((message: ChatMessage): void => {
    if (message.turn === undefined) return;
    void (message.type === 'user'
      ? forkSession(sessionId, message.turn - 1, message.content)
      : forkSession(sessionId, message.turn));
  }, [forkSession, sessionId]);

  // Recomputed from the transcript rather than stored, like every other
  // projection here: a reload rebuilds which corrections replace which widgets
  // from the log alone, with nothing extra to keep in step.
  const fixes = useMemo(() => collectWidgetFixes(messages), [messages]);

  /**
   * Stable lookups over changing data.
   *
   * `fixes` is rebuilt whenever the transcript changes, which during a stream
   * is every chunk. Handing that object to every message as a prop broke
   * MessageBubble's memo on all of them — and a re-render of MarkdownRenderer
   * *remounts* each fenced block, because react-markdown's component map is
   * rebuilt and React sees a new component type at that position.
   *
   * That is what made charts flicker and a hidden widget come back: the widget
   * was not re-rendering, it was being replaced by a new one with fresh state.
   *
   * These functions never change identity and read the current value through a
   * ref. The data stays live; the props stop moving.
   */
  const fixesRef = useRef(fixes);
  fixesRef.current = fixes;
  const widgetFixes = useMemo(() => ({
    replaced: (src: string) => fixesRef.current.replacements.get(widgetHash(src)),
    superseded: (src: string) => fixesRef.current.superseded.has(widgetHash(src)),
  }), []);

  const status = useStore(s => s.status);

  // "connecting" is normal for a moment and a symptom after that.
  const [stalledConnect, setStalledConnect] = useState(false);
  useEffect(() => {
    if (status !== 'connecting') { setStalledConnect(false); return; }
    const timer = setTimeout(() => setStalledConnect(true), CONNECT_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [status]);
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
      {/*
        Quoted into the composer rather than stored as a comment: the reader can
        see exactly what the agent will receive, and it reaches the agent
        because it *is* the message. A comment held somewhere the assistant
        cannot read is a promise the interface does not keep.
      */}
      <SelectionAsk
        scrollRoot={scrollRef}
        onAsk={(quote) => prefillComposer(quoteForComposer(quote))}
      />
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-5 py-6">
        <div className="mx-auto w-full max-w-column">
          {status === 'lost' && (
            <div className="mb-4 rounded-xl border border-aico-warning/30 bg-aico-warning/8 px-4 py-2 text-[13px] text-aico-warning">
              Connection lost — reconnecting. The run keeps going on the server; nothing is lost.
            </div>
          )}

          {/*
            A stream that never opens showed nothing but the word "connecting"
            in the corner, while the page sat empty and a submitted turn looked
            like a hang. The distinction that matters is one the page can state
            without knowing the cause: the run is on the server and is fine, and
            it is only this page that has gone deaf. Saying that turns "it is
            broken" into "reload it", which is both true and actionable.

            Deliberately does not diagnose, and deliberately does not promise a
            fix. Two candidate causes were measured and ruled out — HTTP/1.1's
            six connections per host, and the server being slow to accept, which
            answers an identical request from curl instantly. An earlier draft
            said "reloading usually fixes it" and was watched not fixing it. A
            banner that names the wrong cause, or promises a remedy that does
            not work, is worse than one that just says what is true.
          */}
          {stalledConnect && (
            <div className="mb-4 rounded-xl border border-aico-warning/30 bg-aico-warning/8 px-4 py-2 text-[13px] text-aico-warning">
              Still connecting to the event stream. Your run is unaffected — it is on the server and
              keeps going — but this page will not show it until the stream opens. It keeps
              retrying; if it stays this way, try reloading or another browser window.
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
            // A sent message owns its whole footer — copy, edit and version
            // navigation together — so only replies use the shared actions row.
            const copyable = message.type === 'assistant'
              && !message.streaming && message.content.trim().length > 0;
            return (
              <div key={message.id} className="group/message">
                {message.type === 'user' && seq !== null ? (
                  <EditableMessage
                    content={message.content}
                    {...(busy ? {} : {
                      onResend: (text: string) => resend(seq, text),
                      ...(message.turn === undefined
                        ? {} : { onBranch: () => branchFrom(message) }),
                    })}
                    {...(versioned.groups.has(message.id) ? {
                      versions: {
                        total: versioned.groups.get(message.id)!.total,
                        current: versioned.groups.get(message.id)!.current,
                        onSelect: (index: number) => setVersionChoice((current) => {
                          const next = new Map(current);
                          next.set(versioned.groups.get(message.id)!.originalSeq, index);
                          return next;
                        }),
                      },
                    } : {})}
                  />
                ) : (
                  <MessageBubble
                    message={message}
                    onFix={fixWidget}
                    widgetFixes={widgetFixes}
                  />
                )}
                {copyable && (
                  <div className={message.type === 'user' ? 'flex justify-end' : ''}>
                    <MessageActions
                      text={message.content}
                      {...(!busy && message.turn !== undefined
                        ? { onBranch: () => branchFrom(message) } : {})}
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
