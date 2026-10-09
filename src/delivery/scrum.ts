/**
 * Scrum on the Delivery board: the service that appends sprint events, enforces who may,
 * and builds the reads the routes, the tool and the clients share (ADR 0039 section 4).
 *
 * THE RULE THIS FILE EXISTS TO KEEP. An agent proposes and a person decides, and the
 * "decides" half is in code, not in a prompt: this module has no function an agent's tool
 * reaches that commits a sprint, starts it, closes it or accepts a suggestion. The tool
 * (`tools/delivery.ts`) can only call the `propose*` functions and the pure reads; the
 * routes that commit, start, close or accept sit behind the decision gate
 * (`server/scrum-routes.ts`, `checkHuman`). A suggestion is data in the journal until a
 * person's route turns it into an ordinary edit.
 *
 * Everything here is an appended event or a read of the fold (ADR 0001); nothing is
 * stored that the log cannot back. The daily summary, the review draft and the retro
 * facts are computed from the journal on demand, with no model call.
 *
 * Deliberately not here: the arithmetic (shared/delivery/scrum.ts, so the clients draw
 * the same numbers), the dispatcher's mode gate (scrum-fold `mayStartInMode`), and any
 * model call ("write it up" is not built; the summary is facts).
 *
 * @module delivery/scrum
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_POINTS, burndown, dailyMarkdown, dailySummary, defaultCapacity, isDateKey, memberAt, mergedAt, ms, normalisePoints,
  retroMarkdown, reviewMarkdown, sprintTaskIds, velocity, diffDays,
  type Burndown, type DailySummary, type Proposal, type RetroFacts, type SplitPart, type Sprint, type SprintRemote, type Velocity, type BoardMode,
} from '../../shared/delivery/scrum.js';
import * as G from './git.js';
import { DeliveryError, createTask, updateTask } from './index.js';
import { activeSprint } from './scrum-fold.js';
import * as S from './store.js';
import type { Task } from './types.js';

const MAX_SPRINT_DAYS = 42;
const MAX_OPEN_PROPOSALS = 100;
const TASK_OPEN = new Set(['backlog', 'ready', 'running', 'review', 'changes', 'pr', 'blocked']);
const UNSTARTED = new Set(['backlog', 'ready', 'blocked']);

const clip = (s: unknown, n: number): string => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const isoNow = (): string => new Date().toISOString();

async function board(project: string): Promise<string> {
  const p = path.resolve(project);
  if (!fs.existsSync(S.journalFile(p))) S.ensureInit(p, (await G.currentBranch(p)) ?? 'main');
  return p;
}

function sprintOf(p: string, id: string): Sprint {
  const sp = S.load(p).scrum.sprints.get(id);
  if (!sp) throw new DeliveryError(`no sprint ${id} on this board`, 404);
  return structuredClone(sp);
}

function taskOf(p: string, id: string): Task {
  const t = S.getTask(p, id);
  if (!t) throw new DeliveryError(`no task ${id} on this board`, 404);
  return t;
}

// ── mode, sprints, estimates ─────────────────────────────────────────────

/** Switching modes never loses data: Kanban simply stops looking at sprints. */
export async function setMode(project: string, mode: unknown): Promise<BoardMode> {
  if (mode !== 'kanban' && mode !== 'scrum') throw new DeliveryError('mode must be "kanban" or "scrum"');
  const p = await board(project);
  if (S.load(p).scrum.mode !== mode) S.recordScrum(p, { k: 'mode', mode });
  return mode;
}

export interface SprintInput { name?: unknown; goal?: unknown; start?: unknown; end?: unknown; capacityPoints?: unknown }

