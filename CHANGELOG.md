# Changelog

Notable changes per release. Dates are the release date; `main` is the trunk
and each `release/vX.Y` branch is cut from it at the version it names.

## Unreleased

### Added

- **The skill bench, in Settings → Skills.** Every skill has a *Measure*
  button: the corpus and its split, a model, a ceiling, then *Evaluate* or
  *Optimize*. Both run as jobs the page polls — a browser would time out on a
  five-minute request, and a job outlives the tab that started it — with each
  task's score, misses and cost as they land, each step's verdict, and at the
  end the candidate as a line diff with an *Adopt it* button. Adopting
  registers it as a user skill of the same name; the built-in is untouched.
  VS Code reaches the same bench through *Measure skills* in the panel's `⋯`
  menu and the command palette, because a job that spends money for minutes is
  the wrong shape for a 300px column and the right shape for a wide tab.

- **A truer optimiser.** Four things SkillOpt does that the first loop did
  not. *Candidates*: several proposals a step, each scored on the training set,
  only the best sent to validation — a what-if over ideas instead of a bet on
  one. *A result cache*: every (skill text, task) pair is paid for once, so the
  training set after a rejected step — an identical skill — costs nothing,
  which was most of the loop's spend. *Patience*: three rejections in a row end
  it; the remaining budget is better left unspent. *Preserve hints*: the
  optimiser is told which tasks pass so it does not fix one by rewriting the
  sentence another depends on. Runs are cancellable between tasks.

### Fixed

- **A model on an "OpenAI Compatible" provider ran on an assumed 128K window,
  and compaction fired far too often.** Reported with a screenshot: the meter at
  100% of 128K on a model that holds a million, and a summary folding the
  conversation every couple of turns. Detection for compatible endpoints
  existed and was never reached — the provider type used to dispatch it knew
  the legacy single-provider settings and nothing about configured instances,
  so it asked OpenRouter, or a local Ollama, about a model neither had heard
  of. Detection now asks the instance that actually routes the request, through
  the same probe the settings screen uses to test a provider, and matches ids
  forgivingly (`poolside/laguna-s-2.1` finds `laguna-s-2.1`).

  For endpoints that report nothing — most — the meter is now a button: click
  it, type `1m` or `128k`, and that is the window from then on, never
  re-detected behind your back, with *Forget* to hand it back to detection.
  The same control is in the VS Code panel. And when compaction fires on an
  assumed window it now says so, and says where to fix it.

- **Picking a model for a provider in Settings looked like it did nothing.** The
  pick wrote the global default and nothing else, so the row — which shows the
  provider's own default — never changed, and the list stayed open. The pick
  now also sets the provider's default, the list closes on a confirmation line
  with *Change* to reopen it, and it highlights the provider's default rather
  than whatever the open conversation happened to be pinned to.

## 0.9.1 — 2026-09-03

### Fixed

- **`npm install -g github:suhail-akhtar/aico#<tag>` recursed until it failed.**
  A global install exports `npm_config_global=true` into every lifecycle
  script's environment. The prepare step that installs the web client's
  dependencies runs `npm --prefix web install`, which inherited it — and a
  global install with no package named installs the current directory, which
  was the clone being prepared. npm prepared it again, six levels deep, then
  gave up. `npx github:` sets different config and never hit it, which is why
  the README's headline path worked while the one a VS Code user needs — a
  global `aico` on the `PATH` — did not. The prepare script now scrubs the
  outer install's config from its children and refuses to run nested. The
  site's VS Code page also told people to `npm install -g @suhail-akhtar/aico`,
  which is not on the registry; it now names the tag.

## 0.9.0 — 2026-09-02

### Added

- **A correction can be kept.** A 👎 with a note used to be stored in the log
  and read by nothing — the one moment where a person has just said, in their
  own words, what went wrong, and it vanished the instant they moved on.
  **Remember this** turns that note into a knowledge entry: a trigger built from
  what was *asked* (knowledge is matched against the next request's wording, and
  the next request that goes wrong will resemble this one, not its answer) and
  the note as the guidance. Filed with the project unless you say otherwise,
  because a convention stored globally follows you into repositories where it is
  wrong.

  The user is the gate. Nothing is adopted because the agent thought it should
  be — the entry is written only after a person has read the pre-filled trigger
  and guidance and confirmed them. That is the whole difference between a lesson
  and a confidently wrong rule, and it is why this deliberately stops short of
  SkillOpt-style self-editing: that works because every attempt can be scored
  against a grader, and your real work has none.

  In the browser the entry is editable before it is kept. In the VS Code panel a
  👎 asks *What went wrong?* immediately — the second click nobody makes in a
  300px column — and **Remember this** shows the trigger it will use before you
  press it.

