# Using aico

The README says what this is. This says how to work with it.

- [Five minutes in](#five-minutes-in)
- [The web client](#the-web-client)
- [Planning something first](#planning-something-first)
- [When it pushes back](#when-it-pushes-back)
- [Running servers and long commands](#running-servers-and-long-commands)
- [Keeping a shell](#keeping-a-shell)
- [Steering a run without stopping it](#steering-a-run-without-stopping-it)
- [Projects, sessions and groups](#projects-sessions-and-groups)
- [Choosing a model](#choosing-a-model)
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
per-project workspace it keeps its own scratch files in — reports, logs, spilled
tool output. Your repository stays yours.

**The model name decides the provider.** `aico -m glm-4.6` goes to Z.AI even if
your default is OpenRouter. You do not have to switch anything first.

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
backgrounded shell commands, Mini App servers, scheduled runs and watchers. When
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
Add one with the folder icon in the sidebar, give it a colour and a description,
and attach **custom instructions** that apply to every session in it.

A **group** is a label you make up — for work that spans directories, or for
anything you want kept together.

A **session goal** is a standing objective for one conversation. It goes into the
prompt, so the agent keeps working toward it across turns instead of losing the
thread.

The **task panel** appears when the agent is tracking work. Watch the ratio: it
says `3/7` while running and states plainly how it finished. A list closed by
cancelling everything reads **`0 done · 5 cancelled`**, never *all done* —
because those are different outcomes and one of them means nothing got built.

---

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

**The agent says it cannot write anything.** Plan mode is on. Answer the plan, or
turn the toggle off.

**Nothing appears in the browser client.** The token has to be in the URL. Copy
the one printed at startup, or restart `aico serve` for a fresh one.

**You want to see exactly what happened.** Open **Trajectory**, or export the
session as Markdown. Every tool call, result and turn boundary is in the log with
a sequence number — the transcript is derived from it, so it cannot disagree.
