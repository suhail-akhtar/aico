/**
 * Delivery: the task board's service (ADR 0038). Dispatcher, serial merge queue and
 * hygiene over the journal in `store.ts`.
 *
 * The shape, and why each part is where it is:
 *
 *  - **Dispatcher** (`tick`): every few seconds while a person has it running, start
 *    up to `maxParallel` (default 2, cap 4) ready tasks whose dependencies are merged
 *    and whose touched files do not overlap a running task's. Each starts in its own
 *    `git worktree` on `aico/task-<id>` made from the trunk and prepared for its stack
 *    (`env.ts`), as an agent run (`runner.ts`; under the server, a chat session) with a
 *    spend ceiling and a deadline. Progress renews a lease; a
 *    claim whose lease runs out (the process died) goes back to `ready`. A paused
 *    dispatcher starts nothing but still collects finished runs.
 *  - **Scrum mode** (ADR 0039 section 4, `scrum.ts` / `scrum-fold.ts`): when the board's mode is Scrum the
 *    dispatcher starts only `ready` tasks that belong to the active sprint (`mayStartInMode`); rework of work
 *    already begun is never gated. Switching the mode back loses nothing.
 *  - **Merge queue** (`prepare`, `approve`): serial, one change at a time. A submitted
 *    task is rebased onto the current trunk, its checks run on the rebased tree (a tree
 *    already green is not run again), and it gets an evidence report and a risk score
 *    before it is `review`. A conflict or a red check sends it back (`changes`) with the
 *    reason and the dispatcher resumes it. The agent never merges. Approval lands it by
 *    fast-forward; if the trunk moved since review it is rebased and checked again first.
 *  - **Local only.** Nothing here pushes. The trunk moves only when a person approves
 *    (the route is human-gated) or, if the board's setting says so, for low-risk work
 *    whose checks are green.
 *  - **Batch review.** A person may land several low-risk, green tasks with one yes
 *    (`approveBatch`); they still land one at a time through the same lane, each
 *    re-checked if the trunk moved, and anything that is not low risk is refused by name.
 *  - **Needs you.** A run held in a chat can wait for a person (a question, a permission
 *    card, a parked call). The tick reads that from the runner and journals it on the task
 *    (`needs`), so every client sees "this task is waiting for you" from the same fold; the
 *    answer goes through the chat's own routes (nothing here says yes for anyone).
 *  - **Releases** (`planRelease`, `createRelease`, `deployRelease`, `rollbackRelease`,
 *    `release.ts`): tasks that landed since the last tag become a version, notes and a local
 *    annotated tag; a deploy is a person's click running the configured command; a rollback
 *    is a task that reverts the release's commits and goes through this same queue.
 *  - **Autonomy** (`autonomy.ts`, ADR 0038 "Autonomy levels"). The board's level is a ceiling on what the
 *    engine does without a person: `assisted` also starts the prerequisites of Ready tasks and lands
 *    low-risk green work; `autonomous` also pulls the next backlog tasks and lands medium risk; `full` also
 *    lands high risk when the organisation's policy allows. Safety findings (a secret, a weakened test, a
 *    high-severity rule) wait for a person at every level, and the hard limits (per-task budget, daily
 *    budget, parallelism, a failure streak) are enforced HERE in the tick, which pauses the dispatcher and
 *    says why. Nothing acts while the dispatcher is paused: a person started it, and pausing is the kill switch.
 *  - **What does not travel.** AICO's own machine state (`runtime-files.ts`) is kept out of every task's
 *    commits and diff, and a landing that a file in the person's checkout stands in the way of becomes a
 *    decision with two named choices (`landing.ts`), never a raw git error.
 *  - **Hygiene.** Merging or cancelling removes the worktree and the branch. Work that
 *    is not on the trunk is never discarded: a branch with unmerged commits is kept and
 *    named. A periodic sweep removes `aico/task-*` worktrees whose task is over, prunes
 *    stale worktree records and lets git run its own `gc --auto` when no run is active.
 *
 * All state is the journal; the in-memory part (live run handles, timers, locks) is
 * rebuilt or harmless after a restart, which comes back with the dispatcher paused.
 *
 * Deliberately not here: any model call (planning is a normal chat turn that uses the
 * `Delivery` tool), merging a combination nobody checked (no merge commits), or any
 * network access.
 *
 * @module delivery
 */

import fs from 'node:fs';
import path from 'node:path';
import { projectKey } from '../learning/proposals.js';
import { looksLikeSecretPath } from '../tools/git.js';
import { pushNotification } from '../background/notifications.js';
import { buildEvidence, render, type EvidencePacket } from '../evidence/index.js';
import { checksFor } from '../project/profile.js';
import type { SessionEvent } from '../session/events.js';
import { eventLogPath } from '../session/persistence.js';
import { sinkRedactText } from '../vault/sink.js';
import { appendOwnAuditEvent } from '../audit/log.js';
import { deliveryAutonomyCap } from '../policy/enforce.js';
import { autonomyRank, isAutonomy } from '../../shared/delivery/autonomy.js';
import { isDueDate, parseQuickAdd } from '../../shared/delivery/quickadd.js';
import { autoLandDecision, effectiveAutonomy, powersOf } from './autonomy.js';
import { AGENT_SLOTS, awaitingReview, runningCeiling } from './board-view.js';
import { displacedDir, findCollisions, setAside, type Collision } from './landing.js';
import { RUNTIME_EXCLUDES, dropPaths, isRuntimePath, scrubBranch } from './runtime-files.js';
import { deliveryConfig } from './config.js';
import { localiseDeps, prepareWorktree, unlinkDeps } from './env.js';
import { runCommand } from './exec.js';
import * as G from './git.js';
import { branchOf, relativeToWorktrees, worktreePath, worktreesRoot } from './paths.js';
import * as R from './release.js';
import { backgroundRunner, type AgentRunner } from './runner.js';
import { runPrompt } from './prompts.js';
import { assessRisk, levelOf, numstat } from './risk.js';
import { applyRemoteRisk } from '../connections/pr-risk.js';
import * as S from './store.js';
import { mayStartInMode } from './scrum-fold.js';
import { actualTouches, overlap, predictTouches } from './touches.js';
import { verifyTree } from './verify.js';
import type {
  ActivityEntry, Assignee, AttentionSnapshot, Autonomy, BatchResult, BoardState, DispatcherState, Release, ReleasePlan, Task, TaskNeed,
  TaskPriority, TaskStatus, TaskType,
} from './types.js';
import type { PullState } from '../../shared/connections/types.js';

export type { BoardState, Task } from './types.js';
export { boardState, getTask, onChange as onBoardChange, projectOfKey, journaledProjects } from './store.js';

export const LEASE_MS = 5 * 60_000;
export const TICK_MS = 3_000;
export const SWEEP_MS = 10 * 60_000;
export const DEFAULT_TASK_BUDGET_USD = 3;
export const TASK_DEADLINE_MS = 45 * 60_000;
/** Conflict / red-check round trips before a task waits for a person instead of looping. */
export const MAX_REWORK_ROUNDS = 4;

const MAX_TASKS_PER_BOARD = 500;
const MAX_BATCH = 25;

export class DeliveryError extends Error {
  /** `code` and `data` let a client act on the refusal (a landing collision names its files and choices) instead of parsing the sentence. */
  constructor(message: string, readonly status = 400, readonly code?: string, readonly data?: Record<string, unknown>) { super(message); }
}

// The organisation's ceiling on autonomy is applied wherever the board is read or acted on; the store stays free of policy.
S.setAutonomyCapProvider(() => { try { return deliveryAutonomyCap(); } catch { return undefined; } });

const iso = (ms: number): string => new Date(ms).toISOString();

// ── configuration ────────────────────────────────────────────────────────

interface Config {
  runner: AgentRunner | undefined;
  now: () => number;
  budgetUsd: () => number;
}

const config: Config = { runner: undefined, now: Date.now, budgetUsd: () => DEFAULT_TASK_BUDGET_USD };

/** The server (or a test) says how runs start. Unset: the background-agent runner, built on first use. */
export function configureDelivery(next: Partial<Config>): void { Object.assign(config, next); }

function runner(): AgentRunner { return (config.runner ??= backgroundRunner()); }

// ── landing hooks (PR mode, ADR 0039) ────────────────────────────────────

/**
 * How a project lands work when it is not `local`. Delivery stays free of the network (its
 * tests assert it never runs push/fetch): the connections module installs these at start-up
 * and owns every remote call. Without hooks, or in `local` mode, nothing here changes.
 */
export interface LandingHooks {
  mode(project: string): 'local' | 'pr';
  /** PR mode: bring the local trunk up to the remote's (fast-forward only) before a task is prepared. */
  beforePrepare?(project: string): Promise<void>;
  /** A person approved: push the task branch and open (or update) its pull request. */
  openPr(project: string, task: Task): Promise<{ ok: true; pr: PullState } | { ok: false; reason: string; status?: number }>;
  /** A person clicked Merge: ask the remote to merge (it may refuse). */
  mergePr(project: string, task: Task, opts: { method?: 'merge' | 'squash' | 'rebase' }): Promise<{ ok: true; pr: PullState } | { ok: false; reason: string; status?: number }>;
  /** The remote merged it: update the local trunk and say where the work landed. */
  afterMerged?(project: string, task: Task, pr: PullState): Promise<{ from?: string; to?: string } | undefined>;
}

let landing: LandingHooks | undefined;
export function setLandingHooks(hooks: LandingHooks | undefined): void { landing = hooks; }
const prMode = (project: string): boolean => { try { return landing?.mode(project) === 'pr'; } catch { return false; } };

// ── paths ────────────────────────────────────────────────────────────────

export { worktreesRoot, worktreePath, branchOf, isDeliveryWorktree, relativeToWorktrees } from './paths.js';

/** Which task a directory belongs to, when it is inside a delivery worktree. */
export function taskAt(dir: string): { project: string; task: Task; worktree: string } | undefined {
  const rel = relativeToWorktrees(dir);
  if (!rel) return undefined;
  const [key, id] = rel.split(/[\\/]/);
  if (!key || !id) return undefined;
  const project = S.projectOfKey(key);
  const task = project ? S.getTask(project, id) : undefined;
  return project && task ? { project, task, worktree: path.join(worktreesRoot(), key, id) } : undefined;
}

// ── in-memory run state (rebuilt after a restart; the journal is the truth) ──

interface Handle {
  runId: string; project: string; lastActivityAt: number;
  /** The task's spend before this run: the run's own cost starts at zero, the task's is the sum of its runs. */
  costBase: number;
  /** When an edit last made it into the task's history (edits are coalesced; one line per 20 s at most). */
  lastEditLogAt: number;
  /** Why the ENGINE stopped this run (the daily budget); the run's own words say only "stopped". */
  stopReason?: string;
}

const handles = new Map<string, Handle>();      // `${projectKey}/${taskId}` → live run
const preparing = new Set<string>();           // same key: being rebased / checked now
const noAuto = new Set<string>();              // `${projectKey}/${taskId}`: an automatic landing was tried and needs a person now
const chains = new Map<string, Promise<unknown>>();
const active = new Set<string>();              // projects the timer ticks
let timer: NodeJS.Timeout | undefined;
let sweepTimer: NodeJS.Timeout | undefined;

const hk = (project: string, id: string): string => `${projectKey(project)}/${id}`;

/** Run `fn` after everything queued before it on `lane` for this project. Errors do not poison the lane. */
function serial<T>(project: string, lane: 'tick' | 'queue', fn: () => Promise<T>): Promise<T> {
  const key = `${lane}:${projectKey(project)}`;
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.catch(() => undefined));
  return next;
}

/** Tests: forget all in-memory state, as a restart does. */
export function resetDeliveryForTest(): void {
  handles.clear(); preparing.clear(); chains.clear(); active.clear(); noAuto.clear();
  if (timer) { clearInterval(timer); timer = undefined; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = undefined; }
  S.resetStoreCache();
  config.runner = undefined; config.now = Date.now; config.budgetUsd = () => DEFAULT_TASK_BUDGET_USD;
}

// ── tasks ────────────────────────────────────────────────────────────────

export interface TaskInput {
  title?: unknown; body?: unknown; acceptance?: unknown; priority?: unknown; dependsOn?: unknown; labels?: unknown; status?: unknown;
  /** `null` clears (update only). */
  type?: unknown; parentId?: unknown; assignee?: unknown; dueDate?: unknown;
  /** create: read the title as a quick-add line ("Fix login !1 #auth @sam due:2026-10-20 type:bug"). */
  quick?: unknown;
}

const TASK_TYPES: readonly TaskType[] = ['feature', 'bug', 'chore', 'spike', 'docs'];

function typeOf(v: unknown): TaskType | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v === 'string' && (TASK_TYPES as readonly string[]).includes(v)) return v as TaskType;
  throw new DeliveryError(`type must be one of ${TASK_TYPES.join(', ')}`);
}

function dueOf(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (isDueDate(v)) return v;
  throw new DeliveryError('dueDate must be a date like 2026-10-31');
}

function assigneeOf(v: unknown): Assignee | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const o = typeof v === 'string' ? { kind: 'person', name: v } : (v as { kind?: unknown; name?: unknown } | null);
  const name = typeof o?.name === 'string' ? o.name.trim().slice(0, 60) : '';
  if (!name) throw new DeliveryError('assignee needs a name');
  if (o?.kind === 'agent') {
    if (!(AGENT_SLOTS as readonly string[]).includes(name)) throw new DeliveryError(`an agent assignee is one of ${AGENT_SLOTS.join(', ')}`);
    return { kind: 'agent', name };
  }
  if (o?.kind !== 'person') throw new DeliveryError('assignee.kind must be "person" or "agent"');
  return { kind: 'person', name };
}

/** An epic: another task on this board, not this one, not itself inside an epic, and not one that already has children of its own. */
function parentOf(project: string, v: unknown, selfId?: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new DeliveryError('parentId must be a task id');
  const f = S.load(project);
  const parent = f.tasks.get(v);
  if (!parent) throw new DeliveryError(`parentId names no task on this board: ${clip(v, 60)}`);
  if (selfId && parent.id === selfId) throw new DeliveryError('a task cannot be its own epic');
  if (parent.parentId) throw new DeliveryError('an epic cannot itself belong to an epic (one level only)');
  if (selfId && [...f.tasks.values()].some(t => t.parentId === selfId)) throw new DeliveryError('this task is an epic with children, so it cannot belong to another epic');
  return parent.id;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const firstLine = (s: string): string => s.split(/\r?\n/)[0] ?? '';

function strings(v: unknown, max: number, each: number): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new DeliveryError('expected a list of strings');
  return v.filter((x): x is string => typeof x === 'string').map(s => clip(s.trim(), each)).filter(Boolean).slice(0, max);
}

