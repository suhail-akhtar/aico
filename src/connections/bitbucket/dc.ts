/**
 * The Bitbucket Data Center / Server adapter: REST 1.0 under `/rest/api/1.0` (plus
 * `/rest/build-status/1.0` and `/rest/branch-permissions/2.0`), an HTTP access token as Bearer,
 * no SDK (ADR 0039). Projects, repositories, pull requests, build statuses and the server's own
 * merge checks. No work items, no sprints: Data Center keeps those in Jira, which is out of scope.
 *
 * WHY it looks the way it does, each point a failure it prevents:
 *
 *  - **Merge is optimistic.** `POST .../merge?version=N` is refused (409) unless N is the pull
 *    request's CURRENT version, because any edit, approval or push bumps it. So `merge` reads the
 *    PR fresh, compares its head commit to the one the caller reviewed (a push after review is a
 *    `conflict`, not a merge), and sends that version. A 409 therefore means "it changed under
 *    you", and the message says to look again. Retrying blindly with a newer version would defeat
 *    the lock, so nothing here retries a merge.
 *  - **The server answers "can it merge?"** (`GET .../merge`: `canMerge`, `conflicted`, and a veto
 *    per unmet rule, such as required approvers, required builds and open tasks). The fold uses
 *    that verdict and its sentences; AICO never second-guesses it and never bypasses a veto.
 *  - **Build status is pushed by an external CI** (Bamboo, Jenkins) onto the commit. It is read
 *    from `/rest/build-status/1.0/commits/<sha>`; a pull request with no CI simply has no checks,
 *    which is "none", never "passing".
 *  - **The context path matters.** Data Center is often served under `/bitbucket`; every URL is
 *    built from the base URL's path, not from its origin alone.
 *  - **Required approvers are an admin setting.** `settings/pull-requests` needs repository admin
 *    to read; without it the requirement is "unreadable" (a warning chip), and the server's veto
 *    list still tells the truth at merge time.
 *  - **Git user name.** Over https the token is the password and the user name is the account
 *    the token acts as (found by the probe); the engine's askpass answers with it.
 *
 * What it does not do: approve (AICO never approves a pull request), edit reviewers, change
 * branch permissions (read only), or touch Jira.
 *
 * @module connections/bitbucket/dc
 */

import type { Capabilities, PullState, RepoRef, ProbeResult, ScopeAdvice } from '../../../shared/connections/types.js';
import {
  noCapabilities,
  type AdapterCtx, type Comment, type NewPull, type ProtectionInfo, type ProviderAdapter, type RepoInfo,
} from '../adapter.js';
import { ConnectionError, type ConnRequest, type ConnResponse } from '../http.js';
import { sanitizeLine, withoutAttribution } from '../sanitize.js';
import type { StoredConnection } from '../types.js';
import { asArr, asObj, bbMessage, call, commitSha, enc, failure, numId, optional, str, type Obj } from './common.js';
import { clipText, foldDcActivities, foldDcBuild, foldDcPull, foldDcPullSettings, patternCovers, type DcMergeCheck } from './fold.js';

/** Data Center rejects a description over 32,768 characters; stay under it. */
export const DC_PULL_BODY_MAX = 30_000;
const COMMENT_MAX = 30_000;

// ── URLs ───────────────────────────────────────────────────────────────────

function parsed(baseUrl: string): URL {
  try { return new URL(baseUrl); } catch { throw new ConnectionError(`"${baseUrl}" is not a URL.`, 'config'); }
}
/** `https://host[:port][/context]`, no trailing slash. */
export function dcRoot(conn: Pick<StoredConnection, 'baseUrl'>): string {
  const u = parsed(conn.baseUrl);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}
export function dcApiBase(conn: Pick<StoredConnection, 'baseUrl'>): string { return `${dcRoot(conn)}/rest/api/1.0`; }

const KEY = /^~?[A-Za-z0-9_.-]+$/;
const SLUG = /^[A-Za-z0-9_.-]+$/;

