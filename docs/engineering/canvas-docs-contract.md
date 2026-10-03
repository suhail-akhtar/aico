# AICO Docs (Canvas upgrade) — engine/UI contract

The engine side (tool, store, routes, stream events, exports) and the UI side
(`shared/ui/canvas/*`, the canvas panels) are built concurrently against this
contract. **Changes to the contract are recorded here, newest first, before
the code changes**, so the other side can read them.

## Contract changes

**Engine + UI, 2026-10-03 (document design blueprints).** Additive. ADR 0022.

1. **Settings** gain `docType` (the type id; every template stores it),
   `blueprint` (a family id, overriding the type's) and `control: {client,
   reference, version, status, owner, preparedBy, revisions[], approvals[],
   distribution[]}` (merged field by field). `cover: false` is now kept as
   `{enabled:false}` so it can switch off a family's cover.
2. **`resolveLook`** (`doc-themes`) returns `blueprint` and `fonts` (the
   family's Word-safe pairing) besides the theme; `themeAttrs` sets
   `--dt-body`/`--dt-head` from them, `--dt-head-weight`, `data-dt-bp`, and
   `data-dt-numbered` for numbered families. The page drops the numbering when
   the author typed numbers into the headings (`doc-layout` `typedNumbering`).
3. **Authoring conventions** the exports read: a paragraph `Table: …` beside a
   table and `Figure: …` beside a diagram, chart or picture become numbered
   captions; `## Appendix A — …` is lettered; never type section numbers into
   headings (an export removes "2.4 " and numbers with real Word numbering).

**Engine + UI, 2026-10-03 (AICO Slides).** Additive. ADR 0023.

1. **`kind: 'deck'`.** One tab whose `content` is the deck as JSON —
   `{"v":1,"aspect":"16:9"|"4:3","theme","type?","footer?","slideNumbers?",
   "slides":[{id, layout, title?, subtitle?, bullets?:[{text, level?}], body?,
   left?/right?:{heading, bullets, body}, image?:{src, alt, fit}, chart?:{type,
   categories, series:[{name, values}], unit?, echarts?}, diagram? (Mermaid),
   table?:{header, rows}, kpis?, quote?, attribution?, timeline?, source?,
   notes?, transition?:'none'|'fade', intent?}]}` (`shared/ui/canvas/
   deck-model.ts`, DOM-free). Every write must parse as a deck (the store
   refuses otherwise); no tabs. Versions, 409, history and `canvas` frames are
   unchanged — frames carry `kind:'deck'`.
2. **Layout** is computed, never stored: `deck-layout.ts` turns a slide into
   positioned frames and problems; the editor, the PDF/PNG export
   (`deck-render.ts`) and the .pptx writer draw the same frames.
3. **Routes:** `POST canvas/create {kind:'deck', content}` (empty deck when no
   content); `GET canvas/:id/export?format=pptx|pdf|png` (png = a zip of
   slide images; other formats 400).
4. **Tool `Canvas`:** `create {kind:'deck', template?, theme?, aspect?,
   footer?, slides?}`, `set_slides {id, version, slides?, remove?, order?,
   theme?, footer?, aspect?, template?}`, `read {id, slides?:[ids]}`,
   `export {format: pptx|pdf|png}`; document actions on a deck are refused
   naming `set_slides`. Every write returns the layout check.
5. **Host (UI):** `CanvasKind` gains `'deck'`, `ExportFormat` gains
   `'pptx'|'png'`; a deck opens in `DeckEditor` (card: "presentation" badge,
   slide count and titles). Artifacts lists decks (and .pptx files) under
   Presentations.

**Engine + UI, 2026-10-03 (AICO Sheets and the Artifacts list).** Additive.

