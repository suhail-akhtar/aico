/**
 * The input, and the one design decision that matters in it.
 *
 * While a turn is running there are three different things typing can mean, and
 * collapsing them into one "send" button is how a chat UI becomes frustrating:
 *
 *   - **steer** — change what the agent is doing *right now*. Delivered at the
 *     next step boundary, so the current tool call finishes first.
 *   - **follow-up** — a separate next turn. The running work is left alone.
 *   - **cancel** — stop.
 *
 * The engine already distinguishes these, so the UI exposes them rather than
 * picking one and hiding the rest. When nothing is running there is no
 * ambiguity and the same box is just "send".
 *
 * The card shares its width with the transcript above, so the two read as one
 * surface. The metric line beneath it is the only always-on telemetry in the
 * app — everything else is a click away.
 *
 * @module components/Composer
 */

import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { ModelPicker } from './ModelPicker';
import { SetGoalButton } from './GoalBar';

export function Composer(): React.ReactElement {
  const busy = useStore(s => s.busy);
  const submit = useStore(s => s.submit);
  const prefill = useStore(s => s.composerPrefill);
  const steer = useStore(s => s.steer);
  const followup = useStore(s => s.followup);
  const cancel = useStore(s => s.cancel);
  const usage = useStore(s => s.usage);
  const model = useStore(s => s.model);

  const [text, setText] = useState('');
  // From the store, not local state. A plan approved in the side panel turns
  // planning off, and the toggle has to show that — a switch that disagrees
  // with the mode it controls is worse than no switch.
  const planMode = useStore(s => s.planMode);
  const setPlanMode = useStore(s => s.setPlanMode);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Filled from elsewhere — the plan panel's Amend, so far. Appended to what is
  // already typed rather than replacing it: silently discarding a half-written
  // message to make room is never the right trade.
  useEffect(() => {
    if (!prefill) return;
    setText(current => (current.trim() ? `${current.trimEnd()}

${prefill.text}` : prefill.text));
    const node = textarea.current;
    if (node) {
      node.focus();
      requestAnimationFrame(() => {
        resize(node, true);
        node.setSelectionRange(node.value.length, node.value.length);
      });
    }
  }, [prefill]);

  const send = async (mode: 'send' | 'steer' | 'followup'): Promise<void> => {
    const content = text.trim();
    if (!content) return;
    setText('');
    resize(textarea.current, true);

    if (mode === 'steer') await steer(content);
    else if (mode === 'followup') await followup(content);
    else await submit(content, { planMode });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    // While running, plain Enter steers — the action someone reaching for the
    // keyboard mid-run almost always wants. Ctrl/Cmd+Enter queues instead.
    if (!busy) void send('send');
    else if (event.ctrlKey || event.metaKey) void send('followup');
    else void send('steer');
  };

  return (
    <div className="px-5 pb-3">
      <div className="mx-auto w-full max-w-column">
        <div className="rounded-[22px] border border-aico-border bg-aico-bg shadow-sm transition-colors
                        focus-within:border-aico-accent/40">
          <textarea
            ref={textarea}
            value={text}
            onChange={e => { setText(e.target.value); resize(e.target); }}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={busy ? 'Steer the running turn…' : 'Message the agent'}
            className="block max-h-64 w-full resize-none bg-transparent px-5 py-3.5 text-[15px]
                       leading-[24px] text-aico-primary placeholder:text-aico-muted focus:outline-none"
          />

          <div className="flex items-center gap-1.5 px-3 pb-2.5">
            <button
              onClick={() => setPlanMode(!planMode)}
              disabled={busy}
              title="Plan first, then act"
              className={`rounded-lg px-2.5 py-1 text-[13px] transition-colors disabled:opacity-40 ${
                planMode
                  ? 'bg-aico-accent-soft text-aico-accent'
                  : 'text-aico-muted hover:bg-aico-hover hover:text-aico-secondary'
              }`}
            >
              Plan
            </button>

            <SetGoalButton />

            <div className="flex-1" />

            <ModelPicker />

            {busy ? (
              <>
                <button
                  onClick={() => void send('followup')}
                  disabled={!text.trim()}
                  title="Queue as the next turn (⌘/Ctrl+Enter)"
                  className="rounded-lg px-2.5 py-1 text-[13px] text-aico-muted
                             hover:bg-aico-hover hover:text-aico-primary disabled:opacity-40"
                >
                  Queue
                </button>
                <button
                  onClick={() => void send('steer')}
                  disabled={!text.trim()}
                  title="Deliver into the running turn (Enter)"
                  className="rounded-lg bg-aico-accent-soft px-2.5 py-1 text-[13px] text-aico-accent
                             hover:bg-aico-accent/20 disabled:opacity-40"
                >
                  Steer
                </button>
                <button
                  onClick={() => void cancel()}
                  title="Stop the running turn"
                  aria-label="Stop"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-aico-elevated
                             text-aico-primary transition-colors hover:bg-aico-hover"
                >
                  <span className="block h-2.5 w-2.5 rounded-[2px] bg-current" />
                </button>
              </>
            ) : (
              <button
                onClick={() => void send('send')}
                disabled={!text.trim()}
                aria-label="Send"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-aico-accent
                           text-aico-on-accent transition-colors hover:bg-aico-accent-hover
                           disabled:opacity-30"
              >
                ↑
              </button>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-[11px] text-aico-muted">
          <span>
            {busy
              ? 'Enter steers · ⌘/Ctrl+Enter queues'
              : 'Enter to send · Shift+Enter for a newline'}
          </span>
          {usage.input > 0 && (
            <>
              <span aria-hidden>·</span>
              <span title="Total input tokens, cached reads included">In {format(usage.input)}</span>
              <span title="Output tokens">Out {format(usage.output)}</span>
              {usage.cached > 0 && (
                <span title={`${format(usage.cached)} tokens read from cache at ~0.1× rate`}>
                  Cache {Math.round((usage.cached / usage.input) * 100)}%
                </span>
              )}
              {usage.costUsd > 0 && <span>${usage.costUsd.toFixed(4)}</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Grow with the content up to the CSS max-height, then let it scroll. */
function resize(el: HTMLTextAreaElement | null, reset = false): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = reset ? '' : `${el.scrollHeight}px`;
}

function format(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
