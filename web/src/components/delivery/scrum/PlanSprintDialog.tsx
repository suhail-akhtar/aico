/**
 * Sprint planning: a proposal you edit, then commit.
 *
 * AICO proposes the top-priority estimated items that fit the capacity, dependencies first
 * (`proposePlan`, the engine's own module, so what you see is what a route would compute).
 * Everything is a checkbox you can change; the capacity bar moves as you do. An item with
 * no estimate cannot be planned, so it is listed with the estimate chip right there: the
 * fix is one click, not a trip to another screen.
 *
 * Committing is a person's act: it fixes what the team promised, and (when "start now" is
 * ticked) readies the sprint's tasks for the agents. The dialog sends it as a person and
 * keeps every error inside itself. If the sprint was created but the commit was refused,
 * the sprint stays in planning and the dialog picks it up on the next try rather than
 * making a second one.
 *
 * @module web/components/delivery/scrum/PlanSprintDialog
 */

import React, { useMemo, useState } from 'react';
import { api } from '../../../api';
import { refreshBoard } from '../../../delivery';
import {
  SKIP_WORD, dayKey, defaultCapacity, defaultSprintDates, dependentsInPlan, diffDays, nextSprintName, planState, plannedSprintOf, pointsOf,
  pointsWord, proposePlan, toggleChosen, validateSprintDates, type Sprint,
} from '../../../delivery-scrum';
import type { Task } from '../../../delivery-types';
import { PriorityChip, BTN_GHOST, BTN_PRIMARY, ErrorLine, INPUT, LABEL, Modal, useTaskRef } from '../ui';
import { EstimateChip } from './bits';

