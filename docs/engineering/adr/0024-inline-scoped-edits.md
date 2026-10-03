# 0024 — Ask AICO edits one part of a document, checked in code, reviewed before it lands

- **Status:** Accepted (2026-10-03)
- **Date:** 2026-10-03
- **Deciders:** owner (+ authors)
- **Supersedes / related:** amends [0017](0017-model-roles.md) (a twelfth role, `edit`); builds on the canvas contract (`docs/engineering/canvas-docs-contract.md`) and the version history in `src/canvas/store.ts`

## Context

"Ask AI" on a selection (0.30) sent a chat message quoting the passage. The
agent then re-read the canvas and changed it with `edit` (find/replace) or a
whole-tab `update`. Nothing held it to the passage: a request to fix one
sentence could re-word the next paragraph, re-pad a table, drop a citation,
renumber headings or turn a chart's figures into different ones, and the
person saw the result only after it was written. The scope was a sentence in
a prompt — the kind of rule this codebase does not rely on (AGENTS.md §4.6).
The owner asked for an inline edit of a paragraph, table, chart, diagram or
any part that "knows the document and its design … and avoids irrelevant
changes", for documents and presentations.

## Decision

1. **A target is whole blocks plus an optional sub-range.** Blocks are named
   by `blockKeys` (content hashes, so a target survives edits elsewhere); the
   sub-range is a character range in one block, a table cell range
   (`r0..r1 × c0..c1`, header row −1) or an image caption; `part: 'section'`
   extends a heading to its section. The generic shape
   `{docId, blockIds | slideId+elementId, range?}` (`PartTarget`) is what a
   deck resolves for its own elements. Code: `resolveTarget` in
   `shared/ui/canvas/scoped-edit.ts`.
2. **The model answers with a patch of the part's own kind** —
   `{text}`, `{markdown}`, `{header, rows}`, `{cells}`, `{spec}` (ECharts),
   `{source}` (Mermaid), `{caption}`, `{json}` — and `renderPatch` turns it into
   Markdown for the span only. Markup the model must not touch is put back by
   construction: heading marks and typed numbering, fence lines, the text
   around a selection, the image line around a caption.
3. **A validator in code decides, not the prompt** (`validatePatch`): no type
   change unless the instruction asks for one (and then into what it asked
   for, keeping every figure); table shape, headers and every untouched cell
   kept unless asked; no figure dropped or invented unless asked; links,
   citations, footnotes, anchors and cross-references ("Section 4.2",
   "Table 2") kept; no formatting added a correction did not ask for; charts
   must be a drawable ECharts option with the same data and type unless
   asked; Mermaid must pass a syntax check (`checkMermaid`) and keep its nodes;
   a section keeps its heading. What the instruction allows is read
   deterministically from its words (`intentOf`); quick actions are just
   well-worded instructions, tested to unlock exactly what they need.
   `applyPart` re-splits the result and refuses any edit after which a block
   outside the span is not byte-identical.
4. **Retry once with the reasons, then give up with them** (`editPart` in
   `src/canvas/inline-edit.ts`). The editor additionally runs the real
   `mermaid.parse` in the browser on a proposed diagram and sends a failure
   back once as `retryError`.
5. **Bounded, deterministic context** (`buildEditContext`): document type
   (doc-types registry), house style read from the text (spelling, numbered
   headings, voice, parties, dates, money), defined terms, the outline with
   the target's section marked, two blocks either side (clipped) — the whole
   document only under 3,000 characters. The document is fenced as data.
6. **Nothing is written until the person accepts.** `POST
   /api/canvas/edit-part` returns a proposal; the editor shows it in the
   part's place (word diff, cell diff, before/after drawing), and Accept is
   one block edit saved as one version noted "AICO edit: …" — restorable from
   the history, with an Undo on the page. Follow-ups ("shorter still") keep the
   part; the last proposal is validated against the original under every
   instruction in the thread.
7. **The agent gets the same gate**: Canvas `edit_part {part, instruction,
   content?}` validates the agent's own replacement, or asks the edit model,
   then writes version-checked.
8. **A twelfth model role, `edit`** (amends ADR 0017): default the work model
   (economy preset: the cheap one), reasoning effort `low`; a reply cut off at
   the token ceiling is retried with thinking off and twice the budget.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep the chat message, sharpen the prompt | The failure is that nothing enforces the scope; a better sentence is still a sentence. |
| Let the model return the whole tab and diff it | A whole-document rewrite is the failure being fixed; the diff would show the damage, not prevent it. |
| Stream the proposal word by word | The answer is a JSON patch that cannot be validated or shown honestly until complete; parts are small (≤ 16k chars) and replies take 1–3 s. A spinner with Cancel is honest progress. |
| Full Mermaid parse in the engine | Mermaid needs a DOM; the engine's syntax check is the floor and the browser's real parser the ceiling. |
| Use the `background` role (cheap model) | Personal-data routing rules apply to it, and the person reads every word an edit changes; quality is visible. |
| A selection range in rendered text | Rendered and source text differ (`**`, links); the range is located in the Markdown and widened so it never cuts a mark or link in half (`locateSelection`). |

## Consequences

- **Good:** an inline edit cannot change anything outside its part — enforced
  by construction and re-checked on apply; the person sees exactly what changes
  before it lands; every accepted edit is one restorable version; the agent's
  targeted edits go through the same gate.
- **Bad / costs:** one model call per edit (two on a failed check); the Canvas
  tool's description grows by four lines; the validator's intent words are
  English (a non-English instruction allows less, never more).
- **Honest limits:** the validator checks structure, figures and references,
  not meaning — a fluent rewrite that changes a claim without touching a
  number passes and relies on the person's review; Mermaid beyond flowchart and
  sequence diagrams gets the header/bracket check only in the engine; defined
  terms dropped are a warning, not an error.
- **Migration:** none. New route and tool action; old engines simply lack
  `host.editPart` and the editor falls back to the chat message.

## Threat model

The document is the person's, but may quote web pages or emails. It is sent
fenced as reference data with a rule that nothing in it is an instruction,
the reply can only be a patch for the one part (anything else is refused),
and nothing is written without the person's Accept (UI) or a version-checked,
validated write (agent). No new network surface beyond the existing
token-guarded `127.0.0.1` API; no credentials are involved.

## Verification

- `scripts/inline-edit-test.mjs` (in `npm test`): targets, context bounds and
  determinism, each validator rule, apply/merge/stale/undo, the retry loop and
  the cut-off retry with a stub provider, the role, `findPart` and `edit_part`,
  the route never writing.
- `web/test-inline-edit.mjs` (in `test:web:unit`): selection placement,
  quick actions unlock what they ask, diffs.
- `scripts/inline-edit-live.mjs` (paid, on request): 15 edits of every target
  kind on a technical proposal with a real model — scope (every other block
  hashed), a rule per instruction, a judge only for tone — plus a broken stub
  answer the validator must refuse. 2026-10-03, deepseek-v4-flash: 15/15,
  all first attempt, scope held 15/15, $0.0041.
