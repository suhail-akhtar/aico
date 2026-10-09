/**
 * The GitHub adapter: github.com and GitHub Enterprise Server, plain REST plus one GraphQL
 * POST, no SDK (ADR 0039; a vendor SDK is a supply-chain surface for ~25 endpoints).
 *
 * WHY it looks the way it does, each point a failure it prevents:
 *
 *  - **One base URL rule.** github.com is `api.github.com`; anything else is GHES at
 *    `<origin>/api/v3` (REST) and `<origin>/api/graphql`. A mock forge on loopback is "anything
 *    else", which is also how the conformance suite exercises the GHES path for free.
 *  - **Scopes are only judged when GitHub reports them.** Classic tokens list their scopes in
 *    `x-oauth-scopes`; fine-grained tokens send nothing. For those, capabilities come from
 *    cheap calls against the mapped repository, never from a guess that would show a false
 *    "missing" chip (scopes.ts).
 *  - **Lazy mergeability.** GitHub computes `mergeable` on demand and answers `null` first, so
 *    "unknown" is a first-class state and `canMerge` is derived from `mergeable_state` alone
 *    (clean | unstable | has_hooks), never from `mergeable === true`. Merging sends the head
 *    SHA the caller reviewed, so a push after review cannot be merged unseen, and never asks
 *    for an admin bypass (fold.ts holds the rules, table-tested).
 *  - **Humans win conflicts.** `items.update/transition` re-read the issue and compare
 *    `updated_at` to the caller's `ifRev` before writing; a mismatch is a `conflict`, not a
 *    silent overwrite. The window between the re-read and the PATCH is not closed (GitHub has
 *    no conditional PATCH on issues); it is milliseconds, and the next pull shows the truth.
 *  - **Stranger text is sanitised on the way out** (sanitize.ts) and **AICO text has no AI
 *    credit on the way in** (`withoutAttribution`), in code, not by asking nicely.
 *  - **Issues endpoint returns pull requests too.** Items carrying a `pull_request` key are
 *    dropped from imports.
 *  - **Failures say what to do.** 404 on a repo means "not found or the token cannot see it"
 *    (GitHub does not distinguish, deliberately); 403 on a write names the permission; 422 on
 *    PR creation carries GitHub's own first reason. No message ever includes a header.
 *
 * What it does not do: choose what to sync or when to merge (sync.ts, landing.ts), write
 * Projects v2 items (only milestones are created or assigned), set auto-merge, rerun checks,
 * post inline review comments, or touch protections and rulesets (read only).
 *
 * @module connections/github
 */

import type {
  Capabilities, ProbeResult, PullState, RemoteCheck, RepoRef,
} from '../../../shared/connections/types.js';
import {
  noCapabilities,
  type AdapterCtx, type Comment, type ItemQuery, type Iteration, type NewPull, type ProtectionInfo,
  type ProviderAdapter, type RemoteItem, type RepoInfo,
} from '../adapter.js';
import { ConnectionError, nextLink, type ConnRequest, type ConnResponse } from '../http.js';
import { REMOTE_LIMITS, sanitizeLine, sanitizeRemoteText, withoutAttribution } from '../sanitize.js';
import type { StoredConnection } from '../types.js';
import {
  clipText, foldCheckRun, foldComment, foldItem, foldPull, foldReviewComment, foldStatus, safeUrl,
  type RawCheckRun, type RawComment, type RawIssue, type RawPull, type RawReview, type RawStatus,
} from './fold.js';
import { extraPowers, missingScopes, neededScopes, parseScopes } from './scopes.js';

/** GitHub's PR body limit is 65536; stay under it so a multi-byte edge never trips a 422. */
export const PULL_BODY_MAX = 65_000;
const COMMENT_MAX = 65_000;
const ISSUE_BODY_MAX = 65_000;

// ── URLs ───────────────────────────────────────────────────────────────────

function hostOf(baseUrl: string): { hostname: string; host: string; origin: string } | undefined {
  try { const u = new URL(baseUrl); return { hostname: u.hostname.toLowerCase(), host: u.host.toLowerCase(), origin: u.origin }; } catch { return undefined; }
}
function isDotcom(baseUrl: string): boolean {
  const h = hostOf(baseUrl)?.hostname;
  return h === 'github.com' || h === 'api.github.com' || h === 'www.github.com';
}

export function githubApiBase(conn: Pick<StoredConnection, 'baseUrl'>): string {
  if (isDotcom(conn.baseUrl)) return 'https://api.github.com';
  const h = hostOf(conn.baseUrl);
  if (!h) throw new ConnectionError(`"${conn.baseUrl}" is not a URL.`, 'config');
  return `${h.origin}/api/v3`;
}

