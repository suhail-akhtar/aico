/**
 * The small checks every request to `aico serve` passes before a route sees
 * it, and the one that shapes what an error may say on the way out.
 *
 * Why these exist, each from a finding against the loopback API:
 *
 *  - **Host.** The server binds 127.0.0.1, but a page on `evil.example` can
 *    re-point its own name at 127.0.0.1 (DNS rebinding) and then read the
 *    static client and probe the API as "same origin" — its requests carry no
 *    foreign Origin at all. What they cannot fake is the Host header the
 *    browser sends: it names the attacker's domain. So only a loopback name
 *    on this server's port is served.
 *  - **Origin.** The previous check was `origin.startsWith('http://127.0.0.1:7340')`,
 *    which `http://127.0.0.1:73400` and `http://127.0.0.1:7340.evil.example`
 *    both pass. An origin is parsed and compared whole.
 *  - **Submit modes.** `/api/submit` took `approval: 'full'` or `autonomy: 'L4'`
 *    from anything holding the token — which the model may (it runs `curl`
 *    like anyone). Widening how freely a chat acts beyond what a person last
 *    chose there needs a person (server/decision-gate `checkHuman`); a
 *    token-only request is capped to that choice.
 *  - **Errors.** Raw `err.message` carried absolute paths (the store, the
 *    user's home, the project) to whoever asked. Paths are cut to their last
 *    segment; validation messages that hold no path pass unchanged, because
 *    clients and tests read them.
 *
 * Deny-only, like every guard here: nothing in this module grants anything.
 *
 * @module server/http-guards
 */

import path from 'path';
import { parseLevel, type AutonomyLevel } from '../autonomy/levels.js';

/** Host names that mean "this machine" — the only ones the server answers to. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Is this Host header a loopback name on our port? A missing header is
 * refused: every client AICO has (browsers, Node's fetch, curl, the desktop
 * proxy, the VS Code tunnel) sends one.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (typeof host !== 'string' || !host) return false;
  let parsed: URL;
  try { parsed = new URL(`http://${host}`); } catch { return false; }
  // Nothing but host[:port] — no credentials, path or query smuggled in.
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
  if (!LOOPBACK_NAMES.has(parsed.hostname.toLowerCase())) return false;
  const p = parsed.port === '' ? 80 : Number(parsed.port);
  return p === port;
}

/** Is this Origin exactly http://<loopback>:<our port>? Parsed, never prefix-matched. */
export function isAllowedOrigin(origin: string, port: number): boolean {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'http:') return false;
  // `new URL(o).origin === o` refuses anything with a path, credentials or a trailing slash.
  if (parsed.origin !== origin) return false;
  if (!LOOPBACK_NAMES.has(parsed.hostname.toLowerCase())) return false;
  return Number(parsed.port || '80') === port;
}

// ── error messages ──────────────────────────────────────────────────

/** A Windows path (drive or UNC); segments may hold spaces when a separator follows. */
const WIN_PATH = /(?:\b[A-Za-z]:|\\\\[^\\/\s'"`<>|*?:]+)[\\/](?:[^\\/\r\n'"`<>|*?:]+[\\/])*[^\\/\s'"`<>|*?:,;)]*/g;
/** A POSIX absolute path under a root that holds user data or system files (not `/api/…`). */
const POSIX_PATH = /(?<![\w.:/~-])\/(?:home|Users|tmp|var|etc|opt|usr|root|mnt|private|srv|proc|dev|Volumes|run|snap|nix|Library|Applications|workspace|workspaces)(?:\/[^\s'"`<>|:,;)]*)?/g;
/** `~/…` reveals the layout of the home directory just as well. */
const HOME_PATH = /(?<![\w.~-])~[\\/][^\s'"`<>|:,;)]*/g;

function tail(p: string): string {
  const base = path.basename(p.replace(/[\\/]+$/, '').replace(/\\/g, '/'));
  return base ? `…/${base}` : '…';
}

/**
 * A message safe to send to a client: absolute paths become `…/<last part>`,
 * a stack trace is cut off at its first frame. Everything else is kept.
 */
export function publicErrorMessage(message: string): string {
  let out = String(message);
  const stack = out.search(/\n\s+at\s/);
  if (stack >= 0) out = out.slice(0, stack);
  out = out.replace(WIN_PATH, tail).replace(POSIX_PATH, tail).replace(HOME_PATH, tail);
  return out.length > 2000 ? `${out.slice(0, 2000)}…` : out;
}

/**
 * Errors that are programming faults, not answers: their text names internals
 * ("Cannot read properties of undefined (reading 'cwd')") and helps no caller.
 */
export function isInternalFault(err: unknown): boolean {
  return err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError;
}

// ── how freely a submitted turn may act ─────────────────────────────

/**
 * One scale for the two ways a client says it: L0 (plan, read-only) … L4
 * (unattended). `ask` = L1, `edits` = L2, `auto` = L3 (the web client's
 * historical default), `full` = beyond auto — it does not stop when the
 * Sentinel is unsure — so it ranks with L4.
 */
export type SubmitRank = 0 | 1 | 2 | 3 | 4;

/** The rank every session starts at: `auto`, what every web session has always done. */
export const DEFAULT_SUBMIT_RANK: SubmitRank = 3;

const APPROVAL_RANK: Record<string, SubmitRank> = { ask: 1, edits: 2, auto: 3, full: 4 };

export interface SubmitModeRequest {
  approval?: 'auto' | 'edits' | 'ask' | 'full';
  autonomy?: AutonomyLevel;
}

/** How freely this request asks the turn to act. The level wins when both are sent (runs.ts does the same). */
export function submitRank(req: SubmitModeRequest): SubmitRank {
  if (req.autonomy) return Number(req.autonomy.slice(1)) as SubmitRank;
  return APPROVAL_RANK[req.approval ?? 'auto'] ?? DEFAULT_SUBMIT_RANK;
}

/**
 * What to do with a submit, given the most a person has allowed in this
 * session (`ceiling`):
 *
 *  - at or below the ceiling → run as asked (lowering is always allowed);
 *  - above it, and a person is behind the request → run as asked;
 *  - above it, from the token alone, asking for rank 4 (`full`, L4) → refuse:
 *    silently running a turn the caller believes is unattended in a stricter
 *    mode would block it on prompts nobody is watching;
 *  - otherwise → cap to the ceiling.
 */
export function decideSubmitMode(
  req: SubmitModeRequest,
  ceiling: SubmitRank,
  person: boolean,
): { action: 'run'; mode: SubmitModeRequest; rank: SubmitRank } | { action: 'refuse'; reason: string } {
  const rank = submitRank(req);
  if (rank <= ceiling || person) return { action: 'run', mode: req, rank };
  if (rank >= 4) {
    return {
      action: 'refuse',
      reason: `${req.autonomy ? `Autonomy ${req.autonomy}` : 'Full autonomy'} needs a person in the AICO window; the API token alone cannot turn it on.`,
    };
  }
  return { action: 'run', mode: capTo(req, ceiling), rank: ceiling };
}

function capTo(req: SubmitModeRequest, ceiling: SubmitRank): SubmitModeRequest {
  // Said in the caller's own vocabulary, so a level client keeps getting levels.
  if (req.autonomy) return { autonomy: parseLevel(`L${ceiling}`)! };
  if (ceiling === 0) return { autonomy: 'L0' };
  // Ceilings 1–3 here (0 is handled above; a ceiling of 4 never caps).
  const named: Record<number, 'ask' | 'edits' | 'auto'> = { 1: 'ask', 2: 'edits', 3: 'auto' };
  return { approval: named[ceiling] ?? 'auto' };
}
