/**
 * GitLab's wire shapes folded into the normalised `PullState` / `RemoteCheck` / `RemoteItem`.
 *
 * WHY separate and pure. GitLab words the same questions differently from GitHub, and each
 * difference is a rule the rest of the engine leans on, so the rules live in a table-tested
 * module that never touches the network (scripts/connections-gitlab-test.mjs):
 *
 *  - **`detailed_merge_status` is the verdict, `merge_status` is the fallback.** GitLab 15.6+
 *    says in one word why a merge request cannot merge (`ci_must_pass`, `not_approved`,
 *    `discussions_not_resolved`, `need_rebase` ...); `canMerge` is true ONLY for `mergeable`
 *    (and, on servers older than that, a conservative reading of `merge_status` plus the head
 *    pipeline). A status AICO does not know blocks and is shown in GitLab's own words: an
 *    unknown future status must never read as "go".
 *  - **Lazy mergeability again.** `checking` / `unchecked` are `unknown`, never `mergeable`.
 *  - **Pipelines are jobs.** The head pipeline's jobs are the checks. A job that failed but is
 *    `allow_failure` is neutral; `manual` and `skipped` are not failures; "no pipeline" is
 *    `none`, never `passing`.
 *  - **Approvals are optional or required, and say which.** The approvals endpoint reports
 *    `approvals_required`; it feeds the same review fold GitHub uses (`foldReviews`), so
 *    "changes requested outranks approvals" and "a requirement unmet stays pending" mean the
 *    same thing on both. A MR with `detailed_merge_status: requested_changes` is `changes`.
 *  - **"Merge when pipeline succeeds" is offered, never taken.** `autoMerge.available` is set
 *    only when a running pipeline is the one thing in the way; the click that uses it is a
 *    person's (landing.ts), and GitLab itself still enforces every other rule at the moment it
 *    merges. `armed` means someone already did.
 *  - **Weights are points.** `weight` (when the tier has it) wins over an `sp:5` label.
 *
 * Every string a stranger could have written is sanitised here on the way out.
 *
 * What it does not do: make requests, or decide to merge.
 *
 * @module connections/gitlab/fold
 */

import type { CheckState, PullState, RemoteCheck } from '../../../shared/connections/types.js';
import type { Comment, ProtectionInfo, RemoteItem } from '../adapter.js';
import { checkState, foldReviews, pointsFromLabels, safeUrl } from '../github/fold.js';
import { REMOTE_LIMITS, sanitizeLine, sanitizeRemoteText } from '../sanitize.js';

// ── raw shapes (fields we do not use are omitted) ────────────────────────

export interface RawUser { id?: number; username?: string; name?: string }
export interface RawPipeline { id?: number; status?: string; sha?: string; web_url?: string; ref?: string }
export interface RawMr {
  iid: number;
  web_url?: string;
  state?: string;
  title?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  merge_status?: string;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  sha?: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  merged_at?: string | null;
  head_pipeline?: RawPipeline | null;
  blocking_discussions_resolved?: boolean;
  merge_when_pipeline_succeeds?: boolean;
  auto_merge_enabled?: boolean;
  user?: { can_merge?: boolean };
  source_branch?: string;
  target_branch?: string;
  reviewers?: RawUser[];
  updated_at?: string;
}
export interface RawJob { id?: number; name?: string; status?: string; stage?: string; web_url?: string; allow_failure?: boolean; failure_reason?: string }
export interface RawApprovals { approved?: boolean; approvals_required?: number; approvals_left?: number; approved_by?: Array<{ user?: RawUser }> }
export interface RawIssue {
  iid: number; id?: number; title?: string; description?: string | null; state?: string;
  labels?: Array<string | { name?: string }>; assignees?: RawUser[]; assignee?: RawUser | null; author?: RawUser | null;
  web_url?: string; updated_at?: string; weight?: number | null;
  milestone?: { id?: number; iid?: number; title?: string; due_date?: string | null } | null;
  iteration?: { id?: number; title?: string } | null;
}
export interface RawNote { id?: number; body?: string | null; author?: RawUser | null; created_at?: string; system?: boolean; noteable_type?: string }

// ── checks ───────────────────────────────────────────────────────────────

const PENDING_JOB = new Set(['created', 'pending', 'running', 'waiting_for_resource', 'preparing', 'scheduled', 'waiting_for_callback']);

/** One job (or pipeline) status as a check state. */
export function foldJobState(status: string | undefined, allowFailure = false): RemoteCheck['state'] {
  const s = (status ?? '').toLowerCase();
  if (s === 'success') return 'success';
  if (s === 'failed') return allowFailure ? 'neutral' : 'failure';
  if (s === 'canceled' || s === 'cancelled') return 'failure';
  if (s === 'skipped') return 'skipped';
  if (PENDING_JOB.has(s)) return 'pending';
  // manual (waiting for a click), and anything GitLab adds later: informational, not a gate.
  return 'neutral';
}

