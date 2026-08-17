/**
 * Opening a session for a run.
 *
 * One helper so every entry point — the readline REPL, the Ink TUI, the
 * Electron bridge, one-shot `-p` mode — attaches to durable history the same
 * way. Divergence here would mean a conversation resumable from one UI and not
 * another, which is exactly the class of bug an append-only log is supposed to
 * remove.
 *
 * @module session/open
 */

import { Session } from './session.js';
import { initEventLog, loadEventLog, persistSession } from './persistence.js';

/** A session attached to durable storage. */
export interface OpenSession {
  session: Session;
  /** Whether existing history was rehydrated from disk. */
  resumed: boolean;
  /** Detach persistence and flush pending writes. */
  close: () => Promise<void>;
}

/**
 * Open a session by id, resuming its event log when one exists.
 *
 * Storage failures are not fatal: an unwritable log degrades the run to
 * in-memory history rather than refusing to start. The agent is still useful
 * without a transcript; it is useless if it will not run.
 *
 * @param sessionId - session identity.
 * @param cwd - project directory the log is filed under.
 * @param name - optional display name for a fresh session.
 */
export async function openSession(
  sessionId: string,
  cwd: string,
  name?: string,
): Promise<OpenSession> {
  let session: Session | null = null;
  let resumed = false;

  try {
    session = await loadEventLog(sessionId, cwd);
    resumed = session !== null && session.length > 0;
  } catch {
    session = null;
  }

  if (session === null) {
    session = new Session({
      id: sessionId,
      cwd,
      startedAt: Date.now(),
      ...(name ? { name } : {}),
    });
    await initEventLog(session.header).catch(() => undefined);
  }

  let detach: (() => Promise<void>) | undefined;
  try {
    detach = persistSession(session).detach;
  } catch {
    // In-memory only; the run continues without a transcript.
  }

  return {
    session,
    resumed,
    close: async () => {
      if (detach) await detach();
    },
  };
}

/**
 * Seed a fresh session with history carried over from the legacy transcript
 * format, so `--continue` and `--resume` against a pre-log session do not start
 * the model with an empty context.
 *
 * The seeded messages are real `user/message` and `assistant/message` events,
 * so from the first new turn onward the log behaves exactly like one that was
 * always event-based. Tool detail is not recoverable from the legacy format —
 * it was never stored — and that loss is one-time, not ongoing.
 *
 * @param session - the (empty) session to seed.
 * @param history - legacy `{role, content}` pairs.
 */
export function seedFromLegacyHistory(
  session: Session,
  history: Array<{ role: string; content: string }>,
): void {
  if (session.length > 0 || history.length === 0) return;
  for (const message of history) {
    if (message.role === 'assistant') {
      session.append('assistant/message', {
        turn: 0,
        step: 0,
        content: message.content,
      }, { surfaceOp: { op: 'append' } });
    } else {
      session.append('user/message', {
        turn: 0,
        content: message.content,
        source: { kind: 'human' },
      }, { surfaceOp: { op: 'append' } });
    }
  }
}
