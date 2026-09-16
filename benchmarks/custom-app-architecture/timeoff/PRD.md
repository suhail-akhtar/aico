# DaysOff — PRD

## Stack

Custom app (`process` kind), decided here because no template was used.

- **Frontend — TypeScript compiled by `tsc` to plain ES modules, served as static
  files; hand-written CSS with design tokens. No framework, no bundler.**
  The client is two screens (my time off, my team) over one REST API, and none of
  the domain logic lives in it: business-day counting and the running balance are
  computed server-side where they are unit-tested. React + Vite would add a
  second dev process for the platform to babysit and ~300 MB of install for two
  screens that re-render on a fetch. If the UI grows past roughly five screens
  or starts holding real client state, that trade flips and Vite + React comes in.
- **Backend — Hono on Node 22, TypeScript strict, one process serving both
  `/api/*` and the client.** Hono is Web-standard `Request`/`Response`, so the
  tests call the whole app in memory (`app.request(...)`) with no port open — and
  a test that never binds a socket cannot flake on a busy port.
- **Database — SQLite through the built-in `node:sqlite`, migrations as an
  append-only numbered array.** The data is relational (an employee has a
  manager; a request has an employee and a decider) and the balance is a
  queryable sum. `node:sqlite` is in the runtime: no driver, no native build, no
  pool, one file on disk. Single internal tool, one writer — Postgres buys
  nothing until a second instance writes at once, and `db.ts` is the only file
  that would change.
- **One process, not services.** One company, tens of users, one deployable.

## Purpose

An internal time-off tool: an employee asks for days off and can see where they
stand, and a manager clears the queue of their direct reports' requests.

## Users and the primary action

- **Employee** — asks for time off, then re-checks the same screen: days left,
  what is still pending, what was decided.
  Tenth visit: *"how many days do I have left, and did my request go through?"*
- **Manager** — opens the queue, decides. Tenth visit: approve or deny the two
  or three requests waiting, with a note explaining the call.

There is no admin: managers are managers because someone lists them as their
manager (see *Data*), not because of a role field.

## Scope

**In this iteration:** pick who you are; see your own requests and days left;
submit a request in whole working days; a manager sees *only* their direct
reports' pending requests; approve or deny with a note; the employee's screen
then shows the outcome, the note, and the corrected balance.

**Deliberately not yet:** passwords and SSO (identity is a picker over a seeded
directory — see *Assumptions*); half days and hours; public-holiday calendars;
carry-over between years; editing or cancelling a request after it is sent;
email or Slack notification; a company-wide calendar of who is out; accrual
by tenure.

## Data

- **Employee** (`id`, `name`, `email`, `manager_id → Employee.id`, `allowance_days`,
  `created_at`) — self-referencing: `manager_id` is *the* statement of who
  reports to whom.
- **TimeOffRequest** (`id`, `employee_id → Employee.id`, `start_date`, `end_date`,
  `days`, `reason`, `status`, `decided_by → Employee.id`, `decided_at`,
  `decision_note`, `created_at`) — `status` is `pending | approved | denied`;
  `days` is the count of working days, stored at creation so a later change to
  the counting rule cannot silently rewrite history.
- **Balance** is derived, never stored: `allowance_days − SUM(days)` over that
  employee's *approved* requests in the current calendar year. Pending days are
  reported separately so a request in flight never reads as days already spent.

Relations: an employee reports to at most one manager; a manager has many direct
reports; an employee has many requests; a request is decided by exactly one
manager (the employee's, or nobody while pending).

## Done when

- Picking a person shows their name, their days left, and their own requests —
  and nobody else's.
- Submitting a request stores whole working days (Sat/Sun excluded), rejects an
  end before a start or an overlap with an existing request, and lists the new
  row as Pending.
- A manager's queue contains the pending requests of their direct reports and
  nothing else — not their own, not another manager's team's.
- Approving or denying stores the note and the decider; days left drops by the
  approved days and by nothing on a denial.
- Deciding a request for someone who is not your direct report answers 403.
- `npm test` covers the working-day count and the balance arithmetic.

## Open questions / assumptions

- **Assumed** identity is a picker over a seeded directory (`POST /api/session`
  with an employee id, id kept in an HttpOnly cookie), because no SSO or user
  store was named. Swapping it for company SSO means replacing `src/server/session.ts`
  only — every route already reads the id from the cookie.
- **Assumed** a 25-working-day annual allowance per employee, overridable per
  row via `allowance_days`.
- **Assumed** whole days, Monday–Friday, public holidays ignored.
- **Assumed** the manager is the employee's *direct* manager, not the whole
  chain above them.
- **Not asked yet:** whether a manager may also approve their own request (this
  iteration says no — the queue is direct reports only).
