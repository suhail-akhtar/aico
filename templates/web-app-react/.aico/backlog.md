# Backlog — __APP_TITLE__

Stories are vertical slices: contract → mock → feature → route → strings → tests. Tick a box only
when its "Done when" has been observed (a passing test, or a VerifyApp check against the running
app). Append iterations; never rewrite the ones above.

## Iteration 0 — from the template

- [x] Sign in and out through a gateway with a cookie session; the browser holds no token.
      Done when: `e2e/auth.spec.ts` passes (sign-in, protected-page redirect, sign-out, expiry, foreign return address).
- [x] `items` worked feature: list with cursor paging, create, edit, delete, optimistic with rollback,
      loading, empty and error states.
      Done when: `src/features/items/ItemsPage.test.tsx` passes (17 tests) and `e2e/items.spec.ts` passes.
- [x] A typed client generated from `openapi/openapi.json`, kept current by CI.
      Done when: `npm run gen:check` exits 0 and `e2e/contract.spec.ts` passes against the running API.
- [x] CSRF defence: forged state-changing requests are refused.
      Done when: the "request forgery" spec in `e2e/auth.spec.ts` passes.
- [x] Accessible by default: labelled controls, keyboard operation, focus management, axe clean.
      Done when: `src/a11y.test.tsx` and `e2e/quality.spec.ts` pass in light and dark at 1280 and 390.
- [x] Strict CSP and no console errors on the main flow.
      Done when: the "security posture" spec in `e2e/quality.spec.ts` passes.
- [x] Responsive (1280 and 390), dark mode, i18n-ready, error boundary, runtime configuration.
      Done when: `e2e/quality.spec.ts` passes; `src/shared/i18n/i18n.test.ts` finds no unused or missing key.
- [x] The image builds and runs non-root on a read-only filesystem.
      Done when: `docker build .` succeeds and the container answers `/healthz`, `/config.json` and a foreign `API_BASE_URL` stops it.
- [x] Every check passes.
      Done when: `make check` exits 0 (format, lint, types, generated code, 85% coverage, audit, build).

## Iteration 1 — make it this product

- [ ] Rename `items` to the real first resource with its real fields.
      Done when: the contract, the generated client, the mock, the tests and the strings all use the domain's words and `make check` passes.
- [ ] Agree the gateway with the backend team (`docs/BFF.md`): sign-in URL, sign-out, session probe.
      Done when: `E2E_BASE_URL=<staging> npm run e2e` passes against it and the choice is in `.aico/decisions.md`.
- [ ] Replace the placeholder name, favicon and landing copy.
      Done when: no `__APP_TITLE__` or "Keep track of your items" remains in `index.html`, `en.json` or `public/`.
- [ ] Pick the languages to ship.
      Done when: each has a catalogue registered in `i18n.ts` and the missing-key test covers it.
- [ ] Add error tracking at the existing hooks and its host to both CSP tables.
      Done when: a thrown render error reaches the tracker from a staging build and the header-parity test passes.
