/**
 * The declarative adapter: the one `ProviderAdapter` registered for provider `custom`, which runs
 * whichever enabled connector pack the connection names (`StoredConnection.pack`).
 *
 * It is a dispatcher, not an interpreter of anything new. Every method is "run this named
 * operation of the pack through runner.ts, then normalise the answer (normalise.ts)"; the
 * adapter itself decides nothing about syncing, pushing or merging, exactly like the built-in ones.
 *
 * What makes a pack weaker than a built-in adapter, said once and honestly (ADR 0039 section 3,
 * point 6):
 *
 *  - It has no cross-endpoint transactions: `items.transition` is one request; "update then
 *    re-read to compare revisions" is not something a manifest can express, so a stale-revision
 *    conflict is whatever the platform itself answers (409/412 become `conflict`).
 *  - Labels do not exist as an operation: `addLabels` / `removeLabel` do nothing, so AICO's
 *    progress shows on the pull request and in comments, not as labels on the platform's items.
 *  - Mergeability is the connector's word, narrowed (normalise.ts); protection and iterations
 *    are not offered at all.
 *  - A surprising API (RPC over one URL, non-JSON, signed requests) needs an MCP server, not a
 *    manifest; an operation may name one tool of such a server.
 *
 * What it ensures instead: an operation runs only if a person approved this exact content AND the
 * operation passed its contract test for that content (runner.ts), so `probe` reports capabilities
 * derived from what actually passed, never from what the file claims.
 *
 * @module connections/packs/adapter
 */

import type { Capabilities, ProbeResult, PullState, RemoteCheck } from '../../../shared/connections/types.js';
import { noCapabilities, type AdapterCtx, type Comment, type NewPull, type ProviderAdapter, type RemoteItem, type RepoInfo } from '../adapter.js';
import { ConnectionError } from '../http.js';
import { sanitizeLine, withoutAttribution } from '../sanitize.js';
import type { StoredConnection } from '../types.js';
import { clipText } from '../github/fold.js';
import { normaliseFor } from './normalise.js';
import { runOperation } from './runner.js';
import { OPS, type OpName } from './format.js';
import { loadPack, requireEnabled, PackError } from './store.js';

const COMMENT_MAX = 30_000;

async function run(ctx: AdapterCtx, op: OpName, input: Record<string, unknown>): Promise<unknown> {
  let pack;
  try { pack = requireEnabled(ctx.conn.pack ?? ''); } catch (e) {
    if (e instanceof PackError) throw new ConnectionError(e.message, 'config');
    throw e;
  }
  // The mapped repository is an input of every repository-scoped operation; an operation without it (probe) never sees it.
  const allowed = OPS[op].inputs as readonly string[];
  const given = { ...(ctx.repo ? { owner: ctx.repo.owner, name: ctx.repo.name } : {}), ...input };
  input = Object.fromEntries(Object.entries(given).filter(([k]) => allowed.includes(k)));
  const raw = await runOperation(op, input, {
    conn: ctx.conn, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.project ? { project: ctx.project } : {}),
    ...(ctx.person ? { person: true } : {}),
  });
  return normaliseFor(op, raw, { connection: ctx.conn.id, ...(ctx.repo ? { repo: ctx.repo } : {}), manifest: pack.report.manifest });
}

/** Does the enabled pack provide this operation, and did it pass its contract for this content? */
export function provides(conn: StoredConnection, op: OpName): boolean {
  const p = loadPack(conn.pack ?? '');
  return !!p && p.status === 'enabled' && !!p.report.manifest?.operations[op] && p.state.tested?.ops[op]?.ok === true;
}

function missing(ctx: AdapterCtx, op: OpName): ConnectionError {
  const label = loadPack(ctx.conn.pack ?? '')?.report.manifest?.label ?? ctx.conn.label;
  return new ConnectionError(`"${label}" does not provide ${op} (or it has not passed its contract test), so AICO cannot do that here.`, 'config');
}

