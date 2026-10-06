# Security policy

## Reporting a vulnerability

Do not open a public issue. Report privately to the maintainers (the repository's "Report a vulnerability"
security advisory form, or the contact in `CODEOWNERS`) with what you found, how to reproduce it and the
version. You get an acknowledgement within three working days. Only the latest minor version gets fixes.

## What the system does

| Concern | Control | Where |
|---|---|---|
| Tokens in the browser | none: oauth2-proxy keeps the session in Valkey behind an `HttpOnly`, `SameSite=Lax` cookie (BFF, RFC 10017) | `compose.yaml` (bff) |
| API trust | the API validates every token itself (RS256 pinned, issuer, audience, expiry); it is not exposed except through the gateway | `services/api` (`AUTH_MODE=oidc`) |
| CSRF | unsafe `/api` requests without `X-Requested-With: fetch` are answered 403 by the gateway before reaching the API | `deploy/traefik/dynamic.yml` |
| Gateway | static file configuration; the Docker socket is never mounted into Traefik | `deploy/traefik/` |
| Containers | non-root, read-only root filesystems, `cap_drop: ALL`, `no-new-privileges`, images pinned by digest | `compose.yaml` |
| Secrets | only in `.env` (gitignored, random per app); `compose.yaml` fails to start when one is missing | `.env.example` |
| Ports | only the gateway publishes a port, on 127.0.0.1 | `compose.yaml` |

## Before going live (not done for you)

- Terminate TLS in front of Traefik (or add an entrypoint with a certificate) and set `COOKIE_SECURE=true`.
- Keycloak runs in `start-dev` here (development database settings, no HTTPS). Use `start` with a hostname,
  TLS and a real realm; remove the dev user from `deploy/keycloak/realm.json`.
- Per-client rate limits belong at the gateway; the API's own limits see one address (the proxy).
- Back up the `db` volume; plan upgrades of Keycloak and PostgreSQL majors.
