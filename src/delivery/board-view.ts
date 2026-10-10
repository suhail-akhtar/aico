/**
 * What a client reads off the board that is not stored anywhere: why a ready task is not
 * running, what is blocking it, how long work takes, who is doing what, how an epic stands.
 *
 * WHY DERIVED AND NOT JOURNALED. Each of these is a function of facts the journal already
 * holds (task statuses, dependencies, touches, timestamps, spend). Storing them would mean
 * a second copy that can disagree with the first, and the first thing the owner said about
 * the board after using it for real was "ready tasks never start and nothing says why" -
 * an answer that has to be true at the moment it is shown can only be computed from the
 * fold at that moment. Everything here is pure: it takes `now` as an argument and reads
 * no clock, no file and no process state, so a fixed journal always reads the same.
 *
 * What it deliberately does not do: decide anything. The dispatcher (index.ts) owns the
 * rules; the reasons below are the same rules, asked "why not" instead of "go". They are
 * kept beside each other in `startBlocker` so a rule changed in one place is changed in both.
 *
 * @module delivery/board-view
 */

import { overlap } from './touches.js';
import type { ActivityEntry, BoardState, Task, TaskStatus } from './types.js';

const STATUS_WORD: Record<TaskStatus, string> = {
  backlog: 'Backlog', ready: 'Ready', running: 'Running', review: 'Review', changes: 'Changes requested',
  pr: 'Pull request', merged: 'Merged', blocked: 'Blocked', cancelled: 'Cancelled',
};
export const statusWord = (s: TaskStatus): string => STATUS_WORD[s];

/** The agent slots a board names its runs after. */
export const AGENT_SLOTS = ['Agent A', 'Agent B', 'Agent C', 'Agent D'] as const;

/** The tasks in `dependsOn` that are not merged, with where each stands. */
export function blockedByOf(t: Pick<Task, 'dependsOn'>, tasks: ReadonlyMap<string, Task>): Array<{ id: string; status: TaskStatus }> {
  const out: Array<{ id: string; status: TaskStatus }> = [];
  for (const d of t.dependsOn) {
    const dep = tasks.get(d);
    if (dep && dep.status === 'merged') continue;
    // A dependency that no longer exists blocks nothing the board can show: it is reported as cancelled.
    out.push({ id: d, status: dep ? dep.status : 'cancelled' });
  }
  return out;
}

export interface ViewContext {
  now: number;
  tasks: ReadonlyMap<string, Task>;
  dispatcher: BoardState['dispatcher'];
  pausedBecause?: string | undefined;
  maxParallel: number;
  wip: { running?: number | undefined; review?: number | undefined };
  budgetUsdPerDay: number;
  spentTodayUsd: number;
  scrum: { mode: 'kanban' | 'scrum'; activeSprintId?: string | undefined };
}

const quote = (t: Task | undefined, id: string): string => `"${(t?.title ?? id).slice(0, 60)}"`;

/** The effective ceiling on tasks running at once: the board's parallelism, lowered by its WIP limit. */
export function runningCeiling(maxParallel: number, wip: ViewContext['wip']): number {
  return wip.running && wip.running > 0 ? Math.min(maxParallel, wip.running) : maxParallel;
}

/** Changes a person has yet to look at: in review, or submitted and still being rebased and checked (no agent holds them any more). */
export function awaitingReview(tasks: Iterable<Task>): number {
  let n = 0;
  for (const t of tasks) if (t.status === 'review' || (t.status === 'running' && !t.claim)) n++;
  return n;
}

const SLOTS_BUSY = /agent slots? (is|are) busy/;

/**
 * Why a task that is ready (or sent back) is not being run right now, or undefined when
 * nothing but the next tick is in its way. The checks are in the order the dispatcher
 * applies them; the first that holds is the answer a person can act on.
 */
