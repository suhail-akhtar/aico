/**
 * <EChart> — draws an ECharts option into a panel, and never only that.
 *
 * Every chart also renders its data as TEXT: a visually-hidden table when the
 * canvas draws, a visible one when it cannot (server-side rendering, a test,
 * a headless console). Three reasons, none of them decorative:
 *   - a screen reader gets the numbers, not "graphic";
 *   - the contract-render test can assert an example's values reach the
 *     output, which is how the `alerts` bug was caught once before;
 *   - a panel with no canvas is still a panel with data, not a blank box.
 *
 * Resize follows the container; theme follows `data-theme` on the root and
 * the OS preference, re-reading the tokens each time so a chart drawn in
 * the dark theme is redrawn in the light one rather than staying half-lit.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { canDraw, echarts, readTokens, type EChartsOption, type Tokens } from './engine.js';

export interface EChartProps {
  /** Build the option from the current tokens — called on every (re)draw. */
  build: (t: Tokens) => EChartsOption;
  /** The data as text — rows of [label, value…]. */
  summary: { cols: string[]; rows: Array<Array<string | number>> };
  /** Optional height; otherwise the container's. */
  height?: number | string | undefined;
  /** Called with the ECharts click params when a mark is clicked (drill-down hook). */
  onClick?: ((params: { name?: string | undefined; seriesName?: string | undefined; value?: unknown }) => void) | undefined;
  className?: string | undefined;
  /** A line under the chart — provenance, a computed note. */
  footer?: ReactNode;
}

export function EChart({ build, summary, height, onClick, className, footer }: EChartProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [drawn, setDrawn] = useState(false);
  // Parents pass a fresh `build` closure on every render; redraw only when the
  // DATA changed, keyed on the text summary, so a 15-second "as of" ticker in
  // the panel chrome does not rebuild the chart.
  const buildRef = useRef(build); buildRef.current = build;
  const clickRef = useRef(onClick); clickRef.current = onClick;
  const key = JSON.stringify(summary);

  useEffect(() => {
    const el = ref.current;
    if (!el || !canDraw()) return;
    let chart: echarts.ECharts | undefined;
    try {
      chart = echarts.init(el, undefined, { renderer: 'canvas' });
    } catch {
      return;
    }
    const draw = () => { try { chart?.setOption(buildRef.current(readTokens()), { notMerge: true }); setDrawn(true); } catch { /* a bad option is a blank chart, not a crash */ } };
    draw();
    chart.on('click', (p: unknown) => { const q = p as { name?: string; seriesName?: string; value?: unknown }; clickRef.current?.({ name: q.name, seriesName: q.seriesName, value: q.value }); });
    // A container at 0×0 — a collapsed drawer, a chat message being
    // re-laid-out, a hidden tab, the remount an auto-refresh does — must NOT
    // reach ECharts: a `graph` (View coordinate system) resized to nothing
    // throws "Cannot read properties of null (reading '0')" from inside the
    // ResizeObserver callback, uncaught, once per chart per tick. Skip it;
    // the observer fires again with a real size when the panel is laid out,
    // and that resize succeeds (verified against 6.1.0 in host.test).
    const resize = () => {
      if (!chart || chart.isDisposed()) return;
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      try { chart.resize(); } catch { /* a chart that cannot fit is a chart left as it was, not a crash */ }
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : undefined;
    ro?.observe(el);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(draw) : undefined;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
    mq?.addEventListener?.('change', draw);
    return () => { ro?.disconnect(); mo?.disconnect(); mq?.removeEventListener?.('change', draw); chart?.dispose(); };
  }, [key]);

  const table = (
    <table className={drawn ? 'wg-sr' : 'wg-datatable'}>
      <caption>{drawn ? 'Chart data' : 'Chart data (no canvas available here)'}</caption>
      <thead><tr>{summary.cols.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
      <tbody>{summary.rows.slice(0, 60).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{String(c)}</td>)}</tr>)}</tbody>
    </table>
  );

  return (
    <div className={`wg-chart${className ? ` ${className}` : ''}`} style={height !== undefined ? { height } : undefined}>
      <div ref={ref} className="wg-canvas" aria-hidden={drawn} />
      {table}
      {footer && <div className="wg-chart-f">{footer}</div>}
    </div>
  );
}
