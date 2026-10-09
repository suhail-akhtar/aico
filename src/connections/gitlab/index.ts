/**
 * The GitLab adapter: gitlab.com and self-managed, REST v4, no SDK (ADR 0039).
 *
 * WHY it looks the way it does, each point a failure it prevents:
 *
 *  - **One address rule.** The API is `<base>/api/v4` on the same host as the web UI, for
 *    gitlab.com and for a self-managed server alike; a server mounted under a path
 *    (`https://corp.test/gitlab`) keeps that path. Projects are addressed by their URL-encoded
 *    full path (`group%2Fsub%2Fproject`), so a nested group is just an `owner` with a slash.
 *  - **Scopes are asked, not guessed.** `GET /personal_access_tokens/self` lists a token's scopes
 *    and expiry (15.5+); older servers answer 404 and then NOTHING is reported, capabilities come
 *    from cheap real calls against the mapped project, and no false "missing" chip is shown.
 *  - **Tiers are capability flags.** Iterations (Premium), issue weights and approval rules are
 *    probed, not assumed: iterations fall back to milestones, weights to `sp:5` labels, required
 *    approvals to "unknown", each with a plain warning instead of a failed connection.
 *  - **GitLab's own verdict decides mergeability** (fold.ts): `detailed_merge_status`, with the
 *    account's `can_merge`. "Merge when pipeline succeeds" is offered through
 *    `PullState.autoMerge` and used only when the caller (a person's click) asks for it; it is
 *    never the default of `merge`.
 *  - **Humans win conflicts.** `items.update/transition` re-read the issue and compare
 *    `updated_at` to the caller's `ifRev` before writing; a mismatch is a `conflict`. GitLab has
 *    no conditional PUT on issues, so the milliseconds between the re-read and the write remain
 *    (the next pull shows the truth).
 *  - **No new labels by accident.** Applying a label that does not exist creates it on GitLab, so
 *    AICO's `aico:*` progress labels appear without an extra call; that is a documented effect of
 *    a person turning work-item sync on, not a surprise.
 *  - **Stranger text is sanitised on the way out and AICO text has no AI credit on the way in**
 *    (`withoutAttribution`), in code.
 *  - **Failures say what to do.** 404 means "not found, or the token cannot see it" (GitLab does
 *    not distinguish); 403 on a write names the scope; no message ever includes a header.
 *
 * What it does not do: choose what to sync or when to merge (sync.ts, landing.ts), write epics
 * (read-only is not even offered), rerun jobs (no check id reaches the caller), push merge trains,
 * or touch protected-branch and approval settings (read only).
 *
 * @module connections/gitlab
 */

import type { Capabilities, ProbeResult, PullState, RepoRef } from '../../../shared/connections/types.js';
import {
  noCapabilities,
  type AdapterCtx, type Comment, type ItemQuery, type Iteration, type NewPull, type ProtectionInfo,
  type ProviderAdapter, type RemoteItem, type RepoInfo,
} from '../adapter.js';
import { ConnectionError, type ConnResponse } from '../http.js';
import { asArr, asObj, baseOf, enc, makeRest, optional, parseItemQuery, parseRemoteSegments, type Obj } from '../rest.js';
import { clipText, safeUrl } from '../github/fold.js';
import { REMOTE_LIMITS, sanitizeLine, withoutAttribution } from '../sanitize.js';
import type { StoredConnection } from '../types.js';
import {
  foldCommitStatus, foldIssue, foldNote, foldPull, isDraft,
  type RawApprovals, type RawIssue, type RawJob, type RawMr, type RawNote,
} from './fold.js';
import { extraPowers, missingScopes, neededScopes, parseScopes } from './scopes.js';

/** A merge request description may hold 1,048,576 characters; stay under it so a multi-byte edge never trips a 400. */
export const PULL_BODY_MAX = 1_000_000;
const COMMENT_MAX = 1_000_000;
const ISSUE_BODY_MAX = 1_000_000;

// ── messages and the shared request helpers ──────────────────────────────