export async function createSprint(project: string, input: SprintInput): Promise<Sprint> {
  const p = await board(project);
  const f = S.load(p);
  const planned = [...f.scrum.sprints.values()].find(s => s.status === 'planned');
  if (planned) throw new DeliveryError(`"${planned.name}" is still being planned: commit and start it, or keep planning it, before making another sprint`, 409);
  if (!isDateKey(input.start) || !isDateKey(input.end)) throw new DeliveryError('start and end must be dates like 2026-10-12');
  const length = diffDays(input.start, input.end) + 1;
  if (length < 1) throw new DeliveryError('the sprint cannot end before it starts');
  if (length > MAX_SPRINT_DAYS) throw new DeliveryError(`a sprint is at most ${MAX_SPRINT_DAYS} days; this one is ${length}`);
  const capacity = input.capacityPoints === undefined || input.capacityPoints === null || input.capacityPoints === '' ? undefined : normalisePoints(input.capacityPoints);
  if (input.capacityPoints !== undefined && input.capacityPoints !== null && input.capacityPoints !== '' && capacity === undefined) throw new DeliveryError(`capacity must be a positive number up to ${MAX_POINTS}`);
  const id = S.newTaskId();
  S.recordScrum(p, {
    k: 'sprint', id, name: clip(input.name, 80) || `Sprint ${f.scrum.sprints.size + 1}`, goal: clip(input.goal, 500),
    start: input.start, end: input.end, ...(capacity !== undefined ? { capacityPoints: capacity } : {}),
  });
  return sprintOf(p, id);
}

// ── sprints that mirror a platform's iterations ──────────────────────────

export interface MirroredSprintInput { name: string; start: string; end: string; remote: SprintRemote }

function checkDates(start: unknown, end: unknown): asserts start is string {
  if (!isDateKey(start) || !isDateKey(end)) throw new DeliveryError('start and end must be dates like 2026-10-12');
  const length = diffDays(start, end as string) + 1;
  if (length < 1) throw new DeliveryError('the sprint cannot end before it starts');
  if (length > MAX_SPRINT_DAYS) throw new DeliveryError(`a sprint is at most ${MAX_SPRINT_DAYS} days; this one is ${length}`);
}

/**
 * A planned sprint that mirrors an iteration on a connected platform. The connections layer calls this with
 * plain data (this module stays free of the network). It only ever creates a PLANNED sprint: starting it makes
 * tasks ready, which is spend, and stays a person's act. Several may be planned at once (the current and the
 * next iteration), which `createSprint` refuses for a sprint a person makes by hand.
 */
export async function importMirroredSprint(project: string, input: MirroredSprintInput): Promise<Sprint> {
  const p = await board(project);
  checkDates(input.start, input.end);
  const f = S.load(p);
  const existing = [...f.scrum.sprints.values()].find(x => x.remote?.connection === input.remote.connection && x.remote.id === input.remote.id);
  if (existing) return sprintOf(p, existing.id);
  const id = S.newTaskId();
  S.recordScrum(p, {
    k: 'sprint', id, name: clip(input.name, 80) || `Sprint ${f.scrum.sprints.size + 1}`, goal: '', start: input.start, end: input.end, remote: input.remote,
  });
  return sprintOf(p, id);
}

/** The platform renamed or re-dated a mirrored sprint (it owns both): pull the change in. A no-op when nothing differs. */
export async function syncMirroredSprint(project: string, sprintId: string, patch: { name?: string; start?: string; end?: string; remote: SprintRemote }): Promise<Sprint> {
  const p = await board(project);
  const sp = sprintOf(p, sprintId);
  const name = patch.name !== undefined ? clip(patch.name, 80) : undefined;
  const start = patch.start ?? sp.start;
  const end = patch.end ?? sp.end;
  const datesOk = isDateKey(start) && isDateKey(end) && diffDays(start, end) + 1 >= 1 && diffDays(start, end) + 1 <= MAX_SPRINT_DAYS;
  const changed = sp.status !== 'closed' && ((name && name !== sp.name) || (datesOk && (start !== sp.start || end !== sp.end)));
  const r = sp.remote;
  const linkMoved = !r || r.state !== patch.remote.state || r.timeFrame !== patch.remote.timeFrame || r.url !== patch.remote.url || r.itemKey !== patch.remote.itemKey;
  if (!changed && !linkMoved) return sp;
  S.recordScrum(p, {
    k: 'sprint-sync', sprint: sprintId, remote: patch.remote,
    ...(changed && name && name !== sp.name ? { name } : {}),
    ...(changed && datesOk && start !== sp.start ? { start } : {}), ...(changed && datesOk && end !== sp.end ? { end } : {}),
  });
  return sprintOf(p, sprintId);
}

