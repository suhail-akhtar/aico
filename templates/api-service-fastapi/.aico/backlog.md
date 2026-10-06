# Backlog — __APP_TITLE__

Stories are vertical slices: model → migration → repository → service → route → schema →
OpenAPI → test. Tick a box only when its "Done when" has been observed (a passing test, or a
VerifyApp check against the running service). Append iterations; never rewrite the ones above.

## Iteration 0 — from the template

- [x] `items` resource: create, list with cursor pagination and search, get, replace, delete.
      Done when: `uv run pytest tests/integration/test_items.py` passes (10 tests).
- [x] Accounts: register, login, rotating refresh tokens with theft detection, logout, `/auth/me`.
      Done when: `tests/integration/test_auth_flow.py` passes (15 tests).
- [x] Ownership is enforced: another user's item is a 404 for every verb, in lists and searches.
      Done when: `tests/security/test_authorization.py` passes.
- [x] Validation answers 422 problem+json naming each field; unknown fields are refused.
      Done when: POST `/v1/items` with `{"name": " "}` returns `errors[0].loc == ["body", "name"]`.
- [x] `/healthz` and `/readyz`; `/openapi.json` is committed and the service conforms to it.
      Done when: `tests/contract` passes (Schemathesis against the running app).
- [x] The image builds and the compose stack answers `/healthz` and `/readyz` with PostgreSQL.
      Done when: `docker compose up --build --wait` is healthy and `curl :8000/readyz` says ok.
- [x] Every check passes: format, lint, mypy --strict, tests with the 85% gate, pip-audit.
      Done when: `make check` exits 0.
- [x] Runs behind an OIDC gateway: `AUTH_MODE=oidc` verifies the provider's RS256 tokens, creates
      the user on first sight, and answers 404 on the local credential endpoints.
      Done when: `tests/unit/test_oidc.py`, `tests/integration/test_oidc_auth.py` and
      `tests/contract/test_wire_contract.py` pass (the last in both modes).

## Iteration 1 — make it this service

- [ ] Rename `items` to the real first resource with its real fields and constraints.
      Done when: the tests use the domain's words, the migration is reviewed, and `make check` passes.
- [ ] Add the second resource by copying `src/app/features/items/` (`docs/EXTENDING.md`).
      Done when: its routes are in `openapi.json` and have integration and cross-user tests.
- [ ] Decide authentication with the user: keep local accounts, or an identity provider (OIDC).
      Done when: an unauthenticated request to a protected route answers 401 in a test, and the
      choice is recorded in `.aico/decisions.md`.
- [ ] Set the first real limits: `ALLOWED_ORIGINS`, rate limits, `REGISTRATION_ENABLED`.
      Done when: `.env.example` and `deploy/README.md` say what production uses.
