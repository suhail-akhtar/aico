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
import { deliveryConfig } from './config.js';
import { localiseDeps, prepareWorktree, unlinkDeps } from './env.js';
import { runCommand } from './exec.js';
import * as G from './git.js';
import { branchOf, relativeToWorktrees, worktreePath, worktreesRoot } from './paths.js';
import * as R from './release.js';
import { backgroundRunner, type AgentRunner } from './runner.js';
import { runPrompt } from './prompts.js';
import { assessRisk, numstat } from './risk.js';
import * as S from './store.js';
import { actualTouches, overlap, predictTouches } from './touches.js';
import { verifyTree } from './verify.js';
import type {
  AttentionSnapshot, BatchResult, BoardState, DispatcherState, Release, ReleasePlan, Task, TaskNeed, TaskPriority, TaskStatus,
} from './types.js';

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
  constructor(message: string, readonly status = 400) { super(message); }
}

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

interface Handle { runId: string; project: string; lastActivityAt: number }

const handles = new Map<string, Handle>();      // `${projectKey}/${taskId}` → live run
const preparing = new Set<string>();           // same key: being rebased / checked now
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
  handles.clear(); preparing.clear(); chains.clear(); active.clear();
  if (timer) { clearInterval(timer); timer = undefined; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = undefined; }
  S.resetStoreCache();
  config.runner = undefined; config.now = Date.now; config.budgetUsd = () => DEFAULT_TASK_BUDGET_USD;
}

// ── tasks ────────────────────────────────────────────────────────────────

