/**
 * Azure DevOps' wire shapes folded into AICO's normalised `PullState`, `RemoteCheck`, `RemoteItem`,
 * `Comment` and `Iteration`. Pure: no requests, no clock but an injectable one.
 *
 * WHY separate. This is where Azure's habits become rules the rest of the engine relies on, and
 * Azure's habits are different from GitHub's in ways that are easy to get wrong:
 *
 *  - **A pull request is mergeable because its POLICIES say so.** `mergeStatus: succeeded` only
 *    means the files merge; branch policies (minimum reviewers, required reviewers, build
 *    validation, comment resolution, work item linking) are separate evaluations. `canMerge` is
 *    true only when the merge succeeds AND every blocking evaluation is approved AND the
 *    evaluations were readable. When the token cannot read them the answer is "unknown, so no", with
 *    a sentence saying why, never a guess that would invite a merge the remote then refuses.
 *  - **Only builds and statuses are CHECKS.** A failing check sends the task back to the agent
 *    to fix, so a policy that the agent cannot fix by writing code (a missing linked work item,
 *    unresolved comments, a required reviewer) is a merge BLOCKER with a plain sentence, not a
 *    failing check. An optional (non-blocking) build that fails is informational.
 *  - **Votes are not GitHub reviews.** 10 approved, 5 approved with suggestions, 0 no vote, -5
 *    waiting for the author, -10 rejected. Both negative votes ask for changes; group reviewers
 *    (`isContainer`) are requests, never approvals.
 *  - **Work item states are CATEGORIES** (shared/connections/process.ts): the fold reads the
 *    category from the project's own types and falls back to the well-known names only when the
 *    types could not be read.
 *  - **Descriptions are HTML.** They become Markdown-ish text with hidden elements removed (an
 *    element styled `display:none` is invisible to a person but not to a model), then pass through
 *    the same sanitiser as every remote string.
 *
 * What it does not do: make requests, or decide to merge (`canMerge` is Azure's verdict).
 *
 * @module connections/azure-devops/fold
 */

import { normaliseCategory, POINTS_FIELDS, isClosedCategory, type StateCategory, type TypeStates } from '../../../shared/connections/process.js';
import type { CheckState, PullState, RemoteCheck, RepoRef } from '../../../shared/connections/types.js';
import type { Comment, Iteration, RemoteItem } from '../adapter.js';
import { checkState, foldReviews, safeUrl } from '../github/fold.js';
import { REMOTE_LIMITS, sanitizeLine, sanitizeRemoteText } from '../sanitize.js';
import { buildWebUrl, itemWebUrl, pullWebUrl, type AzureBase } from './urls.js';

// ── raw shapes (only what is read) ────────────────────────────────────────

export interface RawIdentity { displayName?: string; uniqueName?: string; id?: string }
export interface RawReviewer extends RawIdentity { vote?: number; isRequired?: boolean; hasDeclined?: boolean; isContainer?: boolean }
export interface RawPr {
  pullRequestId: number;
  status?: string;
  title?: string;
  description?: string;
  isDraft?: boolean;
  mergeStatus?: string;
  sourceRefName?: string;
  targetRefName?: string;
  lastMergeSourceCommit?: { commitId?: string };
  lastMergeCommit?: { commitId?: string };
  createdBy?: RawIdentity;
  reviewers?: RawReviewer[];
  repository?: { id?: string; name?: string; project?: { id?: string; name?: string; visibility?: string } };
}
export interface RawEvaluation {
  evaluationId?: string;
  status?: string;
  configuration?: {
    id?: number; isEnabled?: boolean; isBlocking?: boolean;
    type?: { id?: string; displayName?: string };
    settings?: { minimumApproverCount?: number; displayName?: string; buildDefinitionId?: number; scope?: Array<{ refName?: string; matchKind?: string; repositoryId?: string | null }> };
  };
  context?: { buildId?: number; isExpired?: boolean };
}
export interface RawStatus { id?: number; state?: string; description?: string; context?: { name?: string; genre?: string }; targetUrl?: string }
export interface RawBuild { id?: number; buildNumber?: string; status?: string; result?: string; definition?: { name?: string }; sourceVersion?: string; _links?: { web?: { href?: string } } }
export interface RawThread {
  id?: number; status?: string; isDeleted?: boolean;
  comments?: Array<{ id?: number; author?: RawIdentity; content?: string; publishedDate?: string; commentType?: string; isDeleted?: boolean }>;
}
export interface RawWorkItem { id: number; rev?: number; fields?: Record<string, unknown>; relations?: Array<{ rel?: string; url?: string }> }

