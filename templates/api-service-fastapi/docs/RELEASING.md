# Releasing

Versions are [SemVer](https://semver.org). The API is versioned in the URL (`/v1`): a
breaking change to a route's contract is a new prefix, not a new minor version of this
package. Within `/v1`, changes are additive only.

## First commit and first tag

```sh
git init -b main
git add .
git commit -m "chore: scaffold from aico template api-service-fastapi@1.0.0"
make check && make test-pg
git tag -a v0.1.0 -m "v0.1.0: iteration 0 passes every check"
```

`v0.1.0` is tagged only after `make check` and the container smoke test pass: that is the
definition of Iteration 0 being done (`.aico/backlog.md`).

## Per story

One commit per finished story, [Conventional Commits](https://www.conventionalcommits.org/),
with the story title as the subject and its "Done when" evidence in the body:

```
feat: add orders resource

Done when: tests/integration/test_orders.py passes (9 tests); the cross-user
cases return 404; openapi.json lists the five new routes.
```

## Cutting a release

1. CI is green on the exact commit you will tag (`gh run watch --exit-status`).
2. Move the `## [Unreleased]` entries in `CHANGELOG.md` under a new `## [X.Y.Z] - date` heading
   and update the compare links.
3. Bump `version` in `pyproject.toml` (`uv version --bump minor` then `uv lock`); commit
   `chore: release X.Y.Z`.
4. `git tag -a vX.Y.Z -m "vX.Y.Z"` and push the tag.
5. Build and publish the image from that tag; record its digest. Deploy that digest, not a tag.
6. Keep `openapi.json` of each release so the next one can be diffed against it for breaking
   changes (`oasdiff breaking old.json openapi.json`).

## Database changes

Migrations are forward-only in production and run before the new version starts (the
`migrate` step). Ship a change that needs both an old and a new schema in two releases:
add (compatible), deploy, switch the code, then remove in a later release. Never edit a
migration that has been released.

## Rollback

Redeploy the previous image digest. If the new release added a migration, the old code must
still work against the new schema: that is what the two-release rule above guarantees. A
`downgrade()` exists for development and is tested, but is not how production is rolled back.
