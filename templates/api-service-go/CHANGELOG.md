# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Resource-server mode: `AUTH_MODE=oidc` (default `local`) verifies access tokens from an external OpenID Connect
  provider (RS256 only, JWKS from `OIDC_JWKS_URI`, exact `OIDC_ISSUER`, required `OIDC_AUDIENCE`, skew up to 60 s via
  `OIDC_CLOCK_SKEW`), so the service can sit behind an OIDC gateway such as Traefik + oauth2-proxy + Keycloak.
  The process refuses to start in this mode without the three `OIDC_*` settings.
- Just-in-time provisioning: the token `sub` is the user id; the first request of a subject creates the `users` row
  (race-safe, `ON CONFLICT (id) DO NOTHING`) with an unusable password hash; a changed `email` claim updates the row;
  an email owned by another account is `409 urn:problem:identity-conflict` (accounts are never merged).
- In `oidc` mode `register`, `login` and `logout` answer 404 (`Local authentication is disabled: AUTH_MODE=oidc`) and
  `server seed` does nothing.
- `apperr.NewCoded` and a problem `type` that can be more specific than the status category.
- `internal/platform/oidctest`: an in-process identity provider (JWKS server and token signer) for tests.
- Tests: verifier (valid, expired, not yet valid, wrong issuer or audience, `alg: none`, HS256 key confusion, RS512,
  tampered payload, unknown and rotated `kid`, forged-kid flood, weak and encryption keys, missing or non-UUID `sub`),
  provisioning (concurrency, collisions, email updates, storage failures), configuration fail-fast, and a wire-contract
  test of the JSON shape (snake_case, `limit`/`cursor` paging, optional `quantity`) in both modes.

### Changed

- `UserRepository` gained `ByID`, `CreateIfAbsent` and `UpdateEmail` (memory and PostgreSQL, one contract suite).
- `api/openapi.yaml`: `description` of a created or replaced item is documented as nullable (the service already
  accepted `null`); the API description mentions both authentication modes. Generated code is unchanged.
- New dependencies: `github.com/golang-jwt/jwt/v5` v5.3.1, `github.com/MicahParks/keyfunc/v3` v3.8.2 and
  `github.com/MicahParks/jwkset` v0.11.3 (see `.aico/decisions.md`).

## [0.1.0] - 2026-10-06

### Added

- Items API (create, list with keyset pagination, get, replace, delete) with ownership enforced in every query.
- Accounts: register, login, logout, `/v1/auth/me`; Argon2id password hashing and opaque, revocable bearer sessions.
- Health (`/healthz`) and readiness (`/readyz`) probes; the served `/openapi.yaml`; RFC 9457 problem responses;
  request ids; structured JSON logs with trace correlation.
- Spec-first OpenAPI (oapi-codegen strict server), sqlc queries, goose migrations on PostgreSQL.
- Security headers, CORS allow-list, body-size and media-type limits, rate limiting, graceful shutdown.
- OpenTelemetry tracing, off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- Tests: unit, repository contract (memory fake and PostgreSQL), API, security, JSON edge cases, OpenAPI contract;
  race detector; coverage gate 85%.
- Distroless non-root image, compose stack with PostgreSQL, pinned tools image, CI workflow, Dependabot, pre-commit,
  SBOM, govulncheck with an expiring allow-list.

[Unreleased]: https://example.invalid/compare/v0.1.0...HEAD
[0.1.0]: https://example.invalid/releases/tag/v0.1.0
