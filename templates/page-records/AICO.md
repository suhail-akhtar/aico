# __APP_TITLE__

A page app: `schema.sql` plus `public/index.html`, served by aico's apps host,
which also provides the database API (`aico.db`), the CRUD component
(`x-data="resource(...)"`), the design system (`/_aico/aico.css`) and Alpine.
There is nothing to install and nothing to build.

## Layout

- `schema.sql` — the tables. Applied on every open, so every statement is
  idempotent. To change a table that has data, append an `ALTER TABLE` line;
  editing the `CREATE TABLE` alone does nothing.
- `public/index.html` — the whole screen: summary strip, table, form, delete
  confirmation. Uses only runtime classes and `resource()`.
- `public/app.css` — overrides of the design tokens (`--accent`, `--radius`).

## The worked feature

`records` is the table; the page lists them newest first, shows a total and a
count in the summary strip, creates and edits through one form with field-level
messages, and deletes in two steps. Copy this shape for any second table.

## Conventions

- Never send SQL from the page; `aico.db.list/create/update/remove` only.
- Never call `alert`/`confirm`/`prompt`; use `aico.notify` and an in-page dialog.
- CSP is `'self'`: no CDN, no remote fonts or images.
- After a schema change run `AppManage tables` and read the answer.
- Lead with the answer: the summary strip says what the reader came for.

## Checks

None to run. Verification is `VerifyApp` on the served URL: the strip shows the
right total, a create appears at the top, an invalid form shows its message.
