# Architecture Decision Records

An ADR records a decision that is expensive to reverse: what was decided, in
what context, what else was considered, and what it costs. They exist so a
future author — human or AI — does not re-derive, or quietly undo, a decision
whose reasons they never saw.

## When to write one

Before implementing a change that: adds a runtime dependency, listener,
process or agent capability; changes a persisted format or a wire contract
(session events, HTTP/SSE, MCP tools, desktop IPC, settings schema); changes a
security boundary; or reverses a recorded decision. Details:
[lifecycle.md § design](../lifecycle.md#2-design--adr). Smaller decisions live
in the module header of the code they govern.

## How

1. Copy [0000-template.md](0000-template.md) to `NNNN-short-title.md` (next number).
2. Status `Proposed`; fill every section; include a threat model if it touches a boundary.
3. The owner accepts (status `Accepted`, date) or rejects (`Rejected`, kept for the record).
4. ADRs are not edited after acceptance except for status and links; a
   changed decision is a new ADR that `Supersedes` the old one.
5. Cite the code that enforces the decision, so a reader can verify it still holds.

## Index

| # | Decision | Status |
|---|---|---|
| [0001](0001-append-only-session-log.md) | A session is an append-only event log; the transcript is derived | Accepted |
| [0002](0002-guards-only-deny.md) | Tool-policy guards may only deny, never grant | Accepted |
| [0003](0003-desktop-is-a-client.md) | The desktop app is a client of the engine, not a fork | Accepted |
| [0004](0004-licence-polyform-noncommercial.md) | Licence: PolyForm Noncommercial 1.0.0 from 0.28.0 | Accepted |
| [0005](0005-browser-agent-safety-model.md) | Browser agent safety: hand off human checks, never see or fill secrets, approvals | Accepted |
| [0006](0006-credential-broker.md) | Credential broker: agents use credentials, never read them | Accepted |
| [0007](0007-ops-tools-and-dependencies.md) | Operate remote machines through trusted consumer tools (SSH via ssh2, HTTP, WinRM via PowerShell, SNMP via net-snmp) | Accepted |

ADRs 0001–0005 record decisions made and shipped before ADRs existed
(backfilled 2026-09-30 from the code, module headers, CHANGELOG and release notes).