export function githubGraphqlUrl(conn: Pick<StoredConnection, 'baseUrl'>): string {
  if (isDotcom(conn.baseUrl)) return 'https://api.github.com/graphql';
  const h = hostOf(conn.baseUrl);
  if (!h) throw new ConnectionError(`"${conn.baseUrl}" is not a URL.`, 'config');
  return `${h.origin}/api/graphql`;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** `https://h/o/r(.git)`, `git@h:o/r(.git)`, `ssh://git@h[:port]/o/r(.git)`; undefined for another host. */
export function parseGithubRemote(url: string, baseUrl: string): RepoRef | undefined {
  const base = hostOf(baseUrl);
  if (!base) return undefined;
  const dotcom = isDotcom(baseUrl);
  const sameHost = (hostname: string, host?: string): boolean => {
    const h = hostname.toLowerCase();
    if (dotcom) return h === 'github.com' || h === 'www.github.com';
    // https keeps its port in the comparison; ssh ports differ from the web port by design.
    return host !== undefined ? host.toLowerCase() === base.host || (host.toLowerCase() === base.hostname && !/:\d+$/.test(base.host)) : h === base.hostname;
  };
  const finish = (pathPart: string): RepoRef | undefined => {
    const segs = pathPart.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    if (segs.length !== 2 || !segs.every(s => SEGMENT.test(s))) return undefined;
    return { owner: segs[0]!, name: segs[1]! };
  };
  const t = url.trim();
  // scp-like: [user@]host:owner/repo.git (no scheme, a colon before the first slash).
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)([^\s]+)$/.exec(t);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return sameHost(scp[1]!) ? finish(scp[2]!) : undefined;
  let u: URL;
  try { u = new URL(t); } catch { return undefined; }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return undefined;
  const web = u.protocol === 'https:' || u.protocol === 'http:';
  if (!sameHost(u.hostname, web ? u.host : undefined)) return undefined;
  return finish(u.pathname);
}

// ── small helpers ──────────────────────────────────────────────────────────

interface Obj { [k: string]: unknown }
const asObj = (x: unknown): Obj => (x && typeof x === 'object' ? x as Obj : {});
const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const enc = encodeURIComponent;

function repoOf(ctx: AdapterCtx): RepoRef {
  if (!ctx.repo) throw new ConnectionError('This operation needs a repository: map the project to a GitHub repository first.', 'config');
  return ctx.repo;
}
const repoPath = (ctx: AdapterCtx): string => { const r = repoOf(ctx); return `/repos/${enc(r.owner)}/${enc(r.name)}`; };
const repoName = (ctx: AdapterCtx): string => { const r = repoOf(ctx); return `${r.owner}/${r.name}`; };

function num(id: string, what: string): number {
  if (!/^\d{1,9}$/.test(id)) throw new ConnectionError(`"${id.slice(0, 40)}" is not a GitHub ${what} number.`, 'config');
  return Number(id);
}
function sha(s: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(s)) throw new ConnectionError('That is not a commit SHA.', 'config');
  return s;
}

function call(ctx: AdapterCtx, req: ConnRequest): Promise<ConnResponse> {
  return ctx.client.request({
    ...req,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.project ? { project: ctx.project } : {}),
  });
}

/** GitHub's own words for a failure, sanitised and short. */
function ghMessage(res: ConnResponse): string {
  const j = asObj(res.json);
  const errors = asArr(j.errors);
  let first = '';
  if (errors.length) {
    const e = errors[0];
    if (typeof e === 'string') first = e;
    else {
      const o = asObj(e);
      if (typeof o.message === 'string') first = o.message;
      else if (o.code === 'missing_field') first = `${String(o.field ?? 'a field')} is missing`;
      else if (o.code === 'invalid') first = `${String(o.field ?? 'a field')} is invalid`;
      else if (o.code === 'already_exists') first = `${String(o.field ?? 'it')} already exists`;
    }
  }
  const main = typeof j.message === 'string' ? j.message : '';
  return sanitizeLine(first || main, 240);
}

/** A response that is not a success, as an error the person can act on. Never mentions a header. */
function failure(res: ConnResponse, what: string, needs?: string): ConnectionError {
  const msg = ghMessage(res);
  const s = res.status;
  if (s === 404) {
    return new ConnectionError(`${what} was not found, or the token cannot see it.${needs ? ` (Changing it needs ${needs}.)` : ''}`, 'not-found', 404);
  }
  if (s === 403) {
    return new ConnectionError(
      needs ? `The token lacks permission for ${what}: it needs ${needs}.${msg ? ` GitHub says: ${msg}` : ''}`
        : `GitHub refused access to ${what} (403).${msg ? ` ${msg}` : ''}`,
      'http', 403);
  }
  if (s === 409) return new ConnectionError(`${what}: ${msg || 'the request conflicts with the current state.'}`, 'conflict', 409);
  if (s === 422) return new ConnectionError(`GitHub rejected ${what}: ${msg || 'the request was not valid.'}`, 'http', 422);
  return new ConnectionError(`GitHub answered ${s} for ${what}.${msg ? ` ${msg}` : ''}`, 'http', s);
}

async function getJson(ctx: AdapterCtx, req: ConnRequest, what: string): Promise<{ res: ConnResponse; json: unknown }> {
  const res = await call(ctx, req);
  if (res.status < 200 || res.status >= 300) throw failure(res, what);
  return { res, json: res.json };
}


/**
 * Every page of a list, following `Link: rel=next` (bounded). Unlike the client's `listAll` it
 * fails on a non-2xx page: the client hands those back as values, and an empty "403 page" read as
 * an empty list would look like "nothing to import".
 */
async function paged<T>(ctx: AdapterCtx, first: ConnRequest, pick: (json: unknown) => T[], what: string, maxPages = 5): Promise<{ items: T[]; notModified: boolean; more: boolean }> {
  const items: T[] = [];
  let req: ConnRequest = first;
  let allCached = true;
  for (let page = 0; page < maxPages; page++) {
    const res = await call(ctx, req);
    if (res.status < 200 || res.status >= 300) throw failure(res, what);
    if (!res.notModified) allCached = false;
    items.push(...pick(res.json));
    const next = nextLink(res.headers);
    if (!next) return { items, notModified: allCached, more: false };
    const { query: _q, ...rest } = first;
    void _q;
    req = { ...rest, path: next };
  }
  return { items, notModified: allCached, more: true };
}

