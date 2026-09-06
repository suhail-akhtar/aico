# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript.

- Page app on the aico host rather than a framework — a records tool has one
  screen and a handful of tables; the host's data API and CRUD component are
  the whole backend, so there is nothing to install and nothing to deploy.
- Constraints live in `schema.sql` (NOT NULL, CHECK, DEFAULT) — a rule the
  database holds is one the page cannot forget.
- Newest first — the reader's tenth visit is about what just happened, not the
  oldest row.
- Summary strip above the table — the reader came for a figure, not for arithmetic.