- **A skill can be measured, and improved only when it measures better.**
  `aico skill eval <name>` runs a skill against tasks with known answers and
  scores it; `aico skill optimize <name>` is SkillOpt's loop sized for one
  person's account. A separate optimiser model reads the *failing* trajectories
  — which checks missed and, in the corpus author's words, why — and proposes
  edits bounded by a textual learning rate: at most four operations a step, none
  over 600 characters, and the skill may not grow past a third more than it
  started. A candidate is kept only if it scores **strictly higher on
  validation tasks the optimiser never saw**; a rejected one goes into a buffer
  the optimiser is shown next time, so it does not propose the same thing twice.

  Graders are regexes, files and counts — never a model judging a model. An LLM
  judge costs a call per task per step, drifts between runs, and turns the
  optimiser's job into "satisfy the judge". A planted SQL injection either gets
  named or it does not. Efficiency is part of the score: every task caps tool
  calls, because an optimiser scored on correctness alone will happily add "read
  every file twice", and a skill's length is paid for on every future turn.

  The shipped corpus is six planted tasks across the four built-in skills; add
  your own under `~/.aico/skill-evals/<skill>/*.json`. Every run prints its
  ceiling before the first call and stops at it, not near it. `optimize` never
  writes the skill it was given — it writes a registrable draft for a person to
  diff and adopt, because a corpus is a proxy and only a reader can judge the
  seventh task nobody wrote.

  Baseline on the cheap model, six tasks for eleven cents: security-review
  1.00, commit 1.00, init 1.00, review 0.92 — the one miss was efficiency, not
  correctness: it found both planted bugs in thirteen tool calls against a cap
  of twelve. The shipped skills mostly pass the shipped corpus, so the loop's
  first honest answer is "little to fix here; write harder tasks", which is what
  the user corpus directory is for.

### Fixed

- **Auto-compaction never ran in the browser or the editor.** The terminal
  client has folded older turns into a summary after every turn since the
  feature existed. The server never called it — so a web or VS Code session
  could sit at 100% of a million-token window with the meter saying exactly
  that and nothing acting on it, the whole conversation resent on every turn
  until the provider refused. The server now compacts before a turn (so a
  session reopened after a long absence is folded before its first request)
  and after it (so the meter drops while you are looking at it), and says so:
  *Compacted the conversation: 1,280 → 754 tokens, 1 older turn folded*.

  Proven live rather than by reading: a project whose settings set a
  1,000-token threshold, four large turns, the transcript pinned at three
  messages from turn two on. The first version of that proof failed for a
  reason worth recording — three turns totalled ~770 tokens and never crossed
  the line it was testing, which looked exactly like the bug still being there.

- **Notices were dropped by both clients.** The server has said things like
  "the agent you addressed was deleted" since personas existed, and neither the
  browser nor the panel had a case for the event — it was parsed and discarded.
  Both now show a notice where they show an error, in a quieter tone, until it
  is dismissed. The compaction line above is the first one most people will see.

## 0.8.0 — 2026-09-02

### Added

- **Tools only the editor can run.** `VSCodeDiagnostics`, `VSCodeTasks` and
  `VSCodeWorkspace` — read the Problems panel, list and run the project's own
  `tasks.json` commands, and create, add or open a folder. These are things
  nothing outside VS Code can do: the diagnostics live in a language server the
  editor is talking to and nobody else is.

  They round-trip on the mechanism permissions and native edits already use — a
  promise held on the server, released by an HTTP answer — rather than a second
  protocol. And they are **offered only while an editor is attached**, declared
  per turn, because the same conversation reopened in a browser tab has no
  editor and a tool that can only answer "there is no editor here" costs a turn
  and two retries to discover.

  There is deliberately no "run any VS Code command" tool. That surface reaches
  deleting files and installing extensions, and no permission prompt can
  describe it honestly. There is no editor terminal either: commands run on the
  fixed shell, which is visible in the transcript and the same on every surface.

  `VSCodeDiagnostics` is available in Plan mode — "what is already broken here?"
  is the first question of most plans, and answering it from the language server
  beats guessing from a grep. Adding a workspace folder or opening one always
  confirms natively first, whatever the approval mode says.

- **The panel caught up with the browser client.** Delegation is visible (a
  strip of sub-agents that collapses when they finish and stays open when one
  fails); `@` addresses a specialist; a conversation can be renamed, forked or
  archived; a message can be copied, rated, branched from, or **edited and sent
  again** with arrows to move between versions; there is a session goal, and a
  provider switcher.

  All of it is view code over state that already existed — `planFrom`,
  `todosFrom`, `searchAgents`, `applyVersions`, `editMarker` are imported
  unchanged — so the two surfaces cannot disagree about what the agent committed
  to or what was said back.

