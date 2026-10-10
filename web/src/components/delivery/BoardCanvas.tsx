/**
 * The board itself: columns of cards, optionally in swimlanes.
 *
 * One CSS grid holds everything so the lanes and the columns line up: a sticky header
 * row (column title, count or WIP, collapse, add), then one band per lane. With no lanes
 * the single band stretches to the bottom, so an empty column is still a place to drop.
 * A column can collapse to a thin rail (kept per browser); Merged starts collapsed.
 *
 * Drag and drop does two jobs: moving a card to another column (only among the
 * statuses a person owns, `checkMove`) and putting it where you want in its column
 * (Backlog, Ready, Blocked: the dispatcher takes Ready top first). The insertion line
 * shows where it will land. Neither needs a mouse: the card menu and Alt + Up / Down do
 * the same, which is also how touch and screen readers do it.
 *
 * What it does not do: call the engine. It reports `onDrop(task, column, beforeId)`
 * and the view decides, so one place owns the optimistic update and the refusal text.
 *
 * @module web/components/delivery/BoardCanvas
 */

import React, { Fragment, useState } from 'react';
import { checkMove, type ColumnDef } from '../../delivery-model';
import { epicProgress, wipState, type Lane } from '../../delivery-board';
import type { Task, TaskStatus } from '../../delivery-types';
import { EpicBar } from './board-bits';
import { DvIcon } from './icons';
import { QuickAdd } from './QuickAdd';
import { TaskCard, type CardContext } from './TaskCard';
import { edge, tint } from './ui';

/** Columns where the person's order is kept (the review column stays in risk order, by design). */
export const REORDERABLE: readonly TaskStatus[] = ['backlog', 'ready', 'blocked'];
/** Columns a person can add to by typing. */
export const ADDABLE: readonly TaskStatus[] = ['backlog', 'ready'];

const EMPTY_COPY: Partial<Record<TaskStatus, string>> = {
  backlog: 'New tasks start here. Type one above, or plan from a brief.',
  ready: 'Drag tasks here for agents to pick up. Agents take the top one first.',
  running: 'No agent is working. Start the agents to begin.',
  review: 'Finished work waits here for you to approve or send back.',
  changes: 'Work you sent back appears here while the agent redoes it.',
  pr: 'Pull requests wait here for the remote’s checks and reviews.',
  merged: 'Nothing has landed yet.',
  blocked: 'Nothing is blocked.',
  cancelled: 'Nothing was cancelled or archived.',
};

