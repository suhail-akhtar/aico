/**
 * A plan you can answer.
 *
 * Plan mode stopped the agent changing anything, and then handed over a wall of
 * prose. Prose can be read and cannot be answered: there was no approve, no
 * "yes but not step three", and no way to keep a good plan for tomorrow except
 * to leave the tab open and remember.
 *
 * Four answers, because those are the four a plan actually deserves. **Go
 * ahead** is the common one. **Amend** puts the plan in the composer as a
 * quotation so a correction is a sentence rather than a re-brief. **Later**
 * keeps it without starting it. **Decline** closes it.
 *
 * **The open questions come first, above the steps.** They are the cheapest
 * bug in the plan: an assumption the reader would have corrected costs a
 * sentence now and a rewrite later. Putting them under the steps, where the
 * approve button already is, is the same as not asking.
 *
 * The decision is sent as an ordinary message, so it lands in the log with
 * everything else and a plan approved yesterday still reads as approved today.
 *
 * @module components/PlanPanel
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { planFrom, PLAN_REPLY, type PlanDecision } from '../plans';
import { orderMessages } from '../reduce';

const DECISION_LABEL: Record<Exclude<PlanDecision, undefined>, string> = {
  approved: 'approved',
  deferred: 'saved for later',
  declined: 'declined',
};

export function PlanPanel(): React.ReactElement | null {
  const logged = useStore(s => s.logged);
  const busy = useStore(s => s.busy);
  const submit = useStore(s => s.submit);
  const prefillComposer = useStore(s => s.prefillComposer);
  const [sending, setSending] = useState(false);

  const { plan, decision } = useMemo(() => planFrom(orderMessages(logged)), [logged]);

  if (!plan) return null;

  const answer = async (reply: string): Promise<void> => {
    if (sending || busy) return;
    setSending(true);
    try { await submit(reply); } finally { setSending(false); }
  };

  // Placed in the composer rather than sent, because amending is the one answer
  // that needs the reader's own words. Re-briefing from scratch is what people
  // do when a plan is only prose, and it throws away the parts that were right.
  const amend = (): void => prefillComposer(`About that plan — `);

  const settled = decision !== undefined;

  return (
    <div className="mx-auto w-full max-w-column px-5 pb-2">
      <div className={`rounded-xl border px-3 py-2.5 ${
        settled ? 'border-aico-border bg-aico-panel' : 'border-aico-accent/40 bg-aico-accent-soft'
      }`}>
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-aico-primary">Plan</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-aico-secondary" title={plan.title}>
            {plan.title}
          </span>
          <span className="shrink-0 tabular-nums text-[11px] text-aico-muted">
            {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}
          </span>
          {settled && (
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
              decision === 'approved' ? 'bg-aico-success/12 text-aico-success'
                : decision === 'declined' ? 'bg-aico-danger/12 text-aico-danger'
                : 'bg-aico-hover text-aico-muted'
            }`}>
              {DECISION_LABEL[decision]}
            </span>
          )}
        </div>

        {/*
          Above the steps on purpose. An assumption the reader would have
          corrected costs a sentence now and a rewrite later, and putting it
          below — next to the approve button — is the same as not asking.
        */}
        {plan.openQuestions.length > 0 && !settled && (
          <div className="mt-2 rounded-lg border border-aico-border bg-aico-panel px-2.5 py-1.5">
            <p className="text-[11px] font-medium text-aico-secondary">
              Assumed, and worth correcting before this runs:
            </p>
            <ul className="mt-1 space-y-0.5">
              {plan.openQuestions.map((q, i) => (
                <li key={i} className="text-[12px] leading-[18px] text-aico-secondary">— {q}</li>
              ))}
            </ul>
          </div>
        )}

        <ol className="mt-2 space-y-1">
          {plan.steps.map((step, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-[2px] w-4 shrink-0 text-right tabular-nums text-[11px] text-aico-muted">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] leading-[18px] text-aico-secondary">{step.title}</p>
                {step.detail && (
                  <p className="text-[11px] leading-[17px] text-aico-muted">{step.detail}</p>
                )}
                {step.touches && step.touches.length > 0 && (
                  <p className="truncate font-mono text-[11px] text-aico-muted"
                     title={step.touches.join(', ')}>
                    {step.touches.join(' · ')}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>

        {plan.risks.length > 0 && (
          <ul className="mt-2 space-y-0.5 border-t border-aico-border pt-1.5">
            {plan.risks.map((risk, i) => (
              <li key={i} className="text-[11px] leading-[17px] text-aico-muted">Risk: {risk}</li>
            ))}
          </ul>
        )}

        {!settled && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-aico-border pt-2">
            <button
              onClick={() => void answer(PLAN_REPLY.approved)}
              disabled={sending || busy}
              className="rounded-lg bg-aico-accent px-2.5 py-1 text-[12px] font-medium text-white
                         transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Go ahead
            </button>
            <button
              onClick={amend}
              disabled={sending || busy}
              className="rounded-lg px-2.5 py-1 text-[12px] text-aico-secondary
                         transition-colors hover:bg-aico-hover disabled:opacity-50"
            >
              Amend
            </button>
            <button
              onClick={() => void answer(PLAN_REPLY.deferred)}
              disabled={sending || busy}
              className="rounded-lg px-2.5 py-1 text-[12px] text-aico-secondary
                         transition-colors hover:bg-aico-hover disabled:opacity-50"
            >
              Later
            </button>
            <div className="flex-1" />
            <button
              onClick={() => void answer(PLAN_REPLY.declined)}
              disabled={sending || busy}
              className="rounded-lg px-2.5 py-1 text-[12px] text-aico-muted
                         transition-colors hover:bg-aico-danger/10 hover:text-aico-danger
                         disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        )}

        {decision === 'deferred' && (
          <p className="mt-2 border-t border-aico-border pt-1.5 text-[11px] text-aico-muted">
            Kept, not started. It stays here — say the word when you want it run.
          </p>
        )}
      </div>
    </div>
  );
}
