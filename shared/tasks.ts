/**
 * The Tasks panel's model: one shape for every piece of work running beside a
 * chat, and the pure rules that turn a list of them into what a person reads.
 *
 * Why it exists. "What is running right now, and what does it need from me?"
 * had five partial answers: the status bar's count, the Activity page's rows,
 * the AgentsCard beside a chat, the Inbox page and the long-job card. Each
 * showed a different slice with different words, and none could show that a
 * sub-agent had been started *by* another sub-agent, or say what it was doing
 * beyond a tool name. The engine now projects everything into {@link TaskItem}
 * (src/work/tasks.ts) and every client renders it through these functions, so
 * the desktop panel and the web drawer cannot disagree about what "running"
 * or "$0.004" means.
 *
 * Pure on purpose — no React, no store, no engine import — so the engine can
 * use {@link humaniseStep} when a tool starts, and the grouping, tree and
 * filter rules can be unit-tested without a window (desktop/scripts/test-tasks.mjs).
 *
 * Deliberately not here: fetching, acting, or deciding what a person may
 * approve. Actions are *offered* from flags the engine sets; whether a yes is
 * accepted is still the decision gate's call on the server (ADR 0005 / the
 * gate in src/server/decision-gate.ts), never this module's.
 *
 * @module shared/tasks
 */

// ── the shape ────────────────────────────────────────────────────────────

/** What kind of work a row is. Decides its icon, its actions and its chip. */
export type TaskKind =
  /** A Task sub-agent — delegated by a chat or by another sub-agent. */
  | 'subagent'
  /** One investigator of an Investigate fan-out (read-only, parallel). */
  | 'investigate'
  /** A background agent (fire-and-forget, also what a cron firing runs). */
  | 'background'
  /** A long job: a proposal waiting for a person, or the approved job running across turns. */
  | 'longjob'
  /** One firing of a scheduled (cron) job. */
  | 'scheduled'
  /** A backgrounded shell command (Bash background:true). */
  | 'shell'
  /** A terminal tab in the desktop app (the person's, or the agent's own). */
  | 'terminal'
  /** A taught browser procedure being replayed (desktop). */
  | 'procedure'
  /** A watcher waiting for a file, a URL, a process or another task. */
  | 'watcher'
  /** A Mini App server or install. */
  | 'app'
  /** Any other ledger run. */
  | 'run'
  /** A call an unattended run parked in the approve-later inbox. */
  | 'inbox'
  /** A running chat blocked on a tool permission. */
  | 'permission'
  /** A running chat blocked on a question to the person. */
  | 'question';

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'stopped';

/** What a row can offer. Each is an existing engine route; the panel adds none. */
export type TaskActionId =
  | 'approve' | 'deny' | 'review'
  | 'stop' | 'pause' | 'resume' | 'retry'
  | 'transcript' | 'open-chat' | 'show' | 'copy-command';

export interface TaskTodo {
  done: number;
  total: number;
  /** The item in progress, when the list names one. */
  current?: string;
}

export interface TaskItem {
  /** Unique across kinds (a ledger id, `inbox:<id>`, `ask:<session>`, `term:<id>` …). */
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  /** Belongs in "Waiting for you": nothing moves until a person answers. */
  needsYou?: boolean;
  /** The chat this belongs to, when there is one. */
  sessionId?: string;
  /** The task that started this one — the delegation tree. */
  parentId?: string;
  agentName?: string;
  model?: string;
  /** Who asked for it: user, model, cron, remote, watcher. */
  origin?: string;
  startedAt: number;
  endedAt?: number;
  heartbeatAt?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  toolUses?: number;
  /** The last thing it did, in words ("Editing src/app.ts"). */
  step?: string;
  todo?: TaskTodo;
  /** The tail of its output (shell, terminal), already redacted by the engine. */
  output?: string;
  /** How it ended, when it ended well (a result excerpt). */
  outcome?: string;
  /** Why it failed or was stopped. */
  error?: string;
  /** What it is asking, or the brief it was given. */
  detail?: string;
  /** For shell rows: the command line (redacted). */
  command?: string;
  pid?: number;
  /** The session whose log is this task's transcript (`sub-<agentId>`). */
  transcriptId?: string;
  /** Ids the actions need, by the route they go to. */
  ref?: {
    inboxId?: string;
    longJobId?: string;
    cronJobId?: string;
    permissionId?: string;
    terminalId?: string;
    ledgerId?: string;
  };
  /** What the engine says may be attempted. Absent means no. */
  can?: {
    stop?: boolean; pause?: boolean; resume?: boolean; retry?: boolean;
    approve?: boolean; deny?: boolean;
    /** The host can bring it on screen (a terminal tab, the browser running a procedure). */
    show?: boolean;
  };
}

