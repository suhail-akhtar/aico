/**
 * What every Mini App gets for free: a data client, a component library, and a
 * design system.
 *
 * ## Why this exists at all
 *
 * A model asked to "build an invoices app" will write its own fetch wrapper,
 * its own table markup, its own colours, and its own idea of what a form looks
 * like — every time, differently, and mostly badly. The apps would each be
 * plausible and none of them would look like they came from the same product.
 *
 * So the parts that should not vary are shipped: `aico.db` is the only way to
 * reach the database, `x-data="resource(...)"` is a working CRUD screen, and
 * the stylesheet is the whole visual language. What is left for the app to
 * write is the part that is actually about invoices.
 *
 * That is also a security property. A page that has a data client does not
 * hand-build query strings, and a page that never builds a query never builds
 * a bad one.
 *
 * ## Why these are strings and not files
 *
 * `tsup` bundles `src/` into a single `dist/index.js`; loose `.js` and `.css`
 * files beside the sources are not carried along, and `files` in package.json
 * ships `dist` rather than `src`. An asset that exists in the repository and
 * not in the published package is the kind of thing that works for the author
 * forever. Embedding is unglamorous and cannot break that way.
 *
 * Alpine is the exception — it is a real dependency, resolved from
 * `node_modules` at serve time, because vendoring a copy of someone else's
 * library into a string is how you end up maintaining it.
 *
 * @module miniapps/runtime
 */

/**
 * The client library, loaded before Alpine so its `alpine:init` handler is
 * registered in time.
 *
 * Written as a plain script rather than a module on purpose: a module is
 * deferred, and a deferred script that registers `Alpine.data` can lose the
 * race with Alpine's own auto-start.
 */
