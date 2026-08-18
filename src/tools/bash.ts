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

import { spawn, execFile } from 'child_process';
import { currentCwd } from '../run-context.js';

export interface BashInput {
  command: string;
  timeout?: number;
  /** Passed from settings — default bash timeout in seconds (0 = no timeout) */
  _defaultTimeout?: number;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exit_code: number;
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
  // Priority: explicit timeout arg → settings default → 120s fallback
  const rawTimeout = input.timeout ?? input._defaultTimeout ?? 120;
  const timeoutMs = rawTimeout === 0 ? undefined : rawTimeout * 1000;

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
    const timeoutMessage =
      `Command timed out after ${rawTimeout}s. Use timeout=0 for unlimited or increase the timeout.`;

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
    const finish = (exitCode: number, error?: string): void => {
      // Both `close` and the timeout grace path can reach here; whichever is
      // first is the answer.
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      report(true);
      // Appended, not substituted. This read `stderr || error`, so the
      // explanation was kept only when the command had said nothing itself —
      // and a command killed mid-write usually has. The result was a run that
      // timed out, reported whatever partial stderr existed, and never
      // mentioned the timeout: a non-zero exit with no reason, intermittently,
      // depending on whether the doomed process got a write in first.
      resolve({
        stdout,
        stderr: [stderr, error].filter(Boolean).join('\n').trim(),
        exit_code: exitCode,
      });
    };

    child.on('error', (err) => {
      finish(1, err instanceof Error ? err.message : String(err));
    });

    child.on('close', (code) => {
      if (cancelled) { finish(code ?? 1, cancelMessage); return; }
      if (timedOut) {
        finish(code ?? 1, timeoutMessage);
        return;
      }
      finish(code ?? 0);
    });
  });
}

export const bashDefinition = {
  name: 'Bash',
  description: 'Execute a shell command and return stdout, stderr, and exit code. Output streams while it runs. Default timeout: 120s. Use timeout=0 for unlimited (required for npm install, pip install, cargo build, etc.).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds. 0 means no timeout. Defaults to the configured bash timeout.',
      },
    },
    required: ['command'],
  },
};
