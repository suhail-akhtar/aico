/**
 * Measuring a skill, and the shape of the evidence.
 *
 * A skill is a prompt. Whether it is a *good* prompt was, until now, a matter of
 * opinion — it shipped when it read well. SkillOpt's insight is that a skill can
 * be treated as a trainable parameter, and the precondition for training
 * anything is a score. This module defines what a score is made of.
 *
 * ## Graders are deterministic on purpose
 *
 * Every check here is a regex, a file, or a count. No LLM judge. A judge costs a
 * model call per task per step, drifts between runs, and — the real problem —
 * makes the optimiser's job "satisfy the judge" rather than "do the task". A
 * planted SQL injection either gets named or it does not, and that can be
 * decided without asking anyone.
 *
 * The cost is that only tasks with checkable outcomes can be in a corpus. That
 * is the right constraint: it is the same one SkillOpt runs under, and it is why
 * the built-in corpus covers the four shipped skills rather than free-form work.
 *
 * @module skills/eval/types
 */

export type Check =
  /** The skill's final reply matches. `why` is what a miss means, for the optimiser. */
  | { kind: 'output-matches'; pattern: string; flags?: string; weight?: number; why: string }
  /** The reply must *not* match — filler, apologies, hedging. */
  | { kind: 'output-lacks'; pattern: string; flags?: string; weight?: number; why: string }
  /** A file the skill was supposed to create. */
  | { kind: 'file-exists'; path: string; weight?: number; why: string }
  | { kind: 'file-matches'; path: string; pattern: string; flags?: string; weight?: number; why: string }
  /**
   * Nothing in the fixture changed.
   *
   * A review that "fixes" what it was asked to review has failed the task in
   * the way that matters most, and no output check would notice.
   */
  | { kind: 'no-file-changed'; weight?: number; why: string }
  /**
   * Efficiency is part of the score.
   *
   * A skill that finds every bug in forty tool calls is worse than one that
   * finds them in twelve, and an optimiser that only sees correctness will
   * happily add "read every file twice" to the prompt. This is the cost term.
   */
  | { kind: 'max-tool-calls'; limit: number; weight?: number; why: string };

export interface EvalTask {
  id: string;
  /** Which skill this exercises. */
  skill: string;
  /** Substituted for `{args}` in the skill body. */
  args?: string;
  /** Files to materialise in the scratch directory before the run. */
  files?: Record<string, string>;
  /**
   * Make the scratch directory a git repository.
   *
   * `baseline` files are committed first; `files` are then written and staged,
   * so a skill that reads `git diff --staged` sees exactly the change under
   * test and nothing else.
   */
  git?: { baseline?: Record<string, string> };
  checks: Check[];
  /**
   * Which side of the optimiser's split this task is on.
   *
   * Left unset, the split is decided by a hash of the id — stable across runs,
   * so a task does not drift between train and validation and quietly leak.
   */
  split?: 'train' | 'val';
}

export interface CheckResult {
  check: Check;
  passed: boolean;
}

export interface TaskResult {
  id: string;
  /** Weighted fraction of checks passed, 0..1. */
  score: number;
  checks: CheckResult[];
  /** The skill's final reply. */
  output: string;
  toolCalls: string[];
  costUsd: number;
  /** Set when the run itself failed — an exception, not a low score. */
  error?: string;
}

export interface EvalReport {
  skill: string;
  model: string;
  tasks: TaskResult[];
  /** Mean of task scores. The number the optimiser is trying to raise. */
  mean: number;
  costUsd: number;
  /** True when the budget ran out before every task was tried. */
  overBudget: boolean;
}
