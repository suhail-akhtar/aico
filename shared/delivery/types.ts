/**
 * Delivery's wire contract: the task board every client draws and the engine folds
 * from its journal (ADR 0038).
 *
 * Lives in `shared/` because the web, desktop and VS Code clients import it and the
 * engine must not be able to drift from what they read: `src/delivery/types.ts`
 * re-exports this file instead of copying it. Types only — no code, no runtime imports —
 * so any client can use it without pulling the engine in. (The one import is a type-only
 * one from the sibling Connections contract, for `Task.pr` and `Task.remote`, ADR 0039.)
 *
 * Deliberately not here: the journal's event shapes (engine-private; a client
 * sees the fold, never the events) and anything about how a task is run.
 *
 * @module shared/delivery/types
 */

import type { PullState, RemoteLink, BoardConnection } from '../connections/types.js';
import type { BoardMode, Proposal, Sprint } from './scrum.js';

export type TaskStatus =
  | 'backlog' | 'ready' | 'running' | 'review' | 'changes' | 'pr' | 'merged' | 'blocked' | 'cancelled';

export type TaskPriority = 1 | 2 | 3 | 4;

export type RiskLevel = 'low' | 'medium' | 'high';

/** What kind of work a task is (a label for the board and its filters; nothing is scheduled by it). */
export type TaskType = 'feature' | 'bug' | 'chore' | 'spike' | 'docs';

/**
 * How much of the board's routine the engine may do without a person (ADR 0038, "Autonomy levels").
 * Ordered: each level can do everything the one before it can. `manual` is the default.
 */
export type Autonomy = 'manual' | 'assisted' | 'autonomous' | 'full';

/** Who or what is working on a task: a person's name, or one of the board's agent slots ("Agent A".."Agent D"). */
export interface Assignee { kind: 'agent' | 'person'; name: string }

/** One line of a task's (or the board's) history. `by: 'system'` is the engine acting on a rule, never on a model's word. */
export interface ActivityEntry { at: string; kind: string; by: 'person' | 'agent' | 'system'; text: string }

/** What a landed change is, from its Conventional Commit types (the highest wins: feat over fix over the rest). */
export type ChangeKind = 'feat' | 'fix' | 'perf' | 'refactor' | 'docs' | 'test' | 'chore' | 'other';

/**
 * What a task's run is waiting for a person to do, read from the run's chat session
 * (a question, a permission prompt) or the approve-later inbox (a parked call).
 * The answer goes through the route that already exists for that kind: the chat's
 * `answer`, its `permission`, or `inbox/decide` — Delivery adds no second way to say yes.
 */
export interface TaskNeed {
  /** `question`: the agent asked; `permission`: a tool call waits for a yes; `approval`: a call was parked in the inbox. */
  kind: 'question' | 'permission' | 'approval';
  /** The question, or what is being asked to allow ("Bash: npm publish"). */
  prompt: string;
  detail?: string;
  /** `permission`: the pending request id; `approval`: the inbox action id. */
  ref?: string;
  tool?: string;
  /** ISO time the wait began. */
  since: string;
}

