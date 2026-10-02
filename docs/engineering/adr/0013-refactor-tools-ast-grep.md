# 0013 — Make wide refactors one planned, checked step: ast-grep and the TypeScript language service

- **Status:** Accepted (2026-10-03)
- **Date:** 2026-10-03
- **Deciders:** owner (requested the `refactor` tool group and named `@ast-grep/cli` in the brief)
- **Supersedes / related:** design [agents-skills-tools.md](../design/agents-skills-tools.md) §4.1 (effect classes), §4.5 (prompt budget);
  `src/tools/vscode.ts` (the editor-only rename this complements)

## Context

AICO was weak at large mechanical refactors. Renaming an exported API used in
two hundred files meant `Grep` plus one `Edit` per site: hundreds of calls, each
a chance to miss `money.formatPrice(…)` behind a namespace import, to corrupt a
lookalike (`formatPriceRange`), or to rewrite a string that must stay. There was
no point at which the whole change was visible, checked, or undoable as one
unit. `VSCodeRename` does this exactly — but only while VS Code is attached,
not in the terminal, web, desktop, cron or a sub-agent.

## Decision

1. **A deferred tool group, `refactor`** (`src/tools/deferred.ts`): `CodeSearch`
   (read), `CodeRewrite` and `Refactor` (write). Their schemas are sent only once a
   turn loads the group; until then they cost one `LoadTools` line, which says when
   to load them ("instead of many Edits"). Always-sent budget stays flat (§4.5).
2. **Plans, enforced** (`src/refactor/plan.ts`). Every writing call is a dry run
   unless `dryRun: false`; an apply is honoured only for a plan this run has already
   shown for the same arguments, and only if a fresh computation still has the same
   digest — otherwise the plan is shown again and nothing is written. An apply is one
   standalone checkpoint (`checkpoint/snapshotFiles`, also recorded into the turn's),
   then the project's checks (`RunChecks`), then on red either a report with the
   one-call rollback (default — multi-step refactors are legitimately red between
   steps) or an automatic rollback (`onFail: "rollback"`).
3. **Effect class `write`**, in every list that classes file writers: permission
   (`permissions.ts`), L2 `edits` auto-approval (`agents/ceiling.ts`,
   `server/runs.ts`), background gating, the copilot's withheld set, sub-agent
   write detection. Plan mode offers `CodeSearch` only. `paths.write`
   (`agents/paths-guard.ts`) and the sandbox (`sandbox/guard.ts`) check **every
   file of the shown plan** before an apply runs (`plannedWriteTargets`).
4. **ast-grep for structural search/rewrite** (`src/refactor/ast-grep.ts`), via
   `@ast-grep/cli` as an **optional dependency**. Found in the project's
   `node_modules` first, then AICO's install, then `ast-grep` on PATH (never `sg`,
   which on Linux is shadow-utils). The rewrite is computed from `--json` output in
   memory, not by `--update-all`, so it goes through the plan, the run's file writer,
   the checkpoint and the scopes. Missing binary → a message naming the install
   command and the fallback (Grep + Edit, or `Refactor` for TS/JS).
5. **TypeScript language service for TS/JS refactors** (`src/refactor/ts-service.ts`):
   rename, find references, organize imports, move file (importers and its own
   imports updated), driven directly with no editor. `typescript` is loaded with
   `createRequire` at call time — the **project's** copy first (its version is the
   one its `tsc` agrees with), AICO's second — and is not made a runtime dependency.

### The dependency: `@ast-grep/cli` 0.45.x

| | |
|---|---|
| Licence | MIT (the CLI and every platform package) — compatible with PolyForm Noncommercial distribution |
| Shape | a 6 KB launcher plus one prebuilt native binary per platform, as npm `optionalDependencies`: win32 x64/ia32/arm64 (msvc), linux x64/arm64 (gnu), darwin x64/arm64 |
| Size | the platform binary is large because it embeds ~25 tree-sitter grammars: **~103 MB unpacked on win32-x64, ~53 MB on linux-x64-gnu, ~52 MB on darwin-arm64** |
| Install script | yes — a `postinstall` that places the platform binary; if it fails the optional dependency is skipped and AICO still installs |
| Network | none at run time |
| Gaps | no prebuilt for linux musl (Alpine): the tool then reports the PATH/cargo install route |

