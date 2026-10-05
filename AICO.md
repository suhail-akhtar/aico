# Project Memory

## Project Overview

AICO is a coding agent that runs in a terminal, in a browser, or unattended,
against Anthropic, OpenAI, DeepSeek, OpenRouter, Gemini, Z.AI or a local Ollama.

The decision everything else follows from: **a session is an append-only event
log, not a chat buffer.** Turns, steps, tool calls, tool results, titles, goals
and ratings are durable events with monotonic sequence numbers, and the
transcript is derived from them. That is what lets a run survive the client that
started it.

## Architecture

**The log is the truth, the stream is a preview.** Durable events carry a `seq`
and are replayed on reconnect. Ephemeral events (`chunk`, `reasoning`,
`tool-start`) are never replayed. The client keys finalized messages by `seq` so
replay is idempotent, and accumulates live deltas in a separate draft that is
discarded once the log catches up.

**`onChunk` and `onReasoning` send text accumulated within a step, not deltas.**
Clients must REPLACE, never append. Appending produces "ThisThis isThis is a…"
and grows quadratically. This has been got wrong twice; it is the single most
expensive contract in the codebase to misread.

**The system prompt is data, rendered per provider.** `src/prompts.ts` authors
sections; `src/prompt/` renders them as XML or Markdown per `promptDialect`.
Nothing in the content knows the vendor, nothing in the renderer knows the
content. Every dialect row carries a `rationale` naming its source — vendor
guidance expires, and a table of stale citations is worse than none.

**Everything volatile lives in the tail, never the system prompt.** Providers
render `tools → system → messages`, so churn in the system block invalidates the
prefix of every message behind it. Git status and the date ride after the
transcript instead. This is why the prompt is stable. Tool schemas outweigh the
prompt about 2:1, so rarely used tool groups are sent only once a session loads
them (`src/tools/deferred.ts`); a load costs one prefix miss, never one per step.

**Guards may only deny, never grant.** Tool policy runs as ordered named stages
— hooks, plan mode, bash safety, sandbox, permission.

**Honest sandbox scope.** `sandbox.mode` governs AICO's own file tools
completely and spawned processes not at all. Shell confinement (ADR 0027,
`src/tools/shell-confinement*.ts`) reads each shell command line and requires a
person — at every autonomy level, full autonomy included — for writes outside
the project/workspace/temp, executable downloads, global installs, running
what was downloaded and lasting system changes. It reads command text, so a
write made inside a program (`node -e …`, a script) is not seen. Defence in
depth, not a jail — say so rather than implying otherwise.

**The model uses secrets by name, never by value.** `src/vault/` is the
credential broker: the model writes `{{secret:name}}`, trusted code resolves it
under a policy (scope, approval, audit) at the moment of use. Every sink — the
pipeline result (inside the PostToolUse hook), `Session.append`, spill, the SSE
hub, API responses, run callbacks — passes `vault/sink.ts`'s redactor. A new
sink must too; a new tool that touches the vault goes in `VAULT_TOOL_CLASSES`.
See `docs/security/credential-broker.md`.

## Development Notes

- **Working on this repo: follow `AGENTS.md`** (non-negotiables, workflow,
  no AI attribution, never touch the real `~/.aico`) and `docs/engineering/`.
- **Tests run against real models, not mocks.** `npm test` is the mock-based
  harness; `live-test.mjs` and `web-live-test.mjs` cost money and are not part
  of it.
- **The web E2E suite hardcodes `deepseek-v4-flash`.** If `activeProvider` in
  `~/.aico/settings.json` is a different vendor, every turn 404s and ~30
  assertions fail for reasons unrelated to the change under test.
- **`web/dist-test` bundles are built per-entry with explicit `--outfile`.** A
  multi-entry `--outdir` mirrors source paths and the suite silently tests stale
  bundles.
- **Settings reach the client redacted.** Anything bound under `providers`,
  `providerInstances`, `env`, `mcpServers` or `hooks` would write the redacted
  form back and destroy a working key. `settings-schema.ts` enforces this at
  module load.
- **Prompt rendering must be deterministic.** It heads every cache prefix, so
  reordering sections or varying whitespace costs the cache on every turn.
- **Scripts that call `buildSystemPrompt` do not exit on their own** — the
  memory loader holds an fs watcher open. End one-off scripts with
  `process.exit(0)`.
- Prefer sharpening a prompt bullet to adding one. Every rule can be expanded
  into a doctrine, and the sum of those doctrines is a timid agent.

## Common Commands

```sh
npm test              # engine + session-title suites (mocked, free)
npm run typecheck     # tsc --noEmit
npm run build         # tsup → dist/
npm run build:web     # vite → web-dist/
npm run test:web:unit # pure client logic, no browser
npm run test:web      # HTTP-level E2E against a live provider (costs money)
node live-test.mjs    # agent loop against a real API (costs money)
aico serve --port N   # loopback server + browser client
```
