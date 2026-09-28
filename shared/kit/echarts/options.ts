/**
 * Option BUILDERS — pure functions from widget options to an ECharts option.
 *
 * Pure on purpose: the renderer (host.tsx) is a thin React wrapper, and the
 * thing worth testing is here — that a contract's example produces a chart
 * with the right series, the right axes and the right marks, with no DOM.
 * Every builder tolerates hostile input the way widgets.tsx always has: a
 * string where a number should be is skipped, an empty series draws an
 * empty chart, nothing throws.
 */
import { baseOption, fmtNum, fmtTime, type EChartsOption, type Tokens } from './engine.js';

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown, fb = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fb);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export type StateName = 'up' | 'warn' | 'down' | 'unknown';
export const stateColor = (t: Tokens, s: string): string => (s === 'up' || s === 'ok' ? t.ok : s === 'warn' || s === 'degraded' ? t.warn : s === 'down' || s === 'crit' || s === 'failed' ? t.crit : t.ink4);
export const normState = (v: unknown): StateName => {
  if (v === 1 || v === true) return 'up';
  if (v === 0 || v === false) return 'down';
  const s = String(v ?? '').toLowerCase();
  if (/^(up|ok|online|healthy|running|ready|active|pass|passing|1)$/.test(s)) return 'up';
  if (/^(down|offline|failed|critical|crit|error|unreachable|dead|0)$/.test(s)) return 'down';
  if (/^(warn|warning|degraded|pending|paused|maintenance)$/.test(s)) return 'warn';
  return 'unknown';
};

// ── Series normalisation ────────────────────────────────────────────────────

export interface NSeries { name: string; points: Array<[number, number]> }
export interface Normalised { series: NSeries[]; timeAxis: boolean; labels: string[] }

/**
 * Accepts every shape a series has ever been given in a widget fence:
 *   series: number[]                                   (+ labels?: string[])
 *   series: [{ name, points: [[t,v],…] | number[] }]
 *   data:   number[]                                    (legacy)
 * Points with a millisecond/second time become a time axis; bare numbers an index axis.
 */
export function normaliseSeries(o: Record<string, unknown>): Normalised {
  const labels = arr(o['labels']).map((l) => str(l));
  const raw = Array.isArray(o['series']) ? o['series'] : Array.isArray(o['data']) ? o['data'] : [];
  if (raw.length > 0 && raw.every((x) => typeof x === 'number' || typeof x === 'string')) {
    const pts = raw.map((v, i) => [i, num(v)] as [number, number | undefined]).filter((p): p is [number, number] => p[1] !== undefined);
    return { series: [{ name: str(o['name'], 'series'), points: pts }], timeAxis: false, labels };
  }
  const out: NSeries[] = [];
  let timeAxis = false;
  for (const s of raw) {
    if (!isObj(s)) continue;
    const pts = Array.isArray(s['points']) ? s['points'] : Array.isArray(s['values']) ? s['values'] : Array.isArray(s['data']) ? s['data'] : [];
    const points: Array<[number, number]> = [];
    pts.forEach((p, i) => {
      if (Array.isArray(p)) { const t = num(p[0]), v = num(p[1]); if (t !== undefined && v !== undefined) { points.push([t < 1e11 && t > 1e8 ? t * 1000 : t, v]); timeAxis = timeAxis || t > 1e8; } }
      else if (isObj(p)) { const t = num(p['t'] ?? p['time'] ?? p['x']), v = num(p['v'] ?? p['value'] ?? p['y']); if (v !== undefined) { points.push([t === undefined ? i : (t < 1e11 && t > 1e8 ? t * 1000 : t), v]); timeAxis = timeAxis || (t !== undefined && t > 1e8); } }
      else { const v = num(p); if (v !== undefined) points.push([i, v]); }
    });
    out.push({ name: str(s['name'] ?? s['label'], `series ${out.length + 1}`), points });
  }
  return { series: out, timeAxis, labels };
}

const timeAxisOpt = (t: Tokens, span: number) => ({
  type: 'time', axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
  axisLabel: { color: t.ink4, fontFamily: t.mono, fontSize: 9, hideOverlap: true, formatter: (v: number) => fmtTime(v, span) },
});
const catAxisOpt = (t: Tokens, labels: string[]) => ({
  type: 'category', data: labels, axisLine: { show: false }, axisTick: { show: false },
  axisLabel: { color: t.ink4, fontFamily: t.mono, fontSize: 9, hideOverlap: true },
});
const valAxisOpt = (t: Tokens, unit = '') => ({
  type: 'value', splitLine: { lineStyle: { color: t.line } }, axisLine: { show: false }, axisTick: { show: false },
  axisLabel: { color: t.ink4, fontFamily: t.mono, fontSize: 9, formatter: (v: number) => fmtNum(v, unit) }, scale: true,
});

// ── Time series ─────────────────────────────────────────────────────────────

export interface Threshold { level: 'info' | 'warn' | 'crit'; gt?: number | undefined; lt?: number | undefined }

export function timeseriesOption(o: Record<string, unknown>, t: Tokens, thresholds: Threshold[] = []): EChartsOption {
  const n = normaliseSeries(o);
  const unit = str(o['unit']);
  const area = o['area'] !== false;
  const allT = n.series.flatMap((s) => s.points.map((p) => p[0]));
  const span = allT.length ? Math.max(...allT) - Math.min(...allT) : 0;
  const band = isObj(o['band']) ? { lo: num(o['band']['lo']), hi: num(o['band']['hi']) } : undefined;
  const marks: unknown[] = [];
  for (const th of thresholds) {
    const v = th.gt ?? th.lt; if (v === undefined) continue;
    marks.push({ yAxis: v, lineStyle: { color: th.level === 'crit' ? t.crit : th.level === 'warn' ? t.warn : t.info, type: 'dashed', width: 1 }, label: { formatter: `${th.level} ${th.gt !== undefined ? '>' : '<'} ${fmtNum(v, unit)}`, color: t.ink4, fontFamily: t.mono, fontSize: 9, position: 'insideEndTop' } });
  }
  for (const a of arr(o['annotations'])) {
    if (!isObj(a)) continue;
    const at = num(a['at']) ?? (typeof a['at'] === 'string' ? Date.parse(a['at']) : undefined); if (at === undefined || !Number.isFinite(at)) continue;
    marks.push({ xAxis: at < 1e11 && at > 1e8 ? at * 1000 : at, lineStyle: { color: t.crit, type: 'dashed', width: 1 }, label: { formatter: str(a['label'], 'change'), color: t.crit, fontFamily: t.mono, fontSize: 9, position: 'insideEndTop' } });
  }
  const series = n.series.map((s, i) => ({
    name: s.name, type: 'line', showSymbol: false, smooth: false, sampling: 'lttb',
    lineStyle: { width: 1.5 }, emphasis: { focus: 'series' },
    ...(area && n.series.length === 1 ? { areaStyle: { opacity: 0.12 } } : {}),
    data: s.points.map((p) => (n.timeAxis ? p : [n.labels[p[0]] ?? p[0], p[1]])),
    ...(i === 0 && (marks.length || band) ? {
      markLine: marks.length ? { silent: true, symbol: 'none', data: marks } : undefined,
      markArea: band && band.lo !== undefined && band.hi !== undefined ? { silent: true, itemStyle: { color: t.ink4, opacity: 0.15 }, data: [[{ yAxis: band.lo }, { yAxis: band.hi }]] } : undefined,
    } : {}),
  }));
  const last = n.series[0]?.points.at(-1);
  if (last && series[0]) (series[0] as Record<string, unknown>)['markPoint'] = { symbol: 'circle', symbolSize: 6, itemStyle: { color: t.series[0] }, label: { show: false }, data: [{ coord: n.timeAxis ? last : [n.labels[last[0]] ?? last[0], last[1]] }] };
  return {
    ...baseOption(t),
    legend: n.series.length > 1 ? { show: true, top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 3, textStyle: { color: t.ink3, fontSize: 9.5 }, type: 'scroll' } : { show: false },
    grid: { left: 8, right: 8, top: n.series.length > 1 ? 22 : 10, bottom: 4, containLabel: true },
    xAxis: n.timeAxis ? timeAxisOpt(t, span) : catAxisOpt(t, n.labels.length ? n.labels : (n.series[0]?.points.map((p) => String(p[0])) ?? [])),
    yAxis: valAxisOpt(t, unit),
    dataZoom: [{ type: 'inside', zoomOnMouseWheel: 'shift', moveOnMouseMove: false }],
    tooltip: { ...(baseOption(t).tooltip as object), valueFormatter: (v: unknown) => fmtNum(typeof v === 'number' ? v : Number.NaN, unit) },
    series,
  };
}

