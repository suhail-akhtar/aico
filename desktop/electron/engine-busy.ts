/**
 * Is the engine in the middle of something a restart would cut short?
 *
 * Asked before installing an update and before a restore, both of which stop
 * the engine. Chats and settings are on disk either way; what a restart loses
 * is work in flight — a turn still streaming, a background agent half way
 * through its task, a scheduled job that is firing.
 *
 * Deliberately NOT counted: dev servers the agent left running, watchers, and
 * schedules waiting for their next time. They run indefinitely by design, so
 * "wait until the work finishes" would wait forever; they are started again
 * (or re-armed) by the engine after the restart.
 *
 * @module desktop/electron/engine-busy
 */

import type { EngineHost } from './engine-host';

interface SessionRow { id: string; title?: string; running?: boolean }
interface WorkRow { id: string; kind: string; title: string; state: string }
interface AgentRow { agentId: string; description: string; status: string }

/** One line per piece of work in flight, for a person to read. Pure, so it can be tested. */
export function summariseBusy(
  sessions: { sessions?: SessionRow[] } | null | undefined,
  system: { backgroundAgents?: AgentRow[]; work?: WorkRow[] } | null | undefined,
): string[] {
  const out: string[] = [];
  for (const s of sessions?.sessions ?? []) {
    if (s.running) out.push(`Chat “${s.title || 'Untitled'}” is still replying`);
  }
  const active = new Set(['running', 'queued', 'blocked']);
  const work = system?.work;
  if (work) {
    for (const w of work) {
      if (w.kind === 'agent' && active.has(w.state)) out.push(`Agent “${w.title}” is working`);
      else if (w.kind === 'schedule' && w.state === 'running') out.push(`Scheduled job “${w.title}” is running`);
    }
  } else {
    // An engine from before the work ledger reports background agents on their own.
    for (const a of system?.backgroundAgents ?? []) {
      if (a.status === 'running' || a.status === 'pending') out.push(`Background agent “${a.description}” is working`);
    }
  }
  return out;
}

function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>(r => setTimeout(() => r(null), ms))]);
}

/** Ask a running engine. An engine that is not running (or does not answer) is not busy. */
export async function engineBusy(engine: EngineHost): Promise<string[]> {
  if (!engine.current()) return [];
  const [sessions, system] = await Promise.all([
    within(engine.request('sessions') as Promise<{ sessions?: SessionRow[] }>, 5000),
    within(engine.request('system') as Promise<{ backgroundAgents?: AgentRow[]; work?: WorkRow[] }>, 5000),
  ]);
  return summariseBusy(sessions, system);
}
