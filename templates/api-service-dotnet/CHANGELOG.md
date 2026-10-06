# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/). Mark a breaking API change as **Breaking**: it decides the version number.

## [Unreleased]

### Added

- OIDC resource-server mode (`AUTH_MODE=oidc` with `OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE`): RS256 tokens validated against a
  JWKS (cached, refetched on an unknown `kid` at most once per interval, timeout, size cap), issuer, audience, expiry and `sub` (UUID)
  enforced in the service itself, just-in-time user rows (409 `identity_conflict` when the email belongs to another account), the local
  credential endpoints answering 404, and no local signing key needed. Local mode is unchanged and still the default.
- `Oidc__JwksTimeoutSeconds` and `Oidc__JwksRefreshIntervalSeconds`; compose passes the OIDC variables through.

### Changed

- **Breaking:** every JSON property is snake_case (`created_at`, `updated_at`, `next_cursor`, `access_token`, `token_type`,
  `expires_in`, `refresh_token`, `request_id`, `trace_id`; validation error keys too), in requests and responses.
- **Breaking:** the list query parameter `after` is now `cursor` and the response field `nextCursor` is now `next_cursor`; the default
  page size is 50 (was 20).
- `Jwt__SigningKey` is required only in local mode (the compose file no longer insists on it before the app can say so itself).

### Added

- Starter scaffold: JWT authentication with refresh-token rotation, the owner-scoped `items` resource, EF Core
  migrations for PostgreSQL, RFC 9457 errors, an OpenAPI 3.1 contract test, rate limiting, security headers, health
  probes, structured logs, optional OpenTelemetry, and a chiseled non-root container.
