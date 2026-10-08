/**
 * The pipeline-facing commands: `aico evidence`, `aico review`, `aico fix-ci`
 * (ADR 0034). Registered from `index.ts` in one call, the way the vault and
 * skill commands are, so the entry point does not grow a block per command.
 *
 * Exit codes are part of the contract with the GitHub Action (and any other
 * pipeline): 0 success; 2 a precondition said nothing could be done (no
 * changes to review, a refused fix) — the job should note it and carry on, not
 * fail the pull request; 1 an error (no provider, a crash). `fix-ci` writes
 * what happened to `--result` as JSON because a pipeline branches on it.
 *
 * No command here reads a GitHub token or posts anything. They take files and
 * refs in, and write Markdown and JSON out.
 *
 * @module ci/cli
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { loadSettings, type AicoSettings } from '../settings.js';
import { packetFromDisk, render, type EvidenceFormat } from '../evidence/index.js';
import { runReview } from './review.js';
import { runFixCi } from './fix-ci.js';

export interface CiCommandDeps {
  /** Resolve a model name (flag, then settings, then whatever provider is configured). */
  pickModel: (flag: string | undefined, settings: AicoSettings) => string;
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function writeOut(file: string | undefined, text: string): void {
  if (file) { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, text); }
  else process.stdout.write(`${text}\n`);
}

export function registerCiCommands(program: Command, deps: CiCommandDeps): void {
  program
    .command('evidence')
    .description('print the change evidence report for a session: files, checks run, approvals, cost, gaps')
    .option('-s, --session <id>', 'session id (default: the most recent in this project)')
    .option('-f, --format <format>', 'md | json | short (a commit-body "Verified:" line)', 'md')
    .option('--base <ref>', 'diff against this ref (default: merge base with the default branch)')
    .option('-C, --cwd <dir>', 'the project directory', process.cwd())
    .action(async (o: { session?: string; format: string; base?: string; cwd: string }) => {
      const format: EvidenceFormat = o.format === 'json' || o.format === 'short' ? o.format : 'md';
      const settings = await loadSettings();
      const found = await packetFromDisk({ root: path.resolve(o.cwd), settings, ...(o.session ? { sessionId: o.session } : {}), ...(o.base ? { base: o.base } : {}) });
      if (!found.ok) { process.stderr.write(`${found.error}\n`); process.exit(2); }
      process.stdout.write(`${render(found.packet, format)}\n`);
      process.exit(0);
    });

  program
    .command('review')
    .description('review a change read-only (no shell, no writes, no network) and print the findings as Markdown')
    .requiredOption('--base <ref>', 'the branch the change merges into, e.g. origin/main')
    .option('--head <ref>', 'the change (default HEAD)')
    .option('--pr <number>', 'the pull request number, for the heading')
    .option('--pr-title <text>', 'the pull request title (untrusted; given to the model as data)')
    .option('--pr-body-file <file>', 'a file holding the pull request description (untrusted)')
    .option('--budget <usd>', 'stop once the estimated cost passes this')
    .option('--max-minutes <n>', 'stop after this many minutes')
    .option('-m, --model <model>', 'model')
    .option('-o, --out <file>', 'write the review here instead of stdout')
    .option('-C, --cwd <dir>', 'the repository', process.cwd())
    .action(async (o: { base: string; head?: string; pr?: string; prTitle?: string; prBodyFile?: string; budget?: string; maxMinutes?: string; model?: string; out?: string; cwd: string }) => {
      const settings = await loadSettings();
      const model = deps.pickModel(o.model, settings);
      let prBody: string | undefined;
      if (o.prBodyFile) { try { prBody = fs.readFileSync(o.prBodyFile, 'utf8'); } catch { /* an unreadable description is just absent */ } }
      let result;
      try {
        result = await runReview({
          cwd: path.resolve(o.cwd), base: o.base, model, settings,
          ...(o.head ? { head: o.head } : {}),
          ...(o.pr && /^\d+$/.test(o.pr) ? { prNumber: Number(o.pr) } : {}),
          ...(o.prTitle ? { prTitle: o.prTitle } : {}),
          ...(prBody ? { prBody } : {}),
          ...(num(o.budget) !== undefined ? { budgetUsd: num(o.budget)! } : {}),
          ...(num(o.maxMinutes) !== undefined ? { maxMinutes: num(o.maxMinutes)! } : {}),
        });
      } catch (err) {
        process.stderr.write(`aico review failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      if (!result.ok) { process.stderr.write(`${result.error}\n`); process.exit(2); }
      writeOut(o.out, result.markdown);
      if (o.out) process.stderr.write(`Review written to ${o.out} (${result.files?.length ?? 0} files${result.truncated ? ', some not shown to the model' : ''}).\n`);
      process.exit(0);
    });

  program
    .command('fix-ci')
    .description('reproduce a failing CI run on a new branch, fix it, and commit only if the checks then pass (never pushes)')
    .requiredOption('--log <file>', 'the failing run\'s log (untrusted)')
    .option('--run-id <id>', 'the failing run\'s id, for the branch and commit')
    .option('--branch-prefix <prefix>', 'prefix of the branch to create', 'aico/fix-ci')
    .option('--budget <usd>', 'stop once the estimated cost passes this')
    .option('--max-minutes <n>', 'stop after this many minutes')
    .option('-m, --model <model>', 'model')
    .option('-o, --out <file>', 'write the pull request body here')
    .option('--result <file>', 'write the outcome as JSON here')
    .option('-C, --cwd <dir>', 'the repository (a clean checkout of the failing commit)', process.cwd())
    .action(async (o: { log: string; runId?: string; branchPrefix: string; budget?: string; maxMinutes?: string; model?: string; out?: string; result?: string; cwd: string }) => {
      let log: string;
      try { log = fs.readFileSync(o.log, 'utf8'); } catch { process.stderr.write(`Cannot read the log file ${o.log}.\n`); process.exit(1); }
      const settings = await loadSettings();
      const model = deps.pickModel(o.model, settings);
      let outcome;
      try {
        outcome = await runFixCi({
          cwd: path.resolve(o.cwd), log, model, settings, branchPrefix: o.branchPrefix,
          ...(o.runId ? { runId: o.runId } : {}),
          ...(num(o.budget) !== undefined ? { budgetUsd: num(o.budget)! } : {}),
          ...(num(o.maxMinutes) !== undefined ? { maxMinutes: num(o.maxMinutes)! } : {}),
        });
      } catch (err) {
        process.stderr.write(`aico fix-ci failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      const { body, ...rest } = outcome;
      if (o.result) writeOut(o.result, JSON.stringify(rest, null, 2));
      if (o.out) writeOut(o.out, body); else process.stdout.write(`${body}\n`);
      process.stderr.write(`fix-ci: ${outcome.status}${outcome.branch ? ` on ${outcome.branch}` : ''}${outcome.reason ? ` — ${outcome.reason}` : ''}\n`);
      // fixed -> 0 (publish it). Anything else is not an error in the pipeline's sense; it is "nothing to publish".
      process.exit(outcome.status === 'fixed' ? 0 : 2);
    });
}
