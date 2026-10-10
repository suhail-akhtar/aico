/**
 * The delivery board's journal: an append-only JSONL file per project, and the
 * board as its fold (ADR 0038, ADR 0001).
 *
 * WHY A JOURNAL. The board is durable state that several things change at once
 * — a person in a client, the planner agent, the dispatcher, a task's run, the
 * merge queue — and that must survive a restart with its claims, its queue and
 * its history intact. The same answer as the long jobs and the approve-later
 * inbox: never mutate, append an event, fold to read. Nothing here is ever
 * rewritten or reordered, so "what happened to this task" is always readable,
 * and a crash mid-append costs at most one torn last line (skipped on read,
 * and the next append starts on a fresh line).
 *
 * WHERE. `aicoHome()/delivery/<project key>/board.jsonl`, with the key the other
 * per-project stores use (`projectKey`). Never `~/.aico` by hand.
 *
 * Everything a board shows beyond the tasks is folded from the same events, never stored a
 * second time: each task's history (bounded to 200 lines) and the board's feed (100) from
 * `activity` events, status changes and comments; the day's spend from the increases of a
 * task's cost; the failure streak from `failed` / `sent-back` lines (reset by `review`,
 * `landed` or a person starting the dispatcher); why the dispatcher paused, from the pause
 * event; ranks from `rank` events. The derived reads (why a task waits, metrics, agents) are
 * `board-view.ts`, computed when the board is read. The one thing kept only in memory is a
 * running task's live line (`setLive`): it changes every few seconds and the journal is forever.
 *
 * The fold is cached by file size so a poll every few seconds does not re-parse
 * a long journal; any append (by this process or another) changes the size and
 * the next read folds again.
 *
 * What this module does not do: decide anything. Which transitions are legal,
 * who may make them and what they cost are the service's rules (index.ts); this
 * file only records facts and folds them. Event shapes are engine-private — a
 * client sees the fold ({@link boardState}), never the events.
 *
 * @module delivery/store
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { projectKey } from '../learning/proposals.js';
import { applyScrum, emptyScrum, openProposals, overlayScrum, sprintList, activeSprint, type ScrumEvent, type ScrumFold } from './scrum-fold.js';
import { agentsOf, blockedByOf, idleReasonOf, lastEntries, metricsOf, rollups, startBlocker, statusWord, type ViewContext } from './board-view.js';
import { isAutonomy, minAutonomy } from '../../shared/delivery/autonomy.js';
import type { ActivityEntry, Autonomy, BoardState, DispatcherState, Release, Task } from './types.js';

export const DEFAULT_MAX_PARALLEL = 2;
export const MAX_PARALLEL_CAP = 4;
export const DEFAULT_BUDGET_USD_PER_DAY = 10;
export const DEFAULT_PAUSE_AFTER_FAILURES = 3;
/** Entries kept per task and on the board's feed (the board carries only the latest of a task's). */
export const TASK_ACTIVITY_MAX = 200;
export const FEED_MAX = 100;
export const BOARD_TASK_ACTIVITY = 30;
export const MAX_VIEWS = 20;
/** Ranks are `priority * RANK_BAND + n`: an untouched board still runs the most urgent first. */
export const RANK_BAND = 1_000_000;

export type BoardSettings = BoardState['settings'];

/** One check run, as kept in the journal: enough for the evidence report, never the raw output. */
export interface CheckRecord {
  name: string;
  command: string;
  outcome: 'passed' | 'failed';
  exitCode: number | null;
  ms: number;
  tests?: { runner: string; passed: number; failed: number; skipped: number; failures: string[] };
  /** The tail of a failing check's output, so a resumed run is told why. */
  tail?: string;
}