async function write(ctx: AdapterCtx, req: ConnRequest, what: string, needs: string): Promise<ConnResponse> {
  const res = await call(ctx, req);
  if (res.status < 200 || res.status >= 300) throw failure(res, what, needs);
  return res;
}

function cleanTitle(t: string, max = 250): string {
  const out = withoutAttribution(t).replace(/\s+/g, ' ').trim().slice(0, max);
  if (!out) throw new ConnectionError('A title is required.', 'config');
  return out;
}
function cleanBody(t: string, max: number): { head: string; overflow?: string } {
  return clipText(withoutAttribution(t ?? ''), max);
}

// ── GraphQL (Projects v2 iterations) ───────────────────────────────────────

const ITERATION_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){projectsV2(first:20){nodes{id title url field(name:"Iteration"){__typename ... on ProjectV2IterationField{id name configuration{iterations{id title startDate duration} completedIterations{id title startDate duration}}}}}}}}`;

/**
 * Which iteration and how many points each ISSUE has on the repository's Projects v2 boards, in one request (the first 100
 * items of each of the first 10 projects). Field names are the ones GitHub's own board templates use: "Iteration", and
 * "Estimate" or "Story Points" for the number. Read only; Projects v2 writes are not built.
 */
const MEMBERS_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){projectsV2(first:10){nodes{items(first:100){nodes{content{__typename ... on Issue{number}} iteration:fieldValueByName(name:"Iteration"){__typename ... on ProjectV2ItemFieldIterationValue{iterationId}} estimate:fieldValueByName(name:"Estimate"){__typename ... on ProjectV2ItemFieldNumberValue{number}} points:fieldValueByName(name:"Story Points"){__typename ... on ProjectV2ItemFieldNumberValue{number}}}}}}}}`;

interface NativeIterations { available: boolean; iterations: Iteration[]; hasIterationField: boolean }

function addDays(day: string, days: number): string | undefined {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + days * 86_400_000).toISOString().slice(0, 10) : undefined;
}

/** Projects v2 iterations of the projects linked to the repository; `available:false` when the server lacks them. */
async function nativeIterations(ctx: AdapterCtx): Promise<NativeIterations> {
  const r = repoOf(ctx);
  let res: ConnResponse;
  try {
    res = await call(ctx, {
      method: 'POST', path: githubGraphqlUrl(ctx.conn), json: { query: ITERATION_QUERY, variables: { owner: r.owner, name: r.name } },
      conditional: false, audit: 'use', ref: 'graphql',
    });
  } catch (e) {
    // Rate limits and a revoked token are not "Projects v2 is missing"; everything else on this optional call is.
    if (e instanceof ConnectionError && (e.code === 'rate-limited' || e.code === 'auth' || e.code === 'policy' || e.code === 'credential')) throw e;
    return { available: false, iterations: [], hasIterationField: false };
  }
  const j = asObj(res.json);
  const nodes = asArr(asObj(asObj(asObj(j.data).repository).projectsV2).nodes);
  if (res.status !== 200 || asArr(j.errors).length || !asObj(asObj(j.data).repository).projectsV2) {
    return { available: false, iterations: [], hasIterationField: false };
  }
  const out: Iteration[] = [];
  let hasField = false;
  for (const n of nodes) {
    const proj = asObj(n);
    const field = asObj(proj.field);
    if (field.__typename !== 'ProjectV2IterationField') continue;
    hasField = true;
    const cfg = asObj(field.configuration);
    const url = safeUrl(proj.url);
    const push = (items: unknown[], state: 'open' | 'closed'): void => {
      for (const it of items) {
        const o = asObj(it);
        const start = typeof o.startDate === 'string' ? o.startDate : undefined;
        const dur = typeof o.duration === 'number' ? o.duration : undefined;
        // GitHub's iteration spans `duration` days from `startDate`; the last day is inclusive here.
        const end = start && dur ? addDays(start, dur - 1) : undefined;
        out.push({
          id: String(o.id ?? ''), title: sanitizeLine(o.title, REMOTE_LIMITS.title), kind: 'iteration', state,
          ...(start ? { start } : {}), ...(end ? { end } : {}), ...(url ? { url } : {}),
        });
      }
    };
    push(asArr(cfg.iterations), 'open');
    push(asArr(cfg.completedIterations), 'closed');
  }
  return { available: true, iterations: out, hasIterationField: hasField };
}

// ── protection ─────────────────────────────────────────────────────────────

async function readProtection(ctx: AdapterCtx, branch: string): Promise<ProtectionInfo> {
  const path = `${repoPath(ctx)}/branches/${branch.split('/').map(enc).join('/')}/protection`;
  const res = await call(ctx, { path });
  if (res.status === 200) {
    const j = asObj(res.json);
    const reviews = asObj(j.required_pull_request_reviews);
    const sc = asObj(j.required_status_checks);
    const checks = asArr(sc.checks).map(c => sanitizeLine(asObj(c).context, REMOTE_LIMITS.title)).filter(Boolean);
    const legacy = asArr(sc.contexts).map(c => sanitizeLine(c, REMOTE_LIMITS.title)).filter(Boolean);
    return {
      protected: true,
      requiredReviews: typeof reviews.required_approving_review_count === 'number' ? reviews.required_approving_review_count : 0,
      requiredChecks: checks.length ? checks : legacy,
    };
  }
  // GitHub answers an admin's read of an unprotected branch with 404 "Branch not protected":
  // readable, and the answer is "no". Any other 403/404 means the token cannot see it.
  if (res.status === 404 && /not protected/i.test(ghMessage(res))) return { protected: false };
  if (res.status === 403 || res.status === 404) return { protected: false, unreadable: 'needs repo admin' };
  throw failure(res, `branch protection for ${branch}`);
}

