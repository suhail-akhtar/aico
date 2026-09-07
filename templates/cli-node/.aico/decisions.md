# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript.

- `node:util` parseArgs instead of commander or yargs — zero runtime dependencies,
  and a tool with two flags does not need a framework.
- One file per command with a pure function inside — the tests call the function,
  the runner only reads files and prints, so the logic is tested without a shell.
- Exit codes 0/1/2 — the convention every shell script and CI step already understands.
- `run(argv, io)` takes its streams — the whole tool is exercised in-process, and
  the entry file is two lines that never need a test.