export function startBlocker(t: Task, c: ViewContext): string | undefined {
  if (t.status !== 'ready' && t.status !== 'changes') return undefined;
  if (t.claim) return undefined;
  if (c.dispatcher !== 'running') {
    return c.pausedBecause ? `The dispatcher paused itself: ${c.pausedBecause}` : c.dispatcher === 'paused' ? 'The dispatcher is paused; start it to run ready tasks.' : 'The dispatcher has not been started.';
  }
  const blockers = blockedByOf(t, c.tasks);
  if (blockers.length > 0) {
    const parts = blockers.map(b => `${quote(c.tasks.get(b.id), b.id)} (${statusWord(b.status)})`);
    const inBacklog = blockers.some(b => b.status === 'backlog');
    return `Waiting for ${parts.join(', ')} to be merged${inBacklog ? '; promote the prerequisites to start them' : ''}.`;
  }
  if (c.scrum.mode === 'scrum' && t.status === 'ready' && (!c.scrum.activeSprintId || t.sprintId !== c.scrum.activeSprintId)) {
    return c.scrum.activeSprintId ? 'Not in the active sprint.' : 'There is no active sprint; Scrum mode runs only the active sprint\'s tasks.';
  }
  if (c.budgetUsdPerDay > 0 && c.spentTodayUsd >= c.budgetUsdPerDay) {
    return `The daily budget of $${c.budgetUsdPerDay.toFixed(2)} is spent ($${c.spentTodayUsd.toFixed(2)} today).`;
  }
  const all = [...c.tasks.values()];
  const running = all.filter(x => x.status === 'running' && x.claim);
  const review = awaitingReview(all);
  if (c.wip.review && review >= c.wip.review) return `Review is full (${review} of ${c.wip.review}); approve or send back a task before more start.`;
  const cap = runningCeiling(c.maxParallel, c.wip);
  const clash = running.map(r => ({ r, file: overlap(t.touches, r.touches) })).find(x => x.file);
  if (clash) return `Waiting for ${quote(clash.r, clash.r.id)}, which is working on the same file (${clash.file}).`;
  if (running.length >= cap) return `All ${cap} agent slot${cap === 1 ? ' is' : 's are'} busy.`;
  return undefined;
}

