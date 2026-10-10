/**
 * Delivery board logic that has no DOM: which column a task lives in, what a
 * person may drag it to, in what order review waits, and how time and money
 * read on a card.
 *
 * WHY separate and pure: the board's rules ("a person moves cards only among
 * Backlog / Ready / Blocked / Cancelled; agents own Running; landing is
 * Approve, not a drag") are the part that must not drift between the web
 * portal and the desktop, and the part a unit test can pin without a browser
 * (web/test-delivery.mjs). The engine stays the authority — it refuses an
 * illegal transition regardless — this module only keeps the UI from offering
 * one and says WHY it is not offered (the tooltip text).
 *
 * It also holds the rules added with releases, batch review and "needs you":
 * which review rows may be ticked for a batch (low risk, nobody waiting on a
 * person), which chat a task's "Session" link opens (`sessionOf`: the real chat,
 * never the runner's run id), what a waiting run is asking and which existing
 * route answers it, how merged tasks group into release notes, and the diff of
 * two attention snapshots that decides which desktop notifications fire.
 *
 * What it does not do: fetch, render, or decide risk. Risk and "touches" come
 * from the engine; here they are only ordered and phrased.
 *
 * @module web/delivery-model
 */

import type {
  AttentionSnapshot, BatchResult, BoardState, ChangeKind, Priority, Release, ReleasePlan, RiskLevel, Task, TaskNeed, TaskStatus,
} from './delivery-types';

export interface ColumnDef { id: TaskStatus; label: string; hint: string }

/** The columns every board shows. Blocked and Cancelled are filters, not columns. */
export const COLUMNS: readonly ColumnDef[] = [
  { id: 'backlog', label: 'Backlog', hint: 'Not ready for an agent yet' },
  { id: 'ready', label: 'Ready', hint: 'Queued: agents take these in priority order' },
  { id: 'running', label: 'Running', hint: 'An agent is working on these now' },
  { id: 'review', label: 'Review', hint: 'Finished work waiting for you' },
  { id: 'changes', label: 'Changes', hint: 'You asked for changes; the agent is on it' },
  { id: 'pr', label: 'PR open', hint: 'A pull request is open on the remote; its checks and reviews decide when it lands' },
  { id: 'merged', label: 'Merged', hint: 'Landed on the trunk' },
];

export const PARKED: readonly ColumnDef[] = [
  { id: 'blocked', label: 'Blocked', hint: 'Stuck on something outside the board' },
  { id: 'cancelled', label: 'Cancelled', hint: 'Dropped; restore it to Backlog to revive' },
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog', ready: 'Ready', running: 'Running', review: 'In review', changes: 'Changes requested', pr: 'PR open',
  merged: 'Merged', blocked: 'Blocked', cancelled: 'Cancelled',
};

export const PRIORITY_LABEL: Record<Priority, string> = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };

/** The statuses a person may set by hand. Everything else is the agents' or the landing step's. */
export const PERSON_STATUSES: readonly TaskStatus[] = ['backlog', 'ready', 'blocked', 'cancelled'];

/** Epoch ms from whatever the engine sent (number, numeric string or ISO); 0 when unreadable. */
export function toMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  return 0;
}

/** "#3" for ids that end in a number (T-3, task_3, 3); otherwise the first six characters. */
export function shortId(id: string): string {
  const m = /^[A-Za-z]{0,6}[-_#]?(\d{1,6})$/.exec(id);
  return m ? `#${Number(m[1])}` : `#${id.slice(0, 6)}`;
}

/** Turns a task id into the label a person reads. */
export type RefFn = (id: string) => string;

/**
 * Friendly numbers for tasks: "#1, #2 …" in creation order. The engine's ids
 * are 8 hex characters, which nobody should have to say aloud ("waits for
 * #9f3c2a1b"). Tasks are never deleted (cancelled ones stay), so a task keeps
 * its number for the life of the board.
 */
export function makeRef(tasks: readonly Pick<Task, 'id' | 'createdAt'>[]): RefFn {
  const order = [...tasks].sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt) || a.id.localeCompare(b.id));
  const n = new Map(order.map((t, i) => [t.id, i + 1]));
  return id => (n.has(id) ? `#${n.get(id)}` : shortId(id));
}