// ── Categories ──────────────────────────────────────────────────────────────

export interface Item { label: string; value: number; color?: string | undefined; max?: number | undefined }
export function normaliseItems(o: Record<string, unknown>, key = 'items'): Item[] {
  const raw = Array.isArray(o[key]) ? o[key] : Array.isArray(o['rows']) ? o['rows'] : Array.isArray(o['slices']) ? o['slices'] : Array.isArray(o['data']) ? o['data'] : [];
  const out: Item[] = [];
  for (const r of raw) {
    if (Array.isArray(r)) { const v = num(r[1]); if (v !== undefined) out.push({ label: str(r[0]), value: v, ...(typeof r[2] === 'string' ? { color: r[2] } : {}) }); }
    else if (isObj(r)) { const v = num(r['value'] ?? r['count'] ?? r['v']); if (v !== undefined) out.push({ label: str(r['label'] ?? r['name'] ?? r['host'], '?'), value: v, color: typeof r['color'] === 'string' ? r['color'] : undefined, max: num(r['max']) }); }
  }
  return out;
}

const cssColor = (t: Tokens, c: string | undefined, fallback: string): string => {
  if (!c) return fallback;
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(c.trim());
  if (!m) return c;
  const k = m[1] as keyof Tokens;
  const v = (t as unknown as Record<string, unknown>)[k];
  return typeof v === 'string' ? v : fallback;
};

export function barsOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const items = normaliseItems(o);
  const unit = str(o['unit']);
  const horizontal = o['orientation'] === 'horizontal' || items.length > 8;
  const cat = { ...catAxisOpt(t, items.map((i) => i.label)), ...(horizontal ? { inverse: true } : {}) };
  const val = valAxisOpt(t, unit);
  return {
    ...baseOption(t),
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', valueFormatter: (v: unknown) => fmtNum(typeof v === 'number' ? v : Number.NaN, unit) },
    xAxis: horizontal ? val : cat, yAxis: horizontal ? cat : val,
    series: [{ type: 'bar', barMaxWidth: 28, data: items.map((i) => ({ value: i.value, name: i.label, itemStyle: { color: cssColor(t, i.color, t.series[0]!), borderRadius: 2 } })), label: { show: items.length <= 12, position: horizontal ? 'right' : 'top', color: t.ink3, fontFamily: t.mono, fontSize: 9, formatter: (p: { value: number }) => fmtNum(p.value, unit) } }],
  };
}

export function topnOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const n = num(o['n']) ?? 10;
  const items = normaliseItems(o).sort((a, b) => b.value - a.value).slice(0, n);
  return barsOption({ ...o, items, orientation: 'horizontal' }, t);
}

export function donutOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const items = normaliseItems(o, 'slices');
  const total = items.reduce((a, i) => a + i.value, 0);
  const semantic: Record<string, string> = { up: t.ok, ok: t.ok, healthy: t.ok, warn: t.warn, warning: t.warn, degraded: t.warn, down: t.crit, critical: t.crit, crit: t.crit, failed: t.crit, unknown: t.ink4 };
  return {
    ...baseOption(t),
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { name: string; value: number; percent: number }) => `${p.name}  ${fmtNum(p.value)}  (${p.percent}%)` },
    legend: { show: items.length <= 6, orient: 'vertical', right: 0, top: 'middle', icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: t.ink3, fontSize: 9.5 } },
    graphic: [{ type: 'text', left: items.length <= 6 ? '30%' : 'center', top: 'middle', style: { text: str(o['total'], fmtNum(total)), fill: t.ink, font: `600 16px ${t.sans}`, textAlign: 'center' } }, ...(o['centerLabel'] ? [{ type: 'text', left: items.length <= 6 ? '30%' : 'center', top: '62%', style: { text: str(o['centerLabel']), fill: t.ink4, font: `9px ${t.sans}`, textAlign: 'center' } }] : [])],
    series: [{ type: 'pie', radius: ['58%', '82%'], center: [items.length <= 6 ? '30%' : '50%', '50%'], avoidLabelOverlap: true, label: { show: false }, itemStyle: { borderColor: t.bg2, borderWidth: 2 }, data: items.map((i) => ({ name: i.label, value: i.value, itemStyle: { color: cssColor(t, i.color, semantic[i.label.toLowerCase()] ?? '') || undefined } })) }],
  };
}

export function heatOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const rows = arr(o['rows']).filter(isObj).map((r) => ({ label: str(r['label'] ?? r['name'], '?'), cells: arr(r['cells'] ?? r['values']).map((c) => num(c) ?? 0) }));
  const cols = arr(o['cols']).map((c) => str(c));
  const width = Math.max(0, ...rows.map((r) => r.cells.length));
  const max = num(o['max']) ?? Math.max(1, ...rows.flatMap((r) => r.cells));
  const data: Array<[number, number, number]> = [];
  rows.forEach((r, y) => r.cells.forEach((v, x) => data.push([x, y, v])));
  return {
    ...baseOption(t),
    grid: { left: 8, right: 8, top: 6, bottom: 4, containLabel: true },
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { value: [number, number, number] }) => `${rows[p.value[1]]?.label ?? ''} · ${cols[p.value[0]] ?? p.value[0]}: ${fmtNum(p.value[2])}` },
    xAxis: { type: 'category', data: cols.length ? cols : Array.from({ length: width }, (_, i) => String(i)), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.ink4, fontFamily: t.mono, fontSize: 9, hideOverlap: true, interval: Math.max(0, Math.floor(width / 8) - 1) }, splitArea: { show: false } },
    yAxis: { type: 'category', data: rows.map((r) => r.label), inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.ink4, fontFamily: t.mono, fontSize: 9 } },
    visualMap: { show: false, min: 0, max, inRange: { color: [t.bg3, t.info, t.warn, t.crit] } },
    series: [{ type: 'heatmap', data, itemStyle: { borderColor: t.bg2, borderWidth: 1, borderRadius: 1 }, emphasis: { itemStyle: { borderColor: t.ink } } }],
  };
}

