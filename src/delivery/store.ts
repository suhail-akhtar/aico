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
import { applyScrum, emptyScrum, openProposals, overlayScrum, sprintList, type ScrumEvent, type ScrumFold } from './scrum-fold.js';
import type { BoardState, DispatcherState, Release, Task } from './types.js';

export const DEFAULT_MAX_PARALLEL = 2;
export const MAX_PARALLEL_CAP = 4;

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
  | { t: 'task'; at: string; task: Task }
  | { t: 'patch'; at: string; id: string; set?: Partial<Task>; unset?: Array<keyof Task> }
  | { t: 'comment'; at: string; id: string; by: 'person' | 'agent'; text: string }
  | { t: 'queue'; at: string; op: 'push' | 'drop'; id: string }
  | { t: 'start'; at: string; id: string; runId: string }
  | { t: 'settings'; at: string; set: Partial<BoardSettings> }
  | { t: 'dispatcher'; at: string; state: DispatcherState }
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
    settings: { maxParallel: DEFAULT_MAX_PARALLEL, autoLandLowRisk: false, trunk },
    dispatcher: 'idle',
    checks: new Map(),
    base: new Map(),
    releases: new Map(),
    scrum: emptyScrum(),
  };
}

function apply(f: Folded, ev: JournalEvent): void {
  switch (ev.t) {
    case 'init':
      f.project = ev.project;
      if (ev.trunk) f.settings.trunk = ev.trunk;
      return;
    case 'task':
      f.tasks.set(ev.task.id, structuredClone(ev.task));
      return;
    case 'patch': {
      const task = f.tasks.get(ev.id);
      if (!task) return;
      Object.assign(task, ev.set ?? {});
      for (const k of ev.unset ?? []) delete (task as unknown as Record<string, unknown>)[k];
      task.updatedAt = ev.at;
      return;
    }
    case 'comment': {
      const task = f.tasks.get(ev.id);
      if (!task) return;
      task.review = { comments: [...(task.review?.comments ?? []), { at: ev.at, by: ev.by, text: ev.text }] };
      task.updatedAt = ev.at;
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
      if (ev.set.maxParallel !== undefined) f.settings.maxParallel = clampParallel(ev.set.maxParallel);
      if (ev.set.autoLandLowRisk !== undefined) f.settings.autoLandLowRisk = ev.set.autoLandLowRisk === true;
      if (ev.set.trunk) f.settings.trunk = ev.set.trunk;
      return;
    case 'dispatcher':
      f.dispatcher = ev.state;
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

export function boardState(project: string): BoardState {
  const f = load(project);
  const running = f.tasks.size === 0 ? [] : [...f.tasks.values()]
    .filter(t => t.status === 'running' && t.claim)
    .map(t => ({ taskId: t.id, runId: t.claim!.runId, startedAt: f.runStarted.get(t.id) ?? t.updatedAt, costUsd: t.costUsd ?? 0 }));
  return {
    project: f.project || path.resolve(project),
    tasks: [...f.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(t => structuredClone(t)),
    queue: [...f.queue],
    running,
    // A board that never used Scrum reads exactly as it did before: the Scrum keys appear with the first Scrum fact.
    settings: { ...f.settings, ...(f.scrum.mode === 'scrum' ? { mode: 'scrum' as const } : {}) },
    dispatcher: f.dispatcher,
    ...(f.scrum.sprints.size > 0 ? { sprints: sprintList(f.scrum) } : {}),
    ...(f.scrum.proposals.size > 0 ? { proposals: openProposals(f.scrum) } : {}),
    releases: [...f.releases.values()].sort((a, b) => b.at.localeCompare(a.at) || b.version.localeCompare(a.version)).map(r => structuredClone(r)),
  };
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

export function putTask(project: string, task: Task): void { append(project, { t: 'task', at: iso(), task }); }

export function patchTask(project: string, id: string, set: Partial<Task>, unset: Array<keyof Task> = []): void {
  append(project, { t: 'patch', at: iso(), id, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) });
}

export function addComment(project: string, id: string, by: 'person' | 'agent', text: string): void {
  append(project, { t: 'comment', at: iso(), id, by, text: text.slice(0, 8000) });
}

export function queuePush(project: string, id: string): void { append(project, { t: 'queue', at: iso(), op: 'push', id }); }
export function queueDrop(project: string, id: string): void { append(project, { t: 'queue', at: iso(), op: 'drop', id }); }
export function markStart(project: string, id: string, runId: string): void { append(project, { t: 'start', at: iso(), id, runId }); }
export function setSettings(project: string, set: Partial<BoardSettings>): void { append(project, { t: 'settings', at: iso(), set }); }
export function setDispatcher(project: string, state: DispatcherState): void { append(project, { t: 'dispatcher', at: iso(), state }); }
export function recordChecks(project: string, tree: string, ok: boolean, results: CheckRecord[]): void { append(project, { t: 'checks', at: iso(), tree, ok, results }); }
export function recordBase(project: string, id: string, trunkSha: string, tree: string): void { append(project, { t: 'base', at: iso(), id, trunkSha, tree }); }
export function putRelease(project: string, release: Release): void { append(project, { t: 'release', at: iso(), release }); }
export function setDeploy(project: string, version: string, deploy: NonNullable<Release['deploy']>): void { append(project, { t: 'deploy', at: iso(), version, deploy }); }
export function recordScrum(project: string, ev: ScrumEvent): void { append(project, { t: 'scrum', at: iso(), ev }); }
export function setRollback(project: string, version: string, taskId: string): void { append(project, { t: 'rollback', at: iso(), version, taskId }); }
