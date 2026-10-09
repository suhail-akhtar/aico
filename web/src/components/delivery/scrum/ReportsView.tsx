/**
 * Reports: the daily summary, the burndown and the velocity.
 *
 * Purpose: the morning question ("where are we, what needs me") and the sprint-shape
 * question ("will we make it, how much do we usually do"). The daily summary is built
 * from the board by the shared fold (no model call), so it can be read, copied into a
 * stand-up note, and trusted to match the log. The burndown shows the ideal line, what
 * remains, today, and scope that moved as a step so added work is never hidden. Velocity
 * is points completed per closed sprint with the rolling average; tasks that merged
 * without an estimate count as 0 and the page says how many.
 *
 * Every chart carries its data as text (ScrumChart) and every empty state says what makes
 * it fill in.
 *
 * @module web/components/delivery/scrum/ReportsView
 */

import React, { useMemo, useState } from 'react';
import {
  burndown, burndownOption, burndownRows, dailyMarkdown, dailySummary, defaultCapacity, paceDetail, pointsWord, shortDate, velocity,
  velocityOption, velocityRows, type DailyLine, type Sprint,
} from '../../../delivery-scrum';
import type { Task } from '../../../delivery-types';
import { BTN_OUTLINE, useTaskRef } from '../ui';
import { PaceChip, Panel } from './bits';
import { ScrumChart } from './ScrumChart';

