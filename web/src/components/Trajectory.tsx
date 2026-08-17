/**
 * The event ledger: what actually happened, in order, with timings.
 *
 * The chat view is a *reading* of a session — prose, tool cards, the answer.
 * This is the session itself: every event the log holds, including the
 * bookkeeping the transcript hides. It is what you open when the question is
 * "why did that take ninety seconds" or "what did it actually send", which the
 * transcript cannot answer because it deliberately omits the machinery.
 *
 * Two things here earn their complexity:
 *
 * **The timeline separates waiting from streaming.** A nine-second step is a
 * completely different problem depending on whether eight of those seconds were
 * spent waiting for the first token — a cold cache, a queued request, a slow
 * provider — or spent streaming a long answer, which is just a long answer.
 * One bar per step would conflate them, so each step draws two.
 *
 * **Rows are windowed.** A long session holds tens of thousands of events, and
 * mounting them all makes the view unusable at exactly the moment it becomes
 * interesting. Only the visible slice plus a small overscan is rendered, with
 * uniform row heights so the scroll geometry needs no measurement.
 *
 * @module components/Trajectory
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, type LogEvent, type TrajectoryView } from '../api';
import { TrajectoryOverview, type Interval } from './TrajectoryOverview';
import { useStore } from '../store';

/** Fixed row height, in px. Uniform rows make windowing exact. */
const ROW_HEIGHT = 28;
/** Rows rendered above and below the viewport, to cover fast scrolling. */
const OVERSCAN = 12;

