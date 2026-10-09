/**
 * GitHub's wire shapes folded into the normalised `PullState` / `RemoteCheck` / `RemoteItem`.
 *
 * WHY separate and pure. The fold is where GitHub's habits turn into rules the rest of the
 * engine relies on (can this be merged? are the checks red?), and the habits are subtle:
 * `mergeable` is computed lazily and is `null` until it has been; a COMMENTED review does not
 * undo an earlier CHANGES_REQUESTED; a neutral or skipped check is not a failure; "no checks"
 * must not read as "passing". Keeping the rules free of the network means a table of inputs
 * tests every one of them (scripts/connections-github-test.mjs) without a server.
 *
 * Every string a stranger could have written (titles, bodies, labels, check names and
 * summaries, logins) is sanitised here on the way out, so nothing downstream has to remember to.
 *
 * What it does not do: make requests, or decide to merge. `canMerge` is the remote's verdict
 * in GitHub's own terms (`mergeable_state`), never AICO's judgement of the diff.
 *
 * @module connections/github/fold
 */

import type { CheckState, PullState, RemoteCheck, ReviewState } from '../../../shared/connections/types.js';
import type { Comment, ProtectionInfo, RemoteItem } from '../adapter.js';
import { REMOTE_LIMITS, sanitizeLine, sanitizeRemoteText } from '../sanitize.js';

// ── the raw shapes we read (fields we do not use are omitted) ─────────────

export interface RawUser { login?: string }
export interface RawLabel { name?: string }
export interface RawPull {
  number: number;
  html_url?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  head?: { sha?: string; ref?: string };
  base?: { ref?: string };
  requested_reviewers?: unknown[];
  requested_teams?: unknown[];
}
export interface RawCheckRun {
  name?: string; status?: string; conclusion?: string | null;
  details_url?: string | null; html_url?: string | null;
  output?: { title?: string | null; summary?: string | null };
}
export interface RawStatus { context?: string; state?: string; target_url?: string | null; description?: string | null }
export interface RawReview { id?: number; user?: RawUser | null; state?: string; body?: string | null; submitted_at?: string; author_association?: string; html_url?: string }
export interface RawIssue {
  number: number; title?: string; body?: string | null; state?: string; labels?: Array<RawLabel | string>;
  assignees?: RawUser[]; user?: RawUser | null; html_url?: string; updated_at?: string;
  milestone?: { number?: number; title?: string; due_on?: string | null } | null;
  pull_request?: unknown;
}
export interface RawComment { id?: number; user?: RawUser | null; author_association?: string; body?: string | null; created_at?: string; html_url?: string }

/** Only http(s) URLs leave the adapter; anything else (javascript:, data:) becomes undefined. */
export function safeUrl(u: unknown): string | undefined {
  if (typeof u !== 'string') return undefined;
  return /^https?:\/\/[^\s]+$/i.test(u) && u.length <= 2000 ? u : undefined;
}

// ── checks ─────────────────────────────────────────────────────────────────

const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

export function foldCheckRun(r: RawCheckRun): RemoteCheck {
  let state: RemoteCheck['state'];
  if (r.status && r.status !== 'completed') state = 'pending';
  else if (r.conclusion === 'success') state = 'success';
  else if (r.conclusion && FAILING_CONCLUSIONS.has(r.conclusion)) state = 'failure';
  else if (r.conclusion === 'skipped') state = 'skipped';
  // neutral, stale, and a completed run with no conclusion: informational, not a gate.
  else state = 'neutral';
  const summary = sanitizeRemoteText(r.output?.summary || r.output?.title || '', REMOTE_LIMITS.summary);
  const url = safeUrl(r.details_url) ?? safeUrl(r.html_url);
  return {
    name: sanitizeLine(r.name, REMOTE_LIMITS.title) || '(unnamed check)', state,
    ...(url ? { url } : {}), ...(summary ? { summary } : {}),
  };
}

export function foldStatus(s: RawStatus): RemoteCheck {
  const state: RemoteCheck['state'] = s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure';
  const summary = sanitizeRemoteText(s.description ?? '', REMOTE_LIMITS.summary);
  const url = safeUrl(s.target_url);
  return {
    name: sanitizeLine(s.context, REMOTE_LIMITS.title) || '(unnamed status)', state,
    ...(url ? { url } : {}), ...(summary ? { summary } : {}),
  };
}