type JournalEvent =
  | { t: 'init'; at: string; project: string; trunk: string }
  | { t: 'task'; at: string; task: Task; by?: 'person' | 'agent' | 'system' }
  | { t: 'patch'; at: string; id: string; set?: Partial<Task>; unset?: Array<keyof Task>; by?: 'person' | 'agent' | 'system' }
  /** A line of history: a task's (with `id`) and the board's feed. `kind` drives the failure streak (failed and sent-back count; review and landed reset). */
  | { t: 'activity'; at: string; id?: string; kind: string; by: 'person' | 'agent' | 'system'; text: string }
  /** A reorder: the new rank of every card that moved. */
  | { t: 'rank'; at: string; ranks: Record<string, number> }
  | { t: 'comment'; at: string; id: string; by: 'person' | 'agent'; text: string }
  | { t: 'queue'; at: string; op: 'push' | 'drop'; id: string }
  | { t: 'start'; at: string; id: string; runId: string }
  | { t: 'settings'; at: string; set: Partial<BoardSettings> }
  | { t: 'dispatcher'; at: string; state: DispatcherState; reason?: string }
  | { t: 'checks'; at: string; tree: string; ok: boolean; results: CheckRecord[] }
  | { t: 'base'; at: string; id: string; trunkSha: string; tree: string }
  | { t: 'release'; at: string; release: Release }
  | { t: 'deploy'; at: string; version: string; deploy: NonNullable<Release['deploy']> }
  | { t: 'rollback'; at: string; version: string; taskId: string }
  /** Scrum mode (ADR 0039 section 4): sprints, estimates, suggestions. Folded by scrum-fold.ts. */
  | { t: 'scrum'; at: string; ev: ScrumEvent };

/** What the fold produces; the contract's BoardState is derived from it. */
export interface Folded {
  project: string;
  tasks: Map<string, Task>;
  queue: string[];
  runStarted: Map<string, string>;
  settings: BoardSettings;
  dispatcher: DispatcherState;
  /** Tree hash → the checks that ran on it. The "already green" cache. */
  checks: Map<string, { ok: boolean; at: string; results: CheckRecord[] }>;
  /** The trunk commit and tree a task's review was prepared against. */
  base: Map<string, { trunkSha: string; tree: string }>;
  /** Releases the board made, by version. */
  releases: Map<string, Release>;
  /** Sprints, estimates, memberships and the agent's suggestions (empty on a board that never used Scrum). */
  scrum: ScrumFold;
  /** Per task, the latest history lines (bounded). */
  activity: Map<string, ActivityEntry[]>;
  /** The board's own feed, newest last (bounded). */
  feed: Array<{ at: string; taskId?: string; kind: string; text: string }>;
  /** Spend per local day (`YYYY-MM-DD`), summed from task cost increases. */
  spend: Map<string, number>;
  /** Consecutive failed / sent-back tasks since the last task reached review or landed, or a person started the dispatcher. */
  failStreak: number;
  /** Why the dispatcher paused itself; cleared when it runs again. */
  pausedBecause?: string | undefined;
}

/** The local calendar day of an instant: what "today's budget" means to the person. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function deliveryRoot(): string {
  return path.join(aicoHome(), 'delivery');
}

export function boardDir(project: string): string {
  return path.join(deliveryRoot(), projectKey(project));
}

export function journalFile(project: string): string {
  return path.join(boardDir(project), 'board.jsonl');
}

/** A new task id: eight hex characters, safe in a branch name and a folder name. */
export function newTaskId(): string {
  return crypto.randomBytes(4).toString('hex');
}

const iso = (): string => new Date().toISOString();

export function clampParallel(n: unknown): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(v, MAX_PARALLEL_CAP) : DEFAULT_MAX_PARALLEL;
}

function emptyFold(project: string, trunk = 'main'): Folded {
  return {
    project,
    tasks: new Map(),
    queue: [],
    runStarted: new Map(),
    settings: {
      maxParallel: DEFAULT_MAX_PARALLEL, autoLandLowRisk: false, trunk, autonomy: 'manual', wip: {},
      budgetUsdPerDay: DEFAULT_BUDGET_USD_PER_DAY, pauseAfterFailures: DEFAULT_PAUSE_AFTER_FAILURES, views: [],
    },
    dispatcher: 'idle',
    checks: new Map(),
    base: new Map(),
    releases: new Map(),
    scrum: emptyScrum(),
    activity: new Map(),
    feed: [],
    spend: new Map(),
    failStreak: 0,
  };
}

