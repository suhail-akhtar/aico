# Releasing

The release checklist, and the script that runs it. Until 0.28.0 every release
was cut by hand from a note that grew one line per mistake; the mistakes are
listed at the bottom because each is now a step. **Use the script.** The manual
steps are documented so you can understand it, audit it, and recover if a
step fails.

## TL;DR

```sh
# 1. On main, clean tree, CI green, CHANGELOG has "## Unreleased" with the notes
npm run release -- 0.29.0              # dry run: preflight, the full diff, every command
npm run release -- 0.29.0 --execute    # do it (asks nothing; stops on the first problem)
# optional: --vsix 0.6.24 when the VS Code extension changed
```

Re-running after a failure resumes: if `package.json` already carries the
version, the bump is skipped and the script continues at push / CI / tag, and
steps that already happened (tag, release) are detected.

## Prerequisites

- On `main`, up to date with `origin/main`, clean working tree.
- `gh` logged in (`gh auth status`) — by the owner; the script never handles credentials.
- `CHANGELOG.md` has `## Unreleased` (or `## X.Y.Z`) with a real summary paragraph.
- Hooks installed (`node scripts/install-hooks.mjs`) — the release commit goes through them.
- Decide: patch or minor ([devops.md § versioning](devops.md#versioning-semver-pre-10));
  does the VS Code extension need a new version?

## What the script does (the checklist)

| # | Step | Command / check | Why it exists |
|---|---|---|---|
| 1 | Preflight | on `main`; clean tree; not behind origin; tag absent locally and on origin; `gh` authed; CHANGELOG section present; README download table still has its shape | 0.18.1: wrong branch name; releasing unpulled work |
| 2 | Bump versions | root `package.json` + `package-lock.json` (top + `packages[""]`), `desktop/package.json` + lockfile, optional `vscode-extension/package.json` + lockfile, README (download links, `#vX.Y.Z`, `#release/vX.Y`, VSIX name), `SECURITY.md` supported line (`X.Y.x`), every `docs/*.html` stamp (`<span class="ver">`, `softwareVersion`, install pins, examples), CHANGELOG heading dated | 0.26.0: README links carried the old version; `docs/install.html`/`vscode.html` were 20 releases stale. Stamp patterns live in one table: `scripts/lib/release-stamps.mjs` |
| 3 | Standards | `node scripts/check-standards.mjs --release X.Y.Z` | the same table verifies what step 2 wrote |
| 4 | Local tests | `npm run typecheck`, `npm test`, `npm run test:web:unit`, `npm --prefix desktop run typecheck`, `npm --prefix desktop test`, `npm run test:standards` | 0.21.0: `test:web:unit` is not in `npm test` |
| 5 | Build the VSIX | `npm --prefix vscode-extension run package` → `vscode-extension/aico-vscode-<ver>.vsix` | 0.20.0: the old root script skipped the webview panel and shipped a stale `media/panel.js` |
| 6 | Commit + push | `Release X.Y.Z: <first sentence of the CHANGELOG summary>`; only the edited files; hooks run; `git push origin HEAD:main` | no attribution; never `--no-verify` |
| 7 | **Wait for CI** | `gh run list --workflow ci.yml --commit <sha>` → `gh run watch <id> --exit-status` | 0.21.0: CI had been red for ~10 releases unnoticed. **Never tag on red.** |
| 8 | Tag + branch | `git tag -a vX.Y.Z`; new minor → `git branch release/vX.Y` + push; patch → verify fast-forward, `git push origin HEAD:refs/heads/release/vX.Y` (never forced); push the tag | per-minor branches only |
| 9 | GitHub release | `gh release create vX.Y.Z <vsix> --title X.Y.Z --notes-file <CHANGELOG section> --verify-tag` | `desktop.yml` waits for the release to exist before attaching |
| 10 | Desktop assets | watch `desktop.yml` for the tag; assert assets: `AICO-Setup-X-win-x64.exe`, `AICO-X-linux-x64.AppImage`, `AICO-X-linux-x64.deb`, `latest.yml`, `latest-linux.yml`, the VSIX | without `latest*.yml` installed copies never update |
| 11 | Link check | `curl -sIL` every README `releases/download/…` link → 200 | a broken download link is the first thing a new user sees |
| 12 | Website | `https://suhail-akhtar.github.io/aico/` shows `v<X.Y.Z>` (Pages serves `docs/` from `main`; retries 10 min, warning only) | |

The script never: force-pushes, moves a tag, creates `release/vX.Y.Z`, skips
hooks, runs paid suites, or publishes to npm.

## By hand, after the script

- **npm publish** — not done; `@suhail-akhtar/aico` is not on npm and installs
  are `npx github:suhail-akhtar/aico#vX.Y.Z`. Only the owner ever runs `npm publish`.
- **Sitemap** — `npm run sitemap` only when pages were added/removed; review its
  diff (it has dropped `miniapps.html` and priorities before).
- **Templates** — if templates changed, `npm run test:templates` before step 1.
- **Announce**, and record anything surprising at the bottom of this file.

## Manual recovery

| Failure | Do |
|---|---|
| Tests fail in step 4 | nothing was committed; fix on `main`, re-run |
| CI red in step 7 | do **not** tag; fix forward on `main` (the release commit stays), re-run the same command — it resumes |
| Tag pushed, release creation failed | re-run; it detects the tag and creates/updates the release |
| `gh release create` left a broken draft (GitHub 500s) | `gh release edit vX.Y.Z --draft=false --tag vX.Y.Z` |
| Desktop workflow failed | fix, then `gh workflow run desktop.yml -f release=vX.Y.Z` (attaches with `--clobber`) |
| Wrong content released | never delete or move the tag; release the next patch |
| `release/vX.Y` is not an ancestor of HEAD | stop; this needs the owner (it would need a force-push) |

## Release history lessons

- **0.18.1** — created `release/v0.18.1` instead of fast-forwarding `release/v0.18`.
- **0.19.1** — `gh release create` hit transient 500s and left a draft under a wrong tag.
- **0.20.0** — root `build:vscode` skipped the webview; stale panel in the VSIX.
- **0.21.0** — `test:web:unit` was never run and CI was red for ~10 releases.
- **0.23.0** — desktop tests joined CI; desktop version = engine version.
- **0.24.0** — first release with `latest*.yml`; a release without them strands users.
- **0.26.0** — README direct download links need bumping every release.
- **0.28.0** — licence changed; `docs/install.html` (a 0.7 example) and `docs/vscode.html` (a 0.6.4 VSIX) found stale by the new checker, and `SECURITY.md` still named `0.3.x` as the supported line.
