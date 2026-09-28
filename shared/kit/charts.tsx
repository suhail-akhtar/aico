/**
 * NOTE: these components use NO hooks on purpose — the hostile-input test
 * calls them as plain functions, and <EChart> (a child element) owns the
 * only effect.
 *
 * The interactive chart widgets — every one drawn by the ECharts engine
 * (echarts/engine.ts) from a PURE option builder (echarts/options.ts), with
 * the data also rendered as text (echarts/host.tsx).
 *
 * These are NEW ids beside the original hand-drawn set, not replacements:
 * a saved view naming `line@1.0.0` keeps rendering exactly as it did. The
 * catalogue and the playbook steer the orchestrator to these for anything
 * an operator will hover, zoom, or compare — `timeseries` over `line`,
 * `heatmap` over `heat`, `histogram` over `hist`.
 *
 * Each component does three things and nothing else: normalise the options
 * with the same tolerance widgets.tsx always had (bad input is skipped, never
 * thrown on), build a text summary, and hand a builder to <EChart>. The
 * provenance rule holds: a computed line (a projection, a baseline band) is
 * labelled computed in the legend and in the footer, never drawn as a
 * measurement.
 */
import type { WidgetProps } from './types';
import { EChart } from './echarts/host.js';
import { fmtNum, type Tokens } from './echarts/engine.js';
import {
  anomalyOption, barsOption, forecastOption, heatOption, histOption, normaliseItems, normaliseSeries, normaliseStateRows,
  normState, serviceMapOption, sparkOption, stateTimelineOption, statusHistoryOption, timeseriesOption, topnOption, treemapOption, linearFit,
  scatterOption, normaliseXY, pieOption, radarOption, normaliseRadar, sankeyOption, normaliseFlow, boxplotOption, normaliseBoxes, calendarOption, normaliseDays, gaugeOption, ganttOption, normaliseGantt, funnelOption,
} from './echarts/options.js';

const str = (v: unknown, fb = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fb);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function Err({ error }: { error: string }) {
  return <div className="wg-error" role="alert"><span aria-hidden>⚠</span> {error}</div>;
}
const stamp = (ms: number): string => { const d = new Date(ms); return Number.isFinite(ms) && ms > 1e11 ? d.toISOString().slice(5, 16).replace('T', ' ') : String(ms); };

// ── Time ────────────────────────────────────────────────────────────────────

/** timeseries — lines over time; thresholds, a baseline band, annotations, legend, hover, shift-wheel zoom. */
export function TimeSeriesChart({ options, error, thresholds }: WidgetProps) {
  const n = normaliseSeries(options);
  const unit = str(options['unit']);
  const build = (t: Tokens) => timeseriesOption(options, t, thresholds ?? []);
  if (error) return <Err error={error} />;
  const rows = n.series.flatMap((s) => s.points.slice(-12).map((p) => [s.name, n.timeAxis ? stamp(p[0]) : (n.labels[p[0]] ?? p[0]), fmtNum(p[1], unit)] as Array<string | number>));
  const last = n.series.map((s) => `${s.name}: ${s.points.length ? fmtNum(s.points.at(-1)![1], unit) : '—'}`).join(' · ');
  return <EChart build={build} summary={{ cols: ['series', 'at', 'value'], rows }} footer={n.series.length ? <span className="mono">{last}</span> : <span>No points</span>} />;
}

/** statetimeline — one row per thing, coloured segments over time. */
export function StateTimeline({ options, error }: WidgetProps) {
  const rows = normaliseStateRows(options);
  const build = (t: Tokens) => stateTimelineOption(options, t);
  if (error) return <Err error={error} />;
  return <EChart build={build} summary={{ cols: ['row', 'from', 'to', 'state'], rows: rows.flatMap((r) => r.segments.map((s) => [r.name, stamp(s.from), stamp(s.to), s.state])) }} footer={rows.length ? undefined : <span>No rows</span>} />;
}

/** statushistory — periodic state cells per row. */
export function StatusHistory({ options, error }: WidgetProps) {
  const rows = arr(options['rows']).filter(isObj).map((r) => ({ label: str(r['label'] ?? r['name'], '?'), cells: arr(r['cells'] ?? r['states']).map(normState) }));
  const build = (t: Tokens) => statusHistoryOption(options, t);
  if (error) return <Err error={error} />;
  return <EChart build={build} summary={{ cols: ['row', 'states'], rows: rows.map((r) => [r.label, r.cells.join(' ')]) }} footer={rows.length ? undefined : <span>No rows</span>} />;
}

/** heatmap — value density, rows × columns. */
export function HeatmapChart({ options, error }: WidgetProps) {
  const rows = arr(options['rows']).filter(isObj).map((r) => ({ label: str(r['label'] ?? r['name'], '?'), cells: arr(r['cells'] ?? r['values']).map((c) => num(c) ?? 0) }));
  const build = (t: Tokens) => heatOption(options, t);
  if (error) return <Err error={error} />;
  return <EChart build={build} summary={{ cols: ['row', 'cells'], rows: rows.map((r) => [r.label, r.cells.map((c) => fmtNum(c)).join(' ')]) }} footer={rows.length ? undefined : <span>No rows</span>} />;
}

/** histogram — a distribution with percentile markers. */
export function HistogramChart({ options, error }: WidgetProps) {
  const buckets = arr(options['buckets'] ?? options['data']).map((b) => num(b) ?? 0);
  const labels = arr(options['labels']).map((l) => str(l));
  const unit = str(options['unit']);
  const build = (t: Tokens) => histOption(options, t);
  if (error) return <Err error={error} />;
  const pct = (['p50', 'p95', 'p99'] as const).map((k) => ({ k, v: num(options[k]) })).filter((m) => m.v !== undefined);
  return <EChart build={build} summary={{ cols: ['bucket', 'count'], rows: buckets.map((b, i) => [labels[i] ?? String(i), b]) }} footer={pct.length ? <span className="mono">{pct.map((m) => `${m.k} ${fmtNum(m.v!, unit)}`).join(' · ')}</span> : buckets.length ? undefined : <span>No data</span>} />;
}