export const POLICY = {
  minReviewers: 'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd',
  build: '0609b952-1397-4640-95ec-e00a01b2c241',
  requiredReviewers: 'fd2167ab-b0be-447a-8ec8-39368250530e',
  comments: 'c6a1889d-b943-4856-b76f-9e46bb6b0df2',
  workItems: '40e92b44-2fe1-4dd6-b3d8-74a9c21d0c6e',
  status: 'cbdc66da-9728-4af8-aada-9a5a32e4a226',
} as const;

export type PolicyKind = 'min-reviewers' | 'build' | 'required-reviewers' | 'comments' | 'work-items' | 'status' | 'other';

export function policyKind(cfg: RawEvaluation['configuration']): PolicyKind {
  const id = cfg?.type?.id?.toLowerCase();
  if (id === POLICY.minReviewers) return 'min-reviewers';
  if (id === POLICY.build) return 'build';
  if (id === POLICY.requiredReviewers) return 'required-reviewers';
  if (id === POLICY.comments) return 'comments';
  if (id === POLICY.workItems) return 'work-items';
  if (id === POLICY.status) return 'status';
  const name = cfg?.type?.displayName ?? '';
  if (/minimum number of reviewers/i.test(name)) return 'min-reviewers';
  if (/required reviewers?/i.test(name)) return 'required-reviewers';
  if (/\bbuild\b/i.test(name)) return 'build';
  if (/comment/i.test(name)) return 'comments';
  if (/work item/i.test(name)) return 'work-items';
  if (/^status/i.test(name)) return 'status';
  return 'other';
}

