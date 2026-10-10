# 0038 — Delivery: a task board whose parallel writers each get a worktree, land one at a time, and wait for a person

- **Status:** Accepted; amended 2026-10-10 (what the first real use showed; autonomy levels; board fields)
- **Date:** 2026-10-09
- **Deciders:** owner (+ authors)
- **Supersedes / related:** revises [principle 11](../principles.md#11-read-only-fan-out-one-writer) narrowly; builds on [0001](0001-append-only-session-log.md) (the log is the truth), [0021](0021-background-agents-that-report-back.md) (background agents), [0032](0032-brief-fix-all.md) (branch per agent, a person starts spend), [0033](0033-supply-chain-and-change-safety.md) and [0034](0034-evidence-ci-agent-flaky-tests.md) (change safety, evidence); `src/delivery/`, `src/tools/delivery.ts`, `src/server/delivery-routes.ts`, `src/server/delivery-runner.ts`

## Context

Principle 11 says parallel sub-agents help with read-only breadth and hurt when they coordinate
writes: role-based build teams (planner → implementer → tester → reviewer) cost 3–10× the tokens,
lose context at every handoff, and verification agents pass work they never ran. That finding stands.

What it does not cover is a different shape of parallelism: *independent tasks*. A backlog of ten
tickets is not one task cut into slices; the tickets can be built at the same time by agents that
never need to agree with each other, as long as each one cannot touch what the others are touching
and nothing reaches the trunk without being checked and approved. People already work this way
(a board, a branch per ticket, a merge queue, a reviewer). GitHub's "Building Git infrastructure for
agent-scale development" (2026-10-06) describes what breaks when many agents write to one repository,
and what held up: coordinate only what needs agreement; move maintenance off the critical path;
keep checkpoints local and push only at milestones. Delivery applies those three lessons.

## Decision

**Principle 11 is revised, narrowly.** Parallel *writer* agents are allowed only when all four hold:

1. each works in its **own git worktree on its own branch** (`aico/task-<id>`), never the person's checkout;
2. on an **independent task from a board** — never slices of one task, never roles of one change;
3. a **serial merge queue** lands work **one change at a time**, after rebasing onto the current trunk
   and running the project's checks on the rebased tree;
4. **nothing reaches the trunk without a person's approval** by default. Auto-landing a low-risk
   change that passed its checks is a setting (`autoLandLowRisk`), off by default.

Everything else in principle 11 stands: no planner/implementer/reviewer teams, no sub-slicing one task
across writers, `Investigate` stays the read-only fan-out.

Mechanics:

- **The board is a journal.** One append-only JSONL file per project under
  `aicoHome()/delivery/<project key>/`; the board is its fold (ADR 0001). A restart folds it again;
  a task whose claim's lease expired goes back to `ready`. The dispatcher comes back **paused** after
  a restart: starting spend is a person's act and a restart is not one.
- **Coordinate only what needs agreement.** The only shared decision between tasks is "do they touch
  the same files". Before a task starts, its touches are predicted from the code graph (files and
  symbols named in the task, labels that are paths) and the task waits while they overlap a running
  task's predicted or actual touches. As a run edits, actual touches replace the prediction. Nothing
  else is negotiated.
- **Serial landing, off the agents' critical path.** An agent submits and is done. The queue rebases the
  branch, runs the checks (a tree already green — same tree hash — is not run again), builds the
  evidence report and a risk score, and puts the task in `review`. A conflict or a red check sends the
  task to `changes` and resumes the run with the files or the failure; the agent never merges.
- **Landing is a fast-forward after a clean rebase.** If the trunk moved since review, the branch is
  rebased again and its checks come from the same tree-hash cache or run again; only then does it land.
  A `--no-ff` merge commit of a combination nobody checked is rejected for that reason.
- **Local only.** Branches, commits and the landing stay on the machine. Delivery never pushes.
- **A person for the three acts that matter.** Starting the dispatcher, approving (landing), and
  requesting changes go through the decision gate (`checkHuman`); the API token alone is refused, and
  the desktop mints a grant for them (`HUMAN_ROUTES`). Guards may only deny: the `Delivery` tool cannot
  promote a task to `ready`, cannot land, and a run can submit only the task its worktree belongs to.