- **Plan mode can be answered in VS Code.** The panel had the Plan/Build toggle
  and nowhere to accept a plan, so approving one meant typing a sentence and
  hoping it read as approval. Go ahead, Amend, Later and Decline now send the
  exact wording `PLAN_REPLY` has always defined — which is what lets a plan
  agreed in the editor still read as agreed when the log replays in a browser.

- **Reasoning effort, per model, from a verified table.** `auto`, `off`,
  `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, sent in each provider's own
  shape: `output_config.effort` for Anthropic, `reasoning_effort` on OpenAI Chat,
  `reasoning.effort` on Responses and OpenRouter, `thinking.type` for Z.AI.
  `auto` means *send nothing* — which for several vendors is adaptive per
  request, not a hidden default we should be overriding.

  Gemini's OpenAI-compatibility surface is deliberately left alone: its
  `thinking_level` is documented for the native API and unverified on the compat
  endpoint, and a probe asserts we stay silent there rather than guessing.

- **A shell whose commands exist.** On Windows the engine ran everything through
  `cmd.exe` while the tool the model sees is called `Bash`, so `ls` and `head`
  came back "not recognized" and the run burned turns rediscovering it. Git Bash
  is preferred, then PowerShell, then `cmd`, and the prompt names which one.
  `AICO_SHELL` overrides.

### Fixed

- **Every multi-line edit failed on Windows.** `git config core.autocrlf`
  defaults to true there, so a checked-out file holds `
` — and `Read` was
  splitting on `
` and leaving a carriage return on the end of every line it
  showed the model. A model cannot see one and does not reproduce it, so the
  `old_str` it sent back never matched and `Edit` reported *"the string to
  replace was not found"*, which reads as the model having invented the snippet.

  Re-reading changed nothing, so an agent would read, fail, read, fail. Only
  single-line edits worked, because a needle with no newline in it has nothing
  to disagree about. `Read` now normalises, `Edit` matches in the file's own
  endings and writes them back unchanged, and `Write` keeps the endings a file
  already had — overwriting a CRLF file with `
` turned a two-line change into
  a diff claiming every line changed.

  The error is also more useful when it does fire: a snippet that differs only
  in whitespace or line endings now says so, rather than being indistinguishable
  from one that is genuinely absent.

- **A flood of command output froze the editor.** A wide `find` produces
  megabytes, `Bash` retains up to 10MB of it, and progress fired every 400ms —
  so the panel rebuilt a `<pre>` from the whole buffer several times a second
  until VS Code offered to close the window. Two independent bounds now: the
  stream carries a tail, and the renderer draws a bounded tail of whatever it is
  given.

- **The composer's controls made the panel scroll sideways.** A flex row that
  cannot fit does not clip — it widens the document and drags the whole
  conversation with it. The toolbar wraps.

## 0.7.0 — 2026-09-01

### Added

- **A native VS Code panel**, in a tab of its own in the Secondary Side Bar
  beside Chat — the same mechanism Claude Code and Codex use, and no proposed
  APIs. It replaces an extension that put the whole web workspace in an iframe:
  a browser page wearing the editor's frame, with no idea what file was open.

  It is not a second implementation. `web/src/{reduce,store,turn-state,plans,
  todos}.ts` turned out to be free of React and the browser — about 1,900 lines
  — and `shared/ui` already styles everything through `--aico-*` custom
  properties. The panel imports the state layer unchanged and redefines
  twenty-six variables in terms of `--vscode-*`, which restyles every shared
  component at once and keeps doing so on a theme nobody has seen yet.

- **Editor context, shown before it is sent.** The active file, the current
  selection with its line range, and that file's Problems arrive as chips above
  the composer; `#` points at another file or a symbol. Every chip is removable,
  and a removal sticks per selection rather than per file.

  The rule behind it: inline what nothing else can recover — a selection, a
  language server's diagnostics — and merely *name* files, because aico has
  `Read` and can fetch exactly the part that matters. Getting that backwards is
  how an editor integration sends fifteen thousand tokens of open tabs with
  every "hello".

- **Tool approval modes.** A turn can be submitted as `auto` (unchanged, and
  still the default), `edits` — file writes go through, commands and fetches are
  put to you — or `ask`. In VS Code the prompt is a modal: a card in a panel can
  be scrolled past while the turn sits blocked on it.

  `Terminal` is deliberately absent from the `edits` pass-through list. A shell
  command can do everything a file write can and more, so "auto-accept edits"
  would be a lie if it also ran commands.

- **`applyEdit`**, an optional writer on the run context. When the client
  supplies one — the panel does — a write is applied as a `WorkspaceEdit`, so
  `Ctrl`+`Z` takes it back and Source Control shows it. Undefined means `fs`,
  which is every other run, so the terminal, the browser workspace and headless
  runs are unchanged.