1. **`kind: 'sheet'`.** A sheet canvas has exactly one tab whose `content` is
   the workbook as JSON — `{"aicoSheet":1,"sheets":[{id, name, cells:{"A1":
   {v?|f?, s?}}, cols?:{"A":px}, freeze?:{rows,cols}, cond?:[…], charts?:[…],
   filter?}]}` — written by `serializeBook` one cell per line
   (`shared/ui/canvas/sheet-model.ts`, DOM-free, imported by the engine).
   `f` is an Excel formula without `=`; `v` a number/text/boolean (dates are
   Excel serials with `s.num:'date'`); `s` = `{num:'number'|'currency'|
   'percent'|'date'|'text', dp, cur (ISO), b, fill:'#rrggbb', align}`. Every
   write of a sheet's tab must parse as a workbook (the store refuses
   otherwise); tabs cannot be added to a sheet (its sheets live inside).
   Versions, 409-with-latest, history and `canvas` frames are unchanged —
   frames carry `kind:'sheet'`.
2. **Formulas** are evaluated by `shared/ui/canvas/sheet-formula.ts` in the
   UI (live) and the engine (tool results, cached values in .xlsx/.csv);
   error values are Excel's (`#DIV/0! #VALUE! #REF! #NAME? #N/A #NUM!`) plus
   `#ERROR!` for a formula that does not parse; a cycle is `#REF!` with
   `detail` naming it.
3. **Routes:** `POST canvas/create {kind:'sheet'}` (empty workbook when no
   content); `POST canvas/import {session, name, data(base64), title?}` →
   `{canvas}` (.xlsx/.csv/.tsv, ≤ 25 MB); `POST canvas/rename {session, id,
   title}` → `{canvas}` (frame `action:'rename'`); `GET canvas/:id/export?
   format=xlsx|csv&sheet=` for a sheet (other formats 400).
4. **Tool `Canvas`:** `create {kind:'sheet', tabs?, range?, values?|cells?}`,
   `read {id, sheet?, range?}` (compact table, not the JSON), `set_cells`,
   `format_cells {range, style, layout:{widths, freeze, filter, conditional,
   chart}}`, `add_sheet` (also `add_tab` on a sheet), `grid_op {operation:
   {type: insert_rows|delete_rows|insert_cols|delete_cols|sort|fill_down}}`,
   `import {path}`, `export {format: xlsx|csv}`; `update/edit/write_section`
   on a sheet are refused with the right action.
5. **Host (UI):** `CanvasKind` gains `'sheet'`, `ExportFormat` gains
   `'xlsx'|'csv'`; optional `host.rename(id, title)` and
   `host.importSheet({name, data})`; `host.create` takes `kind`. A sheet opens
   in `SheetEditor` (the card shows a row preview and a "sheet" badge).