export function PlanSprintDialog({ project, tasks, sprints, now, offsetMin, onClose, onDone }: {
  project: string; tasks: readonly Task[]; sprints: readonly Sprint[]; now: number; offsetMin: number;
  onClose: () => void; onDone: (message: string) => void;
}): React.ReactElement {
  const ref = useTaskRef();
  const planned = plannedSprintOf(sprints);
  const defaults = useMemo(() => defaultSprintDates(sprints, now, offsetMin), [sprints, now, offsetMin]);
  const velocityCap = useMemo(() => defaultCapacity(sprints), [sprints]);
  const [name, setName] = useState(planned?.name ?? nextSprintName(sprints));
  const [goal, setGoal] = useState(planned?.goal ?? '');
  const [start, setStart] = useState(planned?.start ?? defaults.start);
  const [end, setEnd] = useState(planned?.end ?? defaults.end);
  const [capacityText, setCapacityText] = useState(String(planned?.capacityPoints ?? velocityCap ?? ''));
  const [manual, setManual] = useState<string[] | null>(null);
  const [startNow, setStartNow] = useState(() => (planned?.start ?? defaults.start) <= dayKey(now, offsetMin));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const sprintId = planned?.id ?? createdId ?? undefined;
  const capacity = Number(capacityText) > 0 ? Number(capacityText) : undefined;
  const plan = useMemo(() => proposePlan(tasks, { capacity, velocityCapacity: velocityCap, sprintId }), [tasks, capacity, velocityCap, sprintId]);
  const byId = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const chosen = manual ?? plan.items.map(i => i.taskId);
  const state = planState(chosen, byId, plan.capacity);
  const keptIds = useMemo(() => tasks.filter(t => sprintId && t.sprintId === sprintId).map(t => t.id), [tasks, sprintId]);
  const proposed = new Set(plan.items.map(i => i.taskId));
  const skipReason = new Map(plan.skipped.map(s => [s.taskId, s]));
  const pulled = new Map(plan.items.filter(i => i.dependency).map(i => [i.taskId, i]));

  // Everything that could be planned and is not in the proposal, so nothing is hidden.
  const others = tasks.filter(t => !proposed.has(t.id) && !t.sprintId && (t.status === 'backlog' || t.status === 'ready'));
  const candidates = [...plan.items.map(i => byId.get(i.taskId)).filter((t): t is Task => Boolean(t)), ...others.filter(t => t.estimate)];
  const unestimated = others.filter(t => !t.estimate);
  const datesError = planned ? null : validateSprintDates(start, end);
  const length = datesError ? 0 : diffDays(start, end) + 1;

  const setEstimate = async (t: Task, points: number | null): Promise<void> => {
    try { await api.deliveryEstimate(t.id, project, points); await refreshBoard(); } catch (e) { setError((e as Error).message); }
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (datesError) { setError(datesError); return; }
    if (chosen.length === 0) { setError('Tick at least one task to commit.'); return; }
    setBusy(true); setError(null);
    try {
      let id = sprintId;
      if (!id) {
        const made = await api.deliveryCreateSprint(project, { name: name.trim(), goal: goal.trim(), start, end, ...(capacity ? { capacityPoints: capacity } : {}) });
        id = made.id; setCreatedId(made.id);
      }
      const add = chosen.filter(c => !keptIds.includes(c));
      const remove = keptIds.filter(k => !chosen.includes(k));
      await api.deliveryCommitSprint(project, id, add, remove);
      if (startNow && !planned?.startedAt) await api.deliveryStartSprint(project, id);
      await refreshBoard();
      onDone(startNow ? `${name || 'The sprint'} started with ${chosen.length} ${chosen.length === 1 ? 'task' : 'tasks'} (${pointsWord(state.total)}). Start the agents to begin.` : `Committed ${chosen.length} ${chosen.length === 1 ? 'task' : 'tasks'} (${pointsWord(state.total)}) to ${name || 'the sprint'}. Start the sprint when you are ready.`);
      onClose();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  const pct = Math.min(100, Math.round(state.load * 100));
  const row = (t: Task, i: number): React.ReactElement => {
    const on = chosen.includes(t.id);
    const dep = pulled.get(t.id);
    const deps = on ? [] : dependentsInPlan(chosen, t.id, byId);
    const why = !on ? skipReason.get(t.id) : undefined;
    return (
      <li key={t.id} className="flex items-start gap-2.5 px-3 py-2">
        <input
          id={`ps-${t.id}`} type="checkbox" checked={on} className="mt-1 h-4 w-4 shrink-0 accent-[var(--aico-accent)]"
          onChange={() => setManual(toggleChosen(chosen, t.id))}
        />
        <label htmlFor={`ps-${t.id}`} className="min-w-0 flex-1 cursor-pointer">
          <span className="flex items-center gap-2 text-[11.5px] text-aico-muted">
            <span className="font-mono tabular-nums">{ref(t.id)}</span><PriorityChip priority={t.priority} />
            {i === 0 && manual === null && <span className="sr-only">First in the proposal</span>}
          </span>
          <span className="block text-[13px] leading-snug text-aico-primary">{t.title}</span>
          {dep && <span className="block text-[11.5px] text-aico-secondary">Pulled in because a task in the plan depends on it.</span>}
          {why && <span className="block text-[11.5px] text-aico-secondary">{SKIP_WORD[why.reason]}{why.detail ? ` (${why.detail})` : ''}</span>}
          {deps.length > 0 && <span className="block text-[11.5px] text-aico-warning">{deps.map(ref).join(', ')} depends on this and would wait.</span>}
        </label>
        <span className="shrink-0 text-[12px] font-medium tabular-nums text-aico-primary">{pointsWord(pointsOf(t))}</span>
      </li>
    );
  };

  return (
    <Modal title={planned ? `Plan ${planned.name}` : 'Plan a sprint'} onClose={onClose} busy={busy} width="max-w-2xl">
      <form onSubmit={e => void submit(e)} className="space-y-4">
        {!planned && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="ps-name">Name</label>
              <input id="ps-name" className={INPUT} value={name} onChange={e => setName(e.target.value)} maxLength={80} />
            </div>
            <div>
              <label className={LABEL} htmlFor="ps-cap">Capacity (points)</label>
              <input id="ps-cap" className={INPUT} inputMode="decimal" value={capacityText} onChange={e => { setCapacityText(e.target.value); }} placeholder={String(plan.capacity)} />
              <p className="mt-1 text-[11.5px] text-aico-muted">
                {velocityCap !== undefined && capacityText.trim() === String(velocityCap) ? `From your last sprints: about ${velocityCap} points.` : plan.capacitySource === 'starter' ? `A starter value (${plan.capacity}): there is no history yet. Change it freely.` : 'As you set it.'}
              </p>
            </div>
            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="ps-goal">Sprint goal <span className="font-normal text-aico-muted">(optional)</span></label>
              <input id="ps-goal" className={INPUT} value={goal} onChange={e => setGoal(e.target.value)} placeholder="What should be true at the end?" maxLength={500} />
            </div>
            <div>
              <label className={LABEL} htmlFor="ps-start">Starts</label>
              <input id="ps-start" type="date" className={INPUT} value={start} onChange={e => { setStart(e.target.value); }} />
            </div>
            <div>
              <label className={LABEL} htmlFor="ps-end">Ends</label>
              <input id="ps-end" type="date" className={INPUT} value={end} onChange={e => setEnd(e.target.value)} />
              <p className="mt-1 text-[11.5px] text-aico-muted">{datesError ?? `${length} ${length === 1 ? 'day' : 'days'}`}</p>
            </div>
          </div>
        )}

        <div>
          <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="font-medium text-aico-primary">Capacity</span>
            <span className={`tabular-nums ${state.over ? 'font-medium text-aico-warning' : 'text-aico-secondary'}`} aria-live="polite">
              {pointsWord(state.total)} of {pointsWord(plan.capacity)}{state.over ? ` · ${pointsWord(-state.remaining)} over` : ` · ${pointsWord(state.remaining)} free`}
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-aico-hover" role="progressbar" aria-label="Planned points against capacity" aria-valuemin={0} aria-valuemax={plan.capacity} aria-valuenow={state.total}>
            <div className={`h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none ${state.over ? 'bg-aico-warning' : 'bg-aico-accent'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>

        {candidates.length === 0 && unestimated.length === 0 ? (
          <p className="rounded-lg bg-aico-surface px-3 py-3 text-[13px] leading-relaxed text-aico-secondary">The backlog is empty. Add tasks, or plan from a brief, then come back.</p>
        ) : (
          <>
            {candidates.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className={LABEL + ' !mb-0'}>{manual === null ? 'Proposed from the top of the backlog' : 'Your selection'}</span>
                  <span className="flex-1" />
                  {manual !== null && <button type="button" className={`${BTN_GHOST} !px-2 !py-0.5 !text-[12px]`} onClick={() => setManual(null)}>Reset to the proposal</button>}
                </div>
                <ul className="divide-y divide-aico-border-subtle overflow-hidden rounded-xl border border-aico-border-subtle">{candidates.map(row)}</ul>
              </div>
            )}
            {plan.overlaps.length > 0 && (
              <p className="rounded-lg bg-aico-surface px-3 py-2 text-[12.5px] leading-snug text-aico-secondary">
                Some of these are expected to touch the same files ({plan.overlaps.slice(0, 2).map(o => `${ref(o.a)} and ${ref(o.b)}: ${o.files[0]}`).join('; ')}). Agents will take turns on them, so they finish later than if they were independent.
              </p>
            )}
            {unestimated.length > 0 && (
              <div>
                <span className={LABEL}>Needs an estimate to be planned</span>
                <ul className="divide-y divide-aico-border-subtle overflow-hidden rounded-xl border border-dashed border-aico-border">
                  {unestimated.slice(0, 8).map(t => (
                    <li key={t.id} className="flex items-center gap-2.5 px-3 py-1.5">
                      <span className="font-mono text-[11.5px] tabular-nums text-aico-muted">{ref(t.id)}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-aico-primary">{t.title}</span>
                      <EstimateChip id={t.id} title={t.title} estimate={t.estimate} onSet={p => setEstimate(t, p)} />
                    </li>
                  ))}
                </ul>
                {unestimated.length > 8 && <p className="mt-1 text-[11.5px] text-aico-muted">and {unestimated.length - 8} more in the Backlog view.</p>}
              </div>
            )}
          </>
        )}

        {!planned?.startedAt && (
          <label className="flex items-start gap-2 text-[13px] text-aico-primary">
            <input type="checkbox" checked={startNow} onChange={e => setStartNow(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--aico-accent)]" />
            <span>Start the sprint now<span className="block text-[12px] text-aico-muted">Its tasks become Ready. Agents take them only when you start the agents.</span></span>
          </label>
        )}

        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_GHOST} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className={BTN_PRIMARY} disabled={busy || chosen.length === 0}>
            {busy ? 'Committing…' : `Commit ${chosen.length} ${chosen.length === 1 ? 'task' : 'tasks'} · ${pointsWord(state.total)}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Start or close a sprint: say what will happen, then do it as a person. */
export function SprintActionDialog({ project, sprint, kind, tasks, onClose, onDone }: {
  project: string; sprint: Sprint; kind: 'start' | 'close'; tasks: readonly Task[]; onClose: () => void; onDone: (message: string) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = tasks.filter(t => t.sprintId === sprint.id && t.status !== 'cancelled');
  const open = mine.filter(t => t.status !== 'merged');
  const running = open.filter(t => t.status === 'running' || t.status === 'review' || t.status === 'changes' || t.status === 'pr');
  const go = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      if (kind === 'start') await api.deliveryStartSprint(project, sprint.id); else await api.deliveryCloseSprint(project, sprint.id);
      await refreshBoard();
      onDone(kind === 'start' ? `${sprint.name} started. Start the agents when you want work to begin.` : `${sprint.name} closed. ${open.length} unfinished ${open.length === 1 ? 'task is' : 'tasks are'} back in the backlog.`);
      onClose();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title={kind === 'start' ? `Start ${sprint.name}` : `Close ${sprint.name}`} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        {kind === 'start' ? (
          <p className="text-[13.5px] leading-relaxed text-aico-primary">
            {mine.length} {mine.length === 1 ? 'task becomes' : 'tasks become'} Ready. Agents take them in priority order once the dispatcher is running; tasks outside the sprint are left alone. Nothing is spent by starting the sprint itself.
          </p>
        ) : (
          <div className="space-y-2 text-[13.5px] leading-relaxed text-aico-primary">
            <p>{mine.length - open.length} of {mine.length} tasks landed. {open.length === 0 ? 'Everything was delivered.' : `${open.length} unfinished ${open.length === 1 ? 'task goes' : 'tasks go'} back to the product backlog, and the result is recorded for velocity.`}</p>
            {running.length > 0 && <p className="rounded-lg bg-aico-surface px-3 py-2 text-[12.5px] text-aico-secondary">{running.length} {running.length === 1 ? 'task is' : 'tasks are'} still running or in review. Running agents are not stopped; approve what is ready first if you want it counted in this sprint.</p>}
          </div>
        )}
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_GHOST} disabled={busy} onClick={onClose}>Not now</button>
          <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void go()}>{busy ? 'Working…' : kind === 'start' ? 'Start sprint' : 'Close sprint'}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Adding one task to a running sprint is a scope change: say so before doing it. */
export function AddToSprintDialog({ project, sprint, task, onClose, onDone }: {
  project: string; sprint: Sprint; task: Task; onClose: () => void; onDone: (message: string) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = sprint.status === 'active';
  const go = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { await api.deliveryCommitSprint(project, sprint.id, [task.id], []); await refreshBoard(); onDone(`Added "${task.title}" to ${sprint.name}.`); onClose(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title={`Add to ${sprint.name}`} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <p className="text-[13.5px] leading-relaxed text-aico-primary">
          {active
            ? `This adds ${pointsWord(pointsOf(task))} after the sprint started. The burndown shows it as a step in the scope, and the task becomes Ready so agents can take it.`
            : `This adds "${task.title}" (${pointsWord(pointsOf(task))}) to the plan. The sprint has not started, so nothing runs yet.`}
        </p>
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_GHOST} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void go()}>{busy ? 'Adding…' : 'Add to sprint'}</button>
        </div>
      </div>
    </Modal>
  );
}
