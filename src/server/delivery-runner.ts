/**
 * How the server runs a Delivery task: as a real chat session.
 *
 * WHY A SESSION AND NOT A BACKGROUND AGENT. A background agent (`delivery/runner.ts`'s
 * fallback) has no conversation: nothing a person can open, no question it can ask, no
 * permission card, no way to read what it did after it finished — a task whose run needs
 * someone could only be found dead. A task's run is a long piece of work done in the
 * person's project; it should be what every other long piece of work here is: a session
 * with an append-only log (ADR 0001), listed by id, replayable, and visible live. So the
 * runner drives the same `RunManager.submit` a chat does, in the task's worktree, and:
 *
 *  - the task's "Session" link opens THIS chat (`claim.sessionId`, not an opaque agent id);
 *  - a question the agent asks, a permission prompt, or a call the Sentinel or a custom
 *    tool parked in the approve-later inbox for this session all surface on the task as
 *    `needs`, and are answered through the routes those things already have — Delivery
 *    adds no second way to say yes;
 *  - the run is unattended at L4: calls that need a person are parked, not run, and the
 *    Sentinel parks what it doubts (the same posture "Fix all" runs under, ADR 0032).
 *
 * LIMITS ARE ENFORCED HERE, in code, by the poll the dispatcher already makes: a task
 * has a spend ceiling and a deadline, and a run past either is cancelled and reported as
 * failed with the reason. A chat has neither by default, so a prompt asking the agent to
 * stop would be the only thing between a stuck loop and the bill.
 *
 * Not here: any decision about whether or when a task runs (the dispatcher's), and git.
 *
 * @module server/delivery-runner
 */

import { listActions } from '../autonomy/inbox.js';
import type { AgentRunner, RunPoll, RunSpec } from '../delivery/runner.js';
import type { RunManager } from './runs.js';
import type { AicoSettings } from '../settings.js';

export interface SessionRunnerDeps {
  runs: RunManager;
  /** A fresh, valid session id. */
  mintSessionId: () => string;
  /** The model a task's run uses (the person's default). */
  model: () => Promise<string>;
  /** Current settings, for cost estimates. */
  settings: () => Promise<AicoSettings>;
  /** Told when a task's session exists, so the server can find its folder (it is a worktree, not a listed project). */
  onSession?: (sessionId: string, cwd: string) => void;
  now?: () => number;
}

interface RunState {
  sessionId: string;
  spec: RunSpec;
  model: string;
  settings?: AicoSettings;
  startedAt: number;
  lastActivityAt: number;
  lastLength: number;
  ended: boolean;
  ok: boolean;
  error?: string;
  result?: string;
  /** Why the runner itself stopped the run (spend ceiling, deadline). */
  stoppedBecause?: string;
}

export function sessionRunner(deps: SessionRunnerDeps): AgentRunner {
  const now = deps.now ?? Date.now;
  const states = new Map<string, RunState>();

  const finish = (st: RunState, ok: boolean, error?: string, result?: string): void => {
    if (st.ended) return;
    st.ended = true;
    st.ok = ok && !st.stoppedBecause;
    const why = st.stoppedBecause ?? error;
    if (why) st.error = why;
    if (result) st.result = result;
  };

  return {
    start(spec: RunSpec): string {
      const sessionId = deps.mintSessionId();
      const st: RunState = {
        sessionId, spec, model: '', startedAt: now(), lastActivityAt: now(), lastLength: 0, ended: false, ok: false,
      };
      states.set(sessionId, st);
      deps.onSession?.(sessionId, spec.cwd);
      void (async () => {
        try {
          await deps.runs.ensure(sessionId, spec.cwd);
          deps.runs.rename(sessionId, `Task: ${spec.title}`.slice(0, 120));
          st.model = await deps.model();
          st.settings = await deps.settings().catch(() => undefined);
          // Unattended: a call that needs a person is parked in the inbox, not run and not guessed at (ADR 0011).
          const result = await deps.runs.submit(sessionId, spec.cwd, spec.prompt, st.model, { autonomy: 'L4' });
          finish(st, true, undefined, result);
        } catch (e) {
          finish(st, false, e instanceof Error ? e.message : String(e));
        }
      })();
      return sessionId;
    },

    poll(runId: string): RunPoll {
      const st = states.get(runId);
      if (!st) return { state: 'gone', lastActivityAt: 0, costUsd: 0 };
      const run = deps.runs.get(runId);
      let costUsd = 0;
      if (run && st.model) {
        try { costUsd = run.tokenTracker.estimateCost(st.model, st.settings); } catch { /* an unpriced model: no figure, no ceiling */ }
      }
      if (run && run.session.length !== st.lastLength) { st.lastLength = run.session.length; st.lastActivityAt = now(); }
      const base = { lastActivityAt: st.lastActivityAt, costUsd, sessionId: runId };
      if (st.ended) {
        return { state: 'ended', ok: st.ok, ...base, ...(st.error ? { error: st.error } : {}), ...(st.result ? { result: st.result } : {}) };
      }
      // The ceilings, enforced by the loop that watches the run rather than requested in its prompt.
      if (st.spec.budgetUsd > 0 && costUsd > st.spec.budgetUsd && !st.stoppedBecause) {
        st.stoppedBecause = `spend ceiling reached ($${costUsd.toFixed(2)} of $${st.spec.budgetUsd.toFixed(2)})`;
        deps.runs.cancel(runId);
      } else if (now() - st.startedAt > st.spec.deadlineMs && !st.stoppedBecause) {
        st.stoppedBecause = `deadline reached (${Math.round(st.spec.deadlineMs / 60_000)} minutes)`;
        deps.runs.cancel(runId);
      }
      const need = needOf(runId, run);
      return { state: 'running', ...base, ...(need ? { need } : {}) };
    },

    stop(runId: string): void {
      const st = states.get(runId);
      if (st && !st.ended) st.stoppedBecause = 'stopped';
      deps.runs.cancel(runId);
    },
  };
}

type Need = NonNullable<RunPoll['need']>;

/** What a person must do for this session's run, if anything: its question, its permission card, or a parked call. */
function needOf(sessionId: string, run: ReturnType<RunManager['get']>): Need | undefined {
  if (run?.pendingQuestion) {
    return { kind: 'question', prompt: run.pendingQuestion.question.slice(0, 1500), since: new Date(run.pendingQuestion.at).toISOString() };
  }
  if (run?.pendingPermission) {
    const p = run.pendingPermission;
    return {
      kind: 'permission', prompt: `${p.tool}`.slice(0, 200), detail: p.detail.slice(0, 1500), tool: p.tool, ref: p.id,
      since: new Date(p.at).toISOString(),
    };
  }
  const parked = listActions({ status: 'pending' }).find(a => a.sessionId === sessionId);
  if (parked) {
    return {
      kind: 'approval', prompt: `${parked.tool}: ${parked.why}`.slice(0, 400), detail: parked.call.slice(0, 1500), tool: parked.tool, ref: parked.id,
      since: new Date(parked.createdAt).toISOString(),
    };
  }
  return undefined;
}
