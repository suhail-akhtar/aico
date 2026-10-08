/**
 * Undo for an agent's file changes.
 *
 * The session log replays the *conversation*. Nothing replayed the *working
 * tree* — so an agent that degraded a file over twenty steps left no way back
 * except reading the transcript and reversing it by hand. That absence is not
 * only a recovery problem: it is why letting a run go unattended feels
 * reckless. You allow more autonomy when you can take it back.
 *
 * ## What is recorded
 *
 * The prior contents of files the agent itself modifies, captured the first
 * time each is touched. First touch and not every touch: the point of restore
 * is to reach the state before the work started, and a file edited nine times
 * has one interesting earlier version.
 *
 * Nothing else is copied. A snapshot of the whole project would be slow, large
 * and mostly irrelevant — the agent changed six files, and the other four
 * thousand are not part of the story.
 *
 * ## What makes restoring safe
 *
 * Overwriting someone's files is the most destructive thing in this codebase,
 * so restore is deliberately narrow: **a file is only put back if it is still
 * exactly as the agent left it.** If anything else has changed it since — the
 * person, their editor, another process — it is skipped and reported rather
 * than reverted. That single rule is what allows deleting agent-created files
 * too, which would otherwise be far too dangerous to do automatically.
 *
 * @module checkpoint
 */

import { readFile, writeFile, mkdir, rm, readdir } from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

/** One file as it was before the agent first touched it. */
interface Snapshot {
  /** Absolute path of the file. */
  file: string;
  /**
   * Contents before the first modification, or null if it did not exist.
   *
   * Null is what makes "the agent created this" expressible, and therefore
   * what lets restore remove it again.
   */
  before: string | null;
  /** Hash of what the agent last wrote, used to detect later outside edits. */
  after?: string;
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: number;
  files: Snapshot[];
}

export interface RestoreReport {
  restored: string[];
  removed: string[];
  /** Files left alone because something changed them after the agent did. */
  skipped: string[];
}

/** The open checkpoint, if a turn is recording. */
let active: Checkpoint | undefined;
/** Where checkpoints are written. Set per run. */
let storeDir: string | undefined;

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * Begin recording, replacing any open checkpoint.
 *
 * Called at the start of a turn. Recording is off until this runs, so a
 * process with no configured store simply captures nothing rather than
 * failing — checkpoints are a safety net, not a dependency.
 */
export function beginCheckpoint(label: string, directory: string): Checkpoint {
  storeDir = directory;
  active = {
    id: `cp-${Date.now().toString(36)}`,
    label: label.slice(0, 120),
    createdAt: Date.now(),
    files: [],
  };
  return active;
}

/**
 * Record a file's contents before it is modified.
 *
 * Called by the write tools before they write. Cheap and idempotent: the
 * second call for the same file in one checkpoint does nothing, which is what
 * keeps "before" meaning *before the turn* rather than before the last edit.
 */
export async function recordBeforeWrite(file: string): Promise<void> {
  if (!active) return;
  if (active.files.some(entry => entry.file === file)) return;
  try {
    const before = await readFile(file, 'utf8');
    active.files.push({ file, before });
  } catch {
    // Absent, or not text. Either way there is nothing to put back, and
    // recording it as created is what lets restore remove it again.
    active.files.push({ file, before: null });
  }
}

/**
 * What a file held before this turn first touched it: its text, `null` when the
 * turn created it, or `undefined` when it was not touched (or nothing is
 * recording). The test-tamper check compares against this (ADR 0033).
 */
export function recordedBefore(file: string): string | null | undefined {
  return active?.files.find(entry => entry.file === file)?.before;
}

/**
 * Note what the agent left behind, so later outside edits are detectable.
 *
 * Called after a write succeeds. Without it, restore could not tell an
 * untouched file from one the person has since edited, and would have to
 * either refuse everything or overwrite someone's work.
 */
export async function recordAfterWrite(file: string): Promise<void> {
  if (!active) return;
  const entry = active.files.find(candidate => candidate.file === file);
  if (!entry) return;
  try {
    entry.after = digest(await readFile(file, 'utf8'));
  } catch {
    delete entry.after;
  }
}

