/**
 * Bitbucket's wire shapes (Cloud 2.0 and Data Center 1.0) folded into the normalised
 * `PullState` / `RemoteCheck` / `Comment` / `RemoteItem`. Pure: no requests, so a table of
 * inputs tests every rule (scripts/connections-bitbucket-test.mjs).
 *
 * WHY the two products disagree and the fold has to say so honestly:
 *
 *  - **Data Center answers "can this merge?" itself** (`GET .../merge` returns `canMerge`,
 *    `conflicted` and `vetoes` with the reason for each), so its `canMerge` is the remote's
 *    verdict and `mergeBlockers` are the remote's own sentences.
 *  - **Cloud does not.** The pull request carries no mergeable flag, so `mergeable` stays
 *    `unknown` and `canMerge` is derived only from what IS visible (open, not a draft, no
 *    failing or pending build, nobody asking for changes, approvals at least the known
 *    requirement). When the requirement cannot be read (it needs repository admin) one
 *    approval stands in for "somebody reviewed it", so a merge click is never offered on a
 *    pull request nobody has looked at; the server still enforces its own branch restrictions and
 *    refuses with its reason. AICO never bypasses a restriction either way.
 *  - **Reviews.** Cloud: a participant's `approved` and `state: changes_requested`. Data Center:
 *    a reviewer's `status` APPROVED / NEEDS_WORK. Neither has a "dismissed" or a comment-only
 *    verdict to undo anything, so the latest decisive state per person is simply the state.
 *  - **Authors have no "association".** Neither product marks a commenter as member or
 *    collaborator. The PR's author is the account AICO acts as (OWNER), a designated reviewer is
 *    COLLABORATOR, everyone else is NONE and so never reaches the agent unless the connection's
 *    trusted list names them (landing.ts trustedComments).
 *
 * Every string a stranger could have written is sanitised here on the way out.
 *
 * @module connections/bitbucket/fold
 */

import type { CheckState, PullState, RemoteCheck, ReviewState } from '../../../shared/connections/types.js';
import type { Comment, ProtectionInfo, RemoteItem } from '../adapter.js';
import { REMOTE_LIMITS, sanitizeLine, sanitizeRemoteText } from '../sanitize.js';
import { checkState } from '../github/fold.js';
import { asArr, asObj, str, type Obj } from './common.js';

export { clipText, safeUrl } from '../github/fold.js';
import { safeUrl } from '../github/fold.js';

// ── people and reviews (both products) ─────────────────────────────────────

export interface Decision { who: string; state: 'approved' | 'changes' | 'pending' }

/** Decisions to a review state, with the same arithmetic as the GitHub fold (so Delivery sees one meaning). */
export function foldDecisions(decisions: Decision[], required: number | undefined): PullState['reviews'] {
  const approved = decisions.filter(d => d.state === 'approved').length;
  const changesRequested = decisions.filter(d => d.state === 'changes').length;
  const waiting = decisions.filter(d => d.state === 'pending').length;
  const need = required ?? 1;
  let state: ReviewState;
  if (changesRequested > 0) state = 'changes';
  else if (approved > 0 && approved >= need) state = 'approved';
  else if (waiting > 0 || (required !== undefined && required > 0 && approved < required) || (approved > 0 && approved < need)) state = 'pending';
  else state = 'none';
  return { state, approved, changesRequested, ...(required !== undefined ? { required } : {}) };
}

// ═══════════════════════════ Bitbucket Cloud ═══════════════════════════

const personName = (u: unknown): string => {
  const o = asObj(u);
  return str(o.nickname || o.display_name || o.username || '', 80);
};

export function cloudDecisions(pr: Obj): Decision[] {
  const out: Decision[] = [];
  const author = personName(pr.author);
  const seen = new Set<string>();
  for (const p of asArr(pr.participants)) {
    const o = asObj(p);
    const who = personName(o.user);
    if (!who || who === author) continue; // an author cannot approve their own PR here
    seen.add(who);
    const state = o.state === 'changes_requested' ? 'changes' : o.approved === true || o.state === 'approved' ? 'approved' : o.role === 'REVIEWER' ? 'pending' : undefined;
    if (state) out.push({ who, state });
  }
  for (const r of asArr(pr.reviewers)) {
    const who = personName(r);
    if (who && who !== author && !seen.has(who)) out.push({ who, state: 'pending' });
  }
  return out;
}

export function foldCloudStatus(s: Obj): RemoteCheck {
  const st = String(s.state ?? '');
  const state: RemoteCheck['state'] = st === 'SUCCESSFUL' ? 'success' : st === 'INPROGRESS' ? 'pending' : 'failure';
  const summary = sanitizeRemoteText(s.description ?? '', REMOTE_LIMITS.summary);
  const url = safeUrl(s.url);
  return {
    name: sanitizeLine(s.name || s.key, REMOTE_LIMITS.title) || '(unnamed build)', state,
    ...(url ? { url } : {}), ...(summary ? { summary } : {}),
  };
}