const intIn = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
};

/** Validate and merge a `settings` event into the fold. Unknown or invalid values are ignored, never fatal (a newer engine's journal still folds). */
function applySettings(f: Folded, set: Partial<BoardSettings>): void {
  const st = f.settings;
  if (set.maxParallel !== undefined) st.maxParallel = clampParallel(set.maxParallel);
  if (set.autoLandLowRisk !== undefined) st.autoLandLowRisk = set.autoLandLowRisk === true;
  if (set.trunk) st.trunk = set.trunk;
  if (set.autonomy !== undefined && isAutonomy(set.autonomy)) st.autonomy = set.autonomy;
  if (set.wip !== undefined && set.wip && typeof set.wip === 'object') {
    const running = intIn((set.wip as { running?: unknown }).running, 1, 50);
    const review = intIn((set.wip as { review?: unknown }).review, 1, 500);
    st.wip = { ...(running ? { running } : {}), ...(review ? { review } : {}) };
  }
  if (set.budgetUsdPerDay !== undefined) {
    const n = Number(set.budgetUsdPerDay);
    if (Number.isFinite(n) && n > 0 && n <= 100_000) st.budgetUsdPerDay = Math.round(n * 100) / 100;
  }
  if (set.pauseAfterFailures !== undefined) st.pauseAfterFailures = intIn(set.pauseAfterFailures, 1, 50) ?? st.pauseAfterFailures;
  if (set.views !== undefined && Array.isArray(set.views)) st.views = cleanViews(set.views);
}

export function cleanViews(views: unknown[]): BoardSettings['views'] {
  const out: BoardSettings['views'] = [];
  for (const v of views) {
    const o = v as { name?: unknown; filter?: unknown } | null;
    const name = typeof o?.name === 'string' ? o.name.trim().slice(0, 40) : '';
    const filter = typeof o?.filter === 'string' ? o.filter.slice(0, 500) : '';
    if (name && !out.some(x => x.name === name)) out.push({ name, filter });
    if (out.length >= MAX_VIEWS) break;
  }
  return out;
}

/** The rank a new task gets: after every task in its priority band. */
export function nextRankIn(tasks: Iterable<Task>, priority: number): number {
  let max = priority * RANK_BAND;
  for (const t of tasks) if (typeof t.rank === 'number' && Math.floor(t.rank / RANK_BAND) === priority && t.rank > max) max = t.rank;
  return max + 1;
}

function pushActivity(f: Folded, taskId: string | undefined, e: ActivityEntry, feed: boolean): void {
  if (taskId) {
    const list = f.activity.get(taskId) ?? [];
    list.push(e);
    if (list.length > TASK_ACTIVITY_MAX) list.splice(0, list.length - TASK_ACTIVITY_MAX);
    f.activity.set(taskId, list);
  }
  if (feed) {
    f.feed.push({ at: e.at, ...(taskId ? { taskId } : {}), kind: e.kind, text: e.text });
    if (f.feed.length > FEED_MAX) f.feed.splice(0, f.feed.length - FEED_MAX);
  }
}

