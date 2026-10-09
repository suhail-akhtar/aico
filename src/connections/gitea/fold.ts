/**
 * Gitea's (and Forgejo's) wire shapes folded into the normalised `PullState` / `RemoteCheck` /
 * `RemoteItem`. The two servers share this API; where they differ the adapter probes, this
 * module does not branch on the name.
 *
 * WHY separate and pure. Gitea has no single "can I merge this?" word like GitHub's
 * `mergeable_state` or GitLab's `detailed_merge_status`, so the verdict is assembled here from
 * what it does say, and every rule is table-tested without a server
 * (scripts/connections-gitea-test.mjs):
 *
 *  - **`mergeable: false` is three things.** A conflict, an error, or "still being checked"
 *    all serialise as `false`. A conflict is reported only once the pull request has sat for two
 *    minutes since its last update (checking takes seconds); before that it is `unknown`. The
 *    rejected alternative, always `conflicting`, would send a fresh pull request back to the
 *    agent to "resolve" a conflict that does not exist and spend a run on it.
 *  - **`canMerge` is conservative on purpose.** It needs `mergeable === true`, not a draft, no
 *    requested changes, no review still awaited, and every check it can see finished and green.
 *    Gitea enforces its own protection when asked to merge, so a token that cannot read the
 *    protection (admin only) simply gets Gitea's refusal in the person's words; the cost of the
 *    conservative reading is that merging over a red or running check is done on Gitea.
 *  - **Reviews feed the fold GitHub uses**, so "changes outrank approvals" and "a dismissed
 *    review is erased" mean the same here. An approval that is not `official` (the reviewer may
 *    not approve under the branch's rules) counts for nothing.
 *  - **Statuses are the checks.** Gitea/Forgejo Actions report as commit statuses; the field is
 *    `status` (not `state`), `warning` is not a gate and `skipped` is not a failure. No statuses
 *    is `none`, never `passing`.
 *
 * Every string a stranger could have written is sanitised here on the way out.
 *
 * What it does not do: make requests, or decide to merge.
 *
 * @module connections/gitea/fold
 */

import type { CheckState, PullState, RemoteCheck } from '../../../shared/connections/types.js';
import type { Comment, ProtectionInfo, RemoteItem } from '../adapter.js';
import { checkState, foldReviews, pointsFromLabels, safeUrl } from '../github/fold.js';
import { REMOTE_LIMITS, sanitizeLine, sanitizeRemoteText } from '../sanitize.js';

export interface RawUser { id?: number; login?: string; username?: string }
export interface RawPull {
  number: number;
  html_url?: string;
  state?: string;
  title?: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  mergeable?: boolean;
  head?: { sha?: string; ref?: string };
  base?: { ref?: string };
  requested_reviewers?: unknown[] | null;
  created_at?: string;
  updated_at?: string;
}
export interface RawReview { id?: number; user?: RawUser | null; state?: string; body?: string | null; submitted_at?: string; dismissed?: boolean; official?: boolean; html_url?: string }
export interface RawStatus { status?: string; context?: string; description?: string | null; target_url?: string | null }
export interface RawIssue {
  number: number; title?: string; body?: string | null; state?: string; labels?: Array<{ name?: string } | string> | null;
  assignees?: RawUser[] | null; assignee?: RawUser | null; user?: RawUser | null; html_url?: string; updated_at?: string;
  milestone?: { id?: number; title?: string; due_on?: string | null } | null;
  pull_request?: unknown;
}
export interface RawComment { id?: number; user?: RawUser | null; body?: string | null; created_at?: string; html_url?: string }

const login = (u: RawUser | null | undefined): string => sanitizeLine(u?.login ?? u?.username, 80);

// ── checks ───────────────────────────────────────────────────────────────

export function foldStatus(s: RawStatus): RemoteCheck {
  const v = (s.status ?? '').toLowerCase();
  const state: RemoteCheck['state'] = v === 'success' ? 'success'
    : v === 'pending' ? 'pending'
      : v === 'failure' || v === 'error' ? 'failure'
        : v === 'skipped' ? 'skipped'
          : 'neutral'; // warning, and whatever a later version adds: informational, not a gate
  const summary = sanitizeRemoteText(s.description ?? '', REMOTE_LIMITS.summary);
  const url = safeUrl(s.target_url);
  return { name: sanitizeLine(s.context, REMOTE_LIMITS.title) || '(unnamed status)', state, ...(url ? { url } : {}), ...(summary ? { summary } : {}) };
}

