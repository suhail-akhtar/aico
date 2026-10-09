/**
 * The Delivery contract as the clients read it.
 *
 * WHY a re-export: the wire types live in shared/delivery/types.ts (ADR 0038)
 * so the engine and every client import one definition and cannot drift. This
 * file only adds the names the UI used before that file existed
 * (`Priority`) and the one shape that is a request, not a fold: the body of
 * `POST /api/delivery/tasks`.
 *
 * Timestamps on the wire are ISO strings; the UI reads them through `toMs` in
 * delivery-model.ts, which also tolerates epoch numbers.
 *
 * @module web/delivery-types
 */

export type {
  AttentionSnapshot, BatchResult, BoardState, ChangeKind, DispatcherState, Release, ReleasePlan, RiskLevel, Task, TaskNeed,
  TaskPriority as Priority, TaskStatus,
} from '../../shared/delivery/types';

import type { TaskPriority } from '../../shared/delivery/types';

export interface NewTaskInput {
  project: string;
  title: string;
  body?: string;
  acceptance?: string[];
  priority?: TaskPriority;
  dependsOn?: string[];
  labels?: string[];
}
