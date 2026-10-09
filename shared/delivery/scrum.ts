/**
 * Scrum as a mode of the Delivery board: the wire types and every pure rule, shared
 * by the engine (journal fold, routes, tool) and the clients (charts, the plan dialog,
 * the daily summary), so a number on screen and a number in a route are the same
 * number (ADR 0039 section 4).
 *
 * WHY HERE AND PURE. Burndown, velocity, capacity and the planning proposal are
 * arithmetic over facts the journal already holds (sprint membership with timestamps,
 * a task's estimate, when it merged). If they lived only in the engine, every chart
 * would need another round trip and a drifting second implementation in the client;
 * if they lived only in the client, an agent or a notification could not read them.
 * Taking `now` and a time-zone offset as arguments (never reading a clock) is what
 * makes them testable against fixed journals: the same folds, the same answers.
 *
 * What a sprint is here, and is not: a time box with a goal, a set of estimated tasks
 * and a status (planned, active, closed). It is not a second board and not a second
 * status on a task: a task is still backlog / ready / running / review / merged, and a
 * sprint only says which of them the team committed to. Estimates are story points on
 * the task; nothing converts them to hours or money.
 *
 * Deliberately not here: anything with a side effect (the engine's `delivery/scrum.ts`
 * appends the events and enforces who may), the daily "write it up" model call (the
 * summary is built from facts, with no model), and any remote tracker mapping (ADR 0039
 * section 3 owns the points field of each platform).
 *
 * @module shared/delivery/scrum
 */

import type { Task } from './types.js';

export type BoardMode = 'kanban' | 'scrum';
export type SprintStatus = 'planned' | 'active' | 'closed';

/** The scale the UI offers. Any positive number up to {@link MAX_POINTS} is accepted: a team's own scale is theirs. */
export const POINT_SCALE: readonly number[] = [1, 2, 3, 5, 8, 13];
export const MAX_POINTS = 100;
/** Without any history a first sprint still needs a number to plan against; it is labelled as a starter, never as data. */
export const STARTER_CAPACITY = 20;
/** At or above this many points an item is a candidate to split before it is committed. */
export const SPLIT_AT = 13;

/** One change to what the sprint is committed to; `points` is signed so the sum is the scope. */
export interface ScopeEntry {
  at: string;
  taskId: string;
  points: number;
  /** `commit`: part of the plan; `add` / `remove`: scope that moved after the plan; `estimate`: a member re-estimated. */
  kind: 'commit' | 'add' | 'remove' | 'estimate';
}

/** What a closed sprint delivered, frozen at the moment it closed. */
export interface SprintResult {
  committed: number;
  completed: number;
  /** Points added after the sprint started (never hidden: a step on the burndown). */
  added: number;
  removed: number;
  /** Merged tasks that carried no estimate: they count as 0 and the page says how many. */
  unestimatedMerged: number;
  doneIds: string[];
  /** Not finished at close; they went back to the product backlog. */
  carried: string[];
}

/**
 * Where a sprint came from when it mirrors an iteration or milestone on a connected platform (ADR 0039
 * section 4). The platform owns the name and the dates; AICO owns everything else about the sprint
 * (committing, starting, closing, the plan). Absent for a sprint made here.
 */
export interface SprintRemote {
  connection: string;
  /** The platform's id for the iteration or milestone. */
  id: string;
  kind: 'iteration' | 'milestone';
  /** What an item carries to say it belongs to this iteration, when that is not `id` (an Azure DevOps path). */
  itemKey?: string;
  url?: string;
  /** Where the platform says it is in time (Azure DevOps team iterations). */
  timeFrame?: 'past' | 'current' | 'future';
  /** The platform closed or finished it. Closing the sprint here stays a person's act. */
  state: 'open' | 'closed';
  syncedAt: string;
}

export interface Sprint {
  id: string;
  name: string;
  goal: string;
  /** YYYY-MM-DD, in the planner's local calendar. */
  start: string;
  end: string;
  capacityPoints?: number;
  status: SprintStatus;
  createdAt: string;
  committedAt?: string;
  startedAt?: string;
  closedAt?: string;
  scope: ScopeEntry[];
  result?: SprintResult;
  /** Present when the sprint mirrors a platform iteration or milestone. */
  remote?: SprintRemote;
  /** Saved notes: edited by people, never generated into the log without a person saving them. */
  notes?: { review?: { text: string; at: string }; retro?: { text: string; at: string } };
}

export type ProposalKind = 'estimate' | 'split' | 'criteria';
export interface SplitPart { title: string; body?: string; acceptance?: string[]; points?: number }

