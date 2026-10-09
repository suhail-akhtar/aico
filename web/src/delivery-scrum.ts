/**
 * Scrum on the Delivery board, as the screens need it: which tasks belong where, what a
 * sprint header says, how a plan dialog starts, and the chart options.
 *
 * WHY HERE. The arithmetic (burndown, velocity, the planning proposal, the daily summary)
 * is `shared/delivery/scrum.ts`, the same code the engine runs, re-exported below so a
 * component imports one place. What is left for the client is presentation logic with no
 * DOM: the product backlog's order, the words a pace status gets, the default dates of a
 * new sprint, the checkbox state of a plan, and the ECharts options for the burndown and
 * velocity charts. It sits beside delivery-model.ts for the same reason that file does:
 * rules a unit test can pin without a browser (web/test-scrum.mjs).
 *
 * Chart options are built from a palette handed in, never from colours baked here, so the
 * light and dark themes (shared/ui/chart-theme) are the only source of colour.
 *
 * What it does not do: fetch, draw, or decide who may commit a sprint (the engine and the
 * decision gate do; the UI only sends person-only calls as a person).
 *
 * @module web/delivery-scrum
 */

import {
  SPLIT_AT, addDays, dayKey, diffDays, isWorkday, mergedAt, ms, pointsOf, refinementGaps, shortDate,
  type Burndown, type PaceStatus, type SkipReason, type Sprint, type Velocity,
} from '../../shared/delivery/scrum';
import type { BoardState, Task } from './delivery-types';

export * from '../../shared/delivery/scrum';

export type Mode = 'kanban' | 'scrum';

export const modeOf = (board: Pick<BoardState, 'settings'> | null | undefined): Mode => (board?.settings.mode === 'scrum' ? 'scrum' : 'kanban');
export const sprintsOf = (board: Pick<BoardState, 'sprints'> | null | undefined): Sprint[] => board?.sprints ?? [];
export const activeSprintOf = (sprints: readonly Sprint[]): Sprint | undefined => sprints.find(s => s.status === 'active');
export const plannedSprintOf = (sprints: readonly Sprint[]): Sprint | undefined => sprints.find(s => s.status === 'planned');
/** The sprint the header talks about: the running one, else the one being planned, else the latest closed. */
export const currentSprintOf = (sprints: readonly Sprint[]): Sprint | undefined =>
  activeSprintOf(sprints) ?? plannedSprintOf(sprints) ?? [...sprints].reverse().find(s => s.status === 'closed');

/** Tasks that count towards a sprint: its members, not the cancelled. */
export const tasksOfSprint = (tasks: readonly Task[], sprintId: string): Task[] => tasks.filter(t => t.sprintId === sprintId && t.status !== 'cancelled');

/**
 * The product backlog, in the order a planner reads it: what could join a sprint (not in one,
 * not finished), by priority and then age. Blocked items stay visible so they are not forgotten.
 */
export function productBacklog(tasks: readonly Task[]): Task[] {
  return tasks
    .filter(t => !t.sprintId && (t.status === 'backlog' || t.status === 'ready' || t.status === 'blocked'))
    .sort((a, b) => a.priority - b.priority || ms(a.createdAt) - ms(b.createdAt) || a.id.localeCompare(b.id));
}

/** In Scrum mode a ready task outside the active sprint is skipped by the agents: the card says so. */
export function skippedBySprint(task: Pick<Task, 'status' | 'sprintId'>, sprints: readonly Sprint[]): boolean {
  const active = activeSprintOf(sprints);
  return task.status === 'ready' && (!active || task.sprintId !== active.id);
}

// ── words ────────────────────────────────────────────────────────────────

export const PACE_LABEL: Record<PaceStatus, string> = {
  'not-started': 'Not started', ahead: 'Ahead', 'on-track': 'On track', behind: 'Behind', closed: 'Closed',
};

/** The tone a pace status is drawn in; colour only backs the word up, never replaces it. */
export const paceTone = (s: PaceStatus): 'success' | 'warning' | 'danger' | 'neutral' =>
  s === 'ahead' || s === 'on-track' ? 'success' : s === 'behind' ? 'warning' : 'neutral';

export const paceDetail = (b: Pick<Burndown, 'status' | 'delta' | 'remaining' | 'ideal'>): string => {
  if (b.status === 'not-started') return 'The sprint has not started.';
  if (b.status === 'closed') return 'The sprint is closed.';
  const gap = Math.abs(Math.round(b.delta * 10) / 10);
  if (b.status === 'on-track') return `On track: ${b.remaining} points remaining against an ideal of ${Math.round(b.ideal * 10) / 10}.`;
  return `${gap} ${gap === 1 ? 'point' : 'points'} ${b.status === 'behind' ? 'behind' : 'ahead of'} the ideal line (${b.remaining} remaining, ideal ${Math.round(b.ideal * 10) / 10}).`;
};

