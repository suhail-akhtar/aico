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
import { AgentPicker } from './AgentPicker';
import { SetGoalButton } from './GoalBar';
import { MentionMenu } from './MentionMenu';
import { mentionAt, searchAgents } from '../agents';
import { api, type AgentSpec } from '../api';

export function Composer(): React.ReactElement {
  const busy = useStore(s => s.busy);
  const submit = useStore(s => s.submit);
  const prefill = useStore(s => s.composerPrefill);
  const question = useStore(s => s.question);
  const answer = useStore(s => s.answer);
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

  // ── @mentions ──────────────────────────────────────────────────────
  //
  // The same act as the picker, reached without leaving the keyboard. The
  // picker is a decision made before you start writing; this is one made three
  // words in, when you realise the question is a security question.
  const setSessionAgent = useStore(s => s.setSessionAgent);
  const mentionsOn = useStore(s => (s.settings as { agents?: { directChat?: boolean } })
    .agents?.directChat !== false);
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [mention, setMention] = useState<{ query: string; from: number } | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  useEffect(() => {
    if (!mentionsOn) return;
    void api.agents()
      .then(r => setAgents(r.agents.filter(a => a.enabled)))
      .catch(() => { /* mentions are a shortcut, not a requirement */ });
  }, [mentionsOn]);

  /** Re-read after every edit and caret move, so the menu tracks what is typed. */
  const syncMention = (value: string, caret: number): void => {
    if (!mentionsOn) return;
    const found = mentionAt(value, caret);
    setMention(found);
    if (found) setHighlighted(0);
  };

  /** Engage the agent and take its `@name` back out of the message. */
  const engage = (name: string): void => {
    const at = mention;
    setMention(null);
    if (at) {
      const node = textarea.current;
      const caret = node?.selectionStart ?? text.length;
      const next = (text.slice(0, at.from) + text.slice(caret)).replace(/^\s+/, '');
      setText(next);
      // The caret goes where the token was, so typing continues in place.
      requestAnimationFrame(() => {
        node?.focus();
        node?.setSelectionRange(at.from, at.from);
      });
    }
    void setSessionAgent(name);
  };

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

    // A blocked turn takes precedence over every other reading of Enter. It
    // cannot reach a step boundary, so steering would queue the answer behind
    // a boundary that never arrives.
    if (question !== null) { await answer(content); return; }
    if (mode === 'steer') await steer(content);
    else if (mode === 'followup') await followup(content);
    else await submit(content, { planMode });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // The menu owns these keys while it is open, so Enter engages the agent
    // rather than sending a message addressed to nobody in particular.
    if (mention) {
      const matches = searchAgents(agents, mention.query);
      if (event.key === 'Escape') { event.preventDefault(); setMention(null); return; }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted(i => Math.min(i + 1, matches.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted(i => Math.max(i - 1, 0));
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && matches.length > 0) {
        event.preventDefault();
        engage(matches[Math.min(highlighted, matches.length - 1)]!.name);
        return;
      }
    }

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
      <div className="relative mx-auto w-full max-w-column">
        {mention && (
          <MentionMenu
            agents={agents}
            query={mention.query}
            selected={highlighted}
            onSelectedChange={setHighlighted}
            onChoose={engage}
            onDismiss={() => setMention(null)}
          />
        )}
        {/*
          Above the box, not in the transcript. The turn is stopped until this
          is answered, and a question you can scroll past is a turn that hangs —
          which is exactly what happened before the web had any way to hear one.
        */}
        {question !== null && (
          <div className="mb-1.5 flex items-start gap-2 rounded-xl border border-aico-accent/40
                          bg-aico-accent-soft px-3 py-2">
            <span className="mt-[1px] shrink-0 text-[12px] text-aico-accent" aria-hidden>?</span>
            <p className="min-w-0 flex-1 text-[13px] leading-[19px] text-aico-primary">{question}</p>
            <span className="shrink-0 text-[11px] text-aico-muted">waiting</span>
          </div>
        )}
        <div className="rounded-[22px] border border-aico-border bg-aico-bg shadow-sm transition-colors
                        focus-within:border-aico-accent/40">
          <textarea
            ref={textarea}
            value={text}
            onChange={e => {
              setText(e.target.value);
              resize(e.target);
              syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            // Clicking or arrowing out of a half-typed mention should close the
            // menu, not leave it hanging over unrelated text.
            onSelect={e => {
              const node = e.target as HTMLTextAreaElement;
              syncMention(node.value, node.selectionStart ?? 0);
            }}
            onBlur={() => setMention(null)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={question !== null
              ? 'Answer to continue…'
              : busy ? 'Steer the running turn…' : 'Message the agent'}
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

            <AgentPicker />

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
