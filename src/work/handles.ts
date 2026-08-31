/**
 * How to stop each running thing, by id.
 *
 * Kept out of the record for the reason `tools/task.ts` already separates its
 * `_stops` map: a record is data. It is appended to a log, serialised into
 * events and sent to a browser. A function is none of those things, and putting
 * one on the record would mean either it cannot be persisted or it is silently
 * dropped when it is — the second being the kind of bug that only shows up when
 * something needs killing.
 *
 * Each kind stops differently. A sub-agent aborts at a step boundary; a process
 * takes a signal; a watcher just disarms. The ledger does not need to know any
 * of that — it needs one function per id, supplied by whoever started the work.
 *
 * @module work/handles
 */

/** `stop` asks; `kill` does not. See {@link SupervisionPolicy.onBreach}. */
export type StopMode = 'stop' | 'kill';

export type StopHandle = (mode: StopMode, reason: string) => void | Promise<void>;

const handles = new Map<string, StopHandle>();

/** Say how to stop this work. Called by whoever opened the ledger record. */
export function registerStopHandle(id: string, handle: StopHandle): void {
  handles.set(id, handle);
}

/** Forget how to stop it, because it has ended. */
export function clearStopHandle(id: string): void {
  handles.delete(id);
}

export function hasStopHandle(id: string): boolean {
  return handles.has(id);
}

/**
 * Try to stop one piece of work.
 *
 * Returns false when there is nothing to stop — already finished, never
 * registered, or a stale id from a previous process. Callers report that
 * difference rather than claiming a kill they did not make, because "stopped 3
 * agents" when two of them had already exited is a report that makes the next
 * decision wrong.
 */
export async function invokeStop(id: string, mode: StopMode, reason: string): Promise<boolean> {
  const handle = handles.get(id);
  if (!handle) return false;
  try {
    await handle(mode, reason);
    return true;
  } catch {
    // A handle that throws has still been asked. Reporting failure here would
    // send a supervisor round a retry loop against something that may well be
    // on its way down.
    return true;
  }
}

/** Tests only. */
export function resetStopHandlesForTest(): void {
  handles.clear();
}