function priorityOf(v: unknown): TaskPriority | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (n === 1 || n === 2 || n === 3 || n === 4) return n;
  throw new DeliveryError('priority must be 1, 2, 3 or 4 (1 is the most urgent)');
}

/** A task id or an exact title of a task on this board, as the planner refers to earlier tasks. */
function resolveDeps(project: string, deps: string[], selfId?: string): string[] {
  const f = S.load(project);
  const out: string[] = [];
  for (const d of deps) {
    const byId = f.tasks.get(d);
    const byTitle = byId ? undefined : [...f.tasks.values()].filter(t => t.title.trim().toLowerCase() === d.trim().toLowerCase());
    const hit = byId ?? (byTitle?.length === 1 ? byTitle[0] : undefined);
    if (!hit) throw new DeliveryError(`dependsOn names no task on this board: ${clip(d, 60)}`);
    if (hit.id === selfId) throw new DeliveryError('a task cannot depend on itself');
    if (!out.includes(hit.id)) out.push(hit.id);
  }
  if (selfId) {
    // No cycles: following dependencies from any of them must not come back to this task.
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (id === selfId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (f.tasks.get(id)?.dependsOn ?? []).some(walk);
    };
    if (out.some(walk)) throw new DeliveryError('those dependencies would make a cycle');
  }
  return out;
}

async function ensureBoard(project: string): Promise<string> {
  const p = path.resolve(project);
  if (!fs.existsSync(S.journalFile(p))) {
    const trunk = (await G.currentBranch(p)) ?? 'main';
    S.ensureInit(p, trunk);
  }
  return p;
}

export async function createTask(project: string, input: TaskInput, by: 'person' | 'agent' | 'system' = 'person'): Promise<Task> {
  const p = await ensureBoard(project);
  let title = typeof input.title === 'string' ? clip(input.title.trim(), 200) : '';
  let quick: ReturnType<typeof parseQuickAdd> | undefined;
  if (input.quick === true && title) {
    quick = parseQuickAdd(title);
    title = quick.title;
  }
  if (!title) throw new DeliveryError('title required');
  if (S.load(p).tasks.size >= MAX_TASKS_PER_BOARD) throw new DeliveryError(`this board already holds ${MAX_TASKS_PER_BOARD} tasks; cancel or finish some first`);
  const id = S.newTaskId();
  const now = iso(config.now());
  const status = input.status === undefined ? 'backlog' : input.status;
  if (status !== 'backlog' && status !== 'ready' && status !== 'blocked') throw new DeliveryError('a new task starts in backlog, ready or blocked');
  const priority = priorityOf(input.priority) ?? quick?.priority ?? 3;
  const type = typeOf(input.type) ?? quick?.type;
  const dueDate = dueOf(input.dueDate) ?? quick?.dueDate;
  const assignee = assigneeOf(input.assignee) ?? (quick?.assignee ? assigneeOf(quick.assignee) : undefined);
  const parentId = parentOf(p, input.parentId);
  const task: Task = {
    id, project: p, title,
    body: typeof input.body === 'string' ? clip(input.body, 20_000) : '',
    acceptance: strings(input.acceptance, 20, 500) ?? [],
    status, priority,
    dependsOn: resolveDeps(p, strings(input.dependsOn, 20, 200) ?? []),
    labels: [...new Set([...(strings(input.labels, 20, 80) ?? []), ...(quick?.labels ?? [])])].slice(0, 20),
    ...(type ? { type } : {}), ...(dueDate ? { dueDate } : {}), ...(assignee ? { assignee } : {}), ...(parentId ? { parentId } : {}),
    rank: S.nextRankIn(S.load(p).tasks.values(), priority), changeCount: 0, activity: [],
    createdAt: now, updatedAt: now,
  };
  S.putTask(p, task, by);
  kick(p);
  return S.getTask(p, id)!;
}

const EDITABLE_STATUS: ReadonlySet<TaskStatus> = new Set(['backlog', 'ready', 'blocked', 'cancelled']);

/**
 * Edit a task. Text fields while it is open; `status` only to backlog / ready / blocked /
 * cancelled. A person (the route) may do all of that; an agent (the tool, `by: 'agent'`)
 * may not promote a task to `ready`: starting spend is a person's act (ADR 0038).
 */
export async function updateTask(project: string, id: string, input: TaskInput, by: 'person' | 'agent' = 'person'): Promise<Task> {
  const p = path.resolve(project);
  const task = S.getTask(p, id);
  if (!task) throw new DeliveryError(`no task ${id} on this board`, 404);
  if (task.status === 'merged' || task.status === 'cancelled') throw new DeliveryError(`task ${id} is ${task.status} and cannot change`, 409);
  const set: Partial<Task> = {};
  if (input.title !== undefined) {
    const t = typeof input.title === 'string' ? clip(input.title.trim(), 200) : '';
    if (!t) throw new DeliveryError('title cannot be empty');
    set.title = t;
  }
  if (input.body !== undefined) set.body = typeof input.body === 'string' ? clip(input.body, 20_000) : '';
  const acceptance = strings(input.acceptance, 20, 500); if (acceptance) set.acceptance = acceptance;
  const labels = strings(input.labels, 20, 80); if (labels) set.labels = labels;
  const pr = priorityOf(input.priority);
  if (pr) {
    set.priority = pr;
    // A new priority is a new place in the order: after everything already at that priority.
    if (pr !== task.priority) set.rank = S.nextRankIn([...S.load(p).tasks.values()].filter(t => t.id !== id), pr);
  }
  const deps = strings(input.dependsOn, 20, 200); if (deps) set.dependsOn = resolveDeps(p, deps, id);
  const unset: Array<keyof Task> = [];
  const typ = typeOf(input.type); if (typ === null) unset.push('type'); else if (typ) set.type = typ;
  const due = dueOf(input.dueDate); if (due === null) unset.push('dueDate'); else if (due) set.dueDate = due;
  const who = assigneeOf(input.assignee); if (who === null) unset.push('assignee'); else if (who) set.assignee = who;
  const par = parentOf(p, input.parentId, id); if (par === null) unset.push('parentId'); else if (par) set.parentId = par;
  // The text changed: what was predicted from it is stale.
  if ((set.title !== undefined || set.body !== undefined || set.labels || set.acceptance) && task.touches?.predicted) unset.push('touches');

  let status: TaskStatus | undefined;
  if (input.status !== undefined) {
    status = input.status as TaskStatus;
    if (!EDITABLE_STATUS.has(status)) throw new DeliveryError('status can be set to backlog, ready, blocked or cancelled; the engine moves a task through running, review, changes and merged');
    if (status === 'cancelled' && by !== 'person' && task.status !== 'backlog' && task.status !== 'blocked') throw new DeliveryError('an agent can cancel only a backlog or blocked task; stopping a task that has started needs a person');
    if (status === 'ready' && by !== 'person') throw new DeliveryError('only a person promotes a task to ready: that is what lets the dispatcher spend money on it');
    if ((task.status === 'running' || task.status === 'review' || task.status === 'changes' || task.status === 'pr') && status !== 'cancelled' && status !== 'blocked') {
      throw new DeliveryError(`task ${id} is ${task.status}; it can be cancelled or blocked, or finish its run first`, 409);
    }
  }
  if (Object.keys(set).length > 0 || unset.length > 0) S.patchTask(p, id, set, unset, by);
  if (status && status !== task.status) {
    if (status === 'cancelled') await cancelTask(p, id);
    else if (status === 'blocked' && (task.status === 'running' || task.status === 'review' || task.status === 'changes' || task.status === 'pr')) await releaseRun(p, id, 'blocked');
    else S.patchTask(p, id, { status }, [], by);
  }
  kick(p);
  return S.getTask(p, id)!;
}

/** A copy in the backlog: the same words, priority, labels, type, epic, due date and prerequisites; no run, no assignee, no history. */
export async function duplicateTask(project: string, id: string, by: 'person' | 'agent' = 'person'): Promise<Task> {
  const p = path.resolve(project);
  const t = S.getTask(p, id);
  if (!t) throw new DeliveryError(`no task ${id} on this board`, 404);
  const copy = await createTask(p, {
    title: `${t.title} (copy)`, body: t.body, acceptance: t.acceptance, priority: t.priority, labels: t.labels,
    dependsOn: t.dependsOn.filter(d => S.getTask(p, d)), ...(t.type ? { type: t.type } : {}), ...(t.dueDate ? { dueDate: t.dueDate } : {}),
    ...(t.parentId && S.getTask(p, t.parentId) ? { parentId: t.parentId } : {}),
  }, by);
  S.logActivity(p, copy.id, 'duplicated', by, `Duplicated from "${clip(t.title, 60)}".`);
  return S.getTask(p, copy.id)!;
}

const MAX_BULK = 100;

/**
 * Apply one patch to many tasks. Each task goes through `updateTask`, so every rule that holds for one
 * (an agent cannot ready a task; a running task cannot be edited into the wrong column) holds here, and
 * one task failing does not undo the others: the result names what changed and what was refused and why.
 */
export async function bulkUpdate(project: string, ids: readonly string[], patch: TaskInput, by: 'person' | 'agent' = 'person'): Promise<{ tasks: Task[]; failed: Array<{ id: string; error: string }> }> {
  const p = path.resolve(project);
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new DeliveryError('choose at least one task');
  if (unique.length > MAX_BULK) throw new DeliveryError(`a bulk update changes at most ${MAX_BULK} tasks`);
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) throw new DeliveryError('patch needs at least one field');
  const tasks: Task[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of unique) {
    try { tasks.push(await updateTask(p, id, patch, by)); }
    catch (e) { if (e instanceof DeliveryError) failed.push({ id, error: e.message }); else throw e; }
  }
  return { tasks, failed };
}

/**
 * Put one column's cards in a new order. The new order is expressed with the ranks the cards ALREADY
 * hold: the listed cards swap ranks among themselves, so cards that were not listed keep their place
 * relative to everything, and dragging a card above a more urgent one lets the dispatcher honour what
 * the person did (rank first, then priority). The ids must all be in the named column.
 */
export function reorderTasks(project: string, status: TaskStatus, ids: readonly string[]): { ok: true; ranks: Record<string, number> } {
  const p = path.resolve(project);
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new DeliveryError('ids needed: the cards of the column, in their new order');
  if (unique.length > 500) throw new DeliveryError('too many cards to reorder at once');
  const f = S.load(p);
  const tasks = unique.map(id => f.tasks.get(id));
  const missing = unique.filter((_, i) => !tasks[i]);
  if (missing.length > 0) throw new DeliveryError(`no such task on this board: ${missing.slice(0, 3).join(', ')}`, 404);
  const wrong = tasks.filter(t => t!.status !== status);
  if (wrong.length > 0) throw new DeliveryError(`${wrong.slice(0, 3).map(t => t!.id).join(', ')} ${wrong.length === 1 ? 'is' : 'are'} not in ${status}`, 409);
  const slots = tasks.map(t => t!.rank).sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) if (slots[i]! <= slots[i - 1]!) slots[i] = slots[i - 1]! + 0.001;
  const ranks: Record<string, number> = {};
  unique.forEach((id, i) => { ranks[id] = Math.round(slots[i]! * 1000) / 1000; });
  S.setRanks(p, ranks);
  kick(p);
  return { ok: true, ranks };
}

/**
 * Move the Backlog tasks that `id` (transitively) waits for to Ready, prerequisites first, so a person
 * unblocks a stuck card in one click. Only Backlog tasks move: a blocked or cancelled prerequisite is
 * reported (`stuck`), because deciding what to do with it is the person's. `by: 'system'` is the
 * `assisted` level doing the same thing on its own for a task a person already made Ready.
 */
export async function promotePrerequisites(project: string, id: string, by: 'person' | 'system' = 'person'): Promise<{ moved: string[]; stuck: Array<{ id: string; status: TaskStatus }> }> {
  const p = path.resolve(project);
  const f = S.load(p);
  const root = f.tasks.get(id);
  if (!root) throw new DeliveryError(`no task ${id} on this board`, 404);
  const order: string[] = [];
  const stuck: Array<{ id: string; status: TaskStatus }> = [];
  const seen = new Set<string>();
  const walk = (tid: string): void => {
    if (seen.has(tid)) return;
    seen.add(tid);
    const t = f.tasks.get(tid);
    if (!t) return;
    for (const d of t.dependsOn) {
      const dep = f.tasks.get(d);
      if (!dep || dep.status === 'merged') continue;
      walk(d);
      if (dep.status === 'backlog') { if (!order.includes(d)) order.push(d); }
      else if (dep.status === 'blocked' || dep.status === 'cancelled') stuck.push({ id: d, status: dep.status });
    }
  };
  walk(id);
  for (const tid of order) {
    S.patchTask(p, tid, { status: 'ready' }, [], by);
    S.logActivity(p, tid, 'promoted', by, by === 'person' ? `Moved to Ready so "${clip(root.title, 50)}" can start.` : `Moved to Ready by the board (assisted): "${clip(root.title, 50)}" waits for it.`);
    if (by === 'system') audit(p, 'auto-promote', tid, autonomyOf(S.load(p)), 'ok', `prerequisite of ${id}`);
  }
  if (order.length > 0) kick(p);
  return { moved: order, stuck };
}

// ── board settings ───────────────────────────────────────────────────────

export interface SettingsPatch {
  autonomy?: unknown; wip?: unknown; budgetUsdPerDay?: unknown; pauseAfterFailures?: unknown; views?: unknown; maxParallel?: unknown; autoLandLowRisk?: unknown;
}

/** The autonomy in force for a board: its setting lowered to the organisation's ceiling. */
export function autonomyOf(f: S.Folded): Autonomy {
  let cap: Autonomy | undefined;
  try { cap = deliveryAutonomyCap(); } catch { cap = undefined; }
  return effectiveAutonomy(f.settings.autonomy, cap);
}

/**
 * Whether applying this patch is an act only a person may do: it widens what the board may do or spend
 * without one (a level above manual, a higher daily budget, more agents at once, a longer failure streak).
 * Narrowing is always allowed with only the token - refusing to spend is safe.
 */
export function settingsNeedPerson(project: string, patch: SettingsPatch): boolean {
  const f = S.load(path.resolve(project));
  const st = f.settings;
  if (patch.autonomy !== undefined && isAutonomy(patch.autonomy) && autonomyRank(patch.autonomy) > autonomyRank(st.autonomy)) return true;
  if (patch.budgetUsdPerDay !== undefined && Number(patch.budgetUsdPerDay) > st.budgetUsdPerDay) return true;
  if (patch.maxParallel !== undefined && S.clampParallel(patch.maxParallel) > st.maxParallel) return true;
  if (patch.pauseAfterFailures !== undefined && Number(patch.pauseAfterFailures) > st.pauseAfterFailures) return true;
  if (patch.autoLandLowRisk === true && !st.autoLandLowRisk) return true;
  return false;
}

