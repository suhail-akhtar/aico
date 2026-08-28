# Changelog

Notable changes per release. Dates are the release date; `main` is the trunk
and each `release/vX.Y` branch is cut from it at the version it names.

## 0.4.0 — 2026-08-28

A release about the chat surface: what the agent can draw, and what happens
when a drawing goes wrong.

### Added

- **Branch a conversation from any point in it.** Every message offers it, and
  the two sides mean different things: from a reply the branch ends *with* that
  reply, and from your own message it ends just before it with the text handed
  back to the composer. The cut is a turn rather than a message, because a tool
  call and the result answering it can be several events apart and every
  provider rejects a request holding one without the other.
- **Dashboards in the chat.** A `dashboard` block takes KPI tiles with
  sparklines and a responsive grid of chart, viz and table panels — one fence,
  one board, one frame. Asked for "a single dashboard view" the agent used to
  write a standalone HTML file, correctly, because chat blocks are one per fence
  and nothing else was possible.
- **Statistical graphics** through a `viz` block (Vega-Lite). Binning,
  aggregation, regression, loess, density, quantiles, window functions, box
  plots, error bars and faceting are computed by the library from raw rows,
  rather than pre-computed by the model and emitted twice.
- **Mathematics**, which was always rendering and was never advertised. `$x^2$`
  inline, `$$…$$` on its own line, a `math` block with the frame's controls,
  and chemistry via `\ce{2H2 + O2 -> 2H2O}`.
- **Twenty-six diagram types instead of six.** C4 at every level including
  deployment and dynamic, cloud architecture, block, packet, requirements,
  gantt, timeline, kanban, mindmap, quadrant, gitGraph, journey, sankey,
  treemap, radar and the rest — all from the mermaid already in the tree, none
  of which had been mentioned. `npm run test:diagrams` renders every one in a
  real browser so the list describes this build rather than mermaid's docs.
- **Zoom and pan on diagrams**, with the controls over the drawing. Plain wheel
  still scrolls the page; zoom is on the buttons and ctrl/⌘+wheel.
- **`WidgetSpec`**, which hands back the exact shape of any drawable block, or
  of a single diagram type. The catalogue carries a one-line summary per kind in
  the prompt and the full contract behind this tool, so adding kinds does not
  grow the text billed on every request.

### Changed

- Widget controls are icons with tooltips, each carrying its label as an
  accessible name.
- Diagrams live in the same frame as everything else — same copy, download,
  expand and hide, and for the first time the same repair path when one fails
  to parse. Expanding fills the window and Escape leaves it.
- Repairing a widget no longer holds a conversation about it. The corrected
  version replaces the broken one in place and the exchange stays out of the
  transcript, though the log keeps every word. A repair that produced nothing
  stays visible, because a widget marked "being fixed" with no explanation is
  worse than the noise.
- Spreadsheet attachments are read through ExcelJS. The `xlsx` package is
  abandoned on npm at 0.18.5 with a prototype-pollution and a ReDoS advisory,
  both in the parser, and this code parses files a user uploaded.

### Fixed

- Sessions started from the web ran in whatever directory `aico serve` was
  launched in — usually AICO's own checkout — rather than the configured
  workspace. The server was already right; the client named a project on every
  request, so the correct default was unreachable.
- The model a session is held with is remembered. It used to live in browser
  state, so it reverted to the global default on reload with nothing to say it
  had. Choosing in Settings sets the default without silently pinning whichever
  chat was open, and a pinned session says so and can follow the default again.
- **Queue did nothing at all.** Messages went into a queue that was never
  drained — `claimTurn` had no callers anywhere. Steer worked and looked broken
  for the opposite reason: it lands at the next step boundary and said nothing
  in the meantime. Both now show what was accepted and when it will run.
- Charts stopped flickering and hidden widgets stopped reappearing when a new
  message streamed. react-markdown reconciles by component identity, so a
  rebuilt component map remounted every fenced block — the charts were not
  redrawing, they were being destroyed and rebuilt.

### Security

- `npm audit` is clean in this repository. `form-data`, `ws`, `prismjs` and
  `refractor` were upgraded; `xlsx` was replaced.
- One advisory reaches consumers and cannot be suppressed from here: ExcelJS
  depends on `uuid` 8, which has a bounds-check advisory in `v3/v5/v6` when a
  caller supplies a buffer. ExcelJS calls `uuid.v4()` with no buffer, so it is
  not reachable, but `overrides` do not transit to installers and `npm audit`
  will report it. It replaced two advisories that *were* reachable.

## 0.3.0

Multi-provider architecture, the web console, and the session event log. See
the git history for detail — this changelog starts at 0.4.0.
