/**
 * A pack operation's mapped fields, turned into the shared normalised shapes AICO's sync and
 * landing code read (`PullState`, `RemoteItem`, `Comment`, `RemoteCheck`, `RepoInfo`).
 *
 * WHY a layer of its own. The field map is data the model wrote; this is where that data meets the
 * rules the built-in adapters already live by, so a pack cannot be a weaker adapter by accident:
 *
 *  - **Everything a stranger could have written is sanitised** (titles, bodies, comments, labels,
 *    check names and summaries, logins), exactly as the GitHub fold does: hidden text out, sizes
 *    capped. URLs are http(s) only.
 *  - **A required field that is missing, or an enum value the value map does not cover, is an
 *    error that names the field**, never a default that quietly reads as success. A pull request
 *    state "OPENISH" does not become `open`; an unknown check state does not become `passing`
 *    (it counts as pending, which blocks a merge).
 *  - **`canMerge` can only be narrowed here, never widened.** A connector may say "mergeable";
 *    an open, non-draft pull request with no failing or pending check and nobody asking for
 *    changes is the most this layer lets that mean. A connector with no `canMerge` field is
 *    "merge it on the platform".
 *  - **Association is `NONE` unless the map says otherwise** through a value map the person
 *    reviewed, so review feedback from an unmapped commenter never reaches the agent.
 *  - **The clone URL is checked** (https, no userinfo, one of the pack's hosts) before PR mode can
 *    push to it.
 *
 * This is also what "the contract test checks the normalised output against the shared types"
 * means: the contract test runs operations through these functions and a malformed result fails the
 * operation.
 *
 * @module connections/packs/normalise
 */

import type { CheckState, PullState, RemoteCheck, RepoRef, ReviewState } from '../../../shared/connections/types.js';
import type { Comment, RemoteItem, RepoInfo } from '../adapter.js';
import { ConnectionError } from '../http.js';
import { REMOTE_LIMITS, sanitizeLine, sanitizeRemoteText } from '../sanitize.js';
import { checkState, safeUrl } from '../github/fold.js';
import type { ConnectorManifest, OpName } from './format.js';

type Raw = Record<string, unknown>;
const obj = (x: unknown): Raw => (x && typeof x === 'object' && !Array.isArray(x) ? x as Raw : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

function bad(op: string, field: string, why: string): ConnectionError {
  return new ConnectionError(`The connector's ${op} result is not usable: ${field} ${why}.`, 'http');
}

function text(op: string, field: string, v: unknown, required: boolean, max: number = REMOTE_LIMITS.title): string {
  if (v === undefined || v === null || v === '') { if (required) throw bad(op, field, 'is missing'); return ''; }
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(op, field, 'is not text');
  return sanitizeLine(String(v), max);
}
function body(v: unknown, max: number): string { return typeof v === 'string' ? sanitizeRemoteText(v, max) : ''; }
function strings(v: unknown, max: number, cap = 50): string[] { return arr(v).filter((x): x is string => typeof x === 'string').map(x => sanitizeLine(x, max)).filter(Boolean).slice(0, cap); }
function oneOf<T extends string>(op: string, field: string, v: unknown, allowed: readonly T[], fallback?: T): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  if (fallback !== undefined && (v === undefined || v === null)) return fallback;
  throw bad(op, field, `is ${v === undefined ? 'missing' : JSON.stringify(String(v)).slice(0, 40)}, which the value map does not turn into ${allowed.join(', ')}`);
}
function whole(v: unknown): number | undefined { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 && n <= 1e6 ? Math.floor(n) : undefined; }

// ── pieces ─────────────────────────────────────────────────────────────────

export function normaliseChecks(list: unknown[], op = 'checks.forCommit'): RemoteCheck[] {
  return list.slice(0, 100).map(c => {
    const r = obj(c);
    const state = typeof r.state === 'string' && ['pending', 'success', 'failure', 'neutral', 'skipped'].includes(r.state) ? r.state as RemoteCheck['state'] : 'pending';
    const url = safeUrl(r.url);
    const summary = body(r.summary, REMOTE_LIMITS.summary);
    return { name: text(op, 'name', r.name, true), state, ...(url ? { url } : {}), ...(summary ? { summary } : {}) };
  });
}

