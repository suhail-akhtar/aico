# 0038 — Delivery: a task board whose parallel writers each get a worktree, land one at a time, and wait for a person

- **Status:** Accepted
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
