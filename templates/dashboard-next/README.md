# __APP_TITLE__

__APP_DESCRIPTION__

A metrics dashboard on Next.js (App Router), Tailwind, Node's built-in SQLite
and ECharts. KPI tiles and a 14-day chart over whatever you POST to it.

## Run

```sh
npm install
npm run dev                     # http://localhost:3000 — seeded with sample data
```

Feed it:

```sh
curl -s -X POST localhost:3000/api/metrics -H 'content-type: application/json' -d '{"name":"signups","value":3}'
curl -s localhost:3000/api/metrics?days=7
```

## Check

```sh
npm run typecheck
npm run lint
npm test
npm run build && npm start
```

## Configure

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_PATH` | `./data/app.sqlite` | SQLite file; mount as a volume in Docker |

## Deploy

`deploy/README.md`. `node deploy/docker.mjs` builds the image; mount `/app/data`.

## Structure

```
src/lib/db.ts             open, migrate, seed
src/lib/metrics.ts        record, perDay, kpi, dashboard — the worked feature
src/app/page.tsx          tiles + chart (server component)
src/components/Chart.tsx  ECharts, client-side, data by props
src/app/api/metrics       GET aggregated view, POST ingest
test/                     vitest
```
