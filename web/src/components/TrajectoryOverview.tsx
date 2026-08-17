/**
 * The time axis above the ledger.
 *
 * **Fixed height, horizontal.** Every step is a span positioned left-to-right
 * by when it actually happened. The previous version drew one row *per step*
 * and grew without bound: a session with 218 steps produced 218 stacked rows
 * that pushed the ledger — the actual content — completely off the page, and
 * scrolled the app chrome away with it. A timeline whose height depends on how
 * much happened is not a timeline.
 *
 * Each assistant span is drawn in two parts: the wait before the first token,
 * and the streaming after it. That split is the whole diagnostic value. A step
 * that took nine seconds is a different problem depending on which part
 * dominated, and one bar cannot say which.
 *
 * Wheel zooms the time domain and drag selects an interval, because at session
 * scale an individual two-second step is a fraction of a pixel. Selecting an
 * interval filters the ledger to the records alive during it, which is how you
 * get from "something took ages around there" to the events that did.
 *
 * @module components/TrajectoryOverview
 */

import React, { useMemo, useRef, useState } from 'react';
import type { StepTiming } from '../api';

/** Height of the band. Fixed on purpose — see the module note. */
const HEIGHT = 76;
const AXIS_HEIGHT = 18;
const LANE_TOP = 12;
const LANE_HEIGHT = 26;

export interface Interval { start: number; end: number }

export interface TrajectoryOverviewProps {
  steps: StepTiming[];
  /** The currently focused time range, or null for everything. */
  selection: Interval | null;
  onSelect: (interval: Interval | null) => void;
}

