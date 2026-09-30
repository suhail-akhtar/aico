# 0003 — The desktop app is a client of the engine, not a fork

- **Status:** Accepted (shipped in 0.23.0, 2026-09-29; backfilled 2026-09-30)
- **Deciders:** owner
- **Related:** [`desktop/DESIGN.md`](../../../desktop/DESIGN.md); [principles § 5](../principles.md#5-the-desktop-app-is-a-client-not-a-fork)

## Context

The first Electron client (added in `698c5bd`, removed in `a2c3ecf`, on the
abandoned pre-rewrite lineage) died because it duplicated engine plumbing: its
own store, its own SQLite settings, its own IPC. Every engine change had to be
made twice and the two drifted.

## Decision

- The engine runs as the engine: `desktop/engine/entry.ts` imports `serve()`
  from `src/server/index.ts`, bundled to `dist/engine/engine.mjs`, started in
  an Electron `utilityProcess` (`desktop/electron/engine-host.ts`). Electron
  44's bundled Node 24 has `node:sqlite`, so users need no Node install.
- The renderer reuses the web client's state layer (`@web` → `web/src`) and the
  shared renderers (`@aico/ui` → `shared/ui`), the VS Code panel's pattern.
- `aico://app/` is a privileged scheme that serves the renderer and proxies
  `/api/*` to the engine; main attaches the token and the engine Origin. The
  renderer never holds the token (`desktop/electron/protocol.ts` deletes any it sent).
- The engine owns runs, sessions, settings, skills, MCP and cron. Desktop-only:
  window, tray, the built-in browser, IDE tools, plugins, and UI prefs in
  `~/.aico/desktop/prefs.json`. "The desktop never owns a run."
- The agent drives the IDE and browser through an MCP server in main
  (`desktop/electron/mcp.ts`, `ide_*` / `browser_*`), passed to the engine as
  `AICO_HOST_MCP` — no engine fork needed.
- Rendering added for the desktop goes in `shared/` so every client gets it.

## Alternatives considered

| Option | Why not |
|---|---|
| Embed the web portal in a window | the owner asked for a native app, not the portal embedded |
| Desktop-specific engine/state | exactly what killed the first client |
| Engine as a child Node process | requires a Node install; utilityProcess needs none |

## Consequences

- **Good:** one engine, four clients; engine fixes reach the desktop for free;
  the desktop and CLI share `~/.aico`.
- **Costs:** desktop features that need engine support must be built in the
  engine (e.g. `AICO_HOST_MCP` in 0.23.0); packaging gotchas (utilityProcess
  `cwd` inside `app.asar`, zustand aliasing).
- **Honest limit:** `desktop/electron/main.ts` computes `AICO_HOME` itself and
  passes it to the engine — two definitions to keep in step.

## Verification

`npm --prefix desktop test` + typecheck in CI; `desktop/scripts/shot.mjs`
drives the real app. A PR adding a store, settings file or run state to
`desktop/electron/` violates this ADR.
