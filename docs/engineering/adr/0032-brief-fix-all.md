# 0032 — Fix all: the morning brief may start one confirmed background fix per project

- **Status:** Accepted (2026-10-06)
- **Date:** 2026-10-06
- **Deciders:** owner (asked for grouped advisories and a "Fix all" per advisory, per project and for the whole section, confirmed first, on branches, with per-project results)
- **Supersedes / related:** the brief's "never acts" rule (`src/brief/service.ts`, `src/brief/core.ts`) — this is its one exception; [0015](0015-sentinel-reviewer.md) and [0027](0027-shell-confinement.md) (the guards the started agents still run under); `src/server/decision-gate.ts` (`checkHuman`)

## Context

The brief listed one row per advisory per project, so fixing the same
`source-map-js` advisory in five projects meant five chats. The brief had never
started anything: its actions were links and a prefilled prompt. Starting
unattended, paid work that edits files is a new permission, and the model can
`curl` the loopback port, so the API token alone must not be enough.

## Decision

1. `POST /api/brief/fix-plan { keys }` is a read: it returns what would run.
   `POST /api/brief/fix-all { keys }` starts it and **needs a person**
   (`human()`; `/api/brief/fix-all` is in the desktop's `HUMAN_ROUTES`).
2. The client sends **item keys only**. The engine builds every prompt, path
   and branch from the stored brief, so nothing a request, page or tool result
   says reaches an agent that runs with permissions.
3. The engine, not the agent, creates the branch (`git switch -c
   fix/advisory-<id>` or `fix/advisories-<date>`, numbered if taken) before the
   agent starts: "never on the default branch" holds by construction. A project
   with uncommitted changes, not a git repository, or not a known workspace is
   skipped and reported, never touched.
4. One `spawnBackgroundAgent` per project via `fixAgentOptions`: the ordinary
   auto-approve mode (`permissions: 'inherit'`, `autoApprove: true`), unattended
   with the approve-later inbox (autonomy **L4**, which is the level that parks;
   L3 would refuse instead), and the Sentinel pinned to `onEscalate: 'ask'` so a
   person's own full-autonomy setting cannot apply. **Not** `permissions: 'full'`.
   A Sentinel escalation or a shell-confinement request (write outside the
   project, download, global install) is therefore never approved on the agent's
   behalf: it is parked in "Waiting for you" when the inbox can replay it
   (custom tools) and otherwise refused with a notification and a line in the
   agent's report. The confirmation dialog says "anything unusual waits for you".
   Budget: ledger policy of `brief.fixBudgetUsd` (default $2), 30 minute
   deadline, `onBreach: stop`. Failures are per project.
5. At most 8 projects per run. The agents never push or open a pull request.

## Consequences

- Branch switching happens in the person's checkout (not a worktree): a
  worktree has no `node_modules`, so the tests the agent must run would fail.
  The plan says so before anything happens.
- Shell calls are not replayable from the inbox (only custom tools are), so a
  stopped shell step is refused and reported rather than parked; the person
  re-runs it themselves. Revisit if the inbox learns to replay shell calls.
- Rejected: one chat covering every project (one failure stops all, one
  context for unrelated repositories); auto-starting from the scheduled brief.
