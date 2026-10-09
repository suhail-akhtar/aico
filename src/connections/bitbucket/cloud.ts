/**
 * The Bitbucket Cloud adapter: REST 2.0 at api.bitbucket.org, plain requests, no SDK (ADR 0039).
 * A pull-request and build-status connector. It is deliberately NOT a planning connector.
 *
 * WHY it looks the way it does, each point a failure it prevents:
 *
 *  - **Two token kinds, two schemes.** An Atlassian API token (the replacement for app passwords,
 *    which Atlassian switched off in June 2026) is Basic auth with the account email; a repository,
 *    project or workspace access token is Bearer. The connection's optional `username` (the email,
 *    not a secret) picks Basic; without it the token is Bearer. Git pairs the token with a fixed
 *    user name instead (`gitUsername`): `x-bitbucket-api-token-auth` or `x-token-auth`.
 *  - **Cloud does not say whether a PR merges cleanly,** so `mergeable` is `unknown` and `canMerge`
 *    is derived from what is visible (fold.ts explains). The merge call re-reads the PR and refuses
 *    if its head moved since the caller looked, because Cloud's merge has no head-sha parameter;
 *    the window between that read and the POST is milliseconds and the server's own branch
 *    restrictions still apply. Nothing here can bypass a restriction.
 *  - **AICO never approves.** Approvals are read (they are the review state) and never given: an
 *    agent approving its own pull request would defeat the point of a required review.
 *  - **Issues are an optional per-repository feature,** off by default and basic where on, and
 *    Jira is out of scope. The probe reads `has_issues` and says so; the issue operations exist
 *    for repositories that use the tracker, with the component standing in for a label.
 *  - **Stranger text is sanitised on the way out and AICO text has no AI credit on the way in.**
 *
 * What it does not do: sprints (Cloud has none), Pipelines definitions (build results arrive as
 * commit statuses), inline review comments, or any change to branch restrictions (read only).
 *
 * @module connections/bitbucket/cloud
 */

import type { Capabilities, PullState, ProbeResult, RemoteCheck, RepoRef, ScopeAdvice } from '../../../shared/connections/types.js';
import {
  noCapabilities,
  type AdapterCtx, type Comment, type ItemQuery, type NewPull, type ProtectionInfo, type ProviderAdapter, type RepoInfo,
} from '../adapter.js';
import { ConnectionError, type ConnRequest, type ConnResponse } from '../http.js';
import { REMOTE_LIMITS, sanitizeLine, withoutAttribution } from '../sanitize.js';
import type { StoredConnection } from '../types.js';
import { asArr, asObj, call, commitSha, enc, failure, filterValue, numId, optional, str, type Obj } from './common.js';
import {
  clipText, foldCloudComments, foldCloudIssue, foldCloudPull, foldCloudRestrictions, foldCloudStatus,
} from './fold.js';

/** Cloud's PR description limit is not documented to the byte; stay well under any plausible one. */
export const CLOUD_PULL_BODY_MAX = 30_000;
const COMMENT_MAX = 30_000;
const ISSUE_BODY_MAX = 30_000;

// ── URLs ───────────────────────────────────────────────────────────────────

function hostOf(baseUrl: string): { hostname: string; host: string; origin: string } | undefined {
  try { const u = new URL(baseUrl); return { hostname: u.hostname.toLowerCase(), host: u.host.toLowerCase(), origin: u.origin }; } catch { return undefined; }
}
function isCloudHost(baseUrl: string): boolean {
  const h = hostOf(baseUrl)?.hostname;
  return h === 'bitbucket.org' || h === 'api.bitbucket.org' || h === 'www.bitbucket.org';
}

/** bitbucket.org is `api.bitbucket.org/2.0`; any other host (the mock forge) serves the same layout under `<origin>/2.0`. */
export function cloudApiBase(conn: Pick<StoredConnection, 'baseUrl'>): string {
  if (isCloudHost(conn.baseUrl)) return 'https://api.bitbucket.org/2.0';
  const h = hostOf(conn.baseUrl);
  if (!h) throw new ConnectionError(`"${conn.baseUrl}" is not a URL.`, 'config');
  return `${h.origin}/2.0`;
}

