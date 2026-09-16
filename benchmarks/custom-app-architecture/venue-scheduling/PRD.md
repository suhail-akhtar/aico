# VenueSlot — PRD

## Purpose

A scheduling tool for a small event venue: staff book the hall for weddings,
corporate events and private parties, and see the booked month at a glance.
Every event carries its own setup and teardown time, and the venue cannot be
double-booked once that time is counted in.

## Stack

Custom app — the stack was chosen here, not inherited from a template.

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | React 19 + TypeScript, bundled by Vite | A month grid is view state that changes on every click (month paging, day selection, a booking appearing without a reload). Components and HMR make that cheap to build and easy to re-render. Vite bundles locally, which also satisfies the platform's no-CDN rule. |
| Backend / API | Hono on Node 22, served by `@hono/node-server` | The no-overlap rule is a correctness rule, so it lives in one place on the server, never in the browser. Hono is a few kilobytes, typed end to end, and runs straight from TypeScript under `tsx` — no build step in dev. One process, one port: in dev Vite runs in middleware mode inside this same server, so the URL the platform reports serves both the app and the API. |
| Database | SQLite through Node's built-in `node:sqlite` | One venue's data is a few thousand rows in one file, so a file database beats a database service to install, run and back up. The driver is already inside Node — no native module to compile on Windows, no ORM to keep in step with the schema. It is synchronous, so the overlap check and the insert happen in a single SQL transaction. |
| Shape | One monolith, no services | The venue is one place with one calendar. Splitting it would add a network boundary to a rule that must be atomic. |

## Users and the primary action

Venue staff and the person who runs the bookings. They use it on the day a
customer calls: they open the month, look at what is already booked, and put a
new event in — or are stopped because the hall is already taken that evening.
The tenth visit looks like the first: pick a month, read it, add a booking.

## Scope

**In this iteration**

- Month calendar: every booking on its day, with the setup and teardown block
  it occupies shown alongside the event itself.
- Event types (wedding, corporate event, private party), each with its own
  default setup and teardown time.
- Create a booking: event type, name, contact, date, start and end time.
- Overlap rule: a booking is refused when its setup → teardown window touches
  an existing booking's window. Touching exactly at an edge is allowed.
- Cancel a booking, freeing its slot.
- Per-booking setup/teardown override, so a one-off does not change the type.

**Out (deliberately)**

- More than one bookable space, and moving a booking between spaces.
- Departments or staff accounts, roles and sign-in: one trusted team, one URL.
- Recurring bookings, deposits, invoices, customer emails, iCal feeds.
- Time zones: the venue's own wall clock, stored as written.

## Data

- **event_types** (id, name, setup_minutes, teardown_minutes, colour) — the
  defaults a booking starts from. Seeded with Wedding (3 h setup / 2 h
  teardown), Corporate event (1 h / 1 h), Private party (1.5 h / 1.5 h).
- **bookings** (id, event_type_id, title, contact, event_date, starts_at,
  ends_at, setup_minutes, teardown_minutes, block_start, block_end, notes,
  created_at) — one event's hold on the venue. `starts_at`/`ends_at` are the
  event itself; `block_start`/`block_end` are those ± the booking's own
  setup and teardown, stored so the overlap test is one indexed range
  comparison. An event type has many bookings; the venue has one calendar, so
  every booking is a candidate clash for every other.

## Done when

- The month view shows each booking on its day with the event's own time and
  the wider block it occupies, and the arrows page to the next and previous
  month.
- Staff can book an event by choosing a type and a start, and it appears on
  the calendar in the same visit, with no reload.
- A booking that would overlap an existing block is refused, the refusal names
  the booking it collides with, and nothing is written.
- Cancelling a booking removes it and frees its slot for a new booking.
- One booking's setup and teardown can be changed without altering its event
  type's defaults.
- `RunChecks` (typecheck, lint, build, test) is green.

## Open questions / assumptions

- **Assumed** one bookable space. The brief says "a small event venue" and "no
  two bookings can overlap" without naming rooms; a second space would make
  overlap a per-space rule and is named in "Later".
- **Assumed** staff are trusted and there is no sign-in this iteration.
- **Assumed** times are the venue's local wall clock, stored without an
  offset, and that a block never has to cross midnight into a second day of
  its own (a booking may end after midnight, but it is stored as one window).
- **Assumed** setup and teardown default from the event type but are editable
  per booking — caterers change the plan for one wedding, not the type.
- **Assumed** half-open comparison: a booking starting the minute another's
  teardown ends is fine. Worth confirming with the venue; the rule is one line
  in `src/server/bookings.ts` either way.
