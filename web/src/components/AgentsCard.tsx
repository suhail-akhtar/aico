/**
 * What the sub-agents are doing, while they are doing it.
 *
 * The gap this fills is the worst one left in the client. When a turn
 * delegates, the transcript stops: the parent has made one `Task` call and is
 * waiting, and everything interesting — a dozen tool calls, several minutes,
 * most of the tokens — happens inside a child the page had no window onto. The
 * activity line said "Running Task" and the duration climbed. That is
 * indistinguishable from a hang, and people reasonably concluded it was one and
 * pressed Stop on work that was going fine.
 *
 * The engine has always tracked all of this. Only the terminal UI ever
 * subscribed to it.
 *
 * **Each agent says what it was asked for, and what it is on now.** The brief
 * is the parent's own sentence, which is the thing that makes a delegation
 * legible — "Study runtime and existing miniapp examples" tells you what is
 * happening; "Task" does not.
 *
 * **Finished agents stay until the turn ends.** A child that vanishes the
 * instant it succeeds takes its evidence with it, and the reader is back to
 * wondering whether it ran at all.
 *
 * @module components/AgentsCard
 */

import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { SubAgentView } from '../api';
import { Icon } from './Icon';

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

const TONE: Record<SubAgentView['status'], string> = {
  running: 'text-aico-accent',
  completed: 'text-aico-success',
  failed: 'text-aico-danger',
  cancelled: 'text-aico-muted',
};

export function AgentsCard(): React.ReactElement | null {
  const agents = useStore(s => s.subAgents);
  const dismissed = useStore(s => s.dismissed);
  const dismissPanel = useStore(s => s.dismissPanel);

  // Its own clock. Nothing else re-renders while a child is quietly working,
  // which is exactly the stretch this exists to describe.
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = agents.some(a => a.status === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  if (agents.length === 0) return null;

  // Keyed by which agents these are, so dismissing this delegation does not
  // hide the next one.
  const identity = agents.map(a => a.agentId).join(',');
  if (dismissed.agents === identity) return null;

  const running = agents.filter(a => a.status === 'running').length;

  return (
    <div className="pointer-events-auto rounded-xl border border-aico-border-subtle
                    bg-aico-surface p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className={running > 0 ? 'aico-thinking text-aico-accent' : 'text-aico-muted'}>
          <Icon name="stack" size={14} />
        </span>
        <span className="text-[12px] font-semibold text-aico-primary">
          {agents.length === 1 ? 'Sub-agent' : `Sub-agents ${agents.length}`}
        </span>
        {running > 0 && (
          <span className="text-[11px] text-aico-muted">{running} running</span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => dismissPanel('agents', identity)}
          aria-label="Hide sub-agents"
          className="text-aico-muted transition-colors hover:text-aico-primary"
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      <ul className="flex flex-col gap-2">
        {agents.map(agent => (
          <li key={agent.agentId} className="text-[12px]">
            <div className="flex items-baseline gap-1.5">
              <span className={`shrink-0 ${TONE[agent.status]}`}>
                {agent.status === 'running' ? '●' : agent.status === 'completed' ? '✓' : '×'}
              </span>
              <span className="min-w-0 flex-1 text-aico-primary">
                {agent.description}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 pl-4 text-[11px] text-aico-muted">
              <span className="text-aico-secondary">{agent.agentType}</span>
              {/*
                The live line. For a finished agent this is its outcome, and for
                a running one it is the tool it is inside — the single most
                useful fact, because it is what distinguishes "installing
                something slow" from "stuck".
              */}
              <span className="min-w-0 truncate">
                {agent.status === 'running'
                  ? agent.statusMessage
                  : agent.error
                    ? agent.error
                    : agent.status}
              </span>
              <div className="flex-1" />
              <span className="shrink-0 tabular-nums">
                {duration((agent.completedAt ?? now) - agent.startedAt)}
              </span>
              {agent.toolCallCount > 0 && (
                <span className="shrink-0 tabular-nums">
                  {agent.toolCallCount} {agent.toolCallCount === 1 ? 'call' : 'calls'}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