export function normalisePull(op: string, raw: Raw, connection: string, now = new Date().toISOString()): PullState {
  const state = oneOf(op, 'state', raw.state, ['open', 'merged', 'closed'] as const);
  const draft = raw.draft === true || raw.draft === 'true';
  const checkItems = normaliseChecks(arr(raw.checks), op);
  const checks = { state: checkState(checkItems) as CheckState, items: checkItems };
  const approved = whole(raw.approved) ?? 0;
  const changes = whole(raw.changesRequested) ?? 0;
  const required = whole(raw.requiredApprovals);
  const need = required ?? 1;
  let rv: ReviewState;
  if (changes > 0) rv = 'changes';
  else if (approved > 0 && approved >= need) rv = 'approved';
  else if ((required !== undefined && required > 0 && approved < required) || (approved > 0 && approved < need)) rv = 'pending';
  else rv = 'none';
  const mergeable = oneOf(op, 'mergeable', raw.mergeable, ['mergeable', 'conflicting', 'unknown'] as const, 'unknown');
  const said = raw.canMerge === true || raw.canMerge === 'true';
  const blockers = strings(raw.mergeBlockers, 240, 10);
  const narrowed = said && state === 'open' && !draft && checks.state !== 'failing' && checks.state !== 'pending' && changes === 0 && mergeable !== 'conflicting';
  if (state === 'open' && !narrowed && blockers.length === 0) {
    if (!said) blockers.push('The connector does not say this can be merged; merge it on the platform.');
    else if (draft) blockers.push('The pull request is a draft.');
    else if (checks.state === 'failing') blockers.push('A check failed.');
    else if (checks.state === 'pending') blockers.push('A check is still running.');
    else if (changes > 0) blockers.push('A reviewer has requested changes.');
    else blockers.push('The branch has conflicts.');
  }
  const url = safeUrl(raw.url) ?? '';
  const mergedSha = text(op, 'mergedSha', raw.mergedSha, false, 64);
  return {
    connection, id: text(op, 'id', raw.id, true, 40), url, state, draft,
    headSha: text(op, 'headSha', raw.headSha, false, 64), mergeable, checks,
    reviews: { state: rv, approved, changesRequested: changes, ...(required !== undefined ? { required } : {}) },
    canMerge: narrowed, mergeBlockers: state === 'open' ? blockers : [],
    ...(state === 'merged' && mergedSha ? { mergedSha } : {}), observedAt: now,
  };
}

export function normaliseComments(list: unknown[]): Comment[] {
  const ASSOC = ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'];
  return list.slice(0, 200).map((c, i) => {
    const r = obj(c);
    const assoc = typeof r.association === 'string' ? r.association.toUpperCase() : 'NONE';
    const review = r.review === 'approved' || r.review === 'changes' || r.review === 'commented' ? r.review : undefined;
    const url = safeUrl(r.url);
    return {
      id: text('pulls.comments', 'id', r.id ?? `c${i}`, true, 60), author: text('pulls.comments', 'author', r.author, false, 80),
      association: ASSOC.includes(assoc) ? assoc : 'NONE',
      body: body(r.body, REMOTE_LIMITS.comment), at: typeof r.at === 'string' ? r.at : '',
      ...(review ? { review } : {}), ...(url ? { url } : {}),
    };
  });
}

export function normaliseItem(op: string, r: Raw): RemoteItem {
  const id = text(op, 'id', r.id, true, 60);
  const num = whole(r.number) ?? whole(r.id) ?? 0;
  const points = whole(r.points);
  return {
    id, number: num, title: text(op, 'title', r.title, true), body: body(r.body, REMOTE_LIMITS.body),
    state: oneOf(op, 'state', r.state, ['open', 'closed'] as const),
    labels: strings(r.labels, REMOTE_LIMITS.label), assignees: strings(r.assignees, 80), author: text(op, 'author', r.author, false, 80),
    url: safeUrl(r.url) ?? '', rev: text(op, 'rev', r.rev, false, 80),
    ...(points !== undefined ? { points } : {}),
  };
}

export function normaliseRepo(op: string, raw: Raw, ref: RepoRef, manifest: ConnectorManifest): RepoInfo {
  let cloneUrl = '';
  if (typeof raw.cloneUrl === 'string' && raw.cloneUrl) {
    try {
      const u = new URL(raw.cloneUrl);
      if (u.protocol === 'https:' && !u.username && !u.password && manifest.hosts.includes(u.host.toLowerCase())) cloneUrl = `${u.origin}${u.pathname}`;
    } catch { /* not a URL: left empty, and PR mode names the fix */ }
  }
  return {
    ref: { owner: ref.owner, name: ref.name, ...(raw.id !== undefined && raw.id !== null ? { id: text(op, 'id', raw.id, false, 60) } : {}) },
    defaultBranch: text(op, 'defaultBranch', raw.defaultBranch, true, 255),
    cloneUrl, htmlUrl: safeUrl(raw.htmlUrl) ?? '', private: raw.private === true,
  };
}

/** What each operation resolves to, by name (used by the contract test to check shape and compare `expect`). */
export function normaliseFor(op: OpName, raw: unknown, ctx: { connection: string; repo?: RepoRef; manifest: ConnectorManifest }): unknown {
  switch (op) {
    case 'probe': { const r = obj(raw); return { user: text(op, 'user', r.user, true, 80), ...(r.version ? { version: text(op, 'version', r.version, false, 40) } : {}) }; }
    case 'repos.get': return normaliseRepo(op, obj(raw), ctx.repo ?? { owner: '', name: '' }, ctx.manifest);
    case 'pulls.find': return raw === undefined ? undefined : normalisePull(op, obj(raw), ctx.connection);
    case 'pulls.create': case 'pulls.get': return normalisePull(op, obj(raw), ctx.connection);
    case 'pulls.comments': return normaliseComments(arr(raw));
    case 'pulls.merge': return { sha: text(op, 'sha', obj(raw).sha, false, 64) };
    case 'items.query': return arr(raw).slice(0, 500).map(i => normaliseItem(op, obj(i)));
    case 'items.get': case 'items.create': case 'items.update': case 'items.transition': return normaliseItem(op, obj(raw));
    case 'checks.forCommit': return normaliseChecks(arr(raw), op);
    case 'pulls.comment': case 'items.comment': return undefined;
  }
}
