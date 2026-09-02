/**
 * Running a skill against its corpus, under a budget.
 *
 * Each task gets a fresh scratch directory, the fixture written into it, and one
 * headless agent run with the skill body as the task. What comes back is the
 * final reply, the tool calls made, and what it cost — which is everything the
 * graders need and everything the optimiser reads.
 *
 * ## The budget is a hard stop, not a warning
 *
 * A step of optimisation is `train + validation` runs, and a run is a real model
 * spending real money on the user's account. The budget is checked before every
 * task, and the moment it is exceeded the report says so and stops. A partial
 * report with `overBudget: true` is honest; a complete one bought with money the
 * user did not agree to spend is not.
 *
 * @module skills/eval/run
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runAgent } from '../../agent.js';
import { Session } from '../../session/index.js';
import { createTokenTracker } from '../../tokens.js';
import type { AicoSettings } from '../../settings.js';
import type { ProviderAPI } from '../../providers/types.js';
import { grade, hashFiles } from './grade.js';
import type { EvalReport, EvalTask, TaskResult } from './types.js';

export interface RunOptions {
  model: string;
  settings: AicoSettings;
  /** Stop before the next task once cumulative cost passes this. */
  budgetUsd: number;
  /** Model calls per task. A skill that loops forever is a failed task, not a bill. */
  maxIterations?: number;
  /** Injected for tests; the real provider is selected from the model otherwise. */
  provider?: ProviderAPI;
  /** Called after each task, for progress output. */
  onTask?: (result: TaskResult) => void;
  /** Stops between tasks; a task already running finishes or is aborted with the agent. */
  signal?: AbortSignal;
  /**
   * Results already known for (skill body, task) pairs, keyed by `cacheKey`.
   *
   * The optimiser re-runs the training set every step with whatever skill is
   * current — and after a rejected step that skill is *unchanged*, so the
   * whole set was being paid for again to learn nothing. With the cache, an
   * unchanged pair costs nothing. Supplied by the caller so its lifetime is the
   * caller's: a single optimisation, never across runs, because a model's
   * answer to the same prompt tomorrow is not today's.
   */
  cache?: Map<string, TaskResult>;
}

/** Identity of one run: what was asked, of which model, with which skill text. */
export function cacheKey(model: string, skillBody: string, taskId: string): string {
  let h = 0;
  for (const ch of skillBody) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${model}|${taskId}|${skillBody.length}|${h.toString(36)}`;
}

/**
 * Write the fixture, and make it a repository when the task asks for one.
 *
 * Identity is set locally so a commit works on a machine with no global git
 * config, and `core.autocrlf` is pinned off so the fixture's bytes are the
 * fixture's bytes — this project has already been bitten once by a checkout
 * quietly rewriting line endings.
 */
export function materialise(task: EvalTask, cwd: string): void {
  const write = (files: Record<string, string> | undefined): void => {
    for (const [rel, content] of Object.entries(files ?? {})) {
      const file = path.join(cwd, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    }
  };

  if (task.git) {
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    };
    git('init', '-q');
    git('config', 'user.email', 'eval@aico.local');
    git('config', 'user.name', 'aico eval');
    git('config', 'core.autocrlf', 'false');
    write(task.git.baseline ?? { '.gitkeep': '' });
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline', '--allow-empty');
    write(task.files);
    git('add', '-A');
    return;
  }

  write(task.files);
}

/** The skill body with the task's arguments in place. */
export function renderTask(skillBody: string, task: EvalTask): string {
  return skillBody.replace('{args}', task.args ?? '');
}

export async function runTask(
  skillBody: string,
  task: EvalTask,
  opts: RunOptions,
): Promise<TaskResult> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `aico-skill-eval-${task.skill}-`));
  const tracker = createTokenTracker();
  const toolCalls: string[] = [];

  try {
    materialise(task, cwd);
    const fixtureHashes = hashFiles(cwd, task.files ?? {});

    const session = new Session({
      id: `skill-eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      cwd,
      startedAt: Date.now(),
    });

    let output = '';
    let error: string | undefined;
    try {
      output = await runAgent({
        task: renderTask(skillBody, task),
        model: opts.model,
        cwd,
        session,
        sessionId: session.header.id,
        tokenTracker: tracker,
        settings: {
          ...opts.settings,
          maxIterations: opts.maxIterations ?? 20,
          // Nothing here should schedule, gate, or wait on a person.
          completionGate: { enabled: false },
          cron: { enabled: false },
        } as AicoSettings,
        autoApprove: true,
        headless: true,
        verbose: false,
        silent: true,
        showPlan: false,
        conversationHistory: [],
        onToolCall: (name) => { toolCalls.push(name); },
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const { score, results } = grade(task.checks, { output, toolCalls, cwd, fixtureHashes });
    return {
      id: task.id,
      // A run that threw scores zero. It did not do the task; the graders
      // would mostly agree, but "mostly" is a gradient the optimiser should
      // not be given for a crash.
      score: error ? 0 : score,
      checks: results,
      output,
      toolCalls,
      costUsd: tracker.estimateCost(opts.model, opts.settings),
      ...(error ? { error } : {}),
    };
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* windows holds handles */ }
  }
}

export async function evalSkill(
  skill: string,
  skillBody: string,
  tasks: readonly EvalTask[],
  opts: RunOptions,
): Promise<EvalReport> {
  const results: TaskResult[] = [];
  let costUsd = 0;
  let overBudget = false;

  for (const task of tasks) {
    if (opts.signal?.aborted) break;
    const key = cacheKey(opts.model, skillBody, task.id);
    const known = opts.cache?.get(key);
    if (known) {
      // Free, and reported as such: a cached task carries no cost, so the
      // budget is not charged twice for one answer.
      const replay = { ...known, costUsd: 0 };
      results.push(replay);
      opts.onTask?.(replay);
      continue;
    }
    if (costUsd >= opts.budgetUsd) { overBudget = true; break; }
    const result = await runTask(skillBody, task, opts);
    results.push(result);
    costUsd += result.costUsd;
    if (!result.error) opts.cache?.set(key, result);
    opts.onTask?.(result);
  }

  const mean = results.length
    ? results.reduce((n, r) => n + r.score, 0) / results.length
    : 0;

  return { skill, model: opts.model, tasks: results, mean, costUsd, overBudget };
}
