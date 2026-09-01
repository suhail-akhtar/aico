/**
 * A proposed plan, and the answer to it.
 *
 * The panel already had the Plan/Build toggle, so a plan could be *asked for*
 * in VS Code and then had nowhere to be answered: the proposal arrived as prose
 * in the transcript, and approving it meant typing a sentence and hoping the
 * agent read it as approval. The browser client has had buttons for this from
 * the start, and — more to the point — has had the *exact wording* of each
 * answer written down in `PLAN_REPLY`, so a plan approved on one surface still
 * reads as approved when the log is replayed on the other.
 *
 * That shared vocabulary is the whole reason this is thirty lines of view rather
 * than a second implementation: `planFrom` reads the proposal out of the
 * transcript and `PLAN_REPLY` says what each button sends. Neither is duplicated
 * here.
 *
 * ## What it does not do
 *
 * It does not render the plan's full body. The proposal is already in the
 * transcript directly above, in the surface built for reading — repeating the
 * steps, risks and open questions in a 300px card would be the same text twice,
 * once badly. What this adds is the title, the count, and the decision.
 *
 * @module components/PlanCard
 */

import React, { useMemo, useState } from 'react';
import { useStore, type PlanAnswer } from '@web/store';
import { composeMessages } from '@web/reduce';
import { planFrom, type PlanDecision } from '@web/plans';

const DECISION_LABEL: Record<Exclude<PlanDecision, undefined>, string> = {
  approved: 'approved',
  deferred: 'saved for later',
  declined: 'declined',
  cancelled: 'cancelled',
  completed: 'done',
};

/**
 * Decisions that end a plan for good.
 *
 * `approved` is deliberately not one of them. Work is under way and the plan is
 * what it is being measured against, so it stays; the rest are answers after
 * which there is nothing left to answer.
 */
const FINISHED: PlanDecision[] = ['declined', 'cancelled', 'completed'];

export function PlanCard(): React.ReactElement | null {
  const logged = useStore(s => s.logged);
  const draft = useStore(s => s.draft);
  const busy = useStore(s => s.busy);
  const answerPlan = useStore(s => s.answerPlan);
  const amendPlan = useStore(s => s.amendPlan);

  const [sending, setSending] = useState(false);
  /** Dismissed by identity, so a *revised* plan comes back on its own. */
  const [dismissed, setDismissed] = useState<string | null>(null);

  /*
    Read from the live view, not the durable log.

    A proposal lands in the draft first and reaches `logged` only when the turn
    ends — so a card reading the log alone would appear after the plan was
    finished being explained, which is exactly too late to be a decision.
  */
  const { plan, decision } = useMemo(
    () => planFrom(composeMessages(logged, draft, busy)),
    [logged, draft, busy],
  );

  if (!plan) return null;
  const identity = `${plan.seq}:${plan.title}`;
  if (dismissed === identity) return null;
  if (FINISHED.includes(decision)) return null;

  const settled = decision !== undefined;

  const answer = async (next: PlanAnswer): Promise<void> => {
    if (sending || busy) return;
    setSending(true);
    try { await answerPlan(next); } finally { setSending(false); }
  };

  return (
    <div
      className={[
        'shrink-0 border-t px-3 py-1.5',
        settled ? 'border-aico-border-subtle' : 'border-aico-accent/40 bg-aico-accent-soft/40',
      ].join(' ')}
    >
      <div className="flex items-start gap-1.5">
        <span className={`text-[10px] leading-[16px] ${
          decision === 'approved' ? 'text-aico-success' : 'text-aico-accent'
        }`}>
          ◇
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] leading-[16px] text-aico-primary" title={plan.title}>
            {plan.title}
          </span>
          <span className="block text-[10px] leading-[14px] text-aico-muted">
            {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}
            {plan.openQuestions.length > 0 && !settled
              && ` · ${plan.openQuestions.length} open question${plan.openQuestions.length === 1 ? '' : 's'}`}
            {settled && ` · ${DECISION_LABEL[decision]}`}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setDismissed(identity)}
          title="Hide this — the plan stays in the conversation"
          aria-label="Hide"
          className="shrink-0 text-[10px] text-aico-muted hover:text-aico-primary"
        >
          ✕
        </button>
      </div>

      {/*
        Open questions before the buttons.

        A plan with a question in it is not ready to be approved, and burying
        that under a "Go ahead" is how an agent gets permission to proceed on an
        assumption nobody agreed to.
      */}
      {!settled && plan.openQuestions.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-3.5">
          {plan.openQuestions.slice(0, 3).map((q, i) => (
            <li key={i} className="text-[10px] leading-[14px] text-aico-warning">? {q}</li>
          ))}
        </ul>
      )}

      {!settled && (
        <div className="mt-1.5 flex items-center gap-1 pl-3.5">
          <Primary label="Go ahead" busy={sending || busy} onPick={() => void answer('approved')} />
          {/*
            Amend puts the framing in the composer rather than sending anything:
            what needs changing is the reader's to write, and `amendPlan`
            supplies the prefix that makes it read as a correction rather than
            as a question.
          */}
          <Quiet label="Amend" busy={sending || busy} onPick={amendPlan} />
          <Quiet label="Later" busy={sending || busy} onPick={() => void answer('deferred')} />
          <span className="flex-1" />
          <Quiet label="Decline" danger busy={sending || busy} onPick={() => void answer('declined')} />
        </div>
      )}

      {/*
        An approved plan can still be called off or declared finished. Without
        these both were sayable only in prose, so the panel went on showing an
        agreed plan as live work long after it had been abandoned — and brought
        it back on every reload.
      */}
      {decision === 'approved' && (
        <div className="mt-1.5 flex items-center gap-1 pl-3.5">
          <Quiet label="Mark done" busy={sending || busy} onPick={() => void answer('completed')} />
          <span className="flex-1" />
          <Quiet label="Cancel plan" danger busy={sending || busy} onPick={() => void answer('cancelled')} />
        </div>
      )}

      {decision === 'deferred' && (
        <div className="mt-1.5 flex items-center gap-1.5 pl-3.5">
          <Primary label="Start it now" busy={sending || busy} onPick={() => void answer('startNow')} />
          <span className="text-[10px] text-aico-muted">Kept, not started.</span>
        </div>
      )}
    </div>
  );
}

function Primary({ label, busy, onPick }: {
  label: string; busy: boolean; onPick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onPick}
      className="rounded bg-aico-accent px-2 py-0.5 text-[11px] text-aico-on-accent
                 hover:bg-aico-accent-hover disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function Quiet({ label, danger, busy, onPick }: {
  label: string; danger?: boolean; busy: boolean; onPick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onPick}
      className={[
        'rounded px-1.5 py-0.5 text-[11px] disabled:opacity-50',
        danger
          ? 'text-aico-muted hover:bg-aico-danger/10 hover:text-aico-danger'
          : 'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
