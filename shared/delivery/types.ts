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
  risk?: { score: number; level: RiskLevel; reasons: string[] };
  review?: { comments: { at: string; by: 'person' | 'agent'; text: string }[] };
  /** Set while a run waits for a person; the card shows it and answers go through the chat's own routes. */
  needs?: TaskNeed;
  /** PR mode (ADR 0039): the remote's view of this task's pull request, refreshed by the poller. Present from `pr` on. */
  pr?: PullState;
  /** The remote work item this task was imported from or linked to (ADR 0039). */
  remote?: RemoteLink;
  /** Where the work landed on the trunk, for release notes and rollback. */
  landed?: { from: string; to: string; at: string; kind: ChangeKind; breaking: boolean; by: 'person' | 'auto' };
  costUsd?: number;
  /** Scrum mode (ADR 0039 section 4): story points, set by a person or accepted from an agent's proposal. */
  estimate?: number;
  /** The sprint the team committed this task to; cleared when a sprint closes without it. */
  sprintId?: string;
  createdAt: string;
  updatedAt: string;
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
  settings: { maxParallel: number; autoLandLowRisk: boolean; trunk: string; /** `kanban` when absent. */ mode?: BoardMode };
  dispatcher: DispatcherState;
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