export function TrajectoryOverview({
  steps, selection, onSelect,
}: TrajectoryOverviewProps): React.ReactElement | null {
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(900);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [hover, setHover] = useState<StepTiming | null>(null);

  const bounds = useMemo(() => {
    if (steps.length === 0) return null;
    const start = Math.min(...steps.map(s => s.startedAt));
    const end = Math.max(...steps.map(s => s.endedAt ?? s.startedAt));
    return { start, end: Math.max(end, start + 1) };
  }, [steps]);

  /** Visible time domain. Zooming narrows it; it never leaves the bounds. */
  const [domain, setDomain] = useState<Interval | null>(null);
  const view = domain ?? (bounds ? { start: bounds.start, end: bounds.end } : null);

  React.useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const measure = (): void => setWidth(el.clientWidth || 900);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!bounds || !view) return null;

  const span = Math.max(view.end - view.start, 1);
  const toX = (t: number): number => ((t - view.start) / span) * width;
  const toTime = (x: number): number => view.start + (x / Math.max(width, 1)) * span;

  const onWheel = (event: React.WheelEvent): void => {
    event.preventDefault();
    const rect = svg.current?.getBoundingClientRect();
    if (!rect) return;
    // Zoom around the pointer, so the thing under the cursor stays put — the
    // only zoom behaviour that lets you aim at a spike and keep it in view.
    const anchor = toTime(event.clientX - rect.left);
    const factor = event.deltaY > 0 ? 1.25 : 0.8;
    const nextSpan = Math.min(
      Math.max(span * factor, 250),
      bounds.end - bounds.start,
    );
    const ratio = (anchor - view.start) / span;
    let start = anchor - ratio * nextSpan;
    let end = start + nextSpan;
    if (start < bounds.start) { start = bounds.start; end = start + nextSpan; }
    if (end > bounds.end) { end = bounds.end; start = end - nextSpan; }
    setDomain({ start, end });
  };

  const beginDrag = (event: React.MouseEvent): void => {
    // Right button clears, matching the "escape hatch that needs no aim" idea.
    if (event.button === 2) { onSelect(null); return; }
    const rect = svg.current?.getBoundingClientRect();
    if (!rect) return;
    const x = event.clientX - rect.left;
    setDrag({ from: x, to: x });
  };

  const moveDrag = (event: React.MouseEvent): void => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || !drag) return;
    setDrag({ ...drag, to: event.clientX - rect.left });
  };

  const endDrag = (): void => {
    if (!drag) return;
    const [a, b] = [drag.from, drag.to].sort((x, y) => x - y);
    setDrag(null);
    // A click, not a drag: treat it as clearing rather than selecting a
    // zero-width interval nothing can be inside.
    if (b - a < 4) { onSelect(null); return; }
    onSelect({ start: toTime(a), end: toTime(b) });
  };

  const selectionRect = selection
    ? { x: toX(selection.start), w: Math.max(toX(selection.end) - toX(selection.start), 2) }
    : null;

  return (
    <div className="shrink-0 border-b border-aico-border-subtle bg-aico-surface px-4 sm:px-6 py-2">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-1 flex items-center gap-3 text-[11px] text-aico-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm bg-aico-warning/70" /> waiting
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm bg-aico-success/70" /> streaming
          </span>
          <div className="flex-1" />
          {hover && (
            <span className="tabular-nums text-aico-secondary">
              step {hover.turn}.{hover.step}
              {hover.ttftMs !== undefined && ` · wait ${Math.round(hover.ttftMs)}ms`}
              {hover.decodeMs !== undefined && ` · stream ${Math.round(hover.decodeMs)}ms`}
              {hover.outputTokens !== undefined && ` · ${hover.outputTokens}t`}
            </span>
          )}
          {!hover && (
            <span className="tabular-nums">
              {(span / 1000).toFixed(1)}s shown of {((bounds.end - bounds.start) / 1000).toFixed(1)}s
              {domain && ' · scroll to zoom, drag to focus'}
            </span>
          )}
          {(domain || selection) && (
            <button
              onClick={() => { setDomain(null); onSelect(null); }}
              className="rounded px-1.5 py-0.5 text-[11px] text-aico-accent hover:bg-aico-hover"
            >
              Reset
            </button>
          )}
        </div>

        <svg
          ref={svg}
          height={HEIGHT}
          className="w-full cursor-crosshair select-none"
          onWheel={onWheel}
          onMouseDown={beginDrag}
          onMouseMove={moveDrag}
          onMouseUp={endDrag}
          onMouseLeave={() => { setDrag(null); setHover(null); }}
          onContextMenu={e => e.preventDefault()}
        >
          {/* Turn boundaries as thick rules, so the shape of the session reads
              before any individual step does. */}
          {steps.map((step, i) => {
            const previous = steps[i - 1];
            if (previous && previous.turn === step.turn) return null;
            const x = toX(step.startedAt);
            if (x < -20 || x > width + 20) return null;
            return (
              <g key={`turn-${step.turn}-${i}`}>
                <line x1={x} y1={0} x2={x} y2={HEIGHT - AXIS_HEIGHT}
                  stroke="var(--aico-border)" strokeWidth={1.5} />
                <text x={x + 3} y={10} className="fill-aico-muted" style={{ fontSize: 10 }}>
                  turn {step.turn}
                </text>
              </g>
            );
          })}

          {steps.map((step, i) => {
            const x = toX(step.startedAt);
            const endsAt = step.endedAt ?? step.startedAt;
            const total = Math.max(toX(endsAt) - x, 1);
            if (x + total < -10 || x > width + 10) return null;

            const waitMs = step.ttftMs ?? (endsAt - step.startedAt);
            const waitW = Math.max((waitMs / span) * width, 0.75);
            const streamW = step.decodeMs !== undefined
              ? Math.max((step.decodeMs / span) * width, 0.75)
              : 0;

            return (
              <g
                key={`${step.turn}-${step.step}-${i}`}
                onMouseEnter={() => setHover(step)}
              >
                <rect x={x} y={LANE_TOP} width={waitW} height={LANE_HEIGHT}
                  rx={1} className="fill-aico-warning/70" />
                {streamW > 0 && (
                  <rect x={x + waitW} y={LANE_TOP} width={streamW} height={LANE_HEIGHT}
                    rx={1} className="fill-aico-success/70" />
                )}
                {/* A wider invisible target: a sub-pixel span is impossible to
                    hover, and hovering is how the numbers are read. */}
                <rect x={x - 2} y={LANE_TOP} width={Math.max(total, 6)} height={LANE_HEIGHT}
                  fill="transparent" />
              </g>
            );
          })}

          {selectionRect && (
            <rect x={selectionRect.x} y={0} width={selectionRect.w} height={HEIGHT - AXIS_HEIGHT}
              className="fill-aico-accent/15 stroke-aico-accent/50" strokeWidth={1} />
          )}
          {drag && (
            <rect
              x={Math.min(drag.from, drag.to)} y={0}
              width={Math.abs(drag.to - drag.from)} height={HEIGHT - AXIS_HEIGHT}
              className="fill-aico-accent/20"
            />
          )}

          {/* Axis ticks in seconds from the session start. */}
          {axisTicks(view, bounds.start).map(tick => (
            <g key={tick.t}>
              <line x1={toX(tick.t)} y1={HEIGHT - AXIS_HEIGHT} x2={toX(tick.t)} y2={HEIGHT - AXIS_HEIGHT + 4}
                stroke="var(--aico-border)" />
              <text x={toX(tick.t) + 3} y={HEIGHT - 4} className="fill-aico-muted" style={{ fontSize: 10 }}>
                {tick.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

/** Round tick marks at a spacing that suits the visible span. */
function axisTicks(view: Interval, origin: number): Array<{ t: number; label: string }> {
  const span = view.end - view.start;
  const candidates = [1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000, 1_800_000];
  const step = candidates.find(c => span / c <= 10) ?? candidates[candidates.length - 1]!;
  const ticks: Array<{ t: number; label: string }> = [];
  const first = Math.ceil((view.start - origin) / step) * step + origin;
  for (let t = first; t <= view.end; t += step) {
    const seconds = Math.round((t - origin) / 1000);
    ticks.push({
      t,
      label: seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}` : `${seconds}s`,
    });
  }
  return ticks;
}
