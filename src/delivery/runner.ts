/**
 * How a task's run is started and watched: one small interface, so the dispatcher
 * is tested without a model and the real thing is the existing background-agent
 * machinery.
 *
 * WHY AN INTERFACE. The dispatcher's rules (parallelism, dependencies, overlap,
 * leases, what to do when a run ends) are the part worth testing, and they must not
 * need a provider to run. The real runner is a thin adapter over what already
 * exists and is already bounded: `spawnBackgroundAgent` (ADR 0021) started the way
 * "Fix all" starts its agents (ADR 0032) — auto-approve, unattended with the
 * approve-later inbox (L4, never full autonomy, never `permissions: 'full'`), the
 * Sentinel pinned to ask — plus the work ledger's supervision policy for the spend
 * ceiling and the deadline (`work/supervisor`). A run is therefore stopped by the
 * loop's own limits, not by a request in its prompt.
 *
 * Two runners exist. This file's is the fallback — a background agent, which has no
 * conversation, so a task run by it has no "Session" to open and cannot report that it is
 * waiting for anyone. The server's (`server/delivery-runner.ts`) runs each task as a chat
 * session and fills in `sessionId` and `need`.
 *
 * The runner starts agents; it never decides whether one should start, never reads
 * the board, never touches git. Deliberately not here: resuming an agent's old
 * conversation. A task that goes back for changes gets a new run in the same
 * worktree with the comments in its prompt; the branch's commits are the memory
 * that matters, and a fresh context is cheaper than replaying a stale one.
 *
 * @module delivery/runner
 */

import { getBackgroundAgentOpts, getBackgroundAgents, cancelBackgroundAgent, spawnBackgroundAgent } from '../background/index.js';
import { fixAgentOptions } from '../brief/fix.js';
import { costFor } from '../tokens.js';
import { ledger } from '../work/ledger.js';
import type { TaskNeed } from './types.js';

export interface RunSpec {
  taskId: string;
  title: string;
  prompt: string;
  /** Where the agent works: its task's worktree. */
  cwd: string;
  budgetUsd: number;
  deadlineMs: number;
}

export interface RunPoll {
  state: 'running' | 'ended' | 'gone';
  /** Meaningful when `ended`: it finished rather than failed or was stopped. */
  ok?: boolean;
  error?: string;
  result?: string;
  lastActivityAt: number;
  costUsd: number;
  /** The chat the run is held in, when it has one (the server's runner does; a background agent has none). */
  sessionId?: string;
  /** What a person must do before the run can go on, while it is running. */
  need?: Omit<TaskNeed, 'since'> & { since?: string };
}

export interface AgentRunner {
  /** Start the run and return its id. Throws when no agent can be started (no provider set up). */
  start(spec: RunSpec): string;
  poll(runId: string): RunPoll;
  stop(runId: string): void;
}

/** The real runner: a background agent, bounded by the ledger supervisor. */
export function backgroundRunner(): AgentRunner {
  return {
    start(spec) {
      const opts = getBackgroundAgentOpts();
      if (!opts) throw new Error('AICO is not configured to run agents (no provider or model set up).');
      const description = `Task: ${spec.title}`.slice(0, 120);
      const id = spawnBackgroundAgent({ description, prompt: spec.prompt }, fixAgentOptions(opts, spec.cwd, description));
      ledger.setPolicy(`bg:${id}`, { maxCostUsd: spec.budgetUsd, deadlineMs: spec.deadlineMs, onBreach: 'stop', notify: 'on-breach' });
      return id;
    },
    poll(runId) {
      const rec = getBackgroundAgents().find(r => r.agentId === runId);
      if (!rec) return { state: 'gone', lastActivityAt: 0, costUsd: 0 };
      const costUsd = costFor(rec.model, {
        inputTokens: rec.inputTokens, outputTokens: rec.outputTokens, cachedTokens: rec.cachedTokens, cacheWriteTokens: rec.cacheWriteTokens,
      }, getBackgroundAgentOpts()?.settings);
      const base = { lastActivityAt: rec.lastActivityAt, costUsd };
      if (rec.status === 'queued' || rec.status === 'running') return { state: 'running', ...base };
      return {
        state: 'ended', ok: rec.status === 'completed', ...base,
        ...(rec.error ? { error: rec.error } : {}),
        ...(rec.result ? { result: rec.result } : {}),
      };
    },
    stop(runId) { cancelBackgroundAgent(runId); },
  };
}