- **Hygiene is part of the design.** Merge and cancel remove the worktree and the branch; a cheap
  periodic sweep removes `aico/task-*` worktrees whose task is over or unknown, prunes stale worktree
  records, and lets git run `gc --auto` — only while no run of that project is active, so maintenance
  never competes with a rebase or a check. Work with uncommitted or unmerged content is kept, never
  discarded (the rule of `src/worktree`).
- **A task's run is a chat session.** The server's runner (`server/delivery-runner.ts`) drives the same
  `RunManager.submit` a chat does, in the task's worktree, unattended (L4: what needs a person is parked in
  the approve-later inbox, not run). The task records the chat (`Task.sessionId`, `claim.sessionId`;
  `claim.runId` is the runner's own id and is not a chat), so "Session" opens a real transcript, also after
  the task is done, and the server can find a chat filed under a removed worktree (`sessionDirOf`). The
  fallback runner (a background agent, used where there is no server) has no chat and says so: no
  `sessionId`, and no client links to a run id. Spend and the deadline are enforced by the poll that watches
  the run, not requested in its prompt.
- **Needs you.** While a run is held in a chat the tick reads what it waits for — a question, a permission
  card, a call parked for that session — and journals it on the task (`needs`) with a line on the thread;
  clients draw it and answer through the routes those things already have (`answer`, `permission`,
  `inbox/decide`), so Delivery adds no second way to say yes. The wait is lifted when answered or when the
  run ends. Notifications reuse `pushNotification` (the user's `Notification` hooks) and, on the desktop,
  the renderer's own watcher of `GET /api/delivery/attention`.
- **Batch review.** `approve-batch` lands several tasks with one person-gated request, but only low-risk
  tasks whose checks are green for the tree that would land; the set is refused whole if any member is
  not eligible (the person approved exactly that set). Each lands through the same serial lane, re-checked
  if the trunk moved.
- **Release trains.** A release is a version-bump commit plus an annotated `vX.Y.Z` tag on the trunk, local
  only. The next version is Conventional Commits arithmetic over the commits since the last tag, from the
  higher of that tag and the project's version file; the notes are the merged tasks' titles and evidence
  summaries (`Task.landed` records where each task landed). The commit is made in a throwaway worktree
  (outside the task worktrees, so the sweep never sees it), tagged, then fast-forwarded like a task; a
  refused move removes the tag again. Deploy is a person's act running `delivery.deployCommand` (or an AICO
  app's own deploy script), and rollback is a task of `git revert`s that goes through the normal queue.
  `delivery.deployCommand` and `delivery.worktreeSetup` are commands, so they are **trust-gated** like
  `hooks`: a project file's value applies only after a person approves that exact file.

## Consequences

- A worktree has only the tracked files. Dependencies are prepared per stack (`delivery/env.ts`): Node,
  Python (`.venv`/`venv`) and PHP (`vendor`) get a *link* to the project's folder; an AICO app's own
  `run.install` runs once when nothing could be linked; .NET, Go, Java, Rust and Ruby use user-wide caches
  and need nothing; `delivery.worktreeSetup` covers the rest. **The link's danger and the choice made:** an
  install by a task's agent would write through the link into the person's checkout and into every other
  task. Copy-on-write would avoid it but only some filesystems clone (APFS, btrfs, XFS, ReFS); on NTFS and
  ext4 copying `node_modules` costs hundreds of megabytes and seconds to minutes for every task, including
  the many that never install anything. So the link is the default and a guard *refuses* a package manager's
  install while the folder is still a link, naming the fix; the `Delivery` action `localise` replaces a Node
  link with a private copy (cloned where possible) and, for Python and PHP, whose environments cannot be
  copied, removes the link and says what to run. The cost is paid only by a task that really changes its
  dependencies. Rejected: noticing the write afterwards (it has happened), and linking per package (npm
  replaces links by copying through). Tool caches written under a linked `node_modules` (`.cache`) are
  shared and harmless.
- Landing is `git merge --ff-only` when the project's checkout is on the trunk (so its files update;
  uncommitted changes the merge would overwrite make git refuse and approve says so, nothing is touched), a
  forward-only move of the branch ref when the trunk is checked out nowhere, and a refusal when it is checked
  out in some other worktree.
- Cost is bounded per task by the ledger supervisor (`safetyLimits.maxCostPerSubagent`, default $3) and a
  deadline; `maxParallel` defaults to 2 and is capped at 4.
- Rejected: one shared branch with file locks (the failure GitHub describes); agent-side merging; a
  merge commit on trunk movement; a planner agent that assigns work to implementer agents (principle 11).

## Amendment (2026-10-10): what the first real use showed, and autonomy levels

The board was used for real on a project with ten tasks and a cheap model, and the owner's verdict was
"buggy, not purposeful, not real value". Every item below was reproduced in `scripts/delivery-test.mjs`
(sections "real use 1a" to "real use 4") against the 0.52.0 engine first, then fixed.

### What does not travel, and what a landing does when the checkout is in the way

- **Root cause of "Approve fails: untracked working tree files would be overwritten by merge: .aico/profile.json".**
  A task runs in a worktree, and AICO's own tools write there (the observer's `.aico/profile.json`, local
  settings, screenshots). The run's `git add -A` (the agent's, and the engine's own commit at submit) put them
  in the branch; the person's checkout had its own untracked copy; the fast-forward collided. **Fix:** AICO's
  machine state (`src/delivery/runtime-files.ts`: the profile, `trust.json`, `*.local.*`, screenshots,
  sessions, caches and logs under `.aico/`) is never staged by the engine's commit, is stripped from the branch
  (one commit that removes what the branch added and restores what it changed) before the merge queue and again
  before landing, and is never counted or shown in a task's diff. Team-owned `.aico/` files (settings, skills,
  tools, agents, rules, knowledge) are not touched: a task that edits them is making a real change. The
  profile is the borderline case (it is "committable"); a person who wants it in git commits it from their
  checkout, not as a side effect of a run in a worktree. Rejected: only `info/exclude` (it is repository-wide, so
  it would also hide the profile in the person's own checkout, and it does nothing for an agent that already
  committed the file).
