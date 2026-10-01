# Testing

What each suite proves, what it costs, how to keep tests isolated and
deterministic, and how to verify a change in the real app. The rule behind all
of it: **passing tests are evidence, not proof.** A keyword check once scored
two broken apps 12/12; nothing had run them.

## The suites

Times measured 2026-09-30 on a Windows dev laptop; counts from the same run.

### Free, offline — run these on every change

| Command | Proves | Size / time |
|---|---|---|
| `npm run typecheck` | engine types | ~5 s |
| `npm test` | `test-harness.mjs` (engine: tools, pipeline, session log + invariants, providers with stubs, server routes in-process, prompts, cost, compaction…), `scripts/vault-test.mjs`, `scripts/credential-ux-test.mjs` (the decision gate on `/api/permission`, Allow once/session, browser_login fill requests, encrypted vault backups), `scripts/title-sanitizer-probe.mjs`, `npm run test:miniapps` | 3,317 + 65 + 38 assertions, ~75 s |
| `npm run test:web:unit` | web reducer, UI helpers (`web/test-ui.mjs`), canvas — bundles each entry to `web/dist-test/*.mjs` first | 35 + 355 + 20, ~25 s |
| `npm --prefix desktop test` | desktop pure modules (`scripts/test-unit.mjs`: maths, zip, backup, menus, browser safety/store/extract/keys, MCP) + `test-browser-{bookmarks,overlay,shield,tabs,import,window,learn,vault}.mjs` (vault = migration rules, the purchase/send gate, where a login may be filled) | 9 suites, ~5 s; no Electron needed |
| `npm --prefix desktop run typecheck` | desktop main + renderer types | |
| `npm run check:standards` | machine-checked standards | < 1 s |
| `npm run test:standards` | the checker's own tests (temp git repos from `scripts/fixtures/check-standards/`) | 41, ~15 s |

`npm test` does **not** include `test:web:unit` or the desktop suites; CI runs
all of them. Run all three before saying "tests pass".

### Free, but real OS / browser / network — run when you touch the area

| Command | Proves |
|---|---|
| `npm run test:diagrams` | every diagram type renders in a real browser (Mermaid needs real layout) |
| `npm run test:economy` | prompt/token economy vs the committed baseline (`scripts/fixtures/economy-baseline-0.11.json`) |
| `npm run test:reasoning` | reasoning-shape handling, no key needed |
| `npm run test:window` | usage recorded once per request and the observed context-window floor (stub endpoint, spends nothing) |
| `npm run test:sidebar` | sidebar at scale in a real browser (spends nothing) |
| `npm run test:layout` | web layout measured at several widths (spends nothing) |
| `npm run test:watchers` | watchers against the real OS (`fs.watch`, pids, sockets, logs) |
| `npm run test:shell` | the shell the command tools really get on this machine (the `cmd.exe` vs bash bug) |
| `npm run test:mcp` | `aico mcp-serve` and the MCP client against real stdio servers |
| `npm run test:serve` | cron and boot reconciliation under a real `aico serve` |
| `npm run test:apps`, `test:deploy` | Apps routes and deploy against a real server |
| `npm run test:templates` | every process template installs, typechecks, tests and builds from clean (network; slow — run before a release that touches templates) |
| `npm run test:nextapp`, `test:miniapps` | Next.js / Mini App host install, serve, persist, refuse |
| `npm run test:panel` | the VS Code panel's transport against a real server (no model) |
| `npm run test:bench:graders` | the eng-bench graders fail each untouched fixture and plausible-but-wrong mutant, and score each reference solution 100% (needs Chrome; ~40 s) |
| `desktop/scripts/shot.mjs <out> <steps.json>` | drives the real desktop app under Playwright `_electron` with an isolated store |

### Paid — real models; only with the owner's approval

| Command | Proves |
|---|---|
| `node desktop/scripts/vault-live.mjs <outDir>` | the real desktop app with a real model: browser password migration, CredentialGenerate → browser_login into a local portal, purchase gate, CredentialRequest secure prompt, Credential Manager add/reveal/rotate/delete/audit, and a canary scan of store, transcript, stream, renderer DOM, IPC and logs |
| `npm run test:live` (`live-test.mjs`) | wire formats, streaming, tool round trips, caching, truncation, cancellation, steering, compaction, sandbox, sub-agent inheritance |
| `npm run test:web` (`web-live-test.mjs`) | HTTP-level E2E; **hardcodes `deepseek-v4-flash`** — if `activeProvider` in the copied settings is another vendor, ~30 assertions fail for unrelated reasons; its mid-run section is timing-sensitive |
| `npm run test:cron`, `test:supervision`, `test:mcp:model` | a scheduled job, a supervised sub-agent, submitted MCP work — each against a real model |
| `npm run test:skills:live`, `test:apps:build`, `test:nextbuild`, `test:section` | skills and app builds end to end |
| `npm run test:vscode` | the panel in a real VS Code (runs a real turn on the default model) |
| `node scripts/long-horizon-live.mjs …`, `scripts/swebench-live.mjs`, `bench.mjs`, `bench-build.mjs` | benchmarks and evidence |
| `npm run bench:eng` (`scripts/eng-bench.mjs`) | six fixed engineering tasks (API build, bug fix, refactor, design doc, full-stack feature, delegation) with hidden-test graders, tokens and USD per task; `--aico <dist>` pins a frozen build, `--compare <old.json>` prints deltas |

