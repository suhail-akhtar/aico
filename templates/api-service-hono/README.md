# __APP_TITLE__

__APP_DESCRIPTION__

A JSON API on [Hono](https://hono.dev) and Node's built-in SQLite. Strict
TypeScript, tests that run the app in memory, an OpenAPI document, health and
readiness routes, and a container image that runs anywhere.

## Run

```sh
npm install
npm run dev            # http://localhost:3000, restarts on change
```

| Route | What |
|---|---|
| `GET /healthz` | liveness |
| `GET /readyz` | readiness (the database answers) |
| `GET /openapi.json` | the API document |
| `GET/POST /items`, `GET/PUT/DELETE /items/:id` | the worked resource |

```sh
curl -s localhost:3000/items
curl -s -X POST localhost:3000/items -H 'content-type: application/json' -d '{"name":"pen","quantity":3}'
```

## Check

```sh
npm run typecheck
npm test
npm run build && npm start
```

## Configure

Environment only. Copy `.env.example` to `.env` for local use.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `DATABASE_PATH` | `./data/app.sqlite` | SQLite file; `:memory:` for tests |

## Deploy

`deploy/README.md`. In short: `node deploy/docker.mjs` builds the image;
mount a volume at `/app/data` so the database survives a restart.

## Structure

```
src/index.ts      entry: env, listen, shutdown
src/app.ts        the Hono app; mounts resources
src/db.ts         open + migrate
src/items.ts      the worked resource — copy for the next one
src/openapi.ts    the document
test/             vitest, in memory
.aico/            backlog and decisions
docs/EXTENDING.md how to add a resource, a migration, auth
```
