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
  return id;
}

/** A backgrounded shell command has exited. */
export function closeBackgroundProcess(pid: number, outcome?: string): void {
  ledger.close(`proc:${pid}`, 'done', outcome ?? 'Exited');
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