### Fixed

- **The extension registered a second project for the folder you had open.**
  VS Code reports Windows paths with a lowercase drive letter (`e:\work`) while
  everything else on Windows uses an uppercase one, and aico's project registry
  compares paths as strings. Sessions started from a terminal then did not
  appear in the panel, because they were filed under the other spelling of the
  same directory. Paths are canonicalised on the way out of the extension, and
  matched case-insensitively on Windows.

- **An untrusted folder disabled the extension silently.** VS Code turns
  extensions off in Restricted Mode; ours simply did not appear, with nothing on
  screen to say why. The manifest now declares `capabilities.untrustedWorkspaces`
  with a reason, so Restricted Mode explains it and offers a Trust button.

- **Opening the panel started a fresh conversation every time**, losing the
  model along with it — the model is pinned per session by design, so forgetting
  the session forgot the model. The panel now resumes the folder's last
  conversation, and a genuinely new one inherits the model last chosen there.

- **A turn could block for ever on stdin.** The engine falls back to a readline
  prompt when permissions are gated with no callback registered; in a server
  that is a turn waiting on input nobody can see. The approval mode and the
  callback are now set together and never separately.

## 0.6.0 — 2026-08-31

### Added

- **One work ledger.** Sub-agents, background agents, backgrounded shell
  commands, Mini App servers, cron firings and watchers now share one record
  shape, one id space and one append-only log at `~/.aico/work.jsonl`. Before
  this there were five separate registries, so nothing could answer "what is
  running right now?" — there was nowhere to ask.

  The log is replayed at startup, and anything it says was running is settled:
  a process whose pid is still alive keeps running (a detached dev server
  legitimately outlives the session that started it), and everything else is
  marked `lost`. A crash used to drop in-flight work silently, with "it
  finished" and "it never came back" looking identical afterwards.

- **`Supervise`** replaces `AgentSupervise`, which could see sub-agents and
  nothing else. One tool, eight actions — `list`, `stop`, `guide`, `wait`,
  `watch`, `unwatch`, `policy`, `ack` — and every id argument accepts an array,
  so stopping three runaway children is one call rather than three.

  Outcomes stay listed until acknowledged. Reading does not clear them, because
  losing a failure to whichever turn happened to glance at it is how a
  background job becomes a mystery an hour later.

- **Supervision policies the platform enforces.** Set `deadlineMs`,
  `maxCostUsd`, `maxSteps` or `idleMs` once with an `onBreach` of `report`,
  `stop` or `kill`, and stop checking back. `idleMs` is deliberately separate
  from a deadline: an agent that has worked hard for an hour and one that has
  made no call in ten minutes are different failures, and one timeout kills the
  wrong one.

  There is no `pause`. An LLM turn cannot be suspended — the provider stream is
  a single open request — and a control that silently cancels would be worse
  than not offering one.

- **Watchers.** Wait for a file, a process, an HTTP endpoint, a command, a log
  pattern or another piece of work, and be woken when it happens. An agent
  waiting on a build today runs, sleeps and runs again — a full turn per check.
  A watcher costs one turn to register and one to be woken by.

- **`aico mcp-serve`.** aico speaks MCP on stdin/stdout, so Claude Code,
  another aico, or any MCP client can hand it work. **Nothing listens** — no
  socket, no port — which is why it needs no authentication to be safe.

  Six tools, and deliberately not `Read`/`Bash`/`Edit`: the surface is
  delegation, not remote control. It runs **read-only by default**; start it
  with `--allow-writes` (or set `mcpServer.allowWrites`) to let submitted work
  run commands and change files. The posture is printed to stderr at startup
  either way.

- **A running-work block in the prompt** when there is something running or
  something finished you have not acknowledged, and nothing at all otherwise.

- **Scheduled jobs are supervised work.** A firing now stays open for as long
  as its run does, adopts the agent it started as a child, and closes with that
  agent's outcome — so *done*, *failed*, *stopped by you* and *stopped by a
  limit* are four visible states rather than one. Stopping the schedule stops
  the run under it, and the spend is rolled up onto the schedule.

  `CronList` and the System panel now report **what the last run did**, not just
  when the next one is due. A job that had been failing every night looked
  perfectly healthy before.

- **Per-job cron permissions.** Scheduled runs default to full tool access:
  nobody can approve anything at 3am, so the alternatives are "act" or "silently
  do nothing", and a job that refuses itself every night is worse than one that
  acts because it looks like it is working. Writing the prompt and choosing the
  schedule is the authorization. Set `permissions: "readonly"` on a job that
  only needs to report.

- **A "Running work" view** in the System panel, across every kind of long-lived
  work, with a Stop button and an idle warning — plus `work/stop` and `work/ack`
  routes behind it.

