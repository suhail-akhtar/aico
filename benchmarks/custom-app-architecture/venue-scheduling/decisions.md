# Decisions — VenueSlot

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript, so a decision written here survives
a long build.

## Stack

- React 19 + Vite, Hono on Node 22, SQLite through the built-in `node:sqlite`:
  one small venue's month view needs components, the overlap rule needs a server
  that decides, and a file database needs nothing installed. No ORM: the whole
  data model is two tables and one indexed range query.
- One process, one port: in dev Vite runs in middleware mode inside the Hono
  server (`src/server/dev.ts`), so the single URL the platform reports serves
  both the app and `/api`. In production the same app serves `dist/client`.
- The database file lives in `data/`, which is gitignored — the venue's bookings
  are not source.

## The booking rule

- `setup_minutes`/`teardown_minutes` are copied onto each booking from its event
  type and `block_start`/`block_end` are stored alongside the event times, so the
  overlap test is one indexed range comparison (`block_start < ? AND ? < block_end`)
  and editing an event type never rewrites a booking already in the diary.
- Overlap is half-open: touching at an edge is free. Enforced inside one
  `BEGIN IMMEDIATE` transaction in `createBooking`, never in the browser.
- A refusal answers `200 { booked: false, reason, conflict }` rather than 409 —
  "the hall is taken" is an answer to a well-formed request, and it keeps failed
  requests out of the browser console. A body that is not a JSON object is still
  a 400.
- The setup/teardown arithmetic lives in `src/shared/time.ts` and both the form
  preview and the server call it, so what the form promises is what the server
  decides.
- An end time at or before the start time means the event runs past midnight
  (a party ending at 01:00 belongs to its evening).
- Times are stored as wall-clock strings with no offset; `YYYY-MM-DDTHH:MM` sorts
  lexicographically in time order, which is what makes the range test work.
