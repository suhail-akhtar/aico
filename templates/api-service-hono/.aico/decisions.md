# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript.

- Hono over Express/Fastify — Web-standard Request/Response, so tests call the
  app in memory with no port and the same code runs on Node, Bun or an edge runtime.
- node:sqlite over an ORM or Postgres — zero dependencies, one file, synchronous;
  a service that outgrows it moves to Postgres by swapping `db.ts` and the
  prepared statements, not the routes.
- Migrations as a numbered array in `db.ts` — append-only, recorded in
  `_migrations`, so a deployed database is never re-run from scratch.
- Validation returns field errors rather than throwing — the 400 body names the
  field, which is what a client can show beside it.
- OpenAPI written by hand — a generator is one more dependency and drifts just
  the same; the test that compares paths is what keeps it honest.
- Config from env only — the same image runs on every host without a rebuild.