/** One sentence for the whole board: why nothing is being picked up. Undefined when all is moving or merely queued behind busy slots. */
export function idleReasonOf(c: ViewContext): string | undefined {
  const all = [...c.tasks.values()];
  const waiting = all.filter(t => (t.status === 'ready' || t.status === 'changes') && !t.claim);
  const running = all.filter(t => t.status === 'running').length;
  if (waiting.length === 0) {
    const backlog = all.filter(t => t.status === 'backlog').length;
    if (c.dispatcher === 'running' && running === 0 && backlog > 0 && !all.some(t => t.status === 'review' || t.status === 'pr')) {
      return `Nothing is Ready. ${backlog} task${backlog === 1 ? ' is' : 's are'} in the backlog; move some to Ready, or raise the board's autonomy to let it pull the next ones.`;
    }
    return undefined;
  }
  const reasons = waiting.map(t => ({ t, why: startBlocker(t, c) })).filter((x): x is { t: Task; why: string } => Boolean(x.why));
  if (reasons.length === 0) return undefined;
  const n = waiting.length;
  const noun = `${n} ${n === 1 ? 'task is' : 'tasks are'}`;
  if (c.dispatcher !== 'running') {
    if (c.pausedBecause) return `${noun} ready, but the dispatcher paused itself: ${c.pausedBecause}`;
    return `${noun} ready, but the dispatcher ${c.dispatcher === 'paused' ? 'is paused' : 'has not been started'}.`;
  }
  // Every waiting task is held by a prerequisite: name them, grouped by where they stand.
  const depBlocked = reasons.filter(x => blockedByOf(x.t, c.tasks).length > 0);
  if (depBlocked.length === reasons.length) {
    const ids = [...new Set(depBlocked.flatMap(x => blockedByOf(x.t, c.tasks).map(b => b.id)))];
    const states = [...new Set(ids.map(id => c.tasks.get(id)?.status ?? 'cancelled'))].map(s => statusWord(s));
    const names = ids.slice(0, 4).map(id => quote(c.tasks.get(id), id));
    return `${depBlocked.length} ready ${depBlocked.length === 1 ? 'task waits' : 'tasks wait'} for ${names.join(' and ')}${ids.length > 4 ? ` and ${ids.length - 4} more` : ''}, which ${ids.length === 1 ? 'is' : 'are'} in ${states.join(' / ')}.`;
  }
  const first = reasons.find(x => !SLOTS_BUSY.test(x.why));
  if (!first) return undefined;
  return `${noun} waiting. ${first.why}`;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** When a task landed: the landing record, else its last update. */
const mergedAt = (t: Task): number => Date.parse(t.landed?.at ?? t.updatedAt);

export function metricsOf(tasks: Iterable<Task>, runStarted: ReadonlyMap<string, string>, spentTodayUsd: number, now: number): BoardState['metrics'] {
  const all = [...tasks];
  const merged = all.filter(t => t.status === 'merged').sort((a, b) => mergedAt(b) - mergedAt(a)).slice(0, 50);
  // Cycle time starts at the FIRST run of the task, lead time at its creation.
  const cycle = merged.map(t => { const s = runStarted.get(t.id); return s ? mergedAt(t) - Date.parse(s) : NaN; }).filter(n => Number.isFinite(n) && n >= 0);
  const lead = merged.map(t => mergedAt(t) - Date.parse(t.createdAt)).filter(n => Number.isFinite(n) && n >= 0);
  const weekAgo = now - 7 * 86_400_000;
  const ageing: BoardState['metrics']['byStatusAgeing'] = {};
  for (const status of ['backlog', 'ready', 'running', 'review', 'changes', 'blocked', 'pr'] as const) {
    const ages = all.filter(t => t.status === status).map(t => Math.max(0, now - Date.parse(t.updatedAt)));
    if (ages.length > 0) ageing[status] = { count: ages.length, oldestMs: Math.max(...ages), medianMs: median(ages) ?? 0 };
  }
  return {
    medianCycleMs: median(cycle), medianLeadMs: median(lead),
    throughput7d: all.filter(t => t.status === 'merged' && mergedAt(t) >= weekAgo).length,
    spentTodayUsd: Math.round(spentTodayUsd * 10_000) / 10_000,
    wipNow: all.filter(t => t.status === 'running' || t.status === 'review').length,
    byStatusAgeing: ageing,
  };
}

/** The board's agent slots: the first `slots` names, plus any other slot a running task holds. */
export function agentsOf(tasks: Iterable<Task>, slots: number): BoardState['agents'] {
  const running = [...tasks].filter(t => t.status === 'running' && t.claim);
  const names: string[] = AGENT_SLOTS.slice(0, Math.max(1, Math.min(slots, AGENT_SLOTS.length)));
  for (const t of running) if (t.assignee?.kind === 'agent' && !names.includes(t.assignee.name)) names.push(t.assignee.name);
  return names.map(name => {
    const t = running.find(x => x.assignee?.kind === 'agent' && x.assignee.name === name);
    if (!t) return { name, state: 'idle' as const };
    return { name, taskId: t.id, ...(t.live?.summary ? { summary: t.live.summary } : {}), state: t.needs ? ('waiting' as const) : ('working' as const) };
  });
}

/** Parent tasks (epics) with how their children stand. */
export function rollups(tasks: ReadonlyMap<string, Task>): Map<string, NonNullable<Task['children']>> {
  const out = new Map<string, NonNullable<Task['children']>>();
  for (const t of tasks.values()) {
    if (!t.parentId || t.status === 'cancelled') continue;
    const r = out.get(t.parentId) ?? { total: 0, merged: 0, running: 0, review: 0 };
    r.total++;
    if (t.status === 'merged') r.merged++;
    else if (t.status === 'running') r.running++;
    else if (t.status === 'review' || t.status === 'pr') r.review++;
    out.set(t.parentId, r);
  }
  return out;
}

/** Keep the latest `n` entries. */
export const lastEntries = (xs: readonly ActivityEntry[] | undefined, n: number): ActivityEntry[] => (xs ? xs.slice(-n).map(x => ({ ...x })) : []);
