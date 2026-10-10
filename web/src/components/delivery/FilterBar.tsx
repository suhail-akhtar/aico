/**
 * Filtering the board: a text box that speaks the filter language, facet menus that
 * write to it, and saved views.
 *
 * The box is the truth (`assignee:"Agent A" type:bug fix login`, parsed by
 * delivery-board `parseFilter`); the menus are shortcuts that edit one key of it, so
 * the two can never disagree and a saved view is just the text. Saving asks for a name
 * inline (no dialog), the view lives in the board's settings so it follows the project
 * to every client, and applying one fills the box.
 *
 * WHY native selects for the facets: they are keyboard- and screen-reader-complete on
 * every platform for free, including a phone, and a four-value menu does not earn a
 * custom popover.
 *
 * @module web/components/delivery/FilterBar
 */

import React, { useEffect, useRef, useState } from 'react';
import { Portal } from '../Portal';
import { api } from '../../api';
import { refreshBoard } from '../../delivery';
import { PRIORITY_LABEL } from '../../delivery-model';
import { TYPE_LABEL, activeView, formatFilter, parseFilter, removeView, upsertView, type Filter } from '../../delivery-board';
import type { BoardState, SavedView, TaskType } from '../../delivery-types';
import { DvIcon } from './icons';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, ErrorLine, INPUT } from './ui';

const SELECT = `${INPUT} !w-auto !py-1.5 !pl-2 !pr-6 !text-[12.5px]`;