/** GitLab words an error as `message` (a string, a list, or `{field: [reasons]}`) or `error` / `error_description`. */
function glMessage(res: ConnResponse): string {
  const j = asObj(res.json);
  const m = j.message ?? j.error_description ?? j.error;
  if (typeof m === 'string') return sanitizeLine(m, 240);
  if (Array.isArray(m)) return sanitizeLine(m.filter((x): x is string => typeof x === 'string').join('; '), 240);
  if (m && typeof m === 'object') {
    return sanitizeLine(Object.entries(m as Obj).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; '), 240);
  }
  return '';
}

const rest = makeRest({ name: 'GitLab', message: glMessage });
const { call, failure, getJson, paged, write } = rest;

// ── URLs ─────────────────────────────────────────────────────────────────

export function gitlabApiBase(conn: Pick<StoredConnection, 'baseUrl'>): string {
  const b = baseOf(conn.baseUrl);
  if (!b) throw new ConnectionError(`"${conn.baseUrl}" is not a URL.`, 'config');
  return `${b.origin}${b.pathname}/api/v4`;
}

export function gitlabGraphqlUrl(conn: Pick<StoredConnection, 'baseUrl'>): string {
  const b = baseOf(conn.baseUrl);
  if (!b) throw new ConnectionError(`"${conn.baseUrl}" is not a URL.`, 'config');
  return `${b.origin}${b.pathname}/api/graphql`;
}

/** `https://h/group/sub/project(.git)`, `git@h:group/project.git`, `ssh://git@h:2222/group/project.git`. */
export function parseGitlabRemote(url: string, baseUrl: string): RepoRef | undefined {
  const segs = parseRemoteSegments(url, baseUrl, { min: 2, max: 20 });
  if (!segs || segs.includes('-')) return undefined; // `/-/` is GitLab's separator for pages, never a group
  return { owner: segs.slice(0, -1).join('/'), name: segs[segs.length - 1]! };
}

function repoOf(ctx: AdapterCtx): RepoRef {
  if (!ctx.repo) throw new ConnectionError('This operation needs a project: map the project to a GitLab project first.', 'config');
  return ctx.repo;
}
const fullPath = (ctx: AdapterCtx): string => { const r = repoOf(ctx); return `${r.owner}/${r.name}`; };
const projectPath = (ctx: AdapterCtx): string => `/projects/${enc(fullPath(ctx))}`;

function iid(id: string, what: string): number {
  if (!/^\d{1,9}$/.test(id)) throw new ConnectionError(`"${id.slice(0, 40)}" is not a GitLab ${what} number.`, 'config');
  return Number(id);
}
function sha(s: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(s)) throw new ConnectionError('That is not a commit SHA.', 'config');
  return s;
}

function cleanTitle(t: string, max = 250): string {
  const out = withoutAttribution(t).replace(/\s+/g, ' ').trim().slice(0, max);
  if (!out) throw new ConnectionError('A title is required.', 'config');
  return out;
}
const cleanBody = (t: string, max: number): { head: string; overflow?: string } => clipText(withoutAttribution(t ?? ''), max);
const isoOrUndefined = (s: string | undefined): string | undefined => (s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : undefined);
const day = (s: string | undefined): string | undefined => (s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString().slice(0, 10) : undefined);

// ── protection ───────────────────────────────────────────────────────────

function branchMatches(pattern: string, branch: string): boolean {
  if (pattern === branch) return true;
  if (!pattern.includes('*')) return false;
  return new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(branch);
}

/**
 * `light`: only whether the branch is protected (one call; what a pull request observation needs).
 * Full: the project's "pipelines must succeed" setting and, on Premium, the approvals its rules require.
 */
async function readProtection(ctx: AdapterCtx, branch: string, light = false): Promise<ProtectionInfo> {
  const base = projectPath(ctx);
  const res = await call(ctx, { path: `${base}/repository/branches/${enc(branch)}` });
  if (res.status === 403) return { protected: false, unreadable: 'the token cannot read branch settings' };
  if (res.status === 404) return { protected: false, unreadable: `GitLab has no branch ${branch}, or the token cannot see it` };
  if (res.status !== 200) throw failure(res, `branch protection for ${branch}`);
  if (asObj(res.json).protected !== true) return { protected: false };
  if (light) return { protected: true };
  const info: ProtectionInfo = { protected: true, requiredReviews: 0, requiredChecks: [] };
  const proj = await call(ctx, { path: base });
  if (proj.status === 200 && asObj(proj.json).only_allow_merge_if_pipeline_succeeds === true) info.requiredChecks = ['Pipeline must succeed'];
  const rules = await call(ctx, { path: `${base}/approval_rules`, query: { per_page: 100 } }); // Premium; 403/404 elsewhere
  if (rules.status === 200) {
    let most = 0;
    for (const r of asArr(rules.json).map(asObj)) {
      const names = asArr(r.protected_branches).map(b => String(asObj(b).name ?? ''));
      const applies = r.applies_to_all_protected_branches === true || names.length === 0 || names.some(n => branchMatches(n, branch));
      if (applies && typeof r.approvals_required === 'number') most = Math.max(most, r.approvals_required);
    }
    info.requiredReviews = most;
  }
  return info;
}

// ── merge requests ───────────────────────────────────────────────────────

