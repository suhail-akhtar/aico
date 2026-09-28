/**
 * ```plot — functions, derivatives, parametric and polar curves, points, and
 * the shaded area of an integral, on real axes with hover and zoom.
 *
 * Every curve is evaluated here (mathjs), so the model states the function and
 * the reader sees it drawn correctly — no hand-computed points to get wrong.
 * An integral's value is computed (Simpson's rule) and labelled as computed.
 *
 * @module shared/kit/math/Plot
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { chartTheme } from '../../ui/chart-theme';
import { parsePlotSpec, samplePlot } from './core';

let echartsPromise: Promise<typeof import('echarts')> | null = null;
const loadECharts = (): Promise<typeof import('echarts')> => (echartsPromise ??= import('echarts'));

export function Plot({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => {
    if (streaming) return null;
    try { const spec = parsePlotSpec(source); return { spec, ...samplePlot(spec) }; }
    catch (err) { return { error: (err as Error).message }; }
  }, [source, streaming]);

  useEffect(() => {
    if (!parsed || 'error' in parsed) return;
    let instance: import('echarts').ECharts | undefined;
    let disposed = false;
    void loadECharts().then((echarts) => {
      if (disposed || !host.current) return;
      const dark = document.documentElement.dataset.theme === 'dark';
      const name = dark ? 'aico-dark' : 'aico-light';
      echarts.registerTheme(name, chartTheme(dark));
      instance = echarts.init(host.current, name, { renderer: 'svg' });
      const { spec, series, area } = parsed;
      const equalAxes = series.some(s => s.kind === 'polar' || s.kind === 'parametric');
      instance.setOption({
        animation: false,
        grid: { left: 48, right: 20, top: spec.title ? 40 : 24, bottom: 44, containLabel: false },
        title: spec.title ? { text: spec.title, left: 8, top: 0, textStyle: { fontSize: 13, fontWeight: 600 } } : undefined,
        tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toPrecision(5) : String(v)) },
        legend: { bottom: 0, type: 'scroll' },
        xAxis: { type: 'value', name: spec.xLabel ?? 'x', nameLocation: 'end', min: equalAxes ? undefined : spec.x[0], max: equalAxes ? undefined : spec.x[1], axisLine: { onZero: true }, splitLine: { show: true } },
        yAxis: { type: 'value', name: spec.yLabel ?? 'y', nameGap: 8, nameTextStyle: { align: 'right' }, min: spec.y?.[0], max: spec.y?.[1], axisLine: { onZero: true }, splitLine: { show: true } },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }, { type: 'inside', yAxisIndex: 0, filterMode: 'none' }],
        series: [
          ...series.map(s => ({
            type: 'line', name: s.name, data: s.data, showSymbol: false, smooth: false, connectNulls: false,
            // The chart theme fills lines; a function plot must not (it reads as an integral).
            areaStyle: { opacity: 0 },
            lineStyle: { width: 2, type: s.dashed || s.kind === 'derivative' ? 'dashed' : 'solid', ...(s.color ? { color: s.color } : {}) },
            ...(s.color ? { itemStyle: { color: s.color } } : {}),
          })),
          ...(area ? [{
            type: 'line', name: `∫ = ${area.value.toPrecision(6)} (computed)`, data: area.data, showSymbol: false,
            lineStyle: { width: 0 }, areaStyle: { opacity: 0.22 }, z: 0,
          }] : []),
          ...(spec.points.length ? [{
            type: 'scatter', name: 'points', symbolSize: 8,
            data: spec.points.map(p => ({ value: [p.x, p.y], name: p.label })),
            label: { show: true, formatter: (d: { name?: string }) => d.name ?? '', position: 'top' },
          }] : []),
        ],
      });
    }).catch((err: unknown) => { if (!disposed) setError(String(err)); });
    const ro = new ResizeObserver(() => instance?.resize());
    if (host.current) ro.observe(host.current);
    return () => { disposed = true; ro.disconnect(); instance?.dispose(); };
  }, [parsed]);

  if (streaming) return <p className="p-2 text-[11px] text-aico-muted">Plot arriving…</p>;
  if (parsed && 'error' in parsed) throw new Error(parsed.error);
  if (error) throw new Error(error);
  return <div ref={host} className="h-[360px] w-full" />;
}