/** forecast — a series, its linear projection (computed) and the threshold it would cross. */
export function ForecastChart({ options, error, provenance }: WidgetProps) {
  const n = normaliseSeries(options);
  const unit = str(options['unit']);
  const threshold = num(options['threshold']);
  const build = (t: Tokens) => forecastOption(options, t);
  if (error) return <Err error={error} />;
  const s = n.series[0];
  const fit = s ? linearFit(s.points) : undefined;
  let words = 'no projection — fewer than 5 points';
  if (s && fit) {
    if (fit.r2 < 0.5) words = `no projection — the trend does not fit a line (r² ${fit.r2.toFixed(2)})`;
    else if (threshold !== undefined && fit.slope !== 0 && n.timeAxis) {
      const x0 = s.points[0]![0], xn = s.points.at(-1)![0];
      const xc = x0 + (threshold - fit.intercept) / fit.slope;
      words = xc > xn ? `computed: reaches ${fmtNum(threshold, unit)} in ≈ ${Math.max(1, Math.round((xc - xn) / 86_400_000))} days at the current slope (r² ${fit.r2.toFixed(2)})` : `computed: already past ${fmtNum(threshold, unit)}, or moving away from it`;
    } else words = `computed: slope ${fmtNum(fit.slope * 86_400_000, unit)}/day (r² ${fit.r2.toFixed(2)})`;
  }
  return <EChart build={build} summary={{ cols: ['series', 'at', 'value'], rows: (s?.points.slice(-12) ?? []).map((p) => [s!.name, stamp(p[0]), fmtNum(p[1], unit)]) }} footer={<span className={provenance === 'platform' ? 'wg-computed' : ''}>{words}</span>} />;
}

/** anomaly — a series against its own rolling baseline band (computed), with the verdict at the last point. */
export function AnomalyChart({ options, error }: WidgetProps) {
  const n = normaliseSeries(options);
  const unit = str(options['unit']);
  const build = (t: Tokens) => anomalyOption(options, t);
  if (error) return <Err error={error} />;
  const s = n.series[0];
  const verdict = str(options['verdict']);
  const explain = str(options['explanation']);
  return <EChart build={build} summary={{ cols: ['series', 'at', 'value'], rows: (s?.points.slice(-12) ?? []).map((p) => [s!.name, stamp(p[0]), fmtNum(p[1], unit)]) }} footer={<span className="wg-computed">{verdict ? `${verdict}${explain ? ` — ${explain}` : ''} · computed` : 'band is a rolling median ± MAD, computed here; the verdict comes from anomaly_scan'}</span>} />;
}

// ── Category ────────────────────────────────────────────────────────────────

/** barchart — categorical comparison, vertical or horizontal, labelled. */
export function BarsChart({ options, error }: WidgetProps) {
  const items = normaliseItems(options);
  const unit = str(options['unit']);
  const build = (t: Tokens) => barsOption(options, t);
  if (error) return <Err error={error} />;
  return <EChart build={build} summary={{ cols: ['label', 'value'], rows: items.map((i) => [i.label, fmtNum(i.value, unit)]) }} footer={items.length ? undefined : <span>No data</span>} />;
}

/** topn — the N largest, ranked. */
export function TopN({ options, error }: WidgetProps) {
  const nMax = num(options['n']) ?? 10;
  const items = normaliseItems(options).sort((a, b) => b.value - a.value).slice(0, nMax);
  const unit = str(options['unit']);
  const build = (t: Tokens) => topnOption(options, t);
  if (error) return <Err error={error} />;
  return <EChart build={build} summary={{ cols: ['rank', 'label', 'value'], rows: items.map((i, k) => [k + 1, i.label, fmtNum(i.value, unit)]) }} footer={items.length ? undefined : <span>No data</span>} />;
}

/** treemap — capacity by hierarchy; a node with `pct` colours by fullness. */
export function TreemapChart({ options, error }: WidgetProps) {
  const unit = str(options['unit']);
  const flat: Array<[string, string]> = [];
  const walk = (v: unknown, prefix: string) => { for (const n of arr(v)) { if (!isObj(n)) continue; const name = `${prefix}${str(n['name'] ?? n['label'], '?')}`; const val = num(n['value']); flat.push([name, val !== undefined ? fmtNum(val, unit) : '']); walk(n['children'], `${name} / `); } };
  walk(options['tree'] ?? options['items'] ?? options['data'], '');
  const build = (t: Tokens) => treemapOption(options, t);
  if (error) return <Err error={error} />;
  return <EChart build={build} summary={{ cols: ['node', 'value'], rows: flat }} footer={flat.length ? undefined : <span>No data</span>} />;
}

// ── Stat family additions ───────────────────────────────────────────────────