// ── pull requests ──────────────────────────────────────────────────────────

async function fetchPull(ctx: AdapterCtx, id: string): Promise<PullState> {
  const n = num(id, 'pull request');
  const base = repoPath(ctx);
  const { json } = await getJson(ctx, { path: `${base}/pulls/${n}` }, `Pull request #${n}`);
  const pr = json as RawPull;
  const head = pr.head?.sha ?? '';
  let runs: RawCheckRun[] = [];
  let statuses: RawStatus[] = [];
  if (head) {
    // A token without Checks/Statuses read gets 403 here; the PR is still worth observing, so the
    // checks are reported as none (and GitHub's own `mergeable_state` still reflects required ones).
    const r = await paged<RawCheckRun>(ctx, { path: `${base}/commits/${head}/check-runs`, query: { per_page: 100 } },
      j => asArr(asObj(j).check_runs) as RawCheckRun[], `The checks of #${n}`, 3).catch(optional);
    runs = r?.items ?? [];
    const s = await call(ctx, { path: `${base}/commits/${head}/status`, query: { per_page: 100 } });
    if (s.status === 200) statuses = asArr(asObj(s.json).statuses) as RawStatus[];
    else if (s.status !== 403 && s.status !== 404) throw failure(s, `The commit status of #${n}`);
  }
  const rv = await paged<RawReview>(ctx, { path: `${base}/pulls/${n}/reviews`, query: { per_page: 100 } },
    j => asArr(j) as RawReview[], `The reviews of #${n}`, 3).catch(optional);
  const protection = pr.base?.ref ? await readProtection(ctx, pr.base.ref).catch(optional) : undefined;
  return foldPull({ connection: ctx.conn.id, pr, runs, statuses, reviews: rv?.items ?? [], ...(protection ? { protection } : {}) });
}

/** For optional reads: a 403/404 means "this token cannot see it", anything else is a real failure. */
function optional(e: unknown): undefined {
  if (e instanceof ConnectionError && (e.status === 403 || e.status === 404)) return undefined;
  throw e;
}

// ── items ──────────────────────────────────────────────────────────────────

async function readIssue(ctx: AdapterCtx, id: string): Promise<RawIssue> {
  const n = num(id, 'issue');
  // Fresh, not conditional: this read decides whether a write may go ahead.
  const { json } = await getJson(ctx, { path: `${repoPath(ctx)}/issues/${n}`, conditional: false }, `Issue #${n}`);
  const issue = json as RawIssue;
  if (issue.pull_request) throw new ConnectionError(`#${n} is a pull request, not an issue.`, 'not-found', 404);
  return issue;
}

function conflict(n: number, current: string, ifRev: string): ConnectionError {
  return new ConnectionError(
    `Issue #${n} changed on GitHub (updated ${current || 'at an unknown time'}) after AICO last read it (${ifRev || 'never'}). It was left as it is; pull it again and decide.`,
    'conflict', 409);
}

function isoOrUndefined(s: string | undefined): string | undefined {
  return s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : undefined;
}

// ── probe ──────────────────────────────────────────────────────────────────

function parseTokenExpiry(h: string | undefined): string | undefined {
  if (!h) return undefined;
  // `2026-12-31 00:00:00 UTC`
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(h.trim());
  const iso = m ? `${m[1]}T${m[2]}Z` : h.trim();
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : undefined;
}

async function probe(ctx: AdapterCtx): Promise<ProbeResult> {
  const warnings: string[] = [];
  const userRes = await call(ctx, { path: '/user', conditional: false });
  if (userRes.status !== 200) throw failure(userRes, 'The account behind this token');
  const user = sanitizeLine(asObj(userRes.json).login, 80);
  const scopesFound = parseScopes(userRes.headers['x-oauth-scopes']);
  const reported = scopesFound !== undefined;
  const found = scopesFound ?? [];

  let version: string | undefined = userRes.headers['x-github-enterprise-version'];
  if (!version && !isDotcom(ctx.conn.baseUrl)) {
    const meta = await call(ctx, { path: '/meta', conditional: false }).catch((e: unknown) => {
      if (e instanceof ConnectionError && e.code === 'rate-limited') throw e;
      return undefined; // the version is a nicety; its absence is not a failed probe
    });
    const v = meta?.status === 200 ? (meta.headers['x-github-enterprise-version'] ?? asObj(meta.json).installed_version) : undefined;
    if (typeof v === 'string') version = v;
  }
  version = version ? sanitizeLine(version, 40) : undefined;

  const caps: Capabilities = noCapabilities();
  caps.repos = true;
  caps.pulls.bodyMax = 65_536;
  caps.items.estimate = 'label';
  caps.checks.logsUrl = true;

  if (ctx.repo) {
    await probeRepo(ctx, caps, warnings);
  } else {
    // Nothing mapped yet: what the token's scopes (or a user-level read) say, and an invitation to map.
    const list = await call(ctx, { path: '/user/repos', query: { per_page: 1 }, conditional: false });
    caps.repos = list.status === 200;
    if (reported) {
      const broad = found.includes('repo');
      caps.pulls = { create: broad, comment: broad, merge: broad, draft: broad, bodyMax: 65_536 };
      caps.items = { ...caps.items, query: broad || found.includes('public_repo'), create: broad, transition: broad, comment: broad };
      caps.checks.read = broad || found.includes('public_repo');
      caps.iterations = broad ? 'milestone' : 'none';
    } else {
      warnings.push('Map a repository and test again to see what this token can do there (fine-grained tokens do not list their permissions).');
    }
  }

  const expiry = parseTokenExpiry(userRes.headers['github-authentication-token-expiration']);
  return {
    at: new Date().toISOString(),
    user,
    ...(version ? { version } : {}),
    capabilities: caps,
    scopes: {
      found, needed: neededScopes(reported), missing: missingScopes(found, reported),
      extra: reported ? extraPowers(found) : [], reported,
    },
    warnings,
    ...(expiry ? { tokenExpiresAt: expiry } : {}),
  };
}

