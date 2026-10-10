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

## What is and is not guaranteed

- The firewall is a separation of **what the implementer is given**. The
  implementer agent still has a shell, and a shell can read any path the user
  can, so this is not a sandbox against a determined agent. Run the implementer
  on a machine or account that does not hold the corpus when a hard wall is
  needed.
- Coverage is what the explorer reached. Logged-in areas, server-side state,
  randomness and time-dependent behaviour are known only as far as they were
  seen. "Parity" never means "identical to the original in every state".
- The CLI adapter uses pipes. A program that needs a real terminal (an `isatty`
  check, raw mode) behaves differently. A pseudo-terminal needs the native
  `node-pty` module, which is not a dependency (a new dependency needs its own
  ADR); the PTY adapter is a recorded follow-up.
- POSIX signals do not exist on Windows: `SIGTERM` ends the process outright
  there, so a handler's output is only observed on macOS and Linux.
- Web exploration clicks and fills what it can see, with probe values, and
  stays on the target's origin unless `--follow-external` is given (a crawl
  scope, not a restriction on the operator).
- `implement` is a real model run and spends money, capped by `--budget`. The
  quality of the clone depends on the model; a strong model is advised.

## Not in phase 1

Native desktop, mobile and daemon/IPC adapters; libraries and SDKs (reflection
and type synthesis); a PTY adapter; model-guided exploration (the baseline
explorer is deterministic and free; an agent can drive the same `Sandbox`);
authenticated exploration (the operator supplies the cookies or headers).

## Consequences

- New code under `src/cleanroom/` and `aico cleanroom observe|synthesize|implement|twin`.
  No new runtime dependency. Tests: `scripts/cleanroom-test.mjs` (real local
  targets, including a real browser when one is installed).
- Exit codes of `twin`: 0 identical, 2 differences found, 1 error.