export function foldJob(j: RawJob): RemoteCheck {
  const url = safeUrl(j.web_url);
  // Only a failure has anything worth saying; a running job's status is already its state.
  const why = j.status === 'failed' && j.failure_reason && j.failure_reason !== 'unknown_failure' ? j.failure_reason.replace(/_/g, ' ') : '';
  const summary = j.status === 'failed' ? sanitizeRemoteText(`${j.allow_failure ? 'Failed, but this job is allowed to fail' : 'Failed'}${why ? `: ${why}` : ''}`, REMOTE_LIMITS.summary) : '';
  const name = sanitizeLine(j.name, REMOTE_LIMITS.title) || '(unnamed job)';
  return { name, state: foldJobState(j.status, j.allow_failure === true), ...(url ? { url } : {}), ...(summary ? { summary } : {}) };
}

/** A commit status (an external system, or a job as the statuses endpoint lists it). */
export function foldCommitStatus(s: { name?: string; status?: string; target_url?: string | null; description?: string | null; allow_failure?: boolean }): RemoteCheck {
  const url = safeUrl(s.target_url);
  const summary = sanitizeRemoteText(s.description ?? '', REMOTE_LIMITS.summary);
  return {
    name: sanitizeLine(s.name, REMOTE_LIMITS.title) || '(unnamed status)', state: foldJobState(s.status, s.allow_failure === true),
    ...(url ? { url } : {}), ...(summary ? { summary } : {}),
  };
}

/** When the jobs cannot be read, the pipeline itself is the one check there is. */
export function foldPipelineCheck(p: RawPipeline): RemoteCheck {
  const url = safeUrl(p.web_url);
  return { name: `Pipeline #${p.id ?? '?'}`, state: foldJobState(p.status), ...(url ? { url } : {}) };
}

export function foldChecks(items: RemoteCheck[]): { state: CheckState; items: RemoteCheck[] } {
  return { state: checkState(items), items };
}

// ── merge verdict ────────────────────────────────────────────────────────

const UNKNOWN_STATUS = new Set(['checking', 'unchecked']);
const UNKNOWN_LEGACY = new Set(['unchecked', 'checking', 'cannot_be_merged_recheck', 'cannot_be_merged_rechecking']);

export function isDraft(mr: Pick<RawMr, 'draft' | 'work_in_progress' | 'title'>): boolean {
  return mr.draft === true || mr.work_in_progress === true || /^\s*(?:draft:|\[draft\]|\(draft\)|wip:)/i.test(mr.title ?? '');
}

export function mrState(mr: Pick<RawMr, 'state' | 'merged_at'>): PullState['state'] {
  if (mr.state === 'merged' || (mr.state === undefined && mr.merged_at)) return 'merged';
  if (mr.state === 'closed') return 'closed';
  return 'open'; // opened, locked (a merge in flight)
}

export function foldMergeable(mr: Pick<RawMr, 'state' | 'merge_status' | 'detailed_merge_status' | 'has_conflicts' | 'merged_at'>): PullState['mergeable'] {
  if (mrState(mr) !== 'open') return 'unknown';
  const d = mr.detailed_merge_status;
  if (mr.has_conflicts === true || d === 'conflict') return 'conflicting';
  if (d && UNKNOWN_STATUS.has(d)) return 'unknown';
  if (d) return 'mergeable'; // GitLab worked it out and found no conflict (it may still be blocked for another reason)
  if (mr.merge_status && UNKNOWN_LEGACY.has(mr.merge_status)) return 'unknown';
  if (mr.merge_status === 'can_be_merged') return 'mergeable';
  if (mr.merge_status === 'cannot_be_merged') return 'conflicting';
  return 'unknown';
}

export function pipelineOk(p: RawPipeline | null | undefined): boolean {
  return !p || p.status === 'success' || p.status === 'skipped';
}

/**
 * `mergeable` is GitLab's own "can be merged now" (15.6+). Older servers have only `merge_status`,
 * which ignores pipelines and discussions, so there the head pipeline and discussions are
 * checked here too. `user.can_merge === false` (the token's account may not merge into this
 * branch) always wins.
 */
export function foldCanMerge(mr: RawMr): boolean {
  if (mrState(mr) !== 'open' || isDraft(mr) || mr.user?.can_merge === false) return false;
  if (autoMergeArmed(mr)) return false;
  if (mr.detailed_merge_status) return mr.detailed_merge_status === 'mergeable';
  return mr.merge_status === 'can_be_merged' && mr.has_conflicts !== true && mr.blocking_discussions_resolved !== false && pipelineOk(mr.head_pipeline);
}

