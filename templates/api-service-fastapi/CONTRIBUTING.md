# Contributing

## Setup and checks

```sh
make setup      # uv sync --locked, installs the pre-commit hook
make check      # format check, lint, mypy --strict, tests with the 85% gate, dependency audit
make test-pg    # the same tests against PostgreSQL (needs Docker)
```

No `make` (Windows)? Run the lines in the `Makefile`; each is a single `uv run ...`.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat: ...`, `fix: ...`,
  `docs: ...`, `chore: ...`, `refactor: ...`, `test: ...`. A breaking change is `feat!:`
  with a `BREAKING CHANGE:` footer.
- One concern per pull request. Include the test that fails without the change.
- Update `CHANGELOG.md` under `## [Unreleased]` for anything a user of the API would notice.
- If you change an endpoint or a schema, run `make openapi` and commit `openapi.json`;
  the contract test fails until you do.
- If you change a model, add a migration (`docs/EXTENDING.md`); the migration test fails
  when models and migrations disagree.

## Rules the build enforces

- Layering: `core` imports no feature; a feature imports another only through its package
  (`tests/unit/test_architecture.py`).
- No secrets in the repository: the pre-commit hook and CI both scan for them.
- Dependencies are exact and locked. Add one with `uv add`, commit `uv.lock`, and say in
  the pull request why it is worth carrying.
