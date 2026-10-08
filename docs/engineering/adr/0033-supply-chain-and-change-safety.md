# 0033 — Check packages before they are installed, and scan what an agent changed: supply chain, secrets, SAST and test tampering

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** owner (+ authors)
- **Supersedes / related:** [0002](0002-guards-only-deny.md) (guards only deny), [0007](0007-ops-tools-and-dependencies.md), [0026](0026-shift-left-security.md) (the `security` check this extends), [0027](0027-shell-confinement.md) (the person-required pattern this copies), [0034](0034-evidence-ci-agent-flaky-tests.md) (reads the records defined here)

## Context

Three failure modes of a coding agent that a unit-test run does not catch, each
of which has an incident class behind it in the industry:

1. **Hallucinated or squatted packages.** Models invent plausible package names
   ("slopsquatting"). If the name does not exist the install fails and the
   model moves on; if an attacker has registered it, the install *succeeds*
   and runs the attacker's install script. A near-miss of a popular name
   (`reqeusts`, `lodahs`) is the same attack by a different road. ADR 0026's
   `DependencyAudit` looks for known advisories in what is *already* installed;
   nothing looked at the name *before* it was installed.
2. **Unsafe code in the agent's own diff.** ADR 0026 added a `security` check
   (secrets + code rules + dependency audit) to RunChecks — but it only joins a
   project that defines other checks (`gateChecks`), it covers JS/TS, Python and
   Go, and a commit made through `git commit` in a shell reads none of it.
3. **Tests weakened to get green.** A failing suite is the strongest pressure on
   a model to edit the test instead of the code: delete the file, add `.skip`,
   drop the assertion, change the expected number. `RunChecks` then reports
   green and the gate lets the turn end. Nothing compared the test before and
   after.

Loop detection (`src/tools/repeat-guard.ts`) is a different control: it spots a
model *repeating the same call* and nudges it to change approach. It is
unchanged and not rebuilt here; the new controls look at *what* is installed
and changed, not how often a call repeats. (They share a mechanism — advisory
text rides `additionalContexts` from a post-execute stage — and one boundary: a
denied install still counts in the repeat guard, so a model hammering a refused
install gets its reminder.)

Constraints: no new runtime dependency; offline work must keep working; nothing
here may *grant* (ADR 0002); a cloned repository must not be able to switch a
control off (`settings-project-policy.ts`).

## Decision

### 1. Package existence and trust check — a deny-only guard, `supply-chain`

`src/tools/package-parse.ts` (pure) reads a shell command the way
`shell-confinement.ts` does — quotes, `&&`/`||`/`;`/`|`/`&`/newlines, wrapper
shells (`bash -c`, `cmd /c`, `powershell -Command`), `sudo`/`env`/`call`, env
prefixes, `npm.cmd`/`.exe`, Windows paths — and returns the packages an
*install command names*. Covered: `npm/pnpm/yarn/bun add|install|i`, `npx`,
`pnpm dlx`, `yarn dlx`, `bunx`, `npm exec`; `pip/pip3/python -m pip/py -m pip/uv
pip install`, `uv add`, `uv tool install`, `uvx`, `poetry add`, `pipx
install|run`; `cargo add|install`; `go get|install`; `dotnet add package`,
`dotnet tool install`, `nuget install`; `composer require`; `gem install`,
`bundle add`. Not covered (said aloud): Maven and Gradle dependency edits (a
file edit, not an install command), Docker/apt/brew system packages, and a
lockfile install with no names (`npm ci`, `pip install -r`): the names in a
lockfile were not chosen by the model this turn, and `DependencyAudit` covers
what they resolve to.

Per named package, `src/tools/package-registry.ts` asks the **public**
registry (`registry.npmjs.org` + `api.npmjs.org`, `pypi.org`, `crates.io`,
`proxy.golang.org`, `api.nuget.org`, `repo.packagist.org`, `rubygems.org`)
through `tools/net.ts` `request()` (injectable, so tests have no network; a
named User-Agent; a 5 s deadline). The hosts are constants checked against an
allowlist before every request, which is stricter than the SSRF guard (no
user-chosen host can reach it) and why `redirect: follow` is acceptable. A
package on a built-in list of ~400 popular names is *established* and costs no
request. The decision (`judgePackage`, pure):

