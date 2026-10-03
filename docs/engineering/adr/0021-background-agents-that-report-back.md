# 0021 — Background agents report back, inherit their parent's bounds, and survive a restart

- **Status:** Accepted
- **Date:** 2026-10-03
- **Deciders:** owner (the 2026-10-03 agents audit: seven gaps against Claude Code's agents)
- **Supersedes / related:** [ADR 0001](0001-append-only-session-log.md) (the log is the truth),
  [ADR 0002](0002-guards-only-deny.md) (guards only deny), [ADR 0011](0011-approve-later-inbox.md),
  [ADR 0015](0015-sentinel-reviewer.md)

## Context

An audit of the tree on 2026-10-03 found seven places where AICO's agents made
a promise the loop did not keep:

1. **Results went nowhere.** A `Task {detach: true}` result was only reachable
   through `Supervise wait`, which printed its first 200 characters. A
   `BackgroundTask` pushed a tray notification with the same 200 characters. A
   parent whose turn had ended was never told at all.
2. **`BackgroundTask` escaped every bound.** It was dispatched by the generic
   tool switch, which knows nothing about the run: the child ran in the server's
   directory, with the full tool set, outside plan mode, at depth 0 (so the
   four-level cap never applied), on a token tracker of its own (so
   `maxCostPerSession` never saw its spend), in a ledger row with no session (so
   any chat could see and stop it).
3. **A finished sub-agent could not be asked a follow-up**, although its whole
   conversation was on disk in its `sub-<id>` log.
4. **Worktree isolation did not isolate.** The worktree was created and the
   child was handed the parent's directory; cleanup ran `worktree remove --force`
   and `branch -D`, discarding uncommitted work; git ran in `process.cwd()`.
5. **A backgrounded shell command that crashed was filed `done`**, under no
   session, and nobody was told it exited.
6. **A restart lost background work**: every agent row became `lost`.
7. **Nothing bounded concurrency**: an `Investigate` ran every angle in one
   `Promise.all`; parents could detach without limit.

## Decision

**Result delivery** (`src/agents/report-back.ts`). A finished detached agent
(success, failure or stop) delivers its full report — bounded like a Task
result: 40k characters, head-and-tail excerpt, the rest spilled to the session
workspace — into its owning conversation's inbox as a `plugin` message
(`background-agent`), wrapped `[Background agent <id> finished — "<desc>"]`.
Never attributed to the person. A running turn reads it at its next step
boundary. If the turn has ended, the server (`RunManager.reportBack`) records it
in the log and, when `agents.wakeOnResult` is not off (default on), starts a turn
whose task is itself a `plugin` message (`WAKE_TASK`). `runAgent` now reads
step-queue input pending at the start of a turn before the person's message, so
a report that lands between turns is never read after the first answer. A stopped
agent's report never wakes a session, and a cancelled turn keeps background
reports (`Inbox.discardStep`). A report a `Supervise wait` already handed over is
not delivered twice. Without a server, the run's own inbox is used; with neither,
a tray notification (the old behaviour). A nested agent reports to its parent
agent's inbox while that parent runs.

**Bounds inheritance.** `BackgroundTask` is a detached `Task`: the agent loop
replaces its handler and calls `runTask` with the run's directory, plan mode,
tool scope (child ⊆ parent), depth + 1, token tracker, abort signal and delegate
rule. A child tracker carries `session` — the conversation's tracker — and the
loop measures `maxTokensPerSession`/`maxCostPerSession` against it, so a
background agent whose parent turn is over is still held to the session's cap.
Detached children run headless (no AskUserQuestion; permissions decided by
`decideHeadlessPermission` with the parent's `autoApprove`). Ledger rows carry
`sessionId` and `parent`; `Supervise` filters by owning session.

**Resume** — `Task {resume: "<id>", prompt}`, not a `Supervise message` verb.
Continuing an agent is making a child run, and `Task` is the one place a child is
made: the caller's depth, scope, plan mode, delegate rule, tracker and signal are
in hand there and applied exactly as for a spawn. `Supervise` runs outside the
loop and has none of them. A running agent gets the follow-up at its next step
(as `guide` does); a finished/interrupted one runs again under the same id, its
history rebuilt from its own `sub-<id>` log, its scope the intersection of the
caller's and the one it originally ran under (`agents/scope-json`). Another
conversation's agent cannot be resumed.

**Worktree safety** (`src/worktree/index.ts`). The child's directory is the
worktree (the matching sub-directory of it), and a write bound pins AICO's file
tools inside it. Finishing never discards: uncommitted work is committed to the
agent's branch; if the commit fails the worktree is left in place and its path
reported; only a worktree with no changes and no commits is removed with its
branch. Every git command runs where it belongs (the worktree, or the repository
root recorded at creation) via `execFile`. Worktrees live under
`aicoHome()/worktrees`, with a persisted registry. `EnterWorktree` no longer
implies it moves the session's directory (a run's directory is fixed for its
life on purpose); it says so and points at `Task isolation:"worktree"`.

**Background commands** (`src/tools/bash.ts`). A non-zero exit closes the row
`failed` with the code; the row carries the owning session; on exit a short
notice (command, exit code, last 40 lines, redacted) is delivered as a
`background-command` plugin message. It does **not** wake the session — a dev
server stopping is rarely something to act on unprompted; a model that wants to
be woken registers a `process` watcher.

**Recovery** (`src/work/ledger.ts`, `src/agents/background.ts`). Agent rows
persist their spec (`WorkRecord.resume`). On load, a running agent with a spec
becomes `interrupted` (a new terminal state), not `lost`. On server start,
detached, top-level agents whose last heartbeat is within
`agents.resumeWithinHours` (24) are resumed when `agents.resumeAfterRestart` is
not off, with a message saying they were interrupted; others stay resumable via
`Task {resume}` or `POST /api/agents/resume`. **Nothing is replayed**: the tool
call in flight reads as unanswered (`session/derive`) and the agent is told to
check the real state first.

**Concurrency** (`src/agents/limiter.ts`). `agents.maxConcurrent` (default 6)
per conversation, covering sub-agents, background agents and Investigate
workers. Over the cap an agent waits as `queued` (in the ledger and the spawn
reply), never refused. A sub-agent blocking on its own children suspends its
slot while it waits, so there is no hold-and-wait deadlock. The composer's Stop
(`RunManager.cancel`) also stops the conversation's detached agents from earlier
turns, and `Supervise stop` stops children first via the ledger's `parent` links.

Sub-agent logs are not chats: `listSessionSummaries` skips `sub-*`; they open by
id through `/api/trajectory`, whose directory lookup falls back to the agent's
recorded log directory.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep `Supervise wait` as the only way to collect results | The model has to remember to wait, and a turn that ended cannot wait at all. |
| Deliver reports as human `followup`s | A transcript that says the person typed a sub-agent's report cannot be audited (and the Sentinel would treat it as a request). |
| `Supervise message <id>` for follow-ups | Supervise has no access to the run's scope, depth, tracker or plan mode — a second, unbounded way to start a model loop. |
| Keep `BackgroundTask` on `background/spawnBackgroundAgent` and pass bounds through | The generic dispatch has no run to read them from; the Task path already inherits all of them. Cron and MCP submissions still use it — they have no parent run. |
| Move the session's cwd on `EnterWorktree` | Every guard, the checks gate and the session's filing key on a run's fixed directory; re-pointing it mid-turn is the riskiest change available for a convenience. |
| Refuse spawns over the concurrency cap | Turns a resource limit into a tool error the model works around by doing the work less carefully itself. |
| Auto-resume every interrupted agent | A blocking child's parent turn is gone (nobody waits for its answer), and resuming a nested child alongside its parent would run it twice. |

## Consequences

- **Good:** background work closes the loop by itself; every spawn path is held
  to the same bounds; follow-ups keep context; worktree work is never lost; a
  restart continues background work instead of losing it.
- **Bad / costs:** a wake turn spends a model call when a background agent
  finishes after the turn (off with `agents.wakeOnResult: false`). Ledger rows of
  agents are larger (the spec). `BackgroundTask` now dies with a cancelled
  parent turn and with the composer's Stop — that is what Stop means.
- **Honest limits:** Bash is not confined to a worktree (a command line is not a
  path). A detached child cannot ask the person anything; a call that needs
  approval under an asking parent is denied with a reason. The concurrency cap is
  per conversation, not per process. Resume restores the conversation, not the
  processes an agent had started.
- **Migration:** old ledger rows have no spec and reconcile to `lost` as before.
  New settings (`agents.maxConcurrent`, `wakeOnResult`, `resumeAfterRestart`,
  `resumeWithinHours`) default to the behaviour above. Existing worktrees under
  `<repo>/.aico/worktrees` are not migrated.

## Verification

`scripts/agents-background-test.mjs` (offline, a scripted OpenAI-compatible stub
server; part of `npm test`): delivery into an ended turn with a wake (full,
bounded, plugin-attributed), into a running turn at the next step, failures and
stops (a stop never wakes); plan mode / scope / depth / tracker inheritance and
the session ceiling measured on the conversation; cross-session isolation and
both id spellings; resume with history and guiding a running agent; worktree
cwd, write bound, commit-to-branch, kept-on-failed-commit, git run in the repo;
backgrounded command exit 3 → `failed` + notice; a second process killed
mid-tool → `interrupted` → resumed with the call unanswered and not re-run;
queueing under the cap and Investigate through the limiter; children-first stop
and Stop reaching earlier detached agents; `sub-*` excluded from the session
list but served by `/api/trajectory`.