/**
 * Change the board's settings. The caller (the route) has already asked for a person where
 * `settingsNeedPerson` says one is needed; this re-checks the two facts that must hold whoever calls it:
 * a value is within its range, and the autonomy never exceeds the organisation's ceiling.
 */
export async function updateSettings(project: string, patch: SettingsPatch, by: 'person' | 'token' = 'person'): Promise<BoardState> {
  const p = await ensureBoard(project);
  const before = S.load(p).settings;
  const set: Partial<S.BoardSettings> = {};
  if (patch.autonomy !== undefined) {
    if (!isAutonomy(patch.autonomy)) throw new DeliveryError('autonomy must be manual, assisted, autonomous or full');
    let cap: Autonomy | undefined;
    try { cap = deliveryAutonomyCap(); } catch { cap = undefined; }
    if (cap && autonomyRank(patch.autonomy) > autonomyRank(cap)) {
      throw new DeliveryError(`Your organisation allows boards up to the ${cap} level, so ${patch.autonomy} cannot be set.`, 403, 'policy');
    }
    if (by !== 'person' && autonomyRank(patch.autonomy) > autonomyRank(before.autonomy)) throw new DeliveryError('Raising a board\'s autonomy needs a person.', 403, 'human-required');
    set.autonomy = patch.autonomy;
  }
  if (patch.wip !== undefined) {
    const w = patch.wip as { running?: unknown; review?: unknown } | null;
    if (!w || typeof w !== 'object') throw new DeliveryError('wip must be an object like { "running": 2, "review": 5 }');
    for (const k of ['running', 'review'] as const) {
      const v = w[k];
      if (v !== undefined && v !== null && !(Number.isInteger(Number(v)) && Number(v) >= 1)) throw new DeliveryError(`wip.${k} must be a whole number of at least 1`);
    }
    set.wip = { ...(w.running ? { running: Number(w.running) } : {}), ...(w.review ? { review: Number(w.review) } : {}) };
  }
  if (patch.budgetUsdPerDay !== undefined) {
    const n = Number(patch.budgetUsdPerDay);
    if (!(Number.isFinite(n) && n > 0 && n <= 100_000)) throw new DeliveryError('budgetUsdPerDay must be a positive amount of dollars');
    if (by !== 'person' && n > before.budgetUsdPerDay) throw new DeliveryError('Raising the daily budget needs a person.', 403, 'human-required');
    set.budgetUsdPerDay = n;
  }
  if (patch.pauseAfterFailures !== undefined) {
    const n = Number(patch.pauseAfterFailures);
    if (!(Number.isInteger(n) && n >= 1 && n <= 50)) throw new DeliveryError('pauseAfterFailures must be a whole number from 1 to 50');
    if (by !== 'person' && n > before.pauseAfterFailures) throw new DeliveryError('Allowing more failures before the board pauses needs a person.', 403, 'human-required');
    set.pauseAfterFailures = n;
  }
  if (patch.views !== undefined) {
    if (!Array.isArray(patch.views)) throw new DeliveryError('views must be a list of { name, filter }');
    set.views = S.cleanViews(patch.views);
  }
  if (patch.maxParallel !== undefined) {
    const n = Number(patch.maxParallel);
    if (!(Number.isFinite(n) && n >= 1)) throw new DeliveryError('maxParallel must be a number from 1 to 4');
    if (by !== 'person' && S.clampParallel(n) > before.maxParallel) throw new DeliveryError('Raising how many agents run at once needs a person.', 403, 'human-required');
    set.maxParallel = S.clampParallel(n);
  }
  if (patch.autoLandLowRisk !== undefined) set.autoLandLowRisk = patch.autoLandLowRisk === true;
  if (Object.keys(set).length === 0) return S.boardState(p);
  S.setSettings(p, set);
  if (set.autonomy !== undefined && set.autonomy !== before.autonomy) {
    S.logActivity(p, undefined, 'autonomy', by === 'person' ? 'person' : 'system', `Autonomy set to ${set.autonomy} (was ${before.autonomy}).`);
    audit(p, 'autonomy.set', undefined, set.autonomy, 'ok', `from ${before.autonomy}`, by === 'person' ? 'person' : 'token');
  }
  kick(p);
  return S.boardState(p);
}

/** One line in the audit log for a decision the board made, or a change to what it may decide. */
function audit(project: string, action: string, task: string | undefined, level: Autonomy, outcome: 'ok' | 'error' | 'denied', detail: string, decidedBy?: string): void {
  appendOwnAuditEvent({
    at: Date.now(), kind: 'delivery', action, project, ...(task ? { task } : {}), autonomy: level,
    decidedBy: decidedBy ?? `engine:${level}`, outcome, detail: detail.slice(0, 280),
  });
}

async function releaseRun(project: string, id: string, status: TaskStatus, comment?: string): Promise<void> {
  const h = handles.get(hk(project, id));
  if (h) { try { runner().stop(h.runId); } catch { /* already over */ } handles.delete(hk(project, id)); }
  S.queueDrop(project, id);
  if (comment) S.addComment(project, id, 'agent', comment);
  S.patchTask(project, id, { status }, ['claim', 'needs']);
}

async function cancelTask(project: string, id: string): Promise<void> {
  const open = S.getTask(project, id)?.pr;
  await releaseRun(project, id, 'cancelled');
  if (open && open.state === 'open') S.addComment(project, id, 'agent', `Cancelled. The pull request ${open.url} was left open on the remote; close it there if it is no longer wanted.`);
  const kept = await removeWorktreeAndBranch(project, id);
  if (kept.keptBranch) S.addComment(project, id, 'agent', `Cancelled. Branch ${kept.keptBranch} still holds unmerged commits and was kept; delete it with git branch -D ${kept.keptBranch} when you no longer need them.`);
}

// ── git plumbing for a task ──────────────────────────────────────────────

async function repoOf(project: string): Promise<string> {
  const root = await G.repoRootOf(project);
  if (!root) throw new DeliveryError('this project is not a git repository, so tasks cannot be isolated on branches', 409);
  return root;
}

/** The project's folder inside the task's worktree (the same relative path as in the repository). */
function insideWorktree(repo: string, project: string, wt: string): string {
  const rel = path.relative(repo, path.resolve(project));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(wt, rel) : wt;
}

/** Remove a task's worktree and, when its work is safely on the trunk (or empty), its branch. Never discards unmerged commits. */
async function removeWorktreeAndBranch(project: string, id: string, opts: { mergedHead?: string } = {}): Promise<{ keptBranch?: string }> {
  const t = S.getTask(project, id);
  const wt = t?.worktree ?? worktreePath(project, id);
  const branch = t?.branch ?? branchOf(id);
  let repo: string;
  try { repo = await repoOf(project); } catch { return {}; }
  if (fs.existsSync(wt)) {
    unlinkDeps(wt, insideWorktree(repo, project, wt));
    // Cancelling must not throw away work in progress: it goes onto the branch (kept below) first.
    if (t?.status === 'cancelled') await G.commitAll(wt, `chore: work in progress when task ${id} was cancelled`, looksLikeSecretPath);
    let r = await G.worktreeRemove(repo, wt);
    if (!r.ok && t?.status === 'cancelled') r = await G.worktreeRemove(repo, wt, true);
    if (!r.ok) { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* busy: the sweep tries again */ } }
  }
  await G.worktreePrune(repo);
  if (!(await G.branchExists(repo, branch))) return {};
  const trunk = S.load(project).settings.trunk;
  const merged = await G.git(['merge-base', '--is-ancestor', branch, G.headRef(trunk)], repo);
  if (merged.ok) { await G.branchDelete(repo, branch, true); return {}; }
  // A squash or rebase merge on the remote leaves the branch looking unmerged here; if its tip is exactly what the remote merged, nothing is lost.
  if (opts.mergedHead && (await G.revParse(repo, branch)) === opts.mergedHead) { await G.branchDelete(repo, branch, true); return {}; }
  return { keptBranch: branch };
}

// ── the dispatcher ───────────────────────────────────────────────────────

/** Ask the timer to look at this project soon (cheap; the timer is shared). */
function kick(project: string): void {
  active.add(path.resolve(project));
  ensureTimer();
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    for (const p of [...active]) void tick(p).catch(() => undefined);
  }, TICK_MS);
  timer.unref?.();
}

function runningClaims(project: string): Task[] {
  return [...S.load(project).tasks.values()].filter(t => t.status === 'running' && t.claim);
}

const depsMerged = (f: S.Folded, t: Task): boolean => t.dependsOn.every(d => f.tasks.get(d)?.status === 'merged');

/** One pass: collect finished runs, renew leases, then (if running) start what may start. Serialised per project. */
export function tick(project: string): Promise<void> {
  const p = path.resolve(project);
  return serial(p, 'tick', async () => {
    await collect(p);
    const f = S.load(p);
    if (f.dispatcher === 'running') {
      // The hard limits come first and can pause the board; nothing below acts on a paused one.
      if (!(await enforceLimits(p))) {
        await closeEpics(p);
        await startReady(p);
        await autoLandReviewed(p);
      }
    }
    // Submitted work the queue has not picked up (a restart in between): pick it up.
    for (const id of S.load(p).queue) {
      const t = S.getTask(p, id);
      if (t && t.status === 'running' && !t.claim && !preparing.has(hk(p, id))) queuePrepare(p, id);
    }
    const g = S.load(p);
    const busy = g.dispatcher === 'running' || handles.size > 0 || preparing.size > 0
      || [...g.tasks.values()].some(t => t.status === 'running');
    if (!busy) active.delete(p);
  });
}

async function collect(project: string): Promise<void> {
  const now = config.now();
  for (const t of runningClaims(project)) {
    const key = hk(project, t.id);
    const h = handles.get(key);
    if (!h) {
      // No live run in this process: its lease decides. A restart leaves leases to run out (ADR 0038).
      if (Date.parse(t.claim!.leaseUntil) < now) {
        S.patchTask(project, t.id, { status: 'ready' }, ['claim', 'needs']);
        S.addComment(project, t.id, 'agent', 'The run was lost (its lease ran out, usually a restart). The task is ready again; its branch and commits were kept.');
      }
      continue;
    }
    const poll = runner().poll(h.runId);
    const cost = Math.round((h.costBase + poll.costUsd) * 10_000) / 10_000;
    if (cost > (t.costUsd ?? 0) + 0.0005) S.patchTask(project, t.id, { costUsd: cost });
    if (poll.state === 'running') {
      if (poll.lastActivityAt > h.lastActivityAt) {
        h.lastActivityAt = poll.lastActivityAt;
        S.patchTask(project, t.id, { claim: { ...t.claim!, leaseUntil: iso(now + LEASE_MS) } });
      }
      syncNeed(project, t, poll.need);
      noteActivity(project, t, h, poll);
      await refreshTouches(project, t.id);
      continue;
    }
    handles.delete(key);
    if (S.setLive(project, t.id, undefined)) S.notifyChange(project);
    await onRunEnded(project, t.id, poll, h);
  }
  // A run that is still winding down after it submitted: keep its cost current, then forget it.
  for (const [key, h] of [...handles]) {
    if (!key.startsWith(`${projectKey(project)}/`)) continue;
    const id = key.slice(key.indexOf('/') + 1);
    const t = S.getTask(project, id);
    if (t && t.status === 'running' && t.claim) continue;
    const poll = runner().poll(h.runId);
    const cost = Math.round((h.costBase + poll.costUsd) * 10_000) / 10_000;
    if (t && cost > (t.costUsd ?? 0) + 0.0005) S.patchTask(project, id, { costUsd: cost });
    if (poll.state !== 'running') handles.delete(key);
  }
}

/**
 * Show what a running task is doing (in memory, pushed to the watching clients) and keep the milestones
 * worth remembering (an edit, a check run, a commit) in its history. The run's own session is where this
 * comes from (`activity.ts`); the model is never asked, and the journal gets a line per milestone, not per step.
 */
function noteActivity(project: string, t: Task, h: Handle, poll: import('./runner.js').RunPoll): void {
  const a = poll.activity;
  if (!a) return;
  const changed = S.setLive(project, t.id, { summary: a.summary, at: iso(a.at), ...(a.tokens ? { tokens: a.tokens } : {}) });
  if (changed) S.notifyChange(project);
  let kept = 0;
  for (const m of a.milestones ?? []) {
    if (kept >= 5) break;
    if (m.kind === 'edit') {
      if (config.now() - h.lastEditLogAt < EDIT_LOG_EVERY_MS) continue;
      h.lastEditLogAt = config.now();
    }
    S.logActivity(project, t.id, m.kind, 'agent', m.text);
    kept++;
  }
}

const EDIT_LOG_EVERY_MS = 20_000;

/**
 * The limits that hold at every autonomy level, checked on each tick while the dispatcher runs. Returns true
 * when the board was paused (so nothing else this tick starts or lands). A pause says why, in the journal and
 * to the person, and is lifted only by a person starting the dispatcher again - that is the kill switch's twin.
 *  - the day's budget: the spend of every task today, from the journal; running tasks are stopped too, because
 *    "no more today" that lets four agents finish their tasks is a suggestion;
 *  - a failure streak: N tasks in a row that failed or were sent back by the engine, a sign that something about
 *    the project, the checks or the model is wrong and more runs would only spend more on it.
 */
async function enforceLimits(project: string): Promise<boolean> {
  const f = S.load(project);
  const level = autonomyOf(f);
  const spent = f.spend.get(S.dayKey(config.now())) ?? 0;
  if (f.settings.budgetUsdPerDay > 0 && spent >= f.settings.budgetUsdPerDay) {
    const why = `the daily budget of $${f.settings.budgetUsdPerDay.toFixed(2)} is spent ($${spent.toFixed(2)} today)`;
    for (const t of runningClaims(project)) {
      const h = handles.get(hk(project, t.id));
      if (h) { h.stopReason = `the daily budget of $${f.settings.budgetUsdPerDay.toFixed(2)} was reached`; try { runner().stop(h.runId); } catch { /* already over */ } }
    }
    pauseBoard(project, why, level, 'budget');
    return true;
  }
  if (f.failStreak >= f.settings.pauseAfterFailures) {
    pauseBoard(project, `${f.failStreak} tasks in a row failed or were sent back (the limit is ${f.settings.pauseAfterFailures}); look at them before more runs spend on the same problem`, level, 'failures');
    return true;
  }
  return false;
}

function pauseBoard(project: string, why: string, level: Autonomy, kind: string): void {
  S.setDispatcher(project, 'paused', why);
  audit(project, 'auto-pause', undefined, level, 'ok', `${kind}: ${why}`);
  try {
    pushNotification({ title: 'Delivery paused itself', body: `${path.basename(project)}: ${why}`.slice(0, 300), level: 'warning', sourceId: `delivery:${projectKey(project)}:pause` });
  } catch { /* a notification must never break the board */ }
  kick(project);
}

