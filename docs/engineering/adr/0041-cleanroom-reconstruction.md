# 0041 — Clean-room reconstruction: observe, spec, implement, twin-test

- **Status:** Accepted
- **Date:** 2026-10-10
- **Deciders:** owner (+ authors)
- **Related:** 0005 (browser agent safety model), 0021 (background agents), 0034 (evidence), 0038 (Delivery); `src/cleanroom/**`

## Context

The owner asked for an engine that points agents at an external software
artifact (a web app, a command-line tool, an API) and rebuilds it from its
observed behaviour alone, then proves the rebuild matches. The method that
makes this defensible, and technically sound, is the clean-room method:
whoever observes the original writes a description; whoever builds the copy
sees only the description.

## Decision

1. **Four stages, one rule between them.** *Observe* drives a target through a
   `Sandbox` and appends every step to a journal; *synthesize* turns the journal
   into a behavioural `Spec`; *implement* builds a clone from the spec alone;
   *twin-test* replays the recorded journeys on the clone and diffs. The **spec
   firewall**: the implementer is given `spec/SPEC.md`, `spec/spec.json` and a
   brief, and nothing from the observer's corpus (no screenshots, no journal, no
   target address).
2. **One `Sandbox` interface** (`start`, `inject`, `observe`, `snapshot`, `stop`)
   hides what the target is. Phase 1 adapters: headless web (Playwright over
   the browser VerifyApp already finds), command line (pipes, ANSI screen
   replay, stdin and signals), HTTP API (`fetch`, no redirects followed).
3. **State graph.** Every step is `State + Event -> State + SideEffect`; a state
   is a fingerprint (path plus normalised accessibility tree for the web,
   exit/output for a command, status/type/size for an API).
4. **Twin-test.** `recorded` mode compares the clone with what the target did
   when observed; `live` mode runs both at once. Compared: web path, title,
   text, controls, side-effect requests, measured colours and the screenshot
   (SSIM and changed-pixel share, an in-house PNG reader, no image dependency);
   CLI exit code, stdout, stderr and rendered screen; API status, type and body.
   Volatile values are scrubbed first. `parity` is identical steps over steps
   replayed, and the report says it is measured over the journeys only.
5. **Spec content is behaviour, not artefact.** Colours, fonts, sizes, radii,
   spacing and layout boxes are *measured values*; response bodies are reduced
   to a schema and one short example; frames, markup and scripts never enter
   the spec. Behaviour the observer could not pin down is listed as `unknowns`.

## Policy: neutral infrastructure (owner decision, 2026-10-10)

The owner decided that this module is execution infrastructure, in the same
class as a debugger, a packet capture or a hypervisor, and that **compliance,
licensing, authorisation and asset ownership rest entirely with the person
operating it**. Accordingly the engine contains no attestation dialog, no
blocking check on what may be observed, no asset-substitution rule and no
artificial throttling. The commands do what they are told.

The authors raised these risks before building, and they are recorded here so
the decision is an informed one and not an omission: reproducing a commercial
product's look can infringe even when every line of code is new; copying its
fonts, images or text copies protected assets; automated access to a live
service commonly breaks its terms; and bypassing certificate pinning, DRM,
licence checks or emulator detection can be unlawful in some jurisdictions.
This module does **none** of the bypassing: it observes from outside, reads no
source and decompiles nothing, and that is the whole of what it does. What the
operator points it at is theirs to decide. Nothing in AICO's other protections
changes: the credential broker, the shell confinement and the human gates apply
to anything the agent does, as they always have.

What the engine does keep, because it is provenance and not policy: every run
is journaled under `aicoHome()/cleanroom/<id>/` with its target and time, and
the AICO session log records the commands as it does for any other work.

## Amendment: closing the phase 1 limits

Phase 1 shipped with a list of limits. Each was either closed or is now stated
exactly, with the reason it stays open.