### Fixed

- **`AskUserQuestion` could hang a headless run forever.** With no callback
  registered it opened a readline on stdin and waited — under `aico mcp-serve`,
  on the JSON-RPC stream itself. It is now removed from the toolset of any run
  with nobody attached, and refuses immediately if it is reached anyway.

- **Background agents ignored their working directory.** `cwd` was declared on
  the spawn options and never forwarded to `runAgent`, so every background agent
  and every cron job ran in the *server's* directory. A nightly job pointed at a
  repository wrote its files somewhere else entirely and looked, from that
  repository, as though it had done nothing.

- **`maxConcurrentJobs` limited nothing.** The tally was incremented on fire and
  decremented in the dispatch's `finally`, but dispatch is fire-and-forget — so
  it counted dispatches in progress, which is never more than one. Counted from
  the ledger now.

- **A slow job could stack copies of itself.** One scheduled every minute that
  takes an hour started sixty. A run that is still going now skips the next
  firing.

- **A stop's reason was still being lost in one path.** Stopping a child closes
  its parent through a follower — a cron firing follows its agent — using the
  child's generic message. The outcome is now recorded before anything is
  signalled.

- **Background agents could hang forever on a permission prompt.** With
  `autoApprove` off — the default — any background agent, cron job or
  MCP-submitted job that needed `Bash`, `Write` or `Edit` fell through to an
  interactive prompt, written to `process.stdout` and read from `stdin`. Under
  `aico serve` that is a terminal nobody is watching; under `aico mcp-serve`
  those are both halves of the JSON-RPC stream. Headless work now gets a
  decision from policy, and the denial says what to do instead.

- **Background agents reported no token usage**, so a spend ceiling compared a
  limit against zero and could never fire.

- **A stop's reason was being discarded.** Stopping a background agent flips its
  own registry to "Cancelled by user", which reached the record first — so every
  supervisor reason, and every reason typed into a stop, was replaced by a
  generic one.

- **MCP servers with a space in their command failed on Windows.** `shell: true`
  passes the command to `cmd.exe` unquoted, and the default Node install lives
  in `C:\Program Files\nodejs`. The only symptom was "MCP process exited
  unexpectedly"; server stderr is now kept so a failure can say why.

## 0.5.0 — 2026-08-31

A minor rather than a patch: the minimum Node version moves from 20 to
22.5, which will stop an older install dead. Everything else is additive.

### Added

- **Mini Apps.** Ask for an invoice ledger or a stock list and you get a real
  single-page application with a SQLite database behind it, served at its own
  local URL, still there tomorrow. A left-nav tab lists them; the agent builds
  them through `MiniAppManage`.

  It is a plugin and it is **off by default** — Settings → Model & context →
  Mini Apps. It is the one feature that opens a listening socket of its own,
  which should be opted into rather than inherited.

  The second port is not a detail, it is the design. A Mini App page is
  model-authored JavaScript; the aico API runs shell commands and keeps its
  token in the portal's `localStorage`. Same origin would hand generated code a
  Bash tool. Two origins, each refusing the other, and a `connect-src 'self'`
  CSP behind that.

  Apps never send SQL either. A page names a table and passes values; the
  server builds the statement, checks every identifier against the schema that
  actually applied, and binds every value — so a search box cannot become a
  `WHERE` clause. Every app gets the same server; the app is the page.

  Each one ships with a data client, a ready-made CRUD component, and a design
  system with light and dark modes. `MiniAppManage create` hands that contract
  to whoever is building — capabilities nobody mentions are capabilities that
  get routed around badly.

- `scripts/miniapp-probe.mjs`, wired into `npm test`: 31 checks over real HTTP
  against a real database file, including encoded path traversal, a quote in a
  value, an injected `ORDER BY`, a foreign `Origin`, and a restart to prove the
  data outlives the process.

### Changed

- The left navigation says **Workspaces** rather than Projects; the button
  beside it already said "Add workspace", so the header was the odd one out.
- **Node 22.5 is now the minimum** (was 20). `node:sqlite` ships with Node from
  22.5; the alternatives were a native module that compiles C++ on every
  install, or WebAssembly.

- **Sub-agents are visible in the browser.** A delegated turn used to go blank:
  the parent made one `Task` call and waited, and the child's minutes of work
  happened where the page could not see it. A panel now lists each sub-agent —
  its brief, the tool it is inside, elapsed time and call count — and the
  activity line names the child instead of saying "Running Task". The spawn and
  its outcome are logged as `agent/spawn` and `agent/done`, so a delegation
  replays after a reload; the live ticker stays on the stream, where it belongs.

