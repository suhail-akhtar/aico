# aico — AI Coder CLI

A multi-provider coding agent for the terminal, with a durable session log at
its core. Works with OpenAI, Anthropic, OpenRouter, Google Gemini, Z.AI (GLM),
and local Ollama.

```
  ✻ aico  (AI Coder)

  Provider: openai
  Model:    gpt-5.6-terra
  Session:  a3f19c
  CWD:      my-project

  Type a message, /help for commands, or exit to quit.

❯ _
```

**Status:** `0.3.0-beta`. Used daily, tested hard, not yet 1.0.

---

## Why this one

Most agent CLIs keep the conversation as a list of strings and re-send it each
turn. aico keeps an **append-only event log** and derives every request from it.
That one decision is what the rest of the design rests on:

| Because requests derive from a log… | You get |
|---|---|
| Tool calls and results stay structured across turns | The model can reason about what a tool returned three turns ago |
| The prompt prefix is append-only | Provider prompt caching actually hits — **79–91% measured** |
| History is addressable by sequence number | Resume, fork, and non-destructive compaction |
| Input can be queued against a step boundary | **Steer a run mid-flight** instead of cancelling it |
| Every fact is an event | Replay, audit, and runtime invariants that catch corruption |

A real session log looks like this:

```
  1 request/header     openai/gpt-5.6-terra tools=41
  2 turn/start         {"turn":1}
  3 user/message       "fix the failing test"        src=human
  4 step/start         {"turn":1,"step":1}
  5 assistant/message  calls=1  usage=5537/69
  6 tool/call          Bash {"command":"node test.mjs"}
  7 tool/result        Bash -> "AssertionError…"     <-seq6
  8 step/end
  …
 27 turn/end           {"kind":"completed"}
```

---

## Install

```sh
git clone https://github.com/suhailakhtar/aico.git
cd aico && npm install && npm run build
npm link                # makes `aico` available globally
```

Requires Node 18+.

## Quick start

```sh
aico provider add                      # interactive setup wizard
aico                                   # interactive REPL
aico -p "fix the failing tests"        # one-shot
aico -c                                # continue the last session
aico --agent review -p "review my diff"
```

---

## Providers & models

| Provider | Key | Notes |
|---|---|---|
| **OpenAI** | `OPENAI_API_KEY` | Includes the `/v1/responses` transport — see below |
| **Anthropic** | `ANTHROPIC_API_KEY` | Explicit `cache_control` for ~90% input savings |
| **OpenRouter** | `OPENROUTER_API_KEY` | Routes any model; sticky session routing for cache warmth |
| **Google Gemini** | `GEMINI_API_KEY` | Via the OpenAI-compatible endpoint |
| **Z.AI (GLM)** | `ZAI_API_KEY` | Implicit caching; Coding Plan endpoint supported |
| **Ollama** | *(none)* | Local, free, private |

The **model name decides the provider**, overriding any configured default —
`aico -m glm-4.6` goes to Z.AI even if your default is OpenRouter.

### Where to put your key

`aico provider add` writes to `~/.aico/settings.json`, which works from any
directory. A `.env` file also works, but `dotenv` reads it from the *current*
working directory — so a key in your project's `.env` will not be found when you
run aico elsewhere. This is the single most common setup surprise.

### gpt-5.6 needs the Responses API

The gpt-5.6 family (`luna`, `terra`, `sol`) cannot be driven agentically through
Chat Completions at all. It rejects `max_tokens`, and refuses function tools
whenever any reasoning effort is set:

> *Function tools with reasoning_effort are not supported … use /v1/responses or
> set reasoning_effort to 'none'.*

Setting `none` "works" but disables the reasoning you are paying for. aico
detects these models and speaks `/v1/responses` instead, where tools and
reasoning coexist. Nothing to configure — but you can tune it:

```jsonc
{
  "model": "gpt-5.6-terra",
  "providers": {
    "openai": {
      "reasoningEffort": "high",   // none | low | medium | high | xhigh
      "maxOutputTokens": 32000     // reasoning shares this budget with output
    }
  }
}
```

Older gpt-5.x models stay on Chat Completions, which is correct for them.

---

## Measured: a real coding task

Not a vibe check. The agent was given a written spec, a **visible** 7-test suite
it could run, and asked to implement a token-bucket rate limiter. It was then
graded against a **hidden** 23-test suite it never saw, targeting the spec
clauses the visible tests do not cover — fractional accrual, monotonic-clock
clamping, `TypeError` contracts, `Infinity` semantics.