async function fetchPull(ctx: AdapterCtx, id: string): Promise<PullState> {
  const n = iid(id, 'merge request');
  const base = projectPath(ctx);
  const { json } = await getJson(ctx, { path: `${base}/merge_requests/${n}` }, `Merge request !${n}`);
  const mr = json as RawMr;
  let jobs: RawJob[] | undefined;
  if (mr.head_pipeline?.id !== undefined) {
    // A token without pipeline access gets 403 here; the MR is still worth observing, with the pipeline as its one check.
    const r = await paged<RawJob>(ctx, { path: `${base}/pipelines/${mr.head_pipeline.id}/jobs`, query: { per_page: 100 } },
      j => asArr(j) as RawJob[], `The pipeline of !${n}`, 3).catch(optional);
    jobs = r?.items;
  }
  const approvals = await getJson(ctx, { path: `${base}/merge_requests/${n}/approvals` }, `The approvals of !${n}`).then(r => r.json as RawApprovals).catch(optional);
  const protection = mr.target_branch ? await readProtection(ctx, mr.target_branch, true).catch(optional) : undefined;
  return foldPull({ connection: ctx.conn.id, mr, jobs, approvals, protection });
}

/** Project members by user name -> access level, for the trust rule. Empty when the token cannot list them (nobody is then trusted). */
async function memberLevels(ctx: AdapterCtx): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const r = await paged<Obj>(ctx, { path: `${projectPath(ctx)}/members/all`, query: { per_page: 100 } }, j => asArr(j).map(asObj), 'The project members', 3).catch(optional);
  for (const m of r?.items ?? []) if (typeof m.username === 'string' && typeof m.access_level === 'number') out.set(m.username.toLowerCase(), m.access_level);
  return out;
}

// ── issues ───────────────────────────────────────────────────────────────

async function readIssue(ctx: AdapterCtx, id: string): Promise<RawIssue> {
  const n = iid(id, 'issue');
  // Fresh, not conditional: this read decides whether a write may go ahead.
  const { json } = await getJson(ctx, { path: `${projectPath(ctx)}/issues/${n}`, conditional: false }, `Issue #${n}`);
  return json as RawIssue;
}

function conflict(n: number, current: string, ifRev: string): ConnectionError {
  return new ConnectionError(
    `Issue #${n} changed on GitLab (updated ${current || 'at an unknown time'}) after AICO last read it (${ifRev || 'never'}). It was left as it is; pull it again and decide.`,
    'conflict', 409);
}

const cleanLabels = (labels: readonly string[]): string[] => labels.map(l => sanitizeLine(l, 50)).filter(Boolean);

// ── iterations ───────────────────────────────────────────────────────────

const ITERATION_PREFIX = 'iteration-';

interface NativeIterations { available: boolean; iterations: Iteration[] }

function iterationState(s: unknown): 'open' | 'closed' {
  return s === 3 || s === 'closed' ? 'closed' : 'open';
}
function timeFrameOf(s: unknown): Iteration['timeFrame'] {
  if (s === 3 || s === 'closed') return 'past';
  if (s === 2 || s === 'started' || s === 'current') return 'current';
  return 'future';
}

/** Premium iterations of the project (and the groups above it); `available:false` when the instance or tier lacks them. */
async function nativeIterations(ctx: AdapterCtx): Promise<NativeIterations> {
  const res = await call(ctx, { path: `${projectPath(ctx)}/iterations`, query: { state: 'all', include_ancestors: true, per_page: 100 } });
  if (res.status === 403 || res.status === 404 || res.status === 501) return { available: false, iterations: [] };
  if (res.status !== 200) throw failure(res, 'The iteration list');
  const iterations: Iteration[] = asArr(res.json).map(asObj).filter(o => o.id !== undefined).map(o => {
    const url = safeUrl(o.web_url);
    const start = typeof o.start_date === 'string' ? o.start_date : undefined;
    const end = typeof o.due_date === 'string' ? o.due_date : undefined;
    return {
      id: `${ITERATION_PREFIX}${String(o.id)}`, title: sanitizeLine(o.title || (start && end ? `${start} to ${end}` : `Iteration ${String(o.iid ?? o.id)}`), REMOTE_LIMITS.title),
      kind: 'iteration' as const, state: iterationState(o.state), timeFrame: timeFrameOf(o.state),
      ...(start ? { start } : {}), ...(end ? { end } : {}), ...(url ? { url } : {}),
    };
  });
  return { available: true, iterations };
}

function foldMilestone(m: Obj): Iteration | undefined {
  if (m.id === undefined) return undefined;
  const url = safeUrl(m.web_url);
  const start = typeof m.start_date === 'string' ? m.start_date : undefined;
  const end = typeof m.due_date === 'string' ? m.due_date : undefined;
  return {
    id: String(m.id), title: sanitizeLine(m.title, REMOTE_LIMITS.title), kind: 'milestone', state: m.state === 'closed' ? 'closed' : 'open',
    ...(start ? { start } : {}), ...(end ? { end } : {}), ...(url ? { url } : {}),
  };
}

