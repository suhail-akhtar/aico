# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript.

- Aggregate on the server, draw on the client — the page ships numbers, not raw rows,
  and the only client JavaScript is the chart.
- ECharts (tree-shaken `echarts/core`) — one dependency, every chart type, no CDN.
- One `metrics(name, value, at)` table — a dashboard's first job is to accept anything
  that can POST a number; typed per-source tables come when a source needs them.
- Pure aggregation functions with tests — the numbers on the tiles are the product,
  and they are tested without a database.
- Sample data seeded when empty — a dashboard nobody can see on first open is a bug.
