/**
 * The Tasks view: everything running beside a conversation, in one shape a
 * person can read — the engine half of the desktop Tasks panel and the web
 * drawer (shared/tasks.ts is the other half).
 *
 * The ledger already answers "what is running?" (work/types — five registries
 * became one). What it does not carry is what a person watching needs: which
 * model, how many tokens each way, what the agent is doing *in words*, which
 * sub-agent started which, how far down its todo list it is, the last lines
 * a background server printed, and what is blocked waiting for *them* rather
 * than for a file to change. Those live elsewhere — the sub-agent and
 * background registries, the shell tool's buffer, the todo files, the long-job
 * journals, the approve-later inbox and the server's open runs — and this
 * module joins them onto the ledger rows at read time.
 *
 * ## In memory, beside the ledger — not in it
 *
 * The extra fields are kept in a side map fed by the two agent registries'
 * own change notifications (the same mirroring `work/adapters.ts` does), not
 * added to `WorkRecord`. The ledger's log is a persisted format and its rows
 * feed the model's running-work block; a token split or a step sentence is
 * neither something to migrate nor something to pay for on every turn. The
 * cost of that choice is honest and small: after a restart a row still has its
 * title, state, steps and spend from the ledger, but no model or step text.
 *
 * ## Redacted on the way out
 *
 * Step text, commands, output tails, briefs and outcomes can all carry a
 * secret a command echoed. Every string leaves through {@link clean}: vault
 * values out (the sink redactor), then anything shaped like a secret. The SSE
 * topic redacts again (server/events) — belt and braces for a panel that
 * shows raw command output.
 *
 * Deliberately not here: any action. Stopping, pausing, approving and denying
 * go through the routes that already exist (`work/stop`, `longjob/*`,
 * `inbox/decide`, `permission`, `cron/*`) with their own human checks; this
 * module only says which of them a row may offer.
 *
 * @module work/tasks
 */

import { ledger } from './ledger.js';
import { isTerminal, type WorkRecord } from './types.js';
import { processInfo } from './register.js';
import { subscribeToAgents, owningSession, type SubAgentRecord } from '../tools/task.js';
import { subscribeToBackgroundAgents, type BackgroundAgentRecord } from '../background/index.js';
import { loadTodos } from '../tools/todo.js';
import { sinkRedactText } from '../vault/sink.js';
import { scanForSecrets, replaceDetected } from '../vault/scan.js';
import {
  humaniseStep, type ScheduleItem, type TaskItem, type TaskKind, type TaskStatus, type TasksSnapshot,
} from '../../shared/tasks.js';

// ── redaction ────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** Secrets out, terminal escapes out, clipped. `tail` keeps the end (output), otherwise the start. */
export function clean(text: string | undefined, max: number, tail = false): string | undefined {
  if (!text) return undefined;
  let t = text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
  if (t.length > max) t = tail ? `…${t.slice(-max)}` : `${t.slice(0, max)}…`;
  t = sinkRedactText(t);
  const found = scanForSecrets(t);
  if (found.length) t = replaceDetected(t, found, d => `[redacted ${d.label}]`);
  t = t.replace(/\b(bearer|token|basic)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, '$1 [redacted]');
  return t.trim() || undefined;
}

// ── what the registries know that the ledger does not ────────────────────

interface AgentMeta {
  model?: string;
  agentName?: string;
  tokensIn: number;
  tokensOut: number;
  toolUses: number;
  step?: string;
  parentId?: string;
  sessionId?: string;
  transcriptId?: string;
  brief?: string;
  investigate?: boolean;
  result?: string;
  error?: string;
}

const META = new Map<string, AgentMeta>();
const META_LIMIT = 600;

function remember(id: string, meta: AgentMeta): void {
  META.delete(id);
  META.set(id, meta);
  if (META.size > META_LIMIT) META.delete(META.keys().next().value!);
}