export function histOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const buckets = arr(o['buckets'] ?? o['data']).map((b) => num(b) ?? 0);
  const labels = arr(o['labels']).map((l) => str(l));
  const unit = str(o['unit']);
  const marks = (['p50', 'p95', 'p99'] as const).map((k) => ({ k, v: num(o[k]) })).filter((m) => m.v !== undefined);
  return {
    ...baseOption(t),
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item' },
    xAxis: catAxisOpt(t, labels.length ? labels : buckets.map((_, i) => String(i))),
    yAxis: valAxisOpt(t),
    series: [{ type: 'bar', barCategoryGap: '12%', data: buckets, itemStyle: { color: t.series[0], borderRadius: 2 }, ...(marks.length ? { markLine: { silent: true, symbol: 'none', data: marks.map((m, i) => ({ xAxis: labels.length ? nearestLabel(labels, m.v!) : Math.min(buckets.length - 1, i), lineStyle: { color: m.k === 'p99' ? t.crit : m.k === 'p95' ? t.warn : t.ink3, type: 'dashed' }, label: { formatter: `${m.k} ${fmtNum(m.v!, unit)}`, color: t.ink4, fontFamily: t.mono, fontSize: 9 } })) } } : {}) }],
  };
}
const nearestLabel = (labels: string[], v: number): string => labels.reduce((best, l) => (Math.abs(Number(l) - v) < Math.abs(Number(best) - v) ? l : best), labels[0]!);

// ── States over time ────────────────────────────────────────────────────────

export interface StateRow { name: string; segments: Array<{ from: number; to: number; state: StateName; label?: string }> }
export function normaliseStateRows(o: Record<string, unknown>): StateRow[] {
  const rows = arr(o['rows']).filter(isObj);
  const out: StateRow[] = [];
  for (const r of rows) {
    const name = str(r['name'] ?? r['label'], '?');
    const segs = arr(r['segments']).filter(isObj).map((s) => { const from = num(s['from']) ?? 0, to = num(s['to']) ?? from; return { from: from < 1e11 && from > 1e8 ? from * 1000 : from, to: to < 1e11 && to > 1e8 ? to * 1000 : to, state: normState(s['state']), ...(typeof s['label'] === 'string' ? { label: s['label'] } : {}) }; });
    if (segs.length) out.push({ name, segments: segs });
    else if (Array.isArray(r['points'])) {
      // From a series of states over time: consecutive equal states become one segment.
      const pts = (r['points'] as unknown[]).map((p) => (Array.isArray(p) ? [num(p[0]) ?? 0, normState(p[1])] as [number, StateName] : null)).filter((x): x is [number, StateName] => Boolean(x));
      const seg: StateRow['segments'] = [];
      for (let i = 0; i < pts.length; i++) {
        const [t0, st] = pts[i]!; const t = t0 < 1e11 && t0 > 1e8 ? t0 * 1000 : t0; const next = pts[i + 1]; const tn = next ? (next[0] < 1e11 && next[0] > 1e8 ? next[0] * 1000 : next[0]) : t + (pts.length > 1 ? (t - (pts[i - 1]?.[0] ?? t)) : 60_000);
        const last = seg.at(-1);
        if (last && last.state === st) last.to = tn; else seg.push({ from: t, to: tn, state: st });
      }
      if (seg.length) out.push({ name, segments: seg });
    }
  }
  return out;
}

export function stateTimelineOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const rows = normaliseStateRows(o);
  const all = rows.flatMap((r) => r.segments.flatMap((s) => [s.from, s.to]));
  const min = all.length ? Math.min(...all) : 0, max = all.length ? Math.max(...all) : 1;
  const data = rows.flatMap((r, y) => r.segments.map((s) => ({ name: r.name, value: [y, s.from, s.to, s.state, s.label ?? ''], itemStyle: { color: stateColor(t, s.state) } })));
  return {
    ...baseOption(t),
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { value: [number, number, number, string, string] }) => `${rows[p.value[0]]?.name ?? ''} · ${p.value[3]}${p.value[4] ? ` · ${p.value[4]}` : ''}<br/>${fmtTime(p.value[1], max - min)} → ${fmtTime(p.value[2], max - min)}` },
    grid: { left: 8, right: 8, top: 4, bottom: 4, containLabel: true },
    xAxis: { ...timeAxisOpt(t, max - min), min, max },
    yAxis: { type: 'category', data: rows.map((r) => r.name), inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.ink4, fontFamily: t.mono, fontSize: 9 } },
    series: [{
      type: 'custom',
      renderItem: (params: { coordSys: { x: number; y: number; width: number; height: number } }, api: { value: (i: number) => number; coord: (v: [number, number]) => [number, number]; size: (v: [number, number]) => [number, number]; style: () => Record<string, unknown> }) => {
        const y = api.value(0); const start = api.coord([api.value(1), y]); const end = api.coord([api.value(2), y]); const h = api.size([0, 1])[1] * 0.62;
        const x0 = Math.max(params.coordSys.x, start[0]); const x1 = Math.min(params.coordSys.x + params.coordSys.width, end[0]);
        if (x1 <= x0) return null;
        return { type: 'rect', shape: { x: x0, y: start[1] - h / 2, width: Math.max(1, x1 - x0), height: h, r: 2 }, style: api.style() };
      },
      encode: { x: [1, 2], y: 0 }, data,
    }],
  };
}

export function statusHistoryOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const rows = arr(o['rows']).filter(isObj).map((r) => ({ label: str(r['label'] ?? r['name'], '?'), cells: arr(r['cells'] ?? r['states']).map(normState) }));
  const buckets = arr(o['buckets']).map((b) => str(b));
  const width = Math.max(0, ...rows.map((r) => r.cells.length));
  const idx: Record<StateName, number> = { up: 0, warn: 1, down: 2, unknown: 3 };
  const data: Array<[number, number, number]> = [];
  rows.forEach((r, y) => r.cells.forEach((s, x) => data.push([x, y, idx[s]])));
  return {
    ...baseOption(t),
    grid: { left: 8, right: 8, top: 6, bottom: 4, containLabel: true },
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { value: [number, number, number] }) => `${rows[p.value[1]]?.label ?? ''} · ${buckets[p.value[0]] ?? p.value[0]}: ${(['up', 'warn', 'down', 'unknown'] as const)[p.value[2]]}` },
    xAxis: { type: 'category', data: buckets.length ? buckets : Array.from({ length: width }, (_, i) => String(i)), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.ink4, fontFamily: t.mono, fontSize: 9, hideOverlap: true } },
    yAxis: { type: 'category', data: rows.map((r) => r.label), inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.ink4, fontFamily: t.mono, fontSize: 9 } },
    visualMap: { show: false, type: 'piecewise', pieces: [{ value: 0, color: t.ok }, { value: 1, color: t.warn }, { value: 2, color: t.crit }, { value: 3, color: t.bg3 }] },
    series: [{ type: 'heatmap', data, itemStyle: { borderColor: t.bg2, borderWidth: 1.5, borderRadius: 2 } }],
  };
}

