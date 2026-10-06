# __APP_TITLE__

A production-shaped JSON API on **Spring Boot 4.1** and **Java 25**: Spring MVC on virtual threads,
Spring Data JPA, Flyway, PostgreSQL, a JWT resource server with a local issuer (or, with one
setting, an external OIDC provider such as Keycloak), an OpenAPI 3.1 document, health probes, JSON
logs and OpenTelemetry hooks. One worked resource (`items`) with registration, login and ownership
checks shows the shape every feature should follow.

## Run

You need JDK 25 (`java -version`) and, for the best experience, Docker.

```
make setup     # creates .env.local with generated secrets (Windows without make: copy .env.example)
make dev       # app on http://localhost:8080 with a throwaway database and a demo user
```

`make dev` starts PostgreSQL in a container when Docker is running and falls back to an in-memory
H2 otherwise, seeds `demo@example.com` (the password is printed at startup), and serves:

| URL | What |
|---|---|
| `/swagger-ui/index.html` | interactive API explorer |
| `/v3/api-docs` | OpenAPI 3.1 document |
| `/healthz`, `/readyz` | liveness and readiness (readiness checks the database) |

Without `make`, use `./mvnw spring-boot:test-run -Dspring-boot.run.main-class=com.example.app.DevApplication`
(`mvnw ...` on Windows). The full stack as containers, the way production runs it: `make run`.

Try it:

```
curl -s -X POST localhost:8080/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"<printed at startup>"}'
curl -s localhost:8080/api/v1/items -H "Authorization: Bearer <access_token>"
```

JSON names are snake_case everywhere (`access_token`, `created_at`, `next_cursor`). Lists page by
cursor, newest first: `GET /api/v1/items?limit=50` returns `{"items": [...], "next_cursor": "..."}`;
send `next_cursor` back as `?cursor=` for the next page. `next_cursor` is `null` on the last page.
Cursors are opaque; do not build them.

## Check

```
make check     # = cov + audit + smoke
make cov       # ./mvnw verify: format, Error Prone + NullAway, unit + integration tests,
               #   85% line coverage gate, SpotBugs + FindSecBugs, SBOM
make audit     # dependency vulnerabilities (OSV-Scanner on the SBOM; needs Docker)
make smoke     # build the image, start it with PostgreSQL, walk the real API from outside
make fmt       # fix formatting
```

Integration tests run against real PostgreSQL (Testcontainers) when Docker is available and fall
back to H2 in PostgreSQL mode otherwise. `AICO_TEST_DB=postgres` makes the fallback an error.
The coverage report is in `target/site/jacoco/index.html`.

## Configure

Environment variables only; `.env.example` lists them, `application.properties` maps them. The app
validates its configuration at startup and refuses to start on a missing database, a short or
placeholder `APP_JWT_SECRET` (local mode), missing `OIDC_*` settings (oidc mode) or a bcrypt cost
below 10, naming the variable.

| Variable | Default | |
|---|---|---|
| `PORT` | 8080 | listen port |
| `DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD` | required | JDBC URL and credentials |
| `APP_AUTH_MODE` | local | `local` (this service signs tokens) or `oidc` (verifies an external provider's) |
| `APP_JWT_SECRET` | required in local mode | token signing key, 32+ characters; not used in oidc mode |
| `OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE` | required in oidc mode | exact `iss`, where the keys are fetched, required `aud` |
| `OIDC_CLOCK_SKEW`, `OIDC_JWKS_MIN_REFRESH` | 30s, 30s | token-time leeway (max 60s); minimum gap between key refetches |
| `APP_CORS_ALLOWED_ORIGINS` | none | comma separated browser origins |
| `APP_DOCS_ENABLED` | true (false in the image) | OpenAPI document and Swagger UI |
| `APP_OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT` | off | export traces, metrics, logs |

## Run behind an OIDC gateway

A single-page app and a BFF or gateway in front (for example Traefik + oauth2-proxy + Keycloak, so
the browser never holds a token) need nothing more than this service verifying the access token the
gateway forwards as `Authorization: Bearer ...`:

```
APP_AUTH_MODE=oidc
OIDC_ISSUER=http://localhost:8080/idp/realms/app          # exactly the token's iss
OIDC_JWKS_URI=http://keycloak:8080/idp/realms/app/protocol/openid-connect/certs   # internal URL
OIDC_AUDIENCE=app-api                                     # the token's aud must contain this
SERVER_FORWARD_HEADERS_STRATEGY=native                    # see "rate limits" below
```

In this mode the service verifies everything itself and trusts the proxy for nothing:

- RS256 only (`alg: none`, HS256 and every other algorithm are refused), signature from the JWKS
  (cached, refetched on an unknown `kid` at most once per `OIDC_JWKS_MIN_REFRESH`, with timeouts),
  `iss` equal to `OIDC_ISSUER`, `aud` containing `OIDC_AUDIENCE`, `exp` required, `nbf` honoured,
  `sub` a UUID. Any failure is a 401 problem, never a 500 (also when the provider is down).
- The account id is the token's `sub`; the email is the `email` claim, lower-cased (or
  `<sub>@oidc.invalid` when absent). The first request with a new `sub` creates the account (no
  sign-up step); two simultaneous first requests are safe.
- If another account already owns that email, the answer is 409 `identity-conflict`: accounts are
  never merged by email. A switched-off account (`accounts.is_active = false`) gets 403
  `account_disabled`.
- `POST /api/v1/auth/register` and `/login` answer 404 ("Local authentication is disabled"), the
  demo user is not seeded, and `APP_JWT_SECRET` is not needed. `GET /api/v1/auth/me` works.
- Rate limits: the limiter keys on the client address, which behind a proxy is the proxy.
  `SERVER_FORWARD_HEADERS_STRATEGY=native` makes Tomcat use the `X-Forwarded-For` the proxy sets
  (trusted only from private networks), so each user gets their own bucket; otherwise raise
  `APP_RATE_LIMIT_CAPACITY` and `APP_RATE_LIMIT_PER_MINUTE` or limit at the gateway.

Standalone behaviour is unchanged: leave `APP_AUTH_MODE` unset and it is `local`.

## Deploy

`docker build -t api-service .` builds a layered, non-root image on a pinned JRE base. Run it with
the variables above (plus `SPRING_PROFILES_ACTIVE=prod`, which the image sets). Put TLS in front of
it. See `deploy/README.md`.

## Structure

```
src/main/java/com/example/app/
  Application.java        composition root
  shared/                 kernel: error, page, config, web (filters), security, openapi
  identity/               register, login, token issuer      (api / app / domain / infra)
  items/                  the worked feature                 (api / app / domain / infra)
src/main/resources/db/migration/   Flyway migrations
src/test/java/...         unit, *IT integration, ArchitectureTest, ModularityTest, DevApplication
docs/ARCHITECTURE.md      how it is built and how it grows; docs/EXTENDING.md how to add to it
```