/**
 * Put tasks in a sprint, or take them out, because the PLATFORM says so (ADR 0039 section 4: membership of
 * imported items is a planning decision made in either place). Unlike {@link commitSprint} it never makes a
 * task ready, even in a running sprint: a remote planning change must not start spend. Joining a running
 * sprint is still recorded as a scope change in the log.
 */
export async function placeFromRemote(project: string, sprintId: string, add: readonly string[] = [], remove: readonly string[] = []): Promise<void> {
  const p = await board(project);
  const sp = sprintOf(p, sprintId);
  if (sp.status === 'closed') return;
  const f = S.load(p);
  const addIds = [...new Set(add)].filter(id => {
    const t = f.tasks.get(id);
    return t && t.status !== 'merged' && t.status !== 'cancelled' && f.scrum.sprintOf.get(id) === undefined;
  });
  const removeIds = [...new Set(remove)].filter(id => f.scrum.sprintOf.get(id) === sprintId);
  if (addIds.length === 0 && removeIds.length === 0) return;
  S.recordScrum(p, { k: 'commit', sprint: sprintId, add: addIds, remove: removeIds });
}

/** Set or clear (`null`) a task's story points. A person's PATCH, or the acceptance of a suggestion. */
export async function setEstimate(project: string, id: string, points: unknown): Promise<Task> {
  const p = await board(project);
  const t = taskOf(p, id);
  if (!TASK_OPEN.has(t.status)) throw new DeliveryError(`task ${id} is ${t.status}; its estimate no longer changes`, 409);
  if (points === null || points === '' || points === undefined) {
    if (t.estimate !== undefined) S.recordScrum(p, { k: 'estimate', task: id, points: null });
    return taskOf(p, id);
  }
  const v = normalisePoints(points);
  if (v === undefined) throw new DeliveryError(`an estimate is a positive number up to ${MAX_POINTS} (the usual scale is 1, 2, 3, 5, 8, 13)`);
  if (v !== t.estimate) S.recordScrum(p, { k: 'estimate', task: id, points: v });
  return taskOf(p, id);
}

/**
 * Commit tasks to a planned or active sprint, or take them out. A PERSON's act: the route
 * is behind the decision gate. Adding to a running sprint is recorded as a scope change,
 * never folded silently into the plan.
 */
export async function commitSprint(project: string, sprintId: string, add: readonly string[] = [], remove: readonly string[] = []): Promise<Sprint> {
  const p = await board(project);
  const sp = sprintOf(p, sprintId);
  if (sp.status === 'closed') throw new DeliveryError(`"${sp.name}" is closed; plan a new sprint`, 409);
  const f = S.load(p);
  const addIds: string[] = [];
  for (const id of new Set(add)) {
    const t = f.tasks.get(id);
    if (!t) throw new DeliveryError(`no task ${id} on this board`, 404);
    if (t.status === 'merged' || t.status === 'cancelled') throw new DeliveryError(`"${t.title}" is ${t.status}; it cannot join a sprint`, 409);
    if (t.sprintId && t.sprintId !== sprintId) throw new DeliveryError(`"${t.title}" is already in another sprint; take it out of that one first`, 409);
    if (t.sprintId !== sprintId) addIds.push(id);
  }
  const removeIds = [...new Set(remove)].filter(id => f.scrum.sprintOf.get(id) === sprintId);
  if (addIds.length === 0 && removeIds.length === 0) return sp;
  S.recordScrum(p, { k: 'commit', sprint: sprintId, add: addIds, remove: removeIds });
  // Joining a running sprint is the same yes as starting it: the tasks are ready for the agents.
  if (sp.status === 'active') for (const id of addIds) if (f.tasks.get(id)?.status === 'backlog') S.patchTask(p, id, { status: 'ready' });
  return sprintOf(p, sprintId);
}