// ── HTML to text ──────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
function decodeEntities(t: string): string {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Markup that hides text from a reader: dropped with everything inside it. Non-nested; good against the lazy trick, not a parser. */
const HIDDEN_ELEMENT = /<([a-z][a-z0-9]*)\b[^>]*?(?:\shidden(?=[\s/>])|\shidden\s*=\s*["'](?:|hidden|true)["']|\sstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|["'])|opacity\s*:\s*0(?:\.0+)?\s*(?:;|["'])))[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** An Azure DevOps HTML field as plain Markdown-ish text. Idempotent on plain text. */
export function htmlToMarkdown(html: unknown): string {
  if (typeof html !== 'string' || !html) return '';
  let t = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  // Three passes catch an element hidden inside another hidden one; a replace with a global regex starts from 0 each time.
  for (let i = 0; i < 3; i++) t = t.replace(HIDDEN_ELEMENT, '');
  t = t
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|h[1-6]|tr|ul|ol|table|blockquote|pre)>/gi, '\n')
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, text: string) => {
      const label = text.replace(/<[^>]+>/g, '').trim();
      const url = safeUrl(decodeEntities(href));
      return url && label && label !== url ? `${label} (${url})` : label || url || '';
    })
    .replace(/<[^>]+>/g, '');
  t = decodeEntities(t);
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Markdown the way AICO writes it to a History/description field: escaped, paragraphs and line breaks kept. */
export function markdownToHtml(md: string): string {
  const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div>${esc.replace(/\r?\n/g, '<br>')}</div>`;
}

// ── work item states ──────────────────────────────────────────────────────

/** `type (lower) -> state (lower) -> category`. */
export type StatesIndex = Map<string, Map<string, StateCategory>>;

export function indexStates(types: readonly TypeStates[]): StatesIndex {
  const out: StatesIndex = new Map();
  for (const t of types) out.set(t.name.toLowerCase(), new Map(t.states.map(s => [s.name.toLowerCase(), s.category])));
  return out;
}

/** The well-known names, used only when the project's own types could not be read. */
const WELL_KNOWN: Record<string, StateCategory> = {
  new: 'proposed', 'to do': 'proposed', proposed: 'proposed', approved: 'proposed', design: 'proposed', open: 'proposed',
  active: 'inprogress', doing: 'inprogress', committed: 'inprogress', 'in progress': 'inprogress', ready: 'inprogress',
  resolved: 'resolved', done: 'completed', closed: 'completed', completed: 'completed', removed: 'removed', cut: 'removed',
};

export function categoryOf(index: StatesIndex | undefined, type: string, state: string): StateCategory {
  const known = index?.get(type.toLowerCase())?.get(state.toLowerCase());
  if (known) return known;
  return WELL_KNOWN[state.toLowerCase()] ?? 'proposed';
}

// ── work items ────────────────────────────────────────────────────────────

export const F = {
  id: 'System.Id', title: 'System.Title', state: 'System.State', type: 'System.WorkItemType', tags: 'System.Tags',
  assignedTo: 'System.AssignedTo', createdBy: 'System.CreatedBy', iteration: 'System.IterationPath', area: 'System.AreaPath',
  project: 'System.TeamProject', description: 'System.Description', history: 'System.History', changed: 'System.ChangedDate',
  acceptance: 'Microsoft.VSTS.Common.AcceptanceCriteria', repro: 'Microsoft.VSTS.TCM.ReproSteps', priority: 'Microsoft.VSTS.Common.Priority',
} as const;

/** The fields every import asks for. */
export const ITEM_FIELDS: readonly string[] = [
  F.id, F.title, F.state, F.type, F.tags, F.assignedTo, F.createdBy, F.iteration, F.area, F.project, F.description,
  F.acceptance, F.repro, F.changed, ...POINTS_FIELDS,
];

function identityName(x: unknown): string {
  if (typeof x === 'string') return sanitizeLine(x.replace(/\s*<[^>]*>\s*$/, ''), 80);
  if (x && typeof x === 'object') {
    const o = x as RawIdentity;
    return sanitizeLine(o.displayName || o.uniqueName, 80);
  }
  return '';
}

/** `a; b;c` -> ['a','b','c']. Azure DevOps keeps tags in one semicolon-separated field. */
export function splitTags(tags: unknown): string[] {
  if (typeof tags !== 'string') return [];
  return tags.split(';').map(t => sanitizeLine(t, REMOTE_LIMITS.label)).filter(Boolean);
}
export function joinTags(tags: readonly string[]): string {
  return [...new Set(tags.map(t => t.replace(/[;\r\n]/g, ' ').trim()).filter(Boolean))].join('; ');
}

function numberField(fields: Record<string, unknown>, names: readonly string[]): number | undefined {
  for (const n of names) {
    const v = fields[n];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** The area path below the project root ("Shop\\Web" for "Shop\\Web"; undefined for the root itself). */
function areaLabel(area: unknown, project: string): string | undefined {
  if (typeof area !== 'string') return undefined;
  const a = sanitizeLine(area, 120);
  if (!a || a.toLowerCase() === project.toLowerCase()) return undefined;
  return `area:${a}`;
}

export function foldItem(raw: RawWorkItem, base: AzureBase, index?: StatesIndex): RemoteItem {
  const f = raw.fields ?? {};
  const project = sanitizeLine(f[F.project], 128);
  const type = sanitizeLine(f[F.type], 60);
  const state = sanitizeLine(f[F.state], 60);
  const category = categoryOf(index, type, state);
  const desc = htmlToMarkdown(f[F.description]) || htmlToMarkdown(f[F.repro]);
  const acceptance = htmlToMarkdown(f[F.acceptance]);
  // The acceptance criteria field becomes the "## Acceptance" checklist Delivery already parses from a body.
  const body = sanitizeRemoteText(acceptance && !/^#{1,6}\s*acceptance\b/im.test(desc) ? `${desc}${desc ? '\n\n' : ''}## Acceptance\n${acceptance}` : desc, REMOTE_LIMITS.body);
  const tags = splitTags(f[F.tags]);
  const area = areaLabel(f[F.area], project);
  const labels = area ? [...tags, area] : tags;
  const assignee = identityName(f[F.assignedTo]);
  const points = numberField(f, POINTS_FIELDS);
  // An item in the project's root iteration ("Shop") has been assigned to no sprint; a sprint's path has a backslash ("Shop\Sprint 1").
  const iterationPath = typeof f[F.iteration] === 'string' ? sanitizeLine(f[F.iteration], 400) : '';
  const iteration = iterationPath.includes('\\') ? iterationPath : undefined;
  return {
    id: String(raw.id),
    number: raw.id,
    title: sanitizeLine(f[F.title], REMOTE_LIMITS.title),
    body,
    state: isClosedCategory(category) ? 'closed' : 'open',
    labels,
    assignees: assignee ? [assignee] : [],
    author: identityName(f[F.createdBy]),
    url: project ? itemWebUrl(base, project, raw.id) : '',
    rev: String(raw.rev ?? ''),
    ...(points !== undefined ? { points } : {}),
    ...(iteration ? { iteration } : {}),
    ...(state ? { stateName: state } : {}),
    stateCategory: category,
    ...(type ? { kind: type } : {}),
  };
}

