# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction keeps this file
when it drops the transcript. Versions are the ones resolved in `package-lock.json` on 2026-10-06
(checked against the npm registry and release pages that day); every dependency in `package.json`
is pinned exactly and used.

## Platform

- Node 24 LTS (`engines >=24`, `.nvmrc`, image `node:24.21.0-alpine3.24` by digest) — Active LTS; Node 22
  is in maintenance, jsdom 30 needs 22.22 or 24.15, and Node 26 becomes LTS on 2026-10-28.
  Scripts under `scripts/` are TypeScript that Node 24 runs directly (type stripping), so they are
  type-checked and unit-tested like the app.
- Vite 8.3.2 with `@vitejs/plugin-react` 6.1.2 — the current major; the React plugin no longer
  needs Babel. No Next.js: nothing here needs server rendering, and the auth model is the gateway's.
- React 19.3.0 — the current stable; `ref` as a prop, `use`, form actions available when wanted.
- TypeScript **6.0.3**, not 7 — 7.0.2 (the native compiler) is stable, but the TanStack and hey-api
  tooling is validated on 6 and `@hey-api/openapi-ts` lists `>=5.5.3` or `>=6.0.0`; revisit 7 once
  the ecosystem's peer ranges include it. `erasableSyntaxOnly` is on so the code also runs under Node's
  type stripping.
- Biome 2.5.15 for format, lint (with the accessibility rules) and import order — one tool and one
  config instead of ESLint + Prettier + plugins; `typescript-eslint` does not yet support TypeScript 6.1+.

## Libraries

- TanStack Router 1.170.41 (file-based routes, type-safe search params, `beforeLoad` guards, code
  splitting by the plugin) and TanStack Query 5.104.1 (server state, infinite queries, optimistic
  updates). React Router and Redux Toolkit rejected: Router's search-param typing and Query's cache cover
  what they would.
- Tailwind CSS 4.3.3 through `@tailwindcss/vite`, with design tokens as CSS variables and a semantic
  colour layer, so dark mode and re-branding are a change to one block. No component library: the
  primitives needed here (button, field, dialog, toast) are small, and the native `<dialog>` gives focus
  trapping and Escape for free. shadcn/ui is the next step when the primitive count grows.
- `@hey-api/openapi-ts` 0.99.0 — generates the client, TanStack Query option factories, and zod schemas
  from one contract; pinned exactly because it is pre-1.0 (output can change between minors, which is why
  the generated code is committed and `gen:check` regenerates it in CI). Its client is generated into the
  repository, so there is no runtime dependency on it. orval and openapi-typescript considered: the latter
  needs a separate fetch layer and a TypeScript 5 peer.
- zod 4.6.5 — validates forms with the *generated* schemas (limits come from the contract). Runs
  interpreted (`jitless`, `src/shared/zod-config.ts`): its JIT compiler probes `eval` at import time, which a
  strict CSP blocks and reports on every page load. react-hook-form not added: three fields do not need it;
  it layers on the same schemas when forms multiply.
- No icon library, no date library, no i18n library: inline SVG for three icons, `Intl` for dates, numbers and
  plurals, and a 70-line typed catalogue. Each is the swap-in point named in `docs/EXTENDING.md`.

## Tests

- Vitest 5.0.3 + jsdom 30.1.2 + Testing Library (react 16.3.3, user-event 14.6.7, jest-dom 7.0.1) + MSW 3.0.2:
  component tests that render the real routes and the real generated client against the same mock gateway the
  dev server uses. axe-core 4.14.0 runs inside them (no contrast in jsdom); `@axe-core/playwright` 4.13.0 runs
  in a real browser with contrast. Coverage gate 85% lines (v8 provider); measured 99% at scaffold.
- Playwright 1.63.0 (image pinned by digest) at 1280x800 and 390x844, against `vite preview` with the mock
  gateway by default and against a real stack with `E2E_BASE_URL`. The same specs, including the contract
  spec that parses live API responses with the generated zod schemas, run against four backends in the bundles.
- `@vitest/mocker` declares an optional peer on MSW 2; an npm `overrides` entry maps it to the installed 3.

## Security

- BFF, no tokens in the browser (RFC 10017): the SPA calls `/api` on its own origin and a gateway holds the
  session. CSRF is `SameSite=Lax` plus a required `X-Requested-With: fetch` header on unsafe methods.
  Considered and rejected: tokens in memory or `sessionStorage` (readable by any injected script), and a
  token-handler library in the browser (it keeps the token problem and adds a dependency).
- Strict CSP with no `unsafe-inline` or `unsafe-eval`: theme initialisation is a same-origin file, there
  is no inline style, the e2e suite fails on any violation. One header table (`mock/security-headers.ts`) is
  checked against nginx's by a unit test.
- Runtime configuration from `/config.json` with same-origin-only URLs, written by an entrypoint that
  validates each value against a strict pattern and refuses to start otherwise.
- nginx-unprivileged 1.30.5 (the stable branch) with a hand-written config: non-root, read-only root filesystem
  (everything under `/tmp`), `server_tokens off`, source maps deleted from the image and refused, `/api` answers
  404 JSON instead of the SPA shell. Its own `/docker-entrypoint.d` scripts are not used.
- `npm audit` gate (`scripts/audit.ts`): high and critical fail, an allow-list entry needs a reason and an expiry.
  First run on the build day found three high advisories in `js-yaml` 4.2.0 via `@hey-api/json-schema-ref-parser`
  (GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh): an `overrides` entry pins js-yaml 4.3.2, the
  patched release. Remove it when hey-api ships a release that depends on a fixed range.
- SBOM through `npm sbom` (built in; `--omit dev` returned only two components on npm 11.19, so it lists all locked packages), not `@cyclonedx/cyclonedx-npm` (pulls deprecated native packages).

## Rejected

- Next.js, Remix, Astro (no SSR or SEO requirement; the BFF is outside the app), Redux, Axios, react-hook-form,
  lodash/date-fns/clsx, a CSS-in-JS library, Storybook (until there is a design system), Jest, Cypress, ESLint +
  Prettier, a service worker (no offline requirement; adds a cache-invalidation problem).