/** Start a planned sprint: its backlog tasks become ready. A person's act (the route is gated). */
export async function startSprint(project: string, sprintId: string): Promise<Sprint> {
  const p = await board(project);
  const sp = sprintOf(p, sprintId);
  if (sp.status !== 'planned') throw new DeliveryError(`"${sp.name}" is ${sp.status}; only a planned sprint can start`, 409);
  const f = S.load(p);
  const running = activeSprint(f.scrum);
  if (running) throw new DeliveryError(`"${running.name}" is still running; close it before starting another`, 409);
  const members = [...f.tasks.values()].filter(t => t.sprintId === sprintId);
  if (members.length === 0) throw new DeliveryError('commit at least one task before starting the sprint', 409);
  S.recordScrum(p, { k: 'start', sprint: sprintId });
  for (const t of members) if (t.status === 'backlog') S.patchTask(p, t.id, { status: 'ready' });
  return sprintOf(p, sprintId);
}

/** Close the active sprint. Unfinished tasks return to the product backlog; running work is never interrupted. A person's act. */
export async function closeSprint(project: string, sprintId: string): Promise<Sprint> {
  const p = await board(project);
  const sp = sprintOf(p, sprintId);
  if (sp.status !== 'active') throw new DeliveryError(`"${sp.name}" is ${sp.status}; only a running sprint can be closed`, 409);
  S.recordScrum(p, { k: 'close', sprint: sprintId });
  const closed = sprintOf(p, sprintId);
  // Ready but never started: back to the backlog with the rest of the carry-over, so the plan, not leftover state, decides what runs next.
  for (const id of closed.result?.carried ?? []) if (S.getTask(p, id)?.status === 'ready') S.patchTask(p, id, { status: 'backlog' });
  return closed;
}

export async function saveNotes(project: string, sprintId: string, kind: unknown, text: unknown): Promise<Sprint> {
  if (kind !== 'review' && kind !== 'retro') throw new DeliveryError('kind must be "review" or "retro"');
  if (typeof text !== 'string') throw new DeliveryError('text required');
  const p = await board(project);
  sprintOf(p, sprintId);
  S.recordScrum(p, { k: 'notes', sprint: sprintId, kind, text: text.slice(0, 40_000) });
  return sprintOf(p, sprintId);
}

// ── refinement: the agent proposes ───────────────────────────────────────

function supersede(p: string, taskId: string, kind: Proposal['kind']): void {
  for (const q of S.load(p).scrum.proposals.values()) if (q.status === 'open' && q.taskId === taskId && q.kind === kind) S.recordScrum(p, { k: 'resolve', id: q.id, status: 'dismissed' });
}

function addProposal(p: string, body: Omit<Proposal, 'id' | 'at' | 'status'>): Proposal {
  const open = [...S.load(p).scrum.proposals.values()].filter(q => q.status === 'open').length;
  if (open >= MAX_OPEN_PROPOSALS) throw new DeliveryError('there are already many open suggestions; accept or dismiss some first', 409);
  supersede(p, body.taskId, body.kind);
  const proposal: Proposal = { ...body, id: S.newTaskId(), at: isoNow(), status: 'open' };
  S.recordScrum(p, { k: 'proposal', proposal });
  return proposal;
}

export async function proposeEstimate(project: string, taskId: string, points: unknown, note?: unknown): Promise<Proposal> {
  const p = await board(project);
  const t = taskOf(p, taskId);
  if (!TASK_OPEN.has(t.status)) throw new DeliveryError(`task ${taskId} is ${t.status}; it cannot be estimated`, 409);
  const v = normalisePoints(points);
  if (v === undefined) throw new DeliveryError(`points must be a positive number up to ${MAX_POINTS} (the usual scale is 1, 2, 3, 5, 8, 13)`);
  return addProposal(p, { kind: 'estimate', taskId, points: v, ...(clip(note, 600) ? { note: clip(note, 600) } : {}) });
}