- **Sub-agents can be supervised, not just watched.** Each running child has a
  Stop button in the panel, and the orchestrator gets `AgentSupervise` — `list`
  reports what every sub-agent is inside, how long since it last did anything
  and what it has spent; `stop` terminates one by id while its siblings carry
  on. A stop requires a reason and carries it through to the result, so a parent
  can tell a deliberate termination from a crash: one invites a re-plan, the
  other a retry. `Task` still blocks, so a parent cannot poll a child it is
  waiting on — the tool description says so rather than letting a model discover
  it the hard way.

- **Mini Apps come in two kinds.** `page` is the original and still the default:
  one HTML file over a shared server that runs no code the model wrote, serving
  the moment you save. `nextjs` is a real Node application — its own server,
  routing, dependencies and process — for when an app genuinely needs
  server-side logic, several routes, or a database other than SQLite. Started
  and stopped from the panel, with install and startup progress and the
  process's own output when it fails.

  That is a different bargain, not a bigger version of the same one, and it is
  stated rather than implied. A Next.js app runs code the model wrote, so what
  it can reach is the guarantee: its own process, its own port (its own origin,
  so it can reach neither aico nor another app), and an environment with every
  API key, token, password and credential stripped by pattern rather than by a
  keep-list. What is *not* contained is said plainly too — it runs Node as you,
  `npm install` runs postinstall scripts, and `cwd` is pinned but the filesystem
  is not. That is the trust you extend to any repository you clone and run.

  SQLite by default through Node's built-in driver — no dependency, no native
  build — with `DATABASE_URL` honoured for Postgres or MySQL, kept in the app's
  own `.env.local` because it is the app's credential rather than the agent's.

- **Every Mini App has its own conversation.** Opening one from the panel
  rejoins the chat about that app — changes, fixes, enhancements, debugging —
  with a bar naming what is in scope and a link to the running page. The binding
  is a log event, so it survives a reload rather than leaving a session quietly
  answering about the wrong app.

  Its identity, directory, schema and file list go into the **system prompt**,
  not into a message: that is the cached prefix, written once and read back at a
  fifth to a tenth of the price on every turn after. Sending it per turn would
  cost full price and change the tail each time, which is what stops a cache
  hitting. File contents are deliberately excluded — a prefix embedding
  `index.html` is invalidated by every edit.

  The contract now asks for the work before the work: research what the app
  actually needs, read an existing one, ask only what cannot be inferred, and
  write the schema and screens down before any file exists. It also states the
  bar for the interface — lead with the answer, one primary action, sort by what
  matters, teach in the empty state.

- **Sub-agents can be corrected mid-run.** `Task` gains `detach: true`, which
  returns an agent id instead of blocking — the only way a parent can supervise,
  since waiting on a child suspends it inside the same call. `AgentSupervise`
  gains `guide`, which delivers a correction at the child's next step boundary
  so it keeps every tool result it has already gathered, and `wait`, which
  collects a detached result and is honest when its own timeout expires: the
  agent keeps running rather than being killed for a caller's impatience.
  Detaching is opt-in and blocking stays the default, so every existing
  delegation behaves exactly as before.
- Sub-agents now get their own session log, filed beside the conversation that
  spawned them, so what a delegated agent actually did is on disk rather than
  summarised in a paragraph.

### Fixed

- **A Mini App's schema can change.** `CREATE TABLE IF NOT EXISTS` cannot add a
  column to a table that already exists, and the open database handle was never
  re-reading the file — so an edit was never applied and `MiniAppManage tables`
  reported the schema from an hour ago. Found the hard way: asked to add a
  column, an agent edited the schema, could not see the change, concluded the
  app was broken, deleted it and rebuilt it under a new name, taking the data
  with it. Schemas are now re-applied when the file changes, `ALTER TABLE …
  ADD COLUMN` is documented as the way to evolve one and its repeat-application
  error is tolerated, and a session bound to an app refuses to delete that app.
- **Enabling Mini Apps no longer needs a restart.** The host is started and
  stopped when the setting is written; nothing on screen used to say a restart
  was required, which made the switch look like it did nothing.
- **The Mini Apps port is validated.** A port you configured is a decision: if
  something else holds it, the panel names the port and says so, in the server's
  own words. A port aico picked is not a decision, so a busy one moves aside to
  any free port rather than failing the feature.
- **Memory and global instructions are followed.** They sat at prompt order 60 —
  above the tool notes, above the safety rules, never restated — while the goal
  and folder rules sat last and were reprised. Your own words about how you want
  to be worked with are more specific than anything shipped in the prompt, not
  less; they now sit with the other standing instructions and are reprised.
- **A standing goal survives a long turn.** It appears in the system prompt once,
  and only Gemini's dialect asks for a tail restatement — so on a twenty-step
  turn the objective sat thousands of tokens behind every decision after the
  first. It is now restated at the step boundary every sixth step: one sentence,
  appended so the cached prefix is untouched, attributed to the harness rather
  than to you.
