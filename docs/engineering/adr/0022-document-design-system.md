# 0022 — Lay documents out by family: blueprints drive the brief, the .docx and the PDF

- **Status:** Accepted
- **Date:** 2026-10-03
- **Deciders:** owner (+ authors)
- **Supersedes / related:** extends [0008](0008-canvas-docs-export.md) (export with the renderer's parser and a hand-written OOXML writer); themes in `shared/ui/canvas/doc-themes.ts`

## Context

The owner exported a 55-page *SharePoint Server Subscription Edition —
Technical Proposal* to Word and called it "not well formatted … every document
almost the same format and design". The file showed why, part by part:

- `styles.xml` was 8 KB; there was **no Heading 1** — the sections were
  Heading 2 (the canvas title is the title, so sections are `##`) with
  "1.", "2.4" typed into the heading text;
- the cover was a purple box in the top-left of an otherwise blank page, with
  no client, version or document control;
- the TOC field was never updated, so every entry said page **1**;
- 56 tables, one style, **equal column widths** — "FR-03" as wide as the
  requirement beside it, "Office Online Server" broken over three lines;
  `Table: …` captions printed as plain paragraphs;
- two images in an architecture proposal; and every diagram in any .docx was
  a ~300 px thumbnail (the renderer's SVG was `width="100%"` inside a
  `fit-content` box, which resolves to the 300 px default of a replaced
  element);
- serif headings over a sans body with no reason, no running header, no
  revision or approval page — and the same layout for a letter, a policy and
  a proposal, only the colour changed.

Themes (round 3) are colour and ornament. The missing thing was *layout by
kind of document*.

## Decision

1. **Blueprints** (`shared/ui/canvas/doc-blueprints.ts`): eleven families —
   proposal/tender, technical design, report, policy/SOP, correspondence,
   academic, CV, marketing, legal, manual, transactional (+ `general`) — each
   owning a set of the 41 document types. A blueprint states the cover layout
   (`band` full-bleed top or bottom, `title-block`, `masthead`, `academic`,
   `none`), front matter (document-control page or inline box, approval roles,
   distribution, contents on its own page), page margins, a typeface pairing
   of faces that ship with Windows/Office (one Word name + a CSS stack starting
   with the same font), point sizes, the numbering scheme (`decimal` 1 · 1.1,
   `legal` 1. · 1.1 · (a), `none`), whether sections start a page, running
   header/footer slots (`{title}`, `{client}`, `{reference}`, `{version}`,
   `{status}`, `{classification}`, `{page}`, `{pages}`), captions, and the
   structure and visuals a reader of that family expects. Types store their
   id (`docSettings.docType`); a document with only a theme resolves its family
   from the theme. Enforced by `resolveBlueprint` and `resolveSettings`
   (family defaults sit under the theme's, which sit under the document's).
2. **The brief is built from the blueprint** (`doc-types` `writingNote`): the
   family's structure, the visuals it expects (a technical design: logical
   architecture, topology as `flowchart TB`, a sequence diagram, inventories,
   a decision table; a proposal: Gantt, RACI, pricing, risks), "never type
   numbers into a heading", and the caption rule. The technical-proposal
   template gained topology and RACI sections.
3. **One plan, two writers** (`src/canvas/doc-plan.ts`): heading levels are
   shifted so the top section is level 1, skipped levels closed, an opening H1
   that repeats the title read as the title; typed numbers ("2.4 ") removed
   when the export numbers (a number needs a dot — "3 Pillars" is a title);
   `Appendix A — …` lettered; Abstract/References unnumbered; `Table: …` /
   `Figure: …` paragraphs become numbered captions; table variant (grid,
   key-value, matrix), numeric columns, total row and **content-based column
   widths** (`doc-layout` `columnWidths`: the browser's auto-layout algorithm
   over measured text units); and whether the document is long enough for a
   cover page, a control page, contents and a page per section.