- **Collisions are a decision.** Before a fast-forward into a checked-out trunk the engine lists the paths the
  merge would trip over (`src/delivery/landing.ts`): files the person has untracked that the branch adds, and
  files with uncommitted edits that the branch changes. A copy identical to what the branch brings, or one that
  is AICO's own, is set aside (copied under `<board>/displaced/<task>/...`, then removed) and the landing goes
  on. Anything else stops the landing with `409 {code: "landing-collision", files, choices: ["keep-mine",
  "take-task"]}`, the task stays in review with `landingBlock`, and nothing is touched. `POST
  /api/delivery/tasks/:id/resolve-landing {choice}` (a person) applies the choice: *keep-mine* drops the task's
  change to those files from the branch (re-checked, then landed); *take-task* saves the person's copies aside
  first, then lands. No choice destroys the person's bytes. A dirty checkout that does not overlap lands as before.
- **A task's diff holds only what the agent changed.** Every git call that means "the trunk" uses the full ref
  (`refs/heads/<trunk>`): a bare name resolves to a *tag* of that name first, so a release branch that shares a
  tag's name would have been rebased onto and diffed against the old tag (reproduced: the task is blocked;
  otherwise the diff would have shown everything the branch gained since as deletions). `currentBranch` no longer
  asks for `--short` (git prints `heads/<name>` when a tag shares the name, and that became the trunk). After a
  rebase the engine asserts the trunk's tip is an ancestor of the branch and refuses to review a branch that is
  not, rather than show a diff that includes changes that are not its own. **Not proven:** the owner's specific
  case (53 lines of `src/agents/personas.mjs` shown deleted by a task about tool results) could not be
  reconstructed from the board alone. The ref ambiguity above and the committed runtime files are the defects
  found; the risk score now also says when a change removes many lines from a file with little added back
  ("removes many lines with little added back: ..."), which is what a model that replaces a file with a
  shortened copy looks like, and it names the file to open first.

