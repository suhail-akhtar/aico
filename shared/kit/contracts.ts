/**
 * What each widget's `options` must actually look like.
 *
 * WHY THIS FILE EXISTS. An operator asked for a network diagram and got
 * `widget failed: s.map is not a function`. The orchestrator had emitted
 * `table@1.0.0` with `columns: [{key,label}], rows: [{…}]` — a perfectly
 * reasonable table shape, and not the one `DataTable` reads. It guessed,
 * because nothing told it. `console_capabilities` published each widget's name,
 * category and prose description and said nothing about its options, so the
 * only way for a model to fill a panel was to invent a shape and hope.
 *
 * That is a platform bug, not a model failure. The registry knows the contract;
 * it simply was not publishing it.
 *
 * SO: ONE LINE PER WIDGET, WRITTEN FOR A MODEL. Not JSON Schema — a schema for
 * nineteen widgets is thousands of tokens in a prompt that also has to carry an
 * estate. A dense signature plus a worked example is what an author actually
 * needs, and it fits.
 *
 * THE RULE FOR MAINTAINERS: if you change what a widget reads out of `options`,
 * change its line here in the same commit. A contract that drifts from the code
 * is worse than none, because it is believed.
 */


export interface OptionContract {
  /** Dense signature, e.g. `{ cols: string[], rows: (string|number)[][] }`. */
  signature: string;
  /** A minimal example that renders. Kept short — it goes into a prompt. */
  example: string;
  /** Anything a model gets wrong repeatedly, said explicitly. */
  note?: string;
  /** For a PERSON in the gallery: what the widget represents and when to reach for it. One or two sentences. */
  when?: string;
}

/**
 * Contracts by widget id.
 *
 * Every id here must exist in the CATALOG, and every CATALOG id must appear
 * here — asserted in the tests, because a widget with no contract is exactly
 * the case that produced the crash.
 */
