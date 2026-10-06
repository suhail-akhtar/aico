# Contributing

## Run the checks

```
make check        # format + lint + unit + integration tests + 85% coverage gate + dependency audit
make fmt          # fix formatting (google-java-format)
```

Without `make`: `./mvnw verify` (`mvnw verify` on Windows) is the same gate minus the audit, and
`node scripts/audit.mjs` is the audit. Integration tests use PostgreSQL in Docker when Docker is
running and H2 otherwise (`AICO_TEST_DB=postgres` forces PostgreSQL and fails if Docker is missing;
CI sets it).

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`,
`refactor:`, `chore:`. One commit per finished story. The body says why, and for a backlog story
quotes its "Done when" evidence. Breaking changes carry `!` and a `BREAKING CHANGE:` footer.

## Before opening a pull request

- `make check` passes.
- New behaviour has a test; a bug fix has a test that failed before the fix.
- `CHANGELOG.md` has a line under `## [Unreleased]`.
- Structure rules in `docs/ARCHITECTURE.md` still hold (the architecture tests enforce them).
- No secrets, no `.env` files, no commented-out code.

## Releasing

See `docs/RELEASING.md`.
