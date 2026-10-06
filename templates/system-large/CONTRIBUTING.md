# Contributing

```sh
sh scripts/check.sh        # all checks (Docker only); pass a group to run one: yaml helm kustomize terraform otel rules drift scan
```

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`.
- One concern per pull request, with the test that fails without the change.
- Update `CHANGELOG.md` under `## [Unreleased]`.
- Never commit a secret, a rendered manifest (`chart-rendered.yaml`) or `.terraform/`.
