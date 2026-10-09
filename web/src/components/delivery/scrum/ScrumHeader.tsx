/**
 * The sprint header: what the team promised, how far along it is, and the one next step.
 *
 * Purpose: someone glancing at the board in Scrum mode asks four things in this order
 * (which sprint, how many days are left, how much is done, am I on pace) and then "what do
 * I do next". The header answers the first four in a single row, with the burndown as a
 * sparkline so the shape of the sprint is visible without opening Reports, and offers
 * exactly one primary action for the sprint's state: Plan (none), Start (planned),
 * Close (active and over, or any time from the menu row).
 *
 * With no sprint at all it is a teaching empty state, not a blank: three steps and the two
 * buttons that begin them.
 *
 * What it does not do: decide anything. Starting and closing are a person's acts, sent
 * through the gated routes by the dialogs the board opens.
 *
 * @module web/components/delivery/scrum/ScrumHeader
 */

import React, { useMemo } from 'react';
import {
  burndown, daysLeft, daysLeftWord, overdue, paceDetail, pointsWord, rangeWord, sprintProgress, tasksOfSprint,
  type Sprint,
} from '../../../delivery-scrum';
import type { Task } from '../../../delivery-types';
import { DvIcon } from '../icons';
import { BTN_OUTLINE, BTN_PRIMARY } from '../ui';
import { PaceChip, Sparkline } from './bits';