/** An epic whose children have all merged is done: it merges itself (nothing to land, so no person is needed). */
async function closeEpics(project: string): Promise<void> {
  const f = S.load(project);
  const kids = new Map<string, Task[]>();
  for (const t of f.tasks.values()) if (t.parentId && t.status !== 'cancelled') kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
  for (const [pid, list] of kids) {
    const epic = f.tasks.get(pid);
    if (!epic || epic.status === 'merged' || epic.status === 'cancelled' || epic.claim) continue;
    if (list.length > 0 && list.every(c => c.status === 'merged')) {
      S.patchTask(project, pid, { status: 'merged' }, ['claim', 'needs']);
      S.logActivity(project, pid, 'landed', 'system', `All ${list.length} child task${list.length === 1 ? '' : 's'} merged, so this epic is done.`);
    }
  }
}

/**
 * Put what a run is waiting for on its task, and take it off when a person has answered.
 * Journaled (not just shown) so every client reads the same fold and a restart still knows
 * the task was waiting; the answer itself travels by the chat's own routes.
 */
function syncNeed(project: string, t: Task, need: import('./runner.js').RunPoll['need']): void {
  const cur = t.needs;
  if (!need) {
    if (!cur) return;
    S.patchTask(project, t.id, {}, ['needs']);
    S.addComment(project, t.id, 'agent', 'A person responded; the run is going on.');
    return;
  }
  if (cur && cur.kind === need.kind && cur.ref === need.ref && cur.prompt === need.prompt) return;
  const next: TaskNeed = {
    kind: need.kind, prompt: need.prompt,
    ...(need.detail ? { detail: need.detail } : {}), ...(need.ref ? { ref: need.ref } : {}), ...(need.tool ? { tool: need.tool } : {}),
    since: need.since ?? iso(config.now()),
  };
  S.patchTask(project, t.id, { needs: next });
  S.addComment(project, t.id, 'agent', need.detail ? `Waiting for you: ${need.prompt}\n${need.detail}` : `Waiting for you: ${need.prompt}`);
  notify('needs', project, t, need.prompt);
}

/**
 * Tell the person's hooks (and any client watching notifications) that a task needs them,
 * is ready, landed or failed. The same plumbing the background agents use; the desktop's
 * native notification is its own watcher of `attention()`.
 */
function notify(kind: 'needs' | 'review' | 'landed' | 'failed', project: string, t: Task, detail?: string): void {
  const title = kind === 'needs' ? `Task needs you: ${t.title}` : kind === 'review' ? `Ready for review: ${t.title}`
    : kind === 'landed' ? `Landed: ${t.title}` : `Task failed: ${t.title}`;
  try {
    pushNotification({
      title, body: (detail ?? `${path.basename(project)} · delivery`).slice(0, 300),
      level: kind === 'failed' ? 'error' : kind === 'needs' ? 'warning' : kind === 'landed' ? 'success' : 'info',
      sourceId: `delivery:${t.id}`,
    });
  } catch { /* a notification must never break the board */ }
}

/** Replace a running task's prediction with what its branch actually changed. */
async function refreshTouches(project: string, id: string): Promise<void> {
  const t = S.getTask(project, id);
  if (!t?.worktree || !fs.existsSync(t.worktree)) return;
  const trunk = S.load(project).settings.trunk;
  const base = await G.mergeBase(t.worktree, G.headRef(trunk), 'HEAD');
  if (!base) return;
  // The same set the live diff shows: committed on the branch plus what is edited or new in the worktree, minus AICO's own files.
  const files = await changeFiles(t.worktree, base);
  const cur = t.touches;
  // The Changes tab's number is the real diff, never the prediction (a task with no run yet says 0).
  if (files.length !== (t.changeCount ?? 0)) S.patchTask(project, id, { changeCount: files.length });
  if (files.length === 0) return;
  if (cur && !cur.predicted && cur.files.length === files.length && files.every(f => cur.files.includes(f))) return;
  S.patchTask(project, id, { touches: actualTouches(files, cur?.symbols ?? []) });
}

/** Files a task has changed against `base`: committed plus uncommitted and new, without AICO's runtime files. */
async function changeFiles(wt: string, base: string): Promise<string[]> {
  const committed = (await G.changedFiles(wt, base)).map(c => c.path);
  const dirty = (await G.dirtyPaths(wt)).filter(f => f !== 'node_modules' && !f.startsWith('node_modules/'));
  return [...new Set([...committed, ...dirty])].filter(f => !isRuntimePath(f));
}

async function onRunEnded(project: string, id: string, poll: import('./runner.js').RunPoll, h?: Handle): Promise<void> {
  const t = S.getTask(project, id);
  if (!t || t.status !== 'running' || !t.claim) return;
  if (poll.ok === false) {
    const why = h?.stopReason ?? poll.error;
    await releaseRun(project, id, 'blocked',
      `The run ended without finishing${why ? `: ${why.slice(0, 400)}` : ' (it was stopped, usually by its spend or time limit)'}. `
      + 'Its branch and commits are kept. Set the task to ready to run it again.');
    S.logActivity(project, id, 'failed', 'system', `The run ended without finishing${why ? `: ${why.slice(0, 200)}` : ''}.`);
    notify('failed', project, t, why);
    return;
  }
  // It finished its work but did not call submit: finishing with commits is a submission.
  const r = await submitTask(project, id, { summary: poll.result ? `(the agent's final answer) ${poll.result.slice(0, 1500)}` : undefined, implicit: true });
  if (!r.ok) {
    notify('failed', project, t, r.reason);
    S.logActivity(project, id, 'failed', 'system', `The run finished but there was nothing to review: ${r.reason}`.slice(0, 300));
    await releaseRun(project, id, 'blocked', `The run finished but there was nothing to review: ${r.reason}${poll.result ? `\nIts answer: ${poll.result.slice(0, 1200)}` : ''}`);
  }
}

