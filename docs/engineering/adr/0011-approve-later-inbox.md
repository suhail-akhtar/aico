# 0011 — The approve-later inbox: unattended runs park calls that need a person

- **Status:** Accepted (2026-10-02)
- **Deciders:** owner (design [agents-skills-tools.md](../design/agents-skills-tools.md) Q9, owner decisions §12a: "build the approve-later inbox (Phase 7)")
- **Related:** [ADR 0002](0002-guards-only-deny.md) (guards only deny), [ADR 0009](0009-custom-tools.md) (effect classes and previews), [ADR 0001](0001-append-only-session-log.md) (the session log)

## Context

Until now an unattended run — a cron job, a background agent, work admitted
over `aico mcp-serve` — that reached a call needing a person (a destructive
custom tool, an external one on first use) could only refuse it. The
scenario that motivates the design (S1: a nightly deploy job) then produces
nothing useful at night and nobody can act on its one blocked step in the
morning without re-running the whole job. "Unattended never does
destructive, full stop" stays true; what was missing is *approve later*.

## Decision

1. **An autonomy scale, L0–L4** (`src/autonomy/levels.ts`, design §4.2). It
   maps onto plan mode and the three approval modes both ways (plan → L0,
   ask → L1, edits → L2, auto → L3), so nothing stored changes meaning; L4
   is "unattended". The effective level is min(requested, the agent's
   `autonomy` ceiling, the delegating run's level) and travels on the run
   context, so a child can never raise it. Schedules default to L4 (`full`)
   and may say `L3`; background agents with `full` (or `inherit` under
   auto-approve) are L4; `readonly` never parks. A server turn may send
   `autonomy` instead of `approval`/`planMode`.
2. **Parking** (`src/custom-tools/policy.ts`, deny-only stage
   `custom-tool:approval`). At L4, a custom-tool call the effect-class matrix
   would ask about is not asked and not run. Its exact arguments, rendered
   call (secrets by name), preview output and three hashes — arguments,
   preview, and *context* (the tool's and its preview's definition files, the
   directory, the scope) — are written to the inbox, and the call is denied
   with a result telling the model it is parked, has not run, must not be
   worked around, and that it should finish everything else. The guard still
   only denies.
3. **The inbox store** (`src/autonomy/inbox.ts`): append-only JSONL at
   `aicoHome()/inbox/actions.jsonl` — a `park` event per call, a `status`
   event per change (approved, executed, failed, diverged, denied, expired)
   with time, channel and outcome. It is the state and the audit trail;
   nothing is rewritten. Default expiry 24 hours; at most 200 pending.
   Arguments are stored only if the redactor leaves them unchanged.
4. **Approving** needs a person: `POST /api/inbox/decide` asks the decision
   gate's `checkHuman` (desktop window grant via `HUMAN_ROUTES`, web UI key or
   live client nonce); the API token alone is refused, and the agent's shell
   guard names the route. Denying needs no proof. The engine then refuses if
   the action expired, the context hash or argument hash changed, or the
   re-run preview's hash differs (**diverged**, with the new preview shown);
   otherwise it executes the call through a small pipeline whose guards
   re-validate the arguments and spend a single-use grant bound to the
   argument hash. One approval runs one call, once.
5. **Delivery**: the outcome goes to the session the call came from through
   the watchers' wake path as a *follow-up* (an existing, logged inbox
   message, never a steer — it waits for the next turn), and to the
   notification tray. Web and desktop show a "Waiting for you" page; the
   desktop raises a native notification for each newly parked call.

## Alternatives considered

| Option | Why not |
|---|---|
| A work-ledger item kind `approval` (the design's first sketch) | The ledger reconciles every non-process record to `lost` on restart (an in-process agent cannot survive one) and streams its rows to every client; a parked call must outlive restarts and carries the full call and preview. A separate append-only store keeps both properties and leaves the ledger's reconcile rule intact. |
| A new session event type for the injected result | The session inbox's follow-up message already is a durable, logged injection with a source; a second event type would be a format change for no new capability. |
| Pause the LLM turn until approved | There is no pause for a provider stream (work-ledger decision); a run that waits hours for a person would hold the job and its budget open. |
| Re-ask the model to redo the step after approval | Not exact: the approved call is what runs, and a model may produce a different one. |
| Approve by token, as `/api/permission` once did | The model may know the token (credential-broker threat model); an approval it can give itself is decorative. |

## Consequences

- **Good:** a nightly job does everything it can and leaves the one irreversible step, with its diff, for a person; approving runs exactly that, or refuses when the world moved.
- **Costs:** one new file in the user's store; a schema change for cron jobs (`autonomy`, optional); polling in two clients.
- **Honest limits:**
  - Only custom tools park. Built-ins have no effect classes yet (Phase 2 deferred their table) and run at L4 as at L3; MCP tools follow the session's approval mode; the ops tools keep the credential broker's own approvals (refused unattended).
  - The L4 **certification** gate needs Phase 4's certificates, which do not exist; `effectiveLevel({ certified: false })` caps L4 at L3 for the caller that will have one.
  - Replay runs the custom tool's own guards (arguments, grant) and redaction, not the original run's whole pipeline (its hooks and scope belonged to a run that has ended).
  - The store is a file the user's processes can edit; an edited call is refused (argument hash), but the file is not a sandbox — the same limit as the enable records (ADR 0009).
  - A session that is not open in this server process does not receive the follow-up; the outcome stays on the inbox record and in the tray.
- **Migration:** none. Existing modes map onto the scale; existing cron jobs default to L4 — a destructive custom tool there now parks instead of being refused.

## Verification

`scripts/phase7-autonomy-test.mjs` (part of `npm test`): recording with the
exact call and preview, below-L4 refusal, exact single replay under a double
approval, preview divergence, definition and stored-call divergence, deny and
expiry, the person-only route and shell guard, secret arguments refused,
delivery into the originating session, and the audit sequence. Web:
`test:web:unit` (`web/src/inbox.ts`).
