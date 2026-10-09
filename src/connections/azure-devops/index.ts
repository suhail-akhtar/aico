/**
 * The Azure DevOps adapter: Services (`dev.azure.com/<org>`, legacy `<org>.visualstudio.com`) and
 * Server (an on-premises collection), REST only, no SDK (ADR 0039; azure-devops-node-api is a
 * dependency tree for ~25 endpoints). PAT auth: Basic with an empty user name.
 *
 * WHY it looks the way it does, each point a failure it prevents:
 *
 *  - **API version negotiated, not assumed.** Services is `7.1`. A Server answers `400` to a
 *    version it does not know, so the probe walks 7.1, 7.0, 6.0, 5.1 and keeps the highest that
 *    works; the choice is written into the probe's `version` ("Azure DevOps Server (REST 7.0)")
 *    and read back by `clientOptions`, which sends it as `Accept: application/json;api-version=X`
 *    on every request. An older Server therefore LOSES features (a preview API it lacks is a
 *    warning and an absent chip) instead of failing the connection.
 *  - **A dead PAT is not a 401.** Azure DevOps answers `203` with an HTML sign-in page for an
 *    expired token; the client's `authFailure` hook treats it as the 401 it is, so the page says
 *    "Sign in again" rather than failing to parse HTML.
 *  - **Merge only through policy.** `canMerge` is computed from the pull request's policy
 *    evaluations (fold.ts) and merging passes the head commit that was reviewed,
 *    `bypassPolicy: false` and `deleteSourceBranch: false` explicitly. There is no admin bypass here.
 *  - **The 4000-character description limit** is the probed `bodyMax`: the evidence packet is clipped
 *    at it and the rest is returned for landing.ts to post as a thread comment. AICO's own comments are
 *    posted as RESOLVED threads, so they can never trip a "comments must be resolved" policy.
 *  - **Humans win conflicts.** Every item write re-reads the item, compares its `rev` with the one
 *    the caller pulled, and sends a JSON-Patch `test /rev` operation so even the window between the
 *    read and the write is closed by the server. A mismatch is a `conflict` and nothing is written.
 *  - **State by category.** `transitionCategory` finds the work item type's own state for
 *    Proposed / InProgress / Resolved / Completed (Active, Committed, Doing, Closed, Done ...) at the
 *    moment of writing; no state is ever matched by name (shared/connections/process.ts).
 *  - **WIQL is built, not concatenated** (wiql.ts) and every returned item is checked to belong to
 *    the mapped project. Descriptions are HTML and become sanitised text (fold.ts).
 *  - **Failures say what to do.** Messages name the permission and never include a header.
 *
 * What it does not do: choose what to sync or when to merge (sync.ts, landing.ts); create or delete
 * anything on the remote except what a person's click asks (pull requests, comments, tags, states,
 * an iteration assignment, a work item link); edit policies; run or queue builds; use Boards beyond
 * items and iterations. Unverified against a live service: every shape here follows the documented
 * REST reference for api-version 7.1 / 7.0 / 6.0 and the hand-written fixtures; see ADR 0039.
 *
 * @module connections/azure-devops
 */

import {
  CATEGORY_STATE_MAP, detectProcess, isClosedCategory, pickState, POINTS_FIELDS,
  type StateCategory, type TypeStates,
} from '../../../shared/connections/process.js';
import type { Capabilities, ProbeResult, PullState, RemoteCheck, RepoRef } from '../../../shared/connections/types.js';
import {
  noCapabilities,
  type AdapterCtx, type Comment, type ItemQuery, type Iteration, type NewPull, type ProtectionInfo, type ProviderAdapter,
  type RemoteItem, type RepoInfo, type WriteResult,
} from '../adapter.js';
import { ConnectionError, type ConnRequest, type ConnResponse } from '../http.js';
import { clipText, safeUrl } from '../github/fold.js';
import { REMOTE_LIMITS, sanitizeLine, sanitizeRemoteText, withoutAttribution } from '../sanitize.js';
import type { StoredConnection } from '../types.js';
import {
  F, ITEM_FIELDS, categoryOf, foldBuildResult, foldItem, foldNodes, foldPull, foldTeamIteration, foldThreads, htmlToMarkdown, indexStates,
  joinTags, latestStatuses, markdownToHtml, policyKind, splitTags,
  type RawBuild, type RawEvaluation, type RawNode, type RawPr, type RawStatus, type RawTeamIteration, type RawThread, type RawWorkItem, type StatesIndex,
} from './fold.js';
import { FULL_ACCESS_NOTE, neededScopes } from './scopes.js';
import {
  cloneUrl, hostsFor, parseBase, parseRemote, suggestFromRemote, validateRepo, type AzureBase,
} from './urls.js';
import { batches, buildWiql } from './wiql.js';

/** Azure DevOps rejects a pull request description over 4000 characters. */
export const PULL_BODY_MAX = 4000;
const COMMENT_MAX = 150_000;
const HISTORY_MAX = 30_000;
/** REST versions tried, highest first, when the server is not Services. */
export const VERSIONS: readonly string[] = ['7.1', '7.0', '6.0', '5.1'];
/** At most this many work items per sync (WIQL has no offset; a larger backlog is imported in recency order). */
const MAX_IMPORT = 1000;
const TYPES_TTL_MS = 5 * 60_000;

interface Obj { [k: string]: unknown }
const asObj = (x: unknown): Obj => (x && typeof x === 'object' ? x as Obj : {});
const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const enc = encodeURIComponent;

// ── base URL, version, client options ─────────────────────────────────────

function baseOf(conn: Pick<StoredConnection, 'baseUrl'>): AzureBase {
  const b = parseBase(conn.baseUrl);
  if (!b) throw new ConnectionError(`"${conn.baseUrl}" is not an Azure DevOps address. Use https://dev.azure.com/<organization>, or your server's collection URL.`, 'config');
  return b;
}

export function azureApiBase(conn: Pick<StoredConnection, 'baseUrl'>): string { return baseOf(conn).apiBase; }

/** The REST version this connection speaks: 7.1 on Services, what the last probe negotiated on a Server (6.0 until one has run). */
export function restVersion(conn: Pick<StoredConnection, 'baseUrl' | 'probe'>): string {
  const b = parseBase(conn.baseUrl);
  if (!b || b.kind !== 'server') return '7.1';
  const m = /REST (\d+\.\d+)/.exec(conn.probe?.version ?? '');
  return m ? m[1]! : '6.0';
}

const accept = (version: string, preview = false): string => `application/json;api-version=${version}${preview ? '-preview.1' : ''}`;

/** Azure DevOps shows a dead PAT as 203 (or a 2xx HTML page), not as 401. */
export function authFailure(status: number, _headers: Record<string, string>, contentType: string): boolean {
  return status === 203 || (status >= 200 && status < 300 && /text\/html/i.test(contentType));
}

// ── requests ──────────────────────────────────────────────────────────────