async function startReady(project: string): Promise<void> {
  let f = S.load(project);
  const level = autonomyOf(f);
  const powers = powersOf(level);
  // The levels above manual do the routine a person would otherwise do by hand, before the dispatcher looks for work.
  if (powers.promotePrerequisites) {
    for (const t of [...f.tasks.values()].filter(x => x.status === 'ready' && !x.claim && x.dependsOn.length > 0)) {
      const moved = await promotePrerequisites(project, t.id, 'system').catch(() => undefined);
      if (moved && moved.moved.length > 0) f = S.load(project);
    }
  }
  if (powers.pullBacklog) await pullBacklog(project, level);
  f = S.load(project);
  const max = runningCeiling(S.clampParallel(f.settings.maxParallel), f.settings.wip);
  let running = runningClaims(project);
  const reviewCount = (): number => awaitingReview(S.load(project).tasks.values());
  const epics = new Set([...f.tasks.values()].filter(t => t.parentId).map(t => t.parentId!));
  const candidates = [...f.tasks.values()]
    .filter(t => (t.status === 'ready' || t.status === 'changes') && !t.claim && depsMerged(f, t) && mayStartInMode(f.scrum, t) && !epics.has(t.id))
    .sort((a, b) => a.rank - b.rank || a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  for (const t of candidates) {
    if (running.length >= max) break;
    // The reviewer is the bottleneck: work that nobody has looked at yet is not made faster by starting more of it.
    if (f.settings.wip.review && reviewCount() >= f.settings.wip.review) break;
    if (reworkRounds(t) > MAX_REWORK_ROUNDS) {
      await releaseRun(project, t.id, 'blocked', `This task has bounced ${MAX_REWORK_ROUNDS} times between conflicts, failing checks and changes. It needs a person to look at it.`);
      continue;
    }
    // Predict what it will touch; hold it while that overlaps a running task's files.
    let touches = t.touches;
    if (!touches) {
      touches = await predictTouches(project, t).catch(() => ({ files: [], symbols: [], predicted: true }));
      S.patchTask(project, t.id, { touches });
    }
    const clash = running.map(r => ({ r, file: overlap(touches, S.getTask(project, r.id)?.touches) })).find(x => x.file);
    if (clash) continue;
    const started = await startRun(project, t.id);
    if (started) running = runningClaims(project);
  }
}

/**
 * `autonomous` and above: when there is a free slot and nothing Ready is waiting for it, take the next
 * Backlog tasks into Ready - the highest in the board's order (rank, then priority) whose prerequisites are
 * merged, that belong to the active sprint in Scrum mode, and that do not touch the same files as work already
 * in flight. This is the one place the engine decides what to spend on next; a person set the level, started
 * the dispatcher, and can pause it at any moment.
 */
async function pullBacklog(project: string, level: Autonomy): Promise<void> {
  const f = S.load(project);
  const ceiling = runningCeiling(S.clampParallel(f.settings.maxParallel), f.settings.wip);
  const tasks = [...f.tasks.values()];
  const inFlight = tasks.filter(t => t.status === 'running' || ((t.status === 'ready' || t.status === 'changes') && !t.claim));
  let free = ceiling - inFlight.length;
  if (free <= 0) return;
  if (f.settings.wip.review && awaitingReview(tasks) >= f.settings.wip.review) return;
  const sprint = f.scrum.mode === 'scrum' ? [...f.scrum.sprints.values()].find(x => x.status === 'active') : undefined;
  if (f.scrum.mode === 'scrum' && !sprint) return;
  const epics = new Set(tasks.filter(t => t.parentId).map(t => t.parentId!));
  const candidates = tasks
    .filter(t => t.status === 'backlog' && !epics.has(t.id) && depsMerged(f, t) && (!sprint || t.sprintId === sprint.id))
    .sort((a, b) => a.rank - b.rank || a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  const claimed = inFlight.map(t => t.touches).filter((x): x is NonNullable<Task['touches']> => Boolean(x));
  for (const t of candidates) {
    if (free <= 0) break;
    let touches = t.touches;
    if (!touches) {
      touches = await predictTouches(project, t).catch(() => ({ files: [], symbols: [], predicted: true }));
      S.patchTask(project, t.id, { touches });
    }
    if (claimed.some(c => overlap(touches, c))) continue;
    S.patchTask(project, t.id, { status: 'ready' }, [], 'system');
    S.logActivity(project, t.id, 'auto-start', 'system', `Pulled into Ready by the board (${level}): the next task in its order, with a free agent slot.`);
    audit(project, 'auto-start', t.id, level, 'ok', 'pulled the next backlog task into Ready');
    claimed.push(touches);
    free--;
  }
}

/** Comments the engine wrote after a conflict or red check, counted so a loop ends in a person. */
function reworkRounds(t: Task): number {
  return (t.review?.comments ?? []).filter(c => c.by === 'agent' && /^(Rebase conflict|Checks failed)/.test(c.text)).length;
}

async function startRun(project: string, id: string): Promise<boolean> {
  const f = S.load(project);
  const t = S.getTask(project, id)!;
  let repo: string;
  try { repo = await repoOf(project); } catch (e) {
    S.patchTask(project, id, { status: 'blocked' });
    S.addComment(project, id, 'agent', (e as Error).message);
    return false;
  }
  const trunk = f.settings.trunk;
  const wt = worktreePath(project, id);
  const branch = branchOf(id);
  // A task's spend is the sum of its runs. One that has used its whole allowance is not started again on the board's say-so.
  const allowance = config.budgetUsd();
  const spentBefore = t.costUsd ?? 0;
  if (allowance > 0 && spentBefore >= allowance) {
    S.patchTask(project, id, { status: 'blocked' });
    S.addComment(project, id, 'agent', `This task has already spent $${spentBefore.toFixed(2)} of its $${allowance.toFixed(2)} budget over its runs, so it was not started again. Raise the per-task limit (safetyLimits.maxCostPerSubagent) or split the task, then set it to ready.`);
    S.logActivity(project, id, 'failed', 'system', `Per-task budget spent ($${spentBefore.toFixed(2)} of $${allowance.toFixed(2)}).`);
    return false;
  }
  if (!fs.existsSync(wt)) {
    const made = await G.worktreeAdd(repo, wt, branch, G.headRef(trunk));
    if (!made.ok) {
      S.patchTask(project, id, { status: 'blocked' });
      S.addComment(project, id, 'agent', `Could not create the worktree: ${(made.err || made.out).trim().slice(0, 400)}`);
      return false;
    }
    // A fresh worktree has the tracked files and nothing else: give it what the stack needs (env.ts).
    const cfg = deliveryConfig(project);
    const prepared = await prepareWorktree({
      repo, projectDir: path.resolve(project), wt, workdir: insideWorktree(repo, project, wt),
      setup: cfg.worktreeSetup,
    });
    if (cfg.untrusted) prepared.notes.push(`This project's own settings define a Delivery command that no person has approved, so it was not used. ${cfg.untrusted}`);
    if (prepared.notes.length > 0) S.addComment(project, id, 'agent', `Environment: ${prepared.notes.join(' ')}`);
    if (prepared.setupFailure) {
      S.patchTask(project, id, { status: 'blocked', branch, worktree: wt });
      S.addComment(project, id, 'agent', `The run was not started: ${prepared.setupFailure}. Fix the setup (or the project's install), then set the task to ready.`);
      return false;
    }
  }
  // A second run on the same worktree would race the first: stop any old one.
  const old = handles.get(hk(project, id));
  if (old) { try { runner().stop(old.runId); } catch { /* over */ } handles.delete(hk(project, id)); }

  const fresh = { ...t, branch, worktree: wt };
  const prompt = runPrompt(fresh, trunk, { rework: t.status === 'changes' });
  let runId: string;
  try {
    runId = runner().start({
      taskId: id, title: t.title, prompt, cwd: insideWorktree(repo, project, wt),
      budgetUsd: allowance > 0 ? Math.max(0.01, allowance - spentBefore) : allowance, deadlineMs: TASK_DEADLINE_MS,
    });
  } catch (e) {
    S.patchTask(project, id, { status: 'blocked', branch, worktree: wt });
    S.addComment(project, id, 'agent', `Could not start the run: ${(e as Error).message}`);
    return false;
  }
  const now = config.now();
  handles.set(hk(project, id), { runId, project, lastActivityAt: 0, costBase: spentBefore, lastEditLogAt: 0 });
  S.markStart(project, id, runId);
  // The chat the run is held in, when the runner has one: what the card's "Session" opens.
  const sessionId = runner().poll(runId).sessionId;
  // Who is doing it: the first free agent slot, unless a person already took the card (their name stays; the slot is still in use).
  const slot = pickSlot(project, id);
  S.patchTask(project, id, {
    status: 'running', branch, worktree: wt,
    claim: { runId, ...(sessionId ? { sessionId } : {}), leaseUntil: iso(now + LEASE_MS) },
    ...(sessionId ? { sessionId } : {}),
    ...(!t.assignee || t.assignee.kind === 'agent' ? { assignee: { kind: 'agent' as const, name: slot } } : {}),
  }, ['needs']);
  S.logActivity(project, id, 'started', 'system', `${t.status === 'changes' ? 'Resumed' : 'Started'} by ${slot}${sessionId ? '' : ' (a background agent: no chat to open)'}.`);
  return true;
}

/** The first agent slot no running task holds. */
function pickSlot(project: string, forId: string): string {
  const taken = new Set([...S.load(project).tasks.values()].filter(t => t.id !== forId && t.status === 'running' && t.claim && t.assignee?.kind === 'agent').map(t => t.assignee!.name));
  return AGENT_SLOTS.find(n => !taken.has(n)) ?? AGENT_SLOTS[AGENT_SLOTS.length - 1]!;
}

// ── submit and the merge queue ───────────────────────────────────────────

export interface SubmitResult { ok: boolean; reason?: string }

/**
 * A run's work is done: commit what is left, record what it touched, and put the
 * task in the merge queue. Only a task that is running with a claim can be
 * submitted; whether the caller IS that task's run is the tool's check (it is
 * made from the run's own directory), not a thing a model can assert.
 */
export async function submitTask(project: string, id: string, opts: { summary?: string | undefined; implicit?: boolean } = {}): Promise<SubmitResult> {
  const t = S.getTask(project, id);
  if (!t) return { ok: false, reason: `no task ${id}` };
  if (t.status !== 'running' || !t.claim) return { ok: false, reason: `task ${id} is ${t.status}${t.claim ? '' : ' with no run'}; only a running task can be submitted` };
  const wt = t.worktree;
  if (!wt || !fs.existsSync(wt)) return { ok: false, reason: 'its worktree is gone' };
  const trunk = S.load(project).settings.trunk;
  // AICO's own runtime files are never part of a task's change (runtime-files.ts): not staged here, and taken out of any commit the agent made itself.
  const committed = await G.commitAll(wt, `chore: complete task ${id} - ${t.title.slice(0, 60)}`, looksLikeSecretPath, RUNTIME_EXCLUDES);
  if (committed.kept.length > 0) {
    S.addComment(project, id, 'agent', `Left uncommitted because they look like credentials: ${committed.kept.join(', ')}. They are not part of this change.`);
  }
  if (committed.error) return { ok: false, reason: `could not commit the remaining changes: ${committed.error}` };
  if (committed.committed) S.logActivity(project, id, 'commit', 'system', 'Committed the work that was left uncommitted.');
  const scrubbed = await scrubBranch(wt, trunk, id);
  if (scrubbed.error) return { ok: false, reason: `could not keep AICO's own files out of the change: ${scrubbed.error}` };
  if (scrubbed.removed.length > 0) S.addComment(project, id, 'agent', `Left out of this change because AICO writes them itself: ${scrubbed.removed.join(', ')}.`);
  const base = await G.mergeBase(wt, G.headRef(trunk), 'HEAD');
  if (!base || (await G.aheadCount(wt, base)) === 0) return { ok: false, reason: `the branch has no commits past ${trunk}; commit your work before submitting` };
  const files = (await G.changedFiles(wt, base)).map(c => c.path);
  if (files.length === 0) return { ok: false, reason: `the branch changes nothing against ${trunk}; there is nothing to review` };
  S.patchTask(project, id, { touches: actualTouches(files, t.touches?.symbols ?? []), changeCount: files.length }, ['claim', 'needs']);
  S.logActivity(project, id, 'submitted', 'agent', `Submitted ${files.length} changed file${files.length === 1 ? '' : 's'} for review${opts.implicit ? ' (the run finished without calling submit)' : ''}.`);
  if (opts.summary?.trim()) S.addComment(project, id, 'agent', `Submitted: ${opts.summary.trim().slice(0, 4000)}`);
  S.queuePush(project, id);
  queuePrepare(project, id);
  return { ok: true };
}

function queuePrepare(project: string, id: string): void {
  const key = hk(project, id);
  if (preparing.has(key)) return;
  preparing.add(key);
  kick(project);
  void serial(project, 'queue', () => prepare(project, id)).catch(async err => {
    const t = S.getTask(project, id);
    if (t && t.status === 'running') {
      S.queueDrop(project, id);
      S.patchTask(project, id, { status: 'blocked' });
      S.addComment(project, id, 'agent', `The merge queue failed on this task: ${(err as Error).message.slice(0, 400)}`);
    }
  }).finally(() => { preparing.delete(key); });
}

async function sendBack(project: string, id: string, text: string): Promise<void> {
  S.queueDrop(project, id);
  S.addComment(project, id, 'agent', text);
  S.patchTask(project, id, { status: 'changes' }, ['evidence', 'risk', 'claim', 'needs']);
  S.logActivity(project, id, 'sent-back', 'system', `Sent back for changes: ${text.split('\n')[0]!.slice(0, 200)}`);
  kick(project);
}

/** Rebase, check, review-prepare one submitted task. Always inside the queue lane: one at a time. */
async function prepare(project: string, id: string): Promise<void> {
  noAuto.delete(hk(project, id));   // a task coming back to review is a new chance for the board's own rule
  const t = S.getTask(project, id);
  if (!t || t.status !== 'running' || t.claim || !t.worktree) return;
  const repo = await repoOf(project);
  const outcome = await rebaseAndCheck(project, id, repo, t.worktree);
  if (!outcome.ok) { await sendBack(project, id, outcome.text); return; }
  const { trunkSha, tree, v } = outcome;

  const pack = await reviewPackage(project, id, outcome);
  S.recordBase(project, id, trunkSha, tree);
  S.patchTask(project, id, { status: 'review', ...pack, changeCount: pack.touches.files.length }, ['landingBlock']);
  S.logActivity(project, id, 'checks', 'system', v.none ? 'The project defines no checks to run.' : v.cached ? 'Checks were already green for this exact tree.' : `Checks passed (${v.results.length}).`);
  S.logActivity(project, id, 'review', 'system', `Ready for review: ${pack.risk.level} risk (${pack.risk.score}).`);
  const decision = autoDecisionFor(project, id);
  if (decision.ok) {
    try { await landNow(project, id, 'auto', decision); return; } catch (e) { noteAutoFailure(project, id, e); /* stays in review for a person */ }
  }
  notify('review', project, S.getTask(project, id)!, `${pack.risk.level} risk · ${firstLine(pack.evidence.summary)}`);
}

/** Whether the board may land this reviewed task by itself right now, and on whose rule. The legacy `autoLandLowRisk` switch keeps working as it always did. */
function autoDecisionFor(project: string, id: string): ReturnType<typeof autoLandDecision> & { autonomy: Autonomy; legacy?: boolean } {
  const f = S.load(project);
  const t = f.tasks.get(id);
  if (!t || t.status !== 'review' || !t.risk) return { ok: false, reason: 'not in review with a risk score', autonomy: 'manual' };
  const tree = f.base.get(id)?.tree;
  const green = Boolean(tree && f.checks.get(tree)?.ok === true);
  const pr = prMode(project);
  if (noAuto.has(hk(project, id))) return { ok: false, reason: 'an automatic landing was already tried and needs a person', autonomy: autonomyOf(f) };
  // The dispatcher being on is the person's yes to spend; the levels above manual act only while it is.
  const level: Autonomy = f.dispatcher === 'running' ? autonomyOf(f) : 'manual';
  const by = autoLandDecision({ level, risk: t.risk, checksGreen: green, prMode: pr });
  if (by.ok) return { ...by, autonomy: level };
  if (f.settings.autoLandLowRisk && t.risk.level === 'low' && green && !pr) {
    return { ok: true, reason: 'low risk and its checks were green (the board setting autoLandLowRisk)', autonomy: level, legacy: true };
  }
  return { ...by, autonomy: level };
}

function noteAutoFailure(project: string, id: string, e: unknown): void {
  noAuto.add(hk(project, id));
  const msg = e instanceof Error ? e.message : String(e);
  S.logActivity(project, id, 'needs-you', 'system', `An automatic landing did not go through, so it waits for you: ${msg.slice(0, 240)}`);
}

/** Tasks already in review that the board may now land by itself (a level was raised, or a landing earlier in the queue changed nothing for them). One at a time through the queue lane. */
async function autoLandReviewed(project: string): Promise<void> {
  const f = S.load(project);
  if (autonomyOf(f) === 'manual' || f.dispatcher !== 'running') return;
  const reviewed = [...f.tasks.values()].filter(t => t.status === 'review' && !preparing.has(hk(project, t.id))).sort((a, b) => a.rank - b.rank || a.priority - b.priority);
  for (const t of reviewed) {
    const d = autoDecisionFor(project, t.id);
    if (!d.ok) continue;
    try { await land(project, t.id, 'auto', d); } catch (e) { noteAutoFailure(project, t.id, e); }
    if (S.load(project).dispatcher !== 'running') return;
  }
}

type Prepared =
  | { ok: false; text: string }
  | { ok: true; trunkSha: string; tree: string; v: import('./verify.js').VerifyOutcome; base: string; trunk: string };

/** Rebase onto the current trunk and run the checks on the result. */
async function rebaseAndCheck(project: string, id: string, repo: string, wt: string): Promise<Prepared> {
  const trunk = S.load(project).settings.trunk;
  // PR mode: start from what the team has, and once the branch is on the remote absorb a moved
  // trunk by merging it in (a rebase would rewrite pushed history and need a force-push).
  if (prMode(project)) { try { await landing?.beforePrepare?.(project); } catch { /* the remote being unreachable must not stop a local review */ } }
  const pushed = Boolean(S.getTask(project, id)?.pr);
  // An agent can commit AICO's own files again while reworking; they are taken out before anything is rebased.
  const clean = await scrubBranch(wt, trunk, id);
  if (clean.error) return { ok: false, text: `Checks failed: could not keep AICO's own files out of the change (${clean.error}).` };
  const rb = pushed ? await G.mergeTrunkInto(wt, trunk) : await G.rebaseOnto(wt, trunk);
  if (!rb.ok) {
    return { ok: false, text: pushed
      ? `Rebase conflict: the pull request's branch no longer merges cleanly with ${trunk}${rb.conflicts.length > 0 ? ` in: ${rb.conflicts.join(', ')}` : ''}. Merge ${trunk} into this branch (git merge ${trunk}; do NOT rebase, the branch is already on the remote), resolve the conflicts keeping both sides' intent, run the checks and submit again.`
      : rb.conflicts.length > 0
        ? `Rebase conflict against ${trunk} in: ${rb.conflicts.join(', ')}. Rebase this branch onto ${trunk} (git rebase ${trunk}), resolve the conflicts keeping both sides' intent, run the checks and submit again.`
        : `Rebase conflict against ${trunk}: ${rb.message || 'git could not rebase the branch'}. Fix the branch so it rebases cleanly and submit again.` };
  }
  const tree = await G.treeOf(wt);
  const trunkSha = await G.revParse(repo, G.headRef(trunk));
  if (!tree || !trunkSha) return { ok: false, text: `Checks failed: could not read the rebased tree or ${trunk}.` };
  // A task's diff must hold only what the agent changed. After a rebase the branch sits on the trunk's tip; if it does not,
  // everything the trunk gained since would read as the task's deletions, so it is not reviewed at all.
  if (!(await G.isAncestor(wt, trunkSha, 'HEAD'))) return { ok: false, text: `Checks failed: the branch is not based on the current ${trunk} after rebasing, so its diff would include changes that are not its own. Rebase it onto ${trunk} (git rebase ${trunk}) and submit again.` };
  const v = await verifyTree(project, insideWorktree(repo, project, wt), tree);
  if (!v.ok) {
    const f = v.failed!;
    return { ok: false, text: `Checks failed: ${f.name} (${f.command}) did not pass on the branch rebased onto ${trunk}.\n${f.tail ?? ''}`.slice(0, 6000) };
  }
  const base = (await G.mergeBase(wt, G.headRef(trunk), 'HEAD')) ?? trunkSha;
  return { ok: true, trunkSha, tree, v, base, trunk };
}

/** The evidence report, risk score and actual touches for a prepared branch. */
async function reviewPackage(project: string, id: string, o: Extract<Prepared, { ok: true }>): Promise<{ evidence: NonNullable<Task['evidence']>; risk: NonNullable<Task['risk']>; touches: NonNullable<Task['touches']> }> {
  const t = S.getTask(project, id)!;
  const wt = t.worktree!;
  const stats = await numstat(wt, o.base);
  const risk = await assessRisk({ project, worktree: wt, base: o.base, stats });
  const files = (await G.changedFiles(wt, o.base)).map(c => c.path).filter(f => !isRuntimePath(f));
  const evidence = await evidenceFor(project, t, o.base, stats, o.v, o.trunk);
  return { evidence, risk, touches: actualTouches(files, t.touches?.symbols ?? []) };
}

async function evidenceFor(
  project: string, task: Task, base: string, stats: Awaited<ReturnType<typeof numstat>>,
  v: import('./verify.js').VerifyOutcome, trunk: string,
): Promise<NonNullable<Task['evidence']>> {
  const events: SessionEvent[] = v.results.map((r, i) => ({
    seq: i + 1, type: 'check/run', timestamp: Date.now(),
    data: {
      name: r.name, command: r.command, outcome: r.outcome, exitCode: r.exitCode, ms: r.ms,
      ...(r.tests ? { tests: { runner: r.tests.runner, passed: r.tests.passed, failed: r.tests.failed, skipped: r.tests.skipped, failures: r.tests.failures } } : {}),
    },
  } as unknown as SessionEvent));
  let projectChecks: string[] | undefined;
  try { projectChecks = checksFor(project).filter(c => !c.builtin).map(c => c.name); } catch { /* the packet then claims nothing is unrun */ }
  const packet: EvidencePacket = buildEvidence(events, {
    root: task.worktree ?? project,
    goal: task.title,
    ...(projectChecks ? { projectChecks } : {}),
    git: { base: base.slice(0, 10), files: stats.map(s => ({ path: s.path, added: s.added, removed: s.removed })) },
  });
  packet.cost = { ...packet.cost, usd: task.costUsd ?? 0, note: 'the run that produced this change' };
  const head = [
    `## Task ${task.id}: ${task.title}`, '',
    ...(task.acceptance.length ? ['Acceptance criteria:', ...task.acceptance.map(a => `- ${a}`), ''] : []),
    `Rebased onto ${trunk} (${base.slice(0, 10)}); ${v.none ? 'the project defines no checks to run' : v.cached ? 'its checks were already green for this exact tree, so they were not run again' : 'its checks ran on the rebased tree'}.`, '',
  ].join('\n');
  return { md: `${head}\n${render(packet, 'md')}`, summary: render(packet, 'short') };
}

// ── landing ──────────────────────────────────────────────────────────────

/**
 * Land a reviewed task on the trunk by fast-forward. A person approves (the route
 * is human-gated); `by: 'auto'` is only the board's own setting for low-risk,
 * green work. If the trunk moved since review the branch is rebased and checked
 * again first; a conflict or red check sends it back instead of landing.
 */
export function land(project: string, id: string, by: 'person' | 'auto', decision?: ReturnType<typeof autoDecisionFor>): Promise<Task> {
  return serial(project, 'queue', () => landNow(project, id, by, decision));
}

/** The landing itself, for a caller already inside the queue lane (the merge queue's own auto-land). */
async function landNow(project: string, id: string, by: 'person' | 'auto', decision?: ReturnType<typeof autoDecisionFor>, opts: { recheck?: boolean } = {}): Promise<Task> {
  const t = S.getTask(project, id);
  if (!t) throw new DeliveryError(`no task ${id} on this board`, 404);
  if (t.status !== 'review') throw new DeliveryError(`task ${id} is ${t.status}; only a task in review can be approved`, 409);
  if (!t.worktree || !t.branch) throw new DeliveryError(`task ${id} has no branch to land`, 409);
  const repo = await repoOf(project);
  const trunk = S.load(project).settings.trunk;
  if (!(await G.revParse(repo, G.headRef(trunk)))) throw new DeliveryError(`the trunk branch "${trunk}" does not exist in this project`, 409);
  // A branch that carries AICO's own files (reviewed before they were kept out, or committed since) is cleaned first; the cleaned tree is re-checked below.
  const cleaned = await scrubBranch(t.worktree, trunk, id);
  if (cleaned.error) throw new DeliveryError(`could not keep AICO's own files out of the change: ${cleaned.error}`, 409);
  if (cleaned.removed.length > 0) S.addComment(project, id, 'agent', `Left out of this change because AICO writes them itself: ${cleaned.removed.join(', ')}.`);
  const now = await G.revParse(repo, G.headRef(trunk));
  const reviewed = S.load(project).base.get(id);
  if (!reviewed || reviewed.trunkSha !== now || cleaned.removed.length > 0 || opts.recheck) {
    const again = await rebaseAndCheck(project, id, repo, t.worktree);
    if (!again.ok) {
      await sendBack(project, id, `${again.text}\n(The trunk moved after review, so the branch was rebased and checked again before landing.)`);
      throw new DeliveryError(`the trunk moved and the branch no longer rebases cleanly or passes its checks; it was sent back for changes`, 409);
    }
    S.recordBase(project, id, again.trunkSha, again.tree);
    // Same patch on a newer trunk: the report and score describe the tree that will land.
    const pack = await reviewPackage(project, id, again);
    S.patchTask(project, id, { ...pack, changeCount: pack.touches.files.length });
    // The tree changed, so what an automatic landing was allowed on may have too.
    if (by === 'auto' && decision) {
      const again2 = autoDecisionFor(project, id);
      if (!again2.ok) throw new DeliveryError(`after re-checking, the board may not land it by itself: ${again2.reason}`, 409);
    }
  }
  if (prMode(project)) return openPullRequest(project, id, by);
  const fresh = S.getTask(project, id)!;
  // Files in the person's checkout that stand in the way: set aside what is identical or AICO's own, stop and ask about the rest.
  const stuck = await clearCollisions(project, id, repo, trunk, t.branch, fresh);
  if (stuck.length > 0) {
    S.patchTask(project, id, { landingBlock: { at: iso(config.now()), files: stuck.map(c => ({ path: c.path, why: c.why })), choices: ['keep-mine', 'take-task'] } });
    S.logActivity(project, id, 'needs-you', 'system', `Landing stopped: ${stuck.length} file${stuck.length === 1 ? '' : 's'} in your checkout differ from the task's (${stuck.slice(0, 3).map(c => c.path).join(', ')}${stuck.length > 3 ? ', ...' : ''}). Keep yours or take the task's.`);
    throw new DeliveryError(
      `could not land on ${trunk}: ${stuck.length} file${stuck.length === 1 ? '' : 's'} in your checkout differ from what the task changes (${stuck.slice(0, 4).map(c => c.path).join(', ')}${stuck.length > 4 ? ', ...' : ''}). Choose to keep yours or take the task's; nothing was changed.`,
      409, 'landing-collision', { files: stuck.map(c => c.path), details: stuck.map(c => ({ path: c.path, why: c.why })), choices: ['keep-mine', 'take-task'] },
    );
  }
  const before = await G.revParse(repo, G.headRef(trunk));
  const ff = await G.fastForward(repo, trunk, t.branch);
  if (!ff.ok) {
    throw new DeliveryError(`could not land on ${trunk}: ${ff.message || 'git refused'}. Check out ${trunk} in the project with no changes the merge would overwrite, then approve again.`, 409, 'landing-refused');
  }
  S.queueDrop(project, id);
  // What landed and where: release notes group by it, a rollback reverts exactly this range.
  const landedRange = before && ff.sha ? await G.logRange(repo, `${before}..${ff.sha}`) : [];
  const landed: NonNullable<Task['landed']> = {
    from: before ?? '', to: ff.sha ?? '', at: iso(config.now()), by, ...R.classifyCommits(landedRange),
    ...(by === 'auto' && decision
      ? { decision: { autonomy: decision.autonomy, risk: fresh.risk?.level ?? 'low', score: fresh.risk?.score ?? 0, evidence: firstLine(fresh.evidence?.summary ?? ''), reason: decision.reason } }
      : {}),
  };
  S.patchTask(project, id, { status: 'merged', ...(before && ff.sha ? { landed } : {}) }, ['claim', 'needs', 'landingBlock']);
  const legacy = Boolean(decision && 'legacy' in decision && decision.legacy);
  const how = by === 'person' ? 'Approved and landed.'
    : legacy ? 'Landed automatically: low risk and its checks were green (the board setting autoLandLowRisk).'
      : `Landed automatically at the ${decision?.autonomy ?? 'assisted'} level: ${decision?.reason ?? 'its checks were green'}.`;
  S.addComment(project, id, by === 'person' ? 'person' : 'agent', how);
  S.logActivity(project, id, 'landed', by === 'person' ? 'person' : 'system',
    by === 'person' ? 'Approved and landed.' : `${how} Evidence: ${firstLine(fresh.evidence?.summary ?? 'checks green')}`);
  if (by === 'auto') audit(project, 'auto-land', id, decision?.autonomy ?? 'manual', 'ok', `${fresh.risk?.level ?? '?'} risk (${fresh.risk?.score ?? '?'}): ${decision?.reason ?? ''}`);
  const kept = await removeWorktreeAndBranch(project, id);
  if (kept.keptBranch) S.addComment(project, id, 'agent', `Branch ${kept.keptBranch} was kept.`);
  notify('landed', project, S.getTask(project, id)!, by === 'person' ? 'approved by you' : legacy ? 'landed automatically (low risk, checks green)' : `landed automatically (${decision?.autonomy})`);
  kick(project);
  return S.getTask(project, id)!;
}

/**
 * Files the person's checkout has that a fast-forward would trip over. Identical copies and AICO's own files are
 * set aside (copied under the board's folder, then removed from the checkout) and the landing goes on; whatever
 * is left is returned for a person to decide. Nothing is touched when there is nothing to decide.
 */
async function clearCollisions(project: string, id: string, repo: string, trunk: string, branch: string, t: Task): Promise<Collision[]> {
  const all = await findCollisions(repo, trunk, branch);
  if (all.length === 0) return [];
  const auto = all.filter(c => c.identical || c.runtime);
  if (auto.length > 0) {
    const dest = displacedDir(project, id, iso(config.now()));
    const done = await setAside(repo, auto.map(c => c.path), dest);
    if (!done.ok) throw new DeliveryError(`could not land on ${trunk}: ${done.error ?? 'could not set aside the files in the way'}`, 409, 'landing-refused');
    S.addComment(project, id, 'agent', `Files in your checkout were in the way and were set aside (${auto.length}: ${auto.slice(0, 4).map(c => c.path).join(', ')}${auto.length > 4 ? ', ...' : ''}). ${auto.every(c => c.identical) ? 'Their content is identical to what the task brings, ' : 'They are AICO\'s own files, '}so nothing is lost; copies are in ${done.saved}.`);
  }
  void t;
  return all.filter(c => !(c.identical || c.runtime));
}

/**
 * A person's answer to a refused landing. `keep-mine`: the task's change to the files in the way is dropped from the
 * branch (re-checked), and the rest lands. `take-task`: the checkout's copies are saved aside, then the task lands as
 * it is. Either way the person's files are never destroyed: `take-task` saves them first, `keep-mine` does not touch them.
 */
export function resolveLanding(project: string, id: string, choice: 'keep-mine' | 'take-task'): Promise<Task> {
  const p = path.resolve(project);
  if (choice !== 'keep-mine' && choice !== 'take-task') throw new DeliveryError('choice must be "keep-mine" or "take-task"');
  return serial(p, 'queue', async () => {
    const t = S.getTask(p, id);
    if (!t) throw new DeliveryError(`no task ${id} on this board`, 404);
    if (t.status !== 'review') throw new DeliveryError(`task ${id} is ${t.status}; only a task in review can be landed`, 409);
    if (!t.worktree || !t.branch) throw new DeliveryError(`task ${id} has no branch to land`, 409);
    const repo = await repoOf(p);
    const trunk = S.load(p).settings.trunk;
    const colliding = (await findCollisions(repo, trunk, t.branch)).filter(c => !(c.identical || c.runtime));
    if (colliding.length === 0) return landNow(p, id, 'person');   // nothing in the way any more
    if (choice === 'take-task') {
      const dest = displacedDir(p, id, iso(config.now()));
      const done = await setAside(repo, colliding.map(c => c.path), dest);
      if (!done.ok) throw new DeliveryError(`could not save your files first: ${done.error ?? 'unknown error'}; nothing was changed`, 409, 'landing-refused');
      S.addComment(p, id, 'person', `Took the task's version of ${colliding.length} file${colliding.length === 1 ? '' : 's'}; yours were saved in ${done.saved}.`);
      S.logActivity(p, id, 'resolved', 'person', `Landing: took the task's version of ${colliding.map(c => c.path).slice(0, 3).join(', ')}; yours are saved aside.`);
      return landNow(p, id, 'person');
    }
    const base = await G.mergeBase(t.worktree, G.headRef(trunk), 'HEAD');
    if (!base) throw new DeliveryError('the branch has no common base with the trunk', 409);
    const dropped = await dropPaths(t.worktree, base, colliding.map(c => c.path), `chore: keep the checkout's own version of ${colliding.length} file${colliding.length === 1 ? '' : 's'} (task ${id})`);
    if (!dropped.ok) throw new DeliveryError(`could not take those files out of the task: ${dropped.error ?? 'unknown error'}; nothing was changed`, 409, 'landing-refused');
    S.addComment(p, id, 'person', `Kept your version of ${dropped.dropped.length} file${dropped.dropped.length === 1 ? '' : 's'}: ${dropped.dropped.slice(0, 4).join(', ')}. The task's change to ${dropped.dropped.length === 1 ? 'it' : 'them'} was dropped.`);
    S.logActivity(p, id, 'resolved', 'person', `Landing: kept your version of ${dropped.dropped.slice(0, 3).join(', ')}; the task's change to ${dropped.dropped.length === 1 ? 'it was' : 'them was'} dropped.`);
    return landNow(p, id, 'person', undefined, { recheck: true });
  });
}

export const approveTask = (project: string, id: string): Promise<Task> => land(path.resolve(project), id, 'person');

/**
 * PR mode's landing: instead of moving the trunk, push the task branch and open (or update) its
 * pull request, then wait for the remote's checks and reviews. Still a person's act (the route is
 * human-gated and `auto` is refused), still one change at a time through the queue lane.
 */
async function openPullRequest(project: string, id: string, by: 'person' | 'auto'): Promise<Task> {
  if (by !== 'person') throw new DeliveryError('only a person opens a pull request', 403);
  if (!landing) throw new DeliveryError('pull-request mode is not available in this process', 409);
  const t = S.getTask(project, id)!;
  const r = await landing.openPr(project, t);
  if (!r.ok) throw new DeliveryError(r.reason, r.status ?? 502);
  S.queueDrop(project, id);
  S.patchTask(project, id, { status: 'pr', pr: r.pr, risk: applyRemoteRisk(t.risk, r.pr, levelOf) }, ['claim', 'needs']);
  S.addComment(project, id, 'agent', `${t.pr ? 'Updated' : 'Opened'} the pull request: ${r.pr.url}. The remote's checks and reviews decide when it lands; AICO watches it.`);
  notify('review', project, S.getTask(project, id)!, `pull request ${t.pr ? 'updated' : 'opened'}`);
  kick(project);
  return S.getTask(project, id)!;
}

const prSignature = (pr: PullState): string => JSON.stringify([
  pr.state, pr.draft, pr.headSha, pr.mergeable, pr.checks.state, pr.checks.items.map(c => `${c.name}:${c.state}`),
  pr.reviews, pr.canMerge, pr.mergeBlockers, pr.protectedBase, pr.mergedSha, pr.autoMerge,
]);

/**
 * What the remote now says about a task's pull request (the poller's observation). Delivery
 * decides what it means: merged on the remote -> the task is merged and cleaned up; closed
 * without merging -> blocked for a person; failing checks, requested changes or a conflict ->
 * back to `changes` with the reason (the dispatcher resumes the run); anything else -> the card
 * just shows the new state. Remote text in `feedback` is already fenced as untrusted data.
 */
export function observePr(project: string, id: string, pr: PullState, extra: { feedback?: string } = {}): Promise<Task | undefined> {
  const p = path.resolve(project);
  return serial(p, 'queue', async () => {
    const t = S.getTask(p, id);
    if (!t || t.status !== 'pr') return t;
    if (pr.state === 'merged') return mergedRemotely(p, t, pr);
    if (pr.state === 'closed') {
      await releaseRun(p, id, 'blocked', `The pull request ${pr.url} was closed without being merged. The branch and commits are kept. Reopen it on the remote, or set this task to ready to start over.`);
      S.patchTask(p, id, { pr });
      notify('failed', p, t, 'pull request closed without merging');
      return S.getTask(p, id);
    }
    const risk = applyRemoteRisk(t.risk, pr, levelOf);
    // No new journal event when only the observation time moved.
    if (!t.pr || prSignature(t.pr) !== prSignature(pr) || JSON.stringify(t.risk) !== JSON.stringify(risk)) S.patchTask(p, id, { pr, risk });
    const sendbackText = pr.checks.state === 'failing'
      ? `Checks failed on the pull request ${pr.url}: ${pr.checks.items.filter(c => c.state === 'failure').map(c => c.name).slice(0, 6).join(', ') || 'see the pull request'}. Fix the cause on this branch with a new commit (the branch is already on the remote: do not rebase or force-push), run the checks and submit again.${extra.feedback ? `\n${extra.feedback}` : ''}`
      : pr.mergeable === 'conflicting'
        ? `Rebase conflict: the pull request ${pr.url} conflicts with its base branch on the remote. Merge the latest ${S.load(p).settings.trunk} into this branch (git merge, not rebase), resolve the conflicts keeping both sides' intent, run the checks and submit again.`
        : pr.reviews.state === 'changes'
          ? `A reviewer requested changes on the pull request ${pr.url}. Address them with new commits on this branch (do not rebase or force-push), run the checks and submit again.${extra.feedback ? `\n${extra.feedback}` : ''}`
          : undefined;
    if (sendbackText) await sendBack(p, id, sendbackText);
    return S.getTask(p, id);
  });
}

async function mergedRemotely(p: string, t: Task, pr: PullState): Promise<Task> {
  const id = t.id;
  const repo = await repoOf(p);
  let moved: { from?: string; to?: string } | undefined;
  try { moved = await landing?.afterMerged?.(p, t, pr); } catch { /* the trunk could not be refreshed; the merge still happened */ }
  const range = moved?.from && moved.to ? await G.logRange(repo, `${moved.from}..${moved.to}`) : [];
  const landed: NonNullable<Task['landed']> = {
    from: moved?.from ?? '', to: moved?.to ?? pr.mergedSha ?? '', at: iso(config.now()), by: 'person', ...R.classifyCommits(range),
  };
  S.queueDrop(p, id);
  S.patchTask(p, id, { status: 'merged', pr, ...(landed.from && landed.to ? { landed } : {}) }, ['claim', 'needs']);
  S.addComment(p, id, 'agent', `Merged on the remote: ${pr.url}.`);
  const kept = await removeWorktreeAndBranch(p, id, { mergedHead: pr.headSha });
  if (kept.keptBranch) S.addComment(p, id, 'agent', `Branch ${kept.keptBranch} was kept.`);
  notify('landed', p, S.getTask(p, id)!, 'merged on the remote');
  kick(p);
  return S.getTask(p, id)!;
}

/**
 * A person's Merge click (human-gated): ask the remote to merge the task's pull request. The
 * remote's own rules still apply and it may refuse; AICO never bypasses a protection.
 */
export function mergePullRequest(project: string, id: string, opts: { method?: 'merge' | 'squash' | 'rebase' } = {}): Promise<Task> {
  const p = path.resolve(project);
  return serial(p, 'queue', async () => {
    const t = S.getTask(p, id);
    if (!t) throw new DeliveryError(`no task ${id} on this board`, 404);
    if (t.status !== 'pr' || !t.pr) throw new DeliveryError(`task ${id} is ${t.status}; only a task with an open pull request can be merged`, 409);
    if (!landing) throw new DeliveryError('pull-request mode is not available in this process', 409);
    const r = await landing.mergePr(p, t, opts);
    if (!r.ok) throw new DeliveryError(r.reason, r.status ?? 502);
    if (r.pr.state === 'merged') return mergedRemotely(p, S.getTask(p, id)!, r.pr);
    S.patchTask(p, id, { pr: r.pr });
    return S.getTask(p, id)!;
  });
}

/** Why a task may not be part of a batch landing, or undefined when it may (low risk, in review, its checks green). */
export function batchBlocker(project: string, t: Task | undefined): string | undefined {
  if (!t) return 'no such task on this board';
  if (t.status !== 'review') return `it is ${t.status}, not in review`;
  if (!t.risk) return 'its risk has not been assessed';
  if (t.risk.level !== 'low') return `it is ${t.risk.level} risk; only low-risk work can be landed in a batch, open it and approve it on its own`;
  const f = S.load(project);
  const tree = f.base.get(t.id)?.tree;
  if (!tree || f.checks.get(tree)?.ok !== true) return 'its checks are not green for the tree that would land';
  return undefined;
}

/**
 * Land several low-risk, green tasks with one yes (one person-gated request), one at a time
 * through the same lane as a single approval: each is rebased and re-checked if the trunk
 * moved, and a task that no longer rebases cleanly or passes is sent back like any other.
 * The set is validated first and refused whole if any member is not eligible: the person
 * approved exactly that set, so a different one is not quietly landed.
 */
export async function approveBatch(project: string, ids: readonly string[]): Promise<BatchResult> {
  const p = path.resolve(project);
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new DeliveryError('choose at least one task to land');
  if (unique.length > MAX_BATCH) throw new DeliveryError(`a batch lands at most ${MAX_BATCH} tasks`);
  const refused = unique.map(id => ({ id, reason: batchBlocker(p, S.getTask(p, id)) })).filter((x): x is { id: string; reason: string } => Boolean(x.reason));
  if (refused.length > 0) {
    throw new DeliveryError(`nothing was landed. ${refused.map(r => `${r.id}: ${r.reason}`).join('; ')}`, 409);
  }
  const result: BatchResult = { landed: [], skipped: [] };
  for (let i = 0; i < unique.length; i++) {
    const id = unique[i]!;
    try {
      await land(p, id, 'person');
      result.landed.push(id);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      result.skipped.push({ id, reason });
      // The checkout cannot take a landing at all (uncommitted edits, the trunk held elsewhere): the rest would fail alike.
      if (/^could not land/.test(reason)) {
        for (const rest of unique.slice(i + 1)) result.skipped.push({ id: rest, reason: 'not attempted: an earlier task could not land' });
        break;
      }
    }
  }
  return result;
}

export async function requestChanges(project: string, id: string, comment: string): Promise<Task> {
  const p = path.resolve(project);
  const text = comment.trim();
  if (!text) throw new DeliveryError('comment required: say what to change');
  return serial(p, 'queue', async () => {
    const t = S.getTask(p, id);
    if (!t) throw new DeliveryError(`no task ${id} on this board`, 404);
    if (t.status !== 'review') throw new DeliveryError(`task ${id} is ${t.status}; changes can be requested on a task in review`, 409);
    S.queueDrop(p, id);
    S.addComment(p, id, 'person', text);
    S.patchTask(p, id, { status: 'changes' }, ['evidence', 'risk']);
    kick(p);
    return S.getTask(p, id)!;
  });
}

/** What the Changes tab shows: the diff, its files (the count is `files.length`, always), and whether it is live. */
export interface TaskDiff { diff: string; files: G.DiffFile[]; live: boolean; truncated: boolean; note?: string }

/**
 * A task's change. One source for the text and the file list, so the number on the tab is the number of files
 * below it: nothing is predicted here. While the task runs the diff is LIVE - the worktree as it is now,
 * uncommitted edits and new files included - so a person can watch the work. In review it is the branch against
 * its merge base (the trunk commit it was rebased onto); after the merge it is the range that landed.
 */
export async function taskDiffInfo(project: string, id: string): Promise<TaskDiff> {
  const p = path.resolve(project);
  const t = S.getTask(p, id);
  if (!t) throw new DeliveryError(`no task ${id} on this board`, 404);
  const trunk = S.load(p).settings.trunk;
  if (!t.worktree || !fs.existsSync(t.worktree)) {
    if (t.status === 'merged' && t.landed?.from && t.landed.to) {
      const snap = await G.rangeSnapshot(await repoOf(p), t.landed.from, t.landed.to);
      return { ...snap, files: snap.files.filter(f => !isRuntimePath(f.path)), live: false };
    }
    return { diff: '', files: [], live: false, truncated: false, note: t.status === 'merged' ? 'This task was merged; see the trunk history for its change.' : 'No agent has started on this task yet, so there is nothing to show.' };
  }
  const base = await G.mergeBase(t.worktree, G.headRef(trunk), 'HEAD');
  if (!base) return { diff: '', files: [], live: false, truncated: false, note: `The branch has no common history with ${trunk}.` };
  const live = t.status === 'running';
  const snap = await G.diffSnapshot(t.worktree, base, { live, exclude: RUNTIME_EXCLUDES });
  return { ...snap, live };
}

export async function taskDiff(project: string, id: string): Promise<string> { return (await taskDiffInfo(project, id)).diff; }

/** A task's history, up to 200 lines, oldest first. */
export function taskActivity(project: string, id: string): ActivityEntry[] {
  const p = path.resolve(project);
  if (!S.getTask(p, id)) throw new DeliveryError(`no task ${id} on this board`, 404);
  return S.taskActivity(p, id);
}

// ── the person's controls ────────────────────────────────────────────────

/** Start or pause the dispatcher. Starting is the act that lets the board spend money, so the route is human-gated. */
export async function setDispatch(project: string, action: 'start' | 'pause', maxParallel?: number): Promise<BoardState> {
  const p = await ensureBoard(project);
  if (maxParallel !== undefined) S.setSettings(p, { maxParallel: S.clampParallel(maxParallel) });
  if (action === 'start') {
    const repo = await repoOf(p);
    const f = S.load(p);
    if (!(await G.branchExists(repo, f.settings.trunk))) {
      const cur = await G.currentBranch(repo);
      if (!cur) throw new DeliveryError('the project has no branch to use as the trunk yet; make a first commit', 409);
      S.setSettings(p, { trunk: cur });
    }
    S.setDispatcher(p, 'running');
    startSweeper();
    kick(p);
    await tick(p);
  } else {
    S.setDispatcher(p, 'paused');
    kick(p);
  }
  return S.boardState(p);
}

export function setBoardSettings(project: string, set: { autoLandLowRisk?: boolean }): BoardState {
  const p = path.resolve(project);
  if (set.autoLandLowRisk !== undefined) S.setSettings(p, { autoLandLowRisk: set.autoLandLowRisk === true });
  return S.boardState(p);
}

// ── hygiene and boot ─────────────────────────────────────────────────────

/** Remove worktrees of finished tasks and `aico/task-*` worktrees no live task owns. Never touches unmerged work. */
export async function sweep(project: string): Promise<string[]> {
  const p = path.resolve(project);
  const removed: string[] = [];
  let repo: string;
  try { repo = await repoOf(p); } catch { return removed; }
  const f = S.load(p);
  const live = new Set([...f.tasks.values()].filter(t => !['merged', 'cancelled'].includes(t.status)).map(t => t.id));
  for (const w of await G.worktreeList(repo)) {
    // Git prints its own spelling of the path (forward slashes, a long name for a short one).
    const parts = relativeToWorktrees(w.path)?.split(/[\\/]/);
    if (!parts || parts.length !== 2 || parts[0] !== projectKey(p)) continue;
    const rel = parts[1]!;
    if (live.has(rel)) continue;
    const r = await G.worktreeRemove(repo, w.path);
    if (r.ok) { removed.push(w.path); }
    if (w.branch?.startsWith('aico/task-')) {
      const merged = await G.git(['merge-base', '--is-ancestor', w.branch, G.headRef(f.settings.trunk)], repo);
      if (merged.ok) await G.branchDelete(repo, w.branch, true);
    }
  }
  // Finished tasks whose directory is still on disk (a removal that was busy earlier).
  for (const t of f.tasks.values()) {
    if (['merged', 'cancelled'].includes(t.status) && t.worktree && fs.existsSync(t.worktree)) {
      await removeWorktreeAndBranch(p, t.id);
      removed.push(t.worktree);
    }
  }
  await G.worktreePrune(repo);
  // Git's own housekeeping (pack and loose-object upkeep), only when nothing of this project is running or being
  // prepared, so it never competes with a rebase or a check for the disk (GitHub's lesson: maintenance off the critical path).
  const key = `${projectKey(p)}/`;
  const busy = [...handles.keys(), ...preparing].some(k => k.startsWith(key)) || runningClaims(p).length > 0;
  if (!busy) await G.gcAuto(repo);
  return removed;
}

function startSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    for (const p of S.journaledProjects()) void sweep(p).catch(() => undefined);
  }, SWEEP_MS);
  sweepTimer.unref?.();
}

