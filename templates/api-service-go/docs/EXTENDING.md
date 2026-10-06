# Extending this service

Everything below is run with `docker compose --profile tools run --rm tools make <verb>` if you
have no local Go; with Go installed, drop the prefix.

## Add a resource (the main move)

Copy `internal/features/items/` to `internal/features/orders/` and rename inside it.

1. **Contract first.** Add the paths and schemas to `api/openapi.yaml` (operation ids, request
   and response schemas, `additionalProperties: false` on request bodies, limits). Run `make gen`:
   the generated `StrictServerInterface` now has your new methods and the build fails until they
   exist.
2. **Migration.** Add `db/migrations/00002_add_orders.sql` (`-- +goose Up` / `-- +goose Down`).
   Real constraints: `NOT NULL`, `CHECK`, `REFERENCES ... ON DELETE`, and an index that serves the
   list query (`(owner_id, id DESC)`). Never edit a migration that has shipped; add another.
3. **Queries.** Add `db/queries/orders.sql` (`-- name: GetOrder :one`). Every query has
   `owner_id` in its `WHERE`. `make gen` writes the Go.
4. **Domain.** In `orders.go`: the type, the `Repository` interface, the `Service` with the
   validation (return `validate.Errors`) and the ids and timestamps. Declare
   `ErrNotFound = apperr.New(apperr.KindNotFound, ...)`.
5. **Adapters.** `postgres.go` wraps the sqlc queries and maps `pgx.ErrNoRows` to `ErrNotFound`;
   `memory.go` is the in-memory fake. Both must pass the shared contract test: copy
   `repository_contract_test.go` and call `runRepositoryContract` for each.
6. **Handler.** `handler.go` implements the new generated methods: read the caller with
   `identity.FromContext`, call the service, return the generated response type or an error.
7. **Wire it.** In `internal/app/app.go`: construct the service, add `ordersAPI struct{ *orders.Handler }`
   to the `server` struct, and add the Postgres repository to `PostgresOptions` and the memory one
   to the test options. The compile-time assertion `var _ api.StrictServerInterface = server{}`
   fails if a generated method has no implementation.
8. **Tests.** The service tests (copy `items_test.go`), the cross-user cases (copy
   `TestOtherUsersItemsAreInvisible`), and a probe in `TestRequestLimitsInTheDocumentMatchTheService`
   for each limit you added to the spec. `TestResponsesMatchTheDocument` replays the API and
   validates every response against the spec: add your calls to its scenario.
9. `make check`, then `AppManage start` / `docker compose up --build` and call the new routes.

## Add a column

New migration (`ALTER TABLE items ADD COLUMN sku text NOT NULL DEFAULT ''`; a `NOT NULL` column needs a
default or a backfill so it applies to existing rows). Then: the queries, `make gen`, the domain
type, the adapters, the OpenAPI schemas, and a test. The contract tests fail until the memory
fake and PostgreSQL agree.

## Protect a route differently

- Any signed-in user: the default. A route is protected unless it has `security: []` in the
  document **and** is listed in `publicRoutes` in `internal/app/app.go`; a test keeps the two
  identical, so a route cannot become public by accident.
- A role: add a column, put it in `identity.Principal`, return it from `SessionRepository.Lookup`,
  and check it in the service (`apperr.KindForbidden` is a new kind: add it to `apperr` and to
  the mapper in `httpx/problem.go`, with a test).
- A tighter rate limit: a second `ratelimit.Limiter` and `httpx.RateLimit(limiter, httpx.PathPrefix(...))`
  in `app.New`.

## Call another service

Use one `http.Client` with an explicit `Timeout`, owned by the composition root and passed to the
adapter that needs it (an interface in the feature, the client in an `adapters` file). Retry only
idempotent calls, with bounded jittered backoff, and never retry on a deadline the caller set.
Treat the response as untrusted data. If you fetch a URL a user supplied, guard against SSRF: refuse
loopback, link-local and private addresses after DNS resolution (a `net.Dialer.Control` hook) and do
not follow redirects blindly. A call with no timeout is a goroutine that can hold a connection forever.

## Add a background job

Keep it in-process only if it is idempotent and safe to run twice (two replicas both run it): start it
from `app.New` with the `ctx` so it stops on shutdown. Anything that must not be lost belongs in a
queue: River (PostgreSQL, transactional enqueue) is the natural next step, see `docs/ARCHITECTURE.md`.

## Use an identity provider instead of local passwords

Already built: set `AUTH_MODE=oidc` (see the README, "Run behind an OIDC gateway"). The seam is
`auth.TokenVerifier` (`jwks.go`: RS256 JWTs checked against a cached JWKS) plus `provision.go` (maps
the token `sub` to a `users` row, created on first sight). `identity.Principal` and the middleware are
unchanged, so items and your own features only read the principal.

To go further: once nothing needs local accounts, delete register, login, logout and the `sessions`
table (a migration; the `users` table stays because `items.owner_id` references it). To authorise by
role or scope, extend `auth.Claims` and the `accessClaims` struct in `jwks.go` (for Keycloak,
`realm_access.roles`), carry the value in `identity.Principal`, and check it in the feature that
needs it; authentication stays in the middleware. A different IdP needs only the three `OIDC_*`
values, as long as it signs access tokens with RS256 and puts a UUID in `sub`. Another algorithm
(ES256, EdDSA) means changing `oidcAlg`, the parser option and the key check together, with tests.

## Make it multi-tenant

Add `tenant_id` to `Principal` and to every table, put it in every `WHERE` next to `owner_id`, and add
a cross-tenant test per route. Consider PostgreSQL row-level security as a second line of defence.

## What not to do

- No SQL in handlers or services; it lives in `db/queries` and the adapter.
- No writing error bodies in handlers; return an error and let `httpx` render it.
- No editing generated files (`internal/api`, `dbgen`); edit the spec or the SQL and `make gen`.
- No secrets in code, tests (other than obviously fake ones marked `standards-allow: secret`) or the image.
- No `log.Println`; use the `slog` logger with a context so request ids appear.
- No new dependency without a line in `.aico/decisions.md` saying what it replaces and why.
