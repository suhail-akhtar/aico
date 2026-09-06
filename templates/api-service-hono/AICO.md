# __APP_TITLE__

A JSON API: Hono on Node, node:sqlite for storage, vitest for tests. TypeScript
throughout, strict. Runs as its own process; aico starts it with `npm run dev`
and waits for "listening on".

## Layout

- `src/index.ts` — process entry: env config, listen, SIGTERM shutdown. Rarely changes.
- `src/app.ts` — the Hono app: middleware, health, mounts each resource. One line per resource.
- `src/db.ts` — opens the database and runs `MIGRATIONS` in order. Append, never edit.
- `src/items.ts` — **the worked resource**: type, `parseItem`, repository, routes. Copy it.
- `src/openapi.ts` — the document served at `/openapi.json`. Add every new route.
- `test/*.test.ts` — vitest against `createApp(openDatabase(':memory:'))`; no port.

## Conventions

- A resource is one file: `Row` type, `Input` type, `parseX(body)` returning
  `{ value }` or `{ errors }`, `xRepo(db)` with prepared statements, `xRoutes(db)`.
- Validation errors answer `400 { error: 'invalid', fields: {…} }`; missing rows
  `404 { error: 'not_found' }`; nothing else leaks (`onError` answers 500).
- Newest first, `limit` capped at 1000, ids are positive integers or 404.
- Config from env only: `PORT`, `HOST`, `DATABASE_PATH`. See `.env.example`.
- Schema changes are a new entry in `MIGRATIONS`; a deployed database has
  already run the earlier ones.

## Checks

`npm run typecheck`, `npm test`, `npm run build`. `RunChecks` runs them all.
Then `AppManage start` and `VerifyApp` the URL: `/healthz`, `/items`, a POST
with a bad body answering 400 with the field named.
