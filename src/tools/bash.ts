/**
 * Running a shell command.
 *
 * Spawned rather than `exec`ed, and that is the whole point of this file's
 * shape. `exec` buffers everything until the process exits, so a five-minute
 * `npm install` produced *nothing at all* on screen until it was over — no
 * output, no sign of life, no way to tell a slow install from a hung one. The
 * command's own progress is the only honest answer to "is this still working",
 * and it was being thrown away and then handed over all at once.
 *
 * Output now streams. A sink can subscribe to partial output while the command
 * runs; the final result is unchanged, so nothing downstream had to learn a new
 * shape.
 *
 * @module tools/bash
 */

import { spawn, execFile, execFileSync } from 'child_process';
import { currentCwd } from '../run-context.js';

export interface BashInput {
  command: string;
  timeout?: number;
  /**
   * Start it and return, instead of waiting for it to exit.
   *
   * Auto-detected for commands that are not supposed to exit — dev servers,
   * watchers — so this only has to be set when the detection is wrong.
   */
  background?: boolean;
  /** Passed from settings — default bash timeout in seconds (0 = no timeout) */
  _defaultTimeout?: number;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  /** Set when the command was left running. */
  background?: { pid: number; command: string };
}

/** Partial output from a command that is still running. */
export interface BashProgress {
  /** Everything printed so far, stdout and stderr interleaved as they arrived. */
  output: string;
  /** Milliseconds since the command started. */
  elapsedMs: number;
}

export type BashProgressSink = (progress: BashProgress) => void;

/**
 * Where partial output goes while a command runs.
 *
 * A module-level sink rather than a parameter because the tool signature is
 * fixed by the registry — every tool is `(input) => Promise<result>` — and
 * threading a callback through the whole dispatch path to reach one tool would
 * change every tool for the sake of this one.
 */
let progressSink: BashProgressSink | undefined;

export function setBashProgressSink(sink: BashProgressSink | undefined): void {
  progressSink = sink;
}

/** How long to wait for a killed process tree to actually exit. */
const KILL_GRACE_MS = 2000;

/**
 * The longest any foreground command may run, including `timeout: 0`.
 *
 * `timeout: 0` used to mean *forever*, and the tool description recommended it
 * for anything slow. A model starting a dev server reasoned exactly as told —
 * this is long-running, so disable the timeout — and the turn hung for 139
 * minutes, 138 of them with no output at all, until the user killed it by hand.
 *
 * "No timeout" is not a thing an agent should be able to ask for. Thirty
 * minutes is far past any real build and far short of a wasted afternoon.
 */
const MAX_FOREGROUND_MS = 30 * 60 * 1000;

/**
 * How long to watch a background command before reporting it started.
 *
 * Long enough for a server to bind its port and print where it is listening,
 * short enough not to feel like a hang. A command that dies inside this window
 * is reported as the failure it is — announcing "started in the background" for
 * a process that already crashed would be worse than the hang it replaced.
 */
const STARTUP_WINDOW_MS = 5000;

/**
 * Commands that are not supposed to exit.
 *
 * Running one of these in the foreground is always a mistake: the tool waits
 * for an exit that only a kill will produce. Detection is deliberately narrow —
 * a false positive backgrounds something the model wanted to wait for, which is
 * a worse failure than missing one — so it matches launchers by name rather
 * than guessing from shape.
 */
const SERVER_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch|preview)\b/, what: 'a dev server' },
  { re: /\b(?:vite|nodemon|webpack-dev-server|browser-sync)\b/, what: 'a dev server' },
  { re: /\b(?:next|nuxt|astro|remix|gatsby)\s+dev\b/, what: 'a dev server' },
  { re: /\bng\s+serve\b/, what: 'a dev server' },
  { re: /\bpython3?\s+-m\s+http\.server\b/, what: 'a static file server' },
  { re: /\b(?:http-server|serve|live-server)\b/, what: 'a static file server' },
  { re: /\bphp\s+-S\b/, what: 'a static file server' },
  { re: /\b(?:flask\s+run|uvicorn|gunicorn|daphne|hypercorn)\b/, what: 'an application server' },
  { re: /\brails\s+s(?:erver)?\b/, what: 'an application server' },
  { re: /\bnode\s+[^|&;]*\bserv(?:e|er)[\w.-]*\.(?:js|mjs|cjs|ts)\b/, what: 'a server script' },
  { re: /\bdocker(?:\s+compose|-compose)\s+up\b(?![^|&;]*\s-d\b)/, what: 'containers in the foreground' },
  { re: /--watch\b|\bwatch\s+-/, what: 'a watcher' },
  { re: /\btail\s+-[a-zA-Z]*f\b/, what: 'a log tail' },
];