async function ifProvided<T>(ctx: AdapterCtx, op: OpName, input: Record<string, unknown>): Promise<T> {
  // Not approved (or edited since) is a different answer from "this connector has no such operation".
  try { requireEnabled(ctx.conn.pack ?? ''); } catch (e) {
    if (e instanceof PackError) throw new ConnectionError(e.message, 'config');
    throw e;
  }
  if (!provides(ctx.conn, op)) throw missing(ctx, op);
  return await run(ctx, op, input) as T;
}

const idOf = (id: string, what: string): string => {
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(id)) throw new ConnectionError(`"${id.slice(0, 40)}" is not a usable ${what} id.`, 'config');
  return id;
};

function bodyMax(conn: StoredConnection): number {
  return loadPack(conn.pack ?? '')?.report.manifest?.capabilities?.pulls?.bodyMax ?? 4000;
}

export const customAdapter: ProviderAdapter = {
  id: 'custom',

  apiBase(conn) {
    const m = loadPack(conn.pack ?? '')?.report.manifest;
    return (m?.baseUrl ?? conn.baseUrl).replace(/\/+$/, '');
  },
  hostsFor() { return []; },
  clientOptions(conn) {
    const m = loadPack(conn.pack ?? '')?.report.manifest;
    const base = (m?.baseUrl ?? conn.baseUrl).replace(/\/+$/, '');
    if (m?.auth.scheme === 'basic') return { apiBase: base, auth: { kind: 'basic' }, username: conn.username ?? m.auth.username ?? '' };
    if (m?.auth.scheme === 'header' && m.auth.header) return { apiBase: base, auth: { kind: 'header', name: m.auth.header } };
    return { apiBase: base, auth: { kind: 'bearer' } };
  },
  parseRemote() { return undefined; },

  async probe(ctx): Promise<ProbeResult> {
    const pack = (() => { try { return requireEnabled(ctx.conn.pack ?? ''); } catch (e) { if (e instanceof PackError) throw new ConnectionError(e.message, 'config'); throw e; } })();
    const who = await run(ctx, 'probe', {}) as { user: string; version?: string };
    const m = pack.report.manifest;
    const ok = (op: OpName): boolean => pack.state.tested?.ops[op]?.ok === true && !!m.operations[op];
    const caps: Capabilities = noCapabilities();
    caps.repos = ok('repos.get');
    caps.pulls = {
      create: ok('pulls.create') && ok('pulls.get'), comment: ok('pulls.comment'), merge: ok('pulls.merge') && ok('pulls.get'),
      draft: m.capabilities?.pulls?.draft === true, bodyMax: m.capabilities?.pulls?.bodyMax ?? 4000,
    };
    caps.items = {
      query: ok('items.query'), create: ok('items.create'), transition: ok('items.transition'), comment: ok('items.comment'),
      estimate: m.capabilities?.items?.estimate ?? 'none', parentLink: false,
    };
    caps.checks = { read: ok('checks.forCommit') || Boolean(m.operations['pulls.get']?.result?.checks), rerun: false, logsUrl: false };
    const warnings: string[] = [];
    for (const o of pack.report.ops) if (!ok(o.name as OpName)) warnings.push(`The connector's ${o.name} has not passed its contract test and is off.`);
    warnings.push(`This is an agent-built connector ("${m.label}"). It is weaker than a built-in one: no labels, no branch-protection read, no sprints.`);
    return {
      at: new Date().toISOString(), user: who.user, ...(who.version ? { version: who.version } : {}),
      capabilities: caps,
      scopes: {
        found: [],
        needed: [{ scope: m.auth.help ? sanitizeLine(m.auth.help, 300) : 'A token the platform accepts', why: `Sent as ${m.auth.scheme === 'header' ? `the ${m.auth.header} header` : m.auth.scheme === 'basic' ? 'Basic auth' : 'a Bearer token'} to ${m.hosts.join(', ')} only.`, feature: 'repos', required: true }],
        missing: [], extra: [], reported: false,
      },
      warnings,
    };
  },

  repos: {
    async get(ctx, ref) {
      if (!provides(ctx.conn, 'repos.get')) {
        // No repository operation: the mapping still works for work items; PR mode has nowhere to push and says so.
        return { ref, defaultBranch: 'main', cloneUrl: '', htmlUrl: '', private: false } satisfies RepoInfo;
      }
      return run({ ...ctx, repo: ref }, 'repos.get', { owner: ref.owner, name: ref.name }) as Promise<RepoInfo>;
    },
    async list() { return []; },
  },

  pulls: {
    find: (ctx, head) => ifProvided<PullState | undefined>(ctx, 'pulls.find', { head }),
    async create(ctx, input: NewPull) {
      const { head, overflow } = clipText(withoutAttribution(input.body ?? ''), bodyMax(ctx.conn));
      const title = withoutAttribution(input.title).replace(/\s+/g, ' ').trim().slice(0, 250);
      if (!title) throw new ConnectionError('A title is required.', 'config');
      const pull = await ifProvided<PullState>(ctx, 'pulls.create', { head: input.head, base: input.base, title, body: head, draft: input.draft === true });
      return { pull, ...(overflow ? { overflow } : {}) };
    },
    // A pack has no "edit pull request" operation: re-reading is the honest answer.
    update: (ctx, id) => ifProvided<PullState>(ctx, 'pulls.get', { id: idOf(id, 'pull request') }),
    async comment(ctx, id, markdown) {
      const b = clipText(withoutAttribution(markdown), COMMENT_MAX);
      await ifProvided<undefined>(ctx, 'pulls.comment', { id: idOf(id, 'pull request'), body: b.overflow ? `${b.head}\n\n… (cut at ${COMMENT_MAX} characters)` : b.head });
    },
    get: (ctx, id) => ifProvided<PullState>(ctx, 'pulls.get', { id: idOf(id, 'pull request') }),
    comments: (ctx, id) => ifProvided<Comment[]>(ctx, 'pulls.comments', { id: idOf(id, 'pull request') }),
    async merge(ctx, id, opts) {
      if (!/^[0-9a-f]{7,64}$/i.test(opts.sha)) throw new ConnectionError('That is not a commit SHA.', 'config');
      return ifProvided<{ sha: string }>(ctx, 'pulls.merge', { id: idOf(id, 'pull request'), method: opts.method, sha: opts.sha });
    },
  },

  items: {
    async query(ctx, q) {
      if (q.source === 'off') return { items: [], notModified: true };
      const items = await ifProvided<RemoteItem[]>(ctx, 'items.query', {
        source: q.source, ...(q.value ? { value: sanitizeLine(q.value, 256) } : {}), ...(q.since ? { since: q.since } : {}),
        ...(q.me ? { me: q.me } : {}), state: q.state ?? 'open',
      });
      return { items, notModified: false };
    },
    get: (ctx, id) => ifProvided<RemoteItem>(ctx, 'items.get', { id: idOf(id, 'item') }),
    create: (ctx, input) => ifProvided<RemoteItem>(ctx, 'items.create', {
      title: withoutAttribution(input.title).trim().slice(0, 250), body: withoutAttribution(input.body ?? ''), ...(input.labels?.length ? { labels: input.labels.join(',') } : {}),
    }),
    update: (ctx, id, patch, ifRev) => ifProvided<RemoteItem>(ctx, 'items.update', {
      id: idOf(id, 'item'), ...(patch.title !== undefined ? { title: withoutAttribution(patch.title).trim().slice(0, 250) } : {}),
      ...(patch.body !== undefined ? { body: withoutAttribution(patch.body) } : {}), ifRev,
    }),
    transition: (ctx, id, to, ifRev) => ifProvided<RemoteItem>(ctx, 'items.transition', { id: idOf(id, 'item'), to, ifRev }),
    async comment(ctx, id, markdown) {
      const b = clipText(withoutAttribution(markdown), COMMENT_MAX);
      await ifProvided<undefined>(ctx, 'items.comment', { id: idOf(id, 'item'), body: b.head });
    },
    async addLabels() { /* a pack has no label operation */ },
    async removeLabel() { /* a pack has no label operation */ },
  },

  checks: {
    async forCommit(ctx, sha) {
      if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new ConnectionError('That is not a commit SHA.', 'config');
      return ifProvided<RemoteCheck[]>(ctx, 'checks.forCommit', { sha });
    },
  },
};

export { OPS };
