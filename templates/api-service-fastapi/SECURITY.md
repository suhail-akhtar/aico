# Security policy

## Reporting a vulnerability

Do not open a public issue. Report it privately to the maintainers (use the
repository's "Report a vulnerability" security advisory form, or the contact in
`CODEOWNERS`). Include what you found, how to reproduce it, and the version.
You will get an acknowledgement within three working days.

## Supported versions

The latest released minor version receives security fixes.

## What this service already does

| Concern | Control | Where |
|---|---|---|
| Passwords | Argon2id, m=64 MiB, t=3, p=2 (OWASP minimum is 19 MiB, 2, 1), rehash on login, parameters pinned by a test | `core/security.py`, `core/config.py` |
| Sessions | 15-minute HS256 JWT (`typ: at+jwt`, `iss`/`aud`/`exp` required, algorithm pinned) + single-use refresh tokens with theft detection | `core/security.py`, `features/auth` |
| Provider tokens (`AUTH_MODE=oidc`) | RS256 only (`none` and HS256 refused before any key lookup), JWKS cached and refetched at most every 30 s with a timeout, `iss` exact, `aud` required, `exp`/`nbf` with at most 60 s skew, `sub` a UUID, all checked in this process even behind a gateway | `core/oidc.py` |
| Authorisation | every query is scoped by owner; someone else's row is a 404 | `features/items/repository.py` |
| Injection | parameterised SQL only; `LIKE` wildcards escaped; strict request schemas (`extra="forbid"`) | `features/items` |
| Edge | security headers, CORS allow-list (no wildcard), body-size limit, per-address rate limits, RFC 9457 errors with no internals | `core/middleware.py`, `core/problems.py` |
| Secrets | environment only, validated at startup, never logged (key-name redaction, no tracebacks with locals) | `core/config.py`, `core/logging.py` |
| Supply chain | locked and hash-verified dependencies, `pip-audit` with an expiring allow-list, Dependabot, image pinned by digest, SBOM, secret scan | `uv.lock`, `scripts/audit.py`, CI |
| Runtime | non-root, read-only root filesystem, no capabilities | `Dockerfile`, `compose.yaml` |

## What it does not do (decide before going live)

- **TLS** is terminated by whatever is in front of the container (a load balancer or
  reverse proxy). Set `FORWARDED_ALLOW_IPS` to that proxy's address, or client
  addresses (and therefore rate limits) will be wrong.
- **Rate limits are per process.** With several replicas the effective limit is N
  times the configured one. Put a hard limit at the gateway.
- **Email verification, password reset, MFA and account lockout** are not included.
  If you need local passwords at scale, prefer an identity provider (OIDC); see
  `docs/EXTENDING.md`.
- **Registration answers 409 for an existing address**, which reveals that it exists.
  Turn registration off (`REGISTRATION_ENABLED=false`) or add email verification if
  that matters to you.
- **Provider accounts** (`AUTH_MODE=oidc`) are created on first sight and never merged: if the
  token's email belongs to another account the answer is 409. The email is captured once, not
  re-synced, and a provider that lets users claim unverified addresses should verify them.
  A key revoked at the provider keeps verifying here for up to `OIDC_JWKS_CACHE_SECONDS` (10 minutes).
- **`JWT_SECRET` rotation** invalidates all access tokens at once (they last 15
  minutes). Refresh tokens are unaffected.
