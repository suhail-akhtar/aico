# Backlog — __APP_TITLE__

Stories are vertical slices: pure function → command → help text → test. Tick a
box only when its "Done when" was observed. Append iterations; never rewrite the
ones above.

## Iteration 0 — from the template

- [x] `count` command over one or more files, lines or words, table or JSON.
      Done when: `npm test` passes the count tests.
- [x] Help, version, unknown command and usage errors with the right exit codes.
      Done when: the cli tests for exit 0/1/2 pass.
- [x] Builds to a single bin with a shebang.
      Done when: `npm run build` then `node dist/index.js --help` prints usage.

## Iteration 1 — make it this tool

- [ ] Replace `count` with the tool's real first command, keeping the shape.
      Done when: its pure function has tests and its help line is in `src/cli.ts`.
- [ ] Decide the output contract (table, JSON, both) with the user.
      Done when: every command that prints a table also takes `--json`.
- [ ] Name it: package name, bin name, `NAME` in `src/cli.ts`.
      Done when: `npm link` puts the real name on the PATH.
