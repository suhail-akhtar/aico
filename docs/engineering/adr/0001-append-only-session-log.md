# 0001 — A session is an append-only event log; the transcript is derived

- **Status:** Accepted (shipped with the August 2026 rewrite; backfilled 2026-09-30)
- **Deciders:** owner
- **Related:** [`AICO.md`](../../../AICO.md) "Architecture"; [principles § 1](../principles.md#1-the-log-is-the-truth-the-stream-is-a-preview)

## Context

A chat buffer that clients mutate cannot survive the client that started a
run, cannot be replayed after a reconnect, and cannot say exactly what the
model saw. Prompt caching also needs a request prefix that never changes under
a running turn.

## Decision

A session is an append-only list of `SessionEvent`s with a monotonic `seq`
(`src/session/session.ts` `Session.append()` assigns `seq: this.nextSeq++`;
`src/session/events.ts`). The governing invariant is **model-visible means
logged**: anything that reaches a model request is reconstructable from the
log. SURFACE events project into requests; RECORD events are durable facts
that never reach the model directly. The transcript, titles, goals and ratings
are projections. On disk: JSONL at
`aicoHome()/projects/<cwd-hash>/sessions/<id>.events.jsonl`.

On the wire (`src/server/events.ts`), durable events carry `seq` and are
replayed with `?since=`; ephemeral events (`chunk`, `reasoning`, `tool-start`)
are never buffered or replayed. `onChunk`/`onReasoning` carry the text
accumulated within a step; clients REPLACE, never append.

## Alternatives considered

| Option | Why not |
|---|---|
| Mutable message array persisted per turn | cannot replay; loses what the model actually saw; edits break cache prefixes |
| Streaming deltas as the source of truth | replay produces duplicated text ("ThisThis is…"), quadratic growth; happened twice |

## Consequences

- **Good:** runs survive client disconnects; steering and queues are durable;
  every answer can cite what it read; cache hit rates of 79–96% on long runs.
- **Costs:** new state needs a new event type; projections must be written for
  every consumer; persisted format changes need migrations.
- **Known exception:** forking a session writes a `session/title` event at
  `maxSeq + 1` outside `Session.append` (`src/session/persistence.ts`); keep it
  the only one.
- **Known gap:** the same folder can be keyed as `E:\` and `e:\` (two
  `cwd-hash` stores); needs a migration, not yet done.

## Verification

Session invariants (ordering, turn balance, call/result pairing) are asserted
by every test that produces a log (`checkSessionInvariants` in
`test-harness.mjs`). Reversing this decision would break replay tests and the
web E2E reconnect scenarios.