/** bargauge — named bars against a max, thresholds by colour. */
export function BarGauge({ options, error }: WidgetProps) {
  const items = normaliseItems(options);
  const max = num(options['max']) ?? 100;
  const unit = str(options['unit'], max === 100 ? '%' : '');
  if (error) return <Err error={error} />;
  if (items.length === 0) return <div className="wg-empty">No data</div>;
  return (
    <div className="bg-rows">
      {items.map((i, k) => {
        const m = i.max ?? max; const pct = Math.max(0, Math.min(100, (i.value / (m || 1)) * 100));
        const tone = pct >= 90 ? 'var(--crit)' : pct >= 75 ? 'var(--warn)' : i.color ?? 'var(--info)';
        return (
          <div key={k} className="bg-row">
            <span className="bg-l" title={i.label}>{i.label}</span>
            <div className="bg-bar"><i style={{ width: `${pct}%`, background: tone }} /></div>
            <span className="bg-v mono">{fmtNum(i.value, unit)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** sparkrow — a compact row of stats with sparklines, for a dashboard header. */
export function SparkRow({ options, error }: WidgetProps) {
  const items = arr(options['items']).filter(isObj).map((i) => ({ label: str(i['label'], '?'), value: str(i['value'], '—'), series: arr(i['series'] ?? i['spark']).map((v) => num(v)).filter((v): v is number => v !== undefined), color: typeof i['color'] === 'string' ? i['color'] : undefined }));
  if (error) return <Err error={error} />;
  if (items.length === 0) return <div className="wg-empty">No data</div>;
  return (
    <div className="sr-row">
      {items.map((i, k) => (
        <div key={k} className="sr-item">
          <div className="sr-l">{i.label}</div>
          <div className="sr-v" style={i.color ? { color: i.color } : undefined}>{i.value}</div>
          <div className="sr-s"><EChart build={(t) => sparkOption(i.series, t, i.color && !i.color.startsWith('var(') ? i.color : t.series[0]!)} summary={{ cols: ['value'], rows: i.series.slice(-8).map((v) => [fmtNum(v)]) }} height={22} /></div>
        </div>
      ))}
    </div>
  );
}

/** slo — availability against a target: budget left, burn rate, time to exhaustion (all computed from what is given). */
export function SloPanel({ options, error }: WidgetProps) {
  const target = num(options['target']) ?? 99.9;
  const good = num(options['good']); const total = num(options['total']);
  const availability = num(options['availability']) ?? (good !== undefined && total ? (good / total) * 100 : undefined);
  const windowDays = num(options['windowDays']) ?? 30;
  const elapsedDays = num(options['elapsedDays']) ?? windowDays;
  if (error) return <Err error={error} />;
  if (availability === undefined) return <div className="wg-empty">No data</div>;
  const budgetTotal = (100 - target) / 100 * windowDays * 1440; // minutes of allowed downtime
  const used = Math.max(0, (100 - availability) / 100 * elapsedDays * 1440);
  const left = Math.max(0, budgetTotal - used);
  const burn = budgetTotal > 0 && elapsedDays > 0 ? (used / budgetTotal) / (elapsedDays / windowDays) : 0;
  const exhaustDays = burn > 0 ? Math.max(0, (left / (used / elapsedDays || 1))) : Number.POSITIVE_INFINITY;
  const ok = availability >= target;
  const fmtMin = (m: number) => (m >= 1440 ? `${(m / 1440).toFixed(1)}d` : m >= 60 ? `${(m / 60).toFixed(1)}h` : `${Math.round(m)}m`);
  return (
    <div className="slo">
      <div className="slo-top"><span className="slo-v" style={{ color: ok ? 'var(--ok)' : 'var(--crit)' }}>{availability.toFixed(availability >= 99.99 ? 3 : 2)}%</span><span className="slo-t">target {target}% · {windowDays}d</span></div>
      <div className="bg-bar slo-bar"><i style={{ width: `${Math.min(100, (used / (budgetTotal || 1)) * 100)}%`, background: burn > 2 ? 'var(--crit)' : burn > 1 ? 'var(--warn)' : 'var(--ok)' }} /></div>
      <div className="slo-kv mono">
        <span>budget used</span><b>{fmtMin(used)} of {fmtMin(budgetTotal)}</b>
        <span>burn rate</span><b>{burn.toFixed(2)}×</b>
        <span>exhausts in</span><b>{Number.isFinite(exhaustDays) ? `≈ ${exhaustDays.toFixed(1)}d` : 'not at this rate'}</b>
      </div>
      <div className="wg-computed">computed from availability and the window; not an observation</div>
    </div>
  );
}

// ── Topology ────────────────────────────────────────────────────────────────

/** servicemap — services and data stores as a force graph, state on the border, declared and correlated edges drawn differently. */
export function ServiceMap({ options, error }: WidgetProps) {
  const nodes = arr(options['nodes']).filter(isObj).map((n) => [str(n['label'] ?? n['name'] ?? n['id']), normState(n['state'] ?? n['status'] ?? 'unknown'), str(n['kind'], 'service')] as [string, string, string]);
  const edges = arr(options['edges'] ?? options['links']).filter(isObj).map((e) => [str(e['from'] ?? e['source']), str(e['to'] ?? e['target']), str(e['kind'] ?? e['relation'], 'depends_on')] as [string, string, string]);
  const build = (t: Tokens) => serviceMapOption(options, t);
  if (error) return <Err error={error} />;
  return <EChart build={build} summary={{ cols: ['node', 'state', 'kind'], rows: nodes }} footer={nodes.length ? <span className="mono">{nodes.length} nodes · {edges.length} edges · green = declared · dotted = co-occurrence</span> : <span>No nodes</span>} />;
}

// ── Ops objects ─────────────────────────────────────────────────────────────

/** incidents — the correlated problem list, priority first. */
export function IncidentList({ options, error }: WidgetProps) {
  const items = arr(options['items'] ?? options['incidents']).filter(isObj).map((i) => ({ id: str(i['id']), title: str(i['title'], '?'), sev: str(i['sev'] ?? i['severity'], 'info'), status: str(i['status'], 'open'), priority: num(i['priority']), host: str(i['host'] ?? i['hosts']), age: str(i['age']) }));
  if (error) return <Err error={error} />;
  if (items.length === 0) return <div className="wg-empty">No alerts</div>;
  const tone = (s: string) => (s === 'c' || s === 'critical' ? 'var(--crit)' : s === 'w' || s === 'warning' ? 'var(--warn)' : s === 'ok' || s === 'resolved' ? 'var(--ok)' : 'var(--info)');
  return (
    <div className="alist">
      {items.map((i, k) => (
        <div key={k} className="al">
          <span className="dot" style={{ background: tone(i.sev) }} />
          <span className="t">{i.priority !== undefined && <b className="mono" style={{ marginRight: 6 }}>P{i.priority}</b>}{i.title}{i.status !== 'open' && <span className="mono" style={{ color: 'var(--ink4)', marginLeft: 6 }}>{i.status}</span>}</span>
          <span className="mono host">{i.host}</span>
          <span className="ti">{i.age || i.id}</span>
        </div>
      ))}
    </div>
  );
}

/** gate — what is waiting for a human; approves nothing (the Gate surface does). */
export function GateQueue({ options, error }: WidgetProps) {
  const items = arr(options['items'] ?? options['pending']).filter(isObj).map((g) => ({ id: str(g['id']), title: str(g['title'] ?? g['intent'], '?'), host: str(g['host'] ?? g['deviceId']), tier: str(g['tier'] ?? g['effectiveTier']), left: str(g['left'] ?? g['detail'] ?? g['age']) }));
  if (error) return <Err error={error} />;
  if (items.length === 0) return <div className="wg-empty">Nothing to show</div>;
  return (
    <div className="alist">
      {items.map((g, k) => (
        <div key={k} className="al">
          <span className="dot" style={{ background: g.tier === 'T0' ? 'var(--ink4)' : 'var(--warn)' }} />
          <span className="t">{g.title}{g.tier && <span className="mono" style={{ color: 'var(--ink4)', marginLeft: 6 }}>{g.tier}</span>}</span>
          <span className="mono host">{g.host}</span>
          <span className="ti">{g.left}</span>
        </div>
      ))}
    </div>
  );
}

// ── The 2026-09-04 set ──────────────────────────────────────────────────────

/** scatter — x against y, one dot per host or sample; groups by colour; a COMPUTED fit line labelled so. */
export function ScatterChart({ options, error }: WidgetProps) {
  const pts = normaliseXY(options);
  const xl = str(options['xLabel'] ?? options['x'], 'x'), yl = str(options['yLabel'] ?? options['y'], 'y');
  const build = (t: Tokens) => scatterOption(options, t);
  if (error) return <Err error={error} />;
  const fit = options['trend'] !== false && pts.length >= 5 ? linearFit(pts.map((p) => [p.x, p.y])) : undefined;
  return <EChart build={build} summary={{ cols: ['point', xl, yl], rows: pts.slice(0, 60).map((p) => [p.label ?? p.group ?? '·', fmtNum(p.x, str(options['xUnit'])), fmtNum(p.y, str(options['yUnit']))]) }} footer={pts.length === 0 ? <span>No points</span> : fit ? <span className="wg-computed">{`${pts.length} points · linear fit r² ${fit.r2.toFixed(2)} — computed here, not observed`}</span> : <span className="mono">{`${pts.length} points`}</span>} />;
}

/** pie — share of a whole with labels and hover; semantic colours for state names. Prefer over donut. */
export function PieChart({ options, error }: WidgetProps) {
  const items = normaliseItems(options, 'slices');
  const build = (t: Tokens) => pieOption(options, t);
  if (error) return <Err error={error} />;
  const total = items.reduce((a, i) => a + i.value, 0);
  return <EChart build={build} summary={{ cols: ['slice', 'value', 'share'], rows: items.map((i) => [i.label, fmtNum(i.value), total > 0 ? `${Math.round((i.value / total) * 100)}%` : '—']) }} footer={items.length ? <span className="mono">{`total ${fmtNum(total)}`}</span> : <span>No data</span>} />;
}

/** radar — several dimensions of several things on one polygon: host health profiles, SLO scorecards. */
export function RadarChart({ options, error }: WidgetProps) {
  const { axes, rows } = normaliseRadar(options);
  const build = (t: Tokens) => radarOption(options, t);
  if (error) return <Err error={error} />;
  return <EChart build={build} summary={{ cols: ['row', ...axes.map((a) => a.name)], rows: rows.map((r) => [r.name, ...axes.map((_, i) => fmtNum(r.values[i] ?? Number.NaN, str(options['unit'])))]) }} footer={rows.length && axes.length ? undefined : <span>No rows</span>} />;
}

/** sankey — how much flows from where to where: traffic between zones, alerts source → severity → host. */
export function SankeyChart({ options, error }: WidgetProps) {
  const { links } = normaliseFlow(options);
  const build = (t: Tokens) => sankeyOption(options, t);
  if (error) return <Err error={error} />;
  const dropped = arr(options['links'] ?? options['flows'] ?? options['edges'] ?? options['data']).length - links.length;
  return <EChart build={build} summary={{ cols: ['from', 'to', 'value'], rows: links.slice(0, 60).map((l) => [l.source, l.target, fmtNum(l.value, str(options['unit']))]) }} footer={links.length ? (dropped > 0 ? <span className="wg-computed">{`${dropped} link(s) dropped — self-links and cycles cannot be drawn as a flow`}</span> : undefined) : <span>No flows</span>} />;
}

/** boxplot — the distribution per group side by side, with outliers as dots. */
export function BoxplotChart({ options, error }: WidgetProps) {
  const rows = normaliseBoxes(options);
  const unit = str(options['unit']);
  const build = (t: Tokens) => boxplotOption(options, t);
  if (error) return <Err error={error} />;
  return <EChart build={build} summary={{ cols: ['group', 'min', 'p25', 'median', 'p75', 'max', 'outliers'], rows: rows.map((r) => [r.name, ...r.box.map((v) => fmtNum(v, unit)), r.outliers.length]) }} footer={rows.length ? <span className="wg-computed">whiskers at 1.5×IQR — computed from the samples given</span> : <span>No rows</span>} />;
}

/** calendar — one cell per day over weeks or months, coloured by value. */
export function CalendarHeatmap({ options, error }: WidgetProps) {
  const days = normaliseDays(options);
  const build = (t: Tokens) => calendarOption(options, t);
  if (error) return <Err error={error} />;
  const total = days.reduce((a, d) => a + d[1], 0);
  return <EChart build={build} summary={{ cols: ['day', 'value'], rows: days.slice(-60).map((d) => [d[0], fmtNum(d[1], str(options['unit']))]) }} footer={days.length ? <span className="mono">{`${days.length} days · total ${fmtNum(total, str(options['unit']))}`}</span> : <span>No days</span>} />;
}

/** radial — a modern arc gauge: value against min/max with warn/crit bands. Prefer over gauge. */
export function GaugeChart({ options, error }: WidgetProps) {
  const v = num(options['value']);
  const build = (t: Tokens) => gaugeOption(options, t);
  if (error) return <Err error={error} />;
  const unit = str(options['unit'], num(options['max']) === undefined && num(options['min']) === undefined ? '%' : '');
  return <EChart build={build} summary={{ cols: ['value', 'warn', 'crit'], rows: [[v === undefined ? '—' : fmtNum(v, unit), num(options['warn']) === undefined ? '—' : fmtNum(num(options['warn'])!, unit), num(options['crit']) === undefined ? '—' : fmtNum(num(options['crit'])!, unit)]] }} footer={v === undefined ? <span>No value</span> : undefined} />;
}

const agoText = (s: number): string => (s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${(s / 3600).toFixed(1)}h ago` : `${(s / 86_400).toFixed(1)}d ago`);
const deltaTone = (delta: number, lowIsGood: boolean): 'ok' | 'crit' | 'flat' => (delta === 0 ? 'flat' : (delta > 0) !== lowIsGood ? 'ok' : 'crit');

/**
 * stat — the modern KPI tile: a value with its unit, the change against a
 * previous value (direction, colour by whether up is good), a sparkline, and
 * threshold colouring. Several `items` make a row of tiles. Prefer over kpi.
 */
export function StatPanel({ options, error }: WidgetProps) {
  const raw = Array.isArray(options['items']) ? options['items'] : [options];
  const unit0 = str(options['unit']);
  const now = Date.now();
  const items = raw.filter(isObj).map((i) => {
    // kind "age": the value is a TIMESTAMP and the tile says how long ago,
    // coloured by maxAge (warn) / maxAgeCrit — last backup, last scrape,
    // last ETL run, last model refresh. Freshness is a number too.
    const at = i['at'] ?? i['age'] ?? (i['kind'] === 'age' ? i['value'] : undefined);
    if (at !== undefined) {
      const ms = typeof at === 'string' ? Date.parse(at) : typeof at === 'number' ? (at < 1e11 ? at * 1000 : at) : Number.NaN;
      const ageS = Number.isFinite(ms) ? Math.max(0, (now - ms) / 1000) : undefined;
      const warn = num(i['maxAge'] ?? options['maxAge']), crit = num(i['maxAgeCrit'] ?? options['maxAgeCrit']);
      const state = ageS === undefined ? 'flat' : crit !== undefined && ageS >= crit ? 'crit' : warn !== undefined && ageS >= warn ? 'warn' : warn !== undefined || crit !== undefined ? 'ok' : 'flat';
      return { label: str(i['label'] ?? i['name'], 'Last seen'), value: ageS, unit: '', text: ageS === undefined ? '—' : agoText(ageS), delta: undefined, pct: undefined, tone: 'flat' as const, state, series: [] as number[], sub: str(i['sub']) || (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : ''), target: undefined };
    }
    const value = num(i['value']);
    const previous = num(i['previous'] ?? i['prev']);
    const unit = str(i['unit'], unit0);
    const lowIsGood = (i['lowIsGood'] ?? options['lowIsGood']) === true;
    const warn = num(i['warn'] ?? options['warn']), crit = num(i['crit'] ?? options['crit']);
    const series = arr(i['spark'] ?? i['series']).map((v) => num(v)).filter((v): v is number => v !== undefined);
    const state = value === undefined ? 'flat' : lowIsGood
      ? (crit !== undefined && value <= crit ? 'crit' : warn !== undefined && value <= warn ? 'warn' : crit !== undefined || warn !== undefined ? 'ok' : 'flat')
      : (crit !== undefined && value >= crit ? 'crit' : warn !== undefined && value >= warn ? 'warn' : crit !== undefined || warn !== undefined ? 'ok' : 'flat');
    const delta = value !== undefined && previous !== undefined ? value - previous : undefined;
    const pct = delta !== undefined && previous ? (delta / Math.abs(previous)) * 100 : undefined;
    return { label: str(i['label'] ?? i['name'], 'Value'), value, unit, text: typeof i['value'] === 'string' ? i['value'] : undefined, delta, pct, tone: delta === undefined ? 'flat' : deltaTone(delta, lowIsGood), state, series, sub: str(i['sub']), target: num(i['target']) };
  });
  if (error) return <Err error={error} />;
  if (items.length === 0) return <div className="wg-empty">No data</div>;
  return (
    <div className={`st-row${items.length === 1 ? ' one' : ''}`}>
      {items.map((i, k) => (
        <div key={k} className={`st-item st-${i.state}`}>
          <div className="st-l">{i.label}</div>
          <div className="st-v">{i.text ?? (i.value === undefined ? '—' : fmtNum(i.value, i.unit))}</div>
          <div className="st-d">
            {i.delta !== undefined && <span className={`st-delta ${i.tone}`}>{i.delta > 0 ? '▲' : i.delta < 0 ? '▼' : '•'} {fmtNum(Math.abs(i.delta), i.unit)}{i.pct !== undefined ? ` (${Math.abs(i.pct) >= 100 ? Math.round(Math.abs(i.pct)) : Math.abs(i.pct).toFixed(1)}%)` : ''}</span>}
            {i.target !== undefined && <span className="st-sub">target {fmtNum(i.target, i.unit)}</span>}
            {i.sub && <span className="st-sub">{i.sub}</span>}
          </div>
          {i.series.length > 1 && <div className="st-s"><EChart build={(t) => sparkOption(i.series, t, i.state === 'crit' ? t.crit : i.state === 'warn' ? t.warn : i.state === 'ok' ? t.ok : t.series[0]!)} summary={{ cols: ['value'], rows: i.series.slice(-8).map((v) => [fmtNum(v, i.unit)]) }} height={26} /></div>}
        </div>
      ))}
    </div>
  );
}

/**
 * hostmap — one tile per host coloured by a METRIC (not just a state), sized
 * to fit however many there are, grouped when a group is given. The Datadog
 * host map, for an estate: "which boxes are hot" in one glance.
 */
export function HostMap({ options, error }: WidgetProps) {
  const unit = str(options['unit']);
  const items = arr(options['items'] ?? options['hosts'] ?? options['data']).map((r) => {
    if (Array.isArray(r)) return { name: str(r[0], '?'), value: num(r[1]), group: typeof r[2] === 'string' ? r[2] : undefined };
    if (isObj(r)) return { name: str(r['name'] ?? r['host'] ?? r['label'], '?'), value: num(r['value']), group: typeof r['group'] === 'string' ? r['group'] : undefined, state: r['state'] === undefined ? undefined : normState(r['state']) };
    return undefined;
  }).filter((x): x is { name: string; value: number | undefined; group: string | undefined; state?: ReturnType<typeof normState> | undefined } => Boolean(x));
  if (error) return <Err error={error} />;
  if (items.length === 0) return <div className="wg-empty">No hosts</div>;
  const vals = items.map((i) => i.value).filter((v): v is number => v !== undefined);
  const min = num(options['min']) ?? (vals.length ? Math.min(...vals) : 0);
  const max = num(options['max']) ?? (vals.length ? Math.max(...vals) : 1);
  const warn = num(options['warn']), crit = num(options['crit']);
  const lowIsBad = options['lowIsBad'] === true;
  const tone = (v: number | undefined, state?: ReturnType<typeof normState>): string => {
    if (state === 'down') return 'crit'; if (state === 'warn') return 'warn';
    if (v === undefined) return 'unknown';
    if (crit !== undefined && (lowIsBad ? v <= crit : v >= crit)) return 'crit';
    if (warn !== undefined && (lowIsBad ? v <= warn : v >= warn)) return 'warn';
    return crit !== undefined || warn !== undefined ? 'ok' : 'heat';
  };
  const heat = (v: number | undefined): number => (v === undefined || max <= min ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min))));
  const groups = [...new Set(items.map((i) => i.group ?? ''))];
  const size = items.length > 60 ? 'xs' : items.length > 24 ? 's' : items.length > 8 ? 'm' : 'l';
  return (
    <div className={`hm hm-${size}`}>
      {groups.map((g) => (
        <div key={g} className="hm-g">
          {g && <div className="hm-gl">{g}</div>}
          <div className="hm-tiles">
            {items.filter((i) => (i.group ?? '') === g).map((i, k) => {
              const tn = tone(i.value, i.state);
              return (
                <div key={k} className={`hm-t ${tn}`} style={tn === 'heat' ? { ['--heat' as string]: heat(i.value) } : undefined} title={`${i.name}${i.value === undefined ? '' : `: ${fmtNum(i.value, unit)}`}${i.group ? ` · ${i.group}` : ''}`}>
                  <span className="hm-n">{i.name}</span>
                  {size !== 'xs' && <span className="hm-v">{i.value === undefined ? '—' : fmtNum(i.value, unit)}</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * change — what moved: each row's value now against before, ranked by the
 * size of the change. The answer to "what is different since yesterday".
 */
export function ChangeRows({ options, error }: WidgetProps) {
  const unit = str(options['unit']);
  const lowIsGood = options['lowIsGood'] === true;
  const rows = arr(options['items'] ?? options['rows'] ?? options['data']).map((r) => {
    if (Array.isArray(r)) return { label: str(r[0], '?'), before: num(r[1]), now: num(r[2]) };
    if (isObj(r)) return { label: str(r['label'] ?? r['name'] ?? r['host'], '?'), before: num(r['before'] ?? r['previous'] ?? r['prev']), now: num(r['now'] ?? r['value'] ?? r['current']) };
    return undefined;
  }).filter((x): x is { label: string; before: number | undefined; now: number | undefined } => Boolean(x))
    .map((r) => { const d = r.now !== undefined && r.before !== undefined ? r.now - r.before : undefined; const pct = d !== undefined && r.before ? (d / Math.abs(r.before)) * 100 : undefined; return { ...r, d, pct, tone: d === undefined ? 'flat' : deltaTone(d, lowIsGood) }; })
    .sort((a, b) => Math.abs(b.pct ?? b.d ?? 0) - Math.abs(a.pct ?? a.d ?? 0));
  if (error) return <Err error={error} />;
  if (rows.length === 0) return <div className="wg-empty">No rows</div>;
  const maxAbs = Math.max(1e-9, ...rows.map((r) => Math.abs(r.pct ?? 0)));
  return (
    <table className="tb ch">
      <thead><tr><th>{str(options['label'], 'item')}</th><th className="r">{str(options['beforeLabel'], 'before')}</th><th className="r">{str(options['nowLabel'], 'now')}</th><th className="r">change</th><th aria-hidden /></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="mono">{r.label}</td>
            <td className="r mono">{r.before === undefined ? '—' : fmtNum(r.before, unit)}</td>
            <td className="r mono">{r.now === undefined ? '—' : fmtNum(r.now, unit)}</td>
            <td className={`r mono ch-d ${r.tone}`}>{r.d === undefined ? '—' : `${r.d > 0 ? '+' : r.d < 0 ? '−' : ''}${fmtNum(Math.abs(r.d), unit)}${r.pct !== undefined ? ` (${r.pct > 0 ? '+' : r.pct < 0 ? '−' : ''}${Math.abs(r.pct) >= 100 ? Math.round(Math.abs(r.pct)) : Math.abs(r.pct).toFixed(1)}%)` : ''}`}</td>
            <td className="ch-bar"><i className={r.tone} style={{ width: `${Math.round((Math.abs(r.pct ?? 0) / maxAbs) * 100)}%` }} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── The taxonomy set: gantt, funnel, pipeline, plandiff, oncall, expiry, scorecard ──

/** gantt — spans on one time axis: a trace waterfall, job runs, deployment steps, an incident timeline. */
export function GanttChart({ options, error }: WidgetProps) {
  const rows = normaliseGantt(options);
  const build = (t: Tokens) => ganttOption(options, t);
  if (error) return <Err error={error} />;
  const dur = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 3_600_000).toFixed(1)}h`);
  const total = rows.length ? Math.max(...rows.map((r) => r.end)) - Math.min(...rows.map((r) => r.start)) : 0;
  return <EChart build={build} summary={{ cols: ['span', 'start', 'duration', 'status'], rows: rows.slice(0, 60).map((r) => [`${'  '.repeat(r.depth)}${r.name}`, stamp(r.start), dur(r.end - r.start), r.status]) }} footer={rows.length ? <span className="mono">{`${rows.length} spans · ${dur(total)} end to end`}</span> : <span>No spans</span>} />;
}

/** funnel — stages each a subset of the last; the drop between them is the finding. */
export function FunnelChart({ options, error }: WidgetProps) {
  const items = normaliseItems(options, 'stages');
  const build = (t: Tokens) => funnelOption(options, t);
  if (error) return <Err error={error} />;
  const first = items[0]?.value ?? 0, last = items.at(-1)?.value ?? 0;
  return <EChart build={build} summary={{ cols: ['stage', 'count', 'of first'], rows: items.map((i) => [i.label, fmtNum(i.value, str(options['unit'])), first ? `${Math.round((i.value / first) * 100)}%` : '—']) }} footer={items.length >= 2 ? <span className="mono">{`${fmtNum(first)} → ${fmtNum(last)} · ${first ? Math.round((1 - last / first) * 100) : 0}% reduced`}</span> : <span>Needs two or more stages</span>} />;
}

type StageState = 'ok' | 'warn' | 'crit' | 'running' | 'pending' | 'skipped' | 'unknown';
const stageState = (v: unknown): StageState => { const s = String(v ?? '').toLowerCase(); if (s === 'running' || s === 'in_progress' || s === 'active') return 'running'; if (s === 'pending' || s === 'queued' || s === 'waiting' || s === 'scheduled') return 'pending'; if (s === 'skipped' || s === 'cancelled' || s === 'canceled') return 'skipped'; const n = normState(s); return n === 'up' ? 'ok' : n === 'down' ? 'crit' : n === 'warn' ? 'warn' : 'unknown'; };
const durText = (s: number | undefined): string => (s === undefined ? '' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${(s / 60).toFixed(1)}m` : `${(s / 3600).toFixed(1)}h`);

/**
 * pipeline — stages left to right with status and duration: a CI build, an
 * ETL DAG, a deployment plan, a backup chain. The current stage pulses.
 */
export function PipelineView({ options, error }: WidgetProps) {
  const stages = arr(options['stages'] ?? options['steps'] ?? options['items']).map((r) => {
    if (typeof r === 'string') return { name: r, state: 'unknown' as StageState, seconds: undefined as number | undefined, detail: '' };
    if (Array.isArray(r)) return { name: str(r[0], '?'), state: stageState(r[1]), seconds: num(r[2]), detail: str(r[3]) };
    if (isObj(r)) return { name: str(r['name'] ?? r['label'] ?? r['stage'], '?'), state: stageState(r['status'] ?? r['state']), seconds: num(r['seconds'] ?? r['duration']) ?? (num(r['durationMs']) !== undefined ? num(r['durationMs'])! / 1000 : undefined), detail: str(r['detail'] ?? r['note']) };
    return undefined;
  }).filter((x): x is { name: string; state: StageState; seconds: number | undefined; detail: string } => Boolean(x));
  if (error) return <Err error={error} />;
  if (stages.length === 0) return <div className="wg-empty">No stages</div>;
  const total = stages.reduce((a, s) => a + (s.seconds ?? 0), 0);
  const done = stages.filter((s) => s.state === 'ok').length;
  const worst = stages.some((s) => s.state === 'crit') ? 'crit' : stages.some((s) => s.state === 'running') ? 'running' : stages.some((s) => s.state === 'warn') ? 'warn' : done === stages.length ? 'ok' : 'pending';
  return (
    <div className="pl-wrap">
      {str(options['title']) && <div className="pl-title"><b>{str(options['title'])}</b><span className={`pl-badge ${worst}`}>{worst === 'ok' ? 'passed' : worst === 'crit' ? 'failed' : worst}</span></div>}
      <div className="pl-stages">
        {stages.map((s, i) => (
          <div key={i} className={`pl-stage ${s.state}`} title={`${s.name} · ${s.state}${s.seconds !== undefined ? ` · ${durText(s.seconds)}` : ''}${s.detail ? `\n${s.detail}` : ''}`}>
            <div className="pl-dot" aria-hidden />
            <div className="pl-n">{s.name}</div>
            <div className="pl-m mono">{s.state === 'pending' ? 'queued' : s.state === 'skipped' ? 'skipped' : s.state === 'running' ? 'running…' : durText(s.seconds) || s.state}</div>
            {i < stages.length - 1 && <div className="pl-link" aria-hidden />}
          </div>
        ))}
      </div>
      <div className="pl-foot mono">{`${done}/${stages.length} stages${total ? ` · ${durText(total)} total` : ''}`}</div>
    </div>
  );
}

/**
 * plandiff — an infrastructure-as-code plan as a diff: add / change / destroy
 * counts and the resources under each, in the colours every operator reads
 * (green, amber, red). Destroy is the number that gets read first.
 */
export function PlanDiff({ options, error }: WidgetProps) {
  const kinds = ['add', 'change', 'destroy', 'replace'] as const;
  const norm = (k: unknown): (typeof kinds)[number] | undefined => { const s = String(k ?? '').toLowerCase(); return s === 'add' || s === 'create' || s === 'added' ? 'add' : s === 'change' || s === 'update' || s === 'changed' || s === 'modify' ? 'change' : s === 'destroy' || s === 'delete' || s === 'remove' || s === 'destroyed' ? 'destroy' : s === 'replace' ? 'replace' : undefined; };
  const items = arr(options['resources'] ?? options['changes'] ?? options['items']).map((r) => {
    if (Array.isArray(r)) { const k = norm(r[1]); return k ? { name: str(r[0], '?'), action: k, detail: str(r[2]) } : undefined; }
    if (isObj(r)) { const k = norm(r['action'] ?? r['change'] ?? r['op']); return k ? { name: str(r['name'] ?? r['address'] ?? r['resource'], '?'), action: k, detail: str(r['detail'] ?? r['reason']) } : undefined; }
    return undefined;
  }).filter((x): x is { name: string; action: (typeof kinds)[number]; detail: string } => Boolean(x));
  const counts = { add: num(options['add']) ?? items.filter((i) => i.action === 'add').length, change: num(options['change']) ?? items.filter((i) => i.action === 'change').length, destroy: num(options['destroy']) ?? items.filter((i) => i.action === 'destroy').length, replace: num(options['replace']) ?? items.filter((i) => i.action === 'replace').length };
  if (error) return <Err error={error} />;
  const none = counts.add + counts.change + counts.destroy + counts.replace === 0;
  return (
    <div className="pd">
      <div className="pd-h">
        {str(options['tool']) && <span className="p">{str(options['tool'])}</span>}
        <span className="pd-c add mono">+{counts.add} add</span>
        <span className="pd-c change mono">~{counts.change} change</span>
        <span className="pd-c replace mono">±{counts.replace} replace</span>
        <span className={`pd-c destroy mono${counts.destroy ? ' hot' : ''}`}>−{counts.destroy} destroy</span>
      </div>
      {none && <div className="wg-empty">No changes. Infrastructure matches the code.</div>}
      {items.length > 0 && (
        <ul className="pd-list">
          {items.slice(0, 80).map((i, k) => <li key={k} className={`pd-r ${i.action}`}><span className="pd-sign mono">{i.action === 'add' ? '+' : i.action === 'change' ? '~' : i.action === 'replace' ? '±' : '−'}</span><span className="mono pd-name">{i.name}</span>{i.detail && <span className="pd-det">{i.detail}</span>}</li>)}
          {items.length > 80 && <li className="pd-more">… {items.length - 80} more</li>}
        </ul>
      )}
      {counts.destroy > 0 && <div className="pd-warn">Destroy is irreversible in most providers — read every − line before approving.</div>}
    </div>
  );
}

/**
 * oncall — who is on now, who is next, until when, per schedule. From the
 * PagerDuty connector or a roster the orchestrator was given.
 */
export function OncallCard({ options, error }: WidgetProps) {
  const now = Date.now();
  const scheds = arr(options['schedules'] ?? options['items'] ?? options['rotations']).filter(isObj).map((s) => {
    const shifts = arr(s['shifts'] ?? s['entries']).filter(isObj).map((e) => ({ who: str(e['who'] ?? e['name'] ?? e['user'], '?'), start: Date.parse(str(e['start'] ?? e['from'])), end: Date.parse(str(e['end'] ?? e['until'] ?? e['to'])), level: num(e['level']) }));
    const current = str(s['now'] ?? s['current'] ?? s['onCall']) || shifts.find((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.start <= now && now < x.end)?.who || '';
    const next = str(s['next']) || shifts.filter((x) => Number.isFinite(x.start) && x.start > now).sort((a, b) => a.start - b.start)[0]?.who || '';
    const untilRaw = s['until'] ?? shifts.find((x) => x.start <= now && now < x.end)?.end;
    const until = typeof untilRaw === 'number' ? untilRaw : typeof untilRaw === 'string' ? Date.parse(untilRaw) : Number.NaN;
    return { name: str(s['name'] ?? s['schedule'], 'On-call'), current, next, until, escalation: arr(s['escalation']).map((x) => str(x)).filter(Boolean), contact: str(s['contact'] ?? s['phone']) };
  });
  if (error) return <Err error={error} />;
  if (scheds.length === 0) return <div className="wg-empty">No schedule</div>;
  const left = (ms: number): string => { if (!Number.isFinite(ms)) return ''; const h = (ms - now) / 3_600_000; return h < 0 ? 'ended' : h < 1 ? `${Math.round(h * 60)}m left` : h < 48 ? `${Math.round(h)}h left` : `${Math.round(h / 24)}d left`; };
  return (
    <div className="oc">
      {scheds.map((s, i) => (
        <div key={i} className="oc-s">
          <div className="oc-n">{s.name}</div>
          <div className="oc-now">
            <span className="oc-dot" aria-hidden />
            <b>{s.current || 'nobody'}</b>
            {s.contact && <span className="mono oc-c">{s.contact}</span>}
            {Number.isFinite(s.until) && <span className="oc-until mono">{left(s.until)}</span>}
          </div>
          {(s.next || s.escalation.length > 0) && (
            <div className="oc-sub">
              {s.next && <span>next: <b>{s.next}</b></span>}
              {s.escalation.length > 0 && <span>escalates to {s.escalation.join(' → ')}</span>}
            </div>
          )}
          {!s.current && <div className="oc-gap">No one is on call now — a page goes nowhere.</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * expiry — things with a date they stop working: certificates, licences,
 * domains, tokens, leases, support contracts. Soonest first, coloured by
 * how close; an expired one is at the top in red.
 */
export function ExpiryList({ options, error }: WidgetProps) {
  const now = Date.now();
  const warnD = num(options['warnDays']) ?? 30, critD = num(options['critDays']) ?? 7;
  const items = arr(options['items'] ?? options['certs'] ?? options['rows']).map((r) => {
    if (Array.isArray(r)) return { name: str(r[0], '?'), at: Date.parse(str(r[1])), kind: str(r[2]), detail: '' };
    if (isObj(r)) return { name: str(r['name'] ?? r['label'] ?? r['host'] ?? r['subject'], '?'), at: typeof r['expires'] === 'number' ? (r['expires'] < 1e11 ? r['expires'] * 1000 : r['expires']) : Date.parse(str(r['expires'] ?? r['expiresAt'] ?? r['until'] ?? r['notAfter'])), kind: str(r['kind'] ?? r['type']), detail: str(r['detail'] ?? r['issuer']) };
    return undefined;
  }).filter((x): x is { name: string; at: number; kind: string; detail: string } => Boolean(x))
    .map((x) => ({ ...x, days: Number.isFinite(x.at) ? (x.at - now) / 86_400_000 : undefined }))
    .sort((a, b) => (a.days ?? Number.POSITIVE_INFINITY) - (b.days ?? Number.POSITIVE_INFINITY));
  if (error) return <Err error={error} />;
  if (items.length === 0) return <div className="wg-empty">Nothing tracked</div>;
  const tone = (d: number | undefined): string => (d === undefined ? 'unknown' : d < 0 ? 'expired' : d <= critD ? 'crit' : d <= warnD ? 'warn' : 'ok');
  const text = (d: number | undefined): string => (d === undefined ? 'no date' : d < 0 ? `expired ${Math.round(-d)}d ago` : d < 1 ? `${Math.round(d * 24)}h left` : `${Math.round(d)}d left`);
  const bad = items.filter((i) => i.days !== undefined && i.days <= warnD).length;
  return (
    <div className="ex">
      <div className="ex-sum mono">{bad === 0 ? `${items.length} tracked · none within ${warnD}d` : `${bad} of ${items.length} within ${warnD}d`}</div>
      <ul className="ex-list">
        {items.slice(0, 40).map((i, k) => (
          <li key={k} className={`ex-r ${tone(i.days)}`} title={Number.isFinite(i.at) ? new Date(i.at).toISOString() : ''}>
            <span className="ex-left mono">{text(i.days)}</span>
            <span className="ex-name">{i.name}</span>
            {i.kind && <span className="p ex-k">{i.kind}</span>}
            {i.detail && <span className="ex-d">{i.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * scorecard — controls as pass / fail / n-a with the score and the failing
 * ones first: a CIS baseline, SOC2 evidence, a patch policy, a launch
 * checklist. The score is COMPUTED from the rows and says so.
 */
export function Scorecard({ options, error }: WidgetProps) {
  const norm = (v: unknown): 'pass' | 'fail' | 'warn' | 'na' => { if (v === true) return 'pass'; if (v === false) return 'fail'; const s = String(v ?? '').toLowerCase(); if (/^(pass|passed|ok|compliant|yes|true|done|met)$/.test(s)) return 'pass'; if (/^(fail|failed|no|false|missing|non-?compliant|open|unmet)$/.test(s)) return 'fail'; if (/^(warn|partial|manual|review|pending)$/.test(s)) return 'warn'; return 'na'; };
  const rows = arr(options['controls'] ?? options['checks'] ?? options['items']).map((r) => {
    if (Array.isArray(r)) return { id: str(r[0]), name: str(r[1] ?? r[0], '?'), status: norm(r[2] ?? r[1]), detail: str(r[3]), group: '' };
    if (isObj(r)) return { id: str(r['id'] ?? r['control']), name: str(r['name'] ?? r['title'] ?? r['control'], '?'), status: norm(r['status'] ?? r['result'] ?? r['pass']), detail: str(r['detail'] ?? r['evidence'] ?? r['note']), group: str(r['group'] ?? r['section']) };
    return undefined;
  }).filter((x): x is { id: string; name: string; status: 'pass' | 'fail' | 'warn' | 'na'; detail: string; group: string } => Boolean(x));
  if (error) return <Err error={error} />;
  if (rows.length === 0) return <div className="wg-empty">No controls</div>;
  const scored = rows.filter((r) => r.status !== 'na');
  const pass = scored.filter((r) => r.status === 'pass').length, fail = scored.filter((r) => r.status === 'fail').length, warn = scored.filter((r) => r.status === 'warn').length;
  const pct = scored.length ? Math.round((pass / scored.length) * 100) : 0;
  const target = num(options['target']);
  const order = { fail: 0, warn: 1, pass: 2, na: 3 };
  const sorted = rows.slice().sort((a, b) => order[a.status] - order[b.status]);
  return (
    <div className="sc">
      <div className="sc-h">
        <div className={`sc-score ${target !== undefined ? (pct >= target ? 'ok' : 'crit') : fail ? 'crit' : warn ? 'warn' : 'ok'}`}><b className="mono">{pct}%</b><span>{str(options['title'], 'compliant')}</span></div>
        <div className="sc-counts mono"><span className="ok">{pass} pass</span><span className="crit">{fail} fail</span>{warn > 0 && <span className="warn">{warn} partial</span>}{rows.length - scored.length > 0 && <span className="dim">{rows.length - scored.length} n/a</span>}{target !== undefined && <span className="dim">target {target}%</span>}</div>
        <div className="sc-bar" aria-hidden><i className="ok" style={{ width: `${scored.length ? (pass / scored.length) * 100 : 0}%` }} /><i className="warn" style={{ width: `${scored.length ? (warn / scored.length) * 100 : 0}%` }} /><i className="crit" style={{ width: `${scored.length ? (fail / scored.length) * 100 : 0}%` }} /></div>
      </div>
      <ul className="sc-list">
        {sorted.slice(0, 60).map((r, k) => (
          <li key={k} className={`sc-r ${r.status}`} title={r.detail}>
            <span className="sc-st mono">{r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : r.status === 'warn' ? '!' : '–'}</span>
            {r.id && <span className="sc-id mono">{r.id}</span>}
            <span className="sc-n">{r.name}</span>
            {r.group && <span className="p sc-g">{r.group}</span>}
            {r.detail && r.status !== 'pass' && <span className="sc-d">{r.detail}</span>}
          </li>
        ))}
      </ul>
      <div className="sc-foot wg-computed">score computed from {scored.length} scored control{scored.length === 1 ? '' : 's'}; n/a excluded</div>
    </div>
  );
}