const RISK_RANK: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 };

/**
 * Where a task sits in the review queue. An unassessed task ranks as medium:
 * not knowing the risk is a reason to look, not a reason to wave it through.
 */
export function riskRank(task: Pick<Task, 'risk'>): number {
  return task.risk ? RISK_RANK[task.risk.level] ?? 1 : 1;
}

/** Review tasks, riskiest first; within a level the higher score, then the one that has waited longest. */
export function sortForReview(tasks: readonly Task[]): Task[] {
  return tasks
    .filter(t => t.status === 'review')
    .sort((a, b) =>
      riskRank(a) - riskRank(b)
      || (b.risk?.score ?? 0) - (a.risk?.score ?? 0)
      || toMs(a.updatedAt) - toMs(b.updatedAt)
      || a.id.localeCompare(b.id));
}

/**
 * A person's own order (drag within a column) when both tasks carry a rank; 0 otherwise, so a board from an
 * engine without ranks sorts exactly as before.
 */
export function cmpRank(a: Pick<Task, 'rank'>, b: Pick<Task, 'rank'>): number {
  return a.rank !== undefined && b.rank !== undefined ? a.rank - b.rank : 0;
}

function byPriority(a: Task, b: Task): number {
  return cmpRank(a, b) || a.priority - b.priority || toMs(a.createdAt) - toMs(b.createdAt) || a.id.localeCompare(b.id);
}

export interface GroupOptions {
  /** Case-insensitive match against title, labels and the task's number. */
  query?: string;
  label?: string;
  ref?: RefFn;
  /** Only tasks waiting on a person (the "N need you" chip). */
  onlyNeeds?: boolean;
}

function matches(t: Task, o: GroupOptions): boolean {
  if (o.onlyNeeds && !t.needs) return false;
  if (o.label && !t.labels.includes(o.label)) return false;
  const q = o.query?.trim().toLowerCase();
  if (!q) return true;
  return t.title.toLowerCase().includes(q) || (o.ref ?? shortId)(t.id).toLowerCase().includes(q) || t.labels.some(l => l.toLowerCase().includes(q));
}

/**
 * Tasks by status, each list in the order a person expects: Ready follows the
 * dispatcher's queue (what an agent takes next is first), Review is risk order,
 * Merged and Changes show the most recently touched first, the rest by priority.
 */
export function groupTasks(tasks: readonly Task[], queue: readonly string[] = [], opts: GroupOptions = {}): Record<TaskStatus, Task[]> {
  const out: Record<TaskStatus, Task[]> = { backlog: [], ready: [], running: [], review: [], changes: [], pr: [], merged: [], blocked: [], cancelled: [] };
  for (const t of tasks) if (matches(t, opts) && out[t.status]) out[t.status].push(t);
  const pos = new Map(queue.map((id, i) => [id, i]));
  out.ready.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9) || byPriority(a, b));
  out.backlog.sort(byPriority);
  out.running.sort(byPriority);
  out.blocked.sort(byPriority);
  out.cancelled.sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
  out.review = sortForReview(out.review);
  for (const k of ['merged', 'changes', 'pr'] as const) out[k].sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
  // A task waiting on a person floats to the top of whatever column it is in (stable: the rest keep their order).
  for (const k of Object.keys(out) as TaskStatus[]) out[k] = needsFirst(out[k]);
  return out;
}

export type MoveCheck = { ok: true } | { ok: false; reason: string };

const OWNED_BY_AGENT: Partial<Record<TaskStatus, string>> = {
  running: 'An agent is working on this. It moves to Review when the agent finishes.',
  review: 'Open it to review: Approve and land, or Request changes.',
  changes: 'Waiting for the agent to pick up your requested changes.',
  pr: 'A pull request is open. The remote’s checks and reviews decide when it lands: open the task to see them.',
  merged: 'Already landed on the trunk. Create a new task for further changes.',
};