function apply(f: Folded, ev: JournalEvent): void {
  switch (ev.t) {
    case 'init':
      f.project = ev.project;
      if (ev.trunk) f.settings.trunk = ev.trunk;
      return;
    case 'task': {
      const task = structuredClone(ev.task);
      // A journal from before ranks and counts: derive them, in the order the tasks were created, so an old board reads sensibly.
      if (typeof task.rank !== 'number') task.rank = nextRankIn(f.tasks.values(), task.priority);
      if (typeof task.changeCount !== 'number') task.changeCount = 0;
      task.activity = [];   // the history is kept beside the task (f.activity), not on it
      f.tasks.set(task.id, task);
      pushActivity(f, task.id, { at: ev.at, kind: 'created', by: ev.by ?? 'person', text: `Created in ${statusWord(task.status)}.` }, false);
      return;
    }
    case 'patch': {
      const task = f.tasks.get(ev.id);
      if (!task) return;
      const before = task.status;
      if (ev.set?.costUsd !== undefined) {
        const delta = ev.set.costUsd - (task.costUsd ?? 0);
        if (delta > 0) { const k = dayKey(Date.parse(ev.at)); f.spend.set(k, (f.spend.get(k) ?? 0) + delta); }
      }
      Object.assign(task, ev.set ?? {});
      for (const k of ev.unset ?? []) delete (task as unknown as Record<string, unknown>)[k];
      if (ev.set?.sessionId) {
        const sid = ev.set.sessionId;
        task.session = { id: sid };
        task.sessions = [...(task.sessions ?? []).filter(x => x.id !== sid), { id: sid, at: ev.at, stage: before }];
      }
      if (ev.set?.status && ev.set.status !== before) {
        pushActivity(f, ev.id, { at: ev.at, kind: 'status', by: ev.by ?? 'system', text: `${statusWord(before)} -> ${statusWord(ev.set.status)}` }, false);
      }
      task.updatedAt = ev.at;
      return;
    }
    case 'comment': {
      const task = f.tasks.get(ev.id);
      if (!task) return;
      task.review = { comments: [...(task.review?.comments ?? []), { at: ev.at, by: ev.by, text: ev.text }] };
      pushActivity(f, ev.id, { at: ev.at, kind: 'comment', by: ev.by, text: ev.text.length > 300 ? `${ev.text.slice(0, 297)}...` : ev.text }, false);
      task.updatedAt = ev.at;
      return;
    }
    case 'activity': {
      const e: ActivityEntry = { at: ev.at, kind: ev.kind, by: ev.by, text: ev.text };
      pushActivity(f, ev.id && f.tasks.has(ev.id) ? ev.id : undefined, e, true);
      if (ev.kind === 'failed' || ev.kind === 'sent-back') f.failStreak++;
      else if (ev.kind === 'review' || ev.kind === 'landed') f.failStreak = 0;
      return;
    }
    case 'rank': {
      for (const [id, rank] of Object.entries(ev.ranks)) { const t = f.tasks.get(id); if (t && Number.isFinite(rank)) t.rank = rank; }
      return;
    }
    case 'queue':
      f.queue = f.queue.filter(id => id !== ev.id);
      if (ev.op === 'push') f.queue.push(ev.id);
      return;
    case 'start':
      f.runStarted.set(ev.id, ev.at);
      return;
    case 'settings':
      applySettings(f, ev.set);
      return;
    case 'dispatcher':
      f.dispatcher = ev.state;
      if (ev.state === 'running') { f.failStreak = 0; delete f.pausedBecause; }
      else if (ev.state === 'paused') { if (ev.reason) f.pausedBecause = ev.reason; else delete f.pausedBecause; }
      if (ev.state === 'paused' && ev.reason) {
        f.feed.push({ at: ev.at, kind: 'paused', text: `Dispatcher paused: ${ev.reason}` });
        if (f.feed.length > FEED_MAX) f.feed.splice(0, f.feed.length - FEED_MAX);
      }
      return;
    case 'checks':
      f.checks.set(ev.tree, { ok: ev.ok, at: ev.at, results: ev.results });
      return;
    case 'base':
      f.base.set(ev.id, { trunkSha: ev.trunkSha, tree: ev.tree });
      return;
    case 'release':
      f.releases.set(ev.release.version, structuredClone(ev.release));
      return;
    case 'deploy': {
      const r = f.releases.get(ev.version);
      if (r) r.deploy = structuredClone(ev.deploy);
      return;
    }
    case 'rollback': {
      const r = f.releases.get(ev.version);
      if (r) r.rollback = { taskId: ev.taskId, at: ev.at };
      return;
    }
    case 'scrum':
      applyScrum(f.scrum, f.tasks, ev.ev, ev.at);
      return;
  }
}

