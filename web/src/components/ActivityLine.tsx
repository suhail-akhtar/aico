/**
 * What the agent is doing right now, while it is doing it.
 *
 * The gap this fills: a turn that has streamed some text and then gone quiet
 * looks identical to a turn that has died. The old indicator only appeared
 * when *nothing* was streaming, so the most confusing case — text arrived,
 * then thirty seconds of nothing — showed no indicator at all. You cannot tell
 * whether it is thinking, running an install, or gone.
 *
 * Three facts, and each answers a question people actually ask:
 *
 * **What is it doing** — running a named tool, thinking, writing, or waiting
 * on the model. Derived from the draft rather than announced by the server, so
 * it cannot disagree with what is on screen.
 *
 * **For how long** — a live clock from the turn's start. "Working" with no
 * duration is the same non-answer as a blank screen; 2m 14s tells you whether
 * to wait or to stop it.
 *
 * **When anything last happened** — after twenty seconds of silence it says so
 * outright. A long quiet stretch is normal for a big model call and alarming
 * for a hung one, and the only honest thing to do is show the number and let
 * the reader judge.
 *
 * @module components/ActivityLine
 */

import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Icon } from './Icon';

/** Silence past this is worth naming rather than hiding. */
const QUIET_MS = 20_000;

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function ActivityLine(): React.ReactElement | null {
  const busy = useStore(s => s.busy);
  const draft = useStore(s => s.draft);
  const startedAt = useStore(s => s.turnStartedAt);
  const lastAt = useStore(s => s.lastActivityAt);
  const usage = useStore(s => s.usage);
  const cancel = useStore(s => s.cancel);
  const subAgents = useStore(s => s.subAgents);

  // Its own clock: nothing else re-renders while the agent is quiet, which is
  // exactly the stretch this exists to describe.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  if (!busy) return null;

  const running = [...draft.tools.values()].filter(t => t.toolRunning);
  const thinking = [...draft.reasoning.values()].some(b => b.endedAt === undefined);
  const writing = draft.text.trim().length > 0;

  /*
    A delegation is the one case where the tool's name is the least informative
    thing on offer. "Running Task" for six minutes is what made people stop a
    turn that was working: the parent genuinely is doing nothing, and every
    visible signal agreed with that reading. Naming the child and the tool it is
    inside answers the actual question.
  */
  const busyAgents = subAgents.filter(a => a.status === 'running');
  const delegated = busyAgents.length > 0;

  const what = delegated
    ? (busyAgents.length === 1
        ? `${busyAgents[0]!.agentType} · ${busyAgents[0]!.statusMessage || 'working'}`
        : `${busyAgents.length} sub-agents`)
    : running.length > 0
    ? (running.length === 1 ? `Running ${running[0]!.toolName}` : `Running ${running.length} tools`)
    : thinking ? 'Thinking'
    : writing ? 'Writing'
    : 'Waiting for the model';

  const elapsed = startedAt ? now - startedAt : 0;
  const quiet = lastAt ? now - lastAt : 0;
  const isQuiet = quiet > QUIET_MS;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto flex w-full max-w-column items-center gap-2 px-5 pb-1 text-[12px]"
    >
      <span className="aico-thinking shrink-0 text-aico-accent">
        <Icon name="bolt" size={14} />
      </span>

      <span className="shrink-0 font-medium text-aico-secondary">{what}</span>

      {startedAt !== null && (
        <span className="shrink-0 tabular-nums text-aico-muted">{duration(elapsed)}</span>
      )}

      {isQuiet && (
        <span className="min-w-0 truncate text-aico-muted">
          · nothing for {duration(quiet)}
          {delegated ? ' — the sub-agent is still working'
            : running.length > 0 ? ' — the command is still running'
            : ' — the model has not replied yet'}
        </span>
      )}

      <div className="flex-1" />

      {(usage.input > 0 || usage.output > 0) && (
        <span className="shrink-0 tabular-nums text-aico-muted">
          {usage.input.toLocaleString()} in · {usage.output.toLocaleString()} out
        </span>
      )}

      {/*
        A second stop, next to the thing it stops. The composer has one, but a
        reader watching a stalled turn is looking here — and being told to look
        somewhere else is what makes a stop button feel unresponsive.
      */}
      <button
        onClick={() => void cancel()}
        className="shrink-0 rounded-full px-2 py-0.5 text-[11px] text-aico-muted
                   transition-colors hover:bg-aico-danger/10 hover:text-aico-danger"
      >
        Stop
      </button>
    </div>
  );
}