- **A routed model id no longer goes to a direct vendor.** With an OpenAI
  instance active, `deepseek/deepseek-v4-flash` was sent to api.openai.com,
  which answers "invalid model ID" — an error that reads like a typo and is
  actually a routing decision. A vendor's own routed form still belongs to it,
  so `z-ai/glm-5.3` stays with Z.AI.
- **Sub-agents ran in the wrong directory.** `runAgent` was called without a
  `cwd`, so a delegated agent worked in `process.cwd()` — on a server driving
  several workspaces, wherever it was launched rather than the project the
  delegation belonged to. A sub-agent asked to read a file was reading another
  repository's copy of it.
- **Sessions nobody used are no longer saved.** Opening the workspace against a
  folder wrote a log immediately, so merely looking at a new chat put a
  placeholder row in the sidebar permanently — three folders, three
  conversations you never had. The file is now created by the first event, and
  the listing drops header-only logs left by earlier versions. Filtered on event
  count rather than turn count, so a session interrupted during its first turn
  is still kept.
- **GLM is costed from its price list rather than its name.** `glm-5.3` and
  `glm-5.3-flash` both matched the `glm-5` prefix and were billed identically,
  for two models that differ by a factor of nine — flash overstated about
  fivefold, the full model understated by half. The whole 4.5–5.3 range now
  carries its published rates, including the cached-input discount and the free
  tiers. `z-ai/glm-5.3-flash` matched nothing at all and fell through to the
  invented default, which is what the `?` beside a cost meant; the lookup now
  retries without the vendor prefix, and only after the full id has failed, so
  `deepseek/…` on OpenRouter keeps the separate rate it is listed with.
- **GLM is no longer capped at 8K output.** `OpenAICompatibleProvider` had one
  hardcoded ceiling for every endpoint speaking the protocol, with no way to
  raise it — on a model documenting a 1M context and a 128K output limit. A
  ceiling below what the model can write does not shorten a reply, it truncates
  the tool call, and a half-emitted call performs no action at all: the step
  writes nothing and bills for the attempt. Z.AI now defaults to 32K and takes
  `providers.zai.maxTokens`.
- **A 1M-context model is no longer compacted as though it held 128K.**
  `glm-5.3` inherited its window from the `glm-5` prefix, so compaction fired at
  an eighth of the real budget — paying for a summary, and discarding detail, on
  a model still holding the whole conversation.
- **The harness no longer appears to be you.** The loop talks to the model
  through the same channel a person does — the truncation nudge, the completion
  gate, a compaction summary — and the log has always recorded which is which.
  The client ignored that and drew a user bubble around all of it, so a step cut
  off at the output ceiling produced an empty reply and then "you" said *Your
  previous step was cut off…*, three times over. Read back, that looks like a
  session stuck arguing with itself. They are system notes now, each naming the
  part of the harness that wrote it.
- The portal's static file handler tested containment with `startsWith(root)`,
  which also accepts a sibling — a directory named `web-dist-anything` beside
  the real one would have been served from.

## 0.4.1 — 2026-08-29

Everything here was found by running the thing rather than testing it. The
suite was green for all of it, before and after.

### Fixed

- **A repair no longer goes on an expedition.** Pressing Fix on a diagram sent
  the agent hunting: scratch directories, two npm installs, a thirty-one-minute
  hang, a search for which mermaid version the renderer bundles — for a fix that
  was one pair of quotation marks. The repair turn now carries the block's spec
  inline, is told the parser error names where it stopped rather than what is
  wrong, and runs with a toolset of exactly one entry. Twenty-odd tool calls
  became zero or one, and thirty-one minutes became about ten seconds.
- **A correction is visible without reloading.** The repair wrote the right
  block to the log and the broken widget went on showing the failure until the
  page was reloaded. `widgetFixes` had a frozen identity so the transcript's
  memo would survive a streaming turn — but a memo that never breaks also does
  not break when there is finally something new to draw. It is now keyed on the
  replacements, which change once per repair rather than once per chunk.
- The install instructions pointed at other people's software: `npx aico` and
  `npm install -g aico` install an unrelated package, and the clone URL was
  missing a hyphen and 404s.
- `prepare` swallowed build failures. It ended in `|| exit 0` — there for a real
  reason, since a published tarball has no `src/` to build — but it made every
  failure succeed, so a broken build reported a successful install and surfaced
  later as a missing `dist/index.js`.

### Changed