const SLUG = /^[A-Za-z0-9_.-]+$/;

/** `https://[user@]bitbucket.org/ws/repo(.git)`, `git@bitbucket.org:ws/repo.git`, `ssh://git@bitbucket.org/ws/repo.git`. */
export function parseCloudRemote(url: string, baseUrl: string): RepoRef | undefined {
  const base = hostOf(baseUrl);
  if (!base) return undefined;
  const cloud = isCloudHost(baseUrl);
  const sameHost = (hostname: string, host?: string): boolean => {
    const h = hostname.toLowerCase();
    if (cloud) return h === 'bitbucket.org' || h === 'www.bitbucket.org';
    return host !== undefined ? host.toLowerCase() === base.host || (host.toLowerCase() === base.hostname && !/:\d+$/.test(base.host)) : h === base.hostname;
  };
  const finish = (pathPart: string): RepoRef | undefined => {
    const segs = pathPart.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    if (segs.length !== 2 || !segs.every(s => SLUG.test(s))) return undefined;
    return { owner: segs[0]!, name: segs[1]! };
  };
  const t = url.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)([^\s]+)$/.exec(t);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return sameHost(scp[1]!) ? finish(scp[2]!) : undefined;
  let u: URL;
  try { u = new URL(t); } catch { return undefined; }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return undefined;
  const web = u.protocol === 'https:' || u.protocol === 'http:';
  if (!sameHost(u.hostname, web ? u.host : undefined)) return undefined;
  return finish(u.pathname);
}

// ── helpers ────────────────────────────────────────────────────────────────

function repoOf(ctx: AdapterCtx): RepoRef {
  if (!ctx.repo) throw new ConnectionError('This operation needs a repository: map the project to a Bitbucket repository first.', 'config');
  return ctx.repo;
}
const repoPath = (ctx: AdapterCtx): string => { const r = repoOf(ctx); return `/repositories/${enc(r.owner)}/${enc(r.name)}`; };
const repoName = (ctx: AdapterCtx): string => { const r = repoOf(ctx); return `${r.owner}/${r.name}`; };

async function getJson(ctx: AdapterCtx, req: ConnRequest, what: string): Promise<{ res: ConnResponse; json: unknown }> {
  const res = await call(ctx, req);
  if (res.status < 200 || res.status >= 300) throw failure(res, what);
  return { res, json: res.json };
}

async function write(ctx: AdapterCtx, req: ConnRequest, what: string, needs: string): Promise<ConnResponse> {
  const res = await call(ctx, req);
  if (res.status < 200 || res.status >= 300) throw failure(res, what, needs);
  return res;
}

/** Every page of a `{values, next}` list, bounded; a non-2xx page is an error, never an empty list. */
async function paged(ctx: AdapterCtx, first: ConnRequest, what: string, maxPages = 5): Promise<{ values: unknown[]; notModified: boolean; more: boolean }> {
  const values: unknown[] = [];
  let req: ConnRequest = first;
  let allCached = true;
  for (let page = 0; page < maxPages; page++) {
    const res = await call(ctx, req);
    if (res.status < 200 || res.status >= 300) throw failure(res, what);
    if (!res.notModified) allCached = false;
    const j = asObj(res.json);
    values.push(...asArr(j.values));
    const next = typeof j.next === 'string' ? j.next : undefined;
    if (!next) return { values, notModified: allCached, more: false };
    const { query: _q, ...rest } = first;
    void _q;
    req = { ...rest, path: next };
  }
  return { values, notModified: allCached, more: true };
}

function cleanTitle(t: string, max = 250): string {
  const out = withoutAttribution(t).replace(/\s+/g, ' ').trim().slice(0, max);
  if (!out) throw new ConnectionError('A title is required.', 'config');
  return out;
}

const STRATEGY: Record<'merge' | 'squash' | 'rebase', string> = { merge: 'merge_commit', squash: 'squash', rebase: 'rebase_fast_forward' };

