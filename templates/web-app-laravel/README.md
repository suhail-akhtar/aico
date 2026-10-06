# __APP_TITLE__

A full-stack PHP web application on **Laravel 13 / PHP 8.5**: server-rendered Blade
with **Livewire 4** for the interactive parts, **Tailwind 4** (built by Vite in a Node
build stage only), sign-up and sign-in with **Fortify** (Argon2id), a **Sanctum**
bearer-token **JSON API** documented in OpenAPI, **PostgreSQL 18**, a database queue and
scheduler, and a hardened **FrankenPHP** production image. One worked feature, `items`,
shows every layer end to end.

You need **Docker** and nothing else. No PHP, Composer or Node on your machine.

## Run it

```sh
make setup      # builds the tools image, installs dependencies, creates .env with an APP_KEY
make dev        # app :8080 (live reload), Vite :5173, Mailpit :8025
```

Open http://localhost:8080, create an account, add an item. The seeded demo account is
`demo@example.com` (the password is `UserFactory::PASSWORD` in `database/factories`).
Without `make`: `docker compose -f compose.yaml -f compose.dev.yaml up --build`.

`make run` starts the **production-like** stack instead: the built image, read-only,
non-root, with a migrate job, a queue worker and the scheduler.

| Verb | What it does |
|---|---|
| `make setup` | build the tools image, `composer install`, create `.env` + `APP_KEY` |
| `make dev` | live-reload stack (mounts your files) |
| `make fmt` | format with Pint |
| `make lint` | Pint check + PHPStan (Larastan) level 10 |
| `make test` / `make cov` | Pest / with coverage, fails under 85% |
| `make audit` | `composer audit` (fails on known vulnerabilities) |
| `make build` / `make smoke` | build the image / start it and check it like production |
| `make check` | lint + cov + audit: what CI runs |
| `make run` | production-like stack |

With PHP 8.5 and Composer installed natively, `make RUN= check` skips Docker.

## Configure

Environment variables only; the full list with explanations is `.env.example`. The app
**refuses to start** (and the container entrypoint stops) without a valid `APP_KEY`, with
`APP_DEBUG=true` in production, or with password hashing below the OWASP minimum.

## The API

`POST /api/v1/auth/tokens` (email, password, device_name) returns a bearer token (stored
hashed, expires after 30 days). Then `GET/POST /api/v1/items`, `GET/PATCH/DELETE
/api/v1/items/{id}`. Lists are cursor-paginated (`limit` up to 100). Errors are RFC 9457
problem details. The OpenAPI document is committed at `docs/openapi.json` and served at
`/docs/api.json` in development (set `API_DOCS_ENABLED=true` to serve it elsewhere).
Another user's item is always a 404, never a 403.

## Structure

```
app/Features/Accounts/   sign-up, password reset, API tokens
app/Features/Items/      Models, Actions, Policies, Enums, Http/{Controllers,Livewire,Requests,Resources}
app/Support/             problem details, security headers, request context, config guard
routes/  database/  resources/  tests/  docs/  docker/
```

Read `docs/ARCHITECTURE.md` (and its three growth stages), `docs/EXTENDING.md` (add a
feature in ten minutes), `docs/DEPLOYING.md`, and `.aico/decisions.md` (why this stack).
