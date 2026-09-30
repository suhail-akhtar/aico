/**
 * What every ops tool shares: resolving a credential for one use, recording
 * the operation in the work ledger, rate limits, live output, and keeping
 * secret-looking text the vault does not know about out of results.
 *
 * The ops tools (SSH, HTTP, WinRM, SNMP) are the vault's *trusted consumers*
 * (docs/security/credential-broker.md §10): they take a credential by name,
 * resolve it through the broker for the exact host or origin they are about
 * to contact, send the value there, and return a result that never contains
 * it. This module is where the rules that apply to all of them live, so each
 * tool cannot get one of them slightly wrong:
 *
 *  - **One approval primitive.** Anything a person must say yes to — a
 *    destructive command, an unknown SSH host key, an SNMP set, an HTTP
 *    DELETE — is a credential use with `requireApproval`, answered through the
 *    broker's human channels (AICO Desktop's native dialog, a passphrase, the
 *    terminal). The API token cannot answer it; neither can the model. There
 *    is no second, weaker approval path to keep in step.
 *  - **The person reads all of it.** The broker shows the first 500
 *    characters of a use's purpose, so a forced approval whose text would be
 *    cut is refused instead of shown truncated — a destructive tail hidden
 *    past the cut is exactly what an injected command would try.
 *  - **Every operation is a ledger record** (tool, target, credential *name*,
 *    state), so `Supervise` lists, waits on and stops long runs like any other
 *    work, and a restart marks what was in flight as lost.
 *  - **Unknown secrets are masked.** The redactor only knows values the vault
 *    holds; a service's generated admin password printed by `cat` is not one
 *    of them. High-confidence secret shapes in output are masked, and the
 *    tools offer `capture` to move such a value into the vault instead.
 *
 * @module tools/ops/common
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { currentRunContext } from '../../run-context.js';
import { registerStopHandle, type StopHandle } from '../../work/handles.js';
import { ledger } from '../../work/ledger.js';
import {
  create as vaultCreate, resolve as vaultResolve, VaultError,
  type ApprovalPrompter, type CredentialKind, type ResolvedSecret,
} from '../../vault/index.js';
import { looksLikeSecret, replaceDetected, scanForSecrets } from '../../vault/scan.js';
import { sinkRedactAccumulated } from '../../vault/sink.js';
import { owningSession } from '../task.js';

/** A failure the model can act on. The message never carries a value. */
export class OpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsError';
  }
}

/** Longest purpose a forced approval may carry: the broker shows 500 characters of it. */
export const MAX_APPROVAL_PURPOSE = 480;

// ── who approves, per run ────────────────────────────────────────────

/**
 * The run's own approval dialog, for when no process-wide prompter is set
 * (the terminal UI). Carried in async context by the `ops:prompter` stage,
 * because the tool registry's dispatch signature is fixed and the run's
 * permission callback is not reachable from inside a tool otherwise.
 */
const prompterStore = new AsyncLocalStorage<ApprovalPrompter | undefined>();

export function runWithOpsPrompter<T>(prompter: ApprovalPrompter | undefined, fn: () => Promise<T>): Promise<T> {
  return prompterStore.run(prompter, fn);
}

function fallbackPrompter(): ApprovalPrompter | undefined {
  return prompterStore.getStore();
}

// ── credentials ──────────────────────────────────────────────────────

export interface OpsUse {
  tool: string;
  host?: string;
  origin?: string;
  purpose: string;
  requireApproval?: boolean;
}

/**
 * Resolve a credential for one use. The target in `use` MUST be the one the
 * caller then connects to (credential-broker.md §10 rule 1).
 */
export async function useCredential(ref: string, use: OpsUse): Promise<ResolvedSecret> {
  const cleaned = normaliseRef(ref);
  if (!cleaned) throw new OpsError('Name the credential to use (see CredentialList), e.g. "nas-root" or "{{secret:nas-root}}".');
  if (use.requireApproval && use.purpose.length > MAX_APPROVAL_PURPOSE) {
    throw new OpsError(`This needs a person's approval, and the approval shows ${MAX_APPROVAL_PURPOSE} characters; this `
      + `one is ${use.purpose.length}. Split it into smaller steps so the person can read all of what they approve.`);
  }
  const sessionId = currentRunContext()?.sessionId;
  try {
    return await vaultResolve(cleaned, {
      tool: use.tool,
      purpose: use.purpose,
      ...(use.host ? { host: use.host } : {}),
      ...(use.origin ? { origin: use.origin } : {}),
      ...(use.requireApproval ? { requireApproval: true } : {}),
      ...(sessionId ? { sessionId } : {}),
    }, fallbackPrompter());
  } catch (err) {
    throw new OpsError(err instanceof VaultError ? err.message : 'The credential could not be used.');
  }
}

