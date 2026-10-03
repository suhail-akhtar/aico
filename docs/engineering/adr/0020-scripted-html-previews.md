# 0020 — Run HTML previews from their own origin (`aico://preview`), sandboxed, with no network

- **Status:** Accepted
- **Date:** 2026-10-03
- **Deciders:** owner (+ authors)
- **Supersedes / related:** 0003 (desktop is a client), 0005 (browser safety model); `shared/ui/HtmlPreview.tsx`

## Context

The desktop showed HTML (an artifact the agent built, or a ```html block with
"scripts" ticked) in a `srcdoc` iframe. A srcdoc document (and a blob: or
data: one) inherits the embedding window's CSP, and the desktop's is
`script-src 'self' aico:`. Checked in the running app: with
`sandbox="allow-scripts"` the frame's inline script was refused with a CSP
error, so a dashboard's charts never drew and the chat's "scripts" checkbox
did nothing. The owner asked for previews whose scripts run, served the way
plugin views are, under hard isolation rules.

## Decision

1. **A second origin.** `aico://preview/<token>/…` is served by the same
   protocol handler as the app (`electron/protocol.ts` dispatches on the
   host) but is a different origin from `aico://app` (the scheme is
   "standard", so the host is part of the origin). The handler never proxies
   `/api/` for any host but `app`, and the preview host never reaches the
   engine: main fetches the file itself (`GET /api/artifacts/file`, which
   checks containment in the chat's artifacts folder) and returns only bytes.
   Subframes get no preload (`nodeIntegrationInSubFrames` is off), so there
   is no `aicoDesktop` bridge, no IPC and no engine token in a preview.
2. **Tokens, one directory each.** The AICO window registers a preview over
   IPC (`preview:register {session, path} | {html}`) and gets a URL with a
   144-bit random token. A token serves only its file's directory (or one
   in-memory page); `..`, absolute paths, drive letters, backslashes,
   percent-encoded dots and NUL resolve to nothing (`preview-core.ts`
   `cleanSegments`, `PreviewRegistry.resolve`). The registry keeps the last 200.
3. **Framing.** `sandbox="allow-scripts"` — never `allow-same-origin`, popups,
   forms, downloads or top navigation. "Open in browser" is a button in the
   app's own chrome, so the frame needs no `allow-popups`.
4. **CSP on every preview response**:
   `default-src 'none'; script-src 'unsafe-inline' <own dir> [CDNs]; style-src 'unsafe-inline' <own dir> [CDNs]; img-src <own dir> data: blob:; font-src <own dir> data: [CDNs]; media-src <own dir> data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; frame-ancestors aico://app; sandbox allow-scripts`.
   `<own dir>` is `aico://preview/<token>/`, so even another preview's files
   are out of reach.
5. **CDNs.** Generated pages usually load a chart library from a CDN. We allow
   exactly cdnjs.cloudflare.com, cdn.jsdelivr.net and unpkg.com, for scripts,
   styles and fonts, and **only those a page names** in its HTML. They cannot
   send anything back: `connect-src 'none'`, images limited to the directory,
   data: and blob:, no forms, no navigation out. No `'unsafe-eval'`.
6. **Navigation.** `will-frame-navigate` on every webContents refuses a
   navigation a preview frame starts to anywhere outside its own token (a
   link, `location = …`), so a page cannot carry data out in a URL.
7. **The chat block.** `shared/ui/HtmlPreview` gains a host seam,
   `setScriptedHtmlFrame`; the desktop registers it, so a block with
   "scripts" ticked runs from an in-memory preview page. The block keeps its
   own stricter meta CSP (inline scripts only). The web portal and VS Code
   still use srcdoc.

## Alternatives considered

| Option | Why not |
|---|---|
| `srcdoc` / blob: / data: frames | Inherit the window's CSP; measured: scripts refused. |
| Add `'unsafe-inline'` to the app's own `script-src` | Weakens the window that holds the engine connection, for every page. |
| A localhost HTTP server for previews | A new network listener; ports are reachable by other local processes. |
| Serve by session + path in the URL, no token | Any preview could point a frame at any file of the chat; the token pins one directory. |
| Allow any CDN / `https:` | An open script source is an open door; three named CDNs cover what generated pages use. |

## Consequences

- **Good:** an HTML artifact previews like the page it is (scripts, sibling
  .js/.css/images); the chat's "scripts" checkbox works in the desktop.
- **Bad / costs:** a page that fetches data (`fetch('data.json')`) fails by
  design; so does a library that needs `eval` (Vega). "Open in browser" is
  the escape hatch for both.
- **Honest limits:** a CDN script runs inside the sandbox and could misbehave
  there (it still cannot read AICO, call the engine or send data out). Tokens
  live in main's memory; a preview stops loading after 200 newer ones or a
  restart. Opaque-origin frames cannot be measured, so the chat block keeps a
  fixed height.
- **Migration:** none.

## Threat model

- **Asset:** the engine (runs commands) and its token; the app origin's
  storage and IPC; the person's files; data inside the previewed page.
- **Attacker:** the HTML itself (model output, or a page the agent fetched).
- **Paths and controls:** read the app → opaque origin, different host, no
  preload; call the engine → no `/api/` off the app host, `connect-src 'none'`,
  token never in the preview; read other files → token pinned to one
  directory + engine containment check; exfiltrate → no connect, no forms,
  images local only, navigation guard, no popups; clickjack the app →
  `frame-ancestors aico://app`.

## Verification

- `desktop/scripts/test-unit.mjs` (preview section): traversal and encoded
  escapes resolve to nothing, tokens are per registration, CSP directives
  (`connect-src 'none'`, no `allow-same-origin`, no eval, CDNs only when named,
  never an unlisted one), navigation rule.
- Live (desktop, isolated `AICO_HOME`): an artifact page with an inline-script
  chart and a jsDelivr chart library draws; the same page's `fetch()` to an
  https URL and to the engine port both fail, `window.aicoDesktop` is
  undefined, and `aico://preview/<token>/../…` is a 404.
- Reversing any rule fails a unit test above.