4. **The .docx** (`src/canvas/docx.ts`): Heading 1–4 linked to a multilevel
   list (`numbering.xml` abstractNum 10/11, numIds 900/901) with outline
   levels and keep-with-next; Title, Subtitle, TOC 1–3 (number and page tab
   stops), Caption, Appendix Heading styles; the cover as its own section
   drawn with **page-anchored text boxes** (a zero-margin table of exact-height
   rows was tried first; Word still reserved header/footer space and pushed
   the second row onto a page of its own); front matter as a section numbered
   i, ii; the body a section numbered from 1, its footer "Page X of
   SECTIONPAGES"; captions as `SEQ` fields; `tblHeader`, `cantSplit`, `dxa`
   widths; alt text; `core.xml` subject/keywords/version/status and `app.xml`.
   The TOC field is pre-filled with `PAGEREF` results **read from a printed
   layout** (the PDF engine, in a Word-like pass), and `updateFields` stays on.
5. **The PDF** (`src/canvas/export.ts`) follows the same plan: CSS margin
   boxes for the running header/footer (the cover gets none), named pages
   with counters reset after the cover and roman numbers in the front matter,
   the body's page count from the first pass, TOC page numbers from the first
   pass, headings grouped with the block they introduce (Chrome ignores
   `break-after: avoid` before a table), short tables kept whole, captions as
   `<caption>`, widows/orphans 3.
6. **The editor** sets the page in the family's faces and numbering through
   the same `resolveLook`/`themeAttrs`, and drops its numbering when the
   author typed numbers.

## Alternatives considered

| Option | Why not |
|---|---|
| More themes (a theme per type) | Colour was not the failure; 41 stylesheets would drift between Word and PDF, which is why themes are switches (round 3). |
| A real Word template (.dotx) per family | A binary per family to maintain, and the PDF would still need the same rules written again. Blueprints are data both writers read. |
| `docx` npm package | Rejected in ADR 0008 (size, one-way conversion); nothing here needs it. No new dependency was added. |
| Word's autofit for column widths | Only applies when someone opens the file and asks; a printed PDF never does. |
| Leave the TOC to `updateFields` | Word asks before updating, many viewers never do — the owner's TOC said "1" everywhere. Pre-filling and keeping the field gives both. |
| Exact page numbers from Word itself | Needs Word; the export runs on any machine with Chrome/Edge. The PDF pass is an estimate Word corrects on update/print. |
| Embed fonts | Licensing and size; Office and Windows faces are used instead, with CSS fallbacks. |

## Consequences

- **Good:** each family has its own front matter, type, numbering, running
  text and visuals; the owner's specific defects each have a test.
- **Bad / costs:** a .docx export with contents now prints the document once
  in Chrome for page numbers (~1–3 s); the export code grew (~1,000 lines).
- **Honest limits:** TOC pre-fill is Chrome's pagination in a Word-like pass,
  not Word's; Word re-computes on open/print. Wide diagrams (a 20-node
  left-to-right flowchart) are still small on a portrait page — the brief
  asks for `flowchart TB` and about a dozen nodes rather than the exporter
  rotating pages. No two-column layouts. Faces fall back on machines without
  Office. The heading/table keep groups are monolithic in Chrome, so a group
  is limited to a short block (≤ 12-row table, ≤ 10-item list, ≤ 1,200
  characters of prose).
- **Migration:** none. Existing documents resolve their family from the theme;
  documents without a theme use `general` (old look, but Heading 1 for top
  sections, captions and fitted tables). `cover: false` is now stored as
  `{enabled:false}`.

## Verification

- `scripts/doc-design-test.mjs` (part of `npm test`): families cover every
  type exactly once; briefs carry the family; column widths, variants, typed
  numbers, outline labels; the plan; every .docx XML part parsed with
  `@xmldom/xmldom`; styles, numbering, sections, captions, header/footer,
  properties; mammoth reads Heading 1; HTML captions and widths; with a
  browser, TOC page numbers and roman/arabic numbering read back from the PDF.
- `test-harness.mjs` export assertions updated for Heading 1, sections and
  SECTIONPAGES; `web/test-canvas.mjs` for the editor's faces and numbering.
- Live (2026-10-03): four families (technical proposal, SOP, campaign brief,
  service-desk report) exported through `exportCanvas` with an isolated store,
  rendered by Microsoft Word (COM, SaveAs PDF) and by Chrome, pages inspected;
  the pre-filled TOC matched Word's own page numbers on 21 of 22 entries
  (proposal), 6 of 6 (SOP) and 7 of 8 (report) — the misses one page out.
