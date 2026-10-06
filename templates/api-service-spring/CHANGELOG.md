# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- OIDC resource-server mode (`APP_AUTH_MODE=oidc`, `OIDC_ISSUER`, `OIDC_JWKS_URI`,
  `OIDC_AUDIENCE`): verifies RS256 access tokens from an external provider (signature from the JWKS
  with a rate-limited refetch, issuer, audience, `exp`, `nbf`, UUID `sub`), creates the account on
  first sight of a `sub`, answers 409 `identity-conflict` rather than merging accounts by email,
  403 `account_disabled` for a switched-off account, and turns `register`/`login` into 404.
  `APP_JWT_SECRET` is not needed in this mode. Default stays `local`.
- `items.quantity` (0..1,000,000, default 0) and `accounts.is_active` (Flyway `V2`).
- Tests: a fake identity provider (JWKS endpoint plus token signer inside the test JVM) and the
  rejection matrix (expired, not yet valid, wrong issuer or audience, `alg: none`, HS256 signed with
  the public key, tampering, bad `sub`, unknown then rotated key, outage); concurrent first-request
  provisioning; fail-fast startup.

### Changed

- **Breaking wire format** (so one generated client works against every starter): JSON names are
  snake_case (`access_token`, `token_type`, `expires_in`, `created_at`, `updated_at`,
  `request_id`); `GET /api/v1/items` pages by cursor (`limit` 1..100 default 50, `cursor`,
  response `{items, next_cursor}`, newest first) instead of `page`/`size`/`totalElements`.
- `PUT /api/v1/items/{id}` is a full replace: an omitted `quantity` becomes 0.
- `compose.yaml` no longer requires `APP_JWT_SECRET` at compose time; the app still refuses to
  start without it in local mode.

## [0.1.0] - 2026-10-06

### Added

- Items resource: create, list (paged, searchable), get, update (optimistic locking), delete, all
  scoped to the signed-in owner.
- Registration and login with a local JWT issuer; bcrypt password hashing with rehash on login.
- PostgreSQL schema through Flyway; dev runner with a throwaway database and demo user.
- RFC 9457 problem responses, request ids, JSON logs, health and readiness probes, OpenTelemetry
  hooks (off unless enabled), rate limiting, body size limit, security headers, CORS allow-list.
- OpenAPI 3.1 document at `/v3/api-docs` with a contract test.
- Tests: unit, architecture (ArchUnit and Spring Modulith), integration on PostgreSQL, security.
- Quality gates: Spotless, Error Prone with NullAway, SpotBugs with FindSecBugs, enforcer rules,
  85% line coverage, dependency audit, SBOM.
- Container image (non-root, layered, pinned base digests) and compose stack.