export function ScrumHeader({ sprint, tasks, now, offsetMin, onPlan, onStart, onClose, onRefine, source }: {
  sprint: Sprint | undefined;
  /** The connected platform's name, when the sprint mirrors one of its iterations. */
  source?: string | undefined;
  tasks: readonly Task[];
  now: number;
  offsetMin: number;
  onPlan: () => void;
  onStart: () => void;
  onClose: () => void;
  onRefine: () => void;
}): React.ReactElement {
  const bd = useMemo(() => (sprint ? burndown(sprint, tasks, now, offsetMin) : null), [sprint, tasks, now, offsetMin]);

  if (!sprint || !bd) return <FirstSprint onPlan={onPlan} onRefine={onRefine} />;

  const progress = sprintProgress(sprint, tasks, bd);
  const left = daysLeft(sprint, now, offsetMin);
  const late = overdue(sprint, now, offsetMin);
  const members = tasksOfSprint(tasks, sprint.id);
  const planned = sprint.status === 'planned';
  const closed = sprint.status === 'closed';
  const capacity = sprint.capacityPoints;

  return (
    <div className="shrink-0 border-b border-aico-border-subtle px-4 py-3 sm:px-6" data-scrum-header={sprint.status}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-aico-border-subtle bg-aico-surface px-4 py-3">
        <div className="min-w-[200px] flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-[15px] font-semibold tracking-tight text-aico-primary">{sprint.name}</h2>
            <span className="rounded-full bg-aico-hover px-2 py-0.5 text-[11px] text-aico-secondary">{planned ? 'Planning' : closed ? 'Closed' : 'Active'}</span>
            {sprint.remote && (
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] ${sprint.remote.state === 'closed' && !closed ? 'border-aico-warning text-aico-warning' : 'border-aico-border-subtle text-aico-secondary'}`}
                title={sprint.remote.state === 'closed' && !closed
                  ? `${source ?? 'The platform'} has ended this sprint. Close it here when the work is done.`
                  : `The name and dates of this sprint follow ${source ?? 'the platform'}; planning, starting and closing stay here.`}
                data-sprint-remote={sprint.remote.kind}
              >
                {sprint.remote.state === 'closed' && !closed ? `Ended on ${source ?? 'the platform'}` : `Synced with ${source ?? 'the platform'}`}
              </span>
            )}
          </div>
          {sprint.goal && <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-aico-secondary">{sprint.goal}</p>}
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] tabular-nums text-aico-muted">
            <span>{rangeWord(sprint)}</span><span aria-hidden="true">·</span>
            <span className={late ? 'font-medium text-aico-warning' : ''}>{late ? 'ended, ready to close' : daysLeftWord(left, sprint.status)}</span>
          </p>
        </div>

        <div className="min-w-[180px] basis-48">
          <p className="flex items-baseline gap-1.5 tabular-nums">
            <span className="text-[22px] font-semibold leading-none tracking-tight text-aico-primary">{progress.done}</span>
            <span className="text-[13px] text-aico-secondary">of {progress.scope} {progress.scope === 1 ? 'point' : 'points'} done</span>
          </p>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-aico-hover" role="progressbar" aria-label="Points done" aria-valuemin={0} aria-valuemax={progress.scope} aria-valuenow={progress.done}>
            <div className="h-full rounded-full bg-aico-accent transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${progress.pct}%` }} />
          </div>
          <p className="mt-1 text-[12px] text-aico-muted">
            {progress.tasksDone} of {progress.tasksTotal} {progress.tasksTotal === 1 ? 'task' : 'tasks'} landed
            {planned && capacity ? ` · capacity ${pointsWord(capacity)}` : ''}
          </p>
        </div>

        {!planned && (
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-start gap-1">
              <PaceChip status={bd.status} title={paceDetail(bd)} />
              {bd.status !== 'closed' && <span className="hidden max-w-[150px] text-[11.5px] leading-snug text-aico-muted sm:block">{paceDetail(bd).replace(/^On track: /, '')}</span>}
            </div>
            <Sparkline
              remaining={bd.points.map(p => p.remaining)} ideal={bd.points.map(p => p.ideal)}
              label={`Burndown: ${bd.remaining} points remaining, ${paceDetail(bd)}`}
            />
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {planned && (
            <>
              <button type="button" className={BTN_OUTLINE} onClick={onPlan}>Edit plan</button>
              <button type="button" className={BTN_PRIMARY} onClick={onStart} disabled={members.length === 0} title={members.length === 0 ? 'Commit at least one task first' : undefined}>
                <DvIcon name="play" size={13} />Start sprint
              </button>
            </>
          )}
          {sprint.status === 'active' && (
            <button type="button" className={late ? BTN_PRIMARY : BTN_OUTLINE} onClick={onClose}>Close sprint</button>
          )}
          {closed && <button type="button" className={BTN_PRIMARY} onClick={onPlan}><DvIcon name="plus" size={14} />Plan next sprint</button>}
          {sprint.status === 'active' && <button type="button" className={BTN_OUTLINE} onClick={onPlan} title="Plan the next sprint while this one runs">Plan next</button>}
        </div>
      </div>
    </div>
  );
}

function FirstSprint({ onPlan, onRefine }: { onPlan: () => void; onRefine: () => void }): React.ReactElement {
  const steps = [
    ['Refine the backlog', 'Give each item story points, split the big ones and write acceptance criteria. An agent can suggest all three; you accept or dismiss each.'],
    ['Plan the sprint', 'Pick what fits the capacity. AICO proposes the top-priority items in dependency order; you commit the plan.'],
    ['Run it', 'Agents start only the sprint\'s tasks. You review and land them; the burndown and a daily summary track the pace.'],
  ] as const;
  return (
    <div className="shrink-0 border-b border-aico-border-subtle px-4 py-4 sm:px-6" data-scrum-header="none">
      <div className="rounded-xl border border-aico-border-subtle bg-aico-surface px-5 py-4">
        <h2 className="text-[17px] font-semibold tracking-tight text-aico-primary">Plan your first sprint</h2>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-aico-secondary">Scrum here is the same board with a time box on it. Nothing starts until you commit a plan and start the sprint.</p>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {steps.map(([t, d], i) => (
            <li key={t} className="rounded-lg border border-aico-border-subtle bg-aico-bg p-3">
              <span className="text-[11.5px] font-medium tabular-nums text-aico-muted">{i + 1}</span>
              <p className="mt-0.5 text-[13.5px] font-medium text-aico-primary">{t}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-aico-secondary">{d}</p>
            </li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={BTN_PRIMARY} onClick={onPlan}><DvIcon name="plus" size={14} />Plan sprint</button>
          <button type="button" className={BTN_OUTLINE} onClick={onRefine}><DvIcon name="sparkles" size={14} />Refine the backlog with an agent</button>
        </div>
      </div>
    </div>
  );
}
