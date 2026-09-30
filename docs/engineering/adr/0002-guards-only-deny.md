# 0002 — Tool-policy guards may only deny, never grant

- **Status:** Accepted (backfilled 2026-09-30)
- **Deciders:** owner
- **Related:** [principles § 3](../principles.md#3-guards-may-only-deny-never-grant); [security.md](../security.md)

## Context

Everything around a tool call — hooks, plan-mode filtering, the bash safety
classifier, the permission prompt — used to live inline in one closure in
`agent.ts`. Adding a timeout, retry, metrics or a loop-breaking guard meant
threading it through that closure, and the order of checks was implicit. With
user hooks, a sandbox and plan mode all able to add stages, a later, more
permissive stage could launder an earlier denial.

## Decision

Tool execution runs through `src/tools/pipeline.ts` as ordered, named stages:
pre-execute (waterfall: hooks, argument rewriting) → **guards** → around
(timeout, retry, metrics) → body → post-execute → normalize. Guards are
**monotonic**: the type is

```ts
export type GuardVerdict =
  | { kind: 'abstain' }
  | { kind: 'deny'; reason: string };
```

There is no `allow`. Registered stages (see `src/agent.ts`): `PreToolUse`
hooks → plan mode → bash safety → permission → body → `PostToolUse`; the
sandbox guard is installed separately (`src/sandbox/guard.ts`). A denied call
still runs post-execute so the repeat guard and metrics see refused calls.

## Alternatives considered

| Option | Why not |
|---|---|
| Allow/deny/abstain verdicts with precedence rules | order becomes security-relevant; one misordered stage opens a hole |
| Keep checks inline in the loop | every cross-cutting concern touches the agent loop |

## Consequences

- **Good:** adding a stage can only make the system stricter; stage order
  cannot open a hole; hooks, sandbox and plan mode compose.
- **Costs:** "allow this despite X" features cannot be a guard — they must
  change the input to an earlier decision (settings, permission mode).
- **Honest limit:** the bash safety guard is pattern-based and the sandbox is
  partial for spawned processes; "only deny" constrains composition, not the
  quality of each guard.

## Verification

The type system: returning `allow` from a guard does not compile. Pipeline
tests in `test-harness.mjs` (`ToolPipeline`, `RepeatToolGuard`).
