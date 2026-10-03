/**
 * The Tasks panel rows only the desktop knows about: terminal tabs running a
 * command, and taught browser procedures being replayed.
 *
 * The engine's ledger cannot see either — terminals are node-pty processes
 * in Electron main and procedures run against the built-in browser there —
 * so the panel would otherwise say "nothing running" while `npm run build`
 * churns in a tab the agent opened. These are polled from main
 * (`term:list`, `browser:teach:runs`) and turned into the same TaskItem the
 * engine sends.
 *
 * Pure and testable (desktop/scripts/test-tasks.mjs): the previous rows are
 * passed in, so a command that stopped running becomes a *finished* row
 * with how long it took and how it exited, instead of silently vanishing.
 * A tab sitting at its prompt is not a task and is not shown; an exited tab
 * is gone.
 *
 * @module desktop/renderer/tasks/desktop-items
 */

import type { TaskItem } from '@aico/shared/tasks';

/** What `term:list` returns, read defensively: the terminal module is still growing. */
export interface TerminalSummaryLike {
  id: string;
  title: string;
  cwd?: string;
  exited?: boolean;
  owner?: string;
  running?: boolean;
  createdAt?: number;
  commands?: number;
  lastExit?: number | null;
  lastCommand?: string;
}

/** What `browser:teach:runs` returns. */
export interface ProcedureRunLike {
  id: string;
  name: string;
  origin?: string;
  status: string;
  at: number;
  done: number;
  total: number;
  current?: string;
}

/** How many finished desktop rows to keep: a window open all week runs many commands. */
const KEEP_FINISHED = 40;

export function terminalItems(list: TerminalSummaryLike[], prev: ReadonlyMap<string, TaskItem>, now: number): TaskItem[] {
  const out: TaskItem[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    if (t.exited) continue;
    const id = `term:${t.id}`;
    const before = prev.get(id);
    const agent = t.owner === 'agent';
    if (t.running) {
      seen.add(id);
      const startedAt = before && before.status === 'running' ? before.startedAt : now;
      out.push({
        id,
        kind: 'terminal',
        title: `${t.title}${agent ? ' (agent)' : ''}`,
        status: 'running',
        origin: agent ? 'model' : 'user',
        startedAt,
        step: t.lastCommand && before?.status !== 'running' ? `Running ${t.lastCommand}` : (before?.step ?? 'Running a command'),
        ...(t.cwd ? { detail: t.cwd } : {}),
        ref: { terminalId: t.id },
        can: { stop: true, show: true },
      });
    } else if (before && before.status === 'running') {
      // It was running a moment ago: it finished. The exit code says how.
      seen.add(id);
      const failed = typeof t.lastExit === 'number' && t.lastExit !== 0;
      out.push({
        ...before,
        id: `${id}:${before.startedAt}`,
        status: failed ? 'failed' : 'completed',
        endedAt: now,
        ...(t.lastCommand ? { step: t.lastCommand } : {}),
        ...(failed ? { error: `Exited with code ${t.lastExit}` } : typeof t.lastExit === 'number' ? { outcome: 'Exited with code 0' } : {}),
        can: { show: true },
      });
    }
  }
  // Finished rows from earlier polls stay until they age out.
  const finished = [...prev.values()].filter(i => i.kind === 'terminal' && i.status !== 'running' && !seen.has(i.id) && !out.some(o => o.id === i.id));
  return [...out, ...finished.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, KEEP_FINISHED)];
}

const PROC_STATUS: Record<string, TaskItem['status']> = {
  running: 'running', waiting_for_user: 'waiting', done: 'completed',
  failed: 'failed', refused: 'failed', stopped: 'stopped', needs_judgement: 'stopped',
};

export function procedureItems(runs: ProcedureRunLike[], prev: ReadonlyMap<string, TaskItem>, now: number): TaskItem[] {
  return runs.map((r): TaskItem => {
    const id = `procedure:${r.id}`;
    const status = PROC_STATUS[r.status] ?? 'running';
    const before = prev.get(id);
    const live = status === 'running' || status === 'waiting';
    return {
      id,
      kind: 'procedure',
      title: r.name,
      status,
      ...(status === 'waiting' ? { needsYou: true, detail: 'The procedure is waiting for you in the browser (a sign-in, a code, or an Allow).' } : {}),
      origin: 'model',
      startedAt: r.at,
      ...(!live ? { endedAt: before?.endedAt ?? now } : {}),
      ...(r.current ? { step: r.current } : {}),
      todo: { done: r.done, total: r.total },
      ...(r.status === 'needs_judgement' ? { error: 'A step could not be found with confidence; it was handed back to the agent.' } : {}),
      ...(r.status === 'refused' ? { error: 'A step was refused (a secret field, a human check, or another origin).' } : {}),
      can: { show: true },
    };
  });
}
