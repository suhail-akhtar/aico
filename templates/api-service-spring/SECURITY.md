# Security policy

## Reporting a vulnerability

Do not open a public issue. Report it privately to the maintainers (replace this paragraph with
your security contact, or enable GitHub private vulnerability reporting for the repository). Include
what you found, how to reproduce it, and the version. Expect an acknowledgement within a few days.

## What this service does for you

| Area | Behaviour | Where |
|---|---|---|
| Authentication | Bearer JWT (HS256), 15 minute lifetime, issuer and audience checked | `shared/security/SecurityConfig.java` |
| Passwords | bcrypt, cost 12 (OWASP floor is 10), 12 character minimum, rehash on login | `identity/infra/BcryptPasswordHasher.java` |
| Account enumeration | Same error and same timing for unknown email and wrong password | `identity/app/AuthService.java` |
| Authorisation | Every item query is scoped to the token's user; foreign ids answer 404 | `items/domain/ItemRepository.java` |
| Abuse limits | Per-address rate limit (stricter on login and register), 256 KB body limit | `shared/web/` |
| Headers | CSP `default-src 'none'`, `nosniff`, frame deny, no-referrer, HSTS, no `Server` header | `SecurityConfig.java` |
| CORS | Explicit allow-list from `APP_CORS_ALLOWED_ORIGINS`; none by default | `SecurityConfig.java` |
| Errors | RFC 9457 problem bodies; stack traces, SQL and class names never leave the process | `shared/web/ProblemDetailsAdvice.java` |
| Secrets | Environment only; the app refuses to start with a short or placeholder key | `shared/config/AppProperties.java` |
| Supply chain | Pinned versions and base image digests, SBOM, `make audit`, Dependabot, secret scan | `pom.xml`, `Dockerfile`, CI |

## What you must still do

- Run behind TLS (HSTS is sent but only means something over HTTPS).
- Set a strong `APP_JWT_SECRET` and rotate it on a schedule; keep it in a secret store.
- Decide on proxy trust before deploying behind one: the rate limiter keys on the socket address.
  Configure `server.forward-headers-strategy` only if you control the proxy.
- Replace the local login with your identity provider as soon as there is more than one service
  (see `docs/EXTENDING.md`, "Use an external identity provider").
- The rate limiter and token lifetime are per instance; scale-out needs a shared limiter.

## Known limits

- No refresh tokens, no password reset, no email verification, no MFA (growth steps, documented).
- CSRF protection is off because the API uses bearer tokens and no cookies. Turn it on if you
  ever authenticate with cookies.
