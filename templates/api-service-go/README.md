# __APP_TITLE__

__APP_DESCRIPTION__

A production-shaped JSON API on Go 1.27 and the standard library. The OpenAPI document is
the contract: the server interface, the models and the SQL layer are generated from it
and from the SQL, so the compiler tells you when code and contract disagree. PostgreSQL,
Argon2id accounts with opaque bearer sessions, RFC 9457 errors, structured logs, rate
limits, graceful shutdown, and a distroless non-root image. One worked resource (`items`)
to copy.

## Run

You need Docker. You do not need Go: the toolchain and every linter run from a pinned image.

```sh
make setup                  # .env with generated secrets (or: cp .env.example .env and edit)
docker compose up --build   # PostgreSQL + the API at http://localhost:8080
make seed                   # optional: demo@example.com with 3 sample items
```

```sh
curl -s localhost:8080/healthz
curl -s -X POST localhost:8080/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse battery staple"}'
TOKEN=$(curl -s -X POST localhost:8080/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse battery staple"}' | sed 's/.*"access_token":"\([^"]*\)".*/\1/')
curl -s -X POST localhost:8080/v1/items -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"pen","quantity":3}'
curl -s localhost:8080/v1/items -H "authorization: Bearer $TOKEN"
```

| Route | What |
|---|---|
| `GET /healthz` | liveness (no dependency checked) |
| `GET /readyz` | readiness (database answers, not draining) |
| `GET /openapi.yaml` | the contract this server was generated from |
| `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/logout` | local accounts and sessions (404 when `AUTH_MODE=oidc`) |
| `GET /v1/auth/me` | the signed-in user (both modes) |
| `GET/POST /v1/items`, `GET/PUT/DELETE /v1/items/{id}` | the worked resource (owner-scoped, cursor pagination) |

## Check

Every verb is the same in every AICO starter: `setup dev fmt lint test cov audit build check run`.

```sh
make check                  # fmt-check, lint, vet, tidy, cov (race + PostgreSQL + 85% gate), audit
make docker-check           # the same inside the pinned tools image: no local Go needed
docker compose --profile tools run --rm tools make check   # what docker-check runs
```

Without `make` (Windows), use the second form; it is one command. With Go 1.27 installed,
`go test ./...` runs the fast suite (the PostgreSQL tests skip unless `TEST_DATABASE_URL` is set;
`make db-up` starts a database and `make cov` runs everything).

## Configure

Environment only, validated at startup (every problem is reported at once, no value echoed).

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | `postgres://user:password@host:5432/db?sslmode=verify-full` |
| `APP_ENV` | `development` | `development`, `production`, `test` (production adds HSTS, refuses `seed`) |
| `HOST`, `PORT` | `0.0.0.0`, `8080` | listen address |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `CORS_ALLOWED_ORIGINS` | none | comma-separated origins; no wildcard |
| `MAX_BODY_BYTES` | `1048576` | request body cap |
| `RATE_LIMIT_RPS`, `RATE_LIMIT_BURST` | `20`, `40` | per client address, per replica |
| `AUTH_RATE_LIMIT_PER_MINUTE`, `AUTH_RATE_LIMIT_BURST` | `10`, `5` | login and register |
| `AUTH_MODE` | `local` | `local` (accounts and sessions here) or `oidc` (verify identity-provider tokens) |
| `OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE` | required when `AUTH_MODE=oidc` | exact `iss`; where the signing keys are fetched (an internal URL is fine); required `aud` |
| `OIDC_CLOCK_SKEW` | `30s` | leeway for `exp`, `nbf`, `iat` (0 to 60s), `oidc` mode only |
| `SESSION_TTL` | `24h` | local bearer token lifetime |
| `REQUEST_TIMEOUT`, `SHUTDOWN_TIMEOUT` | `10s`, `20s` | per-request deadline, drain window |
| `DB_MAX_CONNS`, `MIGRATE_ON_START` | `10`, `true` | pool size; apply migrations at boot |
| `ARGON2_MEMORY_KIB`, `ARGON2_ITERATIONS`, `ARGON2_PARALLELISM` | `65536`, `3`, `1` | password hashing cost (floor: 19456 KiB, 2) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | off | set it and traces export over OTLP/HTTP |

## Run behind an OIDC gateway

The service can be a plain OAuth 2.0 resource server: a gateway (Traefik + oauth2-proxy, an API
gateway, a service mesh) signs the user in with an identity provider such as Keycloak and forwards
each request with `Authorization: Bearer <access token>`. Set

```sh
AUTH_MODE=oidc
OIDC_ISSUER=https://idp.example.com/realms/app          # exact `iss`, byte for byte
OIDC_JWKS_URI=http://keycloak:8080/realms/app/protocol/openid-connect/certs   # may be internal
OIDC_AUDIENCE=app-api                                    # the access token must carry this `aud`
```

Without all three the process exits with code 2 naming the missing variable. Every request is
verified here, never on the gateway's say-so: RS256 only (`none` and `HS*` are refused), signature
from the cached JWKS (refetched on an unknown `kid`, at most once per 15 s, 5 s timeout), `iss`,
`aud`, `exp` (required) and `nbf` with at most 60 s of skew, and a `sub` that is a UUID. Any failure
is the normal 401 problem document.

The user id is the token `sub`; the email is the `email` claim, lower-cased (`<sub>@oidc.invalid`
when absent). The first request of a new subject creates the `users` row (the password hash is an
unusable sentinel, so no local login can ever match it), safely under concurrency. If another
account already owns that email the answer is `409 urn:problem:identity-conflict`: accounts are never
merged by email. In this mode `register`, `login` and `logout` answer 404, `server seed` does nothing,
and `/v1/auth/me` plus every items route work as before. `/healthz`, `/readyz` and `/openapi.yaml`
stay open. The default is `local`, so a standalone service is unchanged.

## Deploy

`deploy/README.md`. In short: `node deploy/docker.mjs` builds the image; it needs PostgreSQL and
`DATABASE_URL`; run it read-only, as non-root, behind TLS.

## Structure

```
api/openapi.yaml            the contract (edit first); embedded and served at /openapi.yaml
cmd/server/                 five lines: signals in, exit code out
internal/cli/               serve, migrate, seed, healthcheck, version
internal/app/               composition root, middleware order, graceful Serve
internal/features/items/    the worked resource: domain, handler, postgres, memory fake
internal/features/auth/     accounts, Argon2id, sessions, JWT/JWKS verifier, JIT provisioning, the auth middleware
internal/platform/          shared kernel: config, httpx, apperr, ids, ratelimit, database, telemetry
internal/api/               generated server interface and models (do not edit)
db/migrations, db/queries   goose migrations (append only) and sqlc queries
docs/                       ARCHITECTURE, EXTENDING, RELEASING
.aico/                      backlog and decisions
```