/** What an agent suggests during refinement. Data until a person accepts it. */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  taskId: string;
  at: string;
  note?: string;
  status: 'open' | 'accepted' | 'dismissed';
  resolvedAt?: string;
  points?: number;
  parts?: SplitPart[];
  acceptance?: string[];
}

// ── dates ────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch ms from an ISO string or number; 0 when unreadable. */
export function ms(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) { const d = Date.parse(v); if (Number.isFinite(d)) return d; }
  return 0;
}

export function isDateKey(v: unknown): v is string {
  return typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
}

/** The calendar day of an instant for a time zone given as minutes east of UTC (IST is 330). */
export function dayKey(at: number, offsetMin = 0): string { return new Date(at + offsetMin * 60_000).toISOString().slice(0, 10); }
export function dayStart(key: string, offsetMin = 0): number { return Date.parse(`${key}T00:00:00.000Z`) - offsetMin * 60_000; }
export function dayEnd(key: string, offsetMin = 0): number { return dayStart(key, offsetMin) + DAY - 1; }
export function addDays(key: string, n: number): string { return new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10); }
export function diffDays(a: string, b: string): number { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY); }
export function isWorkday(key: string): boolean { const d = new Date(`${key}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6; }
/** The working day before `key` (Monday looks back to Friday). */
export function previousWorkday(key: string): string {
  let k = addDays(key, -1);
  for (let i = 0; i < 7 && !isWorkday(k); i++) k = addDays(k, -1);
  return k;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "9 Oct" for a day key. */
export function shortDate(key: string): string {
  const [, m, d] = key.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''}`.trim();
}

// ── tasks ────────────────────────────────────────────────────────────────

export const pointsOf = (t: Pick<Task, 'estimate'> | undefined): number => (t?.estimate && t.estimate > 0 ? t.estimate : 0);

/** When a task landed, or undefined while it has not. */
export function mergedAt(t: Pick<Task, 'status' | 'landed' | 'updatedAt'>): number | undefined {
  if (t.status !== 'merged') return undefined;
  return ms(t.landed?.at) || ms(t.updatedAt) || undefined;
}

/** Valid estimate or undefined: positive, at most {@link MAX_POINTS}, in steps of 0.5. */
export function normalisePoints(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_POINTS) return undefined;
  return Math.round(n * 2) / 2;
}

/** What a backlog item still needs before it can be planned. */
export function refinementGaps(t: Pick<Task, 'estimate' | 'acceptance'>): Array<'estimate' | 'acceptance' | 'split'> {
  const gaps: Array<'estimate' | 'acceptance' | 'split'> = [];
  if (!t.estimate) gaps.push('estimate');
  if (!t.acceptance || t.acceptance.length === 0) gaps.push('acceptance');
  if ((t.estimate ?? 0) >= SPLIT_AT) gaps.push('split');
  return gaps;
}

// ── scope ────────────────────────────────────────────────────────────────

export function scopeAt(sprint: Pick<Sprint, 'scope'>, cutoff = Infinity): number {
  let n = 0;
  for (const e of sprint.scope) if (ms(e.at) <= cutoff) n += e.points;
  return round(n);
}

export function taskPointsIn(sprint: Pick<Sprint, 'scope'>, taskId: string, cutoff = Infinity): number {
  let n = 0;
  for (const e of sprint.scope) if (e.taskId === taskId && ms(e.at) <= cutoff) n += e.points;
  return round(n);
}

