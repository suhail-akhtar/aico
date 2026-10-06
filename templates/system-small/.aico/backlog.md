# Backlog — __APP_TITLE__

Tick a box only when its "Done when" was observed (a passing test, or `VerifyApp` against the running stack).
Append iterations; never rewrite the ones above.

## Iteration 0 — from the template

- [x] The whole stack starts from one command.
      Done when: `docker compose up --build --wait` ends with every service healthy and the migration job exited 0.
- [x] Sign in and out through Keycloak with a cookie session; the browser holds no token.
      Done when: `services/web/e2e/auth.spec.ts` passes through the gateway.
- [x] Items: create, list with paging, edit, delete, owner-scoped, stored in PostgreSQL.
      Done when: `services/web/e2e/items.spec.ts` and `contract.spec.ts` pass against the real API.
- [x] CSRF and security headers enforced at the gateway.
      Done when: the request-forgery spec in `auth.spec.ts` and the security-posture spec in `quality.spec.ts` pass.
- [x] Hardened containers, secrets only from `.env`.
      Done when: `docker compose config` shows no secret value in the file and the containers run non-root, read-only.

## Iteration 1 — make it this product

- [ ] Replace `items` with the real resource (see `docs/EXTENDING.md`).
- [ ] TLS entrypoint, `COOKIE_SECURE=true`, Keycloak in `start` mode, real realm (see `SECURITY.md`).
- [ ] Per-client rate limits at the gateway; backups of the `db` volume.
