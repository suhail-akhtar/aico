# 0037 — Show UI mockups as a design board: linked HTML screens on a zoomable canvas

- **Status:** Accepted
- **Date:** 2026-10-09
- **Deciders:** owner (+ authors)
- **Supersedes / related:** 0020 (scripted HTML previews), 0008 (headless export), 0003 (desktop is a client); `src/canvas/board-tool.ts`, `shared/ui/board/`, `web/src/components/board/`

## Context

Asked for a UI mockup, the agent wrote loose HTML files into the artifacts
folder. The person then opened them one at a time in the Artifacts viewer:
no overview of the flow, no way to see five screens side by side, links
between screens that went nowhere (the viewer frames one file), and nothing
to send round. Claude Desktop's mockup canvas shows what people expect
instead: titled frames grouped under section headings on a zoomable canvas,
a Play button per screen whose links open the other screens, a Present mode,
and per-screen download.

Constraints: previews have no network and run sandboxed from their own
origin (ADR 0020); the browser portal has no such origin and serving
model-written HTML from the engine's origin was rejected there; no new
runtime dependency; the export path (headless Chrome/Edge through
`playwright-core`, ADR 0008) already exists; a zip writer (`fflate`) is
already a dependency.

## Decision

1. **A board is a folder** `boards/<id>/` in the chat's artifacts folder:
   `board.json` (`{version, title, description?, sections:[{title, frames:[{id,
   title, file, width, height, note?}]}], notes:[…]}`) plus standalone HTML
   screens and their shared files. Screens link to each other with plain
   relative links, so the folder also works opened from disk.
2. **One model-facing tool, `DesignBoard`** (deferred group `design`,
   `src/canvas/board-tool.ts`): `create`, `write_file`, `add_frame`,
   `update_frame`, `remove_frame`, `reorder`, `get`, `list`, `export`. The
   rules are enforced in the tool, not the prompt: every path is a plain
   relative path inside the board folder, checked as text
   (`safeRelPath`: no `..`, absolute, drive, backslash, hidden, encoded
   forms) and again by real path (a link inside the folder cannot lead a write
   out); a screen or stylesheet that loads from the network (anything but a
   script/style/font from the three ADR 0020 CDNs; any remote picture; fetch)
   is refused with the fix named; `get` reports broken links, unreachable
   screens, missing files and the person's notes. No permission prompt, like
   Canvas: it writes only the chat's own artifacts.
3. **The format, layout and camera are pure and shared**
   (`shared/ui/board/board-model.ts`): the engine validates with the same
   `parseBoard` the viewer reads with; sections stack, frames sit in a row,
   deterministic; the camera is `{x, y, k}` like the Code map's.
4. **Screens are composed, not served** (`shared/ui/board/board-compose.ts`):
   each screen becomes one self-contained document — local CSS, scripts,
   pictures and fonts inlined from the artifacts route (which checks
   containment), a CSP meta (`connect-src 'none'`, no forms, no `<base>`), and
   for live views a small script that turns a click on a link into
   `postMessage({aicoBoard:'nav', href})`. The viewer accepts the message only
   from its own frame's window and resolves `href` against the board; a link
   to anything else is reported, never followed. Frames are always
   `sandbox="allow-scripts"`, never `allow-same-origin`. The browser frames the
   document with `srcdoc`; the desktop registers it as an in-memory page on
   `aico://preview` (ADR 0020), because a srcdoc frame there inherits the
   window's CSP and would run no script.
5. **One viewer for web and desktop** (`web/src/components/board/`): the
   canvas (wheel/pinch zoom toward the pointer, drag/Space/hand to pan, zoom
   steps, fit), frame titles with Play and download in screen space, live
   pages only for the frames in view (at most twelve, nearest first; the rest
   are placeholders), Play (device size, scaled down to fit, links navigate),
   Present (board order, ← →, Esc, full screen), sticky notes the agent reads
   back. Select, hand and note are the only tools.
6. **Export** (`src/canvas/board-export.ts`, `GET /api/boards/export`): PNG of a
   screen and a PDF of the board are screenshots taken by the headless
   browser with the board folder served at an origin that exists only inside
   it (CDNs for scripts/styles/fonts only, everything else refused, motion
   frozen); the PDF is a page per screen at the screen's own size (CSS named
   pages). Zip is the folder via `fflate`. `POST /api/boards/notes` lets the
   person change the notes and nothing else.
