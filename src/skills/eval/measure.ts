/**
 * Measuring a drafted skill before anyone installs it: with it, without it,
 * and whether its description gets it opened.
 *
 * WHY. This repository shipped a checklist skill that read well, measured it,
 * found it made the output longer and no better, and removed it. A generated
 * skill is the same bet made faster, so Phase 5 (design §5.1 "Generation",
 * §10) does not let a skill's author be its only judge: every task in the
 * skill's `evals/evals.json` is run twice — once with the skill's procedure,
 * once with the bare request (the baseline) — on the same model and tools, and
 * the uplift is the number that matters. A skill that does not beat the
 * baseline on its own tasks costs tokens for nothing.
 *
 * Triggering is measured separately because it fails separately: a perfect
 * procedure behind a vague description is never opened. Each trigger query is
 * one model call that sees only a catalogue (the installed skills plus this
 * one, as the agent's prompt words it) and the `Skill` tool; whether its first
 * tool call opens this skill is the answer. The description is then tuned the
 * way skill-creator does it: queries split train/test, a revision proposed from
 * the *train* misses only, and the better description kept by *test* score —
 * the incumbent wins ties, so a rewrite has to earn its place.
 *
 * THE REPORT IS BOUND TO THE FILES. `.aico-eval.json` beside `SKILL.md` holds
 * the results and the tree hash they were measured on (the report itself is
 * outside the hash, `provenance.ts`). `register` checks that hash (`evalGate`),
 * so editing a skill after measuring it means measuring it again — the loop is
 * enforced where it runs, not asked for in a prompt.
 *
 * MONEY. Every model call is checked against `budgetUsd` before it is made; a
 * run that hits the ceiling stops and says so (`overBudget`), and an incomplete
 * report does not pass the gate without a person.
 *
 * WHAT IT DOES NOT. No LLM judge (Phase 4) — prose expectations are listed as
 * unchecked. No k-trial agent runs: one run per arm per task, which is what a
 * low-cost draft check can afford; trigger scores can be repeated (`triggerRuns`)
 * and are reported with their spread.
 *
 * @module skills/eval/measure
 */

import fs from 'fs';
import path from 'path';
import type { AicoSettings } from '../../settings.js';
import type { ProviderAPI } from '../../providers/types.js';
import { costFor, createTokenTracker } from '../../tokens.js';
import { parseSkillFile } from '../loader.js';
import { updateFrontmatter } from '../frontmatter.js';
import { treeHash } from '../provenance.js';
import { skillRegistry } from '../registry.js';
import { skillDefinition } from '../../tools/skill.js';
import { readDraftEvals, type TriggerQuery } from './evals-file.js';
import { runTask } from './run.js';
import type { EvalTask, TaskResult } from './types.js';
import {
  REPORT_FILE, type ArmResult, type SkillEvalReport, type TaskComparison, type TriggerOutcome, type TriggerScore,
} from './report.js';

export {
  REPORT_FILE, readReport, evalGate, describeReport,
  type ArmResult, type GateResult, type SkillEvalReport, type TaskComparison, type TriggerOutcome, type TriggerScore,
} from './report.js';


/** No caller may spend more than this on one measurement (the owner's certification cap, §12a). */
export const MAX_BUDGET_USD = 2;
export const DEFAULT_BUDGET_USD = 0.25;


export interface MeasureOptions {
  model: string;
  settings: AicoSettings;
  budgetUsd?: number;
  /** Run each task without the skill too (default true). The point of the exercise. */
  baseline?: boolean;
  /** Score and tune the description on the trigger queries (default true). */
  triggers?: boolean;
  /** Description revisions to try (default 1; 0 measures without tuning). */
  descriptionRounds?: number;
  /** Times to score the final description on the held-out queries (default 1). */
  triggerRuns?: number;
  /** Model calls per agent run (default 10). */
  maxIterations?: number;
  provider?: ProviderAPI;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}


// ── the plan and its price ─────────────────────────────────────────────

/** Assumed size of one agent run and one trigger call, for the estimate only. */
const RUN_GUESS = { inputTokens: 24_000, outputTokens: 1_200 };
const TRIGGER_GUESS = { inputTokens: 1_500, outputTokens: 80 };

export interface MeasurePlan {
  skill: string;
  tasks: number;
  agentRuns: number;
  triggerQueries: number;
  triggerCalls: number;
  estimateUsd: number;
  budgetUsd: number;
  problems: string[];
  notes: string[];
}

