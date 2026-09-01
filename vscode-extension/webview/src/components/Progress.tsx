/**
 * What the agent said it would do, and how far it has got.
 *
 * The browser client has had this since the beginning — a task list and a plan
 * beside the conversation — and the panel shipped without either, so a run in
 * VS Code was a wall of prose with no visible shape. Copilot and Codex both put
 * progress on screen for the same reason: a long turn with no structure gives a
 * reader nothing to check against, and no way to tell "working" from "lost".
 *
 * Derived from the transcript, not from a second source. `todosFrom` is the
 * browser client's own pure function, imported unchanged — so the two surfaces
 * cannot disagree about what the agent committed to. The plan is the other half
 * and lives next door in `PlanCard`, because a task list is a report and a plan
 * is a question, and the two want different chrome.
 *
 * ## Two behaviours worth stating
 *
 * **It collapses when it is resolved.** A finished list becomes one line. A
 * panel that keeps a completed checklist at full height is spending the reader's
 * screen on something that has stopped being a question.
 *
 * **"All done" is never claimed for a list that was abandoned.** A run that
 * cancelled four of five tasks reads `1 done · 4 cancelled`, because conflating
 * those is how a task list becomes a formality.
 *
 * @module components/Progress
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '@web/store';
import { composeMessages } from '@web/reduce';
import { todosFrom, type Todo, type TodoStatus } from '@web/todos';

/** One glyph per state. Shape, not colour — a 10px dot is not a status. */
const MARK: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '◐',
  done: '✓',
  cancelled: '✕',
};

const TONE: Record<TodoStatus, string> = {
  pending: 'text-aico-muted',
  in_progress: 'text-aico-accent',
  done: 'text-aico-success',
  cancelled: 'text-aico-muted',
};

/** Rows shown while the list is open. Beyond this it is a scroll, not a glance. */
const VISIBLE = 8;

export function Progress(): React.ReactElement | null {
  const logged = useStore(s => s.logged);
  const draft = useStore(s => s.draft);
  const busy = useStore(s => s.busy);

  const [open, setOpen] = useState(true);
  /** Dismissed by signature, so a genuinely new list comes back on its own. */
  const [dismissed, setDismissed] = useState<string | null>(null);

  const summary = useMemo(
    () => todosFrom(composeMessages(logged, draft, busy)),
    [logged, draft, busy],
  );

  if (summary.total === 0) return null;
  if (summary.retired) return null;
  if (dismissed === summary.signature) return null;

  const settled = summary.allSettled;
  const shown = open ? summary.todos.slice(0, VISIBLE) : [];

  return (
    <div className="shrink-0 border-t border-aico-border-subtle">
      <div className="flex items-center gap-1.5 px-3 py-1">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={open}
        >
          <span className="text-[9px] text-aico-muted">{open ? '▾' : '▸'}</span>
          <span className="truncate text-[11px] text-aico-secondary">
            {headline(summary)}
          </span>
        </button>

        {/*
          Dismissing is offered only once the work has settled. Closing a live
          checklist hides the one thing on screen that says what is happening.
        */}
        {settled && (
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss this list"
            onClick={() => setDismissed(summary.signature)}
            className="shrink-0 text-[11px] text-aico-muted hover:text-aico-primary"
          >
            ✕
          </button>
        )}
      </div>

      {open && (
        <ul className="max-h-[30vh] overflow-y-auto px-3 pb-1.5">
          {shown.map((todo: Todo) => (
            <li key={todo.id} className="flex items-start gap-1.5 py-[1px]">
              <span className={`shrink-0 text-[10px] leading-[16px] ${TONE[todo.status]}`}>
                {MARK[todo.status]}
              </span>
              <span
                className={[
                  'min-w-0 flex-1 text-[11px] leading-[16px]',
                  todo.status === 'done' || todo.status === 'cancelled'
                    ? 'text-aico-muted'
                    : 'text-aico-primary',
                  todo.status === 'cancelled' ? 'line-through' : '',
                ].join(' ')}
              >
                {todo.title}
              </span>
            </li>
          ))}
          {summary.todos.length > VISIBLE && (
            <li className="pt-0.5 text-[10px] text-aico-muted">
              …and {summary.todos.length - VISIBLE} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * The one line the collapsed list has to earn its place with.
 *
 * "All done" is reserved for a list that genuinely finished. A run that
 * cancelled most of its work reports both numbers, because a summary that
 * rounds those together is how a task list stops meaning anything.
 */
function headline(s: ReturnType<typeof todosFrom>): string {
  if (s.allSettled) {
    if (s.cancelled > 0) return `${s.done} done · ${s.cancelled} cancelled`;
    return `All done · ${s.done} task${s.done === 1 ? '' : 's'}`;
  }
  const current = s.todos.find(t => t.status === 'in_progress');
  const progress = `${s.closed}/${s.total}`;
  return current ? `${progress} · ${current.title}` : `${progress} tasks`;
}