| Facts | Verdict |
|---|---|
| Registry says 404/410 | **Deny** — "`foo-bar` is not on npm — it may be a hallucinated name; check the spelling or the docs". No "person approves" path: there is nothing to approve. |
| Exists, first published < `minAgeDays` (default 30) | **Needs a person** |
| Exists, very low downloads where the registry exposes them (npm < 20/week, crates.io < 200 total, RubyGems < 500 total) | **Needs a person** |
| Exists, not established, within edit distance 1 (2 for names ≥ 8 characters) of a popular name, and under a year old (where age is exposed) | **Needs a person** ("looks like `requests`") |
| Git URL, `github:`/`user/repo` shorthand, tarball/direct URL, `--git` | **Needs a person** (no registry vouches for it) |
| Local path, `file:`, `link:`, `workspace:`, editable/relative install; the project's own package (an npm workspace member, the module `go.mod` declares, the project `pyproject.toml` names); `npx` of a binary already in `node_modules/.bin` | Ignored |
| Go: a 404 from the proxy for a path that is not on a public forge (a vanity import path, a company git host — `go` fetches those directly) | **Abstain** + a note naming `GOPRIVATE`; only github.com, gitlab.com, bitbucket.org, codeberg.org and sr.ht paths are judged missing |
| A private registry is configured (`.npmrc` `registry`/scoped, `--registry`, `PIP_INDEX_URL`/`--index-url`/`UV_INDEX_URL`, `.cargo` source replacement, `GOPROXY`, `nuget.config`, Composer `repositories`, `--source`) | **Abstain** — the public registry says nothing about a private name; an advisory note says the check was skipped |
| Timeout, 5xx, offline, unreadable answer | **Abstain** + advisory note ("could not verify; the install was not blocked") |

"Needs a person" copies `shell-confinement-guard.ts`: the run's approval card
(`ask`) when a person attends, a notification and a refusal that names the fix
when unattended (L4, cron, background, headless) or when nobody can be asked;
a yes sets the same `HUMAN_APPROVED` flag so the Sentinel does not ask twice.
Conservative-when-unknown is about *not granting* (principle 7): a lookup that
could not be completed never grants anything — it simply does not add a refusal,
because blocking offline work would make the control a reason to turn it off.

Results are cached under `aicoHome()/cache/package-check.json` (exists: 24 h,
missing: 1 h — a name can be published tomorrow; unknown is never cached).

**Setting** `supplyChain.packageCheck` (default `true`) and
`supplyChain.minAgeDays`. Project policy is `tighten`: a project file may set
`packageCheck: true` and a `minAgeDays` *older* than the person's own (default
30); turning it off, or loosening the age, is the person's own setting
(`settings-project-policy.ts`, asserted in `scripts/security-settings-test.mjs`
and `scripts/supply-chain-test.mjs`). Changing either to a weaker value over
the settings API needs a person (`safetyWeakening`), like every other
safety-weakening write, since the model can hold the API token.

### 2. Change-safety scan on the agent's diff

`src/security/change-safety.ts` scans the lines this turn *added* in the files
it wrote — the same diff logic as `security/project-scan.ts`, which now exports
its file scan as structured findings rather than a formatted report — with:

- **secrets** (`shared/security/rules.mjs` `SECRET_PATTERNS`, one copy for the
  pre-push hook, the repo scan and this), and
- **a small high-signal SAST set** in `shared/security/rules.mjs`, extended from
  JS/TS, Python and Go to **Java, PHP and C#**: SQL built by interpolation or
  concatenation, command execution built from a variable (`exec`, `system`,
  `Process.Start`, `shell=True`), `eval`, TLS/host-key verification disabled,
  hard-coded credentials, insecure deserialisation (`pickle`, `unserialize`,
  `ObjectInputStream`, `BinaryFormatter`, `TypeNameHandling`), unescaped HTML
  output (`innerHTML`, `dangerouslySetInnerHTML`, `echo $_GET`, `Html.Raw`), and
  weak hashes (MD5/SHA-1) used for passwords. Line-level patterns tuned for
  precision, waivable on the line with `security-allow: <rule> — reason`;
  Kotlin and Ruby are still uncovered and the report says so.

Enforcement, in the loop:

- **Turn-end gate** (`change-safety` plugin, in `agent.ts` after the checks
  and verification gates, before the commit gate): a secret or a *high* SAST
  finding nudges the model with `file:line`, the rule and the fix (secrets: use
  an environment variable or the credential vault, rotate it if it was ever
  real). At most **2 nudges per turn**, and a finding already reported is not
  reported again, so a model that disagrees is not argued with in a loop.
  Medium findings are recorded, not nudged. It runs even where the project
  defines no checks (the `security` check does not), and is off only by the
  person's `completionGate.changeSafety: false` (project policy `tighten`, as
  `completionGate.security`).
