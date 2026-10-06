# Security policy

## Reporting a vulnerability

Do not open a public issue. Report privately to the maintainers (replace this paragraph with your
security contact, or enable GitHub private vulnerability reporting). Include what you found, how to
reproduce it and the version. Expect an acknowledgement within a few days.

## What this system does for you

| Area | Behaviour | Where |
|---|---|---|
| Sign-in | OIDC authorization code with PKCE; the API is the confidential client; tokens never reach the browser | `identity/security/SecurityConfig.java` |
| Session | HttpOnly, SameSite=Lax cookie; server-side in Valkey; 8 h; `Secure` with `APP_SECURE_COOKIES=true` | `application.properties` |
| CSRF | On for cookie sessions (`X-XSRF-TOKEN`); bearer-token calls are exempt | `SecurityConfig.java` |
| Machine tokens | Issuer and audience checked on every bearer token | `AudienceValidator.java` |
| Authorisation | Roles from the realm; queries scoped to the caller; foreign ids answer 404 | `tasks/`, `identity/` |
| Abuse limits | Per-address limit at the gateway and per-caller in Valkey; 256 KB body, 5 MB upload | `infra/traefik/dynamic.yml`, `shared/web/` |
| Errors | RFC 9457 problem bodies; no stack traces, SQL or class names | `ProblemDetailsAdvice.java` |
| Audit | Audit rows written with the change, readable by admins | `audit/` |
| Containers | No capabilities, no privilege escalation, read-only root filesystems where the image allows, named volumes, no Docker socket, ports on 127.0.0.1 | `compose.yaml` |
| Secrets | `.env` (git-ignored) only; compose refuses to start without them; separate PostgreSQL roles per database | `.env.example`, `infra/postgres/init` |
| Supply chain | Image digests and Actions SHAs pinned, SBOM, OSV audit, secret scan, Dependabot | `compose.yaml`, `.github/` |

## What you must still do before production

- Serve over TLS and set `APP_SECURE_COOKIES=true`; set a real public hostname in Keycloak and Traefik.
- Run Keycloak with `start`, not `start-dev`; delete the dev users and rotate every client secret.
- Move secrets from `.env` to a secret manager; use managed PostgreSQL and S3, or back up the volumes.
- Keep the gateway's `forwardedHeaders.insecure=false` unless a trusted proxy sits in front.
- Turn off the API explorer (`APP_DOCS_ENABLED=false`).

## Known limits

- Mail goes to Mailpit, which keeps everything and sends nothing. Configure real SMTP (`SMTP_*`).
- Uploaded files are size-limited and stored, not virus-scanned.
