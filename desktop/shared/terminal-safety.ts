/**
 * Who may type into a terminal, and when AICO should speak up about one.
 *
 * WHY. The terminal panel holds the person's own shells — one may be sitting
 * at `[sudo] password for suhail:`, another may be an SSH session on a
 * production box. The agent reading those is useful ("what went wrong in my
 * terminal?"); the agent typing into them is how a single injected line
 * becomes a command on the wrong machine or a guess at a password prompt. So
 * the rule is code, not a prompt (AGENTS.md §4.6, ADR 0019):
 *
 *  - `agentMayWrite` — the agent writes only into a tab it started itself
 *    (`ide_terminal_run`), never into one a person opened or an SSH shell, and
 *    never while that tab shows a password / passphrase / sudo / PIN / one-time
 *    code prompt (`detectSecretPrompt`);
 *  - `ErrorWatch` — "Watch with AICO" only *suggests*: error-looking output
 *    produces at most one card per 30 s per tab, the same error is not shown
 *    twice, and nothing calls a model until the person clicks.
 *
 * Pure; time is passed in.
 *
 * @module desktop/shared/terminal-safety
 */

import { stripAnsi } from './terminal-redact';

/** Who opened a tab. Only `agent` tabs ever take the agent's keystrokes. */
export type TabOwner = 'user' | 'agent' | 'ssh';

