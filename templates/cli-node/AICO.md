# __APP_TITLE__

A command-line tool in TypeScript. No framework: `node:util`'s `parseArgs` for
flags, one file per command, a build to `dist/` with a `bin` entry. Nothing is
served; the tests are the check.

## Layout

- `src/index.ts` — the entry: calls `run()` with the real streams. Never changes.
- `src/cli.ts` — `run(argv, io)`: global flags, the `COMMANDS` table, dispatch, exit
  codes. Add a command to the table and the help text here.
- `src/commands/count.ts` — **the worked command**: parse its own flags, do the
  work through a pure function, print, return an exit code. Copy it.
- `test/cli.test.ts` — vitest through `run()` with captured streams; no process spawned.

## Conventions

- Exit codes: 0 success, 1 the work failed, 2 the invocation was wrong (bad
  flag, unknown command, missing argument). Usage errors go to stderr.
- Every command has a pure function the tests call directly and a thin
  runner that reads files and prints.
- `--json` on any command that prints a table, so the tool composes with others.
- Help text is the contract: update it in the same change as the behaviour.

## Checks

`npm run typecheck`, `npm test`, `npm run build`. `RunChecks` runs them.
There is no URL to open; a passing run is the verification. Try the built bin
with `node dist/index.js --help`.
