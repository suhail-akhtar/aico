# Agent capability audit — engineering quality and token cost (2026-10-01)

Scope: what the agent is sent on every request, how it plans, verifies and
delegates, and which on-demand guidance it has for enterprise engineering work.
Every number below was measured, not estimated by eye: a scripted provider
captured the real request of a depth-0 turn (`runAgent`, Anthropic dialect, an
empty project, the built-in skills loaded, no MCP servers), and tokens are the
repo's own `estimateTokens` (≈ chars/4). The benchmark (`scripts/eng-bench.mjs`)
is the place to judge outcomes; this file records causes.

## Headline numbers

| Request | Before | After |
|---|---|---|
| Depth-0 system prompt | 4,325 tok | 4,323 tok |
| Depth-0 tool schemas | 19,879 tok (72 tools) | 9,959 tok (34 tools) |
| **Depth-0 always-sent** | **24,204 tok** | **14,282 tok (−41%)** |
| `general` sub-agent (system + tools) | ≈24.2K + ≈800 role prompt | 11,966 + 266 role prompt |
| `explore` sub-agent / Investigate angle | ≈7.35K | 5,444 |

The economy probe (`scripts/economy-probe.mjs`) still reports a byte-stable
prefix and tool set across a session, including a QA-shaped message.

## Findings → fixes

**1. Tool schemas were 82% of every request, and half of them are rarely used.**
Evidence: 72 schemas, 19.9K tokens; the vault (1.2K), remote ops (2.5K),
agent/skill/MCP registries (3.2K), cron, world lookups, image, background and
session utilities ≈ 10K, none of which a coding turn calls. No deferral
mechanism existed. Fix: `src/tools/deferred.ts` — eight named groups withheld
until loaded; one `LoadTools` schema lists each group and its tool names.
Loading is sticky and derived from the session log (`tool/call` events: a
`LoadTools` naming a group, a call to a member by name, or opening the
server-ops skill), inherited by sub-agents, and the tool list is always rebuilt
in canonical order, so a load costs one prefix miss per group per session and
the next turn's request is byte-identical. Handlers exist for every tool;
explicit tool sets (agent types, spec arrays, composed registries) are never
deferred; `settings.deferTools: false` restores the old behaviour. Expected
effect: ~10K fewer tokens on every request and on every `general` sub-agent's
first request; more room on small-window models.

**2. Delegated code changes escaped the completion gates.** Evidence: gate state
is per run (`run-scoped.ts`), a sub-agent is a run of its own with its gates
off (`completionGateEnabled` needs `depth === 0`), so a parent that delegated
an implementation finished with its checks gate silent — "a sub-agent
reporting success is a claim" was prompt text only. Fix: when a child settles,
`runTask` absorbs its written files and check results into the parent's run
(`checks.ts` `workOf`/`absorbWork`, `verification.noteFileWritten`). The
parent's gate then demands fresh RunChecks (and VerifyApp for pages) over the
delegated code; a green RunChecks the child ran after its last edit is genuine
evidence and is not paid for twice. Expected effect: no "done" on unverified
delegated work — the failure mode benchmarks punish.

**3. Briefs were free text; reports were unbounded.** Evidence: Task took one
`prompt` string; its 1.3K-token description catalogued 16 role types, most of
them the role-based build team this codebase's own research rejects
(`tools/investigate.ts`); the `general` role prompt carried ~800 tokens of
generic doctrine and a report line that conflicted with other roles'. Fix:
Task has `acceptance_criteria`, `files`, `constraints` beside `prompt`; a
write-capable child with no acceptance criteria is refused before anything
spawns (`briefProblem`), and the brief is composed with labelled sections and
one report shape (`REPORT_CONTRACT`: STATUS / Changed / Verified / Open,
~250 words). Description 828 tokens; `general` prompt 266 tokens. Expected
effect: children that stop at the parent's definition of done, and smaller
results in the parent's context.