export function foldCloudStatuses(values: unknown[]): { state: CheckState; items: RemoteCheck[] } {
  const items = values.map(v => foldCloudStatus(asObj(v)));
  return { state: checkState(items), items };
}

export interface CloudPullInput {
  connection: string;
  pr: Obj;
  statuses: unknown[];
  protection?: ProtectionInfo | undefined;
  now?: string;
}

export function foldCloudPull(i: CloudPullInput): PullState {
  const pr = i.pr;
  const st = String(pr.state ?? '');
  const state: PullState['state'] = st === 'MERGED' ? 'merged' : st === 'OPEN' ? 'open' : 'closed';
  const draft = pr.draft === true;
  const checks = foldCloudStatuses(i.statuses);
  const readable = i.protection && !i.protection.unreadable ? i.protection : undefined;
  // Readable and unprotected means nothing is required; unreadable means unknown (and then one approval is asked for).
  const required = readable ? (readable.protected ? readable.requiredReviews : 0) : undefined;
  const reviews = foldDecisions(cloudDecisions(pr), required);
  const head = str(asObj(asObj(pr.source).commit).hash, 64);
  const blockers: string[] = [];
  if (state === 'open') {
    if (draft) blockers.push('The pull request is a draft.');
    if (reviews.changesRequested > 0) blockers.push('A reviewer has requested changes.');
    if (required !== undefined && required > 0 && reviews.approved < required) blockers.push(`${reviews.approved} of ${required} required approvals.`);
    // Cloud will not say whether approvals are required when the token cannot read the restrictions; offering a
    // merge click on a pull request nobody has approved would be a guess, so one approval stands in for "reviewed".
    else if (required === undefined && reviews.approved === 0) blockers.push('Nobody has approved it yet (Bitbucket did not say whether approvals are required).');
    for (const c of checks.items) if (c.state === 'failure') blockers.push(`Build failed: ${c.name}`);
    if (checks.state === 'pending') blockers.push('A build is still running.');
  }
  const mergeCommit = str(asObj(pr.merge_commit).hash, 64);
  return {
    connection: i.connection,
    id: String(pr.id),
    url: safeUrl(asObj(asObj(asObj(pr.links).html)).href) ?? '',
    state, draft,
    headSha: head,
    // Cloud reports no mergeability: honest "unknown", never a guess in either direction.
    mergeable: 'unknown',
    checks, reviews,
    canMerge: state === 'open' && blockers.length === 0,
    mergeBlockers: blockers,
    ...(readable ? { protectedBase: readable.protected } : {}),
    ...(state === 'merged' && mergeCommit ? { mergedSha: mergeCommit } : {}),
    observedAt: i.now ?? new Date().toISOString(),
  };
}

/**
 * Comments of a Cloud pull request, deleted ones dropped, plus one synthetic review entry per
 * reviewer who asked for changes (Cloud's "needs work" has no text of its own; the entry lets the
 * resume path say who asked).
 */
export function foldCloudComments(values: unknown[], pr: Obj): Comment[] {
  const author = personName(pr.author);
  const reviewers = new Set<string>([
    ...asArr(pr.reviewers).map(personName),
    ...asArr(pr.participants).filter(p => asObj(p).role === 'REVIEWER').map(p => personName(asObj(p).user)),
  ].filter(Boolean));
  const assoc = (who: string): string => (who && who === author ? 'OWNER' : reviewers.has(who) ? 'COLLABORATOR' : 'NONE');
  const out: Comment[] = [];
  for (const v of values) {
    const c = asObj(v);
    if (c.deleted === true) continue;
    const who = personName(c.user);
    const url = safeUrl(asObj(asObj(asObj(c.links).html)).href);
    out.push({
      id: String(c.id ?? ''), author: who, association: assoc(who),
      body: sanitizeRemoteText(asObj(c.content).raw ?? '', REMOTE_LIMITS.comment),
      at: typeof c.created_on === 'string' ? c.created_on : '', ...(url ? { url } : {}),
    });
  }
  for (const p of asArr(pr.participants)) {
    const o = asObj(p);
    if (o.state !== 'changes_requested') continue;
    const who = personName(o.user);
    out.push({ id: `review-${who}`, author: who, association: assoc(who), body: '', at: typeof o.participated_on === 'string' ? o.participated_on : '', review: 'changes' });
  }
  return out.map((c, i) => ({ c, i })).sort((a, b) => (Date.parse(a.c.at) || 0) - (Date.parse(b.c.at) || 0) || a.i - b.i).map(x => x.c);
}