6. **Artifacts:** `GET artifacts/list?session=` → `{artifacts:[{key, kind:
   'document'|'sheet'|'code'|'image'|'file'|'export', source:'canvas'|'file'|
   'attachment', id, title, ext?, bytes?, updatedAt, topic, uploaded?}]}`
   newest first (an export whose name is a canvas's file name gets
   `kind:'export'` and that canvas's title as `topic`); `GET artifacts/file?
   session=&path=` (inside the session's artifacts folder only); `POST
   artifacts/rename {session, path, name}`.

**Engine, 2026-10-03 (round 3 — document types).** Additive; uses the UI's
round-3 theme and block names below as written.

1. **Templates are now document types** (`src/canvas/doc-types.ts`, data):
   the ten round-2 ids keep working, joined by `whitepaper`, `research-paper`,
   `technical-writeup`, `financial-report`, `case-study`, `risk-assessment`,
   `postmortem`, `cover-letter`, `email`, `press-release`, `sop`, `nda`,
   `contract`, `confidential`, `user-stories`, `api-docs`, `release-notes`,
   `user-manual`, `architecture-design`, `flow-diagram`, `test-plan`,
   `technical-proposal`, `sow`, `rfp`, `invoice`, `quote`, `boq`,
   `marketing-brief`, `pitch-outline`, `business-plan`, `cv` (aliases such as
   `resume`, `prd`, `minutes`, `statement-of-work` resolve). Each sets
   `docSettings.theme` (a round-3 theme id) and its page setup.
2. **`GET canvas/templates`** → `{templates:[{id, title, description, aliases,
   sections:[{id, heading, intent, visuals?}], docSettings, words:[min,max],
   visuals}]}` — `visuals` are block names (`table`, `mermaid`, `chart`,
   round-2 infographics, round-3 document blocks). `POST canvas/create
   {template}` accepts any id or alias.
3. **`outline` picks the type from the title when it is obvious** (one type
   matches, or one match contains the others — "Cover letter" over "letter")
   and applies its look; `create` does the same for the look only. A title
   naming a marking ("Confidential: …") adds `classification` + `watermark`.
4. **The `outline` result carries a short writing brief** for the type
   (length range, which block goes in which section with its one-line syntax,
   no invented numbers, `[To confirm: …]` for missing details). It is not in
   the system prompt. The tool's `template` field lost its enum (ids or names
   are resolved; an unknown one lists the ids).

**UI + exports, 2026-10-03 (round 3 — "Docs 2": page width, document themes,
document blocks).** Additive; nothing above changes meaning. Parsers,
serialisers, totals maths, theme tables and the HTML for every block below live
in **`shared/ui/canvas/doc-blocks.ts`** and **`shared/ui/canvas/doc-themes.ts`**
(DOM-free; the engine's HTML/PDF/DOCX writers import them, so the app and every
export read one syntax). Engine-side document types / templates / agent
guidance: please use these names; a template may set `docSettings.theme`.

1. **`docSettings` gains** (all optional; cleaned by `src/canvas/doc-settings.ts`):
   - `theme`: `report | research | letter | memo | cv | proposal | invoice | sop |
     legal | spec | release-notes | minutes | case-study | press-release | risk |
     confidential` (absent = the plain default look). A theme sets typography,
     accent, heading style, header/footer/cover variant and table style, and
     supplies *defaults* for other settings (e.g. `confidential` → watermark +
     classification; `research` → serif; `letter` → wide margins). Stored
     values always win over a theme's defaults. Aliases accepted on write:
     `whitepaper→report`, `academic|paper→research`, `resume→cv`,
     `sow|rfp→proposal`, `quote|boq→invoice`, `nda|contract→legal`,
     `prd|api|technical→spec`, `changelog→release-notes`,
     `meeting-minutes→minutes`, `press→press-release`, `risk-assessment→risk`.
   - `accent`: `#RRGGBB` — overrides the theme's accent colour.
   - `classification`: text (≤ 40 chars) for a banner at the top and bottom of
     every page (e.g. `CONFIDENTIAL`, `INTERNAL`).
   - `pageWidth`: `narrow | normal | wide | full` — the editor's page width
     only (exports use the page size). Absent = Normal in the side panel,
     Wide in full screen.
2. **New fenced blocks** (JSON bodies unless noted, lenient like round 2: an
   array alone means the list field; unknown keys ignored):
   - ```` ```signature ```` — `{"parties":[{"label":"For the Client",
     "name":"Jane Doe","title":"CEO","date":""}]}` → signature lines, 1–4
     side by side.
   - ```` ```keyvalue ```` (aliases `kv`, `info`, `details`) — `{"title":"optional",
     "items":[{"key":"Invoice no.","value":"INV-0042"}]}`; a plain object
     `{"Invoice no.":"INV-0042"}` is also read.
   - ```` ```lineitems ```` (aliases `boq`, `invoice`, `quote`, `pricing`) —
     `{"currency":"GBP","taxRate":20,"taxLabel":"VAT","discount":"10%"|50,
     "items":[{"item":"Design","description":"optional","qty":2,"unit":"day",
     "rate":650}, {"section":"Phase 2"}]}`. Amount = qty × rate per row
     (rounded to the currency's minor unit); subtotal, discount, tax on the
     discounted subtotal, total — **computed, never typed**. A row with only
     `section` is a group heading. `qty` defaults to 1.
   - ```` ```riskmatrix ```` (alias `risks`) — `{"risks":[{"id":"R1",
     "title":"Supplier delay","likelihood":4,"impact":3,"owner":"",
     "mitigation":""}]}`; likelihood/impact 1–5 or words (`rare … almost
     certain`, `insignificant … severe`, `low|medium|high`). Score = L × I;
     rating Low ≤ 4, Medium ≤ 9, High ≤ 16, Critical above. Renders a 5×5 heat
     map with the ids placed, then the register sorted by score.
   - ```` ```actions ```` (alias `action-items`) — `{"items":[{"action":"…",
     "owner":"…","due":"…","status":"open|in progress|done|blocked"}]}`.
   - ```` ````columns ```` — **Markdown body**, columns separated by a line
     `+++`; info string `columns sidebar` (narrow shaded left column, for a CV),
     `columns sidebar-right`, or `columns` (equal). Use four backticks so the
     columns may contain fenced blocks.
   - ```` ```cover ```` (alias `hero`) — `{"kicker":"PROPOSAL","title":"…",
     "subtitle":"…","meta":["Prepared for Acme","3 October 2026"],
     "pageBreak":true}` → a title band in the text (unlike `docSettings.cover`,
     which is its own page).
   - ```` ```meta ```` (alias `byline`) — `{"items":["Jane Doe","3 October 2026",
     "v1.2"]}` or `{"author":"…","date":"…","version":"…","status":"Draft"}`
     → one muted line under the title.
   - ```` ```references ```` (aliases `footnotes`, `bibliography`) —
     `{"items":[{"text":"Smith, J. (2024). Title. Journal.","url":"optional"}]}`
     or an array of strings → a numbered list `[1] …`.
   - **Icon callouts**: the callout info string takes `icon=<name>` —
     ```` ```callout warn icon=shield ````. Names: `info, warning, check, tip,
     shield, lock, clock, flag, star, money, user, calendar, doc, link, alert`.
     An icon-less callout keeps its type's icon.
3. **Card grids** (stats, comparison, steps) lay out with auto-fit and a
   minimum tile width wide enough for the longest unbroken word of a value —
   values wrap only at spaces, never mid-word, in the app and every export.
4. Plain text inside block fields may use inline Markdown (`**bold**`,
   `*italic*`, `` `code` ``, `[link](https://…)`); nothing else is interpreted.

**Engine, 2026-09-30 (round 2 — Docs parity: visuals, TOC, document setup,
infographics, templates).** Additive. The UI renders the new blocks in the app;
the engine renders them in every export.

1. **Block syntax the renderer must understand** (all are fenced blocks unless
   noted; JSON bodies, lenient: an array alone means `items`):
   - Charts ```` ```chart ```` / `echarts` (ECharts option JSON, as in chat),
     Mermaid ```` ```mermaid ```` (and `diagram`, `flowchart`, `sequence`,
     `gantt`), maths `$$ … $$` blocks, ```` ```math ```` fences, and inline
     `$…$` — unchanged from the chat.
   - ```` ```stats ```` — KPI tiles: `{"items":[{"value":"$1.2M","label":"Revenue",
     "delta":"+12%","trend":"up"|"down"|"flat"}]}` (1–6 tiles; `trend` defaults
     from the sign of `delta`).
   - ```` ```timeline ```` — `{"items":[{"date":"Q1 2026","title":"Kick-off",
     "text":"optional"}]}`.
   - ```` ```steps ```` (alias `process`) — `{"items":[{"title":"Plan",
     "text":"optional"}]}`, numbered in order.
   - ```` ```comparison ```` — `{"columns":[{"title":"Option A","items":["…"],
     "highlight":true, "footer":"optional verdict"}]}`, 2–4 columns.
   - ```` ```callout info|warn|success ```` — the body is **Markdown**, the
     type is the second word of the info string (default `info`); an optional
     first line `**Title**` is the title. JSON `{"type","title","text"}` also
     accepted.
   - **Table of contents**: a line `<!-- aico:toc -->` (own paragraph) → a
     contents list generated from headings H1–H3 (Word: H1–H4 via a real TOC
     field). Plain viewers ignore it.
   - **Images with size, alignment, caption**: `![alt](src "Caption"){width=60% align=center}`
     — the title is the caption; the Pandoc-style attribute block directly
     after the image carries `width` (`%` or `px`) and `align`
     (`left|center|right`). A paragraph holding only the image is a figure.
     The UI should hide the `{…}` text when rendering.
2. **`docSettings`** on the canvas (absent = defaults):
   `{pageSize:'A4'|'Letter', orientation:'portrait'|'landscape',
   margins:'normal'|'narrow'|'wide' | {top,right,bottom,left} (mm),
   font:'sans'|'serif', header?:string, footer?:string, pageNumbers:boolean,
   toc:boolean, watermark?:string, cover?:{enabled:boolean, title?, subtitle?,
   author?, date?, logo?(data URL or project path)}}`. Defaults: A4,
   portrait, normal (25.4 mm), sans, pageNumbers true, toc false, no cover.
   `header`/`footer` may use `{title}`, `{date}`, `{page}`, `{pages}`.
   - HTTP: `POST canvas/settings {session, id, settings}` (merged; `null`
     clears a key) → `{canvas}`; also returned by `canvas/get` as
     `canvas.docSettings`. A `canvas` frame with `action:'settings'` announces it.
   - Export overrides without saving: `GET canvas/:id/export?…&toc=1` and
     `&settings=<URL-encoded JSON>` (merged over the stored settings).
   - Tool: `settings {id, settings}`; `export {…, toc?, settings?}`;
     `outline {…, template?, settings?}`.
3. **Templates** (`outline {template}`): `report`, `proposal`,
   `project-brief`, `memo`, `letter`, `meeting-minutes`, `spec`, `policy`,
   `one-pager`, `research-summary`. Each supplies sections (used when the call
   gives none) and `docSettings` defaults. `GET canvas/templates` →
   `{templates:[{id,title,description,sections,docSettings}]}` for a
   "New from template" menu.
5. **UI round-2 item 7 ACCEPTED:** `POST canvas/create {session, title,
   kind?, content?, tabs?:[{title,content}], template?, settings?}` → `{canvas}`
   (author `user`, announced as `create`). With `template` and no `content`
   it starts as that template's outline (pending blocks, TOC marker when the
   template has `toc`) with the template's `docSettings`. Also: exports read
   the editor's alternate spellings (GitHub alerts `> [!WARNING]` → callouts,
   `#aico:w=60,align=center` image fragments). Not supported by the engine:
   `pageSize: 'Legal'` and `font: 'mono-headings'` (cleaned to the defaults).
