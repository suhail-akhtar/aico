/**
 * Work-item states by CATEGORY, the way Azure DevOps (and any tracker with workflow states)
 * is mapped to AICO's task states without ever matching a state by name (ADR 0039 section 2).
 *
 * WHY categories. A team's states are whatever their process says: Agile has New / Active /
 * Resolved / Closed, Scrum has New / Approved / Committed / Done, CMMI has Proposed / Active /
 * Resolved / Closed, Basic has To Do / Doing / Done, and an inherited process can rename or add
 * any of them. Every one of them belongs to one of five CATEGORIES (Proposed, InProgress,
 * Resolved, Completed, Removed), and the category is the only thing that means the same
 * everywhere. So the stored state map says "running -> InProgress" and the adapter finds
 * the work item type's own InProgress state at the moment it writes ("Active", "Committed",
 * "Doing"). Nothing here knows a state's name.
 *
 * Shared, with no imports, because the Connections page previews the mapping per process with
 * the very same function the engine uses to pick the state it will write. A preview computed by
 * different code from the write would be a lie waiting to happen.
 *
 * What it does not do: talk to a tracker, or decide when to move an item (sync.ts).
 *
 * @module shared/connections/process
 */

export type StateCategory = 'proposed' | 'inprogress' | 'resolved' | 'completed' | 'removed';

export interface TypeState { name: string; category: StateCategory }
export interface TypeStates { name: string; states: TypeState[] }

/** How far along each category is. `removed` is terminal like `completed` but is not "done". */
const RANK: Record<StateCategory, number> = { proposed: 0, inprogress: 1, resolved: 2, completed: 3, removed: 4 };

const WORDS: Record<string, StateCategory> = {
  proposed: 'proposed', inprogress: 'inprogress', 'in progress': 'inprogress', 'in-progress': 'inprogress',
  resolved: 'resolved', completed: 'completed', complete: 'completed', removed: 'removed',
};

/** The category a stored state-map value names ("InProgress", "Completed"), or undefined when it is a label or a plain state name. */
export function categoryWord(value: string | undefined): StateCategory | undefined {
  return value ? WORDS[value.trim().toLowerCase()] : undefined;
}

/** The words the page writes into a state map, in the tracker's own capitalisation. */
export const CATEGORY_LABEL: Record<StateCategory, string> = {
  proposed: 'Proposed', inprogress: 'InProgress', resolved: 'Resolved', completed: 'Completed', removed: 'Removed',
};

/** An unknown category word from a tracker (a newer API, a custom process) is read as `proposed`: never as done. */
export function normaliseCategory(raw: unknown): StateCategory {
  return typeof raw === 'string' ? WORDS[raw.trim().toLowerCase()] ?? 'proposed' : 'proposed';
}

export function categoryRank(c: StateCategory): number { return RANK[c]; }

/** Closed for AICO's purposes: Completed or Removed. `resolved` is still open work (awaiting verification). */
export function isClosedCategory(c: StateCategory): boolean { return c === 'completed' || c === 'removed'; }

/**
 * Does the item need to move to reach `target`? Forward only: an item already at or beyond the
 * category stays where a person left it, and a closed item is never reopened by AICO.
 */
export function needsMove(current: StateCategory | undefined, target: StateCategory): boolean {
  if (current === undefined) return true;
  if (isClosedCategory(current)) return false;
  return RANK[current] < RANK[target];
}

/**
 * The state of a work item type that stands for `target`: the first state of that category in
 * the order the process lists them ("Active" before a custom second in-progress state). A type
 * with no state of that category returns undefined and the caller says it cannot move the item;
 * it never substitutes a neighbouring category.
 */
export function pickState(states: readonly TypeState[], target: StateCategory): TypeState | undefined {
  return states.find(s => s.category === target);
}

/** The five default AICO -> category rows for a tracker with categories. Blocked stays a tag: it is not a workflow state. */
export const CATEGORY_STATE_MAP: Readonly<Record<string, string>> = Object.freeze({
  backlog: 'Proposed', ready: 'Proposed', running: 'InProgress', review: 'InProgress', pr: 'InProgress', merged: 'Completed', blocked: 'aico:blocked',
});

export type ProcessName = 'Agile' | 'Scrum' | 'CMMI' | 'Basic' | 'Custom';

/**
 * Which of Microsoft's four processes a project uses, from the names of its work item types.
 * Only a label for the page; nothing is decided by it (the categories do that). An inherited
 * process keeps its parent's type names, so it reads as the parent.
 */
export function detectProcess(typeNames: readonly string[]): ProcessName {
  const has = (n: string): boolean => typeNames.some(t => t.toLowerCase() === n);
  if (has('product backlog item')) return 'Scrum';
  if (has('requirement') && has('change request')) return 'CMMI';
  if (has('user story')) return 'Agile';
  if (has('issue') && has('epic') && !has('bug')) return 'Basic';
  if (has('issue') && has('task')) return 'Basic';
  return 'Custom';
}

/** The fields that carry an estimate, in the order they are preferred. */
export const POINTS_FIELDS: readonly string[] = ['Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.Size'];

export interface StatePreviewRow {
  /** AICO's state: backlog, ready, running, review, pr, merged, blocked. */
  aico: string;
  /** What the map says for it. */
  value: string;
  /** `category` when the value names a category, otherwise it is a tag AICO adds. */
  kind: 'category' | 'tag';
  category?: StateCategory;
  /** The state each work item type would be moved to. */
  perType: Array<{ type: string; state: string | null }>;
}

/** The rows of the page's process-aware preview, from the stored map and the project's types. */
export function previewStateMap(stateMap: Readonly<Record<string, string>>, types: readonly TypeStates[], rows: readonly string[]): StatePreviewRow[] {
  return rows.map(aico => {
    const value = (stateMap[aico] ?? CATEGORY_STATE_MAP[aico] ?? '').trim();
    const category = categoryWord(value);
    if (!category) return { aico, value, kind: 'tag', perType: [] };
    return {
      aico, value, kind: 'category', category,
      perType: types.map(t => ({ type: t.name, state: pickState(t.states, category)?.name ?? null })),
    };
  });
}
