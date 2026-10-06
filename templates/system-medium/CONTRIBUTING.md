# Contributing

## Run the checks

```
make check        # lint, tests with coverage gates, dependency audit, image build
make fmt          # google-java-format (api) and biome (web)
docker compose up --build --wait && node scripts/smoke.mjs     # the whole system
```

Without `make`: `cd services/api && ./mvnw verify` (`mvnw verify` on Windows; Docker must be running
for the integration tests) and `cd services/web && npm run check`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`,
`refactor:`, `chore:`. One commit per finished story; the body says why and quotes the backlog
story's "Done when" evidence.

## Before opening a pull request

- `make check` passes and the smoke test passes against a fresh `docker compose up`.
- New behaviour has a test; a bug fix has a test that failed before the fix.
- `CHANGELOG.md` has a line under `## [Unreleased]`.
- No secrets, no `.env` files, no commented-out code.