function parts(v: unknown): SplitPart[] {
  if (!Array.isArray(v) || v.length < 2) throw new DeliveryError('a split needs at least two parts');
  if (v.length > 8) throw new DeliveryError('a split has at most eight parts');
  return v.map((raw, i) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const title = clip(o.title, 200);
    if (!title) throw new DeliveryError(`part ${i + 1} needs a title`);
    const acc = Array.isArray(o.acceptance) ? o.acceptance.map(a => clip(a, 300)).filter(Boolean).slice(0, 10) : [];
    const points = o.points === undefined ? undefined : normalisePoints(o.points);
    if (o.points !== undefined && points === undefined) throw new DeliveryError(`part ${i + 1}: points must be a positive number up to ${MAX_POINTS}`);
    return { title, ...(clip(o.body, 5000) ? { body: clip(o.body, 5000) } : {}), ...(acc.length ? { acceptance: acc } : {}), ...(points !== undefined ? { points } : {}) };
  });
}

export async function proposeSplit(project: string, taskId: string, rawParts: unknown, note?: unknown): Promise<Proposal> {
  const p = await board(project);
  const t = taskOf(p, taskId);
  if (!UNSTARTED.has(t.status)) throw new DeliveryError(`task ${taskId} is ${t.status}; only a task that has not started can be split`, 409);
  return addProposal(p, { kind: 'split', taskId, parts: parts(rawParts), ...(clip(note, 600) ? { note: clip(note, 600) } : {}) });
}

export async function proposeCriteria(project: string, taskId: string, criteria: unknown, note?: unknown): Promise<Proposal> {
  const p = await board(project);
  const t = taskOf(p, taskId);
  if (!UNSTARTED.has(t.status)) throw new DeliveryError(`task ${taskId} is ${t.status}; criteria can be proposed only before it starts`, 409);
  const acc = Array.isArray(criteria) ? criteria.map(a => clip(a, 300)).filter(Boolean).slice(0, 10) : [];
  if (acc.length === 0) throw new DeliveryError('propose at least one acceptance criterion');
  return addProposal(p, { kind: 'criteria', taskId, acceptance: acc, ...(clip(note, 600) ? { note: clip(note, 600) } : {}) });
}

/** A person accepts a suggestion: it becomes the ordinary edit, then is resolved. The route is behind the decision gate. */
export async function acceptProposal(project: string, id: string): Promise<{ proposal: Proposal; created: Task[] }> {
  const p = await board(project);
  const q = S.load(p).scrum.proposals.get(id);
  if (!q) throw new DeliveryError(`no suggestion ${id} on this board`, 404);
  if (q.status !== 'open') throw new DeliveryError(`that suggestion was already ${q.status}`, 409);
  const created: Task[] = [];
  if (q.kind === 'estimate') await setEstimate(p, q.taskId, q.points);
  else if (q.kind === 'criteria') await updateTask(p, q.taskId, { acceptance: q.acceptance }, 'person');
  else {
    const orig = taskOf(p, q.taskId);
    if (!UNSTARTED.has(orig.status)) throw new DeliveryError(`"${orig.title}" is ${orig.status}; it can no longer be split`, 409);
    for (const part of q.parts ?? []) {
      const t = await createTask(p, {
        title: part.title, body: part.body ?? '', acceptance: part.acceptance ?? [], priority: orig.priority, labels: orig.labels, dependsOn: orig.dependsOn,
      });
      if (part.points !== undefined) await setEstimate(p, t.id, part.points);
      created.push(taskOf(p, t.id));
    }
    // Whatever waited for the big item now waits for all of its parts.
    for (const t of S.load(p).tasks.values()) {
      if (t.dependsOn.includes(orig.id) && !created.some(c => c.id === t.id)) {
        S.patchTask(p, t.id, { dependsOn: [...t.dependsOn.filter(d => d !== orig.id), ...created.map(c => c.id)] });
      }
    }
    if (orig.sprintId) await commitSprint(p, orig.sprintId, created.map(c => c.id), [orig.id]);
    S.addComment(p, orig.id, 'agent', `Split into ${created.length} tasks: ${created.map(c => c.title).join('; ')}`.slice(0, 1500));
    await updateTask(p, orig.id, { status: 'cancelled' }, 'person');
  }
  S.recordScrum(p, { k: 'resolve', id, status: 'accepted' });
  return { proposal: structuredClone(S.load(p).scrum.proposals.get(id)!), created: created.map(c => taskOf(p, c.id)) };
}