// ── Hierarchy ───────────────────────────────────────────────────────────────

interface TreeNode { name: string; value: number; children?: TreeNode[]; itemStyle?: { color: string } }
function normaliseTree(v: unknown, t: Tokens, depth = 0): TreeNode[] {
  return arr(v).filter(isObj).map((n) => {
    const children = normaliseTree(n['children'], t, depth + 1);
    const own = num(n['value']);
    const value = own ?? children.reduce((a, c) => a + c.value, 0);
    const pct = num(n['pct'] ?? n['used']);
    return { name: str(n['name'] ?? n['label'], '?'), value, ...(children.length ? { children } : {}), ...(pct !== undefined ? { itemStyle: { color: pct >= 90 ? t.crit : pct >= 75 ? t.warn : t.info } } : {}) };
  }).filter((n) => n.value > 0);
}
export function treemapOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const data = normaliseTree(o['tree'] ?? o['items'] ?? o['data'], t);
  const unit = str(o['unit']);
  return {
    ...baseOption(t),
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { name: string; value: number }) => `${p.name}: ${fmtNum(p.value, unit)}` },
    series: [{ type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, left: 0, right: 0, top: 0, bottom: 0, label: { color: t.ink, fontFamily: t.mono, fontSize: 10, formatter: (p: { name: string; value: number }) => `${p.name}\n${fmtNum(p.value, unit)}` }, upperLabel: { show: true, height: 16, color: t.ink2, fontSize: 9.5 }, itemStyle: { borderColor: t.bg2, borderWidth: 2, gapWidth: 2 }, levels: [{ itemStyle: { borderWidth: 0, gapWidth: 3 } }, { colorSaturation: [0.35, 0.6] }], data, color: t.series }],
  };
}

// ── Forecast and anomaly ────────────────────────────────────────────────────

/** Least-squares line through the points; returns slope per ms and intercept. */
export function linearFit(points: Array<[number, number]>): { slope: number; intercept: number; r2: number } | undefined {
  if (points.length < 5) return undefined;
  const n = points.length; const x0 = points[0]![0];
  const xs = points.map((p) => (p[0] - x0)), ys = points.map((p) => p[1]);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; syy += (ys[i]! - my) ** 2; }
  if (sxx === 0) return undefined;
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  // `intercept` is the value at the FIRST point's time (x0), since xs are offsets from it.
  return { slope, intercept: my - slope * mx, r2 };
}

export function forecastOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const n = normaliseSeries(o);
  const s = n.series[0];
  const threshold = num(o['threshold']);
  const unit = str(o['unit']);
  const horizonMs = (num(o['horizonDays']) ?? 14) * 86_400_000;
  const base = timeseriesOption({ ...o, series: s ? [s] : [], area: true }, t, threshold !== undefined ? [{ level: 'crit', gt: threshold }] : []);
  if (!s || !n.timeAxis) return base;
  const fit = linearFit(s.points);
  const series = (base.series as unknown[]) ?? [];
  if (fit && fit.r2 >= 0.5) {
    const x0 = s.points[0]![0]; const xn = s.points.at(-1)![0];
    const y = (x: number) => fit.intercept + fit.slope * (x - x0);
    const proj: Array<[number, number]> = [[xn, y(xn)], [xn + horizonMs, y(xn + horizonMs)]];
    let cross: [number, number] | undefined;
    if (threshold !== undefined && fit.slope !== 0) { const xc = x0 + (threshold - fit.intercept) / fit.slope; if (xc > xn && xc <= xn + horizonMs) cross = [xc, threshold]; }
    series.push({ name: 'projection (computed)', type: 'line', showSymbol: false, data: proj, lineStyle: { type: 'dashed', width: 1.4, color: t.ink3 }, ...(cross ? { markPoint: { symbol: 'circle', symbolSize: 8, itemStyle: { color: t.crit }, label: { show: true, position: 'top', color: t.crit, fontFamily: t.mono, fontSize: 9, formatter: `${fmtNum(threshold!, unit)} in ≈ ${Math.max(1, Math.round((cross[0] - xn) / 86_400_000))}d (computed)` }, data: [{ coord: cross }] } } : {}) });
  } else {
    series.push({ name: fit ? 'no projection — poor fit (computed)' : 'no projection — too few points', type: 'line', data: [] });
  }
  return { ...base, series, legend: { show: true, top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 3, textStyle: { color: t.ink3, fontSize: 9.5 } }, grid: { left: 8, right: 8, top: 22, bottom: 4, containLabel: true } };
}

/** Rolling median ± k·MAD band, computed client-side and labelled as such. */
export function anomalyOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const n = normaliseSeries(o);
  const s = n.series[0];
  const base = timeseriesOption({ ...o, series: s ? [s] : [], area: false }, t);
  if (!s || s.points.length < 8) return base;
  const win = Math.max(8, Math.floor(s.points.length / 4));
  const k = num(o['sigma']) ?? 3.5;
  const lo: Array<[number, number]> = [], hi: Array<[number, number]> = [];
  for (let i = 0; i < s.points.length; i++) {
    const seg = s.points.slice(Math.max(0, i - win), Math.max(1, i)).map((p) => p[1]).sort((a, b) => a - b);
    if (seg.length < 4) continue;
    const med = seg[Math.floor(seg.length / 2)]!;
    const mad = seg.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[Math.floor(seg.length / 2)]! * 1.4826 || Math.abs(med) * 0.05 || 1;
    lo.push([s.points[i]![0], med - k * mad]); hi.push([s.points[i]![0], med + k * mad]);
  }
  const series = (base.series as unknown[]) ?? [];
  series.unshift(
    { name: 'baseline lo', type: 'line', data: lo, showSymbol: false, lineStyle: { width: 0 }, stack: 'band', silent: true, tooltip: { show: false } },
    { name: `baseline ±${k}σ (computed)`, type: 'line', data: hi.map((p, i) => [p[0], p[1] - (lo[i]?.[1] ?? 0)]), showSymbol: false, lineStyle: { width: 0 }, areaStyle: { color: t.ink4, opacity: 0.18 }, stack: 'band', silent: true, tooltip: { show: false } },
  );
  const verdict = str(o['verdict']);
  const last = s.points.at(-1)!;
  const flagged = verdict && verdict !== 'normal';
  (series[series.length - 1] as Record<string, unknown>)['markPoint'] = { symbol: 'circle', symbolSize: flagged ? 9 : 6, itemStyle: { color: flagged ? t.crit : t.series[0] }, label: { show: Boolean(verdict), position: 'top', color: flagged ? t.crit : t.ink3, fontFamily: t.mono, fontSize: 9, formatter: verdict || '' }, data: [{ coord: last }] };
  return { ...base, series, legend: { show: true, top: 0, right: 0, data: [`baseline ±${k}σ (computed)`, s.name], icon: 'roundRect', itemWidth: 10, itemHeight: 3, textStyle: { color: t.ink3, fontSize: 9.5 } }, grid: { left: 8, right: 8, top: 22, bottom: 4, containLabel: true } };
}

