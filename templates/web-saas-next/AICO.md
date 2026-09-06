# __APP_TITLE__

A full-stack web app: Next.js App Router, React server components and server
actions, Tailwind, node:sqlite, a signed cookie for sessions. Strict TypeScript.
Runs as its own process; aico starts it with `next dev` and waits for "ready".

## Layout

- `src/lib/db.ts` — opens the database once per process; `MIGRATIONS` in order. Append, never edit.
- `src/lib/session.ts` — signed cookie encode/decode (pure). `src/lib/auth.ts` — users,
  passwords (scrypt), `currentUser()`, `requireUser()`, cookie set/clear.
- `src/lib/items.ts` — **the worked feature's data layer**: type, parse, functions
  taking `(db, userId, …)`. Copy this file for each new feature.
- `src/app/items/page.tsx` + `actions.ts` — the worked feature's screen (server
  component) and server actions (`'use server'`, each starting with `requireUser()`).
- `src/app/actions/auth.ts` — register, login, logout actions. `src/components/` —
  the few client components (forms with inline errors).
- `src/app/api/healthz/route.ts` — health. `test/` — vitest over the lib files, in memory.

## Conventions

- A feature = `src/lib/<feature>.ts` + `src/app/<feature>/page.tsx` + `actions.ts`
  (+ a client component only where the browser needs state).
- Read in server components, write in server actions; no API routes for the
  app's own pages. API routes are for other clients.
- Every query is scoped by `user_id` from the cookie, never from the form.
- Validation returns `{ error }` / `{ errors }`; the form shows it beside the field.
- Styling: Tailwind utilities plus the small component classes in `globals.css`
  (`btn`, `input`, `card`, `label`, `field-error`). Tokens in `@theme`.
- Config from env only: `SESSION_SECRET`, `DATABASE_PATH`. See `.env.example`.

## Checks

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. `RunChecks`
runs them. Then `AppManage start` and `VerifyApp`: register, add an item, tick
it, sign out, sign in again and see it still there.