/** Cloud's issue states: new, open and on hold are work still to do; the rest are over. */
export function foldCloudIssue(j: Obj): RemoteItem {
  const state = ['new', 'open', 'on hold'].includes(String(j.state)) ? 'open' : 'closed';
  const component = asObj(j.component).name;
  const milestone = asObj(j.milestone).name;
  const assignee = personName(j.assignee);
  const url = safeUrl(asObj(asObj(asObj(j.links).html)).href);
  const id = String(j.id ?? '');
  return {
    id, number: Number(j.id) || 0,
    title: sanitizeLine(j.title, REMOTE_LIMITS.title),
    body: sanitizeRemoteText(asObj(j.content).raw ?? '', REMOTE_LIMITS.body),
    state,
    // The tracker has no labels; the component is the closest thing and is how `label` imports find work.
    labels: typeof component === 'string' && component ? [sanitizeLine(component, REMOTE_LIMITS.label)] : [],
    assignees: assignee ? [assignee] : [],
    author: personName(j.reporter),
    url: url ?? '',
    rev: typeof j.updated_on === 'string' ? j.updated_on : '',
    ...(typeof milestone === 'string' && milestone ? { milestone: { id: sanitizeLine(milestone, 80), title: sanitizeLine(milestone, REMOTE_LIMITS.title) } } : {}),
  };
}

export interface RestrictionKind { kind: string; value?: unknown; pattern?: unknown; branch_match_kind?: unknown }