// ── Graph ───────────────────────────────────────────────────────────────────

export function serviceMapOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const nodes = arr(o['nodes']).filter(isObj).map((n) => ({ id: str(n['id'] ?? n['name']), name: str(n['label'] ?? n['name'] ?? n['id']), state: normState(n['state'] ?? n['status'] ?? 'unknown'), kind: str(n['kind'], 'service'), focus: n['focus'] === true }));
  const edges = arr(o['edges'] ?? o['links']).filter(isObj).map((e) => ({ source: str(e['from'] ?? e['source']), target: str(e['to'] ?? e['target']), kind: str(e['kind'] ?? e['relation'], 'depends_on'), label: str(e['label']) }));
  const ids = new Set(nodes.map((n) => n.id));
  return {
    ...baseOption(t),
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { dataType: string; data: { name?: string; state?: string; kind?: string; source?: string; target?: string } }) => p.dataType === 'edge' ? `${p.data.source} → ${p.data.target}${p.data.kind ? ` · ${p.data.kind}` : ''}` : `${p.data.name} · ${p.data.state}${p.data.kind ? ` · ${p.data.kind}` : ''}` },
    series: [{
      type: 'graph', layout: 'force', roam: 'move', draggable: true, force: { repulsion: 260, edgeLength: 90, gravity: 0.08 },
      label: { show: true, position: 'bottom', color: t.ink2, fontFamily: t.mono, fontSize: 9.5 },
      edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 6, lineStyle: { color: t.line2, width: 1.2, curveness: 0.05 },
      emphasis: { focus: 'adjacency', lineStyle: { width: 2.5, color: t.ev } },
      data: nodes.map((n) => ({ id: n.id, name: n.name, state: n.state, kind: n.kind, symbol: n.kind === 'host' || n.kind === 'node' ? 'roundRect' : n.kind === 'db' || n.kind === 'data' ? 'diamond' : 'circle', symbolSize: n.focus ? 30 : 20, itemStyle: { color: t.bg3, borderColor: stateColor(t, n.state), borderWidth: n.state === 'up' ? 1.5 : 2.5 } })),
      links: edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ source: e.source, target: e.target, kind: e.kind, ...(e.label ? { label: { show: true, formatter: e.label, color: t.ink4, fontSize: 8.5 } } : {}), lineStyle: e.kind === 'declared' || e.kind === 'depends_on' ? { color: t.ev, width: 1.6 } : e.kind === 'co_occurs' || e.kind === 'correlated' ? { color: t.ink4, type: 'dotted' } : {} })),
    }],
  };
}

/** A sparkline with no chrome at all. */
export function sparkOption(points: number[], t: Tokens, color = t.series[0]!): EChartsOption {
  return {
    animation: false, backgroundColor: 'transparent',
    grid: { left: 1, right: 1, top: 2, bottom: 2 },
    xAxis: { type: 'category', show: false, data: points.map((_, i) => i) },
    yAxis: { type: 'value', show: false, scale: true },
    tooltip: { show: false },
    series: [{ type: 'line', data: points, showSymbol: false, lineStyle: { width: 1.4, color }, areaStyle: { color, opacity: 0.12 }, markPoint: points.length ? { symbol: 'circle', symbolSize: 4, itemStyle: { color }, label: { show: false }, data: [{ coord: [points.length - 1, points.at(-1)] }] } : undefined }],
  };
}

// ── The 2026-09-04 set: scatter, pie, radar, sankey, boxplot, calendar, gauge, stat ──

export interface XYPoint { x: number; y: number; label?: string | undefined; group?: string | undefined; size?: number | undefined }
/** `{ points: [{x,y,label?,group?,size?}] | [x,y,label?][] , xLabel?, yLabel?, trend? }` */
export function normaliseXY(o: Record<string, unknown>): XYPoint[] {
  const out: XYPoint[] = [];
  for (const r of arr(o['points'] ?? o['data'])) {
    if (Array.isArray(r)) { const x = num(r[0]), y = num(r[1]); if (x !== undefined && y !== undefined) out.push({ x, y, label: typeof r[2] === 'string' ? r[2] : undefined, group: typeof r[3] === 'string' ? r[3] : undefined }); }
    else if (isObj(r)) { const x = num(r['x']), y = num(r['y']); if (x !== undefined && y !== undefined) out.push({ x, y, label: typeof r['label'] === 'string' ? r['label'] : typeof r['name'] === 'string' ? r['name'] : typeof r['host'] === 'string' ? r['host'] : undefined, group: typeof r['group'] === 'string' ? r['group'] : typeof r['series'] === 'string' ? r['series'] : undefined, size: num(r['size']) }); }
  }
  return out;
}

/** XY correlation: one dot per host or sample, grouped by colour, an optional COMPUTED fit line. */
export function scatterOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const pts = normaliseXY(o);
  const xLabel = str(o['xLabel'] ?? o['x']), yLabel = str(o['yLabel'] ?? o['y']);
  const xUnit = str(o['xUnit']), yUnit = str(o['yUnit']);
  const groups = [...new Set(pts.map((p) => p.group ?? ''))];
  const sizes = pts.map((p) => p.size).filter((s): s is number => s !== undefined);
  const sMax = sizes.length ? Math.max(...sizes) : 0;
  const series: Array<Record<string, unknown>> = groups.map((g, gi) => ({
    name: g || 'points', type: 'scatter',
    symbolSize: (v: unknown[]) => { const s = typeof v[3] === 'number' ? v[3] : undefined; return s !== undefined && sMax > 0 ? 6 + 18 * Math.sqrt(s / sMax) : 8; },
    itemStyle: { color: t.series[gi % t.series.length], opacity: 0.85 },
    emphasis: { focus: 'series', itemStyle: { borderColor: t.ink, borderWidth: 1 } },
    data: pts.filter((p) => (p.group ?? '') === g).map((p) => [p.x, p.y, p.label ?? '', p.size ?? null]),
  }));
  const fit = o['trend'] !== false && pts.length >= 5 ? linearFit(pts.map((p) => [p.x, p.y])) : undefined;
  if (fit) {
    const xs = pts.map((p) => p.x); const x0 = Math.min(...xs), x1 = Math.max(...xs);
    series.push({ name: `fit r²=${fit.r2.toFixed(2)} (computed)`, type: 'line', showSymbol: false, silent: true, lineStyle: { color: t.ink4, width: 1, type: 'dashed' }, data: [[x0, fit.slope * x0 + fit.intercept], [x1, fit.slope * x1 + fit.intercept]] });
  }
  return {
    ...baseOption(t),
    legend: groups.length > 1 || fit ? { show: true, top: 0, right: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: t.ink3, fontSize: 9.5 }, type: 'scroll' } : { show: false },
    grid: { left: 8, right: 12, top: groups.length > 1 || fit ? 22 : 10, bottom: 4, containLabel: true },
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { seriesName: string; value: unknown[] }) => `${typeof p.value[2] === 'string' && p.value[2] ? p.value[2] : p.seriesName}<br/>${xLabel || 'x'}: ${fmtNum(Number(p.value[0]), xUnit)} · ${yLabel || 'y'}: ${fmtNum(Number(p.value[1]), yUnit)}` },
    xAxis: { ...valAxisOpt(t, xUnit), name: xLabel, nameLocation: 'middle', nameGap: 18, nameTextStyle: { color: t.ink4, fontSize: 9 }, scale: true },
    yAxis: { ...valAxisOpt(t, yUnit), name: yLabel, nameTextStyle: { color: t.ink4, fontSize: 9, align: 'left' }, scale: true },
    dataZoom: [{ type: 'inside', zoomOnMouseWheel: 'shift', moveOnMouseMove: false }],
    series,
  };
}

