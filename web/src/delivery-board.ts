/**
 * The logic of a true board, without a DOM: ordering inside a column, WIP limits,
 * swimlanes, filters and saved views, the honest "why is nothing running" line,
 * how a refused landing becomes choices, and the words the autonomy control uses.
 *
 * WHY separate: the owner's first real use of Delivery failed on exactly these
 * places. Ready tasks sat forever because their prerequisites were in Backlog and the
 * board said only "starting…"; Approve showed a raw git error; the Changes tab counted
 * 1 and showed nothing. Each of those is a sentence the board must get right, and a
 * sentence is testable (web/test-delivery-board.mjs) in a way a screenshot is not.
 *
 * Every function reads the newer engine fields (rank, blockedBy, idleReason, autonomy
 * ...) through a default, so a board from an engine that predates them still draws:
 * blockers are recomputed from `dependsOn`, the agents strip from `running`, and so on.
 * The engine stays the authority (it refuses an illegal move, owns the ranks, decides
 * what lands); this module only keeps the UI from offering what would be refused and
 * says plainly why.
 *
 * What it does not do: fetch, render, persist. Saved views are plain `{ name, filter }`
 * where `filter` is the text in the filter box (`assignee:"Agent A" type:bug fix login`),
 * so a view is readable in a settings file and survives a change of the filter UI.
 *
 * @module web/delivery-board
 */

import { elapsed, formatUsd, makeRef, shortId, toMs, type RefFn } from './delivery-model';
import { AUTONOMY_LABEL, AUTONOMY_LEVELS as AUTONOMY_ORDER, AUTONOMY_SUMMARY } from '../../shared/delivery/autonomy';
import type { ActivityEntry, Autonomy, BoardAgent, BoardState, FeedEntry, SavedView, Task, TaskStatus, TaskType } from './delivery-types';

// ── refs in a sentence ────────────────────────────────────────────────

/** "#1", "#1 and #2", "#1, #2 and #3". */
export function listRefs(ids: readonly string[], ref: RefFn = shortId): string {
  const r = ids.map(ref);
  if (r.length <= 1) return r.join('');
  return `${r.slice(0, -1).join(', ')} and ${r[r.length - 1]}`;
}

const STATUS_WORD: Record<TaskStatus, string> = {
  backlog: 'Backlog', ready: 'Ready', running: 'Running', review: 'In review', changes: 'Changes requested', pr: 'PR open',
  merged: 'Merged', blocked: 'Blocked', cancelled: 'Cancelled',
};

// ── blockers ──────────────────────────────────────────────────────────

export interface Blocker { id: string; status: TaskStatus | 'missing' }

/**
 * What a task is waiting for: the engine's `blockedBy` when it sends one, else the
 * unmerged tasks in `dependsOn`. A prerequisite that no longer exists counts as unmet
 * (unknown is not done), as everywhere else on the board.
 */
export function blockersOf(task: Pick<Task, 'dependsOn' | 'blockedBy'>, byId: ReadonlyMap<string, Pick<Task, 'status'>>): Blocker[] {
  if (task.blockedBy) return task.blockedBy.filter(b => b.status !== 'merged').map(b => ({ id: b.id, status: b.status }));
  return task.dependsOn.flatMap((id): Blocker[] => {
    const d = byId.get(id);
    return d?.status === 'merged' ? [] : [{ id, status: d ? d.status : 'missing' }];
  });
}

export interface BlockedChip { id: string; text: string; status: Blocker['status']; statusWord: string }

/** "Blocked by #2 · Backlog" for each unmet prerequisite; only for work that has not started. */
export function blockedChips(task: Task, byId: ReadonlyMap<string, Task>, ref: RefFn = shortId): BlockedChip[] {
  if (task.status !== 'backlog' && task.status !== 'ready' && task.status !== 'blocked') return [];
  return blockersOf(task, byId).map(b => {
    const word = b.status === 'missing' ? 'missing' : STATUS_WORD[b.status];
    return { id: b.id, status: b.status, statusWord: word, text: `Blocked by ${ref(b.id)} · ${word}` };
  });
}

// ── why nothing is moving ─────────────────────────────────────────────

export interface StatusLine {
  /** `working`: agents are on tasks; `idle`: on but nothing can start; `paused`: stopped, maybe with a reason; `off`: not started. */
  state: 'working' | 'idle' | 'paused' | 'off';
  /** One calm sentence. */
  text: string;
  /** More, for a tooltip or the banner's second line. */
  detail?: string;
  /** Ready tasks that cannot start yet, and the Backlog prerequisites a click could move to Ready. */
  blockedReady: string[];
  promote: string[];
  /** The label of the one-click fix, when there is one. */
  fix?: string;
  /** "2 ready tasks wait for #1 and #2 (in Backlog)": why Ready tasks cannot start, whatever state the agents are in. */
  waits?: string;
  /** Why they wait, in a sentence. */
  why?: string;
  /**
   * A Ready task waits for something that will never move by itself (a prerequisite in Backlog, blocked, cancelled or
   * missing). A prerequisite that is Ready, running or in review is just the queue working, and is not a problem.
   */
  stuck: boolean;
}