// ── probe ────────────────────────────────────────────────────────────────

function parseExpiry(s: unknown): string | undefined {
  if (typeof s !== 'string' || !s) return undefined;
  const iso = s.length === 10 ? `${s}T23:59:59Z` : s; // GitLab dates a token's expiry by day: valid through that day
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : undefined;
}

async function probe(ctx: AdapterCtx): Promise<ProbeResult> {
  const warnings: string[] = [];
  const userRes = await call(ctx, { path: '/user', conditional: false });
  if (userRes.status !== 200) throw failure(userRes, 'The account behind this token');
  const user = sanitizeLine(asObj(userRes.json).username, 80);

  const verRes = await call(ctx, { path: '/version', conditional: false }).catch((e: unknown) => {
    if (e instanceof ConnectionError && e.code === 'rate-limited') throw e;
    return undefined; // the version is a nicety; its absence is not a failed probe
  });
  const versionRaw = verRes?.status === 200 ? asObj(verRes.json).version : undefined;
  const version = typeof versionRaw === 'string' ? sanitizeLine(versionRaw, 40) : undefined;

  const selfRes = await call(ctx, { path: '/personal_access_tokens/self', conditional: false });
  const self = selfRes.status === 200 ? asObj(selfRes.json) : undefined;
  const found = parseScopes(self);
  const reported = found !== undefined;
  const scopesFound = found ?? [];
  const expiry = parseExpiry(self?.expires_at);

  const caps: Capabilities = noCapabilities();
  caps.repos = true;
  caps.pulls.bodyMax = PULL_BODY_MAX;
  caps.checks.logsUrl = true;
  caps.items.estimate = 'label';

  if (ctx.repo) {
    await probeRepo(ctx, caps, warnings);
  } else {
    // Nothing mapped yet (the add flow tests before a project exists): check a project this account can push to, so the
    // chips are what real calls say rather than a guess from scopes.
    const list = await call(ctx, { path: '/projects', query: { membership: true, min_access_level: 30, per_page: 1, simple: true }, conditional: false });
    caps.repos = list.status === 200;
    const full = list.status === 200 ? asObj(asArr(list.json)[0]).path_with_namespace : undefined;
    if (typeof full === 'string' && /^[\w.-]+(?:\/[\w.-]+)+$/.test(full)) {
      const cut = full.lastIndexOf('/');
      await probeRepo({ ...ctx, repo: { owner: full.slice(0, cut), name: full.slice(cut + 1) } }, caps, warnings);
      warnings.push(`Checked against ${full}: map a project and test again to see what this token can do there.`);
    } else if (reported) {
      const full2 = scopesFound.includes('api');
      caps.pulls = { create: full2, comment: full2, merge: full2, draft: full2, bodyMax: PULL_BODY_MAX };
      caps.items = { ...caps.items, query: full2 || scopesFound.includes('read_api'), create: full2, transition: full2, comment: full2 };
      caps.checks.read = full2 || scopesFound.includes('read_api');
      caps.iterations = full2 ? 'milestone' : 'none';
    } else {
      warnings.push('Map a project and test again to see what this token can do there (this GitLab does not list token scopes).');
    }
  }

  return {
    at: new Date().toISOString(),
    user,
    ...(version ? { version } : {}),
    capabilities: caps,
    scopes: { found: scopesFound, needed: neededScopes(), missing: missingScopes(scopesFound, reported), extra: reported ? extraPowers(scopesFound) : [], reported },
    warnings,
    ...(expiry ? { tokenExpiresAt: expiry } : {}),
  };
}

