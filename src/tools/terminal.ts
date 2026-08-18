/**
 * A shell that remembers what you did to it.
 *
 * Every `Bash` call is a fresh process, so nothing survives it. `cd` into a
 * directory and the next command starts back where it began; export a variable,
 * activate a virtualenv, `nvm use` a version — all gone. The model has no way
 * to hold state in a shell, so it re-establishes it on every line: `cd "…" &&
 * node server.js`, over and over, one long chain that has to be right all at
 * once.
 *
 * The session that prompted this shows the cost. The agent ran that exact
 * chained command twice, both failed, and the third attempt hung — three
 * attempts at one idea, each paying again for state the shell had already been
 * told about and thrown away.
 *
 * So: one shell per session, kept alive between calls, with its working
 * directory and environment intact.
 *
 * **A pipe, not a pseudo-terminal.** A real PTY needs a compiled native module,
 * which on Windows means a toolchain the user may not have, to buy interactive
 * curses programs that an agent almost never needs. State persistence is the
 * part that was actually missing, and a pipe delivers it with no new
 * dependency. Programs that demand a TTY are the honest limit of this, and it
 * says so rather than hanging.
 *
 * **Completion is marked, not guessed.** A pipe has no prompt to wait for, so
 * each command is followed by an echo of a per-command nonce, the exit code and
 * the working directory. Reading stops at that marker. The nonce is fresh every
 * time so a command that prints the marker text cannot end its own read early.
 *
 * **The working directory comes back with every result.** The confusion this
 * fixes is silent: a `cd` that did not take looks exactly like one that did,
 * until something writes a file into the wrong place. Reporting where the shell
 * now is turns that from a discovery into a fact.
 *
 * @module tools/terminal
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { currentCwd, currentRunContext } from '../run-context.js';
import { looksLikeServer } from './bash.js';

/** How long a single command may hold the shell before it is presumed wedged. */
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
/** Nothing may hold it past this, however long the caller asked for. */
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
/** Output kept per command. The tail matters most, so the head is what goes. */
const MAX_OUTPUT = 200_000;
/** Grace after the marker for stderr, which arrives on its own pipe. */
const DRAIN_MS = 60;
/**
 * How long an untouched shell is kept alive.
 *
 * Each of these is a real OS process holding pipes. One per session was fine
 * for a CLI and a slow leak under a server: a session opened once and never
 * returned to left its shell running for the life of the process. Twenty
 * minutes is far longer than a pause between commands and far shorter than a
 * working day of abandoned sessions.
 */
const IDLE_TTL_MS = 20 * 60 * 1000;
/** A hard ceiling, in case something opens sessions faster than they idle out. */
const MAX_SHELLS = 32;

export interface TerminalResult {
  output: string;
  stderr: string;
  exit_code: number;
  /** Where the shell is now — the state that a one-shot call cannot carry. */
  cwd: string;
  /** Set when the shell had to be replaced, and its state lost with it. */
  restarted?: string;
}

interface Shell {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  cwd: string;
  /** One command at a time: a shared stdin has no way to tell replies apart. */
  busy: boolean;
  /** When this shell was last used, for idling it out. */
  usedAt: number;
  /**
   * Resolves once the shell's own startup noise has been read and discarded.
   *
   * A shell greets you: a copyright banner, a prompt. None of it is the result
   * of any command, and clearing the buffer before the first command is a race
   * against text that may not have arrived yet. So the first thing written is a
   * marker of its own, and everything up to it is thrown away.
   */
  ready: Promise<void>;
}

const shells = new Map<string, Shell>();

/** Which shell this call belongs to. */
function shellKey(): string {
  return currentRunContext()?.sessionId ?? 'default';
}

const isWindows = process.platform === 'win32';

/** Start a shell and leave it running. */
function open(cwd: string, key: string): Shell {
  // Non-interactive bash on POSIX: it reads commands from stdin and keeps every
  // bit of state that matters, without printing a prompt at all. `-i` would add
  // prompts and job-control warnings to buy interactivity nothing here uses.
  const child = isWindows
    ? spawn('cmd.exe', ['/q', '/k'], { cwd })
    : spawn('/bin/bash', [], { cwd, detached: true });

  const shell = {
    child, stdout: '', stderr: '', cwd, busy: false, usedAt: Date.now(),
  } as Shell;

  child.stdout?.on('data', (b: Buffer) => { shell.stdout += b.toString('utf8'); });
  child.stderr?.on('data', (b: Buffer) => { shell.stderr += b.toString('utf8'); });
  // A shell that dies takes its state with it; the next call opens a new one
  // rather than writing into a closed pipe.
  child.once('exit', () => { if (shells.get(key) === shell) shells.delete(key); });

  if (isWindows) {
    // `@echo off` stops cmd repeating each command back, and `prompt $_` reduces
    // the prompt to a bare newline. Without the second one every result is
    // prefixed with `C:\some\path>`, which is not output and reads like it is.
    child.stdin?.write('@echo off\r\nprompt $_\r\n');
  }

  // Read past the greeting before anything real is written.
  const primer = `__AICO_READY_${randomBytes(4).toString('hex')}__`;
  shell.ready = new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      const at = shell.stdout.indexOf(primer);
      const dead = shell.child.exitCode !== null;
      if (at === -1 && !dead) return;
      clearInterval(poll);
      // Everything up to and including the primer was the shell clearing its
      // throat. Only what follows can belong to a command.
      if (at !== -1) shell.stdout = shell.stdout.slice(at + primer.length);
      shell.stderr = '';
      resolve();
    }, 15);
    poll.unref?.();
    child.stdin?.write(isWindows ? `echo ${primer}\r\n` : `echo ${primer}\n`);
  });

  return shell;
}

