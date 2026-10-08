# 0034 — Change evidence report, a CI agent for GitHub, and flaky-test detection

- **Status:** Accepted (2026-10-08)
- **Date:** 2026-10-08
- **Deciders:** owner (asked for the three together: a reviewer-grade record of what a change was checked against, a way to run AICO in a pipeline, and an end to "it passed on the second try")
- **Supersedes / related:** [0001](0001-append-only-session-log.md) (the log is the truth; this adds two record events), [0002](0002-guards-only-deny.md), [0026](0026-shift-left-security.md) (the `security` check this reports), [0028](0028-code-graph.md) (impact in a review), [0032](0032-brief-fix-all.md) (branch by construction, never the default branch); `src/checks.ts`, `src/tools/run-checks.ts`, `src/test-results.ts`

## Context

Three gaps, one theme: *"it works" should be a fact someone can check, not a
sentence in a final message.*

1. **No reviewer-facing record.** The log already holds everything a reviewer
   would ask about a change (what was run, what failed, what a person allowed),
   but only as a transcript. A pull request description written by the model
   from memory says what the model remembers, which is exactly the claim a
   reviewer cannot trust. Two facts a reviewer wants were not in the log at all:
   a check's *exit code and structured counts* (only prose in a tool result) and
   *whether a person approved a tool call* (an answer at a prompt left no event).
2. **No way to run AICO in a pipeline.** `aico -p` exists but is not shaped for
   CI: it auto-approves nothing, has no read-only mode, no budget flag, and no
   output a workflow can post. A reviewer bot that can write files, or a fix
   agent that can push to the default branch, would be a new attack surface
   rather than a feature.
3. **A flaky test is reported as a failure, or worse as green.** `RunChecks`
   stops at the first failing check and tells the model to fix it. A test that
   fails once for timing reasons sends the model hunting for a bug that is not
   there; a model that re-runs "until green" and says "passed" has hidden the
   flake from the person. Both are the same defect: the run did not say what
   happened.

## Decision

### 1. The change packet (evidence report)

A pure function over the session log plus git: `buildEvidence(events, git)` in
`src/evidence/packet.ts`, rendered by `src/evidence/render.ts` as Markdown or
JSON. It states **only what the log proves**; anything with no record is shown
as *not run* / *no record*, never inferred.

| Section | Source |
|---|---|
| Goal | first human `user/message` (clipped), or the last `goal/set` |
| Files changed (+/-) | `git diff --numstat` against a base (default: merge-base with the default branch, else `HEAD`), plus untracked files; if git is unavailable the files written per `tool/call` arguments, labelled "from the log, no counts" |
| Checks run | `check/run` events (new): name, command, exit code, duration, pass/fail, test counts, flaky tests. A check the project defines that has no `check/run` is listed *not run* when the project's checks are known |
| VerifyApp | `tool/call` + `tool/result` for `VerifyApp` (verdict text, first lines — what was seen) |
| Scans and findings | `check/run` named `security`, `DependencyAudit` results, and findings recorded by the diff-scan gates (read tolerantly: an absent record is "not run") |
| Approvals / denials | `tool/decision` events (new): `approved` by a person, `denied` by a person or by policy (guard name/reason) |
| Models and cost | `request/header` models; cost estimated from `assistant/message.usage` with `costFor` (`src/tokens.ts`), labelled *estimated* |
| Open todos / gaps | the last `TodoWrite` state; checks failing at the end; `agent/done` with `failed`/`cancelled` |