- **Commit gate**: a commit whose added lines hold a secret is refused — in the
  `Git` tool, in `AppManage commit`, and for `git commit` typed into any shell
  tool (a deny-only guard, `change-safety-commit`: the staged diff, every tracked
  change for `-a`, plus untracked files when the same line stages and commits).
  The refusal names `file:line` and the pattern
  (never the value), and the `Git` tool unstages the offending files.

### 3. Test-tamper guard

`src/security/test-tamper.ts` (pure) compares a test file *before* and *after*:
before is the checkpoint snapshot taken at the file's first touch this turn
(`checkpoint/index.ts`), else `git show HEAD:<path>`; after is the working copy.
It reports, per test file: **deleted**; **assertions removed** (counted per
language: `expect`/`assert`/`should`, `assertEquals`/`assertThat`, `Assert.`,
`$this->assert`, `t.Error`/`require.`/`assert.`, `assert` statements and
`self.assert*`, comments excluded); **skip/focus markers added** (`.skip`,
`.only`, `xit`, `xdescribe`, `xtest`, `fit`, `fdescribe`, `@Disabled`,
`@Ignore`, `[Fact(Skip=…)]`, `[Ignore]`, `pytest.mark.skip/xfail`,
`@unittest.skip`, `t.Skip`, `markTestSkipped/Incomplete`); **weak matchers
added** (`toBeTruthy`, `toBeDefined`, `assertNotNull`, `assert True`…); and,
only in a turn where a `test` check had already failed, **an expected value
changed** on an otherwise identical assertion line.

- **In the loop**: the same `change-safety` turn-end gate nudges, naming the
  test, requiring the model to *restore it or say why to the person in its
  final answer* — not to argue. A turn that deliberately rewrites tests (a new
  snapshot, a refactor) can say so once, as every gate allows.
- **At unattended levels** (L4, cron, background, headless) a deny-only guard,
  `test-tamper`, refuses before the call runs: `rm`/`del`/`git rm`/
  `Remove-Item` of a test file (shell), and an `Edit`/`Write` of a test file that
  adds a skip marker. They need a person; the refusal names the fix and says to
  report the step as needing one. Attended, the nudge above is the control — a
  person is watching and the permission card already shows the edit.

Honest scope: assertion counts and value changes are heuristics (a legitimate
refactor to a table-driven test removes assertion *lines*); that is why the
response to them is a nudge to restore-or-justify, not a refusal. A deletion
done by a shell command the parser does not understand, or a test weakened
through a file the write path never saw, is found only if it left the working
tree different from the checkpoint/HEAD in a file this turn wrote.

### 4. The record: `safety/finding` (RECORD event)

Every finding of the three controls is appended to the session log as one
additive RECORD event, so the change-evidence report ([0034](0034-evidence-ci-agent-flaky-tests.md))
can say *what was checked and what was found* from facts. Old logs have none and
render "no record".

```
'safety/finding': {
  turn: number;
  control: 'supply-chain' | 'secret' | 'sast' | 'test-tamper';
  rule: string;       // package-missing | package-new | package-low-downloads | package-lookalike
                      // | package-direct-source | package-unverified | secret | <sast rule id>
                      // | test-file-deleted | assertions-removed | skip-marker-added
                      // | weak-matcher-added | expected-value-changed
  severity: 'high' | 'medium' | 'info';
  outcome: 'denied' | 'approved-by-person' | 'refused-commit' | 'nudged' | 'reported' | 'advisory';
  file?: string;      // project-relative, forward slashes
  line?: number;
  subject?: string;   // "npm:left-padz", "tests/a.test.ts"
  detail: string;     // <= 300 chars; never a secret value, only the pattern name and length
}
```

The tool-call denials these guards produce are also recorded by 0034 as
`tool/decision` (`by: 'policy'`); `safety/finding` adds the *why* as data.

## Alternatives considered

