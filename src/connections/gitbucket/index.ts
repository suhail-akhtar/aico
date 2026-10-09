/**
 * The GitBucket adapter: GitHub's API v3 as GitBucket implements it, at `<base>/api/v3`
 * (ADR 0039: "run through the GitHub adapter in a compat profile whose capabilities come
 * entirely from the probe").
 *
 * WHAT is reused and what is not. Issues, labels, comments and milestones have GitHub's wire
 * shapes, so `githubAdapter.items`, `.iterations.assign/create` and `.pulls.comment` are
 * delegated to as they are (their errors are re-worded "GitBucket" on the way out) and the
 * GitHub fold modules (`foldItem`, `foldStatus`, `foldComment`) shape what comes back. What
 * GitBucket does not have, or has differently, is written here, and EACH GAP IS A CAPABILITY
 * FLAG THAT STAYS OFF, shown to the person as a missing chip rather than discovered as a failure:
 *
 *  - no check-runs endpoint: checks are commit statuses only (`checks.rerun` and `logsUrl` off);
 *  - no reviews endpoint: reviews are always `none`, approvals and requested changes are not read;
 *  - no draft pull requests, no merge queue, no auto-merge, no Projects: `pulls.draft` off,
 *    iterations are milestones;
 *  - no `mergeable_state`, no `head=` filter on pull requests, no search API, and no `since`
 *    or `labels` filter on the issue list that can be relied on: pull requests are found by
 *    scanning the open list, work items are filtered here (label, assignee, text, update time),
 *    and the merge compares the head SHA itself because the merge call cannot be told to;
 *  - tokens have no scopes and no expiry endpoint: nothing is reported, capabilities are probed;
 *  - the HTTP clone URL has a `/git/` prefix (`<base>/git/owner/repo.git`).
 *
 * Honest limit: GitBucket's API surface moves between releases and these shapes are from its
 * documentation and source, not a live server. The conformance suite covers the supported
 * subset against hand-written fixtures; the first live add on a real instance is the owner's.
 *
 * What it does not do: choose what to sync or when to merge (sync.ts, landing.ts), read or
 * write branch protections beyond reporting them, or anything on the "no" list above.
 *
 * @module connections/gitbucket
 */

import type { Capabilities, ProbeResult, PullState, RepoRef, ScopeAdvice } from '../../../shared/connections/types.js';
import {
  noCapabilities,
  type AdapterCtx, type Comment, type ItemQuery, type Iteration, type NewPull, type ProtectionInfo,
  type ProviderAdapter, type RemoteItem, type RepoInfo,
} from '../adapter.js';
import { ConnectionError, type ConnResponse } from '../http.js';
import { githubAdapter } from '../github/index.js';
import { clipText, foldComment, foldItem, foldStatus, type RawComment, type RawIssue, type RawStatus } from '../github/fold.js';
import { asArr, asObj, baseOf, enc, makeRest, optional, parseItemQuery, parseRemoteSegments, type Obj } from '../rest.js';
import { REMOTE_LIMITS, sanitizeLine, withoutAttribution } from '../sanitize.js';
import type { StoredConnection } from '../types.js';
import { foldPull, type RawBucketPull } from './fold.js';

const PULL_BODY_MAX = 60_000;
const COMMENT_MAX = 60_000;

function bMessage(res: ConnResponse): string {
  const j = asObj(res.json);
  const errors = asArr(j.errors).map(e => (typeof e === 'string' ? e : String(asObj(e).message ?? ''))).filter(Boolean);
  return sanitizeLine(typeof j.message === 'string' && j.message ? j.message : errors[0] ?? '', 240);
}
const { call, failure, getJson, paged, write } = makeRest({ name: 'GitBucket', message: bMessage });

export function gitbucketApiBase(conn: Pick<StoredConnection, 'baseUrl'>): string {
  const b = baseOf(conn.baseUrl);
  if (!b) throw new ConnectionError(`"${conn.baseUrl}" is not a URL.`, 'config');
  return `${b.origin}${b.pathname}/api/v3`;
}

