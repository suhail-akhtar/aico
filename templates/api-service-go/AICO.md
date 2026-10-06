# __APP_TITLE__

A JSON API: Go 1.27 stdlib, spec-first OpenAPI, PostgreSQL (pgx + sqlc + goose).
aico starts it with `docker compose up --build` (API + Postgres) and waits for
"server listening". No Go on the host? Checks run in the golang image; never install Go.

## Layout

- `api/openapi.yaml` — **the contract. Edit first**, then `make gen` (oapi-codegen + sqlc).
- `internal/api/` and `internal/platform/database/dbgen/` — generated; never edit by hand.
- `internal/features/<name>/` — domain + Service, `handler.go`, `postgres.go`, `memory.go`.
  **items is the worked example: copy it.** `auth` = accounts and bearer sessions, or with
  `AUTH_MODE=oidc` a JWT/JWKS verifier plus JIT provisioning (`OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE`).
- `internal/platform/` — shared kernel (config, httpx, apperr, ids). Imports no feature.
- `internal/app/` — composition root. `db/migrations/` — goose, append only; `db/queries/` — sqlc.

## Conventions

- Handlers return errors (`apperr`, `validate.Errors`); httpx renders RFC 9457. Never write error bodies.
- Every query filters on `owner_id`; someone else's row is a 404. Config from env only.
- A repository change must pass the shared contract test for the memory fake and Postgres.

## Checks

`RunChecks`: gofumpt, golangci-lint, go vet, go test. Full gate (Postgres, -race, 85%):
`docker compose --profile tools run --rm tools make check`. Then `AppManage start` and
`VerifyApp` `/healthz`, then register, log in and POST `/v1/items` with the token.
