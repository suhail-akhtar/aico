# __APP_TITLE__

__APP_DESCRIPTION__

A production-shaped JSON API on **.NET 10 (LTS)** and ASP.NET Core minimal APIs: JWT authentication with
refresh-token rotation (or, with `AUTH_MODE=oidc`, a resource server for your identity provider), a worked owner-scoped `items` resource, EF Core migrations, RFC 9457 errors, an OpenAPI
3.1 contract that is tested, rate limiting, security headers, health probes, structured logs, OpenTelemetry,
and a distroless non-root container. Warnings are errors; `make check` is the whole bar.

## Run

```sh
cp .env.example .env     # then edit it; AICO writes the same file as .env.local with random secrets
make dev                 # http://127.0.0.1:5080 on SQLite: no database server, seeded demo user
```

Without `make`: `dotnet tool restore && dotnet run --project src/ApiService --launch-profile Development`.
Interactive docs (Development only): <http://127.0.0.1:5080/scalar/v1>. Demo login: `demo@example.test` and the
`Seed__DemoPassword` from your `.env`.

```sh
TOKEN=$(curl -s localhost:5080/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@example.test","password":"<Seed__DemoPassword>"}' | sed 's/.*"access_token":"\([^"]*\)".*/\1/')
curl -s localhost:5080/items -H "authorization: Bearer $TOKEN"
curl -s localhost:5080/items -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"pen","quantity":3}'
```

| Route | What |
|---|---|
| `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` | credentials and tokens (rate limited; 404 in OIDC mode) |
| `GET /auth/me` | the signed-in account |
| `GET/POST /items`, `GET/PUT/DELETE /items/{id}` | the worked resource: owner-scoped, paginated (`?limit=1..100&cursor=`, `next_cursor` in the answer), validated |
| `GET /healthz`, `GET /readyz` | liveness, readiness (database answers, not shutting down) |
| `GET /openapi/v1.json` | the OpenAPI 3.1 document (`OpenApi__Enabled=false` hides it) |

Every JSON property is **snake_case** (`created_at`, `next_cursor`, `access_token`), in requests and responses: one naming policy
in `Platform/PlatformExtensions.cs`, pinned by `WireContractTests` and the OpenAPI snapshot. A request member spelled in
camelCase is rejected like any other unknown member.

## Run behind an OIDC gateway

By default the service signs its own tokens (`Auth__Mode=local`). To put it behind an identity provider (Keycloak, Entra ID,
Auth0, ...) and a gateway or BFF that forwards `Authorization: Bearer <access token>`, switch to resource-server mode:

```sh
AUTH_MODE=oidc
OIDC_ISSUER=http://localhost:8080/idp/realms/app          # the exact `iss` in the tokens (the PUBLIC issuer URL)
OIDC_JWKS_URI=http://keycloak:8080/idp/realms/app/protocol/openid-connect/certs   # where to fetch the keys (may be internal)
OIDC_AUDIENCE=app-api                                      # the `aud` the tokens must carry
```

All three are required in this mode; the process refuses to start without them and names the one that is missing. The service
validates every token itself (the gateway's say-so is not trusted): signature from the JWKS (cached for an hour, refetched when a
token names an unknown `kid`, at most once per 30 s, 5 s timeout), **RS256 only**, `iss` equal to `OIDC_ISSUER`, `aud`
containing `OIDC_AUDIENCE`, `exp` required, 30 s leeway, `sub` a UUID. The first request with a new `sub` creates the user row
(id = `sub`, email from the `email` claim, or `<sub>@oidc.invalid`); if another account already uses that email the answer is
**409** `identity_conflict` (accounts are never merged). `register`, `login`, `refresh` and `logout` answer 404, the dev seed
user is not created, and `Jwt__SigningKey` is not needed. `/auth/me`, `/items`, `/healthz` and `/readyz` behave as before; the
OpenAPI document is identical in both modes. A gateway that maps `/api/v1/*` to `/*` needs no other change.

## Check

```sh
make check      # fmt-check + lint + typecheck + tests with the 85 % coverage gate + vulnerability audit
make test-pg    # the same suite against real PostgreSQL in a container (needs Docker)
make up         # PostgreSQL + one-shot migration + the API in containers, then curl localhost:8080/healthz
```

Tests run the real application in memory (no port, no network) on SQLite; CI also runs them on PostgreSQL. They
cover unit rules, the API end to end, the OpenAPI contract (snapshot), architecture rules, and security
(ownership, forged tokens, injection strings, oversized bodies, CORS, rate limits, error leakage).

## Configure

Environment only (ASP.NET Core configuration, `__` for `:`). The app validates everything at startup and refuses to
start on a missing or unsafe value. Full list in `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `ConnectionStrings__Default` | SQLite file in Development | PostgreSQL connection string (required in production) |
| `Jwt__SigningKey` | none | local mode: at least 32 characters; the `change-me` placeholder is refused outside Development |
| `AUTH_MODE` (or `Auth__Mode`) | `local` | `local` or `oidc`; any other value stops startup |
| `OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE` (or `Oidc__Issuer`, `__JwksUri`, `__Audience`) | none | required in oidc mode |
| `Oidc__JwksTimeoutSeconds` / `Oidc__JwksRefreshIntervalSeconds` | 5 / 30 | key fetch timeout; minimum seconds between unknown-`kid` refetches |
| `Database__MigrateOnStartup` | `false` | `true` applies migrations at start (compose); production runs `ApiService --migrate` once |
| `Cors__AllowedOrigins` | none | comma-separated exact origins |
| `RateLimit__PermitLimit` / `__AuthPermitLimit` | 120 / 10 per minute | per client address |
| `ForwardedHeaders__Enabled` + `__KnownNetworks` | off | trust `X-Forwarded-*` from your proxy's CIDR only |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset = off | OpenTelemetry traces, metrics and logs |

## Deploy

`deploy/README.md`. Short version: `node deploy/docker.mjs` builds the image (chiseled, non-root, read-only
filesystem friendly); run `docker run <image> --migrate` once per release, then start the service.

## Structure

```
src/ApiService/   Program.cs (composition) | Features/{Auth,Items} | Platform/ | Persistence/ | SharedKernel/
tests/            ApiService.Tests: in-memory host, contract snapshot, architecture rules
docs/             ARCHITECTURE.md (growth path), EXTENDING.md (how to add things), RELEASING.md
.aico/            backlog and decisions (why each choice was made)
```

The starter is MIT-licensed (`LICENSE`) so the app you build from it is yours; replace the file with your own licence.
