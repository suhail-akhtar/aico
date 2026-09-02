/**
 * Evaluation and optimisation as jobs the clients can watch.
 *
 * Both take minutes and spend money, so neither can be an HTTP request that
 * waits for its answer: a browser would time out, a panel would show nothing,
 * and closing either would leave a run nobody could see or stop. A job starts,
 * returns an id, and reports its state on demand — the same shape every other
 * long-running thing in this server has, minus the ledger, because a job's
 * whole record fits in memory and is worthless once read.
 *
 * ## What "adopt" means
 *
 * The optimiser never writes the skill it was given; it produces a candidate.
 * Adopting one writes it as a draft and registers it as a *user* skill of the
 * same name, which takes precedence over the built-in. The built-in is
 * untouched, so "un-adopt" is deleting the user skill. That asymmetry is the
 * point: the shipped file cannot be corrupted by a loop, only shadowed by a
 * choice a person made.
 *
 * @module skills/eval/jobs
 */

import fs from 'fs';
import path from 'path';
import type { AicoSettings } from '../../settings.js';
import type { ProviderAPI } from '../../providers/types.js';
import { draftsDir, executeSkillManage } from '../manage.js';
import { skillRegistry } from '../registry.js';
import { assignSplits, corpusFor } from './corpus.js';
import { evalSkill } from './run.js';
import { optimizeSkill, type OptimizeStep } from './optimize.js';
import type { EvalReport, TaskResult } from './types.js';

export type JobKind = 'eval' | 'optimize';

export interface SkillJob {
  id: string;
  kind: JobKind;
  skill: string;
  model: string;
  startedAt: number;
  /** Where it is: which task or step is running, in words. */
  phase: string;
  /** Per-task results so far, in the order they finished. */
  tasks: Array<TaskResult & { phase?: 'train' | 'val' }>;
  /** Optimise only: one entry per propose–validate round. */
  steps: OptimizeStep[];
  costUsd: number;
  done: boolean;
  cancelled: boolean;
  error?: string;
  /** Eval: the finished report. */
  report?: EvalReport;
  /** Optimise: the outcome. `best` is the candidate body, or absent if nothing won. */
  outcome?: {
    baselineValMean: number;
    bestValMean: number;
    improved: boolean;
    best?: string;
    stoppedBecause?: string;
  };
}

interface Live {
  job: SkillJob;
  abort: AbortController;
}

const jobs = new Map<string, Live>();

/** Jobs are small; keep a handful so a client that reconnects can still read one. */
const KEEP = 12;

function forget(): void {
  if (jobs.size <= KEEP) return;
  const finished = [...jobs.values()].filter(l => l.job.done).sort((a, b) => a.job.startedAt - b.job.startedAt);
  for (const l of finished.slice(0, jobs.size - KEEP)) jobs.delete(l.job.id);
}

function newJob(kind: JobKind, skill: string, model: string): Live {
  const job: SkillJob = {
    id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind, skill, model, startedAt: Date.now(), phase: 'starting',
    tasks: [], steps: [], costUsd: 0, done: false, cancelled: false,
  };
  const live = { job, abort: new AbortController() };
  jobs.set(job.id, live);
  forget();
  return live;
}

async function skillBody(name: string): Promise<{ name: string; body: string } | undefined> {
  await skillRegistry.load({});
  const found = skillRegistry.lookup(name);
  return found ? { name: found.frontmatter.name, body: found.promptTemplate } : undefined;
}

/** What a client needs before it starts anything: the corpus, split. */
export async function describeCorpus(skill: string): Promise<{
  skill: string;
  tasks: Array<{ id: string; split: 'train' | 'val'; checks: number; builtin: boolean }>;
  train: number;
  val: number;
}> {
  const tasks = corpusFor(skill);
  const sides = assignSplits(tasks);
  const rows = tasks.map(t => ({
    id: t.id,
    split: sides.get(t.id) ?? 'train',
    checks: t.checks.length,
    builtin: !t.id.includes('/user/'),
  }));
  return {
    skill,
    tasks: rows,
    train: rows.filter(r => r.split === 'train').length,
    val: rows.filter(r => r.split === 'val').length,
  };
}

export interface StartOptions {
  skill: string;
  model: string;
  settings: AicoSettings;
  budgetUsd: number;
  maxIterations?: number;
  /** Injected by tests only; never reachable over HTTP. */
  provider?: ProviderAPI;
}