/** May a person drag this task into `to`? When not, `reason` is the tooltip. */
export function checkMove(task: Pick<Task, 'status'>, to: TaskStatus): MoveCheck {
  const from = task.status;
  if (from === to) return { ok: false, reason: 'Already here.' };
  if (!PERSON_STATUSES.includes(from)) return { ok: false, reason: OWNED_BY_AGENT[from] ?? 'This task cannot be moved by hand.' };
  if (!PERSON_STATUSES.includes(to)) {
    return { ok: false, reason: to === 'merged' || to === 'review' || to === 'pr'
      ? 'Work lands through Review: open a task in Review and choose Approve and land (or Open pull request).'
      : 'Agents move cards into this column. You can set Backlog, Ready, Blocked or Cancelled.' };
  }
  if (from === 'cancelled' && to !== 'backlog') return { ok: false, reason: 'Restore a cancelled task to Backlog first.' };
  return { ok: true };
}

export function allowedTargets(task: Pick<Task, 'status'>): TaskStatus[] {
  return PERSON_STATUSES.filter(s => checkMove(task, s).ok);
}

/** Dependencies not yet merged (a missing task counts as unmet: the dependency is unknown, not done). */
export function unmetDeps(task: Pick<Task, 'dependsOn'>, byId: ReadonlyMap<string, Task>): string[] {
  return task.dependsOn.filter(id => byId.get(id)?.status !== 'merged');
}

/** "waits for #3", "waits for #3, #5" or "waits for #3 +2"; null when nothing is outstanding. */
export function waitsForLabel(unmet: readonly string[], ref: RefFn = shortId): string | null {
  if (!unmet.length) return null;
  const shown = unmet.slice(0, 2).map(ref).join(', ');
  return `waits for ${shown}${unmet.length > 2 ? ` +${unmet.length - 2}` : ''}`;
}

