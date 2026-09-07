'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { Point } from '@/lib/metrics';

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

/** One line per series, days on the x axis. Data arrives from the server component; nothing is fetched here. */
export function Chart({ series }: { series: Record<string, Point[]> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    const days = [...new Set(Object.values(series).flat().map(p => p.day))].sort();
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: 40, right: 16, top: 36, bottom: 28 },
      xAxis: { type: 'category', data: days.map(d => d.slice(5)) },
      yAxis: { type: 'value' },
      series: Object.entries(series).map(([name, points]) => ({
        name, type: 'line', smooth: true, showSymbol: false,
        data: days.map(d => points.find(p => p.day === d)?.value ?? 0),
      })),
    });
    const resize = () => chart.resize();
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); chart.dispose(); };
  }, [series]);
  return <div ref={ref} style={{ width: '100%', height: 320 }} role="img" aria-label="Line chart of each metric per day" />;
}
