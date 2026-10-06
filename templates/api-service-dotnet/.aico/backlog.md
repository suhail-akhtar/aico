# Backlog — __APP_TITLE__

Stories are vertical slices: migration, entity, service, endpoint, DTO validation, test, contract snapshot. Tick a
box only when its "Done when" has been observed (a passing test, or a VerifyApp check against the running service).
One Conventional Commit per finished story, with the story title and its "Done when" evidence in the body. Append
iterations; never rewrite the ones above.

## Iteration 0 — from the template

- [x] `items` resource: create, list (keyset pages), get, update, delete, owner-scoped.
      Done when: `dotnet test --solution ApiService.slnx` passes `ItemsTests`, including another user's item answering 404.
- [x] Accounts: register, login, refresh-token rotation with reuse detection, logout, `/auth/me`; Argon2id hashes.
      Done when: `AuthTests` and `PasswordHasherTests` pass (the hashing parameters are pinned by a test).
- [x] Errors are RFC 9457 problem documents with a stable `code` and the request id; nothing internal leaks.
      Done when: `SecurityTests.An_unexpected_exception_is_a_500_problem_that_leaks_nothing` passes.
- [x] `/healthz`, `/readyz`, and an OpenAPI 3.1 document that is a committed, tested contract.
      Done when: `ContractTests` pass (the document matches `Snapshots/openapi.v1.json` and lists every route).
- [x] Rate limits, security headers, CORS allow-list, body-size limit, configuration validated at startup.
      Done when: `SecurityTests` and `ConfigurationTests` pass.
- [x] Image builds, migrates a real PostgreSQL, and serves.
      Done when: `make up` then `curl localhost:8080/readyz` answers `{"status":"ok"}`, and `scripts/smoke.sh` passes.
- [x] Wire contract v1 for a shared front end: snake_case JSON, `limit` + `cursor` paging with `next_cursor`, optional `quantity`.
      Done when: `WireContractTests` pass and `Snapshots/openapi.v1.json` shows the snake_case names and the `cursor` parameter.
- [x] OIDC resource-server mode (`AUTH_MODE=oidc`): RS256 from a JWKS URL, issuer and audience pinned, just-in-time user rows.
      Done when: `OidcTests` and `OidcConfigurationTests` pass (forged, expired, confused-algorithm and wrong-audience tokens are 401; an email collision is 409).
- [x] `make check` is green: format, analyzers as errors, tests with the 85 % coverage gate, vulnerability audit.
      Done when: `make check` exits 0.

## Iteration 1 — make it this service

- [ ] Rename `items` to the real first resource with its real fields, and update `ArchitectureTests.Only_request_dtos_are_public`.
      Done when: the tests use the domain's words, pass, and `Snapshots/openapi.v1.json` shows the new routes.
- [ ] Add the second resource by copying `Features/Items` (`docs/EXTENDING.md`, "Add a feature").
      Done when: its ownership test, its migration and its contract snapshot are committed and `make check` passes.
- [ ] Decide authentication with the user: keep this JWT login (`AUTH_MODE=local`), or use their identity provider (`AUTH_MODE=oidc`, already built).
      Done when: the choice is in `.aico/decisions.md` and an unauthenticated request to a protected route answers 401 in a test.
- [ ] Set the production configuration: `ConnectionStrings__Default`, `Jwt__SigningKey`, `Cors__AllowedOrigins`,
      `ForwardedHeaders__*` behind the proxy.
      Done when: the service starts in the target environment, `/readyz` answers ok and `--migrate` ran as a job.
- [ ] Replace the placeholders: licence holder in `LICENSE`, `CODEOWNERS`, security contact in `SECURITY.md`, API title in `OpenApiSetup.cs`.
      Done when: `grep -ri "placeholder\|your-" .` finds none and the contract snapshot is re-accepted.