async function probeRepo(ctx: AdapterCtx, caps: Capabilities, warnings: string[]): Promise<void> {
  const base = repoPath(ctx);
  const name = repoName(ctx);
  const repo = await call(ctx, { path: base, conditional: false });
  if (repo.status === 404 || repo.status === 403) {
    warnings.push(`The repository ${name} was not found, or this token cannot see it.`);
    return;
  }
  if (repo.status !== 200) throw failure(repo, `The repository ${name}`);
  const rj = asObj(repo.json);
  const perms = asObj(rj.permissions);
  const canWrite = rj.permissions === undefined || perms.push === true || perms.maintain === true || perms.admin === true;
  const canTriage = canWrite || perms.triage === true;
  const hasIssues = rj.has_issues !== false;
  const branch = typeof rj.default_branch === 'string' && rj.default_branch ? rj.default_branch : 'main';

  const pulls = await call(ctx, { path: `${base}/pulls`, query: { per_page: 1, state: 'all' }, conditional: false });
  if (pulls.status === 200) {
    caps.pulls = { create: canWrite, comment: canTriage, merge: canWrite, draft: canWrite, bodyMax: 65_536 };
    if (!canWrite) warnings.push('This token can only read the repository, so AICO cannot open or merge pull requests.');
  } else warnings.push('Pull requests are unreadable with this token (it needs Pull requests: read and write).');

  if (!hasIssues) {
    warnings.push('Issues are turned off for this repository, so work items are unavailable.');
  } else {
    const issues = await call(ctx, { path: `${base}/issues`, query: { per_page: 1, state: 'all' }, conditional: false });
    if (issues.status === 200) {
      caps.items = { ...caps.items, query: true, create: canTriage, transition: canTriage, comment: canTriage };
    } else warnings.push('Issues are unreadable with this token (it needs Issues: read and write).');
  }

  const checks = await call(ctx, { path: `${base}/commits/${branch.split('/').map(enc).join('/')}/check-runs`, query: { per_page: 1 }, conditional: false });
  if (checks.status === 200) caps.checks.read = true;
  else warnings.push('Checks are unreadable with this token (it needs Checks: read), so pull requests will show no checks.');

  const prot = await readProtection(ctx, branch);
  if (prot.unreadable) warnings.push(`Branch protection unreadable (${prot.unreadable}): AICO cannot see which reviews and checks ${branch} requires.`);
  else caps.protection.read = true;

  const native = await nativeIterations(ctx);
  if (native.available && native.hasIterationField) caps.iterations = 'native';
  else {
    const ms = await call(ctx, { path: `${base}/milestones`, query: { per_page: 1, state: 'all' }, conditional: false });
    caps.iterations = ms.status === 200 ? 'milestone' : 'none';
    if (!native.available) warnings.push('Projects v2 is not available here, so milestones stand in for iterations.');
  }
}

// ── the adapter ────────────────────────────────────────────────────────────

function repoInfo(conn: StoredConnection, j: Obj, ref: RepoRef): RepoInfo {
  const origin = hostOf(conn.baseUrl)?.origin ?? 'https://github.com';
  const full = typeof j.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(j.full_name) ? j.full_name : `${ref.owner}/${ref.name}`;
  const perms = asObj(j.permissions);
  const owner = full.split('/')[0]!;
  const name = full.split('/')[1]!;
  return {
    ref: { owner, name, ...(j.id !== undefined ? { id: String(j.id) } : {}) },
    defaultBranch: typeof j.default_branch === 'string' && j.default_branch ? sanitizeLine(j.default_branch, 255) : 'main',
    // Rebuilt from the base URL, never copied from the response: no userinfo, no foreign host.
    cloneUrl: `${isDotcom(conn.baseUrl) ? 'https://github.com' : origin}/${full}.git`,
    htmlUrl: `${isDotcom(conn.baseUrl) ? 'https://github.com' : origin}/${full}`,
    private: j.private === true,
    ...(j.permissions ? { permissions: { pull: perms.pull === true, push: perms.push === true, admin: perms.admin === true } } : {}),
  };
}

