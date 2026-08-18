/**
 * No tool call runs forever.
 *
 * A dev server started in the foreground held a turn for 139 minutes, 138 of
 * them with no output, until it was killed by hand. That was fixed where it
 * happened — `Bash` now caps its own runtime and backgrounds servers — but the
 * fix was for one tool, and the fault was never really about `Bash`.
 *
 * Every other tool could do the same thing and nothing would stop it. A browser
 * that never finishes launching, an MCP server that accepts a request and goes
 * quiet, a fetch to a host that blackholes packets, a sub-agent stuck in its
 * own loop: each of these is one unresolved promise, and one unresolved promise
 * anywhere in the dispatch path is a turn that never ends. The loop is waiting
 * on the tool, the user is waiting on the loop, and nothing in between is
 * capable of noticing.
 *
 * So the backstop lives at the dispatch chokepoint, where it covers tools that
 * do not exist yet as well as the ones that do.
 *
 * **A backstop, not a policy.** Each limit is set well above what the tool
 * legitimately needs, because a timeout that fires during normal work is worse
 * than none — it turns a slow success into a failure and teaches everyone to
 * raise it until it stops mattering. `Bash` keeps its own shorter, sharper
 * limit: it can kill a process tree, which this cannot.
 *
 * **Timing out is not cancelling.** This stops the *waiting*; it cannot reach
 * inside a tool and stop the work. The abort signal is what does that, and it
 * is fired first for exactly that reason. The message says so plainly rather
 * than implying a clean stop that did not happen.
 *
 * @module tools/timeout-policy
 */

/** Where a tool without an entry below lands. Generous: this is a backstop. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Per-tool ceilings, in milliseconds.
 *
 * Chosen from what the slowest legitimate call looks like, then given room.
 * Anything absent gets {@link DEFAULT_TIMEOUT_MS}.
 */
const TIMEOUTS: Record<string, number> = {
  // Manages its own deadline, kills its own process tree, and can hand a server
  // back to the caller still running. A second, blunter timer over the top of
  // that would only fire when the precise one had already failed — so this sits
  // just past Bash's own 30-minute ceiling and never in front of it.
  Bash: 31 * 60 * 1000,

  // Launches a browser and waits for a page to settle. Slow on a cold start,
  // and a page that never fires `load` is exactly what it exists to catch.
  VerifyApp: 3 * 60 * 1000,

  // Another agent's whole turn. Long, because the work is real; bounded,
  // because a child stuck in its own loop must not take the parent with it.
  Task: 20 * 60 * 1000,
  Agent: 20 * 60 * 1000,

  // Network, and someone else's server.
  WebFetch: 90 * 1000,
  WebSearch: 90 * 1000,

  // Local and fast. A minute here means something is wrong, not slow.
  Read: 60 * 1000,
  Write: 60 * 1000,
  Edit: 60 * 1000,
  Glob: 60 * 1000,
  Grep: 2 * 60 * 1000,
  LS: 60 * 1000,

  // Waiting on a person, who is entitled to take their time.
  AskUserQuestion: 60 * 60 * 1000,
};

/** MCP tools are somebody else's process; they get the default, not a guess. */
export function timeoutFor(toolName: string): number {
  return TIMEOUTS[toolName] ?? DEFAULT_TIMEOUT_MS;
}

/** How a timeout reads to the model that has to act on it. */
export function timeoutMessage(toolName: string, ms: number): string {
  const minutes = ms / 60_000;
  const howLong = minutes >= 1
    ? `${minutes % 1 === 0 ? minutes : minutes.toFixed(1)} minutes`
    : `${Math.round(ms / 1000)} seconds`;
  return `${toolName} did not return within ${howLong} and was abandoned. `
    + `The work may still be running — this stopped waiting for it, which is not the same `
    + `as stopping it. Do not simply retry the identical call; find out why it hung, or `
    + `take a different route to the same goal.`;
}

export class ToolTimeoutError extends Error {
  constructor(public readonly toolName: string, public readonly ms: number) {
    super(timeoutMessage(toolName, ms));
    this.name = 'ToolTimeoutError';
  }
}

/**
 * Run a tool call, and give up waiting if it never comes back.
 *
 * The abort signal fires before the rejection so a tool that honours
 * cancellation gets the chance to stop cleanly, rather than being orphaned
 * while its promise is dropped on the floor.
 */
export async function withTimeout<T>(
  toolName: string,
  run: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
  overrideMs?: number,
): Promise<T> {
  const ms = overrideMs ?? timeoutFor(toolName);
  const controller = new AbortController();

  // The caller's Stop and this deadline want the same thing, so they share one
  // signal — a tool only has to understand cancellation, not who ordered it.
  const forwardAbort = (): void => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ToolTimeoutError(toolName, ms));
      }, ms);
      // Unref'd so a pending backstop cannot by itself hold the process open;
      // the promise is what the caller is waiting on, not the timer.
      timer.unref?.();

      run(controller.signal).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    outerSignal?.removeEventListener('abort', forwardAbort);
  }
}
