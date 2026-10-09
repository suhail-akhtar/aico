/**
 * The small pieces of the Scrum views: the Kanban | Scrum switch, the story-point chip
 * with its picker, the burndown sparkline, the pace chip and the titled panel.
 *
 * WHY together: each is a dozen lines, none is used outside the Scrum views, and they
 * share one rule: colour backs a word up and never replaces it (a pace is "Behind" in
 * words with a dot, a point chip says "5 pts" to a screen reader).
 *
 * The sparkline is plain SVG on purpose. It is 130 px of two lines in a header that
 * renders on every live frame; loading a charting library for it would cost more than
 * the chart. The full burndown and velocity charts use ECharts (ScrumChart).
 *
 * @module web/components/delivery/scrum/bits
 */

import React, { useEffect, useRef, useState } from 'react';
import { Portal } from '../../Portal';
import { POINT_SCALE, PACE_LABEL, paceTone, type Mode } from '../../../delivery-scrum';
import type { PaceStatus } from '../../../delivery-scrum';
import { tint } from '../ui';

// ── Kanban | Scrum ───────────────────────────────────────────────────────

export function ModeSwitch({ mode, busy, onChange }: { mode: Mode; busy?: boolean; onChange: (m: Mode) => void }): React.ReactElement {
  const opts: Array<{ id: Mode; label: string; hint: string }> = [
    { id: 'kanban', label: 'Kanban', hint: 'A continuous flow: agents take whatever is ready.' },
    { id: 'scrum', label: 'Scrum', hint: 'Sprints, story points and a daily summary on this same board. Switching loses nothing.' },
  ];
  return (
    <div role="radiogroup" aria-label="Board mode" className="inline-flex rounded-lg bg-aico-hover p-0.5">
      {opts.map(o => (
        <button
          key={o.id} type="button" role="radio" aria-checked={mode === o.id} disabled={busy} title={o.hint} onClick={() => { if (mode !== o.id) onChange(o.id); }}
          className={`rounded-md px-2.5 py-1 text-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent disabled:opacity-60 ${mode === o.id ? 'bg-aico-bg font-medium text-aico-primary shadow-sm' : 'text-aico-secondary hover:text-aico-primary'}`}
        >{o.label}</button>
      ))}
    </div>
  );
}

// ── story points ─────────────────────────────────────────────────────────

/**
 * A task's story points. Click to pick from the usual scale (or clear). On a card it sits
 * above the card's stretched title button (`relative z-10`) so it stays clickable. A task
 * that is finished shows its points but cannot change them.
 */
export function EstimateChip({ id, title, estimate, locked, onSet, className = '' }: {
  id: string; title: string; estimate?: number | undefined; locked?: boolean; onSet: (points: number | null) => void | Promise<void>; className?: string;
}): React.ReactElement | null {
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!at) return;
    const close = (): void => setAt(null);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.current?.focus(); } };
    const onDown = (e: MouseEvent): void => { if (!menu.current?.contains(e.target as Node) && e.target !== btn.current) close(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    menu.current?.querySelector<HTMLElement>('button[aria-checked="true"], button')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [at]);

  if (locked) {
    return estimate ? <span className={`rounded-md bg-aico-hover px-1.5 py-px text-[11.5px] font-semibold tabular-nums text-aico-secondary ${className}`} title={`Story points: ${estimate}`}>{estimate}<span className="sr-only"> points</span></span> : null;
  }
  const set = !!estimate;
  return (
    <>
      <button
        ref={btn} type="button" aria-haspopup="menu" aria-expanded={Boolean(at)}
        aria-label={set ? `Story points for ${title}: ${estimate}. Change` : `No estimate for ${title}. Set story points`}
        title={set ? `Story points: ${estimate}. Click to change` : 'No estimate yet. Click to set story points'}
        onClick={() => { const r = btn.current!.getBoundingClientRect(); setAt(a => (a ? null : { x: Math.min(r.left, window.innerWidth - 232), y: r.bottom + 4 })); }}
        data-estimate={id}
        className={`relative z-10 min-w-[1.5rem] rounded-md px-1.5 py-px text-center text-[11.5px] tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent max-md:min-h-[28px] ${set ? 'bg-aico-hover font-semibold text-aico-primary hover:bg-aico-border-subtle' : 'border border-dashed border-aico-border text-aico-muted hover:border-aico-accent hover:text-aico-primary'} ${className}`}
      >
        {set ? estimate : 'pts'}
      </button>
      {at && (
        <Portal>
          <div
            ref={menu} role="menu" aria-label={`Story points for ${title}`}
            style={{ position: 'fixed', top: at.y, left: Math.max(8, at.x), width: 224 }}
            className="z-[80] rounded-xl border border-aico-border bg-aico-bg p-2 shadow-xl"
          >
            <p className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-aico-muted">Story points</p>
            <div className="grid grid-cols-6 gap-1" role="presentation">
              {POINT_SCALE.map(n => (
                <button
                  key={n} type="button" role="menuitemradio" aria-checked={estimate === n}
                  onClick={() => { setAt(null); void onSet(n); }}
                  className={`rounded-lg py-1.5 text-[13px] font-medium tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent ${estimate === n ? 'bg-aico-accent text-aico-on-accent' : 'bg-aico-hover text-aico-primary hover:bg-aico-border-subtle'}`}
                >{n}</button>
              ))}
            </div>
            <p className="px-1 pt-1.5 text-[11.5px] leading-snug text-aico-muted">Relative effort and uncertainty, not hours.</p>
            {set && (
              <button type="button" role="menuitem" onClick={() => { setAt(null); void onSet(null); }} className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-[12.5px] text-aico-secondary hover:bg-aico-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">
                Clear the estimate
              </button>
            )}
          </div>
        </Portal>
      )}
    </>
  );
}