/** "42s", "3m 04s", "1h 12m". Never negative. */
export function elapsed(startedAt: unknown, now: number): string {
  const s = Math.max(0, Math.floor((now - toMs(startedAt)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Money on a card: two decimals, "<$0.01" for a trace, "$0.00" for none. */
export function formatUsd(n: number | undefined): string {
  if (!n || n <= 0) return '$0.00';
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(at: unknown, now: number): string {
  const ms = toMs(at);
  if (!ms) return '';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** The one line a Review card shows about checks: the evidence summary, first line, clipped. */
export function checksSummary(task: Pick<Task, 'evidence'>, max = 96): string | null {
  const line = task.evidence?.summary?.split('\n').map(s => s.trim()).find(Boolean);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface BoardCounts { byStatus: Record<TaskStatus, number>; total: number; open: number }

export function countTasks(tasks: readonly Task[]): BoardCounts {
  const byStatus: Record<TaskStatus, number> = { backlog: 0, ready: 0, running: 0, review: 0, changes: 0, pr: 0, merged: 0, blocked: 0, cancelled: 0 };
  for (const t of tasks) if (t.status in byStatus) byStatus[t.status]++;
  return { byStatus, total: tasks.length, open: tasks.length - byStatus.merged - byStatus.cancelled };
}

export function labelsOf(tasks: readonly Task[]): string[] {
  return [...new Set(tasks.flatMap(t => t.labels))].sort((a, b) => a.localeCompare(b));
}

/** Whether two boards are identical — the poller skips a re-render when nothing moved. */
export function sameBoard(a: BoardState | null, b: BoardState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function normaliseTask(t: Task): Task {
  return {
    ...t,
    body: t.body ?? '',
    acceptance: Array.isArray(t.acceptance) ? t.acceptance : [],
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
    labels: Array.isArray(t.labels) ? t.labels : [],
    priority: ([1, 2, 3, 4] as number[]).includes(t.priority) ? t.priority : 3,
    // A board from an engine that predates the true-board fields still draws: absent means "none yet", never undefined arithmetic.
    changeCount: typeof t.changeCount === 'number' ? t.changeCount : t.touches && !t.touches.predicted ? t.touches.files.length : 0,
    activity: Array.isArray(t.activity) ? t.activity : [],
    ...(typeof t.rank === 'number' ? {} : { rank: Number.MAX_SAFE_INTEGER }),
  };
}

/** Normalise a possibly sparse payload so components can index without guarding every field. */
export function normaliseBoard(raw: unknown): BoardState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<BoardState>;
  if (!Array.isArray(r.tasks)) return null;
  // Fields this client reads but does not validate (autonomy, agents, feed, metrics, idleReason ...) pass through untouched.
  const { tasks: _t, queue: _q, running: _r, settings: _s, dispatcher: _d, releases: _rl, project: _p, ...extra } = r as unknown as Record<string, unknown>;
  return {
    ...extra,
    project: String(r.project ?? ''),
    tasks: r.tasks.map(normaliseTask),
    queue: Array.isArray(r.queue) ? r.queue.map(String) : [],
    running: Array.isArray(r.running) ? r.running : [],
    settings: {
      maxParallel: 2, autoLandLowRisk: false, trunk: 'main', autonomy: 'manual', wip: {}, budgetUsdPerDay: 10, pauseAfterFailures: 3, views: [],
      ...(r.settings ?? {}),
    },
    autonomy: r.autonomy ?? r.settings?.autonomy ?? 'manual',
    metrics: r.metrics ?? { medianCycleMs: null, medianLeadMs: null, throughput7d: 0, spentTodayUsd: 0, wipNow: 0, byStatusAgeing: {} },
    agents: Array.isArray(r.agents) ? r.agents : [],
    feed: Array.isArray(r.feed) ? r.feed : [],
    dispatcher: r.dispatcher === 'running' || r.dispatcher === 'paused' ? r.dispatcher : 'idle',
    releases: Array.isArray(r.releases) ? r.releases : [],
    ...(r.connection ? { connection: r.connection } : {}),
    // Scrum (ADR 0039 section 4): present once the board has used it; absent means Kanban with no sprints.
    ...(Array.isArray(r.sprints) ? { sprints: r.sprints } : {}),
    ...(Array.isArray(r.proposals) ? { proposals: r.proposals } : {}),
  };
}

// ── the chat behind a task ────────────────────────────────────────────

/**
 * The chat a task's "Session" link opens: the live run's chat while it runs, else
 * the chat of its latest run. NEVER `claim.runId` — that names the run in the
 * engine's runner and is a chat only for the app's runner; the fallback background
 * runner has no chat at all, and then there is no link to show (undefined).
 */
export function sessionOf(task: Pick<Task, 'claim' | 'sessionId'> & { session?: { id: string } }): string | undefined {
  const id = task.session?.id || task.claim?.sessionId || task.sessionId;
  return id && id.trim() ? id : undefined;
}

// ── a run that waits for a person ─────────────────────────────────────

/** What the card calls each kind of wait: the word is the signal, colour only backs it up. */
export const NEED_WORD: Record<TaskNeed['kind'], string> = {
  question: 'Question',
  permission: 'Permission',
  approval: 'Approval',
};

/** The sentence that tells a person what is expected of them. */
export const NEED_ASK: Record<TaskNeed['kind'], string> = {
  question: 'The agent asked you a question',
  permission: 'The agent is waiting for you to allow a tool call',
  approval: 'A tool call was parked until you approve it',
};

/**
 * What to say when the engine answers `ok: false` (a 200, not an error): the wait ended while
 * the person was typing — the agent was cancelled, answered elsewhere, or timed out. The board
 * catches up on its next frame; the draft stays so nothing typed is lost.
 */
export const NEED_STALE: Record<TaskNeed['kind'], string> = {
  question: 'The agent is no longer waiting for an answer; it may have moved on or been stopped. The board updates shortly.',
  permission: 'That request is no longer pending; it was decided elsewhere or the run stopped. The board updates shortly.',
  approval: 'That parked call is no longer pending; it was decided elsewhere. The board updates shortly.',
};

/** One stable string per wait: the same wait keeps its key until the engine moves on to another. */
export function needKey(need: TaskNeed): string {
  return `${need.kind}:${need.ref ?? ''}:${need.since}`;
}

/**
 * Which existing route answers this wait — Delivery adds no second way to say yes:
 * a question goes to the chat's `answer`, a permission to its `permission`, a parked
 * call to `inbox/decide`. A wait that cannot be answered from here (no chat, no ref)
 * says so, instead of offering a button that would fail.
 */
export type NeedControls =
  | { ok: true; kind: 'question'; sessionId: string }
  | { ok: true; kind: 'permission'; sessionId: string; ref: string }
  | { ok: true; kind: 'approval'; ref: string }
  | { ok: false; reason: string };

export function needControls(task: Pick<Task, 'needs' | 'claim' | 'sessionId'>): NeedControls | null {
  const need = task.needs;
  if (!need) return null;
  const sessionId = sessionOf(task);
  if (need.kind === 'question') {
    return sessionId ? { ok: true, kind: 'question', sessionId } : { ok: false, reason: 'This run has no chat to answer in. Open the task to see what it asked.' };
  }
  if (need.kind === 'permission') {
    if (!sessionId) return { ok: false, reason: 'This run has no chat to answer in.' };
    return need.ref ? { ok: true, kind: 'permission', sessionId, ref: need.ref } : { ok: false, reason: 'The request is no longer pending. The board will update in a moment.' };
  }
  return need.ref ? { ok: true, kind: 'approval', ref: need.ref } : { ok: false, reason: 'The parked call is no longer pending. The board will update in a moment.' };
}

/** A prompt clipped for a card: collapsed whitespace, an ellipsis, never mid-character. */
export function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Stable partition: tasks waiting on a person first, everything else in the order it already had. */
export function needsFirst<T extends Pick<Task, 'needs'>>(list: readonly T[]): T[] {
  return [...list.filter(t => t.needs), ...list.filter(t => !t.needs)];
}

/** Open tasks waiting on a person, the one that has waited longest first. */
export function needingYou(tasks: readonly Task[]): Task[] {
  return tasks
    .filter(t => t.needs && t.status !== 'merged' && t.status !== 'cancelled')
    .sort((a, b) => toMs(a.needs?.since) - toMs(b.needs?.since) || a.id.localeCompare(b.id));
}

/** "1 needs you" / "3 need you". */
export function needsChipLabel(n: number): string {
  return `${n} ${n === 1 ? 'needs' : 'need'} you`;
}

/**
 * Show a wait as answered the moment a person answers it, without waiting for the engine's
 * next frame (3 s at most): tasks whose current wait is in `answered` lose `needs`. A new wait
 * (a different key) is never hidden by an old answer. Returns the same array when nothing changed.
 */
export function withoutAnswered(tasks: readonly Task[], answered: Readonly<Record<string, string>>): readonly Task[] {
  let changed = false;
  const out = tasks.map(t => {
    if (!t.needs || answered[t.id] !== needKey(t.needs)) return t;
    changed = true;
    const { needs: _needs, ...rest } = t;
    return rest as Task;
  });
  return changed ? out : tasks;
}

// ── batch review ──────────────────────────────────────────────────────

export type BatchCheck = { ok: true } | { ok: false; reason: string; hint: string };

/**
 * May this review task be ticked for a batch? Only a low-risk task nobody is waiting on:
 * a medium, high or unassessed task is a reason to look, and a task with a question open
 * has something to answer first. The engine re-checks every id and refuses the set as a
 * whole if one is not eligible; this keeps the UI from offering what it would refuse.
 */
export function batchCheck(task: Pick<Task, 'status' | 'risk' | 'needs'>): BatchCheck {
  if (task.status !== 'review') return { ok: false, reason: 'Only tasks in review can be approved.', hint: 'Not in review' };
  if (task.needs) return { ok: false, reason: 'This task is waiting on you. Answer it first.', hint: 'Waiting on you' };
  if (!task.risk) return { ok: false, reason: 'Not assessed yet, so it is not low risk. Open it to approve on its own.', hint: 'Open it to approve on its own' };
  if (task.risk.level !== 'low') return { ok: false, reason: `${task.risk.level === 'high' ? 'High' : 'Medium'} risk. Open it to approve on its own.`, hint: 'Open it to approve on its own' };
  return { ok: true };
}

/** Review tasks that may be ticked, in the order given. */
export function batchEligibleIds(list: readonly Task[]): string[] {
  return list.filter(t => batchCheck(t).ok).map(t => t.id);
}

/** Keep only selected ids that are still in the list and still eligible (a task can leave review or turn risky under you). */
export function pruneSelection(selected: readonly string[], list: readonly Task[]): string[] {
  return orderSelection(selected, list);
}

/** The selection in the queue's display order — the order the engine lands them in. */
export function orderSelection(selected: readonly string[], list: readonly Task[]): string[] {
  const want = new Set(selected);
  return list.filter(t => want.has(t.id) && batchCheck(t).ok).map(t => t.id);
}

export function toggleSelection(selected: readonly string[], id: string, list: readonly Task[]): string[] {
  const t = list.find(x => x.id === id);
  if (!t || !batchCheck(t).ok) return orderSelection(selected, list);
  return orderSelection(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id], list);
}

/** "Select all low risk": every eligible row. It never reaches a medium, high or unassessed one. */
export function selectAllLow(list: readonly Task[]): string[] {
  return batchEligibleIds(list);
}

export function batchButtonLabel(n: number, busy = false): string {
  return busy ? `Landing ${n}…` : `Approve and land ${n}`;
}

export interface BatchSummary {
  /** `ok`: all landed; `partial`: some skipped; `none`: nothing landed. */
  tone: 'ok' | 'partial' | 'none';
  headline: string;
  landed: number;
  skipped: Array<{ id: string; label: string; title: string | undefined; reason: string }>;
}

/** The words after a batch: how many landed and, for every skipped id, why. */
export function summariseBatch(result: BatchResult, label: RefFn = shortId, titleOf: (id: string) => string | undefined = () => undefined): BatchSummary {
  const landed = result.landed?.length ?? 0;
  const skipped = (result.skipped ?? []).map(s => ({ id: s.id, label: label(s.id), title: titleOf(s.id), reason: s.reason }));
  const plural = (n: number): string => `${n} ${n === 1 ? 'task' : 'tasks'}`;
  if (landed > 0 && skipped.length === 0) return { tone: 'ok', headline: `Landed ${plural(landed)} on the trunk.`, landed, skipped };
  if (landed > 0) return { tone: 'partial', headline: `Landed ${plural(landed)}. ${skipped.length} ${skipped.length === 1 ? 'was' : 'were'} skipped.`, landed, skipped };
  return { tone: 'none', headline: skipped.length ? `Nothing landed. ${skipped.length} ${skipped.length === 1 ? 'was' : 'were'} skipped.` : 'Nothing landed.', landed, skipped };
}

// ── releases ──────────────────────────────────────────────────────────

export type ReleaseSection = 'Breaking changes' | 'Added' | 'Fixed' | 'Changed' | 'Other';

const SECTION_OF_KIND: Record<ChangeKind, Exclude<ReleaseSection, 'Breaking changes'>> = {
  feat: 'Added', fix: 'Fixed', perf: 'Changed', refactor: 'Changed', docs: 'Other', test: 'Other', chore: 'Other', other: 'Other',
};

export const KIND_WORD: Record<ChangeKind, string> = {
  feat: 'feature', fix: 'fix', perf: 'performance', refactor: 'refactor', docs: 'docs', test: 'tests', chore: 'chore', other: 'change',
};

type NoteTask = ReleasePlan['tasks'][number];

/** The section a task's notes go under; a breaking change goes first whatever its kind. */
export function sectionOf(t: Pick<NoteTask, 'kind' | 'breaking'>): ReleaseSection {
  return t.breaking ? 'Breaking changes' : SECTION_OF_KIND[t.kind] ?? 'Other';
}

const SECTION_ORDER: readonly ReleaseSection[] = ['Breaking changes', 'Added', 'Fixed', 'Changed', 'Other'];

/** Merged tasks grouped the way the release notes read; empty sections are left out, order inside a section is kept. */
export function groupReleaseTasks<T extends Pick<NoteTask, 'kind' | 'breaking'>>(tasks: readonly T[]): Array<{ section: ReleaseSection; tasks: T[] }> {
  return SECTION_ORDER
    .map(section => ({ section, tasks: tasks.filter(t => sectionOf(t) === section) }))
    .filter(g => g.tasks.length > 0);
}

export const BUMP_WORD: Record<Release['bump'], string> = { major: 'Major', minor: 'Minor', patch: 'Patch', none: 'No bump' };

/** "1.3.0" -> [1,3,0]; null for anything the engine would refuse (it accepts only major.minor.patch). */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) return 0;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** What a person typed, as the engine wants it: trimmed, and without a leading "v". */
export function normaliseVersionInput(v: string): string {
  return v.trim().replace(/^v(?=\d)/i, '');
}

/**
 * Why a typed version cannot be used, in words — or null. `base` is the version the bump
 * starts from (plan.baseVersion): a release must be higher than it. The engine checks the
 * same and also that the tag is new; this is only the part that needs no round trip.
 */
export function validateVersion(input: string, base?: string): string | null {
  const v = normaliseVersionInput(input);
  if (!v) return 'Enter a version, for example 1.4.0.';
  if (!parseVersion(v)) return 'Use three numbers separated by dots, for example 1.4.0.';
  if (base && parseVersion(base) && compareVersions(v, base) <= 0) return `Must be higher than ${base}.`;
  return null;
}

export type ActionState = { enabled: true } | { enabled: false; reason: string };

/** Whether "Create release" is available, and when not, the plain reason. */
export function releaseCreateState(plan: ReleasePlan | null, versionError?: string | null): ActionState {
  if (!plan) return { enabled: false, reason: 'Loading what a release would contain.' };
  if (versionError) return { enabled: false, reason: versionError };
  if (plan.blockers.length > 0) return { enabled: false, reason: plan.blockers.join(' ') };
  if (!plan.next) return { enabled: false, reason: 'There is no version to propose yet.' };
  return { enabled: true };
}

/** The Deploy button for one release: its label, and when disabled the reason (the engine's own, from plan.deploy.why). */
export function deployAction(plan: Pick<ReleasePlan, 'deploy'> | null, release: Pick<Release, 'deploy'>): { label: string } & ActionState {
  const state = release.deploy?.state;
  const label = state === 'failed' ? 'Retry deploy' : state === 'ok' ? 'Deploy again' : 'Deploy';
  if (state === 'running') return { label: 'Deploying…', enabled: false, reason: 'A deploy of this release is running.' };
  if (!plan) return { label, enabled: false, reason: 'Checking whether a deploy command is set.' };
  if (!plan.deploy.available) return { label, enabled: false, reason: plan.deploy.why || 'No deploy command is set for this project.' };
  return { label, enabled: true };
}

export const DEPLOY_SOURCE_WORD: Record<'app' | 'setting' | 'none', string> = {
  app: 'the app’s own deploy script', setting: 'your Delivery setting', none: 'not set',
};

// ── notifications ─────────────────────────────────────────────────────

export type AttentionKind = 'needs' | 'failed' | 'review' | 'merged';

export interface AttentionEvent {
  kind: AttentionKind;
  project: string;
  /** The project's display name. */
  name: string;
  taskId: string;
  title: string;
  needKind?: TaskNeed['kind'];
}

const ATTENTION_ORDER: Record<AttentionKind, number> = { needs: 0, failed: 1, review: 2, merged: 3 };

/**
 * What changed between two attention snapshots, for notifications. `prev` null is the
 * baseline (the first poll): nothing is announced for what was already true. A project
 * that was not in `prev` is a board that appeared, not news. One event per task, the
 * most pressing: waiting on you, then failed (running -> blocked), then newly in review,
 * then newly merged. Most pressing first, so a cap of three keeps the right three.
 */
export function attentionEvents(prev: AttentionSnapshot | null | undefined, next: AttentionSnapshot): AttentionEvent[] {
  if (!prev) return [];
  const before = new Map(prev.boards.map(b => [b.project, new Map(b.tasks.map(t => [t.id, t]))]));
  const out: AttentionEvent[] = [];
  for (const board of next.boards) {
    const old = before.get(board.project);
    if (!old) continue;
    for (const t of board.tasks) {
      const was = old.get(t.id);
      const base = { project: board.project, name: board.name, taskId: t.id, title: t.title };
      if (t.needs && (!was?.needs || was.kind !== t.kind)) {
        out.push({ ...base, kind: 'needs', ...(t.kind ? { needKind: t.kind } : {}) });
      } else if (was && was.status === 'running' && t.status === 'blocked') {
        out.push({ ...base, kind: 'failed' });
      } else if (was && was.status !== 'review' && t.status === 'review') {
        out.push({ ...base, kind: 'review' });
      } else if (was && was.status !== 'merged' && t.status === 'merged') {
        out.push({ ...base, kind: 'merged' });
      }
    }
  }
  return out.sort((a, b) => ATTENTION_ORDER[a.kind] - ATTENTION_ORDER[b.kind]);
}

/** The notification for one event, and which preference switch governs it (needs -> attention; the rest -> background). */
export function describeAttention(e: AttentionEvent, multiProject = false): { title: string; body: string; pref: 'attention' | 'background' } {
  const where = multiProject && e.name ? ` (${e.name})` : '';
  const what = `${clipText(e.title, 90)}${where}`;
  switch (e.kind) {
    case 'needs':
      return {
        pref: 'attention', body: what,
        title: e.needKind === 'permission' ? 'An agent needs your permission' : e.needKind === 'approval' ? 'A call is waiting for your approval' : 'An agent has a question',
      };
    case 'failed': return { pref: 'background', title: 'An agent could not finish a task', body: `${what} is blocked.` };
    case 'review': return { pref: 'background', title: 'Ready for review', body: what };
    case 'merged': return { pref: 'background', title: 'Landed on the trunk', body: what };
  }
}

// ── keyboard ──────────────────────────────────────────────────────────

/**
 * Where a tab strip's focus goes for a key: Left/Right wrap around, Home/End jump to the
 * ends; any other key (or an empty strip) returns null so the caller leaves it alone.
 */
export function nextTabIndex(count: number, index: number, key: string): number | null {
  if (count <= 0) return null;
  const at = index < 0 ? 0 : index;
  switch (key) {
    case 'ArrowRight': return (at + 1) % count;
    case 'ArrowLeft': return (at - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

// ── release wording ───────────────────────────────────────────────────

/** Why the board proposes this version, in a sentence a person can check against the list below it. */
export function whyLine(plan: Pick<ReleasePlan, 'next' | 'baseVersion'>): string | null {
  const n = plan.next;
  if (!n) return null;
  const reason = n.reason.replace(/[.\s]+$/, '');
  if (n.bump === 'none') return `Why this version: ${reason}.`;
  return `Why a ${n.bump} bump${plan.baseVersion ? ` from ${plan.baseVersion}` : ''}: ${reason}.`;
}

/** "3 merged tasks and 1 other commit since v1.2.0" — what the next release is made of. */
export function releaseSummaryLine(plan: Pick<ReleasePlan, 'tasks' | 'other' | 'lastTag' | 'trunk'>): string {
  const t = plan.tasks.length; const o = plan.other.length;
  const since = plan.lastTag ? `since ${plan.lastTag}` : `on ${plan.trunk}`;
  if (t === 0 && o === 0) return `Nothing new ${since}`;
  const parts = [
    t > 0 ? `${t} merged ${t === 1 ? 'task' : 'tasks'}` : '',
    o > 0 ? `${o} other ${o === 1 ? 'commit' : 'commits'}` : '',
  ].filter(Boolean);
  return `${parts.join(' and ')} ${since}`;
}

/** The empty state when there is nothing to release: what it is, and the next step. */
export function releaseEmpty(plan: Pick<ReleasePlan, 'tasks' | 'other' | 'lastTag'>, releaseCount: number): { title: string; body: string } | null {
  if (plan.tasks.length > 0 || plan.other.length > 0) return null;
  if (plan.lastTag) return { title: `Nothing new since ${plan.lastTag}`, body: 'Land some tasks, then release them here.' };
  return { title: releaseCount > 0 ? 'Nothing new to release' : 'No releases yet', body: 'Land some tasks, then release them here.' };
}

/** The files a release will touch: the project's version files, plus the changelog when asked for. */
export function releaseFiles(plan: Pick<ReleasePlan, 'versionFiles'>, changelog: boolean): string[] {
  return [...plan.versionFiles, ...(changelog && !plan.versionFiles.includes('CHANGELOG.md') ? ['CHANGELOG.md'] : [])];
}

/** What making the release does to the repository, in one plain sentence (nothing is ever pushed). */
export function releaseEffect(trunk: string, files: readonly string[]): string {
  return files.length > 0
    ? `Makes a commit and a local tag on ${trunk}. Nothing is pushed.`
    : `Makes a local tag on the latest commit of ${trunk}. No files change and nothing is pushed.`;
}
