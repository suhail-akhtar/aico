# __APP_TITLE__

A full-stack system in one compose project: `services/web` (React 19 SPA) and `services/api` (FastAPI)
behind a Traefik gateway on ONE origin, PostgreSQL 18, and a backend-for-frontend sign-in
(oauth2-proxy, sessions in Valkey, Keycloak as the identity provider). The browser never holds a token.

## Run

`docker compose up --build --wait`, then open http://localhost:8080 (`AICO_PREVIEW_PORT` changes it).
Sign in as `dev@example.com`; the password is `DEV_USER_PASSWORD` in `.env`. Each service also runs
alone (`services/web`: `npm run dev` with its mock gateway; `services/api`: `uv run ...`).

## Layout

- `compose.yaml` the stack; `deploy/traefik/dynamic.yml` routes (/api -> api, /idp -> keycloak, / -> web);
  `deploy/keycloak/realm.json` realm, client, dev user; `deploy/postgres/` creates the keycloak database.
- `services/web`, `services/api` are complete starters: read their own `AICO.md` before editing them.
- The contract is `services/web/openapi/openapi.json` == `services/api/openapi.json`. Change both, then
  `npm run gen` in web. Gateway rules: `services/web/docs/BFF.md`.

## Rules

- No secret in a file: values come from `.env` (gitignored). API in `AUTH_MODE=oidc`: it trusts only tokens
  Traefik forwards after oauth2-proxy approved the session.
- Every unsafe `/api` call needs `X-Requested-With: fetch` (the gateway refuses otherwise).

## Checks

`RunChecks` in each service. System level: `docker compose --profile e2e run --rm e2e` (Playwright through
Traefik, real Keycloak, API and database). Then `VerifyApp` on the preview origin.
