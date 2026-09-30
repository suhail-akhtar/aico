# Review

What a change must show before it merges, and how to review one — especially
one written by an AI agent. The PR template (`.github/PULL_REQUEST_TEMPLATE.md`)
is this checklist in short form.

## Definition of done (author)

- [ ] **Works end to end**, verified live with an isolated `AICO_HOME`; what
      you looked at and what you saw is in the PR.
- [ ] **Tests**: a failing-first test for a bug; tests for new behaviour;
      `npm test`, `npm run test:web:unit`, `npm --prefix desktop test` green as
      relevant; paid/live probes run with approval or listed as not run.
- [ ] `npm run typecheck` (and `npm --prefix desktop run typecheck` for desktop) passes.
- [ ] `npm run check:standards` passes.
- [ ] **Docs**: module header updated if the design changed; `AICO.md` if a
      load-bearing contract changed; `GUIDE.md`/README for user-visible
      behaviour; CHANGELOG under `## Unreleased`; ADR if it met a trigger.
- [ ] **Security** questions answered ([security.md](security.md#per-change-security-review)).
- [ ] **No AI attribution** in commits, PR body or docs.
- [ ] **Honest gaps** listed: what was not tested, what is partial.

## Reviewer checklist

**Correctness**
- Does the change do what the PR says — and only that? Unrelated edits are sent back.
- Is the bug reproduced by a test that fails without the fix?
- Edge cases: Windows paths (spaces, `E:` vs `e:`), CRLF, empty/huge inputs,
  concurrent writers, abort mid-operation, restart mid-operation.
- Does anything wait forever? Is every spawned process reaped?

**Contracts** (the expensive ones)
- Session log: new durable state appended as events, never mutated; replay idempotent.
- `onChunk`/`onReasoning` carry accumulated step text — clients replace.
- Prompt rendering stays deterministic; volatile content stays in the tail.
- Pipeline guards still only deny.
- Dependency direction holds ([architecture.md](architecture.md#dependency-direction-must-hold)).
- Persisted formats: old data still loads.

**Enforcement**
- Is any new rule the harness depends on enforced in code, or only asked for
  in a prompt? A prompt-only rule is a change request.

**Security**
- New capability, listener, process, fetch, or secret flow? Threat-modelled?
- Untrusted content cannot change policy; secrets cannot reach log/stream/model.

**Tests**
- Deterministic (no unseeded randomness, no bare sleeps); isolated (`test-home.mjs` first).
- Assertions check the behaviour, not the implementation's incidental shape.
- Would the test fail if the feature were removed? (Delete the fix mentally.)

**Docs and honesty**
- Claims in docs, UI copy and the CHANGELOG are true and scoped ("partial", "self-run").
- No "open source"/"MIT" for AICO; no attribution.

## Reviewing AI-authored diffs

AI diffs fail in characteristic ways. Look specifically for:

- **Confident fiction**: file paths, functions, flags, settings keys or commands
  that do not exist. Grep for each one you do not recognise.
- **Scope creep**: reformatting, renamed variables, "while I was here"
  refactors, rewritten comments in files the task did not need.
- **Tests that test the mock**: assertions that pass whether or not the
  feature works; tests adjusted to match the bug; weakened assertions.
- **Early victory**: "all tests pass" with no command output; "verified" with
  no description of what was looked at; a live step silently skipped.
- **Prompt-only fixes**: a new system-prompt line where the loop should enforce.
- **Duplicated plumbing**: a second store, registry, settings path or IPC
  channel where one exists (the reason the first Electron client died).
- **Swallowed errors**: `catch {}` added to make a failure disappear.
- **Security regressions**: a guard returning allow, a secret in an error
  message, a shell string built from model text, a new listener.
- **Stale reads**: edits based on a version of the file another agent has
  since changed (conflict markers, reverted neighbours' work).
- **Attribution**: trailers or footers the tool added by default.

An AI reviewer's findings are input; approval comes from the owner.