/**
 * After a restart: every dispatcher that was running is paused (a restart is not a
 * person's yes to spend), live claims keep their lease and return to `ready` when it
 * runs out, and the sweep runs once. Called by the server at start-up.
 */
export async function bootDelivery(): Promise<void> {
  startSweeper();
  for (const p of S.journaledProjects()) {
    const f = S.load(p);
    if (f.dispatcher === 'running') S.setDispatcher(p, 'paused', 'AICO restarted. A restart is not your yes to spend, so start the dispatcher again when you want it to go on.');
    if (f.queue.length > 0 || [...f.tasks.values()].some(t => t.status === 'running')) kick(p);
    void sweep(p).catch(() => undefined);
  }
}

/** Tests and clients: wait until the queue and the tick lanes of a project are idle. */
export async function settled(project: string): Promise<void> {
  const p = path.resolve(project);
  for (let i = 0; i < 400; i++) {
    await Promise.all([chains.get(`tick:${projectKey(p)}`), chains.get(`queue:${projectKey(p)}`), ...[...deployJobs].filter(([k]) => k.startsWith(`${projectKey(p)}/`)).map(([, j]) => j)]);
    if (![...preparing].some(k => k.startsWith(`${projectKey(p)}/`))) return;
    await new Promise(r => setTimeout(r, 25));
  }
}

