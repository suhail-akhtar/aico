/**
 * The Gitea and Forgejo adapter: one implementation, API v1, a `flavour` that names the server
 * in messages and in the version cross-check (ADR 0039; the two share an API that has diverged
 * only at the edges, so a mismatch lowers a chip, never the connection).
 *
 * WHY it looks the way it does, each point a failure it prevents:
 *
 *  - **`Authorization: token`.** The scheme both servers document; the client sends it through
 *    the `scheme` option of bearer auth, so the secret is still applied only at the last moment.
 *  - **Scopes are never reported, so they are probed.** A Gitea token does not list its scopes
 *    and there is no `self` endpoint; the capability chips come from one cheap call per feature
 *    against the mapped repository, and the page shows probed rows rather than "missing" chips
 *    it would have to invent.
 *  - **Labels are ids.** Issue creation and label changes take label IDS on the servers still
 *    in use, and an unknown label name is an error, not a new label. The adapter resolves names
 *    to ids (listing the repository's labels) and creates the missing `aico:*` ones itself, in
 *    one bounded step, because a state map that writes `aico:running` must work on first use.
 *  - **Pull requests are found by listing.** There is no `head=` filter; the open list is
 *    scanned (bounded) for the task branch, which also makes opening idempotent.
 *  - **Mergeability is assembled** (fold.ts): `mergeable` alone cannot tell a conflict from
 *    "still checking", so it is read with a grace period; the merge sends `head_commit_id` so a
 *    push after review cannot be merged unseen, never `force_merge` (no admin bypass), and the
 *    merge commit is read back afterwards because Gitea answers a merge with an empty body.
 *  - **Humans win conflicts.** `items.update/transition` re-read the issue and compare
 *    `updated_at` to the caller's `ifRev`; a mismatch is a `conflict`, and nothing is written.
 *  - **Trust is derived, not assumed.** Comments carry no author association on these servers,
 *    so the owner is OWNER, the repository's collaborators and reviewers Gitea marks `official`
 *    are COLLABORATOR, everyone else NONE (nobody is trusted when the lists are unreadable).
 *  - **Stranger text is sanitised on the way out and AICO text has no AI credit on the way in.**
 *
 * What it does not do: choose what to sync or when to merge (sync.ts, landing.ts), rerun Actions
 * (the API is partial and version dependent), set auto-merge, create or change protections
 * (read only), or write estimates (a `sp:5` label is the only convention).
 *
 * @module connections/gitea
 */

import type { Capabilities, ProbeResult, PullState, RepoRef, ScopeAdvice } from '../../../shared/connections/types.js';
import {
  noCapabilities,
  type AdapterCtx, type Comment, type ItemQuery, type Iteration, type NewPull, type ProtectionInfo,
  type ProviderAdapter, type RepoInfo,
} from '../adapter.js';
import { ConnectionError, type ConnResponse } from '../http.js';
import { clipText } from '../github/fold.js';
import { asArr, asObj, baseOf, enc, makeRest, optional, parseItemQuery, parseRemoteSegments, type Obj } from '../rest.js';
import { REMOTE_LIMITS, sanitizeLine, withoutAttribution } from '../sanitize.js';
import type { StoredConnection } from '../types.js';
import {
  foldComment, foldItem, foldPull, foldReviewComment, foldStatus, isDraft,
  type RawComment, type RawIssue, type RawPull, type RawReview, type RawStatus,
} from './fold.js';

/** Stay under the 65,535-byte TEXT column some Gitea databases still use. */
export const PULL_BODY_MAX = 65_000;
const COMMENT_MAX = 65_000;
const ISSUE_BODY_MAX = 65_000;
/** Gitea clamps `limit` to its MAX_RESPONSE_ITEMS (50 by default). */
const PAGE = 50;

export type Flavour = 'gitea' | 'forgejo';

function gMessage(res: ConnResponse): string {
  const j = asObj(res.json);
  const errors = asArr(j.errors).filter((e): e is string => typeof e === 'string');
  return sanitizeLine(typeof j.message === 'string' && j.message ? j.message : errors[0] ?? '', 240);
}

export function giteaApiBase(conn: Pick<StoredConnection, 'baseUrl'>): string {
  const b = baseOf(conn.baseUrl);
  if (!b) throw new ConnectionError(`"${conn.baseUrl}" is not a URL.`, 'config');
  return `${b.origin}${b.pathname}/api/v1`;
}

