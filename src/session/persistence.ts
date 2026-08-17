/**
 * Durable storage for session event logs.
 *
 * The log is written as append-only JSONL — one event per line — because that
 * is the only format whose write path matches the data structure's semantics.
 * A rewrite-the-whole-file approach (what `history.ts` does for the legacy
 * message format) turns every append into an O(n) write and loses data if the
 * process dies mid-write.
 *
 * Files live beside the legacy transcripts, under a distinct extension, so a
 * project can hold both formats during migration and neither reader is confused
 * by the other's files.
 *
 *   ~/.aico/projects/<cwd-hash>/sessions/<id>.jsonl         legacy messages
 *   ~/.aico/projects/<cwd-hash>/sessions/<id>.events.jsonl  event log
 *
 * @module session/persistence
 */

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import path from 'path';
import { getSessionDir } from '../history.js';
import { Session, type SessionHeader } from './session.js';
import type { SessionEvent } from './events.js';

/** Current on-disk format version, recorded in the header line. */
export const EVENT_LOG_VERSION = 1;

/** First line of every event-log file. */
interface EventLogHeaderLine {
  type: '__header__';
  version: number;
  id: string;
  cwd: string;
  startedAt: number;
  name?: string;
}

/** Absolute path of a session's event log. */
export function eventLogPath(sessionId: string, cwd: string): string {
  return path.join(getSessionDir(cwd), `${sessionId}.events.jsonl`);
}

/**
 * Create the log file and write its header line.
 * Safe to call for a session that already exists — the header is only written
 * when the file is new, so an accidental re-init cannot truncate history.
 */
export async function initEventLog(header: SessionHeader): Promise<void> {
  const dir = getSessionDir(header.cwd);
  await mkdir(dir, { recursive: true });
  const filePath = eventLogPath(header.id, header.cwd);
  try {
    await readFile(filePath, 'utf8');
    return; // already initialized
  } catch {
    // fall through to create
  }
  const headerLine: EventLogHeaderLine = {
    type: '__header__',
    version: EVENT_LOG_VERSION,
    id: header.id,
    cwd: header.cwd,
    startedAt: header.startedAt,
    ...(header.name ? { name: header.name } : {}),
  };
  // 'wx' fails if another process won the race to create it; that process
  // wrote an equivalent header, so losing the race is success.
  await writeFile(filePath, JSON.stringify(headerLine) + '\n', { flag: 'wx' }).catch(() => undefined);
}

/**
 * Attach a session to durable storage.
 *
 * Appends are serialized through a promise chain so two events appended in the
 * same tick cannot interleave their writes and corrupt a line. Write failures
 * are reported once and then suppressed — losing the transcript must not take
 * down a running agent, but silently losing it forever is worse.
 *
 * @returns an unsubscribe function that also flushes pending writes.
 */
export function persistSession(session: Session): { detach: () => Promise<void> } {
  const filePath = eventLogPath(session.header.id, session.header.cwd);
  let chain: Promise<void> = Promise.resolve();
  let reportedFailure = false;

  const unsubscribe = session.subscribe((event) => {
    chain = chain.then(async () => {
      try {
        await appendFile(filePath, JSON.stringify(event) + '\n');
      } catch (err) {
        if (!reportedFailure) {
          reportedFailure = true;
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`  ⚠ session log write failed (${reason}); transcript will be incomplete`);
        }
      }
    });
  });

  return {
    detach: async () => {
      unsubscribe();
      await chain;
    },
  };
}

/**
 * Load a persisted event log.
 *
 * Corrupt lines are skipped rather than aborting the load: a log truncated by a
 * kill -9 is still worth resuming, and derivation repairs the resulting
 * dangling tool call. The count of skipped lines is reported so the damage is
 * visible rather than silent.
 *
 * @returns the rehydrated session, or `null` when no log exists.
 */