// ── protection ─────────────────────────────────────────────────────────────

async function readProtection(ctx: AdapterCtx, branch: string): Promise<ProtectionInfo> {
  const res = await call(ctx, { path: `${repoPath(ctx)}/branch-restrictions`, query: { pagelen: 100 } });
  if (res.status === 200) {
    const j = asObj(res.json);
    const all = asArr(j.values);
    // Past the first page is rare for restrictions; a truncated list would under-report, so say so.
    if (typeof j.next === 'string') return { protected: true, unreadable: 'more restrictions than AICO reads' };
    return foldCloudRestrictions(all, branch);
  }
  if (res.status === 403 || res.status === 404) return { protected: false, unreadable: 'needs repository admin' };
  throw failure(res, `branch restrictions for ${branch}`);
}

// ── pull requests ──────────────────────────────────────────────────────────

async function fetchPull(ctx: AdapterCtx, id: string): Promise<PullState> {
  const n = numId(id, 'pull request');
  const base = repoPath(ctx);
  const { json } = await getJson(ctx, { path: `${base}/pullrequests/${n}`, conditional: false }, `Pull request #${n}`);
  const pr = asObj(json);
  // A token without the build-status scope gets 403 here; the PR is still worth observing (no checks reported).
  const st = await paged(ctx, { path: `${base}/pullrequests/${n}/statuses`, query: { pagelen: 100 } }, `The builds of #${n}`, 3).catch(optional);
  const dest = str(asObj(asObj(pr.destination).branch).name, 255);
  const protection = dest ? await readProtection(ctx, dest).catch(optional) : undefined;
  return foldCloudPull({ connection: ctx.conn.id, pr, statuses: st?.values ?? [], ...(protection ? { protection } : {}) });
}

async function rawPull(ctx: AdapterCtx, id: string): Promise<Obj> {
  const n = numId(id, 'pull request');
  const { json } = await getJson(ctx, { path: `${repoPath(ctx)}/pullrequests/${n}`, conditional: false }, `Pull request #${n}`);
  return asObj(json);
}

// ── issues (only where the repository uses the tracker) ────────────────────

async function readIssue(ctx: AdapterCtx, id: string): Promise<Obj> {
  const n = numId(id, 'issue');
  const { json } = await getJson(ctx, { path: `${repoPath(ctx)}/issues/${n}`, conditional: false }, `Issue #${n}`);
  return asObj(json);
}

function issueConflict(n: number, current: string, ifRev: string): ConnectionError {
  return new ConnectionError(
    `Issue #${n} changed on Bitbucket (updated ${current || 'at an unknown time'}) after AICO last read it (${ifRev || 'never'}). It was left as it is; pull it again and decide.`,
    'conflict', 409);
}

// ── probe ──────────────────────────────────────────────────────────────────

const NEEDED: ScopeAdvice[] = [
  { scope: 'read:repository, write:repository', why: 'Read the repository and push aico/task-* branches.', feature: 'repos', required: true },
  { scope: 'read:pullrequest, write:pullrequest', why: 'Open pull requests, comment, and merge on your click.', feature: 'pulls', required: true },
  { scope: 'read:pipeline', why: 'Read build results (they arrive as commit statuses).', feature: 'checks', required: false },
  { scope: 'read:issue, write:issue', why: 'Import issues, only for repositories that use the issue tracker.', feature: 'items', required: false },
];

