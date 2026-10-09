# Using aico

The README says what this is. This says how to work with it.

- [Five minutes in](#five-minutes-in)
- [The web client](#the-web-client)
- [Planning something first](#planning-something-first)
- [When it pushes back](#when-it-pushes-back)
- [Running servers and long commands](#running-servers-and-long-commands)
- [AICO in CI](#aico-in-ci)
- [Keeping a shell](#keeping-a-shell)
- [Steering a run without stopping it](#steering-a-run-without-stopping-it)
- [Projects, sessions and groups](#projects-sessions-and-groups)
- [Choosing a model](#choosing-a-model)
- [For organisations: a managed policy and an audit trail](#for-organisations-a-managed-policy-and-an-audit-trail)
- [When something goes wrong](#when-something-goes-wrong)

---

## Five minutes in

```sh
npx aico provider add          # paste a key, pick a default model
npx aico                       # talk to it
```

Two things worth knowing before you start.

**It works in the directory you launch it from.** Not the directory it was
installed in. Everything it reads and writes is scoped there, and so is the
per-project scratch workspace it keeps its own files in — reports, logs, spilled
tool output. Your repository stays yours.

**The model name decides the provider.** `aico -m glm-4.6` goes to Z.AI even if
your default is OpenRouter, and `aico -m kimi-k3` goes to Moonshot. You do not
have to switch anything first.

```sh
aico -p "why does the build fail on windows?"   # one question, no session
aico -c                                          # carry on from last time
aico --agent review -p "review my diff"          # a read-only reviewer
```

---

## The web client

```sh
aico serve
```

It prints a URL with a token in it and opens your browser. **The token is not
decoration** — this server runs commands and edits files, so reaching the port is
deliberately not the same as being able to drive it. It binds to `127.0.0.1`
only.

The run belongs to the server, not to the page. Close the tab mid-turn and the
work carries on; reopen it and the session replays from its log — real tool
results, real sequence numbers, nothing reconstructed.

**Chat** is the conversation. **Trajectory** is the same session read as an event
ledger, which is where to go when you want to know exactly what happened and in
what order.

Tool rows are one line each until you click them. The right-hand end of the row
carries the outcome:

| You see | It means |
|---|---|
| `works` / `3 problems` | A browser check passed, or found things — worst one shown inline |
| `…/src/api` | Where a `Terminal` command left the shell |
| `running · pid 4321` | Started in the background and still going |
| `failed` | It did not work. No diff is drawn for a write that did not happen |

If you live in VS Code, the extension in `vscode-extension/` gives aico a tab of
its own beside Chat, rendering these same tool cards and diffs in your editor's
colours. Four things change:

- an edit lands as a **workspace edit**, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> takes it
  back and Source Control shows it;
- the file you have open, the lines you have selected and that file's Problems
  ride along with your question, shown as chips before you send;
- `#` in the composer points at a file or a symbol without leaving the keyboard;
- tool approvals are real dialogs, with a selector for how much to ask.

The README has the build steps — it is not on the Marketplace yet.

---

## Planning something first

For anything you would rather agree on before it happens, turn **Plan** on in the
composer and describe the work.

The turn cannot change anything — the write tools are genuinely absent, not
discouraged. The agent reads around, then puts a plan on the right of the screen
with its steps, the files each one touches, the risks, and **what it had to
assume**.

Read the assumptions first. They sit above the steps on purpose: an assumption
you would have corrected costs you a sentence now and a rewrite later.

Then answer it:

- **Go ahead** — planning switches off and the work starts. You do not have to
  turn the mode off yourself.
- **Amend** — puts the plan in the composer so you can say what to change in a
  sentence. Planning stays on, so you get a revised plan rather than a
  half-built one.
- **Later** — keeps it without starting it. The card stays, with a **Start it
  now** button for whenever you come back.
- **Decline** — closes it.

The card collapses to a single line once you have answered, and remembers what
you decided. Reopen the session tomorrow and it still says *approved*.

### Long jobs

When the agent estimates a request at more than three hours of work (in any
mode; `longJobs.thresholdHours` changes the line), it stops before doing any of
it and shows a **Long job** card instead: research and requirements, the
design, milestones with acceptance criteria, the time and cost estimate, and a
budget cap. Nothing that writes or runs commands happens in that chat until you
press **Approve and start** or **Decline** on the card — typing "go ahead" does
not approve it.

Once approved it works milestone by milestone across turns. A milestone closes
only when the project's checks pass and each acceptance criterion has its
evidence. It stops when every milestone is done or the budget or time cap is
reached, and pauses if you cancel a turn, a turn fails, or four turns pass
without progress. **Pause**, **Resume** and **Stop** are on the card; Activity
shows the current milestone and spend. A restart resumes the job from its
journal under `~/.aico/long-jobs/`, and a report with the evidence is written
next to it when the job ends.

---

## When it pushes back

If you asked for something that runs in a browser, the turn will not call itself
finished until it has actually opened the thing.

You may see it stopped and told:

> *You built index.html but never opened it. Reading the source you just wrote is
> not verification — a page can look right in source and throw on load, render
> blank, or have controls that do nothing.*

or

> *index.html loads without errors, but nothing was actually operated — it has 21
> interactive controls and the check exercised none of them.*

or, if your brief listed behaviours:

> *Nothing verified: Export to PDF triggers a building-up animation of the layout
> sheet.*

This is the harness, not the model being cautious. It is trying to stop you being
told a page works when it does not. If you would rather it did not, put
`"completionGate": { "enabled": false }` in your settings — but the failure it
catches is the one that is hardest to notice, because a broken page and a working
one look identical in a transcript.

**Write your brief as a list.** Bulleted behaviours — *"Switch between floor plan
and 3D with a camera swing"* — are read out as requirements and checked. A wall
of prose is not, and neither are things no click can prove, like a colour
palette.

---

## Running servers and long commands

Just ask for it. `npm run dev`, `python -m http.server`, `node server.js` — these
are detected and started in the background, and you get the pid and the URL back
immediately.

```
Started in the background — this looks like a dev server. It is still running as
pid 41820 and printed http://localhost:8099.
```

The agent can then verify against that URL. Stop it with `kill <pid>` when you
are done; everything still running is killed when aico exits.

For a slow build or install, raise the timeout rather than disabling it —
`timeout` is in seconds and caps at 30 minutes. There is no unlimited, on
purpose.

---

## Knowing what is still running

Everything long-lived goes into one place: sub-agents, background agents,
backgrounded shell commands, app servers, scheduled runs and watchers. When
there is something in flight, or something finished while you were away, the
agent is told about it at the start of the turn — and when there is nothing, it
is told nothing at all.

```
❯ what's still going?

  bg:84bf0996  [running]  agent  refactor the auth module
    ran 4m · 22 step(s) · $0.31 · now: Edit
  proc:41820   [running]  process  npm run dev
    ran 12m · pid 41820
```

Outcomes stay listed until they are acknowledged. Reading does not clear them,
which is deliberate: a background job that failed at 3am should still be there
in the morning, not lost to whichever turn happened to glance at it.

### Background agents report back

A background agent (or a sub-agent started with `detach`) sends its full report
back into the chat that started it when it finishes, fails or is stopped — shown
as a note from the background agent, not as something you said. If the turn that
started it has already ended, the chat starts a short turn to read the report;
turn that off with `"agents": { "wakeOnResult": false }` and the report waits at
the top of your next message instead. A backgrounded shell command reports its
exit code and last lines the same way, without starting a turn.

Background agents work in your folder with your limits — plan mode, the tools
you allowed, the session budget — and only your chat can see or stop them. Stop
in the composer stops them too. You can ask a finished one a follow-up ("ask the
researcher to also check the tests"): it continues with everything it already
knew. If AICO restarts while one is running, it carries on afterwards (within 24
hours, `agents.resumeAfterRestart`), without re-running whatever it was in the
middle of. At most six agents run at once per chat (`agents.maxConcurrent`);
more wait their turn.

### Limits the platform enforces for you

Rather than remembering to check on something, put a limit on it:

```
Give that background agent a $2 ceiling and stop it if it goes ten minutes
without doing anything.
```

`deadlineMs`, `maxCostUsd`, `maxSteps` and `idleMs`, with an action of *report*,
*stop* or *kill*. Idle is deliberately separate from a deadline — an agent that
has worked hard for an hour and one that has made no call in ten minutes are
different problems, and a single timeout kills the wrong one.

### Waiting without burning turns

Asking an agent to "wait for the build" means it runs a command, sleeps, and
runs it again — a full turn and a full prompt per check. Instead it can register
a watcher and stop:

```
❯ start the build and tell me when it's done

  Watching dist/bundle.js — you will be woken when it appears.
  (turn ends; nothing is being polled)

  → dist/bundle.js appeared
```

Watchers cover files, processes, HTTP endpoints, commands, log patterns and
other work. The wake arrives at the next step boundary, so nothing the turn has
already learned is thrown away.

### The morning brief and monitors

Every morning (08:00 local by default; Settings → General → Morning brief)
AICO prepares a short brief on Home — desktop and web — with what needs you
first: calls waiting in the inbox, long jobs, background and scheduled runs
that failed or finished overnight, and, through the `gh` CLI if you are signed
in, PRs waiting for your review, your PRs with failing checks or changes
requested, new issues assigned to you and failed Actions on the default branch.
New high/critical dependency advisories (audited at most once a day), stale
branches and uncommitted work come after. Gathering uses no model; one call to
the cheapest model of your provider ranks the items and writes two sentences
(titles only, secrets redacted; turn `brief.useModel` off for none). Nothing
to say means no call. Calendar and email are read only from MCP tools you name
in `brief.mcp` (for example `[{ "server": "calendar", "tool": "list_events" }]`).

Each item has one-click actions — open the PR or run, open the chat, review in
the inbox, or **Start a fix**, which opens a new chat in that project with the
prompt filled in and *not sent* (the composer is scrolled into view and the card says so). The
same advisory in several projects is one row with the projects as chips; **Fix all**
(per advisory, per project, or the whole section) shows a plan first and, once you
confirm, starts one background task per project on its own `fix/advisory-…` branch —
never the default branch, nothing pushed — skipping any project with uncommitted
changes. Uncommitted changes and stale branches offer **Review**. Otherwise the brief
only reads; nothing acts until you click. Earlier briefs are under **History**.

**Monitors** are opt-in per project (the card's **Monitors** table): CI on the
default branch, new review requests, new critical advisories. They poll
quietly — every 5 minutes, stretching to 30 when nothing changes and backing
off to an hour when `gh` is unreachable — use no model, and notify only when
something changed. Alerts during quiet hours (`brief.quietHours`, 22:00–07:00)
wait until they end.

---

## Operating your servers

Store a credential for your server once (Credential Manager, or `aico vault add
nas-root -k ssh-password --host 10.0.0.5 --username root`), then ask in plain
words: *"install Grafana on 10.0.0.5 and set it up"*. The agent uses the
credential by name — `SshExec`, `SshCopy`, `SshTunnel`, `HttpRequest`,
`WinRmExec` (Windows), `SnmpQuery` — and never sees its value. Passwords for the
accounts it creates are generated into the vault, written to the server's own
config files (mode 0600), and reused later by name, including by the desktop
browser to sign you in.

You are asked before: the first connection to a server (you see its host-key
fingerprint), anything destructive (deletes, drops, stopping services, firewall
or SSH changes, reboots), SNMP writes and HTTP DELETEs. A server whose host key
changed is refused outright. Long installs run in the background — `Supervise`
lists them, like everything else running. Details:
[docs/security/ops-tools.md](docs/security/ops-tools.md).

---

## Packages, secrets and tests: what aico checks in its own changes

Three things a coding agent gets wrong under pressure are checked in code, not
asked for in the prompt (ADR 0033):

- **Packages.** Before an install command runs, aico asks the public registry
  (npm, PyPI, crates.io, the Go proxy, NuGet, Packagist, RubyGems) whether each
  package it names exists. A name that does not is refused — models invent
  plausible names, and an attacker can register one. A package published in the
  last 30 days, with almost no downloads, one letter from a popular name, or
  installed from a git repository or URL needs your approval (and is refused
  when nobody is watching). With no network, or a private registry set in
  `.npmrc`, `PIP_INDEX_URL`, `GOPROXY` and the like, the check steps aside with a
  note. Switch it off or change the age in your own settings only:
  `{ "supplyChain": { "packageCheck": true, "minAgeDays": 30 } }`. Maven and
  Gradle edits, and lockfile installs, are not covered.
- **Secrets and unsafe code.** Before a turn may finish, what it wrote is
  scanned for secrets and high-severity mistakes (JS/TS, Python, Go, Java, PHP,
  C#), even in a project with no checks; the model is sent back with file:line
  and the fix. A commit that adds a secret is refused — through the `Git` tool,
  app commits, or `git commit` in a shell. Waive a deliberate line with
  `security-allow: <rule> — reason`. `completionGate.changeSafety: false` (your
  own settings) turns the review off.
- **Tests.** A test that got weaker this turn — deleted, fewer assertions, a new
  `.skip`, a weaker check, a changed expected value after a failing run — is
  named, and the model must restore it or tell you why. Unattended runs
  (background agents, scheduled work) cannot delete or skip a test without you.

These are heuristics, not proofs: a package that exists and is old is not
thereby safe, and the code rules are patterns, not analysis.

---

## MCP servers, and trusting a project

Every MCP tool call goes through the same checks as aico's own tools: hooks,
plan mode, an agent's tool list and — in `ask`/`edits` mode — a prompt before it
runs. aico assumes a server's tools can change things (servers describe
themselves, and that description is not trusted). If a server only reads, say so
and plan mode and read-only agents may use it:

```jsonc
{ "mcpServers": { "docs": { "command": "npx", "args": ["some-docs-server"], "readOnly": true } } }
```

A project's own `.aico/settings.json` (or `settings.local.json`) that defines MCP
servers, hooks or environment variables runs nothing until you approve it: the
terminal asks when you start `aico` in that folder, and the web portal and the
desktop ask on the first chat. You are shown the exact commands. A change to
them asks again; one-shot and scheduled runs skip them and say so. An agent's
tool list can name MCP tools — `mcp:github`, `mcp:github:create_issue`,
`mcp__github__*`, or `MCP` for all of them — and a sub-agent never gets more
tools than the agent that started it.

---

## Letting another AI use aico

`aico mcp-serve` speaks MCP on stdin and stdout, so Claude Code — or another
aico, or any MCP client — can hand it work:

```jsonc
{
  "mcpServers": {
    "aico": { "command": "aico", "args": ["mcp-serve", "--cwd", "/path/to/repo"] }
  }
}
```

Nothing listens. There is no socket and no port: the transport is the pipe the
client opened by starting the process, which is why it needs no password to be
safe — reaching it already requires being able to run programs as you.

**It is read-only by default.** Submitted work can read, search and analyse, but
cannot run commands or change files. Add `--allow-writes` to permit that.

> The reason it is not inherited from your own `autoApprove` is that consent does
> not transfer. Ticking auto-approve for your own session, with a terminal in
> front of you, is not the same decision as letting an unattended process on the
> other end of a pipe edit your repository. The posture is printed to stderr
> every time the server starts, so it is never a surprise in either direction.

What the caller gets is *delegation*, not remote control — submit a task, ask
about it, collect the result, stop it. It deliberately does not expose `Read`,
`Bash` or `Edit`: those would make aico a worse version of the caller's own
tools, and would move every safety rule aico has to the wrong side of the
boundary. Every submitted job carries a spend ceiling and a deadline and is
stopped automatically if it passes either.

---

## AICO in CI

Two jobs for a pipeline, and a record of what a change was checked against.
Design and limits: [ADR 0034](docs/engineering/adr/0034-evidence-ci-agent-flaky-tests.md).

### Review a pull request

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0, persist-credentials: false }
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- uses: suhail-akhtar/aico/.github/actions/aico@vX.Y.Z   # a release tag that contains the action
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}  # or OPENAI_API_KEY, DEEPSEEK_API_KEY, …
  with:
    mode: review
    github-token: ${{ secrets.GITHUB_TOKEN }}
    budget-usd: '2'
```

The full workflow is [`docs/examples/github-actions/aico-review.yml`](docs/examples/github-actions/aico-review.yml)
(permissions: `contents: read`, `pull-requests: write`). Copy it into your own
repository; AICO's own repository does not run it.

What it does: the model is given the diff, a list of who depends on each
changed file (computed from the project's import graph, not left for the model
to ask), and read-only file tools. It cannot run a command, write a file or
reach the network, and the process it runs in holds the model key and **no
GitHub token** — a separate step posts the result as **one comment**, updated in
place on later pushes. It ranks findings by severity, says what it could not
check, and ends with a record of what the review did. It is a comment, never an
approval, and it does not replace your required checks.

Things worth knowing:

- Use `pull_request`, not `pull_request_target`. Pull requests from forks get
  no secrets from GitHub, so the action notices there is no key and skips with a
  notice instead of failing the PR.
- `fetch-depth: 0` (it compares against the base branch) and
  `persist-credentials: false` are required. The action refuses a checkout that
  left a token in `.git/config`, because the review's file tools could read it.
- `version:` pins the AICO release; by default it is the tag you referenced the
  action at. There is no "latest".
- `budget-usd` and `timeout-minutes` are hard ceilings for the AICO step. A
  review stopped by either says so.
- Linux runners; Node 22.5 or newer.

### Fix a failing CI run (opt-in)

[`docs/examples/github-actions/aico-fix-ci.yml`](docs/examples/github-actions/aico-fix-ci.yml)
runs when a workflow named in it fails on a branch you list, and does nothing
unless `allow-fix-ci: 'true'` is set. It reproduces the failure on a clean
checkout, fixes it on a **new** branch (`aico/fix-ci-<run id>`, created by the
engine before the agent starts), and commits only if the session log shows the
failure reproduced and every project check passing afterwards. Then a separate
step pushes that branch and opens a pull request against the branch that failed,
with the change evidence as its body. It never pushes to the branch it is
fixing, never edits `.github/`, never fixes its own fix branches, and refuses
an agent that committed by itself. A failure that does not reproduce is
reported, not "fixed".

This job runs your failing commit's code with a write token, so keep it to
branches only trusted people can push to and to commits from your own repository
(the example does both). Pull requests opened with `GITHUB_TOKEN` do not start
your CI; review them like any other.

From a terminal, the same engine commands are `aico review --base origin/main`
and `aico fix-ci --log failed.log`; both print Markdown, neither pushes or posts.
Exit code 2 means "nothing to publish", not an error.

### The change evidence report

`aico evidence` prints what the session log proves about a piece of work: files
changed (+/-), every check run with its command, exit code and counts,
VerifyApp results, scans and findings, approvals a person gave and calls that
were refused, models and estimated cost, and the open items. Anything with no
record is shown as **not run** or **no record** — never inferred.

```
aico evidence                       # the project's latest session, as Markdown
aico evidence --format short        # "Verified: typecheck, test (412 passed) · not run: lint"
aico evidence --session 3fa9c1 --format json
```

In a chat, ask for a PR description or a commit message and the agent loads the
`Evidence` tool and pastes the record instead of its recollection. The `short`
form is meant for a commit body; none of the forms carries authorship or credit
lines. Limits: checks run by a sub-agent are in that agent's own log, a terminal
permission prompt (the CLI REPL) leaves no record, calls auto-approved by a
setting leave none, and the cost is an estimate.

### Flaky tests

When a test check fails and the runner said which tests, `RunChecks` re-runs
just those once. Failed then passed is reported **FLAKY**, by name — not as a
pass, and not retried until it is. Failed twice is a real failure. A test seen
flaky before is marked "known flaky" (a per-project list under the AICO home).
AICO does not skip, quarantine or edit a flaky test; the report suggests
quarantining it and leaves that to you.

---

## Keeping a shell

`Terminal` keeps one shell alive per session. Use it when state has to persist:

```
cd into a directory and stay there
activate a virtualenv
export a variable
```

Every result tells you the directory it ended in, which is how you notice a `cd`
that silently did nothing. On Windows it will also tell you when `cd` failed to
cross drives without `/d` — it reports the trap rather than quietly fixing your
command.

Servers are refused here, and pointed at `Bash`, because a server in a persistent
shell would hold it open forever and everything after it would queue behind.

---

## Steering a run without stopping it

Type while it is working and press Enter. Your message is delivered at the next
step boundary — the agent finishes the tool call it is in and then reads you.

That is usually better than stopping. Stopping throws away the turn; steering
keeps the context and changes direction.

**Stop** does stop, including the command it is running. A 45-second command ends
in about a second and a half.

---

## Projects, sessions and groups

A **project** is a directory. Sessions filed under it are the work you did there.
Open one with the **+** menu at the top of the sidebar (*Open project…*), give it
a colour and a description, and attach **custom instructions** that apply to
every session in it. The list is headed *Projects*; the row called *Scratch* is
where sessions run when no project is chosen.

A **group** is a label you make up — for work that spans directories, or for
anything you want kept together. Make one from the same **+** menu; it starts
empty. Drag a session onto a group's name to file it there, or use the row's
**⋯ → Move to group**; drop it back on its own project to unfile it. Filing never
moves the session's directory.

**Finding things.** The search box is always there and matches titles, ids,
project names and paths, and group names — "payments auth" finds the sessions
about both. **Recent** shows the last five conversations across every project
and steps aside while you search. Which sections you fold is remembered across
reloads; a first visit opens the three most active. The list is a tree for the
keyboard: arrows move, Left and Right fold and unfold, Enter opens, and `/`
jumps to search.

**App conversations** — sessions bound to an App — sit in their own section
rather than under the scratch folder, with a shortcut to the Apps screen.

A **session goal** is a standing objective for one conversation. It goes into the
prompt, so the agent keeps working toward it across turns instead of losing the
thread.

The **task panel** appears when the agent is tracking work. Watch the ratio: it
says `3/7` while running and states plainly how it finished. A list closed by
cancelling everything reads **`0 done · 5 cancelled`**, never *all done* —
because those are different outcomes and one of them means nothing got built.

---

## Wide refactors

Renaming an API used in two hundred files, adding an argument at every call
site, or moving a module and fixing its importers is one planned step rather
than hundreds of edits. The agent loads the `refactor` tools when a change is
that wide: `CodeSearch` and `CodeRewrite` match code structurally with
[ast-grep](https://ast-grep.github.io/) (so comments, strings and lookalike
names are left alone), and `Refactor` uses the TypeScript language service for
TS/JS rename, references, organize imports and move file — no editor needed.

Every change is shown as a plan first (files, counts, the first hunks) and only
the plan that was shown can be applied. Applying it is one checkpoint, then
your project's checks run; if they fail you see why, and one call
(`Refactor` rollback) undoes the whole change. ast-grep is an optional
dependency: if your platform skipped it, install it in the project
(`npm i -D @ast-grep/cli`) or put `ast-grep` on PATH.

## Delivery: a board of tasks, delivered in parallel

For work that is several independent pieces rather than one change, the project
gets a **delivery board**. The engine side (this section) is what runs under any
client; the board screens are in the clients.

**The flow.** Describe the work and the agent (in plan mode, so it can read the
code and write only the board) breaks it into tasks in the *backlog*, each with a
title, what and why, checkable acceptance criteria, a priority (1 is most
urgent), dependencies and labels (name the folders or files a task touches, for
example `src/auth`). Nothing runs yet. You promote the tasks you want to *ready*
and start the **dispatcher**; that, approving, and requesting changes are the
three things that need *you* in the AICO window (the API token alone is
refused), because they spend money or move your trunk.

**What the dispatcher does.** It runs up to *max parallel* ready tasks (default
2, at most 4). A task starts only when the tasks it depends on are **merged**
and no running task is touching the same files (it predicts a task's files from
the code graph and the task's text, then uses the files the run really
changed). Each task gets its own `git worktree` on a branch `aico/task-<id>`
under the AICO home (never inside your repository, and your checkout is never
touched), and a background agent bounded by a spend ceiling
(`safetyLimits.maxCostPerSubagent`, default $3) and a 45-minute deadline. The
agent commits locally and submits with the `Delivery` tool. It cannot push,
pull, merge, switch branches or manage worktrees. If AICO restarts, the
dispatcher comes back **paused**, and a run that was lost goes back to ready
with its branch and commits.

**The merge queue.** A submitted task is rebased onto the current trunk, the
project's checks run on the rebased tree (the same tree is never checked
twice), and the task gets an evidence report and a **risk score**: size, how
many other files depend on the change, weakened or deleted tests, secrets and
unsafe code in the added lines, and sensitive files (dependencies, CI,
authentication). It then waits in *review*. A rebase conflict or a failing check
sends it back to *changes* and the agent resumes in the same worktree with the
conflict files or the failure. **Approve** lands it on the trunk by
fast-forward (rebased and checked again first if the trunk moved), then removes
its worktree and branch. **Request changes** adds your comment and resumes the
run. If your checkout is on the trunk, landing updates its files (uncommitted
changes the merge would overwrite make git refuse; approve says so and changes
nothing). Nothing is ever pushed. The board setting `autoLandLowRisk` (off) lands low-risk work whose
checks are green without asking.

**Where things are.** The board is a journal under
`<AICO home>/delivery/<project>/board.jsonl`; branches are `aico/task-<id>`. A
branch that still holds unmerged commits (a cancelled task, say) is kept and
named rather than deleted. HTTP: `GET /api/delivery/board?project=`,
`POST /api/delivery/tasks`, `PATCH /api/delivery/tasks/:id`,
`POST /api/delivery/plan`, `POST /api/delivery/dispatch`,
`POST /api/delivery/tasks/:id/approve` and `/request-changes`,
`GET /api/delivery/tasks/:id/diff?project=`, and `GET /api/delivery/events?project=`
(an event stream of `delivery/board` frames). The design and what was rejected
are in [ADR 0038](docs/engineering/adr/0038-delivery.md).

### The Delivery screen

**Delivery** is in the sidebar (browser and desktop; it follows the open
project, with a project switcher in its header). The **board** has columns for
Backlog, Ready, Running, Review and Changes, and a thin **Merged** rail you can
open; **Blocked** and **Cancelled** are filter chips that add a column. Tasks are
numbered `#1`, `#2`… in the order they were made, and a task waiting on another
says so ("waits for #3"). A running card shows its elapsed time, what it has cost
and a link to the agent's session; a review card shows a risk badge (a coloured
spine and a word: high, medium or low) and the one-line result of its checks.

You move cards only where a person may: among Backlog, Ready, Blocked and
Cancelled, by dragging or by the card's **Move** menu (the keyboard and touch
path, which also says why a move is refused: Running belongs to the agents, and
work lands through Review, not by a drag). **Start agents** asks how many may run
at once (1 to 4) and says plainly that it spends money; **Pause** is one click.
**Plan from a brief** takes a paragraph and starts the planning chat (the link
opens it; tasks appear in Backlog as it writes them). **New task** takes a title,
details, acceptance criteria, priority, dependencies and labels.

Open a card for its **drawer**: the brief and acceptance criteria (editable while
the task is in Backlog or Ready), the files it touched (each opens the Code map on
that file), the **diff** file by file (collapsible, with line numbers), the agent's
**evidence report**, and the discussion. For a task in Review, **Approve and land**
and **Request changes** stay at the foot of the drawer; a high-risk change asks you
to confirm the landing a second time. The **Review queue** tab lists everything
waiting, riskiest first, and after each decision opens the next, so a batch is
arrow keys, read, decide. Shortcuts: `n` new task, `/` filter.

**Landing several at once.** In the Review queue, rows for **low-risk tasks whose
checks are green** have a checkbox (Space ticks the focused row; **Select all low
risk** ticks them all). **Approve and land N** is one yes; they land one at a time,
each rebased and checked again if the trunk moved. A task that no longer rebases
cleanly goes back for changes and the rest still land; if your checkout cannot take
a landing at all (uncommitted edits in the way) nothing lands and you are told why.
Medium- and high-risk tasks have no checkbox ("Open it to approve on its own"), and
the engine refuses a batch that contains one.

**When a run needs you.** Each task runs as a chat, and the card's **Session** link
opens that chat (also after the task is done). If the agent asks a question, wants a
tool call allowed, or has a call waiting in *Waiting for you*, the card shows
**Needs you** with the question and an answer box, **Allow / Deny** or **Approve /
Deny** (they use the same routes as the chat and the inbox, so the same rules apply:
in a browser, *Allow* is accepted only from a window that is showing that chat, and the
card says so and offers to open it; the desktop allows it from the window itself). The
header counts how many tasks need you and filters to them, and the desktop raises a
notification when a task needs you, is ready for review, lands or fails (under the
existing *needs you* and *background work* switches). Your own note on a task
(`Discussion`) and a note an agent leaves for a task that depends on it are part of
the thread the next run is started with.

**Releases.** The **Releases** tab lists what has landed since the last `v1.2.3` tag
and proposes the next version from the commit messages (`feat` a minor, `fix` and the
rest a patch, `!` or a `BREAKING CHANGE:` line a major), from the higher of the last
tag and your own version file; you may type another, higher version. The notes are
the tasks' titles with the checks they passed. **Create release** makes one commit
(it bumps `package.json`, `pyproject.toml`, `Cargo.toml` or a `.csproj` where there
is one, and adds a `CHANGELOG.md` section) and an annotated tag `vX.Y.Z` on your
trunk. Nothing is pushed; push the tag yourself when you are ready. It is refused,
and nothing changes, if you have uncommitted edits to a file it would overwrite.
**Deploy** shows the exact command first and runs it in your project folder: for an
AICO app, the app's own deploy script; otherwise `delivery.deployCommand` from your
AICO settings. **Roll back** creates a task that reverts that release's commits and
sends it through the same checks and review as any other task; if later work
conflicts, nothing is created and the files are named.

Two settings (in your own `settings.json`, or in a project's `.aico/settings.json`
**after you approve that file**, as for hooks): `delivery.deployCommand` and
`delivery.worktreeSetup`, a command that runs once in each new task worktree before
its agent starts (install or generate what the stack needs).

**What a new worktree gets.** Node's `node_modules`, a Python `.venv`/`venv` and PHP's
`vendor` are linked from your project, so the checks run at once; an AICO app that
declares its own install runs it once instead; .NET, Go, Java, Rust and Ruby use their
global caches. Because a link is shared, an agent's `npm install`, `pip install` or
`composer require` is refused while its folder is still a link (it would change your
checkout and every other task), and the refusal tells it to call the `Delivery` tool's
`localise` action, which gives that worktree a private copy (or, for Python and PHP,
removes the link so the agent creates its own).

### Scrum: sprints on the same board

The Delivery header has a **Kanban | Scrum** switch. Kanban is the default and does not change. Scrum
puts a time box on the same board and adds nothing else: no second app, no settings page, and switching
back loses nothing (sprints, estimates and notes stay in the journal).

**What changes in Scrum.** A **sprint header** shows the sprint's name, goal, dates, days left, points done
of points committed, a pace word (**Ahead**, **On track**, **Behind**) and a small burndown. The board
becomes the **Sprint** view: the sprint's tasks plus any work already running or in review (its Backlog
column reads "Sprint backlog"). Cards get a **story-point chip**: click it to pick 1, 2, 3, 5, 8 or 13 (any
number up to 100 is accepted through the API). The dispatcher starts **only ready tasks that are in the
running sprint**; a ready task outside it says "Not in sprint" and is left alone until it joins one or you
switch back to Kanban. Work already begun (changes requested) is never stranded by this.

**Refine the backlog.** The **Backlog** view lists what could join a sprint, by priority, with what each
item still needs ("No estimate", "No criteria", "Large (13+): consider splitting"). **Refine with an agent**
starts one planning turn that can only *suggest*: an estimate, a split into two to eight smaller tasks, or
acceptance criteria. Suggestions appear at the top as cards you **Accept** or **Dismiss**. Nothing changes
until you accept (accepting a split creates the parts, cancels the original, re-points what depended on it
and keeps the original's place in the sprint). The agent's `Delivery` tool has `propose_estimate`,
`propose_split`, `propose_criteria`, and the read-only `plan` and `sprint`; it has no action that commits,
starts or closes a sprint.

**Plan a sprint.** **Plan sprint** proposes the top-priority *estimated* items that fit the capacity,
dependencies first (a task is never planned before something it waits for; items that need the same files are
flagged because agents would take turns). Capacity starts at the mean of your last three closed sprints, or a
labelled starter value (20) when there is no history. Tick and untick freely; the capacity bar follows; an item
with no estimate can be estimated right there. **Commit** records the plan, and with "Start the sprint now" it
also starts: the sprint's tasks become **Ready** (starting the agents is still its own act, and a restart
still comes back paused). **Committing, starting and closing a sprint, and accepting a suggestion, need you in
the AICO window** (the API token alone is refused); creating a planned sprint, estimating, dismissing, saving
notes and the mode switch need only the token. Adding a task to a *running* sprint asks first: it is recorded as
a scope change and shows as a step in the burndown, never folded in silently. Closing a sprint sends unfinished
work back to the backlog (running agents are not stopped) and records the result for velocity.

**Reports.** The **daily summary** is built from the log with no model call: what landed since the previous
working day (a Monday covers the weekend), what is in progress, waiting for review, blocked (with the reason)
and waiting for you, and the pace; **Copy as text** gives a stand-up note. The **burndown** draws points
remaining against an ideal line that is flat over weekends; scope added or removed after the start is a step
and a chip. **Velocity** is points completed per closed sprint with a rolling average of the last three; tasks
that merged without an estimate count as 0 and the page says how many. Every chart has its data as a table for
screen readers.

**Review and retro.** **Review & retro** drafts the sprint review from what merged (each task's evidence summary
and acceptance criteria) with the unfinished listed, not omitted, and a retrospective from the sprint's facts
(median time from first run to landing, trips back for changes and why, flaky checks, time agents waited on
you, cost per point) plus three open questions. Both are editable markdown; nothing is saved until you press
Save and nothing is posted anywhere.

HTTP (all under `/api/delivery`, registered projects only): `GET /scrum?project=[&tz=]`, `POST /scrum/mode`,
`PATCH /scrum/tasks/:id {estimate}`, `POST /scrum/refine`, `POST /scrum/proposals/:id/accept` (a person) and
`/dismiss`, `POST /sprints`, `POST /sprints/:id/commit|start|close` (a person), `GET /sprints/:id/summary|review|retro`,
`POST /sprints/:id/notes`. The design is [ADR 0039](docs/engineering/adr/0039-connections-and-agile.md) section 4.

## Connections: your GitHub, pull requests and backlog

Delivery works on its own, on your machine. **Connections** let it meet the place your team
already works. Today that is **GitHub** (github.com, or GitHub Enterprise Server at an address
you give), Azure DevOps, GitLab, Gitea, Forgejo, GitBucket and Bitbucket (below), each one
adapter behind the same page. What you get:

- **A backlog from your issues.** Issues assigned to you, with a label, or matching a query
  become **backlog** tasks. Their title, description, `## Acceptance` checklist, labels and a
  `P1`..`P4` or `priority: high` label are read from the issue, and a later edit on GitHub
  overwrites the task's copy: **people own the issue, the remote wins.** Importing never starts
  anything: a task labelled `ready` on GitHub shows **Ready on remote** and waits for your click.
  AICO writes back only its own progress: `aico:running`, `aico:in-review`, `aico:pr-open`,
  `aico:blocked` labels, a comment linking the pull request, and it closes the issue when the
  task merges. It never edits your text or your comments. If an issue is closed upstream while a
  task is running, the task is **blocked** ("closed upstream") for you to decide.
- **Pull requests instead of a local landing.** Set a project's **Landing** to **Pull request**
  and the review card's button becomes **Open pull request**. Your click pushes the task branch
  (`aico/task-<id>`, nothing else, never forced) and opens a PR whose description is the change
  evidence. The task moves to **PR open** and AICO watches the PR: if the remote's checks fail,
  a member or collaborator requests changes, or it conflicts, the task goes back to **changes**
  with the reason and the run continues on the same branch with a **new commit** (it never
  rewrites a branch that is already on the remote). **The remote's rules are the gate**: required
  checks, required reviews and branch protection decide, and AICO never bypasses them. When the
  PR is merged on GitHub the task is merged, your local trunk catches up (fast-forward only) and
  the worktree is cleaned up. You can also press **Merge** on the card (a confirm): it shows only
  while GitHub says the PR can be merged, and GitHub can still refuse. Auto-merge, deleting remote
  branches and editing protections are yours, on the platform.
- **Plain, quiet sync.** There is no webhook (your machine has no public address), so AICO polls
  while a board is open or its dispatcher runs: issues every 5 minutes, pull requests every
  minute, with conditional requests, a rate limit of its own, and backoff. The board header shows
  the connection and **Sync now**.

### Connect a project (about a minute)

1. Open **Settings, Connections** (or the **Connections** link on a Delivery board) and choose
   **Add connection**, then **GitHub**. For GitHub Enterprise Server, switch on that option and
   enter your server's address.
2. Create a **fine-grained personal access token** (the page links to where, and lists what it
   needs: Contents, Pull requests and Issues read and write; Checks, Statuses and Metadata read;
   limit it to the repositories you will map). Paste it. It goes into the credential vault bound to
   that host; the page, the log and the agent never see it again.
3. Press **Test**. You see who the token acts as, what it can do, the permissions it is missing
   (in red) and any power it has beyond what is needed (a warning). Fix the token and test again.
4. **Use for this project.** The repository is read from the project's `origin`; confirm it. Pick
   **Landing** (Local or Pull request: a confirm card explains the engine will then push), **Work
   items** (Off, Assigned to me, Label, Query) and, only if your team uses other names, the seven
   state names. A server with a private certificate authority gets its CA file under
   **Advanced**; certificate checks are never turned off.

You can also say it in a chat: *"connect this project to our GitHub, import the issues labelled
aico, and open PRs"*. The agent's `ConnectionManage` tool creates the connection and maps the
project, and tells you to paste the token on the page: **it cannot store or read a token, change
the host later, or switch pull-request mode on** (it asks you to).

### GitLab, Gitea, Forgejo and GitBucket

Same page, same four steps; pick the tile. A server you run takes its address (a private CA goes
under **Advanced**, and certificate checks are never turned off). What differs:

- **GitLab** (gitlab.com, or **Self-managed GitLab** at your server's address, also under a path).
  Create a personal access token with the `api` scope, or better a **project access token with
  the Developer role**: it cannot push protected branches and reaches one project. The Test result
  lists the token's scopes and expiry and warns about `sudo` and `admin_mode`. Nested groups work:
  enter the project as `group/subgroup/project`. Merge requests carry the change evidence; pipelines
  show job by job; GitLab's own word decides whether a merge request can be merged. When the only
  thing in the way is a running pipeline, the card offers **Merge on GitLab when the pipeline
  succeeds**: your click sets it, and GitLab then merges by itself only if every rule still holds.
  AICO never sets it otherwise. Issues bring their labels, their **weight** as story points where
  your GitLab has weights (otherwise an `sp:5` label), milestones, and **iterations on Premium**
  (without them the page says so and milestones stand in). Epics are not read.
- **Gitea and Forgejo** (two tiles, one implementation). Create a token with Repository and Issue
  read and write. These servers do not list a token's permissions, so Test checks them with real
  requests and shows what worked. Actions results show as checks. A pull request GitLab-style
  "can merge" does not exist here, so **Merge** is offered when the server says the pull request is
  mergeable, nobody is waiting on or against it, and every check it can see is green; to merge
  over a red or running check, do it on the server. A conflict is reported once a pull request has
  been unchanged for two minutes (before that it may still be checking). Sprints are milestones
  and estimates are `sp:5` labels.
- **GitBucket** (a subset of GitHub's API). Pull requests, issues, milestones and commit statuses
  work. It has no check-runs, reviews, draft pull requests, scopes or search, and each of those
  shows as a missing chip rather than a failure; the merge refuses a pull request whose head moved
  after you saw it.

### Azure DevOps (Services and Server), with your sprints

Pick **Azure DevOps**. For Azure DevOps Services give your **organization** (the name after
`dev.azure.com/`; pasting the whole address works); for a server your company runs, tick **I use
Azure DevOps Server** and give its collection address (for example
`https://tfs.example.com/tfs/DefaultCollection`). Create a **personal access token** with **Code**
(read and write), **Work Items** (read and write), **Build** (read) and **Project and Team** (read).
Azure DevOps does not list a token's permissions, so Test checks each with a real request and shows
what worked; it also warns if the token looks like a Full access token. Pick the repository as
`Project/Repository` (spaces in names are fine; the page offers the ones your token can see).

- **Pull requests.** Your **Open pull request** click pushes `aico/task-<id>` and opens a PR from it.
  Azure DevOps limits a description to 4000 characters, so the change evidence is cut there and the
  rest follows as a comment. AICO's own comments are posted as **resolved** threads, so they never
  trip a "resolve all comments" policy. Whether a PR can be merged comes from its **branch policies**
  (minimum reviewers, required reviewers, build validation, comment resolution, work item linking):
  **Merge** is offered only when the merge succeeds and every blocking policy says yes; a policy AICO
  cannot fix by writing code (a missing linked work item, unresolved comments) is shown as a reason,
  not as a failing check. If your token cannot read policies, AICO does not guess: it says so and you
  merge on Azure DevOps. AICO never bypasses a policy and never deletes the source branch.
- **Work items.** Import **assigned to me**, a **tag**, or a **WIQL condition** (the part after
  `WHERE`; Epics, Features and test items are never imported). Titles, descriptions, acceptance
  criteria and tags are read and a later edit on Azure DevOps wins. AICO moves an item **forward only**
  by state category: a running task moves it to the type's own *InProgress* state (Active, Committed,
  Doing), a merged one to *Completed* (Closed, Done), whatever your process calls them. **Settings,
  Connections, Use for this project, State names** previews what each AICO state becomes for each work
  item type of your Agile, Scrum, CMMI, Basic or custom process. Blocked is the tag `aico:blocked`. The
  PR is linked to the work item with a real link.
- **Sprints (opt in).** Tick **Mirror Azure DevOps iterations as Scrum sprints** and the team's
  **current and next iteration** arrive as planned sprints with Azure DevOps' name and dates (it owns
  both: a rename or a moved date is pulled in). Tasks follow their work item's iteration and
  **Story Points** (or Effort, or Size); if you plan a task into a sprint or estimate it here and the
  platform has not changed it, AICO writes that decision back once; if the platform changed it,
  the platform wins. AICO never starts a sprint, never closes one because the platform ended it, and
  creates an iteration on Azure DevOps only when you ask for it. GitHub milestones and Projects
  iterations work the same way (a Projects iteration is read, not written: set it on the board).
- **Older servers.** AICO speaks REST 7.1 and, for a server, tries 7.1, then 7.0, then 6.0 until the
  server accepts one (Azure DevOps Server 2019 or newer). An older server loses features (a policy or
  iteration API it lacks becomes a warning), not the connection. An expired token shows as **Sign in
  again**.

### Bitbucket Cloud and Bitbucket Data Center

Pick **Bitbucket Cloud** (bitbucket.org) or **Bitbucket Data Center** (your server's address,
also under a path like `/bitbucket`). These are **pull-request and build-status connections, not
planning ones**: Jira is not supported, and Bitbucket has no sprints, so AICO's sprints stay on
your machine. The Test result says so.

- **Cloud.** Create an **Atlassian API token** with the scopes the page lists (repository and
  pull request read and write; pipeline read) and enter it **with your Atlassian account email**;
  or create a **repository, project or workspace access token** and leave the email empty.
  (App passwords no longer exist.) Pull requests carry the change evidence. Cloud does not say
  whether a pull request merges cleanly, so **Merge** is offered only when it is open, not a draft,
  its builds are green, nobody asked for changes, and someone approved it (or the required number
  did, when your token can read the branch restrictions); Bitbucket can still refuse. Issues come
  in only where the repository uses Bitbucket's issue tracker (the **component** plays the label).
- **Data Center.** Create an **HTTP access token** with project or repository write. AICO asks the
  server whether each pull request can merge and shows the server's own reasons (required
  approvers, required builds, open tasks). **Merge** sends the pull request's current version, so
  if anything changed since you looked it is refused and you are told to look again. Builds come
  from your CI (Bamboo, Jenkins); with none, a pull request simply shows no checks. Admin rights on
  the repository let AICO read the required approvers and branch permissions; without them the page
  says "protection unreadable" and the server enforces them at merge anyway.

### Any other platform: a connector AICO builds

For Linear, YouTrack, Phabricator or an in-house tool, choose **Other** in Add connection: it opens
a chat with an instruction in the composer. Tell AICO the platform and its API docs (or an OpenAPI
file). It writes a **connector pack** (a small file of settings, a few HTTP request definitions and
recorded examples), tests it against those examples on your own machine, and tells you when it is
ready. Nothing is sent to the platform at that point and AICO never asks for your token in the chat.

Then **Settings, Connections, Connectors built by AICO** shows it. **Review and enable...** opens a
card with everything you are approving: the hosts it may contact (a closed list), how your token
is sent, and every operation grouped by what it can change: *reads*, *writes* (comments, status
changes, new pull requests) and *cannot be undone* (merge, which only ever runs from your click).
Where AICO raised an operation's class above what the file claimed, it says so; operations whose
test failed stay off. **Enable** approves exactly that content. **If anything in the connector is
edited later, by anyone, it switches itself off ("Needs re-approval") until you review it again.**
After enabling, **Add a connection** makes the connection, you paste the token (it is bound to those
hosts in the vault) and press Test, like any other.

A connector is weaker than a built-in one: it has no labels (progress shows on the pull request and
in comments), no branch-protection read, no sprints, and "can merge" is whatever the platform
reports, narrowed (never a draft, a failing check or a requested change). An organisation can
forbid connectors (`connections.packs: "forbid"` in the managed policy) or limit them by host.

### Limits, said plainly

- **Your token decides what works.** A token without permission for branch protection shows
  "protection unreadable"; one without pull-request write cannot open PRs. The Test result says
  which.
- **PR mode gives up a linear task branch.** Once a branch is on the remote, a moved trunk is
  merged into it rather than rebased; your platform's squash or rebase merge makes the trunk
  linear again.
- **Pull requests from forks, reassigned issues, Projects v2 writes and creating repositories or
  protections are not handled.** Iterations and milestones are read for Scrum; the page shows
  what it found.
- **Managed policy.** A `connections` rule (see "For organisations") can forbid connections,
  limit providers and hosts, or keep Delivery local; the page says so and sends nothing.
- **Nothing reaches the platform in local mode.** A project with no connection, or landing set to
  Local, behaves exactly as before: nothing is pushed.

## The code map

AICO keeps a dependency graph of each project — which file imports what,
which files use each exported symbol (through `@/` aliases, barrels, renamed
re-exports and namespaces, never confusing two functions that share a name),
and which files change together in git history. It costs no model tokens,
lives in the AICO home rather than your repository, and refreshes itself.

- **See it:** desktop — a project's **Code map** tab, "Show in code map" on a
  file, or `Ctrl+Shift+M`; web — **Code map** on a workspace page. Views:
  **Architecture** (the first view: folders as boxes, what depends on
  something above it, with the number of imports on each link and cycles in
  red; click a folder to open it, **Esc** or the breadcrumb to go back),
  **Focus** (one file in the middle, the files that use it on the left, the
  files it uses on the right, two hops out; click any box to refocus, Esc or
  Alt+← to go back), the old force **Overview**, files, impact of a file or
  symbol by depth, the path from one file to another, import cycles,
  hotspots, co-change, and what your uncommitted change affects. Drag to pan,
  scroll or pinch to zoom, **0** fits, **F** focuses the selected file, `/`
  searches files and symbols, Enter opens the file (arrows pan in
  Architecture and Focus, and walk the edges in the others).
- **Ask about it:** select files, a symbol, a path or an impact and press
  **Ask AICO about this** — a chat starts with exactly that context.
- **Methods too:** calls are linked by the receiver's type wherever the code
  states it (a constructor, a typed parameter or field, a declared return
  type), so a method's symbol view lists exactly its callers — never those of
  a same-named method on another class. For TypeScript the TypeScript checker
  does this when it is installed (the map says which); in very large projects
  the symbol you look at is resolved exactly on demand ("exact (on demand)",
  or "partial" if it takes longer than 8 seconds — ask again). Calls through an
  interface are marked **via interface**; an interface's details list the
  types that implement it and why (for Go, the exact method set — a pointer
  receiver means only `*T` satisfies it). The **Exact only** filter hides
  everything that rests on an interface or a unique name.
- **Open a file:** in the web client, a file opens in VS Code at the line, or
  in the editor you set with `editor.command` in your settings (e.g.
  `"editor": {"command": "cursor -g {file}:{line}"}`, `idea --line {line} {file}`,
  `subl {file}:{line}`); with none available it opens in the client's own
  viewer at that line. The desktop opens files in its editor and offers
  **Open in external editor**.
- **The agent uses it:** asking about callers, usages, impact, a rename or the
  architecture gives the agent the `CodeGraph` tool, and when it changes an
  exported function's or method's signature, the edit's result lists the files
  that still call it the old way — even on the first edit of a project that
  was not indexed yet (the list follows as soon as the graph is ready).
- **Rules:** layering rules — files matching `from` must not depend on files
  matching `to` — come from your settings (`codeGraph.rules`, or
  `codeGraph.projects["<path>"].rules`), the project's `.aico/settings.json`
  and a committed `.aico/codegraph.json` (`{"rules": [{"from": "src/ui/**",
  "to": "src/db/**", "reason": "UI goes through the API"}]}`). They add up: a
  project can add rules, never remove yours. Violations show in the map and
  the agent's overview.
- **In your morning brief:** for projects you have indexed, the brief lists new
  import cycles, newly broken rules, sudden hotspots and files nothing uses any
  more, with **Show in Code map** and **Ask AICO to fix**. Switch on the
  **Code** monitor for a project (brief → Monitors) to hear about them right
  after the change.

## Sheets, and everything a chat made

Ask for a spreadsheet ("make a BOQ sheet with quantities × rates and
totals") and the agent builds a **sheet** beside the chat: a live grid with
Excel formulas (SUM, AVERAGE, COUNTIF, SUMIF, IF, ROUND, VLOOKUP, XLOOKUP,
TEXT, DATE, TODAY and more, across sheets too), number formats (number,
currency, percent, date), a frozen header, fills and conditional fills, and
charts drawn from a range. Edit it like Excel: type, F2, Enter/Tab, arrows,
paste straight from Excel or a CSV, Ctrl+D to fill down, insert and delete
rows and columns, sort, filter, undo. Every formula recomputes as you type;
an error shows Excel's code with the reason (a circular reference names the
loop). The agent changes only the cells it means to, and if you are editing
at the same time your edits are kept on top of its.

**Export** gives a real `.xlsx` (formulas with their values, formats, widths,
the frozen header and conditional fills — it opens in Excel) or a CSV;
**Import** turns a `.xlsx` or `.csv` into a new sheet. Charts stay in AICO —
they are not written into the `.xlsx`.

Ask for a **presentation** ("a 10-slide pitch deck for…", "a status deck for
the steering committee") and the agent plans the slides for that kind of deck,
then fills them: titles, bullets, two columns, comparisons, charts, Mermaid
diagrams, tables, big numbers, timelines, quotes and speaker notes. You edit
the content — the layout, spacing and text size are worked out for you, and
anything that will not fit is outlined in red with the reason. Pick one of 12
themes, drag slides to reorder, **Present** (F5; arrows, B for black, S for
the presenter view with notes, next slide and a timer), and **Export** a
`.pptx` whose text, tables and charts stay editable in PowerPoint, a PDF, or a
PNG per slide.

**Artifacts** (desktop: the button beside Share) lists what the chat made or
opened — documents, sheets, code, exports, generated images and attachments —
grouped by type or by topic (an export sits under the document it came from).
Open a canvas, **Open beside** to put a document and a sheet side by side,
rename, export or download, and **Show in chat** to jump to where it came
from. The web client shows the same list in the side rail.

### Design boards: clickable mockups

Ask for a **mockup**, prototype, wireframe or UX flow ("mock up the screens
for a team notebook: today, a workspace, a document, settings") and the agent
builds a **design board**: real HTML screens laid out as titled frames under
section headings ("Today and the start", "Making things"), on a canvas you
zoom and pan. It appears in **Artifacts** as a design board (in the web
client, click it in the side rail and it opens over the whole window).

- **Look around.** Wheel or pinch zooms toward the pointer; drag the canvas,
  hold Space, or pick the hand tool (H) to pan. − / + step the zoom, the %
  goes to 100%, Fit (Shift+1) shows the whole board. Only the screens in view
  load, so a big board stays quick.
- **Play** (the button on a frame, a double-click, or Enter on a selected
  frame) opens that screen at its device size. Its links and buttons open the
  board's other screens, so you can click through the whole flow; ← → step
  through the board, Esc goes back.
- **Present** walks every screen in order, full screen.
- **Notes.** Pick the note tool (N) and click to pin a note — on a screen or
  on the board. The agent reads your notes with the board, so "address my
  notes on the board" works.
- **Download** a screen as one self-contained HTML file (the frame's download
  button), or **Export** the board as a PDF (a page per screen), the selected
  screen as PNG, or the whole folder as a zip whose screens open in any
  browser and still link to each other.

Screens run in a sandbox with no network: they cannot reach AICO, your files
or the internet, and a link that does not lead to another screen of the board
does nothing (the board says so). The boards live in the chat's artifacts
folder under `boards/`.

## In VS Code

aico is a tab of its own in the Secondary Side Bar, beside Chat — a native
panel, not the web portal in a frame. Install the `.vsix` attached to a
release, reload the window, and open a folder: a session's log is filed under
one and its file tools are confined to it.

What changes inside the editor: your selection and the active file's Problems
arrive as removable chips; `#` names another file or symbol; edits land as
`WorkspaceEdit`s so Ctrl+Z takes them back; approvals are real dialogs; and the
agent can read your Problems panel (`VSCodeDiagnostics`) and run your
`tasks.json` tasks (`VSCodeTasks`) — tools that only exist while the editor is
attached. The full write-up is on the
[VS Code page](https://suhail-akhtar.github.io/aico/vscode.html).

## Building an app

**Apps** in the bottom navigation is where applications live: not files in a
repository you brought, but things aico keeps in its workspace, starts, serves
and deploys. Turn the host on once under Settings → Apps.

**Create app** asks one question first — what do you want to build? Write it
the way you would brief a colleague: who uses it, what they do most often, what
must be true when it is done. As you type, the templates are ranked against your
words and the best match is named with the words that matched. Eighteen templates
ship (nine for Node, listed here, plus the starters below): a records page over SQLite that needs no install, a static landing page, a
JSON API, a full web application with accounts, a metrics dashboard, a
documentation site, a command-line tool, an LLM agent service, and an Expo
mobile app. Each copies in as files with a worked feature, tests, notes for the
agent and a deploy script; nothing is generated, so the skeleton costs no
tokens. Take the best match, browse *See all templates*, or *Let the agent
choose and start*. Your brief becomes the first message of the conversation.

Beyond those nine, the catalogue has starters for Python, Java, .NET, Go and PHP
and a React frontend. Three ready-made system bundles (frontend, API, database, sign-in and a gateway that start together) go from small to large: system-small, system-medium and system-large (the last is deployment code for the medium app, validated statically, not applied to a cluster).
A card says what it needs installed, checked on your machine for real (`go
version`, `java -version`), and when the toolchain is missing but Docker is
running it says so and can run the app in a container instead — only when you
choose that (*Start in Docker*). Every app has its own git history: a scaffold
commit naming the template, one Conventional Commit per finished story (a turn
that changed source cannot end with the app uncommitted), a `v0.1.0` baseline
tag when the first iteration passes its checks, and releases that bump the
version and CHANGELOG. Tagging asks for your approval and nothing is ever pushed.

That conversation is bound to the app, and the app sits beside it. **Preview**
is the app itself, at desktop, tablet or phone width, reloaded when a turn ends.
**Backlog** is the plan the agent wrote from your brief — stories with a *Done
when* line each, and the next one a click from being built. **Decisions** is
where design choices are recorded so they survive a long session. **Files** and
**Logs** are what they say. Start, Stop, Deploy and Open sit in the panel's
header.

What holds the agent to the plan: a story is done only when its checks are green
and the app was opened in a real browser and the *Done when* line was seen to be
true. The turn cannot end as finished before that. A `process` app — anything
with its own server — runs code the agent wrote with your permissions on a port
of its own; it cannot reach aico's API, but it is the trust you extend to any
repository you clone and run.

From the terminal the same things are `/app templates`, `/app new <template>
"<name>" --brief "…"`, and `/app list|start|stop|deploy`.

## Teaching it a correction

When a reply misses, rate it **▼** and say why. **Remember this** turns your note
into a knowledge entry: *when* is built from what you asked, *then* is your note.
Read both, edit if you like, keep it. From then on any task whose wording matches
the trigger is shown the guidance before the agent starts.

It is filed with the project by default. Tick *Every project* only when the
lesson is about you rather than the code — a convention stored globally follows
you into repositories where it is wrong.

You do not have to catch everything yourself. After each turn aico reads its own
log for the signals a review would look for — a rating with a note, a message
you sent mid-turn to steer, a fix that followed a failing check or browser
verdict, an error that repeated — and files each as a **proposal** under
Settings → Memory → Suggested. Nothing is adopted on its own: read it, edit the
trigger or the text, and *Keep* it, or *Dismiss* it. Kept proposals become
knowledge, a project fact such as "this project uses npm", or a line in
`~/.aico/USER.md`, which holds at most twelve short things about how you like to
work. Design decisions the agent settles while building go to
`.aico/decisions.md`, and a session that compacts keeps that file and writes the
dropped detail to a report it names in the summary.

### What AICO learned about how you work

Some corrections are not about a task but about you: "no, use pnpm", "never use
`var`", the file you re-indent with tabs a minute after the agent wrote it, the
package manager you pick every time. aico notices these — a rating with a note,
a correction in your message, a hand edit to something it just wrote (kept as a
short diff summary, never the file), a choice you repeat — and a small, cheap
model call turns them into short **rules** such as *Use pnpm, not npm.*, each
scoped to everywhere, one project, or one language, with the evidence linked.

Every rule starts **proposed** and does nothing until you accept it under
**Settings → What AICO learned** (desktop and web). There you can edit, disable,
forget (it will not be proposed again), add your own, or export them all. A rule
that contradicts an accepted one says what it would replace; the old one stays
in force until you accept the new one. Accepted rules that fit the current
project are added to each request — at most about 400 tokens, most relevant
first. Turn on *Auto-accept low-risk style rules* to skip the click for
formatting-only rules; anything about tools, commands or permissions still waits
for you. *Learn how I work* off stops all of it.

## Choosing a model

The picker sits in the composer and lists the active provider's models. What you
pick applies to that session from your next message.

Practical notes from real use:

- Some models stall for minutes at a time. The activity line tells you —
  *"nothing for 2m 16s — the model has not replied yet"* — so you can tell a
  slow model from a hung one.
- Cheap and thorough is a real combination. A 40-step run on an inexpensive model
  can cost seven cents and produce more than a six-step run costing sixteen.
- A fast, cheap answer can also be a thin one. If the result seems small for what
  you asked, it probably is — which is what the requirements check is for.

Ceilings live in Settings: context, spend per session, and permission mode. A
spend ceiling is the honest way to try an expensive model.

**Reasoning effort** is the *Think* control beside the model picker, in the web
composer and the VS Code panel alike. It offers only the rungs the current model
has, and *Auto* says what the provider does when nothing is sent — adaptive on
Claude and Gemini, `high` on DeepSeek, `max` on Kimi K3. Pick a rung on one
model and switch to another that lacks it, and the button shows the rung that
will actually be sent. What Auto means for a provider is yours to set: each
provider card in Settings → Models has an *Auto reasoning* control.

**The context meter** under the composer is the window the model is being run
against, and it says where the figure came from — reported by the provider,
from the built-in table, set by you, inferred from use, or assumed. Assumed is
the one to look at: it means nothing knew this model, 128K was taken as a
guess, and compaction is running against that guess. Click the meter and type
the real figure (`1m`, `200k`); *Forget* hands it back to detection. If a
prompt larger than an assumed window goes through, the figure is raised on its
own and a line in the conversation says so.

You can also just tell the model. It has a `ContextWindow` tool: it can read
the figure and where it came from, and record one you give it. It will not
record its own guess — models are reliably wrong about their limits — and it
refuses anything smaller than a prompt it has already been seen to accept.

**Which model does which job.** Below the providers, Settings → Models lists
every job AICO runs a model for — helpers, titles and the brief, the safety
reviewer, the judge, vision, summaries — with the model, where it runs, its
price, and why it is that model. *Balanced* keeps today's behaviour; *Economy*
moves research and review helpers to the cheap model; *Private* keeps the jobs
that read your own data on a local model. Set a vision model there and a
text-only chat model is told what your screenshots show. `/doctor` lists any
job whose choice could not be used.

---

## For organisations: a managed policy and an audit trail

AICO is one person's tool on one person's machine, and says so: there is no
SSO, SCIM, role system, admin console or central server. What it has is the
two things an IT team can run with the tools it already owns — a **policy file**
that locks things for everyone on a machine, and an **audit export** a log
shipper can collect. See [ADR 0035](docs/engineering/adr/0035-managed-policy-and-audit-export.md)
for the decisions and the limits.

**The policy.** Put a JSON file where only administrators can write it and push
it with MDM, Group Policy, Intune, Jamf or your configuration management:

| OS | Path |
|---|---|
| Windows | `%ProgramData%\AICO\policy.json` |
| macOS | `/Library/Application Support/AICO/policy.json` |
| Linux | `/etc/aico/policy.json` |

It sits above the person's own settings and a project's: it can only
**restrict**, never grant. A full example with every key is in
[`docs/examples/aico-policy.example.json`](docs/examples/aico-policy.example.json);
check yours before you deploy it with `aico policy check policy.json`. What it
can say:

- **Providers and models** — allow-lists and deny-lists with `*` patterns
  (`claude-*`); `localOnly` to allow only models that run on the machine.
- **Tools** — `deniedTools` (names and patterns, MCP tools included). A forbidden
  tool is not offered to the model at all, and a call to it is refused before
  anyone is asked.
- **Autonomy** — `maxAutonomyLevel` (L0 plan … L4 unattended) for every run:
  chat, terminal, cron, background agents.
- **Gates** — `requiredGates` (`checks`, `security`, `verification`, `commit`,
  `supply-chain`, `change-scan`) cannot be switched off by anyone.
- **Extension points** — `mcp`, `plugins`, `customTools`: `forbid`, or an
  `allow-list` of names. Servers already configured that are not on the list
  stop being loaded.
- **Connections** — `connections` (`mode`: `any`, `forbid` or `allow-list`, with
  `providers` and/or `hosts` lists, and `maxLanding: "local"` to keep Delivery from
  ever pushing): which forges and trackers may be connected. Asked when a connection
  is made or mapped and again before every request, so a policy that appears later
  stops traffic at once; connection activity is in the audit export as kind `connection`.
  `packs: "forbid"` stops agent-built connector packs (they can also be limited by host,
  or by name in the `customTools` list as `connector:<id>`).
- **Network** — `network` allow-list or deny-list of domains for the tools that
  carry a URL (WebFetch, the browser tools, MCP tools that take a URL).
- **Spend** — `budget.perSessionUsd` and `budget.perDayUsd`.
- **The rest** — `sentinelRequired`, `telemetry: "off"` (no update check),
  `minAicoVersion`, and a `message` and `contact` shown with every block.

People see it: Settings shows "Managed by your organisation", fixed settings
are greyed out with the reason, and a blocked model or tool says which rule
blocked it and whom to ask. `aico policy show` prints the same.

**A mistake in the file is loud, not silent.** A value that is invalid takes
its most restrictive form and the problem is shown; a key this version does not
know is reported and ignored (use `minAicoVersion` to require a newer AICO); a
file that cannot be read at all **locks AICO down** — no model or tool call —
until it is fixed. `AICO_POLICY_FILE` names one more policy file for testing; it
is applied *in addition to* the system file and can only add restrictions.

**What the policy cannot do.** It is only as strong as the operating system's
protection of the file: an administrator can edit it, and anyone can run another
tool. AICO checks and reports when the current user could edit the file ("not a
lock"). It does not parse shell commands, so `Bash` can still reach any host
unless you also deny it or filter egress. Desktop plugins can still be added
from the app's own plugin screen.

**The audit export.**

    aico audit export --since 2026-10-01 --until 2026-10-08 --format cef --out audit.cef
    aico audit export --since 2026-10-01 --project /work/api --format jsonl
    aico usage --since 2026-10-01 --by model --format csv

Formats are `jsonl` (every field), `cef` (what ArcSight, Sentinel, QRadar and
Splunk's CEF add-on read natively) and `csv`. Each record has a schema version
(`aico.audit/1`), an ISO time, the OS user and a hash of the host (the policy's
`audit` section changes both), and a stable `id`, so exporting the same period
twice de-duplicates. It covers every tool call (what it acted on, whether it was
allowed, whether a person or the auto-approve switch decided, which guard
refused it), turns with tokens and estimated cost, approvals in the
approve-later inbox, credential **use** by reference name, settings and policy
changes (key names, never values), background agents, cron firings and long
jobs. It never contains file contents, prompts, assistant text or tool
results; every string is redacted again on the way out. The HTTP route
(`POST /api/audit/export`) needs a person in the AICO window. The records are
read from files on the machine, so they are not tamper-evident — ship the export
somewhere append-only on a schedule.

---

## When something goes wrong

**It stopped and said the output limit was reached.** A step was cut off. It gets
told and retries in smaller pieces automatically; if it keeps happening the task
is probably too big for one turn.

**A tool says "did not return within N minutes".** The wait was abandoned, which
is not the same as the work being stopped — it may still be running. Do not
retry the identical call; find out why it hung.

**A file edit was refused.** You will be told why: either it has not been read
this session, or it changed since it was read. Both are one `Read` away from
fixed, and both exist to stop an edit landing in a file nobody looked at.

**It compacts far too often.** Look at the context meter: if it says
*assumed*, the window is a guess and compaction is firing against it. Set the
real figure from the meter, or tell the model and it will record it. On an
OpenAI-compatible endpoint that reports its models, detection now asks that
endpoint, so this is rarer than it was — but an endpoint that reports nothing
still needs telling once.

**The cost climbs with every word on a custom endpoint.** That was a bug:
some gateways report a running usage total on every streamed chunk, and each
one was being added up. Fixed in 0.10 — if you still see it, the number is an
estimate (the meter says so) because the endpoint's prices are unknown; set
`modelPricing` in settings for the real rate.

**The agent says it cannot write anything.** Plan mode is on. Answer the plan, or
turn the toggle off.

**Nothing appears in the browser client.** The token has to be in the URL. Copy
the one printed at startup, or restart `aico serve` for a fresh one.

**You want to see exactly what happened.** Open **Trajectory**, or export the
session as Markdown. Every tool call, result and turn boundary is in the log with
a sequence number — the transcript is derived from it, so it cannot disagree.