export async function loadEventLog(sessionId: string, cwd: string): Promise<Session | null> {
  const filePath = eventLogPath(sessionId, cwd);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split('\n').filter(line => line.trim() !== '');
  if (lines.length === 0) return null;

  let header: SessionHeader | undefined;
  const events: SessionEvent[] = [];
  let skipped = 0;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === '__header__') {
      const head = record as unknown as EventLogHeaderLine;
      header = {
        id: head.id,
        cwd: head.cwd,
        startedAt: head.startedAt,
        ...(head.name ? { name: head.name } : {}),
      };
      continue;
    }
    if (typeof record.seq !== 'number' || typeof record.type !== 'string') {
      skipped++;
      continue;
    }
    events.push(record as unknown as SessionEvent);
  }

  if (skipped > 0) {
    console.warn(`  ⚠ session ${sessionId}: ${skipped} corrupt event line(s) skipped`);
  }

  const session = new Session(header ?? { id: sessionId, cwd, startedAt: Date.now() });
  // Restore in seq order regardless of file order, so a log concatenated out of
  // order (or repaired by hand) still projects correctly.
  events.sort((a, b) => a.seq - b.seq);
  for (const event of events) session.restore(event);
  return session;
}

/** List session IDs that have an event log in this project. */
export async function listEventLogs(cwd: string): Promise<string[]> {
  try {
    const files = await readdir(getSessionDir(cwd));
    return files
      .filter(f => f.endsWith('.events.jsonl'))
      .map(f => f.replace('.events.jsonl', ''));
  } catch {
    return [];
  }
}

/** Line separator, tolerating CRLF logs written on Windows. */
const NEWLINE = new RegExp('\\r?\\n');

/** What the sidebar needs about a session it is not currently showing. */
export interface SessionSummary {
  id: string;
  /** Display name, when the session has been named. */
  title?: string;
  /** How the name was decided, so a UI can mark a provisional one. */
  titleSource?: 'fallback' | 'model' | 'user';
  /**
   * Timestamp of the session's last *event*, for recency ordering.
   *
   * Deliberately not the file's mtime. Merely opening a session can touch the
   * file, and ordering by mtime made the list reshuffle every time one was
   * clicked — the session you opened jumped to the top, then the next one did.
   * A session's position should reflect when work last happened in it, which
   * only its events know.
   */
  updatedAt: number;
  /** Number of user turns, for the sidebar to show substance over noise. */
  turns: number;
}

/**
 * Summaries for every session in this project, most recently touched first.
 *
 * Titles are extracted by scanning each log for its last `session/title` line
 * rather than by loading and projecting the session. A sidebar listing fifty
 * conversations must not replay fifty event logs to find fifty short strings —
 * and the scan is a plain substring test before any JSON parsing, so lines that
 * cannot be titles cost almost nothing.
 */
export async function listSessionSummaries(cwd: string): Promise<SessionSummary[]> {
  const dir = getSessionDir(cwd);
  let files: string[];
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.events.jsonl'));
  } catch {
    return [];
  }

  const summaries = await Promise.all(files.map(async (file): Promise<SessionSummary> => {
    const id = file.replace('.events.jsonl', '');
    const full = path.join(dir, file);

    let title: string | undefined;
    let titleSource: SessionSummary['titleSource'];
    let updatedAt = 0;
    let turns = 0;

    try {
      const text = await readFile(full, 'utf8');
      for (const line of text.split(NEWLINE)) {
        if (!line) continue;
        // Cheap rejects first: most lines in a busy log are chunks and results,
        // and none of them need parsing to be skipped.
        const isTitle = line.includes('"session/title"');
        const isUser = line.includes('"user/message"');
        const hasStamp = line.includes('"timestamp"');
        if (!isTitle && !isUser && !hasStamp) continue;
        try {
          const event = JSON.parse(line) as {
            type?: string; timestamp?: number; data?: { title?: string; source?: string };
          };
          if (typeof event.timestamp === 'number' && event.timestamp > updatedAt) {
            updatedAt = event.timestamp;
          }
          if (event.type === 'user/message') turns++;
          if (event.type === 'session/title' && event.data?.title) {
            // Later lines win: the log records the title's whole history, and
            // the current name is simply the last decision in it.
            title = event.data.title;
            titleSource = event.data.source as SessionSummary['titleSource'];
          }
        } catch { /* a torn line is not a reason to lose the whole listing */ }
      }
    } catch { /* unreadable: still list the session, just unnamed */ }

    // A log with no timestamped events at all still needs an order; the file's
    // own mtime is the only remaining signal.
    if (updatedAt === 0) {
      try { updatedAt = (await stat(full)).mtimeMs; } catch { /* listed but gone */ }
    }

    return {
      id,
      updatedAt,
      turns,
      ...(title ? { title } : {}),
      ...(titleSource ? { titleSource } : {}),
    };
  }));

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}
