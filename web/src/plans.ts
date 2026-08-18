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
export type PlanDecision = 'approved' | 'deferred' | 'declined' | undefined;

export interface PlanState {
  plan?: Plan;
  decision: PlanDecision;
}

/** Marker phrases the panel writes when the reader answers. Matched back on replay. */
export const PLAN_REPLY = {
  approved: 'Go ahead with that plan.',
  deferred: 'Keep that plan for later — do not start it now.',
  declined: 'Do not go ahead with that plan.',
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
    if (text.startsWith(PLAN_REPLY.approved)) decision = 'approved';
    else if (text.startsWith(PLAN_REPLY.deferred)) decision = 'deferred';
    else if (text.startsWith(PLAN_REPLY.declined)) decision = 'declined';
  }

  return { plan, decision };
}