/** A scheduled job, as configuration (its firings are `scheduled` tasks). */
export interface ScheduleItem {
  id: string;
  name: string;
  schedule: string;
  paused: boolean;
  nextRun?: number;
  lastRun?: number;
  lastOutcome?: string;
  runCount: number;
}

export interface TasksSnapshot {
  at: number;
  items: TaskItem[];
  schedules: ScheduleItem[];
}

// ── words ────────────────────────────────────────────────────────────────

export const KIND_LABEL: Record<TaskKind, string> = {
  subagent: 'Sub-agent',
  investigate: 'Investigator',
  background: 'Background agent',
  longjob: 'Long job',
  scheduled: 'Scheduled run',
  shell: 'Shell command',
  terminal: 'Terminal',
  procedure: 'Browser procedure',
  watcher: 'Watcher',
  app: 'App server',
  run: 'Run',
  inbox: 'Parked call',
  permission: 'Permission',
  question: 'Question',
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** The chips a person filters by: fewer, broader groups than the kinds. */
export type KindGroup = 'agents' | 'jobs' | 'commands' | 'browser' | 'watchers' | 'asks';

export const KIND_GROUP: Record<TaskKind, KindGroup> = {
  subagent: 'agents', investigate: 'agents', background: 'agents',
  longjob: 'jobs', scheduled: 'jobs', run: 'jobs',
  shell: 'commands', terminal: 'commands', app: 'commands',
  procedure: 'browser',
  watcher: 'watchers',
  inbox: 'asks', permission: 'asks', question: 'asks',
};

export const GROUP_LABEL: Record<KindGroup, string> = {
  agents: 'Agents', jobs: 'Jobs', commands: 'Commands', browser: 'Browser', watchers: 'Watchers', asks: 'Asks',
};

export const KIND_GROUPS: KindGroup[] = ['agents', 'jobs', 'commands', 'browser', 'watchers', 'asks'];

const LIVE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['queued', 'running', 'waiting', 'paused']);

export function isLive(status: TaskStatus): boolean {
  return LIVE.has(status);
}

/** Shorten a path or command to what identifies it: the last two segments, at most `max` chars. */
export function shortText(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const looksLikePath = !clean.includes(' ') && /[\\/]/.test(clean);
  const tail = looksLikePath ? clean.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : clean;
  return tail.length > max ? `${tail.slice(0, max - 1)}…` : tail;
}

/**
 * A tool call in words: what a person would say the agent is doing.
 *
 * "Running Task" for six minutes is what made people stop healthy work; the
 * argument is what distinguishes one Read from another. Unknown tools still
 * read as a sentence ("Using GitHub · list issues"), never as a raw id.
 */