/** `https://h[/prefix]/owner/name`, the clone form `https://h[/prefix]/git/owner/name.git`, and `ssh://user@h:29418/owner/name.git`. */
export function parseGitbucketRemote(url: string, baseUrl: string): RepoRef | undefined {
  const segs = parseRemoteSegments(url, baseUrl, { min: 2, max: 3 });
  if (!segs) return undefined;
  const parts = segs.length === 3 ? (segs[0] === 'git' ? segs.slice(1) : undefined) : segs;
  return parts ? { owner: parts[0]!, name: parts[1]! } : undefined;
}

/** Re-word the GitHub adapter's messages for this server. */
function renamed<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  return async (...a: A): Promise<R> => {
    try { return await fn(...a); } catch (e) {
      if (e instanceof ConnectionError) e.message = e.message.replace(/\bGitHub\b/g, 'GitBucket');
      throw e;
    }
  };
}

function repoOf(ctx: AdapterCtx): RepoRef {
  if (!ctx.repo) throw new ConnectionError('This operation needs a repository: map the project to a GitBucket repository first.', 'config');
  return ctx.repo;
}
const repoPath = (ctx: AdapterCtx): string => { const r = repoOf(ctx); return `/repos/${enc(r.owner)}/${enc(r.name)}`; };
const branchPath = (b: string): string => b.split('/').map(enc).join('/');
function num(id: string, what: string): number {
  if (!/^\d{1,9}$/.test(id)) throw new ConnectionError(`"${id.slice(0, 40)}" is not a GitBucket ${what} number.`, 'config');
  return Number(id);
}
function sha(s: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(s)) throw new ConnectionError('That is not a commit SHA.', 'config');
  return s;
}
const isoOrUndefined = (s: string | undefined): string | undefined => (s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : undefined);

const NEEDED: ScopeAdvice[] = [
  { scope: 'A personal access token', why: 'GitBucket tokens have no scopes: the account\'s own rights apply. Use a dedicated account with write access to the repository only.', feature: 'pulls', required: true },
];

// ── protection ───────────────────────────────────────────────────────────

async function readProtection(ctx: AdapterCtx, branch: string): Promise<ProtectionInfo> {
  const res = await call(ctx, { path: `${repoPath(ctx)}/branches/${branchPath(branch)}` });
  if (res.status === 403) return { protected: false, unreadable: 'the token cannot read branch settings' };
  if (res.status === 404) return { protected: false, unreadable: `GitBucket has no branch ${branch}, or the token cannot see it` };
  if (res.status !== 200) throw failure(res, `branch protection for ${branch}`);
  const b = asObj(res.json);
  const prot = asObj(b.protection);
  if (b.protected !== true && prot.enabled !== true) return { protected: false };
  const sc = asObj(prot.required_status_checks);
  const contexts = asArr(sc.contexts).map(c => sanitizeLine(c, REMOTE_LIMITS.title)).filter(Boolean);
  // GitBucket has no required-review rule to read.
  return { protected: true, requiredReviews: 0, requiredChecks: contexts };
}

// ── pull requests ────────────────────────────────────────────────────────

async function fetchPull(ctx: AdapterCtx, id: string): Promise<PullState> {
  const n = num(id, 'pull request');
  const base = repoPath(ctx);
  const { json } = await getJson(ctx, { path: `${base}/pulls/${n}` }, `Pull request #${n}`);
  const pr = json as RawBucketPull;
  const head = pr.head?.sha ?? '';
  let statuses: RawStatus[] = [];
  if (head) {
    const s = await call(ctx, { path: `${base}/commits/${head}/status` });
    if (s.status === 200) statuses = asArr(asObj(s.json).statuses) as RawStatus[];
    else if (s.status !== 403 && s.status !== 404) throw failure(s, `The commit status of #${n}`);
  }
  const protection = pr.base?.ref ? await readProtection(ctx, pr.base.ref).catch(optional) : undefined;
  return foldPull({ connection: ctx.conn.id, pr, statuses, ...(protection ? { protection } : {}) });
}

