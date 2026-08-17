/**
 * Per-step tool-call scheduler.
 *
 * The agent loop used to execute a step's tool calls in a plain `for` loop, one
 * at a time. Five `Read` calls in one step meant five sequential round trips,
 * and the `Task` tool's own description — "Multiple Task calls in the same
 * response run in PARALLEL automatically" — was simply untrue.
 *
 * This schedules them properly, under four rules:
 *
 *  1. **Exclusive calls are barriers.** A tool that is not concurrency-safe
 *     (`Bash`, `Write`, `Edit`) runs alone, with nothing else in flight.
 *
 *  2. **Parallel-safe calls share a bounded rolling pool.** Up to
 *     `maxParallel` at once, refilled as each settles — not a fixed batch, so
 *     one slow call does not idle the whole pool behind it.
 *
 *  3. **Results commit in MODEL order.** Dispatch may finish out of order, but
 *     `tool/result` events are appended only across contiguous settled slots.
 *     The model sees its results in the order it asked for them regardless of
 *     which finished first, so a step is reproducible on replay.
 *
 *  4. **Execution mode is re-read per call.** A registry change mid-group (a
 *     tool re-registered as exclusive) creates a barrier for the calls that
 *     have not started yet, rather than being ignored until the next step.
 *
 * ## Cancellation
 *
 * Abort stops replenishment, drains what already started, and commits those
 * results. Every call that never started gets a synthetic call/result pair
 * recorded, because a model turn whose assistant message requested five tools
 * and whose log contains three results is one providers reject outright. A
 * cancelled step must still leave a replay-valid log.
 *
 * @module tools/scheduler
 */

import type { AdditionalContext } from './pipeline.js';

/** Whether a call may overlap with others. */
export type ExecutionMode = 'parallel' | 'exclusive';

/** Default pool width. Tuned for file reads, which dominate real steps. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 8;

/** One tool call to schedule. */
export interface ScheduledCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** What a dispatch produced. */
export interface DispatchOutcome {
  result: unknown;
  isError: boolean;
  additionalContexts?: AdditionalContext[];
}

export interface SchedulerOptions<C extends ScheduledCall> {
  /** Maximum parallel-safe calls in flight. `1` is fully serial. */
  maxParallel: number;
  /** Live classification. Re-read per call, never cached across a group. */
  executionMode: (call: C) => ExecutionMode;
  /** Run one call. Must not reject; a throw is recorded as an error result. */
  dispatch: (call: C) => Promise<DispatchOutcome>;
  /** Called when a call is dispatched, in model order. Record `tool/call` here. */
  onStart: (call: C) => void;
  /** Called in MODEL order as results become committable. Record `tool/result`. */
  onCommit: (call: C, outcome: DispatchOutcome) => void;
  /** Called for a call cancelled before dispatch. Record a synthetic pair. */
  onSkipped: (call: C) => void;
  /** Cancellation for the step. */
  signal?: AbortSignal;
}

export interface SchedulerResult {
  /** True when the step was cancelled before every call completed. */
  aborted: boolean;
  /** Context contributed by post-execute stages, in commit order. */
  additionalContexts: AdditionalContext[];
  /** Calls that reached dispatch. */
  started: number;
  /** Calls whose results were committed. */
  committed: number;
}

/** Outcome of one barrier or pool. */
interface GroupOutcome {
  consumed: number;
  aborted: boolean;
}

/** A settled dispatch awaiting its turn in model order. */
interface Slot {
  outcome: DispatchOutcome;
}

/**
 * Normalize and validate the configured pool width.
 *
 * Fails loud rather than silently clamping: a `maxParallelToolCalls` of `0`
 * that quietly became `1` would look like it worked while doing something the
 * user did not ask for.
 */
export function resolveMaxParallel(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`maxParallelToolCalls must be an integer >= 1 (got ${JSON.stringify(value)})`);
  }
  return resolved;
}

/**
 * Schedule one step's tool calls.
 *
 * Never rejects: a dispatch that throws becomes an error result for that call,
 * matching the loop's previous behaviour, because the model must receive a
 * result for every call it made.
 */
