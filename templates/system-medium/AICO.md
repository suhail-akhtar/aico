# __APP_TITLE__

A bundle: React SPA (`services/web`) + Spring Boot 4 / Spring Modulith API (`services/api`), run together
by `compose.yaml` behind Traefik (`/` web, `/api` `/oauth2` `/login` API) with Keycloak, PostgreSQL 18,
Valkey, SeaweedFS (S3), flagd, Mailpit. Start: `docker compose up --build --wait` (needs `.env`:
`make setup`). App http://localhost:8080, mail :8025. Dev users alice (admin) and bob (member),
password `DEV_USER_PASSWORD` in `.env`.

## Rules

- API modules (`com.example.system.<module>`): `tasks` (worked feature), `identity`, `audit`,
  `notifications`, `shared`. Layers api -> app -> domain <- infra; modules talk through events or a
  published API only. `ModularityTest` + `ArchitectureTest` fail the build otherwise.
- Browser auth is a cookie session created by the API (BFF); the SPA never holds a token. Writes need
  the `X-XSRF-TOKEN` header. Owner comes from the session, never the body; foreign ids answer 404.
- Side effects go through domain events and the outbox (`@ApplicationModuleListener`), consumers are
  idempotent (`Inbox`). Schema changes: new `db/migration/V<n>__*.sql`, never edit one.
- Config is env-only (`.env`, validated at startup). No secrets in git.

## Checks

`make check`, or: `cd services/api && ./mvnw verify` (tests on real PostgreSQL via Docker, 85%
coverage, SpotBugs); `cd services/web && npm run check`; then `docker compose up --build --wait`
and `node scripts/smoke.mjs`. Read docs/EXTENDING.md before adding a module.
