# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction keeps this file when it
drops the transcript. Versions are the ones resolved in `go.mod`/`go.sum` and the pinned images on 2026-10-06
(checked against proxy.golang.org, the projects' release pages and `docker buildx imagetools inspect` that
day); every module in `go.mod` is used, and every tool is pinned exactly.

## Platform

- Go 1.27 (`go 1.27` in go.mod; image `golang:1.27.1`) — the newest stable line (1.27.1 released 2026-09-01),
  supported until two newer majors exist. `GOTOOLCHAIN=local` in the image, so the toolchain never changes
  under a build. Go 1.27 backs `encoding/json` with the v2 implementation: `internal/app/json_test.go` pins
  the JSON behaviours the API relies on (numbers, nulls, escapes, duplicates, unknown fields) so an upgrade
  that changes one fails a test instead of production.
- Standard-library router (`net/http` `ServeMux` with `METHOD /path/{id}` patterns), `log/slog`, `net/http/httptest`,
  `testing` — the router has had method and wildcard matching since 1.22, so a router dependency (chi, gin,
  echo) would add a package for nothing. `http.CrossOriginProtection` is not used: the API authenticates with
  an `Authorization` header, never a cookie, so there is no ambient credential for a cross-site request to abuse.
  `RequireJSON` still refuses form and text bodies as defence in depth.
- PostgreSQL 18.6 (image `postgres:18.6-alpine` pinned by digest; 18 is supported to 2030-11) — the one database
  every stage of growth stays on; SQLite was rejected as a dev mode because sqlc generates different Go for a
  different dialect, and two dialects is two bugs.
- Distroless `static-debian13:nonroot` runtime, CGO off, `-trimpath`, version stamped with `-ldflags` — one static
  file, no shell, no package manager, uid 65532. The image health check is the binary itself
  (`/server healthcheck`) because distroless has no curl. Alpine rejected: a shell and apk are attack surface the
  service never uses. The tools stage is Debian (`golang:1.27.1-bookworm`) because `-race` needs cgo and a C compiler.
- Everything pinned by version AND digest (images) or full SHA (GitHub Actions): a tag can be moved (the March 2026
  `trivy-action` tag rewrite showed it), a digest cannot. Dependabot keeps both fresh.

## Libraries (resolved versions)

- pgx v5.11.0 (native `pgxpool`, no `database/sql` in the request path) with **sqlc v1.31.1** generating the
  queries into `internal/platform/database/dbgen` — plain SQL checked against the schema at generation time, so a
  typo is a `make gen` failure and not a 500; no ORM (GORM and ent hide the SQL and the N+1s). `database/sql` is
  used for exactly one thing: goose speaks it, and the pool hands out a `*sql.DB` view of itself.
- goose v3.28.0 (embedded SQL migrations, session advisory lock) — chosen over golang-migrate 4.20.1 because its
  `Provider` API is a plain library call with a pluggable locker and fewer transitive dependencies, and sqlc reads
  goose files directly as its schema. Migrations are numbered, append-only, and embedded in the binary.
