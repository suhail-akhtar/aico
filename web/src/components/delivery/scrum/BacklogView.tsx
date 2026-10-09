/**
 * The product backlog, for refinement and planning.
 *
 * Purpose: before a sprint, someone reads the backlog top to bottom asking of each item
 * "is it sized, is it clear, is it small enough". The page orders items the way the plan
 * will (priority, then age), shows the answer to those three questions as a point chip
 * and, where something is missing, a word ("No estimate", "No criteria", "Large"), and
 * puts the agent's suggestions at the top as things to accept or dismiss.
 *
 * The suggestions are data until a person accepts (the engine's route is gated); this
 * view never applies one by itself. "Refine with an agent" starts one planning turn that
 * can only suggest, and opens its chat so the person can watch it.
 *
 * @module web/components/delivery/scrum/BacklogView
 */

import React, { useMemo, useState } from 'react';
import { api } from '../../../api';
import { refreshBoard, upsertTask } from '../../../delivery';
import { gapWords, pointsWord, productBacklog, scopeNet, type Proposal, type Sprint } from '../../../delivery-scrum';
import type { Task } from '../../../delivery-types';
import { DvIcon } from '../icons';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, ErrorLine, PriorityChip, Spinner, useTaskRef } from '../ui';
import { EstimateChip, Panel } from './bits';