export async function scheduleToolCalls<C extends ScheduledCall>(
  calls: readonly C[],
  opts: SchedulerOptions<C>,
): Promise<SchedulerResult> {
  const additionalContexts: AdditionalContext[] = [];
  let started = 0;
  let committed = 0;
  let next = 0;

  while (next < calls.length) {
    // Classify the head of the remaining calls. An exclusive head is its own
    // group; a parallel head opens a pool over everything that follows, which
    // `fillPool` will cut short if a later call reclassifies.
    const head = calls[next];
    const mode = opts.executionMode(head);
    const group = mode === 'parallel' ? calls.slice(next) : [head];

    const outcome = await runGroup(group, mode, opts, additionalContexts, (delta) => {
      started += delta.started;
      committed += delta.committed;
    });

    next += outcome.consumed;

    if (outcome.aborted) {
      // Everything after this group never had a chance to run.
      for (const call of calls.slice(next)) opts.onSkipped(call);
      return { aborted: true, additionalContexts, started, committed };
    }
  }

  return { aborted: false, additionalContexts, started, committed };
}

/** Run one exclusive barrier or one bounded parallel pool. */
async function runGroup<C extends ScheduledCall>(
  group: readonly C[],
  mode: ExecutionMode,
  opts: SchedulerOptions<C>,
  additionalContexts: AdditionalContext[],
  report: (delta: { started: number; committed: number }) => void,
): Promise<GroupOutcome> {
  const { maxParallel, signal } = opts;
  const slots: Array<Slot | undefined> = group.map(() => undefined);
  const inFlight = new Map<number, Promise<number>>();

  let nextToStart = 0;
  let started = 0;
  let committed = 0;
  let aborted = signal?.aborted ?? false;

  /**
   * Advance the commit cursor across contiguous settled slots.
   *
   * The contiguity requirement is what preserves model order: slot 3 settling
   * first does not let it commit ahead of slots 0-2, so the recorded results
   * always read in the order the model requested them.
   */
  const commitReady = (): void => {
    while (committed < group.length) {
      const slot = slots[committed];
      if (slot === undefined) break;
      const call = group[committed];
      opts.onCommit(call, slot.outcome);
      if (slot.outcome.additionalContexts?.length) {
        additionalContexts.push(...slot.outcome.additionalContexts);
      }
      committed++;
      report({ started: 0, committed: 1 });
    }
  };

  const startCall = (index: number): void => {
    const call = group[index];
    // Logged at dispatch, not at commit, so a process killed mid-tool still
    // leaves evidence the call was attempted. Derivation repairs the missing
    // result rather than leaving the log unresumable.
    opts.onStart(call);
    started++;
    report({ started: 1, committed: 0 });
    const promise = opts.dispatch(call).then(
      (outcome) => {
        slots[index] = { outcome };
        return index;
      },
      (err: unknown) => {
        // The pipeline normalizes its own failures, so reaching here means a
        // handler outside it threw. Record an error result: the model is owed
        // one result per call it made, whatever went wrong.
        slots[index] = {
          outcome: {
            result: { error: err instanceof Error ? err.message : String(err) },
            isError: true,
          },
        };
        return index;
      },
    );
    inFlight.set(index, promise);
  };

  const fillPool = (): void => {
    while (!aborted && nextToStart < group.length && inFlight.size < maxParallel) {
      // Re-read the mode of each later call before starting it. A tool that
      // became exclusive since the group opened must not join the pool — it
      // ends the group and becomes the next barrier.
      if (nextToStart > 0 && mode === 'parallel'
        && opts.executionMode(group[nextToStart]) !== 'parallel') {
        break;
      }
      startCall(nextToStart);
      nextToStart++;
      if (signal?.aborted) aborted = true;
    }
  };

  fillPool();
  while (inFlight.size > 0) {
    const settledIndex = await Promise.race(inFlight.values());
    inFlight.delete(settledIndex);
    commitReady();
    // Abort can arrive while a tool or an ordered commit is awaiting.
    if (signal?.aborted) aborted = true;
    fillPool();
  }
  commitReady();

  if (aborted) {
    // Started calls have settled and committed above; every call in this group
    // that never started still needs a recorded outcome so the log stays
    // replay-valid.
    for (const call of group.slice(started)) opts.onSkipped(call);
    return { consumed: group.length, aborted: true };
  }

  // `started` rather than `group.length`: a parallel group cut short by
  // reclassification consumed only the calls it actually ran, and the caller
  // resumes at the reclassified one.
  return { consumed: started, aborted: false };
}