/** Persist the open checkpoint, if it recorded anything. Returns its id. */
export async function commitCheckpoint(): Promise<string | undefined> {
  if (!active || !storeDir || active.files.length === 0) {
    active = undefined;
    return undefined;
  }
  const checkpoint = active;
  active = undefined;
  try {
    await mkdir(storeDir, { recursive: true });
    await writeFile(
      path.join(storeDir, `${checkpoint.id}.json`),
      JSON.stringify(checkpoint),
      'utf8',
    );
    return checkpoint.id;
  } catch {
    return undefined;
  }
}

/** Every stored checkpoint, newest first. */
export async function listCheckpoints(directory: string): Promise<Checkpoint[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const found: Checkpoint[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as Checkpoint;
      if (Array.isArray(parsed?.files)) found.push(parsed);
    } catch {
      // A corrupt checkpoint is skipped rather than failing the listing.
    }
  }
  return found.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Put the files back as they were.
 *
 * The rule that makes this safe enough to offer: a file is only touched if it
 * still matches what the agent last wrote. Anything changed since is skipped
 * and named, so a partial restore is visible rather than silent.
 */
export async function restoreCheckpoint(
  checkpoint: Checkpoint,
  options: { dryRun?: boolean } = {},
): Promise<RestoreReport> {
  const report: RestoreReport = { restored: [], removed: [], skipped: [] };

  for (const entry of checkpoint.files) {
    let current: string | null;
    try {
      current = await readFile(entry.file, 'utf8');
    } catch {
      current = null;
    }

    // Already back where it started — nothing to do, and reporting it as
    // restored would overstate what happened.
    if (current !== null && entry.before !== null && current === entry.before) continue;
    if (current === null && entry.before === null) continue;

    // Changed by someone other than the agent. Leaving it alone is the whole
    // safety property; without this check restore is an overwrite.
    if (entry.after !== undefined && current !== null && digest(current) !== entry.after) {
      report.skipped.push(entry.file);
      continue;
    }
    if (entry.after === undefined && current !== null) {
      report.skipped.push(entry.file);
      continue;
    }

    if (entry.before === null) {
      if (!options.dryRun) {
        try { await rm(entry.file, { force: true }); } catch { /* already gone */ }
      }
      report.removed.push(entry.file);
    } else {
      if (!options.dryRun) {
        try {
          await mkdir(path.dirname(entry.file), { recursive: true });
          await writeFile(entry.file, entry.before, 'utf8');
        } catch {
          report.skipped.push(entry.file);
          continue;
        }
      }
      report.restored.push(entry.file);
    }
  }

  return report;
}

/**
 * A checkpoint of its own for one bulk change, beside the turn's.
 *
 * A refactor apply (`refactor/plan`) rewrites tens or hundreds of files in one
 * call and may need to be undone on its own — the turn's checkpoint also holds
 * every edit made before it, and restoring that would throw the earlier work
 * away with the refactor. So the apply snapshots exactly the files it is about
 * to touch, in the same shape and under the same restore rule, and `seal`
 * records what it left so a later outside edit is still detected.
 */
export async function snapshotFiles(label: string, files: readonly string[]): Promise<Checkpoint> {
  const checkpoint: Checkpoint = {
    // `-r` so it cannot collide with a turn checkpoint opened in the same millisecond.
    id: `cp-${Date.now().toString(36)}-r`,
    label: label.slice(0, 120),
    createdAt: Date.now(),
    files: [],
  };
  for (const file of new Set(files)) {
    let before: string | null;
    try { before = await readFile(file, 'utf8'); } catch { before = null; }
    checkpoint.files.push({ file, before });
  }
  return checkpoint;
}

/** Record what the change left, file by file (see {@link recordAfterWrite}). */
export async function sealSnapshot(checkpoint: Checkpoint): Promise<void> {
  for (const entry of checkpoint.files) {
    try { entry.after = digest(await readFile(entry.file, 'utf8')); } catch { delete entry.after; }
  }
}

/** Persist a standalone checkpoint where the `Checkpoint` tool lists them. */
export async function storeCheckpoint(checkpoint: Checkpoint, directory: string): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${checkpoint.id}.json`), JSON.stringify(checkpoint), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** For tests, and for a process that should stop recording. */
export function resetCheckpoints(): void {
  active = undefined;
  storeDir = undefined;
}

/** Whether a turn is currently recording. */
export function isRecording(): boolean {
  return active !== undefined;
}
