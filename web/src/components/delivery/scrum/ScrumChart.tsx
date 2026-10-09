/**
 * A chart for the Scrum views: ECharts through the same theme the chat's charts use
 * (shared/ui/chart-theme), so the burndown and velocity read as part of one system in
 * light and dark, and never only as a picture.
 *
 * WHY NOT shared/ui/Chart. That component draws a model-written spec once, at a fixed
 * 320 px, and never redraws when the theme flips. These charts are page furniture:
 * they need a height of their own, a redraw when `data-theme` changes, and the data as
 * text (a visually-hidden table for a screen reader, shown outright if the library
 * cannot load) because a number a person must act on cannot be locked in a drawing.
 *
 * ECharts is a megabyte and is imported on first use, once, like the chat's charts.
 * The palette comes from chart-theme's validated series colours (checked for colour-
 * blind separation), with the series told apart by direct labels and line style as well.
 *
 * @module web/components/delivery/scrum/ScrumChart
 */

import React, { useEffect, useRef, useState } from 'react';
import { DARK_INK, DARK_SERIES, LIGHT_INK, LIGHT_SERIES, chartTheme } from '../../../../../shared/ui/chart-theme';
import type { ChartPalette } from '../../../delivery-scrum';

let echartsPromise: Promise<typeof import('echarts')> | null = null;
const loadECharts = (): Promise<typeof import('echarts')> => (echartsPromise ??= import('echarts'));

/** The chart palette for a theme. Light is #ffffff-ish and dark near-black, as the portal's surfaces are. */
export function paletteFor(dark: boolean): ChartPalette {
  const series = dark ? DARK_SERIES : LIGHT_SERIES;
  const ink = dark ? DARK_INK : LIGHT_INK;
  return {
    actual: series[0]!, ideal: ink.muted, scope: series[3]!, ink: ink.primary, muted: ink.secondary, line: ink.line,
    surface: dark ? '#0f1115' : '#ffffff', committed: dark ? '#2f4a73' : '#b9d2f3',
  };
}

const isDark = (): boolean => document.documentElement.dataset.theme === 'dark';

export function ScrumChart({ build, height = 240, label, table }: {
  build: (pal: ChartPalette) => Record<string, unknown>;
  height?: number;
  /** What the chart shows, in a sentence: its accessible name. */
  label: string;
  /** The same data as text. */
  table: { cols: string[]; rows: string[][] };
}): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const buildRef = useRef(build);
  buildRef.current = build;
  const [failed, setFailed] = useState<string | null>(null);
  // Redraw on the data, not on every render: the board re-renders on each live frame.
  const key = JSON.stringify([build(paletteFor(false)), table]);

  useEffect(() => {
    let disposed = false;
    let chart: import('echarts').ECharts | undefined;
    let observer: MutationObserver | undefined;
    let resize: ResizeObserver | undefined;
    void loadECharts().then(echarts => {
      if (disposed || !host.current) return;
      const draw = (): void => {
        if (!host.current) return;
        const dark = isDark();
        const name = dark ? 'aico-dark' : 'aico-light';
        echarts.registerTheme(name, chartTheme(dark));
        chart?.dispose();
        // SVG: crisp when zoomed or printed, and the page's text and the chart's text are the same font.
        chart = echarts.init(host.current, name, { renderer: 'svg' });
        chart.setOption(buildRef.current(paletteFor(dark)));
      };
      draw();
      observer = new MutationObserver(draw);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      resize = new ResizeObserver(() => { if (host.current && host.current.clientWidth > 0) chart?.resize(); });
      resize.observe(host.current);
    }).catch((e: unknown) => { if (!disposed) setFailed(e instanceof Error ? e.message : String(e)); });
    return () => { disposed = true; observer?.disconnect(); resize?.disconnect(); chart?.dispose(); };
  }, [key]);

  return (
    <div>
      {!failed && <div ref={host} role="img" aria-label={label} style={{ height }} className="w-full" />}
      <table className={failed ? 'mt-2 w-full text-left text-[12px] text-aico-secondary' : 'sr-only'}>
        <caption className={failed ? 'pb-1 text-left text-[12px] text-aico-muted' : 'sr-only'}>{label}{failed ? ' (the chart could not be drawn, so here is the data)' : ''}</caption>
        <thead><tr>{table.cols.map(c => <th key={c} scope="col" className="pr-4 font-medium">{c}</th>)}</tr></thead>
        <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="pr-4 tabular-nums">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