/** Does a branch restriction's pattern cover `branch`? Exact name or a `*` glob; branching-model kinds are not guessed. */
export function patternCovers(r: RestrictionKind, branch: string): boolean {
  if (r.branch_match_kind === 'branching_model') return false;
  const p = typeof r.pattern === 'string' ? r.pattern : '';
  if (!p) return false;
  if (p === branch) return true;
  if (!p.includes('*')) return false;
  const re = new RegExp(`^${p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(branch);
}

/** Cloud branch restrictions to protection: any restriction that covers the branch makes it protected. */
export function foldCloudRestrictions(values: unknown[], branch: string): ProtectionInfo {
  const hit = values.map(asObj).filter(r => patternCovers(r as unknown as RestrictionKind, branch));
  if (hit.length === 0) return { protected: false };
  let reviews = 0;
  const checks: string[] = [];
  for (const r of hit) {
    const v = typeof r.value === 'number' ? r.value : Number(r.value);
    if (r.kind === 'require_approvals_to_merge' && Number.isFinite(v)) reviews = Math.max(reviews, v);
    if (r.kind === 'require_default_reviewer_approvals_to_merge' && Number.isFinite(v)) reviews = Math.max(reviews, v);
    if (r.kind === 'require_passing_builds_to_merge' && Number.isFinite(v) && v > 0) checks.push(`${v} passing build${v === 1 ? '' : 's'}`);
  }
  return { protected: true, requiredReviews: reviews, requiredChecks: checks };
}

// ═══════════════════════════ Bitbucket Data Center ═══════════════════════════

const dcName = (u: unknown): string => {
  const o = asObj(u);
  return str(o.slug || o.name || o.displayName || '', 80);
};

export function dcDecisions(pr: Obj): Decision[] {
  const out: Decision[] = [];
  const author = dcName(asObj(pr.author).user);
  for (const r of asArr(pr.reviewers)) {
    const o = asObj(r);
    const who = dcName(o.user);
    if (!who || who === author) continue;
    const state = o.status === 'NEEDS_WORK' ? 'changes' : o.status === 'APPROVED' || o.approved === true ? 'approved' : 'pending';
    out.push({ who, state });
  }
  return out;
}

export function foldDcBuild(b: Obj): RemoteCheck {
  const st = String(b.state ?? '');
  const state: RemoteCheck['state'] = st === 'SUCCESSFUL' ? 'success' : st === 'INPROGRESS' ? 'pending' : 'failure';
  const summary = sanitizeRemoteText(b.description ?? '', REMOTE_LIMITS.summary);
  const url = safeUrl(b.url);
  return {
    name: sanitizeLine(b.name || b.key, REMOTE_LIMITS.title) || '(unnamed build)', state,
    ...(url ? { url } : {}), ...(summary ? { summary } : {}),
  };
}

export interface DcMergeCheck { canMerge?: boolean; conflicted?: boolean; outcome?: string; vetoes?: unknown[] }

export interface DcPullInput {
  connection: string;
  pr: Obj;
  /** Just created by AICO: nothing has been asked of the server yet, and the blocker should say so. */
  justOpened?: boolean;
  /** `GET .../merge`; absent when the token could not ask. */
  merge?: DcMergeCheck | undefined;
  builds: unknown[];
  protection?: ProtectionInfo | undefined;
  now?: string;
}

export function foldDcPull(i: DcPullInput): PullState {
  const pr = i.pr;
  const st = String(pr.state ?? '');
  const state: PullState['state'] = st === 'MERGED' ? 'merged' : st === 'OPEN' ? 'open' : 'closed';
  const draft = pr.draft === true;
  const items = i.builds.map(b => foldDcBuild(asObj(b)));
  const checks = { state: checkState(items), items };
  const readable = i.protection && !i.protection.unreadable ? i.protection : undefined;
  const required = readable?.protected ? readable.requiredReviews : undefined;
  const reviews = foldDecisions(dcDecisions(pr), required);
  const m = i.merge;
  const mergeable: PullState['mergeable'] = m?.conflicted === true || m?.outcome === 'CONFLICTED' ? 'conflicting' : m?.outcome === 'CLEAN' ? 'mergeable' : 'unknown';
  const blockers: string[] = [];
  if (state === 'open') {
    if (draft) blockers.push('The pull request is a draft.');
    if (mergeable === 'conflicting') blockers.push('The branch has conflicts with the target branch.');
    for (const v of asArr(m?.vetoes)) {
      const msg = sanitizeLine(asObj(v).summaryMessage || asObj(v).detailedMessage, 240);
      if (msg) blockers.push(msg);
    }
    if (reviews.changesRequested > 0) blockers.push('A reviewer has marked it "needs work".');
    if (m === undefined) blockers.push(i.justOpened ? 'Just opened: Bitbucket has not checked whether it can be merged yet.' : 'Bitbucket was not asked whether this can be merged (the token cannot read it).');
  }
  const props = asObj(pr.properties);
  const mergeCommit = str(asObj(props.mergeCommit).id, 64);
  const href = asObj(asArr(asObj(pr.links).self)[0]).href;
  return {
    connection: i.connection,
    id: String(pr.id),
    url: safeUrl(href) ?? '',
    state, draft,
    headSha: str(asObj(pr.fromRef).latestCommit, 64),
    mergeable,
    checks, reviews,
    // The server's own verdict, never ours, and never for a draft or a closed request.
    canMerge: state === 'open' && !draft && m?.canMerge === true && reviews.changesRequested === 0,
    mergeBlockers: blockers,
    ...(readable ? { protectedBase: readable.protected } : {}),
    ...(state === 'merged' && mergeCommit ? { mergedSha: mergeCommit } : {}),
    observedAt: i.now ?? new Date().toISOString(),
  };
}

/** Data Center activities to comments: COMMENTED entries only (APPROVED/OPENED/etc. are not conversation). */
export function foldDcActivities(values: unknown[], pr: Obj): Comment[] {
  const author = dcName(asObj(pr.author).user);
  const reviewers = new Set(asArr(pr.reviewers).map(r => dcName(asObj(r).user)).filter(Boolean));
  const assoc = (who: string): string => (who && who === author ? 'OWNER' : reviewers.has(who) ? 'COLLABORATOR' : 'NONE');
  const out: Comment[] = [];
  const walk = (c: Obj): void => {
    const who = dcName(c.author);
    out.push({
      id: String(c.id ?? ''), author: who, association: assoc(who),
      body: sanitizeRemoteText(c.text ?? '', REMOTE_LIMITS.comment),
      at: typeof c.createdDate === 'number' ? new Date(c.createdDate).toISOString() : '',
    });
    for (const r of asArr(c.comments)) walk(asObj(r));
  };
  for (const v of values) {
    const a = asObj(v);
    if (a.action === 'COMMENTED' && a.comment) walk(asObj(a.comment));
  }
  for (const r of asArr(pr.reviewers)) {
    const o = asObj(r);
    if (o.status !== 'NEEDS_WORK') continue;
    const who = dcName(o.user);
    out.push({ id: `review-${who}`, author: who, association: assoc(who), body: '', at: '', review: 'changes' });
  }
  return out.map((c, i) => ({ c, i })).sort((a, b) => (Date.parse(a.c.at) || 0) - (Date.parse(b.c.at) || 0) || a.i - b.i).map(x => x.c);
}

/** `settings/pull-requests` -> required approvers and builds (needs repository admin to read). */
export function foldDcPullSettings(j: Obj): { requiredReviews: number; requiredBuilds: number; tasksMustBeDone: boolean } {
  const count = (x: unknown): number => {
    const o = asObj(x);
    return o.enable === true && typeof o.count === 'number' ? o.count : 0;
  };
  return {
    requiredReviews: count(j.requiredApprovers),
    requiredBuilds: count(j.requiredSuccessfulBuilds),
    tasksMustBeDone: asObj(j.requiredAllTasksComplete).enable === true || j.requiredAllTasksComplete === true,
  };
}