export function Trajectory(): React.ReactElement {
  const sessionId = useStore(s => s.sessionId);
  const busy = useStore(s => s.busy);

  const [view, setView] = useState<TrajectoryView | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [hideNoise, setHideNoise] = useState(true);
  /** Time range selected on the overview, or null for the whole session. */
  const [interval, setInterval_] = useState<Interval | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  const load = React.useCallback(async (): Promise<void> => {
    try {
      setView(await api.trajectory(sessionId, { limit: 2000 }));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  // While a turn runs the ledger is the thing being watched, so it refreshes;
  // once it stops there is nothing new to fetch and polling would be waste.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [busy, load]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = (): void => setViewportHeight(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => {
    const events = view?.events ?? [];
    const needle = filter.trim().toLowerCase();
    return events.filter(event => {
      if (hideNoise && NOISE_TYPES.has(event.type)) return false;
      // An interval selected on the overview focuses the ledger on what was
      // happening then — the point of selecting it.
      if (interval && (event.timestamp < interval.start || event.timestamp > interval.end)) {
        return false;
      }
      if (!needle) return true;
      return event.type.toLowerCase().includes(needle)
        || JSON.stringify(event.data).toLowerCase().includes(needle);
    });
  }, [view, filter, hideNoise, interval]);

  // Open at the tail: the interesting end of a ledger is the recent one.
  const pinnedToTail = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !pinnedToTail.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const window = rows.slice(first, first + visible);

  const selectedEvent = rows.find(e => e.seq === selected);

  if (error) {
    return <div className="p-8 text-sm text-aico-danger">Could not load the ledger: {error}</div>;
  }
  if (!view) {
    return <div className="p-8 text-sm text-aico-muted">Reading the log…</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-aico-hover px-4 sm:px-6 py-3">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3">
          <div>
            <h1 className="text-sm font-semibold text-aico-primary">Trajectory</h1>
            <p className="text-[11px] text-aico-muted">
              {rows.length === view.total
                ? `${view.total} events`
                : `${rows.length} of ${view.total} events`}
              {' · '}{view.steps.length} steps
              {interval && ' · focused on a time range'}
              {view.hasMore && ' · older events not loaded'}
            </p>
          </div>
          <div className="flex-1" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter events…"
            className="w-44 rounded-md border border-aico-hover bg-aico-elevated px-2 py-1 text-xs
                       text-aico-primary placeholder:text-aico-muted focus:border-aico-accent/50 focus:outline-none"
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-aico-muted">
            <input
              type="checkbox"
              checked={hideNoise}
              onChange={e => setHideNoise(e.target.checked)}
              className="accent-aico-accent"
            />
            hide chunks
          </label>
        </div>
      </header>

      <TrajectoryOverview
        steps={view.steps}
        selection={interval}
        onSelect={setInterval_}
      />

      <div className="flex min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={e => {
            const el = e.currentTarget;
            setScrollTop(el.scrollTop);
            pinnedToTail.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="min-w-0 flex-1 overflow-y-auto"
        >
          {/* One spacer of the full height keeps the scrollbar honest while
              only the visible slice is mounted. */}
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            <div style={{ position: 'absolute', top: first * ROW_HEIGHT, left: 0, right: 0 }}>
              {window.map(event => (
                <Row
                  key={event.seq}
                  event={event}
                  selected={event.seq === selected}
                  onSelect={() => setSelected(event.seq === selected ? null : event.seq)}
                />
              ))}
            </div>
          </div>
          {rows.length === 0 && (
            <p className="p-6 text-center text-xs text-aico-muted">
              {filter ? 'No events match that filter.' : 'This session has no events yet.'}
            </p>
          )}
        </div>

        {selectedEvent && (
          <Inspector event={selectedEvent} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
}

/** Event types that are pure volume rather than information. */
const NOISE_TYPES = new Set(['assistant/chunk']);

/** Colour per event family, so the shape of a turn is readable at a glance. */
function toneOf(type: string): string {
  if (type.startsWith('user/')) return 'text-aico-info';
  if (type.startsWith('assistant/')) return 'text-aico-primary';
  if (type.startsWith('tool/')) return 'text-aico-accent';
  if (type.startsWith('turn/')) return 'text-aico-success';
  if (type.startsWith('goal/') || type.startsWith('session/')) return 'text-purple-400';
  return 'text-aico-muted';
}

function Row(
  { event, selected, onSelect }: { event: LogEvent; selected: boolean; onSelect: () => void },
): React.ReactElement {
  return (
    <button
      onClick={onSelect}
      style={{ height: ROW_HEIGHT }}
      className={`flex w-full items-center gap-3 px-4 sm:px-6 text-left font-mono text-[11px]
                  transition-colors ${selected ? 'bg-aico-hover' : 'hover:bg-aico-hover/40'}`}
    >
      <span className="w-12 shrink-0 text-right text-aico-muted">{event.seq}</span>
      <span className={`w-40 shrink-0 truncate ${toneOf(event.type)}`}>{event.type}</span>
      <span className="min-w-0 flex-1 truncate text-aico-secondary">{summarize(event)}</span>
      <span className="w-16 shrink-0 text-right text-aico-muted">{clock(event.timestamp)}</span>
    </button>
  );
}

/** One line describing an event, chosen per type rather than dumping JSON. */
function summarize(event: LogEvent): string {
  const d = event.data;
  switch (event.type) {
    case 'user/message':
    case 'assistant/message':
      return String(d.content ?? '').slice(0, 200) || '(no text)';
    case 'tool/call':
      return `${String(d.name)} ${String(d.arguments ?? '').slice(0, 160)}`;
    case 'tool/result':
      return `${String(d.name)} → ${String(d.content ?? '').slice(0, 160)}`;
    case 'turn/start':
      return `turn ${String(d.turn)}`;
    case 'turn/end':
      return `turn ${String(d.turn)} · ${String((d.reason as { kind?: string })?.kind ?? '')}`;
    case 'step/start':
    case 'step/end':
      return `turn ${String(d.turn)} step ${String(d.step)}`;
    case 'session/title':
      return `${String(d.title)} (${String(d.source)})`;
    case 'goal/set':
      return `${String(d.status)}: ${String(d.text)}`;
    case 'message/feedback':
      return `seq ${String(d.targetSeq)} ${String(d.rating)}`;
    default: {
      const json = JSON.stringify(d);
      return json.length > 200 ? `${json.slice(0, 200)}…` : json;
    }
  }
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function Inspector(
  { event, onClose }: { event: LogEvent; onClose: () => void },
): React.ReactElement {
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-aico-hover bg-aico-surface">
      <header className="flex items-center gap-2 border-b border-aico-hover px-4 py-2">
        <span className={`font-mono text-xs ${toneOf(event.type)}`}>{event.type}</span>
        <span className="font-mono text-[10px] text-aico-muted">seq {event.seq}</span>
        <div className="flex-1" />
        <button onClick={onClose} className="text-aico-muted hover:text-aico-primary" aria-label="Close">
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-auto p-4">
        <div className="mb-3 text-[11px] text-aico-muted">
          {new Date(event.timestamp).toLocaleString()}
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-aico-secondary">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      </div>
    </aside>
  );
}
