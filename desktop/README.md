# AICO Desktop

AICO as a native app for Windows and Linux: a ChatGPT-style chat in front, an IDE
behind it (Monaco, real terminals, Git, GitHub), a built-in browser the agent
drives, and plugins for every piece. See [DESIGN.md](DESIGN.md) for how it is put
together and why.

## Run it from source

```sh
# from the repository root
npm ci
npm --prefix web ci        # the shared conversation store and renderers
npm --prefix desktop ci

npm --prefix desktop start # build everything and launch
```

`npm --prefix desktop run dev` relaunches without rebuilding.

## Package it

```sh
npm --prefix desktop run package:win     # NSIS installer  → desktop/release/
npm --prefix desktop run package:linux   # AppImage + deb  → desktop/release/
```

CI builds both on every version tag (`.github/workflows/desktop.yml`) and attaches
them to the release.

## Test it

```sh
npm --prefix desktop test        # unit: widget kit, maths core, plugins, prefs, turns, theme
npm --prefix desktop run typecheck
node desktop/scripts/shot.mjs <outDir> <steps.json>   # drive the real app and screenshot it
```

`shot.mjs` runs the app under Playwright with an isolated `AICO_HOME` (never your
real `~/.aico`); `AICO_EXE=<path>` runs a packaged build instead.

## Layout

| Path | What |
|---|---|
| `electron/main.ts` | Window, tray, menu, lifecycle |
| `electron/engine-host.ts` | The AICO engine (`serve()`) in a utility process |
| `electron/protocol.ts` | `aico://app/` — the interface's files and the API proxy |
| `electron/mcp.ts` | The agent's `ide_*` and `browser_*` tools |
| `electron/browser.ts` | The built-in browser and its DevTools-protocol driver |
| `electron/terminal.ts`, `files.ts`, `github.ts`, `plugins.ts` | Desktop services |
| `engine/entry.ts` | The engine bundle's entry |
| `renderer/src/` | The interface (React); reuses `web/src` state and `shared/ui` |
| `shared/` | Types shared by main and the interface (prefs, plugin manifests) |

## Plugins

A plugin is a folder in `~/.aico/desktop/plugins/<id>/` with `aico-plugin.json`:

```json
{
  "id": "me.release-helper",
  "name": "Release helper",
  "version": "0.1.0",
  "icon": "rocket",
  "contributes": {
    "navItems": [{ "id": "board", "title": "Releases", "icon": "rocket", "view": "board" }],
    "views": [{ "id": "board", "title": "Releases", "kind": "prompt-board", "prompts": [
      { "title": "Draft release notes", "prompt": "Draft release notes from the commits since the last tag." }
    ] }],
    "commands": [{ "id": "notes", "title": "Draft release notes", "action": { "type": "prompt", "prompt": "Draft release notes from the commits since the last tag." } }],
    "themes": [{ "id": "dusk", "label": "Dusk", "mode": "dark", "background": "#1A1B26", "foreground": "#C0CAF5", "accent": "#7AA2F7" }]
  }
}
```

View kinds: `markdown` (every chat renderer works in it), `prompt-board`, `links`,
and `frame` — your own HTML in a sandbox, talking to the app over `postMessage`.
Other contributions: `prompts`, `statusItems`, `widgets` (a chat fence language
your HTML draws) and `instructions` (added to every chat while the plugin is on).
Or just ask the agent: *"make me a plugin that…"*.