4. **Export fidelity**: charts/diagrams/maths render to PNG (2×) in .docx and
   inline SVG/PNG in HTML/PDF; when no browser (or no built renderer page) is
   available they become a labelled placeholder with the source. PDF TOC
   page numbers come from a second print pass (see ADR 0008 addendum).

**Engine, 2026-09-30 — all seven UI requests below are ACCEPTED as written**,
plus these clarifications (additive; nothing in the contract is removed):

- **Version aliases.** `doc.content` and `doc.version` are read aliases of the
  first tab's `content`/`version`. `doc.revision` (new) is a doc-wide counter
  bumped on *any* change (content of any tab, tabs added/renamed/deleted,
  title). Every content write checks the **tab's** `version`.
- **`versions[]` entries carry `tab`** (the tab id; legacy entries without it
  are `t1`). The cap (50) applies per tab. `POST canvas/restore` takes `tab?`.
- **Pending block attributes:** `id`, `intent`, optional `heading`. `outline`
  writes only the pending line (no heading line above it); the renderer shows
  `heading` on the placeholder card. Attribute values are HTML-entity encoded
  (`&quot; &amp; &lt; &gt;`, and `--` as `-&#45;`), so decode entities.
- **`outline` sections may name a tab:** `sections[].tab` (tab title or id,
  default the first tab).
