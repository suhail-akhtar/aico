/**
 * Small pieces every Delivery component shares: button classes, the risk badge,
 * the priority chip, a status dot, skeletons and a modal shell.
 *
 * WHY here and not in a design-system file: Delivery is the only screen that
 * needs a risk badge or a priority chip, and the buttons deliberately match the
 * portal's existing ones (rounded-lg, accent primary) rather than inventing a
 * second look; shared/ui has no button primitive to reuse.
 *
 * Tinted backgrounds use `color-mix` on the theme variables instead of
 * Tailwind's `/12` modifier: the web build maps colours to plain `var(...)`,
 * where an opacity modifier is dropped, and the desktop build maps them
 * through color-mix. One spelling that works in both.
 *
 * Status text stays `text-aico-primary` on a tinted chip with a coloured dot:
 * the warning and success hues are below 4.5:1 as text on white, and a word
 * plus a dot is the "colour never alone" rule.
 *
 * @module web/components/delivery/ui
 */

import React, { createContext, useContext, useEffect, useRef } from 'react';
import { Portal } from '../Portal';
import type { Priority, RiskLevel } from '../../delivery-types';
import { PRIORITY_LABEL, nextTabIndex, shortId, type RefFn } from '../../delivery-model';
import { DvIcon, type DvGlyph } from './icons';

/** How a task id reads on screen ("#3"); provided once by the board, defaulting to the id's short form. */
export const RefContext = createContext<RefFn>(shortId);
export const useTaskRef = (): RefFn => useContext(RefContext);

export const BTN_PRIMARY = 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-aico-accent px-3 py-1.5 text-[13px] font-medium text-aico-on-accent transition-colors hover:bg-aico-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aico-accent disabled:cursor-not-allowed disabled:opacity-50';
export const BTN_OUTLINE = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-aico-border px-3 py-1.5 text-[13px] text-aico-primary transition-colors hover:bg-aico-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aico-accent disabled:cursor-not-allowed disabled:opacity-50';
export const BTN_GHOST = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-aico-secondary transition-colors hover:bg-aico-hover hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aico-accent disabled:cursor-not-allowed disabled:opacity-50';
export const INPUT = 'w-full rounded-lg border border-aico-border bg-aico-bg px-3 py-2 text-[13px] text-aico-primary placeholder:text-aico-muted focus:border-aico-accent focus:outline-none';
export const LABEL = 'mb-1 block text-[12px] font-medium text-aico-secondary';

// Tailwind finds classes by scanning source for whole strings, so every tint is spelled out here: a class
// assembled from `${v}` at run time is never generated and the background silently disappears.
const TINT: Record<string, string> = {
  danger: 'bg-[color-mix(in_srgb,var(--aico-danger)_12%,transparent)]',
  warning: 'bg-[color-mix(in_srgb,var(--aico-warning)_12%,transparent)]',
  success: 'bg-[color-mix(in_srgb,var(--aico-success)_12%,transparent)]',
  accent: 'bg-[color-mix(in_srgb,var(--aico-accent)_12%,transparent)]',
};
export const tint = (v: string): string => TINT[v] ?? '';
/** A hairline in a status hue, for a box that carries a state (never the only signal: a word and a glyph go with it). */
const EDGE: Record<string, string> = {
  danger: 'border-[color-mix(in_srgb,var(--aico-danger)_45%,transparent)]',
  warning: 'border-[color-mix(in_srgb,var(--aico-warning)_50%,transparent)]',
  success: 'border-[color-mix(in_srgb,var(--aico-success)_45%,transparent)]',
  accent: 'border-[color-mix(in_srgb,var(--aico-accent)_45%,transparent)]',
};
export const edge = (v: string): string => EDGE[v] ?? '';

const RISK: Record<RiskLevel, { word: string; bg: string; dot: string }> = {
  high: { word: 'High risk', bg: tint('danger'), dot: 'bg-aico-danger' },
  medium: { word: 'Medium risk', bg: tint('warning'), dot: 'bg-aico-warning' },
  low: { word: 'Low risk', bg: tint('success'), dot: 'bg-aico-success' },
};

