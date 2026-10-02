# 0014 — Long jobs: work over a few hours runs only with a person's yes

- **Status:** Accepted (2026-10-03)
- **Deciders:** owner ("long-run mode is NOT the default … when AICO estimates a job will take more than ~3–4 hours, it MUST stop and get the user's explicit confirmation first")
- **Related:** [ADR 0002](0002-guards-only-deny.md) (guards only deny), [ADR 0011](0011-approve-later-inbox.md) (a person's yes, never the token), [ADR 0001](0001-append-only-session-log.md)

## Context

Every turn is bounded (`maxIterations`, the session cost breaker), which is
right for normal work and wrong for a job of days: it either stops halfway or
someone raises the limits for everything. Raising them silently for big
requests would let the model decide, alone, to spend hours and dollars. The
owner wants the opposite: normal work unchanged; a big job stops first and
asks, with the research, design, milestones and acceptance criteria, time,
cost and a cap; and once approved it runs to done, verified, or to the cap.

## Decision

1. **Sizing reuses `ProposePlan`.** It gains `estimate_hours`, `long_job`
   (research, design, cost, budget) and per-step `acceptance`. At or below
   `longJobs.thresholdHours` (default 3) nothing changes. Above it the plan
   is recorded as a **proposal** (`src/longjob/`), the loop ends the turn on
   it in any mode, and a deny-only guard (`long-job`, agent.ts) refuses every
   tool that is not read-only — Bash included — while it is pending. An
   incomplete proposal blocks the same way and cannot be approved; a smaller
   re-estimate does not clear it.
2. **Only a person approves** — `longjob/decide` and resuming via
   `longjob/control` ask the decision gate's `checkHuman` (desktop grant, UI
   key or live client nonce). The API token alone is refused, the agent's
   shell cannot call the routes, and a chat message is not an answer.
   Declining, pausing and stopping need no proof.
3. **A journal, not a mode.** One append-only JSONL per job under
   `aicoHome()/long-jobs/<project>/` (proposal, status, milestone, decision,
   turn events), read fresh. The ledger gets a mirror row (kind `run`) for the
   Activity page and its Stop; on restart the server resumes `running` jobs
   from the journal (the ledger marks its rows lost, so it cannot be the record).
4. **Across turns.** When a turn of the session ends, `afterTurn` records its
   spend and time and either queues the next turn (current milestone and its
   criteria) or settles the job: done, stopped at budget, paused (cancelled,
   failed, or four turns with no milestone closed). Inside a turn the
   session cost breaker is set to the remaining budget.
5. **Milestones close only through `LongJob`** (offered only while the
   session has an approved job): it runs the project's checks and requires
   `checkProjectGate` green and one piece of evidence per criterion. The job
   is done when its last milestone closes; a report is written from the
   journal.
6. Sub-agents inside an approved job may run up to `longJobs.subAgentMaxMinutes`
   (default 60); elsewhere `task.ts` keeps its own ceilings.

## Consequences

- Always-sent cost: the ProposePlan schema grows by about 165 tokens (measured);
  `LongJob` is never sent to an ordinary session.
- Sizing is the model's estimate. A model that never calls ProposePlan for a
  big request is not gated — the gate is enforced once an estimate exists,
  not guessed from the request text.
- Acceptance evidence is the model's statement; what code verifies is that
  every criterion has some and that the checks pass.
- The time cap is agent working time, checked between turns. Destructive
  steps still go through ordinary approvals and the inbox: approving a job
  approves its plan, not its tool calls.

## Rejected

- A separate planner/agent team for long jobs (principle 11: role teams are
  the anti-pattern). A new approval surface (the decision gate exists). A
  "long-run mode" toggle (the owner: not a default, decided by size).
