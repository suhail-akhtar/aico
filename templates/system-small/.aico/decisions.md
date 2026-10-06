# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Versions are those resolved and
running on 2026-10-06 when the bundle was verified (images are pinned by digest in `compose.yaml`).

## Shape

- Two complete starters side by side (`services/web` = web-app-react 1.x, `services/api` = api-service-fastapi 1.x),
  composed rather than merged: each keeps its own tests, lockfile and image, so either can be replaced or split out.
- One origin through Traefik 3.7.13 (file provider, no Docker socket): no CORS, cookie never cross-site, one place for the CSRF rule.
- Backend-for-frontend sign-in (RFC 10017): oauth2-proxy 7.15.5 with sessions in Valkey 9.0.6 (the cookie holds a handle, not tokens).
  Chosen over a token in the SPA (XSS-readable) and over rolling our own session service (security code to maintain).
- Keycloak 26.8.0 as the identity provider, in `start-dev` for local runs, with a realm imported from `deploy/keycloak/realm.json`
  (client `web`, PKCE S256, an audience mapper for `app-api`, one dev user). It shares the PostgreSQL server but has its own
  database and role. Rejected for the small tier: no identity provider at all, because the web starter only supports gateway sign-in.
- The API runs `AUTH_MODE=oidc` and validates tokens itself (RS256 pinned, iss, aud, exp); users are created on first sight of a `sub`.

## Versions running

- PostgreSQL 18.6 (alpine), Python 3.14.8, FastAPI 0.142.2, SQLAlchemy 2.1.3, Pydantic 2.13.5, React 19.3.0, Vite 8.3.2,
  TypeScript 6.0.3, Node 24.21 (build image), Playwright 1.63.0 (e2e image). No Redis 8, no MinIO (licence).

## Findings while verifying (kept so they are not rediscovered)

- oauth2-proxy's `set_authorization_header` forwards the **ID token** as the bearer, not the access token. The audience mapper
  therefore applies to the ID token too (`id.token.claim: true`), otherwise the API rejects every request with an invalid audience.
- Keycloak imports a realm only when the database is empty: changing `PUBLIC_URL` or the port needs `docker compose down -v` first
  (symptom: `invalid_redirect_uri` in Keycloak's log).
- The API's rate limits count one client (the proxy) behind the gateway, so they are set high here; real limits belong at the gateway.
- Only the gateway publishes a port. The database, Keycloak and the API are reachable on the compose network only.
