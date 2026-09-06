# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript.

- Next.js App Router with server components and server actions — reads and
  writes stay on the server, forms work without JavaScript, and there is no
  separate API layer to keep in sync with the pages.
- node:sqlite — zero dependencies and one file; the lib functions take the
  database as a parameter so moving to Postgres changes `db.ts` and the
  statements, not the pages.
- Signed cookie sessions (HMAC, node:crypto) instead of a session table or an
  auth library — nothing to install, nothing to expire, and rotating the secret
  is the sign-everyone-out lever.
- scrypt for passwords — in node:crypto, memory-hard, sensible defaults.
- Every query scoped by `user_id` from the cookie — an id from the client is
  never trusted on its own.
- Tailwind with a small component layer in `globals.css` — utilities for layout,
  five named classes so buttons and inputs look the same on every page.
- `output: 'standalone'` — the Dockerfile ships only the server Next traced.