export function humaniseStep(tool: string | undefined, args?: Record<string, unknown>): string {
  if (!tool) return '';
  const a = args ?? {};
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  };
  const with_ = (verb: string, what: string): string => (what ? `${verb} ${shortText(what)}` : verb);
  switch (tool) {
    case 'Read': case 'ReadAttachment': case 'WorkspaceRead': return with_('Reading', pick('file_path', 'path', 'name'));
    case 'Write': case 'WorkspaceWrite': return with_('Writing', pick('file_path', 'path'));
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return with_('Editing', pick('file_path', 'path', 'notebook_path'));
    case 'Bash': case 'PowerShell': case 'Terminal': return with_('Running', pick('command', 'cmd'));
    case 'Grep': case 'CodeSearch': return with_('Searching for', pick('pattern', 'query'));
    case 'Glob': return with_('Finding', pick('pattern'));
    case 'LS': return with_('Listing', pick('path'));
    case 'WebFetch': return with_('Fetching', pick('url'));
    case 'WebSearch': return with_('Searching the web for', pick('query'));
    case 'Task': return with_('Delegating:', pick('description'));
    case 'Investigate': return with_('Investigating:', pick('question'));
    case 'TodoWrite': return 'Updating the task list';
    case 'TodoRead': return 'Reading the task list';
    case 'RunChecks': return 'Running the project checks';
    case 'Git': return with_('Git', pick('action', 'command'));
    case 'Refactor': case 'CodeRewrite': return with_('Refactoring', pick('file_path', 'path', 'symbol'));
    case 'CodebaseMap': return 'Mapping the codebase';
    case 'ProposePlan': return 'Proposing a plan';
    case 'AskUserQuestion': return 'Asking you a question';
    case 'Skill': return with_('Using skill', pick('name', 'skill'));
    case 'Supervise': return with_('Supervising', pick('action'));
    case 'GenerateImage': return 'Generating an image';
    case 'Canvas': return with_('Writing canvas', pick('title', 'id'));
    case 'LoadTools': case 'load_tools': return 'Loading tools';
    default: {
      const m = /^mcp__([^_]+(?:-[^_]+)*)__(.+)$/.exec(tool);
      if (m) {
        const server = m[1]!;
        const name = m[2]!.replace(/_/g, ' ');
        if (server === 'aico-desktop' && name.startsWith('browser ')) {
          return `Browser: ${name.slice(8)}${pick('url', 'text', 'name') ? ` ${shortText(pick('url', 'text', 'name'), 40)}` : ''}`;
        }
        if (server === 'aico-desktop' && name.startsWith('ide ')) return `IDE: ${name.slice(4)}`;
        return `Using ${server} · ${name}`;
      }
      return `Using ${tool}`;
    }
  }
}

// ── numbers ──────────────────────────────────────────────────────────────

