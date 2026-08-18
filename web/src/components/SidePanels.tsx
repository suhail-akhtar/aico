/**
 * The plan and the task list, out of the way of the conversation.
 *
 * Both of these began life stacked above the composer, where they pushed the
 * chat around and stayed at full height long after they had anything to say. A
 * panel that is still shouting about a finished list is worse than no panel:
 * people stop reading it, and then miss the one time it mattered.
 *
 * So they float to the right of the column, and they know when to shut up.
 *
 * **Resolution collapses them.** A plan that has been answered has done its
 * job; a task list with nothing open has done its job. Both drop to a single
 * line stating the outcome, which stays readable and stops occupying the
 * screen. Collapsing rather than vanishing, because "what did I agree to?" is
 * asked five minutes later and the answer should not require scrolling.
 *
 * **Closing is per-thing, not forever.** The close button records *what* was
 * closed. A genuinely new plan, or a task list that has moved on, comes back on
 * its own; the one that was dismissed stays dismissed. A plain boolean would
 * have made the first dismissal permanent and hidden the next real thing behind
 * a decision made about something else.
 *
 * **Narrow screens get them inline.** A floating rail beside a column that
 * already fills the window is a rail on top of the text. Below `xl` they fall
 * back into the normal flow, where they are merely large rather than in the way.
 *
 * @module components/SidePanels
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { todosFrom, type Todo, type TodoStatus } from '../todos';
import { planFrom, type PlanDecision } from '../plans';
import type { PlanAnswer } from '../store';
import { orderMessages } from '../reduce';

/** How each task state reads at a glance. */
const MARKS: Record<TodoStatus, { glyph: string; tone: string; label: string }> = {
  done: { glyph: '✓', tone: 'text-aico-success', label: 'done' },
  in_progress: { glyph: '◐', tone: 'text-aico-accent', label: 'in progress' },
  pending: { glyph: '○', tone: 'text-aico-muted', label: 'to do' },
  // Not a failure and not an achievement. Still visible: an item quietly
  // dropped is the one most worth being able to see.
  cancelled: { glyph: '⊘', tone: 'text-aico-muted', label: 'cancelled' },
};

const DECISION_LABEL: Record<Exclude<PlanDecision, undefined>, string> = {
  approved: 'approved',
  deferred: 'saved for later',
  declined: 'declined',
};

