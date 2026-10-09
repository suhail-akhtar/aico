/**
 * Iterations <-> sprints, and story points, for any connection (ADR 0039 section 4, phase 5).
 *
 * A platform's iteration (an Azure DevOps team iteration, a GitHub Projects v2 iteration, a
 * milestone) becomes a Scrum SPRINT that mirrors it. This module is provider-generic: an adapter
 * lists `Iteration`s, optionally says which iteration and how many points each item has
 * (`iterations.members`), optionally assigns an item to one (`assign`) or writes points
 * (`items.setEstimate`), and everything else is here.
 *
 * The rules, each a failure it prevents:
 *
 *  - **The platform owns the sprint's name and dates.** A pull refreshes them on every sprint that
 *    is not closed (remote wins). A closed sprint is history and keeps what it had.
 *  - **Importing never starts spend.** Only the current iteration and the next one are imported,
 *    each as a PLANNED sprint. Starting a sprint makes its tasks ready, and that stays a person's
 *    act in AICO. A remote iteration that has ended does not close its sprint; the link says so.
 *  - **AICO creates and deletes no remote iteration** here. (A person's explicit "create on the
 *    platform" is `createRemoteIteration`, called from a human-gated route and nowhere else.)
 *  - **Membership and points are a THREE-WAY merge**, with the value at the last pull as the
 *    base. If the remote changed since then, the remote wins and the local value follows (no
 *    matter what a person did here meanwhile: that is the field-ownership table). If only the
 *    local value changed, a person's planning decision in AICO is pushed, once. Equal, nothing.
 *    Because the base is stored on the task's link (`remote.iteration`, `remote.points`), a
 *    restart or a second machine reaches the same answer from the same facts.
 *  - **A remote planning change never makes a task ready.** Tasks are placed with
 *    `placeFromRemote`, which records a scope change in a running sprint instead of promoting
 *    backlog work (the card says "ready on remote" elsewhere; a person clicks).
 *  - **A task in a sprint made by hand** (not mirrored) is left alone: it is a local decision the
 *    platform knows nothing about.
 *
 * What it does not do: talk HTTP (the adapter does), decide when to sync (the poller), or change
 * a sprint's status.
 *
 * @module connections/iterations
 */

import * as Scrum from '../delivery/scrum.js';
import * as S from '../delivery/store.js';
import type { Sprint } from '../../shared/delivery/scrum.js';
import type { AdapterCtx, Iteration, ProviderAdapter, RemoteItem } from './adapter.js';
import { ConnectionError } from './http.js';
import { asError, ctxFor } from './service.js';
import * as Store from './store.js';
import type { ProjectMapping, RemoteLink, StoredConnection } from './types.js';
import type { SyncResult } from './sync.js';

const MAX_SPRINT_DAYS = 42;

/** The key an item carries to say it is in this iteration. */
export const keyOf = (it: Pick<Iteration, 'id' | 'itemKey'>): string => it.itemKey ?? it.id;

// ── pure: which iterations become sprints ────────────────────────────────

export interface Pick_ { iteration: Iteration; start: string; end: string }

export const isDay = (s: string | undefined): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** A platform's date or timestamp ("2026-10-30T07:00:00Z", a milestone's due date) as the day it falls on. */
const dayOf = (s: string | undefined): string | undefined => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined);
const withDays = (it: Iteration): Iteration => {
  const { start: _s, end: _e, ...rest } = it;
  void _s; void _e;
  const start = dayOf(it.start); const end = dayOf(it.end);
  return { ...rest, ...(start ? { start } : {}), ...(end ? { end } : {}) };
};
const dayMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const spanDays = (a: string, b: string): number => Math.round((dayMs(b) - dayMs(a)) / 86_400_000) + 1;

/**
 * The iterations to import: the CURRENT one and the NEXT one, as sprints with dates.
 *  - An iteration with start and end: current when today is inside it (or the platform says so),
 *    next when it is the earliest to start after today.
 *  - A milestone (a due date only): the sprint runs from today to the due date; the two soonest
 *    open milestones that are still ahead become current and next.
 * One that is closed/past, undated, or longer than a sprint can be is skipped; `skipped` says why,
 * so a person sees "Release 2027 is 365 days long" instead of a silent gap.
 */
