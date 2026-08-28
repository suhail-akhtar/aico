/**
 * Charts, from an ECharts option object the model writes.
 *
 * ## Why a library and why this one
 *
 * The alternative is hand-building each chart type, which the sibling AIOps
 * console does and does well — nineteen purpose-built widgets, complete
 * control, no dependency. That is the right trade when you know the fifteen
 * charts your product needs. It is the wrong one here: a coding agent is asked
 * for whatever the data suggests, and "whatever" includes treemaps, sankeys,
 * funnels, candlesticks and boxplots that nobody is going to hand-build ahead
 * of time.
 *
 * ECharts because it is Apache-2.0, covers those types in one grammar, and —
 * the part that actually decides it — is common enough that a model writes
 * valid option objects for it without being taught. A more elegant grammar the
 * model has never seen would be a worse tool here.
 *
 * ## Loaded on demand
 *
 * A megabyte, fetched the first time a chart appears and never in a session
 * without one. Exactly what {@link module:shared/ui/Diagram} does with mermaid,
 * for the same reason.
 *
 * @module shared/ui/Chart
 */

import React, { useEffect, useRef, useState } from 'react';
import { parseChartSpec } from './widget-specs';

/** One module-level promise, so N charts cost one download. */
let echartsPromise: Promise<typeof import('echarts')> | null = null;

function loadECharts(): Promise<typeof import('echarts')> {
  echartsPromise ??= import('echarts');
  return echartsPromise;
}

/**
 * A palette that reads on both themes.
 *
 * ECharts' default series colours are tuned for a white page and turn muddy on
 * a dark one. Set explicitly rather than left to the library, which is the same
 * lesson the mermaid renderer learned.
 */
const PALETTE = [
  '#679efe', '#4ed17e', '#f7ad31', '#f25a5a',
  '#a78bfa', '#56b6d8', '#f472b6', '#94a3b8',
];

export interface ChartProps {
  source: string;
  /** Suppressed while the block is still arriving, so half a spec is not drawn. */
  streaming?: boolean;
}

export function Chart({ source, streaming }: ChartProps): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    // A fenced block arrives a character at a time. Parsing it mid-stream
    // produces an error for every incomplete prefix, so the failure state
    // flickers through the whole message before settling on success.
    if (streaming) return;

    const parsed = parseChartSpec(source);
    if (parsed.error) { setError(parsed.error); return; }
    setError(undefined);

    let disposed = false;
    let instance: import('echarts').ECharts | undefined;

    void loadECharts().then((echarts) => {
      if (disposed || !host.current) return;
      const dark = document.documentElement.dataset.theme === 'dark';
      // SVG rather than canvas: these sit in a scrolling transcript that gets
      // zoomed and printed, and canvas goes blurry at both.
      instance = echarts.init(host.current, dark ? 'dark' : undefined, { renderer: 'svg' });
      // Transparent because the widget frame already supplies a background;
      // ECharts' dark theme paints a near-black panel that sits badly on ours.
      // Spread last so a spec that sets either of these wins — the model asked
      // for a colour scheme, and overruling it would be surprising.
      instance.setOption({ color: PALETTE, backgroundColor: 'transparent', ...parsed.option });
    }).catch((err: unknown) => {
      if (!disposed) setError(err instanceof Error ? err.message : String(err));
    });

    // The container is width-constrained by the transcript column, which
    // changes when the sidebar or a side panel does. Without this the chart
    // keeps its first width and either clips or leaves a gap.
    const observer = new ResizeObserver(() => instance?.resize());
    if (host.current) observer.observe(host.current);

    return () => {
      disposed = true;
      observer.disconnect();
      instance?.dispose();
    };
  }, [source, streaming]);

  if (streaming) {
    return <p className="p-2 text-[11px] text-aico-muted">Chart arriving…</p>;
  }
  if (error) {
    // Thrown rather than rendered, so the widget frame owns every failure and
    // the Fix action is offered here exactly as it is for a crash mid-render.
    throw new Error(error);
  }
  return <div ref={host} className="h-[320px] w-full" />;
}
