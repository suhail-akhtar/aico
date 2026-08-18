/**
 * What the agent said it would do, and how far it has got.
 *
 * The task list existed only as tool rows scrolling past — "Updated todos, 6
 * lines" — so following a long piece of work meant scrolling back to the last
 * one and reading a wall of text to find what was left. The list is the plan;
 * it belongs somewhere fixed, where the answer to "what is left" costs a glance
 * rather than a search.
 *
 * Derived from the transcript rather than fetched, so it cannot disagree with
 * the conversation above it. See {@link ../todos}.
 *
 * **It stays quiet when there is nothing to say.** Most turns have no task list
 * at all; a panel that is always there, usually empty, is a permanent tax on the
 * width for an occasional benefit.
 *
 * **"All done" is a claim, not a conclusion.** When every item is closed the
 * panel says so — and says how, because a list finished by cancelling half of
 * it is not the same as one finished by doing it. That distinction is exactly
 * what a green tick hides, and hiding it is how a task list becomes a
 * formality.
 *
 * @module components/TaskPanel
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { todosFrom, type Todo, type TodoStatus } from '../todos';
import { orderMessages } from '../reduce';

/** How each state reads at a glance. */
const MARKS: Record<TodoStatus, { glyph: string; tone: string; label: string }> = {
  done: { glyph: '✓', tone: 'text-aico-success', label: 'done' },
  in_progress: { glyph: '◐', tone: 'text-aico-accent', label: 'in progress' },
  pending: { glyph: '○', tone: 'text-aico-muted', label: 'to do' },
  // Not a failure and not an achievement. Muted, struck through, and still
  // visible: an item quietly dropped is the one worth being able to see.
  cancelled: { glyph: '⊘', tone: 'text-aico-muted', label: 'cancelled' },
};

function TodoRow({ todo }: { todo: Todo }): React.ReactElement {
  const mark = MARKS[todo.status];
  return (
    <li className="flex items-start gap-2 py-[3px]">
      <span className={`mt-[1px] shrink-0 text-[12px] ${mark.tone} ${
        todo.status === 'in_progress' ? 'aico-thinking' : ''}`} aria-hidden>
        {mark.glyph}
      </span>
      <span
        className={`min-w-0 flex-1 text-[12px] leading-[18px] ${
          todo.status === 'done' ? 'text-aico-muted'
            : todo.status === 'cancelled' ? 'text-aico-muted line-through'
            : 'text-aico-secondary'
        }`}
      >
        {todo.title}
      </span>
      <span className="sr-only">{mark.label}</span>
    </li>
  );
}

export function TaskPanel(): React.ReactElement | null {
  const logged = useStore(s => s.logged);
  const busy = useStore(s => s.busy);
  const [collapsed, setCollapsed] = useState(false);

  const summary = useMemo(() => todosFrom(orderMessages(logged)), [logged]);

  // Nothing to show is the common case, and a permanently empty panel is a
  // permanent cost for an occasional benefit.
  if (summary.total === 0) return null;

  const { closed, total, inProgress, pending, cancelled, done } = summary;
  const pct = Math.round((closed / total) * 100);

  return (
    <div className="mx-auto w-full max-w-column px-5 pb-2">
      <div className="rounded-xl border border-aico-border bg-aico-panel px-3 py-2">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="group flex w-full items-center gap-2 text-left"
          aria-expanded={!collapsed}
        >
          <span className="text-[12px] font-medium text-aico-secondary">Tasks</span>

          <span className="tabular-nums text-[12px] text-aico-muted">
            {closed}/{total}
          </span>

          {/* A bar, because the useful question is "how much is left", and a
              fraction answers it more slowly than a length does. */}
          <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-aico-hover">
            <span
              className={`block h-full rounded-full transition-[width] duration-500 ${
                summary.allSettled ? 'bg-aico-success' : 'bg-aico-accent'}`}
              style={{ width: `${pct}%` }}
            />
          </span>

          {inProgress > 0 && (
            <span className="shrink-0 text-[11px] text-aico-accent">
              {inProgress} in progress
            </span>
          )}

          {/*
            The claim, and the caveat that makes it honest. A list finished by
            cancelling half of it is not a list that was done, and a bare "all
            done" is exactly the false all-clear this panel exists to prevent.
          */}
          {summary.allSettled && !busy && (
            <span className="shrink-0 text-[11px] text-aico-success">
              {cancelled === 0
                ? 'all done'
                : `${done} done · ${cancelled} cancelled`}
            </span>
          )}

          <span className="shrink-0 text-[10px] text-aico-muted opacity-0 transition-opacity group-hover:opacity-100">
            {collapsed ? '▾' : '▴'}
          </span>
        </button>

        {!collapsed && (
          <ul className="mt-1.5 border-t border-aico-border pt-1.5">
            {summary.todos.map(todo => <TodoRow key={todo.id} todo={todo} />)}
          </ul>
        )}

        {/*
          Said once, at the end, where it is actionable. The agent decides what
          "done" means for each item and nothing downstream can check that, so
          the panel does not pretend otherwise — it points at the evidence that
          does exist rather than adding a tick of its own.
        */}
        {summary.allSettled && !busy && pending + inProgress === 0 && (
          <p className="mt-1.5 border-t border-aico-border pt-1.5 text-[11px] text-aico-muted">
            Every item is closed. What each one was checked against is in the
            transcript above — a browser check reads “works”, a command shows its exit.
          </p>
        )}
      </div>
    </div>
  );
}