const SECRET_PROMPTS: Array<{ re: RegExp; what: string }> = [
  { re: /\[sudo\] password for [^:\n]*:\s*$/i, what: 'sudo password' },
  { re: /\bsudo\b[^\n]{0,60}password[^\n]{0,20}:\s*$/i, what: 'sudo password' },
  { re: /\benter passphrase\b[^\n]{0,120}:\s*$/i, what: 'key passphrase' },
  { re: /\bpass ?phrase\b[^\n]{0,80}:\s*$/i, what: 'passphrase' },
  { re: /\bpassword\b[^\n]{0,120}:\s*$/i, what: 'password' },
  { re: /\bpasscode\b[^\n]{0,80}:\s*$/i, what: 'passcode' },
  { re: /\b(?:pin|PIN)\b[^\n]{0,40}:\s*$/, what: 'PIN' },
  { re: /\b(?:verification|authentication|security|one[- ]time|2fa|mfa|otp)\b[^\n]{0,40}\bcode\b[^\n]{0,20}:\s*$/i, what: 'one-time code' },
  { re: /\b(?:OTP|TOTP|token code)\b[^\n]{0,20}:\s*$/i, what: 'one-time code' },
  { re: /\bvault password\b[^\n]{0,40}:\s*$/i, what: 'vault password' },
  { re: /Enter (?:PEM|PKCS#?12|import|export) pass(?:word|phrase)[^\n]{0,40}:\s*$/i, what: 'certificate passphrase' },
  // PowerShell's Read-Host -AsSecureString / Get-Credential, and Windows runas.
  { re: /\bEnter the password for\b[^\n]{0,80}:\s*$/i, what: 'password' },
];

/**
 * Is the cursor sitting at a prompt for a secret? Looks only at the current
 * line — the text after the last newline, colours stripped — so a password
 * prompt that was already answered (the Enter moved the cursor on) does not
 * count, and one that is open does, whatever came before it.
 */
export function detectSecretPrompt(recentOutput: string): { prompt: boolean; what?: string } {
  const plain = stripAnsi(recentOutput.slice(-2048));
  const current = plain.slice(plain.lastIndexOf('\n') + 1);
  if (!current.trim()) return { prompt: false };
  const line = current.slice(-240);
  for (const p of SECRET_PROMPTS) if (p.re.test(line)) return { prompt: true, what: p.what };
  return { prompt: false };
}

/** The one place the agent's write into a terminal is decided. */
export function agentMayWrite(tab: { owner: TabOwner; exited?: boolean } | undefined, recentOutput: string): { ok: true } | { ok: false; reason: string } {
  if (!tab) return { ok: false, reason: 'There is no such terminal.' };
  if (tab.exited) return { ok: false, reason: 'That terminal has exited.' };
  if (tab.owner === 'user') return { ok: false, reason: 'That terminal belongs to the user. You may read it (ide_terminal_read) but never type into it; start your own with ide_terminal_run.' };
  if (tab.owner === 'ssh') return { ok: false, reason: 'That is the user\'s SSH session. You may not type into it; use SshExec with a stored credential instead.' };
  const p = detectSecretPrompt(recentOutput);
  if (p.prompt) return { ok: false, reason: `The terminal is waiting for a ${p.what}. You never type secrets; ask the user to answer it in the terminal themselves.` };
  return { ok: true };
}

// ── "Watch with AICO" ──

/** Lines that look like a failure. Each is cheap and anchored to a word boundary. */
const ERROR_PATTERNS: Array<{ re: RegExp; kind: string }> = [
  { re: /^\s*(?:Traceback \(most recent call last\))/m, kind: 'Python traceback' },
  { re: /^\s*at [\w$.<>[\]]+ \(?[^\s()]+:\d+(?::\d+)?\)?\s*$/m, kind: 'stack trace' },
  { re: /\bnpm ERR!|\bnpm error\b|\bERR_[A-Z_]{4,}\b/, kind: 'npm error' },
  { re: /^\s*(?:error|fatal(?: error)?)\s*[:!]/i, kind: 'error' },
  { re: /\berror(?:\[E\d+\])?:|\berror TS\d+\b|\bERROR\b|\bFatal(?: error)?:|\bFATAL\b|\bpanic:/, kind: 'error' },
  { re: /\bUnhandled(?:PromiseRejection| exception| rejection)|\bUncaught\b|\bSegmentation fault\b/i, kind: 'crash' },
  { re: /\b(?:Build|Compilation|Tests?|Command|Job|Task|Deployment) failed\b|\bFAILED\b|\bFAIL\s+\S+/, kind: 'failure' },
  { re: /\b(?:\w+Exception|\w+Error)(?::|\s+at\b)/, kind: 'exception' },
  { re: /\bexited with code [1-9]\d*\b|\bexit (?:code|status) [1-9]\d*\b/i, kind: 'non-zero exit' },
  { re: /\bcommand not found\b|is not recognized as (?:an internal or external command|the name of a cmdlet)/i, kind: 'command not found' },
];

/** Lines that contain the word "error" but are not one: summaries of zero, flags, and our own output. */
const BENIGN = /\b0 errors?\b|\bno errors?\b|\berrors?: 0\b|--?[\w-]*error[\w-]*|\bwithout errors?\b|\berror-?free\b|AICO noticed/i;

export interface ErrorHit { kind: string; line: string; signature: string }

/** A stable fingerprint of an error line: numbers, hex, paths' line:col and quotes removed. */
export function errorSignature(line: string): string {
  return line
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\b\d+\b/g, '#')
    .replace(/(["'`]).*?\1/g, '"…"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 160);
}

/** The first error-looking line in a chunk of output, if any. */
export function matchError(output: string): ErrorHit | undefined {
  for (const raw of stripAnsi(output).split('\n')) {
    const line = raw.trim();
    if (!line || line.length > 2000 || BENIGN.test(line)) continue;
    for (const p of ERROR_PATTERNS) {
      if (p.re.test(line)) return { kind: p.kind, line: line.slice(0, 300), signature: errorSignature(line) };
    }
  }
  return undefined;
}

export const WATCH_DEBOUNCE_MS = 30_000;

/**
 * One tab's watcher. `feed` takes output as it arrives (or a finished
 * command's exit code) and returns a suggestion when one is due.
 *
 * Debounce: the first error opens a window; more errors inside it are
 * absorbed. When `WATCH_DEBOUNCE_MS` has passed since the last card, the next
 * *new* error (a signature not seen in this tab) makes a new card. A dev
 * server that prints the same stack trace every reload therefore shows one
 * card, not one per reload.
 */
export class ErrorWatch {
  private lastCardAt = -Infinity;
  private readonly seen = new Set<string>();
  private carry = '';

  feed(output: string, now: number): ErrorHit | undefined {
    // Hold a partial last line so a line split across chunks is judged whole.
    const text = this.carry + output;
    const cut = text.lastIndexOf('\n');
    if (cut < 0) { this.carry = text.slice(-4096); return undefined; }
    this.carry = text.slice(cut + 1).slice(-4096);
    return this.consider(matchError(text.slice(0, cut)), now);
  }

  /** A finished command with a non-zero exit counts too, by its command. */
  exit(command: string, exitCode: number | null, now: number): ErrorHit | undefined {
    if (exitCode === null || exitCode === 0) return undefined;
    const line = `${command} exited with code ${exitCode}`;
    return this.consider({ kind: 'non-zero exit', line: line.slice(0, 300), signature: `exit:${errorSignature(command)}:${exitCode}` }, now);
  }

  private consider(hit: ErrorHit | undefined, now: number): ErrorHit | undefined {
    if (!hit) return undefined;
    if (this.seen.has(hit.signature)) return undefined;
    if (now - this.lastCardAt < WATCH_DEBOUNCE_MS) return undefined;
    this.seen.add(hit.signature);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    this.lastCardAt = now;
    return hit;
  }
}