export function autoMergeArmed(mr: Pick<RawMr, 'merge_when_pipeline_succeeds' | 'auto_merge_enabled'>): boolean {
  return mr.merge_when_pipeline_succeeds === true || mr.auto_merge_enabled === true;
}

export function foldAutoMerge(mr: RawMr): PullState['autoMerge'] | undefined {
  if (mrState(mr) !== 'open') return undefined;
  const armed = autoMergeArmed(mr);
  const available = !armed && !isDraft(mr) && mr.user?.can_merge !== false && mr.has_conflicts !== true
    && (mr.detailed_merge_status === 'ci_still_running' || (!mr.detailed_merge_status && (mr.head_pipeline?.status === 'running' || mr.head_pipeline?.status === 'pending')));
  return armed || available ? { kind: 'pipeline', available, armed } : undefined;
}

const BLOCKER_TEXT: Record<string, string> = {
  ci_must_pass: 'The pipeline must succeed before this can be merged.',
  ci_still_running: 'The pipeline is still running.',
  discussions_not_resolved: 'There are unresolved discussions.',
  draft_status: 'The merge request is a draft.',
  not_approved: 'It needs more approvals.',
  need_rebase: 'The branch must be rebased onto the target branch (the project merges fast-forward only).',
  conflict: 'The branch has conflicts with the target branch.',
  blocked_status: 'Another merge request blocks this one.',
  external_status_checks: 'External status checks have not passed.',
  jira_association_missing: 'A Jira issue must be linked first.',
  requested_changes: 'A reviewer has requested changes.',
  checking: 'GitLab has not finished working out whether this can be merged yet.',
  unchecked: 'GitLab has not finished working out whether this can be merged yet.',
};

/** Plain sentences for why a merge request cannot be merged right now (empty when it can, or is finished). */
export function foldBlockers(mr: RawMr, checks: RemoteCheck[], reviews: PullState['reviews']): string[] {
  if (mrState(mr) !== 'open') return [];
  const out: string[] = [];
  const d = mr.detailed_merge_status;
  if (autoMergeArmed(mr)) out.push('It is set to merge when the pipeline succeeds.');
  else if (isDraft(mr)) out.push('The merge request is a draft.');
  else if (d && d !== 'mergeable') {
    out.push(BLOCKER_TEXT[d] ?? `GitLab says: ${sanitizeLine(d.replace(/_/g, ' '), 60)}.`);
  } else if (!d) {
    if (mr.has_conflicts === true || mr.merge_status === 'cannot_be_merged') out.push(BLOCKER_TEXT.conflict!);
    else if (!mr.merge_status || UNKNOWN_LEGACY.has(mr.merge_status)) out.push(BLOCKER_TEXT.checking!);
    if (mr.blocking_discussions_resolved === false) out.push(BLOCKER_TEXT.discussions_not_resolved!);
  }
  if (mr.user?.can_merge === false && out.length === 0) out.push('This account may not merge into the target branch.');
  if (reviews.changesRequested > 0 && d !== 'requested_changes') out.push('A reviewer has requested changes.');
  if (d === 'not_approved' && reviews.required !== undefined && reviews.approved < reviews.required) out.push(`${reviews.approved} of ${reviews.required} required approvals.`);
  for (const c of checks) if (c.state === 'failure') out.push(`Check failed: ${c.name}`);
  return [...new Set(out)];
}

export interface FoldPullInput {
  connection: string;
  mr: RawMr;
  /** Jobs of the head pipeline; `undefined` when they could not be read (the pipeline stands in). */
  jobs?: RawJob[] | undefined;
  approvals?: RawApprovals | undefined;
  protection?: ProtectionInfo | undefined;
  now?: string;
}

/** Approvals into the same fold GitHub's reviews use, so both providers mean the same by "approved" and "changes". */
export function foldMrReviews(mr: RawMr, approvals: RawApprovals | undefined): PullState['reviews'] {
  const synthetic = (approvals?.approved_by ?? []).map((a, i) => ({ id: i + 1, user: { login: a.user?.username ?? `#${a.user?.id ?? i}` }, state: 'APPROVED' }));
  if (mr.detailed_merge_status === 'requested_changes') synthetic.push({ id: 9_999, user: { login: '(reviewer)' }, state: 'CHANGES_REQUESTED' });
  const required = approvals && typeof approvals.approvals_required === 'number' ? approvals.approvals_required : undefined;
  return foldReviews(synthetic, mr.reviewers?.length ?? 0, required);
}