export function foldChecks(statuses: RawStatus[]): { state: CheckState; items: RemoteCheck[] } {
  const items = statuses.map(foldStatus);
  return { state: checkState(items), items };
}

// ── reviews ──────────────────────────────────────────────────────────────

/** Gitea's review states in the vocabulary of the shared fold. A dismissed review is erased; a not-official approval counts for nothing. */
export function foldPullReviews(reviews: RawReview[], requestedCount: number, required: number | undefined): PullState['reviews'] {
  const mapped = reviews.map(r => {
    const who = r.user ? { login: login(r.user) } : null;
    let state: string | undefined;
    if (r.dismissed === true) state = 'DISMISSED';
    else if (r.state === 'APPROVED') state = r.official === false ? 'COMMENTED' : 'APPROVED';
    else if (r.state === 'REQUEST_CHANGES') state = 'CHANGES_REQUESTED';
    else if (r.state === 'COMMENT') state = 'COMMENTED';
    return { ...(r.id !== undefined ? { id: r.id } : {}), user: who, ...(state ? { state } : {}) };
  });
  return foldReviews(mapped, requestedCount, required);
}

// ── merge verdict ────────────────────────────────────────────────────────

/** How long a `mergeable: false` is read as "still being checked" rather than "conflicts". */
export const CHECKING_GRACE_MS = 120_000;

export function foldState(pr: Pick<RawPull, 'state' | 'merged' | 'merged_at'>): PullState['state'] {
  if (pr.merged === true || (pr.merged === undefined && !!pr.merged_at)) return 'merged';
  return pr.state === 'closed' ? 'closed' : 'open';
}

export function isDraft(pr: Pick<RawPull, 'draft' | 'title'>): boolean {
  return pr.draft === true || /^\s*(?:\[WIP\]|WIP:|\[DRAFT\]|DRAFT:)/i.test(pr.title ?? '');
}

export function foldMergeable(pr: Pick<RawPull, 'state' | 'merged' | 'merged_at' | 'mergeable' | 'updated_at' | 'created_at'>, nowMs: number): PullState['mergeable'] {
  if (foldState(pr) !== 'open') return 'unknown';
  if (pr.mergeable === true) return 'mergeable';
  if (pr.mergeable === false) {
    const since = Date.parse(pr.updated_at ?? pr.created_at ?? '');
    return Number.isFinite(since) && nowMs - since > CHECKING_GRACE_MS ? 'conflicting' : 'unknown';
  }
  return 'unknown';
}

export function foldCanMerge(pr: RawPull, reviews: PullState['reviews'], checks: PullState['checks'], protection: ProtectionInfo | undefined): boolean {
  if (foldState(pr) !== 'open' || isDraft(pr) || pr.mergeable !== true) return false;
  if (reviews.state === 'changes' || reviews.state === 'pending') return false;
  if (protection && !protection.unreadable && protection.protected && protection.requiredReviews !== undefined && reviews.approved < protection.requiredReviews) return false;
  return checks.state === 'none' || checks.state === 'passing';
}

export function foldBlockers(
  pr: RawPull, mergeable: PullState['mergeable'], checks: PullState['checks'], reviews: PullState['reviews'], protection: ProtectionInfo | undefined,
): string[] {
  if (foldState(pr) !== 'open') return [];
  const out: string[] = [];
  if (isDraft(pr)) out.push('The pull request is a draft.');
  if (mergeable === 'conflicting') out.push('The branch has conflicts with the base branch.');
  else if (mergeable === 'unknown') out.push('The server has not said this can be merged yet: it may still be checking, or there may be conflicts.');
  if (reviews.changesRequested > 0) out.push('A reviewer has requested changes.');
  else if (reviews.state === 'pending') out.push(reviews.required !== undefined && reviews.required > 0 ? `${reviews.approved} of ${reviews.required} required approvals.` : 'A requested review has not been given yet.');
  else if (protection && !protection.unreadable && protection.protected && protection.requiredReviews !== undefined && reviews.approved < protection.requiredReviews) {
    out.push(`${reviews.approved} of ${protection.requiredReviews} required approvals.`);
  }
  for (const c of checks.items) if (c.state === 'failure') out.push(`Check failed: ${c.name}`);
  if (checks.state === 'pending') out.push('Checks are still running.');
  return [...new Set(out)];
}

