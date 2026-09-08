# __APP_TITLE__

A full-stack web app: Next.js App Router, server components and actions,
Tailwind, node:sqlite, a signed session cookie. Its own process: aico runs
`next dev` and waits for "ready".

## Layout

- `src/lib/db.ts` — opens the database once; `MIGRATIONS` in order. Append only.
- `src/lib/session.ts` — signed cookie (pure). `src/lib/auth.ts` — users, scrypt
  passwords, `currentUser()`, `requireUser()`, cookie set/clear.
- `src/lib/items.ts` — **the worked feature's data layer**: type, parse, functions
  taking `(db, userId, …)`. Copy it for each new feature.
- `src/app/items/page.tsx` + `actions.ts` — its screen (server component) and
  actions (`'use server'`, each starting with `requireUser()`).
- `src/app/actions/auth.ts` — register, login, logout. `src/components/` — client
  forms with inline errors.
- `src/components/shell/` — the signed-in shell; `nav.ts` has one entry per feature.
  `src/components/ui/` — `PageHeader`, `StatCard`, `StatusPill`, `EmptyState`:
  every screen is built from these. Skill `app-design` says how.
- `src/app/api/healthz/route.ts` — health. `test/` — vitest over the lib files.

## Conventions

- A feature = `src/lib/<f>.ts` + `src/app/<f>/page.tsx` + `actions.ts` + a nav entry.
- Read in server components, write in server actions; API routes are for other clients.
- Every query scoped by `user_id` from the cookie, never from the form.
- Validation returns `{ error }` / `{ errors }`; the form shows it beside the field.
- Styling: Tailwind utilities plus the classes in `globals.css` (`btn`, `input`,
  `card`, `label`, `field-error`). Tokens in `@theme`; never a raw hex.
- Config from env only: `SESSION_SECRET`, `DATABASE_PATH`. `.env.local` was written
  at create with a generated secret; `.env.example` documents both.

## Checks

`npm run typecheck`, `lint`, `test`, `build` — `RunChecks` runs them. Then
`AppManage start` and `VerifyApp` with steps: register, add an item, tick it,
sign out, sign in, see it still there.
