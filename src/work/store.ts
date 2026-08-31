/**
 * Where the ledger lives on disk.
 *
 * `~/.aico/work.jsonl`, append-only, replayed on boot — the same discipline the
 * session log already uses, for the same reason: a file you only ever append to
 * cannot be corrupted by a crash halfway through a write, and replaying it
 * reconstructs exactly what was true rather than what something remembered to
 * save.
 *
 * **Global, not per-project.** Sessions are per working directory because a
 * conversation belongs to a repository. Processes do not: a pid is a fact about
 * the machine, and a Mini App server started from one project is still holding
 * a port when you open another. Splitting this per-directory would mean a
 * restart in the wrong folder could not see — or reap — what the last one left.
 *
 * @module work/store
 */

import fs from 'fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { WorkEvent, WorkRecord } from './types.js';
import { isTerminal } from './types.js';

const LF = '\n';

/** Overridable so tests get a real file without touching the user's ledger. */
let storePath = path.join(os.homedir(), '.aico', 'work.jsonl');

export function workStorePath(): string {
  return storePath;
}

/** Point the ledger at another file. Tests only — the daemon uses the default. */
export function setWorkStorePath(next: string): void {
  storePath = next;
}

/**
 * How many terminal records to keep when compacting.
 *
 * Finished work is still worth having: "what did the 3am cron job do last
 * night" is a real question, and a ledger that forgets the moment something
 * ends can only answer it for work that is still running. But it is not worth
 * unbounded growth, so the tail is kept and the rest goes.
 */
const KEEP_TERMINAL = 200;

/** Compact once the log is this many lines longer than the live set. */
const COMPACT_SLACK = 500;

/** Append one event. Failures are swallowed: the ledger must not break a run. */
export async function appendWorkEvent(event: WorkEvent): Promise<void> {
  // Captured before the first await, not read after it. Every append is
  // fire-and-forget, so several can be in flight at once; reading the module
  // variable at flush time would let a path change land earlier writes in the
  // wrong file. In production the path never moves and this costs nothing —
  // but "usually there is only one" is exactly the assumption that makes a
  // race take a year to show up.
  const target = storePath;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(target, JSON.stringify(event) + LF, 'utf8');
  } catch {
    // A ledger that cannot write is a degraded ledger, not a failed run. The
    // in-memory index is still correct for this process; only restart recovery
    // is lost, and taking the user's work down to report that would be worse.
  }
}

/**
 * Replay the log into records.
 *
 * A malformed line is skipped rather than fatal. The file is appended to by a
 * process that can be killed mid-write, so a truncated last line is an expected
 * state, not a corruption to refuse to start over.
 */
export async function readWorkLog(): Promise<{ records: WorkRecord[]; lines: number }> {
  let raw: string;
  try {
    raw = await readFile(storePath, 'utf8');
  } catch {
    return { records: [], lines: 0 };
  }

  const byId = new Map<string, WorkRecord>();
  let lines = 0;
  for (const line of raw.split(LF)) {
    if (!line.trim()) continue;
    lines++;
    let event: WorkEvent;
    try {
      event = JSON.parse(line) as WorkEvent;
    } catch {
      continue;
    }
    if (event.t === 'add') {
      byId.set(event.record.id, event.record);
    } else if (event.t === 'patch') {
      const existing = byId.get(event.id);
      // A patch with no add before it is a log that was compacted between the
      // two. Dropping it is right: the record it belonged to is deliberately
      // gone, and inventing a partial one would report work that never ran.
      if (existing) Object.assign(existing, event.patch);
    } else if (event.t === 'drop') {
      byId.delete(event.id);
    }
  }
  return { records: [...byId.values()], lines };
}

/**
 * Rewrite the log as one `add` per surviving record.
 *
 * Written to a sibling and renamed, so a crash during compaction leaves the
 * original intact rather than a half-written replacement. The alternative —
 * truncating in place — has a window where the ledger is empty, and that window
 * is exactly when a crash costs the most.
 */
export async function compactWorkLog(records: WorkRecord[]): Promise<void> {
  const live = records.filter(r => !isTerminal(r.state));
  const finished = records
    .filter(r => isTerminal(r.state))
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
    .slice(-KEEP_TERMINAL);

  const keep = [...live, ...finished];
  const body = keep
    .map(record => JSON.stringify({ t: 'add', at: Date.now(), record } satisfies WorkEvent))
    .join(LF);

  const target = storePath;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.compact`;
    await writeFile(temp, keep.length ? body + LF : '', 'utf8');
    await rename(temp, target);
  } catch {
    // Same reasoning as the append path: a failed tidy-up is not a failed run.
  }
}

/** Whether the log has drifted far enough from the live set to be worth rewriting. */
export function shouldCompact(lines: number, recordCount: number): boolean {
  return lines > recordCount + COMPACT_SLACK;
}

/**
 * Is this pid alive?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `EPERM` means the process exists and is not ours — still alive, so
 * still running as far as the ledger is concerned.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether the store file currently exists — used by the boot path's logging. */
export function workStoreExists(): boolean {
  return fs.existsSync(storePath);
}
