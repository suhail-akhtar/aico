/**
 * The board's Activity panel and the metrics strip.
 *
 * The panel is a feed of what the agents and people did across the board, newest first,
 * filterable to one task; it sits beside the board (it takes width, it does not cover
 * cards) and is a toggle, off by default so the board stays calm. The metrics strip is
 * four numbers (cycle time, lead time, throughput over seven days, spent today against
 * the budget), collapsed by default for the same reason.
 *
 * WHY here and not in a report: "full and clear visibility" means the answer to "what
 * are the agents doing" is one click from the board, not a different page.
 *
 * @module web/components/delivery/ActivityPanel
 */

import React, { useMemo, useState } from 'react';
import { ago, formatUsd } from '../../delivery-model';
import { budgetShare, filterFeed, formatSpan } from '../../delivery-board';
import type { ActivityEntry, BoardMetrics, FeedEntry } from '../../delivery-types';
import { DvIcon } from './icons';
import { useTaskRef } from './ui';

const KIND_ICON: Record<string, 'bolt' | 'chat' | 'check' | 'alert' | 'play' | 'branch' | 'clock'> = {
  run: 'play', comment: 'chat', landed: 'check', failed: 'alert', created: 'clock', moved: 'branch',
};

export function ActivityPanel({ feed, titleOf, now, onOpenTask, onClose, className = '' }: {
  feed: readonly FeedEntry[]; titleOf: (id: string) => string | undefined; now: number; onOpenTask: (id: string) => void; onClose: () => void; className?: string;
}): React.ReactElement {
  const ref = useTaskRef();
  const [taskId, setTaskId] = useState('');
  const ids = useMemo(() => [...new Set(feed.flatMap(e => (e.taskId ? [e.taskId] : [])))], [feed]);
  const rows = useMemo(() => filterFeed(feed, taskId || null), [feed, taskId]);
  return (
    <aside aria-label="Activity" className={`flex min-h-0 w-full flex-col border-l border-aico-border-subtle bg-aico-bg ${className}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-aico-border-subtle px-3.5 py-2.5">
        <h2 className="text-[13px] font-semibold text-aico-primary">Activity</h2>
        <span className="flex-1" />
        <select aria-label="Show activity for" value={taskId} onChange={e => setTaskId(e.target.value)} className="max-w-[150px] rounded-md border border-aico-border bg-aico-bg px-1.5 py-1 text-[12px] text-aico-primary">
          <option value="">All tasks</option>
          {ids.map(id => <option key={id} value={id}>{ref(id)} {titleOf(id)?.slice(0, 24) ?? ''}</option>)}
        </select>
        <button type="button" onClick={onClose} aria-label="Hide activity" className="rounded-md p-1 text-aico-muted hover:bg-aico-hover hover:text-aico-primary"><DvIcon name="close" size={15} /></button>
      </div>
      {rows.length === 0 ? (
        <div className="m-3.5 rounded-lg border border-dashed border-aico-border px-3 py-4 text-[12.5px] leading-relaxed text-aico-secondary">
          <p className="font-medium text-aico-primary">Nothing has happened yet.</p>
          <p className="mt-1">Starts, finished runs, notes, landings and pauses from every agent appear here as they happen.</p>
        </div>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2">
          {rows.map((e, i) => (
            <li key={`${e.at}-${i}`} className="relative flex gap-2.5 border-b border-aico-border-subtle py-2 last:border-b-0">
              <DvIcon name={KIND_ICON[e.kind] ?? 'bolt'} size={13} className="mt-0.5 shrink-0 text-aico-muted" />
              <div className="min-w-0 flex-1 text-[12.5px] leading-snug">
                <p className="text-aico-primary">{e.text}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-aico-muted">
                  <span title={new Date(e.at).toLocaleString()}>{ago(e.at, now)}</span>
                  {e.taskId && (
                    <button type="button" onClick={() => onOpenTask(e.taskId!)} className="rounded font-mono text-aico-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent" title={titleOf(e.taskId)}>{ref(e.taskId)}</button>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

/** A task's timeline in the drawer: one line per event, oldest first, who did it spelled out. */
export function Timeline({ entries, now }: { entries: readonly ActivityEntry[]; now: number }): React.ReactElement {
  if (entries.length === 0) {
    return <p className="rounded-lg border border-dashed border-aico-border px-3 py-4 text-[13px] text-aico-secondary">Nothing has happened on this task yet.</p>;
  }
  const BY = { person: 'You', agent: 'Agent', system: 'Board' } as const;
  return (
    <ol className="relative ml-1.5 space-y-3 border-l border-aico-border-subtle pl-4">
      {entries.map((e, i) => (
        <li key={`${e.at}-${i}`} className="relative">
          <span className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full border-2 border-aico-bg ${e.by === 'agent' ? 'bg-aico-accent' : e.by === 'person' ? 'bg-aico-primary' : 'bg-aico-muted'}`} aria-hidden="true" />
          <p className="text-[13px] leading-snug text-aico-primary">{e.text}</p>
          <p className="mt-0.5 text-[11.5px] text-aico-muted"><span className="font-medium text-aico-secondary">{BY[e.by]}</span> · <span title={new Date(e.at).toLocaleString()}>{ago(e.at, now) || 'earlier'}</span></p>
        </li>
      ))}
    </ol>
  );
}

export function MetricsStrip({ metrics, budget }: { metrics: BoardMetrics | undefined; budget: number | undefined }): React.ReactElement {
  const share = budgetShare(metrics?.spentTodayUsd, budget);
  const tiles: Array<{ label: string; value: string; hint: string }> = [
    { label: 'Cycle time', value: formatSpan(metrics?.medianCycleMs), hint: 'Median time from an agent starting to the work landing' },
    { label: 'Lead time', value: formatSpan(metrics?.medianLeadMs), hint: 'Median time from a task being created to landing' },
    { label: 'Throughput', value: metrics ? `${metrics.throughput7d}` : '–', hint: 'Tasks landed in the last 7 days' },
  ];
  return (
    <section aria-label="Metrics" className="flex shrink-0 flex-wrap items-stretch gap-2 border-b border-aico-border-subtle px-4 py-2.5 sm:px-6">
      {tiles.map(t => (
        <div key={t.label} title={t.hint} className="min-w-[120px] rounded-lg border border-aico-border-subtle bg-aico-surface px-3 py-1.5">
          <p className="text-[11px] uppercase tracking-wide text-aico-muted">{t.label}</p>
          <p className="text-[18px] font-semibold tabular-nums leading-tight text-aico-primary">{t.value}{t.label === 'Throughput' && metrics ? <span className="ml-1 text-[11.5px] font-normal text-aico-muted">in 7 days</span> : null}</p>
        </div>
      ))}
      <div title="Spent today against the daily budget" className="min-w-[180px] flex-1 rounded-lg border border-aico-border-subtle bg-aico-surface px-3 py-1.5">
        <p className="text-[11px] uppercase tracking-wide text-aico-muted">Spent today</p>
        <p className="text-[18px] font-semibold tabular-nums leading-tight text-aico-primary">
          {formatUsd(metrics?.spentTodayUsd)}<span className="ml-1 text-[11.5px] font-normal text-aico-muted">{budget ? `of ${formatUsd(budget)}` : 'no daily budget set'}</span>
        </p>
        {share !== null && (
          <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-aico-hover" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label="Share of the daily budget spent">
            <span className={`block h-full rounded-full ${share >= 0.9 ? 'bg-aico-warning' : 'bg-aico-accent'}`} style={{ width: `${Math.round(share * 100)}%` }} />
          </span>
        )}
      </div>
    </section>
  );
}
