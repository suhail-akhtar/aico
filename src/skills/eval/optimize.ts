/**
 * Treating a skill as a trainable parameter, with the user as the last gate.
 *
 * This is SkillOpt's loop, sized for one person's account rather than a lab:
 *
 *   1. **Forward.** Run the training tasks with the current skill.
 *   2. **Backward.** A separate optimiser model reads the *failing* trajectories
 *      — what was asked, which checks missed and why, what the agent said and
 *      did — and proposes edits to the skill text.
 *   3. **Textual learning rate.** The proposal is bounded: at most `maxEdits`
 *      operations, each replacement at most `maxEditChars`, and the skill may not
 *      grow past `maxSkillChars`. An unbounded optimiser rewrites the whole prompt
 *      each step, and a whole-prompt rewrite can neither be reviewed nor reverted
 *      in part.
 *   4. **Gate.** The candidate runs the *validation* tasks — a disjoint set the
 *      optimiser never sees — and is kept only if it scores strictly higher than
 *      the current skill. Otherwise it goes into a rejected buffer that the
 *      optimiser is shown next time, so it does not propose the same thing twice.
 *
 * ## What this deliberately never does
 *
 * It never writes the shipped skill. The result is a *candidate* file for a
 * person to diff and adopt. Everything above is measurement against a corpus,
 * and a corpus is a proxy: a skill can score higher on six planted tasks and be
 * worse on the seventh nobody wrote. The strict gate makes regressions on the
 * proxy impossible; only a reader can judge the rest.
 *
 * ## Why the growth cap is a cost feature
 *
 * Every invocation of a skill pays for its length, on every turn, for ever. An
 * optimiser scored on correctness alone will add "also check X" indefinitely,
 * because each addition helps one task and costs nothing it can see. The cap is
 * where the token bill gets a vote. SkillOpt's own trained skills settle around
 * 900 tokens; the default here allows a third more than the starting length.
 *
 * @module skills/eval/optimize
 */

import type { AicoSettings } from '../../settings.js';
import type { ProviderAPI } from '../../providers/types.js';
import { assignSplits } from './corpus.js';
import { evalSkill, type RunOptions } from './run.js';
import type { EvalReport, EvalTask, TaskResult } from './types.js';

/** One proposed change. `find` must occur exactly once; empty `find` appends. */
export interface SkillEdit {
  find: string;
  replace: string;
  reason: string;
}

export interface EditBudget {
  /** Operations per step. */
  maxEdits: number;
  /** Characters in one replacement. */
  maxEditChars: number;
  /** Longest the skill may become, in characters. */
  maxSkillChars: number;
}

export interface RejectedProposal {
  step: number;
  edits: SkillEdit[];
  /** Why it was refused: worse on validation, or invalid. */
  because: string;
  valMean?: number;
}

export interface OptimizeStep {
  step: number;
  trainMean: number;
  /** With several candidates: the training score of the one that went to validation. */
  candidateTrainMean?: number;
  /** How many proposals were scored on training this step. */
  candidates?: number;
  proposed: SkillEdit[];
  /** Edits that could not be applied — `find` missing or ambiguous, over budget. */
  dropped: Array<{ edit: SkillEdit; because: string }>;
  valMean?: number;
  accepted: boolean;
  costUsd: number;
}

export interface OptimizeOptions extends Omit<RunOptions, 'onTask' | 'cache'> {
  /** How many propose–validate rounds. */
  steps: number;
  budget?: Partial<EditBudget>;
  /** The model that proposes edits. Defaults to the one being evaluated. */
  optimizerModel?: string;
  /** Injected for tests. */
  optimizer?: ProviderAPI;
  /**
   * Proposals per step. Each is scored on the training set and only the best
   * goes to validation, so the cost is `candidates × train` runs a step for one
   * validation run — a what-if over several ideas rather than a bet on one.
   * Default 1, which is the loop as first written.
   */
  candidates?: number;
  /**
   * Consecutive rejections before giving up. A loop that has proposed three
   * things in a row and moved nothing is not about to move something on the
   * fourth; the remaining budget is better left unspent.
   */
  patience?: number;
  onStep?: (step: OptimizeStep) => void;
  onTask?: (phase: 'train' | 'val', result: TaskResult) => void;
  /** What the loop is doing right now, in words, for a client to show. */
  onPhase?: (text: string) => void;
}