/**
 * Tools whose *arguments* routinely contain the words above.
 *
 * `grep -r "npm run dev" src/` must not be mistaken for a dev server. This is
 * the narrow exclusion; an earlier version instead blanked every quoted string
 * before matching, which also blanked the quoted path in
 * `node "C:\\...\\server.js"` — the exact command that hung — and so defeated
 * the detection it was meant to protect.
 */
const TEXT_TOOLS = /^\s*(?:sudo\s+)?(?:grep|rg|ag|ack|find|echo|printf|cat|sed|awk|less|more|head|tail\s+(?!-[a-zA-Z]*f))\b/;

/**
 * Turn a requested timeout into the one that will actually be enforced.
 *
 * Separated out so the ceiling is testable: the alternative is a test that
 * waits half an hour to find out whether the limit exists, which is the same as
 * not testing it.
 */
export function resolveTimeout(rawTimeout: number): { requestedMs: number; timeoutMs: number } {
  const requestedMs = rawTimeout === 0 ? Infinity : rawTimeout * 1000;
  return { requestedMs, timeoutMs: Math.min(requestedMs, MAX_FOREGROUND_MS) };
}

/** What kind of never-exiting command this is, if it is one. */
export function looksLikeServer(command: string): string | undefined {
  // Each link in a chain is judged on its own: `cd x && npm run dev` is a
  // server, and `npm run build && echo done` is not.
  for (const part of command.split(/&&|\|\||;/)) {
    if (TEXT_TOOLS.test(part)) continue;
    for (const { re, what } of SERVER_PATTERNS) {
      if (re.test(part)) return what;
    }
  }
  return undefined;
}

/** Commands left running, so they can be listed and stopped. */
const running = new Map<number, { command: string; startedAt: number }>();

/** Everything still running in the background. */
export function backgroundProcesses(): { pid: number; command: string; startedAt: number }[] {
  return [...running.entries()].map(([pid, info]) => ({ pid, ...info }));
}

/**
 * Stop everything left running.
 *
 * Synchronous, and that is the whole point. `killTree` spawns `taskkill` and
 * does not wait for it; called from an `exit` handler — which cannot await
 * anything — the parent was gone before `taskkill` ever ran, and the server
 * survived it. Two runs of the test suite left two servers holding two ports,
 * which is precisely the leak this function exists to prevent.
 */
export function stopBackgroundProcesses(): void {
  for (const pid of running.keys()) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
      }
    } catch { /* already gone, which is the outcome we wanted */ }
  }
  running.clear();
}

let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', stopBackgroundProcesses);
}

