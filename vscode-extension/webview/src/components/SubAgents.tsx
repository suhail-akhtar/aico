/**
 * Work the agent handed to someone else.
 *
 * Delegation was entirely invisible in the panel: a turn could spawn three
 * sub-agents, spend four minutes and real money, and the column showed prose
 * with a spinner. The browser client has shown this from the start, and the
 * data was already arriving here — only the view was missing.
 *
 * ## Why it is a strip and not a list
 *
 * Sub-agents are *transient*. They matter intensely while running and barely at
 * all once done, so the resting state is one line per child, and a finished set
 * collapses to a summary. A permanent panel of completed delegations would
 * spend a 300px column on history the transcript already contains.
 *
 * ## Failures do not collapse
 *
 * A child that failed stays expanded with its error. Everything else about this
 * component is about getting out of the way; that one case is the reason to
 * look at all, and folding it into "3 done" is how a silent failure becomes a
 * mystery an hour later.
 *
 * @module components/SubAgents
 */

import React, { useState } from 'react';
import { useStore } from '@web/store';
import type { SubAgentView } from '@web/api';

/** Glyph per state — shape, not colour, so it survives a colourblind reader. */
const MARK: Record<SubAgentView['status'], string> = {
  running: '◐',
  completed: '✓',
  failed: '✕',
  cancelled: '⊘',
};

const TONE: Record<SubAgentView['status'], string> = {
  running: 'text-aico-accent',
  completed: 'text-aico-success',
  failed: 'text-aico-danger',
  cancelled: 'text-aico-muted',
};

export function SubAgents(): React.ReactElement | null {
  const subAgents = useStore(s => s.subAgents);
  const [open, setOpen] = useState(true);

  if (subAgents.length === 0) return null;

  const running = subAgents.filter(a => a.status === 'running');
  const failed = subAgents.filter(a => a.status === 'failed');
  // Anything running, or anything that went wrong, is worth the space. A set
  // that finished cleanly is history and gets one line.
  const expanded = open && (running.length > 0 || failed.length > 0);

  return (
    <div className="shrink-0 border-t border-aico-border-subtle">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-left"
      >
        <span className="text-[9px] text-aico-muted">{expanded ? '▾' : '▸'}</span>
        <span className="truncate text-[11px] text-aico-secondary">{headline(subAgents)}</span>
      </button>

      {expanded && (
        <ul className="max-h-[30vh] overflow-y-auto px-3 pb-1.5">
          {subAgents.map(agent => (
            <li key={agent.agentId} className="py-[1px]">
              <div
                className="flex items-start gap-1.5"
                // Indented by depth, so a grandchild reads as one. Capped at two
                // because the engine allows exactly two levels.
                style={{ paddingLeft: `${Math.min(agent.depth - 1, 1) * 12}px` }}
              >
                <span className={`shrink-0 text-[10px] leading-[16px] ${TONE[agent.status]} ${
                  agent.status === 'running' ? 'aico-thinking' : ''
                }`}>
                  {MARK[agent.status]}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] leading-[16px] text-aico-primary">
                    {agent.description || agent.agentType}
                  </span>
                  {/*
                    What it is doing right now, or what went wrong. Both are the
                    reason this component exists — a running child with no
                    status is the same blank spinner the panel already had.
                  */}
                  {agent.status === 'running' && agent.statusMessage && (
                    <span className="block truncate text-[10px] leading-[14px] text-aico-muted">
                      {agent.statusMessage}
                    </span>
                  )}
                  {agent.status === 'failed' && agent.error && (
                    <span className="block text-[10px] leading-[14px] text-aico-danger">
                      {agent.error}
                    </span>
                  )}
                </span>

                <span
                  className="shrink-0 text-[10px] tabular-nums text-aico-muted"
                  title={`${agent.agentType} · ${agent.model} · ${agent.toolCallCount} tool calls`}
                >
                  {elapsed(agent)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One line for the strip.
 *
 * Names what is *running* when anything is, because that is the question being
 * asked. Failures outrank a clean count for the same reason they do not
 * collapse.
 */
function headline(agents: SubAgentView[]): string {
  const running = agents.filter(a => a.status === 'running');
  const failed = agents.filter(a => a.status === 'failed').length;

  if (running.length === 1) {
    const one = running[0];
    return `Delegated · ${one.description || one.agentType}`;
  }
  if (running.length > 1) return `${running.length} delegations running`;
  if (failed > 0) return `${failed} delegation${failed === 1 ? '' : 's'} failed`;
  return `${agents.length} delegation${agents.length === 1 ? '' : 's'} finished`;
}

/** How long it has been going, or how long it took. */
function elapsed(agent: SubAgentView): string {
  const end = agent.completedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - agent.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}`;
}