- oapi-codegen v2.8.0 + runtime v1.7.0, spec-first, std-http strict server, **models and server only** — the
  OpenAPI file is the contract; the strict interface makes a missing handler a compile error. Hand-maintained
  OpenAPI beside hand-written routes (the Node starter's approach) drifts; Huma (code-first) rejected because it
  makes the code the source of truth and the document an output. OpenAPI 3.0.3, not 3.1: the generator and
  kin-openapi centre on 3.0 today; move when both support 3.1 fully. The embedded-spec option is off because it
  would link kin-openapi into the binary.
- golang.org/x/crypto v0.57.0 (`argon2`) — Argon2id with explicit parameters m=64 MiB, t=3, p=1 (OWASP minimum is
  m=19 MiB, t=2, p=1; `config` refuses to go below it and a test pins the defaults), PHC-format hashes, rehash on
  login when the cost has moved, and a concurrency cap because each hash holds that memory. The wrapper
  `alexedwards/argon2id` rejected: 60 lines of our own are clearer than a dependency that last released in 2023.
- Opaque 256-bit session tokens, stored as SHA-256, instead of JWT (golang-jwt not used) — a session is revocable
  by deleting a row, there is no algorithm-confusion or key-rotation surface, and a leaked table cannot be replayed.
  For a single service issuing and verifying its own credentials this is simpler and safer. The growth step is OIDC
  (`coreos/go-oidc`), not self-issued JWTs.
- golang.org/x/time v0.16.0 (`rate`) — token buckets per client address, in process, with idle eviction. Per replica
  and peer-address only (X-Forwarded-For is not trusted); the real limit belongs at the gateway.
- OpenTelemetry v1.47.0 (`otel`, `sdk`, `trace`, `otlptracehttp`) and `otelhttp` v0.72.0 — off unless
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set; the SDK and exporter read the standard `OTEL_*` variables themselves, so there
  are no custom flags. Log lines carry `trace_id` and `span_id`. Heavy, but it is the standard, and the only
  dependency tree that grows because of it is the exporter's protobuf and gRPC modules.
- Hand-written config (env only), validation and request-id/CORS/rate-limit middleware — `caarlos0/env`,
  `go-playground/validator`, `rs/cors` and a request-id package each replace a few dozen lines with a dependency and
  a reflection or tag DSL that must be kept in step with the OpenAPI limits. `internal/app/contract_test.go` compares
  the spec's limits with the service's, which is the check a validator library would have hidden.
- Test-only: kin-openapi v0.149.0 (loads the spec, validates every response against it, and checks the spec's limits
  against the API) and go-cmp v0.7.0 (struct diffs). testify rejected (Google's Go style recommends the standard
  `testing` package with `cmp`); `testing.T.Context` and table tests need nothing more.
- Rejected on purpose: Wire (archived), viper, Gin/Echo/Fiber, GORM/ent, Testcontainers (needs a Docker socket, which
  the tools container does not have; a compose service and a CI service container give the same real PostgreSQL),
  River (a growth step, see docs/ARCHITECTURE.md), a DI framework.

## Structure

- `internal/features/<name>` with a domain `Service`, a `Repository` port, and HTTP, PostgreSQL and in-memory
  adapters; `internal/platform` shared kernel; `internal/app` the only composition root — package-by-feature, ports and
  adapters at the IO edges only. The in-memory repository is a test double held to the same contract suite as
  PostgreSQL, never a runtime mode.
- Ids are UUIDv7 generated in the application (`platform/ids`, with a counter so they are strictly increasing within a
  process) — known before the INSERT, time-ordered so keyset pagination is `ORDER BY id DESC` on the primary key, and
  not a row-count oracle like serial integers.
- Keyset (cursor) pagination, `limit` capped at 100 — OFFSET scans and discards rows and skips or repeats under inserts.
- Errors: domains return `apperr` kinds and `validate.Errors`; `httpx` maps them in one place to RFC 9457
  (`urn:problem:<code>` types, `request_id`, per-field `errors`). 422 for well-formed but invalid input, 400 for
  malformed, 415, 413, 429 with `Retry-After`. Unexpected errors are logged and masked.
- Ownership in the WHERE clause of every query: a foreign row is a 404, identical to a missing one.
- Authentication is deny-by-default: a route is protected unless listed in `publicRoutes`; a contract test keeps that
  list equal to the document's `security: []` operations.
- Readiness flips to 503 when shutdown starts, then the server drains for `SHUTDOWN_TIMEOUT` and exits 0 — the load
  balancer stops sending traffic before connections close.
- Migrations run at boot under an advisory lock by default (`MIGRATE_ON_START`), or as a release step with the server
  refusing to start while any are pending.

## Tooling

- golangci-lint v2.14.0 (`version: "2"`: standard linters plus gosec, revive, errorlint, noctx, sloglint, bodyclose, ...)
  and gofumpt/goimports through `golangci-lint fmt` — one tool, one config. govulncheck v1.8.0 (reachable
  vulnerabilities only, with a reviewed, expiring `.audit-allowlist`), cyclonedx-gomod v1.12.0 for the SBOM, osv-scanner
  and gitleaks (pinned images) and CodeQL in CI.
- The tools image (`docker compose --profile tools run --rm tools make check`) pins all of them, so a machine with only
  Docker runs the same gate as CI. `make` is a convenience wrapper; every verb is one command.
- Coverage gate 85% of statements, measured over `internal/...` with generated code excluded, with the race detector and
  real PostgreSQL (`REQUIRE_DB=1` turns a missing database into a failure, so the gate cannot pass by skipping).
- `template.json` uses the multi-stack schema: toolchain `go >=1.27`, `manifestFile: go.mod`, an env file with generated
  secrets, native-form checks (`go vet`, `go test`, `go run <linter>@version`) so they also work in the golang image
  fallback, and `docker compose up --build` for the dev loop, because the service needs PostgreSQL and the Go toolchain
  alone cannot provide one. The checks in the manifest run the fast suite; the full gate is `make check`.

## Verification record (2026-10-06)

- `node scripts/templates-verify-go.mjs` (repository root of aico) passed 67 checks from a clean copy with every Go command in
  Docker: gofumpt/goimports clean, golangci-lint v2.14.0 0 issues, `go vet`, tidy and generated-code checks, tests with `-race`
  against PostgreSQL 18.6 at 96.3% statement coverage (gate 85%), govulncheck v1.8.0 clean, CycloneDX 1.6 SBOM (37 components),
  the production image (8.2 MiB, non-root, healthcheck, version stamped), the compose stack over HTTP, the seed command, a
  graceful SIGTERM exit 0, a restart, login throttling, and `scripts/smoke.sh`.
- govulncheck also lists GO-2026-5932 (the unmaintained `golang.org/x/crypto/openpgp` package, no fix) at module level: nothing
  here imports openpgp, so it is not reachable and not in `.audit-allowlist`. Watch for it if you add a dependency that signs or
  encrypts with OpenPGP.
- Not run on the build machine: the GitHub Actions workflow itself (its steps are the same commands, run here), the pre-commit
  hooks, the devcontainer, and a native (non-Docker) Go toolchain.

## Resource-server mode, `AUTH_MODE=oidc` (template 1.1.0, 2026-10-06)

- **Why a second mode and not a replacement.** A full-stack bundle puts one SPA behind a gateway (Traefik + oauth2-proxy
  as the backend-for-frontend, Keycloak as the identity provider): the browser never holds a token and the gateway
  forwards `Authorization: Bearer <access token>`. The API is then a plain OAuth 2.0 resource server. The standalone
  starter keeps working exactly as before because the default is `local`; the mode is chosen once, at the composition root
  (`app.New`), and `identity.Principal`, the middleware and every feature are untouched. Every request is verified in the
  API's own code path, never on the gateway's say-so (defence in depth: a mis-routed request that skips the gateway still
  needs a valid token). The older line above that says golang-jwt is not used describes local mode, which still uses opaque
  sessions; oidc mode is the "growth step" it names, built with the libraries below instead of `coreos/go-oidc`.
- **JWT library: `golang-jwt/jwt/v5` v5.3.1 (MIT) + `MicahParks/keyfunc/v3` v3.8.2 and `jwkset` v0.11.3 (Apache-2.0).**
  jwt v5 is the maintained parser and lets the verifier pin RS256, require `exp`, and check `iss`/`aud`/`nbf`/`iat` with
  an explicit leeway; keyfunc + jwkset give a cached JWKS with an hourly refresh and a rate-limited refetch on an unknown
  `kid` (`rate.Limiter`, reusing the `golang.org/x/time` already in `go.mod`), a client timeout, and a `use` filter. All
  three are used. Rejected: `coreos/go-oidc/v3` (the first candidate): `RemoteKeySet` refetches on every unknown `kid`
  with no rate limit, so a flood of forged key ids becomes a flood of requests to the identity provider; its verifier
  models ID tokens, and it applies a fixed 5-minute not-before leeway where the contract allows 60 s. `lestrrat-go/jwx`
  v3 (MIT): a complete JOSE suite, a much larger surface than one RS256 verifier needs. Hand-rolled JWS/JWKS with
  `crypto/rsa`: JOSE verifier bugs (algorithm confusion, kid handling, base64 edge cases) are well documented, and a
  library with many users is safer than 150 lines of ours.
- **What is enforced** (`internal/features/auth/jwks.go`; the RS256 pin was checked by deleting it and watching
  `TestVerifyRefusesUntrustedKeys` fail): RS256 only, in the parser (a JWKS entry's own `alg` is not trusted to do it,
  because many identity providers omit it); `iss` byte for byte; `aud` contains `OIDC_AUDIENCE`; `exp` required; `nbf`
  and `iat` honoured; leeway `OIDC_CLOCK_SKEW` (default 30 s, at most 60 s); `sub` must be a UUID (canonicalised to lower
  case); the token must carry a `kid` (without one keyfunc would try every key in the set, including keys we never meant
  to trust); the key must be RSA of at least 2048 bits; keys published with `use=enc` are ignored; strict base64
  decoding; tokens over 8 KiB are refused before parsing. Every failure is the same 401 problem document; the reason
  goes to the debug log, never the token.
- **JWKS refresh policy.** Fetched once at start, refreshed hourly (so a revoked key disappears within the hour), and
  refetched for an unknown `kid` at most once per 15 s with a 5 s bound on the fetch and on waiting for the limiter, so a
  forged-kid flood costs at most one request per interval and fails fast in between (`TestUnknownKidFloodDoesNotHammer...`
  counts the requests the fake provider receives). The API starts even when the identity provider is not up yet: refusing
  to start would turn a slow boot order into an outage; until keys arrive every token is a 401, and the first token with
  a `kid` after the provider is back triggers the fetch. `OIDC_JWKS_URI` is separate from `OIDC_ISSUER` because the keys
  are fetched over an internal address while the issuer is the public URL inside the token.
- **Identity mapping and just-in-time provisioning** (`provision.go`). The user id IS the token `sub`, so `items.owner_id`
  is the identity provider's stable identifier; the `users` row exists because `items.owner_id` references it. It is
  created on first sight with `INSERT ... ON CONFLICT (id) DO NOTHING` (`CreateIfAbsent`, sqlc `:execrows`): two
  simultaneous first requests both succeed, the loser re-reads, and a repository contract test fires 24 concurrent callers
  at both the memory fake and PostgreSQL and requires exactly one insert. The password hash is the sentinel
  `!oidc-no-local-password`, which is not an Argon2id encoding: `Login` recognises it before the hasher would reject it as
  malformed (a 500) and answers the normal 401 after the same dummy hash work as an unknown email. Email is the `email`
  claim lower-cased, or `<sub>@oidc.invalid` (a reserved domain: it can never receive mail or collide) when the claim is
  absent or not an address. A later, different, valid claim updates the stored email; a later token without the claim
  never overwrites a real address with the placeholder.
- **Email collisions are a 409, never a merge.** If a different account already owns the email (a local account, or
  another subject), the answer is `409 urn:problem:identity-conflict` (`apperr.NewCoded`: same status and title as any
  conflict, a more specific `type`) and nothing is created or changed. Matching by email would let whoever controls an
  email claim take over a pre-existing account; silently merging is the same takeover with a log line. An operator
  resolves a collision by deleting or renaming the old account. Rejected: linking on `email_verified` (not every identity
  provider sets it truthfully, and the starter would then need account-linking UX).
- **No schema change, and no `is_active`.** This starter's `users` table has no `is_active` column and nothing refuses a
  disabled account today, so there is nothing to refuse. Disabling a person is the identity provider's job: a disabled
  Keycloak user gets no new tokens and existing ones expire in minutes. Adding a column, a migration and a per-request
  check is the growth step if you need to cut a user off before their token expires; the `ByID` lookup that provisioning
  already does on every request is where that check would go. Migration `00001` is untouched.
- **Local credential endpoints.** In `oidc` mode `register`, `login` and `logout` answer `404 Local authentication is
  disabled: AUTH_MODE=oidc` from a middleware that runs before authentication and before the body is read (so a malformed
  body or a missing token cannot turn it into a 400 or 401), and the handlers check again so a route mounted without that
  middleware still fails closed. `server seed` is a no-op that exits 0, so a compose file that always runs it still works.
  There is no `refresh` endpoint in this starter. `auth/me` and the items routes work as before.
- **Fail fast.** `AUTH_MODE` must be `local` or `oidc` (default `local`); in `oidc` mode `OIDC_ISSUER`, `OIDC_JWKS_URI` and
  `OIDC_AUDIENCE` are required and validated (absolute http(s) URL, no credentials or fragment; the issuer no query) and
  every problem is reported at once with the variable named and no value echoed (a URL could embed a password). In `local`
  mode the `OIDC_*` variables are ignored, not validated. `app.New` rebuilds the verifier from the validated configuration
  and the verifier itself refuses a skew above 60 s, so a caller that bypasses `config.Load` cannot weaken it.
- **Wire contract for the shared client.** The contract already matched: snake_case JSON, `limit` 1..100 (default 50) and
  `cursor`, `next_cursor` absent on the last page, `quantity` optional, full-replace `PUT` with no required version,
  RFC 9457 problems, `/healthz` and `/readyz` unauthenticated. The only gap was documentary: `description` accepts `null`
  (it always did) but the spec did not say so, so `CreateItem.description` is now `nullable: true`; oapi-codegen v2.8.0
  output is byte-identical. `TestWireContractForTheSharedClient` replays the contract in both modes (property names at
  every depth, a three-page cursor walk, optional `quantity`, null description, problem documents).
- **Tests without a network.** `internal/platform/oidctest` is an in-process identity provider: it generates RSA keys once
  per test process, serves them as a JWKS from `httptest`, counts requests, rotates keys, can be made to fail, and signs
  both valid tokens and every hostile variant (`alg: none`, HS256 keyed with public material, RS512, forged signature,
  unknown or missing `kid`, tampered payload, weak and encryption keys). Nothing in it is imported by the binary.

## Verification record, oidc mode (2026-10-06)

- Resolved for the new dependencies: `github.com/golang-jwt/jwt/v5` v5.3.1, `github.com/MicahParks/keyfunc/v3` v3.8.2,
  `github.com/MicahParks/jwkset` v0.11.3 (latest stable on the Go module proxy that day; no new transitive module: `jwkset`
  needs only `golang.org/x/time`, already required). govulncheck v1.8.0: no reachable vulnerabilities. SBOM: 40 components.
- `node scripts/templates-verify-go.mjs` from a clean copy, every Go command in Docker: formatting, golangci-lint v2.14.0
  (0 issues), vet, tidy, generated code current (oapi-codegen v2.8.0 and sqlc v1.31.1), `go test -race` against
  PostgreSQL 18.6 at 96.4% statement coverage (gate 85%, 17 packages, nothing skipped), govulncheck, SBOM, then the
  production image (8.3 MiB), the compose stack over HTTP in local mode, seed, graceful SIGTERM, restart, throttling and
  `scripts/smoke.sh`. The first run stopped at the compose step because another process took the random host port the script
  had just picked; the run was repeated with `--skip-checks` (every check above had already passed) and passed.
- 190 top-level tests, 346 with subtests, 0 failed, 0 skipped. The oidc paths are covered over HTTP, over a real socket
  (`TestServeInOIDCMode`) and against PostgreSQL (`TestOIDCAgainstPostgres`: 24 concurrent first requests, one row).
- Not run: the compose stack in `AUTH_MODE=oidc` against a real Keycloak and a gateway (the verifier is tested against an
  in-process JWKS, never against Keycloak's actual key set or token layout); `OIDC_JWKS_URI` over `https` with a private
  CA (the default HTTP client is used, so a private CA needs the system trust store of the image).