| Phase 1 limit | Now |
|---|---|
| Command-line tools ran through pipes | A pseudo-terminal adapter (`--pty`): a real terminal size, key presses, resize, and Ctrl-C delivered the way a terminal delivers it. Uses `@lydell/node-pty`, an **optional** dependency (prebuilt binaries, MIT, already shipped by the desktop app); without it the adapter says so and pipes remain. |
| No Windows signals | `signalDelivery` is recorded per run: what the platform could deliver (Ctrl-C through a pty on Windows; `SIGTERM`/`SIGHUP`/`SIGINT` on POSIX) and what it could not, so the spec states it instead of implying a handler ran. |
| The firewall only controlled inputs | A real wall around the implementer: it gets file tools confined to its workspace plus `CloneRun`, which runs the clone under the Node permission model with a minimal environment. `installCleanroomWall` denies any other tool (it only denies, like every guard). The corpus path never appears in the workspace. Still not a defence against a determined human, and the Node permission model does not restrict the network. |
| Parity measured over explored behaviour only | Coverage is measured: states and controls discovered versus tried, what was pending or skipped, and why exploration stopped. Runs resume (`--resume`) and extend instead of starting over. The twin report prints coverage next to parity. A clone can be explored too and its spec diffed against the original's (`specdiff`), which finds behaviour the journeys never touched. |
| `implement --run` untested with a model | The loop is proven with a scripted model (the wall, the workspace, the budget, the report). A real-model run has **not** been made; it costs money and waits for the owner. |
| Model-guided exploration | `--guide`: a model may only **reorder** the explorer's pending actions, under its own budget. It cannot invent actions, so the baseline stays deterministic and the guide cannot make a run unsafe or unbounded. |
| Libraries and SDKs | `library` target (Node and Python): exports are listed, called with fuzzed argument vectors, classes are constructed and their methods probed on fresh instances (a handle protocol), errors are typed, output is captured; the synthesizer writes a `.d.ts` or `.pyi`. The Node worker runs under the permission model; a call that never returns is killed. **Python libraries are probed without confinement** (Python has no equivalent switch); the spec says so. |
| Daemons and IPC | `daemon` target: readiness by log line or port, then TCP, Unix socket or Windows named pipe probes, signal behaviour, watched directories. |
| Desktop | `desktop` target on **Windows** through UI Automation in a persistent PowerShell worker (legacy WinForms panes are recognised by class name; typing and clicking use real input). Needs an interactive desktop and moves the mouse, so its test is opt-in (`npm run test:cleanroom:desktop`). **macOS (AXUIElement) and Linux (AT-SPI) are not built.** |
| Mobile | `mobile` target for **Android** through adb: `uiautomator dump` for the tree, `screencap`, `input tap/swipe/text/keyevent`, rotation, backgrounding and resuming, deep links, runtime permissions, posted notifications. System events are offered to the explorer as `sys:` controls. **Proven only against a simulated adb** (`scripts/fixtures/fake-adb.mjs`), because there is no device or emulator here; the first live run is the real check. **iOS is not built** (it needs macOS and Xcode). |

## What is and is not guaranteed

- The wall separates **what the implementer is given and can reach through its
  tools**. It is not a sandbox against a human with a shell on the same account.
  Run the implementer on a machine or account that does not hold the corpus
  when a hard wall is needed.
- Coverage is what the explorer reached, now with the figure. Logged-in areas,
  server-side state, randomness and time-dependent behaviour are known only as
  far as they were seen. "Parity" never means "identical in every state".
- Terminal EOF (Ctrl-D) cannot be delivered through a Windows pseudo-terminal.
  The test records that as a skipped case rather than passing it.
- POSIX paths (SIGHUP/SIGTERM delivery, Unix sockets) are implemented but were
  verified only on Windows, where this was built.
- The Node permission model confines the filesystem, not the network.
- Web exploration clicks and fills what it can see, with probe values, and
  stays on the target's origin unless `--follow-external` is given (a crawl
  scope, not a restriction on the operator).
- `implement --run` spends money, capped by `--budget`; a strong model is advised.

## Still not built

iOS; desktop adapters for macOS and Linux; D-Bus and other brokered IPC;
authenticated exploration beyond the operator supplying cookies or headers; a
real-model `implement --run` trial and a live emulator run of the mobile
adapter (both need the owner).

## Consequences

- New code under `src/cleanroom/` and `aico cleanroom observe|synthesize|implement|twin`;
  `CloneRun` in `src/tools/clone-run.ts`, in a hidden deferred tool group loaded
  only by a clean-room brief (so the always-sent schema budget is unchanged).
- One optional dependency, `@lydell/node-pty`.
- Tests: `cleanroom-test.mjs` (real local targets, a real browser when one is
  installed), `cleanroom-wall-test.mjs`, `cleanroom-library-test.mjs`,
  `cleanroom-daemon-test.mjs`, `cleanroom-mobile-test.mjs` (simulated adb), all
  in `npm test`; `cleanroom-desktop-test.mjs` is opt-in.
- Exit codes of `twin`: 0 identical, 2 differences found, 1 error.
