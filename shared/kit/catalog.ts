/**
 * The kit's catalogue — plain data, no React, so the engine's WidgetSpec tool
 * can read it (with the option contracts) without pulling in a renderer.
 *
 * @module shared/kit/catalog
 */

export interface KitEntry {
  id: string;
  /** Component export name in widgets.tsx / charts.tsx. */
  component: string;
  name: string;
  category: string;
  description: string;
}

const RAW: Array<[string, string, string, string, string]> = [
  // The interactive set first: these are what a model should reach for.
  ['stat', 'StatPanel', 'Stat', 'Metrics', 'The modern KPI tile: value with unit, change vs previous (coloured by whether up is good), sparkline, warn/crit colouring; several items make a row.'],
  ['timeseries', 'TimeSeriesChart', 'Time series', 'Metrics', 'One or more series over time: hover values, legend, thresholds, baseline band, annotations; shift+wheel to zoom.'],
  ['barchart', 'BarsChart', 'Bar chart', 'Metrics', 'Categorical comparison, vertical or horizontal, with labels and hover.'],
  ['radial', 'GaugeChart', 'Gauge', 'Metrics', 'One value against min/max on an arc with warn/crit bands and the value in the centre.'],
  ['pie', 'PieChart', 'Pie / share', 'Metrics', 'Share of a whole with labels, hover and a centre total.'],
  ['heatmap', 'HeatmapChart', 'Heatmap', 'Metrics', 'Value density across rows × columns with hover values.'],
  ['histogram', 'HistogramChart', 'Histogram', 'Metrics', 'A distribution with p50/p95/p99 markers and hover counts.'],
  ['topn', 'TopN', 'Top N', 'Metrics', 'The N largest values, ranked as horizontal bars.'],
  ['bargauge', 'BarGauge', 'Bar gauge', 'Metrics', 'Named bars against a max, coloured by threshold.'],
  ['sparkrow', 'SparkRow', 'Spark row', 'Metrics', 'A compact row of stats with sparklines, for a dashboard header.'],
  ['scatter', 'ScatterChart', 'XY scatter', 'Analysis', 'x against y, grouped by colour, sized by a third value, with a computed linear fit labelled so.'],
  ['forecast', 'ForecastChart', 'Trend + forecast', 'Analysis', 'A series with its computed linear projection to a threshold; refuses a poor fit.'],
  ['anomaly', 'AnomalyChart', 'Anomaly', 'Analysis', 'A series against its own rolling baseline band (computed).'],
  ['boxplot', 'BoxplotChart', 'Boxplot', 'Analysis', 'Distributions per group side by side, from samples or five-number summaries.'],
  ['change', 'ChangeRows', 'Change table', 'Analysis', 'Each row now against before, ranked by the size of the change.'],
  ['gantt', 'GanttChart', 'Gantt / spans', 'Analysis', 'Spans on one time axis with nesting and status: a plan, job runs, a trace waterfall, a timeline.'],
  ['radar', 'RadarChart', 'Radar profile', 'Analysis', 'Several dimensions of several things on one polygon — a skills profile, a before/after, a comparison.'],
  ['sankey', 'SankeyChart', 'Flow (sankey)', 'Analysis', 'How much flows from where to where.'],
  ['treemap', 'TreemapChart', 'Treemap', 'Data', 'Size by hierarchy (folder → file, budget → line item).'],
  ['calendar', 'CalendarHeatmap', 'Calendar heatmap', 'Data', 'One cell per day over weeks or months, coloured by value.'],
  ['funnel', 'FunnelChart', 'Funnel', 'Analysis', 'Stages each a subset of the last: visitors → sign-ups → paid.'],
  ['pipeline', 'PipelineView', 'Pipeline', 'Process', 'Stages left to right with status and duration — a CI build, an ETL DAG, a release.'],
  ['scorecard', 'Scorecard', 'Scorecard', 'Process', 'Checks as pass / fail / partial / n-a with a computed score, failing first.'],
  ['plandiff', 'PlanDiff', 'Plan diff', 'Process', 'Add / change / replace / destroy counts and the items under each (a Terraform plan, a migration).'],
  ['statetimeline', 'StateTimeline', 'State timeline', 'Health', 'State per row over time as coloured segments.'],
  ['statushistory', 'StatusHistory', 'Status history', 'Health', 'Periodic state cells per row, coloured by state.'],
  ['slo', 'SloPanel', 'SLO / budget', 'Health', 'Achievement against a target: budget used, burn rate, time to exhaustion — computed.'],
  ['hostmap', 'HostMap', 'Tile map', 'Health', 'One tile per item coloured by a metric, grouped, sized to fit hundreds.'],
  ['expiry', 'ExpiryList', 'Expiry list', 'Health', 'Things that expire (certificates, licences, deadlines) soonest first, coloured by days left.'],
  ['servicemap', 'ServiceMap', 'Service map', 'Topology', 'Services and stores as a draggable, zoomable graph.'],
  ['netmap', 'NetworkMap', 'Network diagram', 'Topology', 'Devices with icons, names and zones, joined by labelled links coloured by state.'],
  ['incidents', 'IncidentList', 'Incident list', 'Lists', 'A problem list with priority, status, owner and age.'],
  ['gate', 'GateQueue', 'Approval queue', 'Lists', 'What is waiting for a human, with tier and time left.'],
  ['oncall', 'OncallCard', 'On-call', 'Lists', 'Who is on duty now and next, per schedule.'],
  ['doc', 'DocPanel', 'Document panel', 'Text', 'Markdown prose: headings, lists, links, code — the written half of a dashboard.'],
  ['actions', 'ActionRow', 'Action buttons', 'Text', 'Buttons that put a prompt in the chat box (or send it) or open a page.'],
  // The original set, kept so older replies still render.
  ['kpi', 'StatTile', 'Stat tile (classic)', 'Metrics', 'Single figure with delta and inline sparkline. Prefer stat.'],
  ['line', 'TimeSeries', 'Line (classic)', 'Metrics', 'A series over time. Prefer timeseries.'],
  ['gauge', 'RadialGauge', 'Gauge (classic)', 'Metrics', 'Percentage against a threshold arc. Prefer radial.'],
  ['bars', 'BarChart', 'Bars (classic)', 'Metrics', 'Categorical comparison. Prefer barchart.'],
  ['hist', 'LatencyHistogram', 'Histogram (classic)', 'Metrics', 'Distribution with percentile markers. Prefer histogram.'],
  ['heat', 'Heatmap', 'Heat (classic)', 'Metrics', 'Value density grid. Prefer heatmap.'],
  ['bignum', 'HeadlineFigure', 'Headline figure', 'Metrics', 'One very large number.'],
  ['donut', 'SeverityDonut', 'Donut', 'Metrics', 'Proportional breakdown with a centre total. Prefer pie.'],
  ['alerts', 'AlertList', 'Alert list', 'Lists', 'A feed with severity and age.'],
  ['status', 'StatusGrid', 'Status grid', 'Health', 'One tile per item, coloured by health.'],
  ['uptime', 'AvailabilityStrip', 'Availability strip', 'Health', 'Rolling availability, one bar per interval.'],
  ['table', 'DataTable', 'Table', 'Data', 'A dense table.'],
  ['logs', 'LogStream', 'Log stream', 'Data', 'Tailed log or command output.'],
  ['progress', 'ProgressRows', 'Progress rows', 'Data', 'Named bars for quota, capacity or completion.'],
  ['topo', 'DependencyMap', 'Dependency map', 'Topology', 'A small dependency graph.'],
  ['timeline', 'ChangeTimeline', 'Timeline', 'Process', 'Events on one axis.'],
  ['runstat', 'AutomationRuns', 'Runs', 'Process', 'Recent runs with outcome and duration.'],
  ['text', 'NarrativePanel', 'Narrative', 'Text', 'Written analysis beside the numbers.'],
];

export const KIT_CATALOG: KitEntry[] = RAW.map(([id, component, name, category, description]) => ({ id, component, name, category, description }));

export function kitEntry(ref: string): KitEntry | undefined {
  const id = ref.split('@')[0]!.trim().toLowerCase();
  return KIT_CATALOG.find(e => e.id === id);
}
