# One layout per stack

The shape to copy when the codebase does not already show one. When it does, the codebase wins.

## Next.js (App Router) — feature slices

```
src/lib/<feature>.ts            data + logic: types, parse(), functions taking (db, userId, …)
src/app/<feature>/page.tsx      server component: read with the lib, render, forms post to actions
src/app/<feature>/actions.ts    'use server'; every action begins with requireUser()
src/components/<Feature>*.tsx   client components only where the browser needs state
test/<feature>.test.ts          vitest over the lib, in memory
```

## Hono / Express service — one file per resource

```
src/<resource>.ts               Row type, Input type, parseX() → { value } | { errors }, xRepo(db), xRoutes(db)
src/app.ts                      mounts each resource: app.route('/<resource>', xRoutes(db))
src/openapi.ts                  every route documented
test/<resource>.test.ts         app.request() in memory
```

## Page app (aico host)

```
schema.sql                      tables; idempotent; ALTER TABLE lines appended to migrate
public/index.html               one screen; x-data="resource('<table>', …)"
public/app.css                  token overrides only
```

## Python service

```
app/<feature>/models.py  schemas.py  service.py  router.py
tests/test_<feature>.py
```

## Where things never go

- SQL in a route handler, a page, or a component.
- A user id read from the client without scoping the query to the session's user.
- Secrets in code or in an image; env only, with `.env.example` naming every variable.
- Business rules in the interface layer; the interface reads and calls.

## Decision line

```
- Chose a `memberships` table over a `role` column on users — one user can belong to several organisations, and the column would have forced a second account per organisation.
```
