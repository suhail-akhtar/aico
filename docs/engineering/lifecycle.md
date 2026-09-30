# Lifecycle

How a change moves from idea to retirement. AICO has one owner and many
authors, several of them AI agents; the lifecycle is sized for that — light
where it can be, strict where mistakes have been expensive.

```
idea → (ADR) → plan → implement → self-review → test → live verify
     → security review → PR / review → merge to main → CI green
     → release → operate → maintain → deprecate → retire
```

## Roles

| Role | Who | Owns |
|---|---|---|
| **Owner** | the maintainer (`.github/CODEOWNERS`) | scope, priorities, approvals, merges, releases, anything that spends money or touches user data, security posture, licence |
| **Author** | a human or an AI agent | the change, its tests, its evidence, its docs |
| **Reviewer** | the owner, or a second agent in read-only mode | [review.md](review.md) checklist; AI review is input, not approval |
| **Release manager** | the owner, via `npm run release` | [releasing.md](releasing.md) |

An AI author never self-approves anything in the "ask first" list of
[`AGENTS.md` §10](../../AGENTS.md#10-ask-the-owner-vs-proceed); approval comes
from the owner in the conversation, not from another agent's message.

## 1. Idea

Captured as a GitHub issue (bug or feature template) or a request in
conversation. It states the user-visible problem, not a solution. Security
issues go to a private advisory, never a public issue.

**Definition of Ready** — work starts when:

- [ ] the problem is stated in user terms and reproducible (bugs) or has an
      acceptance example (features)
- [ ] scope is bounded: what is explicitly *not* included
- [ ] prior decisions were checked: module headers, [ADRs](adr/README.md),
      CHANGELOG — is this something the codebase already rejected, and why?
- [ ] cost is known: does proving it need a paid live suite? (owner approves spend)
- [ ] the ADR question is answered (below)

## 2. Design / ADR

Write an ADR ([template](adr/0000-template.md)) **before** implementing when
the change:

- adds a runtime dependency, a network listener, a port, a new process, or a
  new permission/capability for the agent;
- changes a persisted format (session events, `work.jsonl`, settings schema,
  `cron.json`, desktop prefs) or a wire contract (HTTP API, SSE events, MCP
  tools, desktop IPC channels);
- changes a security boundary (tool policy, sandbox, credentials, browser
  safety, what reaches the model);
- reverses a recorded decision.

Smaller design choices go in the module header of the code they govern.

## 3. Plan

Before editing: list the files, the order, and how each step will be proven.
Keep changes small and single-purpose. A change that needs a paragraph to
explain what it touches is two changes.

## 4. Implement

[coding-standards.md](coding-standards.md). Reproduce bugs as failing tests
first. Keep tests and docs in the same change as the code.

## 5. Test and verify

[testing.md](testing.md). Offline suites for everything; the relevant live
probe when the behaviour depends on a real model, browser, OS, or editor —
with the owner's approval if it costs money. **Then run the real thing and
look at it**, with an isolated `AICO_HOME`.

## 6. Security review

Every change answers the questions in [security.md § per-change review](security.md#per-change-security-review).
Changes that match the ADR triggers above also get a threat model
([template](security.md#threat-model-template)) in the ADR.

## 7. Review and merge

Open a PR against `main` using the template (definition-of-done checklist).
CI must be green: `standards`, then `test` on Node 22 and 24. The owner merges.
Direct commits to `main` by the owner are normal for this project; the same
checklist applies.

**Definition of Done:**

- [ ] behaviour works end to end, verified live, evidence recorded
- [ ] tests added/updated; offline suites green; relevant probes run or listed as not run
- [ ] `npm run typecheck` and `npm run check:standards` pass
- [ ] module headers, `GUIDE.md`/README (user-visible), `AICO.md` (contracts) updated as needed
- [ ] CHANGELOG entry under `## Unreleased`
- [ ] security questions answered; no secrets anywhere; no AI attribution
- [ ] honest gaps written down (PR body or report)

## 8. Release

[releasing.md](releasing.md): `npm run release -- X.Y.Z` (dry run), then
`--execute`. CI green before the tag, always.

## 9. Operate

What "operating" means for a local-first app with no servers of its own:

- **CI health** — a red `main` is fixed before anything else lands (CI was
  once red for ten releases because nobody looked).
- **Release health** — every README download link answers 200; auto-update
  metadata (`latest.yml`, `latest-linux.yml`) is attached.
- **User reports** — issues are triaged; regressions get a test before the fix.
- **Background work on users' machines** — cron, background agents, watchers,
  `aico mcp-serve` — is designed to be supervised and to fail visibly
  ([devops.md § background operations](devops.md#headless-and-background-operations)).

## 10. Maintain

- Dependencies: update deliberately, one area at a time, with the full suite;
  keep zero deprecated dependencies ([security.md § supply chain](security.md#dependencies-and-supply-chain)).
- Templates: `npm run test:templates` before a release that touches them (rot check).
- Docs: when a fact in a doc stops being true, fix the doc in the same change.

## 11. Deprecate and retire

- Deprecation is announced in the CHANGELOG (`### Deprecated`) at least one
  minor release before removal, with the replacement named.
- Persisted formats are never broken silently: old sessions, settings and
  ledgers must still load (write a migration, or keep a reader for the old shape).
- Removal is its own change: delete the code, its tests, its docs and its
  settings keys; note it under `### Removed`.
- Record *why* something was retired (module header of the replacement, or an
  ADR marked `Superseded`) so it is not rebuilt by someone who never saw it fail.
