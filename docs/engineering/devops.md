# DevOps

CI/CD as it actually is, versioning and branching, and how AICO runs work
headless and in the background — and supervises it.

## CI/CD

| Workflow | Trigger | Jobs |
|---|---|---|
| `.github/workflows/ci.yml` | push to `main` and `release/**`, PRs to `main` | **standards**: `check-standards` over the pushed/PR range + the checker's tests (Node 22, `fetch-depth: 0`). **test** (Node 22 and 24, `fail-fast: false`): `npm ci` → typecheck → build → `npm test` → web deps → `test:web:unit` → desktop deps (`--ignore-scripts`, no Electron download) → desktop tests |
| `.github/workflows/desktop.yml` | tag `v*`; manual dispatch with `release=vX.Y.Z` | Windows (NSIS) + Linux (AppImage, deb): engine/web/desktop `npm ci` → desktop tests → desktop typecheck → `package:<target>` (`CSC_IDENTITY_AUTO_DISCOVERY=false`, unsigned) → upload artifacts → attach to the release (waits up to 10 min for it to exist; `--clobber`) |

Why things are the way they are:

- Node 22 is the floor (`node:sqlite` arrived in 22.5; Node 20 failed every
  run for weeks with `ERR_UNKNOWN_BUILTIN_MODULE`). 24 catches breaks on current Node.
- `fail-fast: false` so one failing Node version never hides the other.
- Web unit tests were added to CI after a stale assertion sat red for two
  releases; desktop tests since 0.23.0.
- No paid suites in CI, deliberately (`CI=true`). Live suites run by hand with approval.
- There is no npm publish job and no deploy job: the website is GitHub Pages
  serving `docs/` from `main`; installers attach to GitHub releases.

**Red `main` is the top priority.** CI was once red for ~10 releases because
nobody watched it. Watch every push: `gh run watch --exit-status`.

## Versioning (semver, pre-1.0)

- `MAJOR.MINOR.PATCH`, currently `0.x`. **Minor** = features or any
  user-visible behaviour change; **patch** = fixes only, safe to fast-forward
  onto. Breaking a persisted format or a documented contract needs a minor at
  least, a migration, and a CHANGELOG `### Changed` note that says what to do.
- One version for engine **and** desktop (`package.json`, `desktop/package.json`,
  both lockfiles) — `check-standards` enforces it.
- The VS Code extension is versioned separately (`vscode-extension/package.json`,
  `0.6.x`) and bumped only when it changes; the current VSIX is re-attached to every release.
- `web/package.json` (`0.4.1`) is private and not released; leave it alone.

## Branches and tags

- `main` — trunk; everything lands here (branch-protected, no force-push).
- `release/vX.Y` — one per **minor**, cut at the release commit; patch
  releases **fast-forward** it. Never `release/vX.Y.Z` (a branch and tag with
  the same name make `git checkout` ambiguous; 0.18.1 made this mistake).
- `vX.Y.Z` — annotated tags, never moved, equal to `package.json`.
- The local-only tag `legacy/pre-rewrite` marks an abandoned lineage with no
  common ancestor; never push it. If a branch looks bizarrely stale, check
  `git merge-base --is-ancestor` first.
- Users pin `#vX.Y.Z`, follow `#release/vX.Y`, or track `#main`.

## Changelog

`CHANGELOG.md`, newest first. Work in progress goes under `## Unreleased`;
`npm run release` renames it to `## X.Y.Z — YYYY-MM-DD`. Each release opens
with a one-paragraph summary (its first sentence becomes the release commit
subject), then `### Added` / `### Changed` / `### Fixed` / `### Deprecated` /
`### Removed` / `### Security` as needed. Write for users: what changed for
them and why, with evidence for claims. Never rewrite past entries except to
fix a factual error.

## Hotfixes and rollback

- **Normal hotfix:** fix on `main` → `npm run release -- X.Y.(Z+1)`. Because
  release branches track `main`, this fast-forwards `release/vX.Y`.
- **Hotfix to an older line** (a `release/vX.Y` that has diverged): never
  happened yet. CI does not run on `release/*` pushes today — add the branch to
  `ci.yml` triggers first, cherry-pick onto the branch, then
  `npm run release -- X.Y.Z --allow-branch` from it. The script refuses if CI
  cannot run there.
- **Rollback:** tags are never moved or deleted. Roll *forward*: release a
  patch that reverts the change (`git revert`, not reset). Users on a bad
  version pin the previous tag (`#vX.Y.(Z-1)`); desktop users get the next
  patch through auto-update.
- **Broken release assets:** re-run `desktop.yml` with `release=vX.Y.Z`
  (attaches with `--clobber`). A broken draft from transient GitHub errors can
  be fixed in place: `gh release edit vX.Y.Z --draft=false --tag vX.Y.Z`.

## Desktop auto-update constraints

- `electron-updater`, loaded with `require` (with `import()` it came back
  undefined in packaged builds), only in packaged NSIS/AppImage/deb builds;
  checks 10 s after start, then every 6 h; installs on quit.
- Reads `latest.yml` / `latest-linux.yml` + blockmaps from the GitHub release
  — **a release without them strands every installed copy on the old version.**
  The release script verifies they are attached.
- Unsigned: integrity is the sha512 in `latest.yml`; SmartScreen warns on first install.
- 0.24.0 was the first release carrying update metadata; 0.23.x updates by hand once.
- An end-to-end auto-update install has not been verified yet — honest gap.
- Desktop version = engine version; never release one without the other.

## Headless and background operations