/** `https://h[/prefix]/owner/name(.git)`, `git@h:owner/name.git`, `ssh://git@h:2222/owner/name.git`. */
export function parseGiteaRemote(url: string, baseUrl: string): RepoRef | undefined {
  const segs = parseRemoteSegments(url, baseUrl, { min: 2, max: 2 });
  return segs ? { owner: segs[0]!, name: segs[1]! } : undefined;
}

const branchPath = (b: string): string => b.split('/').map(enc).join('/');

const NEEDED: ScopeAdvice[] = [
  { scope: 'Repository: read and write', why: 'Push aico/task-* branches, open and merge pull requests, read commit statuses.', feature: 'pulls', required: true },
  { scope: 'Issue: read and write', why: 'Import issues as tasks and keep their labels and state in step.', feature: 'items', required: false },
  { scope: 'User: read', why: 'Show which account the token acts as.', feature: 'repos', required: false },
];

function looksForgejo(version: string | undefined): boolean { return !!version && (/forgejo/i.test(version) || /gitea-\d/i.test(version)); }

export function makeGiteaAdapter(flavour: Flavour): ProviderAdapter {
  const name = flavour === 'forgejo' ? 'Forgejo' : 'Gitea';
  const { call, failure, getJson, paged, write } = makeRest({ name, message: gMessage });

  function repoOf(ctx: AdapterCtx): RepoRef {
    if (!ctx.repo) throw new ConnectionError(`This operation needs a repository: map the project to a ${name} repository first.`, 'config');
    return ctx.repo;
  }
  const repoPath = (ctx: AdapterCtx): string => { const r = repoOf(ctx); return `/repos/${enc(r.owner)}/${enc(r.name)}`; };
  const repoName = (ctx: AdapterCtx): string => { const r = repoOf(ctx); return `${r.owner}/${r.name}`; };

  function num(id: string, what: string): number {
    if (!/^\d{1,9}$/.test(id)) throw new ConnectionError(`"${id.slice(0, 40)}" is not a ${name} ${what} number.`, 'config');
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

  // ── labels (names <-> ids) ───────────────────────────────────────────────

  async function repoLabels(ctx: AdapterCtx): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const r = await paged<Obj>(ctx, { path: `${repoPath(ctx)}/labels`, query: { limit: PAGE }, conditional: false }, j => asArr(j).map(asObj), 'The label list', 6);
    for (const l of r.items) if (typeof l.name === 'string' && typeof l.id === 'number') out.set(l.name, l.id);
    return out;
  }

  /** Ids for these label names; the ones that do not exist are created (a person turned the sync on, and `aico:*` labels are its vocabulary). */
  async function ensureLabels(ctx: AdapterCtx, names: readonly string[]): Promise<number[]> {
    const clean = [...new Set(names.map(l => sanitizeLine(l, 50)).filter(Boolean))];
    if (!clean.length) return [];
    const have = await repoLabels(ctx);
    const ids: number[] = [];
    for (const n of clean) {
      let id = have.get(n);
      if (id === undefined) {
        const res = await write(ctx, {
          method: 'POST', path: `${repoPath(ctx)}/labels`, audit: 'write', ref: 'new-label',
          json: { name: n, color: '#6b7280', description: 'Managed by AICO' },
        }, `creating the label "${n}"`, 'Issue: write');
        id = Number(asObj(res.json).id);
        if (!Number.isFinite(id)) throw new ConnectionError(`${name} did not say which label "${n}" became.`, 'http');
      }
      ids.push(id);
    }
    return ids;
  }

  // ── protection ───────────────────────────────────────────────────────────

  /** `GET branches/{b}` is readable by anyone who can read the repository and says whether it is protected and what it requires. */
  async function readProtection(ctx: AdapterCtx, branch: string): Promise<ProtectionInfo> {
    const res = await call(ctx, { path: `${repoPath(ctx)}/branches/${branchPath(branch)}` });
    if (res.status === 403) return { protected: false, unreadable: 'the token cannot read branch settings' };
    if (res.status === 404) return { protected: false, unreadable: `${name} has no branch ${branch}, or the token cannot see it` };
    if (res.status !== 200) throw failure(res, `branch protection for ${branch}`);
    const b = asObj(res.json);
    if (b.protected !== true) return { protected: false };
    const contexts = b.enable_status_check === true ? asArr(b.status_check_contexts).map(c => sanitizeLine(c, REMOTE_LIMITS.title)).filter(Boolean) : [];
    return {
      protected: true,
      requiredReviews: typeof b.required_approvals === 'number' ? b.required_approvals : 0,
      requiredChecks: contexts,
    };
  }

  // ── pull requests ────────────────────────────────────────────────────────

  async function statusesOf(ctx: AdapterCtx, commit: string, what: string): Promise<RawStatus[]> {
    const r = await paged<RawStatus>(ctx, { path: `${repoPath(ctx)}/commits/${commit}/status`, query: { limit: PAGE } },
      j => asArr(asObj(j).statuses) as RawStatus[], what, 3);
    return r.items;
  }

  async function fetchPull(ctx: AdapterCtx, id: string): Promise<PullState> {
    const n = num(id, 'pull request');
    const base = repoPath(ctx);
    const { json } = await getJson(ctx, { path: `${base}/pulls/${n}` }, `Pull request #${n}`);
    const pr = json as RawPull;
    const head = pr.head?.sha ?? '';
    // A token without commit-status access gets 403 here; the pull request is still worth observing, with no checks.
    const statuses = head ? await statusesOf(ctx, head, `The checks of #${n}`).catch(optional) : undefined;
    const rv = await paged<RawReview>(ctx, { path: `${base}/pulls/${n}/reviews`, query: { limit: PAGE } }, j => asArr(j) as RawReview[], `The reviews of #${n}`, 3).catch(optional);
    const protection = pr.base?.ref ? await readProtection(ctx, pr.base.ref).catch(optional) : undefined;
    return foldPull({ connection: ctx.conn.id, pr, statuses: statuses ?? [], reviews: rv?.items ?? [], ...(protection ? { protection } : {}) });
  }

  /** Who may steer the agent: the owner, the collaborators, and reviewers the server marks `official`. */
  async function trustedLogins(ctx: AdapterCtx, reviews: RawReview[]): Promise<{ owner: string; collaborators: Set<string> }> {
    const collaborators = new Set<string>();
    const r = await paged<Obj>(ctx, { path: `${repoPath(ctx)}/collaborators`, query: { limit: PAGE } }, j => asArr(j).map(asObj), 'The collaborators', 2).catch(optional);
    for (const c of r?.items ?? []) { const l = c.login ?? c.username; if (typeof l === 'string') collaborators.add(l.toLowerCase()); }
    for (const rv of reviews) if (rv.official === true && rv.user?.login) collaborators.add(rv.user.login.toLowerCase());
    return { owner: repoOf(ctx).owner.toLowerCase(), collaborators };
  }

  // ── issues ───────────────────────────────────────────────────────────────

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
      `Issue #${n} changed on ${name} (updated ${current || 'at an unknown time'}) after AICO last read it (${ifRev || 'never'}). It was left as it is; pull it again and decide.`,
      'conflict', 409);
  }

  // ── probe ────────────────────────────────────────────────────────────────

  async function probe(ctx: AdapterCtx): Promise<ProbeResult> {
    const warnings: string[] = [];
    const userRes = await call(ctx, { path: '/user', conditional: false });
    if (userRes.status !== 200) throw failure(userRes, 'The account behind this token');
    const u = asObj(userRes.json);
    const user = sanitizeLine(u.login ?? u.username, 80);

    const verRes = await call(ctx, { path: '/version', conditional: false }).catch((e: unknown) => {
      if (e instanceof ConnectionError && e.code === 'rate-limited') throw e;
      return undefined; // the version is a nicety; its absence is not a failed probe
    });
    const vRaw = verRes?.status === 200 ? asObj(verRes.json).version : undefined;
    const version = typeof vRaw === 'string' ? sanitizeLine(vRaw, 60) : undefined;
    if (version) {
      if (flavour === 'gitea' && looksForgejo(version)) warnings.push('This server reports a Forgejo version. Add it as Forgejo so the messages and checks match.');
      else if (flavour === 'forgejo' && !looksForgejo(version)) warnings.push('This server reports a Gitea version. Add it as Gitea so the messages and checks match.');
    }

    const caps: Capabilities = noCapabilities();
    caps.repos = true;
    caps.pulls.bodyMax = PULL_BODY_MAX;
    caps.items.estimate = 'label';
    caps.checks.logsUrl = true;

    if (ctx.repo) await probeRepo(ctx, caps, warnings);
    else {
      // Nothing mapped yet (the add flow tests before a project exists): check a repository this account can write to, so
      // the chips are what real calls say. A token does not list its scopes here, so there is nothing else to go on.
      const list = await call(ctx, { path: '/user/repos', query: { limit: PAGE }, conditional: false });
      caps.repos = list.status === 200;
      const repos = list.status === 200 ? asArr(list.json).map(asObj) : [];
      const pick = repos.find(r => asObj(r.permissions).push === true) ?? repos[0];
      const full = typeof pick?.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(pick.full_name) ? pick.full_name : undefined;
      if (full) {
        await probeRepo({ ...ctx, repo: { owner: full.split('/')[0]!, name: full.split('/')[1]! } }, caps, warnings);
        warnings.push(`Checked against ${full}: map a project and test again to see what this token can do there.`);
      } else warnings.push('This account has no repository to check the token against: map a project and test again.');
    }

    return {
      at: new Date().toISOString(),
      user,
      ...(version ? { version } : {}),
      capabilities: caps,
      scopes: { found: [], needed: NEEDED, missing: [], extra: [], reported: false },
      warnings,
    };
  }

  async function probeRepo(ctx: AdapterCtx, caps: Capabilities, warnings: string[]): Promise<void> {
    const base = repoPath(ctx);
    const rname = repoName(ctx);
    const repo = await call(ctx, { path: base, conditional: false });
    if (repo.status === 404 || repo.status === 403) {
      warnings.push(`The repository ${rname} was not found, or this token cannot see it.`);
      return;
    }
    if (repo.status !== 200) throw failure(repo, `The repository ${rname}`);
    const rj = asObj(repo.json);
    const perms = asObj(rj.permissions);
    const canWrite = rj.permissions === undefined || perms.push === true || perms.admin === true;
    const branch = typeof rj.default_branch === 'string' && rj.default_branch ? rj.default_branch : 'main';

    const pulls = await call(ctx, { path: `${base}/pulls`, query: { state: 'all', limit: 1 }, conditional: false });
    if (rj.has_pull_requests !== false && pulls.status === 200) {
      caps.pulls = { create: canWrite, comment: true, merge: canWrite, draft: canWrite, bodyMax: PULL_BODY_MAX };
      if (!canWrite) warnings.push('This token can only read the repository, so AICO cannot open or merge pull requests.');
    } else if (rj.has_pull_requests === false) warnings.push('Pull requests are turned off for this repository.');
    else warnings.push('Pull requests are unreadable with this token (it needs Repository: read and write).');

    if (rj.has_issues === false) {
      warnings.push('Issues are turned off for this repository, so work items are unavailable.');
    } else {
      const issues = await call(ctx, { path: `${base}/issues`, query: { state: 'all', type: 'issues', limit: 1 }, conditional: false });
      if (issues.status === 200) caps.items = { ...caps.items, query: true, create: true, transition: canWrite, comment: true };
      else warnings.push('Issues are unreadable with this token (it needs Issue: read and write).');
    }

    const checks = await call(ctx, { path: `${base}/commits/${branchPath(branch)}/status`, query: { limit: 1 }, conditional: false });
    if (checks.status === 200) caps.checks.read = true;
    else warnings.push(`Checks are unreadable with this token (it needs Repository: read), so pull requests will show no checks. ${name} Actions report as commit statuses.`);

    const prot = await readProtection(ctx, branch);
    if (prot.unreadable) warnings.push(`Branch protection unreadable (${prot.unreadable}): AICO cannot see which reviews and checks ${branch} requires.`);
    else caps.protection.read = true;

    const ms = await call(ctx, { path: `${base}/milestones`, query: { state: 'all', limit: 1 }, conditional: false });
    caps.iterations = ms.status === 200 ? 'milestone' : 'none';
    warnings.push(`${name} has milestones, not iterations or story points: milestones stand in for sprints and an "sp:5" label carries an estimate.`);
  }

  // ── the adapter ──────────────────────────────────────────────────────────

  function repoInfo(conn: StoredConnection, j: Obj, ref: RepoRef): RepoInfo {
    const full = typeof j.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(j.full_name) ? j.full_name : `${ref.owner}/${ref.name}`;
    const perms = asObj(j.permissions);
    const root = conn.baseUrl.replace(/\/+$/, '');
    return {
      ref: { owner: full.split('/')[0]!, name: full.split('/')[1]!, ...(j.id !== undefined ? { id: String(j.id) } : {}) },
      defaultBranch: typeof j.default_branch === 'string' && j.default_branch ? sanitizeLine(j.default_branch, 255) : 'main',
      // Rebuilt from the base URL, never copied from the response: no userinfo, no foreign host.
      cloneUrl: `${root}/${full}.git`,
      htmlUrl: `${root}/${full}`,
      private: j.private === true,
      ...(j.permissions ? { permissions: { pull: perms.pull === true, push: perms.push === true, admin: perms.admin === true } } : {}),
    };
  }

  return {
    id: flavour,

    apiBase: giteaApiBase,

    hostsFor(baseUrl) {
      const b = baseOf(baseUrl);
      return b ? [b.host] : [];
    },

    clientOptions(conn) {
      return { apiBase: giteaApiBase(conn), auth: { kind: 'bearer', scheme: 'token' }, headers: { Accept: 'application/json' } };
    },

    // Over https the token goes in as the password; the user name is ignored by these servers, so the account is the natural one.
    gitUsername(conn) { return conn.probe?.user || 'x-access-token'; },

    parseRemote: parseGiteaRemote,

    probe,

    repos: {
      async get(ctx, ref) {
        const c: AdapterCtx = { ...ctx, repo: ref };
        const { json } = await getJson(c, { path: repoPath(c) }, `The repository ${ref.owner}/${ref.name}`);
        return repoInfo(ctx.conn, asObj(json), ref);
      },
      async list(ctx, query) {
        const { items } = await paged<Obj>(ctx, { path: '/user/repos', query: { limit: PAGE } }, j => asArr(j).map(asObj), 'The repository list', 3);
        const q = query?.trim().toLowerCase();
        return items.filter(r => !q || String(r.full_name ?? '').toLowerCase().includes(q)).map(r => repoInfo(ctx.conn, r, { owner: '', name: '' }));
      },
    },

    pulls: {
      async find(ctx, head) {
        // No `head=` filter exists: scan the open list (newest first) for the task branch.
        const out = await paged<Obj>(ctx, { path: `${repoPath(ctx)}/pulls`, query: { state: 'open', sort: 'recentupdate', limit: PAGE } }, j => asArr(j).map(asObj), 'The pull request list', 4);
        const hit = out.items.find(p => asObj(p.head).ref === head);
        return hit && typeof hit.number === 'number' ? fetchPull(ctx, String(hit.number)) : undefined;
      },

      async create(ctx, input: NewPull) {
        const title = cleanTitle(input.draft ? `WIP: ${input.title.replace(/^\s*(?:\[WIP\]|WIP:)\s*/i, '')}` : input.title);
        const { head, overflow } = cleanBody(input.body, PULL_BODY_MAX);
        const res = await write(ctx, {
          method: 'POST', path: `${repoPath(ctx)}/pulls`, audit: 'pr.open', ref: input.head,
          json: { title, head: input.head, base: input.base, body: head },
        }, 'opening the pull request', 'Repository: write');
        // A fresh PR has no statuses or reviews to fetch, and `mergeable` is still being computed.
        const pull = foldPull({ connection: ctx.conn.id, pr: res.json as RawPull, statuses: [], reviews: [] });
        return { pull, ...(overflow ? { overflow } : {}) };
      },

      async update(ctx, id, patch) {
        const n = num(id, 'pull request');
        const base = repoPath(ctx);
        const json: Obj = {};
        if (patch.title !== undefined) {
          let title = cleanTitle(patch.title);
          // The title is where "draft" lives here: a rename must not quietly take a draft out of draft.
          const cur = (await getJson(ctx, { path: `${base}/pulls/${n}`, conditional: false }, `Pull request #${n}`)).json as RawPull;
          if (isDraft(cur) && !isDraft({ title })) title = `WIP: ${title}`;
          json.title = title;
        }
        if (patch.body !== undefined) {
          const { head, overflow } = cleanBody(patch.body, PULL_BODY_MAX);
          json.body = overflow ? `${head}\n\n… (cut; the rest is in the first comment)` : head;
        }
        if (patch.state) json.state = patch.state;
        await write(ctx, { method: 'PATCH', path: `${base}/pulls/${n}`, json, audit: 'write', ref: id }, `Pull request #${n}`, 'Repository: write');
        return fetchPull(ctx, id);
      },

      async comment(ctx, id, markdown) {
        const n = num(id, 'pull request');
        const body = clipText(withoutAttribution(markdown), COMMENT_MAX);
        await write(ctx, {
          method: 'POST', path: `${repoPath(ctx)}/issues/${n}/comments`, audit: 'write', ref: id,
          json: { body: body.overflow ? `${body.head}\n\n… (cut at ${COMMENT_MAX} characters)` : body.head },
        }, `Pull request #${n}`, 'Issue: write');
      },

      get: fetchPull,

      async comments(ctx, id) {
        const n = num(id, 'pull request');
        const base = repoPath(ctx);
        const convo = await paged<RawComment>(ctx, { path: `${base}/issues/${n}/comments`, query: { limit: PAGE } }, j => asArr(j) as RawComment[], `The comments of #${n}`, 3);
        const revs = await paged<RawReview>(ctx, { path: `${base}/pulls/${n}/reviews`, query: { limit: PAGE } }, j => asArr(j) as RawReview[], `The reviews of #${n}`, 3);
        const trust = await trustedLogins(ctx, revs.items);
        const assoc = (login: string | undefined): string => {
          const l = (login ?? '').toLowerCase();
          if (!l) return 'NONE';
          if (l === trust.owner) return 'OWNER';
          return trust.collaborators.has(l) ? 'COLLABORATOR' : 'NONE';
        };
        const all: Comment[] = [
          ...convo.items.map(c => foldComment(c, assoc(c.user?.login ?? c.user?.username))),
          ...revs.items.map(r => foldReviewComment(r, assoc(r.user?.login ?? r.user?.username))).filter((c): c is Comment => !!c),
        ];
        // Newest last; a stable sort keeps API order for equal timestamps.
        return all.map((c, i) => ({ c, i })).sort((a, b) => (Date.parse(a.c.at) || 0) - (Date.parse(b.c.at) || 0) || a.i - b.i).map(x => x.c);
      },

      async merge(ctx, id, opts) {
        const n = num(id, 'pull request');
        const base = repoPath(ctx);
        const res = await call(ctx, {
          method: 'POST', path: `${base}/pulls/${n}/merge`, audit: 'pr.merge', ref: id,
          // `head_commit_id` makes the server refuse if the head moved since review. `force_merge` (the admin bypass) is never sent.
          json: { Do: opts.method, head_commit_id: sha(opts.sha) },
        });
        if (res.status === 405) throw new ConnectionError(`${name} will not merge #${n} right now: ${gMessage(res) || 'it is not mergeable.'}`, 'conflict', 405);
        if (res.status === 409) throw new ConnectionError(`#${n} was not merged: ${gMessage(res) || 'its branch changed after it was reviewed, or it has conflicts'}. Look at the new commits first.`, 'conflict', 409);
        if (res.status < 200 || res.status >= 300) throw failure(res, `Merging #${n}`, 'Repository: write');
        // The server answers a merge with an empty body: the merge commit is read back.
        const after = await getJson(ctx, { path: `${base}/pulls/${n}`, conditional: false }, `Pull request #${n}`);
        return { sha: String((after.json as RawPull).merge_commit_sha ?? '') };
      },
    },

    items: {
      async query(ctx, q: ItemQuery) {
        if (q.source === 'off') return { items: [], notModified: true };
        const state = q.state ?? 'open';
        const since = isoOrUndefined(q.since);
        const query: Record<string, string | number> = { state, type: 'issues', limit: PAGE };
        if (q.source === 'label') {
          if (!q.value?.trim()) throw new ConnectionError('Importing by label needs a label name.', 'config');
          query.labels = sanitizeLine(q.value, REMOTE_LIMITS.label);
        }
        if (q.source === 'assigned-to-me' && !q.me) throw new ConnectionError('Importing items assigned to you needs to know which account the token acts as; test the connection first.', 'config');
        const pq = q.source === 'query' ? parseItemQuery(sanitizeLine(q.value ?? '', 256)) : undefined;
        if (pq) {
          // The API has parameters, not a query language: labels and text go to the server, assignee and author are filtered below.
          if (pq.labels.length) query.labels = pq.labels.join(',');
          if (pq.text) query.q = pq.text;
          if (pq.state && !q.state) query.state = pq.state;
        }
        if (since) query.since = since;
        const out = await paged<RawIssue>(ctx, { path: `${repoPath(ctx)}/issues`, query }, j => asArr(j) as RawIssue[], 'The issue list', 6);
        const me = q.me?.toLowerCase();
        const wantAssignee = (pq?.assignee ?? '').toLowerCase();
        const wantAuthor = (pq?.author ?? '').toLowerCase();
        // `type=issues` leaves pull requests out on current servers; older ones list them, so the key is checked too.
        // "Assigned to me" is filtered here: the server's own filter names differ between versions.
        const items = out.items
          .filter(i => !i.pull_request)
          .filter(i => q.source !== 'assigned-to-me' || [...(i.assignees ?? []), ...(i.assignee ? [i.assignee] : [])].some(a => (a.login ?? a.username ?? '').toLowerCase() === me))
          .filter(i => !wantAssignee || [...(i.assignees ?? []), ...(i.assignee ? [i.assignee] : [])].some(a => (a.login ?? a.username ?? '').toLowerCase() === wantAssignee))
          .filter(i => !wantAuthor || (i.user?.login ?? i.user?.username ?? '').toLowerCase() === wantAuthor)
          .map(foldItem);
        return { items, notModified: out.notModified };
      },

      async get(ctx, id) { return foldItem(await readIssue(ctx, id)); },

      async create(ctx, input) {
        const title = cleanTitle(input.title);
        const body = cleanBody(input.body, ISSUE_BODY_MAX).head;
        const labels = await ensureLabels(ctx, input.labels ?? []);
        const res = await write(ctx, {
          method: 'POST', path: `${repoPath(ctx)}/issues`, audit: 'write', ref: 'new-issue',
          json: { title, body, ...(labels.length ? { labels } : {}) },
        }, 'creating the issue', 'Issue: write');
        return foldItem(res.json as RawIssue);
      },

      async update(ctx, id, patch, ifRev) {
        const n = num(id, 'issue');
        const current = await readIssue(ctx, id);
        if ((current.updated_at ?? '') !== ifRev) throw conflict(n, current.updated_at ?? '', ifRev);
        const base = repoPath(ctx);
        const json: Obj = {};
        if (patch.title !== undefined) json.title = cleanTitle(patch.title);
        if (patch.body !== undefined) json.body = cleanBody(patch.body, ISSUE_BODY_MAX).head;
        // `milestone: 0` clears it.
        if (patch.milestone !== undefined) json.milestone = patch.milestone === null ? 0 : num(patch.milestone, 'milestone');
        if (Object.keys(json).length) await write(ctx, { method: 'PATCH', path: `${base}/issues/${n}`, json, audit: 'write', ref: id }, `Issue #${n}`, 'Issue: write');
        // Labels are their own resource here, and a PUT replaces the set; the caller passes the set it wants.
        if (patch.labels) {
          const ids = await ensureLabels(ctx, patch.labels);
          await write(ctx, { method: 'PUT', path: `${base}/issues/${n}/labels`, json: { labels: ids }, audit: 'write', ref: id }, `Issue #${n}`, 'Issue: write');
        }
        // Two writes moved `updated_at`: the caller needs the revision that is true now.
        return foldItem(await readIssue(ctx, id));
      },

      async transition(ctx, id, to, ifRev) {
        const n = num(id, 'issue');
        const current = await readIssue(ctx, id);
        if ((current.updated_at ?? '') !== ifRev) throw conflict(n, current.updated_at ?? '', ifRev);
        const res = await write(ctx, {
          method: 'PATCH', path: `${repoPath(ctx)}/issues/${n}`, audit: 'write', ref: id,
          json: { state: to === 'closed' ? 'closed' : 'open' },
        }, `Issue #${n}`, 'Issue: write');
        return foldItem(res.json as RawIssue);
      },

      async comment(ctx, id, markdown) {
        const n = num(id, 'issue');
        const body = clipText(withoutAttribution(markdown), COMMENT_MAX);
        await write(ctx, {
          method: 'POST', path: `${repoPath(ctx)}/issues/${n}/comments`, audit: 'write', ref: id,
          json: { body: body.overflow ? `${body.head}\n\n… (cut at ${COMMENT_MAX} characters)` : body.head },
        }, `Issue #${n}`, 'Issue: write');
      },

      async addLabels(ctx, id, labels) {
        const n = num(id, 'issue');
        const ids = await ensureLabels(ctx, labels);
        if (!ids.length) return;
        await write(ctx, { method: 'POST', path: `${repoPath(ctx)}/issues/${n}/labels`, json: { labels: ids }, audit: 'write', ref: id }, `Issue #${n}`, 'Issue: write');
      },

      async removeLabel(ctx, id, label) {
        const n = num(id, 'issue');
        const have = await repoLabels(ctx);
        const lid = have.get(sanitizeLine(label, 50));
        if (lid === undefined) return; // not a label of this repository: already the state the caller wanted
        const res = await call(ctx, { method: 'DELETE', path: `${repoPath(ctx)}/issues/${n}/labels/${lid}`, audit: 'write', ref: id });
        // 404/410 on a label that is not on the issue: already the state the caller wanted.
        if (res.status === 404 || res.status === 410) return;
        if (res.status < 200 || res.status >= 300) throw failure(res, `Issue #${n}`, 'Issue: write');
      },
    },

    iterations: {
      async list(ctx) {
        const r = repoOf(ctx);
        const root = ctx.conn.baseUrl.replace(/\/+$/, '');
        const ms = await paged<Obj>(ctx, { path: `${repoPath(ctx)}/milestones`, query: { state: 'all', limit: PAGE } }, j => asArr(j).map(asObj), 'The milestone list', 3);
        const out: Iteration[] = [];
        for (const m of ms.items) {
          if (typeof m.id !== 'number') continue;
          const due = typeof m.due_on === 'string' ? m.due_on : undefined;
          out.push({
            id: String(m.id), title: sanitizeLine(m.title, REMOTE_LIMITS.title), kind: 'milestone', state: m.state === 'closed' ? 'closed' : 'open',
            ...(due ? { end: due } : {}), url: `${root}/${r.owner}/${r.name}/milestone/${m.id}`,
            ...(typeof m.open_issues === 'number' ? { openItems: m.open_issues } : {}),
            ...(typeof m.closed_issues === 'number' ? { closedItems: m.closed_issues } : {}),
          });
        }
        return out;
      },

      async assign(ctx, itemId, iterationId) {
        const n = num(itemId, 'issue');
        await write(ctx, { method: 'PATCH', path: `${repoPath(ctx)}/issues/${n}`, json: { milestone: num(iterationId, 'milestone') }, audit: 'write', ref: itemId }, `Issue #${n}`, 'Issue: write');
      },

      async create(ctx, input) {
        const due = isoOrUndefined(input.end);
        const res = await write(ctx, {
          method: 'POST', path: `${repoPath(ctx)}/milestones`, audit: 'write', ref: 'new-milestone',
          // Milestones have a due date only; a start date has nowhere to go.
          json: { title: cleanTitle(input.title, 250), ...(due ? { due_on: due } : {}) },
        }, 'creating the milestone', 'Issue: write');
        const m = asObj(res.json);
        const r = repoOf(ctx);
        return {
          id: String(m.id ?? ''), title: sanitizeLine(m.title, REMOTE_LIMITS.title), kind: 'milestone' as const, state: 'open' as const,
          ...(typeof m.due_on === 'string' ? { end: m.due_on } : {}), url: `${ctx.conn.baseUrl.replace(/\/+$/, '')}/${r.owner}/${r.name}/milestone/${m.id}`,
        };
      },
    },

    checks: {
      async forCommit(ctx, commit) {
        const statuses = await statusesOf(ctx, sha(commit), 'The commit status');
        return statuses.map(foldStatus);
      },
    },

    protection: { read: readProtection },
  };
}

export const giteaAdapter: ProviderAdapter = makeGiteaAdapter('gitea');
export const forgejoAdapter: ProviderAdapter = makeGiteaAdapter('forgejo');

