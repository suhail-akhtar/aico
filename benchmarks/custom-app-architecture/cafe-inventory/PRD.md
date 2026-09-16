# StockCup — PRD

## Purpose
Know what the café has and what to reorder, without counting the shelves by hand
after every service.

## Users and the primary action
The owner and whoever is on bar, sharing one tablet behind the counter. The
action they take most often, on the tenth visit, is **logging a drink sold** — a
tap per drink during service — because that is what keeps the numbers true
without extra work. The close second is **glancing at what has gone under its
threshold** before the next order.

## Scope
In this iteration: ingredients carrying a quantity, a unit and a reorder
threshold; recipes built from ingredients and amounts; logging a sale that
deducts the right ingredients automatically; a dashboard naming everything under
its threshold; removing a sale logged by mistake.

Out, deliberately: suppliers and purchase orders, cost and margin, more than one
location, staff accounts and permissions, barcode scanning, till/POS
integration, waste and spillage, unit conversion beyond an ingredient's own unit,
and historical reporting.

## Stack
- **Frontend — vanilla ES modules and hand-written CSS, served as static files
  by the app's own process.** Five screens, one operator, no sync or offline
  needs: a bundler and a component framework would add an install step, a build
  config and a lockfile entry that buy nothing here, and the host's CSP forbids
  CDN scripts so every byte is local regardless. Views are small functions over
  one loaded snapshot, which is the whole state model this tool needs.
- **Backend/API — Node 22 + Hono + TypeScript (strict), `tsx` in dev, `tsc` for
  `npm start`.** One JSON API under `/api/*` from the same process that serves
  the UI. Hono is two packages on top of `node:http`, TypeScript is what makes
  field-level validation of recipes and sale lines reliable, and keeping one
  language across both halves keeps one mental model.
- **Database — SQLite through `node:sqlite`, built into Node 22.5+.** One file at
  `data/stockcup.db`, schema applied from `MIGRATIONS` at boot. A café runs one
  process on one machine, so there is no server to keep up and no concurrency to
  coordinate; `node:sqlite` avoids the native compile step that makes
  `better-sqlite3` the usual Windows install failure; and a transaction is what
  lets a sale deduct every ingredient all-or-nothing.
- **Monolith, not services.** One process serves the UI and the API over one
  database file. There is no scaling axis here — a second moving part would only
  be a second thing to keep running.

## Data
- **Ingredient** (id, name, unit `g|ml|each`, quantity, reorder_threshold,
  updated_at) — one line on the shelf.
- **Recipe** (id, name, size, active) — one drink on the menu.
- **RecipeItem** (recipe_id, ingredient_id, amount) — how much of one ingredient
  one drink uses. A recipe has many; an ingredient appears in many.
- **Sale** (id, logged_at, note) — one trip to the till, one row per confirm.
- **SaleItem** (sale_id, recipe_id, count) — how many of that drink went out.
- **StockMovement** (id, ingredient_id, delta, reason `sale|count|adjust`,
  sale_id, created_at) — every change to a quantity, so a deduction can be
  traced and a removed sale reversed.

## Done when
- Adding an ingredient with a quantity and threshold shows it in the stock list,
  and correcting its quantity shows the new figure.
- A recipe saved with two ingredient lines shows both, with amounts and units.
- Logging a sale of two drinks drops each of its ingredients by 2 × the recipe
  amount, and the movement log names the sale.
- The dashboard lists every ingredient at or under its threshold with how much
  is missing, and says so plainly when nothing is.
- Removing a sale puts the ingredients back.

## Open questions / assumptions
- **Assumed one shared login, no sign-in.** A café this size shares one tablet;
  named accounts are a Later story, not part of the primary action.
- **Assumed one unit per ingredient with decimal quantities** (900 g, not "two
  boxes of 500 g"). Pack sizes and purchase units are a Later story.
- **Assumed sales are logged by drink, not by ingredient** — the recipe is what
  makes the deduction automatic.
- **Assumed price and margin are out of scope.** This is stock, not a till.
- **Assumed one threshold number per ingredient**, not per weekday or per
  supplier lead time.