/** Fold a journal's text. A torn or unreadable line is skipped, never fatal. */
export function foldJournal(text: string, project = ''): Folded {
  const f = emptyFold(project);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev: JournalEvent;
    try { ev = JSON.parse(line) as JournalEvent; } catch { continue; }
    if (ev && typeof ev === 'object' && typeof ev.t === 'string') apply(f, ev);
  }
  overlayScrum(f.tasks, f.scrum);
  // Not decided here: a dispatcher recorded as running stays running in the fold. The service
  // pauses it at boot (delivery/index bootDelivery), because a restart is not a person's yes to spend.
  return f;
}

const cache = new Map<string, { size: number; folded: Folded }>();

/** Tests: forget every cached fold, as a restart does. */
export function resetStoreCache(): void { cache.clear(); }

/** The folded board; `project` is the registered project's path. */
export function load(project: string): Folded {
  const file = journalFile(project);
  let size = -1;
  try { size = fs.statSync(file).size; } catch { /* no journal yet */ }
  const hit = cache.get(file);
  if (hit && hit.size === size) return hit.folded;
  let folded: Folded;
  if (size < 0) folded = emptyFold(path.resolve(project));
  else {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* raced a delete: empty */ }
    folded = foldJournal(text, path.resolve(project));
    if (!folded.project) folded.project = path.resolve(project);
  }
  cache.set(file, { size, folded });
  return folded;
}

type Listener = (project: string) => void;
const listeners = new Set<Listener>();

