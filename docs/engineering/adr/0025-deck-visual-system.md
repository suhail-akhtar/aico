# 0025 — Deck visuals: infographics as native shapes, licensed pictures, icons, design briefs, rules in the validator

- **Status:** Accepted (2026-10-03)
- **Date:** 2026-10-03
- **Deciders:** owner (+ engine author)
- **Supersedes / related:** extends [0023](0023-presentations.md) (layouts plus fields, one layout engine, hand-written .pptx); uses [0006](0006-credential-broker.md) (stock keys), the SSRF policy of [0007](0007-ops-tools-and-dependencies.md) (`tools/ops/ssrf.ts`), [0017](0017-model-roles.md) (image model, via GenerateImage)

## Context

ADR 0023 decks were correct but plain: bullets, tables, a chart, a Mermaid
diagram. Commercial templates the owner showed rely on infographics (chevron
processes, cycles, pyramids, hexagon clusters, progress rings, KPI tiles, team
cards with round photos), on pictures (full-bleed backgrounds with an overlay,
side pictures, pictures cut into circles, hexagons or a diagonal) and on
icons, in light and dark variants with gradient accents. Three constraints from
0023 still hold: no free positioning by the model, nothing in PowerPoint that is
a picture of a slide, and every rule the deck depends on checked in code.

### Presentation practice encoded as rules (the validator)

Collected from the usual sources (Duarte's *slide:ology*, Reynolds' *Presentation
Zen*, Alley's assertion-evidence research, Tufte's data-ink principle, Microsoft's
PowerPoint accessibility guidance, WCAG 2.x), reduced to what code can check.
Where each lives:

| Rule | Check (severity) | Code |
|---|---|---|
| One idea per slide; ≤ 6 bullets (deck type sets fewer) | bullets over the type's limit (error); > ~40 words on a slide, scaled by the type (warn) | `deck-layout.ts` `checkBullets`, `deck-rules.ts` |
| Assertion titles, not labels | a content title of one or two words with no figure (warn, with an example) | `deck-rules.ts` |
| Body text readable at a distance | main text fitted below 18 pt at 16:9 (16 pt in columns and beside a picture) is an error: cut, split or `make_visual` | `deck-layout.ts` `sizeRule` |
| Labels in diagrams | infographic labels never below 12 pt (titles 13 pt); text that does not fit there is an error | `deck-infographics.ts` |
| A visual on most slides | runs of ≥ 3 text-only slides, and decks of ≥ 6 content slides under 50% visual (warn, names `make_visual`) | `deck-rules.ts` |
| Visual variety | > 3 consecutive slides on one layout or one infographic kind (warn) | `deck-rules.ts` |
| Rhythm | > 12 slides without a section divider (warn) | `deck-rules.ts` |
| Contrast (WCAG AA) | theme text roles ≥ 4.5:1 (error for a brand palette that breaks it); text on shapes picks the light or dark slot by measured contrast; accent label text falls back to the title colour under 3:1; gradient and accent fields are deepened (`lumMod`) until white keeps 4.5:1; text over photos sits on a scrim whose worst case (a white photo) is tested to keep 4.5:1 in every theme | `deck-themes.ts` `inkOn`/`themeContrastProblems`, `deck-layout.ts` `gradOf`/`SCRIM`/`scrimContrast` |
| Max two fonts | by construction: a theme is one heading and one body face; a brand font is accepted only from the measured set | `deck-model.ts` `toFonts` |
| 3–5 colours | infographic items cycle accents 1–5 only, in the same order on every slide | `deck-layout.ts` `KIT.accent` |
| Data-ink | no 3D chart types exist; single-series charts carry direct labels (0023); > 4 series or > 6 pie slices (warn) | `deck-rules.ts` |
| Pictures: alt text, credit, sharpness | missing alt text (error); a fetched picture without credit or licence (error); fewer than ~1.25 px per point after cropping to cover its slot (warn, with the size needed) | `deck-layout.ts` `imageChecks` |
| Alignment grid and margins | by construction: every infographic is laid out in the content area of 0023's grid | `deck-infographics.ts` |

