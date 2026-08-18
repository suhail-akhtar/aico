/**
 * You may not edit what you have not looked at.
 *
 * This was a line in the system prompt — "always read a file before editing it
 * unless you just created it" — and a prompt rule is a request. It holds until
 * the model is confident, and a model editing from memory is confident by
 * definition: it is not guessing that the file says what it thinks, it has
 * stopped considering the question.
 *
 * The failure is quiet and expensive. An `Edit` whose `old_string` was
 * remembered rather than read either misses — a wasted step and a confusing
 * error — or, far worse, matches something that drifted since, and rewrites the
 * wrong line in a file nobody has looked at this session. A `Write` from memory
 * silently discards whatever else was in the file.
 *
 * So the rule moves out of the prompt and into the write path, where it is a
 * fact rather than a request.
 *
 * **Observation, not just reading.** A file this turn created is observed —
 * it wrote the contents, so it knows them. A file a `Glob` merely listed is
 * not: knowing a path exists says nothing about what is inside it.
 *
 * **Editing an unobserved file is refused; creating a new one is not.** The
 * danger is destroying something unseen, and a file that does not exist has
 * nothing to destroy. The refusal names the fix and costs one `Read`.
 *
 * **Observation expires when the file changes underneath.** A file read an hour
 * ago, then rewritten by a build, a formatter, or a `git checkout`, is a file
 * nobody has seen — and this is precisely when a remembered `old_string` finds
 * the wrong match. Freshness is by modification time rather than by clock.
 *
 * @module tools/observation
 */

import fs from 'fs';
import path from 'path';

/** What we knew about a file, and when. */
interface Observation {
  /** Modification time when it was observed. Staleness is measured against this. */
  mtimeMs: number;
}

const observed = new Map<string, Observation>();

/** One spelling of a path, so `./x`, `x` and an absolute path agree. */
function key(file: string): string {
  return path.resolve(file).toLowerCase();
}

/**
 * Record that the contents of this file are now known.
 *
 * Called after a read and after a write: writing a file is the most direct way
 * of knowing what is in it.
 */
export function observe(file: string): void {
  try {
    observed.set(key(file), { mtimeMs: fs.statSync(file).mtimeMs });
  } catch {
    // Gone, or unreadable. Nothing to remember, and no claim to make.
  }
}

/** Forget everything. Per-turn, like the rest of what a turn is allowed to assume. */
export function resetObservations(): void {
  observed.clear();
}

/**
 * Why this file may not be edited, or undefined if it may.
 *
 * The message is the whole value of this check. "Permission denied" would leave
 * the model to guess; naming the file, the reason, and the single call that
 * fixes it costs one step and no confusion.
 */
export function blockedReason(file: string, operation: 'edit' | 'overwrite'): string | undefined {
  let current: fs.Stats;
  try {
    current = fs.statSync(file);
  } catch {
    // It does not exist. Creating it destroys nothing.
    return undefined;
  }
  if (!current.isFile()) return undefined;

  const seen = observed.get(key(file));
  if (!seen) {
    return `${path.basename(file)} has not been read in this session, so its current contents `
      + `are unknown. ${operation === 'edit'
        ? 'An edit built from memory either fails to match or — worse — matches something that '
          + 'has drifted since, changing a line nobody has looked at.'
        : 'Writing it would discard whatever is in it now.'} `
      + `Read ${file} first, then repeat this call.`;
  }

  if (current.mtimeMs > seen.mtimeMs) {
    return `${path.basename(file)} has changed since it was read — a build, a formatter, a `
      + `checkout, or another process. What you are working from is a previous version, which `
      + `is exactly when a remembered match lands in the wrong place. Read ${file} again before `
      + `changing it.`;
  }

  return undefined;
}

/** Whether this file's contents are currently known. Exposed for tests. */
export function isObserved(file: string): boolean {
  return blockedReason(file, 'edit') === undefined;
}