AICO runs work nobody is watching: scheduled jobs, background agents,
sub-agents, backgrounded shell processes, Mini App servers, and work submitted
by another AI over MCP. Before 2026-08-31 these had five registries and none
survived a restart; now one **work ledger** answers "what is running?".

| Piece | Where | What it does |
|---|---|---|
| Work ledger | `src/work/ledger.ts`, store `aicoHome()/work.jsonl` (append-only; `AICO_WORK_LOG` overrides) | one record shape for all running work; state changes written immediately, heartbeats batched; `reported` is a field (outcomes stay listed until `ack`) |
| Adapters | `src/work/adapters.ts`, `register.ts` | subsystems keep their own APIs and feed the ledger through their `subscribe*` functions |
| Supervisor | `src/work/supervisor.ts` | limits enforced by the loop, not the model; breach actions `report \| stop \| kill` (no `pause`: an LLM turn cannot be suspended, and a control that silently cancels is worse than none) |
| `Supervise` tool | `src/tools/supervise.ts` | the one tool over everything running: `list`, `stop`, `guide`, `wait`, `watch`, `unwatch`, `policy`, `ack` |
| Watchers | `src/work/watchers.ts` | wait without spending turns (`work`, `file`, `process`, `http`, `log`); they `inject` with the source recorded, never `steer` |
| `<running_work>` | `src/work/projection.ts` | running work projected into the volatile prompt tail |
| Cron | `src/cron/` (store `AICO_CRON_STORE` or `aicoHome()/cron.json`) | scheduled agent runs; default `permissions: 'full'` on purpose (the user authored the schedule); a slow job never stacks copies; `cwd` is forwarded |
| Background agents | `src/background/` | detached agent runs, mirrored into the ledger |
| MCP server | `aico mcp-serve` (`src/mcp-server/`) | another AI submits/waits/stops work over stdio; read-only unless `--allow-writes`; mandatory spend ceiling for remote jobs; `aico_wait` returns the result whole |
| Daemon | `aico serve` | hosts cron and boot reconciliation (`npm run test:serve`) |

Rules for anything that runs unattended:

1. **It must be visible**: register in the ledger (through its subsystem's
   subscribe feed), with an owner session, a start time and a stop reason.
2. **It must be stoppable** (`Supervise stop/kill`) and must stop cleanly on
   abort; orphaned processes are bugs (the Windows `Code.exe` orphan lesson).
3. **It must be bounded**: a deadline, a spend ceiling (`maxCostUsd`,
   `safetyLimits.*`), and token reporting so the ceiling can fire.
4. **It must never block on a human**: no interactive permission prompt, no
   `AskUserQuestion` in a headless run — refuse or fail with a reason instead
   (cron once hung forever on a prompt written to a terminal nobody watched).
5. **It must fail visibly**: a failed job leaves an outcome the user will see
   (`reported` until `ack`), never silence.
6. **Least privilege for remote callers**: unattended work does not inherit the
   interactive user's `autoApprove`; no caller-supplied argument raises it.
7. **It must survive a restart or say it did not**: boot reconciliation marks
   work that was running when the process died.

To extend: add your subsystem's `subscribe*` feed to `src/work/adapters.ts`,
map its states to the ledger's, give it a `stop`, add a case to
`scripts/watcher-live.mjs` or `scripts/serve-live.mjs`, and document it in
`GUIDE.md` ("Knowing what is still running"). **Not authorised without the
owner:** HTTP MCP, capability tokens, TLS/tunnels (phase 5), or any new
network listener. (`SshTunnel`'s loopback-only forward was authorised by the
owner — [ADR 0007](adr/0007-ops-tools-and-dependencies.md) — and is not phase 5.)

## Operating the owner's machines (ops tools)

The agent operates real servers and devices through six tools in
`src/tools/ops/` — `SshExec`, `SshCopy`, `SshTunnel`, `HttpRequest`, `WinRmExec`,
`SnmpQuery` — using vault credentials by name. Contracts, the approval and SSRF
rules and the limits: [docs/security/ops-tools.md](../security/ops-tools.md). The
method the agent follows (inventory → plan → dry run → apply with checks → verify →
credentials in the vault → handover): the `server-ops` built-in skill.

How they fit the rules above:

| Rule | How the ops tools meet it |
|---|---|
| Visible | every call is a ledger record: `<Tool> <target> [cred <name>]: <summary>`; background SSH runs and tunnels stay live records until they end |
| Stoppable | `Supervise stop` aborts a running command (TERM + channel close) or closes a tunnel; cancellation of the turn does the same |
| Bounded | per-call deadlines (SSH/WinRM 120 s default, 30 min max foreground, 24 h background; HTTP 60 s; SNMP 5 s/request), dispatcher backstops past them, per-target rate limits, SSH connection cap per host |
| Never blocks on a human when headless | approvals go through the broker; with nobody to ask, the use is refused |
| Fails visibly | failed/cancelled calls are recorded as such; background outcomes stay unreported until acked; run logs in `aicoHome()/ops/runs/` |
| Survives restart or says so | connections live in the engine, so a restart marks in-flight ops `lost` |

Testing: `scripts/ops-test.mjs` (offline, in `npm test`) runs the tools against a
real `ssh2` SSH server with exec/SFTP/forwarding (`scripts/lib/ssh-test-server.mjs`,
local-shell or Docker backend), local HTTP(S) servers and net-snmp's agent.
`scripts/ops-live.mjs` adds a real model turn through `aico serve` (paid — run on
request only).
