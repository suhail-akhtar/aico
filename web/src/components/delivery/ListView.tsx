/**
 * The List view: every task as a sortable table row.
 *
 * Same data, same filter and the same drawer as the board; the table is for the
 * question a board answers badly ("everything due this week, oldest first"). Columns:
 * number, title, status, assignee, priority, type, estimate, due, updated. A header is a
 * button that sorts (ascending, then descending), and says which with `aria-sort`.
 * On a phone the table scrolls sideways inside its own box; the page never does.
 *
 * @module web/components/delivery/ListView
 */

import React, { useEffect, useMemo, useState } from 'react';
import { PRIORITY_LABEL, STATUS_LABEL, ago } from '../../delivery-model';
import { sortTasks, type SortKey } from '../../delivery-board';
import type { Task } from '../../delivery-types';
import { Avatar, BlockedChips, DueChip, TypeIcon } from './board-bits';
import { DvIcon } from './icons';
import { QuickAdd } from './QuickAdd';
import { Pill, PriorityChip, useTaskRef } from './ui';

const COLS: ReadonlyArray<{ key: SortKey; label: string; cls: string }> = [
  { key: 'ref', label: '#', cls: 'w-12' },
  { key: 'title', label: 'Title', cls: 'min-w-[220px]' },
  { key: 'status', label: 'Status', cls: 'w-32' },
  { key: 'assignee', label: 'Assignee', cls: 'w-36' },
  { key: 'priority', label: 'Priority', cls: 'w-24' },
  { key: 'type', label: 'Type', cls: 'w-20' },
  { key: 'estimate', label: 'Est.', cls: 'w-14' },
  { key: 'due', label: 'Due', cls: 'w-24' },
  { key: 'updated', label: 'Updated', cls: 'w-24' },
];

const STATUS_TONE: Record<string, 'info' | 'warning' | 'success' | 'neutral' | 'danger'> = {
  running: 'info', review: 'warning', changes: 'warning', pr: 'info', merged: 'success', blocked: 'danger', cancelled: 'neutral',
};

export function ListView({ tasks, all, byId, now, selectedId, focusedId, ticked, onTick, onTickAll, onOpen, onOpenTask, project, onCreated, onError, onOrder }: {
  tasks: readonly Task[]; all: readonly Task[]; byId: ReadonlyMap<string, Task>; now: number; selectedId: string | null; focusedId: string | null;
  ticked: ReadonlySet<string>; onTick: (t: Task) => void; onTickAll: (on: boolean) => void; onOpen: (t: Task) => void; onOpenTask: (id: string) => void;
  project: string; onCreated: (t: Task) => void; onError: (m: string) => void;
  /** The order the rows are in now, for the J / K keys. */
  onOrder: (ids: string[]) => void;
}): React.ReactElement {
  const ref = useTaskRef();
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'ref', dir: 'asc' });
  const rows = useMemo(() => sortTasks(tasks, sort.key, sort.dir, ref), [tasks, sort, ref]);
  useEffect(() => { onOrder(rows.map(t => t.id)); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (key: SortKey): void => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'updated' ? 'desc' : 'asc' }));
  const allTicked = rows.length > 0 && rows.every(t => ticked.has(t.id));

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-6">
      <div className="mb-3 max-w-xl"><QuickAdd project={project} status="backlog" placeholder="Add a task to the backlog  (Enter to add, !1 for urgent, #label)" onCreated={onCreated} onError={onError} /></div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-aico-border px-5 py-8 text-center text-[13px] text-aico-secondary">
          <p className="font-medium text-aico-primary">No tasks match.</p>
          <p className="mt-1">Clear the filter, or add a task above.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-aico-border-subtle">
          <table className="w-full min-w-[900px] border-collapse text-left text-[13px]">
            <caption className="sr-only">All tasks, sortable</caption>
            <thead className="bg-aico-surface text-[12px] text-aico-secondary">
              <tr>
                <th scope="col" className="w-9 px-2.5 py-2"><input type="checkbox" aria-label="Select all shown" checked={allTicked} onChange={e => onTickAll(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--aico-accent)]" /></th>
                {COLS.map(c => (
                  <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`${c.cls} px-2.5 py-2 font-medium`}>
                    <button type="button" onClick={() => toggle(c.key)} className="inline-flex items-center gap-1 rounded hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">
                      {c.label}
                      <DvIcon name={sort.key === c.key ? (sort.dir === 'asc' ? 'up' : 'down') : 'sort'} size={11} className={sort.key === c.key ? 'text-aico-primary' : 'text-aico-muted opacity-60'} />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(t => {
                const sel = t.id === selectedId;
                return (
                  <tr key={t.id} data-task={t.id} className={`border-t border-aico-border-subtle ${sel ? 'bg-aico-accent-soft' : 'hover:bg-aico-hover'} ${focusedId === t.id ? 'outline outline-2 -outline-offset-2 outline-aico-accent' : ''}`}>
                    <td className="px-2.5 py-1.5"><input type="checkbox" aria-label={`Select ${ref(t.id)}`} checked={ticked.has(t.id)} onChange={() => onTick(t)} className="h-3.5 w-3.5 accent-[var(--aico-accent)]" /></td>
                    <td className="px-2.5 py-1.5 font-mono text-[12px] tabular-nums text-aico-muted">{ref(t.id)}</td>
                    <td className="px-2.5 py-1.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <TypeIcon type={t.type} />
                        <button type="button" onClick={() => onOpen(t)} className="min-w-0 truncate text-left font-medium text-aico-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent" aria-label={`${ref(t.id)} ${t.title}. Open details`}>{t.title}</button>
                        {t.needs && <Pill tone="warning">Needs you</Pill>}
                        <span className="flex shrink-0 items-center gap-1"><BlockedChips task={t} byId={byId} onOpen={onOpenTask} max={1} /></span>
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5"><Pill tone={STATUS_TONE[t.status] ?? 'neutral'}>{STATUS_LABEL[t.status]}</Pill></td>
                    <td className="px-2.5 py-1.5"><span className="flex items-center gap-1.5"><Avatar assignee={t.assignee} size={20} /><span className="truncate text-aico-secondary">{t.assignee?.name ?? ''}</span></span></td>
                    <td className="px-2.5 py-1.5"><PriorityChip priority={t.priority} /><span className="sr-only">{PRIORITY_LABEL[t.priority]}</span></td>
                    <td className="px-2.5 py-1.5 capitalize text-aico-secondary">{t.type ?? ''}</td>
                    <td className="px-2.5 py-1.5 tabular-nums text-aico-secondary">{t.estimate ?? ''}</td>
                    <td className="px-2.5 py-1.5"><DueChip due={t.dueDate} now={now} done={t.status === 'merged' || t.status === 'cancelled'} /></td>
                    <td className="px-2.5 py-1.5 text-[12px] text-aico-muted">{ago(t.updatedAt, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[12px] text-aico-muted">{rows.length} of {all.length} tasks</p>
    </div>
  );
}