export const pointsWord = (n: number): string => `${Math.round(n * 10) / 10} ${n === 1 ? 'pt' : 'pts'}`;

export function daysLeftWord(left: number, status: Sprint['status']): string {
  if (status === 'closed') return 'closed';
  if (status === 'planned') return 'not started';
  if (left <= 0) return 'ended';
  return left === 1 ? 'last day' : `${left} days left`;
}

/** "5 Oct – 16 Oct". */
export const rangeWord = (s: Pick<Sprint, 'start' | 'end'>): string => `${shortDate(s.start)} – ${shortDate(s.end)}`;

/** What a backlog row still needs, in words (the chips under a title). */
export function gapWords(t: Pick<Task, 'estimate' | 'acceptance'>): string[] {
  return refinementGaps(t).map(g => (g === 'estimate' ? 'No estimate' : g === 'acceptance' ? 'No criteria' : `Large (${SPLIT_AT}+): consider splitting`));
}

export const SKIP_WORD: Record<SkipReason, string> = {
  'needs-estimate': 'Needs an estimate',
  'does-not-fit': 'Does not fit the capacity',
  'too-big': 'Bigger than the whole sprint: split it',
  'waits-for-dependency': 'Waits for a task that is not in the plan',
};

// ── a new sprint ─────────────────────────────────────────────────────────

/** The next sprint's dates: it starts on the next working day after the last sprint (or today) and runs two weeks, ending on a working day. */
export function defaultSprintDates(sprints: readonly Sprint[], now: number, offsetMin = 0): { start: string; end: string } {
  const today = dayKey(now, offsetMin);
  const lastEnd = sprints.reduce((m, s) => (s.end > m ? s.end : m), '');
  let start = lastEnd && addDays(lastEnd, 1) > today ? addDays(lastEnd, 1) : today;
  while (!isWorkday(start)) start = addDays(start, 1);
  let end = addDays(start, 13);
  while (!isWorkday(end)) end = addDays(end, -1);
  return { start, end };
}

export const nextSprintName = (sprints: readonly Sprint[]): string => `Sprint ${sprints.length + 1}`;

export function validateSprintDates(start: string, end: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return 'Pick a start and an end date.';
  const days = diffDays(start, end) + 1;
  if (days < 1) return 'The sprint cannot end before it starts.';
  if (days > 42) return `A sprint is at most 42 days; this one is ${days}.`;
  return null;
}

// ── the plan dialog ──────────────────────────────────────────────────────

export interface PlanState {
  /** Ticked task ids, in plan order. */
  chosen: string[];
  total: number;
  capacity: number;
  /** total / capacity, uncapped: above 1 is over. */
  load: number;
  over: boolean;
  remaining: number;
}

export function planState(chosen: readonly string[], byId: ReadonlyMap<string, Task>, capacity: number): PlanState {
  const total = Math.round(chosen.reduce((n, id) => n + pointsOf(byId.get(id)), 0) * 100) / 100;
  return { chosen: [...chosen], total, capacity, load: capacity > 0 ? total / capacity : 0, over: total > capacity + 1e-9, remaining: Math.round((capacity - total) * 100) / 100 };
}

/** Tick or untick; a task that others in the plan depend on takes them with it only if the person agrees, so this just reports who depends on it. */
export function dependentsInPlan(chosen: readonly string[], id: string, byId: ReadonlyMap<string, Task>): string[] {
  return chosen.filter(c => c !== id && byId.get(c)?.dependsOn.includes(id));
}

export function toggleChosen(chosen: readonly string[], id: string): string[] {
  return chosen.includes(id) ? chosen.filter(c => c !== id) : [...chosen, id];
}

/** "3 of 4 sprint tasks done"-style progress for the header bar. */
export function sprintProgress(sprint: Sprint, tasks: readonly Task[], bd: Pick<Burndown, 'done' | 'scope'>): { done: number; scope: number; pct: number; tasksDone: number; tasksTotal: number } {
  const mine = tasksOfSprint(tasks, sprint.id);
  return {
    done: bd.done, scope: bd.scope, pct: bd.scope > 0 ? Math.min(100, Math.round(bd.done / bd.scope * 100)) : 0,
    tasksDone: mine.filter(t => mergedAt(t) !== undefined).length, tasksTotal: mine.length,
  };
}

// ── chart options ────────────────────────────────────────────────────────

export interface ChartPalette {
  actual: string;
  ideal: string;
  scope: string;
  ink: string;
  muted: string;
  line: string;
  surface: string;
  committed: string;
}

