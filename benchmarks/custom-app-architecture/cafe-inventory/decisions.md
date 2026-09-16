# Decisions — StockCup

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript, so a decision written here survives
a long build.
- Stack: Node 22 + Hono + TypeScript strict on the server, node:sqlite for storage, plain ES modules and hand-written CSS on the front, one process for both. Why: one café, one machine — a bundler, a framework and a native SQLite build would each be a moving part with nothing to move for; node:sqlite also avoids the compile step that fails on Windows.
- HOST defaults to 127.0.0.1, not 0.0.0.0. Why: there is no sign-in yet, so the café's stock should not answer to anything else on the wifi.
- "Under threshold" is decided once on the server, in statusOf() in src/ingredients.ts. Why: the stock list and the dashboard must not disagree about what counts as needing a reorder.
- Quantities are REAL, and the unit is one of g / ml / each. Why: half a bottle of syrup and 0.5 kg are real counts, and a second unit column would be a conversions table nobody asked for.
- No OpenAPI document, unlike the api-service-hono template. Why: the only client is our own UI; the contract is written down in docs/EXTENDING.md instead, and a second copy would drift.
- A view is a module exporting { id, label, load, render, mount }, registered in one line in public/js/app.js. Why: adding a screen should be an import, a line and a file — the shell keeps loading, error and routing so no view reimplements them.
- Shell: a fixed sidebar from 900px, an off-canvas drawer behind a Menu button below it, one <main> the views paint into. Why: the counter tablet is the main device, so the narrow layout is the one that must not be cramped.
- Under 640px a row becomes a stacked, labelled card instead of a table that scrolls sideways. Why: five columns of numbers at 390px is unreadable, and sideways scrolling while holding a tablet is worse.
- The store's own screens live in public/ and are served by the same process as the API. Why: one URL for the café, no CORS, and no second thing to start.
- Validation lives on the server only; the screens show the errors it answers and focus the field it names. Why: two copies of "what is valid" drift, and the first draft of the stock form already disagreed with the API about a blank quantity.
- Field readers moved to src/validate.ts so every resource's parseX() reads the same way. Why: recipes and sales need the same "a name", "an amount", "a count" rules, and copying them per resource is how they drift.
- A recipe can always be removed: sale_items copies the drink's name. Why: taking a drink off the menu must not rewrite what was sold yesterday.
- An ingredient used by a drink, or with stock history, answers 409 with a sentence naming what holds it. Why: a foreign-key failure is a 500 and tells nobody anything.
- src/stock.ts is the only thing that changes a quantity: it moves the shelf and writes the ledger row together. Why: the shelf and the history can then never disagree, and a sale is traceable and reversible.
- A sale the café cannot make is refused whole, naming each ingredient that is short. Why: taking an ingredient negative would quietly corrupt every number after it, and a half-applied sale is worse than none.
- The ledger is append-only: undoing a sale writes the opposite rows instead of deleting history. Why: "what happened to the milk" should stay answerable.
- A drink's own correction of a count also writes a ledger row (reason 'count'). Why: every way a quantity moves should look the same in the history.
- The sale screen multiplies recipe amount by how many itself. Why: it is a display of the recipe, not a rule — the server owns what a sale costs and whether it is possible.