| Option | Why not |
|---|---|
| Check every dependency in the manifest after the turn | Catches the squat after the install script has run; the point is before |
| Block anything not on a popularity allowlist | Turns every niche package into a prompt and teaches people to turn the control off; "very low downloads" and "brand new" are the signal, a name nobody has heard of is not |
| Deny young/low-download packages outright | A person may genuinely want one; the existing person-required path is the right shape and unattended runs still refuse |
| Block when the registry is unreachable | Breaks offline work; unknown does not grant, and does not refuse |
| A model reviews the diff for vulnerabilities | A second opinion that costs tokens each turn; the cheap patterns catch the repeat offenders and CodeQL ([0026](0026-shift-left-security.md)) is the deep pass |
| Full SAST engine (Semgrep rules bundled) | New dependency or download; `project-scan.ts` already runs Semgrep/Bandit/gosec when the person has them |
| Refuse any test edit while a check is failing | The legitimate fix is sometimes in the test; heuristics nudge, only the unambiguous (deletion, new skip) needs a person, and only unattended |
| Rebuild loop detection into these | `repeat-guard` is advisory and unrelated to content; kept as is |

## Consequences

- **Good:** a hallucinated install fails fast with a message the model can act
  on, and a squat or a lookalike reaches a person; secrets and the classic
  injection/TLS/deserialisation mistakes are caught in six languages before the
  turn ends and before a commit; weakened tests are named instead of silently
  green; every finding is data in the log.
- **Bad / costs:** one registry request per unfamiliar package per day (cached,
  popular names free); a person is asked about genuinely obscure packages; the
  SAST rules and assertion counts have false positives, answered by a waiver
  comment or a one-line justification.
- **Honest limits:** the package check sees *explicit install commands*, not
  names a model writes into `package.json` and installs with `npm install`
  (the manifest edit is covered only by `DependencyAudit` afterwards); a
  command built from variables, a script file or `eval` hides the names;
  download counts exist for npm, crates.io and RubyGems only, and age for
  npm, PyPI, crates.io and Packagist (Go and NuGet are existence-only, with no
  lookalike rule); the registry answer is "this name exists", not "this
  package is safe" — `DependencyAudit` and a lockfile review remain; popularity
  is a proxy a patient attacker can inflate; the SAST set is patterns, not
  taint analysis; test-tamper heuristics miss a test weakened by moving its
  logic elsewhere. Kotlin, Ruby and Rust code get the secret scan only.
- **Migration:** none. New setting keys default on; old logs lack the event.
  One adjacent fix the review depends on: `checks.noteSourceChanged` resolved a
  relative path the model gave against the *process* directory, not the run's,
  so a server run (whose process directory is not the project) lost the files
  a relative `Write` touched; it now resolves against `currentCwd()`.

## Threat model

- **Assets:** the person's machine and credentials (an install script runs with
  both), the repository's history (a committed secret is permanent), and the
  integrity of the test suite as evidence.
- **Adversaries:** a registry squatter exploiting model hallucinations; a prompt
  injection steering the model to install or commit; the model itself, under
  pressure to turn a red check green; a cloned repository whose settings try
  to switch the controls off.
- **Mitigations and where:** deny-only guards (`supply-chain`,
  `change-safety-commit`, `test-tamper`) cannot be laundered by stage order; a
  project cannot weaken the settings (`PROJECT_POLICY`); the registry hosts are
  constants; findings never carry a secret value (pattern name and length).
- **Residual risk:** see *Honest limits*. A prompt-injected model can still
  write a malicious dependency into a manifest; that path is `DependencyAudit`,
  the Sentinel on shell installs, and shell confinement.

## Verification

- `scripts/supply-chain-test.mjs` — the parser for every manager (flags,
  version specifiers, extras, scopes, multiple names, `&&` chains, Windows
  shells, wrappers), the verdict table against a mocked registry (no network),
  private-registry abstention, the cache, the guard (deny / ask / unattended /
  unknown → advisory), the settings policy, and the wiring in `runAgent`.
- `scripts/change-safety-test.mjs` — secret and SAST cases in JS/TS, Python, Go,
  Java, PHP and C# including no false positives on `standards-allow: secret`
  canaries and waivers; tamper detection across languages; the turn-end gate
  (bounded, deduplicated, records the event); the commit refusals; the
  unattended guard; the records' shape.
- Both are in the `npm test` chain; `scripts/security-settings-test.mjs`
  asserts the new keys' project policy; `npm run check:security` proves the new
  rules do not fire on this repository's own source (or are baselined with a
  reason).
- Live registries: the tests mock every registry, so the response shapes were
  also probed once against the real public registries (2026-10-08: 17 names
  across npm, PyPI, crates.io, the Go proxy, NuGet, Packagist and RubyGems,
  existing and not, each answered as the lookups expect, 0.3–2.2 s). Registry
  behaviour changes without notice, rate limits were not exercised, and a CI
  runner or a corporate proxy may see different answers; a changed shape
  degrades to `unknown` (the install is not blocked, a note says so), never to
  a wrong refusal.