function fromSubAgent(r: SubAgentRecord): AgentMeta {
  return {
    model: r.model,
    ...(r.agentName ? { agentName: r.agentName } : { agentName: r.agentType }),
    tokensIn: r.inputTokens,
    tokensOut: r.outputTokens,
    toolUses: r.toolCallCount,
    ...(r.lastStep ? { step: r.lastStep } : r.currentTool ? { step: humaniseStep(r.currentTool) } : {}),
    ...(r.parentAgentId ? { parentId: `agent:${r.parentAgentId}` } : {}),
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    transcriptId: `sub-${r.agentId}`,
    ...(r.brief ? { brief: r.brief } : {}),
    investigate: /^investigate \d+\/\d+$/.test(r.description),
    ...(r.result ? { result: r.result } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

function fromBackground(r: BackgroundAgentRecord): AgentMeta {
  return {
    model: r.model,
    ...(r.agentName ? { agentName: r.agentName } : {}),
    tokensIn: r.inputTokens,
    tokensOut: r.outputTokens,
    toolUses: r.toolCallCount,
    ...(r.lastStep ? { step: r.lastStep } : r.currentTool ? { step: humaniseStep(r.currentTool) } : {}),
    ...(r.result ? { result: r.result } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

let tracking: Array<() => void> = [];

/**
 * Start following the agent registries. Idempotent; called at server boot so
 * an agent that finishes (and is dropped from its registry ten seconds later)
 * before anyone opens the panel still has its model and token split here.
 */
export function startTaskTracking(): void {
  if (tracking.length) return;
  tracking.push(subscribeToAgents(records => {
    for (const r of records) remember(`agent:${r.agentId}`, fromSubAgent(r));
    changed();
  }));
  tracking.push(subscribeToBackgroundAgents(records => {
    for (const r of records) remember(`bg:${r.agentId}`, fromBackground(r));
    changed();
  }));
}

export function stopTaskTracking(): void {
  for (const off of tracking) off();
  tracking = [];
}

// ── what the server knows: open runs blocked on a person ─────────────────

export interface TaskAsk {
  type: 'permission' | 'question';
  sessionId: string;
  /** The permission request id (the `permission` route decides it by id). */
  id?: string;
  tool?: string;
  detail?: string;
  question?: string;
  at?: number;
}

export interface TaskAsksProvider {
  /** Every open run's pending permission or question. */
  asks(): TaskAsk[];
  /** Whether a chat has a run on this server (a follow-up can be queued to it). */
  open(sessionId: string): boolean;
}

let asksProvider: TaskAsksProvider | undefined;

/** Injected by the server at boot, as the watchers' wake delivery is: this module does not import the run manager. */
export function setTaskAsksProvider(next: TaskAsksProvider | undefined): void {
  asksProvider = next;
}

// ── the projection ───────────────────────────────────────────────────────

/** Finished rows kept in a snapshot: enough for "what failed while I was away", bounded for the wire. */
const FINISHED_LIMIT = 150;

function statusOf(state: WorkRecord['state'], paused = false): TaskStatus {
  switch (state) {
    case 'queued': return 'queued';
    case 'running': return 'running';
    case 'blocked': return paused ? 'paused' : 'waiting';
    case 'done': return 'completed';
    case 'cancelled': return 'stopped';
    default: return 'failed'; // failed, lost
  }
}

function kindOf(r: WorkRecord, meta: AgentMeta | undefined, longJobIds: Set<string>): TaskKind {
  if (r.id.startsWith('agent:')) return meta?.investigate ? 'investigate' : 'subagent';
  if (r.id.startsWith('bg:')) return 'background';
  if (r.id.startsWith('proc:')) return 'shell';
  if (r.id.startsWith('miniapp:')) return 'app';
  if (r.id.startsWith('cron:') || r.kind === 'schedule') return 'scheduled';
  if (r.kind === 'watcher') return 'watcher';
  if (longJobIds.has(r.id)) return 'longjob';
  if (r.kind === 'agent' || r.kind === 'remote') return 'background';
  if (r.kind === 'process') return 'shell';
  return 'run';
}

/** `Investigate 2/3 — <the angle>`, from the brief investigate.ts writes. */
function investigateTitle(description: string, brief: string | undefined): string {
  const m = /^investigate (\d+\/\d+)$/.exec(description);
  const angle = brief ? /Your angle, and only this one: (.+)/.exec(brief)?.[1] : undefined;
  return `Investigate ${m?.[1] ?? ''}${angle ? ` — ${angle.trim()}` : ''}`.trim();
}

type LongJob = import('../longjob/index.js').LongJob;
type Parked = import('../autonomy/inbox.js').PendingAction;

/** Disk-backed sources, cached briefly: the snapshot is rebuilt on every agent beat. */
let diskCache: { at: number; jobs: LongJob[]; parked: Parked[]; schedules: ScheduleItem[] } | undefined;
const DISK_TTL_MS = 2000;

async function diskSources(now: number): Promise<NonNullable<typeof diskCache>> {
  if (diskCache && now - diskCache.at < DISK_TTL_MS) return diskCache;
  let jobs: LongJob[] = [];
  let parked: Parked[] = [];
  let schedules: ScheduleItem[] = [];
  try { jobs = (await import('../longjob/index.js')).listJobs().slice(0, 50); } catch { /* best effort: no long jobs shown */ }
  try { parked = (await import('../autonomy/inbox.js')).listActions({ status: 'pending' }); } catch { /* best effort: no parked calls shown */ }
  try {
    const { executeCronList } = await import('../cron/tools.js');
    schedules = executeCronList().map(j => ({
      id: j.id, name: j.name, schedule: j.schedule, paused: j.status === 'paused',
      ...(j.nextRun ? { nextRun: j.nextRun } : {}), ...(j.lastRun ? { lastRun: j.lastRun } : {}),
      ...(j.lastOutcome ? { lastOutcome: clean(j.lastOutcome, 200) } : {}),
      runCount: j.runCount,
    }));
  } catch { /* best effort: the scheduler is not loaded (a bare test process) */ }
  diskCache = { at: now, jobs, parked, schedules };
  return diskCache;
}

function fromLedger(
  r: WorkRecord, jobsById: Map<string, LongJob>, longJobIds: Set<string>,
): TaskItem {
  const meta = META.get(r.id);
  const kind = kindOf(r, meta, longJobIds);
  const job = kind === 'longjob' ? jobsById.get(r.id) : undefined;
  const status = statusOf(r.state, job?.status === 'paused');
  const live = !isTerminal(r.state);
  const proc = kind === 'shell' ? processInfo(r.id) : undefined;
  // A process the model started inside a sub-agent hangs under that sub-agent.
  const procParent = proc?.startedBy?.startsWith('sub-') ? `agent:${proc.startedBy.slice(4)}` : undefined;
  const procSession = proc?.startedBy ? owningSession(proc.startedBy) : undefined;
  const sessionId = r.sessionId ?? meta?.sessionId ?? job?.sessionId ?? procSession;
  const parentId = r.parent ?? meta?.parentId ?? procParent;
  const cronJobId = kind === 'scheduled' && r.id.startsWith('cron:') ? r.id.slice(5, r.id.lastIndexOf(':')) : undefined;

  const title = kind === 'investigate' ? investigateTitle(r.title, meta?.brief)
    : kind === 'longjob' ? (job?.title ?? r.title.replace(/^Long job: /, ''))
      : kind === 'shell' ? (clean(proc?.command ?? r.title, 160) ?? r.title)
        : r.title;

  const step = live
    ? (meta?.step ?? (r.progress?.lastTool ? humaniseStep(r.progress.lastTool) : undefined) ?? r.progress?.note)
    : meta?.step;

  const outcome = r.state === 'done' ? (r.result ?? meta?.result) : undefined;
  const error = r.state !== 'done' && isTerminal(r.state) ? (r.error ?? meta?.error) : undefined;

  const item: TaskItem = {
    id: r.id,
    kind,
    title: clean(title, 200) ?? r.id,
    status,
    ...(sessionId ? { sessionId } : {}),
    ...(parentId ? { parentId } : {}),
    ...(meta?.agentName ? { agentName: meta.agentName } : {}),
    ...(meta?.model ? { model: meta.model } : {}),
    origin: r.origin,
    startedAt: r.startedAt,
    ...(r.endedAt ? { endedAt: r.endedAt } : {}),
    heartbeatAt: r.heartbeatAt,
    ...(meta ? { tokensIn: meta.tokensIn, tokensOut: meta.tokensOut } : r.cost?.tokens ? { tokensIn: r.cost.tokens } : {}),
    ...(r.cost?.usd ? { costUsd: r.cost.usd } : job?.spentUsd ? { costUsd: job.spentUsd } : {}),
    ...(meta ? { toolUses: meta.toolUses } : (kind === 'background' || kind === 'scheduled') && r.progress?.steps ? { toolUses: r.progress.steps } : {}),
    ...(step ? { step: clean(step, 160) } : {}),
    ...(outcome ? { outcome: clean(outcome, 600) } : {}),
    ...(error ? { error: clean(error, 600) } : {}),
    ...(meta?.brief && kind !== 'investigate' ? { detail: clean(meta.brief, 400) } : {}),
    ...(proc ? { command: clean(proc.command, 2000), ...(proc.output ? { output: clean(proc.output, 4000, true) } : {}) } : {}),
    ...(r.pid !== undefined ? { pid: r.pid } : {}),
    ...(meta?.transcriptId ? { transcriptId: meta.transcriptId } : {}),
    ref: {
      ledgerId: r.id,
      ...(job ? { longJobId: job.id } : {}),
      ...(cronJobId ? { cronJobId } : {}),
    },
    can: {
      stop: live,
      ...(job ? { pause: job.status === 'running', resume: job.status === 'paused' } : {}),
      // A failed delegation is retried by asking its chat to, which needs the chat's run here.
      ...(!live && (kind === 'subagent' || kind === 'investigate') && sessionId && asksProvider?.open(sessionId) ? { retry: true } : {}),
    },
  };
  if (job) {
    const done = job.milestones.filter(m => m.doneAt).length;
    const current = job.milestones.find(m => !m.doneAt)?.title;
    item.todo = { done, total: job.milestones.length, ...(current ? { current: clean(current, 120)! } : {}) };
    if (job.note && status === 'paused') item.detail = clean(job.note, 300);
  }
  return item;
}

/** A sub-agent's own todo list (TodoWrite inside it is keyed by its session, `sub-<id>`). */
async function attachTodos(items: TaskItem[]): Promise<void> {
  await Promise.all(items.map(async (item) => {
    if (!item.transcriptId || (item.status !== 'running' && item.status !== 'waiting')) return;
    try {
      const todos = (await loadTodos(item.transcriptId)).filter(t => t.status !== 'cancelled');
      if (!todos.length) return;
      const current = todos.find(t => t.status === 'in_progress')?.title;
      item.todo = { done: todos.filter(t => t.status === 'done').length, total: todos.length, ...(current ? { current: clean(current, 120)! } : {}) };
    } catch { /* best effort: no list shown */ }
  }));
}

/**
 * Everything, now: live work, recently finished work, and what waits for a
 * person. Pure read; safe to call from any route.
 */
export async function tasksSnapshot(now = Date.now()): Promise<TasksSnapshot> {
  startTaskTracking();
  const { jobs, parked, schedules } = await diskSources(now);
  const jobsById = new Map(jobs.map(j => [j.id, j]));
  const longJobIds = new Set(jobs.map(j => j.id));

  const all = ledger.all();
  const live = all.filter(r => !isTerminal(r.state));
  const finished = all.filter(r => isTerminal(r.state))
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
    .slice(0, FINISHED_LIMIT);
  const items = [...live, ...finished].map(r => fromLedger(r, jobsById, longJobIds));
  await attachTodos(items);

  // Long-job proposals: waiting for a person's yes, and nothing else runs in that chat until then.
  for (const job of jobs) {
    if (job.status !== 'pending') continue;
    items.push({
      id: `longjob:${job.id}`,
      kind: 'longjob',
      title: clean(job.title, 200) ?? 'Long job',
      status: 'waiting',
      needsYou: true,
      sessionId: job.sessionId,
      origin: 'model',
      startedAt: job.createdAt,
      detail: clean(`Estimated ${job.estimateHours} h · budget $${job.budget.usd} and ${job.budget.hours} h · ${job.milestones.length} milestones${job.missing.length ? ` · still missing: ${job.missing.join(', ')}` : ''}`, 400),
      todo: { done: 0, total: job.milestones.length },
      ref: { longJobId: job.id },
      can: { approve: job.missing.length === 0, deny: true },
    });
  }

  // The approve-later inbox: calls an unattended run parked for a person.
  for (const a of parked) {
    items.push({
      id: `inbox:${a.id}`,
      kind: 'inbox',
      title: clean(`${a.tool}${a.label ? ` — ${a.label}` : ''}`, 200) ?? a.tool,
      status: 'waiting',
      needsYou: true,
      ...(a.sessionId ? { sessionId: a.sessionId } : {}),
      ...(a.agentName ? { agentName: a.agentName } : {}),
      ...(a.agentModel ? { model: a.agentModel } : {}),
      origin: a.origin,
      startedAt: a.createdAt,
      detail: clean(`${a.why}\n${a.call}`, 600),
      ref: { inboxId: a.id },
      can: { approve: true, deny: true },
    });
  }

  // Open chats blocked on a tool permission or a question.
  for (const ask of asksProvider?.asks() ?? []) {
    if (ask.type === 'permission' && ask.id) {
      items.push({
        id: `ask:permission:${ask.sessionId}`,
        kind: 'permission',
        title: `Allow ${ask.tool ?? 'a tool'}?`,
        status: 'waiting',
        needsYou: true,
        sessionId: ask.sessionId,
        startedAt: ask.at ?? now,
        ...(ask.detail ? { detail: clean(ask.detail, 600) } : {}),
        ref: { permissionId: ask.id },
        // Allowing needs the window that shows the chat (decision gate); refusing needs nothing.
        can: { deny: true },
      });
    } else if (ask.type === 'question') {
      items.push({
        id: `ask:question:${ask.sessionId}`,
        kind: 'question',
        title: 'The agent asked you something',
        status: 'waiting',
        needsYou: true,
        sessionId: ask.sessionId,
        startedAt: ask.at ?? now,
        ...(ask.question ? { detail: clean(ask.question, 600) } : {}),
      });
    }
  }

  return { at: now, items, schedules };
}

// ── live updates ─────────────────────────────────────────────────────────

type Listener = (snapshot: TasksSnapshot) => void;
const listeners = new Set<Listener>();
let pending: ReturnType<typeof setTimeout> | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let offLedger: (() => void) | undefined;
let lastSent = '';

/** Coalesce: an agent beats on every tool call and every token count. */
const DEBOUNCE_MS = 300;
/**
 * The sources with no notification — the inbox, long-job journals, the
 * server's pending permissions — are re-read on this beat while anyone
 * watches. A permission prompt reaches the panel within this long.
 */
const TICK_MS = 3000;

function changed(): void {
  if (!listeners.size || pending) return;
  pending = setTimeout(() => {
    pending = undefined;
    void tasksSnapshot().then((snap) => {
      // Skip a frame identical to the last one (the tick usually finds nothing new).
      const key = JSON.stringify({ i: snap.items, s: snap.schedules });
      if (key === lastSent) return;
      lastSent = key;
      for (const fn of listeners) {
        try { fn(snap); } catch { /* a broken subscriber is its own problem */ }
      }
    }).catch(() => { /* best effort: the next change tries again */ });
  }, DEBOUNCE_MS);
  pending.unref?.();
}

/** Follow the snapshot. Ticks only while someone follows; returns the unsubscribe. */
export function subscribeTasks(fn: Listener): () => void {
  startTaskTracking();
  listeners.add(fn);
  if (listeners.size === 1) {
    lastSent = '';
    offLedger = ledger.subscribe(() => changed());
    ticker = setInterval(changed, TICK_MS);
    ticker.unref?.();
  }
  changed();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      offLedger?.(); offLedger = undefined;
      if (ticker) clearInterval(ticker);
      ticker = undefined;
    }
  };
}

/** Tests only. */
export function resetTasksForTest(): void {
  stopTaskTracking();
  META.clear();
  listeners.clear();
  offLedger?.(); offLedger = undefined;
  if (ticker) clearInterval(ticker);
  ticker = undefined;
  if (pending) clearTimeout(pending);
  pending = undefined;
  diskCache = undefined;
  asksProvider = undefined;
  lastSent = '';
}