/** Be told whenever a journal changes (the SSE feed, the dispatcher's kick). Returns the unsubscribe. */
export function onChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function tornTail(file: string): boolean {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return false;
    fd = fs.openSync(file, 'r');
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function append(project: string, ev: JournalEvent): void {
  const file = journalFile(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A crash mid-append leaves a torn last line; start on a fresh one so this event is not glued to it.
  fs.appendFileSync(file, `${tornTail(file) ? '\n' : ''}${JSON.stringify(ev)}\n`, 'utf8');
  for (const fn of listeners) { try { fn(project); } catch { /* a listener must not break the journal */ } }
}

// ── readers ──────────────────────────────────────────────────────────────

/** The highest autonomy the organisation's policy allows, when it limits it. Installed by the service (index.ts) so the store stays free of policy. */
let capProvider: () => Autonomy | undefined = () => undefined;
export function setAutonomyCapProvider(fn: () => Autonomy | undefined): void { capProvider = fn; }

/** What each running task is doing this moment (in memory; derived from the run's session, never journaled per step). */
const liveNow = new Map<string, NonNullable<Task['live']>>();
const liveKey = (project: string, id: string): string => `${path.resolve(project)}\u0000${id}`;
export function setLive(project: string, id: string, live: NonNullable<Task['live']> | undefined): boolean {
  const k = liveKey(project, id);
  const cur = liveNow.get(k);
  if (!live) { const had = liveNow.delete(k); return had; }
  if (cur && cur.summary === live.summary && cur.tokens === live.tokens) return false;
  liveNow.set(k, live);
  return true;
}
export function liveOf(project: string, id: string): NonNullable<Task['live']> | undefined { return liveNow.get(liveKey(project, id)); }

/** Tell the watchers a board changed without a journal write (a live line moved). */
export function notifyChange(project: string): void {
  for (const fn of listeners) { try { fn(project); } catch { /* a listener must not break the board */ } }
}

/** The fold's view context: what the derived fields (blockers, idle reason, metrics) are computed from. */
export function viewContext(f: Folded, now: number): ViewContext {
  const sprint = activeSprint(f.scrum);
  return {
    now, tasks: f.tasks, dispatcher: f.dispatcher, pausedBecause: f.pausedBecause, maxParallel: f.settings.maxParallel,
    wip: f.settings.wip, budgetUsdPerDay: f.settings.budgetUsdPerDay, spentTodayUsd: f.spend.get(dayKey(now)) ?? 0,
    scrum: { mode: f.scrum.mode, activeSprintId: sprint?.id },
  };
}

export function spentToday(project: string, now = Date.now()): number { return load(project).spend.get(dayKey(now)) ?? 0; }

export function boardState(project: string, now: number = Date.now()): BoardState {
  const f = load(project);
  const ctx = viewContext(f, now);
  const roll = rollups(f.tasks);
  const sorted = [...f.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const tasks = sorted.map(t => {
    const c = structuredClone(t);
    const blocked = blockedByOf(c, f.tasks);
    if (blocked.length > 0) c.blockedBy = blocked;
    const why = startBlocker(c, ctx);
    if (why) c.waitingReason = why;
    const live = t.status === 'running' ? liveOf(f.project || project, t.id) : undefined;
    if (live) c.live = { ...live };
    const children = roll.get(t.id);
    if (children) c.children = { ...children };
    if (c.sessionId && !c.session) c.session = { id: c.sessionId };
    c.activity = lastEntries(f.activity.get(t.id), BOARD_TASK_ACTIVITY);
    return c;
  });
  const running = f.tasks.size === 0 ? [] : [...f.tasks.values()]
    .filter(t => t.status === 'running' && t.claim)
    .map(t => ({ taskId: t.id, runId: t.claim!.runId, startedAt: f.runStarted.get(t.id) ?? t.updatedAt, costUsd: t.costUsd ?? 0 }));
  const cap = capProvider();
  const autonomy = cap ? minAutonomy(f.settings.autonomy, cap) : f.settings.autonomy;
  const idle = idleReasonOf(ctx);
  return {
    project: f.project || path.resolve(project),
    tasks,
    queue: [...f.queue],
    running,
    // A board that never used Scrum reads exactly as it did before: the Scrum keys appear with the first Scrum fact.
    settings: { ...f.settings, wip: { ...f.settings.wip }, views: f.settings.views.map(v => ({ ...v })), ...(f.scrum.mode === 'scrum' ? { mode: 'scrum' as const } : {}) },
    dispatcher: f.dispatcher,
    autonomy,
    ...(cap && cap !== 'full' ? { autonomyCap: cap } : {}),
    ...(idle ? { idleReason: idle } : {}),
    ...(f.pausedBecause && f.dispatcher === 'paused' ? { pausedBecause: f.pausedBecause } : {}),
    metrics: metricsOf(f.tasks.values(), f.runStarted, ctx.spentTodayUsd, now),
    agents: agentsOf(tasks, f.settings.maxParallel),
    feed: f.feed.map(e => ({ ...e })),
    ...(f.scrum.sprints.size > 0 ? { sprints: sprintList(f.scrum) } : {}),
    ...(f.scrum.proposals.size > 0 ? { proposals: openProposals(f.scrum) } : {}),
    releases: [...f.releases.values()].sort((a, b) => b.at.localeCompare(a.at) || b.version.localeCompare(a.version)).map(r => structuredClone(r)),
  };
}

/** A task's history, up to 200 lines, oldest first. */
export function taskActivity(project: string, id: string): ActivityEntry[] {
  return (load(project).activity.get(id) ?? []).map(e => ({ ...e }));
}

export function getRelease(project: string, version: string): Release | undefined {
  const r = load(project).releases.get(version);
  return r ? structuredClone(r) : undefined;
}

export function getTask(project: string, id: string): Task | undefined {
  const t = load(project).tasks.get(id);
  return t ? structuredClone(t) : undefined;
}

/** Every project that has a journal, for the boot sweep and the worktree lookup by folder key. */
export function journaledProjects(): string[] {
  const out: string[] = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(deliveryRoot()); } catch { return out; }
  for (const d of dirs) {
    let fd: number | undefined;
    try {
      // Only the first line names the project, and a poll asks for every board: do not read a long journal whole.
      fd = fs.openSync(path.join(deliveryRoot(), d, 'board.jsonl'), 'r');
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const first = buf.toString('utf8', 0, n).split('\n').find(l => l.trim());
      const ev = first ? JSON.parse(first) as JournalEvent : undefined;
      if (ev?.t === 'init' && ev.project) out.push(ev.project);
    } catch { /* not a journal */ } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return out;
}

/** The project a `<project key>` folder belongs to (a task's worktree names its key). */
export function projectOfKey(key: string): string | undefined {
  return journaledProjects().find(p => projectKey(p) === key);
}

// ── writers (facts only; the service decides) ────────────────────────────

/** First write for a project: records its path and trunk branch. Idempotent. */
export function ensureInit(project: string, trunk: string): void {
  const p = path.resolve(project);
  if (fs.existsSync(journalFile(p))) return;
  append(p, { t: 'init', at: iso(), project: p, trunk });
}

export function putTask(project: string, task: Task, by: 'person' | 'agent' | 'system' = 'person'): void { append(project, { t: 'task', at: iso(), task, by }); }

export function patchTask(project: string, id: string, set: Partial<Task>, unset: Array<keyof Task> = [], by: 'person' | 'agent' | 'system' = 'system'): void {
  append(project, { t: 'patch', at: iso(), id, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}), by });
}

/** One line of history for a task (or, with no id, the board). The kinds `failed` and `sent-back` feed the failure streak; `review` and `landed` reset it. */
export function logActivity(project: string, id: string | undefined, kind: string, by: 'person' | 'agent' | 'system', text: string): void {
  append(project, { t: 'activity', at: iso(), ...(id ? { id } : {}), kind, by, text: text.slice(0, 600) });
}

/** New ranks for the cards that moved (one event, so a reorder is atomic). */
export function setRanks(project: string, ranks: Record<string, number>): void { append(project, { t: 'rank', at: iso(), ranks }); }

export function addComment(project: string, id: string, by: 'person' | 'agent', text: string): void {
  append(project, { t: 'comment', at: iso(), id, by, text: text.slice(0, 8000) });
}

export function queuePush(project: string, id: string): void { append(project, { t: 'queue', at: iso(), op: 'push', id }); }
export function queueDrop(project: string, id: string): void { append(project, { t: 'queue', at: iso(), op: 'drop', id }); }
export function markStart(project: string, id: string, runId: string): void { append(project, { t: 'start', at: iso(), id, runId }); }
export function setSettings(project: string, set: Partial<BoardSettings>): void { append(project, { t: 'settings', at: iso(), set }); }
export function setDispatcher(project: string, state: DispatcherState, reason?: string): void { append(project, { t: 'dispatcher', at: iso(), state, ...(reason ? { reason } : {}) }); }
export function recordChecks(project: string, tree: string, ok: boolean, results: CheckRecord[]): void { append(project, { t: 'checks', at: iso(), tree, ok, results }); }
export function recordBase(project: string, id: string, trunkSha: string, tree: string): void { append(project, { t: 'base', at: iso(), id, trunkSha, tree }); }
export function putRelease(project: string, release: Release): void { append(project, { t: 'release', at: iso(), release }); }
export function setDeploy(project: string, version: string, deploy: NonNullable<Release['deploy']>): void { append(project, { t: 'deploy', at: iso(), version, deploy }); }
export function recordScrum(project: string, ev: ScrumEvent): void { append(project, { t: 'scrum', at: iso(), ev }); }
export function setRollback(project: string, version: string, taskId: string): void { append(project, { t: 'rollback', at: iso(), version, taskId }); }
