# Extending this dashboard

## Add a source

Anything that can POST JSON: `POST /api/metrics { name, value }`. From a cron,
a webhook, an app's own code. For a source that needs its own shape, add a
table in `MIGRATIONS` (`src/lib/db.ts`) and a `record<Source>` function beside
`record` in `src/lib/metrics.ts`.

## Add a view (the main move)

1. Write a pure function in `src/lib/metrics.ts` that takes rows or points and
   returns numbers — a top-N, a rate, a breakdown. Test it in `test/`.
2. Call it from `dashboard()` (or from `page.tsx` for a one-off) on the server.
3. Render it: a tile (copy the KPI card), a chart (add a series or a second
   `<Chart>`), or a table.
4. `RunChecks`, then `AppManage start` and `VerifyApp` the page.

## Add a time picker

A search param (`?days=30`) read in `page.tsx` and passed to `dashboard(db, days)`;
a row of links above the tiles. Keep it server-side; no client state needed.

## Add live refresh

`export const revalidate = 60` on the page for a cheap refresh, or a client
`setInterval` that calls `router.refresh()`. Not a WebSocket until a human
asks for sub-minute latency.

## Add another chart type

Register it in `Chart.tsx` (`echarts/charts` exports Bar, Pie, Scatter…) and
pass a `kind` prop. Keep data as `Point[]` per series; convert inside the chart.

## What not to do

- No fetching inside components; the server component passes props.
- No aggregation in SQL that is not also unit-tested as a pure function on the way in.
- No CDN scripts; ECharts is bundled.
- No `seedSample` in production once real data exists.
