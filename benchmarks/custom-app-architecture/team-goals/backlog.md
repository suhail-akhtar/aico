# Goalboard — backlog

Vertical slices: each story is data → logic → screen → check, and ships on its
own. Order is the tenth visit: sign in, then the primary action (move a goal's
progress), then the permission and isolation guarantees, then adding people.

## Iteration 1 — A team signs in, sees only its own board, and moves a goal forward

- [x] A teammate signs in with their email and password and lands on their
      team's goal board, showing only that team's goals.
      Done when: VerifyApp check "sign in and see your team's board" — signing
      in as dana@atlas.test shows the Atlas goals by title and no Beacon goal
      title or id anywhere on the page.
- [x] An owner creates a goal with a title, a target date and a starting
      progress, and it appears on the board.
      Done when: VerifyApp check "owner creates a goal with a target date" —
      the new goal appears on the board with its formatted date and its
      starting percentage.
- [x] A member updates the progress on a goal in their team, and the board and
      the goal's progress log both show it.
      Done when: VerifyApp check "member updates progress on a goal" — saving
      60% on a goal shows 60% on the board and a new row in that goal's log
      naming the member.
- [x] A viewer reads the board and changes nothing.
      Done when: VerifyApp check "viewer is read only" — signed in as
      vera@atlas.test the board has no progress control and no create-goal
      control, and test/permissions.test.ts shows a viewer's write is refused
      and the goal does not move.
- [x] No one can see or touch another team's goals, at any role.
      Done when: VerifyApp check "another team's goal is invisible" — signed in
      as the Atlas owner, /goals/<a Beacon goal id> answers 404 and lists no
      Beacon data; test/isolation.test.ts proves every repository read and write
      is scoped to the caller's team, including for an owner.
- [x] An owner adds a teammate to their team at a chosen role.
      Done when: VerifyApp check "owner adds a teammate" — after adding
      view@atlas.test as a viewer, that person appears on the team page with the
      viewer role and can sign in to see the same board.

## Later (named, not planned)

Per-goal key results instead of one 0–100 field · check-in cadence and nudges ·
comments on a goal · team switcher for people in several teams · cross-team
portfolio rollup for a leadership view · CSV export · password reset by email.
