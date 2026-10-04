# 0026 — Check security automatically while the code is written: static scan, dependency gates, a DAST suite against the real engine, and a security check in the agent's own gate

- **Status:** Accepted (2026-10-04)
- **Date:** 2026-10-04
- **Deciders:** owner (+ authors)
- **Supersedes / related:** [0002](0002-guards-only-deny.md) (guards only deny), [0006](0006-credential-broker.md) (credential broker), [security.md](../security.md#automated-security)

## Context

Until now AICO's security checks were human: a per-change review checklist,
a `/security-review` style pass, and `check-standards`' secret scan. A review
in October 2026 found real problems that a machine could have flagged the day
they were written: a stored provider key sent to a caller-chosen `baseUrl`
(`providers/test`), a prefix-matched `Origin` check, a cloned repository's
`.aico/settings.json` able to switch on `autoApprove` or `danger-full-access`,
guards that read a malformed decision as "allow", hook commands returned
unredacted by `GET /api/settings`, and unguarded `fetch` of model-chosen URLs.
Each is cheap to catch in the commit that introduces it and expensive after a
release.

The owner's requirement: security integrated into the coding phase through
automated static and dynamic analysis, penetration testing and compliance
scanning — and the same for the code AICO writes for its users.

Constraints: no new runtime or dev dependency (AGENTS.md §6); the standards
job runs with node and git only; paid suites only on request; never touch the
real `~/.aico`.

## Decision

Five layers, each enforced in code:

1. **SAST, fast** — `scripts/security-scan.mjs`, rules in
   `shared/security/rules.mjs` (one copy, imported by the scanner,
   `check-standards` and the engine). Generic rules (command/SQL injection,
   eval, TLS off, unsanitised HTML, weak randomness for secrets, secrets in
   logs; JS/TS, Python, Go) plus AICO rules (Electron webPreferences,
   `openExternal` without a scheme check, engine `fetch` outside the SSRF
   guard, filesystem writes on request paths, **every `/api` route classified**
   in `scripts/security/routes.json`, **critical settings keys** never `allow`
   in the project-layer policy). Existing findings live in a reviewed baseline
   (`scripts/security/baseline.json`, each `accepted` or `open` with a note);
   CI fails only on new ones; open ones print on every run. Waiver in place:
   `security-allow: <rule> — reason`. Runs in the **pre-commit hook** (staged
   content, ~0.1 s) and the CI `security` job.
2. **SAST, deep** — CodeQL, `security-extended`, on push/PR and weekly
   (`.github/workflows/codeql.yml`).
3. **Supply chain** — `scripts/security-deps.mjs`: lockfiles resolve only
   from `registry.npmjs.org` with sha512 integrity, no git/URL/file specs;
   production licences permissive (copyleft, non-commercial, unknown fail
   unless recorded in `licence-exceptions.json`); `npm audit --omit=dev` for
   all five shipped lockfiles, high/critical fail unless in
   `audit-allowlist.json` **with an expiry**; CycloneDX SBOMs via the
   built-in `npm sbom`, kept as a CI artifact and attached to every release
   (`desktop.yml`); Dependabot for npm and Actions.
4. **DAST / pen-test** — `scripts/security-dast.mjs` starts `dist/index.js
   serve` in a temp store and attacks every route found in the source:
   token/Origin/Host, CSRF shapes, traversal, oversized/malformed bodies,
   SSRF (including a capture server proving where a key went), human-only
   decisions with only the token (with a positive control), canary secrets in
   responses, the SSE stream and every file written, and a seeded fuzz pass.
   Confirmed, not-yet-fixed findings may be listed in
   `scripts/security/dast-known.json` and print as KNOWN; a fixed one prints
   FIXED. CI job `dast`, ~45 s. Fail-closed guards are pinned by
   `scripts/security-failsafe-test.mjs` (in `npm test`).
5. **The agent's own gate** — a built-in `security` check
   (`src/security/project-scan.ts`) joins RunChecks wherever a project has
   checks: secrets and code rules on the **lines the turn added**, dependency
   audit when a manifest changed, and bandit/gosec/semgrep only if already on
   PATH (semgrep only with the project's own config). Secrets, high findings
   and high/critical advisories fail it, so the completion gate refuses
   "done"; medium findings are reported. `completionGate.security: false`
   turns it off (a person's setting).

## Alternatives considered

| Option | Why not |
|---|---|
| ESLint security plugins / semgrep as dependencies | New dev dependencies and rule packs to keep current; the line rules plus CodeQL cover the same ground without either. semgrep stays optional on the agent side. |
| Fail CI on every existing finding | 32 pre-existing findings would make CI red until all were fixed or blanket-waived; a reviewed baseline keeps them visible without teaching people to ignore red. |
| A third-party SBOM generator (cyclonedx-npm) | `npm sbom` (npm ≥ 10) writes CycloneDX from the lockfile; no dependency. |
| DAST with an external scanner (ZAP) | Needs a JVM/container and a crawl of an API it cannot discover; a route list from source plus targeted attacks tests what matters in < 1 minute. |
| Security check for every project, even with no checks | Changes the gate's documented "silent where nothing is defined" behaviour; deferred. |

## Consequences

- **Good:** the cheap mistakes are caught before a commit exists; a new route
  or settings key has to be classified on purpose; every release carries an
  SBOM; the agent cannot claim "done" over a key it just wrote.
- **Bad / costs:** a CI minute for DAST; regex rules have false positives
  (mitigated by the baseline and the one-line waiver); the route and settings
  registries are two more files to keep in step (the scan tells you when).
- **Honest limits:** line rules do not track data flow (CodeQL does, for
  JS/TS only); `npm audit` knows only published advisories; DAST covers
  `aico serve`, not the desktop's IPC or the MCP server; the agent check sees
  files written through the write path, not files a Bash command changed.
- **Migration:** none for users. Contributors get a pre-commit hook on the
  next `npm install`.

## Threat model

Not a new boundary: the decision adds checks, no capability, listener or
secret flow. The DAST suite starts a loopback server on a random port in a
temp store and a loopback capture server; both die with the run.

## Verification

- `node scripts/test-security-scan.mjs` — every rule fires and has a
  near-miss; baseline, waiver, route and settings registries.
- `node scripts/security-check-test.mjs` — the agent check fails a written
  key / interpolated SQL, ignores lines the turn did not write, and blocks the
  completion gate.
- `node scripts/security-dast.mjs` and `node scripts/security-failsafe-test.mjs`.
- Reverting any of these makes its test (or the CI job) fail.