export const RUNTIME_JS = String.raw`/* aico Mini Apps runtime */
(function () {
  'use strict';

  // The app is served at /<slug>/, so its API is /<slug>/api/. Derived from
  // the location rather than baked in, because the same page is reachable as
  // "/invoices" and "/invoices/" and relative URLs resolve differently for
  // each — a difference that shows up as a 404 nobody can explain.
  var base = '/' + (location.pathname.split('/').filter(Boolean)[0] || '') + '/';

  function q(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  async function call(method, path, body) {
    var res;
    try {
      res = await fetch(base + 'api/' + path, {
        method: method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // A network failure is not a server error and should not be reported as
      // one — the usual cause is that aico stopped.
      throw new Error('Cannot reach the app server. Is aico still running?');
    }
    var payload = null;
    try { payload = await res.json(); } catch (err) { /* empty body is fine */ }
    if (!res.ok) throw new Error((payload && payload.error) || ('Request failed (' + res.status + ')'));
    return payload;
  }

  var db = {
    /** The tables and columns this app actually has. */
    tables: function () { return call('GET', 'tables'); },
    /**
     * Rows, newest first by default if there is something to order by.
     * opts: { where, orderBy, direction, limit, offset }
     */
    list: function (table, opts) {
      opts = opts || {};
      var params = {
        orderBy: opts.orderBy, direction: opts.direction,
        limit: opts.limit, offset: opts.offset,
      };
      Object.keys(opts.where || {}).forEach(function (k) { params['where.' + k] = opts.where[k]; });
      return call('GET', encodeURIComponent(table) + q(params));
    },
    create: function (table, row) { return call('POST', encodeURIComponent(table), row); },
    update: function (table, id, patch) {
      return call('PATCH', encodeURIComponent(table) + '/' + encodeURIComponent(id), patch);
    },
    remove: function (table, id) {
      return call('DELETE', encodeURIComponent(table) + '/' + encodeURIComponent(id));
    },
  };

  // ── Notifications ──────────────────────────────────────────────────
  // Never window.alert or window.confirm. They block the page, they cannot be
  // styled, and in an embedded browser they can wedge the whole session.

  var toasts = [];
  var nextToastId = 1;
  function notify(message, kind) {
    var toast = { id: nextToastId++, message: String(message), kind: kind || 'info' };
    toasts.push(toast);
    setTimeout(function () {
      var at = toasts.indexOf(toast);
      if (at >= 0) toasts.splice(at, 1);
    }, kind === 'error' ? 6000 : 3000);
  }

  window.aico = {
    db: db,
    notify: notify,
    /** Say it, and return false, so a catch block is one line. */
    fail: function (err) { notify(err && err.message ? err.message : String(err), 'error'); return false; },
    money: function (n, currency) {
      if (n === null || n === undefined || n === '') return '';
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency', currency: currency || 'USD',
        }).format(Number(n));
      } catch (err) { return String(n); }
    },
    date: function (value) {
      if (!value) return '';
      var d = new Date(value);
      return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
    },
  };

  document.addEventListener('alpine:init', function () {
    var Alpine = window.Alpine;

    Alpine.store('toasts', { get all() { return toasts; } });

    /**
     * A table with a form: list, create, edit, delete, with the loading and
     * error states already handled.
     *
     * The point is that an app author writes markup and validation rules, not
     * request plumbing — and that every screen behaves the same way when the
     * network is slow or a constraint rejects a row.
     *
     *   x-data="resource('invoices', { orderBy: 'issued_at', direction: 'desc',
     *                                  blank: { customer: '', total: 0 },
     *                                  validate(row) { … return errors } })"
     */
    Alpine.data('resource', function (table, options) {
      options = options || {};
      return {
        table: table,
        rows: [],
        /** The row being edited, or null when the form is creating. */
        editing: null,
        form: Object.assign({}, options.blank || {}),
        errors: {},
        loading: true,
        saving: false,
        /** Set only when the list itself could not load — a page-level state. */
        loadError: '',

        init: function () { this.reload(); },

        async reload() {
          this.loading = true;
          this.loadError = '';
          try {
            this.rows = await db.list(this.table, {
              orderBy: options.orderBy, direction: options.direction,
              where: typeof options.where === 'function' ? options.where.call(this) : options.where,
              limit: options.limit,
            });
          } catch (err) {
            this.loadError = err.message;
          } finally {
            this.loading = false;
          }
        },

        get blank() { return Object.assign({}, options.blank || {}); },

        startCreate: function () {
          this.editing = null;
          this.form = this.blank;
          this.errors = {};
        },

        startEdit: function (row) {
          this.editing = row;
          // A copy, so abandoning an edit does not leave the table showing
          // changes that were never saved.
          this.form = Object.assign({}, row);
          this.errors = {};
        },

        cancel: function () {
          this.editing = null;
          this.form = this.blank;
          this.errors = {};
        },

        get isEditing() { return this.editing !== null; },

        /** Field-level messages, keyed by column, from the app's own rules. */
        validate: function () {
          this.errors = (options.validate ? options.validate.call(this, this.form) : {}) || {};
          return Object.keys(this.errors).length === 0;
        },

        async save() {
          if (this.saving) return;              // double-submit guard
          if (!this.validate()) return;
          this.saving = true;
          try {
            var key = options.key || 'id';
            if (this.editing) {
              var updated = await db.update(this.table, this.editing[key], this.form);
              var at = this.rows.indexOf(this.editing);
              if (at >= 0 && updated) this.rows.splice(at, 1, updated);
              notify('Saved', 'success');
            } else {
              await db.create(this.table, this.form);
              notify('Added', 'success');
              await this.reload();
            }
            this.cancel();
            if (options.onSaved) options.onSaved.call(this);
          } catch (err) {
            window.aico.fail(err);
          } finally {
            this.saving = false;
          }
        },

        /**
         * Delete, confirmed in the page rather than by window.confirm.
         * Call once to arm, once to commit; pendingDelete drives the markup.
         */
        pendingDelete: null,
        askRemove: function (row) { this.pendingDelete = row; },
        cancelRemove: function () { this.pendingDelete = null; },
        async confirmRemove() {
          var row = this.pendingDelete;
          if (!row) return;
          try {
            await db.remove(this.table, row[options.key || 'id']);
            var at = this.rows.indexOf(row);
            if (at >= 0) this.rows.splice(at, 1);
            notify('Deleted', 'success');
            if (options.onSaved) options.onSaved.call(this);
          } catch (err) {
            window.aico.fail(err);
          } finally {
            this.pendingDelete = null;
          }
        },
      };
    });
  });
})();
`;

/**
 * The design system.
 *
 * Tokens first, then components, so an app restyles by overriding a handful of
 * custom properties rather than fighting selectors. Light and dark are both
 * defined here and chosen by the reader's system setting — a generated app
 * should not have to remember to support dark mode, and if it had to it would
 * not.
 *
 * The palette is one blue accent against neutral grey. Restraint is doing real
 * work: the colours in a line-of-business screen should belong to the data —
 * a status pill, an overdue amount — and every accent spent on chrome is one
 * the data cannot use.
 */
