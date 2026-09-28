# AICO Desktop — design

A native desktop client for AICO on Windows and Linux (macOS builds too, but is
not the target). Its own interface — modelled on the ChatGPT desktop app's
calm chat surface and Antigravity's project/conversation sidebar — over the
same engine every other AICO client uses.

## The one lesson this design is built around

AICO had an Electron client once (`698c5bd`, removed in `a2c3ecf`). It was
removed because it carried *a second engine plumbing*: its own store, its own
SQLite settings database and its own IPC layer, competing with the
server-owned run that the browser client already had. It drifted and it lost.

So this app is **a client, not a fork**:

| Concern | Where it lives | Shared with |
|---|---|---|
| Runs, sessions, settings, skills, MCP, memory, apps, cron | the engine (`serve()` from `src/server`) | CLI, web, VS Code |
| Conversation state and the event reducer | `web/src/{api,store,reduce,turn-state,…}` via `@web` | web, VS Code panel |
| Transcript rendering, widgets, math, diagrams | `shared/ui` via `@aico/ui` | web, VS Code panel |
| Widget catalogue the model reads | `shared/widgets/catalog.ts` | engine, web |
| **Desktop-only**: window, tray, native notifications, the built-in browser, local files/terminal, GitHub, plugins, the IDE tools the agent drives | `desktop/` | — |

The desktop never owns a run. Closing the window does not kill a turn that the
engine is still running in its utility process until the app quits, and the
same session opens in the browser client or VS Code.

## Processes

```
Electron main ─┬─ utilityProcess: AICO engine  (serve(), Node 24 inside Electron — node:sqlite works)
               ├─ BrowserWindow: the renderer (aico://app/)
               ├─ WebContentsView(s): the built-in browser (partition persist:aico-browser)
               └─ desktop MCP endpoint (127.0.0.1, random port, bearer token)
```

* **No Node install needed.** Electron 44 ships Node 24.21; the engine runs in
  a `utilityProcess` so a long turn never blocks the window.
* **`aico://app/`** is a privileged custom scheme. It serves the renderer's
  files, and proxies `aico://app/api/*` to the engine with the token attached
  and the Origin the engine expects. The renderer never holds the token, uses
  relative `/api/...` URLs exactly like the web client, and SSE streams through
  unbuffered.

## The agent drives the IDE

The desktop registers itself with the engine as an **MCP server over HTTP**
(no engine change: `McpHttpClient` already supports headers). Its tools:

* `ide_*` — describe the IDE and its state, navigate, notify, open files and
  projects, change appearance, run palette commands, list/enable/disable/create
  plugins.
* `browser_*` — the built-in browser: open, navigate, snapshot (accessibility
  refs), click, type, press, select, scroll, evaluate, screenshot, wait,
  console, network, tabs, hand-over to the user. Input goes through the
  DevTools protocol (`webContents.debugger`), so events are trusted.

`ide_describe` is the orchestrator's manual: every view, command, plugin
contribution point and setting, generated from the live registries — so it
cannot go stale when a plugin is added.

## Plugins — every piece is one

Every feature (Chat, Projects, Library, Scheduled, Git, GitHub, Files, Editor,
Terminal, Browser, Apps, Activity, Skills & MCP, themes, widget packs) is a
**built-in plugin** that registers contributions through the same API a user
plugin uses, and can be switched off.

A plugin is a folder in `~/.aico/desktop/plugins/<id>/` with `aico-plugin.json`:

* **Declarative contributions** (safe, and what the orchestrator writes):
  `views` (a page: markdown + widgets, or a prompt-driven page), `commands`
  (palette entries that send a prompt, open a view, or run a shell command
  after confirmation), `themes`, `snippets`/quick prompts, `statusItems`,
  `navItems`, `settings` defaults.
* **Script contributions**: a `view.html`/`view.js` runs in a sandboxed iframe
  (`sandbox="allow-scripts"`, no same-origin) and talks to the host through a
  postMessage RPC with a narrow, permissioned API. A plugin with script asks
  for trust once, like a VS Code extension.

The orchestrator creates and edits plugins with `ide_plugin_*` tools: it
customises the IDE for the user **without touching the core**.

## Rendering

`shared/ui` already renders markdown, GFM tables, KaTeX math (with mhchem
chemistry), Mermaid, ECharts, Vega-Lite, dashboards, data tables and HTML
previews. This app adds, in `shared/` so every client gains them:

* **the widget kit** — the AETNIC ops-console widget set (54 widgets: KPI/stat
  tiles, gauges, time series, heatmaps, treemaps, sankey, radar, gantt,
  timelines, scorecards, pipelines, network maps, …) placed on a 12-column grid
  by a `widgets` fence;
* **math and physics**: `plot` (functions, parametric, polar — evaluated with a
  real expression engine), `geometry` (points, segments, circles, polygons,
  angles, labels, as SVG), `calc` (step-by-step evaluation with units, so a
  physics calculation shows its working and its SI result).

Exports: Markdown, plain text, standalone HTML with every visual inlined,
PDF (Chromium print), and **copy as rich content** — the clipboard gets HTML
with rendered charts as well as the Markdown.

## Phases

1. Shell: scaffold, engine in a utility process, `aico://` proxy, splash, window
   state, tray, single instance.
2. Chat: ChatGPT-style home and transcript, composer with project/model/effort
   chips, attachments, permissions, questions, steering, notifications.
3. Rendering: widget kit, math/physics/geometry, exports, rich copy.
4. IDE: file explorer, Monaco editor, terminal, full Git, GitHub (`gh`).
5. Browser: built-in browser pane + agent tools (MCP).
6. Plugins: registry, built-ins as plugins, user plugins, orchestrator tools.
7. Library, Scheduled, Apps, Activity monitor, command palette, settings.
8. Packaging: Windows (NSIS) and Linux (AppImage, deb) via electron-builder;
   CI builds both.