function repoOf(ctx: AdapterCtx): RepoRef {
  if (!ctx.repo) throw new ConnectionError('This operation needs a repository: map the project to an Azure DevOps repository first.', 'config');
  return ctx.repo;
}
const projectOf = (ctx: AdapterCtx): string => repoOf(ctx).owner;
const repoPath = (ctx: AdapterCtx): string => { const r = repoOf(ctx); return `/${enc(r.owner)}/_apis/git/repositories/${enc(r.name)}`; };

function num(id: string, what: string): number {
  if (!/^\d{1,10}$/.test(id)) throw new ConnectionError(`"${id.slice(0, 40)}" is not an Azure DevOps ${what} id.`, 'config');
  return Number(id);
}
function sha(s: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(s)) throw new ConnectionError('That is not a commit id.', 'config');
  return s;
}
function branchName(b: string): string {
  if (!b || b.length > 200 || /[\u0000-\u001f\s~^:?*[\\]|\.\./.test(b) || b.startsWith('-') || b.startsWith('/')) throw new ConnectionError(`"${b.slice(0, 40)}" is not a usable branch name.`, 'config');
  return b;
}

function call(ctx: AdapterCtx, req: ConnRequest): Promise<ConnResponse> {
  return ctx.client.request({
    ...req,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.project ? { project: ctx.project } : {}),
  });
}

/** A request pinned to a REST version (the probe, before the connection records one). */
function callV(ctx: AdapterCtx, req: ConnRequest, version: string, preview = false): Promise<ConnResponse> {
  return call(ctx, { ...req, headers: { ...(req.headers ?? {}), Accept: accept(version, preview) } });
}

/** Azure DevOps' own words for a failure, sanitised and short. */
function azMessage(res: ConnResponse): string {
  const j = asObj(res.json);
  return sanitizeLine(typeof j.message === 'string' ? j.message : '', 260);
}

function failure(res: ConnResponse, what: string, needs?: string): ConnectionError {
  const msg = azMessage(res);
  const s = res.status;
  if (s === 404) return new ConnectionError(`${what} was not found, or the token cannot see it.${needs ? ` (Changing it needs ${needs}.)` : ''}`, 'not-found', 404);
  if (s === 401 || s === 403) {
    return new ConnectionError(needs ? `The token lacks permission for ${what}: it needs ${needs}.${msg ? ` Azure DevOps says: ${msg}` : ''}` : `Azure DevOps refused access to ${what} (${s}).${msg ? ` ${msg}` : ''}`, 'http', s);
  }
  if (s === 409 || s === 412) return new ConnectionError(`${what}: ${msg || 'the request conflicts with the current state.'}`, 'conflict', s);
  if (s === 400) return new ConnectionError(`Azure DevOps rejected ${what}: ${msg || 'the request was not valid.'}`, 'http', 400);
  return new ConnectionError(`Azure DevOps answered ${s} for ${what}.${msg ? ` ${msg}` : ''}`, 'http', s);
}

async function getJson(ctx: AdapterCtx, req: ConnRequest, what: string): Promise<unknown> {
  const res = await call(ctx, { conditional: false, ...req });
  if (res.status < 200 || res.status >= 300) throw failure(res, what);
  return res.json;
}

async function write(ctx: AdapterCtx, req: ConnRequest, what: string, needs: string): Promise<ConnResponse> {
  const res = await call(ctx, req);
  if (res.status < 200 || res.status >= 300) throw failure(res, what, needs);
  return res;
}

/** For optional reads: a 401/403/404 means "this token or server cannot", anything else is a real failure. */
function optional(e: unknown): undefined {
  if (e instanceof ConnectionError && (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 400)) return undefined;
  throw e;
}

function cleanTitle(t: string, max = 400): string {
  const out = withoutAttribution(t).replace(/\s+/g, ' ').trim().slice(0, max);
  if (!out) throw new ConnectionError('A title is required.', 'config');
  return out;
}

// ── work item types (states by category), cached briefly ──────────────────

interface TypesInfo { at: number; types: TypeStates[]; index: StatesIndex; closedStates: string[]; names: string[] }
const typesCache = new Map<string, TypesInfo>();
export function resetAzureCachesForTest(): void { typesCache.clear(); }

async function loadTypes(ctx: AdapterCtx): Promise<TypesInfo | undefined> {
  const project = projectOf(ctx);
  const key = `${ctx.conn.id}|${project}`;
  const hit = typesCache.get(key);
  if (hit && Date.now() - hit.at < TYPES_TTL_MS) return hit;
  let json: unknown;
  try { json = await getJson(ctx, { path: `/${enc(project)}/_apis/wit/workitemtypes` }, 'The work item types'); } catch (e) { optional(e); return undefined; }
  const types: TypeStates[] = [];
  for (const raw of asArr(asObj(json).value)) {
    const t = asObj(raw);
    if (typeof t.name !== 'string' || t.isDisabled === true) continue;
    let states = asArr(t.states).map(asObj);
    if (states.length === 0) {
      // An older server lists types without their states: ask for them type by type (bounded).
      if (types.length >= 24) continue;
      const s = await getJson(ctx, { path: `/${enc(project)}/_apis/wit/workitemtypes/${enc(t.name)}/states` }, `The states of ${t.name}`).catch(optional);
      states = asArr(asObj(s).value).map(asObj);
    }
    types.push({
      name: sanitizeLine(t.name, 60),
      states: states.filter(s => typeof s.name === 'string').map(s => ({ name: sanitizeLine(s.name, 60), category: categoryOfRaw(s.category) })),
    });
  }
  if (types.length === 0) return undefined;
  const closed = new Set<string>();
  for (const t of types) for (const s of t.states) if (isClosedCategory(s.category)) closed.add(s.name);
  const info: TypesInfo = { at: Date.now(), types, index: indexStates(types), closedStates: [...closed], names: types.map(t => t.name) };
  typesCache.set(key, info);
  return info;
}

function categoryOfRaw(raw: unknown): StateCategory {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  return s === 'inprogress' ? 'inprogress' : s === 'resolved' ? 'resolved' : s === 'completed' ? 'completed' : s === 'removed' ? 'removed' : 'proposed';
}

// ── repositories ──────────────────────────────────────────────────────────

