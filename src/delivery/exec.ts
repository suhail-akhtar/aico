/**
 * Running one command a person or a project configured for the board — a worktree's
 * setup, a release's deploy — with the guards a model's shell command gets.
 *
 * WHY ITS OWN MODULE. `verify.ts` runs the project's checks and keeps their results by
 * tree hash; this runs commands that are not checks and are not a model's. The rules
 * are the same ones the agent's shell lives under, applied here by code, not by trust:
 *
 *  - the command is refused if it would reveal the vault or answer AICO's own approval
 *    prompts (`vault/guard.shellDenial`) — whoever wrote it, including a repository's
 *    settings file;
 *  - the child gets the agent's scrubbed environment (`agentChildEnv`: no provider keys,
 *    no `settings.env` names), so a project's command cannot print them;
 *  - it has a deadline, and the whole process tree is killed when it passes;
 *  - what comes back is the redacted tail of its output, never the whole of it.
 *
 * What it does not do: decide whether the command may run at all. That is the caller's:
 * a deploy waits for a person (the route is human-gated), a worktree setup comes only
 * from settings a person approved (`config.ts`).
 *
 * @module delivery/exec
 */

import { spawn } from 'node:child_process';
import { agentChildEnv } from '../child-env.js';
import { shellDenial } from '../vault/guard.js';
import { sinkRedactText } from '../vault/sink.js';

export interface ExecResult {
  ok: boolean;
  code: number | null;
  ms: number;
  /** The redacted tail of the combined output. */
  tail: string;
  timedOut?: boolean;
  /** Set when the command was refused before it started. */
  denied?: string;
}

const TAIL = 4000;

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    k.on('error', () => undefined);
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

export function runCommand(opts: { command: string; cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<ExecResult> {
  const denied = shellDenial(opts.command);
  if (denied) return Promise.resolve({ ok: false, code: null, ms: 0, tail: denied, denied });
  const started = Date.now();
  return new Promise(resolve => {
    let raw = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(opts.command, { cwd: opts.cwd, shell: true, windowsHide: true, env: agentChildEnv() }); // security-allow: shell-true — a command a person or an approved project setting configured (config.ts), refused first by shellDenial; never text from a task, a model or a request body
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeoutMs);
    const onAbort = (): void => killTree(child.pid);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const take = (b: Buffer): void => { raw = (raw + b.toString('utf8')).slice(-200_000); };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const done = (code: number | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const clean = sinkRedactText(raw.replace(/\r\n/g, '\n').trimEnd());
      resolve({
        ok: code === 0 && !timedOut, code, ms: Date.now() - started, ...(timedOut ? { timedOut } : {}),
        tail: `${timedOut ? `Timed out after ${Math.round(opts.timeoutMs / 1000)}s.\n` : ''}${extra}${clean.length > TAIL ? `...\n${clean.slice(-TAIL)}` : clean}`,
      });
    };
    child.on('error', err => done(1, `${err.message}\n`));
    child.on('close', code => done(code));
  });
}