export const OPTION_CONTRACTS: Record<string, OptionContract> = {
  kpi: {
    when: 'One number that matters, with a small delta and sparkline. Use for a headline figure on a wall; for thresholds and change-vs-previous use stat.',
    signature: '{ label: string, value: string, delta?: string, sub?: string, color?: string, spark?: number[] }',
    example: '{ "label": "Sessions", "value": "41", "delta": "▼ 173", "color": "var(--crit)" }',
    note: '`value` is a STRING — format it yourself, including units.',
  },
  line: {
    when: 'The simplest trend line, a snapshot. Use only when hover and zoom are not needed; timeseries is the interactive version.',
    signature: '{ series: number[], labels?: string[], unit?: string, band?: { lo: number, hi: number } }',
    example: '{ "series": [12, 18, 31, 29, 44], "unit": "ms" }',
  },
  gauge: {
    when: 'A percentage against a fixed arc. Use for a quick fullness read; radial adds bands and real min/max.',
    signature: '{ value: number, max?: number, unit?: string, sub?: string }',
    example: '{ "value": 99.7, "unit": "%", "sub": "2.1 GB free of 800 GB" }',
    note: '`value` is a NUMBER, not "99.7%".',
  },
  bars: {
    when: 'Compare a few categories. Use for a quick static comparison; barchart adds hover and labels.',
    signature: '{ items: { label: string, value: number, color?: string }[], unit?: string }',
    example: '{ "items": [{ "label": "app-01", "value": 94 }, { "label": "app-02", "value": 31 }] }',
  },
  hist: {
    when: 'How values are spread, with percentile marks. Use for latency or size distributions; histogram is the interactive version.',
    signature: '{ buckets: number[], labels?: string[], p50?: number, p95?: number, p99?: number, unit?: string }',
    example: '{ "buckets": [4, 19, 42, 30, 8], "p95": 210, "unit": "ms" }',
  },
  heat: {
    when: 'Density across hosts x time. Use when a grid of intensities tells the story; heatmap adds hover values.',
    signature: '{ rows: { label: string, cells: number[] }[], cols?: string[], max?: number }',
    example: '{ "rows": [{ "label": "web-01", "cells": [1, 4, 9, 2] }], "cols": ["00", "06", "12", "18"] }',
  },
  bignum: {
    when: 'One very large number for a wall display. Use when the number IS the panel; stat adds change and thresholds.',
    signature: '{ value: string, label?: string, sub?: string, color?: string }',
    example: '{ "label": "0.0.0.0 bindings", "value": "~50", "sub": "all published by Docker", "color": "var(--crit)" }',
    note: '`value` is a STRING so you can write "~50" or "1.2M".',
  },
  donut: {
    when: 'Proportions with a centre total. Use for a severity breakdown; pie adds labels and hover.',
    signature: '{ slices: { label: string, value: number, color?: string }[], total?: string, centerLabel?: string }',
    example: '{ "slices": [{ "label": "crit", "value": 2, "color": "var(--crit)" }, { "label": "warn", "value": 7 }] }',
  },
  alerts: {
    when: 'The live alert feed with severity and age. Use on any operations wall; it is the raw feed — incidents is the correlated list.',
    signature: '{ items: { title: string, host?: string, sev?: "c"|"w"|"ok"|"info", age?: string }[] }',
    example: '{ "items": [{ "title": "Volume E: 99.7%", "host": "hec-fs-01", "sev": "c", "age": "12m" }] }',
  },
  status: {
    when: 'One tile per host coloured by state. Use for "is everything up"; hostmap colours by a metric instead.',
    signature: '{ items: { label: string, state: "up"|"warn"|"down"|"unknown" }[] }',
    example: '{ "items": [{ "label": "web-01", "state": "up" }, { "label": "web-02", "state": "down" }] }',
  },
  uptime: {
    when: 'Availability per interval as a strip. Use for a service health history at a glance.',
    signature: '{ bars: number[], label?: string, sub?: string }',
    example: '{ "bars": [1, 1, 1, 0.6, 1, 1], "label": "30 days", "sub": "99.4%" }',
    note: 'Each bar is availability 0..1, not a percentage.',
  },
  table: {
    when: 'Any rows and columns. Click a header to sort; filter above 8 rows; numbers right-aligned, state words coloured, bar/pct columns drawn as bars. Use whenever the data is a list.',
    signature: '{ cols: string[], rows: (string|number)[][] }',
    example: '{ "cols": ["Service", "Port", "Bind"], "rows": [["Postgres", 5432, "0.0.0.0"], ["Redis", 6379, "0.0.0.0"]] }',
    // The exact mistake that produced `s.map is not a function`. Called out
    // by name because a model reaching for a table will reach for this shape.
    note: 'ROWS ARE ARRAYS OF CELLS, in `cols` order — NOT objects. `cols` are plain strings, not {key,label}.',
  },
  logs: {
    when: 'Tailed log or command output. Errors and warnings are coloured; filter by text or level; long output is cut to the tail. Use for evidence, never as a metric.',
    signature: '{ text: string }',
    example: '{ "text": "line one\\nline two" }',
    note: 'One string with newlines, not an array of lines.',
  },
  progress: {
    when: 'Named bars for quota, capacity or completion. Use for a few percentages side by side.',
    signature: '{ items: { label: string, value: number, max?: number, sub?: string, color?: string }[] }',
    example: '{ "items": [{ "label": "E:", "value": 798, "max": 800, "sub": "2.1 GB free" }] }',
  },
  topo: {
    when: 'Blast radius of one host from the live dependency map. Use before approving a change on it.',
    signature: '{ nodes: { id: string, label: string, state?: string }[], edges: { from: string, to: string }[] }',
    example: '{ "nodes": [{ "id": "a", "label": "lb-01" }], "edges": [] }',
    note: 'For a real network picture use `netmap@1.0.0` instead — it carries device types, addresses, zones and port-labelled links.',
  },
  netmap: {
    when: 'A network diagram with device icons, zones and labelled links. Use when the topology itself is the answer.',
    signature:
      '{ nodes: { id, label, kind?, status?, address?, detail?, tier?, zone?, focus? }[], ' +
      'links: { from, to, protocol?, port?, label?, direction?, status?, dashed?, flow? }[], ' +
      'direction?: "LR"|"TB", showZones?: boolean }',
    example:
      '{ "nodes": [{ "id": "lb", "label": "lb-prod-01", "kind": "loadbalancer", "status": "up", "address": "10.0.1.10", "zone": "dmz" }, ' +
      '{ "id": "db", "label": "pg-prod-01", "kind": "database", "status": "up", "address": "10.0.3.5", "focus": true }], ' +
      '"links": [{ "from": "lb", "to": "db", "protocol": "TCP", "port": 5432, "status": "up", "flow": "forward" }] }',
    note:
      'kind: host|vm|container|router|switch|firewall|loadbalancer|database|storage|service|cloud|client|unknown. ' +
      'status: up|degraded|down|unknown — DEFAULTS TO UNKNOWN, and must stay there for anything not actually checked. ' +
      'direction on a link: forward|both. flow: none|forward|reverse|both animates traffic along the line.',
  },
  timeline: {
    when: 'Deploys, config changes and agent actions on one time axis. Use to answer "what changed and when".',
    signature: '{ items: { at: string, title: string, kind?: string, detail?: string }[] }',
    example: '{ "items": [{ "at": "14:02", "title": "deploy 1.4.2", "kind": "change" }] }',
  },
  runstat: {
    when: 'Recent automation runs with outcome and duration. Use on an automation dashboard.',
    signature: '{ runs: { name: string, outcome: "ok"|"fail"|"running", duration?: string, at?: string }[] }',
    example: '{ "runs": [{ "name": "restart-nginx", "outcome": "ok", "duration": "4s" }] }',
  },
  text: {
    when: 'The orchestrator\'s prose, marked as narrative. Use for the analysis beside the numbers — never for a value.',
    signature: '{ text: string, title?: string }',
    example: '{ "text": "Nothing is collecting from this host; the reading below is a one-off probe." }',
  },

  doc: {
    when: 'The WRITTEN half of a page: what this system is, who owns it, what was agreed, what to check first, links to the vendor docs. Markdown — headings, lists, `code`, **bold**, [links](https://…), fenced blocks. Use it on a page you built for something the operator integrated; use `text` for one paragraph of analysis beside a number.',
    signature: '{ text: string }   (markdown; `markdown` is accepted as an alias)',
    example: '{ "text": "## Warehouse WMS\\n\\nRead-only API user `ops-ro`, owned by Logistics.\\n\\n- Base URL: `https://wms.internal/api/v2`\\n- Escalation: #logistics-oncall\\n\\nIf the health panel is red, check the VPN before paging anyone." }',
    note: 'No HTML is parsed — a tag in the text renders as text. Links must be http/https.',
  },

  actions: {
    when: 'The next step as a button instead of a sentence the operator has to retype. On a page the orchestrator built, this is how someone gets from "the panel is red" to the right question without knowing what to ask.',
    signature: '{ actions: [{ label: string, prompt?: string, surface?: string, href?: string, send?: boolean, hint?: string }] }',
    example: '{ "actions": [{ "label": "Re-run the reach test", "prompt": "Test the warehouse-wms connector and tell me exactly what failed.", "hint": "asks the orchestrator" }, { "label": "Open Connectors", "surface": "connectors" }] }',
    note: 'A button can ONLY open a surface, open an http(s) link, or put a prompt in the chat box (send: true submits it). It cannot run a command, read a credential or change anything — a prompt is a request to an agent that is itself gated.',
  },

  // ── The interactive set (ECharts). Every series shape below is also what a
  // LIVE binding with `shape: "timeseries"` produces, so a bound panel needs
  // no options at all.
  timeseries: {
    when: 'Lines over time with hover, legend, thresholds, a baseline band and annotations; shift+wheel zooms. The default for any metric over time.',
    signature: '{ series: { name: string, points: [t: unixSeconds|ms, v: number][] }[] | number[], labels?: string[], unit?: string, band?: { lo: number, hi: number }, annotations?: { at: unixSeconds|ms|ISO, label: string }[], area?: boolean }',
    example: '{ "series": [{ "name": "db-01 load1", "points": [[1756800000, 0.42], [1756800060, 0.51], [1756800120, 1.9]] }], "unit": "", "annotations": [{ "at": 1756800100, "label": "deploy 2.14" }] }',
    note: 'Prefer this over line for anything an operator will hover or compare. Placement `thresholds` draw as dashed lines. Several series get a legend.',
  },
  statetimeline: {
    when: 'State per row as coloured segments over time. Use for "when was it down" across many hosts or services.',
    signature: '{ rows: { name: string, segments: { from: unixSeconds|ms, to: unixSeconds|ms, state: "up"|"warn"|"down"|"unknown", label?: string }[] }[] }',
    example: '{ "rows": [{ "name": "api-gateway", "segments": [{ "from": 1756800000, "to": 1756803600, "state": "up" }, { "from": 1756803600, "to": 1756804200, "state": "warn", "label": "p99 high" }] }] }',
    note: 'A row may instead carry points: [[t, state],…] and consecutive equal states become one segment.',
  },
  statushistory: {
    when: 'One cell per interval per row, coloured by state. Use for periodic checks (backups, probes) over days.',
    signature: '{ rows: { label: string, cells: ("up"|"warn"|"down"|"unknown")[] }[], buckets?: string[] }',
    example: '{ "rows": [{ "label": "db-01", "cells": ["up", "up", "warn", "up"] }, { "label": "web-01", "cells": ["up", "down", "up", "up"] }], "buckets": ["00", "06", "12", "18"] }',
  },
  heatmap: {
    when: 'Rows x columns with hover values. Use for hour-of-day patterns, host x metric grids, or anything dense.',
    signature: '{ rows: { label: string, cells: number[] }[], cols?: string[], max?: number }',
    example: '{ "rows": [{ "label": "db-01", "cells": [12, 40, 91, 55] }, { "label": "web-01", "cells": [8, 9, 12, 10] }], "cols": ["12:00", "12:15", "12:30", "12:45"], "max": 100 }',
  },
  histogram: {
    when: 'A distribution with p50/p95/p99 marks and hover counts. Use for latency or request-size spread.',
    signature: '{ buckets: number[], labels?: string[], p50?: number, p95?: number, p99?: number, unit?: string }',
    example: '{ "buckets": [3, 12, 40, 22, 9, 4, 1], "labels": ["10", "20", "40", "80", "160", "320", "640"], "p50": 38, "p95": 210, "p99": 410, "unit": "ms" }',
  },
  forecast: {
    when: 'A series and its linear projection to a threshold — computed and labelled so. Use for "when does the disk fill".',
    signature: '{ series: { name: string, points: [t, v][] }[] | number[], threshold?: number, horizonDays?: number, unit?: string }',
    example: '{ "series": [{ "name": "pg-data used %", "points": [[1755000000, 68], [1755086400, 70.2], [1755172800, 72.1], [1755259200, 74.4], [1755345600, 76.3], [1755432000, 78.5]] }], "threshold": 100, "horizonDays": 14, "unit": "%" }',
    note: 'The projection is COMPUTED here from a least-squares line and refused below r² 0.5 or 5 points; a sawtooth never crosses anything. Say "computed" when you quote it.',
  },
  anomaly: {
    when: 'A series against its own rolling baseline band with the verdict at the last point. Use to show WHY something is unusual.',
    signature: '{ series: { name: string, points: [t, v][] }[] | number[], verdict?: "normal"|"spike"|"drop"|"level_shift"|"insufficient", explanation?: string, sigma?: number, unit?: string }',
    example: '{ "series": [{ "name": "api p99", "points": [[1756800000, 118], [1756800060, 121], [1756800120, 119], [1756800180, 124], [1756800240, 120], [1756800300, 117], [1756800360, 122], [1756800420, 119], [1756800480, 121], [1756800540, 118], [1756800600, 260]] }], "verdict": "spike", "explanation": "3.5σ above a 7-day baseline of 120 ms", "unit": "ms" }',
    note: 'Put the anomaly_scan verdict and its explanation in; the band is a rolling median ± MAD drawn here and labelled computed.',
  },
  barchart: {
    when: 'Categorical comparison with hover and labels, vertical or horizontal. The default for "which is biggest".',
    signature: '{ items: { label: string, value: number, color?: string }[], unit?: string, orientation?: "vertical"|"horizontal" }',
    example: '{ "items": [{ "label": "hv-01", "value": 41 }, { "label": "hv-02", "value": 38 }, { "label": "hv-04", "value": 44 }], "unit": " VMs" }',
  },
  topn: {
    when: 'The N largest values ranked as bars. Use for top talkers, biggest directories, noisiest hosts.',
    signature: '{ items: { label: string, value: number }[], n?: number, unit?: string }',
    example: '{ "items": [{ "label": "api-gateway", "value": 1840 }, { "label": "billing-api", "value": 620 }, { "label": "auth", "value": 540 }], "n": 10, "unit": " rps" }',
  },
  treemap: {
    when: 'Capacity by hierarchy as nested rectangles. Use for disk usage by path, cost by team, pods by namespace.',
    signature: '{ tree: { name: string, value?: number, pct?: number, children?: …[] }[], unit?: string }',
    example: '{ "tree": [{ "name": "vm-store-a", "value": 3200, "pct": 83 }, { "name": "pg-data", "value": 800, "pct": 97 }, { "name": "backup-nas", "value": 12000, "pct": 44 }], "unit": " GB" }',
    note: 'value sizes the tile; pct colours it (≥75 warn, ≥90 crit). A node with children takes their sum.',
  },
  bargauge: {
    when: 'Named bars against a max, coloured by threshold. Use for utilisation across a handful of hosts.',
    signature: '{ items: { label: string, value: number, max?: number, color?: string }[], max?: number, unit?: string }',
    example: '{ "items": [{ "label": "cpu", "value": 71 }, { "label": "mem", "value": 62 }, { "label": "disk /var/lib/pg", "value": 97 }], "max": 100, "unit": "%" }',
  },
  sparkrow: {
    when: 'A row of small stats with sparklines. Use as a dashboard header strip.',
    signature: '{ items: { label: string, value: string, series?: number[], color?: string }[] }',
    example: '{ "items": [{ "label": "rps", "value": "1.8k", "series": [1700, 1750, 1820, 1840] }, { "label": "p99", "value": "412 ms", "series": [120, 118, 260, 412], "color": "var(--warn)" }] }',
    note: '`value` is a STRING — format it, units included.',
  },
  slo: {
    when: 'Availability against a target with the error budget and burn rate — computed. Use on a service page.',
    signature: '{ target: number, availability?: number, good?: number, total?: number, windowDays?: number, elapsedDays?: number }',
    example: '{ "target": 99.9, "availability": 99.94, "windowDays": 30, "elapsedDays": 18 }',
    note: 'Give availability directly, or good/total counts. Burn rate and time-to-exhaustion are computed and labelled so.',
  },
  servicemap: {
    when: 'Services and stores as a graph with state on the border. Use to show dependencies and where the failure sits.',
    signature: '{ nodes: { id: string, label?: string, state?: "up"|"warn"|"down"|"unknown", kind?: "service"|"host"|"node"|"db"|"data", focus?: boolean }[], edges: { from: string, to: string, kind?: "depends_on"|"declared"|"runs_on"|"co_occurs", label?: string }[] }',
    example: '{ "nodes": [{ "id": "api", "state": "warn", "kind": "service" }, { "id": "db-01", "state": "down", "kind": "db", "focus": true }, { "id": "billing", "state": "up" }], "edges": [{ "from": "api", "to": "db-01" }, { "from": "billing", "to": "db-01", "kind": "declared" }] }',
    note: 'State defaults to unknown and must stay there for anything not actually checked. Declared edges draw green; co-occurrence dotted — never as structure.',
  },
  incidents: {
    when: 'The correlated incident list with priority and status. Use on a NOC wall instead of the raw alert feed.',
    signature: '{ items: { id?: string, title: string, sev?: "c"|"w"|"ok"|"info", status?: string, priority?: number, host?: string, age?: string }[] }',
    example: '{ "items": [{ "id": "inc_2417", "title": "Disk full on db-01", "sev": "c", "status": "acknowledged", "priority": 90, "host": "db-01", "age": "42m" }] }',
  },
  gate: {
    when: 'What waits for a human at the Safety Kernel gate. Use on an operations wall; decisions happen on the Gate surface.',
    signature: '{ items: { id?: string, title: string, host?: string, tier?: string, left?: string }[] }',
    example: '{ "items": [{ "id": "g_1", "title": "restart_service postgresql", "host": "db-01", "tier": "T2", "left": "11 min left" }] }',
    note: 'Shows the queue; it approves nothing. Decisions happen on the Gate surface.',
  },
  // ── 2026-09-04 ──
  stat: {
    when: 'The modern KPI: value, unit, change vs previous (coloured by whether up is good), sparkline and warn/crit bands; several make a row. The default for headline numbers.',
    signature: '{ label: string, value: number|string, unit?: string, previous?: number, lowIsGood?: boolean, warn?: number, crit?: number, target?: number, spark?: number[], sub?: string } | { items: { label, value, unit?, previous?, warn?, crit?, spark?, sub? }[] }',
    example: '{ "items": [{ "label": "p95 latency", "value": 212, "unit": "ms", "previous": 180, "lowIsGood": true, "warn": 250, "crit": 400, "spark": [150, 160, 172, 180, 205, 212] }, { "label": "Error rate", "value": 0.4, "unit": "%", "previous": 0.9, "lowIsGood": true, "warn": 1, "crit": 5 }] }',
    note: 'One object is one tile; `items` is a row. Change is COMPUTED from `previous` and coloured by `lowIsGood`. A string `value` is shown verbatim (for "DOWN", "n/a").',
  },
  radial: {
    when: 'A modern arc gauge with bands. Use for one bounded value — disk, CPU, battery, budget used.',
    signature: '{ value: number, min?: number, max?: number, unit?: string, warn?: number, crit?: number, lowIsBad?: boolean, sub?: string }',
    example: '{ "value": 83, "unit": "%", "warn": 75, "crit": 90, "sub": "disk /var" }',
    note: 'min/max default to 0/100 (and unit to %). Bands are drawn from warn/crit; `lowIsBad` flips them (free memory, battery).',
  },
  scatter: {
    when: 'Does x explain y? One dot per host or sample with a computed fit. Use for load vs latency, size vs duration.',
    signature: '{ points: { x: number, y: number, label?: string, group?: string, size?: number }[] | [x, y, label?, group?][], xLabel?: string, yLabel?: string, xUnit?: string, yUnit?: string, trend?: boolean }',
    example: '{ "xLabel": "load1", "yLabel": "p95 latency", "yUnit": "ms", "points": [{ "x": 0.4, "y": 120, "label": "web-01" }, { "x": 1.1, "y": 180, "label": "web-02" }, { "x": 2.6, "y": 410, "label": "web-03" }, { "x": 0.7, "y": 140, "label": "web-04" }, { "x": 1.9, "y": 300, "label": "web-05" }] }',
    note: 'The fit line (5+ points) is COMPUTED and labelled so; set `trend:false` to omit it. `group` colours; `size` scales the dot.',
  },
  pie: {
    when: 'Share of a whole with labels and hover. Use for a breakdown by state, type or owner (8 slices or fewer).',
    signature: '{ slices: { label: string, value: number, color?: string }[], total?: string, centerLabel?: string, ring?: boolean }',
    example: '{ "slices": [{ "label": "up", "value": 41 }, { "label": "warn", "value": 5 }, { "label": "down", "value": 2 }], "centerLabel": "hosts" }',
    note: 'State names (up/warn/down/unknown) get the semantic colours. More than 8 slices hides the labels — use topn instead.',
  },
  radar: {
    when: 'Several dimensions of several things on one polygon. Use to compare host health profiles or score cards.',
    signature: '{ axes: (string | { name: string, max?: number })[], rows: { name: string, values: number[] }[], max?: number, unit?: string }',
    example: '{ "axes": ["cpu", "memory", "disk", "net", "latency"], "max": 100, "rows": [{ "name": "web-01", "values": [62, 71, 45, 30, 20] }, { "name": "web-02", "values": [88, 90, 52, 60, 55] }] }',
    note: 'Every row has one value per axis, in axis order. Axis max defaults to `max`, else 110% of the largest value on that axis.',
  },
  sankey: {
    when: 'How much flows where. Use for traffic between zones, alert sources to severities to hosts, request paths.',
    signature: '{ links: { from: string, to: string, value: number }[] | [from, to, value][], nodes?: string[], unit?: string, orientation?: "horizontal"|"vertical" }',
    example: '{ "unit": " GB", "links": [{ "from": "dmz", "to": "app", "value": 42 }, { "from": "app", "to": "db", "value": 31 }, { "from": "app", "to": "cache", "value": 9 }, { "from": "office", "to": "app", "value": 12 }] }',
    note: 'A flow is a DAG: self-links and any link that closes a cycle are dropped and the footer says how many.',
  },
  boxplot: {
    when: 'The distribution per group side by side with outliers. Use to compare latency per service or run time per job.',
    signature: '{ rows: ({ name: string, values: number[] } | { name: string, min: number, p25: number, median: number, p75: number, max: number })[], unit?: string, orientation?: "horizontal"|"vertical" }',
    example: '{ "unit": "ms", "rows": [{ "name": "api", "values": [88, 92, 95, 101, 110, 118, 130, 402] }, { "name": "auth", "values": [40, 42, 45, 47, 51, 55] }, { "name": "search", "min": 120, "p25": 180, "median": 240, "p75": 310, "max": 900 }] }',
    note: 'Give samples and the quartiles are COMPUTED (whiskers at 1.5×IQR, the rest outliers), or give the five numbers yourself.',
  },
  calendar: {
    when: 'A cell per day over weeks or months. Use for incidents per day, backup outcomes, patch compliance, deploy cadence.',
    signature: '{ days: [date: "YYYY-MM-DD"|unix, value: number][] | { date, value }[], from?: "YYYY-MM-DD", to?: "YYYY-MM-DD", max?: number, unit?: string, goodIsHigh?: boolean }',
    example: '{ "days": [["2026-08-01", 0], ["2026-08-02", 2], ["2026-08-03", 1], ["2026-08-04", 0], ["2026-08-05", 5], ["2026-08-06", 0], ["2026-08-07", 1]], "from": "2026-08-01", "to": "2026-09-04" }',
    note: 'One value per day. High is bad by default (incidents, failures); set `goodIsHigh` for successes.',
  },
  hostmap: {
    when: 'One tile per host coloured by a metric, grouped by zone or role. Use for "which boxes are hot" across hundreds of hosts.',
    signature: '{ items: { name: string, value?: number, group?: string, state?: "up"|"warn"|"down"|"unknown" }[] | [name, value, group?][], unit?: string, min?: number, max?: number, warn?: number, crit?: number, lowIsBad?: boolean }',
    example: '{ "unit": "%", "warn": 75, "crit": 90, "items": [{ "name": "web-01", "value": 42, "group": "web" }, { "name": "web-02", "value": 78, "group": "web" }, { "name": "db-01", "value": 93, "group": "db" }, { "name": "db-02", "value": 61, "group": "db" }] }',
    note: 'With warn/crit the tiles are ok/warn/crit; without them they shade by value between min and max. A `state` of down/warn overrides the colour.',
  },
  change: {
    when: 'Now against before per row, ranked by change. Use for "what is different since yesterday / the deploy".',
    signature: '{ items: { label: string, before: number, now: number }[] | [label, before, now][], unit?: string, lowIsGood?: boolean, label?: string, beforeLabel?: string, nowLabel?: string }',
    example: '{ "unit": "ms", "lowIsGood": true, "beforeLabel": "yesterday", "nowLabel": "today", "items": [{ "label": "api p95", "before": 180, "now": 212 }, { "label": "auth p95", "before": 50, "now": 41 }, { "label": "search p95", "before": 240, "now": 700 }] }',
    note: 'Rows are ranked by the size of the change; colour follows `lowIsGood`. Give the same unit for before and now.',
  },
  // ── the operations-taxonomy set ──
  pipeline: {
    when: 'A run made of stages — CI build, ETL DAG, deployment plan, backup chain. Use to show where a run is and where it stopped.',
    signature: '{ title?: string, stages: ({ name: string, status: "ok"|"failed"|"running"|"pending"|"skipped"|"warn", seconds?: number, detail?: string } | [name, status, seconds?, detail?])[] }',
    example: '{ "title": "deploy api 2.14", "stages": [{ "name": "build", "status": "ok", "seconds": 84 }, { "name": "test", "status": "ok", "seconds": 212 }, { "name": "canary", "status": "running" }, { "name": "rollout", "status": "pending" }, { "name": "verify", "status": "pending" }] }',
    note: 'Stages are drawn in the order given. `running` highlights; `pending` is dimmed; a `failed` stage colours the whole run.',
  },
  plandiff: {
    when: 'An infrastructure-as-code plan before it is applied. Use to show what Terraform / OpenTofu / Ansible WILL do — destroy is read first.',
    signature: '{ tool?: string, add?: number, change?: number, replace?: number, destroy?: number, resources?: ({ name: string, action: "add"|"change"|"replace"|"destroy", detail?: string } | [name, action, detail?])[] }',
    example: '{ "tool": "opentofu", "resources": [{ "name": "aws_instance.web[2]", "action": "add" }, { "name": "aws_security_group.web", "action": "change", "detail": "ingress 443 added" }, { "name": "aws_instance.web[0]", "action": "destroy", "detail": "instance type changed — forces replacement" }] }',
    note: 'Counts are derived from `resources` unless given. Paste the plan\'s resource lines; never a command.',
  },
  gantt: {
    when: 'Things with a start and an end on one clock. Use for a trace waterfall, job runs, the steps of a deployment, or an incident timeline.',
    signature: '{ rows: { name: string, start: ISO|unix, end?: ISO|unix, duration?: seconds, durationMs?: number, status?: "ok"|"failed"|"running"|"pending"|"warn", depth?: number, detail?: string }[] }',
    example: '{ "rows": [{ "name": "GET /checkout", "start": "2026-09-04T10:00:00Z", "durationMs": 840, "status": "ok" }, { "name": "auth", "start": "2026-09-04T10:00:00.020Z", "durationMs": 60, "status": "ok", "depth": 1 }, { "name": "db query", "start": "2026-09-04T10:00:00.100Z", "durationMs": 620, "status": "warn", "depth": 1, "detail": "seq scan on orders" }] }',
    note: '`depth` indents a child under the row above it. A `running` row with no end runs to now.',
  },
  funnel: {
    when: 'Stages that narrow. Use for the alert-noise story (received → active → correlated → incidents → acknowledged) or any conversion.',
    signature: '{ stages: { label: string, value: number, color?: string }[] | [label, value][], unit?: string }',
    example: '{ "stages": [{ "label": "alerts received", "value": 1240 }, { "label": "active", "value": 310 }, { "label": "correlated", "value": 288 }, { "label": "incidents", "value": 14 }, { "label": "acknowledged", "value": 9 }] }',
    note: 'Bind platform query "noise" with shape table and the platform counts the stages from the live feed and incidents.',
  },
  oncall: {
    when: 'Who gets paged right now. Use on any operations wall; it also says when NOBODY is on call.',
    signature: '{ schedules: { name: string, now?: string, next?: string, until?: ISO, contact?: string, escalation?: string[], shifts?: { who: string, start: ISO, end: ISO }[] }[] }',
    example: '{ "schedules": [{ "name": "Platform primary", "now": "A. Khan", "next": "S. Ali", "until": "2026-09-05T08:00:00Z", "escalation": ["S. Ali", "duty manager"] }, { "name": "Database", "shifts": [{ "who": "R. Baig", "start": "2026-09-04T00:00:00Z", "end": "2026-09-06T00:00:00Z" }] }] }',
    note: 'Give `now`/`next` directly (PagerDuty oncalls) or `shifts` and the current one is picked by the clock.',
  },
  expiry: {
    when: 'Anything with a date it stops working — certificates, licences, domains, tokens, leases, support contracts. Use to see what expires next.',
    signature: '{ items: ({ name: string, expires: ISO|unix, kind?: string, detail?: string } | [name, expires, kind?])[], warnDays?: number, critDays?: number }',
    example: '{ "warnDays": 30, "critDays": 7, "items": [{ "name": "api.example.com", "expires": "2026-09-09T00:00:00Z", "kind": "tls", "detail": "Let\'s Encrypt" }, { "name": "vSphere licence", "expires": "2026-12-01", "kind": "licence" }, { "name": "old-sso.example.com", "expires": "2026-08-30", "kind": "tls" }] }',
    note: 'Sorted soonest first; an expired item is at the top in red. Days left is computed from the clock at render time.',
  },
  scorecard: {
    when: 'A list of controls that pass or fail. Use for a CIS or hardening baseline, compliance evidence, a patch policy, a go-live checklist.',
    signature: '{ title?: string, target?: number, controls: ({ id?: string, name: string, status: "pass"|"fail"|"partial"|"na"|boolean, group?: string, detail?: string } | [id, name, status, detail?])[] }',
    example: '{ "title": "CIS L1 · web-01", "target": 90, "controls": [{ "id": "1.1.1", "name": "cramfs disabled", "status": "pass" }, { "id": "5.2.8", "name": "SSH root login disabled", "status": "fail", "detail": "PermitRootLogin yes" }, { "id": "3.4.1", "name": "firewall active", "status": "pass" }, { "id": "6.1.1", "name": "audit log rotation", "status": "partial", "detail": "no size cap" }] }',
    note: 'The score is COMPUTED as pass / (pass+fail+partial); n/a is excluded and the footer says so. Failing controls sort first.',
  },
};

/** One line per widget, for the capabilities tool. */
export function contractLine(id: string): string | undefined {
  const c = OPTION_CONTRACTS[id];
  if (!c) return undefined;
  return `options ${c.signature}
    e.g. ${c.example}${c.note ? `
    NOTE: ${c.note}` : ''}`;
}
