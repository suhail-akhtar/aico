# Extending this service

## Add a resource (the main move)

1. **Migration.** Append a `CREATE TABLE IF NOT EXISTS orders (...)` entry to
   `MIGRATIONS` in `src/db.ts`. Real constraints: `NOT NULL`, `CHECK`, `DEFAULT`,
   `REFERENCES items(id)`. Never edit an earlier entry.
2. **Module.** Copy `src/items.ts` to `src/orders.ts`. Rename `Item` → `Order`,
   `parseItem` → `parseOrder` (return field errors, never throw), `itemsRepo` →
   `ordersRepo` (prepared statements, newest first), `itemRoutes` → `orderRoutes`.
3. **Mount.** One line in `src/app.ts`: `app.route('/orders', orderRoutes(db))`.
4. **Document.** Add the paths and schemas to `src/openapi.ts`.
5. **Test.** Copy `test/items.test.ts`; the "documents every route" test will
   fail until step 4 is done, which is the point.
6. `RunChecks`, then `AppManage start` and `VerifyApp` the new routes.

## Add a column

New `MIGRATIONS` entry: `ALTER TABLE items ADD COLUMN sku TEXT`. Add the field to
the `Row` type, `parseX`, the `INSERT`/`UPDATE` statements, the OpenAPI schema,
and a test. A new `NOT NULL` column needs a `DEFAULT`.

## Add auth

Hono middleware in `src/app.ts` before the resources:

```ts
import { bearerAuth } from 'hono/bearer-auth';
app.use('/items/*', bearerAuth({ token: process.env.API_TOKEN! }));
```

Read the token from env, add it to `.env.example`, and test the 401.

## Add a background job

Keep it in-process only if it is idempotent and safe to run twice (two replicas
will both run it). Otherwise it belongs in a separate `process` app that shares
the database file, or a queue.

## Move to Postgres

Replace `src/db.ts` with a `pg` pool and the same `MIGRATIONS` shape; repositories
become async. Routes do not change. Do this when you need more than one
instance writing at once, not before.

## What not to do

- No SQL in route handlers; it lives in the repository.
- No throwing for validation; return `{ errors }`.
- No `console.log` in handlers; the logger middleware already records requests.
- No secrets in code or in the image; env only, `.env` is git-ignored.