Live probes pin `deepseek/deepseek-v4-flash` unless the test is about a
specific model; a slow default model makes 120 s turn budgets flaky. When a
script's cost is unclear, read its header before running it.

## Isolation — never touch the real `~/.aico`

- Every test and probe's **first import** is `scripts/lib/test-home.mjs`
  (`./scripts/lib/test-home.mjs` from the root). It points `AICO_HOME` at a
  fresh temp store, copies only `settings.json` in (for provider keys), and
  deletes it on exit (`AICO_KEEP_TEST_HOME=1` keeps it).
- Children inherit it: spawn with `{ ...process.env }`.
- Stores with their own override: cron (`AICO_CRON_STORE`), work ledger
  (`AICO_WORK_LOG`) — tests must not leave jobs firing in a real store.
- Never delete anything under `~/.aico` yourself; hand the owner
  `node scripts/prune-test-projects.mjs --apply`.
- When running the app by hand: `AICO_HOME=<temp>/.aico`.

## Determinism

- No dependence on wall-clock or randomness without a seed. Timestamps that
  must order use a monotonic source (the canvas bug: two canvases made in the
  same millisecond; Linux CI caught it, Windows never did).
- Wait on a condition with a deadline, never a bare sleep.
- Windows `mtime` granularity: a test needing "a later write" moves mtime
  forward with `utimesSync`.
- Background writers finish asynchronously (`checksFor` writes
  `.aico/profile.json` in the background) — wait before removing a scratch dir.
- A stub OpenAI-compatible endpoint sees two requests per turn: the turn (has
  `tools`) and the session-naming call (no tools). Filter by `tools.length`.
- `web/dist-test` bundles: one esbuild call per entry with an explicit
  `--outfile`. A multi-entry `--outdir` mirrors source paths and the suite
  silently tests stale bundles.

## Bugs: reproduce first

1. Write the failing test or probe that shows the bug (name it after the behaviour).
2. Confirm it fails for the reported reason, not a neighbouring one.
3. Fix. 4. Confirm it passes and nothing else moved.

If a bug cannot be reproduced, say so and record how you tried (the "open a
running session never streams" report turned out to be automation
interference — re-tested with screenshots and clicks only).

## Flaky tests

A flaky test is a bug in the test or the code. Do not retry-until-green. Either
fix it now, or quarantine it with an issue that names the flake and the
suspected cause, and say so in your report. Known timing-sensitive areas:
`web-live-test.mjs` mid-run section; live probes on slow default models.

## Live verification

Tests passing is not the feature working. For anything a user sees or a model
does, run it and look:

- **Web**: `npm run build && npm run build:web`, then
  `AICO_HOME=<temp>/.aico node dist/index.js serve --port 7340`; open the
  printed URL (it carries `?token=`).
- **Desktop**: `npm --prefix desktop start` for a look, or
  `node desktop/scripts/shot.mjs <out-dir> <steps.json>` for a scripted,
  isolated run (`AICO_EXE=<path>` drives a packaged build).
- **VS Code**: `npm run test:vscode` (paid) or install the VSIX in a clean profile.
- **Terminal**: `node dist/index.js -p "…"` in a scratch directory.

### Playwright + Electron lessons (each cost real time)

- **Native views are not in page screenshots.** The desktop browser is a
  `WebContentsView`; `page.screenshot()` captures only the renderer. Use the
  `browser:screenshot` IPC and composite it if you need the page in the image.
- **Do not override the viewport of the main window.** `page.setViewportSize`
  desyncs renderer coordinates from native view bounds — resize the real
  `BrowserWindow` instead. (`desktop/scripts/shot.mjs` still calls
  `setViewportSize`; treat its browser-pane screenshots with care.)
- **Never capture a hidden `WebContentsView` without a deadline.** It hung
  and once crashed the main window; captures need a deadline, a size cap and a cached still.
- Some shortcuts close the window under test (Ctrl+Shift+N in the pop-out);
  Playwright's `press` then throws — expected, not a failure.
- Unquoted `text=Set` is a case-insensitive substring match and clicked
  "Settings…"; use `button:text-is("Set")`.
- Electron has no `window.prompt`.
- When a bug is suspected to be automation interference, re-test with
  screenshots and clicks only; JS injection and console/network reads are the
  tools that misbehave.

## What to report

Commands run with their counts and exit codes; what you looked at live and
what you saw; what you did not run (and why — cost, platform, time). See
[ai-contributors.md § evidence](ai-contributors.md#evidence).
