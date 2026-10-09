# Contributing to AICO

Thanks for helping. AICO is **source-available under the Functional Source License 1.1, Apache
2.0 future licence (FSL-1.1-ALv2)** (see [LICENSE](LICENSE)); contributions are
accepted under the same licence.

## Before you start

- Read [AGENTS.md](AGENTS.md) — the operating manual for anyone, human or AI,
  changing this repository — and the standards in [docs/engineering/](docs/engineering/README.md).
- Bugs and features: open an issue first (templates provided). **Security
  issues: a private [security advisory](https://github.com/suhail-akhtar/aico/security/advisories/new), never a public issue** ([SECURITY.md](SECURITY.md)).
- Anything that adds a dependency, a network listener, a persisted format or
  touches a security boundary needs an [ADR](docs/engineering/adr/README.md) first.

## Set up

```sh
npm ci && npm --prefix web ci && npm --prefix desktop ci   # Node 22.5+
node scripts/install-hooks.mjs                             # commit-msg + pre-push checks
npm run build && npm run build:web
```

Run the app against a throwaway store, never your real `~/.aico`:
`AICO_HOME=/tmp/aico-dev/.aico node dist/index.js serve --port 7340`.

## Before you open a PR

```sh
npm run typecheck
npm test                      # engine (offline, free)
npm run test:web:unit         # web client units
npm --prefix desktop test     # desktop units
npm run check:standards       # attribution, versions, licence, secrets, headers
```

Then verify the change live and fill in the PR template: what you ran, what
you saw, what you did not test. Live suites that call real models cost money —
say which you ran. Add a CHANGELOG entry under `## Unreleased`.

## Rules that are not negotiable

- No AI attribution in commits, PRs or docs (no co-author trailers naming an AI, no "generated with" footers).
- No secrets anywhere in the repository; tests use obviously fake values.
- Never describe AICO as open source or MIT-licensed.
- Keep changes focused; no unrelated reformatting.

Be kind; see the [Code of Conduct](CODE_OF_CONDUCT.md).