| | gpt-5.6-luna | gpt-5.6-terra |
|---|---|---|
| Wall clock | 488 s | **70 s** |
| Steps / tool calls | 13 / 18 | 10 / 15 |
| Input tokens | 110,409 | 82,921 |
| Output tokens | 11,189 | 5,479 |
| Prompt-cache hit | **91%** | 88% |
| Visible tests | 7 / 7 | 7 / 7 |
| **Hidden tests** | **23 / 23** | **23 / 23** |

Both at `reasoningEffort: high`. Two different implementations, both fully
correct on tests neither model saw. Reproduce with `npm run test:live`.

---

## Steering — redirect a run in flight

Type while the agent is working and the message is delivered at its **next step
boundary**, not queued behind the whole run. The turn is extended, not
cancelled, so everything it has already learned is kept.

```
❯ refactor the auth module
  ⋯ Read(src/auth.ts)
  ⋯ Edit(src/auth.ts)
actually keep the session cookie name unchanged
  (steering — applies at the next step)
  ⋯ Edit(src/auth.ts)
```

Queued input also **prevents the loop from finishing**: a model that was about
to answer will continue instead. Both queues are durable, so anything typed
before a crash is still owed when the session resumes.

---

## Safety

Layered, and each layer states what it actually enforces.

**Permissions** — every mutating tool asks before running, with a diff preview
for edits. `/permissions trust-all` for a session, or `-y` to auto-approve.

**Bash safety classifier** — blocks `rm -rf /`, `mkfs`, `curl | bash`, writes to
shell profiles, credential exfiltration, and ~40 other patterns outright.

**Plan mode** (`/plan`) — read-only tools only. **Inherited by sub-agents**, so a
plan-mode run cannot delegate a write to a child.

**Sandbox** (opt-in) — confines file effects to the workspace:

```jsonc
{ "sandbox": { "mode": "workspace-write" } }   // or "read-only"
```

It reports honestly how much it enforces:

| Surface | Enforcement |
|---|---|
| `Write`, `Edit`, `NotebookEdit`, `Read` | **full** — aico resolves every path itself |
| `Bash` and anything it spawns | **partial** — needs Landlock/Seatbelt/a restricted token |

This is defence in depth against a confused agent, not a jail. It stops a
mistaken write; it does not stop deliberate evasion through a shell.

**Repeat-tool guard** — detects a model looping on the same call with identical
arguments and nudges it to change approach. Interleaved bookkeeping tools cannot
launder the loop, and denied calls count.

**Cost limits** — `safetyLimits.maxCostPerSession` / `maxTokensPerSession`, and
sub-agent spend counts toward them.

---

## Architecture

```
src/
  agent.ts        the loop: turn/step, streaming, retries, cancellation
  session/        append-only event log, derivation, inbox, compaction
  tools/          40 tools + pipeline, scheduler, guards
  providers/      6 providers behind one streaming interface
  registry/       capability seams — swap a service without editing consumers
  sandbox/        file-effect confinement with honest enforcement reporting
  agents/         17 agent types + custom agent specs
  studio/         autonomous SDLC pipeline
  ui/App.tsx      Ink terminal UI
  server/         loopback HTTP + SSE, token-authorised
web/              browser client — session list, transcript, trajectory
shared/ui/        presentational components used by the browser client
```

**Turn / step.** A step is one model request plus its tool calls; a turn is zero
or more steps. Both are durable events. Turns end with a structured reason —
`completed | max-tokens | blocked | aborted | error{code}` — so a transcript
explains itself. `max-tokens` is sticky: a truncated reply is never reported as
complete.

**Tool pipeline.** Policy runs as ordered named stages — hooks, plan mode, bash
safety, sandbox, permission — where guards can only *deny*, never grant. Adding
a timeout, a metric, or an audit stage needs no change to the loop.

**Tool scheduler.** Parallel-safe calls share a bounded rolling pool; exclusive
tools (`Bash`, `Write`, `Edit`) are barriers. Dispatch overlaps, but results
commit **in model order**, so a step replays identically. A cancelled step still
records a result for every call it was asked to make.

**Capability registry.** Services are resolved from a context, not imported. A
plugin can register a tool with no edit to core, and a child scope can hold a
different tool set than its parent in the same process.

**Compaction.** Cuts on turn boundaries (never splitting a tool group), appends
a summary that shadows the originals rather than deleting them, and refuses to
run if the result would not be smaller. Measured: 3,045 → 215 tokens, with the
model still answering from the summary.