async function probeRepo(ctx: AdapterCtx, caps: Capabilities, warnings: string[]): Promise<void> {
  const base = projectPath(ctx);
  const name = fullPath(ctx);
  const proj = await call(ctx, { path: base, conditional: false });
  if (proj.status === 404 || proj.status === 403) {
    warnings.push(`The project ${name} was not found, or this token cannot see it.`);
    return;
  }
  if (proj.status !== 200) throw failure(proj, `The project ${name}`);
  const pj = asObj(proj.json);
  const access = asObj(pj.permissions);
  const level = Math.max(Number(asObj(access.project_access).access_level ?? 0), Number(asObj(access.group_access).access_level ?? 0));
  const known = level > 0;
  const canWrite = !known || level >= 30;
  const canTriage = !known || level >= 20;
  const branch = typeof pj.default_branch === 'string' && pj.default_branch ? pj.default_branch : 'main';
  const mrOn = pj.merge_requests_enabled !== false;
  const issuesOn = pj.issues_enabled !== false;
  if (known && level < 30) warnings.push('This token can only read the project (it needs the Developer role to push branches and open merge requests).');

  const mrs = await call(ctx, { path: `${base}/merge_requests`, query: { per_page: 1, state: 'all', scope: 'all' }, conditional: false });
  if (mrOn && mrs.status === 200) {
    caps.pulls = { create: canWrite, comment: canTriage, merge: canWrite, draft: canWrite, bodyMax: PULL_BODY_MAX };
    if (known && level === 30) warnings.push('Developers cannot merge into a protected branch by default; the Merge button appears only when GitLab says this account may merge.');
  } else if (!mrOn) warnings.push('Merge requests are turned off for this project.');
  else warnings.push('Merge requests are unreadable with this token (it needs the api scope).');

  if (!issuesOn) {
    warnings.push('Issues are turned off for this project, so work items are unavailable.');
  } else {
    const issues = await call(ctx, { path: `${base}/issues`, query: { per_page: 1, state: 'all' }, conditional: false });
    if (issues.status === 200) {
      caps.items = { ...caps.items, query: true, create: canTriage, transition: canTriage, comment: canTriage };
      const first = asObj(asArr(issues.json)[0]);
      // `weight` is present (even when null) only on tiers that have it.
      if ('weight' in first) caps.items.estimate = 'field';
    } else warnings.push('Issues are unreadable with this token (it needs the api scope).');
  }

  const pipes = await call(ctx, { path: `${base}/pipelines`, query: { per_page: 1 }, conditional: false });
  if (pipes.status === 200) caps.checks.read = true;
  else warnings.push('Checks (pipelines) are unreadable with this token, or CI/CD is turned off, so merge requests will show no checks.');

  const prot = await readProtection(ctx, branch, true);
  if (prot.unreadable) warnings.push(`Branch protection unreadable (${prot.unreadable}): AICO cannot see which reviews and pipelines ${branch} requires.`);
  else caps.protection.read = true;

  const native = await nativeIterations(ctx);
  if (native.available) caps.iterations = 'native';
  else {
    const ms = await call(ctx, { path: `${base}/milestones`, query: { per_page: 1, state: 'all' }, conditional: false });
    caps.iterations = ms.status === 200 ? 'milestone' : 'none';
    warnings.push('Iterations are not available here (they need GitLab Premium), so milestones stand in for them.');
  }
}

// ── the adapter ──────────────────────────────────────────────────────────

function repoInfo(conn: StoredConnection, j: Obj, ref: RepoRef): RepoInfo {
  const full = typeof j.path_with_namespace === 'string' && /^[\w.-]+(?:\/[\w.-]+)+$/.test(j.path_with_namespace) ? j.path_with_namespace : `${ref.owner}/${ref.name}`;
  const cut = full.lastIndexOf('/');
  const owner = full.slice(0, cut);
  const name = full.slice(cut + 1);
  const access = asObj(j.permissions);
  const level = Math.max(Number(asObj(access.project_access).access_level ?? 0), Number(asObj(access.group_access).access_level ?? 0));
  const root = conn.baseUrl.replace(/\/+$/, '');
  return {
    ref: { owner, name, ...(j.id !== undefined ? { id: String(j.id) } : {}) },
    defaultBranch: typeof j.default_branch === 'string' && j.default_branch ? sanitizeLine(j.default_branch, 255) : 'main',
    // Rebuilt from the base URL, never copied from the response: no userinfo, no foreign host.
    cloneUrl: `${root}/${full}.git`,
    htmlUrl: `${root}/${full}`,
    private: j.visibility !== 'public',
    ...(j.permissions ? { permissions: { pull: level >= 20, push: level >= 30, admin: level >= 40 } } : {}),
  };
}

