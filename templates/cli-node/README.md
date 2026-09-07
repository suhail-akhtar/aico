# __APP_TITLE__

__APP_DESCRIPTION__

A command-line tool in TypeScript with no runtime dependencies.

## Run

```sh
npm install
npm run build
node dist/index.js --help
node dist/index.js count README.md --words
```

Link it onto your PATH while developing: `npm link`, then `__APP_SLUG__ --help`.

## Check

```sh
npm run typecheck
npm test
npm run build
```

## Publish

```sh
node deploy/pack.mjs          # npm pack → __APP_SLUG__-0.1.0.tgz
npm publish                   # when it has a registry home
```

See `deploy/README.md`.

## Structure

```
src/index.ts          entry
src/cli.ts            flags, command table, dispatch, exit codes
src/commands/*.ts     one file per command; count is the worked one
test/                 vitest through run(), no process spawned
.aico/                backlog and decisions
docs/EXTENDING.md     how to add a command
```
