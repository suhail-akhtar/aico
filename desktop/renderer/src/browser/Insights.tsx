/**
 * Browsing insights — your browsing and what AICO blocked, counted and kept
 * only on this device (electron/browser-insights.ts): a headline, the day by
 * day chart for the last 7 or 30 days, top sites by time, the companies whose
 * trackers were blocked most, and "Clear insights".
 *
 * The chart shows one measure at a time (trackers blocked, or time browsed —
 * never two scales on one axis), with a tooltip on each day.
 *
 * @module desktop/renderer/browser/Insights
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { desktop } from '@/desktop';
import { toast } from '@/state/desk';
import type { InsightsSummary } from '@desk/browser-types';
import { call, useAvailable } from './ipc';
import { Favicon } from './Omnibox';
import { openUrl, showInternal } from './store';
import { ForYouCards, LearnedPanel } from './ForYou';

const fmt = (n: number): string => n.toLocaleString();

export function fmtTime(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return ms > 0 ? '<1 min' : '0 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Frame shared by the Insights and Privacy & security pages (matches the chrome's other pages). */
export function ChromePage({ title, icon, actions, children }: { title: string; icon: string; actions?: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="bx-chrome-page thin-scroll">
      <div className="mx-auto w-full max-w-[860px] px-8 pb-16 pt-8">
        <div className="mb-5 flex items-center gap-3">
          <Icon name={icon} size={20} className="text-aico-secondary" />
          <h1 className="flex-1 text-[22px] font-semibold tracking-tight">{title}</h1>
          {actions}
          <button className="icon-btn" onClick={() => showInternal(null)} title="Close (Esc)"><Icon name="x" size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function InsightsPage(): React.ReactElement {
  const [range, setRange] = useState<7 | 30>(7);
  const [data, setData] = useState<InsightsSummary | null | undefined>(undefined);
  const available = useAvailable('browser:insights:summary');
  const load = (): void => { void call<InsightsSummary>('browser:insights:summary', range).then(r => setData(r ?? null)).catch(() => setData(null)); };
  useEffect(load, [range]);
  // Time keeps being counted while this page is open elsewhere; refresh now and then.
  useEffect(() => { const t = setInterval(load, 30_000); return () => clearInterval(t); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = async (): Promise<void> => {
    const ok = await desktop.dialog.confirm({ title: 'Clear insights', message: 'Clear all browsing insights?', detail: 'Time per site, visits and the blocked-tracker tallies are removed from this device. History, bookmarks and settings are kept.', ok: 'Clear insights', danger: true }).catch(() => false);
    if (!ok) return;
    await call('browser:insights:clear').catch((e: Error) => toast.error('Could not clear', e.message));
    load();
  };

  const t = data?.totals;
  const period = range === 7 ? 'this week' : 'in the last 30 days';
  return (
    <ChromePage title="Insights" icon="chart" actions={
      <>
        <div className="segmented" role="group" aria-label="Range">
          {([7, 30] as const).map(r => <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r} days</button>)}
        </div>
        <button className="btn-outline btn-sm" disabled={!t || (t.trackers === 0 && t.ms === 0 && t.pages === 0)} onClick={() => void clear()}>Clear insights</button>
      </>
    }>
      {!available && <p className="py-16 text-center text-[13px] text-aico-muted">Insights are not available in this version.</p>}
      {available && data === undefined && <div className="skeleton h-40 w-full" />}
      {data && t && (
        <>
          {!data.enabled && (
            <div className="mb-4 flex items-center gap-2 rounded-xl bg-aico-hover/70 px-3 py-2 text-[12.5px] text-aico-secondary">
              <Icon name="info" size={14} />Recording insights is off — nothing new is counted.
              <button className="ml-auto text-aico-accent hover:underline" onClick={() => showInternal('privacy')}>Turn on</button>
            </div>
          )}
          <div className="card mb-4 flex items-center gap-4 p-5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-aico-success/10 text-aico-success"><Icon name="shield-check" size={24} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[20px] font-semibold tracking-tight">AICO blocked {fmt(t.trackers)} tracker{t.trackers === 1 ? '' : 's'} {period}</div>
              <div className="mt-0.5 text-[12.5px] text-aico-muted">
                and {fmt(t.cookies)} third-party cookie request{t.cookies === 1 ? '' : 's'} · {fmt(t.upgrades)} HTTPS upgrade{t.upgrades === 1 ? '' : 's'} · counted on this device only{data.since ? ` · since ${new Date(`${data.since}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
              </div>
            </div>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Time browsing" value={fmtTime(t.ms)} />
            <Tile label="Sites" value={fmt(t.sites)} />
            <Tile label="Pages" value={fmt(t.pages)} />
            <Tile label="Suspicious pages" value={fmt(t.warned)} tone={t.warned ? 'warn' : undefined} />
            <Tile label="Downloads" value={fmt(t.downloads)} />
            <Tile label="HTTPS upgrades" value={fmt(t.upgrades)} />
          </div>

          <DailyChart days={data.days} />

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="card p-4">
              <div className="mb-2 text-[13px] font-semibold">Top sites by time</div>
              {data.topSites.length === 0 && <Empty text="Sites you spend time on appear here." />}
              <RankList rows={data.topSites.map(s => ({ key: s.site, label: s.site, value: s.ms, text: fmtTime(s.ms), sub: `${fmt(s.visits)} visit${s.visits === 1 ? '' : 's'} · ${fmt(s.trackers)} blocked`, icon: <Favicon url={`https://${s.site}/`} size={16} />, onClick: () => openUrl(`https://${s.site}/`) }))} />
            </div>
            <div className="card p-4">
              <div className="mb-2 text-[13px] font-semibold">Tracker companies blocked most</div>
              {data.topCompanies.length === 0 && <Empty text="Companies whose trackers AICO blocked appear here." />}
              <RankList rows={data.topCompanies.map(c => ({ key: c.company, label: c.company, value: c.count, text: fmt(c.count) }))} />
            </div>
          </div>
          <ForYouCards place="insights" />
          <LearnedPanel />
          <p className="mt-4 text-center text-[11.5px] text-aico-muted">
            Time is counted only while a page is in front and AICO is in use. Insights never leave this device, and “Clear browsing data” clears them too.
          </p>
        </>
      )}
    </ChromePage>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'warn' }): React.ReactElement {
  return (
    <div className="card px-3 py-2.5">
      <div className="truncate text-[11.5px] text-aico-muted">{label}</div>
      <div className={cls('text-[17px] font-semibold tabular-nums', tone === 'warn' && 'text-aico-warning')}>{value}</div>
    </div>
  );
}

function Empty({ text }: { text: string }): React.ReactElement {
  return <div className="py-6 text-center text-[12.5px] text-aico-muted">{text}</div>;
}

function RankList({ rows }: { rows: Array<{ key: string; label: string; value: number; text: string; sub?: string; icon?: React.ReactNode; onClick?: () => void }> }): React.ReactElement {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <div className="space-y-0.5">
      {rows.map(r => (
        <div key={r.key} className={cls('group rounded-lg px-2 py-1.5', r.onClick && 'cursor-pointer hover:bg-aico-hover')} onClick={r.onClick}>
          <div className="flex items-center gap-2 text-[12.5px]">
            {r.icon}
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="shrink-0 tabular-nums text-aico-secondary">{r.text}</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-aico-border-subtle">
            <div className="h-full rounded-full bg-aico-accent/70" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </div>
          {r.sub && <div className="mt-0.5 text-[11px] text-aico-muted">{r.sub}</div>}
        </div>
      ))}
    </div>
  );
}

type Measure = 'trackers' | 'ms';

/** One series, one axis: trackers blocked per day, or time browsed per day. */
function DailyChart({ days }: { days: InsightsSummary['days'] }): React.ReactElement {
  const [measure, setMeasure] = useState<Measure>('trackers');
  const [hover, setHover] = useState<number | null>(null);
  const values = days.map(d => (measure === 'trackers' ? d.trackers : d.ms));
  const max = Math.max(...values, 0);
  const nice = useMemo(() => niceMax(measure === 'ms' ? max / 60_000 : max), [max, measure]);
  const top = measure === 'ms' ? nice * 60_000 : nice;
  const W = 800; const H = 180; const padL = 44; const padB = 22; const padT = 8;
  const plotW = W - padL - 8; const plotH = H - padB - padT;
  const slot = plotW / days.length;
  const barW = Math.max(3, Math.min(28, slot * 0.62));
  const label = (v: number): string => (measure === 'ms' ? fmtTime(v) : fmt(v));
  const ticks = [0, 0.5, 1].map(f => f * top);
  const dayName = (k: string, long = false): string => new Date(`${k}T12:00:00`).toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric' } : days.length > 10 ? { day: 'numeric' } : { weekday: 'short' });
  const h = hover !== null ? days[hover] : null;

  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex-1 text-[13px] font-semibold">{measure === 'trackers' ? 'Trackers blocked per day' : 'Time browsing per day'}</div>
        <div className="segmented scale-[.92]" role="group" aria-label="Measure">
          <button aria-pressed={measure === 'trackers'} onClick={() => setMeasure('trackers')}>Trackers</button>
          <button aria-pressed={measure === 'ms'} onClick={() => setMeasure('ms')}>Time</button>
        </div>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img"
          aria-label={`${measure === 'trackers' ? 'Trackers blocked' : 'Time browsing'} per day: ${days.map((d, i) => `${dayName(d.day, true)} ${label(values[i]!)}`).join(', ')}`}
          onMouseLeave={() => setHover(null)}>
          {ticks.map(v => {
            const y = padT + plotH - (top ? (v / top) * plotH : 0);
            return (
              <g key={v}>
                <line x1={padL} x2={W - 8} y1={y} y2={y} stroke="var(--aico-border-subtle)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <text x={padL - 6} y={y + 3.5} textAnchor="end" fontSize="10.5" fill="var(--aico-text-muted)">{measure === 'ms' ? `${Math.round(v / 60_000)}m` : fmt(Math.round(v))}</text>
              </g>
            );
          })}
          {days.map((d, i) => {
            const v = values[i]!;
            const bh = top ? Math.max(v > 0 ? 2 : 0, (v / top) * plotH) : 0;
            const x = padL + slot * i + (slot - barW) / 2;
            const y = padT + plotH - bh;
            const r = Math.min(4, barW / 2, bh);
            return (
              <g key={d.day} onMouseEnter={() => setHover(i)}>
                <rect x={padL + slot * i} y={padT} width={slot} height={plotH + padB} fill="transparent" />
                {bh > 0 && (
                  <path d={`M${x},${y + bh} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + bh} Z`}
                    fill="var(--aico-accent)" opacity={hover === null || hover === i ? 1 : 0.45} />
                )}
                {(days.length <= 10 || i % 5 === 0 || i === days.length - 1) && (
                  <text x={padL + slot * i + slot / 2} y={H - 6} textAnchor="middle" fontSize="10.5" fill="var(--aico-text-muted)">{dayName(d.day)}</text>
                )}
              </g>
            );
          })}
        </svg>
        {h && hover !== null && (
          <div className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border border-aico-border-subtle bg-aico-bg px-2.5 py-1.5 text-[11.5px] shadow-lg"
            style={{ left: `${((padL + slot * hover + slot / 2) / W) * 100}%` }}>
            <div className="font-medium">{dayName(h.day, true)}</div>
            <div className="text-aico-secondary">{fmt(h.trackers)} trackers blocked</div>
            <div className="text-aico-secondary">{fmtTime(h.ms)} browsing · {fmt(h.pages)} pages</div>
            <div className="text-aico-muted">{fmt(h.cookies)} cookie requests blocked</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A round axis maximum: 0 → 1, 7 → 10, 34 → 40, 230 → 250. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 4, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
