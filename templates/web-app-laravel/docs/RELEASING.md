# Releasing

Versions follow [SemVer](https://semver.org/); commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`; `!` or a `BREAKING CHANGE:` footer for a major).
`main` is the trunk and is always releasable; tags are annotated `vX.Y.Z`.

## Per story (during development)

One commit per completed story. Subject: `feat: <story title>`. Body: the story's "Done when"
line and the evidence (the command you ran and what it printed). Tick the story in
`.aico/backlog.md` in the same commit.

## First release

`git init -b main`, first commit `chore: scaffold __APP_TITLE__ (aico template web-app-laravel@1.0.0)`.
When Iteration 0 passes `make check` and `make smoke`: `git tag -a v0.1.0 -m "v0.1.0"`.

## Each release

1. `make check` and `make smoke` pass; CI is green on the commit you will tag.
2. Move `## [Unreleased]` entries in `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`; add the comparison link.
3. If the API changed: `make openapi` was run and `docs/openapi.json` is committed (a test fails otherwise).
4. Commit `chore: release X.Y.Z`, then `git tag -a vX.Y.Z -m "vX.Y.Z"` and push the tag.
5. Build and push the image from that tag (`docker build -t registry/__APP_SLUG__:X.Y.Z .`), scan it
   (`trivy image`), then deploy: migrate job first, then the app, queue and scheduler.
6. Keep an SBOM with the release: `make sbom` writes `sbom.cdx.json`.

## Rolling back

Redeploy the previous tag. Migrations are additive within a minor version for exactly this reason:
ship the destructive half (dropping a column) one release after the code stopped using it.
