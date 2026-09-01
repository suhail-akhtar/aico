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
import type { FileWriter } from './tools/file-writer.js';
import type { HostAnswer, HostCall, HostToolName } from '../shared/host-tools.js';
import { effortToSend, type EffortChoice, type EffortLevel } from '../shared/reasoning.js';

/**
 * Somewhere to send a tool call the engine cannot service itself.
 *
 * A function rather than an object with methods, because there is exactly one
 * operation — ask, and wait — and the `tools` list it carries is what decides
 * which tools the model is even shown.
 */
export interface HostBridge {
  (call: Omit<HostCall, 'id'>): Promise<HostAnswer>;
  /** Which of the host tools this client can actually service. */
  tools: readonly HostToolName[];
}

export interface RunContext {
  /** Absolute path the run treats as the project root. */
  cwd: string;
  sessionId?: string;
  settings?: AicoSettings;
  /**
   * Who applies this run's file writes, when it is not the filesystem.
   *
   * Rides on the run context for the same reason `cwd` does: a tool three
   * awaits deep needs it, threading it through every signature would touch
   * everything, and a module-level variable would be one global that two
   * concurrent sessions fight over — one in an editor, one in a browser tab.
   *
   * Undefined is the normal case and means `fs`. See `tools/file-writer`.
   */
  applyEdit?: FileWriter;
  /**
   * The editor driving this run, if one is.
   *
   * Set only when a client has said it can service host tools, and it says so
   * per turn — the same session can be picked up in a browser tab tomorrow,
   * where none of this exists. Undefined is the normal case and means the
   * `VSCode*` tools are not offered at all, which is the only honest way to
   * switch a tool off: present-but-failing teaches a model to keep retrying.
   *
   * See `shared/host-tools` for what can be asked and why the list is short.
   */
  host?: HostBridge;
  /**
   * How hard this run asks the model to think, when the model can be asked.
   *
   * Per run rather than per process for the same reason `cwd` is: one server
   * drives several sessions, and a module-level answer would be whichever
   * session spoke last. `auto` — and the absence of a value — both mean "send
   * nothing and let the platform decide". See `reasoning.ts`.
   */
  effort?: EffortChoice;
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

/**
 * The reasoning level this run should send for `model`, or undefined.
 *
 * Lives here rather than beside the capability table, and the split is the
 * design: *what a model accepts* is one fact for the whole process and belongs
 * in `shared/reasoning`, which the browser client and the VS Code panel import
 * too. *What this run wants* is per session — one server drives several — so it
 * belongs on the context that already answers per-session questions.
 *
 * Keeping them together would have forced `AsyncLocalStorage` into a module the
 * webview imports, which is where this was noticed.
 */
export function resolvedEffort(model: string): EffortLevel | undefined {
  return effortToSend(model, storage.getStore()?.effort);
}
