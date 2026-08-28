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

── Build it properly ───────────────────────────────────────────────────
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
