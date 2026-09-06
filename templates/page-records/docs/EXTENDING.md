# Extending this app

## Add a column

1. Append to `schema.sql`, under the migrations line:
   `ALTER TABLE records ADD COLUMN due_on TEXT;`
   and add the same column to the `CREATE TABLE` so a fresh database matches.
   A new column cannot be `NOT NULL` without a `DEFAULT`.
2. Run `AppManage tables` and read the answer. If the column is not there, the
   change did not apply; fix the file. Never delete the app to "reset" it.
3. Add the field to the form (`x-model="form.due_on"`), to `blank`, and to the
   table if it is worth a column. Add a `validate` rule if it has one.
4. `VerifyApp`: create a record with the new field, see it in the table.

## Add a table

Copy the pattern: `CREATE TABLE IF NOT EXISTS <name> (id INTEGER PRIMARY KEY
AUTOINCREMENT, …)` with real constraints, then a second
`x-data="resource('<name>', {...})"` block on the page, or a second page
`public/<name>.html` linked from the header. Keep one primary action per screen.

## Add a summary figure

Summary figures are getters over `rows`: filter or reduce in the template, as
the strip does. These are small datasets; do not add an endpoint for a total.

## Add a filter

Keep a `filter` in `x-data` and show `rows.filter(...)` in the table and the
strip together, so the figures follow the filter. Equality filters on real
columns can also go server-side through `list(table, { where })`.

## Change the look

`public/app.css` overrides tokens: `--accent`, `--radius`, `--surface`. Use the
runtime's classes (`.card`, `.stat`, `.pill`, `.table`) before writing new CSS.

## What not to do

- No SQL from the page, no `fetch` to anything but `aico.db`.
- No `alert`/`confirm`/`prompt`; use `aico.notify` and the dialog pattern.
- No CDN: the CSP is `'self'`.
- Do not rewrite `CREATE TABLE` to change an existing table; append `ALTER`.
