/**
 * What directory a run is working in, and which session it belongs to.
 *
 * The engine used to answer both questions with process-wide state:
 * `process.cwd()` for the directory, module-level variables for the session.
 * That is exactly wrong for the thing this codebase is built around — a server
 * that owns several runs at once. Two sessions in two different projects share
 * one `process.cwd()`, and the second `setWorkspaceRuntime` call overwrites the
 * first session's id for both of them.
 *
 * `AsyncLocalStorage` is the mechanism for this and the reason it exists: the
 * store follows the async chain of whichever run created it, so a tool called
 * three awaits deep inside session A reads session A's directory while session
 * B is mid-flight in the same process. `process.chdir()` would have been the
 * obvious alternative and is unusable here for the same reason — it is one
 * global that every concurrent run would fight over.
 *
 * Everything falls back to `process.cwd()` when no context is established, so
 * the CLI — one run, one directory, no ambiguity — behaves exactly as before
 * and nothing had to be threaded through it.
 *
 * @module run-context
 */

import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import type { AicoSettings } from './settings.js';

export interface RunContext {
  /** Absolute path the run treats as the project root. */
  cwd: string;
  sessionId?: string;
  settings?: AicoSettings;
}

const storage = new AsyncLocalStorage<RunContext>();

/**
 * Run `fn` with `context` visible to everything it awaits.
 *
 * The context is immutable for the duration: a run does not change directory
 * halfway through, and allowing it to would reintroduce the shared-mutable
 * problem this exists to remove.
 */
export function runInContext<T>(context: RunContext, fn: () => Promise<T>): Promise<T> {
  return storage.run({ ...context, cwd: path.resolve(context.cwd) }, fn);
}

/** The active run's context, or undefined outside a run. */
export function currentRunContext(): RunContext | undefined {
  return storage.getStore();
}

/**
 * The directory the caller should treat as the project root.
 *
 * This is the function every path-resolving tool should use instead of
 * `process.cwd()`. Outside a run it *is* `process.cwd()`, which is what makes
 * this a drop-in replacement rather than a migration.
 */
export function currentCwd(): string {
  return storage.getStore()?.cwd ?? path.resolve(process.cwd());
}