Surfaces, all one function: the `Evidence` tool (deferred group `evidence`, so
it costs nothing until loaded; read-only), `aico evidence [--session id]
[--format md|json]`, and `GET /api/evidence?path=&session=&format=` (registered
projects only, same token as every route). The tool's output is meant to be
pasted into a PR description; for a commit body it offers a `short` form —
`Verified: typecheck, test (412 passed) · not run: lint` — and **never**
authorship or credit lines (AGENTS.md §4.1; asserted in the tests, including for
what AICO writes into users' commits and PRs).

**Two new RECORD events** (additive; old logs have none and render "no record"):

- `check/run` — appended by `RunChecks` (and so also for the completion gate's
  runs) through a narrow `RunContext.sessionLog.record()` that accepts only
  these two types. Carries `exitCode`, `passed`, `ms`, the parsed `tests`
  counts and any `flaky` finding.
- `tool/decision` — appended where a person answers a permission prompt
  (`approved` | `denied`, `by: 'person'`) and where the pipeline denies a call
  (`by: 'policy'`, with the stage's reason). Nothing about the *outcome* of the
  call changes.

### 2. CI agent (GitHub Action)

A composite action at `.github/actions/aico/action.yml` (consumed as
`suhail-akhtar/aico/.github/actions/aico@vX.Y.Z`) plus two engine commands it
calls. Nothing is added to this repository's own workflows; examples live in
`docs/examples/github-actions/`.

- Installs AICO with `npx -y github:suhail-akhtar/aico#vX.Y.Z` — **pinned**: the
  version is the `version` input or the action's own tag (`github.action_ref`
  when it is `vX.Y.Z`); with neither, the action fails rather than float.
  No third-party actions are used inside it.
- `mode: review` — `aico review --base <ref>`. The model gets a **read-only
  tool set** (`agentSpecTools: 'readonly'`, no shell, no writes, no
  delegation), the diff, and a **code-graph impact section computed by code**
  (`reportChanges`) rather than requested of the model — enforce in the loop.
  The PR title/body are passed fenced as untrusted data. It prints Markdown
  (findings ranked, then the evidence packet of that run) to a file; a later
  action step posts **one** comment with `gh`. The `aico` step's environment has
  the model key and **no GitHub token**: the model cannot post, push or call the
  API; only the posting step holds `pull-requests: write`.
- `mode: fix-ci` — `aico fix-ci --log <file> --branch-prefix aico/fix-ci`.
  Gated by `allow-fix-ci: 'true'` (default `'false'`: the step exits with a
  notice). The **engine** creates the branch before the agent starts (by
  construction, as in ADR 0032), refuses to run on a branch that already has the
  prefix (no fix-of-a-fix loops) or on a detached/default branch, gives the
  agent the failing log as *untrusted data*, lets it reproduce the failure with
  `RunChecks`, fix, and re-run, and commits **only if** the log shows the
  failing check now passing. The action then pushes that branch (never the base)
  and opens a PR whose body is the evidence packet. The action refuses to run
  (either mode) when the checkout persisted git credentials where the agent's
  file tools could read them (`persist-credentials: false` is required and checked).
- Cost and time: `budget-usd` → `safetyLimits.maxCostPerSession` and
  `timeout-minutes` → `agentTimeout`, applied in-process by the command (no
  settings file to forge; and a token tracker is attached explicitly — `aico -p`
  creates none, which leaves `safetyLimits` inert there), plus a `timeout` wrapper on the step. `AICO_HOME` is
  a directory under `$RUNNER_TEMP`.
- Fork pull requests get no secrets from GitHub; the action detects the missing
  key and exits 0 with a notice instead of failing the PR.

### 3. Flaky-test detection

In `RunChecks`, when a **test** check fails and its runner is recognised
(`test-results.ts`), the failing tests are re-run **once**, narrowed per runner
(`src/flaky.ts`): Vitest/Jest by file and `-t`, Mocha by `--grep`, pytest by node id,
`go test -run '^(TestA|TestB)'` (prefix-anchored: a `$` in a name filter is not
safe across shells, so a few extra tests with the same prefix may re-run),
`dotnet test --filter`, Maven Surefire `-Dtest=`, Gradle `--tests`, PHPUnit
`--filter`, `cargo test <name>`, `node --test` by file. If the failing tests cannot be identified,
the whole check is re-run once **only if the first run took under 120 s**.

- fail → pass = **flaky**: reported as `FLAKY`, with the test names, *not* green
  and not a pass — the check is recorded as failed-then-passed, the gate still
  holds it as not passed, and the report says what to do (investigate or quarantine
  by hand).
- fail → fail = a **real failure**, reported as before with the second run's output.
- Every classified test is appended to `<aicoHome>/flaky/<project-hash>.jsonl`
  (append-only; one line per observation). A test seen flaky before is flagged
  `known flaky` in the RunChecks report. (Not in the morning brief: its items
  are per-source cards, so a new source touches the clients too — a follow-up,
  not done here.)
- **Never** auto-skip, quarantine, retry-until-green or edit a test file: that
  would collide with the test-tamper guard and with ADR 0026's stance that a
  check must be the project's own. The report *suggests* quarantine to the
  person; doing it is a change they ask for.

## Alternatives considered

| Option | Why not |
|---|---|
| Have the model write the PR summary from its memory | The failure this fixes; "verified" must come from records, not recollection |
| Parse RunChecks' prose for exit codes and counts | Exit codes are not printed; prose is a model-facing format that we would then be unable to change. A record event is cheap and additive |
| Give the review agent Bash for `git diff` | A reviewer that can run arbitrary commands on untrusted PR content is the attack. The diff is computed by code and given to it |
| Let the model call `gh pr comment` / push itself | Puts a write-scoped token in the process that reads attacker-controlled text. The posting step is separate and holds the token |
| Re-run the whole suite on any failure | Doubles cost on every genuine failure and hides which test flaked; the targeted re-run is cheaper and names the test |
| Retry up to N times and report green on any pass | Hides the flake. One retry is enough to classify; the person decides what to do with a flaky test |
| Auto-quarantine flaky tests | Edits tests to make a check green: the exact thing the tamper guard exists to stop |
| A new top-level `flaky` setting to opt out | One more knob; the retry is bounded (once, time-limited) and the output is strictly more informative. `RunChecks` accepts `retryFlaky: false` in code (deliberately not in the tool schema, which would grow every request) for a caller that wants a single raw run |

## Consequences

- **Good:** a reviewer can read what a change was checked against without
  reading the transcript; "not run" is visible; CI use has a read-only default
  and a deliberately narrow write path; flakes stop costing model turns.
- **Bad / costs:** a failing test run costs up to one extra targeted run; two
  event types to carry forever; a composite action to keep working across
  GitHub runner changes.
- **Honest limits:**
  - The packet proves what was *recorded*. Checks run by a sub-agent are in the
    sub-agent's own log (the packet lists the delegations, not their checks);
    checks a person ran in their own terminal are not seen. Terminal-prompt
    approvals (the CLI REPL) are not recorded; only the client permission
    dialogs and policy denials are. Cost is an estimate.
  - Flaky detection recognises the runners `test-results.ts` parses; for
    others there is no failing-test list, so only the time-limited whole-check
    re-run applies. One passing retry is evidence of non-determinism, not a
    diagnosis, and a test that fails on both runs may still be flaky at a lower rate.
  - The action has not been exercised on GitHub by the author of this ADR; it is
    validated offline (YAML parse, actionlint where available) and its engine
    commands are tested with a mocked provider.
  - A review is a model's opinion about a diff plus a computed impact list; it
    does not replace the project's required checks and never approves a PR.
- **Migration:** none. Logs without the new events render "no record"; the
  flake history is created on first use; the action is opt-in.
