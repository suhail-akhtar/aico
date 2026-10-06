# Releasing

Versions are [SemVer](https://semver.org). The app has no public API of its own; what is
versioned is the deployed behaviour and the contract it requires (`openapi/openapi.json`). A
change that needs a newer backend is a minor or major bump and is called out in the changelog.

## First commit and first tag

```sh
git init -b main
git add .
git commit -m "chore: scaffold from aico template web-app-react@1.0.0"
make check && make e2e
git tag -a v0.1.0 -m "v0.1.0: iteration 0 passes every check"
```

`v0.1.0` is tagged only after `make check`, the browser suite and the container smoke test pass:
that is the definition of Iteration 0 being done (`.aico/backlog.md`).

## Per story

One commit per finished story, [Conventional Commits](https://www.conventionalcommits.org/), the
story title as the subject and its "Done when" evidence in the body:

```
feat: add orders list and form

Done when: src/features/orders/OrdersPage.test.tsx passes (12 tests); e2e/orders.spec.ts
passes at 1280 and 390; axe reports nothing on the page and its dialogs.
```

## Cutting a release

1. CI is green on the exact commit you will tag (`gh run watch --exit-status`).
2. Move the `## [Unreleased]` entries in `CHANGELOG.md` under `## [X.Y.Z] - date`.
3. Bump `version` in `package.json` (`npm version minor --no-git-tag-version`), commit
   `chore: release X.Y.Z`.
4. `git tag -a vX.Y.Z -m "vX.Y.Z"` and push the tag.
5. Upload the source maps to your error tracker (the Docker build deletes them), build the image from
   the tag, record its digest, and deploy that digest, not a tag.
6. Keep the `openapi/openapi.json` of each release: a backend that must serve two app versions at once
   needs both contracts.

## Rollback

Redeploy the previous image digest. The app is static and holds no state, so there is nothing to
migrate back; the only coupling is the contract, and a change to it is additive until the old app version
is gone. Browsers cache `index.html` with `no-cache` and assets by fingerprint, so a rollback is picked up on
the next navigation.