export function pickToImport(list: readonly Iteration[], today: string): { picks: Pick_[]; skipped: string[] } {
  const skipped: string[] = [];
  const open = list.filter(i => i.state === 'open' && i.timeFrame !== 'past');
  const dated: Pick_[] = [];
  const milestones: Pick_[] = [];
  // The platform's own word for where an iteration is in time wins over this machine's clock.
  const ended = (it: Iteration, end: string): boolean => it.timeFrame === undefined && end < today;
  for (const it of open) {
    const start = isDay(it.start) ? it.start : undefined;
    const end = isDay(it.end) ? it.end : undefined;
    if (it.kind === 'milestone' || (!start && end)) {
      if (!end || end < today) continue;
      if (spanDays(today, end) > MAX_SPRINT_DAYS) { skipped.push(`"${it.title}" ends ${spanDays(today, end) - 1} days from now, longer than a sprint can be`); continue; }
      milestones.push({ iteration: it, start: today, end });
      continue;
    }
    if (!start || !end) { skipped.push(`"${it.title}" has no dates`); continue; }
    if (ended(it, end)) continue;
    if (spanDays(start, end) > MAX_SPRINT_DAYS) { skipped.push(`"${it.title}" is ${spanDays(start, end)} days long, longer than a sprint can be`); continue; }
    dated.push({ iteration: it, start, end });
  }
  const picks: Pick_[] = [];
  const current = dated.filter(p => p.iteration.timeFrame === 'current' || (p.start <= today && today <= p.end)).sort((a, b) => b.start.localeCompare(a.start))[0];
  if (current) picks.push(current);
  const next = dated.filter(p => p !== current && (p.iteration.timeFrame === 'future' || p.start > today)).sort((a, b) => a.start.localeCompare(b.start))[0];
  if (next) picks.push(next);
  if (picks.length === 0) picks.push(...milestones.sort((a, b) => a.end.localeCompare(b.end)).slice(0, 2));
  return { picks, skipped };
}

export type Merge = 'none' | 'pull' | 'push';

/**
 * Three-way merge of one value. `base` is what both sides had at the last sync, `remote` and
 * `local` what they have now. Remote wins when it moved; a local change is pushed only when the
 * remote did not move.
 */
export function mergeValue<T>(base: T | undefined, remote: T | undefined, local: T | undefined): Merge {
  if (remote !== base) return 'pull';
  if (local !== base) return 'push';
  return 'none';
}

// ── the sync ─────────────────────────────────────────────────────────────

let todayOverride: string | undefined;
/** Tests: pin "today" (a date-based pick would otherwise depend on the wall clock). */
export function setTodayForTest(day: string | undefined): void { todayOverride = day; }
const localDay = (d = new Date()): string => todayOverride ?? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const OPEN = new Set(['planned', 'active']);

function sprintsOf(project: string, conn: StoredConnection): Sprint[] {
  return (S.boardState(project).sprints ?? []).filter(s => s.remote?.connection === conn.id);
}

function remoteOf(conn: StoredConnection, it: Iteration, now: string): NonNullable<Sprint['remote']> {
  return {
    connection: conn.id, id: it.id, kind: it.kind, ...(it.itemKey ? { itemKey: it.itemKey } : {}),
    ...(it.url ? { url: it.url } : {}), ...(it.timeFrame ? { timeFrame: it.timeFrame } : {}), state: it.state, syncedAt: now,
  };
}

/**
 * Mirror the platform's current and next iteration as planned sprints, refresh the sprints already
 * mirrored, and merge task membership and story points. Does nothing unless a person turned
 * sprint sync on for the project (`iterations: 'native'`) and the adapter lists iterations.
 */
