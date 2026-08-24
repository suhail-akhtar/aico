/**
 * The task list, derived rather than fetched.
 *
 * The agent's list already travels through the message stream: every
 * `TodoWrite` call carries the whole list in its arguments, and the tool
 * replaces it wholesale on each call. So the current state is simply the last
 * one that went past — no endpoint, no polling, no second source that can
 * disagree with the transcript.
 *
 * That matters beyond tidiness. A panel fed by its own request can show a list
 * the conversation contradicts; one derived from the log cannot, because it *is*
 * the log. It also replays for free: reopening a finished session rebuilds the
 * final list from the same events, in the same order, with no server involved.
 *
 * @module todos
 */

import type { ChatMessage } from '@aico/ui';

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface Todo {
  id: string;
  title: string;
  status: TodoStatus;
  priority: 'high' | 'medium' | 'low';
}

export interface TodoSummary {
  todos: Todo[];
  done: number;
  cancelled: number;
  inProgress: number;
  pending: number;
  /** Everything that is not still open — done or deliberately abandoned. */
  closed: number;
  total: number;
  /** True when there is nothing left open and there was something to begin with. */
  allSettled: boolean;
  /**
   * Identity of this particular list.
   *
   * Dismissing a panel means "I have seen this one", not "never show me a task
   * list again". Keyed on the titles and their states, so the panel returns the
   * moment the work actually changes and stays gone while it does not.
   */
  signature: string;
  /**
   * The reader has retired this list — marked it finished or dropped what was
   * left — and the agent has been told so.
   *
   * Separate from `allSettled`, which is the agent's own account of the work.
   * This one is the reader overruling it, and it is what lets a stale list stop
   * following the conversation around.
   */
  retired: boolean;
}

/**
 * What retiring a task list says, in the reader's own voice.
 *
 * These are sent as real user messages, exactly like the plan replies, for the
 * same reason: the agent has to *know*, not merely be hidden from. A panel that
 * disappeared while the agent carried on working from the list it could still
 * see would be worse than no button at all — the work would continue and the
 * one place it was visible would be gone.
 *
 * Matched back on replay, which is how the panel stays retired across a reload
 * without a second store to keep in step with the transcript.
 */
export const TASK_REPLY = {
  /** Everything on it is finished, whatever the individual states still say. */
  completed: 'Treat every task on that list as complete. Update the task list to '
    + 'match, and do not carry any of it forward as outstanding work.',
  /** Called off. What is done is done; what is left is not going to happen. */
  dropped: 'Drop the rest of that task list — the remaining items are cancelled '
    + 'and should not be worked on. Update the task list to match.',
} as const;

const STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'done', 'cancelled']);

/** One entry, or nothing if the shape is not what it claims. */
function readTodo(raw: unknown, index: number): Todo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const title = typeof t.title === 'string' ? t.title
    : typeof t.content === 'string' ? t.content
    : undefined;
  if (!title) return undefined;
  // A model can emit a status nobody defined. Treating an unknown one as
  // pending is the safe direction: it keeps the item visible and keeps the
  // list honestly unfinished, rather than quietly counting it as done.
  const status = STATUSES.has(t.status as TodoStatus) ? t.status as TodoStatus : 'pending';
  const priority = t.priority === 'high' || t.priority === 'low' ? t.priority : 'medium';
  return { id: String(t.id ?? index + 1), title, status, priority };
}

/**
 * The current task list, from the last TodoWrite in the transcript.
 *
 * Read backwards and stop at the first one: `TodoWrite` replaces the list
 * wholesale, so the newest call is the whole answer and merging earlier ones
 * would resurrect items the agent has since dropped.
 */
export function todosFrom(messages: ChatMessage[]): TodoSummary {
  let todos: Todo[] = [];
  let listAt = -1;
  let retiredAt = -1;

  // Two backward scans rather than one, because they stop at different places:
  // the list is the *last* TodoWrite, while the retirement is the last time the
  // reader said so — which may be either side of it, and which side decides
  // whether the list is live.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.type !== 'tool' || message.toolName !== 'TodoWrite') continue;
    const raw = (message.toolArgs as Record<string, unknown> | undefined)?.todos;
    if (!Array.isArray(raw)) continue;
    todos = raw.map(readTodo).filter((t): t is Todo => t !== undefined);
    listAt = i;
    break;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.type === 'user' && retires(message.content)) { retiredAt = i; break; }
  }

  const count = (status: TodoStatus): number => todos.filter(t => t.status === status).length;
  const done = count('done');
  const cancelled = count('cancelled');
  const inProgress = count('in_progress');
  const pending = count('pending');

  return {
    todos,
    done,
    cancelled,
    inProgress,
    pending,
    closed: done + cancelled,
    total: todos.length,
    allSettled: todos.length > 0 && inProgress + pending === 0,
    signature: todos.map(t => `${t.id}:${t.status}:${t.title}`).join('|'),
    // Retired if the reader said so after the list was written, or if they said
    // so at all and the agent's answer was to close everything out. That second
    // clause is what stops the panel bouncing back to say "all done" one turn
    // after being retired — while still returning the moment genuinely new work
    // appears, because new work is not settled.
    retired: retiredAt !== -1
      && (retiredAt > listAt || (todos.length > 0 && inProgress + pending === 0)),
  };
}

/** Whether a message is one of the retiring phrases above. */
function retires(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(TASK_REPLY.completed) || trimmed.startsWith(TASK_REPLY.dropped);
}