export type { DispatcherState };

/** The board as a client reads it. A project with no journal yet reports its real trunk, without writing anything. */
export async function getBoard(project: string): Promise<BoardState> {
  const p = path.resolve(project);
  const board = S.boardState(p);
  if (!fs.existsSync(S.journalFile(p))) {
    const trunk = await G.currentBranch(p);
    if (trunk) board.settings.trunk = trunk;
  }
  return board;
}

// ── needs, notes, handoffs, dependency folders ───────────────────────────

/** Notes on a task's thread. A person's goes through a person-gated route; the run reads it when it is resumed. */
export function commentTask(project: string, id: string, text: string, by: 'person' | 'agent'): Task {
  const p = path.resolve(project);
  const t = S.getTask(p, id);
  if (!t) throw new DeliveryError(`no task ${id} on this board`, 404);
  const clean = text.trim();
  if (!clean) throw new DeliveryError('a comment needs some text');
  if (t.status === 'merged' || t.status === 'cancelled') throw new DeliveryError(`task ${id} is ${t.status}; its thread is closed`, 409);
  S.addComment(p, id, by, clean.slice(0, 4000));
  return S.getTask(p, id)!;
}

/**
 * One run leaves a note for another task that depends on it (the dependent's agent reads
 * it in its prompt when it starts). Only along a dependency edge, and only as an agent:
 * a run cannot write on tasks it has no business with, nor as a person.
 */
export function handoff(project: string, fromId: string, toId: string, note: string): Task {
  const p = path.resolve(project);
  const from = S.getTask(p, fromId);
  const to = S.getTask(p, toId);
  if (!from) throw new DeliveryError(`no task ${fromId} on this board`, 404);
  if (!to) throw new DeliveryError(`no task ${toId} on this board`, 404);
  if (!to.dependsOn.includes(fromId) && !from.dependsOn.includes(toId)) {
    throw new DeliveryError(`task ${toId} is not connected to yours by a dependency; hand off only to a task that depends on yours (or that yours depends on)`, 409);
  }
  const clean = note.trim();
  if (!clean) throw new DeliveryError('a handoff needs a note');
  if (to.status === 'merged' || to.status === 'cancelled') throw new DeliveryError(`task ${toId} is ${to.status}; its thread is closed`, 409);
  S.addComment(p, toId, 'agent', `Handoff from "${from.title}": ${clean.slice(0, 3000)}`);
  return S.getTask(p, toId)!;
}

