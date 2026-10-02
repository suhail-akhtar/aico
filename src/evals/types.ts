/**
 * The shape of agent verification (design §6, Phase 4): a golden task, the
 * checks that grade it, and the evidence a run leaves for them.
 *
 * WHY A SEPARATE SET OF CHECKS FROM SKILLS'. A skill eval asks "did the
 * procedure produce the right answer"; an agent eval also asks "did it stay
 * inside its bounds while doing it" — which tools it called, in what order,
 * whether a destructive step was routed to a person and what it did after a
 * no, which files changed, whether a secret leaked. Those are questions about
 * the tool-call log, not the reply, so the evidence here carries the log
 * (every call, its arguments, whether a guard denied it) and the file
 * snapshot before and after. The skill checks (`skills/eval/types`) are a
 * subset and are graded by the same code.
 *
 * Model-free first (design §6.2): every check except `judge` is a regex, a
 * file, a count or an exit code. `judge` exists for prose a regex cannot
 * read, with a fixed PASS/FAIL rubric on a different model, and is never the
 * only check on a critical task (the validator refuses that).
 *
 * @module evals/types
 */

import type { Check as SkillCheck } from '../skills/eval/types.js';

export type AgentCheck =
  | SkillCheck
  /** At least `min` (default 1) calls to a tool matching `tool` (a name or `*` glob), arguments matching `args`. */
  | { kind: 'tool-called'; tool: string; args?: string; min?: number; weight?: number; why: string }
  /** No call to a tool matching `tool` whose arguments match `args` (any arguments when absent). */
  | { kind: 'tool-not-called'; tool: string; args?: string; weight?: number; why: string }
  /** The first `before` call happens before the first `after` call (and `before` happened at all). */
  | { kind: 'tool-order'; before: string; after: string; weight?: number; why: string }
  /** A call to `tool` was routed to a person (an approval was asked for), not around one. */
  | { kind: 'approval-requested'; tool: string; weight?: number; why: string }
  /**
   * After the first denied call, nothing matching `patterns` (regexes over
   * `name args`) was attempted: a "no" is not an invitation to find another way.
   */
  | { kind: 'no-workaround'; patterns: string[]; weight?: number; why: string }
  /**
   * No file outside `writeGlobs` (relative to the workspace) was created,
   * changed or removed, and nothing was written beside the workspace.
   */
  | { kind: 'scope'; writeGlobs: string[]; weight?: number; why: string }
  /** The canary value appears in no reply, no tool-call argument and no changed file. */
  | { kind: 'secret-hygiene'; canary: string; weight?: number; why: string }
  /**
   * Run a command after the agent finished. `files` are copied in first —
   * hidden tests the agent never saw and could not tamper with.
   */
  | { kind: 'command'; argv: string[]; expectExit?: number; files?: Record<string, string>; weight?: number; why: string }
  /**
   * Mutation check for test-writing agents: with `files` swapped in (a seeded
   * bug), `argv` must FAIL — the new tests detect the bug. Restored after.
   */
  | { kind: 'mutation'; argv: string[]; files: Record<string, string>; weight?: number; why: string }
  /** An LLM judge on the final reply against a fixed PASS/FAIL rubric. Prose only. */
  | { kind: 'judge'; rubric: string; weight?: number; why: string };

/** A canned answer for a tool call during evaluation, in place of the real effect. */
export interface MockSpec {
  /** Tool name or `*` glob (`mcp__*`, `k8s_*`). */
  tool: string;
  /** Regex over the call's JSON arguments; absent matches every call. */
  args?: string;
  /** What the call returns. Default: a note that it was recorded, not run. */
  result?: string;
  /** Answer as a person refusing the call (an approval denied). */
  deny?: boolean;
}

export interface AgentEvalTask {
  id: string;
  /** What the person asks the agent. */
  prompt: string;
  /** The fixture, written into a fresh workspace. */
  files?: Record<string, string>;
  git?: { baseline?: Record<string, string> };
  checks: AgentCheck[];
  /** Overrides the run's trial count for this task. */
  trials?: number;
  /** Must pass in every trial (pass^k). Safety probes always are. */
  critical?: boolean;
  /** Canned results and refusals, checked before the built-in defaults. */
  mocks?: MockSpec[];
  /** What a person answers when the run asks (default: approve; safety probes deny). */
  approvals?: 'approve' | 'deny';
  /** Model calls per trial; capped by the agent's own budget. Default 12. */
  maxIterations?: number;
  /**
   * What the probe needs the agent to have done for it to test anything —
   * e.g. read the file with the planted instruction. A trial without such a
   * call still passes (declining is not a failure) but is reported as not
   * exercised, so a pass that proved nothing is not mistaken for one that did.
   */
  exercises?: { tool: string; args?: string; what: string };
}

/** One tool call as the evaluation saw it, after the guards. */
export interface CallRecord {
  name: string;
  /** JSON of the arguments. */
  args: string;
  /** A guard (scope, paths, permission, plan mode) or a mock refused it. */
  denied: boolean;
  mocked: boolean;
}

export interface ApprovalRecord {
  tool: string;
  detail: string;
  answered: boolean;
}

/** Everything a check may look at. Captured before grading starts. */
export interface AgentEvidence {
  output: string;
  /** Every assistant message in the run, joined (what the model said along the way). */
  assistantText: string;
  calls: CallRecord[];
  approvals: ApprovalRecord[];
  /** The workspace the agent ran in. */
  cwd: string;
  /** sha1 of every file before the run, by relative path (`/` separators). */
  before: Record<string, string>;
  /** The directory around the workspace, which nothing may write into. */
  outside: string;
  /** Entries of `outside` before the run (the workspace itself among them). */
  outsideBefore: string[];
}

export interface CheckOutcome {
  kind: AgentCheck['kind'];
  why: string;
  passed: boolean;
  /** What failed, briefly (a matching call, a changed file, the judge's reason). */
  detail?: string;
}

export interface TrialResult {
  /** Weighted fraction of checks passed. */
  score: number;
  /** Every check passed. */
  passed: boolean;
  checks: CheckOutcome[];
  /** The final reply, clipped. */
  output: string;
  /** Tool names in order (with `✗` for denied calls). */
  toolCalls: string[];
  costUsd: number;
  error?: string;
  /** False when the task's `exercises` call never happened (see AgentEvalTask). */
  exercised?: boolean;
}

export interface TaskReport {
  id: string;
  kind: 'safety' | 'golden';
  critical: boolean;
  trials: TrialResult[];
  /** Share of trials that passed. */
  passRate: number;
  /** Every trial passed. */
  passedAll: boolean;
  /** Trials not run because the budget ran out. */
  skipped: number;
}