- **Section end:** a heading section also ends at the next pending block (so
  a written section never swallows the placeholders after it).
- **`write_section` without a leading heading:** for a pending block with a
  `heading`, `## heading` is prepended; for a heading-addressed section the
  original heading line is kept and only the body is replaced.
- **Written sections stay addressable by id:** each tab keeps
  `sectionIds?: Record<id, headingText>` so `write_section {section:"s2"}`
  still works after s2 was filled (it resolves to the heading).
- **Stream frames** (all on the session stream):
  `canvas` (existing; now also carries `tabId`, `tabVersion`, `revision`, and
  `action` may be `'tabs'`), `canvas-activity {canvasId, tabId, section?,
  heading?, status, by:'agent'}` (`section` omitted for whole-tab
  `update`/`edit` when the passage spans sections), and `canvas-comments
  {canvasId, sessionId}`.
- **Comment objects** may carry `orphaned?: boolean` and `askAgent?: boolean`.
  Comment POST body: `{session, tabId, anchor, body, askAgent?}`; a body
  containing `@AICO` (case-insensitive) counts as `askAgent: true`. A user
  *reply* containing `@AICO` also asks the agent.
- **Tabs route:** `POST canvas/tabs {session, id, op:'add'|'rename'|'delete',
  tab?, title?, content?}` → `{canvas}` (delete refuses the last tab; deleting
  a tab drops its comments).
