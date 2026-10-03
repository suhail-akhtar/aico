# 0023 — Presentations: structured slides, one layout engine, a hand-written PowerPoint writer

- **Status:** Accepted 2026-10-03 (owner asked for presentations: "a very robust approach and system"; no new runtime dependency)
- **Date:** 2026-10-03
- **Deciders:** owner (+ engine author)
- **Supersedes / related:** [0008](0008-canvas-docs-export.md) (hand-written OOXML, Chrome for PDF), [canvas-docs-contract.md](../canvas-docs-contract.md)

## Context

AICO Docs writes documents and AICO Sheets writes workbooks; there was no way
to make a presentation. A deck is not a document with page breaks: the person
and the agent both need to change *content* while every slide keeps a
designed, consistent layout, and the file people actually send is a `.pptx`
that must open in PowerPoint without a repair prompt, with text they can edit.

Three things go wrong in agent-made decks, and the design is shaped by them:

1. **Free positioning.** A model placing boxes by coordinates produces
   overlapping text, ragged margins and a different grid on every slide.
2. **Overflow.** Text that does not fit is the most common defect, and it is
   invisible to the model unless something measures it.
3. **Pictures of slides.** Exporting slides as images (or HTML screenshots)
   gives a file nobody can edit.

## Decision

1. **A deck is a canvas kind (`deck`)** whose one tab holds the deck as JSON
   (`shared/ui/canvas/deck-model.ts`) — versioned, conflict-checked and
   streamed exactly like a sheet's workbook (`canvas/store` validates every
   write parses as a deck). No new store, route family or event channel.
2. **Content is structured blocks, never coordinates.** A slide names one of
   15 layouts (title, section, bullets, two-column, comparison, image-text,
   image, chart, diagram, table, kpi, quote, timeline, agenda, closing) and
   fills that layout's fields (title, bullets, columns, chart data, mermaid
   source, table rows, KPIs…), plus speaker notes and a `none|fade`
   transition.
3. **One layout engine places everything** (`deck-layout.ts`): a 16:9
   (960×540 pt) or 4:3 (720×540 pt) canvas, a 12-column grid inside safe
   margins, and text **fitted by measurement** — per-glyph advance widths of
   the theme fonts (`deck-fonts.ts`, measured once from the installed fonts)
   drive word wrap, and a box shrinks its font in steps down to a floor; below
   the floor it is reported as an overflow. The engine's output (positioned
   frames with explicit font sizes and exact line spacing) is consumed by
   *both* renderers — the HTML one (editor, present mode, PDF and PNG) and the
   PowerPoint writer — so the app, the PDF and PowerPoint agree.
4. **Validation is enforced in the tool, not the prompt** (principle 6): every
   Canvas deck write returns the layout engine's problems — missing titles,
   too many bullets, text shrunk to the floor or overflowing, empty charts,
   tables too big — for the model to fix.
5. **Themes are data** (`deck-themes.ts`, 12 themes): font pair, palette,
   title/section treatment, accent motif, chart palette. A **deck type**
   (`deck-types.ts`: pitch, technical briefing, project status, training,
   sales proposal, board update, conference talk) supplies the skeleton
   outline, default theme, bullet limits and a short writing brief returned
   only when a deck is created, as document types do.
6. **`.pptx` written by hand with `fflate`** (`src/canvas/deck-pptx.ts`), as
   ADR 0008 did for `.docx`: a theme part whose colour and font schemes are
   the deck theme (so PowerPoint's Design → Variants recolour and refont the
   deck — text and shapes use `schemeClr` and `+mj-lt`/`+mn-lt`), a slide
   master with layouts, native text boxes (titles as title placeholders),
   shapes, `a:tbl` tables, **native charts** (`c:chart` parts with cached
   values and an embedded workbook, so *Edit Data* works), diagrams as 3×
   PNG pictures, speaker notes in `notesSlides`, fade transitions.
7. **PDF and PNG** are the HTML renderer printed and photographed by the
   installed Chrome/Edge (`playwright-core`, as ADR 0008). Mermaid is drawn by
   the existing `web-dist/export-render.html` page, themed by an `%%{init}%%`
   directive generated from the deck theme.

## Alternatives considered

| Option | Why not |
|---|---|
| `pptxgenjs` | A new runtime dependency (~2 MB with jszip) for one writer; it positions in inches like we would anyway, and gives no layout engine or text fitting — the hard part |
| Freeform absolute positioning for the model | The overlap/margin/overflow defects above; nothing to validate against |
| Markdown with `---` slide breaks (Marp/reveal style) | No place for layouts, chart data, notes or per-slide transitions without inventing syntax inside Markdown; exports would be pictures of HTML |
| Slides as images in the .pptx | Not editable — the one thing a .pptx is for |
| PowerPoint's own autofit (`normAutofit`) only | PowerPoint recomputes it only when text is edited; the file would open overflowing. We compute sizes and keep `normAutofit` for later edits |
| Measuring text in a browser at write time | The tool must validate without a browser; measured tables are deterministic and testable |

## Consequences

- **Good:** the app, PDF and PowerPoint show the same slide; text is editable
  and themed in PowerPoint; overflow is caught before the person sees it; no
  new dependency.
- **Bad:** layouts are a fixed catalogue — a slide that needs a bespoke
  arrangement is not expressible (by design). Fonts outside the measured set
  are measured with a generic fallback (slightly conservative). Charts beyond
  bar/column/line/area/pie/doughnut/stacked are drawn as pictures.
- **Verified:** `scripts/deck-test.mjs` (layout fitting, every XML part
  parses, content types and relationships resolve, notes, theme mapping);
  during development the decks were opened in PowerPoint through COM and
  exported to PDF/PNG to inspect.