export async function dismissProposal(project: string, id: string): Promise<Proposal> {
  const p = await board(project);
  const q = S.load(p).scrum.proposals.get(id);
  if (!q) throw new DeliveryError(`no suggestion ${id} on this board`, 404);
  if (q.status === 'open') S.recordScrum(p, { k: 'resolve', id, status: 'dismissed' });
  return structuredClone(S.load(p).scrum.proposals.get(id)!);
}

// ── reads ────────────────────────────────────────────────────────────────

/** The local time zone as minutes east of UTC; routes accept the client's own via `tz`. */
export const localOffsetMin = (): number => -new Date().getTimezoneOffset();

export interface ScrumView {
  mode: BoardMode;
  sprints: Sprint[];
  proposals: Proposal[];
  velocity: Velocity;
  /** The mean of the last three sprints, when there is history. */
  suggestedCapacity?: number;
  active?: { sprint: Sprint; burndown: Burndown };
  daily: DailySummary;
  dailyMarkdown: string;
}

export function scrumView(project: string, now = Date.now(), offsetMin = localOffsetMin()): ScrumView {
  const p = path.resolve(project);
  const f = S.load(p);
  const b = S.boardState(p);
  const tasks = b.tasks;
  const sprints = b.sprints ?? [];
  const active = sprints.find(s => s.status === 'active');
  const daily = dailySummary({ tasks, sprints, now, offsetMin, mode: f.scrum.mode });
  const cap = defaultCapacity(sprints);
  return {
    mode: f.scrum.mode, sprints, proposals: b.proposals ?? [], velocity: velocity(sprints),
    ...(cap !== undefined ? { suggestedCapacity: cap } : {}),
    ...(active ? { active: { sprint: active, burndown: burndown(active, tasks, now, offsetMin) } } : {}),
    daily, dailyMarkdown: dailyMarkdown(daily),
  };
}

export function sprintReview(project: string, sprintId: string, offsetMin = localOffsetMin()): { draft: string; saved?: { text: string; at: string } } {
  const p = path.resolve(project);
  const sp = sprintOf(p, sprintId);
  const draft = reviewMarkdown(sp, S.boardState(p).tasks, offsetMin);
  return { draft, ...(sp.notes?.review ? { saved: sp.notes.review } : {}) };
}

interface RawEvent { t: string; at: string; id?: string; set?: Record<string, unknown>; unset?: string[]; by?: string; text?: string; tree?: string; ok?: boolean }

/** The journal's raw events, for the few facts a fold does not keep (waits, rounds, flaky runs). Torn lines are skipped. */
function rawEvents(p: string): RawEvent[] {
  let text = '';
  try { text = fs.readFileSync(S.journalFile(p), 'utf8'); } catch { return []; }
  const out: RawEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const ev = JSON.parse(line) as RawEvent; if (ev && typeof ev.t === 'string' && typeof ev.at === 'string') out.push(ev); } catch { /* torn line */ }
  }
  return out;
}

