# Custom-stack architecture probe — 2026-09-16

**4 of 5 genuinely ambiguous, greenfield briefs built cleanly (17/17 checks
each); the fifth built 60% of its backlog before hitting a real iteration
limit** — no template, no pre-chosen stack, no worked feature to copy. Model
`deepseek-v4-flash`.

## Why this probe, separate from SWE-bench

The [SWE-bench Lite probe](../swebench-lite/README.md) (73/80, 91%) proves
AICO can fix real bugs in existing codebases. That is bounded, well-specified
work — the fix is usually a few lines, and "correct" is defined by a hidden
test suite. It does not touch the other half of "true software engineer":
**deciding** what to build before building it — the data model, the stack,
the permission boundaries, the concurrency model — when nothing hands you
the answer.

That decision-making is exactly what `app-architecture` does, and it was
this project's own documented weak point (62% on its synthetic eval corpus,
dropping to 30-44% on the harder cross-stack/cross-cutting cases, fixed to
~77% mean in a prior commit on this branch's history — see
`src/skills/builtin/app-architecture/SKILL.md`'s git log). This is that fix
tested against real, live, end-to-end builds instead of a synthetic corpus.

## The five briefs

Deliberately under-specified the way a real stakeholder request is, and in
domains distinct from this repo's own 9 app templates. Each forces a real
architectural decision a template would have pre-made:

| Brief | Forces a decision about |
|---|---|
| **Goalboard** — team goal tracking | Multi-tenant permission boundaries (owner/member/viewer), data isolation |
| **VenueSlot** — event venue scheduling | Overlapping-interval logic (setup/teardown blocking) |
| **StockCup** — café inventory | A cascading relational model (ingredients → recipes → sales) |
| **Stickyboard** — shared note board | A "feels live" requirement with no mechanism named at all |
| **DaysOff** — time-off approval | A manager/report workflow with real state (pending → approved/denied) |

Created via AICO's `apps/create --custom` path (`createCustomApp` in
`src/apps/templates.ts`) — "stack not yet chosen," nothing but a
`.gitignore` and an empty `decisions.md` to start from.

## Results

| Brief | Checks | Backlog | Cost |
|---|---|---|---|
| Goalboard (team-goals) | 17/17 | 6/6 | $0.14 |
| VenueSlot (venue-scheduling) | 17/17 | 5/5 | $0.10 |
| StockCup (cafe-inventory) | — (turn ended: iteration cap) | 3/5 | $0.10 |
| Stickyboard (note-board) | 17/17 | 5/5 | $0.07 |
| DaysOff (timeoff) | 17/17 | 5/5 | $0.10 |

Each pass includes: the agent choosing and justifying a stack in `docs/PRD.md`,
the app's own typecheck/lint/test all green, no placeholder copy in the
source, the app actually serving, a real browser opening it with zero
console errors, and no horizontal scroll at both 1280px and 390px.

**StockCup is a real, honest partial failure, not swept under the rug.**
Turn 1 hit AICO's 100-iteration hard cap at 3 of 5 stories done. Checked the
tool-call distribution before calling this a bug (48 Edits, 31 Writes, 27
Bash, 10 RunChecks, 13 VerifyApp, no single tool dominating suspiciously) —
this looks like genuine extra complexity in the cascading ingredient
deduction, not a stuck loop. Left as a real finding rather than retried with
a raised cap until it passed, which would have laundered the result.

## Verified, not just trusted

Three of the four full passes were spot-checked directly in the generated
source, the same way the SWE-bench probe's results were checked against real
test output rather than the harness's aggregate alone:

- **Goalboard**: every goal query is scoped by `team_id`, including
  `WHERE id = ? AND team_id = ?` on the update path — a defense against
  guessing another team's goal id, not just filtering the list view. The
  schema comment in `db.ts` says why: `team_id` is `NOT NULL` "on purpose: a
  goal belonging to no team would be a goal [leaked]..."
- **VenueSlot**: the overlap rule is implemented by pre-expanding each
  booking's window to include setup/teardown, then reducing "does this
  conflict" to a plain interval-overlap comparison — factored into one
  shared, testable function specifically so the check stays simple.
- **DaysOff**: `manager_id` is a self-referencing FK on `employees`; the
  pending-requests-for-a-manager query is
  `WHERE e.manager_id = ? AND r.status = 'pending'` — exactly the brief's
  requirement, not a superset filtered client-side.
- **Stickyboard**'s PRD reasoning for the deliberately unnamed "no manual
  refresh" requirement independently arrived at Server-Sent Events over
  WebSockets or polling, with a real argument for each rejection (a client
  that only *reads* pushes has no use for a duplex socket; polling makes
  freshness a function of an interval and costs the database on every idle
  tab) — and proactively flagged in its own "Open questions" that the
  single-process fan-out is the wrong trade for a multi-tenant product,
  which is an honest, correct limitation to name unprompted.

## Caveats

- **n=5 briefs, one model.** Real signal, not a large sample — the SWE-bench
  probe's statistical caution applies here even more, since there is no
  external grading harness for "is this architecture good," only the
  checks this repo's own scripts run and the spot-checks above.
- **The author picked the briefs.** No one else vetted them for fairness or
  difficulty; they were deliberately written to be hard (multi-tenancy,
  interval logic, cascading relations, an unnamed live-update mechanism,
  role-scoped workflow state) rather than sampled from a public corpus the
  way SWE-bench instances are.
- **This is a different kind of evidence than SWE-bench's.** There is no
  hidden test suite defining "correct" the way `FAIL_TO_PASS` does — passing
  here means the agent's own checks ran clean and a human (the spot-checks
  above) agreed the resulting code was actually right, which is closer to a
  code review than a benchmark.

## Reproduce

```
node scripts/apps-build-custom-live.mjs --model deepseek-v4-flash --brief team-goals --turns 4
# --brief: team-goals | venue-scheduling | cafe-inventory | note-board | timeoff
```
