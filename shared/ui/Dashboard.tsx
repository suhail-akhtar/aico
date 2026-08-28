/**
 * Several figures, laid out as one board.
 *
 * ## Why this exists
 *
 * Because without it the agent reaches for a file. Asked for "a single
 * dashboard view", a model looking at this renderer's block list correctly
 * concluded that chat blocks stack one per message and that a *single* board
 * therefore had to be a standalone HTML page — so it wrote one, vendored a
 * megabyte of charting library beside it, and spent several turns debugging a
 * page nobody asked to have on disk.
 *
 * That was not the model going off-piste. It was the honest response to a
 * missing capability, and the session even had a standing goal saying to stay
 * in the chat. A rule in the prompt cannot beat the absence of a way to comply:
 * if the only route to the thing being asked for leads out of the chat, that is
 * the route that gets taken. The fix is the capability, not a firmer
 * instruction.
 *
 * ## What it composes, and what it does not
 *
 * A headline row of stat tiles, then a grid of panels, each of which is an
 * ordinary `chart`, `viz` or `table` spec — exactly what the standalone block
 * takes, so anything that renders alone renders here.
 *
 * Panels cannot be dashboards. That is a deliberate floor rather than an
 * oversight: nesting buys nothing a wider panel does not, and it is the
 * difference between a layout and a recursion with a rendering cost per level.
 *
 * @module shared/ui/Dashboard
 */

import React from 'react';
import { parseDashboardSpec } from './widget-specs';
import type { DashboardPanel, DashboardStat } from './widget-specs';
import { Chart } from './Chart';
import { DataTable } from './DataTable';
import { Viz } from './Viz';

export interface DashboardProps {
  source: string;
  /** Suppressed while the block is still arriving, so half a board is not drawn. */
  streaming?: boolean;
}

/**
 * The history behind a headline number, at the size of a word.
 *
 * Drawn as an SVG path rather than a fourth charting instance per tile. Six
 * ECharts views to show six five-point lines would cost more than the rest of
 * the board put together, and none of them would be interactive in any way
 * worth having at 96 by 28 pixels.
 */
function Sparkline({ points }: { points: number[] }): React.ReactElement | null {
  if (points.length < 2) return null;
  const w = 96;
  const h = 28;
  const pad = 3;
  const min = Math.min(...points);
  const max = Math.max(...points);
  // A flat series would divide by zero and, worse, draw a line at the top of
  // the box implying a maximum. Held at the midline instead, which is honest.
  const range = max - min || 1;
  const xs = points.map((_, i) => pad + (i * (w - 2 * pad)) / (points.length - 1));
  const ys = points.map(v => h - pad - ((v - min) / range) * (h - 2 * pad));
  const line = xs.map((x, i) => `${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-24 shrink-0" aria-hidden="true">
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="2.2" fill="currentColor" />
    </svg>
  );
}

function StatTile({ stat }: { stat: DashboardStat }): React.ReactElement {
  // Colour follows the stated direction, never the sign of the delta. Falling
  // debt is good news and rising churn is not, and only the author knows which
  // way round a given number reads.
  const tone = stat.direction === 'up'
    ? 'text-aico-success'
    : stat.direction === 'down'
      ? 'text-aico-danger'
      : 'text-aico-muted';

  return (
    <div className="min-w-0 rounded-xl border border-aico-border-subtle bg-aico-surface px-3.5 py-3">
      <p className="truncate text-[11px] uppercase tracking-wide text-aico-muted">{stat.label}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="min-w-0">
          {/* Tabular figures: a column of numbers whose digits do not line up
              is the single clearest tell of an interface nobody looked at. */}
          <p className="truncate text-[19px] font-semibold tabular-nums text-aico-primary">
            {stat.value}
          </p>
          {stat.delta && <p className={`text-[11px] tabular-nums ${tone}`}>{stat.delta}</p>}
        </div>
        {stat.series && stat.series.length > 1 && (
          <span className={tone}><Sparkline points={stat.series} /></span>
        )}
      </div>
    </div>
  );
}

/** One panel, drawn by whichever renderer its kind names. */
function Panel({ panel, streaming }: {
  panel: DashboardPanel; streaming: boolean;
}): React.ReactElement {
  const source = typeof panel.spec === 'string' ? panel.spec : JSON.stringify(panel.spec);
  const body = panel.kind === 'table'
    ? <DataTable source={source} />
    : panel.kind === 'viz'
      ? <Viz source={source} streaming={streaming} />
      : <Chart source={source} streaming={streaming} />;

  return (
    <div className={`min-w-0 rounded-xl border border-aico-border-subtle bg-aico-surface p-3
                     ${panel.span === 2 ? 'lg:col-span-2' : ''}`}>
      {panel.title && (
        <p className="mb-2 text-[12px] font-medium text-aico-secondary">{panel.title}</p>
      )}
      {/* Each panel gets its own boundary. One malformed chart in a board of
          nine should leave the other eight standing — a dashboard that goes
          entirely blank because of one bad spec is worse than a gap. */}
      <PanelBoundary label={panel.title ?? panel.kind}>{body}</PanelBoundary>
      {panel.note && <p className="mt-2 text-[11px] text-aico-muted">{panel.note}</p>}
    </div>
  );
}

interface BoundaryState { error?: string }

class PanelBoundary extends React.Component<
  { label: string; children: React.ReactNode }, BoundaryState
> {
  override state: BoundaryState = {};

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <p className="rounded-lg bg-aico-elevated px-3 py-4 text-[11px] text-aico-muted">
          {this.props.label} did not render — {this.state.error}
        </p>
      );
    }
    return this.props.children;
  }
}

export function Dashboard({ source, streaming = false }: DashboardProps): React.ReactElement {
  const parsed = parseDashboardSpec(source);

  if (streaming) {
    return <p className="p-2 text-[11px] text-aico-muted">Dashboard arriving…</p>;
  }
  if (parsed.error) {
    // Thrown rather than rendered, so the widget frame owns the failure and
    // offers to have it repaired, exactly as it does for a single chart.
    throw new Error(parsed.error);
  }

  const { title, subtitle, stats = [], panels } = parsed.spec!;

  return (
    <div className="w-full">
      {(title || subtitle) && (
        <div className="mb-3">
          {title && <p className="text-[15px] font-semibold text-aico-primary">{title}</p>}
          {subtitle && <p className="text-[11px] text-aico-muted">{subtitle}</p>}
        </div>
      )}

      {stats.length > 0 && (
        // Auto-fit rather than a fixed count: four tiles should not each take a
        // quarter of a narrow column, and six should not wrap to a ragged two.
        <div className="mb-3 grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(148px,1fr))]">
          {stats.map((stat, i) => <StatTile key={`${stat.label}-${i}`} stat={stat} />)}
        </div>
      )}

      {/* One column until there is room for two. A dashboard squeezed into a
          side panel is a stack of readable charts, not a grid of unreadable
          ones. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {panels.map((panel, i) => (
          <Panel key={`${panel.kind}-${i}`} panel={panel} streaming={streaming} />
        ))}
      </div>
    </div>
  );
}