export interface TaskInput {
  title?: unknown; body?: unknown; acceptance?: unknown; priority?: unknown; dependsOn?: unknown; labels?: unknown; status?: unknown;
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

export async function createTask(project: string, input: TaskInput): Promise<Task> {
  const p = await ensureBoard(project);
  const title = typeof input.title === 'string' ? clip(input.title.trim(), 200) : '';
  if (!title) throw new DeliveryError('title required');
  if (S.load(p).tasks.size >= MAX_TASKS_PER_BOARD) throw new DeliveryError(`this board already holds ${MAX_TASKS_PER_BOARD} tasks; cancel or finish some first`);
  const id = S.newTaskId();
  const now = iso(config.now());
  const status = input.status === undefined ? 'backlog' : input.status;
  if (status !== 'backlog' && status !== 'ready' && status !== 'blocked') throw new DeliveryError('a new task starts in backlog, ready or blocked');
  const task: Task = {
    id, project: p, title,
    body: typeof input.body === 'string' ? clip(input.body, 20_000) : '',
    acceptance: strings(input.acceptance, 20, 500) ?? [],
    status, priority: priorityOf(input.priority) ?? 3,
    dependsOn: resolveDeps(p, strings(input.dependsOn, 20, 200) ?? []),
    labels: strings(input.labels, 20, 80) ?? [],
    createdAt: now, updatedAt: now,
  };
  S.putTask(p, task);
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
  const pr = priorityOf(input.priority); if (pr) set.priority = pr;
  const deps = strings(input.dependsOn, 20, 200); if (deps) set.dependsOn = resolveDeps(p, deps, id);
  // The text changed: what was predicted from it is stale.
  const unset: Array<keyof Task> = [];
  if ((set.title !== undefined || set.body !== undefined || set.labels || set.acceptance) && task.touches?.predicted) unset.push('touches');

  let status: TaskStatus | undefined;
  if (input.status !== undefined) {
    status = input.status as TaskStatus;
    if (!EDITABLE_STATUS.has(status)) throw new DeliveryError('status can be set to backlog, ready, blocked or cancelled; the engine moves a task through running, review, changes and merged');
    if (status === 'cancelled' && by !== 'person' && task.status !== 'backlog' && task.status !== 'blocked') throw new DeliveryError('an agent can cancel only a backlog or blocked task; stopping a task that has started needs a person');
    if (status === 'ready' && by !== 'person') throw new DeliveryError('only a person promotes a task to ready: that is what lets the dispatcher spend money on it');
    if ((task.status === 'running' || task.status === 'review' || task.status === 'changes') && status !== 'cancelled' && status !== 'blocked') {
      throw new DeliveryError(`task ${id} is ${task.status}; it can be cancelled or blocked, or finish its run first`, 409);
    }
  }
  if (Object.keys(set).length > 0 || unset.length > 0) S.patchTask(p, id, set, unset);
  if (status && status !== task.status) {
    if (status === 'cancelled') await cancelTask(p, id);
    else if (status === 'blocked' && (task.status === 'running' || task.status === 'review' || task.status === 'changes')) await releaseRun(p, id, 'blocked');
    else S.patchTask(p, id, { status });
  }
  kick(p);
  return S.getTask(p, id)!;
}

async function releaseRun(project: string, id: string, status: TaskStatus, comment?: string): Promise<void> {
  const h = handles.get(hk(project, id));
  if (h) { try { runner().stop(h.runId); } catch { /* already over */ } handles.delete(hk(project, id)); }
  S.queueDrop(project, id);
  if (comment) S.addComment(project, id, 'agent', comment);
  S.patchTask(project, id, { status }, ['claim', 'needs']);
}

async function cancelTask(project: string, id: string): Promise<void> {
  await releaseRun(project, id, 'cancelled');
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
async function removeWorktreeAndBranch(project: string, id: string): Promise<{ keptBranch?: string }> {
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
  const merged = await G.git(['merge-base', '--is-ancestor', branch, trunk], repo);
  if (merged.ok) { await G.branchDelete(repo, branch, true); return {}; }
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
    if (f.dispatcher === 'running') await startReady(p);
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
    const cost = Math.round(poll.costUsd * 10_000) / 10_000;
    if (cost > (t.costUsd ?? 0) + 0.0005) S.patchTask(project, t.id, { costUsd: cost });
    if (poll.state === 'running') {
      if (poll.lastActivityAt > h.lastActivityAt) {
        h.lastActivityAt = poll.lastActivityAt;
        S.patchTask(project, t.id, { claim: { ...t.claim!, leaseUntil: iso(now + LEASE_MS) } });
      }
      syncNeed(project, t, poll.need);
      await refreshTouches(project, t.id);
      continue;
    }
    handles.delete(key);
    await onRunEnded(project, t.id, poll);
  }
  // A run that is still winding down after it submitted: keep its cost current, then forget it.
  for (const [key, h] of [...handles]) {
    if (!key.startsWith(`${projectKey(project)}/`)) continue;
    const id = key.slice(key.indexOf('/') + 1);
    const t = S.getTask(project, id);
    if (t && t.status === 'running' && t.claim) continue;
    const poll = runner().poll(h.runId);
    const cost = Math.round(poll.costUsd * 10_000) / 10_000;
    if (t && cost > (t.costUsd ?? 0) + 0.0005) S.patchTask(project, id, { costUsd: cost });
    if (poll.state !== 'running') handles.delete(key);
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
  const base = await G.mergeBase(t.worktree, trunk, 'HEAD');
  if (!base) return;
  const committed = (await G.changedFiles(t.worktree, base)).map(c => c.path);
  const dirty = (await G.porcelain(t.worktree)).map(l => l.slice(3).trim().replace(/^"|"$/g, '')).filter(f => f && !f.endsWith('/') && f !== 'node_modules');
  const files = [...new Set([...committed, ...dirty])];
  if (files.length === 0) return;
  const cur = t.touches;
  if (cur && !cur.predicted && cur.files.length === files.length && files.every(f => cur.files.includes(f))) return;
  S.patchTask(project, id, { touches: actualTouches(files, cur?.symbols ?? []) });
}

async function onRunEnded(project: string, id: string, poll: import('./runner.js').RunPoll): Promise<void> {
  const t = S.getTask(project, id);
  if (!t || t.status !== 'running' || !t.claim) return;
  if (poll.ok === false) {
    await releaseRun(project, id, 'blocked',
      `The run ended without finishing${poll.error ? `: ${poll.error.slice(0, 400)}` : ' (it was stopped, usually by its spend or time limit)'}. `
      + 'Its branch and commits are kept. Set the task to ready to run it again.');
    notify('failed', project, t, poll.error);
    return;
  }
  // It finished its work but did not call submit: finishing with commits is a submission.
  const r = await submitTask(project, id, { summary: poll.result ? `(the agent's final answer) ${poll.result.slice(0, 1500)}` : undefined, implicit: true });
  if (!r.ok) {
    notify('failed', project, t, r.reason);
    await releaseRun(project, id, 'blocked', `The run finished but there was nothing to review: ${r.reason}${poll.result ? `\nIts answer: ${poll.result.slice(0, 1200)}` : ''}`);
  }
}

async function startReady(project: string): Promise<void> {
  const f = S.load(project);
  const max = S.clampParallel(f.settings.maxParallel);
  let running = runningClaims(project);
  const candidates = [...f.tasks.values()]
    .filter(t => (t.status === 'ready' || t.status === 'changes') && !t.claim && depsMerged(f, t))
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  for (const t of candidates) {
    if (running.length >= max) break;
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
  if (!fs.existsSync(wt)) {
    const made = await G.worktreeAdd(repo, wt, branch, trunk);
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
      budgetUsd: config.budgetUsd(), deadlineMs: TASK_DEADLINE_MS,
    });
  } catch (e) {
    S.patchTask(project, id, { status: 'blocked', branch, worktree: wt });
    S.addComment(project, id, 'agent', `Could not start the run: ${(e as Error).message}`);
    return false;
  }
  const now = config.now();
  handles.set(hk(project, id), { runId, project, lastActivityAt: 0 });
  S.markStart(project, id, runId);
  // The chat the run is held in, when the runner has one: what the card's "Session" opens.
  const sessionId = runner().poll(runId).sessionId;
  S.patchTask(project, id, {
    status: 'running', branch, worktree: wt,
    claim: { runId, ...(sessionId ? { sessionId } : {}), leaseUntil: iso(now + LEASE_MS) },
    ...(sessionId ? { sessionId } : {}),
  }, ['needs']);
  return true;
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
  const committed = await G.commitAll(wt, `chore: complete task ${id} - ${t.title.slice(0, 60)}`, looksLikeSecretPath);
  if (committed.kept.length > 0) {
    S.addComment(project, id, 'agent', `Left uncommitted because they look like credentials: ${committed.kept.join(', ')}. They are not part of this change.`);
  }
  if (committed.error) return { ok: false, reason: `could not commit the remaining changes: ${committed.error}` };
  const base = await G.mergeBase(wt, trunk, 'HEAD');
  if (!base || (await G.aheadCount(wt, base)) === 0) return { ok: false, reason: `the branch has no commits past ${trunk}; commit your work before submitting` };
  const files = (await G.changedFiles(wt, base)).map(c => c.path);
  S.patchTask(project, id, { touches: actualTouches(files, t.touches?.symbols ?? []) }, ['claim', 'needs']);
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
  kick(project);
}

/** Rebase, check, review-prepare one submitted task. Always inside the queue lane: one at a time. */
async function prepare(project: string, id: string): Promise<void> {
  const t = S.getTask(project, id);
  if (!t || t.status !== 'running' || t.claim || !t.worktree) return;
  const f = S.load(project);
  const repo = await repoOf(project);
  const outcome = await rebaseAndCheck(project, id, repo, t.worktree);
  if (!outcome.ok) { await sendBack(project, id, outcome.text); return; }
  const { trunkSha, tree, v } = outcome;

  const pack = await reviewPackage(project, id, outcome);
  S.recordBase(project, id, trunkSha, tree);
  S.patchTask(project, id, { status: 'review', ...pack });
  if (f.settings.autoLandLowRisk && pack.risk.level === 'low' && v.ok) {
    try { await landNow(project, id, 'auto'); return; } catch { /* stays in review for a person */ }
  }
  notify('review', project, S.getTask(project, id)!, `${pack.risk.level} risk · ${firstLine(pack.evidence.summary)}`);
}

type Prepared =
  | { ok: false; text: string }
  | { ok: true; trunkSha: string; tree: string; v: import('./verify.js').VerifyOutcome; base: string; trunk: string };

/** Rebase onto the current trunk and run the checks on the result. */
async function rebaseAndCheck(project: string, id: string, repo: string, wt: string): Promise<Prepared> {
  const trunk = S.load(project).settings.trunk;
  const rb = await G.rebaseOnto(wt, trunk);
  if (!rb.ok) {
    return { ok: false, text: rb.conflicts.length > 0
      ? `Rebase conflict against ${trunk} in: ${rb.conflicts.join(', ')}. Rebase this branch onto ${trunk} (git rebase ${trunk}), resolve the conflicts keeping both sides' intent, run the checks and submit again.`
      : `Rebase conflict against ${trunk}: ${rb.message || 'git could not rebase the branch'}. Fix the branch so it rebases cleanly and submit again.` };
  }
  const tree = await G.treeOf(wt);
  const trunkSha = await G.revParse(repo, trunk);
  if (!tree || !trunkSha) return { ok: false, text: `Checks failed: could not read the rebased tree or ${trunk}.` };
  const v = await verifyTree(project, insideWorktree(repo, project, wt), tree);
  if (!v.ok) {
    const f = v.failed!;
    return { ok: false, text: `Checks failed: ${f.name} (${f.command}) did not pass on the branch rebased onto ${trunk}.\n${f.tail ?? ''}`.slice(0, 6000) };
  }
  const base = (await G.mergeBase(wt, trunk, 'HEAD')) ?? trunkSha;
  return { ok: true, trunkSha, tree, v, base, trunk };
}

/** The evidence report, risk score and actual touches for a prepared branch. */
async function reviewPackage(project: string, id: string, o: Extract<Prepared, { ok: true }>): Promise<{ evidence: NonNullable<Task['evidence']>; risk: NonNullable<Task['risk']>; touches: NonNullable<Task['touches']> }> {
  const t = S.getTask(project, id)!;
  const wt = t.worktree!;
  const stats = await numstat(wt, o.base);
  const risk = await assessRisk({ project, worktree: wt, base: o.base, stats });
  const files = (await G.changedFiles(wt, o.base)).map(c => c.path);
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
export function land(project: string, id: string, by: 'person' | 'auto'): Promise<Task> {
  return serial(project, 'queue', () => landNow(project, id, by));
}

/** The landing itself, for a caller already inside the queue lane (the merge queue's own auto-land). */
async function landNow(project: string, id: string, by: 'person' | 'auto'): Promise<Task> {
  const t = S.getTask(project, id);
  if (!t) throw new DeliveryError(`no task ${id} on this board`, 404);
  if (t.status !== 'review') throw new DeliveryError(`task ${id} is ${t.status}; only a task in review can be approved`, 409);
  if (!t.worktree || !t.branch) throw new DeliveryError(`task ${id} has no branch to land`, 409);
  const repo = await repoOf(project);
  const trunk = S.load(project).settings.trunk;
  if (!(await G.revParse(repo, trunk))) throw new DeliveryError(`the trunk branch "${trunk}" does not exist in this project`, 409);
  const now = await G.revParse(repo, trunk);
  const reviewed = S.load(project).base.get(id);
  if (!reviewed || reviewed.trunkSha !== now) {
    const again = await rebaseAndCheck(project, id, repo, t.worktree);
    if (!again.ok) {
      await sendBack(project, id, `${again.text}\n(The trunk moved after review, so the branch was rebased and checked again before landing.)`);
      throw new DeliveryError(`the trunk moved and the branch no longer rebases cleanly or passes its checks; it was sent back for changes`, 409);
    }
    S.recordBase(project, id, again.trunkSha, again.tree);
    // Same patch on a newer trunk: the report and score describe the tree that will land.
    S.patchTask(project, id, await reviewPackage(project, id, again));
  }
  const before = await G.revParse(repo, trunk);
  const ff = await G.fastForward(repo, trunk, t.branch);
  if (!ff.ok) {
    throw new DeliveryError(`could not land on ${trunk}: ${ff.message || 'git refused'}. Check out ${trunk} in the project with no changes the merge would overwrite, then approve again.`, 409);
  }
  S.queueDrop(project, id);
  // What landed and where: release notes group by it, a rollback reverts exactly this range.
  const landedRange = before && ff.sha ? await G.logRange(repo, `${before}..${ff.sha}`) : [];
  const landed: NonNullable<Task['landed']> = {
    from: before ?? '', to: ff.sha ?? '', at: iso(config.now()), by, ...R.classifyCommits(landedRange),
  };
  S.patchTask(project, id, { status: 'merged', ...(before && ff.sha ? { landed } : {}) }, ['claim', 'needs']);
  S.addComment(project, id, by === 'person' ? 'person' : 'agent', by === 'person' ? 'Approved and landed.' : 'Landed automatically: low risk and its checks were green (the board setting autoLandLowRisk).');
  const kept = await removeWorktreeAndBranch(project, id);
  if (kept.keptBranch) S.addComment(project, id, 'agent', `Branch ${kept.keptBranch} was kept.`);
  notify('landed', project, S.getTask(project, id)!, by === 'person' ? 'approved by you' : 'landed automatically (low risk, checks green)');
  kick(project);
  return S.getTask(project, id)!;
}

export const approveTask = (project: string, id: string): Promise<Task> => land(path.resolve(project), id, 'person');

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

export async function taskDiff(project: string, id: string): Promise<string> {
  const p = path.resolve(project);
  const t = S.getTask(p, id);
  if (!t) throw new DeliveryError(`no task ${id} on this board`, 404);
  if (!t.worktree || !fs.existsSync(t.worktree)) {
    throw new DeliveryError(`task ${id} has no worktree${t.status === 'merged' ? ' (it was merged; see the trunk history)' : ''}`, 404);
  }
  const trunk = S.load(p).settings.trunk;
  const base = (await G.mergeBase(t.worktree, trunk, 'HEAD')) ?? trunk;
  return G.diffText(t.worktree, base);
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
      const merged = await G.git(['merge-base', '--is-ancestor', w.branch, f.settings.trunk], repo);
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
    if (f.dispatcher === 'running') S.setDispatcher(p, 'paused');
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

/** The directory a task's chat session was filed under (its worktree), so the server can reopen it after a restart or after the worktree is gone. */
export function sessionDirOf(sessionId: string): string | undefined {
  for (const p of S.journaledProjects()) {
    for (const t of S.load(p).tasks.values()) {
      if (t.sessionId === sessionId && t.worktree && fs.existsSync(eventLogPath(sessionId, t.worktree))) return t.worktree;
    }
  }
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
    const trunk = S.load(p).settings.trunk;
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
    const made = await G.worktreeAdd(repo, wt, branch, trunk);
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
    const base = await G.mergeBase(wt, trunk, 'HEAD');
    const files = base ? (await G.changedFiles(wt, base)).map(c => c.path) : [];
    const now = iso(config.now());
    const task: Task = {
      id, project: p, title: `Revert release ${rel.tag}`,
      body: `Reverts the ${shas.length} commit${shas.length === 1 ? '' : 's'} released in ${rel.tag}:\n${rel.tasks.map(t => `- ${t.title}`).join('\n') || '(commits since the previous release)'}\n\nCreated by a person from the Releases view; it goes through the same checks and review as any task.`,
      acceptance: [`The changes released in ${rel.tag} are undone on ${trunk} and the project's checks pass.`],
      status: 'running', priority: 1, dependsOn: [], labels: ['rollback', `release:${rel.version}`],
      branch, worktree: wt, touches: actualTouches(files), createdAt: now, updatedAt: now,
    };
    S.putTask(p, task);
    S.setRollback(p, version, id);
    S.addComment(p, id, 'agent', `Reverted ${shas.length} commit${shas.length === 1 ? '' : 's'} on this branch. The merge queue checks it next; a person lands it.`);
    S.queuePush(p, id);
    queuePrepare(p, id);
    return S.getTask(p, id)!;
  });
}