async function probe(ctx: AdapterCtx): Promise<ProbeResult> {
  const warnings: string[] = [];
  const caps: Capabilities = noCapabilities();
  caps.pulls.bodyMax = CLOUD_PULL_BODY_MAX;
  caps.iterations = 'none';

  // The account behind the token. An access token (repository, project, workspace) cannot read /user; that is fine.
  const userRes = await call(ctx, { path: '/user', conditional: false });
  let user = '';
  if (userRes.status === 200) user = str(asObj(userRes.json).nickname || asObj(userRes.json).display_name || asObj(userRes.json).username, 80);
  else if (userRes.status === 403 || userRes.status === 404) {
    user = ctx.conn.username ? str(ctx.conn.username, 80) : 'access token';
    warnings.push('This token cannot read its own account (normal for a repository or workspace access token), so "assigned to me" cannot be used.');
  } else throw failure(userRes, 'The account behind this token');
  const scopesHeader = userRes.headers['x-oauth-scopes'];
  const reported = scopesHeader !== undefined && scopesHeader.trim() !== '';
  const found = reported ? scopesHeader!.split(',').map(s => s.trim()).filter(Boolean) : [];

  if (ctx.repo) await probeRepo(ctx, caps, warnings);
  else {
    const list = await call(ctx, { path: '/repositories', query: { role: 'member', pagelen: 1 }, conditional: false });
    caps.repos = list.status === 200;
    warnings.push('Map a repository and test again to see what this token can do there.');
  }
  warnings.push('Bitbucket Cloud has no sprints, so AICO\'s sprints stay local. Jira is not supported.');

  return {
    at: new Date().toISOString(), user,
    capabilities: caps,
    // Until a repository is mapped nothing can be probed, so nothing is called missing: the warning says to map and test again.
    scopes: { found, needed: ctx.repo ? NEEDED : NEEDED.map(n => ({ ...n, required: false })), missing: [], extra: [], reported: false },
    warnings,
  };
}

async function probeRepo(ctx: AdapterCtx, caps: Capabilities, warnings: string[]): Promise<void> {
  const base = repoPath(ctx);
  const name = repoName(ctx);
  const repo = await call(ctx, { path: base, conditional: false });
  if (repo.status === 404 || repo.status === 403) { warnings.push(`The repository ${name} was not found, or this token cannot see it.`); return; }
  if (repo.status !== 200) throw failure(repo, `The repository ${name}`);
  caps.repos = true;
  const rj = asObj(repo.json);
  const branch = str(asObj(rj.mainbranch).name, 255) || 'main';

  // Cloud does not put permissions on the repository; ask the account's own permission on it where the token may.
  let canWrite = true;
  const perm = await call(ctx, { path: '/user/permissions/repositories', query: { q: `repository.full_name="${filterValue(name, 'The repository name')}"`, pagelen: 1 }, conditional: false });
  if (perm.status === 200) {
    const p = str(asObj(asArr(asObj(perm.json).values)[0]).permission, 20);
    if (p) canWrite = p === 'write' || p === 'admin';
  }

  const pulls = await call(ctx, { path: `${base}/pullrequests`, query: { pagelen: 1, state: 'OPEN' }, conditional: false });
  if (pulls.status === 200) {
    caps.pulls = { create: canWrite, comment: canWrite, merge: canWrite, draft: canWrite, bodyMax: CLOUD_PULL_BODY_MAX };
    if (!canWrite) warnings.push('This token can only read the repository, so AICO cannot open or merge pull requests.');
  } else warnings.push('Pull requests are unreadable with this token (it needs read:pullrequest and write:pullrequest).');

  if (rj.has_issues === true) {
    const issues = await call(ctx, { path: `${base}/issues`, query: { pagelen: 1 }, conditional: false });
    if (issues.status === 200) caps.items = { ...caps.items, query: true, create: canWrite, transition: canWrite, comment: canWrite };
    else warnings.push('The issue tracker is unreadable with this token (it needs read:issue and write:issue).');
  } else {
    warnings.push('The issue tracker is turned off for this repository (common on Bitbucket Cloud), so work items are unavailable. Jira is not supported.');
  }

  const checks = await call(ctx, { path: `${base}/commit/${enc(branch)}/statuses`, query: { pagelen: 1 }, conditional: false });
  if (checks.status === 200) caps.checks.read = true;
  else warnings.push('Checks are unreadable with this token (it needs read:pipeline), so pull requests will show no builds.');

  const prot = await readProtection(ctx, branch);
  if (prot.unreadable) warnings.push(`Branch protection unreadable (${prot.unreadable}): AICO cannot see which approvals and builds ${branch} requires.`);
  else caps.protection.read = true;
}

// ── the adapter ────────────────────────────────────────────────────────────

