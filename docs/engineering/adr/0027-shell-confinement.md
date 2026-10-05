# 0027 — Confine shell commands: writes outside the project, downloads, global installs and running what was downloaded need a person

- **Status:** Accepted (2026-10-05)
- **Date:** 2026-10-05
- **Deciders:** owner (+ authors)
- **Supersedes / related:** [0002](0002-guards-only-deny.md) (guards only deny), [0005](0005-browser-agent-safety-model.md) (buying/sending need a person), [0011](0011-approve-later-inbox.md) (the inbox), [0015](0015-sentinel-reviewer.md) (the Sentinel)

## Context

The Phase 0 benchmark ran a turn in auto-approve / full autonomy. The agent
downloaded a 76 MB Go toolchain into its session folder and began writing
shims into `C:\Users\<user>\bin` — outside the workspace, on the person's
PATH. Nothing stopped it. AICO's file tools are confined (Write/Edit/Read
resolve the real path and refuse anything outside the project, the AICO
workspace and the skills folder — `src/tools/path.ts`), but the shell tools
(`Bash`, `PowerShell`, `Terminal`, the desktop's `ide_terminal_run`) were
judged only for *danger patterns* (`rm -rf /`, `curl | sh`, `src/safety.ts`),
never for *where they write*. The Sentinel would have reviewed part of it, but
in full autonomy an escalation proceeds unasked, and the fact at issue — "this
writes to C:\Users\me\bin" — is in the command text; it does not need a
model's judgement.

Constraints: no new dependency; no OS-level jail is portable across Windows,
macOS and Linux without one; ordinary dev work (builds, `npm install`, git,
temp files, reads) must not start asking.

## Decision

1. **A classifier over the command line** (`src/tools/shell-confinement.ts`,
   pure). A small tokenizer (quotes, redirections, `&&`/`||`/`;`/`|`,
   newlines), heredoc/here-string bodies dropped, `$( … )` and `bash -c` /
   `pwsh -Command` / `cmd /c` read recursively. Paths expand `~`, `$HOME`,
   `$env:USERPROFILE`, `%USERPROFILE%`, `$PWD`, temp variables and variables
   assigned earlier on the line, and resolve against the shell's cwd as
   `cd`/`pushd`/`Set-Location` move it (the persistent Terminal's own cwd
   between calls). It reports five kinds:
   - `write-outside` — redirections, cp/mv/rm/mkdir/touch/tee/ln/chmod/install,
     `sed -i`, tar `-C`, unzip `-d`, 7z `-o`, `git clone`/`init`/`-C`,
     `git config --global`, `npm --prefix`, `pip --target`, a "local" npm
     install run from outside the project, the PowerShell cmdlets
     (Set-Content, Out-File, New-Item, Copy/Move/Remove-Item, Expand-Archive,
     `[IO.File]::Write…`) and cmd builtins (copy, move, del, rd, md, xcopy,
     robocopy) — whose target is outside the allowed roots: the project, the
     AICO workspace (session scratch), the skills folder, OS temp,
     `aicoHome()/tmp`, and the person's `shell.allowedWriteRoots`. Containment
     is checked as written *and* by real path.
   - `download` — curl/wget/iwr/irm/Start-BitsTransfer/certutil/bitsadmin/
     aria2c/WebClient fetching an archive or binary (by extension) or a
     toolchain-installer URL.
   - `global-install` — npm/pnpm/bun `-g`, `yarn global`, pip `--user` or
     outside a virtual environment, pipx, cargo/go/gem install, dotnet tool
     `-g`, rustup, winget/choco/scoop/brew/apt/dnf/pacman…, Install-Module,
     msiexec. Project-local installs are not findings.
   - `run-downloaded` — running a file this run downloaded, something unpacked
     from a downloaded archive (tracked across calls in the run), a binary in
     temp/scratch outside the project, or putting one of those on PATH.
   - `persistence` — setx, `reg add`, `[Environment]::SetEnvironmentVariable`
     User/Machine, schtasks/Register-ScheduledTask, `sc create`/New-Service,
     systemctl enable, launchctl load, crontab, registry PowerShell paths.
2. **A deny-only guard, `shell-confinement`**
   (`src/tools/shell-confinement-guard.ts`), installed in `runAgent` before
   the Sentinel and scoped to its run's agent. Any finding needs a person:
   - **ask / edits:** the ordinary permission card already asks about the
     shell call; it now leads with the finding ("writes outside the project:
     <path>") and marks the call shown, so the guard does not ask twice;
   - **auto / full autonomy:** the guard asks through the run's approval card;
     a yes sets `HUMAN_APPROVED` (the Sentinel does not ask again about the
     call the person just saw);
   - **unattended (L4, cron, background, headless) or nobody to ask:**
     refused with the fix named (keep it in the project or scratch, install
     project-locally, or ask the person / their settings) and a notification.
     Not parked: the inbox replays only custom tools (ADR 0011).
3. **A non-negotiable, like buying and sending (ADR 0005).** Full autonomy
   (`sentinel.onEscalate: proceed`) does not waive it: these findings are
   person-required at every level, not Sentinel-escalate.
4. **The person's standing answers** — `shell.allowedWriteRoots: string[]`
   and `shell.allowDownloads: boolean` (default false; covers downloads,
   global installs and running what was downloaded). User settings only
   (`PROJECT_POLICY.shell = 'user-only'`); widening either through the API
   needs a person (`safetyWeakening`). Shown in Settings → Permissions → Tools
   and folders (web schema, rendered by the desktop too).
5. **The Sentinel sees them too.** `sentinelTrigger` reviews downloads
   (`external`) and global installs / running downloads / persistence
   (`exec`), and now covers the `PowerShell` tool — so when the person's
   settings let one through without asking, the reviewer still looks.

## Alternatives considered

| Option | Why not |
|---|---|
| An OS sandbox (AppContainer, bubblewrap, sandbox-exec, seccomp) | Three different mechanisms, each with dependencies and gaps (Windows has no unprivileged equivalent that keeps a dev toolchain working); a long project of its own. The command reader closes the observed failure now and stays useful beside a jail later. |
| Leave it to the Sentinel | Full autonomy proceeds on escalate, a model's judgement varies, and every call would cost a review. A fact in the command text should be checked deterministically (principles: enforce in the loop). |
| Refuse outright instead of asking | Installing a toolchain is sometimes exactly what the person wants; a person, asked with the exact path, is the right authority. Unattended runs do refuse. |
| Flag every write not provably inside | A variable the reader cannot resolve, `$(…)` output or a program's own writes would then ask about ordinary work constantly — and people learn to click yes. Unresolvable targets are skipped and documented as a limit. |
| A prompt rule ("don't write outside the project") | AGENTS.md §4.6: behaviour the harness depends on is enforced in code. |

## Consequences

- **Good:** the incident is caught at each step (download, `~/bin`, the
  shim, running `go.exe`, the PATH edit); the person sees the exact path; a
  cloned repository cannot widen it; the Sentinel reviews what settings allow.
- **Bad / costs:** a few more questions for legitimate system work (a global
  install, `git config --global`, writing to `~/Downloads`), answered once per
  call or permanently in settings; pip outside a venv now asks.
- **Honest limits:** it reads command text. A write made *inside* a program
  (`node -e "fs.writeFileSync('/x')"`, a Makefile, a script it runs), through
  a variable it cannot resolve, or via a tool flag it does not know
  (`--outDir ../x`) is not seen. Run-downloaded tracking lives for one run.
  Not a jail — defence in depth beside the file tools' real-path confinement.
- **Migration:** none. Unset settings mean the new, stricter default; existing
  auto-approve users are asked about the commands listed above.

## Threat model

- **Asset:** the person's machine outside the project — PATH, profile and rc
  files, the registry, scheduled tasks, installed software.
- **Actor:** an over-eager agent (the observed case) or one steered by
  injected content.
- **Entry:** the four shell tools' `command` argument.
- **Control:** the deny-only guard, before the Sentinel; settings user-only and
  person-gated; unattended runs refuse.
- **Residual:** writes performed by programs the command runs; unresolvable
  variables; the person approving something they did not read.

## Verification

- `scripts/shell-confinement-test.mjs` (in `npm test`): 200+ assertions —
  POSIX, PowerShell and cmd forms; `~`/env expansion; `cd` chains; the
  Go-toolchain incident call by call (Windows) and in one line (POSIX);
  false-positive guards (builds, project installs, git in the repo, temp,
  reads); the guard's ask / refuse / no-double-ask / settings paths; the
  runAgent wiring in auto, unattended and ask modes; user-only settings and
  `safetyWeakening`; the Sentinel trigger.
- `scripts/security-settings-test.mjs` asserts `shell` is `user-only`.
- Reversing it fails those tests: removing the guard install fails the
  runAgent block; making `shell` `allow` fails both suites.
