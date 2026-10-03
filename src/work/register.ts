/**
 * Direct ledger registration, for the subsystems with nothing to subscribe to.
 *
 * Sub-agents, background agents and Mini Apps all publish change notifications,
 * so `work/adapters.ts` mirrors them without touching their code. Backgrounded
 * shell commands and cron firings do not — the only place that knows a
 * backgrounded command has started is the line that starts it.
 *
 * Split out of `adapters.ts` rather than living beside its siblings because of
 * what it would drag along. `adapters.ts` imports the sub-agent registry, the
 * background registry, the Mini App supervisor and the cost table; importing it
 * from `tools/bash.ts` would pull all four into the shell tool and close a
 * cycle — `bash` → `adapters` → `task` → the tool registry → `bash`. This file
 * imports only the ledger and the stop-handle map, both leaves.
 *
 * @module work/register
 */

import { registerStopHandle } from './handles.js';
import { ledger } from './ledger.js';

/**
 * A backgrounded shell command.
 *
 * These are spawned detached on purpose, so a dev server outlives the turn that
 * started it. That is also why the pid is recorded rather than a handle: the
 * pid is the only part that survives a restart, and boot reconciliation uses it
 * to tell a server that is still up from one that died while we were down.
 */
export function registerBackgroundProcess(opts: {
  pid: number; command: string; sessionId?: string; kill: () => void;
  /**
   * For the Tasks panel only (work/tasks): the run that started it and a
   * reader for its output so far. Kept beside the ledger, not in it, so the
   * record the model's running-work block is built from is unchanged — a
   * process with a `sessionId` would drop out of every other chat's block.
   */
  startedBy?: string;
  tail?: () => string;
}): string {
  const id = `proc:${opts.pid}`;
  if (ledger.get(id)) return id;
  ledger.open({
    id,
    kind: 'process',
    title: opts.command.length > 80 ? `${opts.command.slice(0, 77)}…` : opts.command,
    origin: 'model',
    pid: opts.pid,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  registerStopHandle(id, () => opts.kill());
  PROCESS_INFO.set(id, {
    command: opts.command,
    ...(opts.startedBy ? { startedBy: opts.startedBy } : {}),
    ...(opts.tail ? { tail: opts.tail } : {}),
  });
  // Bounded: a server left up for weeks starts many commands, and the frozen
  // tails of ones long gone are worth nothing.
  if (PROCESS_INFO.size > 200) PROCESS_INFO.delete(PROCESS_INFO.keys().next().value!);
  return id;
}

/**
 * A backgrounded shell command has exited.
 *
 * `exitCode` decides the outcome: a non-zero exit is `failed`, not `done` — a
 * dev server that crashed with exit 1 used to be filed as finished cleanly
 * (ADR 0021). Returns whether this closed the row (false when it was already
 * settled, e.g. stopped through Supervise, or was never registered).
 */
export function closeBackgroundProcess(pid: number, outcome?: string, exitCode?: number | null): boolean {
  const id = `proc:${pid}`;
  // Freeze the output: the reader closes over the shell's buffer, which is
  // garbage once the process is gone.
  const info = PROCESS_INFO.get(id);
  if (info?.tail) {
    try { info.frozen = info.tail().slice(-TAIL_CHARS); } catch { /* best effort: no tail is shown */ }
    delete info.tail;
  }
  const failed = exitCode !== undefined && exitCode !== 0;
  return ledger.close(id, failed ? 'failed' : 'done', outcome ?? 'Exited');
}

const TAIL_CHARS = 4000;

interface ProcessInfo { command: string; startedBy?: string; tail?: () => string; frozen?: string }
const PROCESS_INFO = new Map<string, ProcessInfo>();

/** What the Tasks panel knows about a backgrounded command beyond its ledger row. Unredacted — the caller redacts. */
export function processInfo(id: string): { command: string; startedBy?: string; output?: string } | undefined {
  const info = PROCESS_INFO.get(id);
  if (!info) return undefined;
  let output = info.frozen;
  if (info.tail) {
    try { output = info.tail().slice(-TAIL_CHARS); } catch { /* best effort */ }
  }
  return { command: info.command, ...(info.startedBy ? { startedBy: info.startedBy } : {}), ...(output ? { output } : {}) };
}

/**
 * One firing of a cron job.
 *
 * The job is configuration and lives in the cron store; this is the occurrence,
 * and the occurrence is what supervision is about. Without it, "what is running
 * right now" cannot see a 3am job that has been stuck for four hours — the
 * store only records when it last *started*.
 */
export function openCronRun(job: { id: string; name: string }, at = Date.now()): string {
  return ledger.open({
    id: `cron:${job.id}:${at}`,
    kind: 'schedule',
    title: job.name,
    origin: 'cron',
  });
}

export function closeCronRun(id: string, ok: boolean, outcome?: string): void {
  ledger.close(id, ok ? 'done' : 'failed', outcome);
}