export function ReportsView({ tasks, sprints, now, offsetMin, onOpenTask }: {
  tasks: readonly Task[]; sprints: readonly Sprint[]; now: number; offsetMin: number; onOpenTask: (id: string) => void;
}): React.ReactElement {
  const shown = sprints.filter(s => s.status !== 'planned');
  const [pick, setPick] = useState<string | null>(null);
  const sprint = shown.find(s => s.id === pick) ?? shown.find(s => s.status === 'active') ?? shown.at(-1);
  const bd = useMemo(() => (sprint ? burndown(sprint, tasks, now, offsetMin) : null), [sprint, tasks, now, offsetMin]);
  const vel = useMemo(() => velocity(sprints), [sprints]);
  const daily = useMemo(() => dailySummary({ tasks, sprints, now, offsetMin, mode: 'scrum' }), [tasks, sprints, now, offsetMin]);
  const suggested = defaultCapacity(sprints);
  const byId = new Map(tasks.map(t => [t.id, t]));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Panel
          id="rp-burndown" title="Burndown" className="min-w-0"
          hint={bd ? paceDetail(bd) : undefined}
          actions={shown.length > 1 ? (
            <select aria-label="Sprint" value={sprint?.id ?? ''} onChange={e => setPick(e.target.value)} className="rounded-md border border-aico-border bg-aico-bg px-1.5 py-0.5 text-[12px] text-aico-primary">
              {[...shown].reverse().map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          ) : bd ? <PaceChip status={bd.status} /> : undefined}
        >
          {sprint && bd ? (
            <>
              <ScrumChart
                height={250} label={`Burndown for ${sprint.name}: ${bd.remaining} of ${bd.scope} points remaining`}
                build={pal => burndownOption(bd, pal)} table={{ cols: ['Day', 'Remaining', 'Ideal'], rows: burndownRows(bd) }}
              />
              {bd.scopeChanges.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Scope changes">
                  {bd.scopeChanges.map((c, i) => (
                    <li key={i} className="rounded-md bg-aico-hover px-2 py-0.5 text-[11.5px] text-aico-secondary">
                      <span className="tabular-nums font-medium text-aico-primary">{c.points > 0 ? '+' : '−'}{Math.abs(c.points)}</span> {c.kind === 'remove' ? 'removed' : c.kind === 'estimate' ? 're-estimated' : 'added'} {shortDate(c.date)}: {byId.get(c.taskId)?.title ?? c.taskId}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <Empty title="The burndown starts with the sprint" body="Once a sprint is running you will see points remaining against the ideal line, with added scope shown as a step." />
          )}
        </Panel>

        <DailyCard className="max-lg:order-first" daily={daily} onOpenTask={onOpenTask} />

        <Panel
          id="rp-velocity" title="Velocity" className="min-w-0 lg:col-span-2"
          hint={vel.rows.length ? `Points completed in each closed sprint. Average of the last ${Math.min(3, vel.rows.length)}: ${pointsWord(vel.average ?? 0)}${suggested ? ` · suggested capacity ${suggested}` : ''}.` : undefined}
        >
          {vel.rows.length > 0 ? (
            <>
              <ScrumChart
                height={220} label={`Velocity over ${vel.rows.length} closed sprints`}
                build={pal => velocityOption(vel, pal)} table={{ cols: ['Sprint', 'Committed', 'Completed', 'Average'], rows: velocityRows(vel) }}
              />
              {vel.unestimatedMerged > 0 && (
                <p className="mt-1 text-[12px] text-aico-muted">{vel.unestimatedMerged} merged {vel.unestimatedMerged === 1 ? 'task had' : 'tasks had'} no estimate and count as 0 points.</p>
              )}
            </>
          ) : (
            <Empty title="Velocity appears after your first closed sprint" body="It is the points you complete per sprint. It also sets the default capacity the next time you plan." />
          )}
        </Panel>
      </div>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }): React.ReactElement {
  return (
    <div className="rounded-lg border border-dashed border-aico-border px-4 py-8 text-center">
      <p className="text-[13.5px] font-medium text-aico-primary">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-aico-secondary">{body}</p>
    </div>
  );
}

export function DailyCard({ daily, onOpenTask, className = '' }: { daily: ReturnType<typeof dailySummary>; onOpenTask: (id: string) => void; className?: string }): React.ReactElement {
  const ref = useTaskRef();
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(dailyMarkdown(daily)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard may be blocked: the text is on screen anyway */ }
  };
  const group = (title: string, rows: DailyLine[], empty: string, tone?: 'warn'): React.ReactElement => (
    <div>
      <h3 className="flex items-center gap-2 text-[12px] font-semibold text-aico-secondary">
        {title}<span className="rounded-full bg-aico-hover px-1.5 text-[11px] font-normal tabular-nums">{rows.length}</span>
      </h3>
      {rows.length === 0 ? <p className="mt-0.5 text-[12.5px] text-aico-muted">{empty}</p> : (
        <ul className="mt-1 space-y-1">
          {rows.map(r => (
            <li key={r.id} className="text-[13px] leading-snug">
              <button type="button" onClick={() => onOpenTask(r.id)} className="text-left text-aico-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">
                <span className="mr-1.5 font-mono text-[11.5px] tabular-nums text-aico-muted">{ref(r.id)}</span>{r.title}{r.points ? <span className="ml-1 text-aico-muted tabular-nums">({r.points})</span> : null}
              </button>
              {r.reason && <span className={`block pl-0 text-[12px] ${tone === 'warn' ? 'text-aico-warning' : 'text-aico-secondary'}`}>{r.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <Panel
      id="rp-daily" title="Daily summary" className={`min-w-0 ${className}`}
      hint={`${shortDate(daily.date)}, since ${shortDate(daily.since)}${daily.sprint ? ` · ${daily.sprint.name}, day ${daily.sprint.day} of ${daily.sprint.of}` : ''}`}
      actions={<button type="button" className={`${BTN_OUTLINE} !py-1 !text-[12px]`} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy as text'}</button>}
    >
      <div className="space-y-3">
        {daily.pace && (
          <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-aico-secondary">
            <PaceChip status={daily.pace.status} />
            <span className="tabular-nums">{daily.pace.remaining} of {daily.pace.scope} points remaining</span>
          </p>
        )}
        {group(`Done${daily.donePoints ? ` (${daily.donePoints} pts)` : ''}`, daily.done, 'Nothing has landed yet.')}
        {group('In progress', daily.inProgress, 'No agent is working on a sprint task.')}
        {group('Waiting for review', daily.inReview, 'Nothing is waiting.')}
        {group('Needs you', daily.needsYou, 'No agent is waiting on you.', 'warn')}
        {group('Blocked', daily.blocked, 'Nothing is blocked.', 'warn')}
      </div>
    </Panel>
  );
}
