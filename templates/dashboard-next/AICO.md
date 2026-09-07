# __APP_TITLE__

A metrics dashboard: Next.js App Router, Tailwind, node:sqlite, ECharts. A
server component aggregates on the server and hands the chart plain data; an
ingest route accepts `{ name, value }` from anything that can POST JSON. Sample
data is seeded when the table is empty so the first open is never blank.

## Layout

- `src/lib/db.ts` — opens and migrates; `seedSample` (delete once real data flows).
- `src/lib/metrics.ts` — **the worked feature**: `parseMetric`, `record`, `perDay`,
  `kpi`, `dashboard(db, days)`. Aggregation is pure and tested without SQLite.
- `src/app/page.tsx` — KPI tiles (`data-kpis`) then the chart. Server component.
- `src/components/Chart.tsx` — the one client component; ECharts over data passed as props.
- `src/app/api/metrics/route.ts` — `GET` the aggregated view, `POST` to ingest.
- `src/app/api/healthz/route.ts` — health. `test/` — vitest over the lib.

## Conventions

- Aggregate on the server; the client draws. No fetching from components.
- A new view = a pure function in `src/lib/metrics.ts` with a test, then a tile or chart.
- Metric names are short identifiers; values are numbers; time is `at` in UTC.
- Config from env only: `DATABASE_PATH`.

## Checks

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Then
`AppManage start` and `VerifyApp`: the tiles show numbers, the chart renders,
`POST /api/metrics` with a bad body answers 400 naming the field.
