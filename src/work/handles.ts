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
 * Stop one piece of work, recording *why* before it can be recorded otherwise.
 *
 * The ordering here is the whole point, and it was wrong once. Stopping a
 * background agent flips its own registry to `cancelled` with its own message
 * ("Cancelled by user"), which the ledger mirror writes to the record on the
 * very next emit — synchronously, inside the stop call. A caller that stopped
 * first and recorded its reason second found the record already terminal and
 * its reason silently dropped. The supervisor's reason, and every reason typed
 * into `Supervise stop`, was being replaced by a generic one.
 *
 * So: take the handle, let the caller write the outcome, *then* stop. `close`
 * clears the handle, which is why it has to be taken rather than read.
 *
 * Returns false when there is nothing to stop — already finished, never
 * registered, or a stale id from a previous process. Callers report that
 * difference rather than claiming a kill they did not make: "stopped 3 agents"
 * when two had already exited is a report that makes the next decision wrong.
 */
export async function stopWork(
  id: string,
  mode: StopMode,
  reason: string,
  recordOutcome: () => void,
): Promise<boolean> {
  const handle = handles.get(id);
  handles.delete(id);
  recordOutcome();
  if (!handle) return false;
  try {
    await handle(mode, reason);
  } catch {
    // A handle that throws has still been asked. Reporting failure would send a
    // supervisor round a retry loop against something already on its way down.
  }
  return true;
}

/**
 * Stop without recording an outcome first.
 *
 * For callers that are not writing to the ledger themselves. Prefer
 * {@link stopWork} — this leaves whatever the stopped subsystem says about
 * itself as the recorded reason.
 */
export async function invokeStop(id: string, mode: StopMode, reason: string): Promise<boolean> {
  return stopWork(id, mode, reason, () => { /* caller records nothing */ });
}

/** Tests only. */
export function resetStopHandlesForTest(): void {
  handles.clear();
}
