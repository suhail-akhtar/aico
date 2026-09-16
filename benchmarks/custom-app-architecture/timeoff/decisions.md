# Decisions — DaysOff

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript, so a decision written here survives
a long build.

- Hono on Node over Next.js/Express — Web-standard Request/Response, so the whole
  app is tested in memory with `app.request(...)` and no port, and one process
  serves both the API and the built client. A framework with its own build,
  router and second dev server is more moving parts than two screens justify.
- node:sqlite over Postgres or an ORM — in the runtime, so no driver and no
  native build, one file on disk, synchronous. `db.ts` is the only file that
  changes when a second writer appears.
- TypeScript for the browser, compiled by `tsc` to ES modules, no bundler — the
  client is thin because the domain logic is server-side and tested there, and
  `tsc` was already a dependency. Revisit at roughly five screens.
- Identity is a cookie holding an employee id picked from the directory, not SSO
  — no user store was named. It is isolated in `src/server/session.ts`, and every
  route already scopes by the id it returns, so SSO replaces one file.
- Manager-ness is derived from `employees.manager_id`, with no role column —
  "my direct reports" is then one query and cannot disagree with the reporting
  line itself.
- The balance is computed on every read (allowance less *approved* days this
  year) and never stored; pending days are shown beside it rather than
  subtracted, so a request in flight does not make days vanish before a decision.
- A request's `days` is stored on the row when it is made — a later change to the
  counting rule must not rewrite what was already agreed.
- The nav is absent until there are two places to go (the manager queue, backlog
  story 3): the shell, the page header and the content column are the parts
  chosen once, and one nav item is decoration, not navigation.
- The narrow-screen table becomes one card per request via CSS on the same
  markup (`thead` hidden, each cell labelled from `data-label`) rather than a
  second card render — nothing is duplicated for phones, and the table stays a
  real table for screen readers on wide screens.
- `GET /api/session` answers `{ employee: null }` rather than 401, and the page
  asks it first — asking for "my time off" before knowing who I am put a failed
  request and a console error in front of every first-time visitor.
- Below 720px the top bar takes two rows (brand, then identity and the button)
  instead of squeezing three items onto one and wrapping the button's label.
- Requests carry `data-employee`, and the people in the picker carry
  `data-email`: a check can then prove that Ada's page holds no row belonging to
  Ben, which asserting the presence of a name cannot.
- The client split into slices once there were two screens: `dom.ts` (builders,
  dates, fields), `my-time-off.ts`, `team.ts`, `main.ts` (shell, gate, routing).
  One file per screen, the same shape the server uses.
- The navigation appears now that there is a second destination, as a horizontal
  bar under the top bar with `aria-current="page"` — two items do not need a
  sidebar, and a bar needs no menu button to work at 390px.
- The form pre-checks only "the last day is before the first", the one rule it
  can settle without a round trip. Weekends, overlaps and the length of the
  range stay the server's answers, put beside the field — one policy, in one
  place, with the client holding a copy only where a round trip buys nothing.
- A denial must carry a note; an approval need not. The employee is owed a
  reason when the answer is no, and a manager approving a clear request should
  not have to write one.
- The queue is ordered soonest first: it is worked from the top, and the person
  who asked first should not wait behind a later request.
- Overlap is `existing.start_date <= new.end_date AND existing.end_date >=
  new.start_date`. The first version compared new-start with new-end, which
  looks correct for a one-day range and silently allows every other clash;
  `test/requests.test.ts` caught it with a Tuesday-to-Friday case.
