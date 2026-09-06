# Backlog — __APP_TITLE__

Stories are vertical slices: migration → repository → route → OpenAPI → test.
Tick a box only when its "Done when" has been observed (a passing test, or a
VerifyApp check against the running service). Append iterations; never rewrite
the ones above.

## Iteration 0 — from the template

- [x] `items` resource: list, create, get, update, delete.
      Done when: `npm test` passes the five items tests.
- [x] Validation answers 400 with a message per field.
      Done when: POST `{ "name": " " }` returns `fields.name`.
- [x] `/healthz` and `/readyz`; `/openapi.json` lists every route.
      Done when: the "documents every route" test passes.
- [x] Image builds and answers `/healthz` on 3000.
      Done when: `node deploy/docker.mjs` then `curl :3000/healthz` says ok.

## Iteration 1 — make it this service

- [ ] Rename `items` to the real first resource with its real fields.
      Done when: the test file uses the domain's words and passes.
- [ ] Add the second resource by copying `src/items.ts`.
      Done when: its routes appear in `/openapi.json` and have tests.
- [ ] Decide auth with the user (API key header, or none for an internal service).
      Done when: an unauthenticated request to a protected route answers 401 in a test.