## Alternatives considered

| Option | Why not |
|---|---|
| Keep Grep + Edit | The measured weakness: hundreds of calls, no single plan, lookalikes and namespace uses missed. |
| `@ast-grep/napi` (7–8 MB, in-process) | Ships only JS/TS/HTML/CSS grammars; other languages need a package each. The CLI covers ~25 languages in one dependency, which a polyglot coding agent needs. Revisit if install size becomes the complaint (record measured, not guessed). |
| Hard (non-optional) dependency | A platform without a prebuilt binary would fail AICO's install for a feature it may never use. |
| `ast-grep --update-all` to apply | Writes behind the plan, the checkpoint, the run's file writer (VS Code undo stack) and the write scopes. |
| `typescript` as a runtime dependency | ~23 MB for every install; the project being refactored almost always has its own `typescript`, which is also the right version to use. |
| An LSP client for pyright / gopls now | Real work (process lifecycle, protocol, per-server quirks) for languages ast-grep already covers structurally. Future work, below. |
| Bundling `typescript` into the desktop engine | ~9 MB of bundle for a fallback; the desktop resolves the project's copy like everyone else. |

## Consequences

- **Good:** a 200-file rename is one dry run and one apply (measured: 153 files, 551
  edits, under a second each, exact — see Verification); applies are checked and
  undoable as a unit; the same tools work in every client.
- **Bad / costs:** `npm install` of AICO downloads one 50–100 MB platform binary.
  The desktop installer does not ship it (the engine is an esbuild bundle) — there
  ast-grep comes from the project or PATH, and the tool says so when absent.
- **Honest limits:** `Refactor` covers TypeScript/JavaScript only. A rename leaves
  strings and comments alone by design (the brief's string-literal rule) — a doc
  comment that names the old API must be updated separately. ast-grep's rewrite is
  syntactic: it cannot tell two same-named functions apart (use `Refactor rename`
  for TS/JS, or narrow `paths`). Write scopes bind the plan's files; they do not
  bind what the project's checks (run afterwards) do, which is as true of `RunChecks`.
- **Future:** Python via pyright and Go via gopls over LSP (rename, references),
  behind the same plan/apply flow.
- **Migration:** none — new tools in a deferred group; nothing stored changes.

## Threat model

The group writes files (effect `write`) and runs the project's own checks (as
`RunChecks` does). New surface: spawning the ast-grep binary — with `execFile` and
an argument array (no shell), the pattern and rewrite passed as single arguments,
paths validated inside the project. Write targets come from the plan the run
computed, every one resolved through `resolveInsideWorkspace` and checked by the
`paths.write` and sandbox guards before the apply runs. No network, no secrets.

## Verification

- `scripts/refactor-tools-test.mjs` (in `npm test`): TS rename across files incl.
  barrel re-exports, namespace and aliased imports, shorthand keys, string/comment/
  lookalike non-matches; dry run → apply → checks → rollback; apply without a shown
  plan refused; stale plan re-shown; red checks reported / rolled back; `paths.write`
  refusing an apply outside its globs; moveFile, organizeImports; ast-grep search and
  rewrite incl. CRLF; missing binary message.
- `scripts/eng-bench/tasks/large-refactor` with grader self-tests in
  `test-graders.mjs` (fixture fails, reference 100%, three realistic mutants each
  lose their check; a test added for the new parameter still scores 100%).
  Driven by the tools alone (scripted, no model) the task scores 10/10 in four
  calls. One deepseek-flash run each (2026-10-03), tools hidden vs available:
  both 10/10, 100 s / 20 steps / $0.023 vs 68 s / 15 steps / $0.016 — and in the
  "available" run the model never loaded the group: both runs solved it with a
  word-boundary regex script through Bash. So this is **not yet evidence that a
  model reaches for the tools**; the open question is discovery (the `LoadTools`
  line), measured next with more runs and a task a regex cannot solve (e.g. two
  same-named symbols in different modules).
