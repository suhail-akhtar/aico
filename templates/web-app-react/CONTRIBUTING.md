# Contributing

## Setup and checks

```sh
make setup      # npm ci, installs the pre-commit hook
make check      # format, lint, types, generated code current, tests with the 85% gate, audit, build
make e2e        # the browser suite (needs `make e2e-install` once, or `make docker-e2e`)
```

No `make` (Windows)? Run the lines in the `Makefile`; each is a single `npm run ...`.
No Node 24? `make docker-check`.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat: ...`, `fix: ...`, `docs: ...`,
  `chore: ...`, `refactor: ...`, `test: ...`. A breaking change is `feat!:` with a `BREAKING CHANGE:` footer.
- One concern per pull request. Include the test that fails without the change.
- Update `CHANGELOG.md` under `## [Unreleased]` for anything a user of the app would notice.
- If you change the contract (`openapi/openapi.json`), run `npm run gen` and `npm run build` and commit the
  regenerated `src/api/generated` and `src/routeTree.gen.ts`; `gen:check` fails until you do.
- Every user-visible string goes through `t()`; a test fails on an unused or missing key.

## Rules the build enforces

- Format and lint (Biome, including accessibility rules), `tsc` strict, no `any`, no `console.log`.
- Coverage of at least 85% lines; axe finds no violation on the pages and dialogs; the browser suite
  finds no CSP violation or console error.
- Dependencies are exact and locked. Add one with `npm install --save-exact`, commit `package-lock.json`,
  and say in the pull request why it is worth carrying. `npm audit` must stay clean (high and critical).
- No secrets in the repository: the pre-commit hook and CI both scan for them.