---

## Agents

17 built-in types, each with its own prompt and tool whitelist: `general`,
`explore`, `plan`, `review`, `verification`, `security-audit`, `project`,
`devops`, `devsecops`, `architect`, `backend`, `frontend`, `qa`, `tech-writer`,
`product-owner`, `healer`, `studio-orchestrator`.

```sh
aico --agent devops -p "set up CI for this repo"
```

The `Task` tool spawns sub-agents three ways: a built-in `subagent_type`, a
registered `agent_name`, or an inline `agent_spec` that synthesizes a specialist
with exactly the tools it needs. Multiple `Task` calls in one step run in
parallel. **Sub-agents inherit every constraint their parent is under** —
settings, hooks, plan mode, sandbox policy, spend caps, and composed tool sets.

`/studio <requirements>` runs an autonomous SDLC pipeline: tier detection,
stack selection from 15 presets, a Ralph-style implementation loop with disk as
the only state, a validation stack, and a self-healer. Resumable.

---

## Commands

58 slash commands. The ones worth knowing:

```
/help  /status  /cost  /compact  /clear  /plan
/model [name]           switch model mid-session
/agents  /agent <n> <task>  /team <requirements>
/studio <req>  /scaffold <req>  /review  /security-audit
/mcp  /mcp-add playwright   MCP servers
/skills  /bg-agents  /cron  /worktrees
/transcript [--all]     export the session (log-backed, includes tool calls)
/doctor                 environment check
```

Commands that talk about "the conversation" act on what the **model** actually
holds — `/clear` clears the model's context, `/compact` shrinks the real
request, `/status` reports true context size and how much is hidden.

---

## Configuration

`~/.aico/settings.json` (global) merged with `.aico/settings.json` (project):

```jsonc
{
  "model": "gpt-5.6-terra",
  "providers": { "openai": { "reasoningEffort": "high" } },

  "autoCompact": { "thresholdPercent": 75, "keepRecentTurns": 3 },
  "maxParallelToolCalls": 8,
  "sandbox": { "mode": "workspace-write" },
  "repeatGuard": { "thresholds": [3, 5, 8] },
  "safetyLimits": { "maxCostPerSession": 5.00 },

  "hooks": { "PreToolUse": ["./scripts/audit.sh"] },
  "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp"] } }
}
```

Full reference: **[`GUIDE.md`](GUIDE.md)**.

---

## Testing

```sh
npm test           # 666 offline assertions, no API key needed
npm run test:live  # 93 live assertions per model — costs money
npm run typecheck
```

The live suite exercises what a mock cannot: wire-format compatibility,
streaming shapes, tool round trips, prompt caching, truncation, cancellation,
steering, compaction, sandbox confinement, and sub-agent inheritance — each
asserted against a real model.

Session logs carry **runtime invariants** (`checkSessionInvariants`) covering
sequence ordering, turn balance, call/result pairing, and replace-range sanity.
Every test that produces a log asserts them.

---

## Browser client

`aico serve` starts a loopback HTTP server and opens a browser client against
it. The run is owned by the server, not by the page: close the tab mid-turn and
the work carries on, reopen it and the session replays from its event log with
real tool results and real sequence numbers.

```sh
aico serve            # prints a tokenised URL and opens it
```

It binds to `127.0.0.1` only, and every request carries a token minted at
startup — reaching the port is not the same as being able to drive it, because
this server can run commands and edit files.

Chat and trajectory are two readings of one session. Tool calls render as cards
with diffs, sessions are named automatically and can be pinned by renaming,
transcripts export as Markdown or text, and settings — providers, permission
mode, context and spend ceilings — are searchable across every pane.

---

## Honest limitations

- **`Bash` is not confined.** The sandbox governs aico's own file tools
  completely and spawned processes not at all. Linux Landlock and macOS Seatbelt
  backends would close this; they are not written.
- **Reasoning continuity.** On the Responses API, reasoning items are not echoed
  between steps, so each step reasons afresh from the conversation.
- **Legacy sessions.** Transcripts recorded before the event log are seeded once
  on resume; tool detail from before the migration was never stored.
- Not a sandbox for untrusted code. Review what it runs.

---

## Development

```sh
npm run dev        # tsup --watch
npm run build
npm test
```

Design decisions and their rationale are documented in the module headers of
`src/session/`, `src/registry/` and `src/sandbox/`, next to the code they
govern rather than in a document that drifts from it.

## License

MIT
