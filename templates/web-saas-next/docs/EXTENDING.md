# Extending this app

## Add a feature (the main move)

Copy the items slice. For a feature called `projects`:

1. **Migration.** Append `CREATE TABLE IF NOT EXISTS projects (...)` to
   `MIGRATIONS` in `src/lib/db.ts`, with `user_id INTEGER NOT NULL REFERENCES
   users(id) ON DELETE CASCADE` and real constraints. Never edit an earlier entry.
2. **Lib.** Copy `src/lib/items.ts` → `src/lib/projects.ts`: the row type, a parse
   function returning `{ error }`, and functions taking `(db, userId, …)`.
3. **Actions.** Copy `src/app/items/actions.ts` → `src/app/projects/actions.ts`.
   Every action begins with `await requireUser()`; the user id comes from there.
4. **Page.** Copy `src/app/items/page.tsx` → `src/app/projects/page.tsx`. Server
   component: read with the lib, render, forms post to the actions. Add a client
   component only where the browser needs state (inline errors, optimistic UI).
5. **Nav.** One `Link` in `src/app/layout.tsx`.
6. **Test.** Copy `test/items.test.ts`; cover parse, ordering, and owner scoping.
7. `RunChecks`, then `AppManage start` and `VerifyApp` the page.

## Add a column

New `MIGRATIONS` entry: `ALTER TABLE items ADD COLUMN due_on TEXT`. Then the row
type, the parse function, the insert/update statements, the page, and a test. A
new `NOT NULL` column needs a `DEFAULT`.

## Add roles or teams

Add a `role TEXT NOT NULL DEFAULT 'member'` to `users` (or an `organisations`
table plus `memberships`), read it in `currentUser()`, and check it at the top
of the action, next to `requireUser()`. Authorisation lives in actions and lib
functions, never only in what the page chooses to render.

## Add an API for other clients

`src/app/api/<resource>/route.ts` exporting `GET`/`POST`. Authenticate with a
bearer token stored hashed on the user, or reuse the cookie for same-origin
clients. Use the same lib functions the pages use.

## Move to Postgres

Replace `src/lib/db.ts` with a `pg` pool and make the lib functions async. Pages
and actions already `await`; tests need a test database. Do this when one
writer is not enough, not before. Vercel needs this on day one.

## What not to do

- No SQL in pages or actions; it lives in `src/lib/`.
- No client component that fetches; read in the server component and pass props.
- No user id from a form field; always `requireUser()`.
- No secrets in code or in the image; env only, `.env.local` is git-ignored.