export const githubAdapter: ProviderAdapter = {
  id: 'github',

  apiBase: githubApiBase,

  hostsFor(baseUrl) {
    if (isDotcom(baseUrl)) return ['api.github.com', 'github.com'];
    const h = hostOf(baseUrl);
    return h ? [h.host] : [];
  },

  clientOptions(conn) {
    return {
      apiBase: githubApiBase(conn),
      auth: { kind: 'bearer' },
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    };
  },

  parseRemote: parseGithubRemote,

  probe,

  repos: {
    async get(ctx, ref) {
      const c: AdapterCtx = { ...ctx, repo: ref };
      const { json } = await getJson(c, { path: repoPath(c) }, `The repository ${ref.owner}/${ref.name}`);
      return repoInfo(ctx.conn, asObj(json), ref);
    },
    async list(ctx, query) {
      const { items } = await paged<Obj>(ctx, {
        path: '/user/repos', query: { per_page: 100, sort: 'updated', affiliation: 'owner,collaborator,organization_member' },
      }, j => asArr(j).map(asObj), 'The repository list', 3);
      const q = query?.trim().toLowerCase();
      return items
        .filter(r => !q || String(r.full_name ?? '').toLowerCase().includes(q))
        .map(r => repoInfo(ctx.conn, r, { owner: '', name: '' }));
    },
  },

  pulls: {
    async find(ctx, head) {
      const r = repoOf(ctx);
      const { json } = await getJson(ctx, { path: `${repoPath(ctx)}/pulls`, query: { head: `${r.owner}:${head}`, state: 'open', per_page: 5 } }, 'The pull request list');
      const first = asArr(json).map(asObj).find(p => asObj(p.head).ref === head || p.head === undefined);
      return first && typeof first.number === 'number' ? fetchPull(ctx, String(first.number)) : undefined;
    },

    async create(ctx, input: NewPull) {
      const title = cleanTitle(input.title);
      const { head, overflow } = cleanBody(input.body, PULL_BODY_MAX);
      const res = await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/pulls`, audit: 'pr.open', ref: input.head,
        json: { title, head: input.head, base: input.base, body: head, draft: input.draft === true },
      }, 'opening the pull request', 'Pull requests: write');
      const pr = res.json as RawPull;
      // A fresh PR has no checks or reviews to fetch, and `mergeable` is still being computed.
      const pull = foldPull({ connection: ctx.conn.id, pr, runs: [], statuses: [], reviews: [] });
      return { pull, ...(overflow ? { overflow } : {}) };
    },

    async update(ctx, id, patch) {
      const n = num(id, 'pull request');
      const json: Obj = {};
      if (patch.title !== undefined) json.title = cleanTitle(patch.title);
      if (patch.body !== undefined) {
        const { head, overflow } = cleanBody(patch.body, PULL_BODY_MAX);
        json.body = overflow ? `${head}\n\n… (cut; the rest is in the first comment)` : head;
      }
      if (patch.state) json.state = patch.state;
      await write(ctx, { method: 'PATCH', path: `${repoPath(ctx)}/pulls/${n}`, json, audit: 'write', ref: id }, `Pull request #${n}`, 'Pull requests: write');
      return fetchPull(ctx, id);
    },

    async comment(ctx, id, markdown) {
      const n = num(id, 'pull request');
      const body = clipText(withoutAttribution(markdown), COMMENT_MAX);
      await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/issues/${n}/comments`, audit: 'write', ref: id,
        json: { body: body.overflow ? `${body.head}\n\n… (cut at ${COMMENT_MAX} characters)` : body.head },
      }, `Pull request #${n}`, 'Pull requests: write');
    },

    get: fetchPull,

    async comments(ctx, id) {
      const n = num(id, 'pull request');
      const base = repoPath(ctx);
      const convo = await paged<RawComment>(ctx, { path: `${base}/issues/${n}/comments`, query: { per_page: 100 } }, j => asArr(j) as RawComment[], `The comments of #${n}`, 3);
      const revs = await paged<RawReview>(ctx, { path: `${base}/pulls/${n}/reviews`, query: { per_page: 100 } }, j => asArr(j) as RawReview[], `The reviews of #${n}`, 3);
      const all: Comment[] = [
        ...convo.items.map(foldComment),
        ...revs.items.map(foldReviewComment).filter((c): c is Comment => !!c),
      ];
      // Newest last; a stable sort keeps API order for equal timestamps.
      return all.map((c, i) => ({ c, i })).sort((a, b) => (Date.parse(a.c.at) || 0) - (Date.parse(b.c.at) || 0) || a.i - b.i).map(x => x.c);
    },

    async merge(ctx, id, opts) {
      const n = num(id, 'pull request');
      const res = await call(ctx, {
        method: 'PUT', path: `${repoPath(ctx)}/pulls/${n}/merge`, audit: 'pr.merge', ref: id,
        // `sha` makes GitHub refuse if the head moved since it was reviewed; no admin bypass exists in this call.
        json: { merge_method: opts.method, sha: sha(opts.sha) },
      });
      if (res.status === 200) return { sha: typeof asObj(res.json).sha === 'string' ? String(asObj(res.json).sha) : '' };
      if (res.status === 405) throw new ConnectionError(`GitHub will not merge #${n} right now: ${ghMessage(res) || 'it is not mergeable.'}`, 'conflict', 405);
      if (res.status === 409) throw new ConnectionError(`#${n} was not merged because its branch changed after it was reviewed. Look at the new commits first.`, 'conflict', 409);
      throw failure(res, `Merging #${n}`, 'Pull requests: write (and Contents: write)');
    },
  },

  items: {
    async query(ctx, q: ItemQuery) {
      if (q.source === 'off') return { items: [], notModified: true };
      const base = repoPath(ctx);
      const state = q.state ?? 'open';
      const since = isoOrUndefined(q.since);
      if (q.source === 'query') {
        const text = sanitizeLine(q.value ?? '', 256).replace(/\brepo:\S+/gi, '');
        const qs = `repo:${repoName(ctx)} is:issue ${state === 'all' ? '' : `is:${state}`} ${since ? `updated:>=${since}` : ''} ${text}`.replace(/\s+/g, ' ').trim();
        const out = await paged<Obj>(ctx, { path: '/search/issues', query: { q: qs, per_page: 100, sort: 'updated', order: 'desc' } },
          j => asArr(asObj(j).items).map(asObj), 'The issue search', 3);
        const self = `/repos/${repoName(ctx)}`.toLowerCase();
        const items = out.items
          .filter(i => !i.pull_request && (typeof i.repository_url !== 'string' || i.repository_url.toLowerCase().endsWith(self)))
          .map(i => foldItem(i as unknown as RawIssue));
        return { items, notModified: out.notModified };
      }
      const query: Record<string, string | number> = { state, per_page: 100, sort: 'updated', direction: 'desc' };
      if (q.source === 'label') {
        if (!q.value?.trim()) throw new ConnectionError('Importing by label needs a label name.', 'config');
        query.labels = sanitizeLine(q.value, REMOTE_LIMITS.label);
      }
      if (q.source === 'assigned-to-me') {
        if (!q.me) throw new ConnectionError('Importing items assigned to you needs to know which account the token acts as; test the connection first.', 'config');
        query.assignee = q.me;
      }
      if (since) query.since = since;
      const out = await paged<RawIssue>(ctx, { path: `${base}/issues`, query },
        j => asArr(j) as RawIssue[], 'The issue list', 5);
      // The issues endpoint lists pull requests too; they are tasks' output, not work to import.
      return { items: out.items.filter(i => !i.pull_request).map(foldItem), notModified: out.notModified };
    },

    async get(ctx, id) { return foldItem(await readIssue(ctx, id)); },

    async create(ctx, input) {
      const title = cleanTitle(input.title);
      const body = cleanBody(input.body, ISSUE_BODY_MAX).head;
      const labels = (input.labels ?? []).map(l => sanitizeLine(l, 50)).filter(Boolean);
      const res = await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/issues`, audit: 'write', ref: 'new-issue',
        json: { title, body, ...(labels.length ? { labels } : {}) },
      }, 'creating the issue', 'Issues: write');
      return foldItem(res.json as RawIssue);
    },

    async update(ctx, id, patch, ifRev) {
      const n = num(id, 'issue');
      const current = await readIssue(ctx, id);
      if ((current.updated_at ?? '') !== ifRev) throw conflict(n, current.updated_at ?? '', ifRev);
      const json: Obj = {};
      if (patch.title !== undefined) json.title = cleanTitle(patch.title);
      if (patch.body !== undefined) json.body = cleanBody(patch.body, ISSUE_BODY_MAX).head;
      // GitHub replaces the whole label set on PATCH; the caller passes the set it wants.
      if (patch.labels) json.labels = patch.labels.map(l => sanitizeLine(l, 50)).filter(Boolean);
      if (patch.milestone !== undefined) json.milestone = patch.milestone === null ? null : num(patch.milestone, 'milestone');
      const res = await write(ctx, { method: 'PATCH', path: `${repoPath(ctx)}/issues/${n}`, json, audit: 'write', ref: id }, `Issue #${n}`, 'Issues: write');
      return foldItem(res.json as RawIssue);
    },

    async transition(ctx, id, to, ifRev) {
      const n = num(id, 'issue');
      const current = await readIssue(ctx, id);
      if ((current.updated_at ?? '') !== ifRev) throw conflict(n, current.updated_at ?? '', ifRev);
      const res = await write(ctx, {
        method: 'PATCH', path: `${repoPath(ctx)}/issues/${n}`, audit: 'write', ref: id,
        json: to === 'closed' ? { state: 'closed', state_reason: 'completed' } : { state: 'open', state_reason: 'reopened' },
      }, `Issue #${n}`, 'Issues: write');
      return foldItem(res.json as RawIssue);
    },

    async comment(ctx, id, markdown) {
      const n = num(id, 'issue');
      const body = clipText(withoutAttribution(markdown), COMMENT_MAX);
      await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/issues/${n}/comments`, audit: 'write', ref: id,
        json: { body: body.overflow ? `${body.head}\n\n… (cut at ${COMMENT_MAX} characters)` : body.head },
      }, `Issue #${n}`, 'Issues: write');
    },

    async addLabels(ctx, id, labels) {
      const n = num(id, 'issue');
      const clean = labels.map(l => sanitizeLine(l, 50)).filter(Boolean);
      if (!clean.length) return;
      await write(ctx, { method: 'POST', path: `${repoPath(ctx)}/issues/${n}/labels`, json: { labels: clean }, audit: 'write', ref: id }, `Issue #${n}`, 'Issues: write');
    },

    async removeLabel(ctx, id, label) {
      const n = num(id, 'issue');
      const res = await call(ctx, { method: 'DELETE', path: `${repoPath(ctx)}/issues/${n}/labels/${enc(sanitizeLine(label, 50))}`, audit: 'write', ref: id });
      // 404 on a label that is not on the issue: already the state the caller wanted.
      if (res.status === 404 && /label does not exist/i.test(ghMessage(res))) return;
      if (res.status < 200 || res.status >= 300) throw failure(res, `Issue #${n}`, 'Issues: write');
    },
  },

  iterations: {
    async members(ctx) {
      const r = repoOf(ctx);
      const res = await call(ctx, {
        method: 'POST', path: githubGraphqlUrl(ctx.conn), json: { query: MEMBERS_QUERY, variables: { owner: r.owner, name: r.name } },
        conditional: false, audit: 'use', ref: 'graphql',
      });
      const j = asObj(res.json);
      const projects = asObj(asObj(asObj(j.data).repository).projectsV2);
      // No Projects v2 on this server or repository: there is nothing to overlay, which is an answer, not a failure.
      if (res.status === 200 && !asArr(j.errors).length && !projects.nodes) return new Map();
      if (res.status !== 200 || asArr(j.errors).length) {
        throw new ConnectionError('The Projects boards could not be read (the token needs Projects: read), so sprint membership was left as it is.', 'http', res.status);
      }
      const out = new Map<string, { iteration?: string; points?: number }>();
      for (const p of asArr(projects.nodes)) {
        for (const n of asArr(asObj(asObj(asObj(p).items)).nodes)) {
          const item = asObj(n);
          const content = asObj(item.content);
          if (content.__typename !== 'Issue' || typeof content.number !== 'number') continue;
          const it = asObj(item.iteration);
          const iteration = it.__typename === 'ProjectV2ItemFieldIterationValue' && typeof it.iterationId === 'string' ? it.iterationId : undefined;
          const sized = [asObj(item.estimate), asObj(item.points)].find(f => f.__typename === 'ProjectV2ItemFieldNumberValue' && typeof f.number === 'number');
          const key = String(content.number);
          const prev = out.get(key) ?? {};
          // The first board that places or sizes an issue wins; a later board does not move it.
          const placed = prev.iteration ?? iteration;
          const points = prev.points ?? (sized ? (sized.number as number) : undefined);
          out.set(key, { ...(placed !== undefined ? { iteration: placed } : {}), ...(points !== undefined ? { points } : {}) });
        }
      }
      return out;
    },

    async list(ctx) {
      const base = repoPath(ctx);
      const out: Iteration[] = [];
      const native = await nativeIterations(ctx);
      out.push(...native.iterations);
      const ms = await paged<Obj>(ctx, { path: `${base}/milestones`, query: { state: 'all', per_page: 100, sort: 'due_on', direction: 'asc' } },
        j => asArr(j).map(asObj), 'The milestone list', 3);
      for (const m of ms.items) {
        if (typeof m.number !== 'number') continue;
        const url = safeUrl(m.html_url);
        const due = typeof m.due_on === 'string' ? m.due_on : undefined;
        out.push({
          id: String(m.number), title: sanitizeLine(m.title, REMOTE_LIMITS.title), kind: 'milestone',
          state: m.state === 'closed' ? 'closed' : 'open',
          ...(due ? { end: due } : {}), ...(url ? { url } : {}),
          ...(typeof m.open_issues === 'number' ? { openItems: m.open_issues } : {}),
          ...(typeof m.closed_issues === 'number' ? { closedItems: m.closed_issues } : {}),
        });
      }
      return out;
    },

    async assign(ctx, itemId, iterationId) {
      const n = num(itemId, 'issue');
      if (!/^\d{1,9}$/.test(iterationId)) {
        throw new ConnectionError('Only milestones can be assigned from here; a Projects v2 iteration is set on the project board.', 'config');
      }
      await write(ctx, { method: 'PATCH', path: `${repoPath(ctx)}/issues/${n}`, json: { milestone: Number(iterationId) }, audit: 'write', ref: itemId }, `Issue #${n}`, 'Issues: write');
    },

    async create(ctx, input) {
      const due = isoOrUndefined(input.end);
      const res = await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/milestones`, audit: 'write', ref: 'new-milestone',
        // Milestones have a due date only; a start date has nowhere to go.
        json: { title: cleanTitle(input.title, 250), ...(due ? { due_on: due } : {}) },
      }, 'creating the milestone', 'Issues: write');
      const m = asObj(res.json);
      const url = safeUrl(m.html_url);
      return {
        id: String(m.number ?? ''), title: sanitizeLine(m.title, REMOTE_LIMITS.title), kind: 'milestone' as const, state: 'open' as const,
        ...(typeof m.due_on === 'string' ? { end: m.due_on } : {}), ...(url ? { url } : {}),
      };
    },
  },

  checks: {
    async forCommit(ctx, commit) {
      const s = sha(commit);
      const base = repoPath(ctx);
      const runs = await paged<RawCheckRun>(ctx, { path: `${base}/commits/${s}/check-runs`, query: { per_page: 100 } },
        j => asArr(asObj(j).check_runs) as RawCheckRun[], 'The check runs', 3);
      const st = await getJson(ctx, { path: `${base}/commits/${s}/status`, query: { per_page: 100 } }, 'The commit status');
      const statuses = asArr(asObj(st.json).statuses) as RawStatus[];
      const out: RemoteCheck[] = [...runs.items.map(foldCheckRun), ...statuses.map(foldStatus)];
      return out;
    },
  },

  protection: {
    read: readProtection,
  },
};
