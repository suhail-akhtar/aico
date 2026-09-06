# Backlog — __APP_TITLE__

Stories are vertical slices: migration → lib → page/actions → test → checked in
the browser. Tick a box only when its "Done when" has been observed. Append
iterations; never rewrite the ones above.

## Iteration 0 — from the template

- [x] Sign up, sign in, sign out with a signed HTTP-only cookie.
      Done when: `npm test` passes auth and session tests; VerifyApp registers and lands on /items.
- [x] Items: add, tick, delete, scoped to the signed-in user.
      Done when: items tests pass; a second account sees none of the first's items.
- [x] Field-level errors on every form.
      Done when: an empty item name shows "Give it a name." beside the field.
- [x] `/api/healthz`; image builds and answers it.
      Done when: `node deploy/docker.mjs` then `curl :3000/api/healthz` says ok.

## Iteration 1 — make it this product

- [ ] Rename `items` to the product's first real object, with its real fields.
      Done when: lib, page, actions and tests use the domain's words and pass.
- [ ] Decide the sign-up policy with the user (open / invite / first user only).
      Done when: the policy is enforced in `register` and covered by a test.
- [ ] Replace the placeholder home page copy.
      Done when: no "placeholder" text remains (Grep).
- [ ] Add the second feature by copying the items slice.
      Done when: it has a page, actions, a lib file and tests.