export function BoardCanvas({ columns, groups, lanes, collapsed, onToggleCollapse, dragged, ctx, onDrop, quickAdd, onQuickAdd, project, onCreated, onError, wip, wipHard, filtered, allTasks, mergedCount }: {
  columns: ColumnDef[];
  /** Per lane, tasks by status. */
  groups: Array<{ lane: Lane; byStatus: Record<TaskStatus, Task[]> }>;
  lanes: boolean;
  collapsed: ReadonlySet<TaskStatus>;
  onToggleCollapse: (s: TaskStatus) => void;
  dragged: Task | null;
  ctx: (t: Task) => CardContext;
  onDrop: (t: Task, to: TaskStatus, beforeId: string | null) => void;
  quickAdd: TaskStatus | null;
  onQuickAdd: (s: TaskStatus | null) => void;
  project: string;
  onCreated: (t: Task) => void;
  onError: (m: string) => void;
  wip: (s: TaskStatus) => number | undefined;
  /** A limit the person set (amber at it), as opposed to the number of agents, where being full is the point. */
  wipHard: (s: TaskStatus) => boolean;
  filtered: boolean;
  allTasks: readonly Task[];
  mergedCount: number;
}): React.ReactElement {
  const [over, setOver] = useState<{ status: TaskStatus; before: string | null } | null>(null);
  const [laneShut, setLaneShut] = useState<Set<string>>(new Set());
  const template = columns.map(c => (collapsed.has(c.id) ? '44px' : 'minmax(var(--col-min), 1fr)')).join(' ');
  const count = (s: TaskStatus): number => groups.reduce((n, g) => n + g.byStatus[s].length, 0);
  const verdict = (s: TaskStatus): { ok: boolean; reason?: string } => {
    if (!dragged) return { ok: false };
    if (dragged.status === s) return REORDERABLE.includes(s) && !dragged.needs ? { ok: true } : { ok: false, reason: 'This column keeps its own order.' };
    const c = checkMove(dragged, s);
    return c.ok ? { ok: true } : { ok: false, reason: c.reason };
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-3 sm:px-6" tabIndex={-1}>
      <div
        className="grid min-h-full min-w-min snap-x snap-mandatory gap-x-3 [--col-min:84vw] sm:snap-none sm:[--col-min:200px]"
        style={{ gridTemplateColumns: template, gridTemplateRows: lanes ? `auto ${groups.map(() => 'auto auto').join(' ')}` : 'auto 1fr' }}
      >
        {columns.map((col, ci) => {
          const n = count(col.id);
          const limit = wip(col.id);
          const st = wipHard(col.id) ? wipState(limit, n) : 'none';
          const shut = collapsed.has(col.id);
          if (shut) {
            return (
              <div key={`h-${col.id}`} className="sticky top-0 z-10 self-start" style={{ gridRow: '1 / -1', gridColumn: ci + 1 }}>
                <button
                  type="button" onClick={() => onToggleCollapse(col.id)} aria-label={`Show ${col.label}, ${n} tasks`} aria-expanded={false}
                  className="flex h-[220px] w-full flex-col items-center gap-2 rounded-xl border border-dashed border-aico-border bg-aico-bg py-3 text-aico-muted transition-colors hover:bg-aico-hover hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
                >
                  <span className="rounded-full bg-aico-hover px-1.5 text-[11px] tabular-nums">{col.id === 'merged' ? mergedCount : n}</span>
                  <span className="text-[12px] font-medium [writing-mode:vertical-rl]">{col.label}</span>
                </button>
              </div>
            );
          }
          return (
            <div key={`h-${col.id}`} style={{ gridRow: 1, gridColumn: ci + 1 }} className={`sticky top-0 z-10 flex items-center gap-2 rounded-t-xl border border-b-0 px-3 pb-1 pt-2.5 ${st === 'at' || st === 'over' ? `${tint('warning')} ${edge('warning')}` : 'border-aico-border-subtle bg-aico-surface'}`}>
              <h2 className="text-[12px] font-semibold uppercase tracking-wide text-aico-secondary" title={col.hint}>{col.label}</h2>
              <span
                className={`rounded-full px-1.5 text-[11px] tabular-nums ${st === 'at' || st === 'over' ? 'bg-aico-warning font-medium text-aico-on-accent' : 'bg-aico-hover text-aico-secondary'}`}
                title={limit ? `${n} of a limit of ${limit}${st === 'over' ? ': over the limit' : st === 'at' ? ': at the limit' : ''}` : undefined}
              >
                {limit ? `${n}/${limit}` : n}
              </span>
              {st === 'over' && <span className="text-[11px] font-medium text-aico-primary">over limit</span>}
              {st === 'at' && <span className="text-[11px] text-aico-secondary">at limit</span>}
              {st === 'none' && limit !== undefined && n >= limit && <span className="text-[11px] text-aico-muted" title="Every agent is busy">full</span>}
              <span className="flex-1" />
              {ADDABLE.includes(col.id) && (
                <button type="button" onClick={() => onQuickAdd(quickAdd === col.id ? null : col.id)} aria-label={`Add a task to ${col.label}`} aria-pressed={quickAdd === col.id} title={`Add a task to ${col.label}  (n for the full form)`} className="rounded-md p-0.5 text-aico-muted hover:bg-aico-hover hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">
                  <DvIcon name="plus" size={15} />
                </button>
              )}
              <button type="button" onClick={() => onToggleCollapse(col.id)} aria-label={`Collapse ${col.label}`} aria-expanded title="Collapse this column" className="rounded-md p-0.5 text-aico-muted hover:bg-aico-hover hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">
                <DvIcon name="chevron" size={14} className="rotate-180" />
              </button>
            </div>
          );
        })}

        {groups.map(({ lane, byStatus }, li) => {
          const last = li === groups.length - 1;
          const shut = laneShut.has(lane.key);
          const total = columns.reduce((n, c) => n + byStatus[c.id].length, 0);
          return (
            <Fragment key={lane.key || 'all'}>
              {lanes && (
                <div style={{ gridRow: 2 + li * 2, gridColumn: '1 / -1' }} className="flex items-center gap-3 border-y border-aico-border-subtle bg-aico-bg py-1.5 pl-1 pr-2">
                  <button
                    type="button" aria-expanded={!shut} onClick={() => setLaneShut(s => { const n = new Set(s); if (n.has(lane.key)) n.delete(lane.key); else n.add(lane.key); return n; })}
                    className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] font-medium text-aico-primary hover:bg-aico-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
                  >
                    <DvIcon name="chevron" size={13} className={`shrink-0 transition-transform ${shut ? '' : 'rotate-90'}`} />
                    <span className="truncate">{lane.label}</span>
                    <span className="rounded-full bg-aico-hover px-1.5 text-[11px] font-normal tabular-nums text-aico-secondary">{total}</span>
                  </button>
                  {lane.epic && epicProgress(lane.epic.id, allTasks).total > 0 && <EpicBar epicId={lane.epic.id} tasks={allTasks} compact />}
                </div>
              )}
              {!shut && columns.map((col, ci) => {
                const tasks = byStatus[col.id];
                const isShut = collapsed.has(col.id);
                if (isShut) return null; // its rail spans every row, from the header
                const v = verdict(col.id);
                const origin = dragged?.status === col.id;
                const showLine = (before: string | null): boolean => over?.status === col.id && over.before === before && v.ok;
                return (
                  <section
                    key={`${lane.key}-${col.id}`}
                    style={{ gridRow: lanes ? 3 + li * 2 : 2, gridColumn: ci + 1 }}
                    aria-label={`${col.label}${lanes ? `, ${lane.label}` : ''}, ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}
                    onDragOver={e => { if (v.ok) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!(over?.status === col.id && over.before === null)) setOver({ status: col.id, before: null }); } else if (dragged) e.dataTransfer.dropEffect = 'none'; }}
                    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => (o?.status === col.id ? null : o)); }}
                    onDrop={e => { e.preventDefault(); const target = over?.status === col.id ? over.before : null; setOver(null); if (dragged && v.ok) onDrop(dragged, col.id, target); }}
                    title={dragged && !v.ok && !origin && v.reason ? v.reason : undefined}
                    className={`flex min-w-0 snap-start flex-col border-x px-2 pb-2 pt-1 transition-colors duration-150 ${last || !lanes ? 'rounded-b-xl border-b' : ''} ${lanes ? 'mb-2 rounded-xl border' : ''}
                      ${over?.status === col.id && v.ok ? 'border-aico-accent bg-aico-accent-soft' : v.ok ? 'border-dashed border-aico-accent bg-aico-surface' : dragged && !origin ? 'border-aico-border-subtle bg-aico-surface opacity-55' : 'border-aico-border-subtle bg-aico-surface'}`}
                  >
                    {quickAdd === col.id && li === 0 && (ADDABLE as readonly string[]).includes(col.id) && (
                      <div className="mb-2"><QuickAdd autoFocus project={project} status={col.id as 'backlog' | 'ready'} onCreated={onCreated} onError={onError} onCancel={() => onQuickAdd(null)} /></div>
                    )}
                    <ul className={`flex flex-1 flex-col gap-2 ${lanes ? 'min-h-[44px]' : 'min-h-[72px]'}`}>
                      {dragged && !v.ok && !origin && v.reason && (
                        <li className="rounded-lg border border-dashed border-aico-border px-2.5 py-2 text-[11.5px] leading-snug text-aico-secondary">{v.reason}</li>
                      )}
                      {tasks.map((t, i) => (
                        <li
                          key={t.id}
                          onDragOver={e => {
                            if (!v.ok || t.id === dragged?.id) return;
                            e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
                            const r = e.currentTarget.getBoundingClientRect();
                            const before = e.clientY < r.top + r.height / 2 ? t.id : tasks[i + 1]?.id ?? null;
                            if (!(over?.status === col.id && over.before === before)) setOver({ status: col.id, before });
                          }}
                        >
                          {showLine(t.id) && <div className="-mt-1.5 mb-0.5 h-0.5 rounded-full bg-aico-accent" aria-hidden="true" />}
                          <div className={dragged?.id === t.id ? 'opacity-40' : ''}><TaskCard task={t} ctx={ctx(t)} /></div>
                          {i === tasks.length - 1 && showLine(null) && <div className="mt-1.5 h-0.5 rounded-full bg-aico-accent" aria-hidden="true" />}
                        </li>
                      ))}
                      {tasks.length === 0 && !dragged && !lanes && (
                        <li className="px-2 py-3 text-center text-[12px] leading-snug text-aico-muted">
                          {filtered ? 'No matches.' : EMPTY_COPY[col.id] ?? 'Nothing here.'}
                          {!filtered && ADDABLE.includes(col.id) && li === 0 && quickAdd !== col.id && (
                            <button type="button" onClick={() => onQuickAdd(col.id)} className="mt-1.5 block w-full rounded-md py-1 text-[12px] text-aico-accent hover:bg-aico-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">+ Add a task</button>
                          )}
                        </li>
                      )}
                    </ul>
                  </section>
                );
              })}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
