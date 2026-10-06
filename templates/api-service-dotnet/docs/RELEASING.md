# Releasing

SemVer, tagged on `main`, one changelog.

1. `make check` passes locally and CI is green on the exact commit you will tag (`gh run watch --exit-status`).
2. Move `## [Unreleased]` in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading and start a new empty
   `[Unreleased]`. Say what changed for a user of the API (new route, changed field, removed behaviour), and mark a
   breaking change as such: that decides the version number.
3. If the API surface changed, `Snapshots/openapi.v1.json` is already in the same commit (the contract test fails
   otherwise). A breaking contract change needs a new major version or a new route version, never a silent edit.
4. Commit: `chore(release): vX.Y.Z`. Tag it annotated: `git tag -a vX.Y.Z -m "vX.Y.Z"`; push the commit and the tag.
5. Build the image from the tag: `docker build -t <registry>/<name>:X.Y.Z .`; push it. Optionally `make sbom` and
   attach `artifacts/sbom/bom.json` to the release.
6. Deploy: run the one-shot migration with the new image first (`docker run --rm <image>:X.Y.Z --migrate`, with the
   production `ConnectionStrings__Default` and `Jwt__SigningKey`), then roll out the service. Migrations are written to
   be backward compatible with the previous version for one release (add columns before using them, drop them a
   release later), so a rollback of the service never meets a schema it cannot read.
7. After the first tag, `v0.1.0` marks "Iteration 0 passes every check"; from then on every completed story is its own
   Conventional Commit (`feat: ...`, `fix: ...`) with the story title and its "Done when" evidence in the body.