export interface OptimizeResult {
  skill: string;
  /** The starting skill's validation score. */
  baseline: EvalReport;
  /** The best skill found — the original if nothing beat it. */
  best: string;
  bestValMean: number;
  steps: OptimizeStep[];
  rejected: RejectedProposal[];
  costUsd: number;
  /** Stopped early: budget exhausted, or nothing left to fix on train. */
  stoppedBecause?: string;
}

export function defaultBudget(skillBody: string): EditBudget {
  return {
    maxEdits: 4,
    maxEditChars: 600,
    maxSkillChars: Math.max(2_000, Math.round(skillBody.length * 1.34)),
  };
}

/**
 * Apply a proposal within the budget, reporting what was refused and why.
 *
 * Pure, and the most important function to test without a model: every
 * guarantee the loop makes about bounded change is enforced here and nowhere
 * else.
 */
export function applyEdits(
  skill: string,
  edits: SkillEdit[],
  budget: EditBudget,
): { next: string; applied: SkillEdit[]; dropped: Array<{ edit: SkillEdit; because: string }> } {
  const applied: SkillEdit[] = [];
  const dropped: Array<{ edit: SkillEdit; because: string }> = [];
  let next = skill;

  for (const edit of edits) {
    if (applied.length >= budget.maxEdits) {
      dropped.push({ edit, because: `over the ${budget.maxEdits}-edit budget for one step` });
      continue;
    }
    if (typeof edit.replace !== 'string' || typeof edit.find !== 'string') {
      dropped.push({ edit, because: 'malformed — find and replace must be strings' });
      continue;
    }
    if (edit.replace.length > budget.maxEditChars) {
      dropped.push({ edit, because: `replacement is ${edit.replace.length} chars; the limit is ${budget.maxEditChars}` });
      continue;
    }

    let candidate: string;
    if (edit.find === '') {
      candidate = `${next.trimEnd()}\n\n${edit.replace.trim()}\n`;
    } else {
      const first = next.indexOf(edit.find);
      if (first === -1) { dropped.push({ edit, because: 'find text is not in the skill' }); continue; }
      if (next.indexOf(edit.find, first + edit.find.length) !== -1) {
        dropped.push({ edit, because: 'find text occurs more than once — ambiguous' });
        continue;
      }
      candidate = next.slice(0, first) + edit.replace + next.slice(first + edit.find.length);
    }

    if (candidate.length > budget.maxSkillChars) {
      dropped.push({ edit, because: `would grow the skill to ${candidate.length} chars; the cap is ${budget.maxSkillChars}` });
      continue;
    }
    next = candidate;
    applied.push(edit);
  }

  return { next, applied, dropped };
}

/**
 * What the optimiser is told.
 *
 * Failures only — a passing trajectory teaches nothing about what to change,
 * and including it doubles the prompt. Each failure carries the check that
 * missed *and its `why`*, which is the corpus author saying in plain words what
 * a miss means; that sentence is worth more than the transcript around it.
 */
export function buildProposalPrompt(
  skill: string,
  failures: Array<{ task: EvalTask; result: TaskResult }>,
  rejected: RejectedProposal[],
  budget: EditBudget,
  passing: readonly string[] = [],
): string {
  const lines: string[] = [];
  lines.push('You improve an AI agent\'s skill file. The file is a natural-language procedure the agent follows.');
  lines.push('Below are tasks it failed, with the specific checks that missed and why each one matters.');
  lines.push('');
  lines.push('## Current skill');
  lines.push('```markdown');
  lines.push(skill);
  lines.push('```');
  lines.push('');
  lines.push('## Failures');
  for (const { task, result } of failures) {
    lines.push(`### Task ${task.id} (score ${result.score.toFixed(2)})`);
    if (task.args) lines.push(`Arguments: ${task.args}`);
    if (result.error) lines.push(`The run crashed: ${result.error}`);
    lines.push('Missed checks:');
    for (const c of result.checks.filter(c => !c.passed)) lines.push(`- ${c.check.why}`);
    lines.push(`Tool calls (${result.toolCalls.length}): ${result.toolCalls.join(', ') || 'none'}`);
    lines.push('Final reply (tail):');
    lines.push('```');
    lines.push(result.output.slice(-1500));
    lines.push('```');
    lines.push('');
  }
  if (passing.length) {
    /*
      What must not break. An optimiser shown only failures will happily fix
      one task by rewriting the sentence another task depends on; naming the
      passing tasks is the cheapest way to say "and keep these".
    */
    lines.push('## Passing — do not break these');
    for (const id of passing) lines.push(`- ${id}`);
    lines.push('');
  }
  if (rejected.length) {
    lines.push('## Already tried and rejected — do not propose these again');
    for (const r of rejected.slice(-6)) {
      lines.push(`- Step ${r.step}: ${r.because}`);
      for (const e of r.edits) lines.push(`  - ${e.reason}`);
    }
    lines.push('');
  }
  lines.push('## Rules');
  lines.push(`- Propose at most ${budget.maxEdits} edits. Each replacement at most ${budget.maxEditChars} characters.`);
  lines.push(`- The whole skill must stay under ${budget.maxSkillChars} characters. Prefer sharpening an existing sentence over adding a new section.`);
  lines.push('- `find` must be an exact, unique substring of the current skill. Use an empty `find` to append.');
  lines.push('- Fix the *cause* of a miss, not its symptom: do not add the planted file names or the expected words.');
  lines.push('- Reply with a JSON array only: [{"find": "...", "replace": "...", "reason": "..."}]');
  return lines.join('\n');
}

