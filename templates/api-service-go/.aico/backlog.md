# Backlog — __APP_TITLE__

Stories are vertical slices: contract (`api/openapi.yaml`) → migration → queries → domain → adapters →
handler → tests. Tick a box only when its "Done when" has been observed (a passing test, or a VerifyApp
check against the running service). Append iterations; never rewrite the ones above.

## Iteration 0 — from the template

- [x] `items` resource: create, list with keyset pagination, get, replace, delete, owner-scoped.
      Done when: `make cov` passes `internal/features/items` (service, handler guards, and the repository
      contract against both the memory fake and PostgreSQL).
- [x] Accounts: register, login, logout, `/v1/auth/me`; Argon2id; opaque bearer sessions stored hashed.
      Done when: `internal/features/auth` tests pass, including the pinned Argon2id parameters.
- [x] Ownership is enforced: another user's item is a 404 for every verb, in lists, and by id.
      Done when: `TestOtherUsersItemsAreInvisible` and `TestMissingItemAndForeignItemAreIndistinguishable` pass.
- [x] Validation answers 422 problem+json naming each field; bad JSON is 400; wrong media type 415; oversize 413.
      Done when: POST `/v1/items` with `{"name":" "}` returns `errors[0].field == "name"`.
- [x] `/healthz`, `/readyz` and the served `/openapi.yaml`; every response matches the document.
      Done when: `TestResponsesMatchTheDocument` and `TestPublicRoutesMatchTheDocument` pass.
- [x] The image builds (distroless, non-root, version stamped) and the compose stack answers over HTTP.
      Done when: `sh scripts/smoke.sh` prints `smoke: ok` and a SIGTERM stops the server cleanly (exit 0).
- [x] Every check passes: format, lint, vet, tidy, generated code current, tests (-race, PostgreSQL, 85% gate), audit.
      Done when: `make check` exits 0 (`docker compose --profile tools run --rm tools make check` if no local Go).

## Iteration 1 — make it this service

- [ ] Rename `items` to the real first resource with its real fields and constraints.
      Done when: the tests use the domain's words, the migration is reviewed, and `make check` passes.
- [ ] Add the second resource by copying `internal/features/items/` (`docs/EXTENDING.md`).
      Done when: its routes are in `api/openapi.yaml`, with service, contract and cross-user tests.
- [ ] Decide authentication with the user: keep local accounts, or an identity provider (OIDC).
      Done when: the choice is in `.aico/decisions.md` and an unauthenticated request to every protected route is a 401 in a test.
      Note: both are built (`AUTH_MODE=local` default, `AUTH_MODE=oidc`; README "Run behind an OIDC gateway").
- [ ] Configure production: `DATABASE_URL` with `sslmode=verify-full`, `CORS_ALLOWED_ORIGINS`, `APP_ENV=production`.
      Done when: `deploy/README.md`'s checklist is ticked against a real environment.
