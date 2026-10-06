# Releasing

Versions follow [Semantic Versioning](https://semver.org/); commits follow Conventional Commits.
The first tag, `v0.1.0`, is made when Iteration 0 passes every check.

1. `main` is green: `make check` locally and CI on the exact commit.
2. Decide the version from the commits since the last tag (`feat` = minor, `fix` = patch,
   `!` or `BREAKING CHANGE` = major; while below 1.0, breaking changes bump the minor).
3. Move the `## [Unreleased]` entries in `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`.
4. Set the version: `./mvnw versions:set -DnewVersion=X.Y.Z -DgenerateBackupPoms=false`, and the
   same number in `OpenApiConfig` (`Info.version`) and the `project.build.outputTimestamp`
   property (today's date, so the jar stays reproducible).
5. Commit: `chore(release): vX.Y.Z`.
6. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"` and push the commit and the tag.
7. Build and publish the image from that tag (`docker build -t <registry>/api-service:X.Y.Z .`),
   plus the SBOM `target/classes/META-INF/sbom/application.cdx.json` as a release asset.
8. Bump to the next development version only if you use `-SNAPSHOT` versions; this starter does not.

Rollback: redeploy the previous image tag. Flyway migrations are forward-only, so a release that
adds a migration must be backwards compatible with the previous application version (expand, then
contract in a later release).
