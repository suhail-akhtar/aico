/**
 * GitBucket's pull request shape folded into `PullState`.
 *
 * WHY separate and not the GitHub fold. GitBucket speaks GitHub's API v3 for issues, comments,
 * milestones and commit statuses (those reuse `connections/github/fold`), but its pull request
 * is a thinner object: `mergeable` is a plain boolean worked out synchronously, there is no
 * `mergeable_state`, no `draft`, and no reviews or check-runs endpoint to read. The GitHub
 * rules (`canMerge` only for `clean|unstable|has_hooks`) would therefore say "never mergeable"
 * for every GitBucket pull request. So the verdict is built here from what GitBucket does say,
 * with the same conservatism as the other adapters:
 *
 *  - `canMerge` needs an open pull request GitBucket calls mergeable and every commit status it
 *    can see finished and green (a protected branch's required contexts are enforced by GitBucket
 *    itself when asked to merge; AICO does not offer the click over a red or running one).
 *  - `mergeable` is `unknown` when GitBucket sends nothing, never `mergeable`.
 *  - Reviews are always `none`: GitBucket has no reviews API, so approvals and requested
 *    changes cannot be seen, and the page says so (the capability is simply absent).
 *
 * What it does not do: make requests, or decide to merge.
 *
 * @module connections/gitbucket/fold
 */

import type { PullState, RemoteCheck } from '../../../shared/connections/types.js';
import type { ProtectionInfo } from '../adapter.js';
import { checkState, foldStatus, safeUrl, type RawStatus } from '../github/fold.js';

export interface RawBucketPull {
  number: number;
  html_url?: string;
  state?: string;
  title?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  mergeable?: boolean | null;
  head?: { sha?: string; ref?: string };
  base?: { ref?: string };
}

export function foldState(pr: Pick<RawBucketPull, 'state' | 'merged' | 'merged_at'>): PullState['state'] {
  if (pr.merged === true || (pr.merged === undefined && !!pr.merged_at)) return 'merged';
  return pr.state === 'closed' ? 'closed' : 'open';
}

export function foldMergeable(pr: Pick<RawBucketPull, 'state' | 'merged' | 'merged_at' | 'mergeable'>): PullState['mergeable'] {
  if (foldState(pr) !== 'open') return 'unknown';
  if (pr.mergeable === true) return 'mergeable';
  if (pr.mergeable === false) return 'conflicting';
  return 'unknown';
}

export interface FoldBucketPullInput {
  connection: string;
  pr: RawBucketPull;
  statuses: RawStatus[];
  protection?: ProtectionInfo | undefined;
  now?: string;
}

export function foldPull(i: FoldBucketPullInput): PullState {
  const { pr } = i;
  const state = foldState(pr);
  const items: RemoteCheck[] = i.statuses.map(foldStatus);
  const checks = { state: checkState(items), items };
  const mergeable = foldMergeable(pr);
  const readable = i.protection && !i.protection.unreadable ? i.protection : undefined;
  const canMerge = state === 'open' && pr.mergeable === true && (checks.state === 'none' || checks.state === 'passing');
  const blockers: string[] = [];
  if (state === 'open') {
    if (mergeable === 'conflicting') blockers.push('The branch has conflicts with the base branch.');
    else if (mergeable === 'unknown') blockers.push('GitBucket has not said whether this can be merged.');
    for (const c of items) if (c.state === 'failure') blockers.push(`Check failed: ${c.name}`);
    if (checks.state === 'pending') blockers.push('Checks are still running.');
  }
  return {
    connection: i.connection,
    id: String(pr.number),
    url: safeUrl(pr.html_url) ?? '',
    state,
    draft: false,
    headSha: pr.head?.sha ?? '',
    mergeable,
    checks,
    reviews: { state: 'none', approved: 0, changesRequested: 0 },
    canMerge,
    mergeBlockers: [...new Set(blockers)],
    ...(readable ? { protectedBase: readable.protected } : {}),
    ...(state === 'merged' && pr.merge_commit_sha ? { mergedSha: pr.merge_commit_sha } : {}),
    observedAt: i.now ?? new Date().toISOString(),
  };
}
