# Backlog — __APP_TITLE__

Stories are vertical slices: metric → aggregation (pure, tested) → tile or chart
→ checked in the browser. Tick a box only when its "Done when" was observed.

## Iteration 0 — from the template

- [x] Metrics table, ingest route, seeded sample data.
      Done when: `POST /api/metrics` answers 201 and a bad body 400 with the field named.
- [x] Per-day aggregation, KPI tiles with change vs previous day, 14-day line chart.
      Done when: the aggregation tests pass and VerifyApp sees the tiles and the chart.
- [x] Image builds and answers `/api/healthz`.
      Done when: `node deploy/docker.mjs` then `curl :3000/api/healthz` says ok.

## Iteration 1 — make it this dashboard

- [ ] Replace the sample series with the real sources; delete `seedSample`.
      Done when: a real POST appears on the page within one reload.
- [ ] Add the one view the user looks at first (a breakdown, a top-N, a rate).
      Done when: it is a pure function with a test and a tile or chart.
- [ ] Decide the time window and refresh with the user (fixed 14 days, or a picker).
      Done when: the choice is in the page and `.aico/decisions.md`.
