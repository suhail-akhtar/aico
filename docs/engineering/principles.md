# Principles

The design philosophy AICO is built on. Each principle names the evidence
behind it; each is applied somewhere you can read. When a new situation is not
covered by a rule, reason from these.

## 1. The log is the truth; the stream is a preview

A session is an append-only event log with monotonic sequence numbers
(`src/session/session.ts`, `src/session/events.ts`). Turns, steps, tool calls,
results, titles, goals and ratings are durable events; the transcript is
*derived*. Ephemeral events (`chunk`, `reasoning`, `tool-start`) are never
replayed. Clients key finalized messages by `seq` so replay is idempotent.

*Why:* it is what lets a run survive the client that started it, makes prompt
caching work (the prefix never changes under a turn), and makes every answer
auditable. *Apply it:* new durable state is a new event type, never a mutation
of an old event; a projection derives from events. See [ADR 0001](adr/0001-append-only-session-log.md).

The single most expensive contract to misread: `onChunk`/`onReasoning` send
the text **accumulated within a step**, not deltas. Clients REPLACE, never
append. It has been got wrong twice.

## 2. Enforce in the loop, not in the prompt

A behaviour the harness depends on is checked in code — the tool layer, the
agent loop, a gate — never merely requested in the system prompt. A prompt
rule is a request; the model declines it exactly when it is most confident,
which is the case the rule existed for.

*Evidence:* "read a file before editing it" was a prompt line and failed in
practice; it moved into the write path (`src/tools/observation.ts`). "Call
ProposePlan once and stop" was a prompt line; a model proposed three plans and
then tried to write in a mode with no write tools; the loop now ends the turn
on the first plan. *Apply it:* when adding a rule, ask where it is checked. If
the answer is "the model will follow the instruction", it is not implemented.
Prompt text tells the model what the enforced rule *is* so its first attempt is
not wasted — it is not the rule.

This applies to contributors too: the engineering rules that can be checked
are checked (`scripts/check-standards.mjs`, git hooks, CI).

## 3. Guards may only deny, never grant

Tool policy runs as ordered named stages — `PreToolUse` hooks, plan mode, bash
safety, sandbox, permission (`src/agent.ts`, `src/tools/pipeline.ts`). A
`GuardVerdict` is `abstain | deny`; there is no `allow`. Adding a stage can
therefore only make the system safer, and stage order cannot open a hole. See
[ADR 0002](adr/0002-guards-only-deny.md).

## 4. Honest scope

Say exactly what a mechanism enforces and what it does not. `sandbox.mode`
governs AICO's own file tools completely and spawned processes not at all, and
the tool reports enforcement as `full` or `partial`. Benchmarks are labelled
self-run. Cost figures carry two distinct "estimated" flags (unknown price vs
unmeasured usage). Unknown model capabilities mean text-only, on purpose.

*Apply it:* never imply a guarantee the code does not give — in docs, UI copy,
tool results, commit messages or reports. An honest "partial" is worth more
than an implied "full".

## 5. The desktop app is a client, not a fork

The desktop runs the engine's own `serve()` in an Electron utilityProcess and
reuses the web client's store and the shared renderers. The first Electron
client died because it duplicated engine plumbing (its own store, settings and
IPC). *Apply it:* a feature that affects runs, sessions, settings, skills, MCP
or cron goes in the engine and reaches every client; desktop-only code is
window, tray, browser, IDE tools and plugins. See [ADR 0003](adr/0003-desktop-is-a-client.md).

## 6. Everything volatile lives in the tail

Providers render `tools → system → messages`; churn in the system block
invalidates the cache prefix of every message behind it. Git status, the date,
running work and triggered knowledge ride after the transcript. Prompt
rendering is deterministic. *Evidence:* 79–96% cache hit rates on long runs.
*Apply it:* never put per-turn data in the system prompt; never make prompt
rendering order- or whitespace-unstable.

## 7. Conservative when unknown

A model with unknown capabilities is text-only. A price matched by prefix on a
custom endpoint is an estimate, not a fact. A context window discovered from a
catalogue never overwrites a human's correction. `aico mcp-serve` work is
read-only unless explicitly started with `--allow-writes` — consent to act on
your own behalf is not consent for an unattended process.

## 8. Build the whole flow, not the visible piece

A plan panel that records a decision without changing the mode is the feature
not working, not a polish gap. A verification that scores keywords is not
verification — `VerifyApp` opens the artifact in a real browser. *Apply it:*
definition of done is "a user can do the thing end to end", proven live.

## 9. Isolation from the user's real data

Every test and probe gets its own store (`scripts/lib/test-home.mjs` →
`AICO_HOME`); `aicoHome()` is the only place the store path is computed. Before
this, a thousand test projects appeared in the owner's sidebar. The real
`~/.aico` also holds live client reproductions — never disturb it.

## 10. Fewer, sharper rules

"Prefer sharpening a prompt bullet to adding one. Every rule can be expanded
into a doctrine, and the sum of those doctrines is a timid agent." The same
holds for these standards: a rule earns its place with evidence, and a rule
that can be checked by a machine should be.

## 11. Read-only fan-out, one writer

Parallel sub-agents help with breadth-first, read-only work (search, review,
audit) and hurt when they coordinate writes. Role-based build teams (planner →
implementer → tester → reviewer) are the documented anti-pattern: 3–10× the
tokens, lost context at handoffs, and verification agents that pass work they
never ran. `Investigate` is the shape that works. *Apply it* to AICO's features
and to how AI agents work on AICO ([ai-contributors.md](ai-contributors.md)).

## 12. Record decisions where they govern

Design decisions live in module headers next to the code, and the big ones in
[ADRs](adr/README.md). This codebase records what it rejected and why (e.g.
`shared/host-tools.ts` on why there is no terminal bridge). Respect a recorded
rejection unless the owner reopens it; reopening means writing down what changed.
