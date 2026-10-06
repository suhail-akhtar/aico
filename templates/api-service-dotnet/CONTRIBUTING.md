# Contributing

## Set up

```sh
make setup            # restores local tools and packages (locked)
cp .env.example .env
make dev
```

Needs the .NET 10 SDK (`global.json`) and, for `make up` and `make test-pg`, Docker.

## Before you push

`make check` runs what CI runs: format check, analyzers as errors, tests with the 85 % coverage gate, and the
vulnerability audit. `make test-pg` runs the suite on a real PostgreSQL. Install the hooks once with
`pip install pre-commit && pre-commit install` (format, secret scan).

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`,
  `test:`; `!` or a `BREAKING CHANGE:` footer for a breaking API change.
- One concern per pull request; the body says why. A finished story's commit body quotes its "Done when" evidence.
- An API change includes the reviewed `tests/ApiService.Tests/Snapshots/openapi.v1.json` diff. A schema change
  includes its migration (`make migration name=...`). Add a line under `## [Unreleased]` in `CHANGELOG.md`.
- Never commit secrets. A test canary must be obviously fake and say `standards-allow: secret` on its line.

## Architecture rules

`docs/ARCHITECTURE.md`. They are tests; a violation names the offending type.