export const gitlabAdapter: ProviderAdapter = {
  id: 'gitlab',

  apiBase: gitlabApiBase,

  hostsFor(baseUrl) {
    const b = baseOf(baseUrl);
    return b ? [b.host] : [];
  },

  clientOptions(conn) {
    return { apiBase: gitlabApiBase(conn), auth: { kind: 'bearer' }, headers: { Accept: 'application/json' } };
  },

  gitUsername() { return 'oauth2'; },

  parseRemote: parseGitlabRemote,

  probe,

  repos: {
    async get(ctx, ref) {
      const c: AdapterCtx = { ...ctx, repo: ref };
      const { json } = await getJson(c, { path: projectPath(c) }, `The project ${ref.owner}/${ref.name}`);
      return repoInfo(ctx.conn, asObj(json), ref);
    },
    async list(ctx, query) {
      const { items } = await paged<Obj>(ctx, {
        path: '/projects', query: { membership: true, simple: true, order_by: 'last_activity_at', per_page: 100 },
      }, j => asArr(j).map(asObj), 'The project list', 3);
      const q = query?.trim().toLowerCase();
      return items
        .filter(r => !q || String(r.path_with_namespace ?? '').toLowerCase().includes(q))
        .map(r => repoInfo(ctx.conn, r, { owner: '', name: '' }));
    },
  },

  pulls: {
    async find(ctx, head) {
      const { json } = await getJson(ctx, { path: `${projectPath(ctx)}/merge_requests`, query: { source_branch: head, state: 'opened', scope: 'all', per_page: 5 } }, 'The merge request list');
      const first = asArr(json).map(asObj).find(m => m.source_branch === head);
      return first && typeof first.iid === 'number' ? fetchPull(ctx, String(first.iid)) : undefined;
    },

    async create(ctx, input: NewPull) {
      const title = cleanTitle(input.draft ? `Draft: ${input.title.replace(/^\s*draft:\s*/i, '')}` : input.title);
      const { head, overflow } = cleanBody(input.body, PULL_BODY_MAX);
      const res = await write(ctx, {
        method: 'POST', path: `${projectPath(ctx)}/merge_requests`, audit: 'pr.open', ref: input.head,
        // The source branch is left alone after a merge: AICO never deletes remote branches (ADR 0039).
        json: { source_branch: input.head, target_branch: input.base, title, description: head, remove_source_branch: false },
      }, 'opening the merge request', 'the api scope and the Developer role');
      // A fresh MR has no pipeline or approvals to fetch, and its mergeability is still being computed.
      const pull = foldPull({ connection: ctx.conn.id, mr: res.json as RawMr });
      return { pull, ...(overflow ? { overflow } : {}) };
    },

    async update(ctx, id, patch) {
      const n = iid(id, 'merge request');
      const base = projectPath(ctx);
      const json: Obj = {};
      if (patch.title !== undefined) {
        let title = cleanTitle(patch.title);
        // GitLab reads "draft" from the title: a rename must not quietly take a draft out of draft.
        const cur = (await getJson(ctx, { path: `${base}/merge_requests/${n}`, conditional: false }, `Merge request !${n}`)).json as RawMr;
        if (isDraft(cur) && !isDraft({ title })) title = `Draft: ${title}`;
        json.title = title;
      }
      if (patch.body !== undefined) {
        const { head, overflow } = cleanBody(patch.body, PULL_BODY_MAX);
        json.description = overflow ? `${head}\n\n… (cut; the rest is in the first comment)` : head;
      }
      if (patch.state) json.state_event = patch.state === 'closed' ? 'close' : 'reopen';
      await write(ctx, { method: 'PUT', path: `${base}/merge_requests/${n}`, json, audit: 'write', ref: id }, `Merge request !${n}`, 'the api scope and the Developer role');
      return fetchPull(ctx, id);
    },

    async comment(ctx, id, markdown) {
      const n = iid(id, 'merge request');
      const body = clipText(withoutAttribution(markdown), COMMENT_MAX);
      await write(ctx, {
        method: 'POST', path: `${projectPath(ctx)}/merge_requests/${n}/notes`, audit: 'write', ref: id,
        json: { body: body.overflow ? `${body.head}\n\n… (cut at ${COMMENT_MAX} characters)` : body.head },
      }, `Merge request !${n}`, 'the api scope');
    },

    get: fetchPull,

    async comments(ctx, id) {
      const n = iid(id, 'merge request');
      const notes = await paged<RawNote>(ctx, { path: `${projectPath(ctx)}/merge_requests/${n}/notes`, query: { per_page: 100, sort: 'asc', order_by: 'created_at' } },
        j => asArr(j) as RawNote[], `The comments of !${n}`, 3);
      const levels = await memberLevels(ctx);
      const all = notes.items.map(note => foldNote(note, levels.get((note.author?.username ?? '').toLowerCase()))).filter((c): c is Comment => !!c);
      // Newest last; a stable sort keeps API order for equal timestamps.
      return all.map((c, i) => ({ c, i })).sort((a, b) => (Date.parse(a.c.at) || 0) - (Date.parse(b.c.at) || 0) || a.i - b.i).map(x => x.c);
    },

    async merge(ctx, id, opts) {
      const n = iid(id, 'merge request');
      const res = await call(ctx, {
        method: 'PUT', path: `${projectPath(ctx)}/merge_requests/${n}/merge`, audit: 'pr.merge', ref: id,
        // `sha` makes GitLab refuse if the head moved since it was reviewed. Nothing here bypasses a rule: GitLab applies
        // every one of its own at the moment it merges, including when it merges later (whenChecksPass).
        json: {
          sha: sha(opts.sha), squash: opts.method === 'squash', should_remove_source_branch: false,
          ...(opts.whenChecksPass ? { merge_when_pipeline_succeeds: true } : {}),
        },
      });
      if (res.status === 200) {
        const mr = asObj(res.json);
        const merged = mr.state === 'merged';
        return { sha: merged ? String(mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha ?? '') : '' };
      }
      if (res.status === 405 || res.status === 406) throw new ConnectionError(`GitLab will not merge !${n} right now: ${glMessage(res) || 'it is not mergeable.'}`, 'conflict', res.status);
      if (res.status === 409) throw new ConnectionError(`!${n} was not merged because its branch changed after it was reviewed. Look at the new commits first.`, 'conflict', 409);
      throw failure(res, `Merging !${n}`, 'the api scope and permission to merge into the target branch');
    },
  },

  items: {
    async query(ctx, q: ItemQuery) {
      if (q.source === 'off') return { items: [], notModified: true };
      const state = q.state ?? 'open';
      const since = isoOrUndefined(q.since);
      const query: Record<string, string | number | boolean> = {
        state: state === 'open' ? 'opened' : state, per_page: 100, order_by: 'updated_at', sort: 'desc',
      };
      if (q.source === 'label') {
        if (!q.value?.trim()) throw new ConnectionError('Importing by label needs a label name.', 'config');
        query.labels = sanitizeLine(q.value, REMOTE_LIMITS.label);
      } else if (q.source === 'assigned-to-me') {
        if (!q.me) throw new ConnectionError('Importing items assigned to you needs to know which account the token acts as; test the connection first.', 'config');
        query.assignee_username = q.me;
      } else if (q.source === 'query') {
        // GitLab's API has parameters, not a query language: `label:bug assignee:ana is:closed crash` is split into them.
        const pq = parseItemQuery(sanitizeLine(q.value ?? '', 256));
        if (pq.labels.length) query.labels = pq.labels.join(',');
        if (pq.assignee) query.assignee_username = pq.assignee;
        if (pq.author) query.author_username = pq.author;
        if (pq.state) query.state = pq.state === 'open' ? 'opened' : 'closed';
        if (pq.text) { query.search = pq.text; query.in = 'title,description'; }
      }
      if (since) query.updated_after = since;
      const out = await paged<RawIssue>(ctx, { path: `${projectPath(ctx)}/issues`, query }, j => asArr(j) as RawIssue[], 'The issue list', 5);
      return { items: out.items.map(foldIssue), notModified: out.notModified };
    },

    async get(ctx, id) { return foldIssue(await readIssue(ctx, id)); },

    async create(ctx, input) {
      const title = cleanTitle(input.title);
      const description = cleanBody(input.body, ISSUE_BODY_MAX).head;
      const labels = cleanLabels(input.labels ?? []);
      const res = await write(ctx, {
        method: 'POST', path: `${projectPath(ctx)}/issues`, audit: 'write', ref: 'new-issue',
        json: { title, description, ...(labels.length ? { labels } : {}) },
      }, 'creating the issue', 'the api scope');
      return foldIssue(res.json as RawIssue);
    },

    async update(ctx, id, patch, ifRev) {
      const n = iid(id, 'issue');
      const current = await readIssue(ctx, id);
      if ((current.updated_at ?? '') !== ifRev) throw conflict(n, current.updated_at ?? '', ifRev);
      const json: Obj = {};
      if (patch.title !== undefined) json.title = cleanTitle(patch.title);
      if (patch.body !== undefined) json.description = cleanBody(patch.body, ISSUE_BODY_MAX).head;
      // GitLab replaces the whole label set on PUT `labels`; the caller passes the set it wants.
      if (patch.labels) json.labels = cleanLabels(patch.labels);
      // `milestone_id: 0` clears it.
      if (patch.milestone !== undefined) json.milestone_id = patch.milestone === null ? 0 : iid(patch.milestone, 'milestone');
      const res = await write(ctx, { method: 'PUT', path: `${projectPath(ctx)}/issues/${n}`, json, audit: 'write', ref: id }, `Issue #${n}`, 'the api scope');
      return foldIssue(res.json as RawIssue);
    },

    async transition(ctx, id, to, ifRev) {
      const n = iid(id, 'issue');
      const current = await readIssue(ctx, id);
      if ((current.updated_at ?? '') !== ifRev) throw conflict(n, current.updated_at ?? '', ifRev);
      const res = await write(ctx, {
        method: 'PUT', path: `${projectPath(ctx)}/issues/${n}`, audit: 'write', ref: id,
        json: { state_event: to === 'closed' ? 'close' : 'reopen' },
      }, `Issue #${n}`, 'the api scope');
      return foldIssue(res.json as RawIssue);
    },

    async comment(ctx, id, markdown) {
      const n = iid(id, 'issue');
      const body = clipText(withoutAttribution(markdown), COMMENT_MAX);
      await write(ctx, {
        method: 'POST', path: `${projectPath(ctx)}/issues/${n}/notes`, audit: 'write', ref: id,
        json: { body: body.overflow ? `${body.head}\n\n… (cut at ${COMMENT_MAX} characters)` : body.head },
      }, `Issue #${n}`, 'the api scope');
    },

    async addLabels(ctx, id, labels) {
      const n = iid(id, 'issue');
      const clean = cleanLabels(labels);
      if (!clean.length) return;
      await write(ctx, { method: 'PUT', path: `${projectPath(ctx)}/issues/${n}`, json: { add_labels: clean.join(',') }, audit: 'write', ref: id }, `Issue #${n}`, 'the api scope');
    },

    async removeLabel(ctx, id, label) {
      const n = iid(id, 'issue');
      // GitLab does not complain about removing a label the issue does not have: already the state the caller wanted.
      await write(ctx, { method: 'PUT', path: `${projectPath(ctx)}/issues/${n}`, json: { remove_labels: sanitizeLine(label, 50) }, audit: 'write', ref: id }, `Issue #${n}`, 'the api scope');
    },
  },

  iterations: {
    async list(ctx) {
      const out: Iteration[] = [];
      const native = await nativeIterations(ctx);
      out.push(...native.iterations);
      const ms = await paged<Obj>(ctx, { path: `${projectPath(ctx)}/milestones`, query: { state: 'all', per_page: 100, include_parent_milestones: true } },
        j => asArr(j).map(asObj), 'The milestone list', 3);
      for (const m of ms.items) { const it = foldMilestone(m); if (it) out.push(it); }
      return out;
    },

    async assign(ctx, itemId, iterationId) {
      const n = iid(itemId, 'issue');
      if (iterationId.startsWith(ITERATION_PREFIX)) {
        const gid = `gid://gitlab/Iteration/${iid(iterationId.slice(ITERATION_PREFIX.length), 'iteration')}`;
        // REST cannot set an iteration; the GraphQL mutation can (Premium).
        const res = await write(ctx, {
          method: 'POST', path: gitlabGraphqlUrl(ctx.conn), audit: 'write', ref: itemId, conditional: false,
          json: {
            query: 'mutation($projectPath:ID!,$iid:String!,$iterationId:ID){issueSetIteration(input:{projectPath:$projectPath,iid:$iid,iterationId:$iterationId}){errors issue{iid}}}',
            variables: { projectPath: fullPath(ctx), iid: String(n), iterationId: gid },
          },
        }, `Issue #${n}`, 'the api scope and GitLab Premium');
        const j = asObj(res.json);
        const errors = asArr(asObj(asObj(j.data).issueSetIteration).errors).filter((e): e is string => typeof e === 'string');
        if (asArr(j.errors).length || errors.length) throw new ConnectionError(`GitLab would not set the iteration of #${n}: ${sanitizeLine(errors[0] ?? asObj(asArr(j.errors)[0]).message ?? 'it was refused', 200)}`, 'http', 422);
        return;
      }
      await write(ctx, { method: 'PUT', path: `${projectPath(ctx)}/issues/${n}`, json: { milestone_id: iid(iterationId, 'milestone') }, audit: 'write', ref: itemId }, `Issue #${n}`, 'the api scope');
    },

    async create(ctx, input) {
      const start = day(input.start);
      const due = day(input.end);
      const res = await write(ctx, {
        method: 'POST', path: `${projectPath(ctx)}/milestones`, audit: 'write', ref: 'new-milestone',
        json: { title: cleanTitle(input.title, 250), ...(start ? { start_date: start } : {}), ...(due ? { due_date: due } : {}) },
      }, 'creating the milestone', 'the api scope');
      return foldMilestone(asObj(res.json)) ?? { id: '', title: input.title, kind: 'milestone', state: 'open' };
    },
  },

  checks: {
    async forCommit(ctx, commit) {
      const s = sha(commit);
      const r = await paged<Obj>(ctx, { path: `${projectPath(ctx)}/repository/commits/${s}/statuses`, query: { per_page: 100 } }, j => asArr(j).map(asObj), 'The commit statuses', 3);
      return r.items.map(o => foldCommitStatus({
        ...(typeof o.name === 'string' ? { name: o.name } : {}), ...(typeof o.status === 'string' ? { status: o.status } : {}),
        target_url: typeof o.target_url === 'string' ? o.target_url : null, description: typeof o.description === 'string' ? o.description : null,
        allow_failure: o.allow_failure === true,
      }));
    },
  },

  protection: {
    read: (ctx, branch) => readProtection(ctx, branch),
  },
};
