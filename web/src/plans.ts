/**
 * The plan on the table, derived from the transcript.
 *
 * Same shape as the task list: `ProposePlan` carries the whole plan in its
 * arguments, so the current proposal is the last one that went past. No
 * endpoint, no second source that can disagree with the conversation.
 *
 * A plan also has an *answer*, and the answer belongs in the log for the same
 * reason the plan does — reopening the session should show what was decided,
 * not an untouched proposal. The decision is recorded as a message, which the
 * transcript already carries, so a plan approved yesterday still reads as
 * approved today.
 *
 * @module plans
 */

import type { ChatMessage } from '@aico/ui';

export interface PlanStep {
  title: string;
  detail?: string;
  touches?: string[];
}

export interface Plan {
  title: string;
  steps: PlanStep[];
  risks: string[];
  openQuestions: string[];
  /** Log seq of the proposal, so a later decision can be matched to it. */
  seq: number;
}

/** What was said about a plan after it was proposed. */
/**
 * How a plan ended.
 *
 * `cancelled` and `completed` are separate from `declined` because they can
 * follow approval — a plan can be agreed to and then called off, or agreed to
 * and finished, and neither is the same as having refused it.
 */
export type PlanDecision =
  | 'approved' | 'deferred' | 'declined' | 'cancelled' | 'completed' | undefined;

export interface PlanState {
  plan?: Plan;
  decision: PlanDecision;
}

/**
 * What the reader's answer says, verbatim.
 *
 * These are the messages the panel sends and the phrases it matches back on
 * replay, so they are defined once. Changing one silently un-decides every plan
 * already in a log, which is why they live here rather than being written out
 * at each call site.
 */
export const PLAN_REPLY = {
  approved: 'Go ahead with that plan.',
  deferred: 'Keep that plan for later — do not start it now.',
  declined: 'Do not go ahead with that plan.',
  /** A deferred plan, picked up later. The same outcome as approving it. */
  startNow: 'Start that plan now, the one saved for later.',
  /**
   * The frame the composer is pre-filled with.
   *
   * An amendment has to read as an amendment. "About that plan — " left the
   * agent to infer whether it was being corrected, questioned, or chatted with,
   * and the three call for different next moves.
   */
  amendPrefix: 'Amend that plan before we start: ',
  /**
   * Called off, whether or not it was approved.
   *
   * Distinct from declining, which answers a plan that was never started.
   * This one has to survive having already been agreed to, so it says the
   * plan no longer applies rather than that it was refused — an agent told
   * "do not go ahead" halfway through work it already began has to reconcile
   * two contradictory instructions, and reconciling is where it guesses.
   */
  cancelled: 'Cancel that plan — it no longer applies. Do not continue with it, and do not '
    + 'treat its steps as outstanding work.',
  /** Everything on it is done, so nothing is owed. */
  completed: 'That plan is finished — treat every step on it as complete. Nothing from it is '
    + 'outstanding.',
} as const;

function readStep(raw: unknown): PlanStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.title !== 'string' || !s.title.trim()) return undefined;
  return {
    title: s.title,
    ...(typeof s.detail === 'string' && s.detail ? { detail: s.detail } : {}),
    ...(Array.isArray(s.touches)
      ? { touches: s.touches.filter((t): t is string => typeof t === 'string') }
      : {}),
  };
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * The plan currently on the table, and what was said about it.
 *
 * Read backwards to the newest proposal; anything the reader said *after* that
 * point is the answer to it. A decision recorded before the latest proposal
 * belongs to an older plan and must not be carried forward — otherwise a
 * revised plan would arrive pre-approved.
 */
export function planFrom(messages: ChatMessage[]): PlanState {
  let plan: Plan | undefined;
  let proposedAt = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.type !== 'tool' || message.toolName !== 'ProposePlan') continue;
    const args = message.toolArgs as Record<string, unknown> | undefined;
    const steps = Array.isArray(args?.steps)
      ? args.steps.map(readStep).filter((s): s is PlanStep => s !== undefined)
      : [];
    if (steps.length === 0) continue;
    plan = {
      title: typeof args?.title === 'string' ? args.title : 'Proposed plan',
      steps,
      risks: strings(args?.risks),
      openQuestions: strings(args?.open_questions),
      seq: i,
    };
    proposedAt = i;
    break;
  }

  if (!plan) return { decision: undefined };

  let decision: PlanDecision;
  for (let i = proposedAt + 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.type !== 'user') continue;
    const text = message.content.trim();
    // startNow resolves to approved: a plan picked up later is a plan that was
    // agreed to, and the panel should not go on offering to start something
    // already running.
    if (text.startsWith(PLAN_REPLY.approved) || text.startsWith(PLAN_REPLY.startNow)) {
      decision = 'approved';
    } else if (text.startsWith(PLAN_REPLY.cancelled)) decision = 'cancelled';
    else if (text.startsWith(PLAN_REPLY.completed)) decision = 'completed';
    else if (text.startsWith(PLAN_REPLY.deferred)) decision = 'deferred';
    else if (text.startsWith(PLAN_REPLY.declined)) decision = 'declined';
    else if (text.startsWith(PLAN_REPLY.amendPrefix)) {
      // An amendment un-decides the plan: the agent is revising it, so the panel
      // waits rather than showing a stale answer to a plan being rewritten.
      decision = undefined;
    }
  }

  return { plan, decision };
}