export function foldPull(i: FoldPullInput): PullState {
  const { mr } = i;
  const state = mrState(mr);
  const items: RemoteCheck[] = i.jobs !== undefined
    ? i.jobs.map(foldJob)
    : mr.head_pipeline?.id !== undefined && mr.head_pipeline.status ? [foldPipelineCheck(mr.head_pipeline)] : [];
  const checks = foldChecks(items);
  const readable = i.protection && !i.protection.unreadable ? i.protection : undefined;
  const reviews = foldMrReviews(mr, i.approvals);
  const autoMerge = foldAutoMerge(mr);
  const merged = state === 'merged';
  const mergedSha = mr.merge_commit_sha ?? mr.squash_commit_sha ?? undefined;
  return {
    connection: i.connection,
    id: String(mr.iid),
    url: safeUrl(mr.web_url) ?? '',
    state,
    draft: isDraft(mr),
    headSha: mr.sha ?? mr.head_pipeline?.sha ?? '',
    mergeable: foldMergeable(mr),
    checks,
    reviews,
    canMerge: foldCanMerge(mr),
    mergeBlockers: foldBlockers(mr, checks.items, reviews),
    ...(readable ? { protectedBase: readable.protected } : {}),
    ...(merged && mergedSha ? { mergedSha } : {}),
    ...(autoMerge ? { autoMerge } : {}),
    observedAt: i.now ?? new Date().toISOString(),
  };
}

// ── issues, notes, members ───────────────────────────────────────────────

export function foldIssue(i: RawIssue): RemoteItem {
  const labels = (i.labels ?? []).map(l => sanitizeLine(typeof l === 'string' ? l : l.name, REMOTE_LIMITS.label)).filter(Boolean);
  const people = i.assignees?.length ? i.assignees : i.assignee ? [i.assignee] : [];
  const ms = i.milestone;
  const points = typeof i.weight === 'number' && Number.isFinite(i.weight) ? i.weight : pointsFromLabels(labels);
  const iteration = i.iteration && i.iteration.id !== undefined ? `iteration-${i.iteration.id}` : ms && ms.id !== undefined ? String(ms.id) : undefined;
  return {
    id: String(i.iid),
    number: i.iid,
    title: sanitizeLine(i.title, REMOTE_LIMITS.title),
    body: sanitizeRemoteText(i.description ?? '', REMOTE_LIMITS.body),
    state: i.state === 'closed' ? 'closed' : 'open',
    labels,
    assignees: people.map(a => sanitizeLine(a.username, 80)).filter(Boolean),
    author: sanitizeLine(i.author?.username, 80),
    url: safeUrl(i.web_url) ?? '',
    rev: i.updated_at ?? '',
    ...(ms && ms.id !== undefined ? { milestone: { id: String(ms.id), title: sanitizeLine(ms.title, REMOTE_LIMITS.title), ...(ms.due_date ? { dueOn: ms.due_date } : {}) } } : {}),
    ...(points !== undefined ? { points } : {}),
    ...(iteration ? { iteration } : {}),
  };
}

/** GitLab's access levels as the provider-neutral association the trust rule reads. */
export function associationOf(level: number | undefined, isOwnerOfNamespace = false): string {
  if (isOwnerOfNamespace || (level ?? 0) >= 50) return 'OWNER';
  if ((level ?? 0) >= 30) return 'MEMBER'; // Developer and Maintainer can push code
  if ((level ?? 0) > 0) return 'CONTRIBUTOR'; // Guest and Reporter cannot: not trusted to steer a coding agent
  return 'NONE';
}

const APPROVED_NOTE = /^approved this merge request\b/i;
const CHANGES_NOTE = /^requested changes\b/i;

/**
 * A note as a conversation comment. GitLab records approvals and requested changes as SYSTEM notes
 * ("approved this merge request"), which are the review verdicts here; every other system note
 * (commits added, labels changed ...) is not conversation and is dropped.
 */
export function foldNote(n: RawNote, level: number | undefined): Comment | undefined {
  const body = (n.body ?? '').trim();
  let review: Comment['review'] | undefined;
  if (n.system) {
    if (APPROVED_NOTE.test(body)) review = 'approved';
    else if (CHANGES_NOTE.test(body)) review = 'changes';
    else return undefined;
  }
  return {
    id: `note-${n.id ?? ''}`,
    author: sanitizeLine(n.author?.username, 80),
    association: associationOf(level),
    body: review ? '' : sanitizeRemoteText(body, REMOTE_LIMITS.comment),
    at: n.created_at ?? '',
    ...(review ? { review } : {}),
  };
}
