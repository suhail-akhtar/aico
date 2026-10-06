# Extending

## Add a resource (the main move)

Copy `src/features/items/` and follow the contract outward. Say the resource is `orders`.

1. **Contract.** Add the paths and schemas to `openapi/openapi.json` (copy the `/v1/items` blocks).
   Keep every operation's `operationId`: the generated names come from it.
2. **Generate.** `npm run gen`. Read `src/api/generated/sdk.gen.ts` and `zod.gen.ts`: that is your API
   and your form limits. Never edit those files.
3. **Mock.** Teach `mock/api.ts` the new routes (copy the items handling) so `npm run dev`, the unit
   tests and the e2e suite work without a backend. `mock/api.test.ts` validates its output against the
   generated schemas, so it cannot drift from the contract.
4. **Feature.** `src/features/orders/` with the same files as items:
   - `cache.ts`: the list-key helpers (change the `_id` the predicate looks for: it is the
     generated operation id, `listOrders`).
   - `queries.ts`: `useOrders` (infinite query) and the three mutations, optimistic.
   - `form-schema.ts`: map form text to the body with the generated `zOrderInput`.
   - `OrderForm.tsx`, `OrderList.tsx`, `OrdersPage.tsx`.
5. **Route.** `src/routes/_authed/orders.tsx` (copy `items.tsx`). `npm run build` regenerates
   `src/routeTree.gen.ts`; commit it. Add a nav link in `src/app/AppShell.tsx`.
6. **Strings.** Add keys to `src/shared/i18n/en.json`; a test fails on an unused or missing key.
7. **Tests.** Copy `ItemsPage.test.tsx` (loading, empty, error, create, edit, delete, rollback) and add an
   axe case to `src/a11y.test.tsx`. Add the flows to `e2e/`.
8. **Backlog and changelog.** Tick the story in `.aico/backlog.md`, add a line under `## [Unreleased]`.

## Add a page

A file under `src/routes/` is a route: `about.tsx` is `/about`. Put it under `_authed/` if it needs a
session. Set the title with `head`. Use one `<h1>`; headings do not skip levels (axe checks).

## Change the look

Colours are tokens in `src/styles.css` (`--bg`, `--primary`, ...), defined for light and dark. Change
the tokens, not the components. Check contrast of any new pair at 4.5:1 (the e2e suite runs axe in both
schemes). Fonts are the system stack: a web font means `font-src 'self'` and self-hosting the files.

## Add a language

Copy `src/shared/i18n/en.json` to `fr.json`, translate it, register it in `catalogs` in `i18n.ts`.
Dates, numbers and plurals already go through `Intl` for the active locale. When you need ICU messages
or lazy-loaded catalogues, replace `i18n.ts` with Lingui or i18next: call sites only use `t`, `tn`
and the two format helpers.

## Talk to a different backend

1. Replace the paths and schemas in `openapi/openapi.json`, run `npm run gen`.
2. Point `LOGIN_URL`, `LOGOUT_URL`, `API_BASE_URL` at your gateway (`docs/BFF.md`).
3. If your error bodies differ, extend `normalizeFieldErrors` in `src/shared/problem.ts` (it has tests).
4. If your session probe is not `GET /v1/auth/me`, change `src/auth/auth.ts` (one function).

## Error tracking and analytics

Hook them where errors already funnel: `ErrorBoundary.componentDidCatch`, the router's
`errorComponent`, and the `console.error` calls. Add the vendor's host to `connect-src` in
`mock/security-headers.ts` **and** `nginx/security-headers.conf` (a test fails if they differ).
Upload source maps from CI before the Docker build deletes them.

## What not to do

- Do not store a token, a session id or a password in `localStorage`, `sessionStorage` or a cookie from script.
- Do not add `VITE_*` variables for anything that differs per environment: add a key to `/config.json`
  (`runtime-config.ts` and `nginx/entrypoint.sh`).
- Do not add `unsafe-inline` or `unsafe-eval` to the CSP to make a library work; configure the library
  (see `src/shared/zod-config.ts`) or pick another.
- Do not edit `src/api/generated` or `src/routeTree.gen.ts` by hand.
- Do not skip `gen:check` by committing a stale client: the next person's build fails on it.
- Do not use `dangerouslySetInnerHTML`; render user text as text.
