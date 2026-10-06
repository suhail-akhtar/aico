# Contributing

- **Run the checks before you push:** `make check` (Pint, PHPStan level 10, tests with the 85%
  coverage gate, `composer audit`). If you touched the Dockerfile or runtime config: `make smoke`.
  No PHP needed, only Docker.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
  `refactor:`, `test:`, `chore:`), imperative subject, the body says why. One story per commit.
- **Tests with the change.** A bug gets a failing test first. A new feature copies the `Items` test files
  (ownership, validation, hostile input).
- **API changes:** run `make openapi` and commit `docs/openapi.json`; a test fails if it is stale.
- **Formatting is automatic:** `make fmt`. Optional git hook: `pre-commit install` (see `.pre-commit-config.yaml`).
- **Never commit secrets.** `.env` is git-ignored; `.env.example` holds placeholders only.
- Record a non-obvious choice (a dependency, a pattern, a security trade-off) in `.aico/decisions.md`.