export interface FoldPullInput {
  connection: string;
  pr: RawPull;
  statuses: RawStatus[];
  reviews: RawReview[];
  protection?: ProtectionInfo | undefined;
  /** Epoch ms; injectable so the two-minute grace is testable. */
  nowMs?: number;
  now?: string;
}

export function foldPull(i: FoldPullInput): PullState {
  const { pr } = i;
  const nowMs = i.nowMs ?? Date.now();
  const state = foldState(pr);
  const checks = foldChecks(i.statuses);
  const readable = i.protection && !i.protection.unreadable ? i.protection : undefined;
  const required = readable?.protected ? readable.requiredReviews : undefined;
  const reviews = foldPullReviews(i.reviews, pr.requested_reviewers?.length ?? 0, required);
  const mergeable = foldMergeable(pr, nowMs);
  return {
    connection: i.connection,
    id: String(pr.number),
    url: safeUrl(pr.html_url) ?? '',
    state,
    draft: isDraft(pr),
    headSha: pr.head?.sha ?? '',
    mergeable,
    checks,
    reviews,
    canMerge: foldCanMerge(pr, reviews, checks, readable),
    mergeBlockers: foldBlockers(pr, mergeable, checks, reviews, readable),
    ...(readable ? { protectedBase: readable.protected } : {}),
    ...(state === 'merged' && pr.merge_commit_sha ? { mergedSha: pr.merge_commit_sha } : {}),
    observedAt: i.now ?? new Date(nowMs).toISOString(),
  };
}

// ── issues and comments ──────────────────────────────────────────────────

export function foldItem(i: RawIssue): RemoteItem {
  const labels = (i.labels ?? []).map(l => sanitizeLine(typeof l === 'string' ? l : l.name, REMOTE_LIMITS.label)).filter(Boolean);
  const people = i.assignees?.length ? i.assignees : i.assignee ? [i.assignee] : [];
  const ms = i.milestone;
  const points = pointsFromLabels(labels);
  return {
    id: String(i.number),
    number: i.number,
    title: sanitizeLine(i.title, REMOTE_LIMITS.title),
    body: sanitizeRemoteText(i.body ?? '', REMOTE_LIMITS.body),
    state: i.state === 'closed' ? 'closed' : 'open',
    labels,
    assignees: people.map(login).filter(Boolean),
    author: login(i.user),
    url: safeUrl(i.html_url) ?? '',
    rev: i.updated_at ?? '',
    ...(ms && ms.id !== undefined ? { milestone: { id: String(ms.id), title: sanitizeLine(ms.title, REMOTE_LIMITS.title), ...(ms.due_on ? { dueOn: ms.due_on } : {}) } } : {}),
    ...(points !== undefined ? { points } : {}),
    ...(ms && ms.id !== undefined ? { iteration: String(ms.id) } : {}),
  };
}

export function foldComment(c: RawComment, association: string): Comment {
  const url = safeUrl(c.html_url);
  return {
    id: String(c.id ?? ''),
    author: login(c.user),
    association,
    body: sanitizeRemoteText(c.body ?? '', REMOTE_LIMITS.comment),
    at: c.created_at ?? '',
    ...(url ? { url } : {}),
  };
}

export function foldReviewComment(r: RawReview, association: string): Comment | undefined {
  if (r.dismissed === true) return undefined;
  const review = r.state === 'APPROVED' ? 'approved' : r.state === 'REQUEST_CHANGES' ? 'changes' : r.state === 'COMMENT' ? 'commented' : undefined;
  if (!review) return undefined; // PENDING and REQUEST_REVIEW are not conversation
  const url = safeUrl(r.html_url);
  return {
    id: `review-${r.id ?? ''}`,
    author: login(r.user),
    association,
    body: sanitizeRemoteText(r.body ?? '', REMOTE_LIMITS.comment),
    at: r.submitted_at ?? '',
    review,
    ...(url ? { url } : {}),
  };
}