function clampBudget(b: number | undefined): number {
  const v = typeof b === 'number' && Number.isFinite(b) && b > 0 ? b : DEFAULT_BUDGET_USD;
  return Math.min(v, MAX_BUDGET_USD);
}

/** What `measureSkill` would do and roughly what it costs. Free. */
export function planMeasure(dir: string, opts: MeasureOptions): MeasurePlan | { error: string } {
  const skill = parseSkillFile(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), path.join(dir, 'SKILL.md'), false);
  if (!skill) return { error: 'SKILL.md does not parse; run verify first.' };
  const evals = readDraftEvals(dir, skill.frontmatter.name);
  if (!evals) return { error: `"${skill.frontmatter.name}" has no evals/evals.json, so there is nothing to measure.` };
  const arms = opts.baseline === false ? 1 : 2;
  const agentRuns = evals.tasks.length * arms;
  const q = opts.triggers === false ? 0 : evals.triggers.length;
  const rounds = Math.max(0, Math.min(3, opts.descriptionRounds ?? 1));
  const testShare = Math.ceil(q * 0.4);
  const triggerCalls = q === 0 ? 0 : q * (1 + rounds) + testShare * Math.max(0, (opts.triggerRuns ?? 1) - 1);
  const estimateUsd = agentRuns * costFor(opts.model, RUN_GUESS, opts.settings)
    + triggerCalls * costFor(opts.model, TRIGGER_GUESS, opts.settings);
  return {
    skill: skill.frontmatter.name, tasks: evals.tasks.length, agentRuns, triggerQueries: q, triggerCalls,
    estimateUsd, budgetUsd: clampBudget(opts.budgetUsd), problems: evals.problems, notes: evals.notes,
  };
}

export function describePlan(p: MeasurePlan, model: string): string {
  return `${p.skill}: ${p.tasks} task(s) → ${p.agentRuns} agent run(s); ${p.triggerQueries} trigger quer(ies) → ${p.triggerCalls} call(s); `
    + `${model}; rough estimate $${p.estimateUsd.toFixed(3)}, hard ceiling $${p.budgetUsd.toFixed(2)}.`;
}

// ── triggering ──────────────────────────────────────────────────────────

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * Stable, stratified train/test split: ~40% of each side held out, ordered by
 * a hash of the query so the split never drifts between runs.
 */
export function splitTriggers(queries: readonly TriggerQuery[]): Map<string, 'train' | 'test'> {
  const out = new Map<string, 'train' | 'test'>();
  if (queries.length < 4) { for (const q of queries) out.set(q.query, 'test'); return out; }
  for (const side of [true, false]) {
    const group = queries.filter(q => q.shouldTrigger === side).sort((a, b) => hash(a.query) - hash(b.query));
    const held = group.length >= 2 ? Math.max(1, Math.round(group.length * 0.4)) : group.length;
    group.forEach((q, i) => out.set(q.query, i < held ? 'test' : 'train'));
  }
  return out;
}

export function scoreTriggers(outcomes: ReadonlyArray<Pick<TriggerOutcome, 'shouldTrigger' | 'triggered'>>): TriggerScore {
  const tp = outcomes.filter(o => o.shouldTrigger && o.triggered).length;
  const fp = outcomes.filter(o => !o.shouldTrigger && o.triggered).length;
  const fn = outcomes.filter(o => o.shouldTrigger && !o.triggered).length;
  const correct = outcomes.filter(o => o.shouldTrigger === o.triggered).length;
  return {
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    accuracy: outcomes.length ? correct / outcomes.length : 0,
    n: outcomes.length,
  };
}

/** The catalogue the trigger call sees: every usable skill but this one, plus this one. */
function catalogueWith(name: string, description: string): string {
  const lines = skillRegistry.list()
    .filter(s => s.frontmatter.name.toLowerCase() !== name.toLowerCase())
    .slice(0, 40)
    .map(s => ({ name: s.frontmatter.name, line: `- ${s.frontmatter.name}: ${s.frontmatter.description.replace(/\s+/g, ' ').trim()}` }));
  lines.push({ name, line: `- ${name}: ${description.replace(/\s+/g, ' ').trim()}` });
  return lines.sort((a, b) => a.name.localeCompare(b.name)).map(l => l.line).join('\n');
}

