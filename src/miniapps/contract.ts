/**
 * What a Mini App author is told.
 *
 * This is the whole reason the feature works or does not. A model that is not
 * told there is a stylesheet writes its own, badly; one that is not told
 * `resource()` exists hand-rolls fetch calls and gets the error states wrong;
 * one that is not told about the CSP reaches for a CDN and ships a blank page.
 * None of those are failures of instruction-following — they are failures to
 * mention a capability, and the model routed around what it could not see.
 *
 * So the contract is data, returned by `MiniAppManage` at the moment it is
 * needed, rather than prose in a system prompt that is paid for on every turn
 * whether or not anyone is building an app.
 *
 * @module miniapps/contract
 */

/**
 * The authoring brief, handed back when an app is created or described.
 *
 * Written as instructions to whoever is building, because that is who reads
 * it. Specific enough to be followed without guessing, short enough to be read.
 */
export function authoringContract(slug: string, dir: string, url: string): string {
  return `Mini App "${slug}"

  Directory  ${dir}
  URL        ${url}

Write these files with the ordinary Write tool. Nothing else is needed —
there is no build step and no install.

  schema.sql        the tables
  public/index.html the app
  public/app.js     its behaviour (optional; may be inline)
  public/app.css    its own styles on top of the foundation (optional)

── schema.sql ──────────────────────────────────────────────────────────
Applied every time the database is opened, so every statement must be
idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.

Give every table an "id INTEGER PRIMARY KEY AUTOINCREMENT". Update and
delete address rows by the primary key and refuse a table without one.

Put the real constraints in: NOT NULL, DEFAULT, CHECK, REFERENCES.
Foreign keys are enforced. A constraint the database holds is one the
page cannot forget.

CHANGING A SCHEMA THAT ALREADY HAS DATA IS DIFFERENT. Editing the CREATE
TABLE does nothing — "IF NOT EXISTS" means exactly that, so the table
already there is left alone and your change appears to have been made
while nothing happened. To add a column, append a line:

  ALTER TABLE books ADD COLUMN rating INTEGER;

Leave the CREATE TABLE alone, or update it too so a fresh database gets
the same shape — both is best. The file is applied on every open and the
duplicate-column error that causes is expected and ignored, so ALTER
lines are safe to leave in place permanently. Append them in the order
they happened; the file is the migration history.

A new column cannot be NOT NULL without a DEFAULT — the rows already
there have no value for it. Give it a default, or allow NULL.

After any schema change, run MiniAppManage tables and READ THE ANSWER.
If your column is not in it, the change did not apply. Fix the file. Do
NOT delete the app and start again: that destroys the reader's data, and
it has never once been the right repair.

── public/index.html ───────────────────────────────────────────────────
Load the runtime in this order. aico.js must come before alpine.js — it
registers components on alpine:init, and a deferred script would lose
that race.

  <link rel="stylesheet" href="/_aico/aico.css">
  <script src="/_aico/aico.js"></script>
  <script defer src="/_aico/alpine.js"></script>

A Content-Security-Policy of 'self' is served with the page. No CDN, no
Google Fonts, no remote image will load. Everything is local or inline.

Never call window.alert, window.confirm or window.prompt. They block the
page. Use aico.notify(message, kind) and an in-page confirmation.

── Reading and writing data ────────────────────────────────────────────
The page never sends SQL. It names a table and passes values:

  await aico.db.tables()
  await aico.db.list('invoices', { where: { status: 'sent' },
                                   orderBy: 'issued_at', direction: 'desc',
                                   limit: 100 })
  await aico.db.create('invoices', { customer: 'Acme', total: 1200 })
  await aico.db.update('invoices', id, { status: 'paid' })
  await aico.db.remove('invoices', id)

Filters are equality only, on real columns; anything else is refused with
a 400 whose message says why. For a search box or a computed total, load
the rows and filter or reduce them in a getter — these are small datasets.

── The CRUD component ──────────────────────────────────────────────────
x-data="resource(table, options)" is a working screen: rows, loading,
loadError, a form, field errors, save with a double-submit guard, and a
two-step delete. Use it instead of writing fetch calls.

  <div x-data="resource('invoices', {
        orderBy: 'issued_at', direction: 'desc',
        blank: { customer: '', total: 0, status: 'draft' },
        validate(row) {
          const e = {};
          if (!row.customer.trim()) e.customer = 'Who is this for?';
          if (!(row.total > 0)) e.total = 'Must be more than zero';
          return e;
        },
      })">

It gives the markup: rows, loading, loadError, form, errors, saving,
isEditing, pendingDelete, and the methods reload(), startCreate(),
startEdit(row), cancel(), save(), askRemove(row), cancelRemove(),
confirmRemove(). onSaved() runs after a successful save or delete —
use it to refresh a summary elsewhere on the page.

Also available: aico.money(n, currency), aico.date(value),
aico.notify(text, 'success' | 'error' | 'info'), aico.fail(err), and
the $store.toasts.all list.

Dark mode follows the reader's system setting with no work from you. To
offer a switch as well, call aico.theme.toggle() — it persists, and
aico.theme.get() returns 'dark', 'light' or 'system'.

── The look ────────────────────────────────────────────────────────────
aico.css is the design system — tokens, light and dark, and components.
Use its classes rather than inventing styles, and restyle by overriding
the custom properties (--accent, --radius, --surface) in app.css.

  layout     .app-header .app-title .app-main .stack .row .grid .spacer
  surface    .card .card-head .card-body[.flush] .stat (.label .value .delta)
  controls   .btn[.btn-primary .btn-danger .btn-ghost .btn-sm]
             .field[.invalid] > label + .input/.select/.textarea + .error/.hint
  data       .table-wrap > table.table, th, td, td.num, td.actions
             .pill[.good .warn .bad .accent]
  states     .empty .alert[.bad .warn] .skeleton
  overlay    .backdrop > .dialog > .dialog-head/.dialog-body/.dialog-foot
             .toasts > .toast[.success .error]
  text       .mono .muted .faint .num

Add x-cloak to anything Alpine fills in, or the raw markup flashes.

── The bar for the interface ───────────────────────────────────────────
The design system gets you a competent screen. What makes it a good one
is the part that is specific to this app, so spend the effort there:

  · LEAD WITH THE ANSWER. The top of the first screen states what the
    reader came to find out — what is owed, what is low, what is late —
    not a toolbar. A table with no summary above it makes every visit
    start with arithmetic.
  · ONE PRIMARY ACTION per screen, and make it obvious. Everything else
    is quieter. Five buttons of equal weight is the same as none.
  · THE PRIMARY ACTION IS THE ONE DONE MOST OFTEN, not the one done
    first. A habit tracker is opened every day to tick something off and
    once a month to add a habit — so ticking off is the button, and "New
    habit" is the quiet one. Getting this backwards produces a screen
    that looks right and is wrong to use: the thing you came for is
    missing or buried, and the thing you rarely need is the loudest
    element on the page. Ask what the reader does on their tenth visit,
    not their first.
  · SORT BY WHAT MATTERS, not by id. Newest first, or most urgent first.
    An id ordering is the database's convenience showing through.
  · NUMBERS RIGHT-ALIGNED AND TABULAR (.num), currency formatted, dates
    readable. A column of figures that jitters as digits change is a
    column nobody scans.
  · SAY WHAT IS WRONG WHERE IT IS WRONG. Field-level messages beside the
    field, in its own words — "Who is this for?" beats "Invalid input".
  · EMPTY STATES THAT TEACH. "No invoices yet — create one to get
    started" beats a blank rectangle. The first run is the screen most
    people see and the one least often designed.
  · NOTHING JUMPS. Skeletons hold the layout while data loads.
  · KEYBOARD WORKS. Labels tied to inputs, Escape closes a dialog, Enter
    submits a form, focus visible.
  · IT SURVIVES A NARROW WINDOW. Tables scroll inside .table-wrap rather
    than pushing the page sideways.

Restraint is doing real work here. Colour should belong to the data — a
status, an overdue amount — and every accent spent on chrome is one the
data cannot use.

── Work out what it is before you build it ─────────────────────────────
A brief like "an invoice app" is three sentences and a hundred decisions.
Guessing them produces something plausible that nobody can use, and the
guesses are invisible until someone tries to file a real invoice.

Do this first, before writing any file:

  1. LOOK. What does this kind of app actually need? An invoice has a
     number, a customer, dates, line items, tax, a status with a real
     lifecycle. A stock list has reorder levels and units. Work from how
     the job is actually done, not from the three fields the sentence
     mentioned. Search the web if the domain has conventions you are not
     sure of — VAT rules, an ISO status vocabulary, a standard code — and
     say what you found rather than inventing a scheme.
  2. LOOK HERE TOO. Read an existing Mini App in this workspace if there
     is one. The conventions are worth copying and the mistakes are worth
     not repeating.
  3. ASK. One round of questions, on the things you cannot infer and
     would have to guess: who uses it, what the one screen they open
     every morning shows, which rules are real ("an invoice cannot be
     edited once sent") and which are decoration. Do not ask about
     anything you can decide yourself.
  4. PLAN, in writing, before any file exists: the tables and their
     relationships, the screens, the rules the database will enforce
     versus the ones the page will. A schema you have to migrate on day
     two is a schema you designed while typing.

Then build. Then check it in a browser and fix what you find.

── Build it properly ───────────────────────────────────────────────────
Before you finish, re-read the request and check every verb in it. If it
says the reader can add, tick, untick, edit, archive or export something,
each of those needs a control they can find. An app that displays the
data beautifully and cannot change it is not the app that was asked for,
and it is the most common way one of these goes wrong.

This is a real application, not a demo. Cover the whole thing:

  · every screen the job needs, not just a table — a summary, filters,
    an empty state that says what to do next
  · validation in the page AND constraints in the schema
  · every failure path handled: loadError, save errors, a delete that
    a foreign key refuses
  · loading states, so nothing jumps when data arrives
  · keyboard: labels tied to inputs, Escape closes a dialog, Enter submits
  · reusable pieces via Alpine.data() rather than repeated markup
  · seed a few realistic rows so the first screen is not empty

Then open ${url} and check it: every button, a bad form, a deletion, and
a reload to confirm the data persisted.`;
}