export function RiskBadge({ level, score, unassessed, compact }: { level?: RiskLevel | undefined; score?: number | undefined; unassessed?: boolean; /** Just the level word, for a narrow card. */ compact?: boolean }): React.ReactElement {
  if (!level || unassessed) {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-aico-hover px-2 py-0.5 text-[11px] text-aico-secondary"><span className="h-1.5 w-1.5 rounded-full bg-aico-muted" />{compact ? 'Unrated' : 'Not assessed'}</span>;
  }
  const r = RISK[level];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium text-aico-primary ${r.bg}`} title={score !== undefined ? `${r.word}, score ${score}` : r.word}>
      <span className={`h-1.5 w-1.5 rounded-full ${r.dot}`} aria-hidden="true" />{compact ? r.word.replace(' risk', '') : r.word}
    </span>
  );
}

/** The left edge of a Review card: risk as a spine, so a column scans by colour before it is read. */
export function riskSpine(level?: RiskLevel): string {
  return level === 'high' ? 'before:bg-aico-danger' : level === 'low' ? 'before:bg-aico-success' : level === 'medium' ? 'before:bg-aico-warning' : 'before:bg-aico-border';
}

export function PriorityChip({ priority }: { priority: Priority }): React.ReactElement {
  const strong = priority <= 2;
  const bars = 5 - priority; // 4 bars for Urgent … 1 for Low
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] ${priority === 1 ? 'font-medium text-aico-danger' : strong ? 'font-medium text-aico-primary' : 'text-aico-muted'}`}
      title={`Priority: ${PRIORITY_LABEL[priority]}`}
    >
      <span className="inline-flex items-end gap-px" aria-hidden="true">
        {[1, 2, 3, 4].map(i => (
          <span key={i} className={`w-[2px] rounded-sm ${i <= bars ? 'bg-current' : 'bg-current opacity-25'}`} style={{ height: 3 + i * 2 }} />
        ))}
      </span>
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }): React.ReactElement {
  return <div className={`animate-pulse rounded-lg bg-aico-hover motion-reduce:animate-none ${className}`} aria-hidden="true" />;
}

/** Elements a Tab press may land on, in DOM order. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog over the page. Escape closes, focus lands inside and stays inside
 * (Tab and Shift+Tab wrap), focus returns to what opened it, and a click on
 * the scrim closes — except while `busy`, so a request in flight cannot be
 * orphaned by a stray click.
 *
 * The effect runs once, on open. `onClose` and `busy` are read through a ref:
 * callers pass a fresh arrow every render, and the board re-renders on every
 * live frame, so depending on them would re-run the effect and pull focus back
 * to the first field in the middle of typing.
 */
export function Modal({ title, onClose, children, busy, width = 'max-w-lg' }: {
  title: string; onClose: () => void; children: React.ReactNode; busy?: boolean; width?: string;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef({ onClose, busy });
  live.current = { onClose, busy };
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('textarea, input, select, button:not([data-modal-close])');
    first?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !live.current.busy) { e.stopPropagation(); live.current.onClose(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) { e.preventDefault(); return; }
      const firstEl = items[0]!; const lastEl = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !ref.current.contains(active)) { e.preventDefault(); firstEl.focus(); }
      else if (e.shiftKey && active === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && active === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, []);
  return (
    <Portal>
      <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`flex max-h-[92vh] w-full ${width} flex-col rounded-t-2xl border border-aico-border-subtle bg-aico-bg shadow-2xl sm:rounded-2xl`}>
          <div className="flex items-center gap-2 border-b border-aico-border-subtle px-5 py-3">
            <h2 className="flex-1 text-[15px] font-semibold text-aico-primary">{title}</h2>
            <button data-modal-close type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-md p-1.5 text-aico-muted hover:bg-aico-hover hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent disabled:opacity-40">
              <DvIcon name="close" size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </div>
      </div>
    </Portal>
  );
}

export function ErrorLine({ children, compact }: { children: React.ReactNode; /** Tighter, for a narrow card. */ compact?: boolean }): React.ReactElement {
  return (
    <p role="alert" className={`flex items-start rounded-lg text-aico-primary ${tint('danger')} ${compact ? 'gap-1.5 px-2 py-1.5 text-[11.5px] leading-snug' : 'gap-2 px-3 py-2 text-[12.5px]'}`}>
      <DvIcon name="alert" size={compact ? 13 : 15} className="mt-px shrink-0 text-aico-danger" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </p>
  );
}

// ── status ────────────────────────────────────────────────────────────

