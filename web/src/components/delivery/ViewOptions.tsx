/**
 * "Display": how the board is laid out, in one popover: swimlanes and density.
 *
 * WHY a popover: both are settings of the picture, not of the data, and a person sets
 * them once. Left as always-visible controls they cost a third toolbar row on every
 * visit, which is exactly the clutter a board that wants to be calm cannot afford. The
 * chip says what is active ("Lanes: Assignee") so a changed view is never invisible.
 *
 * @module web/components/delivery/ViewOptions
 */

import React, { useEffect, useRef, useState } from 'react';
import { Portal } from '../Portal';
import { LANE_OPTIONS, type LaneBy } from '../../delivery-board';
import { Segmented } from './board-bits';
import { DvIcon } from './icons';
import { INPUT, LABEL } from './ui';
import type { Density } from './TaskCard';

export function ViewOptions({ laneBy, onLaneBy, density, onDensity }: {
  laneBy: LaneBy; onLaneBy: (l: LaneBy) => void; density: Density; onDensity: (d: Density) => void;
}): React.ReactElement {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
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

  const lanes = LANE_OPTIONS.find(o => o.id === laneBy)!;
  const changed = laneBy !== 'none' || density !== 'comfortable';
  return (
    <>
      <button
        ref={btn} type="button" aria-haspopup="dialog" aria-expanded={Boolean(at)}
        onClick={() => { const r = btn.current!.getBoundingClientRect(); setAt(a => (a ? null : { x: Math.max(8, Math.min(r.right - 280, window.innerWidth - 292)), y: r.bottom + 6 })); }}
        title="Swimlanes and card density"
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] transition-colors hover:bg-aico-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent ${changed ? 'border-aico-accent bg-aico-accent-soft text-aico-primary' : 'border-aico-border text-aico-primary'}`}
      >
        <DvIcon name="layers" size={13} className="text-aico-muted" />
        {laneBy !== 'none' ? `Lanes: ${lanes.label}` : 'Display'}{density === 'compact' && laneBy === 'none' ? ': compact' : ''}
        <DvIcon name="down" size={12} className="text-aico-muted" />
      </button>
      {at && (
        <Portal>
          <div ref={pop} role="dialog" aria-label="View options" style={{ position: 'fixed', top: at.y, left: at.x, width: 280 }} className="z-[75] space-y-3 rounded-xl border border-aico-border bg-aico-bg p-3 shadow-xl">
            <div>
              <label className={LABEL} htmlFor="vo-lanes">Swimlanes</label>
              <select id="vo-lanes" className={INPUT} value={laneBy} onChange={e => onLaneBy(e.target.value as LaneBy)}>
                {LANE_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.id === 'none' ? 'None' : `By ${o.label.toLowerCase()}`}</option>)}
              </select>
              <p className="mt-1 text-[11.5px] leading-snug text-aico-muted">Rows across the columns, one per assignee, type or epic.</p>
            </div>
            <div>
              <span className={LABEL}>Cards</span>
              <Segmented
                label="Density" value={density} onChange={onDensity}
                items={[{ id: 'comfortable', label: 'Comfortable', hint: 'Full cards' }, { id: 'compact', label: 'Compact', hint: 'Titles and the marks that need you' }]}
              />
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