Warnings are judgement calls a person may overrule; errors are what the agent
is told to fix ("FIX" lines) after every write.

## Decision

1. **An `infographic` layout and a parametric library** (`shared/ui/canvas/deck-infographics.ts`):
   25 kinds — process (chevrons), numbered arrows, cycle, semicircle, radial
   (petals), pyramid, funnel, hexagons, stairs, icon timeline, roadmap,
   numbered cards, versus, pros/cons, SWOT, 2×2 matrix, Venn, progress rings,
   KPI tiles, stat bars, team, quote with photo, numbered agenda, icon grid,
   before/after. A slide is `{kind, items:[{title, text?, value?, icon?, image?}], centre?, axes?}`;
   each kind is a function of its 2–8 items that places frames through the
   engine's own fitting helpers (handed over as a `Kit`, so the module imports
   only types). Item counts per kind and every label's fit are reported.
2. **Native PowerPoint shapes**: frames carry PowerPoint *preset* geometries
   (chevron, homePlate, hexagon, triangle, trapezoid, rightArrow, blockArc,
   donut, pie, diamond, roundRect…) with adjust values in slide units, rotation,
   flips and two-stop gradients; `deck-geometry.ts` computes each preset's
   outline with ECMA-376's formulas for the HTML renderer and the `a:avLst`
   values for the writer, so editor, PDF and PowerPoint agree. Freeforms
   (`a:custGeom`) only where no preset says it: icons, clipped art, the
   diagonal picture cut. Each infographic item's frames are one `p:grpSp`.
   Text stays separate text boxes inside the group (exact positions), editable.
3. **Pictures**: `image` gains `mask` (circle, rounded, hexagon, diagonal),
   `side`, `credit`, `license`, `sourceUrl`, `px`; title, section, closing and
   quote slides take one (full-bleed with a scrim, or a cut-out hero); a new
   `image-grid` layout. In PowerPoint a cut picture is a picture with that
   geometry (crop, recolour and replace still work).
4. **Where pictures come from, in order**: the person's or the project's files
   (copied into the media store so the editor can show them); a **licensed
   search** (`src/canvas/deck-image-search.ts`) — Openverse and Wikimedia
   Commons with no key, Pexels or Unsplash when the vault holds a credential
   named `pexels`/`unsplash` (resolved by the broker for that API's origin
   only); generation through the existing `GenerateImage` tool (costs money,
   reports it — asked through the agent, never silently); generated abstract
   art (`art:mesh|circles|waves|grid|blocks`) drawn as native shapes in the
   theme's gradient.
5. **The picture pipeline** (`src/canvas/deck-media.ts`): a URL is downloaded
   only if a search returned it (a registry of candidates under the media
   folder), so credit and licence are the provider's facts; licences are
   filtered on what the API returned (CC0, PD, CC BY, CC BY-SA; no NC/ND/fair
   use); every fetch goes through `decideTarget` with nothing vouching for
   private addresses, pinned to the checked address, every redirect re-checked,
   capped at 15 MB, PNG/JPEG/GIF by their bytes; stored by hash under
   `<AICO_HOME>/media/deck/`, named `/api/deck-media/<sha>.<ext>`, served by the
   engine (sandboxed CSP) and resolved by every exporter. The credit is drawn on
   the slide (small, in a corner the cut keeps) and written into the speaker
   notes with the source URL. Picker previews are fetched by the engine for
   search results only; the page never fetches a remote picture.