// ── probe ────────────────────────────────────────────────────────────────

async function probe(ctx: AdapterCtx): Promise<ProbeResult> {
  const warnings: string[] = [];
  const userRes = await call(ctx, { path: '/user', conditional: false });
  if (userRes.status !== 200) throw failure(userRes, 'The account behind this token');
  const user = sanitizeLine(asObj(userRes.json).login, 80);

  const caps: Capabilities = noCapabilities();
  caps.repos = true;
  caps.pulls.bodyMax = PULL_BODY_MAX;
  caps.items.estimate = 'label';

  if (ctx.repo) await probeRepo(ctx, caps, warnings);
  else {
    // Nothing mapped yet (the add flow tests before a project exists): check a repository this account can write to.
    const list = await call(ctx, { path: '/user/repos', conditional: false });
    caps.repos = list.status === 200;
    const repos = list.status === 200 ? asArr(list.json).map(asObj) : [];
    const pick = repos.find(r => asObj(r.permissions).push === true) ?? repos[0];
    const full = typeof pick?.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(pick.full_name) ? pick.full_name : undefined;
    if (full) {
      await probeRepo({ ...ctx, repo: { owner: full.split('/')[0]!, name: full.split('/')[1]! } }, caps, warnings);
      warnings.push(`Checked against ${full}: map a project and test again to see what this token can do there.`);
    } else warnings.push('This account has no repository to check the token against: map a project and test again.');
  }
  warnings.push('GitBucket has no check-runs or reviews API: checks come from commit statuses only, and approvals or requested changes are not read.');

  return {
    at: new Date().toISOString(), user, capabilities: caps,
    scopes: { found: [], needed: NEEDED, missing: [], extra: [], reported: false },
    warnings,
  };
}

async function probeRepo(ctx: AdapterCtx, caps: Capabilities, warnings: string[]): Promise<void> {
  const base = repoPath(ctx);
  const r = repoOf(ctx);
  const repo = await call(ctx, { path: base, conditional: false });
  if (repo.status === 404 || repo.status === 403) {
    warnings.push(`The repository ${r.owner}/${r.name} was not found, or this token cannot see it.`);
    return;
  }
  if (repo.status !== 200) throw failure(repo, `The repository ${r.owner}/${r.name}`);
  const rj = asObj(repo.json);
  const perms = asObj(rj.permissions);
  const canWrite = rj.permissions === undefined || perms.push === true || perms.admin === true;
  const branch = typeof rj.default_branch === 'string' && rj.default_branch ? rj.default_branch : 'master';

  const pulls = await call(ctx, { path: `${base}/pulls`, query: { state: 'all' }, conditional: false });
  if (pulls.status === 200) {
    caps.pulls = { create: canWrite, comment: true, merge: canWrite, draft: false, bodyMax: PULL_BODY_MAX };
    if (!canWrite) warnings.push('This token can only read the repository, so AICO cannot open or merge pull requests.');
  } else warnings.push('Pull requests are unreadable with this token.');

  const issues = await call(ctx, { path: `${base}/issues`, query: { state: 'all' }, conditional: false });
  if (issues.status === 200) caps.items = { ...caps.items, query: true, create: true, transition: canWrite, comment: true };
  else warnings.push('Issues are unreadable with this token.');

  const checks = await call(ctx, { path: `${base}/commits/${branchPath(branch)}/status`, conditional: false });
  if (checks.status === 200) caps.checks.read = true;
  else warnings.push('Checks (commit statuses) are unreadable with this token, so pull requests will show no checks.');

  const prot = await readProtection(ctx, branch);
  if (prot.unreadable) warnings.push(`Branch protection unreadable (${prot.unreadable}): AICO cannot see which checks ${branch} requires.`);
  else caps.protection.read = true;

  const ms = await call(ctx, { path: `${base}/milestones`, query: { state: 'all' }, conditional: false });
  caps.iterations = ms.status === 200 ? 'milestone' : 'none';
}

