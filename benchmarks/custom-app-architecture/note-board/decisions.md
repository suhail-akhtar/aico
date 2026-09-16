# Decisions — Stickyboard

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript, so a decision written here survives
a long build.

- **Hono on Node, node:sqlite, one process.** Two tables and one team's worth of
  traffic; the built-in SQLite driver means a fresh clone installs nothing native.
- **Live updates over SSE, not WebSockets and not polling.** Changes only flow
  server → browser (writes are ordinary HTTP), `EventSource` reconnects by itself,
  and polling would make freshness a function of an interval.
- **The change feed is in memory, per board, and nothing is replayed.** A client
  re-reads the board whenever its stream (re)opens, which is cheaper and more
  correct than keeping an event log for a feed only the connected care about.
- **The client is one page of plain JavaScript, no framework and no bundler.**
  One screen and one event loop; DOM is built with `textContent`, never
  `innerHTML`, because note text is whatever a teammate typed.
- **Notes are upserted by id, and a writer gets its own event back.** The write
  path and the stream then cannot disagree, so no code has to remember which
  change was local.
- **Colour is one of five palette names, not a hex.** `CHECK` in the schema and
  `COLOURS` in the parser enforce it; re-tuning the colours stays a CSS change.
- **A note's order is an integer `position`, set to max+1 on create.** The wall is
  append-ordered today, and drag-to-arrange later is then a UI change, not a
  migration.
- **Timestamps are ISO 8601 with milliseconds, written by the repository.** With
  second precision an edit made in the same second as the create was invisible,
  and "edited" is something the wall shows.
- **Deleting asks in place (click Delete, then "Delete?"), with no modal and no
  undo.** A shared wall is a live surface: a dialog steals focus from someone
  else's typing, and there is no history to undo against yet.
- **The open board lives in the URL hash (`#/board/3`); the last one is also kept
  in `localStorage`.** A link to a board is shareable, and a visit with no hash
  comes back to the board you were reading rather than the first one.
- **One board is seeded on first run.** The primary action is writing a sticky,
  so an empty app should not open with a board-creation step in front of it.
- **The client re-reads the board when its stream reconnects or the tab wakes.**
  A stream that died without an error would otherwise leave the wall quietly
  stale, and the header badge says which state the stream is in.
- **Run config for this custom app lives in `app.json` (`run.dev`, `run.ready`).**
  A custom scaffold carries no template profile, so the runner has to be told how
  to start it and what to wait for ("listening on").
- **`SSE_KEEP_ALIVE_MS` exists so tests can beat a stream every 50ms.** The
  keep-alive is 25s in production; without the override the SSE test would wait
  a full interval to prove a stream with nothing to say.

## Verification notes

- The browser checks create their own board each run instead of assuming an empty
  database, so the suite is order-independent and can be re-run.
- The boards those checks created were deleted from the development database
  afterwards, leaving the seeded "Team board" — they were test artifacts, not
  anyone's notes.