/** Check-runs then commit statuses, as one list. */
export function foldChecks(runs: RawCheckRun[], statuses: RawStatus[]): { state: CheckState; items: RemoteCheck[] } {
  const items = [...runs.map(foldCheckRun), ...statuses.map(foldStatus)];
  return { state: checkState(items), items };
}

export function checkState(items: RemoteCheck[]): CheckState {
  if (items.length === 0) return 'none';
  if (items.some(i => i.state === 'failure')) return 'failing';
  if (items.some(i => i.state === 'pending')) return 'pending';
  return 'passing';
}

// ── reviews ────────────────────────────────────────────────────────────────

/**
 * The latest decisive review per reviewer. A DISMISSED review erases that reviewer's
 * earlier verdict; a COMMENTED or PENDING one changes nothing (GitHub's own rule).
 */
export function foldReviews(
  reviews: RawReview[], requestedCount: number, required: number | undefined,
): PullState['reviews'] {
  const latest = new Map<string, 'APPROVED' | 'CHANGES_REQUESTED'>();
  for (const r of reviews) {
    const who = r.user?.login ?? `#${r.id ?? '?'}`;
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') latest.set(who, r.state);
    else if (r.state === 'DISMISSED') latest.delete(who);
  }
  let approved = 0;
  let changesRequested = 0;
  for (const v of latest.values()) { if (v === 'APPROVED') approved++; else changesRequested++; }
  const need = required ?? 1;
  let state: ReviewState;
  if (changesRequested > 0) state = 'changes';
  else if (approved > 0 && approved >= need) state = 'approved';
  else if (requestedCount > 0 || (required !== undefined && required > 0 && approved < required) || (approved > 0 && approved < need)) state = 'pending';
  else state = 'none';
  return { state, approved, changesRequested, ...(required !== undefined ? { required } : {}) };
}

// ── mergeability ───────────────────────────────────────────────────────────

export function foldMergeable(pr: Pick<RawPull, 'mergeable' | 'mergeable_state'>): PullState['mergeable'] {
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') return 'conflicting';
  if (pr.mergeable === true) return 'mergeable';
  return 'unknown';
}

const MERGEABLE_STATES = new Set(['clean', 'unstable', 'has_hooks']);

export function foldCanMerge(pr: Pick<RawPull, 'state' | 'draft' | 'merged' | 'mergeable_state'>): boolean {
  if (pr.merged || pr.state !== 'open' || pr.draft) return false;
  return MERGEABLE_STATES.has(pr.mergeable_state ?? '');
}

/** Plain sentences for why a PR cannot be merged right now (empty when it is closed or merged). */
export function foldBlockers(
  pr: Pick<RawPull, 'state' | 'draft' | 'merged' | 'mergeable_state' | 'mergeable'>,
  checks: RemoteCheck[], reviews: PullState['reviews'],
): string[] {
  if (pr.merged || pr.state !== 'open') return [];
  const out: string[] = [];
  const ms = pr.draft ? 'draft' : pr.mergeable_state;
  if (ms === 'draft') out.push('The pull request is a draft.');
  else if (ms === 'dirty') out.push('The branch has conflicts with the base branch.');
  else if (ms === 'behind') out.push('The branch is behind the base branch.');
  else if (ms === 'blocked') out.push('Required reviews or checks are not satisfied.');
  else if (!ms || ms === 'unknown') out.push('GitHub has not finished working out whether this can be merged yet.');
  if (reviews.changesRequested > 0) out.push('A reviewer has requested changes.');
  else if (ms === 'blocked' && reviews.required !== undefined && reviews.approved < reviews.required) {
    out.push(`${reviews.approved} of ${reviews.required} required approvals.`);
  }
  for (const c of checks) if (c.state === 'failure') out.push(`Check failed: ${c.name}`);
  return out;
}

export interface FoldPullInput {
  connection: string;
  pr: RawPull;
  runs: RawCheckRun[];
  statuses: RawStatus[];
  reviews: RawReview[];
  /** Branch protection of the base, when the token could read it. */
  protection?: ProtectionInfo | undefined;
  now?: string;
}