/** Stop a shell and forget it. */
function close(key: string): void {
  const shell = shells.get(key);
  if (!shell) return;
  shells.delete(key);
  try {
    shell.child.stdin?.end();
    if (isWindows) shell.child.kill();
    else process.kill(-(shell.child.pid ?? 0), 'SIGKILL');
  } catch { /* already gone */ }
}

/** Shut every shell down. Called when the process exits. */
export function closeAllTerminals(): void {
  for (const key of [...shells.keys()]) close(key);
}

let exitHook = false;

/**
 * Close shells nobody is using.
 *
 * Called when a new one is opened, which is the only moment the count can grow
 * — no timer, because a background timer that reaps processes is a thing that
 * fires during tests and in a CLI that has already finished.
 */
function reap(keep: string): void {
  const now = Date.now();
  for (const [key, shell] of [...shells]) {
    if (key === keep || shell.busy) continue;
    if (now - shell.usedAt > IDLE_TTL_MS) close(key);
  }
  if (shells.size <= MAX_SHELLS) return;
  // Oldest first. Map iteration is insertion order, and a shell that has not
  // been used since the others were opened is the safest one to take.
  const byAge = [...shells].filter(([k, s]) => k !== keep && !s.busy)
    .sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [key] of byAge) {
    if (shells.size <= MAX_SHELLS) break;
    close(key);
  }
}

/** Trim to a budget, keeping the end — where a failure explains itself. */
function bound(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `[… ${text.length - MAX_OUTPUT} characters dropped from the start …]\n`
    + text.slice(-MAX_OUTPUT);
}

export interface TerminalInput {
  command: string;
  timeout?: number;
  /** Throw this shell away and start a new one before running. */
  restart?: boolean;
}

/**
 * Run a command in the session's shell, and leave the shell running.
 *
 * Never returns a promise that does not settle: a command that outstays its
 * timeout costs the shell, because a wedged shell cannot be reasoned with
 * through a pipe — there is no terminal to send an interrupt to.
 */
