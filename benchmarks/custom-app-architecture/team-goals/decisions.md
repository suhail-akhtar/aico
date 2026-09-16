# Decisions — Goalboard

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript, so a decision written here survives
a long build.

- Stack: Hono on Node 22, `node:sqlite`, server-rendered HTML, one monolith —
  a team-sized tool, and rendering on the server means another team's rows are
  never serialised into a response at all.
- Isolation is structural: every goal function takes `teamId` first, and the
  team comes from the actor's membership rather than from the request.
- A record belonging to another team answers 404, not 403, so the app never
  confirms that someone else's goal exists. A role refusal is 403.
- Session tokens are stored as SHA-256, passwords as scrypt; the cookie is
  httpOnly + SameSite=Lax, and POSTs are refused when `Origin` names another host.
- One team per person in this iteration: the actor's team is their lowest
  membership id. The schema already allows several; the switcher is Later.
- A top bar rather than a side nav, because there are two destinations; under
  620px it wraps to two rows so the sign-out button is never clipped.
- The seed ships a third team with no goals, so the empty board is a screen you
  can look at rather than one you have to imagine.
- Progress is typed into a number field, not dragged on a slider: the value is
  exact, a keyboard reaches it, and a browser check can drive it.
- Verification note: a browser navigation to a 404 logs a console error that the
  browser tool reports as a defect, so the 404 is proven by
  `test/isolation.test.ts` and the browser proves the visible guarantee instead.
  The same goes for every refusal: a 400 on an invalid form post and a 403 on a
  member's write are asserted in tests, and the browser proves the happy path.
- The board card carries the quick progress update and the goal page carries the
  same form plus the note, so the tenth-visit gesture stays one gesture.
- An invited email that already has an account keeps its own name and password:
  joining a second team must not reset what belongs to that person. The form
  asks for a name and a starting password only when the email is new. Nothing is
  emailed — there is no mail provider — so the owner passes the password on.
- A refusal a person reads is a page, so the role guard lives in `src/guards.ts`
  (`requirePageRole`) rather than in `auth.ts`: `auth.ts` knows about roles, not
  about HTML, and importing a view there would make a cycle.