/** `nas-root`, `nas-root.password`, `{{secret:nas-root}}` → the broker's reference form. */
export function normaliseRef(ref: unknown): string {
  return typeof ref === 'string' ? ref.trim() : '';
}

/** A credential name as shown in results and ledger titles (never a value). */
export function credentialLabel(ref: string): string {
  const m = /\{\{\s*secret:([^}\s.]+)/.exec(ref);
  return (m ? m[1]! : ref.split('.')[0]!).slice(0, 64);
}

/**
 * Store a value the operation produced (a service's generated password, a
 * token an API returned) in the vault, bound to where it came from.
 * Returns the reference. The value is never returned.
 */
export async function captureSecret(input: {
  name: string; kind?: CredentialKind; value: string; host?: string; url?: string; username?: string; description: string;
}): Promise<string> {
  const sessionId = currentRunContext()?.sessionId ?? 'cli';
  const kind: CredentialKind = input.kind ?? 'generic';
  const field = kind === 'api-token' ? 'token' : kind === 'generic' ? 'value' : kind === 'snmp' ? 'community' : 'password';
  try {
    const { credential } = await vaultCreate({
      name: input.name,
      kind,
      secret: { [field]: input.value },
      ...(input.username ? { username: input.username } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(input.url ? { url: input.url } : {}),
      description: input.description.slice(0, 400),
      tags: ['captured'],
      createdBy: `agent:${sessionId.replace(/[^\w.-]/g, '').slice(0, 100) || 'unknown'}`,
      // Bound to where it came from, so trusted tools use it there unattended;
      // unbound, every use asks — the same rule as CredentialGenerate.
      policy: { approval: input.host || input.url ? 'auto' : 'every-use', allowShell: false },
    });
    return `{{secret:${credential.name}}}`;
  } catch (err) {
    throw new OpsError(err instanceof VaultError ? `Could not store the captured value: ${err.message}` : 'Could not store the captured value.');
  }
}

// ── masking what the vault does not know ─────────────────────────────

const ENV_KEYED = /[A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|private[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*(["'`]?)([^\s"'`,;()[\]{}<>]{6,200})\1/gi;

/**
 * Mask high-confidence secret shapes (tokens with known prefixes, keyed
 * `password=…` values, URL passwords, private keys) the redactor cannot know
 * about. Returns the text and how many were masked.
 */
export function maskUnknownSecrets(text: string): { text: string; masked: number } {
  if (!text) return { text, masked: 0 };
  const found = scanForSecrets(text);
  // Config and env files name their secrets with prefixes (`DB_PASSWORD=`,
  // `GF_SECURITY_ADMIN_PASSWORD=`, `client-secret:`), which the chat scanner's
  // word-boundary keywords do not see. Server output is full of them.
  for (const m of text.matchAll(ENV_KEYED)) {
    const value = m[2]!;
    if (!looksLikeSecret(value, '=')) continue;
    // `mkpasswd: /usr/bin/mkpasswd` is a path, not a password — seen live,
    // where masking it hid the one fact the agent had asked for.
    if (/^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:[\\/])[\w./\\~-]*$/.test(value)) continue;
    const start = m.index! + m[0].lastIndexOf(value);
    const end = start + value.length;
    if (found.some(f => start < f.end && end > f.start)) continue;
    found.push({ start, end, value, kind: 'generic', label: 'keyed value' });
  }
  found.sort((a, b) => a.start - b.start);
  if (!found.length) return { text, masked: 0 };
  return {
    text: replaceDetected(text, found, d => `[masked ${d.label}]`),
    masked: found.length,
  };
}

export const MASK_NOTE = 'Some output looked like a secret the vault does not hold and was masked. If you need that value later, '
  + 'run the step again with `capture` so it goes into the vault instead of the conversation.';

// ── the ledger ───────────────────────────────────────────────────────

export interface OpRecord {
  readonly id: string;
  beat(note: string): void;
  /** Successful end. Foreground operations are marked reported: the tool result told the model. */
  done(summary: string, opts?: { reported?: boolean }): void;
  fail(reason: string, opts?: { reported?: boolean; cancelled?: boolean }): void;
  onStop(handle: StopHandle): void;
}

/**
 * Open a ledger record for an operation. Kind `process`: a remote command or
 * tunnel is an OS process somewhere, with no heartbeat worth enforcing idle
 * rules on, and like a local process it cannot survive a restart of this
 * engine (its connection lives here), so boot reconciliation marks it lost.
 */
export function openOp(o: { tool: string; target: string; credential?: string; summary: string }): OpRecord {
  const sessionId = owningSession(currentRunContext()?.sessionId);
  const title = `${o.tool} ${o.target}${o.credential ? ` [cred ${o.credential}]` : ''}: ${o.summary}`.replace(/\s+/g, ' ');
  const id = ledger.open({
    kind: 'process',
    title: title.length > 160 ? `${title.slice(0, 157)}…` : title,
    origin: 'model',
    ...(sessionId ? { sessionId } : {}),
  });
  const finish = (reported: boolean | undefined): void => { if (reported !== false) ledger.acknowledge([id]); };
  return {
    id,
    beat: (note) => ledger.beat(id, { note: note.slice(0, 160) }),
    done: (summary, opts) => { ledger.close(id, 'done', summary.slice(0, 400)); finish(opts?.reported); },
    fail: (reason, opts) => { ledger.close(id, opts?.cancelled ? 'cancelled' : 'failed', reason.slice(0, 400)); finish(opts?.reported); },
    onStop: (handle) => registerStopHandle(id, handle),
  };
}

// ── rate limits and concurrency ──────────────────────────────────────

const WINDOW_MS = 60_000;
const recent = new Map<string, number[]>();

/** Calls per minute per tool and target: enough for any deploy, not enough for a runaway loop. */
export const RATE_LIMITS: Record<string, number> = {
  SshExec: 60, SshCopy: 60, SshTunnel: 20, HttpRequest: 120, WinRmExec: 60, SnmpQuery: 120,
};

/** Throws when a tool has hit its per-target rate. Records the call otherwise. */
export function checkRate(tool: string, target: string, now = Date.now()): void {
  const key = `${tool}\u0000${target.toLowerCase()}`;
  const limit = RATE_LIMITS[tool] ?? 60;
  const list = (recent.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  if (list.length >= limit) {
    recent.set(key, list);
    throw new OpsError(`${tool} has been called ${limit} times in the last minute against ${target}. That looks like a loop; `
      + 'stop and check what is going wrong, or batch the work into fewer calls.');
  }
  list.push(now);
  recent.set(key, list);
}

/** Tests only. */
export function resetOpsRateForTest(): void { recent.clear(); }

// ── live output ──────────────────────────────────────────────────────

export interface OpsProgress { output: string; elapsedMs: number }
let progressSink: ((p: OpsProgress) => void) | undefined;

/** Where a running remote command's partial output goes (the server's tool-progress). */
export function setOpsProgressSink(sink: ((p: OpsProgress) => void) | undefined): void {
  progressSink = sink;
}

/** A throttled reporter for one call; output is redacted as accumulated text. */
export function progressReporter(startedAt: number): { report(all: string, force?: boolean): void } {
  let last = 0;
  return {
    report(all, force = false) {
      if (!progressSink) return;
      const now = Date.now();
      if (!force && now - last < 400) return;
      last = now;
      try { progressSink({ output: sinkRedactAccumulated(all.slice(-16_000)), elapsedMs: now - startedAt }); } catch { /* a UI sink failing must not fail the command */ }
    },
  };
}

// ── small shared helpers ─────────────────────────────────────────────

/** Output kept in memory per stream; beyond it the head is dropped, not the tail. */
export const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

export function appendCapped(acc: string, chunk: string, max = MAX_OUTPUT_CHARS): string {
  const next = acc + chunk;
  return next.length > max ? next.slice(-max) : next;
}

/** Clamp a timeout in seconds to [1, max], with a default. */
export function clampSeconds(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(1, Math.round(n)), max);
}

/** A host as the vault compares it: lower-case, brackets off. */
export function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

/** Validate a host argument: a name or an IP, nothing that could smuggle options or paths. */
export function validHost(host: unknown): host is string {
  return typeof host === 'string' && /^(?:\[[0-9a-fA-F:.]+\]|[0-9a-fA-F:]+:[0-9a-fA-F:.]*|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/.test(host.trim())
    && !host.trim().startsWith('-');
}

export function validPort(port: unknown, fallback: number): number {
  if (port === undefined || port === null || port === '') return fallback;
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new OpsError(`"${String(port).slice(0, 20)}" is not a valid port.`);
  return n;
}