/*
  Worded as the agent's own prompt words it (prompts.ts, the 'skills' section),
  so a description is judged by the sentence it will actually sit under.
*/
const CATALOGUE_INTRO = 'Skills available to you. Each is a procedure someone wrote for a task of that kind; '
  + 'open one with the Skill tool when its description matches what you are about to do, instead of working the procedure out again.';

class Spend {
  costUsd = 0;
  overBudget = false;
  constructor(readonly budgetUsd: number, readonly signal?: AbortSignal) {}
  /** Whether another call may start. Sets `overBudget` the first time it may not. */
  canSpend(): boolean {
    if (this.signal?.aborted) return false;
    if (this.costUsd >= this.budgetUsd) { this.overBudget = true; return false; }
    return true;
  }
}

async function providerFor(model: string, settings: AicoSettings, injected?: ProviderAPI): Promise<ProviderAPI> {
  if (injected) return injected;
  // Lazy for the reason optimize.ts gives: the registry loads every adapter.
  const { selectProvider } = await import('../../providers/index.js');
  return selectProvider(model, settings);
}

/** One call: does this description, among the others, get this skill opened for this query? */
async function triggerOnce(
  provider: ProviderAPI, opts: MeasureOptions, spend: Spend, name: string, description: string, query: string,
): Promise<{ triggered: boolean; picked?: string }> {
  const tracker = createTokenTracker();
  let picked: string | undefined;
  for await (const event of provider.chat({
    model: opts.model,
    systemPrompt: `You are AICO, a coding agent working in the user's project.\n\n${CATALOGUE_INTRO}\n\n${catalogueWith(name, description)}`,
    messages: [{ role: 'user', content: query }],
    tools: [skillDefinition],
    maxTokens: 400,
  })) {
    // The whole stream is read, not broken off at the first tool call: usage
    // arrives last, and a call whose cost went unrecorded is a call the
    // budget never saw.
    if (event.type === 'tool_call' && picked === undefined) {
      picked = event.name === 'Skill' ? String(event.input?.name ?? '') : `(${event.name})`;
    } else if (event.type === 'usage') {
      tracker.add(event.inputTokens, event.outputTokens, event.cacheReadTokens ?? 0, event.cacheWriteTokens ?? 0);
    }
  }
  spend.costUsd += tracker.estimateCost(opts.model, opts.settings);
  return { triggered: picked?.toLowerCase() === name.toLowerCase(), ...(picked ? { picked } : {}) };
}

async function runTriggers(
  provider: ProviderAPI, opts: MeasureOptions, spend: Spend, name: string, description: string,
  queries: readonly TriggerQuery[], split: Map<string, 'train' | 'test'>,
): Promise<TriggerOutcome[]> {
  const out: TriggerOutcome[] = [];
  for (const q of queries) {
    if (!spend.canSpend()) break;
    const r = await triggerOnce(provider, opts, spend, name, description, q.query);
    out.push({ query: q.query, shouldTrigger: q.shouldTrigger, split: split.get(q.query) ?? 'test', ...r });
  }
  return out;
}

function proposalPrompt(name: string, description: string, body: string, misses: TriggerOutcome[]): string {
  const should = misses.filter(m => m.shouldTrigger).map(m => `- "${m.query}"`);
  const shouldNot = misses.filter(m => !m.shouldTrigger).map(m => `- "${m.query}"`);
  return [
    `An AI coding agent decides whether to open the skill "${name}" from its one-line description alone.`,
    '', `Current description: ${description}`,
    '', 'The skill\'s procedure begins:', body.slice(0, 1_200),
    should.length ? `\nIt was NOT opened for these requests, but should have been:\n${should.join('\n')}` : '',
    shouldNot.length ? `\nIt WAS opened for these requests, but should not have been:\n${shouldNot.join('\n')}` : '',
    '', 'Write a better description. Third person; say what the skill does and when to use it ("Use when …");',
    'aim for under 200 characters (1,024 at most); no XML tags; describe the kind of request rather than quoting these ones.',
    'Reply with JSON only: {"description": "..."}',
  ].filter(s => s !== '').join('\n');
}