export function BacklogView({ project, tasks, proposals, sprint, onOpenTask, onPlan, onAdd, onRefine, refining, onHandled }: {
  project: string;
  tasks: readonly Task[];
  proposals: readonly Proposal[];
  /** The sprint tasks can join: the one being planned, else the running one. */
  sprint: Sprint | undefined;
  onOpenTask: (id: string) => void;
  onPlan: () => void;
  onAdd: (task: Task) => void;
  onRefine: () => void;
  refining: boolean;
  onHandled: (message: string) => void;
}): React.ReactElement {
  const ref = useTaskRef();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const list = useMemo(() => productBacklog(tasks), [tasks]);
  const byId = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const unsized = list.filter(t => !t.estimate).length;
  const total = list.reduce((n, t) => n + (t.estimate ?? 0), 0);

  const setEstimate = async (t: Task, points: number | null): Promise<void> => {
    setError(null);
    try { upsertTask(await api.deliveryEstimate(t.id, project, points)); }
    catch (e) { setError(`Could not set the estimate: ${(e as Error).message}`); }
  };
  const decide = async (p: Proposal, accept: boolean): Promise<void> => {
    setBusyId(p.id); setError(null);
    try {
      if (accept) {
        const r = await api.deliveryAcceptProposal(project, p.id);
        onHandled(p.kind === 'split' ? `Split into ${r.created.length} tasks. The original was cancelled and its place in the plan went to the parts.` : p.kind === 'estimate' ? `Estimate set to ${p.points}.` : 'Acceptance criteria added.');
      } else await api.deliveryDismissProposal(project, p.id);
      await refreshBoard();
    } catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[13px] text-aico-secondary" aria-live="polite">
            <span className="tabular-nums">{list.length}</span> {list.length === 1 ? 'item' : 'items'}, <span className="tabular-nums">{pointsWord(total)}</span> estimated{unsized > 0 ? <>, <span className="font-medium text-aico-primary tabular-nums">{unsized} without an estimate</span></> : ''}.
          </p>
          <button type="button" className={BTN_OUTLINE} onClick={onRefine} disabled={refining} title="Starts one planning turn that can only suggest estimates, splits and criteria">
            {refining ? <Spinner /> : <DvIcon name="sparkles" size={14} />}{refining ? 'Starting…' : 'Refine with an agent'}
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={onPlan}><DvIcon name="list" size={14} />Plan sprint</button>
        </div>

        {error && <ErrorLine>{error}</ErrorLine>}

        {proposals.length > 0 && (
          <Panel id="suggestions" title={`Suggestions from the agent (${proposals.length})`} hint="Nothing changes until you accept. Dismissing costs nothing.">
            <ul className="space-y-2">
              {proposals.map(p => {
                const t = byId.get(p.taskId);
                return (
                  <li key={p.id} className="rounded-lg border border-aico-border-subtle bg-aico-bg px-3 py-2.5" data-proposal={p.kind}>
                    <p className="text-[11.5px] text-aico-muted">
                      <span className="font-mono tabular-nums">{ref(p.taskId)}</span> · {p.kind === 'estimate' ? 'Estimate' : p.kind === 'split' ? 'Split' : 'Acceptance criteria'}
                    </p>
                    <button type="button" onClick={() => onOpenTask(p.taskId)} className="text-left text-[13.5px] font-medium leading-snug text-aico-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">{t?.title ?? p.taskId}</button>
                    <div className="mt-1.5 text-[13px] leading-snug text-aico-primary">
                      {p.kind === 'estimate' && <p>Suggested size: <strong className="tabular-nums">{pointsWord(p.points ?? 0)}</strong>{t?.estimate ? <span className="text-aico-muted"> (now {pointsWord(t.estimate)})</span> : ''}</p>}
                      {p.kind === 'criteria' && (
                        <ul className="list-disc space-y-0.5 pl-5">{(p.acceptance ?? []).map(a => <li key={a}>{a}</li>)}</ul>
                      )}
                      {p.kind === 'split' && (
                        <ol className="list-decimal space-y-1 pl-5">
                          {(p.parts ?? []).map(part => (
                            <li key={part.title}>
                              {part.title}{part.points ? <span className="text-aico-secondary tabular-nums"> ({part.points})</span> : ''}
                              {part.acceptance?.length ? <span className="block text-[12px] text-aico-secondary">{part.acceptance.join('; ')}</span> : null}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                    {p.note && <p className="mt-1.5 border-l-2 border-aico-border pl-2 text-[12px] italic leading-snug text-aico-secondary">{p.note}</p>}
                    <div className="mt-2 flex flex-wrap justify-end gap-2">
                      <button type="button" className={BTN_GHOST} disabled={busyId === p.id} onClick={() => void decide(p, false)}>Dismiss</button>
                      <button type="button" className={BTN_PRIMARY} disabled={busyId === p.id} onClick={() => void decide(p, true)}>{busyId === p.id ? 'Working…' : 'Accept'}</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}

        {list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-aico-border px-5 py-8 text-center">
            <p className="text-[14px] font-medium text-aico-primary">The backlog is empty</p>
            <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-aico-secondary">Everything is in a sprint or finished. Add tasks, or plan from a brief, and they will appear here for sizing.</p>
          </div>
        ) : (
          <ul className="divide-y divide-aico-border-subtle overflow-hidden rounded-xl border border-aico-border-subtle bg-aico-surface" aria-label="Product backlog">
            {list.map(t => {
              const gaps = gapWords(t);
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 sm:flex-nowrap">
                  <EstimateChip id={t.id} title={t.title} estimate={t.estimate} onSet={p => setEstimate(t, p)} />
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex items-center gap-2 text-[11.5px] text-aico-muted">
                      <span className="font-mono tabular-nums">{ref(t.id)}</span><PriorityChip priority={t.priority} />
                      {t.status !== 'backlog' && <span className="rounded-md bg-aico-hover px-1.5 py-px text-[11px] text-aico-secondary">{t.status === 'ready' ? 'Ready' : 'Blocked'}</span>}
                    </div>
                    <button type="button" onClick={() => onOpenTask(t.id)} className="line-clamp-2 text-left text-[13.5px] leading-snug text-aico-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">{t.title}</button>
                    {gaps.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">{gaps.map(g => <span key={g} className="rounded-md border border-dashed border-aico-border px-1.5 py-px text-[11px] text-aico-secondary">{g}</span>)}</div>
                    )}
                  </div>
                  {sprint && sprint.status !== 'closed' && (
                    <button type="button" className={BTN_OUTLINE} onClick={() => onAdd(t)} title={t.estimate ? `Add to ${sprint.name}` : `Add to ${sprint.name} (no estimate: it counts as 0 points)`}>
                      Add to sprint
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {sprint && sprint.status !== 'closed' && <p className="text-[12px] text-aico-muted">{sprint.name} holds {pointsWord(scopeNet(sprint, byId))} now{sprint.capacityPoints ? ` of ${pointsWord(sprint.capacityPoints)} capacity` : ''}.</p>}
      </div>
    </div>
  );
}