/** Every task that was ever part of the sprint's scope, in first-seen order. */
export function sprintTaskIds(sprint: Pick<Sprint, 'scope'>): string[] {
  const seen = new Set<string>();
  for (const e of sprint.scope) seen.add(e.taskId);
  return [...seen];
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Whether a task was part of the sprint at that moment: its last commit/add/remove entry is not a remove. */
export function memberAt(sprint: Pick<Sprint, 'scope'>, taskId: string, cutoff = Infinity): boolean {
  let member = false;
  for (const e of sprint.scope) {
    if (e.taskId !== taskId || ms(e.at) > cutoff) continue;
    if (e.kind === 'commit' || e.kind === 'add') member = true;
    else if (e.kind === 'remove') member = false;
  }
  return member;
}

/** Points of members cancelled by that moment: a dropped task is removed scope, not remaining work (its cancel time is the task's last update). */
function cancelledAt(sprint: Pick<Sprint, 'scope'>, byId: ReadonlyMap<string, Task>, cutoff: number): number {
  let n = 0;
  for (const id of sprintTaskIds(sprint)) {
    const t = byId.get(id);
    if (t?.status === 'cancelled' && ms(t.updatedAt) <= cutoff && memberAt(sprint, id, cutoff)) n += taskPointsIn(sprint, id, cutoff);
  }
  return round(n);
}

/** The sprint's scope at a moment: what was committed and re-estimated, less what was cancelled. */
export function scopeNet(sprint: Pick<Sprint, 'scope'>, byId: ReadonlyMap<string, Task>, cutoff = Infinity): number {
  return round(scopeAt(sprint, cutoff) - cancelledAt(sprint, byId, cutoff));
}

function doneAt(sprint: Pick<Sprint, 'scope'>, byId: ReadonlyMap<string, Task>, cutoff: number): number {
  let n = 0;
  for (const id of sprintTaskIds(sprint)) {
    const at = byId.get(id) ? mergedAt(byId.get(id)!) : undefined;
    if (at !== undefined && at <= cutoff) n += taskPointsIn(sprint, id, cutoff);
  }
  return round(n);
}

/** The numbers frozen into a sprint at the moment it closes (the engine's fold calls this at replay time). */
export function computeResult(sprint: Pick<Sprint, 'scope' | 'startedAt'>, tasks: readonly Task[], closedAt: number): SprintResult {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const started = sprint.startedAt ? ms(sprint.startedAt) : Infinity;
  let added = 0; let removed = 0;
  for (const e of sprint.scope) {
    if (ms(e.at) <= started || ms(e.at) > closedAt) continue;
    if (e.points > 0) added += e.points; else removed += -e.points;
  }
  const doneIds: string[] = []; const carried: string[] = []; let unestimatedMerged = 0;
  for (const id of sprintTaskIds(sprint)) {
    const t = byId.get(id);
    if (!t || !memberAt(sprint, id, closedAt) || t.status === 'cancelled') continue;
    const at = mergedAt(t);
    if (at !== undefined && at <= closedAt) { doneIds.push(id); if (!t.estimate) unestimatedMerged++; } else carried.push(id);
  }
  return {
    committed: scopeNet(sprint, byId, started), completed: doneAt(sprint, byId, closedAt), added: round(added),
    removed: round(removed + cancelledAt(sprint, byId, closedAt) - cancelledAt(sprint, byId, started)),
    unestimatedMerged, doneIds, carried,
  };
}

// ── burndown ─────────────────────────────────────────────────────────────

export interface BurndownPoint {
  /** 0 is the start of the sprint; 1 is the end of its first day. */
  day: number;
  date: string;
  /** Points still to do at the end of that day; null for days that have not happened. */
  remaining: number | null;
  ideal: number;
  scope: number;
  done: number;
}

export type PaceStatus = 'not-started' | 'ahead' | 'on-track' | 'behind' | 'closed';

export interface Burndown {
  sprintId: string;
  start: string;
  end: string;
  committed: number;
  days: number;
  workdays: number;
  points: BurndownPoint[];
  /** The index in `points` of today, or null outside the sprint. */
  todayIndex: number | null;
  scope: number;
  done: number;
  remaining: number;
  /** Where the ideal line stands at the end of the previous day (what should be done before today starts). */
  ideal: number;
  /** remaining minus ideal: positive is behind. */
  delta: number;
  status: PaceStatus;
  /** Scope that moved after the sprint started, for the step annotations. */
  scopeChanges: Array<{ date: string; at: string; taskId: string; points: number; kind: ScopeEntry['kind'] }>;
}

export function burndown(sprint: Sprint, tasks: readonly Task[], now: number, offsetMin = 0): Burndown {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const closedMs = sprint.closedAt ? ms(sprint.closedAt) : Infinity;
  const startedMs = sprint.startedAt ? ms(sprint.startedAt) : undefined;
  const committed = scopeNet(sprint, byId, startedMs ?? Infinity);
  const days = Math.max(1, diffDays(sprint.start, sprint.end) + 1);
  const dates = Array.from({ length: days }, (_, i) => addDays(sprint.start, i));
  const workdays = dates.filter(isWorkday).length;
  const today = dayKey(Math.min(now, closedMs === Infinity ? now : closedMs), offsetMin);
  const horizon = sprint.status === 'planned' ? -Infinity : Math.min(now, closedMs);

  let worked = 0;
  const points: BurndownPoint[] = [{ day: 0, date: sprint.start, remaining: sprint.status === 'planned' ? null : committed, ideal: committed, scope: committed, done: 0 }];
  dates.forEach((date, i) => {
    if (isWorkday(date)) worked++;
    const idealFraction = workdays > 0 ? worked / workdays : (i + 1) / days;
    const cutoff = Math.min(dayEnd(date, offsetMin), closedMs);
    const happened = dayStart(date, offsetMin) <= horizon;
    const scope = scopeNet(sprint, byId, Math.min(cutoff, happened ? horizon : cutoff));
    const done = doneAt(sprint, byId, Math.min(cutoff, happened ? horizon : cutoff));
    points.push({
      day: i + 1, date, remaining: happened ? round(Math.max(0, scope - done)) : null,
      ideal: round(Math.max(0, committed * (1 - idealFraction))), scope, done,
    });
  });

  const idx = dates.indexOf(today);
  const todayIndex = idx >= 0 && sprint.status !== 'planned' ? idx + 1 : null;
  const scope = scopeNet(sprint, byId, horizon === -Infinity ? Infinity : horizon);
  const done = horizon === -Infinity ? 0 : doneAt(sprint, byId, horizon);
  const remaining = round(Math.max(0, scope - done));
  const idealBefore = todayIndex === null ? (today > sprint.end ? 0 : committed) : points[todayIndex - 1]!.ideal;
  const delta = round(remaining - idealBefore);
  const thr = Math.max(1, committed * 0.1);
  const status: PaceStatus = sprint.status === 'planned' ? 'not-started' : sprint.status === 'closed' ? 'closed' : delta > thr ? 'behind' : delta < -thr ? 'ahead' : 'on-track';
  const scopeChanges: Burndown['scopeChanges'] = sprint.scope
    .filter(e => startedMs !== undefined && ms(e.at) > startedMs && e.kind !== 'commit' && e.points !== 0)
    .map(e => ({ date: dayKey(ms(e.at), offsetMin), at: e.at, taskId: e.taskId, points: e.points, kind: e.kind }));
  // A task cancelled after the start leaves the scope too, and that is a step the page should show.
  for (const id of sprintTaskIds(sprint)) {
    const t = byId.get(id);
    const at = t ? ms(t.updatedAt) : 0;
    const pts = t ? taskPointsIn(sprint, id, at) : 0;
    if (t?.status === 'cancelled' && startedMs !== undefined && at > startedMs && at <= Math.min(horizon, closedMs) && pts > 0 && memberAt(sprint, id, at)) {
      scopeChanges.push({ date: dayKey(at, offsetMin), at: new Date(at).toISOString(), taskId: id, points: -pts, kind: 'remove' });
    }
  }
  scopeChanges.sort((a, b) => ms(a.at) - ms(b.at) || a.taskId.localeCompare(b.taskId));
  return { sprintId: sprint.id, start: sprint.start, end: sprint.end, committed, days, workdays, points, todayIndex, scope, done, remaining, ideal: idealBefore, delta, status, scopeChanges };
}

/** Calendar days left in the sprint, counting today; 0 once the end date has passed. */
export function daysLeft(sprint: Pick<Sprint, 'end' | 'status' | 'closedAt'>, now: number, offsetMin = 0): number {
  if (sprint.status === 'closed') return 0;
  return Math.max(0, diffDays(dayKey(now, offsetMin), sprint.end) + 1);
}

/** True once an active sprint's end date is behind us: the page asks the person to close it. */
export function overdue(sprint: Pick<Sprint, 'end' | 'status'>, now: number, offsetMin = 0): boolean {
  return sprint.status === 'active' && dayKey(now, offsetMin) > sprint.end;
}

// ── velocity ─────────────────────────────────────────────────────────────

export interface VelocityRow {
  sprintId: string; name: string; end: string;
  committed: number; completed: number; added: number; unestimated: number;
  /** Mean of the completed points of this and up to two earlier sprints. */
  average: number;
}

export interface Velocity {
  rows: VelocityRow[];
  /** Mean of the last {@link VELOCITY_WINDOW} closed sprints; null with none. */
  average: number | null;
  unestimatedMerged: number;
}

export const VELOCITY_WINDOW = 3;

export function velocity(sprints: readonly Sprint[]): Velocity {
  const closed = sprints.filter(s => s.status === 'closed' && s.result).sort((a, b) => ms(a.closedAt) - ms(b.closedAt) || a.id.localeCompare(b.id));
  const rows = closed.map((s, i) => {
    const win = closed.slice(Math.max(0, i - VELOCITY_WINDOW + 1), i + 1);
    const avg = win.reduce((n, x) => n + x.result!.completed, 0) / win.length;
    return {
      sprintId: s.id, name: s.name, end: s.end, committed: s.result!.committed, completed: s.result!.completed, added: s.result!.added,
      unestimated: s.result!.unestimatedMerged, average: round(avg),
    };
  });
  return { rows, average: rows.length ? rows[rows.length - 1]!.average : null, unestimatedMerged: rows.reduce((n, r) => n + r.unestimated, 0) };
}

/** What a new sprint should plan for: the mean of the last three sprints, rounded; undefined without history. */
export function defaultCapacity(sprints: readonly Sprint[]): number | undefined {
  const v = velocity(sprints);
  return v.average === null ? undefined : Math.max(1, Math.round(v.average));
}

// ── planning proposal ────────────────────────────────────────────────────

export type SkipReason = 'needs-estimate' | 'does-not-fit' | 'too-big' | 'waits-for-dependency';

export interface PlanItem {
  taskId: string;
  points: number;
  /** Already committed to this sprint before the proposal. */
  kept?: boolean;
  /** Pulled in only because a task in the plan depends on it. */
  dependency?: boolean;
}

export interface Plan {
  capacity: number;
  capacitySource: 'given' | 'velocity' | 'starter';
  items: PlanItem[];
  total: number;
  skipped: Array<{ taskId: string; reason: SkipReason; detail?: string }>;
  /** Tasks in the plan that predicted-touch the same files, so agents would serialise on them. */
  overlaps: Array<{ a: string; b: string; files: string[] }>;
  /** Items in the plan with no acceptance criteria. */
  withoutAcceptance: number;
  /** Candidates left out for want of an estimate. */
  unestimated: number;
}

const INFLIGHT = new Set(['running', 'review', 'changes', 'pr']);

export const SKIP_TEXT: Record<SkipReason, string> = {
  'needs-estimate': 'Needs an estimate first',
  'does-not-fit': 'Does not fit the remaining capacity',
  'too-big': 'Bigger than the whole sprint: split it',
  'waits-for-dependency': 'Waits for a task that is not in the plan',
};

/**
 * The top-priority estimated items that fit, dependencies first. Deterministic: the same
 * board and capacity always give the same plan. It proposes; committing it is a person's
 * act (the engine's commit route).
 */
export function proposePlan(tasks: readonly Task[], opts: { capacity?: number | undefined; velocityCapacity?: number | undefined; sprintId?: string | undefined } = {}): Plan {
  const given = normalisePoints(opts.capacity);
  const capacity = given ?? opts.velocityCapacity ?? STARTER_CAPACITY;
  const capacitySource: Plan['capacitySource'] = given !== undefined ? 'given' : opts.velocityCapacity !== undefined ? 'velocity' : 'starter';
  const byId = new Map(tasks.map(t => [t.id, t]));
  const kept = tasks.filter(t => opts.sprintId && t.sprintId === opts.sprintId && t.status !== 'cancelled');
  const items: PlanItem[] = kept.map(t => ({ taskId: t.id, points: pointsOf(t), kept: true }));
  const inPlan = new Set(items.map(i => i.taskId));
  let total = round(items.reduce((n, i) => n + i.points, 0));
  const skipped = new Map<string, Plan['skipped'][number]>();
  const pool = tasks
    .filter(t => (t.status === 'backlog' || t.status === 'ready') && (!t.sprintId) && !inPlan.has(t.id))
    .sort((a, b) => a.priority - b.priority || ms(a.createdAt) - ms(b.createdAt) || a.id.localeCompare(b.id));
  const poolIds = new Set(pool.map(t => t.id));

  /**
   * The task and every dependency it still needs, dependencies first, or why it cannot be had.
   * Nothing is added until the whole set fits: a dependency pulled in alone, with the task that
   * needed it left out, would be points spent on something nobody asked for.
   */
  const gather = (t: Task, chain: Set<string>, acc: Task[]): { reason: SkipReason; detail?: string } | null => {
    if (inPlan.has(t.id) || acc.includes(t)) return null;
    if (!t.estimate) return { reason: 'needs-estimate' };
    if (chain.has(t.id)) return { reason: 'waits-for-dependency', detail: t.title };
    chain.add(t.id);
    for (const d of t.dependsOn) {
      const dep = byId.get(d);
      if (!dep || dep.status === 'merged' || inPlan.has(d) || INFLIGHT.has(dep.status)) continue;
      if (dep.status === 'cancelled' || !poolIds.has(d) || skipped.has(d) || gather(dep, chain, acc) !== null) {
        chain.delete(t.id);
        return { reason: 'waits-for-dependency', detail: dep.title };
      }
    }
    chain.delete(t.id);
    acc.push(t);
    return null;
  };
  const tryAdd = (t: Task): void => {
    if (inPlan.has(t.id) || skipped.has(t.id)) return;
    const acc: Task[] = [];
    const blocked = gather(t, new Set(), acc);
    if (blocked) { skipped.set(t.id, { taskId: t.id, ...blocked }); return; }
    const need = round(acc.reduce((n, x) => n + pointsOf(x), 0));
    const tooBig = acc.find(x => pointsOf(x) > capacity);
    if (tooBig) {
      skipped.set(t.id, tooBig === t ? { taskId: t.id, reason: 'too-big' } : { taskId: t.id, reason: 'waits-for-dependency', detail: tooBig.title });
      return;
    }
    if (total + need > capacity + 1e-9) { skipped.set(t.id, { taskId: t.id, reason: 'does-not-fit' }); return; }
    for (const x of acc) {
      items.push({ taskId: x.id, points: pointsOf(x), ...(x !== t ? { dependency: true } : {}) });
      inPlan.add(x.id);
    }
    total = round(total + need);
  };
  for (const t of pool) tryAdd(t);

  const overlaps: Plan['overlaps'] = [];
  const touching = items.map(i => ({ id: i.taskId, files: new Set(byId.get(i.taskId)?.touches?.files ?? []) })).filter(x => x.files.size > 0);
  for (let i = 0; i < touching.length; i++) {
    for (let j = i + 1; j < touching.length; j++) {
      const files = [...touching[i]!.files].filter(f => touching[j]!.files.has(f));
      if (files.length > 0 && overlaps.length < 8) overlaps.push({ a: touching[i]!.id, b: touching[j]!.id, files: files.slice(0, 4) });
    }
  }
  return {
    capacity, capacitySource, items, total, skipped: [...skipped.values()], overlaps,
    withoutAcceptance: items.filter(i => (byId.get(i.taskId)?.acceptance.length ?? 0) === 0).length,
    unestimated: [...skipped.values()].filter(s => s.reason === 'needs-estimate').length,
  };
}

// ── daily summary ────────────────────────────────────────────────────────

export interface DailyLine { id: string; title: string; points: number; status?: string; at?: string; reason?: string }

export interface DailySummary {
  /** The day this describes, YYYY-MM-DD. */
  date: string;
  /** Counting from the start of this working day. */
  since: string;
  sprint?: { id: string; name: string; goal: string; day: number; of: number; daysLeft: number };
  done: DailyLine[];
  inProgress: DailyLine[];
  inReview: DailyLine[];
  blocked: DailyLine[];
  needsYou: DailyLine[];
  pace?: { status: PaceStatus; remaining: number; ideal: number; delta: number; scope: number; done: number };
  /** Points merged in the window. */
  donePoints: number;
}

const firstLine = (s: string): string => (s.split(/\r?\n/).find(l => l.trim()) ?? '').trim().slice(0, 240);

/** Why a blocked task is blocked: the engine's or the person's last note on its thread. */
function blockReason(t: Task): string | undefined {
  const last = [...(t.review?.comments ?? [])].reverse().find(c => c.text.trim());
  return last ? firstLine(last.text) : undefined;
}

/**
 * A stand-up from the log. "Since" is the start of the previous working day, so a Monday
 * summary covers the weekend and Friday. With an active sprint it speaks about that sprint's
 * tasks; without one, about the whole board.
 */
export function dailySummary(input: { tasks: readonly Task[]; sprints: readonly Sprint[]; now: number; offsetMin?: number; mode?: BoardMode }): DailySummary {
  const off = input.offsetMin ?? 0;
  const date = dayKey(input.now, off);
  const sinceKey = previousWorkday(date);
  const since = dayStart(sinceKey, off);
  const active = input.sprints.find(s => s.status === 'active');
  const scoped = active && input.mode !== 'kanban' ? input.tasks.filter(t => t.sprintId === active.id) : input.tasks;
  const line = (t: Task): DailyLine => ({ id: t.id, title: t.title, points: pointsOf(t), status: t.status });
  const done = scoped.filter(t => { const at = mergedAt(t); return at !== undefined && at >= since; })
    .sort((a, b) => (mergedAt(a) ?? 0) - (mergedAt(b) ?? 0))
    .map(t => ({ ...line(t), at: new Date(mergedAt(t)!).toISOString() }));
  const summary: DailySummary = {
    date, since: sinceKey,
    done,
    inProgress: scoped.filter(t => t.status === 'running' || t.status === 'changes').map(line),
    inReview: scoped.filter(t => t.status === 'review' || t.status === 'pr').map(line),
    blocked: scoped.filter(t => t.status === 'blocked').map(t => ({ ...line(t), ...(blockReason(t) ? { reason: blockReason(t)! } : {}) })),
    needsYou: scoped.filter(t => t.needs).map(t => ({ ...line(t), reason: firstLine(t.needs!.prompt) })),
    donePoints: round(done.reduce((n, d) => n + d.points, 0)),
  };
  if (active) {
    const b = burndown(active, input.tasks, input.now, off);
    summary.sprint = { id: active.id, name: active.name, goal: active.goal, day: Math.min(b.days, Math.max(1, b.todayIndex ?? (dayKey(input.now, off) > active.end ? b.days : 1))), of: b.days, daysLeft: daysLeft(active, input.now, off) };
    summary.pace = { status: b.status, remaining: b.remaining, ideal: b.ideal, delta: b.delta, scope: b.scope, done: b.done };
  }
  return summary;
}

const PACE_WORD: Record<PaceStatus, string> = {
  'not-started': 'not started', ahead: 'ahead of the ideal line', 'on-track': 'on track', behind: 'behind the ideal line', closed: 'closed',
};
export const paceWord = (s: PaceStatus): string => PACE_WORD[s];
const pts = (n: number): string => (n === 1 ? '1 point' : `${n} points`);

export function dailyMarkdown(s: DailySummary): string {
  const out: string[] = [`# Daily summary, ${shortDate(s.date)}`, ''];
  if (s.sprint) {
    out.push(`**${s.sprint.name}** · day ${s.sprint.day} of ${s.sprint.of} · ${s.sprint.daysLeft} ${s.sprint.daysLeft === 1 ? 'day' : 'days'} left`);
    if (s.sprint.goal) out.push(`Goal: ${s.sprint.goal}`);
    if (s.pace) out.push(`Burndown: ${pts(s.pace.remaining)} remaining of ${pts(s.pace.scope)}, ${paceWord(s.pace.status)}${s.pace.status === 'behind' || s.pace.status === 'ahead' ? ` (${Math.abs(s.pace.delta)} ${s.pace.status === 'behind' ? 'over' : 'under'} the ideal)` : ''}.`);
    out.push('');
  }
  const section = (title: string, rows: DailyLine[], empty: string, extra?: (r: DailyLine) => string): void => {
    out.push(`## ${title}`);
    if (rows.length === 0) out.push(`- ${empty}`);
    for (const r of rows) out.push(`- ${r.title}${r.points ? ` (${r.points})` : ''}${extra ? extra(r) : ''}`);
    out.push('');
  };
  section(`Done since ${shortDate(s.since)}`, s.done, 'Nothing has landed.');
  section('In progress', s.inProgress, 'No agent is working on a sprint task.');
  section('Waiting for review', s.inReview, 'Nothing is waiting.');
  section('Blocked', s.blocked, 'Nothing is blocked.', r => (r.reason ? `: ${r.reason}` : ''));
  section('Needs you', s.needsYou, 'No agent is waiting on you.', r => (r.reason ? `: ${r.reason}` : ''));
  return out.join('\n').trimEnd() + '\n';
}

// ── sprint review ────────────────────────────────────────────────────────

/** Review notes from what merged: each task's evidence summary and its acceptance criteria, with the unfinished listed, not omitted. */
export function reviewMarkdown(sprint: Sprint, tasks: readonly Task[], offsetMin = 0): string {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const closedMs = sprint.closedAt ? ms(sprint.closedAt) : Infinity;
  const members = sprintTaskIds(sprint).map(id => byId.get(id)).filter((t): t is Task => Boolean(t));
  const live = members.filter(t => memberAt(sprint, t.id, closedMs) && t.status !== 'cancelled');
  const merged = live.filter(t => { const at = mergedAt(t); return at !== undefined && at <= closedMs; });
  const open = live.filter(t => !merged.includes(t));
  const committed = scopeNet(sprint, byId, sprint.startedAt ? ms(sprint.startedAt) : Infinity);
  const completed = doneAt(sprint, byId, closedMs);
  const result = sprint.result ?? computeResult(sprint, tasks, closedMs);
  const out: string[] = [`# Sprint review: ${sprint.name}`, '', `${shortDate(sprint.start)} to ${shortDate(sprint.end)}`, ''];
  if (sprint.goal) out.push(`**Goal.** ${sprint.goal}`, '');
  out.push(`**Delivered ${pts(completed)} of ${pts(committed)} committed**${result.added ? `, with ${pts(result.added)} added after the start` : ''}.`, '');
  out.push('## What was delivered', '');
  if (merged.length === 0) out.push('Nothing from this sprint has landed.', '');
  for (const t of merged) {
    const summary = t.evidence?.summary ? firstLine(t.evidence.summary) : '';
    out.push(`### ${t.title}${t.estimate ? ` (${t.estimate})` : ''}`);
    if (summary) out.push(summary);
    if (t.acceptance.length > 0) { out.push('', ...t.acceptance.map(a => `- [x] ${a}`)); }
    out.push('');
  }
  if (open.length > 0) {
    out.push('## Not finished', '', 'These go back to the product backlog (or stay in the sprint while it is still running).', '');
    for (const t of open) {
      out.push(`### ${t.title}${t.estimate ? ` (${t.estimate})` : ''}`, `Status: ${t.status}`);
      if (t.acceptance.length > 0) out.push('', ...t.acceptance.map(a => `- [ ] ${a}`));
      out.push('');
    }
  }
  const changes = sprint.scope.filter(e => sprint.startedAt && ms(e.at) > ms(sprint.startedAt) && e.kind !== 'commit');
  if (changes.length > 0) {
    out.push('## Scope changes', '');
    for (const e of changes) out.push(`- ${dayKey(ms(e.at), offsetMin)}: ${e.kind === 'add' ? 'added' : e.kind === 'remove' ? 'removed' : 're-estimated'} "${byId.get(e.taskId)?.title ?? e.taskId}" (${e.points > 0 ? '+' : ''}${e.points})`);
    out.push('');
  }
  out.push('## Feedback', '', '_Add what stakeholders said here._', '');
  return out.join('\n');
}

// ── retro ────────────────────────────────────────────────────────────────

/** Facts the engine reads from the journal (cycle times, rounds, checks, waits); the draft only phrases them. */
export interface RetroFacts {
  sprintId: string;
  committed: number;
  completed: number;
  added: number;
  carried: number;
  /** The sprint has closed: unfinished work went back to the backlog (otherwise it is still open). */
  closed?: boolean;
  tasksDone: number;
  tasksTotal: number;
  cycleMedianMs?: number;
  cycleLongest?: { title: string; ms: number };
  /** Times a task went back for changes, and why. */
  changeRounds: number;
  conflicts: number;
  failedChecks: number;
  flakyChecks: number;
  needsWaits: number;
  needsWaitMs: number;
  costUsd: number;
  costPerPoint?: number;
  velocityAverage?: number;
}

export function duration(msec: number): string {
  const m = Math.round(msec / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round(h / 24 * 10) / 10} days`;
}

/** A retro draft: the facts first, then three prompts. People edit it and save; nothing is posted anywhere. */
export function retroMarkdown(sprint: Pick<Sprint, 'name' | 'goal' | 'start' | 'end'>, f: RetroFacts): string {
  const out: string[] = [`# Retrospective: ${sprint.name}`, '', `${shortDate(sprint.start)} to ${shortDate(sprint.end)}`, '', '## What the sprint looked like', ''];
  out.push(`- Delivered ${pts(f.completed)} of ${pts(f.committed)} committed${f.added ? ` (+${f.added} added mid-sprint)` : ''}; ${f.tasksDone} of ${f.tasksTotal} tasks landed.`);
  if (f.velocityAverage !== undefined) out.push(`- Rolling velocity: ${f.velocityAverage} points per sprint.`);
  if (f.carried > 0) out.push(f.closed === false ? `- ${f.carried} ${f.carried === 1 ? 'task is' : 'tasks are'} not finished yet.` : `- ${f.carried} ${f.carried === 1 ? 'task' : 'tasks'} carried over to the backlog.`);
  if (f.cycleMedianMs !== undefined) out.push(`- Median time from first run to landing: ${duration(f.cycleMedianMs)}${f.cycleLongest ? `; longest "${f.cycleLongest.title}" at ${duration(f.cycleLongest.ms)}` : ''}.`);
  out.push(`- Work went back ${f.changeRounds} ${f.changeRounds === 1 ? 'time' : 'times'} for changes (${f.conflicts} rebase ${f.conflicts === 1 ? 'conflict' : 'conflicts'}, ${f.failedChecks} failed ${f.failedChecks === 1 ? 'check' : 'checks'}).`);
  if (f.flakyChecks > 0) out.push(`- ${f.flakyChecks} check ${f.flakyChecks === 1 ? 'run' : 'runs'} failed and then passed on the same code (flaky).`);
  out.push(`- Agents waited on a person ${f.needsWaits} ${f.needsWaits === 1 ? 'time' : 'times'}${f.needsWaits > 0 ? `, ${duration(f.needsWaitMs)} in total` : ''}.`);
  if (f.costPerPoint !== undefined) out.push(`- Spend: $${f.costUsd.toFixed(2)}, about $${f.costPerPoint.toFixed(2)} per point.`);
  else if (f.costUsd > 0) out.push(`- Spend: $${f.costUsd.toFixed(2)}.`);
  out.push('', '## What went well', '', '- ', '', '## What got in the way', '', '- ', '', '## What we will change next sprint', '', '- ', '');
  return out.join('\n');
}