/**
 * The board's one-line truth. The wording the owner needed: not "Agents on · starting…" but
 * "Idle: 2 ready tasks wait for #1 and #2 (in Backlog)", with the click that fixes it.
 */
export function statusLine(board: BoardState, tasks: readonly Task[], ref: RefFn = shortId): StatusLine {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const running = board.running.length;
  const max = board.settings.maxParallel;
  const blockedReady: string[] = [];
  const promoteSet = new Set<string>();
  const others = new Map<string, Blocker['status']>();
  let stuck = false;
  for (const t of tasks) {
    if (t.status !== 'ready') continue;
    const bs = blockersOf(t, byId);
    if (bs.length === 0) continue;
    blockedReady.push(t.id);
    for (const b of bs) {
      if (b.status === 'backlog') promoteSet.add(b.id);
      else others.set(b.id, b.status);
      if (b.status === 'backlog' || b.status === 'blocked' || b.status === 'cancelled' || b.status === 'missing') stuck = true;
    }
  }
  const promote = [...promoteSet];
  const ready = tasks.filter(t => t.status === 'ready');
  const free = ready.filter(t => !blockedReady.includes(t.id));
  const fix = promote.length ? `Move ${listRefs(promote, ref)} to Ready` : undefined;
  let waits: string | undefined;
  if (blockedReady.length > 0) {
    const n = blockedReady.length;
    const wait: string[] = [];
    if (promote.length) wait.push(`${listRefs(promote, ref)} (in Backlog)`);
    for (const [id, st] of others) wait.push(`${ref(id)} (${st === 'missing' ? 'missing' : STATUS_WORD[st].toLowerCase()})`);
    waits = `${n} ready ${n === 1 ? 'task waits' : 'tasks wait'} for ${wait.length > 1 ? `${wait.slice(0, -1).join(', ')} and ${wait[wait.length - 1]}` : wait[0] ?? 'prerequisites'}`;
  }
  const why = promote.length ? 'Agents only start a task after the tasks it depends on have merged, and nothing starts a task that is still in Backlog.'
    : stuck ? 'A prerequisite that is blocked, cancelled or missing never merges by itself: open it, or take it out of the dependencies.'
    : 'They start by themselves once those merge.';
  const base = { blockedReady, promote, stuck, ...(fix ? { fix } : {}), ...(waits ? { waits, why } : {}) };

  if (board.dispatcher === 'paused') {
    return {
      ...base, state: 'paused', text: board.pausedBecause ? `Paused: ${board.pausedBecause}` : `Paused${running ? ` · ${running} finishing` : ''}`,
      ...(waits ? { detail: `${waits}. ${why}` } : board.pausedBecause ? { detail: 'Resume when you have looked at it.' } : board.idleReason ? { detail: board.idleReason } : {}),
    };
  }
  if (board.dispatcher !== 'running') return { ...base, state: 'off', text: 'Agents are stopped', detail: waits ? `${waits}. ${why}` : 'Start the agents to let them take Ready tasks.' };
  if (running > 0) return { ...base, state: 'working', text: `Agents working ${running}/${max}` };

  // On, and nothing is running: say why, never "starting…" for more than the moment it takes.
  if (waits && free.length === 0) return { ...base, state: 'idle', text: `Idle: ${waits}`, detail: why };
  if (board.idleReason) return { ...base, state: 'idle', text: `Idle: ${board.idleReason}` };
  if (free.length > 0) return { ...base, state: 'idle', text: `Idle: ${free.length} ready ${free.length === 1 ? 'task' : 'tasks'}, about to start`, detail: 'If this stays, check the budget and failure limits in the autonomy control.' };
  return { ...base, state: 'idle', text: 'Idle: no tasks are Ready', detail: 'Move a task to Ready, or plan from a brief.' };
}

// ── ordering inside a column ──────────────────────────────────────────