function repoInfo(conn: StoredConnection, j: Obj, ref: RepoRef): RepoInfo {
  const origin = hostOf(conn.baseUrl)?.origin ?? 'https://bitbucket.org';
  const full = typeof j.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(j.full_name) ? j.full_name : `${ref.owner}/${ref.name}`;
  const web = isCloudHost(conn.baseUrl) ? 'https://bitbucket.org' : origin;
  return {
    ref: { owner: full.split('/')[0]!, name: full.split('/')[1]!, ...(typeof j.uuid === 'string' ? { id: j.uuid } : {}) },
    defaultBranch: str(asObj(j.mainbranch).name, 255) || 'main',
    // Rebuilt from the base URL, never copied from the response: no userinfo, no foreign host.
    cloneUrl: `${web}/${full}.git`,
    htmlUrl: `${web}/${full}`,
    private: j.is_private === true,
  };
}

export const bitbucketCloudAdapter: ProviderAdapter = {
  id: 'bitbucket-cloud',

  apiBase: cloudApiBase,

  hostsFor(baseUrl) {
    if (isCloudHost(baseUrl)) return ['api.bitbucket.org', 'bitbucket.org'];
    const h = hostOf(baseUrl);
    return h ? [h.host] : [];
  },

  clientOptions(conn) {
    return {
      apiBase: cloudApiBase(conn),
      // API token + account email = Basic; a repository/workspace access token = Bearer.
      auth: conn.username ? { kind: 'basic' } : { kind: 'bearer' },
      ...(conn.username ? { username: conn.username } : {}),
      headers: { Accept: 'application/json' },
    };
  },

  parseRemote: parseCloudRemote,
  gitUsername: conn => (conn.username ? 'x-bitbucket-api-token-auth' : 'x-token-auth'),

  probe,

  repos: {
    async get(ctx, ref) {
      const c: AdapterCtx = { ...ctx, repo: ref };
      const { json } = await getJson(c, { path: repoPath(c) }, `The repository ${ref.owner}/${ref.name}`);
      return repoInfo(ctx.conn, asObj(json), ref);
    },
    async list(ctx, query) {
      const { values } = await paged(ctx, { path: '/repositories', query: { role: 'member', sort: '-updated_on', pagelen: 100 } }, 'The repository list', 3);
      const q = query?.trim().toLowerCase();
      return values.map(asObj)
        .filter(r => !q || String(r.full_name ?? '').toLowerCase().includes(q))
        .map(r => repoInfo(ctx.conn, r, { owner: '', name: '' }));
    },
  },

  pulls: {
    async find(ctx, head) {
      const q = `source.branch.name="${filterValue(head, 'The branch name')}" AND state="OPEN"`;
      const { json } = await getJson(ctx, { path: `${repoPath(ctx)}/pullrequests`, query: { q, pagelen: 5 } }, 'The pull request list');
      const first = asArr(asObj(json).values).map(asObj).find(p => asObj(asObj(p.source).branch).name === head);
      return first && typeof first.id === 'number' ? fetchPull(ctx, String(first.id)) : undefined;
    },

    async create(ctx, input: NewPull) {
      const title = cleanTitle(input.title);
      const { head, overflow } = clipText(withoutAttribution(input.body ?? ''), CLOUD_PULL_BODY_MAX);
      const res = await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/pullrequests`, audit: 'pr.open', ref: input.head,
        json: {
          title, description: head, draft: input.draft === true,
          source: { branch: { name: input.head } }, destination: { branch: { name: input.base } },
          // Never delete the source branch on merge: AICO does not delete remote branches.
          close_source_branch: false,
        },
      }, 'opening the pull request', 'write:pullrequest');
      const pull = foldCloudPull({ connection: ctx.conn.id, pr: asObj(res.json), statuses: [] });
      return { pull, ...(overflow ? { overflow } : {}) };
    },

    async update(ctx, id, patch) {
      const n = numId(id, 'pull request');
      if (patch.state === 'closed') {
        await write(ctx, { method: 'POST', path: `${repoPath(ctx)}/pullrequests/${n}/decline`, json: {}, audit: 'write', ref: id }, `Pull request #${n}`, 'write:pullrequest');
        return fetchPull(ctx, id);
      }
      const json: Obj = {};
      if (patch.title !== undefined) json.title = cleanTitle(patch.title);
      if (patch.body !== undefined) {
        const { head, overflow } = clipText(withoutAttribution(patch.body), CLOUD_PULL_BODY_MAX);
        json.description = overflow ? `${head}\n\n… (cut; the rest is in the first comment)` : head;
      }
      if (Object.keys(json).length) {
        await write(ctx, { method: 'PUT', path: `${repoPath(ctx)}/pullrequests/${n}`, json, audit: 'write', ref: id }, `Pull request #${n}`, 'write:pullrequest');
      }
      return fetchPull(ctx, id);
    },

    async comment(ctx, id, markdown) {
      const n = numId(id, 'pull request');
      const body = clipText(withoutAttribution(markdown), COMMENT_MAX);
      await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/pullrequests/${n}/comments`, audit: 'write', ref: id,
        json: { content: { raw: body.overflow ? `${body.head}\n\n… (cut at ${COMMENT_MAX} characters)` : body.head } },
      }, `Pull request #${n}`, 'write:pullrequest');
    },

    get: fetchPull,

    async comments(ctx, id) {
      const n = numId(id, 'pull request');
      const pr = await rawPull(ctx, id);
      const { values } = await paged(ctx, { path: `${repoPath(ctx)}/pullrequests/${n}/comments`, query: { pagelen: 100 } }, `The comments of #${n}`, 3);
      return foldCloudComments(values, pr) as Comment[];
    },

    async merge(ctx, id, opts) {
      const n = numId(id, 'pull request');
      // Cloud's merge has no head-sha parameter: re-read, and refuse if the head is not the one the caller reviewed.
      const now = await rawPull(ctx, id);
      const head = str(asObj(asObj(now.source).commit).hash, 64);
      const want = commitSha(opts.sha);
      if (!head || !(head.startsWith(want) || want.startsWith(head))) {
        throw new ConnectionError(`#${n} was not merged because its branch changed after it was reviewed. Look at the new commits first.`, 'conflict', 409);
      }
      const res = await call(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/pullrequests/${n}/merge`, audit: 'pr.merge', ref: id,
        // Only the strategy: no `close_source_branch` (AICO never deletes a remote branch), no override of a restriction exists in this call.
        json: { type: 'pullrequest', merge_strategy: STRATEGY[opts.method], close_source_branch: false },
      });
      if (res.status === 200) return { sha: str(asObj(asObj(res.json).merge_commit).hash, 64) };
      if (res.status === 202) {
        // Long merges are asynchronous; the task finishes on its own and the next observation sees `merged`.
        const merged = await rawPull(ctx, id).catch(() => undefined);
        return { sha: merged ? str(asObj(merged.merge_commit).hash, 64) : '' };
      }
      if (res.status === 409 || res.status === 555) {
        const why = failure(res, `Merging #${n}`).message;
        throw new ConnectionError(`Bitbucket will not merge #${n} right now: ${why}`, 'conflict', res.status);
      }
      if (res.status === 400) {
        throw new ConnectionError(`Bitbucket will not merge #${n} right now: ${failure(res, `Merging #${n}`).message}`, 'conflict', 400);
      }
      throw failure(res, `Merging #${n}`, 'write:pullrequest');
    },
  },

  items: {
    async query(ctx, q: ItemQuery) {
      if (q.source === 'off') return { items: [], notModified: true };
      const parts: string[] = [];
      const state = q.state ?? 'open';
      if (state === 'open') parts.push('(state="new" OR state="open" OR state="on hold")');
      else if (state === 'closed') parts.push('(state="resolved" OR state="closed" OR state="invalid" OR state="duplicate" OR state="wontfix")');
      if (q.since) {
        const t = Date.parse(q.since);
        if (Number.isFinite(t)) parts.push(`updated_on>=${new Date(t).toISOString()}`);
      }
      if (q.source === 'label') {
        if (!q.value?.trim()) throw new ConnectionError('Importing by component needs a component name.', 'config');
        parts.push(`component.name="${filterValue(sanitizeLine(q.value, REMOTE_LIMITS.label), 'The component')}"`);
      } else if (q.source === 'assigned-to-me') {
        if (!q.me) throw new ConnectionError('Importing items assigned to you needs to know which account the token acts as; test the connection first.', 'config');
        parts.push(`assignee.nickname="${filterValue(q.me, 'The account')}"`);
      } else if (q.source === 'query') {
        const text = sanitizeLine(q.value ?? '', 256);
        if (text) parts.push(`(${text})`);
      }
      const out = await paged(ctx, { path: `${repoPath(ctx)}/issues`, query: { ...(parts.length ? { q: parts.join(' AND ') } : {}), sort: '-updated_on', pagelen: 100 } }, 'The issue list', 5);
      return { items: out.values.map(v => foldCloudIssue(asObj(v))), notModified: out.notModified };
    },

    async get(ctx, id) { return foldCloudIssue(await readIssue(ctx, id)); },

    async create(ctx, input) {
      const title = cleanTitle(input.title);
      const body = clipText(withoutAttribution(input.body ?? ''), ISSUE_BODY_MAX).head;
      const res = await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/issues`, audit: 'write', ref: 'new-issue',
        json: { title, content: { raw: body } },
      }, 'creating the issue', 'write:issue');
      return foldCloudIssue(asObj(res.json));
    },

    async update(ctx, id, patch, ifRev) {
      const n = numId(id, 'issue');
      const current = await readIssue(ctx, id);
      if (String(current.updated_on ?? '') !== ifRev) throw issueConflict(n, String(current.updated_on ?? ''), ifRev);
      const json: Obj = {};
      if (patch.title !== undefined) json.title = cleanTitle(patch.title);
      if (patch.body !== undefined) json.content = { raw: clipText(withoutAttribution(patch.body), ISSUE_BODY_MAX).head };
      const res = await write(ctx, { method: 'PUT', path: `${repoPath(ctx)}/issues/${n}`, json, audit: 'write', ref: id }, `Issue #${n}`, 'write:issue');
      return foldCloudIssue(asObj(res.json));
    },

    async transition(ctx, id, to, ifRev) {
      const n = numId(id, 'issue');
      const current = await readIssue(ctx, id);
      if (String(current.updated_on ?? '') !== ifRev) throw issueConflict(n, String(current.updated_on ?? ''), ifRev);
      const res = await write(ctx, {
        method: 'PUT', path: `${repoPath(ctx)}/issues/${n}`, audit: 'write', ref: id,
        json: { state: to === 'closed' ? 'resolved' : 'open' },
      }, `Issue #${n}`, 'write:issue');
      return foldCloudIssue(asObj(res.json));
    },

    async comment(ctx, id, markdown) {
      const n = numId(id, 'issue');
      const body = clipText(withoutAttribution(markdown), COMMENT_MAX);
      await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/issues/${n}/comments`, audit: 'write', ref: id,
        json: { content: { raw: body.overflow ? `${body.head}\n\n… (cut at ${COMMENT_MAX} characters)` : body.head } },
      }, `Issue #${n}`, 'write:issue');
    },

    // Cloud issues have no labels. These are no-ops by design: AICO's progress shows on the pull request
    // and in comments, and the sync's label pushes must not fail every cycle on a tracker that cannot take them.
    async addLabels() { /* no labels on Bitbucket Cloud issues */ },
    async removeLabel() { /* no labels on Bitbucket Cloud issues */ },
  },

  checks: {
    async forCommit(ctx, commit) {
      const s = commitSha(commit);
      const { values } = await paged(ctx, { path: `${repoPath(ctx)}/commit/${s}/statuses`, query: { pagelen: 100 } }, 'The commit statuses', 3);
      return values.map(v => foldCloudStatus(asObj(v))) as RemoteCheck[];
    },
  },

  protection: {
    read: readProtection,
  },
};

