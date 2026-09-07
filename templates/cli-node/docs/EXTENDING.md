# Extending this tool

## Add a command

1. Copy `src/commands/count.ts` to `src/commands/<name>.ts`. Keep the shape: parse
   its own flags with `parseArgs`, do the work in a pure exported function, print,
   return an exit code (0 ok, 1 the work failed, 2 bad invocation).
2. Register it in the `COMMANDS` table in `src/cli.ts` and add a line to `HELP`.
3. Add tests in `test/`: the pure function directly, and the command through
   `run(['<name>', …], io)` for the exit codes and the printed shape.
4. `RunChecks`. There is nothing to open; a passing run is the verification.

## Add a global flag

Add it to the `parseArgs` options in `run()` and handle it before dispatch. Keep
global flags few: `--help`, `--version`, maybe `--quiet`. Everything else belongs
to a command.

## Read stdin

`const text = await new Promise<string>(r => { let s = ''; process.stdin.on('data', c => s += c).on('end', () => r(s)); })`
— but pass the stream in through `Io` (add `stdin`) so tests can supply a string.

## Ship it

`npm run build` writes `dist/` with a shebang on the entry; `bin` in package.json
names the command. `node deploy/pack.mjs` produces the tarball `npm publish` would
upload. Add a `--json` to any new table output so other tools can consume it.

## What not to do

- No runtime dependency for parsing, colours or prompts unless a command truly needs one.
- No `process.exit()` inside a command; return the code and let the entry set it.
- No work in `src/index.ts`.