7. **Skill** `design-board` (≤ 3,600 characters, loads the `design` group):
   direction first (ui-craft §1), one shared stylesheet with the tokens, one
   device size per flow, realistic content, every screen reachable, then
   export PNGs and critique them before reporting.

## Alternatives considered

| Option | Why not |
|---|---|
| Point each frame at the file on `aico://preview` and let links navigate natively | Works only in the desktop; the browser has no preview origin, and the board could not follow which screen is showing. Composition gives one behaviour everywhere. |
| Serve the board folder from the engine for the browser | ADR 0020 rejected model-written HTML on the engine's origin; a token in a frame URL would be one more credential in a URL. |
| A new local HTTP server for previews | A new network listener (ADR 0020 rejected it for the same reason). |
| A drawing canvas (pen, shapes, text) like a whiteboard | A mockup is real screens; mark-up is a different product. Notes cover "talk back to the agent". |
| Thumbnails as cached screenshots for every frame | Needs the headless browser per change; live frames limited to the view cost less and are always current. Placeholders cover the rest. |
| PDF by printing each screen | Print CSS reflows a 1440 px screen to paper; screenshots show the design as reviewed. |
| Let the agent write `board.json` with Write | Nothing would hold the path, network and link rules the viewer depends on. |

## Consequences

- **Good:** a mockup is reviewable as a flow, clickable end to end, presentable,
  exportable (PDF, PNG, zip), and the person's notes reach the agent.
- **Bad / costs:** one more deferred tool (one `LoadTools` line, ~20 tokens,
  until a request names a mockup); screens are inlined per view, so a picture
  shared by ten screens is in ten documents (capped at 3 MB per asset).
- **Honest limits:** the PDF is pictures (no selectable text); frames outside
  the view are placeholders, not cached thumbnails; `@import` is inlined one
  level deep and `srcset` is not rewritten; a screen script that needs
  `eval` or the network fails by design; the VS Code panel does not open
  boards yet (its webview CSP was not checked); drawing tools are not built.
- **Migration:** none. Existing loose HTML artifacts are unchanged.

## Threat model

- **Asset:** the engine (runs commands) and its token; the app origin's storage
  and IPC; files outside the chat's artifacts; the person's other data.
- **Attacker:** the screen HTML/CSS/JS (model output, possibly steered by
  something the agent read), and `board.json` written by the model.
- **Paths and controls:** read files outside the board → `safeRelPath` +
  real-path checks in the tool, `artifacts/file` containment on every client
  fetch, composition refuses `..` past the board; reach the app or the engine
  → opaque-origin sandbox (no `allow-same-origin`), desktop preview origin with
  no preload and no `/api/`, CSP `connect-src 'none'`; exfiltrate → no
  network in the CSP, navigation is a message the viewer resolves only to
  another screen of the board, no forms, no `<base>`; spoof navigation → the
  message is accepted only from the player's own frame window; rewrite the
  board from a client → the notes route replaces notes only, re-parsed by
  `parseBoard`; headless export → requests outside the board folder and the
  three CDNs (scripts/styles/fonts) are refused.

## Verification

- `scripts/design-board-test.mjs` (in `npm test`): traversal, encoded and drive
  paths refused; duplicate ids/files and out-of-range sizes named; the tool's
  actions; remote assets refused with nothing written; a junction inside the
  board cannot lead a write out; link report; composition never asks for a
  path outside the board; routes 404 outside the chat; notes route changes
  only notes; zip always, PNG/PDF when a browser is installed; the `design`
  group loads on mockup requests and from the skill; skill size.
- `web/test-board.mjs` (in `npm run test:web:unit`): layout, camera (zoom keeps
  the point under the pointer, fit, steps, pan), at most twelve live frames,
  hit testing, Play scale, composition.
- Live (isolated `AICO_HOME`, scripted provider, web client at 1440 px): a
  six-screen board built through the agent loop; board, zoom, note, Play,
  a link clicked inside a screen opening another screen, Present, download.