export const RUNTIME_CSS = String.raw`/* aico Mini Apps — foundation */

:root {
  color-scheme: light dark;

  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  --bg: #f6f7f9;
  --surface: #ffffff;
  --surface-2: #f2f4f7;
  --border: #e3e7ec;
  --border-strong: #cfd6de;

  --text: #12161c;
  --text-muted: #616b7a;
  --text-faint: #8b95a3;

  --accent: #2a6ff0;
  --accent-hover: #1f5bd0;
  --accent-soft: #eaf1fe;
  --accent-text: #ffffff;

  --good: #12805c;
  --good-soft: #e6f5ef;
  --warn: #9a6400;
  --warn-soft: #fdf3e0;
  --bad: #c2352f;
  --bad-soft: #fdecea;

  --radius: 10px;
  --radius-sm: 6px;
  /* Shadows are two layers: a tight one for the edge, a wide one for the lift.
     A single blur reads as a smudge at every size. */
  --shadow: 0 1px 2px rgba(16, 24, 40, .06), 0 8px 24px rgba(16, 24, 40, .06);
  --shadow-lg: 0 2px 4px rgba(16, 24, 40, .08), 0 24px 48px rgba(16, 24, 40, .14);
  --ring: 0 0 0 3px var(--accent-soft);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1116;
    --surface: #161a21;
    --surface-2: #1c212a;
    --border: #262c36;
    --border-strong: #333b47;

    --text: #e8eaee;
    --text-muted: #98a2b1;
    --text-faint: #6c7787;

    --accent: #4c8dff;
    --accent-hover: #6ba1ff;
    --accent-soft: #17233a;

    --good: #4ecf9a;
    --good-soft: #12241d;
    --warn: #f0b429;
    --warn-soft: #2a2110;
    --bad: #f4756e;
    --bad-soft: #2b1614;

    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .32);
    --shadow-lg: 0 2px 4px rgba(0, 0, 0, .5), 0 24px 48px rgba(0, 0, 0, .5);
    --ring: 0 0 0 3px rgba(76, 141, 255, .28);
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--font);
  /* 15px, not 16: these are dense data screens, and 16px browser default makes
     a table of numbers feel like a blog post. */
  font-size: 15px;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}

/* Alpine renders after parse; without this the raw x-text markup flashes. */
[x-cloak] { display: none !important; }

h1, h2, h3 { margin: 0; font-weight: 650; letter-spacing: -.011em; }
h1 { font-size: 1.35rem; }
h2 { font-size: 1.05rem; }
h3 { font-size: .95rem; }
p { margin: 0 0 .75rem; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ── Layout ─────────────────────────────────────────────────────── */

.app-header {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: 1rem;
  padding: .85rem 1.5rem;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}
.app-header .spacer { flex: 1; }
.app-title { display: flex; align-items: baseline; gap: .6rem; }
.app-title small { color: var(--text-faint); font-weight: 400; font-size: .8rem; }

.app-main { max-width: 1180px; margin: 0 auto; padding: 1.5rem; }
.stack { display: flex; flex-direction: column; gap: 1.25rem; }
.row { display: flex; align-items: center; gap: .6rem; }
.row.wrap { flex-wrap: wrap; }
.row .spacer { flex: 1; }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }

/* ── Card ───────────────────────────────────────────────────────── */

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}
.card-head {
  display: flex; align-items: center; gap: .75rem;
  padding: .9rem 1.1rem;
  border-bottom: 1px solid var(--border);
}
.card-head .spacer { flex: 1; }
.card-body { padding: 1.1rem; }
.card-body.flush { padding: 0; }

/* A headline number. Tabular figures so a column of them does not jitter as
   the digits change. */
.stat { padding: 1rem 1.1rem; }
.stat .label { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-faint); }
.stat .value { font-size: 1.6rem; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -.02em; margin-top: .2rem; }
.stat .delta { font-size: .8rem; color: var(--text-muted); }

/* ── Controls ───────────────────────────────────────────────────── */

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
  padding: .48rem .85rem;
  font: inherit; font-size: .875rem; font-weight: 550;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease, transform .06s ease;
  white-space: nowrap;
}
.btn:hover { background: var(--surface-2); }
.btn:active { transform: translateY(.5px); }
.btn:focus-visible { outline: none; box-shadow: var(--ring); border-color: var(--accent); }
.btn[disabled] { opacity: .55; cursor: not-allowed; transform: none; }

.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn-danger { background: var(--bad); border-color: var(--bad); color: #fff; }
.btn-danger:hover { filter: brightness(1.06); }
.btn-ghost { background: transparent; border-color: transparent; color: var(--text-muted); }
.btn-ghost:hover { background: var(--surface-2); color: var(--text); }
.btn-sm { padding: .3rem .55rem; font-size: .8rem; }

.field { display: flex; flex-direction: column; gap: .3rem; }
.field > label { font-size: .8rem; font-weight: 550; color: var(--text-muted); }
.input, .select, .textarea {
  width: 100%;
  padding: .5rem .65rem;
  font: inherit; font-size: .9rem;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  transition: border-color .12s ease, box-shadow .12s ease;
}
.input:focus, .select:focus, .textarea:focus { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
.textarea { min-height: 5rem; resize: vertical; }
.input[type="number"] { font-variant-numeric: tabular-nums; }
.field.invalid .input, .field.invalid .select, .field.invalid .textarea { border-color: var(--bad); }
.field .hint { font-size: .78rem; color: var(--text-faint); }
.field .error { font-size: .78rem; color: var(--bad); }

/* ── Table ──────────────────────────────────────────────────────── */

.table-wrap { overflow-x: auto; }
table.table { width: 100%; border-collapse: collapse; font-size: .9rem; }
table.table th {
  position: sticky; top: 0;
  text-align: left; font-weight: 600; font-size: .75rem;
  text-transform: uppercase; letter-spacing: .04em;
  color: var(--text-faint);
  background: var(--surface-2);
  padding: .6rem .9rem;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
table.table td { padding: .65rem .9rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.table tbody tr:last-child td { border-bottom: none; }
table.table tbody tr { transition: background .1s ease; }
table.table tbody tr:hover { background: var(--surface-2); }
table.table .num { text-align: right; font-variant-numeric: tabular-nums; }
table.table .actions { text-align: right; white-space: nowrap; }
/* Row actions appear on hover on a pointer device, and are always visible on
   touch — where there is no hover to reveal them. */
@media (hover: hover) {
  table.table .actions .btn { opacity: 0; transition: opacity .1s ease; }
  table.table tr:hover .actions .btn,
  table.table .actions .btn:focus-visible { opacity: 1; }
}

.pill {
  display: inline-flex; align-items: center; gap: .3rem;
  padding: .15rem .5rem;
  font-size: .75rem; font-weight: 550;
  border-radius: 999px;
  background: var(--surface-2); color: var(--text-muted);
}
.pill.good { background: var(--good-soft); color: var(--good); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.bad  { background: var(--bad-soft);  color: var(--bad); }
.pill.accent { background: var(--accent-soft); color: var(--accent); }

/* ── States ─────────────────────────────────────────────────────── */

.empty { padding: 3rem 1.5rem; text-align: center; color: var(--text-muted); }
.empty h3 { margin-bottom: .35rem; color: var(--text); }

.alert { padding: .7rem .9rem; border-radius: var(--radius-sm); font-size: .875rem; }
.alert.bad { background: var(--bad-soft); color: var(--bad); }
.alert.warn { background: var(--warn-soft); color: var(--warn); }

/* Skeleton rows, not a spinner: the table keeps its shape while it loads, so
   the page does not jump when the data lands. */
.skeleton { height: 1em; border-radius: 4px; background: var(--surface-2); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }

/* ── Dialog ─────────────────────────────────────────────────────── */

.backdrop {
  position: fixed; inset: 0; z-index: 40;
  display: flex; align-items: center; justify-content: center;
  padding: 1.5rem;
  background: rgba(12, 16, 22, .45);
  backdrop-filter: blur(2px);
}
.dialog {
  width: 100%; max-width: 34rem;
  max-height: calc(100vh - 3rem); overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
}
.dialog-head { padding: 1.1rem 1.25rem .5rem; }
.dialog-body { padding: .5rem 1.25rem 1.1rem; display: flex; flex-direction: column; gap: .9rem; }
.dialog-foot { display: flex; justify-content: flex-end; gap: .5rem; padding: .9rem 1.25rem; border-top: 1px solid var(--border); }

/* ── Toasts ─────────────────────────────────────────────────────── */

.toasts { position: fixed; right: 1rem; bottom: 1rem; z-index: 60; display: flex; flex-direction: column; gap: .5rem; }
.toast {
  display: flex; align-items: center; gap: .5rem;
  padding: .6rem .85rem;
  font-size: .875rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--text-faint);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  animation: toast-in .18s ease-out;
}
.toast.success { border-left-color: var(--good); }
.toast.error { border-left-color: var(--bad); }
@keyframes toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; } }

.mono { font-family: var(--font-mono); font-size: .85em; }
.muted { color: var(--text-muted); }
.faint { color: var(--text-faint); }
.num { font-variant-numeric: tabular-nums; }
`;
