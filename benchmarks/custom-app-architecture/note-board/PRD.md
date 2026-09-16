# Stickyboard — PRD

## Purpose

A shared note board for a small team: sticky notes with a title, a body and a
colour, grouped into boards, where a change one person makes shows up for
everyone else on that board without anyone refreshing the page.

## Users and the primary action

Three to ten people on one team, working the same wall at the same time. No
accounts and no sign-in — the board link is the membership, and the brief says
anyone on the team can add, edit or delete any note.

The tenth-visit action: open the board, scan the wall for what changed since
they last looked, and add or adjust a sticky. Everything below is ordered around
that: the wall first, chrome last.

## Stack

A custom app, so the stack is decided here rather than inherited from a template.
The choice that matters is **how changes get to other people's browsers**, and it
drives the rest.

- **Frontend — static ES-module JavaScript, no framework and no bundler**, served
  by the app's own server. The whole UI is one screen (a wall of notes) plus one
  sticky-note component used twice (composer and editor). A component framework
  would add a dependency tree, a build step and a second toolchain to keep in
  sync, and buy nothing at this size; DOM nodes are built with `textContent`
  rather than `innerHTML`, which is also the XSS-safe way to render text three
  teammates typed. Cards are keyed by note id and patched in place, so a live
  event never fights a caret in a field someone is typing into.
- **Backend / API — Hono on Node 22, TypeScript strict, one process.** The
  platform's `api-service-hono` template is the worked pattern for this shape:
  typed routes, field-level `400`s, `/healthz` + `/readyz`, SIGTERM shutdown, and
  vitest against the app in memory so tests never open a port. Hono's
  `streamSSE` gives server push without adding a second server or a socket
  library, and the same process serves the JSON API, the event stream and the
  static page.
- **Database — SQLite via `node:sqlite`, the built-in driver.** Two tables, a few
  hundred rows, one writer. Nothing to install, no native module to compile on a
  fresh clone, and the database is a file next to the app. Going to a
  multi-writer database later is confined to the repository functions
  (`boardsRepo`, `notesRepo`) — routes do not change.
- **Realtime — Server-Sent Events, not WebSockets and not polling.** Changes flow
  server → browser only: writes are ordinary `POST`/`PATCH`/`DELETE` requests, and
  a client that wants to *make* something happen has no use for a duplex socket.
  `EventSource` reconnects on its own, which is exactly the failure mode that
  matters in a small team's office wifi. Polling would make how fresh the wall
  looks a function of an interval, and pay the database for every idle tab.
- **Monolith, not services.** One deployable: the JSON API, the change feed and
  the page all live in the same process, because the fan-out is in memory — a
  second replica would not see the first one's events on its own connections.
  This is the correct trade for one small team, and the wrong one for a
  multi-tenant product; the note is in Open questions.

## Scope

**In this iteration:** boards (list, create, switch, deep-linkable), sticky notes
with title, body, colour and author, add / edit / delete from the wall, live
updates to everyone viewing the same board, a display name each person sets in
their own browser, empty / loading / disconnected states.

**Deliberately not:** accounts, permissions and teams (the brief gives everyone
edit rights); drag-to-arrange and canvas coordinates; comments, attachments,
mentions; search and filtering; edit history and undo; moving a note between
boards; offline editing; a native mobile app; any retention or archive of
deleted notes.

## Data

- **Board** (`id`, `name`, `created_at`) — has many notes. Deleting a board
  deletes its notes.
- **Note** (`id`, `board_id`, `title`, `body`, `colour`, `author`, `position`,
  `created_at`, `updated_at`) — belongs to exactly one board. `colour` is one of
  five palette names (`yellow`, `pink`, `blue`, `green`, `purple`), not a free
  colour, so the palette stays a design decision and not user data. `position`
  orders the wall; new notes append. `author` is the display name the browser
  sent, kept so the wall can say who wrote what — and so real accounts are an
  addition rather than a migration.

## Done when

- Opening a board renders its notes as cards showing title, body, colour and
  author, and an empty board says so instead of showing nothing.
- Adding a note with a title, a body and a colour puts it on the wall, and it is
  still there after a reload.
- Editing a note's text or colour updates its card in place; deleting removes it.
- A change made by one client reaches another client on the same board with no
  refresh — `test/events.test.ts`, two subscribers, one board.
- Creating a board adds it to the sidebar, opens it, and survives a reload.
- `npm run typecheck`, `npm run lint`, `npm run build` and `npm test` pass.

## Open questions / assumptions

- **Assumed no sign-in.** The brief says anyone on the team can change anything,
  so membership is the link and identity is a display name kept in
  `localStorage`. Assumed rather than asked because it is reversible: `author` is
  already a column, so real accounts are additive.
- **Assumed the wall is an append-ordered grid**, not a canvas of x/y positions.
  Sticky notes read as cards in a responsive grid; `position` exists so a
  drag-to-arrange story is a UI change, not a schema change.
- **Assumed one process serves one team.** Restarting the server drops open
  event streams (the browsers reconnect), and the change feed does not cross
  replicas. Both are fine at this size and both are recorded in decisions.
- **Assumed the first run should not be a setup wizard.** The database seeds one
  "Team board" so the primary action — add a sticky — is reachable immediately.
- **Assumed deletes are permanent and unconfirmed by a modal.** A live wall is a
  shared surface, so the card asks once, in place, before it goes; there is no
  undo in this iteration.
