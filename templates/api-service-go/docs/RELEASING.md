# Releasing

Versions are [SemVer](https://semver.org). The API is versioned in the URL (`/v1`): a breaking
change to a route's contract is a new prefix, not a new minor version of this service. Within `/v1`,
changes are additive only (new routes, new optional fields, new response fields).

## First commit and first tag

```sh
git init -b main
git add .
git commit -m "chore: scaffold from aico template api-service-go@1.0.0"
docker compose --profile tools run --rm tools make check   # or: make check
sh scripts/smoke.sh                                         # the built stack answers over HTTP
git tag -a v0.1.0 -m "v0.1.0: iteration 0 passes every check"
```

`v0.1.0` is tagged only after `make check` and the container smoke test pass: that is the definition of
Iteration 0 being done (`.aico/backlog.md`).

## Per story

One commit per finished story, [Conventional Commits](https://www.conventionalcommits.org/), with the
story title as the subject and its "Done when" evidence in the body:

```
feat: add orders resource

Done when: internal/features/orders tests pass against the memory fake and PostgreSQL;
the cross-user cases return 404; api/openapi.yaml lists the five new routes.
```

## Cutting a release

1. CI is green on the exact commit you will tag (`gh run watch --exit-status`).
2. Move the `## [Unreleased]` entries in `CHANGELOG.md` under `## [X.Y.Z] - date` and update the links.
3. Commit `chore: release X.Y.Z`, then `git tag -a vX.Y.Z -m "vX.Y.Z"` and push the tag.
4. Build from the tag with the stamp: `make docker VERSION=X.Y.Z` (or CI). The binary reports it
   (`server version`, and the `starting` log line). Record the image digest; deploy that digest, not a tag.
5. Run the migrations of the new version before it takes traffic (`server migrate`, or leave
   `MIGRATE_ON_START=true` for a single replica).

## Rolling back

Images are immutable: redeploy the previous digest. Migrations are forward-only in production (the
`Down` sections exist for development). Write each migration so the previous version still works
against it (add columns as nullable or defaulted, and remove them one release later).
