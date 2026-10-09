/**
 * Running the project's checks on a task's rebased branch, once per tree.
 *
 * WHY HERE AND NOT `RunChecks`. `RunChecks` is a tool of a run: it reads the run's
 * context, bills a session log and remembers "unchanged since the last green run" by
 * source-file modification time in memory. The merge queue runs outside any run, on a
 * directory that is not the run's, and must survive a restart. So the same idea is
 * kept in the board's journal instead, keyed by what is actually being tested: the
 * git **tree hash** of the rebased branch. A tree the journal already holds as green
 * is not run again (two tasks that rebase to the same tree, a re-approve after a
 * no-op rebase, a retry after a restart); a different tree always runs, however the
 * files' dates look.
 *
 * Which checks: the project's own (profile first, manifest second, `checksFor`),
 * taken from the registered project and run in the task's worktree. The in-process
 * `security` check is left to the risk review (`risk.ts`), which scans the diff
 * itself. A project that defines no checks gets an honest "none defined" and an empty
 * result, which the evidence report shows as such, never a pretended pass.
 *
 * Stops at the first failure (the later ones usually fail for the same reason, as
 * `RunChecks` says), bounds each command's time, runs with the agent's scrubbed
 * environment (no provider keys, `child-env.ts`) and keeps only the tail of a
 * failing check's output.
 *
 * @module delivery/verify
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { agentChildEnv } from '../child-env.js';
import { checksFor } from '../project/profile.js';
import type { Check } from '../checks.js';
import { parseTestOutput } from '../test-results.js';
import { load, recordChecks, type CheckRecord } from './store.js';

export const CHECK_TIMEOUT_MS = 10 * 60_000;
const TAIL = 3000;

export interface VerifyOutcome {
  ok: boolean;
  /** The tree was already known green; nothing ran. */
  cached: boolean;
  results: CheckRecord[];
  /** The project defines no checks. */
  none: boolean;
  failed?: CheckRecord;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    k.on('error', () => undefined);
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

function runOne(check: Check, cwd: string, timeoutMs: number): Promise<CheckRecord> {
  const started = Date.now();
  return new Promise(resolve => {
    let raw = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(check.command, { cwd, shell: true, windowsHide: true, env: agentChildEnv() }); // security-allow: shell-true — the project's own check command (profile or manifest), the same trust RunChecks gives it; never text from a request, a task or the model
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    const take = (b: Buffer): void => { raw = (raw + b.toString('utf8')).slice(-200_000); };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const done = (code: number | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ms = Date.now() - started;
      const tests = /test|jest|vitest|mocha|pytest|spec/i.test(`${check.name} ${check.command}`) ? parseTestOutput(raw) : undefined;
      // The runner's counts outrank its exit code when they disagree towards red (as RunChecks).
      const passed = code === 0 && !timedOut && !(tests && tests.failed > 0) && !(check.failOnOutput && raw.trim().length > 0);
      const clean = raw.replace(/\r\n/g, '\n').trimEnd();
      resolve({
        name: check.name, command: check.command, outcome: passed ? 'passed' : 'failed', exitCode: code, ms,
        ...(tests ? { tests: { runner: tests.runner, passed: tests.passed, failed: tests.failed, skipped: tests.skipped, failures: tests.failures.slice(0, 8).map(f => f.name) } } : {}),
        ...(passed ? {} : { tail: `${timedOut ? `Timed out after ${Math.round(timeoutMs / 1000)}s.\n` : ''}${extra}${clean.length > TAIL ? `...\n${clean.slice(-TAIL)}` : clean}` }),
      });
    };
    child.on('error', err => done(1, `${err.message}\n`));
    child.on('close', code => done(code));
  });
}

/**
 * Check the tree at `worktree` (whose hash is `tree`). `project` is the registered
 * project: it owns the journal and decides which checks exist.
 */
export async function verifyTree(
  project: string, worktree: string, tree: string,
  opts: { checks?: Check[]; timeoutMs?: number; force?: boolean } = {},
): Promise<VerifyOutcome> {
  const known = load(project).checks.get(tree);
  if (known?.ok && !opts.force) return { ok: true, cached: true, results: known.results, none: known.results.length === 0 };

  const all = (opts.checks ?? checksFor(project)).filter(c => !c.builtin);
  if (all.length === 0) {
    recordChecks(project, tree, true, []);
    return { ok: true, cached: false, results: [], none: true };
  }
  const results: CheckRecord[] = [];
  let failed: CheckRecord | undefined;
  for (const check of all) {
    // A sub-project's check runs where its manifest is: the same place inside the worktree.
    const inside = check.cwd ? path.relative(project, check.cwd) : '';
    const cwd = inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? path.join(worktree, inside) : worktree;
    const r = await runOne(check, cwd, opts.timeoutMs ?? CHECK_TIMEOUT_MS);
    results.push(r);
    if (r.outcome === 'failed') { failed = r; break; }
  }
  recordChecks(project, tree, !failed, results);
  return { ok: !failed, cached: false, results, none: false, ...(failed ? { failed } : {}) };
}