async function proposeDescription(
  provider: ProviderAPI, opts: MeasureOptions, spend: Spend, prompt: string,
): Promise<string | undefined> {
  if (!spend.canSpend()) return undefined;
  const tracker = createTokenTracker();
  let text = '';
  for await (const event of provider.chat({
    model: opts.model,
    systemPrompt: 'You write precise skill descriptions and reply with JSON only.',
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    maxTokens: 1_000,
  })) {
    if (event.type === 'text') text += event.content;
    else if (event.type === 'usage') tracker.add(event.inputTokens, event.outputTokens, event.cacheReadTokens ?? 0, event.cacheWriteTokens ?? 0);
  }
  spend.costUsd += tracker.estimateCost(opts.model, opts.settings);
  try {
    const json = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ''))?.[0] ?? '';
    const d = String((JSON.parse(json) as { description?: unknown }).description ?? '').replace(/\s+/g, ' ').trim();
    if (!d || d.length > 1024 || /<[a-z/][^>]*>/i.test(d)) return undefined;
    return d;
  } catch {
    return undefined;
  }
}

/** Better on the held-out side: accuracy, then precision. Ties keep the incumbent. */
function beats(a: TriggerScore, b: TriggerScore): boolean {
  if (a.accuracy !== b.accuracy) return a.accuracy > b.accuracy;
  return (a.precision ?? 0) > (b.precision ?? 0);
}

// ── the measurement ─────────────────────────────────────────────────────

function arm(r: TaskResult): ArmResult {
  return {
    score: r.score,
    missed: r.checks.filter(c => !c.passed).map(c => c.check.why),
    toolCalls: r.toolCalls.length,
    costUsd: r.costUsd,
    output: r.output.length > 1_500 ? `${r.output.slice(0, 1_500)}…` : r.output,
    ...(r.error ? { error: r.error } : {}),
  };
}

/**
 * The task as the agent sees it with the skill: the request, then the
 * procedure as `Skill` would hand it over, with where its files are.
 */
export function withSkillText(name: string, description: string, body: string, dir: string, prompt: string): string {
  return [
    prompt, '',
    `Skill: ${name} — ${description}`,
    `(Its files, if it refers to any, are in ${dir}.)`, '',
    body.replace(/\{args\}/g, prompt), '',
    'Use this procedure where it fits the task.',
  ].join('\n');
}

const mean = (xs: number[]): number | undefined => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;