/** Pull the first JSON array out of a reply that may have prose around it. */
export function parseProposal(text: string): SkillEdit[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
      .map(e => ({
        find: typeof e.find === 'string' ? e.find : '',
        replace: typeof e.replace === 'string' ? e.replace : '',
        reason: typeof e.reason === 'string' ? e.reason : '',
      }));
  } catch {
    return [];
  }
}

async function propose(
  prompt: string,
  model: string,
  settings: AicoSettings,
  injected?: ProviderAPI,
): Promise<string> {
  let provider = injected;
  if (!provider) {
    // Imported here for the same reason the title service does it: the provider
    // registry pulls in every adapter, and a CLI that never optimises should
    // not load them.
    const { selectProvider } = await import('../../providers/index.js');
    provider = selectProvider(model, settings);
  }
  let text = '';
  for await (const event of provider.chat({
    model,
    systemPrompt: 'You edit prompts precisely and reply with JSON only.',
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    maxTokens: 2_000,
  })) {
    if (event.type === 'text') text += event.content;
  }
  return text;
}

export async function optimizeSkill(
  skill: string,
  skillBody: string,
  tasks: readonly EvalTask[],
  opts: OptimizeOptions,
): Promise<OptimizeResult> {
  const budget = { ...defaultBudget(skillBody), ...opts.budget };
  const sides = assignSplits(tasks);
  const train = tasks.filter(t => sides.get(t.id) === 'train');
  const val = tasks.filter(t => sides.get(t.id) === 'val');
  const steps: OptimizeStep[] = [];
  const rejected: RejectedProposal[] = [];
  const candidates = Math.max(1, Math.floor(opts.candidates ?? 1));
  const patience = Math.max(1, Math.floor(opts.patience ?? 3));
  /*
    One cache for the whole optimisation. Every (skill text, task) pair is
    paid for once: the training set after a rejected step, the validation set
    for a candidate identical to one already scored, the baseline that a later
    step happens to reproduce. Without it the loop's cost grew with the number
    of ideas that did not work, which is most of them.
  */
  const cache = new Map<string, TaskResult>();
  let costUsd = 0;
  const remaining = (): number => Math.max(0, opts.budgetUsd - costUsd);
  const say = (text: string): void => opts.onPhase?.(text);

  const run = (body: string, set: readonly EvalTask[], phase: 'train' | 'val'): Promise<EvalReport> =>
    evalSkill(skill, body, set, {
      model: opts.model,
      settings: opts.settings,
      budgetUsd: remaining(),
      cache,
      ...(opts.maxIterations ? { maxIterations: opts.maxIterations } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onTask: r => opts.onTask?.(phase, r),
    });

  /*
    A validation set is not optional. Without one every proposal would be
    judged on the tasks it was written from, which is the definition of
    overfitting — and with a six-task corpus the optimiser could trivially
    special-case each one.
  */
  if (val.length === 0 || train.length === 0) {
    throw new Error(
      `optimising ${skill} needs both training and validation tasks; `
      + `have ${train.length} train and ${val.length} val. Add tasks or set "split" on them.`,
    );
  }

  say('baseline on validation');
  const baseline = await run(skillBody, val, 'val');
  costUsd += baseline.costUsd;
  let best = skillBody;
  let bestValMean = baseline.mean;
  let stoppedBecause: string | undefined;
  let rejectedInARow = 0;

  for (let step = 1; step <= opts.steps; step += 1) {
    if (opts.signal?.aborted) { stoppedBecause = 'cancelled'; break; }
    if (remaining() <= 0) { stoppedBecause = 'budget exhausted'; break; }
    if (rejectedInARow >= patience) { stoppedBecause = `${patience} rejections in a row`; break; }

    say(`step ${step}: training set`);
    const trainReport = await run(best, train, 'train');
    costUsd += trainReport.costUsd;
    if (trainReport.overBudget) { stoppedBecause = 'budget exhausted during training'; break; }
    if (opts.signal?.aborted) { stoppedBecause = 'cancelled'; break; }

    const failures = trainReport.tasks
      .filter(r => r.score < 1)
      .map(r => ({ task: train.find(t => t.id === r.id)!, result: r }));
    const passing = trainReport.tasks.filter(r => r.score === 1).map(r => r.id);
    if (failures.length === 0) { stoppedBecause = 'every training task already passes'; break; }

    /*
      Several ideas, one bet. Each candidate is scored on the training set —
      cheap when it repeats a prior candidate, thanks to the cache — and only
      the best goes on to validation. With one candidate this is exactly the
      original loop.
    */
    const scored: Array<{ next: string; applied: SkillEdit[]; dropped: OptimizeStep['dropped']; trainMean: number }> = [];
    const allProposed: SkillEdit[] = [];
    for (let c = 1; c <= candidates; c += 1) {
      if (opts.signal?.aborted) break;
      say(candidates > 1 ? `step ${step}: proposing ${c} of ${candidates}` : `step ${step}: proposing edits`);
      const text = await propose(
        buildProposalPrompt(best, failures, rejected, budget, passing),
        opts.optimizerModel ?? opts.model,
        opts.settings,
        opts.optimizer,
      );
      const proposed = parseProposal(text);
      allProposed.push(...proposed);
      const { next, applied, dropped } = applyEdits(best, proposed, budget);
      if (applied.length === 0 || next === best) continue;
      if (scored.some(sc => sc.next === next)) continue;

      let trainMean = trainReport.mean;
      if (candidates > 1) {
        say(`step ${step}: scoring candidate ${c} on training`);
        const report = await run(next, train, 'train');
        costUsd += report.costUsd;
        trainMean = report.mean;
        if (report.overBudget) { stoppedBecause = 'budget exhausted while scoring candidates'; break; }
      }
      scored.push({ next, applied, dropped, trainMean });
    }
    if (stoppedBecause) break;

    if (scored.length === 0) {
      const because = allProposed.length === 0
        ? 'the optimiser returned no usable edits'
        : 'every proposed edit was outside the budget or did not match the skill';
      rejected.push({ step, edits: allProposed, because });
      rejectedInARow += 1;
      const record: OptimizeStep = {
        step, trainMean: trainReport.mean, candidates: candidates,
        proposed: allProposed, dropped: [], accepted: false, costUsd: trainReport.costUsd,
      };
      steps.push(record);
      opts.onStep?.(record);
      continue;
    }

    scored.sort((a, b) => b.trainMean - a.trainMean);
    const pick = scored[0]!;

    say(`step ${step}: validating`);
    const valReport = await run(pick.next, val, 'val');
    costUsd += valReport.costUsd;

    /*
      Strictly greater. Equal is a rejection: an edit that changes nothing on
      validation has bought length for no measured gain, and length is paid for
      on every future invocation.
    */
    const accepted = !valReport.overBudget && valReport.mean > bestValMean;
    if (accepted) {
      best = pick.next;
      bestValMean = valReport.mean;
      rejectedInARow = 0;
    } else {
      rejectedInARow += 1;
      rejected.push({
        step,
        edits: pick.applied,
        because: valReport.overBudget
          ? 'validation could not finish within budget'
          : `validation ${valReport.mean.toFixed(2)} did not beat ${bestValMean.toFixed(2)}`,
        valMean: valReport.mean,
      });
    }

    const record: OptimizeStep = {
      step,
      trainMean: trainReport.mean,
      ...(candidates > 1 ? { candidateTrainMean: pick.trainMean, candidates: scored.length } : {}),
      proposed: pick.applied,
      dropped: pick.dropped,
      valMean: valReport.mean,
      accepted,
      costUsd: trainReport.costUsd + valReport.costUsd,
    };
    steps.push(record);
    opts.onStep?.(record);
    if (valReport.overBudget) { stoppedBecause = 'budget exhausted during validation'; break; }
  }

  if (!stoppedBecause && rejectedInARow >= patience) stoppedBecause = `${patience} rejections in a row`;
  say(stoppedBecause ? `stopped: ${stoppedBecause}` : 'finished');

  return {
    skill, baseline, best, bestValMean, steps, rejected, costUsd,
    ...(stoppedBecause ? { stoppedBecause } : {}),
  };
}