/** Share of a whole: the donut builder with labels on, for the `pie` widget. */
export function pieOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const base = donutOption(o, t);
  const items = normaliseItems(o, 'slices');
  const ring = o['ring'] !== false;
  const series = (base['series'] as Array<Record<string, unknown>>)[0]!;
  return {
    ...base,
    graphic: ring ? base['graphic'] : [],
    series: [{ ...series, radius: ring ? ['52%', '78%'] : [0, '78%'], label: { show: items.length <= 8, position: 'outside', color: t.ink3, fontSize: 9, formatter: (p: { name: string; percent: number }) => `${p.name} ${p.percent}%` }, labelLine: { length: 6, length2: 4, lineStyle: { color: t.line2 } } }],
  };
}

export interface RadarSpec { axes: Array<{ name: string; max?: number | undefined }>; rows: Array<{ name: string; values: number[] }> }
/** `{ axes: [{name,max?}|string], rows: [{name, values: number[]}] }` — every row is one profile over the same axes. */
export function normaliseRadar(o: Record<string, unknown>): RadarSpec {
  const axes = arr(o['axes'] ?? o['dimensions']).map((a) => (isObj(a) ? { name: str(a['name'] ?? a['label'], '?'), max: num(a['max']) } : { name: str(a, '?'), max: undefined }));
  const rows = arr(o['rows'] ?? o['series'] ?? o['items']).filter(isObj).map((r) => ({ name: str(r['name'] ?? r['label'] ?? r['host'], '?'), values: arr(r['values'] ?? r['data']).map((v) => num(v) ?? 0) }));
  return { axes, rows };
}

/** Several dimensions of one thing, several things compared: host health profiles, SLO scorecards. */
export function radarOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const { axes, rows } = normaliseRadar(o);
  const unit = str(o['unit']);
  const globalMax = num(o['max']);
  const indicator = axes.map((a, i) => ({ name: a.name, max: a.max ?? globalMax ?? Math.max(1, ...rows.map((r) => r.values[i] ?? 0)) * 1.1 }));
  return {
    ...baseOption(t),
    legend: rows.length > 1 ? { show: true, bottom: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 3, textStyle: { color: t.ink3, fontSize: 9.5 }, type: 'scroll' } : { show: false },
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { name: string; value: number[] }) => `<b>${p.name}</b><br/>${axes.map((a, i) => `${a.name}: ${fmtNum(p.value[i] ?? Number.NaN, unit)}`).join('<br/>')}` },
    radar: { indicator: indicator.length ? indicator : [{ name: '—', max: 1 }], shape: 'polygon', radius: '68%', center: ['50%', rows.length > 1 ? '46%' : '52%'], axisName: { color: t.ink3, fontSize: 9.5, fontFamily: t.mono }, splitLine: { lineStyle: { color: t.line } }, splitArea: { areaStyle: { color: [t.bg2, t.bg3] } }, axisLine: { lineStyle: { color: t.line2 } } },
    series: [{ type: 'radar', symbolSize: 4, lineStyle: { width: 1.5 }, areaStyle: { opacity: 0.12 }, emphasis: { focus: 'series', areaStyle: { opacity: 0.3 } }, data: rows.map((r, i) => ({ name: r.name, value: r.values, itemStyle: { color: t.series[i % t.series.length] } })) }],
  };
}

export interface FlowSpec { nodes: string[]; links: Array<{ source: string; target: string; value: number }> }
/** `{ links: [{from,to,value}] | [from,to,value][], nodes?: string[] }`. Self-links and cycles are dropped: a sankey cannot draw them. */
export function normaliseFlow(o: Record<string, unknown>): FlowSpec {
  const links: FlowSpec['links'] = [];
  for (const r of arr(o['links'] ?? o['flows'] ?? o['edges'] ?? o['data'])) {
    let s: string | undefined, d: string | undefined, v: number | undefined;
    if (Array.isArray(r)) { s = typeof r[0] === 'string' ? r[0] : undefined; d = typeof r[1] === 'string' ? r[1] : undefined; v = num(r[2]); }
    else if (isObj(r)) { s = typeof (r['from'] ?? r['source']) === 'string' ? String(r['from'] ?? r['source']) : undefined; d = typeof (r['to'] ?? r['target']) === 'string' ? String(r['to'] ?? r['target']) : undefined; v = num(r['value'] ?? r['count'] ?? r['bytes']); }
    if (s && d && s !== d && v !== undefined && v > 0) links.push({ source: s, target: d, value: v });
  }
  const declared = arr(o['nodes']).map((n) => (isObj(n) ? str(n['name'] ?? n['id']) : str(n))).filter(Boolean);
  const nodes = [...new Set([...declared, ...links.flatMap((l) => [l.source, l.target])])];
  // Break cycles: keep a link only if it does not close a path back to its source.
  const adj = new Map<string, Set<string>>();
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => { if (from === to) return true; if (seen.has(from)) return false; seen.add(from); for (const n of adj.get(from) ?? []) if (reaches(n, to, seen)) return true; return false; };
  const kept: FlowSpec['links'] = [];
  for (const l of links) { if (reaches(l.target, l.source)) continue; kept.push(l); if (!adj.has(l.source)) adj.set(l.source, new Set()); adj.get(l.source)!.add(l.target); }
  return { nodes: nodes.filter((n) => kept.some((l) => l.source === n || l.target === n)), links: kept };
}

/** Where things flow and how much: traffic between zones, alerts source → severity → host, requests through tiers. */
export function sankeyOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const { nodes, links } = normaliseFlow(o);
  const unit = str(o['unit']);
  return {
    ...baseOption(t),
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { dataType: string; name: string; value: number; data: { source?: string; target?: string } }) => p.dataType === 'edge' ? `${p.data.source} → ${p.data.target}: ${fmtNum(p.value, unit)}` : `${p.name}: ${fmtNum(p.value, unit)}` },
    series: [{
      type: 'sankey', left: 8, right: 60, top: 8, bottom: 8, nodeWidth: 10, nodeGap: 10, draggable: false,
      orient: o['orientation'] === 'vertical' ? 'vertical' : 'horizontal',
      label: { color: t.ink2, fontSize: 9.5, fontFamily: t.mono },
      lineStyle: { color: 'gradient', opacity: 0.35, curveness: 0.5 },
      emphasis: { focus: 'adjacency' },
      itemStyle: { borderWidth: 0 },
      data: nodes.map((n, i) => ({ name: n, itemStyle: { color: t.series[i % t.series.length] } })),
      links,
    }],
  };
}