// ── pull requests ─────────────────────────────────────────────────────────

const refName = (r: string | undefined): string => (r ?? '').replace(/^refs\/heads\//, '');

export function foldMergeable(mergeStatus: string | undefined): PullState['mergeable'] {
  switch (mergeStatus) {
    case 'succeeded': case 'rejectedByPolicy': return 'mergeable';
    case 'conflicts': return 'conflicting';
    default: return 'unknown'; // notSet, queued, failure: not known yet
  }
}

/** A policy's name for a person: the build definition's display name when it has one, else the policy type's. */
function policyName(e: RawEvaluation): string {
  const s = e.configuration?.settings;
  return sanitizeLine(s?.displayName || e.configuration?.type?.displayName || 'Branch policy', REMOTE_LIMITS.title);
}

function evaluationBlocks(e: RawEvaluation): boolean {
  const c = e.configuration;
  if (!c || c.isEnabled === false || c.isBlocking === false) return false;
  return e.status !== 'approved' && e.status !== 'notApplicable';
}

export function foldVote(vote: number | undefined): 'approved' | 'changes' | 'none' {
  if (typeof vote !== 'number') return 'none';
  if (vote >= 5) return 'approved';
  if (vote <= -5) return 'changes';
  return 'none';
}

/** Individual reviewers' votes folded with the same rules as every other adapter's reviews. */
export function foldPrReviews(reviewers: readonly RawReviewer[], required: number | undefined): PullState['reviews'] {
  const people = reviewers.filter(r => !r.isContainer && !r.hasDeclined);
  const raws = people.map((r, i) => ({
    id: i, user: { login: r.uniqueName || r.displayName || String(r.id ?? i) },
    state: foldVote(r.vote) === 'approved' ? 'APPROVED' : foldVote(r.vote) === 'changes' ? 'CHANGES_REQUESTED' : 'COMMENTED',
  }));
  // Anyone asked and not yet answered (and every group) is a pending request.
  const requested = reviewers.filter(r => !r.hasDeclined && (r.isContainer || foldVote(r.vote) === 'none')).length;
  return foldReviews(raws, requested, required);
}

export function foldBuildResult(b: RawBuild, base: AzureBase, project: string, name?: string): RemoteCheck {
  let state: RemoteCheck['state'];
  if (b.status && b.status !== 'completed') state = 'pending';
  else if (b.result === 'succeeded') state = 'success';
  else if (b.result === 'failed' || b.result === 'canceled') state = 'failure';
  else if (b.result === 'partiallySucceeded') state = 'neutral';
  else state = 'neutral';
  const label = sanitizeLine(name ?? b.definition?.name ?? 'Build', REMOTE_LIMITS.title);
  const url = typeof b.id === 'number' ? buildWebUrl(base, project, b.id) : safeUrl(b._links?.web?.href);
  const summary = state === 'neutral' && b.result === 'partiallySucceeded' ? 'Completed with warnings.' : b.buildNumber ? `Build ${sanitizeLine(b.buildNumber, 60)}` : '';
  return { name: label, state, ...(url ? { url } : {}), ...(summary ? { summary } : {}) };
}

function foldStatusCheck(s: RawStatus): RemoteCheck {
  const state: RemoteCheck['state'] = s.state === 'succeeded' ? 'success' : s.state === 'pending' ? 'pending'
    : s.state === 'failed' || s.state === 'error' ? 'failure' : 'skipped';
  const name = [s.context?.genre, s.context?.name].filter(Boolean).join('/');
  const summary = sanitizeRemoteText(s.description ?? '', REMOTE_LIMITS.summary);
  const url = safeUrl(s.targetUrl);
  return { name: sanitizeLine(name, REMOTE_LIMITS.title) || '(unnamed status)', state, ...(url ? { url } : {}), ...(summary ? { summary } : {}) };
}

/** The newest status per context: a PR gets a fresh set on each push and the old ones stay in the list. */
export function latestStatuses(list: readonly RawStatus[]): RawStatus[] {
  const best = new Map<string, RawStatus>();
  for (const s of list) {
    const key = `${s.context?.genre ?? ''}/${s.context?.name ?? ''}`;
    const cur = best.get(key);
    if (!cur || (s.id ?? 0) >= (cur.id ?? 0)) best.set(key, s);
  }
  return [...best.values()];
}

export interface FoldPullInput {
  connection: string;
  base: AzureBase;
  repo: RepoRef;
  pr: RawPr;
  /** Policy evaluations for the PR; undefined when the token or the server could not read them. */
  evaluations?: RawEvaluation[] | undefined;
  statuses: RawStatus[];
  /** PR builds, used only when the policy evaluations could not be read. */
  builds?: RawBuild[] | undefined;
  /** Just created: the policies are computed asynchronously and have not started, which is not the same as unreadable. */
  fresh?: boolean;
  now?: string;
}

export function foldPull(i: FoldPullInput): PullState {
  const { pr } = i;
  const project = pr.repository?.project?.name ?? i.repo.owner;
  const state: PullState['state'] = pr.status === 'completed' ? 'merged' : pr.status === 'abandoned' ? 'closed' : 'open';
  const draft = pr.isDraft === true;
  const evals = i.evaluations;
  const readable = evals !== undefined;
  const active = (evals ?? []).filter(e => e.configuration?.isEnabled !== false);

  // Checks: build validation and status policies, then PR statuses; the builds list only when policies were unreadable.
  const checks: RemoteCheck[] = [];
  for (const e of active) {
    const kind = policyKind(e.configuration);
    if (kind !== 'build' && kind !== 'status') continue;
    const blocking = e.configuration?.isBlocking !== false;
    let s: RemoteCheck['state'];
    if (e.status === 'approved') s = 'success';
    else if (e.status === 'queued' || e.status === 'running') s = 'pending';
    else if (e.status === 'notApplicable') s = 'skipped';
    else s = blocking ? 'failure' : 'neutral'; // rejected, broken: an optional check that fails does not send the task back
    const url = typeof e.context?.buildId === 'number' ? buildWebUrl(i.base, project, e.context.buildId) : undefined;
    checks.push({ name: policyName(e), state: s, ...(url ? { url } : {}), ...(e.context?.isExpired && s === 'success' ? { summary: 'The build is out of date with the target branch.' } : {}) });
  }
  if (!readable) for (const b of i.builds ?? []) checks.push(foldBuildResult(b, i.base, project));
  const policyStatusNames = new Set(checks.map(c => c.name.toLowerCase()));
  for (const s of latestStatuses(i.statuses)) {
    const c = foldStatusCheck(s);
    if (!policyStatusNames.has(c.name.toLowerCase())) checks.push(c);
  }
  const checkSummary: { state: CheckState; items: RemoteCheck[] } = { state: checkState(checks), items: checks };

  const minReviewers = active.find(e => policyKind(e.configuration) === 'min-reviewers');
  const protectedBase = readable ? active.some(e => e.configuration?.isBlocking !== false) : undefined;
  const required = readable && protectedBase ? (minReviewers?.configuration?.settings?.minimumApproverCount ?? 0) : undefined;
  const reviews = foldPrReviews(pr.reviewers ?? [], required);

  const blockers: string[] = [];
  const mergeable = foldMergeable(pr.mergeStatus);
  if (state === 'open') {
    if (draft) blockers.push('The pull request is a draft.');
    if (pr.mergeStatus === 'conflicts') blockers.push('The branch has conflicts with the target branch.');
    else if (pr.mergeStatus === 'failure') blockers.push('Azure DevOps could not work out whether this can be merged.');
    else if (pr.mergeStatus === 'notSet' || pr.mergeStatus === 'queued' || !pr.mergeStatus) blockers.push('Azure DevOps has not finished working out whether this can be merged yet.');
    if (i.fresh) blockers.push('Azure DevOps is still evaluating the branch policies.');
    else if (!readable) blockers.push('The branch policies could not be read with this token, so AICO cannot tell whether they are met. Merge it on Azure DevOps.');
    for (const e of active) {
      if (!evaluationBlocks(e)) continue;
      const kind = policyKind(e.configuration);
      const name = policyName(e);
      const pending = e.status === 'queued' || e.status === 'running';
      if (kind === 'min-reviewers') {
        const need = e.configuration?.settings?.minimumApproverCount ?? 1;
        blockers.push(`${reviews.approved} of ${need} required approvals.`);
      } else if (kind === 'required-reviewers') blockers.push('A required reviewer has not approved yet.');
      else if (kind === 'build' || kind === 'status') blockers.push(pending ? `${name} is still running.` : `${name} has not passed.`);
      else if (kind === 'comments') blockers.push('Comments are not all resolved.');
      else if (kind === 'work-items') blockers.push('A linked work item is required.');
      else blockers.push(`The policy "${name}" is not satisfied.`);
    }
    if (reviews.changesRequested > 0) blockers.push('A reviewer has requested changes.');
  }
  const canMerge = state === 'open' && !draft && pr.mergeStatus === 'succeeded' && readable
    && !active.some(evaluationBlocks) && reviews.changesRequested === 0;

  const merged = state === 'merged';
  const mergedSha = merged ? pr.lastMergeCommit?.commitId : undefined;
  return {
    connection: i.connection,
    id: String(pr.pullRequestId),
    url: pullWebUrl(i.base, { owner: project, name: pr.repository?.name ?? i.repo.name }, pr.pullRequestId),
    state,
    draft,
    headSha: pr.lastMergeSourceCommit?.commitId ?? '',
    mergeable,
    checks: checkSummary,
    reviews,
    canMerge,
    mergeBlockers: [...new Set(blockers)],
    ...(protectedBase !== undefined ? { protectedBase } : {}),
    ...(mergedSha ? { mergedSha } : {}),
    observedAt: i.now ?? new Date().toISOString(),
  };
}

// ── comments ──────────────────────────────────────────────────────────────

/**
 * Conversation comments in order, newest last. Azure DevOps has no author_association; commenting needs
 * permission on the project, so in a PRIVATE project every author is a member. In a public project a
 * stranger may be able to comment, so only the PR's creator and its reviewers are MEMBERs there.
 */
export function foldThreads(threads: readonly RawThread[], pr: RawPr, projectVisibility: string | undefined): Comment[] {
  const insiders = new Set<string>();
  for (const x of [pr.createdBy, ...(pr.reviewers ?? [])]) {
    for (const n of [x?.uniqueName, x?.displayName]) if (n) insiders.add(n.toLowerCase());
  }
  const privateProject = projectVisibility === 'private';
  const out: Comment[] = [];
  for (const t of threads) {
    if (t.isDeleted) continue;
    for (const c of t.comments ?? []) {
      if (c.isDeleted || c.commentType === 'system' || typeof c.content !== 'string') continue;
      const author = identityName(c.author);
      const member = privateProject || [c.author?.uniqueName, c.author?.displayName].some(n => n && insiders.has(n.toLowerCase()));
      out.push({
        id: `${t.id ?? 0}.${c.id ?? 0}`,
        author,
        association: member ? 'MEMBER' : 'NONE',
        body: sanitizeRemoteText(htmlToMarkdown(c.content), REMOTE_LIMITS.comment),
        at: c.publishedDate ?? '',
      });
    }
  }
  return out.map((c, i) => ({ c, i })).sort((a, b) => (Date.parse(a.c.at) || 0) - (Date.parse(b.c.at) || 0) || a.i - b.i).map(x => x.c);
}

// ── iterations ────────────────────────────────────────────────────────────

const day = (s: unknown): string | undefined => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined);

