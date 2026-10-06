# __APP_TITLE__

React 19 SPA: Vite 8, TypeScript 6, TanStack Router + Query, Tailwind 4, Biome. aico runs it with
`npm run dev` and waits for "Local:"; the dev server includes a mock gateway (sign in as
dev@example.com), so the first run works with no backend.

## Layout

- `openapi/openapi.json` is the API contract. `npm run gen` makes `src/api/generated` (typed client,
  react-query options, zod schemas). Never edit generated files.
- `src/routes/` file routes (`_authed/` needs a session). `src/features/items/` is the worked feature:
  copy it. `src/shared/ui` primitives, `src/shared/i18n/en.json` every user-visible string.
- `mock/api.ts` executable contract (dev, unit tests, e2e). `nginx/` production server.

## Conventions

- No tokens in the browser: a gateway holds the session cookie. Unsafe requests carry `X-Requested-With: fetch`
  (the client adds it). Config comes from `/config.json` at runtime, never `VITE_*`.
- Strings go through `t('key')`; a test fails on unused or missing keys. No inline script or style (strict CSP).
- Server state in TanStack Query (optimistic: snapshot, patch, restore, invalidate). Forms validate with the
  generated zod schema. Use real elements and labels; axe runs in tests and e2e.
- Contract change: edit openapi.json, `npm run gen`, `npm run build`, commit all.

## Checks

`RunChecks` runs format, lint, tsc, tests (85% gate). `npm run check` adds gen:check, audit, build.
Then `VerifyApp`: open `/`, sign in, create an item. `npm run e2e` runs Playwright (desktop and 390px).