export interface BoxRow { name: string; box: [number, number, number, number, number]; outliers: number[] }
/** `{ rows: [{ name, values: number[] } | { name, min,p25,median,p75,max }] }` — five numbers, or samples the builder summarises. */
export function normaliseBoxes(o: Record<string, unknown>): BoxRow[] {
  const out: BoxRow[] = [];
  const q = (sorted: number[], p: number): number => { if (!sorted.length) return 0; const i = (sorted.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo); };
  for (const r of arr(o['rows'] ?? o['items'] ?? o['series']).filter(isObj)) {
    const name = str(r['name'] ?? r['label'] ?? r['host'], '?');
    const vals = arr(r['values'] ?? r['samples']).map((v) => num(v)).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    if (vals.length >= 2) {
      const p25 = q(vals, 0.25), p75 = q(vals, 0.75), iqr = p75 - p25;
      const lo = p25 - 1.5 * iqr, hi = p75 + 1.5 * iqr;
      const inside = vals.filter((v) => v >= lo && v <= hi);
      out.push({ name, box: [inside[0] ?? vals[0]!, p25, q(vals, 0.5), p75, inside.at(-1) ?? vals.at(-1)!], outliers: vals.filter((v) => v < lo || v > hi) });
      continue;
    }
    const five = ['min', 'p25', 'median', 'p75', 'max'].map((k) => num(r[k] ?? (k === 'median' ? r['p50'] : undefined)));
    if (five.every((v) => v !== undefined)) out.push({ name, box: five as BoxRow['box'], outliers: [] });
  }
  return out;
}

/** Distribution per group side by side — latency per service, run time per job — with outliers as dots. */
export function boxplotOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const rows = normaliseBoxes(o);
  const unit = str(o['unit']);
  const horizontal = o['orientation'] === 'horizontal' || rows.length > 6;
  const cat = { ...catAxisOpt(t, rows.map((r) => r.name)), ...(horizontal ? { inverse: true } : {}) };
  const val = valAxisOpt(t, unit);
  const outliers = rows.flatMap((r, i) => r.outliers.map((v) => (horizontal ? [v, i] : [i, v])));
  return {
    ...baseOption(t),
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { seriesType: string; name: string; value: number[] }) => p.seriesType === 'boxplot' ? `<b>${p.name}</b><br/>min ${fmtNum(p.value[1]!, unit)} · p25 ${fmtNum(p.value[2]!, unit)} · <b>median ${fmtNum(p.value[3]!, unit)}</b> · p75 ${fmtNum(p.value[4]!, unit)} · max ${fmtNum(p.value[5]!, unit)}` : `outlier ${fmtNum(horizontal ? p.value[0]! : p.value[1]!, unit)}` },
    xAxis: horizontal ? val : cat, yAxis: horizontal ? cat : val,
    series: [
      { type: 'boxplot', data: rows.map((r) => r.box), itemStyle: { color: t.bg3, borderColor: t.series[0], borderWidth: 1.5 }, emphasis: { itemStyle: { borderColor: t.ink } }, boxWidth: [8, 28] },
      ...(outliers.length ? [{ type: 'scatter', data: outliers, symbolSize: 5, itemStyle: { color: t.warn, opacity: 0.8 } }] : []),
    ],
  };
}

/** `{ days: [[YYYY-MM-DD, value]] | [{date,value}], from?, to?, max?, unit? }` — one value per day. */
export function normaliseDays(o: Record<string, unknown>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const day = (v: unknown): string | undefined => { if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10); const n = num(v); if (n === undefined) return undefined; const d = new Date(n < 1e11 ? n * 1000 : n); return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10); };
  for (const r of arr(o['days'] ?? o['data'] ?? o['points'])) {
    if (Array.isArray(r)) { const d = day(r[0]), v = num(r[1]); if (d && v !== undefined) out.push([d, v]); }
    else if (isObj(r)) { const d = day(r['date'] ?? r['day'] ?? r['at'] ?? r['t']), v = num(r['value'] ?? r['count'] ?? r['v']); if (d && v !== undefined) out.push([d, v]); }
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/** A value per day over weeks or months: incidents per day, backup outcome, patch compliance, deploy count. */
export function calendarOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const days = normaliseDays(o);
  const unit = str(o['unit']);
  const from = str(o['from']) || days[0]?.[0] || new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const to = str(o['to']) || days.at(-1)?.[0] || new Date().toISOString().slice(0, 10);
  const max = num(o['max']) ?? Math.max(1, ...days.map((d) => d[1]));
  const good = o['goodIsHigh'] === true;
  return {
    ...baseOption(t),
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { value: [string, number] }) => `${p.value[0]}: ${fmtNum(p.value[1], unit)}` },
    visualMap: { show: false, min: 0, max, inRange: { color: good ? [t.bg3, t.ok] : [t.bg3, t.info, t.warn, t.crit] } },
    calendar: { left: 34, right: 8, top: 22, bottom: 4, range: [from, to], cellSize: ['auto', 'auto'], splitLine: { show: false }, itemStyle: { color: t.bg2, borderColor: t.bg2, borderWidth: 2 }, dayLabel: { color: t.ink4, fontSize: 8.5, nameMap: ['S', 'M', 'T', 'W', 'T', 'F', 'S'], firstDay: 1 }, monthLabel: { color: t.ink3, fontSize: 9 }, yearLabel: { show: false } },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: days, itemStyle: { borderRadius: 2 }, emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } } }],
  };
}

/** How far one number sits from its thresholds: a modern arc gauge with bands, needle-free, the value in the centre. */
export function gaugeOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const min = num(o['min']) ?? 0, max = num(o['max']) ?? 100;
  const v = Math.max(min, Math.min(max, num(o['value']) ?? min));
  const unit = str(o['unit'], max === 100 && min === 0 && o['unit'] === undefined ? '%' : '');
  const warn = num(o['warn']), crit = num(o['crit']);
  const inverted = o['lowIsBad'] === true;
  const span = Math.max(1e-9, max - min);
  const at = (x: number): number => Math.max(0, Math.min(1, (x - min) / span));
  const bands: Array<[number, string]> = inverted
    ? [...(crit !== undefined ? [[at(crit), t.crit] as [number, string]] : []), ...(warn !== undefined ? [[at(warn), t.warn] as [number, string]] : []), [1, t.ok]]
    : [...(warn !== undefined ? [[at(warn), t.ok] as [number, string]] : []), ...(crit !== undefined ? [[at(crit), t.warn] as [number, string]] : []), [1, crit !== undefined || warn !== undefined ? t.crit : t.ok]];
  const color = inverted
    ? (crit !== undefined && v <= crit ? t.crit : warn !== undefined && v <= warn ? t.warn : t.ok)
    : (crit !== undefined && v >= crit ? t.crit : warn !== undefined && v >= warn ? t.warn : t.ok);
  return {
    ...baseOption(t),
    tooltip: { show: false },
    series: [{
      type: 'gauge', startAngle: 210, endAngle: -30, min, max, center: ['50%', '62%'], radius: '95%',
      progress: { show: true, width: 12, roundCap: true, itemStyle: { color } },
      axisLine: { roundCap: true, lineStyle: { width: 12, color: bands } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, pointer: { show: false },
      title: { show: Boolean(o['sub']), offsetCenter: [0, '38%'], color: t.ink4, fontSize: 9.5 },
      detail: { valueAnimation: false, offsetCenter: [0, '-4%'], color, fontSize: 20, fontFamily: t.mono, fontWeight: 600, formatter: (x: number) => fmtNum(x, unit) },
      data: [{ value: v, name: str(o['sub']) }],
    }],
    graphic: [
      { type: 'text', left: '8%', bottom: 2, style: { text: fmtNum(min, unit), fill: t.ink4, font: `9px ${t.mono}` } },
      { type: 'text', right: '8%', bottom: 2, style: { text: fmtNum(max, unit), fill: t.ink4, font: `9px ${t.mono}`, textAlign: 'right' } },
    ],
  };
}