export async function startEval(opts: StartOptions): Promise<SkillJob | { error: string }> {
  const found = await skillBody(opts.skill);
  if (!found) return { error: `no skill called "${opts.skill}"` };
  const tasks = corpusFor(found.name);
  if (tasks.length === 0) return { error: `no tasks for "${found.name}"` };

  const live = newJob('eval', found.name, opts.model);
  const { job } = live;
  job.phase = `running ${tasks.length} task(s)`;

  void evalSkill(found.name, found.body, tasks, {
    model: opts.model,
    settings: opts.settings,
    budgetUsd: opts.budgetUsd,
    ...(opts.maxIterations ? { maxIterations: opts.maxIterations } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    signal: live.abort.signal,
    onTask: (r) => { job.tasks.push(r); job.costUsd += r.costUsd; job.phase = `${job.tasks.length} of ${tasks.length} done`; },
  }).then((report) => {
    job.report = report;
    job.phase = report.overBudget ? 'stopped: budget' : 'finished';
  }).catch((err) => {
    job.error = err instanceof Error ? err.message : String(err);
    job.phase = 'failed';
  }).finally(() => { job.done = true; });

  return job;
}

export interface OptimizeStartOptions extends StartOptions {
  steps: number;
  candidates?: number;
  maxEdits?: number;
  optimizerModel?: string;
}

export async function startOptimize(opts: OptimizeStartOptions): Promise<SkillJob | { error: string }> {
  const found = await skillBody(opts.skill);
  if (!found) return { error: `no skill called "${opts.skill}"` };
  const tasks = corpusFor(found.name);
  const sides = assignSplits(tasks);
  const train = [...sides.values()].filter(s => s === 'train').length;
  const val = tasks.length - train;
  if (train === 0 || val === 0) {
    return { error: `optimising needs training and validation tasks; have ${train} train and ${val} val` };
  }

  const live = newJob('optimize', found.name, opts.model);
  const { job } = live;
  job.phase = 'baseline on validation';

  void optimizeSkill(found.name, found.body, tasks, {
    model: opts.model,
    settings: opts.settings,
    budgetUsd: opts.budgetUsd,
    steps: opts.steps,
    ...(opts.candidates ? { candidates: opts.candidates } : {}),
    ...(opts.maxEdits ? { budget: { maxEdits: opts.maxEdits } } : {}),
    ...(opts.optimizerModel ? { optimizerModel: opts.optimizerModel } : {}),
    ...(opts.maxIterations ? { maxIterations: opts.maxIterations } : {}),
    signal: live.abort.signal,
    onTask: (phase, r) => { job.tasks.push({ ...r, phase }); job.costUsd += r.costUsd; },
    onPhase: (text) => { job.phase = text; },
    onStep: (s) => { job.steps.push(s); },
  }).then((result) => {
    job.outcome = {
      baselineValMean: result.baseline.mean,
      bestValMean: result.bestValMean,
      improved: result.best !== found.body,
      ...(result.best !== found.body ? { best: result.best } : {}),
      ...(result.stoppedBecause ? { stoppedBecause: result.stoppedBecause } : {}),
    };
    job.phase = result.best !== found.body ? 'finished: a better skill' : 'finished: nothing beat the current skill';
  }).catch((err) => {
    job.error = err instanceof Error ? err.message : String(err);
    job.phase = 'failed';
  }).finally(() => { job.done = true; });

  return job;
}

export function getJob(id: string): SkillJob | undefined {
  return jobs.get(id)?.job;
}

export function cancelJob(id: string): boolean {
  const live = jobs.get(id);
  if (!live || live.job.done) return false;
  live.job.cancelled = true;
  live.job.phase = 'cancelling';
  live.abort.abort();
  return true;
}

/**
 * Register an optimised candidate as a user skill of the same name.
 *
 * The draft keeps the original frontmatter so it is a complete skill file;
 * `register` moves it where the loader scans. The built-in stays as it was.
 */
export async function adoptCandidate(id: string): Promise<{ ok: boolean; message: string }> {
  const job = getJob(id);
  if (!job?.outcome?.best) return { ok: false, message: 'this job has no candidate to adopt' };

  await skillRegistry.load({});
  const found = skillRegistry.lookup(job.skill);
  if (!found) return { ok: false, message: `no skill called "${job.skill}"` };

  const raw = fs.readFileSync(found.filePath, 'utf8');
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw)?.[0] ?? '';
  const draftName = `${job.skill}-optimized`;
  const dir = path.join(draftsDir(), draftName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fm + job.outcome.best, 'utf8');

  const message = await executeSkillManage({ action: 'register', name: draftName });
  const ok = !/^(No draft|A name is required|Refusing|Cannot|Not )/i.test(message) && !/problem/i.test(message);
  return { ok, message };
}
