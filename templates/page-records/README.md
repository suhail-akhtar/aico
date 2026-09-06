# __APP_TITLE__

__APP_DESCRIPTION__

A single-page records tool running on aico's apps host: SQLite behind a small
data API, a CRUD component, and a design system — all provided by the host.

## Run

Open the app from **Apps** in the aico web portal; the URL on its card serves
`public/index.html`. There is nothing to install.

## Files

```
schema.sql          the tables (idempotent; append ALTER TABLE to migrate)
public/index.html   the screen
public/app.css      token overrides
.aico/backlog.md    stories, ticked as they land
.aico/decisions.md  what was decided and why
docs/EXTENDING.md   how to add a table, a field, a summary figure
```

## Deploy

A page app runs inside aico's host — see `deploy/README.md`. If it outgrows
that, create an app from the `web-saas-next` template and move the tables.