6. **Icons**: a curated 355-icon subset of Lucide (ISC; Feather-derived icons
   carry Feather's notice) vendored as normalised M/L/C/Z paths by
   `scripts/vendor-deck-icons.mjs` into `shared/ui/canvas/vendor/lucide/`
   (licence file beside it), searched by name, Lucide tags and a business
   synonym table (`deck-icons.ts`). Drawn as SVG in the app and as stroked,
   recolourable `custGeom` freeforms in PowerPoint.
7. **Design brief and brand** (`shared/ui/canvas/deck-design.ts`,
   `src/canvas/deck-brand.ts`): audience, industry, tone, brand and picture
   style map to a theme, layout mix, density and picture queries, with the
   reason; stored on the deck (`brief`) and editable in the editor's Design
   panel. A brand site is fetched through the guard; only colours (theme-color,
   brand-named custom properties, CSS frequency, a PNG/SVG logo's dominant
   colours — greys dropped), a measured font and the site name come back. Brand
   colours become theme slots (`palette`, applied by `themeOfDeck` so
   PowerPoint's Design → Variants still work) and are adjusted until the
   contrast rules pass. The agent may use WebSearch for 1–2 style references
   when the brief warrants it; that is guidance, results are untrusted data.
8. **Ten more themes** (22): Nebula, Sapphire, Carbon, Graphite (dark), Lagoon,
   Sunrise, Citrus, Blossom, Harbor, Pine; five with gradient accents. The
   deck types plan infographic slides (pitch, technical briefing, training) and
   a new `onboarding` type.
9. **"Make this slide visual"** (`makeVisual`): bullets, columns, KPIs or
   milestones become the infographic that fits (figures → tiles/rings/stat bars,
   dates → timeline/roadmap, steps → process, SWOT words → SWOT…), keeping every
   word and adding icons; in the editor and as the `make_visual` tool action.
10. **Tool actions**: `design_brief`, `find_images`, `find_icons`,
    `make_visual`; `create`/`set_slides` take `brief`, `palette`, `fonts`.

## Alternatives considered

| Option | Why not |
|---|---|
| Infographics as SVG/PNG pictures in the .pptx | Not editable — the reason to export .pptx at all |
| Everything as freeform `custGeom` | Exact, but a chevron becomes "Edit Points" instead of a chevron with its handle; presets are what PowerPoint users expect |
| Text inside the preset shapes (`p:txBody` on the shape) | PowerPoint's per-preset text rectangle differs from where the app draws it; grouped text boxes keep one layout for every renderer |
| Letting the model fetch any image URL it finds | Licence unknown, credit invented, and a prompt-injected URL becomes an engine fetch; only searched candidates are fetched |
| An icon npm dependency (`lucide`) | A runtime dependency for path data; the vendored subset is ~116 KB, regenerated by a script |
| Unsplash/Pexels as the default | Need keys; Openverse and Commons need none and say the licence per picture |
| Resizing large originals | No image library in the engine (and none added); pictures are capped at 15 MB, sources with sized URLs (Commons 1920 px, Pexels, Unsplash) preferred by the score |

## Consequences

- **Good:** template-quality infographics that are native, grouped and
  editable in PowerPoint; pictures with a recorded licence; brand colours that
  cannot break contrast; the presentation rules reported after every write.
- **Bad:** layouts are still a fixed catalogue (25 kinds); a full-size Openverse
  original can make a .pptx large (one live deck was 10.8 MB); Openverse's
  Flickr images are often 1024 px, soft for full-bleed (the validator says so);
  relevance of open-licence search is uneven — the agent must pick, and may need
  a second query; the semicircle's block arcs have their (circular) boxes
  partly below the slide edge in PowerPoint.
- **Security:** two new outbound fetch paths (licensed search, brand site) —
  public addresses only, through the existing SSRF policy; no new listener; the
  `/api/deck-media/` and `/api/deck/*` routes sit behind the engine token.
- **Verified:** `scripts/deck-visual-test.mjs` (every kind at every count in a
  light and a dark theme; geometry; icons; pptx parts, relationships, presets,
  freeforms, groups, cut pictures, credits in notes; rules; licence filter;
  candidate-only fetching; SSRF refusals; brand extraction from a local
  fixture; tool actions and routes). Live: three decks built through the tool
  with real Openverse/Commons searches and one built by deepseek-v4-flash in a
  real turn, opened in PowerPoint through COM (no repair), saved as PDF,
  rendered and inspected; grouped text edited through COM.
