## What and why

<!-- The user-visible problem and what this change does about it. One concern per PR. -->

## How it was verified

<!-- Exact commands and results (counts, exit codes). What you ran live, with an
isolated AICO_HOME, and what you saw. Screenshots for UI. -->

## Not verified / known gaps

<!-- What you did not run and why (cost, platform, access). What is partial. -->

## Definition of done

- [ ] Works end to end, verified live (evidence above)
- [ ] Bug fixes: a test that fails without the fix
- [ ] Tests added/updated; `npm test` · `npm run test:web:unit` · `npm --prefix desktop test` green as relevant
- [ ] `npm run typecheck` (and desktop typecheck if touched) passes
- [ ] `npm run check:standards` passes
- [ ] Paid/live suites: run with approval, or listed above as not run
- [ ] Module headers / `AICO.md` / `GUIDE.md` / README updated where behaviour or contracts changed
- [ ] CHANGELOG entry under `## Unreleased`
- [ ] ADR written if this adds a dependency, listener, process, persisted format, wire contract or security boundary

## Security

- [ ] New agent capability, listener, process, URL fetch, or secret flow? If yes, explained below and threat-modelled in the ADR
- [ ] No secrets in code, tests, fixtures, logs or this description
- [ ] Untrusted content (files, pages, tool/MCP output) cannot change policy

## Project policy

- [ ] No AI attribution anywhere (commits, this description, docs)
- [ ] No "open source"/"MIT"/"Apache" claims about AICO (it is source-available under FSL-1.1-ALv2)
- [ ] No unrelated changes (reformatting, renames, drive-by refactors)

Standards: [AGENTS.md](../AGENTS.md) · [docs/engineering/review.md](../docs/engineering/review.md)