export async function terminal(input: TerminalInput): Promise<TerminalResult> {
  const key = shellKey();
  let restarted: string | undefined;

  if (input.restart) {
    close(key);
    restarted = 'Shell restarted as requested; its previous directory and environment are gone.';
  }

  // The one thing a persistent shell must refuse. A server started here holds
  // the shell forever, and unlike Bash — which can hand one back still running
  // — there is no way to detach it from a pipe the next command has to use.
  const server = looksLikeServer(input.command);
  if (server) {
    return {
      output: '',
      stderr: `This looks like ${server}, which never exits, and it would hold this shell open `
        + `for good — every later command in this terminal would wait behind it. `
        + `Start it with the Bash tool instead, which runs it in the background and hands back `
        + `its pid and URL.`,
      exit_code: 1,
      cwd: shells.get(key)?.cwd ?? currentCwd(),
    };
  }

  let shell = shells.get(key);
  if (!shell || shell.child.exitCode !== null || shell.child.killed) {
    shell = open(currentCwd(), key);
    shells.set(key, shell);
    reap(key);
    if (!exitHook) { exitHook = true; process.once('exit', closeAllTerminals); }
  }
  shell.usedAt = Date.now();
  await shell.ready;

  if (shell.busy) {
    return {
      output: '',
      stderr: 'This terminal is already running a command. One at a time — a shared stdin has '
        + 'no way to tell two replies apart.',
      exit_code: 1,
      cwd: shell.cwd,
    };
  }

  const timeoutMs = Math.min(input.timeout ? input.timeout * 1000 : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  // Fresh per command, so a command that prints the marker text — a grep for it,
  // an echo of a previous result — cannot end its own read early.
  const nonce = randomBytes(8).toString('hex');
  const marker = `__AICO_${nonce}__`;

  shell.stdout = '';
  shell.stderr = '';
  shell.busy = true;

  const line = isWindows
    ? `${input.command}\r\necho ${marker} %ERRORLEVEL% %CD%\r\n`
    : `${input.command}\nprintf '%s %s %s\\n' '${marker}' "$?" "$PWD"\n`;

  let died = false;
  try {
    const found = await new Promise<RegExpExecArray | null>((resolve) => {
      const pattern = new RegExp(`${marker} (-?\\d+) (.*)`);
      const deadline = Date.now() + timeoutMs;

      const poll = setInterval(() => {
        const hit = pattern.exec(shell!.stdout);
        if (hit) { clearInterval(poll); setTimeout(() => resolve(hit), DRAIN_MS); return; }
        // A dead shell is an answer too, and waiting out the full timeout for a
        // process that is already gone helps nobody. Reported separately from a
        // timeout, because `exit` ending the shell and a command wedging it call
        // for entirely different next moves.
        if (shell!.child.exitCode !== null) { clearInterval(poll); died = true; resolve(null); }
        if (Date.now() > deadline) { clearInterval(poll); resolve(null); }
      }, 25);

      shell!.child.stdin?.write(line);
    });

    if (!found) {
      // No terminal, no interrupt: a pipe offers no way to reclaim a wedged
      // shell, so the shell is what pays. Said plainly, because the state the
      // model built up in it is genuinely gone.
      const partial = bound(shell.stdout);
      const partialErr = bound(shell.stderr);
      const lastCwd = shell.cwd;
      close(key);
      return {
        output: partial,
        stderr: [partialErr, `The command did not finish within ${Math.round(timeoutMs / 1000)}s. `
          + `This shell has been replaced, so its working directory and environment are gone — `
          + `there is no way to interrupt a command through a pipe without a terminal. `
          + `If it was meant to keep running, start it with Bash, which backgrounds it.`]
          .filter(Boolean).join('\n'),
        exit_code: 124,
        cwd: lastCwd,
        restarted: 'The shell was replaced after a command overran.',
      };
    }

    const exitCode = Number(found[1] ?? 0);
    const cwd = (found[2] ?? '').trim() || shell.cwd;
    const wasAt = shell.cwd;
    shell.cwd = cwd;

    // cmd's oldest trap: `cd D:\somewhere` from a C: prompt changes nothing and
    // reports success. Nothing fails, nothing moves, and every later relative
    // path resolves against a directory the model believes it left. Found by
    // this tool's own tests, which is a fair advertisement for reporting the
    // working directory on every call.
    //
    // Reported rather than rewritten. Silently turning `cd` into `cd /d` would
    // be second-guessing a command the user may have meant literally; saying
    // what happened, and what would work, leaves the decision where it belongs.
    let note = '';
    if (isWindows && exitCode === 0 && cwd === wasAt && /^\s*(?:cd|chdir)\s+\S/i.test(input.command)) {
      const target = /([A-Za-z]):/.exec(input.command.replace(/^\s*(?:cd|chdir)\s+/i, ''));
      if (target && target[1]!.toLowerCase() !== wasAt[0]?.toLowerCase()) {
        note = `cd reported success but the directory did not change: on Windows, cd does not `
          + `cross drives without /d. Still in ${wasAt}. Use \`cd /d ${target[1]}:…\`.`;
      }
    }

    // Everything before the marker is the command's own output.
    const output = shell.stdout.slice(0, shell.stdout.indexOf(marker)).replace(/\r\n/g, '\n');

    return {
      output: bound(output.trim()),
      stderr: bound([shell.stderr.replace(/\r\n/g, '\n').trim(), note].filter(Boolean).join('\n')),
      exit_code: Number.isFinite(exitCode) ? exitCode : 0,
      cwd,
      ...(restarted ? { restarted } : {}),
    };
  } finally {
    const live = shells.get(key);
    if (live) { live.busy = false; live.usedAt = Date.now(); }
  }
}

export const terminalDefinition = {
  name: 'Terminal',
  description:
    'Run a command in a shell that stays alive between calls, keeping its working directory '
    + 'and environment. Use it when state has to persist — cd into a directory and stay there, '
    + 'export a variable, activate a virtualenv — instead of rebuilding that state with '
    + '`cd … && …` on every command. Returns the working directory it ended in. '
    + 'For one-off commands Bash is simpler, and for anything that does not exit — a server, '
    + 'a watcher — use Bash with background:true, which this refuses.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'The command to run.' },
      timeout: {
        type: 'number',
        description: 'Seconds to wait, default 120, capped at 600. On overrun the shell is '
          + 'replaced and its state is lost — a pipe cannot carry an interrupt.',
      },
      restart: {
        type: 'boolean',
        description: 'Discard the current shell and start a clean one before running. Use when '
          + 'the environment is in a state you no longer want.',
      },
    },
    required: ['command'],
  },
};