/** Shared chrome: a title row that can collapse, and a close that means it. */
function Card({
  title, status, statusTone = 'muted', collapsed, onToggle, onClose, urgent, children,
}: {
  title: string;
  status?: string;
  statusTone?: 'good' | 'bad' | 'muted' | 'accent';
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Draws attention while something is genuinely waiting on the reader. */
  urgent?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const tone = statusTone === 'good' ? 'text-aico-success'
    : statusTone === 'bad' ? 'text-aico-danger'
    : statusTone === 'accent' ? 'text-aico-accent'
    : 'text-aico-muted';

  return (
    <section
      className={`pointer-events-auto overflow-hidden rounded-xl border shadow-sm backdrop-blur-sm
                  transition-colors ${
        urgent ? 'border-aico-accent/50 bg-aico-accent-soft' : 'border-aico-border bg-aico-panel/95'
      }`}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={!collapsed}
        >
          <span className="shrink-0 text-[11px] font-medium text-aico-primary">{title}</span>
          {status && (
            <span className={`min-w-0 truncate text-[11px] ${tone}`} title={status}>{status}</span>
          )}
        </button>
        <button
          onClick={onToggle}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          className="shrink-0 rounded px-1 text-[10px] text-aico-muted hover:bg-aico-hover"
        >
          {collapsed ? '▾' : '▴'}
        </button>
        <button
          onClick={onClose}
          aria-label={`Dismiss ${title}`}
          className="shrink-0 rounded px-1 text-[12px] leading-none text-aico-muted
                     hover:bg-aico-danger/10 hover:text-aico-danger"
        >
          ×
        </button>
      </div>
      {!collapsed && <div className="px-2.5 pb-2.5">{children}</div>}
    </section>
  );
}

function TaskCard(): React.ReactElement | null {
  const logged = useStore(s => s.logged);
  const busy = useStore(s => s.busy);
  const dismissed = useStore(s => s.dismissed);
  const dismissPanel = useStore(s => s.dismissPanel);
  const [manual, setManual] = useState<boolean | null>(null);

  const summary = useMemo(() => todosFrom(orderMessages(logged)), [logged]);
  if (summary.total === 0) return null;
  if (dismissed.tasks === summary.signature) return null;

  const { closed, total, inProgress, cancelled, done, allSettled } = summary;
  // Finished work collapses itself. The reader's own choice always wins over
  // that, in either direction, because a panel that reopens what you closed is
  // as annoying as one that never closes.
  const settledAndQuiet = allSettled && !busy;
  const collapsed = manual ?? settledAndQuiet;

  const status = settledAndQuiet
    ? (cancelled === 0 ? 'all done' : `${done} done · ${cancelled} cancelled`)
    : `${closed}/${total}${inProgress > 0 ? ` · ${inProgress} running` : ''}`;

  return (
    <Card
      title="Tasks"
      status={status}
      statusTone={settledAndQuiet ? (cancelled === 0 ? 'good' : 'muted') : 'accent'}
      collapsed={collapsed}
      onToggle={() => setManual(!collapsed)}
      onClose={() => dismissPanel('tasks', summary.signature)}
    >
      <div className="mb-1.5 h-1 overflow-hidden rounded-full bg-aico-hover">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            allSettled ? 'bg-aico-success' : 'bg-aico-accent'}`}
          style={{ width: `${Math.round((closed / total) * 100)}%` }}
        />
      </div>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto">
        {summary.todos.map((todo: Todo) => {
          const mark = MARKS[todo.status];
          return (
            <li key={todo.id} className="flex items-start gap-1.5">
              <span
                className={`mt-[1px] shrink-0 text-[11px] ${mark.tone} ${
                  todo.status === 'in_progress' ? 'aico-thinking' : ''}`}
                aria-hidden
              >
                {mark.glyph}
              </span>
              <span className={`min-w-0 flex-1 text-[11px] leading-[16px] ${
                todo.status === 'done' ? 'text-aico-muted'
                  : todo.status === 'cancelled' ? 'text-aico-muted line-through'
                  : 'text-aico-secondary'
              }`}>
                {todo.title}
              </span>
              <span className="sr-only">{mark.label}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function PlanCard(): React.ReactElement | null {
  const logged = useStore(s => s.logged);
  const busy = useStore(s => s.busy);
  const answerPlan = useStore(s => s.answerPlan);
  const amendPlan = useStore(s => s.amendPlan);
  const dismissed = useStore(s => s.dismissed);
  const dismissPanel = useStore(s => s.dismissPanel);
  const [manual, setManual] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);

  const { plan, decision } = useMemo(() => planFrom(orderMessages(logged)), [logged]);
  if (!plan) return null;

  const identity = `${plan.seq}:${plan.title}`;
  if (dismissed.plan === identity) return null;

  const settled = decision !== undefined;
  // An answered plan has done its job; the agent is getting on with it and the
  // panel should not be in the way of watching that happen.
  const collapsed = manual ?? settled;

  const answer = async (decision: PlanAnswer): Promise<void> => {
    if (sending || busy) return;
    setSending(true);
    // Collapsed on the way out rather than after the reply lands: the decision
    // is made, and leaving it expanded for a round trip reads as hesitation.
    // Except when starting a deferred plan — that one is expanding into work,
    // and the reader wants to watch the steps it agreed to.
    if (decision !== 'startNow') setManual(true);
    // The store owns this, not the panel: approving both sends the message and
    // ends planning, and a caller that does only the first produces an agent
    // that comes back still unable to write a file.
    try { await answerPlan(decision); } finally { setSending(false); }
  };

  return (
    <Card
      title="Plan"
      status={settled ? DECISION_LABEL[decision] : plan.title}
      statusTone={settled
        ? (decision === 'approved' ? 'good' : decision === 'declined' ? 'bad' : 'muted')
        : 'muted'}
      collapsed={collapsed}
      onToggle={() => setManual(!collapsed)}
      onClose={() => dismissPanel('plan', identity)}
      urgent={!settled}
    >
      {!settled && (
        <p className="mb-1.5 text-[11px] leading-[16px] text-aico-secondary">{plan.title}</p>
      )}

      {/*
        Above the steps on purpose. An assumption the reader would have
        corrected costs a sentence now and a rewrite later, and putting it down
        beside the approve button is the same as not asking.
      */}
      {plan.openQuestions.length > 0 && !settled && (
        <div className="mb-1.5 rounded-lg border border-aico-border bg-aico-bg px-2 py-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-aico-muted">
            Assumed — worth correcting first
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {plan.openQuestions.map((q, i) => (
              <li key={i} className="text-[11px] leading-[16px] text-aico-secondary">— {q}</li>
            ))}
          </ul>
        </div>
      )}

      <ol className="max-h-56 space-y-1 overflow-y-auto">
        {plan.steps.map((step, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span className="mt-[1px] w-3 shrink-0 text-right tabular-nums text-[10px] text-aico-muted">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] leading-[16px] text-aico-secondary">{step.title}</p>
              {step.detail && (
                <p className="text-[10px] leading-[15px] text-aico-muted">{step.detail}</p>
              )}
              {step.touches && step.touches.length > 0 && (
                <p className="truncate font-mono text-[10px] text-aico-muted"
                   title={step.touches.join(', ')}>
                  {step.touches.join(' · ')}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {plan.risks.length > 0 && !settled && (
        <ul className="mt-1.5 space-y-0.5 border-t border-aico-border pt-1.5">
          {plan.risks.map((risk, i) => (
            <li key={i} className="text-[10px] leading-[15px] text-aico-muted">Risk: {risk}</li>
          ))}
        </ul>
      )}

      {!settled && (
        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-aico-border pt-2">
          <button
            onClick={() => void answer('approved')}
            disabled={sending || busy}
            className="rounded-lg bg-aico-accent px-2 py-1 text-[11px] font-medium text-white
                       transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Go ahead
          </button>
          <button
            onClick={amendPlan}
            disabled={sending || busy}
            className="rounded-lg px-2 py-1 text-[11px] text-aico-secondary
                       transition-colors hover:bg-aico-hover disabled:opacity-50"
          >
            Amend
          </button>
          <button
            onClick={() => void answer('deferred')}
            disabled={sending || busy}
            className="rounded-lg px-2 py-1 text-[11px] text-aico-secondary
                       transition-colors hover:bg-aico-hover disabled:opacity-50"
          >
            Later
          </button>
          <div className="flex-1" />
          <button
            onClick={() => void answer('declined')}
            disabled={sending || busy}
            className="rounded-lg px-2 py-1 text-[11px] text-aico-muted transition-colors
                       hover:bg-aico-danger/10 hover:text-aico-danger disabled:opacity-50"
          >
            Decline
          </button>
        </div>
      )}

      {/*
        A deferred plan is the one state with something still to offer. Telling
        the reader to "say the word" and then making them find the words is a
        worse deal than a button, and the plan is already written down.
      */}
      {decision === 'deferred' && (
        <div className="mt-1.5 flex items-center gap-2 border-t border-aico-border pt-1.5">
          <button
            onClick={() => void answer('startNow')}
            disabled={sending || busy}
            className="rounded-lg bg-aico-accent px-2 py-1 text-[11px] font-medium text-white
                       transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Start it now
          </button>
          <span className="text-[10px] text-aico-muted">Kept, not started.</span>
        </div>
      )}
    </Card>
  );
}

/**
 * The rail itself.
 *
 * `pointer-events-none` on the container and `auto` on each card, so the empty
 * space beside the conversation stays clickable — a transparent rail that eats
 * clicks is a bug people cannot see and cannot explain.
 */
export function SidePanels(): React.ReactElement {
  return (
    <div
      className="pointer-events-none z-30 flex flex-col gap-2 px-5 pb-2
                 xl:fixed xl:right-4 xl:top-16 xl:w-[290px] xl:px-0"
    >
      <PlanCard />
      <TaskCard />
    </div>
  );
}