export function FilterBar({ query, onQuery, searchRef, assignees, labels, views, project, showStatus, onNotice }: {
  query: string; onQuery: (q: string) => void; searchRef: React.RefObject<HTMLInputElement | null>;
  assignees: string[]; labels: string[]; views: readonly SavedView[]; project: string; showStatus: boolean; onNotice: (m: string) => void;
}): React.ReactElement {
  const f = parseFilter(query);
  const set = (patch: Partial<Filter>): void => onQuery(formatFilter({ ...f, ...patch }));
  const current = activeView(views, query);
  const dirty = formatFilter(f) !== '';
  // On a phone the four menus sit behind one button; the text box and saved views are the quick path there.
  const [more, setMore] = useState(false);
  const facets = more ? 'contents' : 'hidden sm:contents';

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
      <div className="relative">
        <DvIcon name="filter" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-aico-muted" />
        <input
          ref={searchRef} type="search" value={query} onChange={e => onQuery(e.target.value)} aria-label="Filter tasks" placeholder="Filter tasks  /"
          title={'Words match the title, #number and labels. Keys: assignee:"Agent A" type:bug label:auth priority:1 status:ready is:needs is:blocked'}
          className={`${INPUT} !w-44 !py-1.5 !pl-7 !text-[12.5px] sm:!w-44`}
        />
      </div>
      <button type="button" aria-expanded={more} onClick={() => setMore(m => !m)} className={`${BTN_OUTLINE} !py-1.5 !text-[12.5px] sm:hidden`}><DvIcon name="filter" size={13} />Filters</button>
      <div className={facets}>
      <select aria-label="Filter by assignee" value={f.assignee[0] ?? ''} onChange={e => set({ assignee: e.target.value ? [e.target.value] : [] })} className={SELECT}>
        <option value="">Assignee</option>
        {assignees.map(a => <option key={a} value={a}>{a}</option>)}
        <option value="unassigned">Unassigned</option>
      </select>
      <select aria-label="Filter by type" value={f.type[0] ?? ''} onChange={e => set({ type: e.target.value ? [e.target.value as TaskType] : [] })} className={SELECT}>
        <option value="">Type</option>
        {(Object.keys(TYPE_LABEL) as TaskType[]).map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
      </select>
      {labels.length > 0 && (
        <select aria-label="Filter by label" value={f.label[0] ?? ''} onChange={e => set({ label: e.target.value ? [e.target.value] : [] })} className={SELECT}>
          <option value="">Label</option>
          {labels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      )}
      <select aria-label="Filter by priority" value={f.priority[0] ?? ''} onChange={e => set({ priority: e.target.value ? [Number(e.target.value)] : [] })} className={SELECT}>
        <option value="">Priority</option>
        {([1, 2, 3, 4] as const).map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
      </select>
      {showStatus && (
        <select aria-label="Filter by status" value={f.status[0] ?? ''} onChange={e => set({ status: e.target.value ? [e.target.value as never] : [] })} className={SELECT}>
          <option value="">Status</option>
          {['backlog', 'ready', 'running', 'review', 'changes', 'pr', 'merged', 'blocked', 'cancelled'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      )}
      </div>
      <ViewsMenu views={views} query={query} current={current} dirty={dirty} project={project} onApply={onQuery} onNotice={onNotice} />
      {dirty && <button type="button" className={`${BTN_GHOST} !py-1 !text-[12px]`} onClick={() => onQuery('')}>Clear</button>}
    </div>
  );
}

function ViewsMenu({ views, query, current, dirty, project, onApply, onNotice }: {
  views: readonly SavedView[]; query: string; current: SavedView | undefined; dirty: boolean; project: string;
  onApply: (q: string) => void; onNotice: (m: string) => void;
}): React.ReactElement {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!at) return;
    const close = (): void => setAt(null);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.current?.focus(); } };
    const onDown = (e: MouseEvent): void => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onDown); window.removeEventListener('resize', close); };
  }, [at]);

  const persist = async (next: SavedView[]): Promise<void> => {
    setBusy(true); setError(null);
    try { await api.deliverySettings(project, { views: next }); await refreshBoard(); }
    catch (e) { setError((e as Error).message); onNotice(`Could not save the view: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  return (
    <>
      <button
        ref={btn} type="button" aria-haspopup="dialog" aria-expanded={Boolean(at)} className={BTN_OUTLINE + ' !py-1.5 !text-[12.5px]'}
        aria-label={current ? `Saved views: ${current.name}` : 'Saved views'}
        onClick={() => { const r = btn.current!.getBoundingClientRect(); setAt(a => (a ? null : { x: Math.max(8, Math.min(r.left, window.innerWidth - 308)), y: r.bottom + 6 })); setError(null); }}
      >
        <DvIcon name="bookmark" size={13} />{current ? current.name : 'Views'}{views.length > 0 && !current && <span className="rounded-full bg-aico-hover px-1.5 text-[11px] tabular-nums text-aico-secondary">{views.length}</span>}
      </button>
      {at && (
        <Portal>
          <div ref={pop} role="dialog" aria-label="Saved views" style={{ position: 'fixed', top: at.y, left: at.x, width: 300 }} className="z-[75] rounded-xl border border-aico-border bg-aico-bg p-2 shadow-xl">
            {views.length === 0 ? (
              <p className="px-2 py-2 text-[12.5px] leading-snug text-aico-secondary">No saved views yet. Filter the board, then save the filter with a name to come back to it in one click.</p>
            ) : (
              <ul className="mb-1">
                {views.map(v => (
                  <li key={v.name} className="group flex items-center rounded-lg hover:bg-aico-hover">
                    <button type="button" onClick={() => { onApply(v.filter); setAt(null); }} className="min-w-0 flex-1 px-2.5 py-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">
                      <span className="block truncate text-[13px] text-aico-primary">{v.name}{current?.name === v.name && <span className="ml-1.5 text-[11px] text-aico-accent">active</span>}</span>
                      <span className="block truncate font-mono text-[11px] text-aico-muted">{v.filter || 'everything'}</span>
                    </button>
                    <button type="button" aria-label={`Delete the view ${v.name}`} disabled={busy} onClick={() => void persist(removeView(views, v.name))} className="mr-1 rounded-md p-1 text-aico-muted opacity-0 hover:bg-aico-hover hover:text-aico-danger focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100">
                      <DvIcon name="close" size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="border-t border-aico-border-subtle p-1.5 pt-2.5"
              onSubmit={e => { e.preventDefault(); if (!name.trim() || !dirty) return; void persist(upsertView(views, name, formatFilter(parseFilter(query)))).then(() => { setName(''); }); }}
            >
              <label className="mb-1 block text-[12px] font-medium text-aico-secondary" htmlFor="sv-name">Save the current filter</label>
              <div className="flex gap-1.5">
                <input id="sv-name" className={`${INPUT} !py-1.5`} value={name} onChange={e => setName(e.target.value)} placeholder={dirty ? 'e.g. My open bugs' : 'Filter the board first'} disabled={!dirty} />
                <button type="submit" className={BTN_PRIMARY} disabled={!dirty || !name.trim() || busy}>Save</button>
              </div>
              {error && <div className="mt-2"><ErrorLine compact>{error}</ErrorLine></div>}
            </form>
          </div>
        </Portal>
      )}
    </>
  );
}
