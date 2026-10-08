# 0035 — Managed policy (an organisation lock that can only restrict) and a SIEM-ready audit export

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** owner (+ authors)
- **Supersedes / related:** [0001](0001-append-only-session-log.md) (the log is the truth), [0002](0002-guards-only-deny.md) (guards only deny), [0006](0006-credential-broker.md) (the vault and its audit trail), [0011](0011-approve-later-inbox.md) (the inbox), [0015](0015-sentinel-reviewer.md) (the Sentinel), [0017](0017-model-roles.md) (keep data local), [0026](0026-shift-left-security.md) (route classification, DAST)

## Context

AICO is a **single-user, local engine**: one person, one machine, one
`~/.aico`. Every setting that matters for safety lives in files that the same
person (and, through the file tools, the agent) can edit. That is the right
shape for an individual and the wrong one for an organisation that wants to say
"our developers may use these providers, never above this autonomy, with the
checks gate always on, and we want to see what was done".

What an organisation can ask of AICO today, and the evidence that it cannot get it:

- **No lock above the user.** Precedence is project < user at best; the
  project layer is already an allow-list that can only tighten
  (`src/settings-project-policy.ts`), but nothing sits above the person's own
  settings. `disabledTools`, `sandbox`, `safetyLimits`, `autoApprove`,
  `sentinel.mode`, `models.localOnlyPersonal` are all one edit from off.
- **No record an auditor can take away.** The facts exist — session event logs
  (`tool/call`, `tool/result`, `agent/*`, usage), the inbox
  (`inbox/actions.jsonl`), the vault's audit trail (`vault/audit.jsonl`), the
  work ledger, long-job journals — but they are per-session files in an
  internal format. The decision a guard made (which stage denied a call, or
  whether a person or the auto-approve switch said yes) is not durable at all:
  it exists as prose in a tool-result error string. Nothing ships them to a SIEM.
- **No cost view across sessions** short of reading every log.

### What this ADR is not (stated plainly)

**SSO, SCIM, RBAC, per-user roles, a multi-user admin console, a central
policy server, remote-managed seats and tamper-evident (signed) audit storage
are NOT built and are not claimed.** There is no server to sign in to: AICO is
one process on one machine. This ADR is the governance layer that works for an
organisation *today* with the tools IT already has — a policy file pushed by
MDM/GPO/Intune/Jamf/config management, and an export that a log shipper
(Splunk UF, Elastic Agent, Sentinel/Defender connector, a cron `aico audit
export`) already knows how to collect. A later team control plane is sketched
at the end so today's schema does not box it in.

## Decision

### 1. A managed policy file, highest precedence, restrict-only

**Location** (`src/policy/managed.ts` `policyFilePaths()`):

| OS | Path |
|---|---|
| Windows | `%ProgramData%\AICO\policy.json` |
| macOS | `/Library/Application Support/AICO/policy.json` |
| Linux | `/etc/aico/policy.json` |

`AICO_POLICY_FILE` names an additional policy file, for tests and for trying a
policy. **It can never loosen the system file**: when both exist, both apply
and the result is the *most restrictive combination* (lists intersect or
union in the restrictive direction, numbers take the minimum, booleans OR).
Without that rule the override would be a one-line bypass for the very person
the lock is meant to bind. Tests set `AICO_POLICY_FILE` and never write system
paths.

**Precedence:** managed policy > user settings > project settings. The policy
is applied *after* the layers merge (`loadSettings`) and can only **clamp** the
result; it cannot add a permission, grant a tool, supply a credential or turn
anything on that is off. The compiler enforces "restrict only": the policy
schema has no field whose meaning is "allow more than the user chose".

**Schema** (version 1; validated; unknown keys are reported, never silently
accepted — see "Invalid files" below):