/** Run the measurement and write `.aico-eval.json`. The description may be rewritten (tuning). */
export async function measureSkill(dir: string, opts: MeasureOptions): Promise<SkillEvalReport | { error: string }> {
  const plan = planMeasure(dir, opts);
  if ('error' in plan) return plan;
  if (plan.problems.length) return { error: `evals are malformed:\n${plan.problems.map(p => `  - ${p}`).join('\n')}` };

  const file = path.join(dir, 'SKILL.md');
  let skill = parseSkillFile(fs.readFileSync(file, 'utf8'), file, false)!;
  const name = skill.frontmatter.name;
  const evals = readDraftEvals(dir, name)!;
  const spend = new Spend(plan.budgetUsd, opts.signal);
  const say = opts.onProgress ?? (() => {});
  const notes = [...evals.notes];
  const report: SkillEvalReport = {
    version: 1, skill: name, model: opts.model, at: new Date().toISOString(), hash: '',
    budgetUsd: plan.budgetUsd, costUsd: 0, overBudget: false, complete: false, tasks: [],
    unchecked: evals.unchecked, notes,
  };
  say(describePlan(plan, opts.model));

  // 1. Triggering first: tuning may rewrite the description, and the hash is
  //    taken after it, so the report describes the files as they end up.
  if (opts.triggers !== false && evals.triggers.length) {
    const provider = await providerFor(opts.model, opts.settings, opts.provider);
    const split = splitTriggers(evals.triggers);
    const before = skill.frontmatter.description;
    let best = before;
    let outcomes = await runTriggers(provider, opts, spend, name, best, evals.triggers, split);
    const scoreOf = (os: TriggerOutcome[], side: 'train' | 'test') => scoreTriggers(os.filter(o => o.split === side));
    const candidates = [{ description: best, train: scoreOf(outcomes, 'train'), test: scoreOf(outcomes, 'test') }];
    say(`  triggers: held-out accuracy ${candidates[0]!.test.accuracy.toFixed(2)} with the current description`);

    const rounds = Math.max(0, Math.min(3, opts.descriptionRounds ?? 1));
    for (let round = 0; round < rounds; round++) {
      const incumbent = candidates.find(c => c.description === best)!;
      const misses = outcomes.filter(o => o.split === 'train' && o.shouldTrigger !== o.triggered);
      if (misses.length === 0) break;
      const proposed = await proposeDescription(provider, opts, spend, proposalPrompt(name, best, skill.promptTemplate, misses));
      if (!proposed || proposed === best) break;
      const tried = await runTriggers(provider, opts, spend, name, proposed, evals.triggers, split);
      if (tried.length < evals.triggers.length) break; // budget ran out mid-way: an unfair comparison
      const c = { description: proposed, train: scoreOf(tried, 'train'), test: scoreOf(tried, 'test') };
      candidates.push(c);
      say(`  triggers: candidate held-out accuracy ${c.test.accuracy.toFixed(2)}${beats(c.test, incumbent.test) ? ' (kept)' : ' (not better; discarded)'}`);
      if (beats(c.test, incumbent.test)) { best = proposed; outcomes = tried; }
    }

    if (best !== before) {
      fs.writeFileSync(file, updateFrontmatter(fs.readFileSync(file, 'utf8'), { description: best }), 'utf8');
      skill = parseSkillFile(fs.readFileSync(file, 'utf8'), file, false)!;
    }
    const heldOut = [scoreTriggers(outcomes.filter(o => o.split === 'test'))];
    const testQueries = evals.triggers.filter(q => split.get(q.query) === 'test');
    for (let run = 1; run < Math.max(1, Math.min(5, opts.triggerRuns ?? 1)); run++) {
      const again = await runTriggers(provider, opts, spend, name, best, testQueries, split);
      if (again.length < testQueries.length) break;
      heldOut.push(scoreTriggers(again));
    }
    const precisions = heldOut.map(h => h.precision).filter((p): p is number => p !== null);
    report.triggers = {
      description: best,
      train: scoreTriggers(outcomes.filter(o => o.split === 'train')),
      heldOut,
      ...(precisions.length > 1 ? { precisionSpread: { min: Math.min(...precisions), max: Math.max(...precisions) } } : {}),
      outcomes,
    };
    if (candidates.length > 1 || best !== before) {
      report.descriptionTuning = { before, after: best, changed: best !== before, candidates };
    }
    if (outcomes.length < evals.triggers.length) notes.push('Trigger scoring stopped early (budget).');
  }

  // 2. Tasks, paired: with the skill, then without, so a budget stop still
  //    leaves complete pairs rather than one finished arm and half of another.
  const baseline = opts.baseline !== false;
  const runOpts = {
    model: opts.model, settings: opts.settings, budgetUsd: Infinity,
    maxIterations: opts.maxIterations ?? 10,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  let ranAll = true;
  for (const task of evals.tasks) {
    const prompt = evals.prompts[task.id]!;
    const row: TaskComparison = { id: task.id, prompt };
    report.tasks.push(row);
    if (!spend.canSpend()) { ranAll = false; continue; }
    const withTask: EvalTask = { ...task, args: '' };
    const w = await runTask(withSkillText(name, skill.frontmatter.description, skill.promptTemplate, dir, prompt), withTask, runOpts);
    spend.costUsd += w.costUsd;
    row.with = arm(w);
    if (!baseline) { say(`  ${task.id}: with ${w.score.toFixed(2)}`); continue; }
    if (!spend.canSpend()) { ranAll = false; continue; }
    const wo = await runTask('{args}', { ...task, args: prompt }, runOpts);
    spend.costUsd += wo.costUsd;
    row.without = arm(wo);
    say(`  ${task.id}: with ${w.score.toFixed(2)} · without ${wo.score.toFixed(2)}`);
  }

  const paired = report.tasks.filter(t => t.with && (!baseline || t.without));
  const withMean = mean(paired.map(t => t.with!.score));
  const withoutMean = baseline ? mean(paired.map(t => t.without!.score)) : undefined;
  if (withMean !== undefined) report.withMean = withMean;
  if (withoutMean !== undefined) report.withoutMean = withoutMean;
  if (withMean !== undefined && withoutMean !== undefined) report.uplift = withMean - withoutMean;
  report.costUsd = spend.costUsd;
  report.overBudget = spend.overBudget;
  report.complete = ranAll && !spend.overBudget && !opts.signal?.aborted && evals.tasks.length > 0
    && (!report.triggers || report.triggers.outcomes.length === evals.triggers.length);
  if (evals.tasks.length === 0) notes.push('No scorable task: nothing was measured against the baseline.');
  report.hash = treeHash(dir);
  fs.writeFileSync(path.join(dir, REPORT_FILE), JSON.stringify(report, null, 2) + '\n', 'utf8');
  return report;
}
