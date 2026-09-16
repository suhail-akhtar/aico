# Goalboard — PRD

## Stack

Custom app, so the stack is chosen here. Four decisions, one reason each.

- **Backend/API — Node 22 + TypeScript (strict) on Hono**, served by
  `@hono/node-server`. TypeScript because the thing that must not leak is a
  permission rule, and types let "this query was scoped to a team" be part of the
  signature rather than a comment. Hono because it is small, has first-class
  middleware (which is where the session and role guards live) and runs on plain
  Node with no framework ceremony.
- **Database — SQLite through Node's built-in `node:sqlite`.** A small team's
  goal list is one file and a few thousand rows; SQLite gives real constraints
  (`CHECK`, `UNIQUE`, `REFERENCES`) with no server to run and no native build
  step (the driver ships inside Node 22.13+). Foreign keys on, migrations
  numbered and append-only. The move to Postgres, if it ever comes, replaces one
  file: the repositories are already the only place that holds SQL.
- **Frontend — server-rendered HTML,** one CSS file and one small vanilla-JS
  file, no framework and no bundler, no CDN (the CSP forbids it). Rendering the
  board on the server means another team's rows are never serialised into the
  response at all, so isolation is enforced in one place — the repository — and
  not re-enforced in a client filter that a curious user can bypass. It also
  gets a usable board on a cheap phone with no build step.
- **Shape — one monolith, one process.** One team-sized product; a service
  boundary would buy nothing but a deployment.

Sessions are httpOnly `SameSite=Lax` cookies backing a server-side session row;
passwords are scrypt with a per-user salt (`node:crypto`).

## Purpose

A shared place for a small team to agree on its goals, give each one a target
date, and see at a glance how far along it is — without any other team's work
showing up.

## Users and the primary action

Three roles, each scoped to one team:

- **owner** — creates goals with a target date, tracks progress, manages who is
  on the team and at what role.
- **member** — updates the progress of their team's goals.
- **viewer** — reads the board and nothing else.

The tenth visit is not sign-up: it is opening the board and moving a goal's
progress after a stand-up. Everything else exists to make that one gesture
trustworthy.

## Scope

**In this iteration:** email + password sign-in; teams and memberships at three
roles; goals with a title, description, target date and 0–100 progress; a
progress log per goal; the board; the team page for adding a teammate; and the
isolation rule — every read and write is filtered to the caller's team.

**Deliberately not:** self-service registration, email delivery or invites by
email, password reset, cross-team rollups and portfolio views, comments,
attachments, notifications, per-goal key results, SSO, billing, i18n. A person
belongs to one team in this iteration; the schema already allows several, and
the switcher is Later.

## Data

```
users         (id, email UNIQUE lower-cased, name, password_hash, created_at)
teams         (id, name, created_at)
memberships   (team_id → teams, user_id → users, role owner|member|viewer)
goals         (id, team_id → teams, title, description, target_date YYYY-MM-DD,
               progress 0..100, created_by → users, created_at, updated_at)
goal_updates  (id, goal_id → goals, user_id → users, progress, note, created_at)
sessions      (token_hash, user_id → users, created_at, expires_at)
```

A user reaches a team through `memberships`; a goal belongs to exactly one team.
The isolation rule is structural, not a check sprinkled around: the repository
functions that touch a goal take the caller's `teamId` as an argument —
`findScoped(id, teamId)`, `listByTeam(teamId)` — so there is no code path that
reads a goal without saying which team it is allowed to be from. An id belonging
to another team answers **404, not 403**, so the app never confirms that another
team's object exists.

## Done when

- Signing in as an Atlas owner lands on the Atlas board, which lists Atlas's
  goals and no goal, id or count from Beacon.
- An owner creates a goal with a title and a target date and it appears on the
  board with its date and its starting progress.
- A member moves a goal's progress to a new value, and the board and that goal's
  progress log both show it.
- A viewer sees the same board with no create or edit control, and a direct
  progress write from a viewer is refused and changes nothing.
- A request naming another team's goal — from any role, including an owner —
  answers 404 and changes nothing; `npm test` proves this for every repository
  read and write, not only the ones with a screen.
- `npm run typecheck`, `npm test` and `npm run build` pass.

## Open questions / assumptions

- **Assumed** teammates are added by an owner, who types the email and a starting
  password and passes it on by hand. No email is sent, because no mail provider
  is in scope; the first invite flow may change this.
- **Assumed** a target date is a date, not a moment: stored `YYYY-MM-DD`, shown
  as "due 12 Mar" or "8 days overdue", never converted between timezones.
- **Assumed** progress is one 0–100 integer per goal, not key results. A goal
  with several measurable key results is the obvious next iteration and would
  change the `goals` shape; the integer is what a stand-up actually asks for.
- **Assumed** a person belongs to one team, so the board has no team switcher.
- **Assumed** sign-in is email + password with no verification and no reset, and
  that sessions outlive a restart because they live in the database.
