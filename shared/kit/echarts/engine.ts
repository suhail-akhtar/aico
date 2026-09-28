/**
 * The one chart engine — Apache ECharts 6, tree-shaken to what the widgets use.
 *
 * Why one engine: every chart used to be hand-written SVG in widgets.tsx,
 * which was fine for a sparkline and unworkable for anything an operator
 * wants to hover, zoom, or read a legend from. Every new chart was bespoke
 * work with no interactivity, and a saved view with twelve panels was twelve
 * separate drawings that each behaved differently.
 *
 * Why tree-shaken: the desktop bundles this. `echarts/core` plus the charts
 * and components below is a fraction of the full build, and every addition
 * here is a deliberate one — add a chart type by registering it here, in the
 * same commit as the widget that uses it.
 *
 * THEME COMES FROM THE CONSOLE'S TOKENS, not from ECharts' own. `readTokens`
 * reads the CSS variables the desktop already defines (--bg2, --ink*, --ok,
 * --warn, --crit, --info, --ev, --line, --mono …) so a chart matches the panel
 * around it in both themes, and re-reads them when `data-theme` changes.
 */
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart, HeatmapChart, TreemapChart, ScatterChart, CustomChart, GraphChart, RadarChart, SankeyChart, BoxplotChart, GaugeChart, FunnelChart } from 'echarts/charts';
import {
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent,
  MarkAreaComponent, MarkPointComponent, VisualMapComponent, TitleComponent, GraphicComponent, CalendarComponent, RadarComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart, BarChart, PieChart, HeatmapChart, TreemapChart, ScatterChart, CustomChart, GraphChart, RadarChart, SankeyChart, BoxplotChart, GaugeChart, FunnelChart,
  GridComponent, CalendarComponent, RadarComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent,
  MarkAreaComponent, MarkPointComponent, VisualMapComponent, TitleComponent, GraphicComponent,
  CanvasRenderer,
]);

export { echarts };
export type EChartsOption = echarts.EChartsCoreOption;

/** The console's design tokens, as a chart needs them. */
export interface Tokens {
  bg: string; bg2: string; bg3: string; line: string; line2: string;
  ink: string; ink2: string; ink3: string; ink4: string;
  ok: string; warn: string; crit: string; info: string; ev: string;
  sans: string; mono: string;
  /** Categorical series palette — distinguishable, with the semantic colours kept OUT of it. */
  series: string[];
}

/* The Night theme of Design System v1.1 — what a chart wears before the document's tokens are readable. */
const FALLBACK: Tokens = {
  bg: '#161513', bg2: '#1D1C19', bg3: '#252320', line: '#2B2926', line2: '#39362F',
  ink: '#EDEAE3', ink2: '#ABA69C', ink3: '#7E7870', ink4: '#5C5851',
  ok: '#7CC49B', warn: '#D9A855', crit: '#E2705B', info: '#7FA3D4', ev: '#46B8AE',
  sans: 'Inter, "Segoe UI", system-ui, sans-serif', mono: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
  series: ['#3f86d0', '#8f7be0', '#2fa7b9', '#c86fa0', '#6fa8dc', '#b8a04b', '#5f9cd1', '#a684c9'],
};

/** Read the tokens from the document; safe to call with no DOM (tests, SSR). */
export function readTokens(): Tokens {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return FALLBACK;
  try {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fb: string): string => { const x = cs.getPropertyValue(name).trim(); return x || fb; };
    return {
      bg: v('--bg', FALLBACK.bg), bg2: v('--bg2', FALLBACK.bg2), bg3: v('--bg3', FALLBACK.bg3),
      line: v('--line', FALLBACK.line), line2: v('--line2', FALLBACK.line2),
      ink: v('--ink', FALLBACK.ink), ink2: v('--ink2', FALLBACK.ink2), ink3: v('--ink3', FALLBACK.ink3), ink4: v('--ink4', FALLBACK.ink4),
      ok: v('--ok', FALLBACK.ok), warn: v('--warn', FALLBACK.warn), crit: v('--crit', FALLBACK.crit), info: v('--info', FALLBACK.info), ev: v('--ev', FALLBACK.ev),
      sans: v('--sans', FALLBACK.sans), mono: v('--mono', FALLBACK.mono),
      series: FALLBACK.series,
    };
  } catch {
    return FALLBACK;
  }
}

/** Whether a canvas can actually be drawn here (false under SSR and in jsdom). */
export function canDraw(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    return typeof c.getContext === 'function' && Boolean(c.getContext('2d'));
  } catch {
    return false;
  }
}

/** Shared chrome every chart starts from: quiet grid, token colours, tabular tooltip. */
export function baseOption(t: Tokens): EChartsOption {
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: t.sans, color: t.ink3, fontSize: 10 },
    grid: { left: 8, right: 8, top: 10, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.bg2, borderColor: t.line2, borderWidth: 1, padding: [6, 9],
      textStyle: { color: t.ink, fontSize: 11, fontFamily: t.mono },
      axisPointer: { type: 'line', lineStyle: { color: t.ink4, width: 1 } },
      confine: true,
    },
    legend: { show: false },
    color: t.series,
  };
}

/** A concise number for axis labels and tooltips. */
export const fmtNum = (v: number, unit = ''): string => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(v / 1e9).toFixed(1)}G` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e4 ? `${(v / 1e3).toFixed(1)}k` : Number.isInteger(v) ? String(v) : a >= 100 ? String(Math.round(v)) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  return s + unit;
};

export const fmtTime = (ms: number, span: number): string => {
  const d = new Date(ms);
  if (!Number.isFinite(ms)) return '';
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  if (span > 3 * 86_400_000) return `${d.getDate()}/${d.getMonth() + 1} ${hh}:${mm}`;
  return `${hh}:${mm}`;
};