- Diagrams are themed: softer surfaces, borders carrying the identity, and
  groups as background rather than hard dashed boxes. This was reverted in
  0.4.0 on the belief it broke `architecture-beta`. It did not — the cause was
  a CSS selector matching mermaid's nested per-icon SVGs. The probe that
  cleared the theme at the time was wrong twice over: it built a two-service
  diagram when every failure had seven, and asked whether anything rendered
  when the symptom was rendering outside the viewBox. Both are now permanent
  cases in the diagram matrix.

## 0.4.0 — 2026-08-28

A release about the chat surface: what the agent can draw, and what happens
when a drawing goes wrong.

### Added

- **Branch a conversation from any point in it.** Every message offers it, and
  the two sides mean different things: from a reply the branch ends *with* that
  reply, and from your own message it ends just before it with the text handed
  back to the composer. The cut is a turn rather than a message, because a tool
  call and the result answering it can be several events apart and every
  provider rejects a request holding one without the other.
- **Dashboards in the chat.** A `dashboard` block takes KPI tiles with
  sparklines and a responsive grid of chart, viz and table panels — one fence,
  one board, one frame. Asked for "a single dashboard view" the agent used to
  write a standalone HTML file, correctly, because chat blocks are one per fence
  and nothing else was possible.
- **Statistical graphics** through a `viz` block (Vega-Lite). Binning,
  aggregation, regression, loess, density, quantiles, window functions, box
  plots, error bars and faceting are computed by the library from raw rows,
  rather than pre-computed by the model and emitted twice.
- **Mathematics**, which was always rendering and was never advertised. `$x^2$`
  inline, `$$…$$` on its own line, a `math` block with the frame's controls,
  and chemistry via `\ce{2H2 + O2 -> 2H2O}`.
- **Twenty-six diagram types instead of six.** C4 at every level including
  deployment and dynamic, cloud architecture, block, packet, requirements,
  gantt, timeline, kanban, mindmap, quadrant, gitGraph, journey, sankey,
  treemap, radar and the rest — all from the mermaid already in the tree, none
  of which had been mentioned. `npm run test:diagrams` renders every one in a
  real browser so the list describes this build rather than mermaid's docs.
- **Zoom and pan on diagrams**, with the controls over the drawing. Plain wheel
  still scrolls the page; zoom is on the buttons and ctrl/⌘+wheel.
- **`WidgetSpec`**, which hands back the exact shape of any drawable block, or
  of a single diagram type. The catalogue carries a one-line summary per kind in
  the prompt and the full contract behind this tool, so adding kinds does not
  grow the text billed on every request.

### Changed

- Widget controls are icons with tooltips, each carrying its label as an
  accessible name.
- Diagrams live in the same frame as everything else — same copy, download,
  expand and hide, and for the first time the same repair path when one fails
  to parse. Expanding fills the window and Escape leaves it.
- Repairing a widget no longer holds a conversation about it. The corrected
  version replaces the broken one in place and the exchange stays out of the
  transcript, though the log keeps every word. A repair that produced nothing
  stays visible, because a widget marked "being fixed" with no explanation is
  worse than the noise.
- Spreadsheet attachments are read through ExcelJS. The `xlsx` package is
  abandoned on npm at 0.18.5 with a prototype-pollution and a ReDoS advisory,
  both in the parser, and this code parses files a user uploaded.

### Fixed

- Sessions started from the web ran in whatever directory `aico serve` was
  launched in — usually AICO's own checkout — rather than the configured
  workspace. The server was already right; the client named a project on every
  request, so the correct default was unreachable.
- The model a session is held with is remembered. It used to live in browser
  state, so it reverted to the global default on reload with nothing to say it
  had. Choosing in Settings sets the default without silently pinning whichever
  chat was open, and a pinned session says so and can follow the default again.
- **Queue did nothing at all.** Messages went into a queue that was never
  drained — `claimTurn` had no callers anywhere. Steer worked and looked broken
  for the opposite reason: it lands at the next step boundary and said nothing
  in the meantime. Both now show what was accepted and when it will run.
- Charts stopped flickering and hidden widgets stopped reappearing when a new
  message streamed. react-markdown reconciles by component identity, so a
  rebuilt component map remounted every fenced block — the charts were not
  redrawing, they were being destroyed and rebuilt.

### Security

- `npm audit` is clean in this repository. `form-data`, `ws`, `prismjs` and
  `refractor` were upgraded; `xlsx` was replaced.
- One advisory reaches consumers and cannot be suppressed from here: ExcelJS
  depends on `uuid` 8, which has a bounds-check advisory in `v3/v5/v6` when a
  caller supplies a buffer. ExcelJS calls `uuid.v4()` with no buffer, so it is
  not reachable, but `overrides` do not transit to installers and `npm audit`
  will report it. It replaced two advisories that *were* reachable.

## 0.3.0

Multi-provider architecture, the web console, and the session event log. See
the git history for detail — this changelog starts at 0.4.0.