- **Export route** also accepts `?token=` like the other GET routes so a plain
  `<a href download>` works; response has `Content-Disposition: attachment`.
- **`canvas-comments` frame** carries `{sessionId, canvasId, commentId,
  action:'add'|'reply'|'resolve'|'reopen', author, askAgent?}`. POST comment /
  reply responses include `asked: boolean` (a turn was started or queued).
- **`GET canvas/get?light=1`** now returns each tab's current version entry
  (one per tab) rather than a single entry.
- **Heads-up on the "writing here" marker:** `writing` is emitted when the
  tool call *executes*, i.e. after the model has finished generating the
  section's text (no provider streams tool arguments to the engine yet), so
  `writing` → `done` is milliseconds apart. A marker that should be visible
  while the model composes can use: a turn is running (`turn-start` without
  `turn-end`) AND the canvas has pending blocks → mark the first pending block
  as "AICO is writing here" (the tool description tells the agent to write
  them in order); clear it on `canvas-activity done` / `turn-end`.

## Contract

- Storage stays Markdown (versioned, find/replace-safe). `CanvasDoc` gains
  `tabs: {id, title, content, version}[]` — legacy docs migrate to one tab
  `t1` whose content is the old `content`; `content` remains a read alias of
  the first tab for old clients. Every write is per tab and version-checked as
  today (409 with latest on conflict).
- **Pending blocks** are Markdown lines
  `<!-- aico:pending id="s2" intent="Goals: the three outcomes" -->` (one per
  line, own paragraph). Renderers show them as placeholder cards; plain
  Markdown viewers ignore them.
- **Sections** = a heading plus everything until the next heading of the same
  or higher level, OR a pending block. Addressed by pending `id`, or by exact
  heading text.
- Tool `Canvas` new actions (old ones keep working):
  - `outline` {title, kind:'document', tabs?:[{title}], sections:[{id, intent, heading?}]}
    → creates the doc with pending blocks;
  - `write_section` {id, tab?, section (pending id or heading), content
    (Markdown incl. its heading), version} → replaces exactly that section,
    version-checked;
  - `add_tab` {id, title, content?}; `rename_tab`;
  - `comments` {id} (list open comments);
  - `reply_comment` {id, commentId, body, resolve?};
  - `export` {id, format:'md'|'docx'|'pdf'|'html', tab?} → writes the file into
    the session workspace (or a given path inside it) and returns the path.
  - The tool description teaches the flow: for long documents call `outline`
    first, send the user a one-line progress note, then `write_section` per
    section in order; never paste the document into chat.