// ── pace ─────────────────────────────────────────────────────────────────

const DOT: Record<ReturnType<typeof paceTone>, string> = { success: 'bg-aico-success', warning: 'bg-aico-warning', danger: 'bg-aico-danger', neutral: 'bg-aico-muted' };
const BG: Record<ReturnType<typeof paceTone>, string> = { success: tint('success'), warning: tint('warning'), danger: tint('danger'), neutral: 'bg-aico-hover' };

export function PaceChip({ status, title }: { status: PaceStatus; title?: string }): React.ReactElement {
  const tone = paceTone(status);
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium text-aico-primary ${BG[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} aria-hidden="true" />{PACE_LABEL[status]}
    </span>
  );
}

// ── sparkline ────────────────────────────────────────────────────────────

/** Remaining against ideal, 130 × 36, with today as a dot. Decorative: the numbers beside it carry the meaning. */
export function Sparkline({ remaining, ideal, label }: { remaining: Array<number | null>; ideal: number[]; label: string }): React.ReactElement {
  const w = 140; const h = 40; const pad = 3;
  const max = Math.max(1, ...ideal, ...remaining.map(v => v ?? 0));
  const x = (i: number): number => pad + (i / Math.max(1, ideal.length - 1)) * (w - pad * 2);
  const y = (v: number): number => pad + (1 - v / max) * (h - pad * 2);
  const idealPath = ideal.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const real = remaining.map((v, i) => (v === null ? null : [i, v] as const)).filter((p): p is readonly [number, number] => p !== null);
  const realPath = real.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = real.at(-1);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="shrink-0 overflow-visible">
      <path d={idealPath} fill="none" stroke="var(--aico-text-muted)" strokeWidth="1.25" strokeDasharray="3 3" strokeLinecap="round" />
      {realPath && <path d={realPath} fill="none" stroke="var(--aico-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
      {last && <circle cx={x(last[0])} cy={y(last[1])} r="3" fill="var(--aico-accent)" stroke="var(--aico-bg)" strokeWidth="1.5" />}
    </svg>
  );
}

// ── panel ────────────────────────────────────────────────────────────────

export function Panel({ title, hint, actions, children, className = '', id }: {
  title: string; hint?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; id?: string;
}): React.ReactElement {
  return (
    <section aria-labelledby={id} className={`rounded-xl border border-aico-border-subtle bg-aico-surface ${className}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-1 pt-3">
        <h2 id={id} className="text-[13px] font-semibold text-aico-primary">{title}</h2>
        <span className="flex-1" />
        {actions}
      </div>
      {hint && <p className="px-4 text-[12px] leading-snug text-aico-muted">{hint}</p>}
      <div className="px-4 pb-4 pt-2">{children}</div>
    </section>
  );
}
