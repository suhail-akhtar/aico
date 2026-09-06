# __APP_TITLE__

__APP_DESCRIPTION__

A full-stack web application on Next.js (App Router), Tailwind and Node's
built-in SQLite. Accounts with a signed cookie, one worked feature end to end,
tests, and a container image that runs anywhere.

## Run

```sh
npm install
cp .env.example .env.local      # set SESSION_SECRET to a long random string
npm run dev                     # http://localhost:3000
```

Create an account at `/register`, then work in `/items`.

## Check

```sh
npm run typecheck
npm run lint
npm test
npm run build && npm start
```

## Configure

| Variable | Required | Meaning |
|---|---|---|
| `SESSION_SECRET` | yes | signs the session cookie; rotating it signs everyone out |
| `DATABASE_PATH` | no | SQLite file, default `./data/app.sqlite` |

## Deploy

`deploy/README.md`. `node deploy/docker.mjs` builds the image; mount `/app/data`.

## Structure

```
src/app/            routes: /, /login, /register, /items, /api/healthz
src/app/actions/    auth server actions
src/app/items/      the worked feature: page + actions
src/components/     client components (forms)
src/lib/            db, session, auth, items — the data and domain layer
test/               vitest, in memory
.aico/              backlog and decisions
docs/EXTENDING.md   how to add a feature, a table, a role
```