export async function syncIterations(
  project: string, mapping: ProjectMapping, conn: StoredConnection, adapter: ProviderAdapter, ctx: AdapterCtx,
  items: Map<string, RemoteItem>, r: SyncResult,
): Promise<void> {
  if (mapping.iterations !== 'native' || !adapter.iterations) return;
  let list: Iteration[];
  try { list = (await adapter.iterations.list(ctx)).map(withDays); } catch (e) {
    if (e instanceof ConnectionError && e.code !== 'rate-limited' && e.code !== 'policy' && e.code !== 'auth' && e.code !== 'credential') {
      r.message ??= `Sprints could not be read: ${e.message}`;
      return;
    }
    throw e;
  }
  const nowIso = new Date().toISOString();
  const today = localDay();
  let touched = 0;

  // 1. Import the current and next iteration; refresh every mirrored sprint that still exists remotely.
  const { picks, skipped } = pickToImport(list, today);
  const mirrored = new Map(sprintsOf(project, conn).map(s => [s.remote!.id, s]));
  for (const p of picks) {
    if (mirrored.has(p.iteration.id)) continue;
    await Scrum.importMirroredSprint(project, { name: p.iteration.title, start: p.start, end: p.end, remote: remoteOf(conn, p.iteration, nowIso) });
    touched++;
  }
  if (skipped.length) r.message ??= `Not imported as sprints: ${skipped.slice(0, 3).join('; ')}.`;
  const byId = new Map(list.map(i => [i.id, i]));
  for (const sp of sprintsOf(project, conn)) {
    const it = byId.get(sp.remote!.id);
    if (!it) continue;
    if (sp.status === 'closed') continue; // history keeps its name and dates
    const dated = isDay(it.start) && isDay(it.end);
    // A milestone only knows its end: the sprint keeps the day it started and follows the due date.
    const patch = {
      name: it.title,
      ...(dated ? { start: it.start!, end: it.end! } : isDay(it.end) ? { end: it.end! } : {}),
      remote: remoteOf(conn, it, nowIso),
    };
    const before = JSON.stringify([sp.name, sp.start, sp.end, sp.remote?.state, sp.remote?.timeFrame, sp.remote?.url, sp.remote?.itemKey]);
    const after = await Scrum.syncMirroredSprint(project, sp.id, patch);
    if (JSON.stringify([after.name, after.start, after.end, after.remote?.state, after.remote?.timeFrame, after.remote?.url, after.remote?.itemKey]) !== before) touched++;
  }

  // 2. Membership and points, task by task, for items this pass has seen.
  let overlay: Map<string, { iteration?: string; points?: number }> | undefined;
  if (adapter.iterations.members) {
    try { overlay = await adapter.iterations.members(ctx); } catch (e) {
      if (e instanceof ConnectionError && (e.code === 'rate-limited' || e.code === 'policy' || e.code === 'auth' || e.code === 'credential')) throw e;
      r.message ??= `Sprint membership could not be read: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const sprints = sprintsOf(project, conn);
  const sprintByKey = new Map(sprints.filter(s => OPEN.has(s.status)).map(s => [s.remote!.itemKey ?? s.remote!.id, s]));
  const sprintById = new Map((S.boardState(project).sprints ?? []).map(s => [s.id, s]));
  // Milestones are read off the item; anything else comes from the item's own iteration or the platform's overlay.
  const milestoneSprints = sprintByKey.size > 0 && [...sprintByKey.values()].every(s => s.remote!.kind === 'milestone');
  // An adapter that keeps membership elsewhere and could not read it this pass must not make "unknown" look like "none".
  const membershipKnown = !adapter.iterations.members || overlay !== undefined || milestoneSprints;

  for (const t of S.boardState(project).tasks) {
    if (!t.remote || t.remote.connection !== conn.id || t.status === 'merged' || t.status === 'cancelled') continue;
    let item = items.get(t.remote.id);
    if (!item) continue;
    const extra = overlay?.get(item.id);
    const remoteKey = item.iteration ?? extra?.iteration ?? (milestoneSprints ? item.milestone?.id : undefined);
    const remotePoints = item.points ?? extra?.points;
    let link = t.remote;
    let changed = false;

    // Membership.
    const here = t.sprintId ? sprintById.get(t.sprintId) : undefined;
    const mirroredHere = here?.remote?.connection === conn.id ? here : undefined;
    const handMade = here !== undefined && mirroredHere === undefined;
    const localKey = mirroredHere ? mirroredHere.remote!.itemKey ?? mirroredHere.remote!.id : undefined;
    const move: Merge = membershipKnown ? mergeValue(link.iteration, remoteKey, localKey) : 'none';
    if (move === 'pull') {
      if (!handMade) {
        const target = remoteKey !== undefined ? sprintByKey.get(remoteKey) : undefined;
        if (mirroredHere && target?.id !== mirroredHere.id) await Scrum.placeFromRemote(project, mirroredHere.id, [], [t.id]);
        if (target && target.id !== mirroredHere?.id) await Scrum.placeFromRemote(project, target.id, [t.id], []);
        if ((target?.id ?? undefined) !== mirroredHere?.id) {
          S.addComment(project, t.id, 'agent', target ? `Moved into "${target.name}" because ${conn.label} has it there.` : `Taken out of its sprint because ${conn.label} no longer has it in one.`);
          touched++;
        }
      }
      link = withBase(link, 'iteration', remoteKey);
      changed = true;
    } else if (move === 'push' && localKey !== undefined && adapter.iterations.assign) {
      const it = list.find(i => keyOf(i) === localKey);
      if (it) {
        try {
          const w = await adapter.iterations.assign(ctx, item.id, it.id, it);
          // The write moved the item's revision: the estimate push below must carry the new one.
          if (w && w.rev) { item = { ...item, rev: w.rev }; items.set(item.id, item); }
          link = withBase(link, 'iteration', localKey);
          changed = true;
          r.pushed++;
        } catch (e) {
          if (!(e instanceof ConnectionError) || e.code === 'rate-limited' || e.code === 'policy' || e.code === 'auth') throw e;
          r.message ??= `${t.remote.url}: ${e.message}`;
        }
      }
    }

    // Story points.
    const est = mergeValue(link.points, remotePoints, t.estimate);
    if (est === 'pull') {
      try {
        await Scrum.setEstimate(project, t.id, remotePoints ?? null);
        link = withBase(link, 'points', remotePoints);
        changed = true;
      } catch { /* a value the board rejects (zero, negative, huge) stays on the remote only */ }
    } else if (est === 'push' && t.estimate !== undefined && adapter.items?.setEstimate) {
      try {
        const out = await adapter.items.setEstimate(ctx, item.id, t.estimate, item.rev);
        items.set(out.id, out);
        link = { ...withBase(link, 'points', t.estimate), rev: out.rev };
        changed = true;
        r.pushed++;
      } catch (e) {
        if (e instanceof ConnectionError && e.code === 'conflict') { r.conflicts++; continue; }
        if (!(e instanceof ConnectionError) || e.code === 'rate-limited' || e.code === 'policy' || e.code === 'auth') throw e;
        r.message ??= `${t.remote.url}: ${e.message}`;
      }
    }
    if (changed) S.patchTask(project, t.id, { remote: link });
  }
  if (touched) r.sprints = (r.sprints ?? 0) + touched;
}

/** The link with its merge base for `key` set (or cleared). */
function withBase(link: RemoteLink, key: 'iteration' | 'points', value: string | number | undefined): RemoteLink {
  const next: RemoteLink = { ...link };
  if (key === 'iteration') { if (typeof value === 'string') next.iteration = value; else delete next.iteration; }
  else if (typeof value === 'number') next.points = value; else delete next.points;
  return next;
}

// ── a person's click: create the sprint on the platform ───────────────────

/**
 * Create an iteration on the platform for a local sprint and link them. Called ONLY from a
 * human-gated route (a person ticked "create on <platform>"); the sync never calls it.
 */
export async function createRemoteIteration(project: string, sprintId: string): Promise<{ iteration: Iteration; sprint: Sprint }> {
  const mapping = Store.getMapping(project);
  const conn = mapping ? Store.getConnection(mapping.connection) : undefined;
  if (!mapping || !conn) throw new ConnectionError('This project is not connected.', 'config');
  const { adapter, ctx } = ctxFor(conn, { repo: mapping.repo, project });
  if (!adapter.iterations?.create) throw new ConnectionError(`${conn.label} cannot create sprints from here.`, 'config');
  const sp = (S.boardState(project).sprints ?? []).find(s => s.id === sprintId);
  if (!sp) throw new ConnectionError(`There is no sprint ${sprintId} on this board.`, 'not-found', 404);
  if (sp.remote) throw new ConnectionError(`"${sp.name}" already mirrors an iteration on ${conn.label}.`, 'conflict', 409);
  try {
    const it = await adapter.iterations.create(ctx, { title: sp.name, start: sp.start, end: sp.end });
    const linked = await Scrum.syncMirroredSprint(project, sprintId, { remote: remoteOf(conn, it, new Date().toISOString()) });
    return { iteration: it, sprint: linked };
  } catch (e) {
    throw e instanceof ConnectionError ? e : new ConnectionError(asError(e).message, 'http');
  }
}
