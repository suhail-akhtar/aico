# Backlog — __APP_TITLE__

Stories are vertical slices: migration, model/policy, action, request/resource, page or
endpoint, test, checked in the browser. Tick a box only when its "Done when" has been
observed. Append iterations; never rewrite the ones above.

## Iteration 0 — from the template

- [x] Sign up, sign in, sign out, reset a password; Argon2id; throttled; sessions in the database.
      Done when: `make test` passes AuthenticationTest; VerifyApp registers and lands on /items.
- [x] Items: add, edit, mark done, delete, search, filter, paginate, scoped to the signed-in user.
      Done when: ItemsPageTest and ItemsApiTest pass; a second account sees none of the first's items and gets 404 for their ids.
- [x] JSON API with bearer tokens, cursor pagination, RFC 9457 errors, OpenAPI document.
      Done when: OpenApiContractTest passes and `docs/openapi.json` matches `composer openapi`.
- [x] Production image: read-only, non-root, `/healthz` and `/readyz`, fails fast on bad config.
      Done when: `make smoke` prints SMOKE PASSED.

## Iteration 1 — make it this product

- [ ] Rename `Items` to the product's first real object, with its real fields.
      Done when: model, migration, actions, policy, API, page and tests use the domain's words and pass `make check`.
- [ ] Decide the sign-up policy with the user (open / invite only / first user only).
      Done when: the policy is enforced in `CreateNewUser` and covered by a test.
- [ ] Replace the placeholder home page copy and app name.
      Done when: no "Placeholder" text remains (Grep).
- [ ] Turn on email verification (Fortify) with real SMTP settings.
      Done when: an unverified user cannot reach /items and the flow has a test.
- [ ] Add the second feature by copying the Items slice.
      Done when: it has a page, an API, a policy and tests, and `ArchitectureTest` covers it.
