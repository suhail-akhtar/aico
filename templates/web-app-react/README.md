# __APP_TITLE__

__APP_DESCRIPTION__

A single-page app that is ready to sit in front of a real backend: React 19, TypeScript 6,
Vite 8, TanStack Router and Query, Tailwind 4, and a typed API client generated from an
OpenAPI document. Sign-in is the BFF pattern (RFC 10017): the browser never holds a token; a
gateway keeps the session and sets an `HttpOnly` cookie. One worked feature (items: list,
create, edit, delete) shows the patterns to copy.

## Run

```sh
make setup      # npm ci (and the git hook, if pre-commit is installed)
make dev        # http://localhost:5173
```

The dev server includes a **mock gateway** (`mock/api.ts`) that behaves like the real one: a
sign-in page, a session cookie, the CSRF rule, and an in-memory items API. Sign in as
`dev@example.com` / `dev-password`. To use a real gateway instead:
`DEV_API_ORIGIN=http://localhost:8080 npm run dev`.

No Node 24? `make docker-check` runs every check in the pinned Node image.

## Check

```sh
make check      # format, lint, tsc, generated code is current, tests (85% gate), npm audit, build
make e2e-install && make e2e   # Playwright: desktop (1280) and phone (390), axe, CSP, keyboard
```

`make help` lists every verb (`setup dev run fmt lint test cov audit build check gen e2e sbom docker`).

## Configure

Configuration is read at start from `/config.json`, not baked in at build time, so one image
runs everywhere. In the container it is written from environment variables (`.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `API_BASE_URL` | `/api` | where the API lives, on this origin |
| `LOGIN_URL` | `/api/auth/start` | gateway endpoint that starts sign-in (`rd=` is appended) |
| `LOGOUT_URL` | `/api/auth/sign_out?rd=/` | gateway endpoint that ends the session |
| `APP_ENVIRONMENT` | `production` | a label for bug reports |

Every URL must be a path on the same origin; the container refuses to start otherwise.

## Deploy

`docker build -t web-app .` makes a static nginx image (non-root, read-only filesystem, no
capabilities, strict CSP). It needs a gateway in front that serves `/api` and `/api/auth/*`:
see [docs/BFF.md](docs/BFF.md) for the contract, and the AICO full-stack bundles for a complete
stack (Traefik, oauth2-proxy, Keycloak, an API, PostgreSQL).

## Structure

```
openapi/openapi.json     the API contract the app depends on
src/api/generated/       typed client, react-query options, zod schemas (generated, committed)
src/routes/              file-based routes (TanStack Router); _authed/ requires a session
src/features/items/      the worked feature: queries, optimistic updates, form, list, page
src/shared/              ui primitives, i18n catalogue, problem-details parsing
mock/                    the mock gateway, security-header table, Vite plugin
nginx/                   production server config and entrypoint
e2e/                     Playwright specs (run against the mock or a real stack)
docs/                    ARCHITECTURE, BFF contract, EXTENDING, RELEASING
```

Licence: MIT (see `LICENSE`): the code you generate from this starter is yours.