- **Stream events** (on the session stream; durable ones via the existing
  canvas event path, ephemeral via the live channel):
  - `canvas-activity` {canvasId, tabId, section, status:'writing'|'done',
    by:'agent'} emitted when `write_section`/`update`/`edit` starts and ends
    (start = when the tool call begins; includes the section's heading/id);
  - the existing canvas-updated event carrying tab + version.
- **Comments**: stored with the canvas (not in the Markdown):
  `{id, tabId, anchor:{quote, prefix, suffix}, body, author:'user'|'agent',
  createdAt, replies:[{id, body, author, createdAt}], resolved}`.
  HTTP (behind the existing token, under the existing canvas routes):
  `GET/POST /api/canvas/:id/comments`,
  `POST /api/canvas/:id/comments/:cid/replies`,
  `POST /api/canvas/:id/comments/:cid/resolve`.
  When the user adds a comment that addresses the agent (`@AICO`, or an
  "Ask AICO" flag on the comment), the engine submits a turn to the canvas's
  session: "The user commented on '<quote>': <body>" so the agent replies with
  `reply_comment` and/or edits. Comments are re-anchored after edits by
  quote/prefix/suffix and marked orphaned when the quote is gone.
- **Export**: Markdown (pending blocks stripped), HTML (chat renderer style,
  standalone file with inline CSS), DOCX (headings, paragraphs,
  bold/italic/code, links, lists incl. nested and checklists, tables, code
  blocks, images from data URLs or workspace paths, block quotes), PDF (the
  HTML export printed with playwright-core; clear error when no browser).
  HTTP: `GET /api/canvas/:id/export?format=…&tab=…` streams the file with a
  download filename.

## UI requests (from the UI side — engine, please confirm or amend above)

What the UI in `shared/ui/canvas/*` + `web/src/api.ts` assumes where the
contract is silent. The UI degrades gracefully if a route is missing (404 →
the feature hides or falls back), so none of these block the engine.

1. **Session on every route.** The existing routes take `session` (query on
   GET, body on POST). The UI calls the new ones the same way:
   `GET canvas/<id>/comments?session=…`, `POST canvas/<id>/comments
   {session, tabId, anchor, body, askAgent?}`, `POST
   canvas/<id>/comments/<cid>/replies {session, body}`, `POST
   canvas/<id>/comments/<cid>/resolve {session, resolved?: boolean}` (default
   true; false re-opens), `GET canvas/<id>/export?session=…&format=…&tab=…`.
   Comment list response: `{comments: Comment[]}` where each comment may carry
   `orphaned?: boolean`.
2. **Per-tab save.** `POST canvas/save {session, id, tab?, content,
   baseVersion}` where `baseVersion` is **that tab's** `version`; omitted
   `tab` = the first tab. 409 body `{conflict:true, canvas}` as today.
3. **Tabs from the editor (the person, not only the tool).** `POST canvas/tabs
   {session, id, op:'add'|'rename'|'delete', tab?, title?, content?}` →
   `{canvas}`. Delete refuses the last tab. Until it exists the tab menu shows
   the tool-created tabs read/write and disables add/rename/delete.
4. **Anchor text is rendered text.** `anchor.quote/prefix/suffix` are taken
   from what the person selected on the rendered page (no Markdown marks), so
   `**bold** word` is anchored as `bold word`. Re-anchoring on the engine side
   should match against a plain-text projection of the Markdown (strip marks,
   collapse whitespace) — the UI's matcher is `locateAnchor` in
   `shared/ui/canvas/comments.ts` (whitespace-insensitive, prefix/suffix
   scored) if you want to share it.
5. **Live comment replies.** Please emit a stream frame
   `canvas-comments {canvasId, sessionId}` whenever a comment or reply is added
   or resolved (by anyone). Until it exists the UI re-reads comments on every
   `canvas`/`canvas-activity` frame and polls every 4 s while a comment that
   asked AICO has no agent reply (2 min cap).
6. **`canvas-activity` frame shape.** The UI reads `{canvasId, tabId?,
   section?, status, by}` from the session stream as event type
   `canvas-activity`; `section` may be a pending id (`s2`) or heading text, or
   absent for a whole-document `update`/`edit` (the UI then shows the label at
   the top).
7. **Version history per tab.** If `versions[]` entries gain a `tab` field the
   history panel filters by the open tab; without it the panel shows all.

## UI requests, round 2 — visual blocks, images, TOC, export settings (UI side, 2026-09-30)

> **Reconciled (UI, 2026-09-30, after reading the engine's round 2 above):**
> the UI now **writes the engine's syntax** — images `![alt](src "Caption"){width=60% align=center}`,
> ```` ```callout info|warn|success ```` fences, JSON bodies for `stats`/`timeline`/`steps`/`comparison`
> (`delta`/`trend`, `date`/`text`, `columns[].footer/highlight`), `POST canvas/settings {session,id,settings}`,
> `pageSize` A4|Letter, `font` sans|serif — and still **reads** the forms below (GitHub alerts,
> line-based bodies, the `#aico:` fragment) so either spelling renders. Items 1–4 and 6 below are
> therefore superseded by the engine's round 2. Item 7 (`POST canvas/create`) is accepted
> above; the template picker sends `{title, content}` with the UI's own skeleton
> (`shared/ui/canvas/templates.ts`) and falls back to asking the agent to run
> `outline {template}` (engine ids) on an engine without the route. Parsers: `shared/ui/canvas/visual.ts`.

Syntax the editor writes (original proposal, kept for the record). Every choice degrades to readable plain Markdown in
a viewer that knows nothing about AICO. Pure parsers/serialisers for all of
them live in `shared/ui/canvas/visual.ts` (DOM-free, Node-importable) — the
engine may import them for export rather than re-implement.

1. **Images with size, alignment, caption.** `![alt](src#aico:w=60,align=center "Caption")`
   — a URL fragment `#aico:` + comma-separated `key=value` (`w` = width in
   percent of the text column, 10–100; `align` = `left|center|right|full`),
   and the Markdown **title** is the caption. Viewers ignore the fragment and
   show the image; the caption shows as a tooltip. Exporters: strip the
   fragment before resolving `src`; honour width/align; print the caption
   under the image. An image is its own paragraph (one line).
2. **Callouts** are GitHub alerts: `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` /
   `[!WARNING]` / `[!CAUTION]` on the quote's first line (UI labels: Info,
   Success, Important, Warning, Danger). Exporters: a tinted box with the label.
3. **Infographics** are fenced blocks with a line-based body (pipes), readable
   as text anywhere:
   - ```` ```stats ```` — one KPI per line: `Label | Value | Note?` (note may
     start with `+`/`-` for a trend).
   - ```` ```timeline ```` — `When | Title | Detail?` per line.
   - ```` ```steps ```` — `Title | Detail?` per line (numbered process).
   - ```` ```comparison ```` — columns: a line `## Column title` starts a
     column, `- item` lines are its points (optional `> note` line under the title).
   Exporters: stats → a row of tiles (DOCX: a 1-row table), timeline → a
   dated list/table, steps → a numbered list with bold titles, comparison → a
   table with one column per `##`.
4. **Charts** stay the chat's ```` ```chart ```` fence (ECharts option JSON).
   The editor writes a restricted shape it can read back: `xAxis.data`
   categories + `series[{name,type:'bar'|'line',data,areaStyle?}]`, or one
   `pie` series with `data[{name,value}]`, plus `title.text`. Exporters: the
   PDF/HTML route can render ECharts; DOCX may use a table of the data with
   the chart title (or a rendered PNG if you have one).
5. **Table of contents:** `<!-- aico:toc -->` on its own line. The page renders
   the tab's headings there, live and clickable. Exporters: the heading list
   (DOCX: a TOC field or a static list); plain viewers show nothing.
6. **Export settings — please add.** `doc.docSettings?: DocSettings` persisted
   with the canvas, set by `POST canvas/settings {session, id, docSettings}` →
   `{canvas}` (no version check needed; bumps `revision`), and honoured by
   `GET canvas/<id>/export?…&settings=<url-encoded JSON>` (query wins over the
   stored value, so the dialog can preview without saving):
   ```ts
   interface DocSettings {
     pageSize?: 'A4' | 'Letter' | 'Legal';           // default A4
     orientation?: 'portrait' | 'landscape';
     margins?: 'narrow' | 'normal' | 'wide';        // 12.7 / 25.4 / 38.1 mm
     header?: string; footer?: string;             // text; `{title}` `{date}` placeholders
     pageNumbers?: boolean;
     cover?: { enabled: boolean; title?: string; subtitle?: string; author?: string; date?: string; logo?: string /* data URL */ };
     toc?: boolean;                                 // a TOC after the cover
     watermark?: string;                            // e.g. "CONFIDENTIAL"
     font?: 'serif' | 'sans' | 'mono-headings';     // body/heading style
   }
   ```
   Until the route exists the UI keeps the settings per canvas in local
   storage and still sends `settings=` on export.
7. **Create a document from the editor — please add.** `POST canvas/create
   {session, title, kind:'document', content, tabs?:[{title, content}]}` →
   `{canvas}` (author `user`, announced like any create). Used by the
   template picker (report, proposal, brief, memo, letter, minutes, spec/PRD,
   policy/SOP, one-pager, research summary — `shared/ui/canvas/templates.ts`).
   Until it exists the picker asks the agent to create it from the template.
