# Contributing

```sh
make check      # each service's own checks (format, lint, types, tests, audit)
make e2e        # the whole stack up, then the Playwright suite through the gateway
```

No `make` (Windows)? The targets are one or two commands each; run them directly.

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `test:`.
  One concern per pull request, with the test that fails without it. Update `CHANGELOG.md` under `[Unreleased]`.
- A contract change edits `services/api/openapi.json` and `services/web/openapi/openapi.json` together, then
  `npm run gen` in `services/web`. A new secret is added to `.env.example` as `change-me-...`, never as a value.
- Images stay pinned by digest and actions by commit SHA; Dependabot proposes the bumps.
