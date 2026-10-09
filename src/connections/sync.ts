/**
 * Delivery <-> the remote tracker: import work items, push AICO's own state back, observe pull
 * requests (ADR 0039 section 2).
 *
 * The whole conflict policy is the field-ownership table, and this module is where it is code:
 *
 *  - **People own the item.** Title, body, acceptance, labels and priority are PULLED, and a
 *    pull overwrites the local copy. AICO never edits them on the remote.
 *  - **A person promotes to ready, in AICO.** An imported item lands in the backlog, always. A
 *    remote "ready" label only sets `remote.readyOnRemote`; it never starts spend (ADR 0038).
 *  - **AICO owns its progress.** Running / review / PR-open / blocked are pushed as `aico:*`
 *    labels (names from the project's state map), merged closes the item, and a comment links
 *    the pull request. Only forward from what the remote shows: a closed item is not re-labelled.
 *    AICO never edits a human's comment.
 *  - **Remote wins a conflict.** A write carries the revision it was based on; a mismatch is
 *    counted as a conflict, the intent is dropped, and the next pull shows the remote's truth.
 *  - **A closed item stops work.** Closed or removed upstream while a task runs: the task is
 *    blocked ("closed upstream") and a person decides. A not-yet-started task is cancelled.
 *  - **Everything that comes back is sanitised data** (the adapter does it; the import repeats
 *    it) and the run prompt fences an imported body (delivery/prompts.ts).
 *
 * Writes happen only for a project whose work-item source a person turned on; with it `off` this
 * module only observes pull requests. It never runs a model.
 *
 * What it does not do: decide when to run (poller.ts) or open pull requests (landing.ts).
 *
 * @module connections/sync
 */

import * as D from '../delivery/index.js';
import * as S from '../delivery/store.js';
import type { Task, TaskPriority } from '../delivery/types.js';
import type { AdapterCtx, ProviderAdapter, RemoteItem } from './adapter.js';
import { ConnectionError } from './http.js';
import { observeProject } from './landing.js';
import { REMOTE_LIMITS, sanitizeLine, sanitizeRemoteText } from './sanitize.js';
import { asError, ctxFor } from './service.js';
import * as Store from './store.js';
import { connectionDecision } from '../policy/enforce.js';
import { DEFAULT_STATE_MAP, type BoardConnection, type ProjectMapping, type RemoteLink, type StoredConnection, type SyncStatus } from './types.js';

export interface SyncResult {
  imported: number; updated: number; pushed: number; observed: number; conflicts: number; message?: string;
}

const statuses = new Map<string, SyncStatus>();
const running = new Map<string, Promise<SyncResult>>();

export function syncStatusOf(project: string): SyncStatus { return statuses.get(project) ?? { state: 'idle' }; }

