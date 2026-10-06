# Backlog — __APP_TITLE__

Stories are vertical slices: migration -> domain -> adapter -> controller -> OpenAPI -> tests.
Tick a box only when its "Done when" has been observed (a passing test, or a VerifyApp check
against the running service). Append iterations; never rewrite the ones above. One commit per
finished story, Conventional Commits, with the story title and the "Done when" evidence in the body.

## Iteration 0 — from the template

- [x] `items` resource: create, list (paged, searchable), get, update, delete, scoped to the owner.
      Done when: `ItemsApiIT` (13 tests) and `PersistenceIT` pass on PostgreSQL.
- [x] Registration, login and a bearer-token resource server with a local issuer.
      Done when: `AuthApiIT` passes, and `SecurityIT` shows missing, expired, forged, tampered and
      wrong-audience tokens answer 401.
- [x] Another user's item is never reachable.
      Done when: `SecurityIT.anotherUsersItemIs404ForReadUpdateAndDelete` passes.
- [x] Errors are RFC 9457 problems with a code and request id; nothing internal leaks.
      Done when: `assertProblem` holds in every IT and `ProblemDetailsAdviceTest` passes.
- [x] `/healthz`, `/readyz`, `/v3/api-docs` (OpenAPI 3.1) and a contract test.
      Done when: `OpenApiContractIT` passes (every route documented, no extra, real responses match).
- [x] Structure is enforced.
      Done when: `ArchitectureTest` (13 rules) and `ModularityTest` pass.
- [x] Quality gates: format, Error Prone + NullAway, SpotBugs + FindSecBugs, 85% coverage, audit.
      Done when: `./mvnw verify` ends BUILD SUCCESS and `make audit` reports no issues.
- [x] The image builds, runs as non-root on a read-only filesystem and answers the API.
      Done when: `node scripts/smoke.mjs` prints "all checks passed".
- [x] Wire contract v1: snake_case JSON, `limit`/`cursor`/`next_cursor` keyset paging, optional
      `quantity` (the same contract as the other API starters, so one typed client fits them all).
      Done when: `ItemsApiIT` (cursor walk over several pages, snake_case names, quantity bounds)
      and `OpenApiContractIT` pass.
- [x] OIDC resource-server mode behind a gateway (`APP_AUTH_MODE=oidc`).
      Done when: `OidcJwtDecodersTest` (every rejected token) and `OidcModeIT` (first-sight
      provisioning, email collision 409, disabled account 403, concurrent first requests, local
      endpoints 404) pass with no network and no real provider.

## Iteration 1 — make it this service

- [ ] Rename `items` to the real first resource with its real fields (see `docs/EXTENDING.md`).
      Done when: the tests use the domain's words, `make check` passes, the OpenAPI document shows it.
- [ ] Add the second resource by copying the first.
      Done when: its routes are in `/v3/api-docs`, it has ownership tests, `ModularityTest` passes.
- [ ] Decide authentication with the user: keep the local login (`APP_AUTH_MODE=local`), or use
      their identity provider (`APP_AUTH_MODE=oidc`, already built) and, if they never go back,
      delete the local half of `identity/`.
      Done when: an unauthenticated request to a protected route answers 401 in a test, and the
      chosen provider's token reaches `/api/v1/...` in a test (see `OidcModeIT`).
- [ ] Choose real limits: token lifetime, rate limits, body size, CORS origins.
      Done when: `.env.example` documents the chosen values and a test covers each limit.
- [ ] Set the project identity: group id, root package (`com.example.app`), service name, licence
      holder in `LICENSE`, security contact in `SECURITY.md`, owners in `CODEOWNERS`.
      Done when: `grep -r "com.example\|your-org" .` finds nothing unintended and `make check` passes.