/** A line or chip in one hue with a glyph and words: the hue backs the words up, it never replaces them. */
export type Tone = 'info' | 'warning' | 'danger' | 'success';
const TONE: Record<Tone, { bg: string; icon: DvGlyph; text: string }> = {
  info: { bg: tint('accent'), icon: 'help', text: 'text-aico-accent' },
  warning: { bg: tint('warning'), icon: 'alert', text: 'text-aico-warning' },
  danger: { bg: tint('danger'), icon: 'alert', text: 'text-aico-danger' },
  success: { bg: tint('success'), icon: 'checkCircle', text: 'text-aico-success' },
};

export function Callout({ tone = 'info', icon, children, role, id, className = '', onDismiss }: {
  tone?: Tone; icon?: DvGlyph; children: React.ReactNode; role?: 'status' | 'alert'; id?: string; className?: string;
  /** A "Dismiss" button on the right edge, for a result the person should be able to put away. */
  onDismiss?: () => void;
}): React.ReactElement {
  const t = TONE[tone];
  return (
    <div id={id} role={role} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] leading-snug text-aico-primary ${t.bg} ${className}`}>
      <DvIcon name={icon ?? t.icon} size={15} className={`mt-px shrink-0 ${t.text}`} />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="-my-0.5 -mr-1.5 shrink-0 rounded-md px-2 py-0.5 text-[12px] text-aico-secondary hover:bg-aico-hover hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">Dismiss</button>
      )}
    </div>
  );
}

/** A small round chip: a glyph, a word. */
export function Pill({ tone, icon, children, title }: { tone?: Tone | 'neutral'; icon?: React.ReactNode; children: React.ReactNode; title?: string }): React.ReactElement {
  const bg = !tone || tone === 'neutral' ? 'bg-aico-hover' : TONE[tone].bg;
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium text-aico-primary ${bg}`}>
      {icon}{children}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }): React.ReactElement {
  return <span aria-hidden="true" style={{ width: size, height: size }} className="inline-block shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70 motion-reduce:animate-none" />;
}

// ── tabs ──────────────────────────────────────────────────────────────

export const tabId = (prefix: string, id: string): string => `${prefix}-tab-${id}`;
export const panelId = (prefix: string): string => `${prefix}-panel`;

/**
 * A tab strip that behaves like one: roving tabindex (one stop in the Tab order),
 * Left/Right/Home/End move and select, and each tab names its panel. The panel is
 * the caller's: give it `id={panelId(prefix)}`, `role="tabpanel"` and
 * `aria-labelledby={tabId(prefix, value)}`.
 */
export function Tabs<T extends string>({ label, prefix, value, onChange, items, variant = 'pill', className = '' }: {
  label: string; prefix: string; value: T; onChange: (v: T) => void;
  items: ReadonlyArray<{ id: T; label: string; badge?: string | number | undefined; badgeTone?: 'accent' | 'neutral' }>;
  variant?: 'pill' | 'underline'; className?: string;
}): React.ReactElement {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const onKey = (e: React.KeyboardEvent): void => {
    const n = nextTabIndex(items.length, items.findIndex(x => x.id === value), e.key);
    if (n === null) return;
    e.preventDefault();
    const target = items[n]!;
    onChange(target.id);
    refs.current.get(target.id)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKey} className={`${variant === 'pill' ? 'inline-flex max-w-full overflow-x-auto rounded-lg bg-aico-hover p-0.5' : 'flex gap-1'} ${className}`}>
      {items.map(t => {
        const on = t.id === value;
        const badge = t.badge !== undefined && t.badge !== '' && t.badge !== 0 ? (
          <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${t.badgeTone === 'accent' ? 'bg-aico-accent text-aico-on-accent' : 'bg-aico-hover text-aico-secondary'}`}>{t.badge}</span>
        ) : null;
        return (
          <button
            key={t.id} ref={el => { if (el) refs.current.set(t.id, el); else refs.current.delete(t.id); }}
            type="button" role="tab" id={tabId(prefix, t.id)} aria-selected={on} aria-controls={panelId(prefix)} tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={variant === 'pill'
              ? `flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent ${on ? 'bg-aico-bg font-medium text-aico-primary shadow-sm' : 'text-aico-secondary hover:text-aico-primary'}`
              : `relative flex items-center gap-1.5 px-2.5 py-2 text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-aico-accent ${on ? 'font-medium text-aico-primary' : 'text-aico-muted hover:text-aico-secondary'}`}
          >
            {t.label}{badge}
            {variant === 'underline' && on && <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-aico-accent" />}
          </button>
        );
      })}
    </div>
  );
}
