# 0008 — Export canvases with the renderer's own Markdown parser and a hand-written OOXML writer

- **Status:** Accepted 2026-09-30 (owner approved building AICO Docs with .docx/PDF/Markdown export; no new runtime dependency)
- **Date:** 2026-09-30
- **Deciders:** owner (+ engine author)
- **Supersedes / related:** [docs/engineering/canvas-docs-contract.md](../canvas-docs-contract.md) (the engine/UI contract)

## Context

AICO Docs (the Canvas upgrade) must export a document as Markdown, standalone
HTML, Word (.docx) and PDF. The engine had no Markdown parser at runtime — the
web client renders with `react-markdown` + `remark-gfm` (devDependencies,
bundled by Vite). An export that parses Markdown differently from the renderer
produces a Word file that disagrees with what the person saw (loose vs tight
lists, lazy continuation, pipes in code spans, task items).

The brief allowed either the `docx` npm package (MIT) or writing the OOXML
with the existing `fflate` dependency "if that is smaller and robust".

## Decision

1. **Parse with the renderer's parser.** `src/canvas/markdown.ts` uses
   `mdast-util-from-markdown` + `micromark-extension-gfm` + `mdast-util-gfm`
   — the exact packages `react-markdown`/`remark-gfm` already pull in. They are
   declared as **devDependencies** and bundled into `dist/` by tsup (and into the
   desktop engine by esbuild), like the web client's copy; nothing new is
   installed for a user. Versions are the ones already in the lockfile.
2. **Write .docx by hand with `fflate`.** `src/canvas/docx.ts` emits
   WordprocessingML for the dozen elements a canvas has (Word's Heading 1–6
   styles, runs, hyperlinks, numbering with per-list restart, tables with a
   header row, code blocks, quotes, inline pictures) and zips it with the
   `fflate` already shipped.
3. **PDF = the HTML export printed by an installed Chrome/Edge** through
   `playwright-core` (already a dependency), found with VerifyApp's
   `findBrowser()`. No browser is downloaded; without one the export fails with
   a message naming docx/html. All network requests from the page are aborted.
4. **Images** come only from data URLs or files inside the session's project
   directory (≤ 15 MB, png/jpeg/gif/webp/svg; Word gets png/jpeg/gif); remote
   URLs are never fetched by an export.

Enforced by the `AICO Docs` block of `test-harness.mjs`: it unzips the .docx
and asserts `document.xml` (styles, numbering levels, table, hyperlink
relationship, drawings, no placeholders), checks the PDF has pages, and
round-trips the Markdown export.

## Alternatives considered

| Option | Why not |
|---|---|
| `docx` package | A new runtime dependency of roughly 1–2 MB unpacked for a one-way conversion needing a dozen element types; we would still have to parse Markdown ourselves and map mdast onto its object model |
| `html-to-docx` / `mammoth`-style conversion | converts HTML, not Markdown; heavier, and loses list semantics Word needs (numbering definitions) |
| A hand-written Markdown parser | disagrees with the on-screen renderer on exactly the edge cases people report |
| `marked` (already in the tree via mermaid) | a different grammar from the one the canvas renders with |
| Bundled Chromium for PDF | +150 MB download; VerifyApp already chose "use the installed browser" |

## Consequences

- **Good:** exports match the renderer; no new runtime dependency; docx opens
  in Word (checked by opening a generated file through Word's COM API and
  exporting it to PDF during development).
- **Bad / costs:** we own ~400 lines of OOXML. Features outside the list above
  (footnotes as real Word footnotes, math, SVG/WebP pictures in Word, page
  headers/footers) are not produced.
- **Honest limits:** nested ordered lists use Word's decimal / lower-letter /
  lower-roman scheme by level rather than "1." at every level; remote images
  appear only in the HTML export (as links), never in docx/PDF.
- **Migration:** none for users. `package.json` gains four devDependencies
  (`mdast-util-from-markdown`, `mdast-util-gfm`, `micromark-extension-gfm`,
  `@types/mdast`), all already present transitively.

## Addendum (same day) — visuals, TOC, document setup

- **Charts** render to SVG in Node with ECharts (already a runtime dependency)
  using the chat's own spec parser, theme and defaults; **Mermaid and KaTeX**
  (web-build-only dependencies) render in a second web-build page,
  `web-dist/export-render.html`, loaded by the same headless Chrome/Edge that
  prints PDFs through a request interceptor (every other request aborted).
  One browser launch per export, launched only when something uncached must
  be drawn; results cached in-process by a hash of kind + source. Without a
  browser or the built page, each visual is a labelled placeholder with its
  source. Two more devDependencies bundled at build: `micromark-extension-math`,
  `mdast-util-math` (the pair remark-math uses).
- **TOC**: Word gets a real `TOC \o "1-4" \h \z \u` field over bookmarked
  headings with `updateFields` so Word fills page numbers on open (it asks
  first). PDF page numbers use two print passes: pass one is read with
  `pdf-parse` (a runtime dependency) to find each heading's page after the
  TOC, pass two prints them; the numbers sit in fixed-width slots so they
  cannot reflow the pages.
- **Known limit:** Chromium's running header/footer applies to every page, so
  a PDF cover page carries the footer; the .docx cover does not (`titlePg`).

## Threat model

Inputs are the canvas Markdown (written by the agent or the person) and image
references in it. Risks: an image path escaping the project (blocked: resolved
against the project root, `..`/absolute outside refused), an export making the
engine fetch a URL (blocked: remote images never fetched; PDF page aborts every
non-`data:` request), XML injection into the .docx (all text escaped, forbidden
XML characters stripped), `javascript:` links (dropped in HTML; only http(s)
and mailto become Word hyperlinks).

## Verification

`npm test` (AICO Docs block) — docx structure, images inside vs outside the
project, PDF pages (or the no-browser message), md round-trip; live: a real
model turn exporting docx/pdf/md through the tool and the HTTP route.