/** Facts for a retro, from the log. Exported for the tests; the draft only phrases them. */
export function retroFacts(project: string, sprintId: string, now = Date.now()): RetroFacts {
  const p = path.resolve(project);
  const sp = sprintOf(p, sprintId);
  const tasks = new Map(S.boardState(p).tasks.map(t => [t.id, t]));
  const from = sp.startedAt ? ms(sp.startedAt) : 0;
  const to = sp.closedAt ? ms(sp.closedAt) : now;
  const ids = new Set(sprintTaskIds(sp).filter(id => memberAt(sp, id, to)));
  const events = rawEvents(p).filter(e => ms(e.at) >= from && ms(e.at) <= to);

  let changeRounds = 0; let conflicts = 0; let failedChecks = 0;
  const treeOutcomes = new Map<string, Set<boolean>>();
  const openNeed = new Map<string, number>();
  let waits = 0; let waitMs = 0;
  const closeNeed = (id: string, at: number): void => {
    const since = openNeed.get(id);
    if (since !== undefined) { waits++; waitMs += Math.max(0, at - since); openNeed.delete(id); }
  };
  for (const e of events) {
    if (e.t === 'patch' && e.id && ids.has(e.id)) {
      if (e.set?.status === 'changes') changeRounds++;
      const need = e.set?.needs as { since?: string } | undefined;
      if (need && !openNeed.has(e.id)) openNeed.set(e.id, ms(need.since) || ms(e.at));
      if (e.unset?.includes('needs') || (e.set?.status !== undefined && e.set.status !== 'running')) closeNeed(e.id, ms(e.at));
    } else if (e.t === 'comment' && e.id && ids.has(e.id) && e.by === 'agent' && typeof e.text === 'string') {
      if (/^Rebase conflict/.test(e.text)) conflicts++;
      else if (/^Checks failed/.test(e.text)) failedChecks++;
    } else if (e.t === 'checks' && e.tree) {
      const seen = treeOutcomes.get(e.tree) ?? new Set<boolean>();
      seen.add(e.ok === true);
      treeOutcomes.set(e.tree, seen);
    }
  }
  for (const id of [...openNeed.keys()]) closeNeed(id, to);

  const starts = new Map<string, number>();
  for (const e of rawEvents(p)) if (e.t === 'start' && e.id) { const at = ms(e.at); if (!starts.has(e.id) || at < starts.get(e.id)!) starts.set(e.id, at); }
  const done = [...ids].map(id => tasks.get(id)).filter((t): t is Task => Boolean(t) && mergedAt(t!) !== undefined && mergedAt(t!)! <= to);
  const cycles = done.map(t => ({ t, ms: (mergedAt(t) ?? 0) - (starts.get(t.id) ?? ms(t.createdAt)) })).filter(c => c.ms > 0).sort((a, b) => a.ms - b.ms);
  const median = cycles.length ? cycles[Math.floor((cycles.length - 1) / 2)]!.ms : undefined;
  const longest = cycles.length ? cycles[cycles.length - 1]! : undefined;

  const result = sp.result;
  const committed = result?.committed ?? burndown(sp, [...tasks.values()], now, 0).committed;
  const completed = result?.completed ?? burndown(sp, [...tasks.values()], now, 0).done;
  const costUsd = Math.round(done.reduce((n, t) => n + (t.costUsd ?? 0), 0) * 100) / 100;
  const avg = velocity(S.boardState(p).sprints ?? []).average;
  return {
    sprintId, committed, completed, closed: sp.status === 'closed', added: result?.added ?? 0, carried: result?.carried.length ?? [...ids].filter(id => !done.some(t => t.id === id)).length,
    tasksDone: done.length, tasksTotal: ids.size,
    ...(median !== undefined ? { cycleMedianMs: median } : {}),
    ...(longest ? { cycleLongest: { title: longest.t.title, ms: longest.ms } } : {}),
    changeRounds, conflicts, failedChecks,
    flakyChecks: [...treeOutcomes.values()].filter(s => s.size === 2).length,
    needsWaits: waits, needsWaitMs: waitMs, costUsd,
    ...(completed > 0 && costUsd > 0 ? { costPerPoint: Math.round(costUsd / completed * 100) / 100 } : {}),
    ...(avg !== null ? { velocityAverage: avg } : {}),
  };
}

export function sprintRetro(project: string, sprintId: string, now = Date.now()): { facts: RetroFacts; draft: string; saved?: { text: string; at: string } } {
  const p = path.resolve(project);
  const sp = sprintOf(p, sprintId);
  const facts = retroFacts(p, sprintId, now);
  return { facts, draft: retroMarkdown(sp, facts), ...(sp.notes?.retro ? { saved: sp.notes.retro } : {}) };
}