export interface GanttRow { name: string; start: number; end: number; status: StateName | 'running' | 'pending'; group?: string | undefined; depth: number; label?: string | undefined }
const toMs = (v: unknown): number | undefined => { if (typeof v === 'string') { const t = Date.parse(v); if (!Number.isNaN(t)) return t; } const n = num(v); if (n === undefined) return undefined; return n < 1e11 ? n * 1000 : n; };
/** `{ rows: [{ name, start, end?|duration?, status?, group?, depth?, label? }] }` — spans on a shared time axis, in the order given. */
export function normaliseGantt(o: Record<string, unknown>): GanttRow[] {
  const out: GanttRow[] = [];
  for (const r of arr(o['rows'] ?? o['spans'] ?? o['items']).filter(isObj)) {
    const start = toMs(r['start'] ?? r['from'] ?? r['at']);
    if (start === undefined) continue;
    const dur = num(r['duration'] ?? r['durationMs']);
    let end = toMs(r['end'] ?? r['to']);
    if (end === undefined && dur !== undefined) end = start + (r['durationMs'] !== undefined ? dur : dur * 1000);
    if (end === undefined) end = r['status'] === 'running' ? Date.now() : start;
    const st = String(r['status'] ?? r['state'] ?? 'unknown').toLowerCase();
    const status: GanttRow['status'] = st === 'running' || st === 'in_progress' ? 'running' : st === 'pending' || st === 'queued' || st === 'waiting' ? 'pending' : normState(st);
    out.push({ name: str(r['name'] ?? r['label'] ?? r['title'], '?'), start, end: Math.max(start, end), status, group: typeof r['group'] === 'string' ? r['group'] : undefined, depth: Math.max(0, Math.min(6, num(r['depth']) ?? 0)), label: typeof r['detail'] === 'string' ? r['detail'] : undefined });
  }
  return out;
}

/** Spans on one time axis: trace waterfall, job runs, deployment steps, an incident's timeline. */
export function ganttOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const rows = normaliseGantt(o);
  const min = rows.length ? Math.min(...rows.map((r) => r.start)) : 0, max = rows.length ? Math.max(...rows.map((r) => r.end), min + 1) : 1;
  const col = (s: GanttRow['status']): string => (s === 'running' ? t.info : s === 'pending' ? t.ink4 : stateColor(t, s));
  const data = rows.map((r, y) => ({ name: r.name, value: [y, r.start, r.end, r.status, r.label ?? ''], itemStyle: { color: col(r.status), opacity: r.status === 'pending' ? 0.45 : 0.9 } }));
  const span = max - min;
  const dur = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 3_600_000).toFixed(1)}h`);
  return {
    ...baseOption(t),
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { value: [number, number, number, string, string] }) => `${rows[p.value[0]]?.name ?? ''} · ${p.value[3]} · ${dur(p.value[2] - p.value[1])}${p.value[4] ? `<br/>${p.value[4]}` : ''}<br/>${fmtTime(p.value[1], span)} → ${fmtTime(p.value[2], span)}` },
    grid: { left: 8, right: 12, top: 4, bottom: 4, containLabel: true },
    xAxis: { ...timeAxisOpt(t, span), min, max: max + span * 0.02 },
    yAxis: { type: 'category', data: rows.map((r) => `${'\u2007\u2007'.repeat(r.depth)}${r.name}`), inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.ink3, fontFamily: t.mono, fontSize: 9, width: 140, overflow: 'truncate' } },
    series: [{
      type: 'custom',
      renderItem: (params: { coordSys: { x: number; y: number; width: number; height: number } }, api: { value: (i: number) => number; coord: (v: [number, number]) => [number, number]; size: (v: [number, number]) => [number, number]; style: () => Record<string, unknown> }) => {
        const y = api.value(0); const start = api.coord([api.value(1), y]); const end = api.coord([api.value(2), y]); const h = api.size([0, 1])[1] * 0.6;
        const x0 = Math.max(params.coordSys.x, start[0]); const x1 = Math.min(params.coordSys.x + params.coordSys.width, Math.max(end[0], start[0] + 2));
        if (x1 <= x0) return null;
        return { type: 'rect', shape: { x: x0, y: start[1] - h / 2, width: x1 - x0, height: h, r: 2 }, style: api.style() };
      },
      encode: { x: [1, 2], y: 0 }, data,
    }],
  };
}

/** Stages, each a subset of the last: alerts → incidents, requests → conversions. Widths are proportional; the drop between stages is the story. */
export function funnelOption(o: Record<string, unknown>, t: Tokens): EChartsOption {
  const items = normaliseItems(o, 'stages');
  const unit = str(o['unit']);
  const first = items[0]?.value ?? 0;
  return {
    ...baseOption(t),
    tooltip: { ...(baseOption(t).tooltip as object), trigger: 'item', formatter: (p: { name: string; value: number; dataIndex: number }) => { const prev = items[p.dataIndex - 1]?.value; return `${p.name}: ${fmtNum(p.value, unit)}${first ? ` (${Math.round((p.value / first) * 100)}% of first)` : ''}${prev ? `<br/>${Math.round((1 - p.value / prev) * 100)}% dropped from the stage before` : ''}`; } },
    series: [{
      type: 'funnel', left: 8, right: 8, top: 6, bottom: 6, sort: 'none', gap: 3, minSize: '8%', maxSize: '100%',
      label: { show: true, position: 'inside', color: t.ink, fontSize: 10, fontFamily: t.mono, formatter: (p: { name: string; value: number }) => `${p.name}  ${fmtNum(p.value, unit)}` },
      itemStyle: { borderColor: t.bg2, borderWidth: 1 },
      emphasis: { label: { fontSize: 11 } },
      data: items.map((i, k) => ({ name: i.label, value: i.value, itemStyle: { color: cssColor(t, i.color, t.series[k % t.series.length]!), opacity: 0.9 - k * 0.08 } })),
    }],
  };
}
