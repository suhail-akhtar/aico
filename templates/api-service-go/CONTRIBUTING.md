# Contributing

## Setup and checks

```sh
make setup           # .env with generated secrets
make db-up           # PostgreSQL on 127.0.0.1:5432 for the integration tests
make check           # format, lint, vet, tidy, generated code, tests (-race, 85% gate), audit
make docker-check    # the same inside the pinned tools image: no local Go needed
```

No `make` (Windows)? `docker compose --profile tools run --rm tools make check` is the same gate in one
command. `make help` lists every verb.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat: ...`, `fix: ...`, `docs: ...`,
  `chore: ...`, `refactor: ...`, `test: ...`. A breaking change is `feat!:` with a `BREAKING CHANGE:` footer.
- One concern per pull request. Include the test that fails without the change.
- Update `CHANGELOG.md` under `## [Unreleased]` for anything a user of the API would notice.
- If you change an endpoint or a schema, edit `api/openapi.yaml` first, run `make gen`, and commit the generated
  code; CI fails if it is stale. If you change a query, run `make gen` too.
- If you change the schema, add a migration (`docs/EXTENDING.md`); never edit one that has shipped.

## Rules the build enforces

- Generated code (`internal/api`, `internal/platform/database/dbgen`) is never edited by hand (`make gen-check`).
- `go.mod` and `go.sum` are tidy and verified; add a dependency only with a line in `.aico/decisions.md`
  saying what it replaces and why it is worth carrying.
- Every repository change passes the shared contract suite for the in-memory fake and PostgreSQL.
- No secrets in the repository: pre-commit and CI both scan for them. A test canary must be obviously fake and
  carry `standards-allow: secret`.
- The public routes in code equal the `security: []` operations in the OpenAPI document (a test).
