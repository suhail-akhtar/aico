/**
 * Widget id → component. Separate from index.ts so the grid can import it
 * without a cycle.
 *
 * @module shared/kit/registry
 */

import type React from 'react';
import type { WidgetProps } from './types';
import {
  StatTile, TimeSeries, RadialGauge, BarChart, SeverityDonut, StatusGrid,
  AvailabilityStrip, AlertList, DataTable, DependencyMap, LogStream,
  ChangeTimeline, LatencyHistogram, Heatmap, HeadlineFigure, ProgressRows,
  AutomationRuns, NarrativePanel, DocPanel, ActionRow,
} from './widgets';
import {
  TimeSeriesChart, StateTimeline, StatusHistory, HeatmapChart, HistogramChart, ForecastChart, AnomalyChart,
  BarsChart, TopN, TreemapChart, BarGauge, SparkRow, SloPanel, ServiceMap, IncidentList, GateQueue,
  StatPanel, GaugeChart, ScatterChart, PieChart, RadarChart, SankeyChart, BoxplotChart, CalendarHeatmap, HostMap, ChangeRows,
  PipelineView, PlanDiff, GanttChart, FunnelChart, OncallCard, ExpiryList, Scorecard,
} from './charts';
import { NetworkMap } from './netmap/NetworkMap';
import { KIT_CATALOG } from './catalog';

export type KitComponent = React.ComponentType<WidgetProps<never>>;

const COMPONENTS: Record<string, KitComponent> = {
  StatTile, TimeSeries, RadialGauge, BarChart, SeverityDonut, StatusGrid,
  AvailabilityStrip, AlertList, DataTable, DependencyMap, LogStream,
  ChangeTimeline, LatencyHistogram, Heatmap, HeadlineFigure, ProgressRows,
  AutomationRuns, NarrativePanel, NetworkMap,
  TimeSeriesChart, StateTimeline, StatusHistory, HeatmapChart, HistogramChart, ForecastChart, AnomalyChart,
  BarsChart, TopN, TreemapChart, BarGauge, SparkRow, SloPanel, ServiceMap, IncidentList, GateQueue,
  StatPanel, GaugeChart, ScatterChart, PieChart, RadarChart, SankeyChart, BoxplotChart, CalendarHeatmap, HostMap, ChangeRows,
  PipelineView, PlanDiff, GanttChart, FunnelChart, OncallCard, ExpiryList, Scorecard,
  DocPanel, ActionRow,
} as unknown as Record<string, KitComponent>;

/** The component for a widget id (`gauge`, `gauge@1.0.0`, `stat`…), or undefined. */
export function kitComponent(ref: string): KitComponent | undefined {
  const id = ref.split('@')[0]!.trim().toLowerCase();
  const entry = KIT_CATALOG.find(e => e.id === id);
  return entry ? COMPONENTS[entry.component] : undefined;
}

