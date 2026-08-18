/**
 * State that belongs to one run, not to the process.
 *
 * {@link ./run-context.ts} exists because this codebase is a server that owns
 * several runs at once, and answering "which directory" or "which session" from
 * a module-level variable is wrong the moment two of them overlap. Three
 * features added later — the verification gate, the requirements list, and the
 * read-before-edit record — each reintroduced exactly that mistake with a
 * module-level `let`.
 *
 * The symptoms are quiet and bad. Session A opens a turn, session B opens one a
 * second later and resets the shared record, and A's gate now believes nothing
 * was verified — or worse, believes B's passing verdict was its own. Nothing
 * throws; a check simply starts answering about the wrong work.
 *
 * So state is keyed by the run it belongs to, and this is the one place that
 * knows how. Written once because three call sites needed it, not because a
 * fourth might.
 *
 * **Runs with no session share one bucket.** The CLI is a single run in a
 * single process, so "no session id" is unambiguous there. It only stops being
 * unambiguous under a server, and under a server every run has an id.
 *
 * @module run-scoped
 */

import { currentRunContext } from './run-context.js';

/**
 * How many runs' worth of state to keep.
 *
 * State is cleared at the start of each turn, but a session that never returns
 * leaves its bucket behind. A server running for weeks would accumulate one per
 * session ever opened, so the oldest are dropped — losing state for a run that
 * has not been touched in hundreds of others costs nothing, because a turn
 * clears its own state before using it anyway.
 */
const MAX_BUCKETS = 256;

/** Which run this call belongs to. */
function currentKey(): string {
  return currentRunContext()?.sessionId ?? '__no_session__';
}

export interface RunScoped<T> {
  /** This run's state, created on first use. */
  get(): T;
  /** Replace this run's state with a fresh value. */
  reset(): void;
  /** Buckets currently held. Exposed for tests and for spotting a leak. */
  size(): number;
}

/**
 * Per-run state with a shared shape.
 *
 * `create` is called lazily, once per run, so a feature nobody used in this
 * turn costs nothing.
 */
export function runScoped<T>(create: () => T): RunScoped<T> {
  const buckets = new Map<string, T>();

  const evictIfNeeded = (): void => {
    if (buckets.size <= MAX_BUCKETS) return;
    // Insertion order is iteration order for a Map, so the first key is the
    // least recently created. Good enough: this is a bound, not a cache.
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  };

  return {
    get(): T {
      const key = currentKey();
      let value = buckets.get(key);
      if (value === undefined) {
        value = create();
        buckets.set(key, value);
        evictIfNeeded();
      }
      return value;
    },
    reset(): void {
      buckets.set(currentKey(), create());
      evictIfNeeded();
    },
    size: () => buckets.size,
  };
}