/** `https://host[/ctx]/scm/KEY/slug.git`, `ssh://git@host[:7999]/KEY/slug.git`, `https://host[/ctx]/projects/KEY/repos/slug/browse`. */
export function parseDcRemote(url: string, baseUrl: string): RepoRef | undefined {
  let base: URL;
  try { base = new URL(baseUrl); } catch { return undefined; }
  const ctxPath = base.pathname.replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(url.trim()); } catch { return undefined; }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return undefined;
  const web = u.protocol === 'https:' || u.protocol === 'http:';
  if (u.hostname.toLowerCase() !== base.hostname.toLowerCase()) return undefined;
  if (web && u.host.toLowerCase() !== base.host.toLowerCase()) return undefined;
  const ok = (key: string | undefined, slug: string | undefined): RepoRef | undefined => {
    if (!key || !slug) return undefined;
    const name = slug.replace(/\.git$/i, '');
    return KEY.test(key) && SLUG.test(name) ? { owner: key, name } : undefined;
  };
  let p = decodeURIComponent(u.pathname);
  if (web) {
    if (ctxPath && !p.startsWith(`${ctxPath}/`)) return undefined;
    p = p.slice(ctxPath.length);
    const scm = /^\/scm\/([^/]+)\/([^/]+?)\/?$/.exec(p);
    if (scm) return ok(scm[1], scm[2]);
    const browse = /^\/projects\/([^/]+)\/repos\/([^/]+)(?:\/.*)?$/.exec(p);
    return browse ? ok(browse[1], browse[2]) : undefined;
  }
  // ssh: /KEY/slug.git (the SSH port differs from the web port by design).
  const segs = p.replace(/^\/+|\/+$/g, '').split('/');
  return segs.length === 2 ? ok(segs[0], segs[1]) : undefined;
}

// ── helpers ────────────────────────────────────────────────────────────────

function repoOf(ctx: AdapterCtx): RepoRef {
  if (!ctx.repo) throw new ConnectionError('This operation needs a repository: map the project to a Bitbucket repository first.', 'config');
  return ctx.repo;
}
const repoPath = (ctx: AdapterCtx): string => { const r = repoOf(ctx); return `/projects/${enc(r.owner)}/repos/${enc(r.name)}`; };
const repoName = (ctx: AdapterCtx): string => { const r = repoOf(ctx); return `${r.owner}/${r.name}`; };
const repoRefObj = (r: RepoRef): Obj => ({ slug: r.name, project: { key: r.owner } });
const sibling = (ctx: AdapterCtx, tail: string): string => `${dcRoot(ctx.conn)}${tail}`;

async function getJson(ctx: AdapterCtx, req: ConnRequest, what: string): Promise<{ res: ConnResponse; json: unknown }> {
  const res = await call(ctx, req);
  if (res.status < 200 || res.status >= 300) throw failure(res, what, undefined, 'Bitbucket');
  return { res, json: res.json };
}

async function write(ctx: AdapterCtx, req: ConnRequest, what: string, needs: string): Promise<ConnResponse> {
  const res = await call(ctx, req);
  if (res.status < 200 || res.status >= 300) throw failure(res, what, needs, 'Bitbucket');
  return res;
}

/** Every page of a `{values, isLastPage, nextPageStart}` list, bounded; a non-2xx page is an error. */
async function paged(ctx: AdapterCtx, first: ConnRequest, what: string, maxPages = 5): Promise<{ values: unknown[]; more: boolean }> {
  const values: unknown[] = [];
  let start = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await call(ctx, { ...first, query: { limit: 100, ...(first.query ?? {}), start } });
    if (res.status < 200 || res.status >= 300) throw failure(res, what);
    const j = asObj(res.json);
    values.push(...asArr(j.values));
    if (j.isLastPage !== false || typeof j.nextPageStart !== 'number') return { values, more: false };
    start = j.nextPageStart;
  }
  return { values, more: true };
}

