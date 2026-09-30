/**
 * Turning a model's remote command into what is sent over SSH — without a
 * secret value ever being part of it.
 *
 * Three things can need a value on the far side: the SSH login (handled by the
 * SSH layer, never a string here), `sudo`'s password, and `{{secret:…}}`
 * references in the command itself ("set the service user's password to
 * {{secret:svc}}"). The exec request is visible to the remote host's process
 * table (`ps`), its audit log and anything that logs commands, so values go
 * over the channel's **stdin** instead, and only when the far side asks:
 *
 *  - `sudo -S -p <marker>` prints a random prompt marker to stderr when (and
 *    only when) it wants a password. The client writes the password on seeing
 *    it. A NOPASSWD sudo never prints it, so the password is never written to
 *    a command that might read stdin — the failure mode of the naive
 *    `echo pw | sudo -S` (a `tee /etc/x` that writes the password to disk).
 *  - For references, the command runs as `sh -c '<script>'` where the script
 *    prints a random *ready* marker to stderr, then `read`s one line per
 *    secret into shell variables, then runs the command with each reference
 *    rewritten to `"${AICO_SECRET_n}"`. Unexported shell variables, so they do
 *    not appear in child environments either. The client writes the lines on
 *    seeing the marker and closes stdin.
 *
 * Everything here is pure and returns the plan: the exec string, the markers,
 * which references map to which variables. Values are bound later by the
 * caller, and the markers are stripped from what the model sees.
 *
 * Limits, stated: references and sudo need a POSIX `sh` on the host (a Windows
 * host is WinRmExec's job); a value spanning lines cannot be passed on a line
 * (write it with SshCopy `content` instead); `sudo` configured with
 * `requiretty` refuses non-tty use.
 *
 * @module tools/ops/ssh-command
 */

import crypto from 'node:crypto';
import { bindShellPlaceholders } from '../../vault/pipeline.js';
import { parsePlaceholders, type PlaceholderRef } from '../../vault/placeholders.js';

export interface RemotePlan {
  /** Sent as the SSH exec request. References only, never values. */
  exec: string;
  /** Printed by the far side when it is ready for secret lines (absent: close stdin at once). */
  readyMarker?: string;
  /** sudo's prompt marker (absent: no sudo). */
  sudoPrompt?: string;
  /** One entry per distinct reference, in the order the lines must be written. */
  secrets: Array<{ variable: string; ref: PlaceholderRef }>;
}

/** POSIX single-quote a string for `sh`. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function marker(kind: string): string {
  return `AICO-${kind}-${crypto.randomBytes(9).toString('hex')}`;
}

/**
 * Plan a remote command.
 *
 * `markers` is injectable so tests can assert exact output; production uses
 * fresh random markers per call, which is what stops a command's own output
 * from impersonating the prompt.
 */
export async function planRemoteCommand(
  command: string,
  opts: { sudo?: boolean; cwd?: string; markers?: { ready: string; sudo: string } } = {},
): Promise<RemotePlan> {
  const refs = parsePlaceholders(command);
  const secrets: RemotePlan['secrets'] = [];
  let body = command;
  if (refs.length) {
    const bound = await bindShellPlaceholders(command, async (ref) => {
      secrets.push({ variable: `AICO_SECRET_${secrets.length + 1}`, ref });
      return '';
    }, 'posix');
    body = bound.command;
  }
  if (opts.cwd) body = `cd -- ${shQuote(opts.cwd)} && ${body}`;

  const ready = opts.markers?.ready ?? marker('READY');
  const sudoPrompt = opts.sudo ? (opts.markers?.sudo ?? marker('SUDO')) : undefined;
  // The ready line is printed whenever sudo is involved, even with no secrets:
  // it is how the client knows sudo is done asking and stdin can be closed.
  const needsReady = secrets.length > 0 || opts.sudo === true;

  let exec: string;
  if (!needsReady) {
    exec = body;
  } else {
    const reads = secrets.map(s => `IFS= read -r ${s.variable} || exit 97`).join('\n');
    const script = [`printf '%s\\n' ${shQuote(ready)} >&2`, reads, body].filter(Boolean).join('\n');
    exec = opts.sudo
      ? `sudo -S -p ${shQuote(sudoPrompt!)} -- sh -c ${shQuote(script)}`
      : `sh -c ${shQuote(script)}`;
  }
  return {
    exec,
    ...(needsReady ? { readyMarker: ready } : {}),
    ...(sudoPrompt ? { sudoPrompt } : {}),
    secrets,
  };
}

/** A value that can travel as one line of stdin. */
export function lineSafe(value: string): boolean {
  return !/[\r\n\0]/.test(value);
}

/**
 * Watches a remote stderr stream for the markers, across chunk boundaries.
 *
 * `onSudoPrompt` fires once per prompt occurrence (a second one means the
 * password was wrong), `onReady` once. `clean()` strips marker text from
 * output handed to the model.
 */
export class MarkerWatch {
  private buffer = '';
  private sudoSeen = 0;
  private readySeen = false;

  constructor(
    private readonly plan: Pick<RemotePlan, 'readyMarker' | 'sudoPrompt'>,
    private readonly handlers: { onSudoPrompt?: (count: number) => void; onReady?: () => void },
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    const { sudoPrompt, readyMarker } = this.plan;
    for (;;) {
      const s = sudoPrompt ? this.buffer.indexOf(sudoPrompt) : -1;
      const r = readyMarker && !this.readySeen ? this.buffer.indexOf(readyMarker) : -1;
      if (s < 0 && r < 0) break;
      if (s >= 0 && (r < 0 || s < r)) {
        this.buffer = this.buffer.slice(s + sudoPrompt!.length);
        this.sudoSeen++;
        this.handlers.onSudoPrompt?.(this.sudoSeen);
      } else {
        this.buffer = this.buffer.slice(r + readyMarker!.length);
        this.readySeen = true;
        this.handlers.onReady?.();
      }
    }
    // Keep only a tail long enough to hold a marker split across chunks.
    const keep = Math.max(sudoPrompt?.length ?? 0, readyMarker?.length ?? 0);
    if (this.buffer.length > keep) this.buffer = this.buffer.slice(-keep);
  }

  get sudoPrompts(): number { return this.sudoSeen; }
  get ready(): boolean { return this.readySeen; }

  /** Output with marker text (and the lines that carried only a marker) removed. */
  clean(text: string): string {
    let out = text;
    for (const m of [this.plan.sudoPrompt, this.plan.readyMarker]) {
      if (!m) continue;
      out = out.split(`${m}\n`).join('').split(m).join('');
    }
    return out;
  }
}