function repoInfo(conn: StoredConnection, j: Obj, fallback?: RepoRef): RepoInfo {
  const base = baseOf(conn);
  const project = asObj(j.project);
  const owner = sanitizeLine(project.name, 128) || fallback?.owner || '';
  const name = sanitizeLine(j.name, 128) || fallback?.name || '';
  const ref: RepoRef = { owner, name, ...(typeof j.id === 'string' ? { id: j.id } : {}) };
  const def = typeof j.defaultBranch === 'string' ? j.defaultBranch.replace(/^refs\/heads\//, '') : '';
  return {
    ref,
    defaultBranch: def ? sanitizeLine(def, 255) : 'main',
    // Rebuilt from the base URL, never copied from the response: no `<org>@` user-info, no foreign host.
    cloneUrl: cloneUrl(base, ref),
    htmlUrl: cloneUrl(base, ref),
    private: project.visibility !== 'public',
  };
}

async function readRepo(ctx: AdapterCtx, ref: RepoRef): Promise<Obj> {
  const c: AdapterCtx = { ...ctx, repo: ref };
  const j = await getJson(c, { path: repoPath(c) }, `The repository ${ref.owner}/${ref.name}`);
  const o = asObj(j);
  if (o.isDisabled === true) throw new ConnectionError(`The repository ${ref.owner}/${ref.name} is disabled on Azure DevOps.`, 'not-found', 404);
  return o;
}

// ── policies and protection ───────────────────────────────────────────────

type ScopeList = Array<{ refName?: string; matchKind?: string; repositoryId?: string | null }> | undefined;

function scopeApplies(scope: ScopeList, repoId: string | undefined, branch: string): boolean {
  if (!scope || scope.length === 0) return true;
  const ref = `refs/heads/${branch}`;
  return scope.some(s => {
    if (s.repositoryId && repoId && s.repositoryId.toLowerCase() !== repoId.toLowerCase()) return false;
    if (!s.refName) return true; // a policy for every branch of the repository (or project)
    return (s.matchKind ?? 'Exact').toLowerCase() === 'prefix' ? ref.startsWith(s.refName) : s.refName === ref;
  });
}

async function readProtection(ctx: AdapterCtx, branch: string): Promise<ProtectionInfo> {
  const b = branchName(branch);
  const repo = await readRepo(ctx, repoOf(ctx)).catch(e => { if (e instanceof ConnectionError && (e.status === 401 || e.status === 403)) return undefined; throw e; });
  const repoId = typeof repo?.id === 'string' ? repo.id : undefined;
  const project = projectOf(ctx);
  const res = await call(ctx, {
    path: `/${enc(project)}/_apis/policy/configurations`,
    query: { ...(repoId ? { repositoryId: repoId } : {}), refName: `refs/heads/${b}` }, conditional: false,
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) return { protected: false, unreadable: 'needs Code (read) and policy access' };
  if (res.status < 200 || res.status >= 300) throw failure(res, `Branch policies for ${b}`);
  const configs = asArr(asObj(res.json).value).map(asObj).filter(c => c.isEnabled !== false && c.isBlocking !== false)
    .filter(c => scopeApplies(asObj(c.settings).scope as ScopeList, repoId, b));
  if (configs.length === 0) return { protected: false };
  let reviews = 0;
  const checks: string[] = [];
  for (const c of configs) {
    const kind = policyKind(c as RawEvaluation['configuration']);
    const s = asObj(c.settings);
    if (kind === 'min-reviewers') reviews = Math.max(reviews, typeof s.minimumApproverCount === 'number' ? s.minimumApproverCount : 1);
    else if (kind === 'build' || kind === 'status') checks.push(sanitizeLine(s.displayName || asObj(c.type).displayName || 'Build validation', REMOTE_LIMITS.title));
  }
  return { protected: true, requiredReviews: reviews, requiredChecks: checks };
}

// ── pull requests ─────────────────────────────────────────────────────────

async function fetchRawPull(ctx: AdapterCtx, n: number): Promise<RawPr> {
  return await getJson(ctx, { path: `${repoPath(ctx)}/pullrequests/${n}` }, `Pull request #${n}`) as RawPr;
}

async function fetchPull(ctx: AdapterCtx, id: string): Promise<PullState> {
  const n = num(id, 'pull request');
  const pr = await fetchRawPull(ctx, n);
  const project = pr.repository?.project?.name ?? projectOf(ctx);
  const projectId = pr.repository?.project?.id;
  const version = restVersion(ctx.conn);
  // Policy evaluations are the truth about mergeability. A token or server without them leaves the answer "unknown".
  let evaluations: RawEvaluation[] | undefined;
  if (projectId) {
    const res = await callV(ctx, {
      path: `/${enc(project)}/_apis/policy/evaluations`, query: { artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${n}` }, conditional: false,
    }, version, true);
    if (res.status === 200) evaluations = asArr(asObj(res.json).value) as RawEvaluation[];
    else if (![400, 401, 403, 404].includes(res.status)) throw failure(res, `The policies of #${n}`);
  }
  const st = await call(ctx, { path: `${repoPath(ctx)}/pullrequests/${n}/statuses`, conditional: false });
  let statuses: RawStatus[] = [];
  if (st.status === 200) statuses = asArr(asObj(st.json).value) as RawStatus[];
  else if (![400, 401, 403, 404].includes(st.status)) throw failure(st, `The statuses of #${n}`);
  let builds: RawBuild[] | undefined;
  if (!evaluations) {
    const b = await call(ctx, { path: `/${enc(project)}/_apis/build/builds`, query: { branchName: `refs/pull/${n}/merge`, queryOrder: 'queueTimeDescending', $top: 10 }, conditional: false });
    if (b.status === 200) builds = latestBuilds(asArr(asObj(b.json).value) as RawBuild[]);
  }
  return foldPull({ connection: ctx.conn.id, base: baseOf(ctx.conn), repo: repoOf(ctx), pr, evaluations, statuses, builds });
}

/** One build per definition, the newest: a PR queues a fresh build per push and the old ones stay listed. */
function latestBuilds(list: RawBuild[]): RawBuild[] {
  const seen = new Set<string>();
  const out: RawBuild[] = [];
  for (const b of list) {
    const k = b.definition?.name ?? String(b.id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

const MERGE_STRATEGY = { merge: 'noFastForward', squash: 'squash', rebase: 'rebase' } as const;

async function postThread(ctx: AdapterCtx, n: number, markdown: string, ref: string): Promise<void> {
  const body = clipText(withoutAttribution(markdown), COMMENT_MAX);
  const content = body.overflow ? `${body.head}\n\n… (cut at ${COMMENT_MAX} characters)` : body.head;
  // Status 4 = closed: a comment from AICO is information, and an ACTIVE thread would block a "resolve all comments" policy.
  await write(ctx, {
    method: 'POST', path: `${repoPath(ctx)}/pullrequests/${n}/threads`, audit: 'write', ref,
    json: { comments: [{ parentCommentId: 0, content, commentType: 1 }], status: 4 },
  }, `Pull request #${n}`, 'Code (read and write)');
}

// ── work items ────────────────────────────────────────────────────────────

const ITEM_QUERY_FIELDS = ITEM_FIELDS.join(',');

async function readRawItem(ctx: AdapterCtx, id: string, fields: string = ITEM_QUERY_FIELDS): Promise<RawWorkItem> {
  const n = num(id, 'work item');
  const project = projectOf(ctx);
  const res = await call(ctx, { path: `/${enc(project)}/_apis/wit/workitems/${n}`, query: { fields }, conditional: false });
  if (res.status < 200 || res.status >= 300) throw failure(res, `Work item ${n}`);
  const raw = res.json as RawWorkItem;
  // The work item API is organization-wide; an id from another project is not this mapping's to read or write.
  const p = asObj(raw.fields)[F.project];
  if (typeof p === 'string' && p.toLowerCase() !== project.toLowerCase()) {
    throw new ConnectionError(`Work item ${n} belongs to another project (${sanitizeLine(p, 60)}), not ${project}.`, 'not-found', 404);
  }
  return raw;
}

function conflict(n: number, current: string, ifRev: string): ConnectionError {
  return new ConnectionError(
    `Work item ${n} changed on Azure DevOps (now revision ${current || 'unknown'}) after AICO last read it (${ifRev || 'never'}). It was left as it is; pull it again and decide.`,
    'conflict', 409);
}

/** True when a failed PATCH is Azure DevOps refusing the `test /rev` operation (someone edited in between). */
function isRevMismatch(res: ConnResponse): boolean {
  if (res.status === 409 || res.status === 412) return true;
  return res.status === 400 && /TF26071|changed by someone else|\brev\b.*(?:mismatch|does not match|not equal)/i.test(azMessage(res));
}

type PatchOp = { op: 'add' | 'replace' | 'remove' | 'test'; path: string; value?: unknown };

async function patchItem(ctx: AdapterCtx, id: string, ops: PatchOp[], needs: string, audit = 'write'): Promise<RawWorkItem> {
  const n = num(id, 'work item');
  const res = await call(ctx, {
    method: 'PATCH', path: `/${enc(projectOf(ctx))}/_apis/wit/workitems/${n}`, json: ops, audit, ref: id,
    headers: { 'Content-Type': 'application/json-patch+json' },
  });
  if (res.status < 200 || res.status >= 300) {
    if (isRevMismatch(res)) throw conflict(n, '', 'the revision you pulled');
    throw failure(res, `Work item ${n}`, needs);
  }
  return res.json as RawWorkItem;
}

const REV_TEST = (rev: string): PatchOp => ({ op: 'test', path: '/rev', value: Number(rev) });

async function foldWith(ctx: AdapterCtx, raw: RawWorkItem): Promise<RemoteItem> {
  const t = await loadTypes(ctx).catch(optional);
  return foldItem(raw, baseOf(ctx.conn), t?.index);
}

/** Read-modify-write the tags with the revision just read, retrying when someone else wrote between. */
async function editTags(ctx: AdapterCtx, id: string, change: (tags: string[]) => string[] | undefined): Promise<WriteResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await readRawItem(ctx, id, `${F.tags},${F.project}`);
    const tags = splitTags(asObj(cur.fields)[F.tags]);
    const next = change(tags);
    if (!next) return { rev: String(cur.rev ?? '') };
    try {
      const out = await patchItem(ctx, id, [REV_TEST(String(cur.rev ?? 0)), { op: 'add', path: `/fields/${F.tags}`, value: joinTags(next) }], 'Work Items (read and write)');
      return { rev: String(out.rev ?? '') };
    } catch (e) {
      if (e instanceof ConnectionError && e.code === 'conflict' && attempt < 2) continue;
      throw e;
    }
  }
  return undefined;
}

async function pointsFieldFor(ctx: AdapterCtx, raw: RawWorkItem): Promise<string | undefined> {
  const f = asObj(raw.fields);
  const present = POINTS_FIELDS.find(n => typeof f[n] === 'number');
  if (present) return present;
  const type = typeof f[F.type] === 'string' ? f[F.type] as string : '';
  if (!type) return undefined;
  const res = await call(ctx, { path: `/${enc(projectOf(ctx))}/_apis/wit/workitemtypes/${enc(type)}`, query: { $expand: 'fields' }, conditional: false });
  if (res.status !== 200) return undefined;
  const names = new Set(asArr(asObj(res.json).fields).map(x => asObj(x).referenceName).filter((x): x is string => typeof x === 'string'));
  return POINTS_FIELDS.find(n => names.has(n));
}

// ── iterations ────────────────────────────────────────────────────────────

type Send = (req: ConnRequest) => Promise<ConnResponse>;

async function defaultTeam(ctx: AdapterCtx, send: Send = r => call(ctx, r)): Promise<string> {
  const project = projectOf(ctx);
  const res = await send({ path: `/_apis/projects/${enc(project)}`, conditional: false });
  const team = res.status === 200 ? asObj(asObj(res.json).defaultTeam).name : undefined;
  return typeof team === 'string' && team ? team : `${project} Team`;
}

async function listIterations(ctx: AdapterCtx, send: Send = r => call(ctx, r)): Promise<Iteration[]> {
  const project = projectOf(ctx);
  const team = await defaultTeam(ctx, send);
  const res = await send({ path: `/${enc(project)}/${enc(team)}/_apis/work/teamsettings/iterations`, conditional: false });
  let out: Iteration[] = [];
  let denied = 0;
  if (res.status === 200) out = asArr(asObj(res.json).value).map(x => foldTeamIteration(asObj(x) as never)).filter((x): x is Iteration => !!x);
  else if (res.status === 401 || res.status === 403) denied++;
  else if (![400, 404].includes(res.status)) throw failure(res, 'The team iterations');
  if (out.length === 0) {
    // The team has not picked any iteration: the project's own iteration tree still has the sprints.
    const nodes = await send({ path: `/${enc(project)}/_apis/wit/classificationnodes/iterations`, query: { $depth: 6 }, conditional: false });
    if (nodes.status === 200) out = foldNodes(nodes.json as RawNode, new Date().toISOString().slice(0, 10));
    else if (nodes.status === 401 || nodes.status === 403) denied++;
    else if (![400, 404].includes(nodes.status)) throw failure(nodes, 'The iterations');
    // Neither place could be read: that is a permission problem, not a project without sprints.
    if (out.length === 0 && denied === 2) throw new ConnectionError('The token cannot read the iterations of this project (it needs Project and Team: read).', 'http', 403);
  }
  return out.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '') || a.title.localeCompare(b.title));
}

// ── probe ─────────────────────────────────────────────────────────────────

/** Walk the supported REST versions, highest first, until the server accepts one. */
async function negotiate(ctx: AdapterCtx): Promise<string> {
  for (const v of VERSIONS) {
    const res = await callV(ctx, { path: '/_apis/projects', query: { $top: 1 }, conditional: false }, v);
    if (res.status === 200) return v;
    if (res.status === 400 && /version|api-version/i.test(azMessage(res) + res.text.slice(0, 400))) continue;
    throw failure(res, 'The list of projects');
  }
  throw new ConnectionError('This Azure DevOps Server does not support REST 5.1 or later. Azure DevOps Server 2019 or newer is required.', 'config');
}

async function probe(ctx: AdapterCtx): Promise<ProbeResult> {
  const warnings: string[] = [];
  const base = baseOf(ctx.conn);
  const cd = await call(ctx, { path: '/_apis/connectionData', headers: { Accept: 'application/json' }, conditional: false });
  if (cd.status !== 200) throw failure(cd, 'The account behind this token');
  const cdj = asObj(cd.json);
  const who = asObj(cdj.authenticatedUser);
  const email = asObj(asObj(who.properties).Account).$value;
  const name = sanitizeLine(who.providerDisplayName || who.customDisplayName, 80);
  const user = name && typeof email === 'string' && email ? sanitizeLine(`${name} (${email})`, 120) : name || sanitizeLine(email, 120) || 'unknown account';
  if (!who.id || who.id === '00000000-0000-0000-0000-000000000000') {
    warnings.push('Azure DevOps sees this request as anonymous: the token may be missing, expired, or limited to another organization.');
  }

  const onPrem = base.kind === 'server' || cdj.deploymentType === 'onPremises';
  let v = '7.1';
  if (onPrem) v = await negotiate(ctx);
  const version = onPrem ? `Azure DevOps Server (REST ${v})` : 'Azure DevOps Services (REST 7.1)';
  if (onPrem && v !== '7.1') warnings.push(`This server speaks REST ${v}, not 7.1: newer features (some policy and iteration details) may be absent.`);
  const V = (req: ConnRequest, preview = false): Promise<ConnResponse> => callV(ctx, req, v, preview);

  const caps: Capabilities = noCapabilities();
  caps.pulls.bodyMax = PULL_BODY_MAX;
  caps.items.estimate = 'field';
  caps.checks.logsUrl = true;

  const projects = await V({ path: '/_apis/projects', query: { $top: 1 }, conditional: false });
  const repos = await V({ path: '/_apis/git/repositories', conditional: false });
  caps.repos = repos.status === 200;
  if (projects.status !== 200) warnings.push('Projects are unreadable with this token (it needs Project and Team: read).');
  if (repos.status !== 200) warnings.push('Repositories are unreadable with this token (it needs Code: read and write).');

  if (ctx.repo) await probeRepo(ctx, V, v, caps, warnings);
  else {
    if (caps.repos) caps.pulls = { create: true, comment: true, merge: true, draft: Number(v) >= 6, bodyMax: PULL_BODY_MAX };
    const wi = await V({ method: 'POST', path: '/_apis/wit/wiql', query: { $top: 1 }, json: { query: 'SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 0' }, audit: 'use', conditional: false });
    if (wi.status === 200) caps.items = { ...caps.items, query: true, create: true, transition: true, comment: true };
    else warnings.push('Work items are unreadable with this token (it needs Work Items: read and write).');
    // Builds can be listed across the organization; sprints belong to a project, so a readable project list is all that can be said before one is mapped.
    const orgBuilds = await V({ path: '/_apis/build/builds', query: { $top: 1 }, conditional: false });
    if (orgBuilds.status === 200) caps.checks.read = true;
    if (projects.status === 200) caps.iterations = 'native';
    warnings.push('Map a project and a repository and test again to see what this token can do there (Azure DevOps does not list a token\'s permissions).');
  }

  // A Full access token reads service hooks; a least-privilege one gets 401/403. A hint, not a verdict.
  const hooks = await V({ path: '/_apis/hooks/subscriptions', conditional: false, maxBytes: 64 * 1024 }).catch(() => undefined);
  const extra = hooks && hooks.status === 200 ? [FULL_ACCESS_NOTE] : [];

  return {
    at: new Date().toISOString(),
    user,
    version,
    capabilities: caps,
    scopes: { found: [], needed: neededScopes(), missing: [], extra, reported: false },
    warnings,
  };
}

async function probeRepo(ctx: AdapterCtx, V: (r: ConnRequest, preview?: boolean) => Promise<ConnResponse>, v: string, caps: Capabilities, warnings: string[]): Promise<void> {
  const r = repoOf(ctx);
  const rp = repoPath(ctx);
  const project = r.owner;
  const name = `${r.owner}/${r.name}`;
  const repo = await V({ path: rp, conditional: false });
  if (repo.status === 404 || repo.status === 403 || repo.status === 401) {
    warnings.push(`The repository ${name} was not found, or this token cannot see it.`);
    return;
  }
  if (repo.status !== 200) throw failure(repo, `The repository ${name}`);
  const rj = asObj(repo.json);
  if (rj.isDisabled === true) { warnings.push(`The repository ${name} is disabled on Azure DevOps.`); return; }
  const repoId = typeof rj.id === 'string' ? rj.id : undefined;
  const branch = typeof rj.defaultBranch === 'string' ? rj.defaultBranch.replace(/^refs\/heads\//, '') : 'main';

  const pulls = await V({ path: `${rp}/pullrequests`, query: { 'searchCriteria.status': 'all', $top: 1 }, conditional: false });
  if (pulls.status === 200) caps.pulls = { create: true, comment: true, merge: true, draft: Number(v) >= 6, bodyMax: PULL_BODY_MAX };
  else warnings.push('Pull requests are unreadable with this token (it needs Code: read and write).');
  warnings.push('Azure DevOps does not say what a token may write, so opening and merging pull requests is confirmed by the first one; a refusal names the missing permission.');

  const wi = await V({ method: 'POST', path: `/${enc(project)}/_apis/wit/wiql`, query: { $top: 1 }, json: { query: 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project' }, audit: 'use', conditional: false });
  if (wi.status === 200) caps.items = { ...caps.items, query: true, create: true, transition: true, comment: true };
  else warnings.push('Work items are unreadable with this token (it needs Work Items: read and write).');

  const builds = await V({ path: `/${enc(project)}/_apis/build/builds`, query: { $top: 1 }, conditional: false });
  if (builds.status === 200) caps.checks.read = true;
  else warnings.push('Build checks are unreadable with this token (it needs Build: read), so pull requests will show no build results.');

  const pol = await V({ path: `/${enc(project)}/_apis/policy/configurations`, query: { ...(repoId ? { repositoryId: repoId } : {}), refName: `refs/heads/${branch}` }, conditional: false });
  if (pol.status === 200) caps.protection.read = true;
  else warnings.push(`Branch protection unreadable (branch policies need Code: read): AICO cannot see which reviews and builds ${branch} requires, so it will not offer to merge.`);

  // Iterations: the team's, else the project's tree.
  try {
    const its = await listIterations(ctx, r => V(r));
    caps.iterations = its.length > 0 ? 'native' : 'none';
    if (its.length === 0) warnings.push('No sprints were found for this project (the team has none selected and the iteration tree has no dated nodes).');
  } catch (e) {
    if (e instanceof ConnectionError && (e.code === 'rate-limited' || e.code === 'auth' || e.code === 'policy' || e.code === 'credential')) throw e;
    caps.iterations = 'none';
    warnings.push('Sprints are unreadable with this token (it needs Project and Team: read).');
  }
}

// ── the adapter ───────────────────────────────────────────────────────────

export const azureDevopsAdapter: ProviderAdapter = {
  id: 'azure-devops',

  apiBase: azureApiBase,
  hostsFor,

  clientOptions(conn) {
    return {
      apiBase: azureApiBase(conn),
      auth: { kind: 'basic-empty-user' },
      headers: { Accept: accept(restVersion(conn)) },
      authFailure,
    };
  },

  parseRemote,
  validateRepo,
  suggestFromRemote,
  defaultStateMap: CATEGORY_STATE_MAP,

  probe,

  repos: {
    async get(ctx, ref) {
      const bad = validateRepo(ref);
      if (bad) throw new ConnectionError(bad, 'config');
      return repoInfo(ctx.conn, await readRepo(ctx, ref), ref);
    },
    async list(ctx, query) {
      const json = await getJson(ctx, { path: '/_apis/git/repositories' }, 'The repository list');
      const q = query?.trim().toLowerCase();
      return asArr(asObj(json).value).map(asObj)
        .filter(r => r.isDisabled !== true)
        .map(r => repoInfo(ctx.conn, r))
        .filter(r => r.ref.owner && r.ref.name && (!q || `${r.ref.owner}/${r.ref.name}`.toLowerCase().includes(q)))
        .slice(0, 500);
    },
  },

  pulls: {
    async find(ctx, head) {
      const h = branchName(head);
      const json = await getJson(ctx, {
        path: `${repoPath(ctx)}/pullrequests`,
        query: { 'searchCriteria.status': 'active', 'searchCriteria.sourceRefName': `refs/heads/${h}`, $top: 5 },
      }, 'The pull request list');
      const first = asArr(asObj(json).value).map(asObj).find(p => p.sourceRefName === `refs/heads/${h}` && typeof p.pullRequestId === 'number');
      return first ? fetchPull(ctx, String(first.pullRequestId)) : undefined;
    },

    async create(ctx, input: NewPull) {
      const title = cleanTitle(input.title);
      const { head, overflow } = clipText(withoutAttribution(input.body ?? ''), PULL_BODY_MAX);
      const refs = (input.itemIds ?? []).filter(i => /^\d{1,10}$/.test(i)).slice(0, 20).map(id => ({ id }));
      const res = await write(ctx, {
        method: 'POST', path: `${repoPath(ctx)}/pullrequests`, audit: 'pr.open', ref: input.head,
        json: {
          sourceRefName: `refs/heads/${branchName(input.head)}`, targetRefName: `refs/heads/${branchName(input.base)}`, title, description: head,
          ...(input.draft === true ? { isDraft: true } : {}), ...(refs.length ? { workItemRefs: refs } : {}),
        },
      }, 'opening the pull request', 'Code (read and write)');
      const pr = res.json as RawPr;
      // A new pull request has no policy results yet (Azure DevOps computes them asynchronously) and no checks.
      const pull = foldPull({ connection: ctx.conn.id, base: baseOf(ctx.conn), repo: repoOf(ctx), pr, evaluations: undefined, statuses: [], fresh: true });
      return { pull, ...(overflow ? { overflow } : {}) };
    },

    async update(ctx, id, patch) {
      const n = num(id, 'pull request');
      const json: Obj = {};
      if (patch.title !== undefined) json.title = cleanTitle(patch.title);
      if (patch.body !== undefined) {
        const { head, overflow } = clipText(withoutAttribution(patch.body), PULL_BODY_MAX);
        json.description = overflow ? `${head.slice(0, PULL_BODY_MAX - 60)}\n\n… (cut; the rest is in the first comment)` : head;
      }
      if (patch.state) json.status = patch.state === 'closed' ? 'abandoned' : 'active';
      await write(ctx, { method: 'PATCH', path: `${repoPath(ctx)}/pullrequests/${n}`, json, audit: 'write', ref: id }, `Pull request #${n}`, 'Code (read and write)');
      return fetchPull(ctx, id);
    },

    async comment(ctx, id, markdown) { await postThread(ctx, num(id, 'pull request'), markdown, id); },

    get: fetchPull,

    async comments(ctx, id) {
      const n = num(id, 'pull request');
      const pr = await fetchRawPull(ctx, n);
      const threads = await getJson(ctx, { path: `${repoPath(ctx)}/pullrequests/${n}/threads` }, `The comments of #${n}`);
      const proj = await call(ctx, { path: `/_apis/projects/${enc(pr.repository?.project?.name ?? projectOf(ctx))}`, conditional: false });
      const visibility = proj.status === 200 && typeof asObj(proj.json).visibility === 'string' ? String(asObj(proj.json).visibility) : undefined;
      return foldThreads(asArr(asObj(threads).value) as RawThread[], pr, visibility);
    },

    async merge(ctx, id, opts) {
      const n = num(id, 'pull request');
      const reviewed = sha(opts.sha);
      const pr = await fetchRawPull(ctx, n);
      // The commit the person reviewed must still be the tip: a push after review is never merged unseen.
      if ((pr.lastMergeSourceCommit?.commitId ?? '').toLowerCase() !== reviewed.toLowerCase()) {
        throw new ConnectionError(`#${n} was not merged because its branch changed after it was reviewed. Look at the new commits first.`, 'conflict', 409);
      }
      const res = await call(ctx, {
        method: 'PATCH', path: `${repoPath(ctx)}/pullrequests/${n}`, audit: 'pr.merge', ref: id,
        json: {
          status: 'completed', lastMergeSourceCommit: { commitId: reviewed },
          // No bypass, and the source branch stays: leaving or deleting it is the team's setting, never AICO's.
          completionOptions: { mergeStrategy: MERGE_STRATEGY[opts.method], deleteSourceBranch: false, bypassPolicy: false },
        },
      });
      if (res.status >= 200 && res.status < 300) {
        const done = asObj(asObj(res.json).lastMergeCommit).commitId;
        return { sha: typeof done === 'string' ? done : '' };
      }
      if (res.status === 400 || res.status === 405 || res.status === 409 || res.status === 412) {
        throw new ConnectionError(`Azure DevOps will not complete #${n} right now: ${azMessage(res) || 'its policies are not satisfied.'}`, 'conflict', res.status);
      }
      throw failure(res, `Merging #${n}`, 'Code (read and write)');
    },
  },

  items: {
    async query(ctx, q: ItemQuery) {
      if (q.source === 'off') return { items: [], notModified: true };
      const project = projectOf(ctx);
      const types = await loadTypes(ctx).catch(optional);
      const closedStates = types?.closedStates.length ? types.closedStates : ['Closed', 'Done', 'Completed', 'Removed'];
      const sinceMs = q.since ? Date.parse(q.since) : NaN;
      const since = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : undefined;
      const wiql = buildWiql({
        source: q.source, ...(q.value ? { value: q.value } : {}), ...(since ? { since } : {}),
        state: q.state ?? 'open', closedStates,
      });
      const res = await call(ctx, {
        method: 'POST', path: `/${enc(project)}/_apis/wit/wiql`, query: { timePrecision: 'true', $top: MAX_IMPORT }, json: { query: wiql },
        audit: 'use', conditional: false,
      });
      if (res.status < 200 || res.status >= 300) throw failure(res, 'The work item query');
      const ids = asArr(asObj(res.json).workItems).map(w => asObj(w).id).filter((x): x is number => typeof x === 'number').slice(0, MAX_IMPORT);
      const order = new Map(ids.map((id, i) => [id, i]));
      const raws: RawWorkItem[] = [];
      for (const chunk of batches(ids, 200)) {
        const b = await call(ctx, {
          method: 'POST', path: `/${enc(project)}/_apis/wit/workitemsbatch`, json: { ids: chunk, fields: [...ITEM_FIELDS], errorPolicy: 'omit' },
          audit: 'use', conditional: false,
        });
        if (b.status < 200 || b.status >= 300) throw failure(b, 'The work items');
        raws.push(...(asArr(asObj(b.json).value) as RawWorkItem[]).filter(w => typeof w?.id === 'number'));
      }
      const base = baseOf(ctx.conn);
      const items = raws
        .filter(w => {
          const p = asObj(w.fields)[F.project];
          return typeof p !== 'string' || p.toLowerCase() === project.toLowerCase();
        })
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
        .map(w => foldItem(w, base, types?.index))
        // The WIQL already excludes closed states by name; the category check also covers a state it did not know.
        .filter(i => (q.state ?? 'open') === 'all' || ((q.state ?? 'open') === 'closed') === (i.state === 'closed'));
      return { items, notModified: false };
    },

    async get(ctx, id) { return foldWith(ctx, await readRawItem(ctx, id)); },

    async create(ctx, input) {
      const title = cleanTitle(input.title);
      const project = projectOf(ctx);
      const types = await loadTypes(ctx).catch(optional);
      // The requirement-level type of the project's process; Task exists in all four.
      const process = types ? detectProcess(types.names) : 'Custom';
      const type = process === 'Agile' ? 'User Story' : process === 'Scrum' ? 'Product Backlog Item' : process === 'CMMI' ? 'Requirement' : process === 'Basic' ? 'Issue' : 'Task';
      const tags = joinTags(['aico', ...(input.labels ?? [])]);
      const ops: PatchOp[] = [
        { op: 'add', path: `/fields/${F.title}`, value: title },
        { op: 'add', path: `/fields/${F.description}`, value: markdownToHtml(clipText(withoutAttribution(input.body ?? ''), HISTORY_MAX).head) },
        { op: 'add', path: `/fields/${F.tags}`, value: tags },
      ];
      const res = await write(ctx, {
        method: 'POST', path: `/${enc(project)}/_apis/wit/workitems/$${enc(type)}`, json: ops, audit: 'write', ref: 'new-item',
        headers: { 'Content-Type': 'application/json-patch+json' },
      }, 'creating the work item', 'Work Items (read and write)');
      return foldWith(ctx, res.json as RawWorkItem);
    },

    async update(ctx, id, patch, ifRev) {
      const n = num(id, 'work item');
      const current = await readRawItem(ctx, id, `${F.project},${F.state}`);
      if (String(current.rev ?? '') !== ifRev) throw conflict(n, String(current.rev ?? ''), ifRev);
      const ops: PatchOp[] = [REV_TEST(ifRev)];
      if (patch.title !== undefined) ops.push({ op: 'add', path: `/fields/${F.title}`, value: cleanTitle(patch.title) });
      if (patch.body !== undefined) ops.push({ op: 'add', path: `/fields/${F.description}`, value: markdownToHtml(clipText(withoutAttribution(patch.body), HISTORY_MAX).head) });
      if (patch.labels) ops.push({ op: 'add', path: `/fields/${F.tags}`, value: joinTags(patch.labels) });
      if (patch.milestone !== undefined) {
        // An iteration's id (a GUID from `iterations.list`) is resolved to its path; anything else is taken as the path itself.
        let path = patch.milestone === null ? projectOf(ctx) : sanitizeLine(patch.milestone, 400);
        if (patch.milestone && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path)) {
          const found = (await listIterations(ctx)).find(i => i.id.toLowerCase() === path.toLowerCase());
          if (!found?.itemKey) throw new ConnectionError('That iteration is no longer among the iterations of this project.', 'not-found', 404);
          path = found.itemKey;
        }
        ops.push({ op: 'add', path: `/fields/${F.iteration}`, value: path });
      }
      return foldWith(ctx, await patchItem(ctx, id, ops, 'Work Items (read and write)'));
    },

    async transition(ctx, id, to, ifRev) {
      return azureDevopsAdapter.items!.transitionCategory!(ctx, id, to === 'closed' ? 'completed' : 'proposed', ifRev);
    },

    async transitionCategory(ctx, id, category, ifRev) {
      const n = num(id, 'work item');
      const current = await readRawItem(ctx, id, `${F.project},${F.state},${F.type}`);
      if (String(current.rev ?? '') !== ifRev) throw conflict(n, String(current.rev ?? ''), ifRev);
      const f = asObj(current.fields);
      const type = typeof f[F.type] === 'string' ? f[F.type] as string : '';
      const types = await loadTypes(ctx).catch(optional);
      const states = types?.types.find(t => t.name.toLowerCase() === type.toLowerCase())?.states;
      const target = states ? pickState(states, category) : undefined;
      if (!target) {
        throw new ConnectionError(`${type || 'This work item type'} has no ${category} state in this project's process, so work item ${n} was not moved. Change the state names on the Connections page.`, 'config');
      }
      if (categoryOf(types?.index, type, String(f[F.state] ?? '')) === category) {
        return foldWith(ctx, await readRawItem(ctx, id)); // already in that category: nothing to write
      }
      const out = await patchItem(ctx, id, [REV_TEST(ifRev), { op: 'add', path: `/fields/${F.state}`, value: target.name }], 'Work Items (read and write)');
      return foldWith(ctx, out);
    },

    async setEstimate(ctx, id, points, ifRev) {
      const n = num(id, 'work item');
      if (!Number.isFinite(points) || points < 0 || points > 1000) throw new ConnectionError('An estimate is a number from 0 to 1000.', 'config');
      const current = await readRawItem(ctx, id, [F.project, F.type, ...POINTS_FIELDS].join(','));
      if (String(current.rev ?? '') !== ifRev) throw conflict(n, String(current.rev ?? ''), ifRev);
      const field = await pointsFieldFor(ctx, current);
      if (!field) throw new ConnectionError(`Work item ${n} has no story points field (Story Points, Effort or Size), so its estimate was not written.`, 'config');
      return foldWith(ctx, await patchItem(ctx, id, [REV_TEST(ifRev), { op: 'add', path: `/fields/${field}`, value: points }], 'Work Items (read and write)'));
    },

    async comment(ctx, id, markdown) {
      const text = clipText(withoutAttribution(markdown), HISTORY_MAX);
      const out = await patchItem(ctx, id, [{ op: 'add', path: `/fields/${F.history}`, value: markdownToHtml(text.head) }], 'Work Items (read and write)');
      return { rev: String(out.rev ?? '') };
    },

    async addLabels(ctx, id, labels) {
      const clean = labels.map(l => sanitizeLine(l, 50)).filter(Boolean);
      if (!clean.length) return;
      return editTags(ctx, id, tags => (clean.every(l => tags.includes(l)) ? undefined : [...tags, ...clean.filter(l => !tags.includes(l))]));
    },

    async removeLabel(ctx, id, label) {
      const gone = sanitizeLine(label, 50).toLowerCase();
      return editTags(ctx, id, tags => (tags.some(t => t.toLowerCase() === gone) ? tags.filter(t => t.toLowerCase() !== gone) : undefined));
    },

    async linkPull(ctx, itemId, pullId) {
      const n = num(pullId, 'pull request');
      const pr = await fetchRawPull(ctx, n);
      const projectId = pr.repository?.project?.id;
      const repoId = pr.repository?.id;
      if (!projectId || !repoId) return;
      const url = `vstfs:///Git/PullRequestId/${projectId}%2F${repoId}%2F${n}`;
      const res = await call(ctx, { path: `/${enc(projectOf(ctx))}/_apis/wit/workitems/${num(itemId, 'work item')}`, query: { $expand: 'relations' }, conditional: false });
      if (res.status < 200 || res.status >= 300) throw failure(res, `Work item ${itemId}`);
      const have = asArr(asObj(res.json).relations).some(r => {
        const o = asObj(r);
        return o.rel === 'ArtifactLink' && typeof o.url === 'string' && decodeURIComponent(o.url).toLowerCase() === decodeURIComponent(url).toLowerCase();
      });
      if (have) return;
      const out = await patchItem(ctx, itemId, [{ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url, attributes: { name: 'Pull Request' } } }], 'Work Items (read and write)');
      return { rev: String(out.rev ?? '') };
    },
  },

  iterations: {
    list: ctx => listIterations(ctx),

    async assign(ctx, itemId, iterationId, known) {
      let path = known?.itemKey;
      if (!path) path = (await listIterations(ctx)).find(i => i.id === iterationId)?.itemKey;
      if (!path) throw new ConnectionError('That iteration is not in the project\'s iterations any more.', 'not-found', 404);
      const out = await patchItem(ctx, itemId, [{ op: 'add', path: `/fields/${F.iteration}`, value: path }], 'Work Items (read and write)');
      return { rev: String(out.rev ?? '') };
    },

    async create(ctx, input) {
      const project = projectOf(ctx);
      const title = cleanTitle(input.title, 120);
      if (/[\\/$*?"<>|:#&]/.test(title)) throw new ConnectionError('An iteration name cannot contain \\ / $ * ? " < > | : # or &.', 'config');
      const start = input.start && /^\d{4}-\d{2}-\d{2}/.test(input.start) ? input.start.slice(0, 10) : undefined;
      const end = input.end && /^\d{4}-\d{2}-\d{2}/.test(input.end) ? input.end.slice(0, 10) : undefined;
      const node = await write(ctx, {
        method: 'POST', path: `/${enc(project)}/_apis/wit/classificationnodes/iterations`, audit: 'write', ref: 'new-iteration',
        json: { name: title, ...(start || end ? { attributes: { ...(start ? { startDate: `${start}T00:00:00Z` } : {}), ...(end ? { finishDate: `${end}T00:00:00Z` } : {}) } } : {}) },
      }, 'creating the iteration', 'Work Items (full)');
      const nj = asObj(node.json);
      const identifier = typeof nj.identifier === 'string' ? nj.identifier : undefined;
      if (!identifier) throw new ConnectionError('Azure DevOps did not return the new iteration\'s id.', 'http', node.status);
      // The team only shows an iteration it has picked.
      const team = await defaultTeam(ctx);
      await write(ctx, { method: 'POST', path: `/${enc(project)}/${enc(team)}/_apis/work/teamsettings/iterations`, json: { id: identifier }, audit: 'write', ref: 'new-iteration' }, 'adding the iteration to the team', 'Work Items (full)');
      return {
        id: identifier, title, kind: 'iteration' as const, state: 'open' as const, ...(start ? { start } : {}), ...(end ? { end } : {}),
        itemKey: `${project}\\${title}`,
      };
    },
  },

  checks: {
    async forCommit(ctx, commit) {
      const s = sha(commit);
      const base = baseOf(ctx.conn);
      const project = projectOf(ctx);
      const repo = await readRepo(ctx, repoOf(ctx));
      const out: RemoteCheck[] = [];
      const st = await call(ctx, { path: `${repoPath(ctx)}/commits/${s}/statuses`, conditional: false });
      if (st.status === 200) {
        for (const x of latestStatuses(asArr(asObj(st.json).value) as RawStatus[])) {
          const state: RemoteCheck['state'] = x.state === 'succeeded' ? 'success' : x.state === 'pending' ? 'pending' : x.state === 'failed' || x.state === 'error' ? 'failure' : 'skipped';
          const url = safeUrl(x.targetUrl);
          const summary = sanitizeRemoteText(x.description ?? '', REMOTE_LIMITS.summary);
          out.push({ name: sanitizeLine([x.context?.genre, x.context?.name].filter(Boolean).join('/'), REMOTE_LIMITS.title) || '(unnamed status)', state, ...(url ? { url } : {}), ...(summary ? { summary } : {}) });
        }
      } else if (![400, 401, 403, 404].includes(st.status)) throw failure(st, 'The commit statuses');
      const b = await call(ctx, {
        path: `/${enc(project)}/_apis/build/builds`,
        query: { ...(typeof repo.id === 'string' ? { repositoryId: repo.id, repositoryType: 'TfsGit' } : {}), queryOrder: 'queueTimeDescending', $top: 50 }, conditional: false,
      });
      if (b.status === 200) {
        for (const x of latestBuilds((asArr(asObj(b.json).value) as RawBuild[]).filter(r => (r.sourceVersion ?? '').toLowerCase() === s.toLowerCase()))) {
          out.push(foldBuildResult(x, base, project));
        }
      } else if (![400, 401, 403, 404].includes(b.status)) throw failure(b, 'The builds');
      return out;
    },
  },

  protection: { read: readProtection },

  process: {
    async describe(ctx) {
      const t = await loadTypes(ctx);
      if (!t) throw new ConnectionError('The project\'s work item types could not be read (the token needs Work Items: read).', 'not-found', 404);
      const name = detectProcess(t.names);
      const shown = t.types.filter(x => !['Epic', 'Feature', 'Initiative', 'Test Case', 'Test Plan', 'Test Suite', 'Shared Steps', 'Shared Parameter', 'Code Review Request', 'Code Review Response', 'Feedback Request', 'Feedback Response', 'Issue Template'].includes(x.name));
      return { name, types: shown, pointsField: name === 'Scrum' || name === 'Basic' ? 'Effort' : 'Story Points' };
    },
  },
};