export interface RawTeamIteration { id?: string; name?: string; path?: string; attributes?: { startDate?: string | null; finishDate?: string | null; timeFrame?: string } }
export interface RawNode { identifier?: string; name?: string; path?: string; attributes?: { startDate?: string | null; finishDate?: string | null }; children?: RawNode[] }

export function foldTeamIteration(r: RawTeamIteration): Iteration | undefined {
  if (!r.id || !r.name) return undefined;
  const start = day(r.attributes?.startDate);
  const end = day(r.attributes?.finishDate);
  const tf = r.attributes?.timeFrame;
  const timeFrame = tf === 'past' || tf === 'current' || tf === 'future' ? tf : undefined;
  return {
    id: r.id, title: sanitizeLine(r.name, REMOTE_LIMITS.title), kind: 'iteration',
    state: timeFrame === 'past' ? 'closed' : 'open',
    ...(start ? { start } : {}), ...(end ? { end } : {}),
    ...(r.path ? { itemKey: sanitizeLine(r.path, 400) } : {}), ...(timeFrame ? { timeFrame } : {}),
  };
}

/** `\Project\Iteration\Release 1\Sprint 2` (classification node path) as the `System.IterationPath` items carry: `Project\Release 1\Sprint 2`. */
export function nodePathToItemPath(nodePath: string): string {
  const segs = nodePath.split('\\').filter(Boolean);
  if (segs.length >= 2 && segs[1]!.toLowerCase() === 'iteration') segs.splice(1, 1);
  return segs.join('\\');
}

/** The leaves of the classification tree that carry dates: those are the sprints. */
export function foldNodes(root: RawNode | undefined, today: string): Iteration[] {
  const out: Iteration[] = [];
  const walk = (n: RawNode): void => {
    const start = day(n.attributes?.startDate);
    const end = day(n.attributes?.finishDate);
    if (n.identifier && n.name && (start || end) && n.path) {
      out.push({
        id: n.identifier, title: sanitizeLine(n.name, REMOTE_LIMITS.title), kind: 'iteration',
        state: end && end < today ? 'closed' : 'open',
        ...(start ? { start } : {}), ...(end ? { end } : {}),
        itemKey: sanitizeLine(nodePathToItemPath(n.path), 400),
        timeFrame: end && end < today ? 'past' : start && start > today ? 'future' : 'current',
      });
    }
    for (const c of n.children ?? []) walk(c);
  };
  if (root) walk(root);
  return out;
}