function cleanTitle(t: string, max = 250): string {
  const out = withoutAttribution(t).replace(/\s+/g, ' ').trim().slice(0, max);
  if (!out) throw new ConnectionError('A title is required.', 'config');
  return out;
}

const STRATEGY: Record<'merge' | 'squash' | 'rebase', string> = { merge: 'no-ff', squash: 'squash', rebase: 'rebase-no-ff' };

// ── protection ─────────────────────────────────────────────────────────────

async function readProtection(ctx: AdapterCtx, branch: string): Promise<ProtectionInfo> {
  const base = repoPath(ctx);
  const settings = await call(ctx, { path: `${base}/settings/pull-requests`, conditional: false });
  const perms = await call(ctx, { path: sibling(ctx, `/rest/branch-permissions/2.0${base}/restrictions`), query: { limit: 100 }, conditional: false });
  if (settings.status !== 200 && perms.status !== 200) {
    if ([401, 403, 404].includes(settings.status) || [401, 403, 404].includes(perms.status)) return { protected: false, unreadable: 'needs repository admin' };
    throw failure(settings, `branch protection for ${branch}`);
  }
  let reviews = 0;
  const checks: string[] = [];
  let isProtected = false;
  if (settings.status === 200) {
    const s = foldDcPullSettings(asObj(settings.json));
    reviews = s.requiredReviews;
    if (s.requiredBuilds > 0) checks.push(`${s.requiredBuilds} successful build${s.requiredBuilds === 1 ? '' : 's'}`);
    if (s.requiredReviews > 0 || s.requiredBuilds > 0) isProtected = true;
  }
  if (perms.status === 200) {
    for (const r of asArr(asObj(perms.json).values)) {
      const o = asObj(r);
      const m = asObj(o.matcher);
      const type = String(asObj(m.type).id ?? '');
      const id = String(m.id ?? '');
      const covers = (type === 'BRANCH' && (id === `refs/heads/${branch}` || id === branch))
        || (type === 'PATTERN' && patternCovers({ kind: String(o.type), pattern: id, branch_match_kind: 'glob' }, branch));
      if (covers && o.type) isProtected = true;
    }
  }
  return { protected: isProtected, requiredReviews: reviews, requiredChecks: checks };
}

// ── pull requests ──────────────────────────────────────────────────────────

async function rawPull(ctx: AdapterCtx, id: string): Promise<Obj> {
  const n = numId(id, 'pull request');
  const { json } = await getJson(ctx, { path: `${repoPath(ctx)}/pull-requests/${n}`, conditional: false }, `Pull request #${n}`);
  return asObj(json);
}

async function buildsOf(ctx: AdapterCtx, sha: string): Promise<unknown[] | undefined> {
  if (!sha) return [];
  const r = await paged(ctx, { path: sibling(ctx, `/rest/build-status/1.0/commits/${commitSha(sha)}`), conditional: false }, 'The build statuses', 2).catch(optional);
  return r?.values;
}

async function fetchPull(ctx: AdapterCtx, id: string): Promise<PullState> {
  const n = numId(id, 'pull request');
  const pr = await rawPull(ctx, id);
  const open = pr.state === 'OPEN';
  let merge: DcMergeCheck | undefined;
  if (open) {
    const m = await call(ctx, { path: `${repoPath(ctx)}/pull-requests/${n}/merge`, conditional: false });
    if (m.status === 200) merge = asObj(m.json) as DcMergeCheck;
    else if (![401, 403, 404, 409].includes(m.status)) throw failure(m, `The merge check of #${n}`);
  }
  const head = str(asObj(pr.fromRef).latestCommit, 64);
  const builds = await buildsOf(ctx, head);
  const dest = str(asObj(pr.toRef).displayId, 255);
  const protection = dest ? await readProtection(ctx, dest).catch(optional) : undefined;
  return foldDcPull({ connection: ctx.conn.id, pr, merge, builds: builds ?? [], ...(protection ? { protection } : {}) });
}

