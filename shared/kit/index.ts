/**
 * The widget kit: 54 dashboard widgets — KPI and stat tiles, gauges, time
 * series, heatmaps, histograms, forecasts, treemaps, sankey flows, radar
 * profiles, boxplots, calendars, gantt spans, pipelines, scorecards, network
 * and service maps, and more — drawn from a `widgets` fence in a chat reply.
 *
 * Ported from the AETNIC ops console, where they were built and hardened. The
 * catalogue and the option contracts (contracts.ts) are what the model reads
 * through the WidgetSpec tool; the components are what the reader sees.
 *
 * @module shared/kit
 */

export { KIT_CATALOG, kitEntry, type KitEntry } from './catalog';
export { kitComponent, type KitComponent } from './registry';
export { Cluster, parseCluster, type ClusterSpec } from './Cluster';
export { OPTION_CONTRACTS, contractLine, type OptionContract } from './contracts';
export type { WidgetProps } from './types';