export interface Task {
  id: string;
  /** The registered project this task belongs to (absolute path). */
  project: string;
  title: string;
  body: string;
  acceptance: string[];
  status: TaskStatus;
  /** 1 is the most urgent. */
  priority: TaskPriority;
  /** Task ids that must be `merged` before this one starts. */
  dependsOn: string[];
  labels: string[];
  /**
   * The live run. `runId` names the run in the engine's runner; when the run is a chat
   * session (the app's runner) `sessionId` is that chat, and it is what "Session" opens.
   */
  claim?: { runId: string; sessionId?: string; leaseUntil: string };
  /** The chat of the task's latest run; kept after the claim is gone so a finished task still links to it. */
  sessionId?: string;
  /** `aico/task-<id>` once a run has started. */
  branch?: string;
  worktree?: string;
  touches?: { files: string[]; symbols: string[]; predicted: boolean };
  evidence?: { md: string; summary: string };
  risk?: {
    score: number; level: RiskLevel; reasons: string[];
    /**
     * Findings that keep a change away from every automatic landing, whatever its score: `secret` (a possible
     * credential in the added lines), `test-tamper` (a test weakened), `code-high` (a high-severity code rule).
     * Absent on a board journaled before they were recorded; the engine then treats the change as unflagged
     * only if its reasons name none of them.
     */
    flags?: Array<'secret' | 'test-tamper' | 'code-high'>;
  };
  review?: { comments: { at: string; by: 'person' | 'agent'; text: string }[] };
  /** Set while a run waits for a person; the card shows it and answers go through the chat's own routes. */
  needs?: TaskNeed;
  /** PR mode (ADR 0039): the remote's view of this task's pull request, refreshed by the poller. Present from `pr` on. */
  pr?: PullState;
  /** The remote work item this task was imported from or linked to (ADR 0039). */
  remote?: RemoteLink;
  /** Where the work landed on the trunk, for release notes and rollback. */
  landed?: {
    from: string; to: string; at: string; kind: ChangeKind; breaking: boolean; by: 'person' | 'auto';
    /** Set when the engine landed it on its own rule: which autonomy level, what the evidence and risk were, in one line each. */
    decision?: { autonomy: Autonomy; risk: RiskLevel; score: number; evidence: string; reason: string };
  };
  costUsd?: number;
  /** Scrum mode (ADR 0039 section 4): story points, set by a person or accepted from an agent's proposal. */
  estimate?: number;
  /** The sprint the team committed this task to; cleared when a sprint closes without it. */
  sprintId?: string;
  createdAt: string;
  updatedAt: string;

  // ── a real board's fields (ADR 0038, "A board you can run a team from"). Always present on a task read from `boardState`. ──
  /** A person's name, or the agent slot a run was given when it started (kept after, so a finished card still says who did it). */
  assignee?: Assignee;
  /** `YYYY-MM-DD`. */
  dueDate?: string;
  /**
   * Order within a column; lower first. The dispatcher starts ready tasks by rank, then priority. A new task's rank is
   * `priority * 1_000_000 + n`, so an untouched board still runs most-urgent first; dragging reassigns ranks among the dragged cards.
   */
  rank: number;
  type?: TaskType;
  /** An epic (another task on this board) this task belongs to. The epic shows `children`. */
  parentId?: string;
  /** The tasks in `dependsOn` that are not merged yet, with where each is now. Empty (absent) when nothing blocks it. */
  blockedBy?: { id: string; status: TaskStatus }[];
  /** Why a ready task is not running right now, in one sentence (dependencies, overlap, WIP, budget, pause ...). Derived. */
  waitingReason?: string;
  /** What the running agent is doing this moment (derived from its session, never journaled per step). */
  live?: { summary: string; at: string; tokens?: number };
  /** The number of files in the diff the Changes tab shows: committed plus, while it runs, uncommitted. Never a prediction. */
  changeCount: number;
  /** The chat of the task's latest run; same as `sessionId`, in the shape the client links by. */
  session?: { id: string };
  /** Every run's chat, oldest first, with the stage the task was in when it started. */
  sessions?: { id: string; at: string; stage: TaskStatus }[];
  /** The latest history lines (30 on the board; `GET /api/delivery/tasks/:id/activity` has up to 200). */
  activity: ActivityEntry[];
  /** On an epic: how its children stand. */
  children?: { total: number; merged: number; running: number; review: number };
  /** Set while a landing was refused because files in the project's checkout are in the way; cleared when resolved or retried. */
  landingBlock?: { at: string; files: Array<{ path: string; why: 'untracked' | 'modified' }>; choices: Array<'keep-mine' | 'take-task'> };
}

export type DispatcherState = 'idle' | 'running' | 'paused';

/** A release the board made: a version bump commit and an annotated tag on the trunk, local only. */
export interface Release {
  version: string;
  /** `v` + version. */
  tag: string;
  /** The commit the tag points at. */
  commit: string;
  at: string;
  bump: 'major' | 'minor' | 'patch' | 'none';
  /** Markdown release notes, from the tasks' evidence summaries. */
  notes: string;
  tasks: Array<{ id: string; title: string; kind: ChangeKind; breaking: boolean; summary?: string }>;
  /** Files the release commit changed (a version file, CHANGELOG.md). */
  files: string[];
  deploy?: { state: 'running' | 'ok' | 'failed'; at: string; command: string; source: 'app' | 'setting'; tail?: string };
  /** The task that reverts this release's commits, once one was made. */
  rollback?: { taskId: string; at: string };
}