/** Give a task's worktree private dependency folders in place of the links (the run's `localise` action; see env.ts). */
export async function localiseTask(project: string, id: string): Promise<string> {
  const p = path.resolve(project);
  const t = S.getTask(p, id);
  if (!t?.worktree || !fs.existsSync(t.worktree)) throw new DeliveryError(`task ${id} has no worktree`, 404);
  const repo = await repoOf(p);
  const r = localiseDeps(t.worktree, insideWorktree(repo, p, t.worktree));
  if (r.changed.length > 0) S.addComment(p, id, 'agent', `Environment: ${r.message}`);
  return r.message;
}

/** The task a chat session belongs to, across every board: any of the task's runs (the latest and the earlier ones). */
export function taskForSession(sessionId: string): { project: string; task: Task } | undefined {
  if (!sessionId) return undefined;
  for (const p of S.journaledProjects()) {
    for (const t of S.load(p).tasks.values()) {
      if (t.sessionId === sessionId || t.sessions?.some(x => x.id === sessionId)) return { project: p, task: structuredClone(t) };
    }
  }
  return undefined;
}

/**
 * What a chat needs to link back to its task: set on every run's chat, whatever the task's status now (running,
 * review, changes, merged ...). The board's folder is the project; the client opens the board there and selects the task.
 */
export interface SessionDelivery { taskId: string; title: string; status: TaskStatus; project: string; board: string; stage?: TaskStatus }
export function deliveryLinkOfSession(sessionId: string): SessionDelivery | undefined {
  const hit = taskForSession(sessionId);
  if (!hit) return undefined;
  const run = hit.task.sessions?.find(x => x.id === sessionId);
  return {
    taskId: hit.task.id, title: hit.task.title, status: hit.task.status, project: hit.project, board: hit.project,
    ...(run ? { stage: run.stage } : {}),
  };
}

/** The directory a task's chat session was filed under (its worktree), so the server can reopen it after a restart or after the worktree is gone. */
export function sessionDirOf(sessionId: string): string | undefined {
  const hit = taskForSession(sessionId);
  if (hit?.task.worktree && fs.existsSync(eventLogPath(sessionId, hit.task.worktree))) return hit.task.worktree;
  return undefined;
}

/**
 * Every registered board's tasks in a compact form, for a client that raises notifications:
 * it keeps the last snapshot and says what changed (a task now needs you, is ready for review,
 * landed, or failed). Cheap on purpose (a poll), and read-only.
 */
export function attention(isKnown: (project: string) => boolean = () => true): AttentionSnapshot {
  const dayAgo = Date.now() - 24 * 3_600_000;
  const boards: AttentionSnapshot['boards'] = [];
  for (const project of S.journaledProjects()) {
    if (!isKnown(project) || !fs.existsSync(project)) continue;
    const tasks = [...S.load(project).tasks.values()]
      .filter(t => t.status !== 'backlog' && t.status !== 'cancelled' && !(t.status === 'merged' && Date.parse(t.updatedAt) < dayAgo))
      .map(t => ({ id: t.id, title: t.title, status: t.status, needs: Boolean(t.needs), ...(t.needs ? { kind: t.needs.kind } : {}) }));
    if (tasks.length > 0) boards.push({ project, name: path.basename(project), tasks });
  }
  return { boards };
}

// ── releases ─────────────────────────────────────────────────────────────

/** What "Deploy" would run for this project: the app's own script, else the configured command, else nothing. */
async function deployInfo(project: string): Promise<ReleasePlan['deploy']> {
  const app = appDeployFor(project);
  if (app) return { available: true, source: 'app', command: app.target.script };
  const cfg = deliveryConfig(project);
  if (cfg.deployCommand) return { available: true, source: 'setting', command: cfg.deployCommand };
  return {
    available: false, source: 'none',
    why: cfg.untrusted
      ? `This project's settings define a deploy command a person has not approved yet. ${cfg.untrusted}`
      : 'No deploy command is set. Add delivery.deployCommand to your AICO settings (or to this project\'s .aico/settings.json, which asks you once), or deploy an AICO app from its own page.',
  };
}

interface AppDeploy { app: import('../miniapps/store.js').MiniApp; target: import('../miniapps/store.js').DeployTarget }

/** The project's `app.json` deploy target, when the project is an AICO app that declares one. */
function appDeployFor(project: string): AppDeploy | undefined {
  try {
    const app = JSON.parse(fs.readFileSync(path.join(project, 'app.json'), 'utf8')) as import('../miniapps/store.js').MiniApp;
    const target = Array.isArray(app.deploy) ? app.deploy.find(t => t && typeof t.script === 'string' && t.script.trim()) : undefined;
    return typeof app.slug === 'string' && target ? { app, target } : undefined;
  } catch { return undefined; }
}

async function boardTrunk(project: string): Promise<string> {
  if (fs.existsSync(S.journalFile(project))) return S.load(project).settings.trunk;
  return (await G.currentBranch(project)) ?? 'main';
}

/** What a release would be right now (a read). `version` previews a version the person chose. */
export async function planRelease(project: string, version?: string): Promise<ReleasePlan> {
  const p = path.resolve(project);
  const repo = await repoOf(p);
  const trunk = await boardTrunk(p);
  const plan = await R.planRelease({ project: p, repo, trunk, tasks: [...S.load(p).tasks.values()], deploy: await deployInfo(p), ...(version ? { version } : {}) });
  // Where the release commit would land, and whether git would refuse it.
  const here = await G.currentBranch(repo);
  if (here === trunk) {
    const rel = path.relative(repo, p).replace(/\\/g, '/');
    const files = [...plan.versionFiles, rel ? `${rel}/CHANGELOG.md` : 'CHANGELOG.md'];
    const dirty = (await G.git(['status', '--porcelain', '--', ...files], repo)).out.split('\n').filter(l => l.trim());
    if (dirty.length > 0) plan.blockers.push(`${dirty.map(l => l.slice(3).trim()).join(', ')} ${dirty.length === 1 ? 'has' : 'have'} uncommitted changes the release would overwrite; commit or stash ${dirty.length === 1 ? 'it' : 'them'} first.`);
  } else {
    const holder = (await G.worktreeList(repo)).find(w => w.branch === trunk);
    if (holder) plan.blockers.push(`${trunk} is checked out in ${holder.path}; make the release from a checkout of it there.`);
  }
  return plan;
}

/**
 * Make the release: a version-bump commit and an annotated tag on the trunk, local only.
 * A person's act (the route is human-gated); it takes the queue lane, so it never
 * interleaves with a landing.
 */
export function createRelease(project: string, opts: { version?: string; changelog?: boolean } = {}): Promise<Release> {
  const p = path.resolve(project);
  return serial(p, 'queue', async () => {
    await ensureBoard(p);   // the journal's first line names the project; a release is written to it
    const plan = await planRelease(p, opts.version);
    if (plan.blockers.length > 0) throw new DeliveryError(plan.blockers[0]!, 409);
    if (!plan.next) throw new DeliveryError('there is nothing to release', 409);
    const repo = await repoOf(p);
    const made = await R.makeRelease({
      project: p, repo, trunk: plan.trunk, tasks: [...S.load(p).tasks.values()], deploy: plan.deploy,
      version: plan.next.version, changelog: opts.changelog !== false, plan, now: new Date(config.now()),
    });
    if (!made.ok) throw new DeliveryError(made.reason, made.status ?? 409);
    S.putRelease(p, made.release);
    return made.release;
  });
}

const deployJobs = new Map<string, Promise<void>>();   // `${projectKey}/${version}` → the deploy in flight
const DEPLOY_TIMEOUT_MS = 30 * 60_000;

/**
 * Run the project's deploy for a release. A person's act: the route is human-gated and the
 * command is shown to them first. It runs in the project's own folder (where its deploy
 * configuration and credentials live), only while that checkout contains the release commit,
 * and returns at once with `deploy.state: 'running'`; the outcome is journaled when it ends.
 */
export async function deployRelease(project: string, version: string): Promise<Release> {
  const p = path.resolve(project);
  const rel = S.getRelease(p, version);
  if (!rel) throw new DeliveryError(`no release ${version} on this board`, 404);
  const key = `${projectKey(p)}/${version}`;
  if (deployJobs.has(key)) throw new DeliveryError(`a deploy of ${rel.tag} is already running`, 409);
  // Reserved before the first await: two clicks in the same instant cannot both start one.
  let done!: () => void;
  deployJobs.set(key, new Promise<void>(r => { done = r; }));
  let command: string;
  let source: 'app' | 'setting';
  try {
    const info = await deployInfo(p);
    if (!info.available || !info.command || info.source === 'none') throw new DeliveryError(info.why ?? 'there is no deploy command', 409);
    const repo = await repoOf(p);
    if (!(await G.isAncestor(repo, rel.commit, 'HEAD'))) {
      throw new DeliveryError(`the project's checkout does not contain ${rel.tag}; check out the trunk (or a branch that includes the release) and deploy again`, 409);
    }
    command = info.command;
    source = info.source;
    S.setDeploy(p, version, { state: 'running', at: iso(config.now()), command, source });
  } catch (e) {
    deployJobs.delete(key);
    done();
    throw e;
  }
  void (async (): Promise<void> => {
    let ok = false; let tail = '';
    try {
      if (source === 'app') {
        const a = appDeployFor(p)!;
        const { deployApp, deployState } = await import('../apps/deploy.js');
        const started = await deployApp(a.app, p, a.target.id);
        if (!started.ok) { tail = started.message; }
        else {
          for (let waited = 0; waited < DEPLOY_TIMEOUT_MS; waited += 500) {
            const st = deployState(a.app.slug);
            if (!st || st.state !== 'working') {
              ok = st?.state === 'done';
              tail = sinkRedactText((st?.output ?? []).join('').slice(-3000) + (st?.error ? `\n${st.error}` : ''));
              break;
            }
            await new Promise(r => setTimeout(r, 500));
          }
          if (!ok && !tail) tail = 'The deploy did not finish in time.';
        }
      } else {
        const r = await runCommand({ command, cwd: p, timeoutMs: DEPLOY_TIMEOUT_MS });
        ok = r.ok; tail = r.tail;
      }
    } catch (e) {
      tail = e instanceof Error ? e.message : String(e);
    }
    S.setDeploy(p, version, { state: ok ? 'ok' : 'failed', at: iso(config.now()), command, source, tail: tail.slice(-3000) });
  })().finally(() => { deployJobs.delete(key); done(); });
  return S.getRelease(p, version)!;
}

/**
 * Undo a release the safe way: a task that reverts its commits on its own branch and goes
 * through the same queue as any other work (rebased, checked, scored, then a person lands it).
 * The reverting is mechanical (`git revert`), so it costs nothing and needs no agent; if it
 * conflicts, nothing is created and the files are named.
 */
export function rollbackRelease(project: string, version: string): Promise<Task> {
  const p = path.resolve(project);
  return serial(p, 'queue', async () => {
    const rel = S.getRelease(p, version);
    if (!rel) throw new DeliveryError(`no release ${version} on this board`, 404);
    if (rel.rollback) throw new DeliveryError(`${rel.tag} already has a rollback task (${rel.rollback.taskId})`, 409);
    const repo = await repoOf(p);
    const trunk = S.load(p).settings.trunk;   // (git calls below use the qualified ref)
    // The commits to revert, newest first: each released task's landed range, else the span since the previous tag.
    const shas: string[] = [];
    for (const rt of [...rel.tasks].reverse()) {
      const landed = S.getTask(p, rt.id)?.landed;
      if (landed) shas.push(...(await G.revList(repo, `${landed.from}..${landed.to}`)).reverse());
    }
    if (shas.length === 0) {
      const prev = (await G.tagsMerged(repo, `${rel.tag}^`)).find(t => /^v\d+\.\d+\.\d+$/.test(t));
      if (prev) shas.push(...(await G.revList(repo, `${prev}..${rel.tag}^`)).reverse());
    }
    if (shas.length === 0) throw new DeliveryError(`${rel.tag} has no commits to revert that the board can identify (no tasks recorded and no earlier release tag)`, 409);

    const id = S.newTaskId();
    const wt = worktreePath(p, id);
    const branch = branchOf(id);
    const made = await G.worktreeAdd(repo, wt, branch, G.headRef(trunk));
    if (!made.ok) throw new DeliveryError(`could not prepare the rollback: ${(made.err || made.out).trim().slice(0, 300)}`, 409);
    const discard = async (): Promise<void> => {
      unlinkDeps(wt, insideWorktree(repo, p, wt));
      await G.worktreeRemove(repo, wt, true);
      try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* the sweep tries again */ }
      await G.worktreePrune(repo);
      if (await G.branchExists(repo, branch)) await G.branchDelete(repo, branch, true);
    };
    const reverted = await G.revertCommits(wt, shas);
    if (!reverted.ok) {
      await discard();
      throw new DeliveryError(`${rel.tag} cannot be reverted automatically${reverted.conflicts.length ? `: later changes conflict in ${reverted.conflicts.join(', ')}` : `: ${reverted.message}`}. Nothing was changed.`, 409);
    }
    await prepareWorktree({ repo, projectDir: p, wt, workdir: insideWorktree(repo, p, wt), setup: deliveryConfig(p).worktreeSetup });
    const base = await G.mergeBase(wt, G.headRef(trunk), 'HEAD');
    const files = base ? (await G.changedFiles(wt, base)).map(c => c.path) : [];
    const now = iso(config.now());
    const task: Task = {
      id, project: p, title: `Revert release ${rel.tag}`,
      body: `Reverts the ${shas.length} commit${shas.length === 1 ? '' : 's'} released in ${rel.tag}:\n${rel.tasks.map(t => `- ${t.title}`).join('\n') || '(commits since the previous release)'}\n\nCreated by a person from the Releases view; it goes through the same checks and review as any task.`,
      acceptance: [`The changes released in ${rel.tag} are undone on ${trunk} and the project's checks pass.`],
      status: 'running', priority: 1, dependsOn: [], labels: ['rollback', `release:${rel.version}`],
      branch, worktree: wt, touches: actualTouches(files),
      rank: S.nextRankIn(S.load(p).tasks.values(), 1), changeCount: files.length, activity: [], type: 'chore',
      createdAt: now, updatedAt: now,
    };
    S.putTask(p, task, 'person');
    S.setRollback(p, version, id);
    S.addComment(p, id, 'agent', `Reverted ${shas.length} commit${shas.length === 1 ? '' : 's'} on this branch. The merge queue checks it next; a person lands it.`);
    S.queuePush(p, id);
    queuePrepare(p, id);
    return S.getTask(p, id)!;
  });
}
