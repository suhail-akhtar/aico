# AICO engineering standards

How AICO is built, changed, tested, secured, released and operated. These
documents are normative: "must" means must. The short version for agents is
[`AGENTS.md`](../../AGENTS.md); the product's own architecture memory is
[`AICO.md`](../../AICO.md). Where these documents and a module header disagree,
the module header is closer to the code — fix whichever is wrong.

## Reading order

| # | Document | Read it when |
|---|---|---|
| 1 | [principles.md](principles.md) | always, once — the design philosophy every rule derives from |
| 2 | [architecture.md](architecture.md) | before touching code outside one module |
| 3 | [lifecycle.md](lifecycle.md) | before starting any non-trivial change: idea → ADR → build → review → release → operate → retire |
| 4 | [coding-standards.md](coding-standards.md) | before writing code |
| 5 | [testing.md](testing.md) | before writing or running tests; before claiming something works |
| 6 | [security.md](security.md) | before touching tools, providers, servers, the desktop browser, credentials, dependencies |
| 7 | [review.md](review.md) | before opening or reviewing a change |
| 8 | [devops.md](devops.md) | CI/CD, versioning, background operations and supervision |
| 9 | [releasing.md](releasing.md) | before cutting a release |
| 10 | [ai-contributors.md](ai-contributors.md) | if you are an AI agent — the protocol, parallel-agent etiquette, evidence rules |
| — | [adr/](adr/README.md) | decisions already made, and why; the template for new ones |

## What is machine-enforced

| Rule | Where it is enforced |
|---|---|
| No AI attribution in commits / docs | `.githooks/commit-msg`, `.githooks/pre-push`, CI `standards` job (`scripts/check-standards.mjs`) |
| Versions, lockfiles, README links, website stamps agree | `check-standards` (full + release modes), `scripts/release.mjs` |
| CHANGELOG section for the package version | `check-standards` |
| Licence strings (no MIT / "open source" claims) | `check-standards` |
| No committed secrets (high-confidence patterns, `.env`, keys) | `check-standards` |
| New modules carry a header comment | `check-standards` (added files only) |
| Guards can only deny | `GuardVerdict = abstain \| deny` in `src/tools/pipeline.ts` |
| Read before edit | `src/tools/observation.ts` |
| No tool runs forever | `src/tools/timeout-policy.ts` |
| A web artifact is verified before a turn completes | `src/verification.ts` |
| Settings UI cannot write redacted secrets back | `assertNoSecrets()` in `web/src/settings-schema.ts` |
| CI green before tag | `scripts/release.mjs` step 7 |

Everything else is advisory: the author and the reviewer are the enforcement.
[review.md](review.md) lists what to check by hand; the report at the end of
[ai-contributors.md](ai-contributors.md) is how you show you did.

## Changing these standards

Standards change like code: a small PR that says why, with the evidence (the
incident, the bug, the measurement). A rule with no reason attached is the
first to be ignored, so every rule here should be traceable to something that
happened. If a rule becomes checkable, move it into `scripts/check-standards.mjs`
with a test in `scripts/test-check-standards.mjs` and mark it `[M]` in `AGENTS.md`.