export function foldPull(i: FoldPullInput): PullState {
  const { pr } = i;
  const merged = pr.merged === true || (pr.merged === undefined && !!pr.merged_at);
  const state: PullState['state'] = merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
  const checks = foldChecks(i.runs, i.statuses);
  const readable = i.protection && !i.protection.unreadable ? i.protection : undefined;
  const required = readable?.protected ? readable.requiredReviews : undefined;
  const requested = (pr.requested_reviewers?.length ?? 0) + (pr.requested_teams?.length ?? 0);
  const reviews = foldReviews(i.reviews, requested, required);
  const norm = { state: pr.state, draft: pr.draft === true, merged, mergeable_state: pr.mergeable_state, mergeable: pr.mergeable };
  return {
    connection: i.connection,
    id: String(pr.number),
    url: safeUrl(pr.html_url) ?? '',
    state,
    draft: pr.draft === true,
    headSha: pr.head?.sha ?? '',
    mergeable: foldMergeable(pr),
    checks,
    reviews,
    canMerge: foldCanMerge(norm),
    mergeBlockers: foldBlockers(norm, checks.items, reviews),
    ...(readable ? { protectedBase: readable.protected } : {}),
    ...(merged && pr.merge_commit_sha ? { mergedSha: pr.merge_commit_sha } : {}),
    observedAt: i.now ?? new Date().toISOString(),
  };
}

// ── issues and comments ────────────────────────────────────────────────────

/** `sp:5`, `points:5`, `estimate:5`, `Story Points: 3`. */
const POINTS_LABEL = /^(?:sp|story[ -]?points?|points?|estimate)\s*[:=/ -]\s*(\d+(?:\.\d+)?)$/i;

export function pointsFromLabels(labels: string[]): number | undefined {
  for (const l of labels) {
    const m = POINTS_LABEL.exec(l.trim());
    if (m) return Number(m[1]);
  }
  return undefined;
}

export function foldItem(i: RawIssue): RemoteItem {
  const labels = (i.labels ?? [])
    .map(l => sanitizeLine(typeof l === 'string' ? l : l.name, REMOTE_LIMITS.label))
    .filter(Boolean);
  const points = pointsFromLabels(labels);
  const ms = i.milestone;
  return {
    id: String(i.number),
    number: i.number,
    title: sanitizeLine(i.title, REMOTE_LIMITS.title),
    body: sanitizeRemoteText(i.body ?? '', REMOTE_LIMITS.body),
    state: i.state === 'closed' ? 'closed' : 'open',
    labels,
    assignees: (i.assignees ?? []).map(a => sanitizeLine(a.login, 80)).filter(Boolean),
    author: sanitizeLine(i.user?.login, 80),
    url: safeUrl(i.html_url) ?? '',
    rev: i.updated_at ?? '',
    ...(ms && ms.number !== undefined ? { milestone: { id: String(ms.number), title: sanitizeLine(ms.title, REMOTE_LIMITS.title), ...(ms.due_on ? { dueOn: ms.due_on } : {}) } } : {}),
    ...(points !== undefined ? { points } : {}),
  };
}

export function foldComment(c: RawComment): Comment {
  const url = safeUrl(c.html_url);
  return {
    id: String(c.id ?? ''),
    author: sanitizeLine(c.user?.login, 80),
    association: sanitizeLine(c.author_association, 40) || 'NONE',
    body: sanitizeRemoteText(c.body ?? '', REMOTE_LIMITS.comment),
    at: c.created_at ?? '',
    ...(url ? { url } : {}),
  };
}

export function foldReviewComment(r: RawReview): Comment | undefined {
  const review = r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes' : r.state === 'COMMENTED' ? 'commented' : undefined;
  if (!review) return undefined; // PENDING (not submitted) and DISMISSED are not conversation
  const url = safeUrl(r.html_url);
  return {
    id: `review-${r.id ?? ''}`,
    author: sanitizeLine(r.user?.login, 80),
    association: sanitizeLine(r.author_association, 40) || 'NONE',
    body: sanitizeRemoteText(r.body ?? '', REMOTE_LIMITS.comment),
    at: r.submitted_at ?? '',
    review,
    ...(url ? { url } : {}),
  };
}

/** Cut at a code-point boundary: never leave half a surrogate pair at the edge. */
export function clipText(text: string, max: number): { head: string; overflow?: string } {
  if (text.length <= max) return { head: text };
  let cut = max;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return { head: text.slice(0, cut), overflow: text.slice(cut) };
}
