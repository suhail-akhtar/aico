# Coding standards

Conventions this codebase already follows, written down so new code matches.
When in doubt, copy the nearest well-written module (`src/home.ts`,
`src/tools/observation.ts`, `src/work/ledger.ts`, `scripts/prepare.mjs`).

## Language and platform

- TypeScript, `strict: true`, ESM (`"type": "module"`), `moduleResolution: bundler`.
  Engine builds with tsup (`tsup.config.ts`); web and desktop renderer with Vite;
  desktop main with esbuild (`desktop/scripts/build.mjs`).
- Node ≥ 22.5 (the engine uses the built-in `node:sqlite`). CI runs 22 and 24;
  Electron 44 bundles Node 24.
- Imports use `.js` extensions for relative ESM paths in `src/` (as the existing code does).
- Scripts are `.mjs`, run with plain `node`, no build step.
- Formatting (`.editorconfig`): UTF-8, LF, 2-space indent, final newline,
  trimmed trailing whitespace (except Markdown). `.gitattributes` normalises
  line endings; skill Markdown and `.githooks/*` are forced LF because parsers
  and `sh` depend on it.

## Module headers — required for new modules

Every new module under `src/`, `shared/`, `desktop/electron/`,
`desktop/shared/`, `desktop/engine/`, `scripts/` opens with a comment block
(`check-standards` enforces this for added files). It says:

1. **What** the module is for, in one sentence.
2. **Why** it is shaped this way — usually the failure or measurement that
   shaped it ("This was a line in the system prompt … and a prompt rule is a request").
3. **What it deliberately does not do**, and alternatives rejected.
4. Contracts callers must honour (e.g. "clients must REPLACE, never append").

End engine module headers with `@module name` where the neighbours do.
When you change a module's design, update its header in the same change — a
header that describes the old design is worse than none.

## Comments

- Explain *why*, not *what*. The code says what.
- Match the density of the surrounding code. This codebase writes prose
  comments at decision points and almost none on obvious lines.
- Record rejected alternatives where someone would otherwise re-propose them.
- No commented-out code; no `TODO` without an issue or an owner-approved reason.
- No attribution, no names of tools that helped write the code.

## Naming

- Files: kebab-case (`timeout-policy.ts`, `release-stamps.mjs`); React
  components PascalCase (`SidePanels.tsx`).
- Tools the model calls: PascalCase names (`Read`, `Supervise`, `VerifyApp`);
  desktop host tools: `ide_*`, `browser_*` snake_case.
- Settings keys: camelCase (`safetyLimits.maxCostPerSession`).
- Env vars: `AICO_*` (`AICO_HOME`, `AICO_CRON_STORE`, `AICO_WORK_LOG`, `AICO_HOST_MCP`).
- Test names are sentences that state the behaviour: `'a save on a stale
  baseVersion is 409 with the current document'`.

## Errors

- A tool failure is a **result the model can act on**: say what failed and
  name the fix ("Read the file first", "pass `cwd`"). A bare stack trace wastes a step.
- Never swallow errors in engine paths. `catch { /* best effort */ }` is
  allowed only where failure is genuinely harmless (cleanup, optional cache),
  and the comment says so.
- Fail loudly at boundaries that would otherwise fail quietly later
  (`scripts/prepare.mjs`: a failed build must fail the install).
- Error messages never contain secret values, full tokens, or the contents of
  redacted settings.
- Turn ends carry a structured reason (`completed | max-tokens | blocked | aborted | error`);
  do not add a new way for a turn to end without one.

## Async, cancellation, time

- Every long operation accepts an `AbortSignal` and honours it promptly.
- Nothing waits forever: tool dispatch is wrapped by `src/tools/timeout-policy.ts`;
  provider streams have an idle timeout; servers started by `Bash` go to the
  background with pid and URL. `timeout: 0` meaning "forever" once held a turn
  for 139 minutes.
- Processes you spawn are tracked and reaped (the work ledger; `Terminal`
  reaps idle shells). Orphaned processes are bugs.
- Windows: `spawn` with `shell: true` must quote paths — the default Node path
  (`C:\Program Files\nodejs`) contains a space. Prefer `execFile` with an
  argument array and no shell.
- Scripts that load memory (`buildSystemPrompt`) hold an fs watcher open —
  end one-off scripts with `process.exit(0)`.

## State and persistence

- Durable state is appended, not rewritten (session log, `work.jsonl`).
  Parallel writers take a lock (`updateProfile` holds a per-file lock including the read).
- Store paths only via `aicoHome()`; project paths via the run context
  (`src/run-context.ts`), never `process.cwd()` inside engine code that may run
  for another workspace.
- Persisted format changes need a reader for the old shape or a migration, and an ADR.
- Case-insensitive filesystems: `E:\x` and `e:\x` are the same folder
  (a known split bug) — normalise before keying on a path.

## Prompts

- The system prompt is data (`src/prompts.ts`), rendered per provider dialect
  (`src/prompt/`). Content never knows the vendor; renderers never know content.
- Deterministic output: no reordering, no varying whitespace — it heads every cache prefix.
- Volatile information (date, git status, running work, triggered knowledge) goes in the tail.
- Prefer sharpening a bullet to adding one; a rule the harness depends on is
  enforced in code, and the prompt only describes it.

## UI (web, desktop renderer, VS Code panel)

- State lives in the shared store (`web/src/store`); desktop/VS Code reuse it —
  do not fork state into a client.
- Rendering that every client needs goes in `shared/`.
- Never add a React effect that reacts to two sources of truth that correct
  each other (the 0.24.1 flicker loop: route and store `sessionId`).
- Settings fields must not bind secret roots (`providers`, `providerInstances`,
  `env`, `mcpServers`, `hooks`) — `web/src/settings-schema.ts` asserts it at load.
- Pure logic that needs unit tests lives in alias-free modules (the desktop
  unit runner's esbuild cannot resolve `@/` aliases — see `chat/suggest-core.ts`).

## Dependencies

- No new runtime dependency without an ADR (why this, why not built-in, size,
  maintenance, licence compatibility with distribution under FSL-1.1-ALv2).
- Zero deprecated dependencies is a standing goal (0.17.0 removed the last).
- Lockfiles are committed and changed only by npm.

## Things never to do

- Edit generated output (`dist/`, `web-dist/`, `vscode-extension/media/`,
  `shared/**/*.js`).
- Write TypeScript through `node -e` or shell heredocs (backticks and regex
  backslashes get mangled) — use a real editor/edit tool.
- Reformat or rename in files you are not otherwise changing.
