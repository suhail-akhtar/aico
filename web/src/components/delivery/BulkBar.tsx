/**
 * The bar that appears when cards are ticked: one change applied to all of them.
 *
 * Status, priority, estimate and assignee go through the engine's single bulk route; a
 * label is added per task (a bulk patch would replace each task's own labels with one
 * list, which is not what "add a label" means). A status change skips tasks a person
 * may not move (agent-owned ones) and says how many it skipped, instead of failing the lot.
 *
 * @module web/components/delivery/BulkBar
 */

import React, { useState } from 'react';
import { api } from '../../api';
import { refreshBoard } from '../../delivery';
import { PERSON_STATUSES, PRIORITY_LABEL, STATUS_LABEL, checkMove } from '../../delivery-model';
import type { Priority, Task, TaskStatus } from '../../delivery-types';
import { DvIcon } from './icons';
import { BTN_GHOST, INPUT, Spinner } from './ui';

const SEL = `${INPUT} !w-auto !py-1 !text-[12.5px]`;
const POINTS = [1, 2, 3, 5, 8, 13];

export function BulkBar({ ids, tasks, project, assignees, onClear, onDone, onError }: {
  ids: string[]; tasks: readonly Task[]; project: string; assignees: string[]; onClear: () => void; onDone: (m: string) => void; onError: (m: string) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [who, setWho] = useState('');
  const byId = new Map(tasks.map(t => [t.id, t]));

  const run = async (what: string, fn: () => Promise<number | void>): Promise<void> => {
    setBusy(true);
    try {
      const n = await fn();
      await refreshBoard();
      onDone(`${what}${typeof n === 'number' && n < ids.length ? ` (${ids.length - n} skipped)` : ''}.`);
    } catch (e) { onError(`Could not apply that to ${ids.length} tasks: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  const setStatus = (to: TaskStatus): Promise<void> => run(`Moved to ${STATUS_LABEL[to]}`, async () => {
    const ok = ids.filter(id => { const t = byId.get(id); return t && checkMove(t, to).ok; });
    if (ok.length) await api.deliveryBulk(project, ok, { status: to });
    return ok.length;
  });
  const addLabel = (): Promise<void> => {
    const l = label.trim();
    if (!l) return Promise.resolve();
    return run(`Added the label ${l}`, async () => {
      await Promise.all(ids.map(id => { const t = byId.get(id); return t && !t.labels.includes(l) ? api.deliveryUpdate(id, project, { labels: [...t.labels, l] }) : Promise.resolve(); }));
      setLabel('');
    });
  };
  const assign = (): Promise<void> => {
    const name = who.trim();
    const known = tasks.find(t => t.assignee?.name.toLowerCase() === name.toLowerCase())?.assignee;
    return run(name ? `Assigned to ${name}` : 'Unassigned', async () => {
      await api.deliveryBulk(project, ids, { assignee: name ? (known ?? { kind: /^agent\b/i.test(name) ? 'agent' : 'person', name }) : null });
      setWho('');
    });
  };

  return (
    <div role="region" aria-label="Bulk actions" className="absolute inset-x-3 bottom-3 z-20 mx-auto flex max-w-4xl flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-aico-border bg-aico-bg px-3 py-2 shadow-[0_8px_28px_rgba(0,0,0,0.18)] sm:inset-x-6">
      <span className="text-[13px] font-medium tabular-nums text-aico-primary">{ids.length} selected</span>
      <select aria-label="Move selected to" className={SEL} disabled={busy} value="" onChange={e => { if (e.target.value) void setStatus(e.target.value as TaskStatus); }}>
        <option value="">Move to…</option>
        {PERSON_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
      <select aria-label="Set priority" className={SEL} disabled={busy} value="" onChange={e => { if (e.target.value) void run(`Priority set to ${PRIORITY_LABEL[Number(e.target.value) as Priority]}`, () => api.deliveryBulk(project, ids, { priority: Number(e.target.value) as Priority }).then(() => undefined)); }}>
        <option value="">Priority…</option>
        {([1, 2, 3, 4] as const).map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
      </select>
      <select aria-label="Set estimate" className={SEL} disabled={busy} value="" onChange={e => { if (e.target.value) void run(e.target.value === 'none' ? 'Estimate cleared' : `Estimate set to ${e.target.value}`, () => api.deliveryBulk(project, ids, { estimate: e.target.value === 'none' ? null : Number(e.target.value) }).then(() => undefined)); }}>
        <option value="">Estimate…</option>
        {POINTS.map(p => <option key={p} value={p}>{p} points</option>)}
        <option value="none">No estimate</option>
      </select>
      <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); void assign(); }}>
        <input list="dv-bulk-assignees" aria-label="Assign to" className={`${INPUT} !w-32 !py-1 !text-[12.5px]`} placeholder="Assign to…" value={who} onChange={e => setWho(e.target.value)} disabled={busy} />
        <datalist id="dv-bulk-assignees">{assignees.map(a => <option key={a} value={a} />)}</datalist>
        <button type="submit" className={`${BTN_GHOST} !px-2 !py-1 !text-[12.5px]`} disabled={busy}>Assign</button>
      </form>
      <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); void addLabel(); }}>
        <input aria-label="Add a label" className={`${INPUT} !w-28 !py-1 !text-[12.5px]`} placeholder="Add label…" value={label} onChange={e => setLabel(e.target.value)} disabled={busy} />
        <button type="submit" className={`${BTN_GHOST} !px-2 !py-1 !text-[12.5px]`} disabled={busy || !label.trim()}>Add</button>
      </form>
      <span className="flex-1" />
      {busy && <Spinner size={13} />}
      <button type="button" className={`${BTN_GHOST} !px-2 !py-1 !text-[12.5px]`} onClick={onClear}><DvIcon name="close" size={13} />Clear</button>
    </div>
  );
}