/** `ids` with `id` taken out and put before `beforeId` (the end when null or unknown). */
export function reorderIds(ids: readonly string[], id: string, beforeId: string | null): string[] {
  const rest = ids.filter(x => x !== id);
  const at = beforeId ? rest.indexOf(beforeId) : -1;
  if (at < 0) return [...rest, id];
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Keyboard reorder: one step up or down; unchanged at the ends. */
export function nudgeId(ids: readonly string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const out = [...ids];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

// ── WIP ───────────────────────────────────────────────────────────────

export type WipState = 'none' | 'ok' | 'at' | 'over';

/** A column's limit against its count; `at` is where the header turns amber, `over` where it says so in words. */
export function wipState(limit: number | undefined, count: number): WipState {
  if (!limit || limit <= 0) return 'none';
  return count > limit ? 'over' : count === limit ? 'at' : 'ok';
}

/** The limit of a column: Running's falls back to the number of agents. */
export function wipLimit(board: Pick<BoardState, 'settings'>, status: TaskStatus): number | undefined {
  const w = board.settings.wip;
  if (status === 'running') return w?.running ?? board.settings.maxParallel;
  if (status === 'review') return w?.review;
  return undefined;
}

// ── epics ─────────────────────────────────────────────────────────────

export function childrenOf(parentId: string, tasks: readonly Task[]): Task[] {
  return tasks.filter(t => t.parentId === parentId);
}

export interface EpicProgress { done: number; total: number; pct: number }

/** Merged children of the total; cancelled ones do not count either way. */
export function epicProgress(parentId: string, tasks: readonly Task[]): EpicProgress {
  const kids = childrenOf(parentId, tasks).filter(t => t.status !== 'cancelled');
  const done = kids.filter(t => t.status === 'merged').length;
  return { done, total: kids.length, pct: kids.length ? Math.round((done / kids.length) * 100) : 0 };
}

export function isEpic(task: Pick<Task, 'id'>, tasks: readonly Task[]): boolean {
  return tasks.some(t => t.parentId === task.id);
}

// ── swimlanes ─────────────────────────────────────────────────────────

export type LaneBy = 'none' | 'assignee' | 'type' | 'epic';
export const LANE_OPTIONS: ReadonlyArray<{ id: LaneBy; label: string }> = [
  { id: 'none', label: 'No lanes' }, { id: 'assignee', label: 'Assignee' }, { id: 'type', label: 'Type' }, { id: 'epic', label: 'Epic' },
];

export const TYPE_LABEL: Record<TaskType, string> = { feature: 'Feature', bug: 'Bug', chore: 'Chore', spike: 'Spike', docs: 'Docs' };
const TYPE_ORDER: TaskType[] = ['feature', 'bug', 'chore', 'spike', 'docs'];

export interface Lane { key: string; label: string; tasks: Task[]; /** Epic lanes: the epic itself, for its progress bar. */ epic?: Task }

/** Which lane a task sits in; '' is the catch-all ("Unassigned", "No type", "No epic"). */
export function laneKey(task: Task, by: LaneBy, epicIds: ReadonlySet<string> = new Set()): string {
  if (by === 'assignee') return task.assignee ? `${task.assignee.kind}:${task.assignee.name}` : '';
  if (by === 'type') return task.type ?? '';
  if (by === 'epic') return task.parentId ?? (epicIds.has(task.id) ? task.id : '');
  return '';
}

/** Lanes in a stable, readable order. `none` is one lane holding everything. Empty lanes are not returned. */
export function buildLanes(tasks: readonly Task[], by: LaneBy, all: readonly Task[] = tasks): Lane[] {
  if (by === 'none') return [{ key: '', label: '', tasks: [...tasks] }];
  const epicIds = new Set(all.filter(t => t.parentId).map(t => t.parentId!));
  const byId = new Map(all.map(t => [t.id, t]));
  const lanes = new Map<string, Lane>();
  for (const t of tasks) {
    const key = laneKey(t, by, epicIds);
    let lane = lanes.get(key);
    if (!lane) {
      const label = by === 'assignee' ? (key ? key.slice(key.indexOf(':') + 1) : 'Unassigned')
        : by === 'type' ? (key ? TYPE_LABEL[key as TaskType] ?? key : 'No type')
        : (key ? byId.get(key)?.title ?? 'Unknown epic' : 'No epic');
      lane = { key, label, tasks: [], ...(by === 'epic' && key && byId.get(key) ? { epic: byId.get(key)! } : {}) };
      lanes.set(key, lane);
    }
    lane.tasks.push(t);
  }
  const rank = (l: Lane): number => {
    if (!l.key) return 1e6; // the catch-all last
    if (by === 'type') return TYPE_ORDER.indexOf(l.key as TaskType);
    if (by === 'assignee') return l.key.startsWith('agent:') ? 0 : 1;
    return l.epic?.rank ?? 1;
  };
  return [...lanes.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

// ── filters and saved views ───────────────────────────────────────────

export interface Filter {
  text: string;
  assignee: string[];
  type: TaskType[];
  label: string[];
  priority: number[];
  status: TaskStatus[];
  /** `is:needs`, `is:blocked`. */
  needs: boolean;
  blocked: boolean;
}

export const EMPTY_FILTER: Filter = { text: '', assignee: [], type: [], label: [], priority: [], status: [], needs: false, blocked: false };

/** Words and "quoted phrases" split on spaces. */
function tokens(input: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s"]+:)?"[^"]*"|\S+/g;
  for (const m of input.matchAll(re)) out.push(m[0]);
  return out;
}
const unquote = (v: string): string => (v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v);

const STATUS_BY_WORD: Record<string, TaskStatus> = {
  backlog: 'backlog', ready: 'ready', running: 'running', review: 'review', changes: 'changes', pr: 'pr', merged: 'merged', blocked: 'blocked', cancelled: 'cancelled',
};

/** Read the filter box. Unknown `key:value` words stay in the free text, so nothing typed is silently dropped. */
export function parseFilter(input: string): Filter {
  const f: Filter = { ...EMPTY_FILTER, assignee: [], type: [], label: [], priority: [], status: [] };
  const text: string[] = [];
  for (const tok of tokens(input)) {
    const m = /^([a-z]+):(.+)$/i.exec(tok);
    const key = m?.[1]?.toLowerCase();
    const val = m ? unquote(m[2]!) : '';
    if (key === 'assignee' && val) f.assignee.push(val);
    else if (key === 'type' && (TYPE_ORDER as string[]).includes(val.toLowerCase())) f.type.push(val.toLowerCase() as TaskType);
    else if (key === 'label' && val) f.label.push(val);
    else if (key === 'priority' && /^[1-4]$/.test(val)) f.priority.push(Number(val));
    else if (key === 'status' && STATUS_BY_WORD[val.toLowerCase()]) f.status.push(STATUS_BY_WORD[val.toLowerCase()]!);
    else if (key === 'is' && val.toLowerCase() === 'needs') f.needs = true;
    else if (key === 'is' && val.toLowerCase() === 'blocked') f.blocked = true;
    else text.push(tok);
  }
  f.text = text.join(' ');
  return f;
}

const q = (v: string): string => (/\s/.test(v) ? `"${v}"` : v);

/** The inverse of {@link parseFilter}: the text a saved view stores. */
export function formatFilter(f: Filter): string {
  return [
    ...f.assignee.map(v => `assignee:${q(v)}`), ...f.type.map(v => `type:${v}`), ...f.label.map(v => `label:${q(v)}`),
    ...f.priority.map(v => `priority:${v}`), ...f.status.map(v => `status:${v}`),
    ...(f.needs ? ['is:needs'] : []), ...(f.blocked ? ['is:blocked'] : []), ...(f.text.trim() ? [f.text.trim()] : []),
  ].join(' ');
}

export function isEmptyFilter(f: Filter): boolean {
  return formatFilter(f) === '';
}

/** Does a task pass the filter? Different keys are ANDed; several values of one key are ORed. */
export function matchesFilter(t: Task, f: Filter, ref: RefFn = shortId, byId?: ReadonlyMap<string, Task>): boolean {
  if (f.needs && !t.needs) return false;
  if (f.blocked && !(byId ? blockersOf(t, byId).length > 0 : (t.blockedBy ?? []).some(b => b.status !== 'merged'))) return false;
  if (f.assignee.length) {
    const name = t.assignee?.name.toLowerCase() ?? 'unassigned';
    if (!f.assignee.some(a => a.toLowerCase() === name)) return false;
  }
  if (f.type.length && !(t.type && f.type.includes(t.type))) return false;
  if (f.label.length && !f.label.some(l => t.labels.some(x => x.toLowerCase() === l.toLowerCase()))) return false;
  if (f.priority.length && !f.priority.includes(t.priority)) return false;
  if (f.status.length && !f.status.includes(t.status)) return false;
  const text = f.text.trim().toLowerCase();
  if (!text) return true;
  return text.split(/\s+/).every(w =>
    t.title.toLowerCase().includes(w) || ref(t.id).toLowerCase() === w.replace(/^#?/, '#') || t.labels.some(l => l.toLowerCase().includes(w)) || (t.assignee?.name.toLowerCase().includes(w) ?? false));
}

export function applyFilter(tasks: readonly Task[], f: Filter, ref: RefFn = shortId): Task[] {
  if (isEmptyFilter(f)) return [...tasks];
  const byId = new Map(tasks.map(t => [t.id, t]));
  return tasks.filter(t => matchesFilter(t, f, ref, byId));
}

/** Names offered in the filter's menus, from what is on the board. */
export function assigneesOf(tasks: readonly Task[]): string[] {
  return [...new Set(tasks.flatMap(t => (t.assignee ? [t.assignee.name] : [])))].sort((a, b) => a.localeCompare(b));
}

export function upsertView(views: readonly SavedView[], name: string, filter: string): SavedView[] {
  const n = name.trim();
  if (!n) return [...views];
  return [...views.filter(v => v.name.toLowerCase() !== n.toLowerCase()), { name: n, filter }];
}
export function removeView(views: readonly SavedView[], name: string): SavedView[] {
  return views.filter(v => v.name !== name);
}
/** The saved view whose filter is exactly this one (order of words aside). */
export function activeView(views: readonly SavedView[], filter: string): SavedView | undefined {
  const norm = (s: string): string => formatFilter(parseFilter(s));
  const want = norm(filter);
  return want ? views.find(v => norm(v.filter) === want) : undefined;
}

// ── sorting for the list view ─────────────────────────────────────────

export type SortKey = 'ref' | 'title' | 'status' | 'assignee' | 'priority' | 'type' | 'estimate' | 'due' | 'updated';
const STATUS_ORDER: TaskStatus[] = ['backlog', 'ready', 'running', 'review', 'changes', 'pr', 'merged', 'blocked', 'cancelled'];

export function sortTasks(tasks: readonly Task[], key: SortKey, dir: 'asc' | 'desc', ref: RefFn = shortId): Task[] {
  const num = (s: string): number => Number(s.replace(/\D/g, '')) || 0;
  const val = (t: Task): number | string => {
    switch (key) {
      case 'ref': return num(ref(t.id));
      case 'title': return t.title.toLowerCase();
      case 'status': return STATUS_ORDER.indexOf(t.status);
      case 'assignee': return t.assignee?.name.toLowerCase() ?? '￿';
      case 'priority': return t.priority;
      case 'type': return t.type ? TYPE_ORDER.indexOf(t.type) : 99;
      case 'estimate': return t.estimate ?? -1;
      case 'due': return t.dueDate ? toMs(t.dueDate) : Number.MAX_SAFE_INTEGER;
      case 'updated': return toMs(t.updatedAt);
    }
  };
  const sign = dir === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    const x = val(a); const y = val(b);
    const c = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : (x as number) - (y as number);
    return c * sign || num(ref(a.id)) - num(ref(b.id));
  });
}

// ── due dates, assignees ──────────────────────────────────────────────

export type DueState = 'overdue' | 'today' | 'soon' | 'later';

/** Compare calendar days, not instants: a task due "today" is not overdue at 3 pm. */
export function dueState(due: string | undefined, now: number): DueState | null {
  if (!due) return null;
  const d = /^\d{4}-\d{2}-\d{2}/.test(due) ? new Date(`${due.slice(0, 10)}T00:00:00`) : new Date(toMs(due));
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  return days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 2 ? 'soon' : 'later';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Overdue 3d", "Today", "Tomorrow", "Oct 12". */
export function formatDue(due: string | undefined, now: number): string {
  const st = dueState(due, now);
  if (!due || !st) return '';
  const d = /^\d{4}-\d{2}-\d{2}/.test(due) ? new Date(`${due.slice(0, 10)}T00:00:00`) : new Date(toMs(due));
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (st === 'overdue') return `Overdue ${-days}d`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "AA" for "Agent A", "SR" for "Sam Rivera", "S" for "sam". */
export function initials(name: string): string {
  const w = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (w.length === 0) return '?';
  return (w.length === 1 ? w[0]!.slice(0, 1) : w[0]!.slice(0, 1) + w[w.length - 1]!.slice(0, 1)).toUpperCase();
}

// ── landing, and what to do when it is refused ────────────────────────

export interface LandingChoice { id: string; label: string; hint: string; tone: 'primary' | 'neutral' | 'danger' }
export interface LandingProblem {
  code: string;
  title: string;
  body: string;
  files: string[];
  /** Why each file is in the way (`untracked` or `modified`), when the engine says. */
  why: Record<string, string>;
  choices: LandingChoice[];
  /** True when this is a refusal we recognise; false means show the engine's message as is. */
  known: boolean;
}

const CHOICE_COPY: Record<string, Omit<LandingChoice, 'id'>> = {
  'keep-mine': { label: 'Keep my files', hint: 'Your versions stay exactly as they are. The task’s change to those files is dropped from its branch, and the rest lands.', tone: 'primary' },
  'take-task': { label: 'Use the task’s version', hint: 'A copy of your files is saved aside first, then the task’s versions replace them. Nothing is lost.', tone: 'neutral' },
  'stash': { label: 'Stash my changes, then land', hint: 'Your uncommitted work is stashed and can be restored afterwards.', tone: 'primary' },
  'retry': { label: 'Try again', hint: 'Land again now.', tone: 'primary' },
  'rebase': { label: 'Update the branch, then land', hint: 'The trunk moved. The agent re-runs the checks on the updated branch.', tone: 'primary' },
  'cancel': { label: 'Leave it', hint: 'Nothing changes.', tone: 'neutral' },
  'abort': { label: 'Leave it', hint: 'Nothing changes.', tone: 'neutral' },
};

function humanise(id: string): string {
  const s = id.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function choiceOf(id: string): LandingChoice {
  const c = CHOICE_COPY[id];
  return c ? { id, ...c } : { id, label: humanise(id), hint: '', tone: 'neutral' };
}

/** The files a git "untracked working tree files would be overwritten" message lists (tab-indented lines). */
export function filesFromGitMessage(message: string): string[] {
  const at = message.search(/untracked working tree files would be overwritten/i);
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of message.slice(at).split(/\r?\n/).slice(1)) {
    if (/^\s+\S/.test(line) && !/^\s*(please|aborting|error|hint)/i.test(line)) out.push(line.trim());
    else if (out.length) break;
  }
  return out;
}

type FileEntry = string | { path: string; why?: string };

function normaliseFiles(files: unknown): { files: string[]; why: Record<string, string> } {
  const out: string[] = []; const why: Record<string, string> = {};
  if (Array.isArray(files)) for (const f of files as FileEntry[]) {
    const path = typeof f === 'string' ? f : f?.path;
    if (typeof path !== 'string' || !path) continue;
    out.push(path);
    if (typeof f === 'object' && f.why) why[path] = f.why;
  }
  return { files: out, why };
}

function problemFor(code: string, files: string[], why: Record<string, string>, choices: string[], message: string): LandingProblem {
  const n = files.length;
  const base = { code, files, why, choices: choices.map(choiceOf) };
  switch (code) {
    case 'untracked-collision':
    case 'landing-collision': {
      const edited = files.length > 0 && files.every(f => why[f] === 'modified');
      return {
        ...base, known: true,
        title: 'Landing would overwrite files in your project folder',
        body: `${n ? `${n} ${n === 1 ? 'file' : 'files'}` : 'Some files'} in your project folder ${n === 1 ? 'has' : 'have'} ${edited ? 'edits that are not committed' : 'content that is not committed'}, and the task’s branch also writes ${n === 1 ? 'it' : 'them'}. Nothing was changed.`,
      };
    }
    case 'dirty-trunk':
      return { ...base, known: true, title: 'The trunk has uncommitted changes', body: 'Landing needs a clean trunk, and the folder has edits that are not committed. Nothing was changed.' };
    case 'trunk-moved':
      return { ...base, known: true, title: 'The trunk moved while this was in review', body: 'Other work landed first, so the checks that passed no longer describe what would land. Nothing was changed.' };
    default:
      return { ...base, code: code || 'unknown', known: false, title: 'Could not land this change', body: message };
  }
}

/**
 * Turn whatever a refused approve carried into something a person can act on. The engine sends
 * `{ code, files, choices, message }`; an older one sends a raw git sentence, which is recognised here
 * for the one collision the owner hit, so the file list shows even before the engine does the work.
 */
export function landingProblem(err: unknown): LandingProblem {
  const body = (err && typeof err === 'object' && 'body' in err ? (err as { body?: unknown }).body : undefined) as Record<string, unknown> | undefined;
  const message = String(body?.message ?? body?.error ?? (err instanceof Error ? err.message : err) ?? 'The change could not be landed.');
  let code = typeof body?.code === 'string' ? body.code : '';
  let { files, why } = normaliseFiles(body?.details ?? body?.files);
  if (!files.length) ({ files, why } = normaliseFiles(body?.files));
  const choices = Array.isArray(body?.choices) ? (body!.choices as unknown[]).map(String) : [];
  if (!code && /untracked working tree files would be overwritten/i.test(message)) { code = 'untracked-collision'; if (!files.length) files = filesFromGitMessage(message); }
  if (!code && /(local changes to the following files would be overwritten|your local changes would be overwritten|working (tree|directory) (is )?not clean|uncommitted changes)/i.test(message)) code = 'dirty-trunk';
  return problemFor(code, files, why, choices, message);
}

/** The persisted form (`Task.landingBlock`): the same panel, still there after a reload. */
export function landingFromBlock(block: NonNullable<Task['landingBlock']>): LandingProblem {
  const { files, why } = normaliseFiles(block.files);
  return problemFor('untracked-collision', files, why, block.choices, '');
}

// ── autonomy ──────────────────────────────────────────────────────────

export interface AutonomyLevel {
  id: Autonomy;
  label: string;
  /** The engine's own promise for this level (shared/delivery/autonomy): the same words it was written against. */
  line: string;
}

/** Lowest to highest, with the engine's names and sentences. */
export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = AUTONOMY_ORDER.map(id => ({ id, label: AUTONOMY_LABEL[id], line: AUTONOMY_SUMMARY[id] }));

/**
 * What a level does without anyone clicking, level by level up to and including `to`. Each shared summary
 * reads "Also ...", so the list for Full is the whole ladder, not just its last rung.
 */
export function automaticAt(to: Autonomy): string[] {
  return AUTONOMY_LEVELS.slice(1, AUTONOMY_ORDER.indexOf(to) + 1).map(l => l.line.replace(/^Also /, '').replace(/^./, c => c.toUpperCase()));
}

/** What still stops for a person, said once per level so the confirm dialog cannot forget one. */
export function alwaysNeedsYou(level: Autonomy): string[] {
  return [
    level === 'full' ? 'Any gate that is not green, and anything your organisation’s policy holds back.' : 'High-risk changes.',
    'A change with a possible secret, or a test that was weakened: it never lands on its own.',
    'Questions the agent asks and tool permissions it requests.',
    'Anything past the daily budget or the failure limit: the agents pause and say why.',
  ];
}

export function autonomyLevel(a: Autonomy | undefined): AutonomyLevel {
  return AUTONOMY_LEVELS.find(l => l.id === a) ?? AUTONOMY_LEVELS[0]!;
}

/** The highest level a person may pick: the organisation's cap when there is one. */
export function autonomyAllowed(level: Autonomy, cap: Autonomy | undefined): boolean {
  return !cap || AUTONOMY_ORDER.indexOf(level) <= AUTONOMY_ORDER.indexOf(cap);
}

/** Moving above Manual spends money and lands code by itself, so it asks. Lowering never does. */
export function autonomyNeedsConfirm(from: Autonomy | undefined, to: Autonomy): boolean {
  return AUTONOMY_ORDER.indexOf(to) > Math.max(AUTONOMY_ORDER.indexOf(from ?? 'manual'), 0);
}

export interface SettingsDraft { budget: string; failures: string; wipRunning: string; wipReview: string }
export interface SettingsPatch { budgetUsdPerDay?: number; pauseAfterFailures?: number; wip?: { running?: number; review?: number } }

/** Parse the four number fields; an empty WIP field means "no limit". Errors name the field. */
export function parseSettingsDraft(d: SettingsDraft, maxParallel: number): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  const num = (s: string): number | null | undefined => (s.trim() === '' ? undefined : /^\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : null);
  const budget = num(d.budget); const fails = num(d.failures); const wr = num(d.wipRunning); const wv = num(d.wipReview);
  if (budget === null) return { ok: false, error: 'Daily budget must be a number of dollars.' };
  if (fails === null || (fails !== undefined && !Number.isInteger(fails))) return { ok: false, error: 'Pause after failures must be a whole number.' };
  if (wr === null || (wr !== undefined && !Number.isInteger(wr))) return { ok: false, error: 'The Running limit must be a whole number.' };
  if (wv === null || (wv !== undefined && !Number.isInteger(wv))) return { ok: false, error: 'The Review limit must be a whole number.' };
  if (wr !== undefined && wr > Math.max(maxParallel, 1) * 4) return { ok: false, error: 'The Running limit is higher than the number of agents can use.' };
  return { ok: true, patch: { ...(budget !== undefined ? { budgetUsdPerDay: budget } : {}), ...(fails !== undefined ? { pauseAfterFailures: fails } : {}), wip: { ...(wr ? { running: wr } : {}), ...(wv ? { review: wv } : {}) } } };
}

/** Why a landing was automatic, in words: the engine's recorded reason when it has one, else the risk and the checks. */
export function autoLandReason(task: Task): string {
  const d = task.landed?.decision;
  if (d?.reason) return d.reason;
  const parts: string[] = [];
  if (task.risk) parts.push(`${task.risk.level} risk`);
  if (task.evidence?.summary) parts.push(task.evidence.summary.split('\n')[0]!.trim());
  return parts.length ? parts.join(', ') : 'it met the autonomy rules';
}

// ── agents, activity, metrics ─────────────────────────────────────────

const SLOT_NAMES = ['Agent A', 'Agent B', 'Agent C', 'Agent D', 'Agent E', 'Agent F', 'Agent G', 'Agent H'];

/** The strip's slots: the engine's `agents`, else one per running task, padded with idle slots up to the limit. */
export function agentsOf(board: BoardState, tasks: readonly Task[]): BoardAgent[] {
  if (board.agents && board.agents.length) return board.agents;
  const byId = new Map(tasks.map(t => [t.id, t]));
  const running = [...board.running].sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt));
  const slots: BoardAgent[] = running.map((r, i) => {
    const t = byId.get(r.taskId);
    return {
      name: t?.assignee?.kind === 'agent' ? t.assignee.name : SLOT_NAMES[i] ?? `Agent ${i + 1}`,
      taskId: r.taskId, state: t?.needs ? 'waiting' : 'working',
      ...(t?.live?.summary ? { summary: t.live.summary } : {}),
    };
  });
  for (let i = slots.length; i < board.settings.maxParallel; i++) slots.push({ name: SLOT_NAMES[i] ?? `Agent ${i + 1}`, state: 'idle' });
  return slots;
}

/** The board-wide feed: the engine's, else every task's own activity merged (so an older engine still shows something true). */
export function feedOf(board: Pick<BoardState, 'feed'>, tasks: readonly Task[]): FeedEntry[] {
  if (board.feed) return board.feed;
  return tasks.flatMap(t => activityOf(t).map(a => ({ at: a.at, taskId: t.id, kind: a.kind, text: a.text })));
}

/**
 * One task's timeline, oldest first: the engine's `activity`, else what the task itself records
 * (created, discussion notes, landed).
 */
export function activityOf(task: Task): ActivityEntry[] {
  if (task.activity) return [...task.activity].sort((a, b) => toMs(a.at) - toMs(b.at));
  const out: ActivityEntry[] = [{ at: String(task.createdAt), kind: 'created', by: 'system', text: 'Task created' }];
  for (const c of task.review?.comments ?? []) out.push({ at: c.at, kind: 'comment', by: c.by, text: c.text });
  if (task.landed) out.push({ at: task.landed.at, kind: 'landed', by: task.landed.by === 'auto' ? 'system' : 'person', text: task.landed.by === 'auto' ? `Landed automatically: ${autoLandReason(task)}` : 'Landed on the trunk' });
  return out.sort((a, b) => toMs(a.at) - toMs(b.at));
}

export function filterFeed(feed: readonly FeedEntry[], taskId: string | null, limit = 200): FeedEntry[] {
  return feed.filter(e => !taskId || e.taskId === taskId).sort((a, b) => toMs(b.at) - toMs(a.at)).slice(0, limit);
}

/** "2h 10m", "3d 4h", "45m", "-" for unknown. */
export function formatSpan(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return '–';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The running card's live line: what the agent is doing, how long, what it has cost. */
export function liveLine(task: Task, startedAt: unknown, costUsd: number | undefined, now: number): string {
  const parts = [task.live?.summary || 'Working', startedAt ? elapsed(startedAt, now) : '', formatUsd(costUsd ?? task.costUsd)];
  return parts.filter(Boolean).join(' · ');
}

// ── the chat's link back ──────────────────────────────────────────────

/** Chip wording for the Delivery bar in a task's chat; the word carries the state, the colour backs it up. */
export function deliveryChip(status: TaskStatus): { label: string; tone: 'accent' | 'warning' | 'success' | 'neutral' | 'danger' } {
  switch (status) {
    case 'running': return { label: 'Running', tone: 'accent' };
    case 'review': return { label: 'In review', tone: 'warning' };
    case 'changes': return { label: 'Changes requested', tone: 'warning' };
    case 'pr': return { label: 'PR open', tone: 'accent' };
    case 'merged': return { label: 'Merged', tone: 'success' };
    case 'blocked': return { label: 'Blocked', tone: 'danger' };
    case 'cancelled': return { label: 'Cancelled', tone: 'neutral' };
    default: return { label: STATUS_WORD[status], tone: 'neutral' };
  }
}

/** The task whose run is this chat, found in a board when the session summary carries no `delivery` link. */
export function taskForSession(tasks: readonly Task[], sessionId: string): Task | undefined {
  return tasks.find(t => t.session?.id === sessionId || t.claim?.sessionId === sessionId || t.sessionId === sessionId);
}

/** The label to show next to a task number in the bar: "#3" from the board when known. */
export function refIn(tasks: readonly Task[], id: string): string {
  return makeRef(tasks)(id);
}

// ── keyboard ──────────────────────────────────────────────────────────

/** J/K: the id `delta` steps from `current` in `order`, clamped; the first when nothing is selected. */
export function stepSelection(order: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (order.length === 0) return null;
  const i = current ? order.indexOf(current) : -1;
  if (i < 0) return order[delta === 1 ? 0 : order.length - 1]!;
  return order[Math.min(order.length - 1, Math.max(0, i + delta))]!;
}

export const SHORTCUTS: ReadonlyArray<{ keys: string; does: string }> = [
  { keys: 'N', does: 'New task' },
  { keys: '/', does: 'Filter tasks' },
  { keys: 'J / K', does: 'Next / previous task' },
  { keys: 'Enter', does: 'Open the selected task' },
  { keys: 'Alt + ↑ / ↓', does: 'Move the selected task up or down in its column' },
  { keys: 'X', does: 'Tick the selected task for a bulk action' },
  { keys: 'V', does: 'Switch between Board and List' },
  { keys: 'A', does: 'Show or hide the activity panel' },
  { keys: 'Esc', does: 'Close the drawer, clear the selection' },
  { keys: '?', does: 'This list' },
];

// ── metrics ───────────────────────────────────────────────────────────

/** Spent today against the daily budget as a 0..1 share, null without a budget. */
export function budgetShare(spent: number | undefined, budget: number | undefined): number | null {
  if (!budget || budget <= 0) return null;
  return Math.min(1, Math.max(0, (spent ?? 0) / budget));
}