### Why a Ready task did not start, and what a person can do about it

Tasks whose prerequisites were still in the Backlog never started, silently. Nothing was wrong with the
dispatcher: the dependency rule held, and nothing said so. Now every task carries `blockedBy: [{id, status}]`
and a one-sentence `waitingReason` (dependencies, a file clash with a running task, WIP, budget, a paused
dispatcher, Scrum's active sprint), and the board carries `idleReason` ("2 ready tasks wait for "Add auth" and
"Add db", which are in Backlog."), all derived at read time (`src/delivery/board-view.ts`, pure: the same rules
the dispatcher applies, asked "why not"). `POST /api/delivery/tasks/:id/promote-prerequisites` (a person) moves
the Backlog prerequisites, transitively, to Ready in one call and reports `stuck` ones (blocked or cancelled)
that it will not move. A task moved to Ready before the dispatcher started, or while it was paused, is picked up
on start (tested).

### The Changes count is the diff

The tab's number was `touches.files.length`, a prediction from the code graph for a task that had no branch, so
it said 1 over an empty drawer. `Task.changeCount` is now the number of files in the diff the drawer shows,
from one source (`diffSnapshot`): committed on the branch, plus, while the task runs, uncommitted and new
files (taken with a throwaway index, so the task's own index is never touched), minus AICO's runtime files.
`GET .../diff` returns `{diff, files, live, truncated, note?}`; a merged task's diff is the range that landed; a
task nobody has started is an honest empty diff with a note.

### A task and its chat

The journal records, on every start, the run's chat and the stage the task was in (`Task.sessions`,
`Task.session`); the session API (`GET /api/session`) adds `delivery: {taskId, title, status, project, board,
stage?}` for any chat that is a task's run, in every status, and for the earlier chats of a task that was sent
back. The "Session" link failed because the client names the *board's* project when it opens a chat while the
log is filed under the task's worktree; the server now prefers the task's folder for a task's chat. (The link is
recorded in the board's journal, the record of the task, not as a new session event: a new event type would reach
every reducer of the session log for a fact only the board needs.)

### Visibility

`Task.live` is the run's current step (`src/delivery/activity.ts`, read from the session log: the last tool
call and its target, in the present tense until it has a result, plus tokens), held in memory and pushed on the
board stream; it is never journaled per step. The history is the journal: a bounded line per milestone (started,
edits coalesced to one per 20 seconds, check runs, commits, submitted, review, needs you, landed, failed,
promoted, pulled), 200 per task (the board carries the latest 30; `GET .../activity` has all 200) and a
100-line board feed. The model is never asked what it is doing.

### Autonomy levels

`settings.autonomy` is a ceiling on what the engine does without a person. Default `manual` (exactly the board
as it was). Each level adds to the one before; `src/delivery/autonomy.ts` is the whole rule and is tested as a
matrix (240 combinations) against an independently written table.

| Level | The board also does |
|---|---|
| `manual` | nothing: a person moves tasks to Ready and approves every landing |
| `assisted` | starts the Backlog prerequisites of Ready tasks; lands LOW-risk work whose checks are green |
| `autonomous` | pulls the next Backlog tasks into Ready when a slot is free (highest rank, then priority; prerequisites merged; the active sprint in Scrum; no file clash); lands LOW and MEDIUM |
| `full` | lands HIGH too, when every gate is green and the organisation's policy allows it |

**What never changes with the level.** A possible secret in the added lines, a weakened test, a high-severity
code finding, or a safety scan that did not run keeps a change away from every automatic landing, `full`
included: those are findings, not points on a score that a bigger budget can outvote. Pull-request mode never
lands automatically (the remote's rules and a person decide the merge; nothing here pushes, and no level
bypasses a protected branch). The actions of every level happen only while the dispatcher is running: a person
started it, and pausing is the kill switch (one call, only the token). Raising the level, the daily budget,
`maxParallel` or the failure threshold needs a person (`PATCH /api/delivery/settings`, `human()`); lowering needs
only the token. Starting the dispatcher already needed a person, so no level begins spending without one.