| Key | Type | Effect | Enforced at |
|---|---|---|---|
| `version` | `1` | schema version | load |
| `message`, `contact` | string | shown with every block | `PolicyError`, `GET /api/policy` |
| `minAicoVersion` | `x.y.z` | older engines refuse to run turns | `runAgent` gate |
| `allowedProviders` / `deniedProviders` | string[] (glob) | provider family (`anthropic`, `openai`, `ollama`, …) or instance id | `selectProvider` |
| `allowedModels` / `deniedModels` | string[] (glob) | model ids (`claude-*`, `ollama/*`) | `selectProvider`, every role |
| `localOnly` | boolean | every model call must be served on this machine (loopback Ollama / loopback endpoint, never an Ollama `-cloud` model) | `selectProvider`; also forces `models.localOnlyPersonal` |
| `deniedTools` | string[] (glob) | tool names, MCP names (`mcp__server__tool`) | merged into `disabledTools` (tools not offered) **and** the `managed-policy` guard (second line) |
| `maxAutonomyLevel` | `L0`..`L4` | ceiling on every run, any entry point (chat, CLI, cron, background, `mcp-serve`) | `runAgent` via the existing autonomy-ceiling mechanism (`agents/ceiling.ts`) |
| `requiredGates` | `checks` `security` `verification` `commit` `supply-chain` `change-scan` | the gate cannot be switched off by any settings layer | `loadSettings` clamp (`completionGate.*`) and `isGateRequired()` for gates that own their switch |
| `mcp`, `plugins`, `customTools` | `{ mode: any \| forbid \| allow-list, allow?: string[] }` | adding/updating is refused; `allow-list` admits only named servers/plugins/tools; servers already in settings that are not admitted are dropped at load | `addMcpServer`/`updateMcpServer`, custom-tool create, `loadSettings`, the guard |
| `network` | `{ mode: off \| allow-list \| deny-list, domains: string[], allowLoopback?: boolean }` | any tool call carrying a URL argument (`WebFetch`, browser tools, ops/HTTP tools, MCP tools that take a `url`) is checked against the domains | `managed-policy` guard |
| `budget` | `{ perSessionUsd?, perDayUsd? }` | `safetyLimits.maxCostPerSession` is clamped to the minimum; the day cap is checked at each step against today's spend across all sessions | `loadSettings`, step check in `agent.ts` |
| `sentinelRequired` | boolean | `sentinel.mode` cannot be `off`, `onEscalate` cannot be `proceed` | `loadSettings` clamp |
| `telemetry` | `"off"` | no outbound call that is not the person's task: the update check is disabled (AICO has no usage telemetry; this key is how an organisation states and enforces that) | `update-check` |
| `audit` | `{ user: username\|hash\|omit, host: hostname\|hash\|omit, tenant? }` | how the export identifies the user/host | `audit/identity.ts` |

**Enforcement is in code, not in the prompt** (AGENTS.md §4.6). Four seams:

1. `loadSettings()` calls `applyManagedPolicy(merged)` once, at the one place
   settings are merged, so nothing downstream can read an unclamped value by
   forgetting to ask. It also tells the user once, on stderr, what it changed.
2. `selectProvider()` calls `assertModelAllowed()`; every model call in the
   engine (turns, titles, Sentinel, judge, brief, learner, inline edit) goes
   through it, so a disallowed provider fails with a `PolicyError` that names
   the policy, the rule and the contact.
3. The tool pipeline gets a `managed-policy` **guard** (deny/abstain only —
   ADR 0002). It is registered before the permission prompt, so a person is
   never asked to approve something the organisation has forbidden.
4. `runAgent()` gates the run (minimum version, invalid-policy lockdown) and
   lowers the autonomy ceiling.

**Settings writes.** The clamp is the enforcement: a write the policy would
override is inert (the engine does not reject it, which would break the
existing "settings are data" model). For clarity the server also refuses, with
`403` and the policy's reason, a `POST /api/settings` or `/api/settings/path`
that sets a **fixed** value (`autoApprove` under an L2 ceiling, a required gate
off) or raises a **bounded** one (`safetyLimits.maxCostPerSession` above the
cap); a *restricted* setting (`sentinel.mode`, `disabledTools`) is clamped, not
refused. Every accepted write is recorded in the audit trail (key and value
hash, never the value).

**Clients.** `GET /api/policy` (token; read-only) returns whether a policy is
active, its file path and hash, the message and contact, every problem found,
and `locked`: the settings paths the policy fixes or bounds, each with a
reason. It never contains secrets (the policy file holds none by construction:
there is no field for one). The web settings screen shows "Managed by your
organisation" and disables fixed fields; desktop reuses those components.

### Invalid files — decision

An organisation lock that silently stops working is worse than none, and one
that bricks the machine on a typo is a support incident. The rule is
**fail closed, per section, and say so**:

| Situation | Behaviour |
|---|---|
| No file | not managed; nothing changes |
| File exists but is unreadable, is not JSON, or is not an object | **lockdown**: no model call and no tool call is allowed (the app still opens, settings and logs stay readable); the banner says the policy file is unreadable and shows the contact. Every section is "invalid", so every section takes its most restrictive value. |
| A known key has an invalid value (`maxAutonomyLevel: "L9"`, `budget` negative, `allowedModels: "claude"` instead of a list) | that key takes its **most restrictive value**: empty allow-lists (nothing allowed), `localOnly: true`, `maxAutonomyLevel: L0`, `budget` cap of $0.01, gates required, `mcp/plugins/customTools: forbid`, `network` allow-list with no domains. A warning names the key. |
| An unknown key | **ignored and reported** (a newer policy on an older AICO must not brick it), the warning says the key is not understood by this version, and `minAicoVersion` exists to force an upgrade. |
| `version` newer than 1 | treated as an unknown-keys case plus a warning; known keys still apply. |
| `AICO_POLICY_FILE` set but missing | ignored (it cannot loosen anything); reported. |

**Is the file really read-only to the user?** AICO cannot make it so; the
operating system does. At load the engine checks and *reports*: on POSIX a file
writable by group/other or by the current user, on Windows the read-only
attribute and a failed `W_OK` probe. A writable policy file is flagged in
`GET /api/policy` as "not a lock" — still enforced, but the organisation is
told its deployment is weak. See honest limits.

### 2. Audit export

**Sources — existing durable records only** (no new always-on telemetry):

| Kind | Source |
|---|---|
| `tool.call`, `turn.end`, `subagent` | session event logs `projects/*/sessions/*.events.jsonl` (`tool/call`, `tool/result`, `tool/decision`, `turn/end`, `assistant/message` usage, `request/header`, `agent/spawn`, `agent/done`) |
| `approval` | `inbox/actions.jsonl` (parked calls and who decided, by which channel) |
| `credential` | `vault/audit.jsonl` — **reference names only**; the vault's own record never holds a value |
| `settings.change`, `policy.load` | new append-only `audit/events.jsonl` in the store: key paths and hashes, **never values** |
| `work` | the work ledger (`work.jsonl`): background agents, cron firings, watchers — start/end/state/cost |
| `longjob` | long-job journals: proposed, approved/declined (`via`), paused, stopped |

**One additive field on an existing log event.** [ADR 0034](0034-evidence-ci-agent-flaky-tests.md)
already appends `tool/decision` (`approved | denied`, `by: person | policy`,
`reason`) when a person answers a permission dialog or a guard refuses a call.
That is the durable fact an audit needs, so this ADR does not add a second
event: it adds the optional `stage?: string` — the name of the guard that
refused (`managed-policy`, `permission`, `sentinel`, `shell-confinement`,
`pre-execute`, …) — taken from the pipeline result (`PipelineResult.deniedBy`,
new, optional). Old logs and old readers are unaffected (optional field, same
event type). A call with no `tool/decision` was allowed without a prompt
(auto, read-only, or `autoApprove`): the export says `decision=allow
decidedBy=auto`. `escalated` appears on approval records (a call parked in
the approve-later inbox, a long job proposed): a Sentinel refusal is an
ordinary deny with stage `sentinel`. Logs written before this release have no
stage; their refusals export with `stage` empty.

**Stable schema, version `1`** (`schema: "aico.audit/1"`). Every record:

| Field | Meaning |
|---|---|
| `schema` | `aico.audit/1` |
| `id` | stable 16-hex id from source+key (dedupe on re-export) |
| `time` | ISO-8601 UTC |
| `kind` | `tool.call` `turn.end` `subagent` `approval` `credential` `settings.change` `policy.load` `work` `longjob` |
| `action` | verb within the kind (`Bash`, `park`, `use`, `set`, …) |
| `outcome` | `ok` `error` `denied` `escalated` `aborted` `declined` `expired` `timeout` |
| `decision` | `allow` `deny` `escalated` (tool/approval kinds) |
| `decidedBy` | `auto`, `person`, `person:<channel>` (an inbox decision: `host`, `ui-key`, `client`, `tty`), `system` (an expiry), `policy`, `guard:<stage>`; for `credential` the vault's actor (`agent:Bash`…); for `work` the origin (`user`, `cron`, `model`…) |
| `stage` | denying stage |
| `user` | OS username, hash or omitted (policy `audit.user`) |
| `host` | hostname hash by default (policy `audit.host`) |
| `tenant` | policy `audit.tenant` |
| `aicoVersion` | engine version |
| `project` | project folder (the session's `cwd`) |
| `sessionId`, `turn`, `callId` | correlation |
| `tool`, `target` | tool name; **target** = file path / command (≤ 200 chars) / URL host+path **without query** / pattern |
| `model` | model the turn ran on |
| `inputTokens`, `outputTokens`, `costUsd` | usage (estimated cost; says so) |
| `reason` | redacted, ≤ 300 chars |
| `credential` | vault reference name (never a value) |

**Never in an export:** file contents (a `Write`/`Edit` record carries the
path only), prompts, tool results, assistant text, URLs' query strings,
environment values, credential values. Every string passes `sinkRedactText`
(the vault's registered values) **and** the generic secret-shape redactor
(`shared/security` key shapes), then is length-bounded and stripped of control
characters. A fake canary marked `standards-allow: secret` is planted in a
session, the vault audit, the settings and the command text by the tests, and
the export is asserted to contain none of it.

**Formats:** `jsonl` (one record per line), `cef` (`CEF:0|AICO|aico|<ver>|<id>|<name>|<sev>|k=v …`, header and extension escaping per the CEF spec, one line per record) and `csv` (RFC 4180, fixed column order, formula-injection-safe: a leading `= + - @` is prefixed with `'`).

**Access.** `aico audit export --since <date> [--until <date>] [--project <path>] --format jsonl|cef|csv [--out file] [--user <id>] [--host <id>]` runs as the user on their own machine and needs no approval (it reads files they own). `POST /api/audit/export` returns the same records over HTTP and is **token + human** (`DecisionGate.checkHuman`, classified in `scripts/security/routes.json`): the model can hold the API token and `curl` the loopback port, and an audit trail of what it did is exactly what it should not be able to pull or pipe elsewhere on its own. `aico usage --since <date> [--until] [--project] --by model|project|day --format csv|json` summarises tokens and estimated cost the same way (`POST /api/audit/usage`, same gate). `GET /api/policy` is a read of rules and needs only the token: the policy file has no field for a secret.

### 3. Later: a team control plane (sketch, not built)

If AICO ever has a server, it should be a **policy and audit sink**, not a new
engine: it would serve the same `policy.json` (signed, fetched by the engine
at start, cached, with the MDM file still taking precedence), accept the same
`aico.audit/1` records over HTTPS from the export, and map identity from an
IdP (OIDC/SCIM) into the `user` field. RBAC would select *which* policy file a
person gets; it would not add a second enforcement point. The schema above is
shaped for that: policy is data with a version, audit records are flat and
idempotent (`id`), and nothing in either assumes a filesystem.

## Alternatives considered

| Option | Why not |
|---|---|
| Put organisation values in `~/.aico/settings.json` with a "locked" flag | The person (and the agent) can edit that file; a lock the locked party can open is not a lock. |
| Ship an HTTP policy/audit server now | A new network surface, auth, tenancy, and a hosting promise for a product that is a local tool; IT already has MDM and SIEM agents. Needs its own ADR and the owner's authorisation (security.md: new listeners). |
| Policy can also *grant* (pre-approve tools, supply keys) | Breaks "guards only deny" (ADR 0002) and makes the file a secret-bearing artefact. Restrict-only keeps it safe to inspect and to deploy. |
| Reject unknown keys and refuse to start | A newer policy on a lagging machine would brick it; warn plus `minAicoVersion` gives the same assurance without the outage. |
| Treat an invalid file as "no policy" | Silent loss of the lock on a typo. Rejected. |
| Write a decision event for every tool call | ~2× the tool-event volume for a fact (`allow`, auto) the pair already implies; ADR 0034 deliberately records only person answers and refusals. |
| Sign the audit export | Needs key management we do not have; documented as a gap. SIEM-side integrity (append-only index, forwarder TLS) is where organisations already get it. |
| Add an `audit` section to user settings for identity | Identity must be set by IT, not the person; it lives in the policy. |

## Consequences

- **Good:** an organisation can lock providers, models, autonomy, gates, tools,
  extension points, network reach and spend with files it already deploys; the
  agent cannot talk its way past the lock because the lock is code at the merge,
  the model-selection, the tool-guard and the run-start seams. Auditors get a
  stable, documented, redacted stream and a cost report.
- **Bad / costs:** one more settings layer to reason about; a policy typo is
  loud (by design); a few shared files gain small additive edits.
- **Honest limits:**
  - **Not SSO/SCIM/RBAC/multi-user/admin console/central server** (above).
  - The lock is **as strong as the operating system's protection of the policy
    file and of the AICO install.** A user with admin rights can edit
    `policy.json`, run another copy of AICO, or use another client altogether.
    On Windows the engine can only check the read-only attribute, not the ACL.
  - `Bash`/`PowerShell`/`Terminal` can still reach any host and run any
    program: the network policy governs AICO's own URL-carrying tools. Pair
    with `deniedTools: ["Bash", …]`, `maxAutonomyLevel`, shell confinement
    (ADR 0027), an egress proxy or firewall.
  - `network` matches the **host in the URL argument as written**; it does not
    resolve DNS, follow redirects the server performs, or inspect scripts.
  - The per-day budget uses *estimated* cost from persisted logs at step
    boundaries; parallel sessions can overshoot by a step.
  - Desktop plugin installs run in the Electron main process; the engine-side
    `plugins` policy is reported to the app and blocks the agent's plugin
    tools, but a person using the desktop plugin screen is not blocked by the
    engine today (tracked in the follow-ups).
  - Free text is redacted by value (the vault's registered secrets) and by
    shape (key formats, `NAME=value` with a secret-looking name, `--password x`,
    `Bearer …`, `user:pass@host`). A secret that is none of those, typed into a
    command line, a path or a vault `purpose`, is exported as written (bounded
    to 300 characters). That is why the export has no content fields at all.
  - Adding an MCP server while others are disallowed rewrites the project's
    local MCP list without the disallowed ones (the load already dropped them).
  - Audit records are **not tamper-evident**: a same-user process can edit the
    source files, exactly as `vault/audit.ts` already says. Ship the export to
    an append-only store promptly.
  - Logs older than ADR 0034 have no `tool/decision`; their refused calls are
    exported as `outcome=error` with the reason text and no stage.
- **Migration:** none. No policy file means no change in behaviour. The new log
  event is additive. Old exports do not exist.

## Threat model

**Asset(s):** the organisation's intent (what may run, where data goes, what it
costs); the audit record. **Actors:** the user, who may want to bypass; the
model, which may be manipulated by content and holds the loopback API token; a
malicious repository; a local process with the user's rights.
**Entry points:** the policy file, `AICO_POLICY_FILE`, settings writes, the
audit routes, tool calls carrying URLs.
**Trust boundaries crossed:** user → machine-wide policy; model → audit data.

| Threat (STRIDE) | Scenario | Mitigation (where enforced) | Residual risk |
|---|---|---|---|
| Spoofing | A user points `AICO_POLICY_FILE` at a permissive file | the override can only add restrictions; the system file still applies (`mergePolicies`) | none against the lock |
| Tampering | User edits the system policy | OS permissions (MDM sets admin-only); engine reports a writable file as "not a lock" | an administrator can; cannot be solved in the engine |
| Tampering | A repository's `.aico/settings.json` loosens a limit | project layer already tightens-only; the policy is applied after it | — |
| Tampering | The model edits settings to widen a limit | clamp at merge makes the write inert; server refuses locked paths | — |
| Repudiation | "The agent did it" | `tool.call` records with decision, stage, who approved, model, host; `settings.change` | local files are editable; ship the export off-box |
| Information disclosure | Export leaks a secret or file content | no content fields exist; every string redacted twice; canary tests | a secret in a *command line or path* that matches no known shape is exported as written (bounded to 200 chars) |
| Information disclosure | The model pulls the audit trail over loopback | `POST /api/audit/export` is token + human | a same-user process with the UI key |
| Denial of service | Bad policy bricks the machine | per-section fail-closed with a visible message and contact; unknown keys are warnings | an unreadable file is a deliberate lockdown |
| Elevation of privilege | `localOnly` evaded through an Ollama `-cloud` tag or a remote Ollama | `isLocalInstance` and `isCloudModelTag` (ADR 0017) reused | a model on a loopback port that proxies to the cloud |

**Unattended behaviour:** cron, background agents and `mcp-serve` run through
`runAgent`, so the same ceiling, guard and model checks apply; with a ceiling
below the run's level, calls that need a person are refused, not parked.
**Honest limits:** above.
**Tests:** `scripts/managed-policy-test.mjs` (precedence, each enforcement
point, invalid files), `scripts/audit-export-test.mjs` (schema, redaction,
CEF/CSV escaping, usage), `web/test-ui.mjs` (locked fields), plus the route
classification in `scripts/security/routes.json` attacked by the DAST suite.

## Verification

`npm run typecheck`, the two new scripts in `npm test`, `npm run
test:web:unit`, `npm run check:standards`, `npm run check:security`. The
check that would fail if someone reversed it: the precedence test asserts a
user setting and a project setting can each *not* loosen a policy value, and
the canary test asserts the export contains none of the planted secrets.