/** What a release would be if it were made now (a read; nothing is written). */
export interface ReleasePlan {
  trunk: string;
  /** The newest `v<semver>` tag reachable from the trunk. */
  lastTag?: string;
  lastVersion?: string;
  /** The version the bump starts from: the last tag or the project's version file, whichever is higher. */
  baseVersion?: string;
  /** Project version files that will be updated (package.json, pyproject.toml …); empty means tag only. */
  versionFiles: string[];
  next?: { version: string; bump: 'major' | 'minor' | 'patch' | 'none'; reason: string };
  /** Merged board tasks not yet in a release. */
  tasks: Array<{ id: string; title: string; kind: ChangeKind; breaking: boolean; summary?: string }>;
  /** Commits on the trunk since the last tag that did not come from the board. */
  other: Array<{ sha: string; subject: string }>;
  commitCount: number;
  /** Markdown preview of the notes for `next`. */
  notes: string;
  deploy: { available: boolean; source: 'app' | 'setting' | 'none'; command?: string; why?: string };
  /** Reasons a release cannot be made right now (nothing to release, trunk not clean …). */
  blockers: string[];
}

export interface BoardState {
  project: string;
  tasks: Task[];
  /** Task ids awaiting landing, in order. */
  queue: string[];
  running: { taskId: string; runId: string; startedAt: string; costUsd: number }[];
  settings: {
    maxParallel: number; autoLandLowRisk: boolean; trunk: string; /** `kanban` when absent. */ mode?: BoardMode;
    /** What the engine may do without a person. Changing it above `manual` is a person's act. Default `manual`. */
    autonomy: Autonomy;
    /** Work-in-progress limits per column; the dispatcher starts nothing past them. Absent: only `maxParallel` limits. */
    wip: { running?: number; review?: number };
    /** The most the board may spend in a (local) day. The dispatcher pauses itself when it is reached. Default 10. */
    budgetUsdPerDay: number;
    /** Consecutive failed or sent-back tasks after which the dispatcher pauses itself. Default 3. */
    pauseAfterFailures: number;
    /** Saved filters (a name and the filter string the client applies). */
    views: { name: string; filter: string }[];
  };
  dispatcher: DispatcherState;
  /** The autonomy in force: the setting, lowered to what the organisation's policy allows. */
  autonomy: Autonomy;
  /** Present when the organisation's policy limits autonomy below `full`: the highest level it allows. */
  autonomyCap?: Autonomy;
  /** Why ready tasks are not being picked up, when that is so ("2 ready tasks wait for ... which are in Backlog"). */
  idleReason?: string;
  /** Why the dispatcher paused itself (daily budget, too many failures, a restart), until a person starts it again. */
  pausedBecause?: string;
  metrics: {
    medianCycleMs: number | null; medianLeadMs: number | null; throughput7d: number; spentTodayUsd: number;
    /** Tasks running or in review now. */
    wipNow: number;
    /** How long tasks have been in their column: the count and the oldest and median age, for the columns where waiting matters. */
    byStatusAgeing: Partial<Record<TaskStatus, { count: number; oldestMs: number; medianMs: number }>>;
  };
  /** The board's agent slots and what each is doing. */
  agents: { name: string; taskId?: string; summary?: string; state: 'idle' | 'working' | 'waiting' }[];
  /** The last 100 events across the board, newest last. */
  feed: { at: string; taskId?: string; kind: string; text: string }[];
  /** Releases this board made, newest first. */
  releases: Release[];
  /** The project's connection to a forge and tracker, when it has one (ADR 0039); added by the route, not the fold. */
  connection?: BoardConnection;
  /** Scrum (ADR 0039 section 4): every sprint, with its scope log, and the agent's open suggestions. Absent on an engine that predates it. */
  sprints?: Sprint[];
  proposals?: Proposal[];
}

/** Compact cross-project snapshot for notifications: what changed state is the client's diff. */
export interface AttentionSnapshot {
  boards: Array<{
    project: string;
    name: string;
    tasks: Array<{ id: string; title: string; status: TaskStatus; needs: boolean; kind?: TaskNeed['kind'] }>;
  }>;
}

export interface BatchResult {
  /** Ids that landed, in order. */
  landed: string[];
  /** Ids not landed and why (not low risk, not green, sent back after the trunk moved …). */
  skipped: Array<{ id: string; reason: string }>;
}