**Hard limits, enforced in the tick, not requested of a model.** The daily budget (`budgetUsdPerDay`, default
$10, summed from the cost increases in the journal over the local day) pauses the dispatcher and stops the runs
in flight, with the figures in `pausedBecause`; a task's spend is the *sum* of its runs and a task that used its
allowance is not started again (previously the larger of its runs was kept, which undercounted every rework);
`pauseAfterFailures` (default 3) consecutive runs that failed or were sent back by the engine pause the
dispatcher with the count and the limit; `maxParallel` is capped at 4; `wip.running` lowers the parallelism and
`wip.review` stops new starts while that many changes await a person (counting those still being checked). A
pause lasts until a person starts the dispatcher; a restart pauses too, and says so.

**Every automatic act is recorded** with who decided and why: `Task.landed.decision {autonomy, risk, score,
evidence, reason}`, a `landed` line in the task's history (and the feed), and an audit-log event of kind
`delivery` (`auto-land`, `auto-start`, `auto-promote`, `auto-pause`, `autonomy.set`) with `decidedBy:
engine:<level>` or `person`.

**Organisation ceiling.** Managed policy (`policy/managed.ts`) gains `delivery.maxAutonomy`, restrict-only like
every key: the lowest layer wins, an invalid value is `manual`, a lockdown is `manual`. With a managed policy in
force and the key absent the ceiling is `autonomous`: an organisation must name `full` to allow it. The ceiling
is applied where the level is used (`BoardState.autonomy` is the effective level, `settings.autonomy` what was
chosen, `autonomyCap` the ceiling), so lowering the policy lowers a running board at the next tick, and the
engine refuses to *set* a level above it even for a person.

**Honest limits of this trust model.** The risk score is a heuristic and its inputs are the engine's analyses
(code graph, test-tamper comparison, the secret and code rules on added lines); a flaw they cannot see lands at
`autonomous` and `full` without a person. The checks that gate a landing are the project's own: a project with
none gets "no checks defined", which counts as *green* (the evidence says so, and the risk score stays). The
daily budget is an estimate from the provider's token counts and the configured prices; an unpriced model has no
figure and no ceiling. `full` is for projects where the checks are trusted and the trunk is recoverable (every
landing is a normal commit that a release rollback can revert). The levels are not a substitute for branch
protection on a remote. One more gap, left as it was: a task can be moved to Ready with only the API token
(`PATCH /api/delivery/tasks/:id`), as before; the dispatcher still needs a person to start, and so does every
level above `manual`.

### A board you can run a team from

`Task` gains `assignee` (a person, or the agent slot "Agent A".."Agent D" given when a run starts and kept
afterwards), `rank`, `dueDate`, `type`, `parentId` (an epic, one level; it shows `children` and merges itself
when all its children have; the dispatcher never runs an epic as a task), `blockedBy`, `waitingReason`, `live`,
`changeCount`, `session`/`sessions`, `activity`, `landingBlock`. `rank` is `priority * 1,000,000 + n` for a new
task, so an untouched board runs most-urgent first, and a reorder (`POST /api/delivery/tasks/reorder {status,
ids}`) swaps the ranks the dragged cards already hold; the dispatcher starts by rank, then priority. The board
gains `idleReason`, `autonomy`, `autonomyCap`, `pausedBecause`, `metrics` (median cycle time from the first run,
median lead time from creation, throughput over 7 days, `wipNow`, ageing per column, today's spend), `agents` and
`feed`; its settings gain `wip`, `budgetUsdPerDay`, `pauseAfterFailures`, `views` (saved filters, per project).
`PATCH /api/delivery/tasks/bulk {ids, patch}` applies one patch through `updateTask` task by task and names what
it refused; `POST /api/delivery/tasks/:id/duplicate`; creation accepts `quick: true` to read the title as
"Fix login !1 #auth @sam due:2026-10-20 type:bug" (`shared/delivery/quickadd.ts`, so a client can preview it).
Deviations from the contract the clients were given: `activity` on the board's task carries the latest 30 lines
(the full 200 are one call away); `children`, `waitingReason`, `sessions` and `landingBlock` are additions.
