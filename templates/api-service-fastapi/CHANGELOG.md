# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `AUTH_MODE=oidc`: the service verifies an identity provider's access tokens instead of issuing its own.
  RS256 only (`none` and HS256 are refused), signature through a cached, rate-limited JWKS,
  `iss`, `aud`, `exp`, `nbf` (at most 60 s skew) and a UUID `sub` checked in the API itself.
  New variables: `AUTH_MODE` (default `local`), `OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE`
  (required in `oidc` mode; startup fails naming the missing one), and the tuning variables
  `OIDC_CLOCK_SKEW_SECONDS`, `OIDC_JWKS_CACHE_SECONDS`, `OIDC_JWKS_MIN_REFETCH_SECONDS`,
  `OIDC_JWKS_TIMEOUT_SECONDS`.
- Just-in-time user provisioning: the first valid token for a subject creates its user (id = `sub`),
  safe under concurrent first requests; an email already owned by another account is a 409
  `identity-conflict`, never a merge.
- In `oidc` mode `register`, `login`, `refresh` and `logout` answer 404, the demo seed is skipped, and
  `JWT_SECRET` is not required.
- Wire-contract tests that run the same assertions in both authentication modes (snake_case names,
  `limit`/`cursor` paging, optional `quantity`, problem+json).
- `pyjwt[crypto]` (adds `cryptography`) for RS256 verification.

### Changed

- A stored password hash that no hasher recognises (the sentinel given to provider accounts) now fails
  a local login with the ordinary 401 after the usual hashing delay, instead of raising.
- A missing `JWT_SECRET` in `local` mode is now reported as `JWT_SECRET is required when AUTH_MODE=local`.

## [0.1.0] - 2026-10-06

### Added

- Items API (create, list with cursor pagination and search, get, replace, delete) with ownership enforced in every query.
- Authentication: registration, login, rotating refresh tokens with reuse detection, logout, `/auth/me`; Argon2id password hashing.
- Health (`/healthz`) and readiness (`/readyz`) probes; RFC 9457 problem responses; request ids; structured JSON logs.
- Alembic migrations, a development seed, and `python -m app.cli` operational commands.
- Security headers, CORS allow-list, body-size limit, rate limiting; OpenTelemetry through FastAPI's native support, off unless configured.
- Test suite: unit, integration, security, property-based, and OpenAPI contract tests (Schemathesis); coverage gate 85%.
- Multi-stage non-root Docker image, compose stack with PostgreSQL, CI workflow, Dependabot, pre-commit.

[Unreleased]: https://example.invalid/compare/v0.1.0...HEAD
[0.1.0]: https://example.invalid/releases/tag/v0.1.0