/** "4s", "1m 05s", "30m 26s", "2h 04m", "3d 2h". Never negative. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** 950, 12.3k, 362.4k, 1.2M. */
export function formatTokens(n: number | undefined): string {
  const v = Math.max(0, Math.round(n ?? 0));
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1).replace(/\.?0+$/, '')}k`;
  return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/**
 * Dollars with as many places as the amount needs to say something: a
 * sub-agent on a cheap model costs a tenth of a cent, and "$0.00" for it
 * would be a lie of rounding.
 */
export function formatCost(usd: number | undefined): string {
  const v = Math.max(0, usd ?? 0);
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** How long it has run (live) or ran (finished). */
export function elapsedOf(item: Pick<TaskItem, 'startedAt' | 'endedAt'>, now: number): number {
  return Math.max(0, (item.endedAt ?? now) - item.startedAt);
}

// ── the tree ─────────────────────────────────────────────────────────────

/** One row of a flattened delegation tree, with what its indentation guides need. */
export interface TaskRow {
  item: TaskItem;
  depth: number;
  /** For each ancestor level, whether that ancestor was the last of its siblings (no guide below it). */
  guides: boolean[];
  /** Whether this row is the last of its siblings. */
  last: boolean;
  /** How many descendants it has (shown when collapsed). */
  descendants: number;
}

/**
 * Flatten items into a delegation tree: children under their parent, in the
 * order given. A parent that is not in `items` (finished and cleared, in
 * another section, or filtered out) makes its child a root — a row is never
 * hidden because its parent is. Guarded against cycles, since a parent id is
 * data: an item reached twice is emitted once.
 */
export function buildTaskTree(items: TaskItem[], collapsed: ReadonlySet<string> = new Set()): TaskRow[] {
  const byId = new Map(items.map(i => [i.id, i]));
  const children = new Map<string, TaskItem[]>();
  const roots: TaskItem[] = [];
  for (const item of items) {
    const p = item.parentId;
    if (p && p !== item.id && byId.has(p)) {
      const list = children.get(p) ?? [];
      list.push(item);
      children.set(p, list);
    } else {
      roots.push(item);
    }
  }
  const out: TaskRow[] = [];
  const seen = new Set<string>();
  const count = (id: string, guard: Set<string>): number => {
    let n = 0;
    for (const c of children.get(id) ?? []) {
      if (guard.has(c.id)) continue;
      guard.add(c.id);
      n += 1 + count(c.id, guard);
    }
    return n;
  };
  const walk = (item: TaskItem, depth: number, guides: boolean[], last: boolean): void => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push({ item, depth, guides, last, descendants: count(item.id, new Set([item.id])) });
    if (collapsed.has(item.id)) {
      // Mark the hidden subtree as seen so a cycle cannot surface it as a root.
      const stack = [...(children.get(item.id) ?? [])];
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        stack.push(...(children.get(c.id) ?? []));
      }
      return;
    }
    const kids = (children.get(item.id) ?? []).filter(k => !seen.has(k.id));
    kids.forEach((k, i) => walk(k, depth + 1, [...guides, last], i === kids.length - 1));
  };
  roots.forEach((r, i) => walk(r, 0, [], i === roots.length - 1));
  // Anything left is part of a cycle with no root; show it rather than lose it.
  for (const item of items) if (!seen.has(item.id)) walk(item, 0, [], true);
  return out;
}

// ── sections, order, filters ─────────────────────────────────────────────

export interface TaskSections {
  waiting: TaskItem[];
  running: TaskItem[];
  finished: TaskItem[];
}

/**
 * Split into the panel's three sections and order each one.
 *
 * Waiting: oldest first — the one that has waited longest is answered first.
 * Running: newest first, as Claude Desktop does, so what was just started is
 * where the eye lands. Finished: most recently ended first.
 */
export function groupTasks(items: TaskItem[]): TaskSections {
  const waiting: TaskItem[] = [];
  const running: TaskItem[] = [];
  const finished: TaskItem[] = [];
  for (const item of items) {
    if (item.needsYou && isLive(item.status)) waiting.push(item);
    else if (isLive(item.status)) running.push(item);
    else finished.push(item);
  }
  waiting.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  running.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  finished.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt) || a.id.localeCompare(b.id));
  return { waiting, running, finished };
}

export interface TaskFilter {
  /** `chat`: only this chat's work (and work started by it). `all`: everything. */
  scope: 'chat' | 'all';
  sessionId?: string;
  /** Empty means every group. */
  groups?: ReadonlySet<KindGroup>;
  query?: string;
}

/** The chat an item belongs to, climbing parents for children that do not say. */
export function owningSessionOf(item: TaskItem, byId: Map<string, TaskItem>): string | undefined {
  let cur: TaskItem | undefined = item;
  for (let hop = 0; hop < 16 && cur; hop++) {
    if (cur.sessionId) return cur.sessionId;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return undefined;
}

function haystack(item: TaskItem): string {
  return [
    item.title, item.agentName, item.model, item.step, item.command, item.detail,
    KIND_LABEL[item.kind], STATUS_LABEL[item.status], item.error,
  ].filter(Boolean).join(' ').toLowerCase();
}

/** Scope, kind chips and search, ANDed. Search matches every word, anywhere. */
export function filterTasks(items: TaskItem[], filter: TaskFilter): TaskItem[] {
  const byId = new Map(items.map(i => [i.id, i]));
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => {
    if (filter.scope === 'chat') {
      if (!filter.sessionId || owningSessionOf(item, byId) !== filter.sessionId) return false;
    }
    if (filter.groups && filter.groups.size && !filter.groups.has(KIND_GROUP[item.kind])) return false;
    if (words.length) {
      const text = haystack(item);
      if (!words.every(w => text.includes(w))) return false;
    }
    return true;
  });
}

/** How many items each chip would show, under the current scope and search. */
export function countByGroup(items: TaskItem[]): Record<KindGroup, number> {
  const out = { agents: 0, jobs: 0, commands: 0, browser: 0, watchers: 0, asks: 0 } as Record<KindGroup, number>;
  for (const i of items) out[KIND_GROUP[i.kind]]++;
  return out;
}

/**
 * Hide finished rows a person cleared, per scope: anything that ended at or
 * before the "cleared at" mark. Live rows are never hidden — clearing is a
 * view decision, and work that is still going is not finished with. Kept on
 * the client because acknowledging (`work/ack`) means "the orchestrator has
 * been told", which a person tidying a list has not done.
 */
export function applyCleared(items: TaskItem[], clearedAt: number | undefined): TaskItem[] {
  if (!clearedAt) return items;
  return items.filter(i => isLive(i.status) || (i.endedAt ?? i.startedAt) > clearedAt);
}

export interface TaskTotals {
  running: number;
  waiting: number;
  finished: number;
  /** Spend on tasks started since local midnight. Long jobs are left out: their spend includes their sub-agents'. */
  spentTodayUsd: number;
}

export function summarise(items: TaskItem[], now: number): TaskTotals {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const s = groupTasks(items);
  let spent = 0;
  for (const i of items) {
    if (i.kind === 'longjob') continue;
    if (i.startedAt >= midnight.getTime() && i.costUsd) spent += i.costUsd;
  }
  return { running: s.running.length, waiting: s.waiting.length, finished: s.finished.length, spentTodayUsd: spent };
}

// ── actions ──────────────────────────────────────────────────────────────

/**
 * What a row offers, in display order. Built from the kind, the status and
 * the engine's `can` flags, so a client never offers a control the engine
 * has no route for.
 */
export function actionsFor(item: TaskItem): TaskActionId[] {
  const out: TaskActionId[] = [];
  const live = isLive(item.status);
  if (item.needsYou && live) {
    if (item.can?.approve) out.push('approve');
    if (item.kind === 'permission' || item.kind === 'question') out.push('review');
    if (item.can?.deny) out.push('deny');
  }
  if (live && item.can?.pause && item.status !== 'paused') out.push('pause');
  if (item.can?.resume && item.status === 'paused') out.push('resume');
  if (live && item.can?.stop) out.push('stop');
  if (!live && item.can?.retry && (item.status === 'failed' || item.status === 'stopped')) out.push('retry');
  if (item.transcriptId) out.push('transcript');
  if (item.can?.show) out.push('show');
  if (item.sessionId && item.kind !== 'permission' && item.kind !== 'question') out.push('open-chat');
  if (item.command) out.push('copy-command');
  return out;
}

// ── notifications ────────────────────────────────────────────────────────

export interface TaskChange {
  type: 'finished' | 'needs-you';
  item: TaskItem;
}

/**
 * What changed that a person should hear about: work that was live and has
 * ended, and work that has just started waiting for them. The first snapshot
 * (an empty `prev`) announces nothing — opening the window must not replay
 * every task that finished overnight as a burst of toasts.
 */
export type TaskMemo = ReadonlyMap<string, { status: TaskStatus; needsYou: boolean }>;

/** What {@link taskChanges} compares the next snapshot against. */
export function memoOf(items: TaskItem[]): TaskMemo {
  return new Map(items.map(i => [i.id, { status: i.status, needsYou: Boolean(i.needsYou && isLive(i.status)) }]));
}

export function taskChanges(prev: TaskMemo | undefined, next: TaskItem[]): TaskChange[] {
  if (!prev) return [];
  const out: TaskChange[] = [];
  for (const item of next) {
    const was = prev.get(item.id);
    if (was && isLive(was.status) && !isLive(item.status)) out.push({ type: 'finished', item });
    if (item.needsYou && isLive(item.status) && !was?.needsYou) out.push({ type: 'needs-you', item });
  }
  return out;
}
