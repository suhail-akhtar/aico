/**
 * What the remote's pipeline adds to a task's risk (ADR 0039 section 2, point 6).
 *
 * `delivery/risk.ts` scores the DIFF at review time. Once a pull request exists the remote
 * knows more: whether its required checks pass, whether the reviews it requires are in, whether
 * it still conflicts with its base. Those become reasons on the same score, with the same rule
 * as the original: every signal only ever ADDS risk, nothing subtracts, and "no remote checks
 * configured" is a reason (there is no gate), never a credit.
 *
 * The reasons carry their own points as a `(+N)` suffix so the base score can be recovered
 * exactly (`withoutRemote`) when the observation changes; that keeps this a pure function of
 * the PR and the previous risk, with no extra field in the shared contract.
 *
 * Pure: no network, no clock.
 *
 * @module connections/pr-risk
 */

import type { PullState } from '../../shared/connections/types.js';
import type { Task } from '../../shared/delivery/types.js';

const REMOTE = /^Remote /;
const POINTS = /\(\+(\d+)\)$/;

export function remoteRiskReasons(pr: PullState): string[] {
  const out: string[] = [];
  const failing = pr.checks.items.filter(c => c.state === 'failure').map(c => c.name);
  if (pr.checks.state === 'failing') out.push(`Remote checks failed: ${failing.slice(0, 4).join(', ') || 'see the pull request'} (+25)`);
  else if (pr.checks.state === 'pending') out.push('Remote checks are still running (+10)');
  else if (pr.checks.state === 'none') out.push('Remote has no checks configured for this pull request: no automatic gate (+0)');
  if (pr.reviews.changesRequested > 0 || pr.reviews.state === 'changes') out.push('Remote: a reviewer requested changes (+15)');
  else if (pr.reviews.required !== undefined && pr.reviews.approved < pr.reviews.required) {
    out.push(`Remote required reviews missing: ${pr.reviews.approved} of ${pr.reviews.required} (+10)`);
  }
  if (pr.mergeable === 'conflicting') out.push('Remote: the pull request conflicts with its base branch (+25)');
  if (pr.protectedBase) out.push('Remote: the target branch is protected (+0)');
  return out.map(r => (REMOTE.test(r) ? r : `Remote ${r.charAt(0).toLowerCase()}${r.slice(1)}`));
}

const pointsOf = (reason: string): number => Number(POINTS.exec(reason)?.[1] ?? 0);

/** The risk without any remote reasons it was previously given. */
export function withoutRemote(risk: NonNullable<Task['risk']>): { score: number; reasons: string[] } {
  const remote = risk.reasons.filter(r => REMOTE.test(r));
  return { score: Math.max(0, risk.score - remote.reduce((n, r) => n + pointsOf(r), 0)), reasons: risk.reasons.filter(r => !REMOTE.test(r)) };
}

/** `levelOf` is passed in so this module stays free of the Delivery service's imports. */
export function applyRemoteRisk(
  risk: Task['risk'] | undefined, pr: PullState, levelOf: (score: number) => 'low' | 'medium' | 'high',
): NonNullable<Task['risk']> {
  const base = risk ? withoutRemote(risk) : { score: 0, reasons: [] as string[] };
  const add = remoteRiskReasons(pr);
  const score = Math.min(100, base.score + add.reduce((n, r) => n + pointsOf(r), 0));
  return { score, level: levelOf(score), reasons: [...base.reasons, ...add] };
}
