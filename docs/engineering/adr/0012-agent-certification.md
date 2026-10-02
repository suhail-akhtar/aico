# 0012 — Agent certification: a hash-bound certificate gates unattended (L4) runs

- **Status:** Accepted (2026-10-02)
- **Deciders:** owner (design [agents-skills-tools.md](../design/agents-skills-tools.md) Q4, Q8 and §12a: "certification required for unattended runs only; certification cap $2 on deepseek-flash with deepseek-v4-pro as judge")
- **Related:** [ADR 0011](0011-approve-later-inbox.md) (the inbox L4 parks into), [ADR 0002](0002-guards-only-deny.md) (guards only deny), [ADR 0009](0009-custom-tools.md) (effect classes)

## Context

Phase 7 made unattended runs (cron, background, `mcp-serve`) park calls that
need a person instead of refusing them. A named agent at L4 is therefore a
specialist that acts with nobody watching; until now nothing checked that it
behaves — that it ignores instructions planted in files, does not print a
secret, does not work around a refusal, and stays inside its write paths.

## Decision

1. **Certification** (`src/evals/`): lint (the one agent validator, plus a
   budget at L3+ and a model that holds a tool conversation), then a built-in
   safety pack (injection, secret, destructive-without-approval, scope
   escape) and the agent's golden tasks (`<agents dir>/<name>.evals/evals.json`;
   the built-ins' in code), k trials each (default 3). Real-world effects are
   mocked after the guards (network, ops, MCP, external/destructive custom
   tools, AICO's own registries); approvals go to a recorder. Graders are
   model-free; an LLM judge (default `deepseek-v4-pro`) only where a task asks
   for one, never alone on a critical task. Thresholds: lint clean, every
   safety probe and critical task passes every trial, others ≥ 0.8.
2. **The certificate** is a file in `aicoHome()/evals/agents/<name>/certificates/`,
   bound to a sha256 over the agent file, its preloaded skill trees, the custom
   tool definitions (and enabled state) in its set, the pinned MCP tool hashes
   of servers it may reach, the model, its golden tasks and the safety pack
   version. Status: certified / changed since certification / failed /
   uncertified.
3. **The gate** is in `runAgent`: a named agent whose effective level would be
   L4 runs at L3 unless `isCertified` holds for exactly what it is now on the
   run's model, and the result says why. Inbox replay of a call a named agent
   parked is refused (diverged) if that agent is no longer certified. Cron jobs
   and background agents may name an agent; a missing one fails the run.
   Interactive levels (L1–L3) are never gated; the orchestrator itself is not
   an agent definition and is not gated.
4. **Money:** a hard cap per certification (default and maximum $2), checked
   before every trial and judge call and lowered into each run's `maxUsd`,
   which the engine checks before every request. An estimate is shown first.

## Consequences

- An agent edit, a skill or tool edit, an MCP description change, a model
  switch or a test edit flips it to "changed" and drops unattended runs to L3
  until it is certified again — by construction, not by remembering.
- The certificate is a file in the user's store: a process running as the user
  could forge one. Same honest limit as skill review and tool enable records:
  the gate makes certification the normal path; it is not a sandbox.
- Not built: the baseline arm, `--compare`, the out-of-scope hand-back and
  looping-budget probes, project-scope custom tools inside the eval workspace.
