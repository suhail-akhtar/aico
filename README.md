# aico — open-source AI coding agent

An **AI coding agent** for the terminal, a local web workspace and a native
**VS Code** panel, with a durable session log at its core. Self-hosted and MIT
licensed: **bring your own API key** for OpenAI, Anthropic, OpenRouter, Google
Gemini, Moonshot Kimi, Z.AI (GLM) or DeepSeek — or run it entirely offline against a local
**Ollama** model.

It opens what it builds in a real browser before calling a turn done, keeps one
supervised ledger of everything running in the background, speaks **MCP** so
another AI can hand it work, turns your corrections into knowledge it keeps, and
can measure its own skills against tasks with known answers.

```
  ✻ aico  (AI Coder)

  Provider: openai
  Model:    gpt-5.6-terra
  Session:  a3f19c
  CWD:      my-project

  Type a message, /help for commands, or exit to quit.

❯ _
```

**Status:** `0.11.0`. Used daily, tested hard, not yet 1.0.

**Website:** <https://suhail-akhtar.github.io/aico/> — install, providers, the web
workspace, [VS Code](https://suhail-akhtar.github.io/aico/vscode.html),
background supervision, visuals and Mini Apps.

**How does it compare to Claude Code, OpenCode, Aider or Cline?**
[There is an honest page for that](https://suhail-akhtar.github.io/aico/compare.html),
including where those are clearly ahead.

New here? [**GUIDE.md**](GUIDE.md) walks through actually using it — the web
client, planning before building, what the checks are doing when they push back,
and what to do when something goes wrong.

---

### npx

```sh
npx github:suhail-akhtar/aico#v0.11.0 serve
```

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

Run the latest release without installing anything:

```sh
npx github:suhail-akhtar/aico#v0.11.0 serve
```

`#v0.11.0` is a tag, so it pins that release. `#release/v0.11` follows the 0.11
line as it gets fixes, and `#main` is the development trunk.

To have `aico` on your `PATH` — which the VS Code extension needs — install it
globally from the same tag. aico is not on the npm registry; this builds from
source and takes a minute the first time:

```sh
npm install -g github:suhail-akhtar/aico#v0.11.0
```

From source:

```sh
git clone https://github.com/suhail-akhtar/aico.git
cd aico && npm install && npm run build && npm run build:web
npm link                 # makes `aico` available globally
```

Requires Node 22.5+ — aico uses Node's built-in SQLite, which arrived in 22.5.
The web client ships with it, so `aico serve` works from a
bare `npx` with nothing else installed.

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
| **Moonshot Kimi** | `MOONSHOT_API_KEY` | Kimi K3, K2.7 Code, K2.6; reasoning replayed; automatic caching |
| **DeepSeek** | `DEEPSEEK_API_KEY` | First-party V4; cache hits at ~1/50th of a miss |
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

## It checks its own work

The failure this exists for: three models were asked for a single-file 3D space
planner, and a keyword check scored two of them twelve features out of twelve.
Opened in a browser, one threw on load and rendered nothing, and the other was a
shell — the toolbars were there, the app was not.

Nothing in the loop had ever *run* the artifact. The agent wrote a file, read it
back, saw its own text, and concluded it worked.

**`VerifyApp` opens the page in a real browser** and reports what a person would
hit: uncaught exceptions, console errors, failed and off-origin requests, what
actually rendered — including whether a `<canvas>` was ever painted — and
whether named controls do anything when clicked.

```
FAILED — file:///…/index.html has 3 problem(s). This artifact is not finished.

Problems, worst first:
  - uncaught: THREE is not defined
  - 1 of 1 canvas element(s) were never drawn to
  - "brand colour picker" does not work: set a new colour, and nothing changed

What rendered:
  183 elements, 3 canvas, 0 svg, 12 interactive control(s)
  canvas 300×240 — NEVER DRAWN TO
```

**The verdict is not advisory.** A turn that produced a web page cannot end
`completed` until a passing verdict exists for the file *as it stands now*.
Four ways to fail, each with its own objection:

| State | What the turn is told |
|---|---|
| Built it, never opened it | Reading the source you just wrote is not verification |
| Verified, then edited | The last result no longer describes what is on disk |
| Loads, but nothing was clicked | It has 21 controls and the check exercised none |
| Checks miss the brief | Nothing verified: *"Export to PDF triggers a building-up animation"* |

That last one reads the requirements out of **your own words**, not the model's
— a model that writes its own acceptance criteria writes ones it has met. Only
requirements naming an *action* are held to a check: a colour palette is a real
requirement and no click proves it.

It drives each control the way its type demands. Clicking a `<input type=color>`
opens a native dialog headless Chrome does not have, so a click proves nothing —
value controls get a value and the `input`/`change` events a real interaction
raises.

Uses `playwright-core` against a Chrome or Edge you already have.

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

## Plan before you build

Turn **Plan** on and the turn cannot change anything — the write tools are gone,
not discouraged. The agent investigates, then finishes with a structured plan
you can answer:

```
Plan   Create VERSION.txt with the version from package.json
  1  Write VERSION.txt containing "0.4.1"
     Create VERSION.txt in the repo root with the single line "0.4.1".
     VERSION.txt
  Risk: None.

  [ Go ahead ]  Amend   Later                          Decline
```

**Go ahead** turns planning off and the agent starts work — the mode change is
part of the answer, not something you have to remember. **Amend** puts the plan
in the composer so a correction is a sentence rather than a re-brief, and keeps
planning on. **Later** keeps it without starting it, and offers *Start it now*
whenever you come back. **Decline** closes it.

Assumptions appear *above* the steps, because an assumption you would have
corrected costs a sentence now and a rewrite later — putting it beside the
approve button is the same as not asking.

A proposed plan ends the turn. Asked to "call it once and stop", a model
proposed the same plan three times and then announced it would write a file in
a mode with no write tools; the loop enforces it now.

---

## Running things

**`Bash`** is one-shot. Commands that are not supposed to exit — a dev server, a
watcher, a log tail — are detected and **started in the background**: you get the
pid and the URL it printed, and the turn carries on.

```
Started in the background — this looks like a dev server. It is still running as
pid 41820 and printed http://localhost:8099. Nothing is waiting on it, so carry
on — you can verify against http://localhost:8099 now. Stop it with `kill 41820`.
```

That replaced the worst hang this project has had: a server started in the
foreground held one turn for **139 minutes**, 138 of them with no output, because
the tool description recommended `timeout=0` for anything slow and `timeout=0`
meant *forever*. Nothing runs forever now — 30 minutes is the ceiling, and a
backstop wraps **every** tool dispatch, not just Bash. A browser that will not
launch and an MCP server that goes quiet are the same bug as that dev server.

**`Terminal`** is a shell that remembers. `cd` into a directory and stay there;
export a variable and it is still set next call. Every result reports the
working directory it ended in, because a `cd` that did not take looks exactly
like one that did until something writes a file into the wrong place.

**`Read` before `Edit` is enforced**, not requested. An edit to a file you have
not read is refused, as is one to a file that has changed since you read it — a
remembered `old_str` either fails to match or, worse, matches something that
drifted and rewrites a line nobody has looked at.

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

48 slash commands. The ones worth knowing:

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

### Measuring a skill

A skill is a prompt, and whether it is a *good* prompt used to be a matter of
opinion. Two subcommands make it a number:

```
aico skill eval security-review              # score it against tasks with known answers
aico skill optimize review --steps 3         # propose bounded edits; keep only what scores higher
```

`eval` runs the skill on a corpus of planted tasks — a SQL injection in `db.js`,
an off-by-one in a pager, a staged change that wants a conventional commit —
and grades with regexes, files and tool-call counts. Never a model judging a
model. `optimize` is SkillOpt's loop at personal scale: a separate optimiser
model reads the failing runs and proposes at most four edits a step, a
candidate is kept only if it scores **strictly higher on validation tasks the
optimiser never saw**, and rejected proposals are shown back so they are not
tried twice. Both print their cost ceiling before the first call and stop at it.

`optimize` never touches the shipped skill. It writes a draft for you to diff
and register — the corpus is a proxy, and only you can judge the task nobody
wrote. Add your own tasks under `~/.aico/skill-evals/<skill>/*.json`.

The same bench is in the web workspace under **Settings → Skills → Measure**,
with live per-task scores, each step's verdict, the candidate as a diff and an
*Adopt it* button; VS Code reaches it through *Measure skills* in the panel's
`⋯` menu. Several candidates a step can be scored on training with only the
best validated, results for an unchanged skill are cached so a rejected step
costs nothing to retry from, and three rejections in a row end the run.

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

### Where things are kept

Everything outside a project — settings, session logs, skills, memories, the
work ledger — is under `~/.aico`. Set `AICO_HOME` to put it somewhere
else: a portable install, a second profile, or a throwaway store for a test.
Every test and live probe in this repository does exactly that, so none of
them can reach your real one.

### The context window

The meter under the composer shows how full the model's window is and where
that figure came from: the provider, the built-in table, a figure you typed,
or an assumption. Click it to set the real number (`1m`, `128k`) or hand it
back to detection. A prompt the model accepts that is larger than an assumed
window raises the figure on its own, and the model has a `ContextWindow` tool
to read it and, when you tell it the real figure, record it — so "your window
is a million tokens, stop compacting" is an instruction it can carry out.

---

## Testing

```sh
npm test           # 2,512 offline assertions, no API key needed
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
with diffs and an outcome — a browser check reads *works* or *3 problems* with
the worst one inline, a persistent shell reports the directory it left you in, a
backgrounded command reads *running · pid 4321* rather than a misleading
*exit 0*.

A plan and a task list float beside the conversation when there is one, and know
when to stop talking: both collapse to a single line once resolved, and *all
done* is never shown for a list finished by cancelling half of it — that reads
"0 done · 5 cancelled", because conflating the two is how a task list becomes a
formality. Closing a panel records *what* was closed, so a genuinely new plan
comes back on its own and the one you dismissed stays gone.

Sessions are named automatically and can be pinned by renaming, transcripts
export as Markdown or text, and settings — providers, permission mode, context
and spend ceilings — are searchable across every pane.

Two controls on the composer are per message, because the message you are about
to send is what you know something about. **Approve** is `auto` (the default, and
what every session has always done), `not edits` (file writes go through;
commands, fetches and delegation are put to you) or `always`. `Terminal` is
deliberately not in the middle mode's pass-through — a shell can do everything a
file write can. **Think** offers what the *model* accepts, in each provider's own
shape, and nothing when the model is unknown. `auto` means *send nothing*, and
the button says what that turns into on a provider whose silent default is high.

When the conversation outgrows the model, older turns fold into a summary at 75%
of the window and the client says so — *Compacted the conversation: 1,309 → 754
tokens*. A sent message can be edited and sent again, with arrows between
versions.

#### Keeping a correction

Rate a reply **▼** and say why, and **Remember this** turns the note into a
knowledge entry: a trigger built from what you *asked*, your note as the
guidance, filed with the project. The agent is shown it on any later task whose
wording matches. You see both fields before they are kept — nothing is adopted
because the agent decided it should be.

### In VS Code

The extension in [`vscode-extension/`](vscode-extension/) gives aico a tab of its
own in the Secondary Side Bar, beside Chat. It is drawn for the editor and styled
from your theme — not the web workspace in a frame — but it is not a second
implementation either: the state layer, the reducer and every transcript
component are the browser client's, imported unchanged.

What it does that a browser cannot:

- **Edits arrive through the front door.** A write is applied as a
  `WorkspaceEdit`, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> takes it back and it shows in
  Source Control. A file changed behind the editor's back can do neither.
- **It knows what you are looking at.** Active file, selection with its line
  range, and that file's Problems — shown as chips, so it is never a guess what a
  message will carry. `#` points at another file or a symbol; `@` addresses a
  specialist agent.
- **Approvals are real dialogs.** Auto, ask-but-not-for-edits, or ask every time.
- **The editor is a tool.** `VSCodeDiagnostics` reads your Problems panel, so
  after an edit the agent asks the language server what it thinks instead of
  grepping for the shape of an error. `VSCodeTasks` runs what is already in your
  `tasks.json`. `VSCodeWorkspace` creates, adds and opens folders. Offered only
  while an editor is attached — the same session in a browser tab has none.
- **The shape of a run, on screen.** Task list, delegated sub-agents, a plan you
  can accept or amend, the context meter, a session goal.
- **Background work in the status bar**, without opening anything.

On Windows, commands run on Git Bash when it is installed, then PowerShell, then
`cmd` — because the tool a model sees is called `Bash`, and `ls` through
`cmd.exe` used to burn turns rediscovering that it does not exist.

There is no inline completion; that is a different product. The full workspace
stays one click away for Mini Apps, the trajectory view and the settings screens.
The extension is not on the Marketplace yet; the `.vsix` is attached to each
[release](https://github.com/suhail-akhtar/aico/releases), or build it:

```sh
cd vscode-extension && npm install
npm --prefix webview install
npm run package
code --install-extension aico-vscode-*.vsix
```

Reload the window afterwards — VS Code does not load a newly installed extension
into windows that are already open, and a keypress in one of those does nothing
at all. `aico: Check the Setup` in the command palette reports whether the
binary was found and where the server is.

---

## Honest limitations

- **`Bash` is not confined.** The sandbox governs aico's own file tools
  completely and spawned processes not at all. Linux Landlock and macOS Seatbelt
  backends would close this; they are not written.
- **Reasoning continuity.** On the Responses API, reasoning items are not echoed
  between steps, so each step reasons afresh from the conversation.
- **Legacy sessions.** Transcripts recorded before the event log are seeded once
  on resume; tool detail from before the migration was never stored.
- **Verification covers the web.** `VerifyApp` opens HTML in a browser. A CLI
  tool, a library or a server has no equivalent gate — the tests it runs are
  whatever the agent chose to run.
- **`Terminal` is a pipe, not a pseudo-terminal.** State persists; programs that
  demand a TTY do not work, and it says so rather than hanging.
- **A check can be shallow.** Requirements coverage forces a check *per
  behaviour the brief named*; it cannot judge whether the behaviour is any good.
  It closes "never built it" and "never looked", not "built it badly".
- **The VS Code extension is a `.vsix`, not a Marketplace listing.** It uses no
  proposed APIs, so a listing is possible; it needs a publisher account that
  does not exist yet.
- **`aico skill optimize` can only fix what its corpus can fail.** The shipped
  skills already pass the shipped tasks, so the loop's first honest answer is
  "nothing to fix here" — the value is in the tasks you add under
  `~/.aico/skill-evals/`.
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
