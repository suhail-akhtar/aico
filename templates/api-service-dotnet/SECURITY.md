# Security policy

## Reporting a vulnerability

Do not open a public issue. Report it privately through GitHub's "Report a vulnerability" (Security Advisories) on this
repository, or by email to the address you set here: `security@example.com` (replace it). Include what you found, how
to reproduce it, and the version. You will get an acknowledgement within three working days.

## Supported versions

The latest release receives security fixes. Pin and update dependencies through the Dependabot pull requests.

## What this service does for you

Passwords are hashed with Argon2id; refresh tokens are single-use, rotated, hashed at rest, and a replay revokes the
whole token family; access tokens are short-lived and strictly validated (in OIDC mode: RS256 only, issuer and audience pinned, keys from the
configured JWKS URL, never trusting a proxy's say-so); every query is scoped to the caller; errors
never leak internals; requests are size-limited and rate-limited; responses carry strict security headers; the
container is distroless and non-root; dependencies are locked, audited on every restore and in CI, and listed in an SBOM.
Secrets are read from the environment only, and the service refuses to start with a placeholder or missing secret.

## What it does not do (decide before going live)

No email verification, password reset, MFA or account lockout; the rate limiter is per instance; TLS is terminated by your
proxy (enable `ForwardedHeaders` and HSTS there). See `.aico/decisions.md`, "Honest limits".