/**
 * Stop a command and everything it started.
 *
 * `child.kill()` signals only the shell. On Windows that leaves the real work
 * — the compiler, the installer — running, and on POSIX the orphans keep the
 * pipes open so the parent never reports `close`.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // /T takes the tree, /F does not ask nicely. Failures are ignored: the
    // process may already be gone, which is the outcome we wanted.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => { /* best effort */ });
    return;
  }
  try {
    // Negative pid signals the process group created by `detached: true`.
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** How often partial output is reported, at most. */
const PROGRESS_INTERVAL_MS = 400;
/** Output kept in memory. Beyond this the head is dropped, not the tail. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export async function bash(input: BashInput, signal?: AbortSignal): Promise<BashResult> {
  // Priority: explicit timeout arg → settings default → 120s fallback.
  //
  // Zero, and anything past the ceiling, now mean the ceiling. The old reading
  // of zero as "no timeout" is what let a foreground server run for over two
  // hours: the model asked for unlimited because the description told it to,
  // and unlimited was taken literally.
  const rawTimeout = input.timeout ?? input._defaultTimeout ?? 120;
  const { requestedMs, timeoutMs } = resolveTimeout(rawTimeout);

  // Commands that never exit are started and reported, not waited on. The model
  // that ran `node server.js` in the foreground was not confused about what it
  // wanted — it wanted the server up so it could look at the page. Waiting for
  // a server to exit is the one thing that cannot lead there.
  const serverKind = looksLikeServer(input.command);
  const inBackground = input.background ?? serverKind !== undefined;

  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellFlag = process.platform === 'win32' ? '/d/s/c' : '-c';
  const startedAt = Date.now();

  return new Promise<BashResult>((resolve) => {
    const child = spawn(shell, [shellFlag, input.command], {
      cwd: currentCwd(),
      windowsVerbatimArguments: process.platform === 'win32',
      // Its own process group on POSIX, so a timeout can signal the whole tree
      // rather than just the shell. Without this a killed `sh -c` leaves its
      // children running and holding the pipes open.
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    // Interleaved, because a build's progress is the interleaving: stdout and
    // stderr separated into two blocks loses the order things happened in.
    let combined = '';
    let timedOut = false;
    let lastReport = 0;
    let pending = false;

    const report = (force = false): void => {
      if (!progressSink) return;
      const now = Date.now();
      if (!force && now - lastReport < PROGRESS_INTERVAL_MS) {
        // Coalesce: a noisy build emits thousands of writes a second, and one
        // event per write would flood the stream to no benefit.
        pending = true;
        return;
      }
      lastReport = now;
      pending = false;
      progressSink({ output: combined, elapsedMs: now - startedAt });
    };

    // Flush anything coalesced away, so the last line before a long silence is
    // still shown rather than waiting for output that may never come.
    const ticker = setInterval(() => { if (pending) report(true); }, PROGRESS_INTERVAL_MS);
    ticker.unref?.();

    const append = (chunk: Buffer, isError: boolean): void => {
      const text = chunk.toString('utf8');
      if (isError) stderr += text; else stdout += text;
      combined += text;
      if (combined.length > MAX_OUTPUT_BYTES) {
        // Keep the tail: the end of a failing build is what says why.
        combined = combined.slice(-MAX_OUTPUT_BYTES);
      }
      report();
    };

    child.stdout?.on('data', (chunk: Buffer) => append(chunk, false));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, true));

    // One wording, used by both exits below. There are two of them and they are
    // the same event — which is how they came to disagree.
    const timeoutMessage = timeoutMs === MAX_FOREGROUND_MS && requestedMs >= MAX_FOREGROUND_MS
      ? `Command stopped after ${Math.round(MAX_FOREGROUND_MS / 60000)} minutes, the maximum for a `
        + `foreground command. If it was a server or a watcher, start it with background:true and `
        + `it will keep running while you carry on.`
      : `Command timed out after ${rawTimeout}s. Increase the timeout if it genuinely needs longer, `
        + `or use background:true if it is not supposed to exit.`;

    // Startup window for a backgrounded command: report what it printed, leave
    // it running, and let the turn continue.
    const startupTimer = !inBackground ? undefined : setTimeout(() => {
      if (settled || child.pid === undefined) return;
      running.set(child.pid, { command: input.command, startedAt });
      installExitHook();
      // Detached from the parent's event loop so a live server cannot keep the
      // process from exiting on its own.
      child.unref?.();
      const where = /(https?:\/\/[^\s]+)/.exec(combined)?.[1];
      finish(0, undefined, {
        note: `Started in the background${serverKind ? ` — this looks like ${serverKind}` : ''}. `
          + `It is still running as pid ${child.pid}`
          + `${where ? ` and printed ${where}` : ''}. `
          + `Nothing is waiting on it, so carry on`
          + `${where ? ` — you can verify against ${where} now` : ''}. `
          + `Stop it with \`kill ${child.pid}\` when you no longer need it.`,
        pid: child.pid,
      });
    }, STARTUP_WINDOW_MS);
    startupTimer?.unref?.();

    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // A killed shell can still have descendants holding its pipes open, so
      // `close` may arrive long after the deadline — or never. Waiting for it
      // would make a timeout advisory rather than real: a 2s limit took five
      // seconds to return because `ping` outlived the shell that spawned it.
      //
      // This raced with the `close` handler below, and which one won decided
      // whether the caller was told anything: `close` explains the timeout,
      // this used to pass `finish(1)` with no message, so a process stubborn
      // enough to outlive the grace window produced a bare non-zero exit with
      // no reason given. Intermittently, since it depended on how fast the OS
      // reaped a tree it had just been told to kill.
      graceTimer = setTimeout(() => finish(1, timeoutMessage), KILL_GRACE_MS);
      graceTimer.unref?.();
    }, timeoutMs);
    timer?.unref?.();
    let graceTimer: NodeJS.Timeout | undefined;

    // Cancellation kills the tree, exactly like a timeout does.
    //
    // Without this, pressing Stop during `npm install` aborted the *loop* and
    // left the install running: the loop cannot return until the tool promise
    // settles, so the turn stayed busy for as long as the command took. The
    // signal and the deadline want the same thing — stop this process and
    // everything it started — so they share the machinery.
    const onAbort = (): void => {
      if (settled) return;
      cancelled = true;
      killTree(child.pid);
      graceTimer = setTimeout(() => finish(1, cancelMessage), KILL_GRACE_MS);
      graceTimer.unref?.();
    };
    if (signal) {
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let settled = false;
    let cancelled = false;
    const cancelMessage = 'Command cancelled.';
    const finish = (
      exitCode: number,
      error?: string,
      left?: { note: string; pid: number },
    ): void => {
      // Both `close` and the timeout grace path can reach here; whichever is
      // first is the answer.
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (startupTimer) clearTimeout(startupTimer);
      signal?.removeEventListener('abort', onAbort);
      report(true);
      // Appended, not substituted. This read `stderr || error`, so the
      // explanation was kept only when the command had said nothing itself —
      // and a command killed mid-write usually has. The result was a run that
      // timed out, reported whatever partial stderr existed, and never
      // mentioned the timeout: a non-zero exit with no reason, intermittently,
      // depending on whether the doomed process got a write in first.
      resolve({
        stdout: [stdout, left?.note].filter(Boolean).join('\n\n'),
        stderr: [stderr, error].filter(Boolean).join('\n').trim(),
        exit_code: exitCode,
        ...(left ? { background: { pid: left.pid, command: input.command } } : {}),
      });
    };

    child.on('error', (err) => {
      finish(1, err instanceof Error ? err.message : String(err));
    });

    child.on('close', (code) => {
      if (child.pid !== undefined) running.delete(child.pid);
      if (cancelled) { finish(code ?? 1, cancelMessage); return; }
      if (timedOut) {
        finish(code ?? 1, timeoutMessage);
        return;
      }
      // A backgrounded command that exits inside the startup window did not
      // start — a port already in use, a missing module, a typo. Reporting it as
      // "running in the background" would be a worse lie than the hang this
      // replaced, so it is reported as the plain failure it is.
      finish(code ?? 0);
    });
  });
}

export const bashDefinition = {
  name: 'Bash',
  description:
    'Execute a shell command and return stdout, stderr, and exit code. Output streams while it runs. '
    + 'Default timeout: 120s — raise it for a slow build or install. '
    + 'For anything not supposed to exit (a dev server, a watcher, a log tail) use background:true: '
    + 'it starts, you get whatever it printed plus its pid, and the turn carries on. '
    + 'Waiting in the foreground for a server to exit will only ever end in a timeout.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout: {
        type: 'number',
        description:
          'Timeout in seconds, capped at 30 minutes. Raise it for a slow build or install. '
          + 'It is not a way to run a server — use background:true for that.',
      },
      background: {
        type: 'boolean',
        description:
          'Start the command and return without waiting for it to exit. Use for servers, '
          + 'watchers, and anything else long-lived. Detected automatically for common '
          + 'launchers, so it is only needed when that detection is wrong.',
      },
    },
    required: ['command'],
  },
};