const label = (iso: string): string => shortDate(iso);

/** The burndown: ideal dashed, remaining solid and ending at today, scope as a step where it moved. */
export function burndownOption(bd: Burndown, pal: ChartPalette): Record<string, unknown> {
  const labels = bd.points.map(p => (p.day === 0 ? 'Start' : label(p.date)));
  const todayLabel = bd.todayIndex !== null && bd.status !== 'closed' ? labels[bd.todayIndex] : undefined;
  const scopeMoved = bd.points.some(p => p.scope !== bd.committed);
  const max = Math.max(1, ...bd.points.map(p => Math.max(p.scope, p.ideal, p.remaining ?? 0)));
  return {
    animation: false,
    grid: { left: 8, right: 70, top: 24, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    xAxis: { type: 'category', data: labels, boundaryGap: false, axisLabel: { hideOverlap: true, color: pal.muted } },
    yAxis: { type: 'value', min: 0, max: Math.ceil(max * 1.08), name: 'points', nameTextStyle: { color: pal.muted, align: 'left' }, axisLabel: { color: pal.muted } },
    series: [
      {
        name: 'Ideal', type: 'line', data: bd.points.map(p => p.ideal), symbol: 'none', z: 2,
        areaStyle: { opacity: 0 }, lineStyle: { type: 'dashed', width: 1.5, color: pal.ideal }, itemStyle: { color: pal.ideal },
        endLabel: { show: true, formatter: 'Ideal', color: pal.muted, fontSize: 11 },
      },
      ...(scopeMoved ? [{
        name: 'Scope', type: 'line', step: 'end', data: bd.points.map(p => p.scope), symbol: 'none', z: 1,
        areaStyle: { opacity: 0 }, lineStyle: { width: 1.5, color: pal.scope }, itemStyle: { color: pal.scope },
        endLabel: { show: true, formatter: 'Scope', color: pal.muted, fontSize: 11 },
      }] : []),
      {
        name: 'Remaining', type: 'line', data: bd.points.map(p => p.remaining), connectNulls: false, symbolSize: 6, z: 3,
        lineStyle: { width: 2.5, color: pal.actual }, itemStyle: { color: pal.actual, borderColor: pal.surface, borderWidth: 2 },
        areaStyle: { color: pal.actual, opacity: 0.08 },
        endLabel: { show: bd.todayIndex !== null || bd.status === 'closed', formatter: 'Remaining', color: pal.ink, fontSize: 11, fontWeight: 600 },
        ...(todayLabel ? { markLine: { silent: true, symbol: 'none', label: { formatter: 'Today', color: pal.muted, fontSize: 11, position: 'end', rotate: 0 }, lineStyle: { color: pal.line, type: 'solid', width: 1 }, data: [{ xAxis: todayLabel }] } } : {}),
      },
    ],
  };
}

/** Velocity: committed beside completed for each closed sprint, with the rolling average as a line. */
export function velocityOption(v: Velocity, pal: ChartPalette): Record<string, unknown> {
  const names = v.rows.map(r => r.name);
  return {
    animation: false,
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { show: true, top: 0, right: 0, textStyle: { color: pal.muted, fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
    xAxis: { type: 'category', data: names, axisLabel: { color: pal.muted } },
    yAxis: { type: 'value', min: 0, name: 'points', nameTextStyle: { color: pal.muted, align: 'left' }, axisLabel: { color: pal.muted } },
    series: [
      { name: 'Committed', type: 'bar', data: v.rows.map(r => r.committed), barMaxWidth: 22, itemStyle: { color: pal.committed, borderRadius: [4, 4, 0, 0] } },
      {
        name: 'Completed', type: 'bar', data: v.rows.map(r => r.completed), barMaxWidth: 22, itemStyle: { color: pal.actual, borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: pal.ink, fontSize: 11 },
      },
      { name: 'Average', type: 'line', data: v.rows.map(r => r.average), symbolSize: 6, areaStyle: { opacity: 0 }, lineStyle: { width: 2, type: 'dashed', color: pal.ink }, itemStyle: { color: pal.ink } },
    ],
  };
}

/** The data behind a chart, as text rows (a screen reader and a test read this, not the drawing). */
export function burndownRows(bd: Burndown): Array<[string, string, string]> {
  return bd.points.map(p => [p.day === 0 ? 'Start' : label(p.date), p.remaining === null ? 'not yet' : String(p.remaining), String(Math.round(p.ideal * 10) / 10)]);
}

export function velocityRows(v: Velocity): Array<[string, string, string, string]> {
  return v.rows.map(r => [r.name, String(r.committed), String(r.completed), String(r.average)]);
}
