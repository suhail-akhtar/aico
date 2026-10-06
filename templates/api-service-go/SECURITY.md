# Security policy

## Reporting a vulnerability

Do not open a public issue. Report it privately to the maintainers (use the repository's "Report a
vulnerability" security advisory form, or the contact in `CODEOWNERS`). Include what you found, how to
reproduce it, and the version. You will get an acknowledgement within three working days.

## Supported versions

The latest released minor version receives security fixes.

## What this service already does

| Concern | Control | Where |
|---|---|---|
| Passwords | Argon2id, m=64 MiB, t=3, p=1 (OWASP minimum is 19 MiB, 2, 1), rehash on login, concurrency cap, parameters pinned by a test, a hash with hostile parameters is refused | `internal/features/auth/hasher.go`, `internal/platform/config` |
| Sessions | random 256-bit opaque bearer tokens, stored only as SHA-256, expiring, revocable (logout deletes the row) | `internal/features/auth` |
| Identity provider (`AUTH_MODE=oidc`) | access tokens verified in-process on every request: RS256 pinned (no `none`, no `HS*`), JWKS cached with a rate-limited, time-bounded refetch on an unknown `kid`, exact `iss`, `aud`, required `exp`, `nbf`, skew <= 60 s, UUID `sub`, RSA keys >= 2048 bits, encryption keys ignored; unusable password hash for provisioned accounts; an email collision is a 409, never a merge | `internal/features/auth/jwks.go`, `provision.go` |
| Login | identical response and equal work for a wrong password and an unknown email; rate limited per address | `auth.go`, `internal/app` |
| Authorisation | every query is scoped by owner; someone else's row is a 404, identical to a missing one; routes are protected unless listed public, and a test ties that list to the OpenAPI document | `db/queries`, `internal/app/app.go` |
| Injection | sqlc parameterised queries only; ids are validated as UUIDs; strict request types (no client-settable server fields) | `db/queries`, `internal/api` |
| Input | body-size cap (declared and streamed), JSON-only writes (415), field limits mirrored in the database `CHECK`s and checked against the spec in a test | `internal/platform/httpx`, `db/migrations` |
| Edge | security headers (nosniff, CSP `default-src 'none'`, frame deny, referrer, COOP/CORP, `no-store`, HSTS in production), CORS allow-list with no wildcard, per-address rate limits, RFC 9457 errors with no internals | `internal/platform/httpx` |
| Slow clients | read-header, read, write and idle timeouts, a header size cap, per-request deadline | `internal/app/serve.go` |
| Secrets | environment only, validated at startup, never echoed (`DATABASE_URL` is masked in logs and errors), logger redacts credential-named attributes, tests assert no password or token reaches the logs | `internal/platform/config`, `internal/platform/logging` |
| Supply chain | `go.sum` verified (`go mod verify`), govulncheck with an expiring allow-list, osv-scanner, gitleaks, CodeQL, Dependabot, images pinned by digest, actions pinned by SHA, CycloneDX SBOM | `Makefile`, `.github/workflows/ci.yml` |
| Runtime | static CGO-off binary, distroless non-root image, read-only root filesystem, no capabilities, `no-new-privileges` | `Dockerfile`, `compose.yaml` |

## What it does not do (decide before going live)

- **TLS** is terminated by whatever is in front of the container. Use `sslmode=verify-full` to the database.
- **Rate limits are per process and use the peer address.** With several replicas the effective limit is N times the
  configured one, and behind a proxy every client shares the proxy's address. `X-Forwarded-For` is deliberately not
  trusted (any client can forge it). Put the real limit at the gateway.
- **Email verification, password reset, MFA and account lockout** are not included. If you need local passwords at
  scale, prefer an identity provider (OIDC); see `docs/EXTENDING.md`.
- **Registration answers 409 for an existing address**, which reveals that it exists. Add email verification or
  disable registration if that matters to you.
- **Bearer tokens in browsers.** If a browser app calls this API directly, do not keep the token in `localStorage`
  (RFC 10017 recommends a backend-for-frontend); this API is meant for server-to-server and native clients as shipped.
- **No audit log** of who changed what; add one when a compliance regime asks.
