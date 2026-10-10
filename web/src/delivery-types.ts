/**
 * The Delivery contract as the clients read it.
 *
 * WHY a re-export: the wire types live in shared/delivery/types.ts (ADR 0038)
 * so the engine and every client import one definition and cannot drift. This
 * file only adds the names the UI used before that file existed
 * (`Priority`), the small shapes the board's parts pass around, and the one
 * shape that is a request, not a fold: the body of `POST /api/delivery/tasks`.
 *
 * Timestamps on the wire are ISO strings; the UI reads them through `toMs` in
 * delivery-model.ts, which also tolerates epoch numbers.
 *
 * @module web/delivery-types
 */

export type {
  ActivityEntry, Assignee, AttentionSnapshot, Autonomy, BatchResult, BoardState, ChangeKind, DispatcherState, Release, ReleasePlan, RiskLevel, Task,
  TaskNeed, TaskPriority as Priority, TaskStatus, TaskType,
} from '../../shared/delivery/types';

import type { Assignee, BoardState, TaskPriority, TaskType } from '../../shared/delivery/types';

export type BoardSettings = BoardState['settings'];
export type SavedView = BoardSettings['views'][number];
export type BoardAgent = BoardState['agents'][number];
export type FeedEntry = BoardState['feed'][number];
export type BoardMetrics = BoardState['metrics'];
export type BlockedBy = NonNullable<import('../../shared/delivery/types').Task['blockedBy']>[number];

/** A refused landing, as the engine now reports it (code + the files in the way + what the person may choose). */
export interface LandingError { code: string; message: string; files?: string[]; choices?: string[] }

export interface NewTaskInput {
  project: string;
  title: string;
  body?: string;
  acceptance?: string[];
  priority?: TaskPriority;
  dependsOn?: string[];
  labels?: string[];
  type?: TaskType;
  parentId?: string;
  assignee?: Assignee;
  dueDate?: string;
  estimate?: number;
  /** Put it straight in this column (quick-add from a column's header). */
  status?: 'backlog' | 'ready';
}