**4. Schemas and handlers drifted apart for sub-agents.** Evidence:
`buildToolDefs` never received `depth`, so every sub-agent was shown
`Supervise` (891 tokens) with no handler, and a browser-QA sub-agent was shown
every built-in while only 8 had handlers. Separately, at depth 0 a QA-shaped
message dropped the Task schema while keeping its handler — the cache break
`resolveToolSet` documents as fixed. Fix: one `rebuildToolDefs` that passes
`depth` and uses the handler's own condition for Task.

**5. Sub-agents paid for the chat UI.** Evidence: the rendered-block catalogue
(charts, widgets, maths; ~1.35K tokens) and the prose-style note went to every
child, whose reader is a model. Fix: removed at depth > 0.

**6. The prompt named verification and debugging but not design or
self-review.** Evidence: no bullet asked for requirements, constraints, a
design or a justified stack before editing, or a review of the whole diff
before reporting; one bullet asked for a re-read after every edit, a paid step
the Edit/Write results already cover. Fix: two sharpened bullets (decide before
editing; read your whole diff as a reviewer), one on tests that fail without
the change, the re-read removed, delegation section shortened (the schema now
carries the brief). Prompt size unchanged. Plan mode now asks each step for the
check that proves it, and for alternatives when a plan adds a stack or
dependency.

**7. No on-demand guidance for system design or test strategy.** Evidence: the
built-ins covered the Apps platform (`app-*`), review, security review, commit,
init and server ops; nothing for stack selection, layering, API/data contracts
or what to test at which level. Fix: `system-design` (requirements with
numbers → stack defaulting to what exists, one line per rejected alternative,
dependency maintenance/licence check → layering and patterns only for a named
problem → data, API and failure contracts → slices and a recorded decision) and
`test-strategy` (level by what can break, cases that earn their place, the
adversarial "would a wrong implementation pass?" check, determinism, report).
Both trigger from the request (`matching_skills` in the tail) and cost one
catalogue line each; examples are stack-neutral (the 0915 lesson).

**Measured and reverted (2026-10-01):** on `npm run bench:eng`, `system-design`
made the design-doc task write 15–18k words over 37–63 steps ($0.08–0.10)
against 6–10k words over 13–14 steps without it, for no score gain — the model
treated every heading as a section to fill and kept editing. It was removed;
`test-strategy` stays. Lesson: a checklist skill invites exhaustive output,
so measure a skill before shipping it.

**8. Stale or duplicated prompt text.** `widget_spec` named a tool that is
`WidgetSpec`; the runtime block repeated the skill names the skills section
already lists; the operating processes repeated the delegation section;
`AICO.md` claimed a ~1.3K-token prompt. All corrected.

## Recommended, not done

- **Canvas (1.6K tok), Supervise (0.9K), VerifyApp (0.7K) schemas and the
  rendered-block catalogue (1.35K) are always sent at depth 0.** Trimming their
  descriptions, or deferring Canvas behind a user-text rule, is a product call
  (AICO Docs and the widgets are flagship chat features).
- **Retire the studio role types** (`frontend`, `backend`, `qa`, `architect`,
  `healer`, …) from the Task enum and `AGENT_PROMPTS` once nothing names them.
- **RunChecks returns a 4K output tail, not structure.** Parsing test-runner
  summaries (passed/failed/names of failing tests) would cut tokens on every
  red run and sharpen fixes. No formatter detection; no dependency
  vulnerability/licence check tool (security-review runs `npm audit` ad hoc).
- **No language-server navigation outside VS Code** (references, rename,
  diagnostics); CodebaseMap is symbol-level only.
- **Skill-eval corpus has no tasks for `system-design` or `test-strategy`**;
  add them before tuning the text (`scripts/skill-eval-live.mjs`, paid).
- **`headless` is not passed to `resolveToolSet` from `runAgent`**, so the
  CredentialRequest filter for unattended runs only applies in tests; verify
  whether cron/background runs should drop it.
- **Live verification of the behaviour changes is pending**: the offline suites
  prove the mechanisms; whether models load groups when needed, write
  acceptance criteria, and pass the gates on delegated work is what the
  benchmark run should confirm (paid, owner's call).
