/**
 * A streamed response that goes silent has no error to catch and no close
 * event to react to — the socket just sits open. Observed live: a DeepSeek
 * call sat idle for over 40 minutes at ~0% CPU, and the turn's own "steer"
 * recovery could not reach it, because there is no next model call for a
 * steer to attach to until the stuck one finishes. Every provider reads its
 * stream with its own `for await` loop; this is the one place that guards
 * all of them against the same failure instead of five separate ad hoc ones.
 *
 * @module providers/idle-timeout
 */

/** Generous on purpose: a reasoning model can think for a long time between
 * chunks. This is a guard against silence, not a latency budget. */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * A fresh controller that aborts itself when `signal` does.
 *
 * Each provider needs a controller of its own to abort on an idle timeout
 * without also aborting the caller's signal (which is a two-way street the
 * caller does not expect); this keeps that one-way relationship in one place.
 */
export function chainAbort(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller;
}

/**
 * Wrap a stream so it fails after `ms` with no new chunk, instead of hanging.
 *
 * `abort` tears down the underlying request on timeout, so the connection
 * does not leak even though nothing is reading from it any more.
 */
export async function* withIdleTimeout<T>(
  stream: AsyncIterable<T>,
  abort: () => void,
  ms = STREAM_IDLE_TIMEOUT_MS,
): AsyncGenerator<T, void, undefined> {
  const it = stream[Symbol.asyncIterator]();
  while (true) {
    let timer!: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort();
        reject(new Error(`No data from the model for ${Math.round(ms / 1000)}s — the connection stalled.`));
      }, ms);
    });
    let result: IteratorResult<T>;
    try {
      result = await Promise.race([it.next(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
    if (result.done) return;
    yield result.value;
  }
}