const listeners = new Set<(project: string) => void>();
/** Be told when a project's sync status changes (the server republishes the board so the header chip moves). */
export function onSyncStatus(fn: (project: string) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

export function setSyncStatus(project: string, s: SyncStatus): void {
  statuses.set(project, s);
  for (const fn of listeners) { try { fn(project); } catch { /* a listener must not break a sync */ } }
}

/** What the board header shows of a project's connection; undefined when it has none. */
export function boardConnection(project: string): BoardConnection | undefined {
  const mapping = Store.getMapping(project);
  const conn = mapping ? Store.getConnection(mapping.connection) : undefined;
  if (!mapping || !conn) return undefined;
  const blocked = connectionDecision({ provider: conn.provider, host: new URL(conn.baseUrl).hostname, landing: mapping.landing });
  return {
    connection: conn.id, label: conn.label, provider: conn.provider, repo: `${mapping.repo.owner}/${mapping.repo.name}`,
    landing: mapping.landing, workItems: mapping.workItems.source,
    sync: !blocked.ok ? { state: 'blocked', message: blocked.message } : conn.disabled ? { state: 'idle', message: 'Turned off' } : syncStatusOf(project),
  };
}

/** A board as a client reads it, with its connection (added here so the fold stays free of the network layer). */
export function withConnection<B extends object>(board: B, project: string): B & { connection?: BoardConnection } {
  const c = boardConnection(project);
  return c ? { ...board, connection: c } : board;
}
export function resetSyncForTest(): void { statuses.clear(); running.clear(); }

// ── pure helpers (unit-tested) ───────────────────────────────────────────

/** The `## Acceptance` checklist of an item body, as criteria. */
export function parseAcceptance(body: string): string[] {
  const lines = body.split('\n');
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (/^#{1,6}\s*acceptance\b/i.test(line.trim())) { inside = true; continue; }
    if (inside && /^#{1,6}\s/.test(line.trim())) break;
    if (!inside) continue;
    const m = /^\s*[-*]\s*(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
    if (m && m[1]) out.push(m[1].slice(0, 500));
  }
  return out.slice(0, 20);
}

/** `P1`..`P4`, `priority: high|urgent|critical|low`, `priority/2` as a 1-4 priority. */
export function priorityFromLabels(labels: readonly string[]): TaskPriority | undefined {
  for (const l of labels) {
    const m = /^(?:p|priority[\s:/-]*)([1-4])$/i.exec(l.trim());
    if (m) return Number(m[1]) as TaskPriority;
    const w = /^priority[\s:/-]*(critical|urgent|high|medium|normal|low)$/i.exec(l.trim());
    if (w) return ({ critical: 1, urgent: 1, high: 2, medium: 3, normal: 3, low: 4 } as const)[w[1]!.toLowerCase() as 'critical'];
  }
  return undefined;
}

export const readyOnRemote = (labels: readonly string[]): boolean => labels.some(l => /^(?:aico:)?ready$/i.test(l.trim()));

/** The label AICO shows for a task status, from the project's state map; undefined for open/closed. */
export function stateLabel(status: Task['status'], stateMap: Record<string, string>): string | undefined {
  const key = status === 'changes' ? 'running' : status;
  const v = stateMap[key] ?? DEFAULT_STATE_MAP[key];
  return v && v !== 'open' && v !== 'closed' ? v : undefined;
}

/** The labels AICO manages on an item (everything the state map can produce). */
export function managedLabels(stateMap: Record<string, string>): Set<string> {
  return new Set(Object.values({ ...DEFAULT_STATE_MAP, ...stateMap }).filter(v => v !== 'open' && v !== 'closed'));
}

/** The task fields a pull may overwrite, from a remote item. */
export function fieldsFromItem(item: RemoteItem, stateMap: Record<string, string>): { title: string; body: string; acceptance: string[]; labels: string[]; priority?: TaskPriority } {
  const managed = managedLabels(stateMap);
  const labels = item.labels.filter(l => !managed.has(l) && !/^aico:/i.test(l)).map(l => sanitizeLine(l, REMOTE_LIMITS.label)).filter(Boolean).slice(0, 20);
  const priority = priorityFromLabels(item.labels);
  return {
    title: sanitizeLine(item.title, REMOTE_LIMITS.title) || `Item ${item.number}`,
    body: sanitizeRemoteText(item.body, REMOTE_LIMITS.body),
    acceptance: parseAcceptance(sanitizeRemoteText(item.body, REMOTE_LIMITS.body)),
    labels,
    ...(priority ? { priority } : {}),
  };
}

// ── the sync ─────────────────────────────────────────────────────────────

const TERMINAL: ReadonlySet<Task['status']> = new Set(['merged', 'cancelled']);
const STARTED: ReadonlySet<Task['status']> = new Set(['running', 'review', 'changes', 'pr']);

function linkOf(conn: StoredConnection, item: RemoteItem, _prev?: RemoteLink): RemoteLink {
  const ready = readyOnRemote(item.labels);
  return {
    connection: conn.id, kind: 'item', id: item.id, url: item.url, rev: item.rev, syncedAt: new Date().toISOString(),
    remoteState: item.state, ...(ready ? { readyOnRemote: true } : {}),
  };
}

async function pullItems(project: string, mapping: ProjectMapping, conn: StoredConnection, adapter: ProviderAdapter, ctx: AdapterCtx, r: SyncResult): Promise<Map<string, RemoteItem>> {
  const seen = new Map<string, RemoteItem>();
  if (!adapter.items || mapping.workItems.source === 'off') return seen;
  const me = conn.probe?.user;
  const { items } = await adapter.items.query(ctx, {
    source: mapping.workItems.source, ...(mapping.workItems.value ? { value: mapping.workItems.value } : {}), ...(me ? { me } : {}), state: 'open',
  });
  const tasks = S.boardState(project).tasks;
  const byRemote = new Map(tasks.filter(t => t.remote?.connection === conn.id).map(t => [t.remote!.id, t]));
  for (const item of items) {
    seen.set(item.id, item);
    const existing = byRemote.get(item.id);
    const f = fieldsFromItem(item, mapping.stateMap);
    if (!existing) {
      const created = await D.createTask(project, { title: f.title, body: f.body, acceptance: f.acceptance, labels: f.labels, ...(f.priority ? { priority: f.priority } : {}) });
      S.patchTask(project, created.id, { remote: linkOf(conn, item) });
      S.addComment(project, created.id, 'agent', `Imported from ${item.url}. It is in the backlog; promote it to ready when you want it started.`);
      r.imported++;
      continue;
    }
    if (existing.remote!.rev === item.rev && existing.remote!.remoteState === item.state) {
      const ready = readyOnRemote(item.labels);
      if (ready !== Boolean(existing.remote!.readyOnRemote)) S.patchTask(project, existing.id, { remote: linkOf(conn, item, existing.remote) });
      continue;
    }
    // The remote changed: people own these fields, so the pull wins.
    if (!TERMINAL.has(existing.status)) {
      S.patchTask(project, existing.id, {
        title: f.title, body: f.body, acceptance: f.acceptance, labels: f.labels, ...(f.priority ? { priority: f.priority } : {}),
        remote: linkOf(conn, item, existing.remote),
      }, existing.touches?.predicted ? ['touches'] : []);
    } else {
      S.patchTask(project, existing.id, { remote: linkOf(conn, item, existing.remote) });
    }
    r.updated++;
  }
  // Linked tasks whose item is no longer in the open list: closed or removed upstream.
  let checked = 0;
  for (const t of tasks) {
    if (!t.remote || t.remote.connection !== conn.id || seen.has(t.remote.id) || TERMINAL.has(t.status) || checked >= 30) continue;
    checked++;
    let item: RemoteItem | undefined;
    try { item = await adapter.items.get(ctx, t.remote.id); } catch (e) {
      // Gone (deleted or transferred) reads as closed upstream; any other failure is retried next cycle.
      if (e instanceof ConnectionError && (e.code === 'not-found' || e.status === 404)) item = undefined; else continue;
    }
    if (item && item.state === 'open') { seen.set(item.id, item); continue; }
    if (item) seen.set(item.id, item);
    // Merged work being closed (by the PR, usually) is the normal end; anything else is the remote saying stop.
    S.patchTask(project, t.id, { remote: { ...t.remote, remoteState: 'closed', ...(item ? { rev: item.rev } : {}), syncedAt: new Date().toISOString() } });
    if (STARTED.has(t.status)) {
      await D.updateTask(project, t.id, { status: 'blocked' }, 'agent').catch(() => undefined);
      S.addComment(project, t.id, 'agent', `Closed upstream: ${t.remote.url} was closed on the remote while this task was ${t.status}. It is blocked; decide whether to continue, or cancel it.`);
      r.updated++;
    } else if (t.status === 'backlog' || t.status === 'ready' || t.status === 'blocked') {
      S.patchTask(project, t.id, { status: 'cancelled' });
      S.addComment(project, t.id, 'agent', `Closed upstream: ${t.remote.url} was closed on the remote, so this task was cancelled.`);
      r.updated++;
    }
  }
  return seen;
}

async function pushState(project: string, mapping: ProjectMapping, conn: StoredConnection, adapter: ProviderAdapter, ctx: AdapterCtx, items: Map<string, RemoteItem>, r: SyncResult): Promise<void> {
  if (!adapter.items || mapping.workItems.source === 'off') return;
  const managed = managedLabels(mapping.stateMap);
  for (const t of S.boardState(project).tasks) {
    if (!t.remote || t.remote.connection !== conn.id) continue;
    let item = items.get(t.remote.id);
    if (!item) continue;
    const want = stateLabel(t.status, mapping.stateMap);
    const have = item.labels.filter(l => managed.has(l));
    try {
      // Forward only: a closed item is the remote's final word unless AICO is the one closing it.
      if (item.state === 'open' && want !== undefined && !have.includes(want) && !TERMINAL.has(t.status)) {
        const stale = have.filter(l => l !== want);
        for (const l of stale) await adapter.items.removeLabel(ctx, item.id, l);
        await adapter.items.addLabels(ctx, item.id, [want]);
        if (want === stateLabel('pr', mapping.stateMap) && t.pr) await adapter.items.comment(ctx, item.id, `A pull request was opened for this item: ${t.pr.url}`);
        r.pushed++;
      } else if (item.state === 'open' && want === undefined && have.length > 0 && (t.status === 'backlog' || t.status === 'ready')) {
        for (const l of have) await adapter.items.removeLabel(ctx, item.id, l);
        r.pushed++;
      }
      if (t.status === 'merged' && item.state === 'open') {
        await adapter.items.comment(ctx, item.id, t.pr ? `Merged: ${t.pr.url}` : 'This work was merged.');
        item = await adapter.items.transition(ctx, item.id, 'closed', item.rev);
        items.set(item.id, item);
        S.patchTask(project, t.id, { remote: { ...t.remote, remoteState: 'closed', rev: item.rev, syncedAt: new Date().toISOString() } });
        r.pushed++;
      }
    } catch (e) {
      if (e instanceof ConnectionError && e.code === 'conflict') { r.conflicts++; continue; }
      // One item that cannot be written (gone, or the token cannot write there) must not stop the rest, nor read as a failed sync.
      if (e instanceof ConnectionError && e.code !== 'rate-limited' && e.code !== 'policy' && e.code !== 'auth') { r.message ??= `${t.remote.url}: ${e.message}`; continue; }
      throw e;
    }
  }
}

/** Pull items, push AICO's state, observe pull requests, for one mapped project. Serialised per project. */
export function syncProject(project: string, opts: { signal?: AbortSignal; items?: boolean; prs?: boolean } = {}): Promise<SyncResult> {
  const key = project;
  const prev = running.get(key);
  if (prev) return prev;
  const job = (async (): Promise<SyncResult> => {
    const r: SyncResult = { imported: 0, updated: 0, pushed: 0, observed: 0, conflicts: 0 };
    const mapping = Store.getMapping(project);
    const conn = mapping ? Store.getConnection(mapping.connection) : undefined;
    if (!mapping || !conn) { r.message = 'This project is not connected.'; return r; }
    if (conn.disabled || !conn.credential) { r.message = conn.disabled ? 'The connection is turned off.' : 'The connection has no token yet.'; return r; }
    setSyncStatus(project, { state: 'syncing', at: new Date().toISOString() });
    try {
      const { adapter, ctx } = ctxFor(conn, { repo: mapping.repo, project, ...(opts.signal ? { signal: opts.signal } : {}) });
      const items = opts.items === false ? new Map<string, RemoteItem>() : await pullItems(project, mapping, conn, adapter, ctx, r);
      if (opts.items !== false) await pushState(project, mapping, conn, adapter, ctx, items, r);
      if (opts.prs !== false) {
        const o = await observeProject(project, opts.signal);
        r.observed = o.observed;
        if (o.errors.length > 0) r.message = o.errors[0];
      }
      setSyncStatus(project, { state: 'idle', at: new Date().toISOString(), ...(r.message ? { message: r.message } : {}) });
    } catch (e) {
      const err = asError(e);
      r.message = err.message;
      setSyncStatus(project, {
        state: err.code === 'rate-limited' ? 'rate-limited' : err.code === 'policy' ? 'blocked' : 'error', at: new Date().toISOString(), message: err.message,
      });
    }
    return r;
  })().finally(() => { running.delete(key); });
  running.set(key, job);
  return job;
}