// ── the adapter ──────────────────────────────────────────────────────────

function repoInfo(conn: StoredConnection, j: Obj, ref: RepoRef): RepoInfo {
  const full = typeof j.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(j.full_name) ? j.full_name : `${ref.owner}/${ref.name}`;
  const perms = asObj(j.permissions);
  const root = conn.baseUrl.replace(/\/+$/, '');
  return {
    ref: { owner: full.split('/')[0]!, name: full.split('/')[1]!, ...(j.id !== undefined ? { id: String(j.id) } : {}) },
    defaultBranch: typeof j.default_branch === 'string' && j.default_branch ? sanitizeLine(j.default_branch, 255) : 'master',
    // GitBucket serves git over http under /git/. Rebuilt from the base URL, never copied from the response.
    cloneUrl: `${root}/git/${full}.git`,
    htmlUrl: `${root}/${full}`,
    private: j.private === true,
    ...(j.permissions ? { permissions: { pull: perms.pull === true, push: perms.push === true, admin: perms.admin === true } } : {}),
  };
}

const gh = githubAdapter;
const ghItems = gh.items!;

export const gitbucketAdapter: ProviderAdapter = {
  id: 'gitbucket',

  apiBase: gitbucketApiBase,

  hostsFor(baseUrl) {
    const b = baseOf(baseUrl);
    return b ? [b.host] : [];
  },

  clientOptions(conn) {
    return { apiBase: gitbucketApiBase(conn), auth: { kind: 'bearer', scheme: 'token' }, headers: { Accept: 'application/json' } };
  },

  gitUsername(conn) { return conn.probe?.user || 'x-access-token'; },

  parseRemote: parseGitbucketRemote,

  probe,

  repos: {
    async get(ctx, ref) {
      const c: AdapterCtx = { ...ctx, repo: ref };
      const { json } = await getJson(c, { path: repoPath(c) }, `The repository ${ref.owner}/${ref.name}`);
      return repoInfo(ctx.conn, asObj(json), ref);
    },
    async list(ctx, query) {
      const { items } = await paged<Obj>(ctx, { path: '/user/repos' }, j => asArr(j).map(asObj), 'The repository list', 3);
      const q = query?.trim().toLowerCase();
      return items.filter(r => !q || String(r.full_name ?? '').toLowerCase().includes(q)).map(r => repoInfo(ctx.conn, r, { owner: '', name: '' }));
    },
  },

  pulls: {
    async find(ctx, head) {
      // No `head=` filter: scan the open list for the task branch.
      const out = await paged<Obj>(ctx, { path: `${repoPath(ctx)}/pulls`, query: { state: 'open' } }, j => asArr(j).map(asObj), 'The pull request list', 4);
      const hit = out.items.find(p => asObj(p.head).ref === head);
      return hit && typeof hit.number === 'number' ? fetchPull(ctx, String(hit.number)) : undefined;
    },

    async create(ctx, input: NewPull) {
      const title = withoutAttribution(input.title).replace(/\s+/g, ' ').trim().slice(0, 250);
      if (!title) throw new ConnectionError('A title is required.', 'config');
      const { head, overflow } = clipText(withoutAttribution(input.body ?? ''), PULL_BODY_MAX);
      const res = await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/pulls`, audit: 'pr.open', ref: input.head,
        json: { title, head: input.head, base: input.base, body: head },
      }, 'opening the pull request', 'write access');
      const pull = foldPull({ connection: ctx.conn.id, pr: res.json as RawBucketPull, statuses: [] });
      return { pull, ...(overflow ? { overflow } : {}) };
    },

    async update(ctx, id, patch) {
      const n = num(id, 'pull request');
      const json: Obj = {};
      if (patch.title !== undefined) json.title = withoutAttribution(patch.title).replace(/\s+/g, ' ').trim().slice(0, 250);
      if (patch.body !== undefined) {
        const { head, overflow } = clipText(withoutAttribution(patch.body), PULL_BODY_MAX);
        json.body = overflow ? `${head}\n\n… (cut; the rest is in the first comment)` : head;
      }
      if (patch.state) json.state = patch.state;
      await write(ctx, { method: 'PATCH', path: `${repoPath(ctx)}/pulls/${n}`, json, audit: 'write', ref: id }, `Pull request #${n}`, 'write access');
      return fetchPull(ctx, id);
    },

    comment: renamed((ctx: AdapterCtx, id: string, markdown: string) => gh.pulls!.comment(ctx, id, markdown)),

    get: fetchPull,

    async comments(ctx, id) {
      const n = num(id, 'pull request');
      const convo = await paged<RawComment>(ctx, { path: `${repoPath(ctx)}/issues/${n}/comments` }, j => asArr(j) as RawComment[], `The comments of #${n}`, 3);
      // No author association exists: the owner and the repository's collaborators are the trusted ones.
      const collaborators = new Set<string>();
      const r = await paged<Obj>(ctx, { path: `${repoPath(ctx)}/collaborators` }, j => asArr(j).map(asObj), 'The collaborators', 2).catch(optional);
      for (const c of r?.items ?? []) if (typeof c.login === 'string') collaborators.add(c.login.toLowerCase());
      const owner = repoOf(ctx).owner.toLowerCase();
      const all: Comment[] = convo.items.map(c => {
        const login = (c.user?.login ?? '').toLowerCase();
        return { ...foldComment(c), association: login === owner ? 'OWNER' : collaborators.has(login) ? 'COLLABORATOR' : 'NONE' };
      });
      return all.map((c, i) => ({ c, i })).sort((a, b) => (Date.parse(a.c.at) || 0) - (Date.parse(b.c.at) || 0) || a.i - b.i).map(x => x.c);
    },

    async merge(ctx, id, opts) {
      const n = num(id, 'pull request');
      const base = repoPath(ctx);
      // The merge call cannot be told which head was reviewed, so the head is compared here first.
      const now = (await getJson(ctx, { path: `${base}/pulls/${n}`, conditional: false }, `Pull request #${n}`)).json as RawBucketPull;
      if ((now.head?.sha ?? '') !== sha(opts.sha)) {
        throw new ConnectionError(`#${n} was not merged because its branch changed after it was reviewed. Look at the new commits first.`, 'conflict', 409);
      }
      const res = await call(ctx, { method: 'PUT', path: `${base}/pulls/${n}/merge`, audit: 'pr.merge', ref: id, json: { merge_method: opts.method } });
      if (res.status === 200) return { sha: typeof asObj(res.json).sha === 'string' ? String(asObj(res.json).sha) : '' };
      if (res.status === 405 || res.status === 409) throw new ConnectionError(`GitBucket will not merge #${n} right now: ${bMessage(res) || 'it is not mergeable.'}`, 'conflict', res.status);
      throw failure(res, `Merging #${n}`, 'write access');
    },
  },

  items: {
    async query(ctx, q: ItemQuery) {
      if (q.source === 'off') return { items: [], notModified: true };
      const state = q.state ?? 'open';
      const since = isoOrUndefined(q.since);
      if (q.source === 'label' && !q.value?.trim()) throw new ConnectionError('Importing by label needs a label name.', 'config');
      if (q.source === 'assigned-to-me' && !q.me) throw new ConnectionError('Importing items assigned to you needs to know which account the token acts as; test the connection first.', 'config');
      const out = await paged<RawIssue>(ctx, { path: `${repoPath(ctx)}/issues`, query: { state } }, j => asArr(j) as RawIssue[], 'The issue list', 6);
      const pq = q.source === 'query' ? parseItemQuery(sanitizeLine(q.value ?? '', 256)) : undefined;
      const labels = [...(q.source === 'label' ? [sanitizeLine(q.value, REMOTE_LIMITS.label)] : []), ...(pq?.labels ?? [])].map(l => l.toLowerCase());
      const me = q.me?.toLowerCase();
      const wantAssignee = (q.source === 'assigned-to-me' ? me : pq?.assignee)?.toLowerCase();
      const text = (pq?.text ?? '').toLowerCase();
      const items: RemoteItem[] = out.items
        // The issue list also holds pull requests, and none of the filters below can be trusted to have been applied by the server.
        .filter(i => !i.pull_request)
        .filter(i => !since || (Date.parse(i.updated_at ?? '') || 0) >= Date.parse(since))
        .map(foldItem)
        .filter(i => labels.every(l => i.labels.some(x => x.toLowerCase() === l)))
        .filter(i => !wantAssignee || i.assignees.some(a => a.toLowerCase() === wantAssignee))
        .filter(i => !pq?.author || i.author.toLowerCase() === pq.author.toLowerCase())
        .filter(i => !pq?.state || i.state === pq.state)
        .filter(i => !text || `${i.title}
${i.body}
${i.labels.join(' ')}`.toLowerCase().includes(text));
      return { items, notModified: out.notModified };
    },
    get: renamed((ctx: AdapterCtx, id: string) => ghItems.get(ctx, id)),
    create: renamed((ctx: AdapterCtx, input: { title: string; body: string; labels?: string[] }) => ghItems.create(ctx, input)),
    update: renamed((ctx: AdapterCtx, id: string, patch: Parameters<typeof ghItems.update>[2], ifRev: string) => ghItems.update(ctx, id, patch, ifRev)),
    transition: renamed((ctx: AdapterCtx, id: string, to: 'open' | 'closed', ifRev: string) => ghItems.transition(ctx, id, to, ifRev)),
    comment: renamed((ctx: AdapterCtx, id: string, md: string) => ghItems.comment(ctx, id, md)),
    addLabels: renamed((ctx: AdapterCtx, id: string, labels: string[]) => ghItems.addLabels(ctx, id, labels)),
    removeLabel: renamed((ctx: AdapterCtx, id: string, label: string) => ghItems.removeLabel(ctx, id, label)),
  },

  iterations: {
    async list(ctx) {
      const root = ctx.conn.baseUrl.replace(/\/+$/, '');
      const r = repoOf(ctx);
      const ms = await paged<Obj>(ctx, { path: `${repoPath(ctx)}/milestones`, query: { state: 'all' } }, j => asArr(j).map(asObj), 'The milestone list', 3);
      const out: Iteration[] = [];
      for (const m of ms.items) {
        if (typeof m.number !== 'number') continue;
        const due = typeof m.due_on === 'string' ? m.due_on : undefined;
        out.push({
          id: String(m.number), title: sanitizeLine(m.title, REMOTE_LIMITS.title), kind: 'milestone', state: m.state === 'closed' ? 'closed' : 'open',
          ...(due ? { end: due } : {}), url: `${root}/${r.owner}/${r.name}/milestone/${m.number}`,
          ...(typeof m.open_issues === 'number' ? { openItems: m.open_issues } : {}),
          ...(typeof m.closed_issues === 'number' ? { closedItems: m.closed_issues } : {}),
        });
      }
      return out;
    },
    assign: renamed((ctx: AdapterCtx, itemId: string, iterationId: string) => gh.iterations!.assign!(ctx, itemId, iterationId)),
    create: renamed((ctx: AdapterCtx, input: { title: string; start?: string; end?: string }) => gh.iterations!.create!(ctx, input)),
  },

  checks: {
    // Commit statuses only: GitBucket has no check-runs.
    async forCommit(ctx, commit) {
      const s = sha(commit);
      const res = await getJson(ctx, { path: `${repoPath(ctx)}/commits/${s}/status` }, 'The commit status');
      return (asArr(asObj(res.json).statuses) as RawStatus[]).map(foldStatus);
    },
  },

  protection: { read: readProtection },
};