// ── probe ──────────────────────────────────────────────────────────────────

const NEEDED: ScopeAdvice[] = [
  { scope: 'Project or Repository write', why: 'Read repositories, push aico/task-* branches, open and merge pull requests.', feature: 'pulls', required: true },
  { scope: 'Repository admin (optional)', why: 'Read the required approvers and branch permissions.', feature: 'protection', required: false },
];

async function probe(ctx: AdapterCtx): Promise<ProbeResult> {
  const warnings: string[] = [];
  const caps: Capabilities = noCapabilities();
  caps.pulls.bodyMax = DC_PULL_BODY_MAX;
  caps.iterations = 'none';

  // The account behind the token: a plain-text login (it is also the git user name over https).
  const who = await call(ctx, { path: sibling(ctx, '/plugins/servlet/applinks/whoami'), conditional: false, headers: { Accept: 'text/plain' } });
  if (who.status === 401 || who.status === 403) throw failure(who, 'The account behind this token');
  const user = who.status === 200 ? sanitizeLine(who.text.trim(), 80) : '';
  if (!user) warnings.push('The server did not say which account this token acts as, so "assigned to me" and the git user name are unavailable.');

  let version: string | undefined;
  const props = await call(ctx, { path: '/application-properties', conditional: false }).catch((e: unknown) => {
    if (e instanceof ConnectionError && (e.code === 'rate-limited' || e.code === 'auth')) throw e;
    return undefined; // the version is a nicety; its absence is not a failed probe
  });
  if (props?.status === 200) version = str(asObj(props.json).version, 40) || undefined;

  if (ctx.repo) await probeRepo(ctx, caps, warnings);
  else {
    const list = await call(ctx, { path: '/repos', query: { limit: 1 }, conditional: false });
    caps.repos = list.status === 200;
    warnings.push('Map a repository and test again to see what this token can do there.');
  }
  warnings.push('Bitbucket Data Center has no sprints or work items here (they live in Jira, which is not supported), so AICO\'s sprints stay local.');

  return {
    at: new Date().toISOString(), user,
    ...(version ? { version } : {}),
    capabilities: caps,
    scopes: { found: [], needed: ctx.repo ? NEEDED : NEEDED.map(n => ({ ...n, required: false })), missing: [], extra: [], reported: false },
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

  const def = await call(ctx, { path: `${base}/branches/default`, conditional: false });
  const branch = def.status === 200 ? str(asObj(def.json).displayId, 255) || 'main' : 'main';
  const head = def.status === 200 ? str(asObj(def.json).latestCommit, 64) : '';

  const pulls = await call(ctx, { path: `${base}/pull-requests`, query: { limit: 1, state: 'ALL' }, conditional: false });
  if (pulls.status === 200) {
    // Whether the token may WRITE is not readable without admin; the first push or PR says so plainly.
    caps.pulls = { create: true, comment: true, merge: true, draft: true, bodyMax: DC_PULL_BODY_MAX };
    warnings.push('Bitbucket does not say whether this token may write; if a push or pull request is refused, the token needs Repository (or Project) write.');
  } else warnings.push('Pull requests are unreadable with this token (it needs Repository read and write).');

  if (head) {
    const b = await call(ctx, { path: sibling(ctx, `/rest/build-status/1.0/commits/${head}`), query: { limit: 1 }, conditional: false });
    if (b.status === 200) caps.checks.read = true;
    else warnings.push('Checks (build statuses) are unreadable with this token, so pull requests will show no builds.');
  } else caps.checks.read = true;

  const prot = await readProtection(ctx, branch);
  if (prot.unreadable) warnings.push(`Branch protection unreadable (${prot.unreadable}): AICO cannot see which approvers and builds ${branch} requires. The server still enforces them at merge.`);
  else caps.protection.read = true;
}

// ── the adapter ────────────────────────────────────────────────────────────

function repoInfo(conn: StoredConnection, j: Obj, ref: RepoRef, defaultBranch: string): RepoInfo {
  const root = dcRoot(conn);
  const key = str(asObj(j.project).key, 100) || ref.owner;
  const slug = str(j.slug, 100) || ref.name;
  return {
    ref: { owner: key, name: slug, ...(j.id !== undefined ? { id: String(j.id) } : {}) },
    defaultBranch,
    // Rebuilt from the base URL, never copied from the response: no userinfo, no foreign host.
    cloneUrl: `${root}/scm/${key.toLowerCase()}/${slug}.git`,
    htmlUrl: `${root}/projects/${key}/repos/${slug}/browse`,
    private: j.public !== true,
  };
}

export const bitbucketDcAdapter: ProviderAdapter = {
  id: 'bitbucket-dc',

  apiBase: dcApiBase,

  hostsFor(baseUrl) {
    try { return [new URL(baseUrl).host.toLowerCase()]; } catch { return []; }
  },

  clientOptions(conn) {
    return { apiBase: dcApiBase(conn), auth: { kind: 'bearer' }, headers: { Accept: 'application/json' } };
  },

  parseRemote: parseDcRemote,
  gitUsername: conn => conn.probe?.user || 'x-token-auth',

  probe,

  repos: {
    async get(ctx, ref) {
      const c: AdapterCtx = { ...ctx, repo: ref };
      const { json } = await getJson(c, { path: repoPath(c) }, `The repository ${ref.owner}/${ref.name}`);
      const def = await call(c, { path: `${repoPath(c)}/branches/default`, conditional: false });
      const branch = def.status === 200 ? str(asObj(def.json).displayId, 255) || 'main' : 'main';
      return repoInfo(ctx.conn, asObj(json), ref, branch);
    },
    async list(ctx, query) {
      const { values } = await paged(ctx, { path: '/repos', query: { permission: 'REPO_READ' } }, 'The repository list', 3);
      const q = query?.trim().toLowerCase();
      return values.map(asObj)
        .filter(r => !q || `${str(asObj(r.project).key)}/${str(r.slug)}`.toLowerCase().includes(q))
        .map(r => repoInfo(ctx.conn, r, { owner: '', name: '' }, 'main'));
    },
  },

  pulls: {
    async find(ctx, head) {
      const { json } = await getJson(ctx, {
        path: `${repoPath(ctx)}/pull-requests`, query: { state: 'OPEN', direction: 'OUTGOING', at: `refs/heads/${head}`, limit: 5 },
      }, 'The pull request list');
      const first = asArr(asObj(json).values).map(asObj).find(p => asObj(p.fromRef).id === `refs/heads/${head}`);
      return first && typeof first.id === 'number' ? fetchPull(ctx, String(first.id)) : undefined;
    },

    async create(ctx, input: NewPull) {
      const r = repoOf(ctx);
      const title = cleanTitle(input.title);
      const { head, overflow } = clipText(withoutAttribution(input.body ?? ''), DC_PULL_BODY_MAX);
      const res = await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/pull-requests`, audit: 'pr.open', ref: input.head,
        json: {
          title, description: head, state: 'OPEN', open: true, closed: false, locked: false,
          ...(input.draft ? { draft: true } : {}),
          fromRef: { id: `refs/heads/${input.head}`, repository: repoRefObj(r) },
          toRef: { id: `refs/heads/${input.base}`, repository: repoRefObj(r) },
          reviewers: [],
        },
      }, 'opening the pull request', 'Repository write');
      const pull = foldDcPull({ connection: ctx.conn.id, pr: asObj(res.json), builds: [], justOpened: true });
      return { pull, ...(overflow ? { overflow } : {}) };
    },

    async update(ctx, id, patch) {
      const n = numId(id, 'pull request');
      const pr = await rawPull(ctx, id);
      const version = typeof pr.version === 'number' ? pr.version : 0;
      if (patch.state === 'closed') {
        await write(ctx, { method: 'POST', path: `${repoPath(ctx)}/pull-requests/${n}/decline`, query: { version }, json: {}, audit: 'write', ref: id }, `Pull request #${n}`, 'Repository write');
        return fetchPull(ctx, id);
      }
      const json: Obj = {
        version,
        title: patch.title !== undefined ? cleanTitle(patch.title) : str(pr.title, 250),
        // Reviewers are passed back as they are: an update that omitted them could clear the list.
        reviewers: asArr(pr.reviewers).map(x => ({ user: { name: str(asObj(asObj(x).user).name, 100) } })),
      };
      if (patch.body !== undefined) {
        const { head, overflow } = clipText(withoutAttribution(patch.body), DC_PULL_BODY_MAX);
        json.description = overflow ? `${head}\n\n… (cut; the rest is in the first comment)` : head;
      } else if (typeof pr.description === 'string') json.description = pr.description;
      await write(ctx, { method: 'PUT', path: `${repoPath(ctx)}/pull-requests/${n}`, json, audit: 'write', ref: id }, `Pull request #${n}`, 'Repository write');
      return fetchPull(ctx, id);
    },

    async comment(ctx, id, markdown) {
      const n = numId(id, 'pull request');
      const body = clipText(withoutAttribution(markdown), COMMENT_MAX);
      await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/pull-requests/${n}/comments`, audit: 'write', ref: id,
        json: { text: body.overflow ? `${body.head}\n\n… (cut at ${COMMENT_MAX} characters)` : body.head },
      }, `Pull request #${n}`, 'Repository write');
    },

    get: fetchPull,

    async comments(ctx, id) {
      const n = numId(id, 'pull request');
      const pr = await rawPull(ctx, id);
      const { values } = await paged(ctx, { path: `${repoPath(ctx)}/pull-requests/${n}/activities` }, `The activity of #${n}`, 3);
      return foldDcActivities(values, pr) as Comment[];
    },

    async merge(ctx, id, opts) {
      const n = numId(id, 'pull request');
      // The lock: read the CURRENT version and head; refuse if the head is not what the caller reviewed.
      const now = await rawPull(ctx, id);
      const head = str(asObj(now.fromRef).latestCommit, 64);
      const want = commitSha(opts.sha);
      if (!head || !(head.startsWith(want) || want.startsWith(head))) {
        throw new ConnectionError(`#${n} was not merged because its branch changed after it was reviewed. Look at the new commits first.`, 'conflict', 409);
      }
      const version = typeof now.version === 'number' ? now.version : undefined;
      if (version === undefined) throw new ConnectionError(`Bitbucket did not report the version of #${n}, which a merge needs.`, 'http');
      const res = await call(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/pull-requests/${n}/merge`, query: { version }, audit: 'pr.merge', ref: id,
        // Only the strategy. A veto (required approvers, builds, open tasks) is the server's rule and is final.
        json: { strategyId: STRATEGY[opts.method] },
      });
      if (res.status === 200) return { sha: str(asObj(asObj(asObj(res.json).properties).mergeCommit).id, 64) };
      if (res.status === 409) {
        const why = bbMessage(res);
        throw new ConnectionError(`Bitbucket will not merge #${n}: ${why || 'it changed since it was last read, or a merge rule is not met.'} Look at it again before trying.`, 'conflict', 409);
      }
      throw failure(res, `Merging #${n}`, 'Repository write', 'Bitbucket');
    },
  },

  checks: {
    async forCommit(ctx, commit) {
      const s = commitSha(commit);
      const { values } = await paged(ctx, { path: sibling(ctx, `/rest/build-status/1.0/commits/${s}`) }, 'The build statuses', 3);
      return values.map(v => foldDcBuild(asObj(v)));
    },
  },

  protection: {
    read: readProtection,
  },
};
