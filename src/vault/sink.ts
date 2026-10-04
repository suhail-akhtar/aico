/**
 * The one redactor every sink consults.
 *
 * Deliberately tiny and dependency-free, because it is imported by the
 * lowest layers of the engine — the session log, the tool pipeline, the spill
 * writer, the SSE hub — and none of those may pull the vault's crypto or its
 * store into their import graph. The vault publishes a {@link Redactor} here
 * whenever its contents change; the sinks only ever read it.
 *
 * With no vault, or an empty one, every function here is the identity and
 * costs a single branch.
 *
 * The second thing here is the per-call environment stash: the one way a
 * resolved secret reaches the shell. A pipeline stage resolves `{{secret:x}}`
 * and stashes `AICO_SECRET_1=<value>` under the call's id; the Bash dispatcher
 * takes it and hands it to that one child process's environment. The value is
 * never written into the call's arguments, which are logged, streamed and
 * shown to hooks.
 *
 * @module vault/sink
 */

import { Redactor, type SecretEntry, type StreamRedactor } from './redact.js';

let active: Redactor = Redactor.EMPTY;
/** What the vault published, before the extras are merged in. */
let vaultRedactor: Redactor = Redactor.EMPTY;
/**
 * Secrets the engine holds outside the vault — provider keys, `settings.env`,
 * MCP server env/headers (see child-env.ts) — keyed by who registered them.
 * They were never indexed before, so `printenv` in the agent's shell wrote the
 * user's API key straight into the log.
 */
const extras = new Map<string, SecretEntry[]>();

function rebuild(): void {
  const more = [...extras.values()].flat();
  active = more.length ? new Redactor([...vaultRedactor.entries, ...more]) : vaultRedactor;
}

/** Publish the redactor the sinks use. Called by the vault service only. */
export function setActiveRedactor(redactor: Redactor): void {
  vaultRedactor = redactor;
  rebuild();
}

/** Replace the extra (non-vault) secrets registered under `source`. */
export function setExtraRedactions(source: string, entries: SecretEntry[]): void {
  if (entries.length) extras.set(source, entries);
  else extras.delete(source);
  rebuild();
}

/** The redactor in force now. */
export function activeRedactor(): Redactor {
  return active;
}

/** Redact any JSON-shaped value on its way to a sink. */
export function sinkRedact<T>(value: T): T {
  return active.empty ? value : active.redactDeep(value);
}

/** Redact a string on its way to a sink. */
export function sinkRedactText(text: string): string {
  return active.empty ? text : active.redact(text);
}

/** Redact accumulated streaming text (see {@link Redactor.redactAccumulated}). */
export function sinkRedactAccumulated(text: string): string {
  return active.empty ? text : active.redactAccumulated(text);
}

/**
 * A delta redactor bound to the redactor in force *now*. A stream keeps the
 * index it started with, so a vault change mid-stream cannot split one value
 * between two indexes.
 */
export function sinkStream(): StreamRedactor {
  return active.stream();
}

// ── per-call secret environment ──────────────────────────────────────

const callEnv = new Map<string, Record<string, string>>();

/** Stash environment for one tool call. Overwrites any earlier stash for it. */
export function stashCallEnv(callId: string, env: Record<string, string>): void {
  callEnv.set(callId, env);
}

/** Take (and forget) the stashed environment for a call. */
export function takeCallEnv(callId: string | undefined): Record<string, string> | undefined {
  if (!callId) return undefined;
  const env = callEnv.get(callId);
  callEnv.delete(callId);
  return env;
}

/** Forget a stash that was never taken — the call was denied or failed early. */
export function dropCallEnv(callId: string): void {
  callEnv.delete(callId);
}
