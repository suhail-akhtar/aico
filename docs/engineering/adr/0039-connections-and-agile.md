# 0039 — Connections to the team's forge and tracker, and Scrum as a mode of the Delivery board

- **Status:** Accepted (2026-10-09)
- **Date:** 2026-10-09
- **Deciders:** owner (+ authors)
- **Supersedes / related:** extends [0038](0038-delivery.md) (Delivery) and **revises one sentence of it** ("Local only … Delivery never pushes") for projects that opt into PR mode; builds on [0006](0006-credential-broker.md) + [0010](0010-secret-file-sink.md) (credentials), [0009](0009-custom-tools.md) (custom tools), [0002](0002-guards-only-deny.md), [0021](0021-background-agents-that-report-back.md), [0034](0034-evidence-ci-agent-flaky-tests.md) (evidence packet), [0035](0035-managed-policy-and-audit-export.md) (policy, audit). Planned code: `src/connections/` (new), `src/tools/connection-manage.ts`, `src/server/connection-routes.ts`, `shared/delivery/` additions, `web/src/components/connections/`. Phase 0, the GitHub adapter and PR-mode landing are built (0.50.0 line); the other adapters, dynamic connectors and the OAuth conveniences are not.

## Context

Delivery (0038) runs a board of independent tasks locally. Real teams already keep the backlog in
Azure Boards, GitHub Issues, GitLab, Gitea or a Bitbucket-linked tracker, and the *gate* for landing
code is the remote's pull request, required reviews, status checks and branch protection — not a
local `git merge --ff-only`. Two gaps follow:

1. **Delivery is an island.** Tasks are typed in by hand, results never reach the team's tracker, and
   the one gate that already exists in most companies (the remote's branch protection) is ignored.
2. **No sprint concept.** People who run Scrum have iterations, estimates and ceremonies; the board
   has a backlog and states. Agile teams will not adopt a board that cannot show a sprint.

The owner's constraints: Azure DevOps (Services + Server), GitHub (github.com, Pro/Team/Enterprise
Cloud + GitHub Enterprise Server), GitLab (SaaS + self-managed), Bitbucket (Cloud + Data Center),
GitBucket, Gitea/Forgejo; AICO's own agent must be able to add a connector for *any other* platform;
Agile and Scrum end to end; minimal user effort; **not** a product that grows a settings maze; agents
configure all of it from plain instructions while a person approves credentials and spend.

The recurring failure of integrations like this is not the API calls; it is (a) a credential the model
can read, (b) a sync that overwrites what a human typed, (c) issue text steering the agent, and (d) a
"connect" flow with eleven fields. This ADR is organised around those four.

## Decision (summary)

1. One **`Connection`** (where, who, with what credential) and one **provider adapter interface** with
   capability flags. Nine built-in adapters share it; a **declarative/MCP-backed adapter** is how the
   agent adds any other platform.
2. **Delivery stays the product; the remote is a mirror with owners per field.** Work items import as
   backlog tasks; AICO writes only its own fields; the human's fields win conflicts.
3. **Landing mode is a per-project choice**: `local` (today) or `pr` (push `aico/task-<id>`, open a
   PR/MR with the evidence packet, let the remote's checks, reviews and protections be the gate).
4. **Scrum is one switch on the Delivery board** (`mode: kanban | scrum`), local-first and journal-derived;
   it syncs to the platform's iterations where they exist.
5. **One settings page** ("Connections") and **one new tool** (`ConnectionManage`, deferred). Nothing
   else is added to navigation.

## 1. Connection model

```ts
// src/connections/types.ts (sketch; shared/ re-exports the client-visible part)
interface Connection {
  id: string;                 // slug: "work-ado"
  provider: 'azure-devops' | 'github' | 'gitlab' | 'bitbucket-cloud' | 'bitbucket-dc'
          | 'gitea' | 'forgejo' | 'gitbucket' | 'custom';
  label: string;
  baseUrl: string;            // https:// only; filled for cloud SKUs, asked for self-hosted
  auth: { method: 'pat' | 'oauth-device' | 'github-app' | 'entra' | 'access-token';
          credential: string;           // vault name (kind api-token); never a value
          expiresAt?: string };         // from the provider where it says so
  tls?: { caBundle?: string };          // PEM path or vault 'certificate' record; see below
  hosts: string[];            // network allow-list; default = baseUrl host (+ api host)
  probe?: { at: string; version?: string; capabilities: Capabilities; missingScopes: string[] };
}
interface ProjectMapping {    // keyed by registered project path, one connection per project in v1
  connection: string;
  repo: { owner?: string; project?: string; name: string; id?: string };
  workItems?: { source: 'off' | 'assigned-to-me' | 'label' | 'query'; value?: string };
  landing: 'local' | 'pr';    // default 'local'
  trunk: string;
  iterations: 'off' | 'native';
  stateMap: StateMap;         // see §2; defaults come from the probe
}
```

- **Storage.** `aicoHome()/connections/connections.json` (user store) and the project mapping beside
  Delivery's journal under `aicoHome()/delivery/<project key>/`. **Not** in the repository: a cloned
  repo must not be able to point the engine at a host of its choosing (the project-trust lesson of
  0009). Neither file contains a secret; `credential` is a name. Settings reach clients without the
  credential name's record, as for `providers` (§8 of AGENTS.md).
- **Credential.** A vault `api-token` record whose policy is origin-bound to `baseUrl` (+ `hosts`),
  `allowedTools: ['Connection']`, approval `session`. The adapter is a trusted consumer calling
  `resolve({tool:'Connection:<id>', target, purpose})` per request batch (0006). The model never holds,
  sees or types it: `ConnectionManage create` returns a *credential request* the client renders as a
  card (paste token, or sign in); the value goes browser → vault over the human route.
- **Auth methods, honestly.** Every provider supports **PAT / access token first** (works everywhere,
  including on-prem). Nicer methods are additive and later (§7): GitHub/GitLab **OAuth device flow**
  (no callback server, so it suits a local engine; needs an OAuth app AICO's owner registers for the
  cloud SKUs, and the customer registers one on self-hosted), **GitHub App** installation tokens
  (org-wide, short-lived, needs a private key — "advanced"), **Entra ID** for Azure DevOps Services
  (Azure DevOps' own OAuth is being retired in favour of Entra; an org's conditional access may block a
  third-party app, so PAT stays the fallback). Azure DevOps Server is PAT only in v1.
- **TLS: verification is never skipped.** `allowSelfSigned` exists on vault policies for ops tools; a
  connection **does not honour it** (AGENTS.md §8: never add a flag that skips TLS verification). A
  self-hosted server with a private CA gets `tls.caBundle`, applied *only* to that connection's
  requests (a per-request `ca`, not a process-wide `NODE_EXTRA_CA_CERTS`) and to git through
  `GIT_SSL_CAINFO` on the engine-spawned child. Requires a small `ca` option on the ops HTTP client
  (`src/tools/ops/http.ts` currently takes only `rejectUnauthorized`).
- **Network.** All adapter traffic goes through the ops HTTP client: SSRF guard (loopback, link-local,
  metadata refused), address pinning, no cross-origin redirect with credentials, body size caps. A LAN
  address for a self-hosted server is allowed because that is the point, but a connection **created by
  an agent** shows its host on the approval card before any credential is requested.

### The adapter interface

```ts
interface ProviderAdapter {
  id: Connection['provider'];
  probe(c: Ctx): Promise<{ version?: string; capabilities: Capabilities; missingScopes: string[]; user: string }>;

  repos:      { list(q?): Page<Repo>; get(ref): Repo /* incl. cloneUrl, defaultBranch */ };
  pulls?:     { create(i: NewPull): Pull; update(ref, patch): Pull; comment(ref, md): void;
                get(ref): Pull /* state, mergeable, reviews[], required[], checks[] */;
                merge?(ref, how): void; };
  items?:     { query(q: ItemQuery, since?: Cursor): Page<RemoteItem>; get(ref): RemoteItem;
                create(i): RemoteItem; update(ref, patch, ifRev: string): RemoteItem;
                transition(ref, to: StateKind, ifRev: string): RemoteItem;
                comment(ref, md): void; linkPull(item, pull): void };
  iterations?: { list(): Iteration[]; assign(item, it): void; create?(it): Iteration };
  checks?:    { forCommit(sha): Check[]; forPull(ref): Check[]; rerun?(check): void /* + logsUrl */ };
  protection?: { read(branch): { requiredReviews: number; requiredChecks: string[]; allowsMerge: boolean } };
}
interface Capabilities {            // every optional member above is a flag, probed, never assumed
  pulls: { create; comment; merge; draft; mergeQueue; bodyMax: number };
  items: { query; create; transition; estimate: 'field' | 'label' | 'none'; parentLink: boolean };
  iterations: 'native' | 'milestone' | 'none';
  checks: { read; rerun; logsUrl };  protection: { read };
  rate: { limit?: number; resetsAt?: string };
}
```

`probe` runs at **test** time and on version change: it reads `/version`-style endpoints, calls one cheap
endpoint per optional member, and reports *missing scopes by name*. The page shows the result as chips;
a feature without its chip does not appear in the UI and its operations are not offered to the agent.
No SDK is added (no Octokit, no azure-devops-node-api): fetch + the existing client, GraphQL as a plain
POST. A dependency per provider is a supply-chain surface (0033) for ~20 endpoints each.

Operations carry an **effect class** reusing 0009's vocabulary and `approvalDecision`: reads `read`;
comments, item updates, transitions, push-and-open-PR `external` (first use asked per session at `auto`;
the "Open PR" click is itself the approval in Delivery); **merge `destructive`** (asked every call, no
always-allow, refused when nobody can be asked).

### Provider map (API surface and gaps)

Versions and scopes are as known when this was written; **each adapter's first phase records fixtures from
the real service and corrects this table in an ADR amendment** before the adapter is called supported.

| Provider | API used | Auth (v1 → later) | Repos / PR | Work items & iterations | Checks | Gaps to state in the UI |
|---|---|---|---|---|---|---|
| **Azure DevOps Services** | REST `api-version=7.1`; WIQL `POST _apis/wit/wiql` (`timePrecision=true` or `ChangedDate` compares by day only), items via `workitemsbatch` (≤200 ids) and **JSON-Patch** (`application/json-patch+json`, `test` op on `/rev` for optimistic concurrency); `_apis/git/repositories/{r}/pullrequests`; team iterations `{team}/_apis/work/teamsettings/iterations` | PAT (Basic, empty user) → Entra | PR create/update/threads/complete; branch policies via `_apis/policy/*` | Process-dependent types and states (Agile/Scrum/CMMI/Basic). Map by **state category** (Proposed, InProgress, Resolved, Completed, Removed) from `workitemtypes/{t}/states`, never by name. Points field differs by process (`StoryPoints` / `Effort` / `Size`); discovered from the type's fields | `_apis/build/builds`, PR statuses, policy evaluations (preview) | PR description limit **4000 chars** (evidence goes in a thread comment); no ETag, so incremental sync uses WIQL; throttled by TSTUs (`429`, `Retry-After`) |
| **Azure DevOps Server** (on-prem) | same, **negotiated**: read `_apis/connectionData`, use the highest version ≤ 7.1 the server supports (Server 2020 is 6.0; 2022 7.0/7.1) | PAT | same | same; fewer preview APIs | Build; policy evaluations may be absent | Capability probe decides; older servers lose features, not the connection |
| **GitHub** (github.com Free/Pro/Team/Enterprise Cloud) | REST (`X-GitHub-Api-Version: 2022-11-28`) for repos, pulls, issues, check-runs, protection/rulesets; **GraphQL** for Projects v2 (iteration/number/single-select fields) and `enablePullRequestAutoMerge` | fine-grained PAT → device flow → GitHub App | PR create/update/review/merge; `mergeable_state`; reviews with `author_association` | Issues are open/closed only; richer state = Projects v2 `Status` single-select. Iterations = Projects v2 iteration field (has start + duration); milestones as fallback (due date only). Points = a Projects number field | check-runs + combined status; `rerun-failed-jobs`; logs as a URL | Rulesets/protection read needs admin on the repo (probe says "unknown", UI shows "protection unreadable"); ETag + `If-None-Match` makes a `304` free of rate limit; secondary limits return `403/429` with `Retry-After` |
| **GitHub Enterprise Server** | same under `https://HOST/api/v3` and `/api/graphql`; features lag the version (probe `/meta`) | PAT → App | same | same, minus whatever the version lacks | check-runs since 2.x; Actions rerun on newer | Projects v2 needs a recent GHES; otherwise milestones only |
| **GitLab** SaaS / self-managed | REST v4 `/api/v4` (GraphQL only where REST lacks it, e.g. some work-item status) | PAT / project-or-group access token → device flow (recent GitLab) | MR create/update/notes/approvals; `merge_when_pipeline_succeeds`; merge trains if enabled | Issues: opened/closed + labels; **status via scoped labels** (`status::doing`; exclusivity is a tier feature, so the adapter enforces one status label itself) or native work-item status where the version has it. Iterations are tier-gated (Premium+, group-level) → milestones otherwise; points = issue `weight` (tier-dependent) | MR pipelines, jobs, retry; log URL | Writing issues/MRs needs scope `api` (coarse; mitigation: a **project access token with Developer role**, which cannot push protected branches); `429` + `RateLimit-*` headers |
| **Bitbucket Cloud** | REST 2.0 `api.bitbucket.org/2.0` | API token (scoped; app passwords are being retired on Atlassian's announced schedule) / repository or workspace access token | PR create/update/comment/approve/merge; branch restrictions | **No built-in sprints; issue tracker optional per repo and basic; real teams use Jira, which is out of scope.** Work items: off by default; local sprints only | Pipelines (`/pipelines`), commit statuses | Honest: PR-and-checks connector, not a planning connector |
| **Bitbucket Data Center** | REST `/rest/api/1.0` (+ `/rest/build-status/1.0`, `/rest/branch-permissions/2.0`) | HTTP access token (Bearer) | PR create/update/comment/merge — **merge needs the PR's current `version`** (optimistic) | none (Jira-linked) | build status is *pushed by an external CI* (Bamboo/Jenkins), read only | no iterations, no items; admin-set rate limits |
| **Gitea** | REST `/api/v1` (Swagger at `/swagger.v1.json`, probe `/api/v1/version`) | token (`Authorization: token`), OAuth2 later | PR create/update/comment/review/merge (styles); protection read | Issues, labels, **milestones** (due date only) as iterations; no REST for project boards; points only as a label (`sp:5`) if the person opts in | commit statuses; Actions run API is partial and version-dependent | no estimates field, no board API |
| **Forgejo** | Gitea's API, **diverging** since the hard fork | same | same | same | same; Actions API differs from Gitea | adapter shares Gitea's code and a per-endpoint probe; a mismatch lowers the chip, not the connection |
| **GitBucket** | GitHub-compatible API v3 **subset** at `/api/v3` | token | repos, PRs (create/comment/merge), commit statuses | issues, labels, milestones | commit statuses only (no check-runs, no Projects, no merge queue) | run through the GitHub adapter in a *compat profile* whose capabilities come entirely from the probe |

**Sync cadence (no inbound webhooks).** The local engine has no public address, so it **polls**: while a
board with a mapped project is open or the dispatcher is running — items every 5 min, tasks in `pr` every
60 s backing off to 5 min, per-connection token bucket, `ETag`/`If-None-Match` (GitHub, Gitea, GitLab
where offered), `since`/`updated_after` filters, WIQL for Azure; `Retry-After`/`RateLimit-Reset` honoured,
exponential backoff with jitter, and a `rate-limited` chip rather than a failing sync. Webhooks are an
optional later layer through the Control server sketched in 0035 §3; the adapter interface does not
change, only the trigger that calls `pull()`.

## 2. Sync with Delivery

**Link.** `Task.remote?: { connection, kind: 'item', id, url, rev, syncedAt }` and, in PR mode,
`Task.pr?: { id, url, state, checks[], reviews[], mergeable }`. The journal gains additive events
(`remote/linked`, `remote/pulled`, `remote/pushed`, `remote/conflict`, `pr/opened`, `pr/observed`); the
fold ignores events it does not know, so an older engine reading a newer journal degrades instead of
failing (ADR 0001). A new `TaskStatus` value `pr` ("awaiting the remote") is part of this change; clients
ship with it (the shared type is the contract, 0038).

**Field ownership** — the whole conflict policy is this table:

| Field | Owner | Rule |
|---|---|---|
| title, body, acceptance, labels, priority, estimate, iteration, assignee | **remote (people)** | pulled; a pull overwrites local. AICO never edits them. Acceptance is the body's `## Acceptance` checklist (or Azure's *Acceptance Criteria* field) |
| backlog → `ready` | **a person, in AICO** | importing, or a remote "ready"/sprint-committed state, never starts spend (0038 §ready); the card shows "ready on remote" with one click to promote |
| running / review / pr / merged | **AICO** | pushed as a transition to the mapped remote state (below), only forward from what the remote currently shows |
| progress notes, evidence summary, PR link, `aico` label/tag | **AICO** | appended as a comment / link / tag; never edits a comment of a human |

- **State map** (`StateMap`, probed default, editable in one row per state, stored per project):
  `backlog→Proposed`, `running→InProgress`, `review|pr→InProgress (or an "In review" state if one exists)`,
  `merged→Completed`, `cancelled→Removed`; `blocked` is a label/tag, not a state. Azure uses state
  *categories*; GitHub uses Projects `Status` if present, else open/closed + an `aico:running` label;
  GitLab uses a `status::` label or native status; Gitea/Forgejo/GitBucket use open/closed + labels.
- **Conflicts.** Every write carries the revision it was based on (`ifRev`: Azure JSON-Patch `test /rev`,
  GitHub/Gitea `updated_at` re-read, GitLab `updated_at`). Mismatch → re-pull, **remote wins**, the local
  intent is dropped and a `remote/conflict` event records both. Two cases pause rather than guess: the
  item was closed/removed remotely while its task is `running` → task `blocked` ("closed upstream"),
  person decides; the item was reassigned to a person → AICO stops writing to it.
- **Assignee.** A running task is shown as "AICO run <id>" in Delivery. On the remote, AICO sets an
  assignee **only** when the connection's identity is a bot/service account the person chose; it never
  assigns the PAT owner's name to machine work.
- **Evidence.** The packet (0034) is the PR body and the item comment, clipped to `Capabilities.pulls.bodyMax`
  (Azure 4000; GitHub 65 536; GitLab ~1 M) with the full text as a first comment. It carries no AI
  attribution (AGENTS.md §4.1; asserted in the adapter tests like 0034's).

### Landing mode (per project, default `local`)

`local` is 0038 unchanged. `pr`:

1. The queue still rebases onto the local trunk copy and runs the project's checks first — cheap, and
   it keeps red work off the remote.
2. A person's **Open PR** click (human route, replacing *Approve* in the review card) lets the **engine**
   push `aico/task-<id>` and create the PR. The push is a new, narrow carve-out of 0038's "Delivery never
   pushes": destination ref must match `^aico/task-[A-Za-z0-9_-]+$` *by construction in code*; never the
   trunk or any protected pattern, never `--force`, `--delete`, `--mirror`; non-fast-forward is an error
   the task reports, not something to override.
3. Status becomes `pr`. The poller reads PR state, required reviews and checks. **The remote's rules are
   the gate**: AICO never calls an admin-bypass merge, never edits protections, never approves its own PR.
4. Remote checks red → `changes`, run resumed with the failing job's log (as untrusted data) via the
   existing resume path. The fix is a **new commit on the same branch** (trunk movement is absorbed by
   merging the trunk *into the task branch*, not by rebase + force-push — so PR mode loses 0038's linear
   history guarantee on the task branch; the remote's merge style (squash/rebase) restores it on landing).
5. **Merge is the remote's.** Default: a person merges in the platform (or has enabled the platform's
   auto-merge, which AICO neither sets nor unsets); AICO observes `merged` and closes the task, removes
   the worktree and local branch. Optional: a person clicks **Merge** in AICO → `destructive` class, shown
   only when the remote says mergeable and requirements are met. AICO does not delete remote branches
   (leave it to "delete branch on merge").
6. **Pipeline results feed risk.** `risk.ts` gains reasons: remote checks failed/pending/none, required
   reviews missing, target protected, CI touched in the diff. A task with no remote checks configured is
   never scored lower for it ("no gate" is a reason, not a credit).
7. `autoLandLowRisk` (0038) means nothing in PR mode; the setting is hidden there.

**Git credentials.** The engine runs `git` with an argument array, `GIT_TERMINAL_PROMPT=0`,
`-c credential.helper=`, and a remote URL **without userinfo**. A tiny engine-owned `GIT_ASKPASS` script
reads the token from a **read-once 0600 temp file** (the 0010 sink: created just before the call, the
script unlinks it on first read, removed after the call regardless) so the token is not in argv, the
worktree's `.git/config`, the model's environment or its Bash. Honest limit: a repo-supplied `pre-push`
hook runs before git asks for a password and could read the file during that window; a hook is already
arbitrary code as the user, but the stronger variant (askpass redeems a single-use nonce over a local
named pipe) is listed in Open questions because it is a new local listener.

## 3. Dynamic connectors (any other platform)

The agent never writes engine code. It writes **data plus tools that already have a trust model**.

1. Person: "connect our Linear/Phabricator/YouTrack at https://…". Agent: `ConnectionManage create
   provider:"custom" baseUrl, docs` (a URL or an OpenAPI/Swagger file the agent reads with WebFetch;
   the engine parses nothing).
2. The agent produces a **connector pack** in `aicoHome()/connections/custom/<id>/`:
   - `connector.json`: the supported operations (a subset of the adapter interface), each mapped to either
     a **custom tool** (an `http` runner, 0009: SSRF guard, origin-bound credential, masked responses) or
     an **MCP tool** of a stdio server the pack lists (for anything stateful, GraphQL multi-step or a
     non-trivial auth dance); response→`RemoteItem`/`Pull`/`Check` field mappings as **JSON pointers
     only (no expressions)**; pagination as one of three styles (Link header, cursor field, page number);
     state map; declared hosts; capabilities (derived from the operations declared and passing).
   - `tools/*.tool.json` (the 0009 tools) and `fixtures/` (recorded request/response pairs, scrubbed).
3. **Contract tests before enabling.** `ConnectionManage test-contract <id>` starts a mock server
   from `fixtures/` (loopback), runs every declared operation through the real engine path, and checks
   the normalised output against the shared types. A failing or absent contract keeps that operation off
   and its capability flag false. Then a **live read-only probe** by the person's click.
4. **Enable needs a person, bound to a hash.** The enable record hashes `connector.json` + the tool files
   + the fixture manifest + hosts (0009's rule: any edit un-enables). A project cannot ship a connector
   (project-trust hash would be needed and is not offered in v1). `ConnectionManage` can write drafts and
   run contract tests, never enable.
5. **Least privilege.** Credential by reference only (vault name in a header template);
   `hosts` is the connection's allow-list, enforced by the HTTP runner and, for MCP-backed tools, by
   the 0035 `network` policy plus `mcp` policy mode (an `allow-list` policy admits only named servers).
   Write operations are `external`, merge-like operations `destructive`; the *author-declared effect
   class is a claim* (0009's honest limit) — the adapter therefore **maps** operation names to classes
   itself (`create*`/`update*`/`transition*`→external, `merge*`/`delete*`→destructive) and uses the stricter
   of declared and mapped.
6. Honest limit: a declarative adapter is weaker than a built-in one — no cross-endpoint transactions,
   no retry semantics beyond the three pagination styles and the shared backoff, and a surprising API
   (RPC over one URL, non-JSON, XML-signing auth) needs an MCP server, not a manifest.

## 4. Agile and Scrum

A **mode of the Delivery board**, not a second app: `BoardState.settings.mode: 'kanban' | 'scrum'`
(default `kanban`, one switch in the board header). All Scrum state is journal events and pure folds
(ADR 0001), so it works with no connection and replays after a restart.

| Concept | Model (events → fold) | Notes |
|---|---|---|
| Sprint | `sprint/created {name, goal, start, end, capacity?}` → `planned → active → closed` | one active sprint per project |
| Estimate | `Task.points?: number` (`task/estimated`) | scale shown as 1·2·3·5·8·13 but free numbers allowed; maps to the platform's points field when `estimate ≠ none` |
| Backlog refinement | the agent **proposes** (`proposal/created`: splits, acceptance criteria, estimates, dependencies from the code graph); a person accepts per proposal → ordinary `Delivery create/update` | the agent cannot promote or commit; a proposal is data |
| Sprint planning | agent proposes a commit set that fits capacity, orders by priority + `dependsOn`, and flags `touches` overlaps that would serialise work; **the person commits** | capacity default = mean points merged in the last three closed sprints |
| Start sprint | person act (human route): sprint tasks → `ready`; dispatcher still starts paused after a restart | in `scrum` mode the dispatcher only takes `ready` tasks that are in the active sprint |
| Daily summary | deterministic builder over the log: merged, in review/`pr`, blocked (with reason), cost, plus "needs you" list; an optional "Write it up" runs one cheap model call over those facts | no stored prose that the log cannot back |
| Burndown | remaining points at each day's close, folded from `task/merged` and `sprint/scope-changed` | scope added mid-sprint is shown as a step, not hidden |
| Velocity | points merged per closed sprint, rolling average | tasks without points count as 0 and the page says how many |
| Review | sprint review notes built from each merged task's evidence summary + acceptance checklist; unmet acceptance is listed, not omitted | exportable as Markdown/PDF through the existing doc export |
| Retro | draft = facts (carry-over, `changes` rounds, blocked days, failed/flaky checks, cost per point) + three prompts; people edit and save as `retro/saved` | not auto-posted anywhere |
| Kanban | unchanged default; WIP limit = `maxParallel` | switching modes never loses data |

**Synced vs local.** Where the platform has iterations (Azure team iterations; GitHub Projects v2
iteration field, else milestones; GitLab iterations, else milestones; Gitea/Forgejo/GitBucket milestones),
a local sprint can be **linked** to one: name and dates are pulled (remote wins), membership of imported
items is two-way (a human planning decision in either place), points use the discovered field. AICO
creates a remote iteration only when the person ticks "create on <platform>" at sprint start. Bitbucket
(both) and platforms with no iteration concept keep sprints local, and the page says so.

## 5. UX

**Connections** is one page (desktop and web; VS Code opens the web page), reached from the Delivery
board's header and Settings. Nothing else is added to navigation, and there is no per-provider settings
section.

- **List.** One row per connection: provider · label · host · a status chip (`Connected`, `Sign in
  again`, `Unreachable`, `Rate-limited`, `Limited: no pipelines`) · mapped projects. Empty state: *Add
  connection*.
- **Add (four steps, one screen).** Pick a provider (tiles: GitHub, GitLab, Azure DevOps, Bitbucket,
  Gitea/Forgejo, GitBucket, Other) → URL (shown only for self-hosted; cloud is pre-filled) + **Sign in**
  or **Paste token** (the exact scopes needed are listed with a link that pre-fills them where the provider
  allows it) → **Test** (capability chips, missing scopes by name) → **Use for this project** (repo
  auto-detected from `git remote get-url origin`; one confirm).
- **Zero-click discovery.** When a project's `origin` host matches a known cloud host or an existing
  connection, the Delivery page shows one line — "Connect GitHub for this repo?" — never a prompt.
- **Per project** (a drawer on the same page): *Landing* — Local / Pull request; *Work items* — Off /
  Assigned to me / Label / Query; *State names* — a seven-row table, prefilled. That is the whole surface.
  CA bundle and extra hosts sit under a collapsed *Advanced*.
- **Scrum** is the board's mode switch plus the sprint header; there is no Scrum settings page.
- **Agent-configurable.** `ConnectionManage` (deferred group `connections`, one tool, `action` like
  `SkillManage`): `providers`, `list`, `create`, `test`, `map`, `sync`, `describe`, `disable`, `remove`,
  and for dynamic connectors `draft`, `test-contract`. Rules enforced in code, not in the prompt (principle 2):
  it **cannot** store or read a credential (it returns a request card), cannot enable a custom connector,
  cannot widen `hosts` or change `baseUrl` after the first credential, and setting `landing: 'pr'`
  returns a confirm card (a standing change that makes the engine push). Everything else — create, test,
  map a repo, choose work-item source, sync now — it does from plain instructions, e.g. "connect this
  project to our Azure DevOps, sync the sprint backlog, and open PRs".

## 6. Security

| Threat | Mitigation |
|---|---|
| Model or injected text reads a token | credential only in the vault; adapters are trusted consumers using `resolve()` (0006); git via the read-once sink (above); `ConnectionManage` has no read path; tool results are redacted as everywhere |
| **Issue text, PR comments, CI logs steer the agent** | every remote string is *untrusted data*: stored with `source: 'remote'`, fenced in the run prompt as data (the 0034 treatment of PR title/body), HTML comments and invisible/tag Unicode stripped on import, size-capped, never executed or interpreted as instructions; the injection tests (0034/engine suite) gain remote-text canaries |
| A drive-by commenter on a public repo steers a fix | review feedback is fed to a resumed run **only** from the PR's reviewers/assignees or authors the provider marks as members/collaborators (`author_association` on GitHub; project membership on Azure/GitLab; else the connection's `trustedCommenters` list). Other comments are shown to the person, not to the agent |
| Merge to a protected branch | AICO never bypasses protections; merge is `destructive` (every call, person, human route) and only when the remote reports mergeable + satisfied; the default is that a person merges on the platform |
| Over-scoped token | scopes are listed per provider and `probe` reports **extra** powers it can detect (e.g. GitHub classic `repo`+`admin:*`, Azure "Full access") as a warning chip; recommended forms: fine-grained PAT / project access token / Azure PAT with Code, Work Items, Build scopes only |
| A cloned repo points the engine at an attacker host | connections and mappings live in the user store, never the repo; a repo can *suggest* a remote (its `origin`), only a person creates the connection |
| SSRF / metadata via `baseUrl` | ops SSRF guard on every request and redirect; LAN hosts shown on the approval card when an agent proposes them |
| Rate-limit abuse / runaway sync | per-connection token bucket, sync request budget per cycle, backoff + `rate-limited` chip; sync pauses with the dispatcher |
| Silent action on the team's tracker | every remote write is an audit event; first write per connection per session is asked at `auto`; comments are labelled as machine-made and never claim to be the person |
| Dynamic connector as a backdoor | no engine code from the model; hash-bound enable by a person; contract tests; allow-listed hosts; stricter-of effect class (§3) |

**Policy (0035)**: a restrict-only `connections` key — `{ mode: any | forbid | allow-list, providers?:
string[], hosts?: string[], maxLanding?: 'local' | 'pr' }` — enforced at `ConnectionManage create/map`, at
adapter request time (second line), and at landing; `customTools`/`mcp` modes already govern dynamic
connectors; `network` applies to all connection traffic; `deniedTools` can remove `ConnectionManage`. Policy
can only restrict (0002); a connection that becomes disallowed shows `Blocked by policy` and does nothing.

**Audit (0035 §2)**: new kind `connection` — `create`, `test`, `map`, `use` (read batch), `write`
(comment/transition/update), `push`, `pr.open`, `pr.merge`, `sync`, `policy.deny` — with connection id,
provider, operation, target as host+path **without query**, item/PR id, outcome and rate-limit state;
never bodies, titles or tokens. The vault's own audit already records each credential use by name.

## 7. Phasing, effort, tests

Effort: S ≈ days, M ≈ 1–2 weeks, L ≈ 3+ weeks of one engineer.

| Phase | Content | Effort | Depends on |
|---|---|---|---|
| **0** | Connection store, vault policy binding, `ProviderAdapter` + capability types, HTTP client `ca` option, polling/backoff core, `ConnectionManage`, Connections page shell, audit + policy key, fixture replay harness | M | — |
| **1** | **GitHub** (github.com + GHES): probe, repos, issues import/transition/comment, PRs, checks, protection read; **PR-mode landing end to end** (`pr` status, engine push, risk reasons, observe-merged) | L | 0 |
| **1b** | **Scrum mode, local only** (sprints, points, proposals, planning, summaries, burndown, velocity, review, retro) — no network, can run in parallel with 1 | M | 0038 |
| **2** | **GitLab**; **Gitea/Forgejo**; **GitBucket** (GitHub compat profile) | M each for GitLab, S for the other two | 1 |
| **3** | **Azure DevOps** Services + Server (WIQL, JSON-Patch, process/state categories, iterations, policies, version negotiation) | L | 1 |
| **4** | **Bitbucket** Cloud + Data Center (PR + checks only) | S–M | 1 |
| **5** | Iteration sync for every adapter that has one (GitHub Projects v2, Azure, GitLab) | S each | 1b + adapter |
| **6** | **Dynamic connectors** (declarative + MCP-backed, contract tester, enable flow) | M | 0, 1 |
| **7** | OAuth device flow (GitHub, GitLab), GitHub App, Entra for Azure DevOps | M; needs the owner to register apps | 1–3 |

Order of value: 0 → 1 (+1b in parallel) → 3 or 2 by who the first users are → 6 → 4/7.

**Tests (no live calls in the suite).**
- **Recorded fixtures per provider and scenario** (`test/fixtures/connections/<provider>/<scenario>/`),
  recorded once by the owner with `scripts/record-connection-fixtures.mjs`, scrubbed (tokens, emails,
  hostnames → `forge.test`) and covered by the secret scan; replayed by a loopback mock forge
  (`scripts/lib/mock-forge.mjs`) on `127.0.0.1`.
- **One conformance suite** runs the same operation script against every adapter and compares normalised
  output to goldens; capability probes are tested against fixtures of older/limited servers (Azure Server
  2020, a GHES without Projects v2, GitLab Free) so degradation is a tested behaviour.
- **Invariants as assertions**: no token in log/stream/result/argv/`.git/config` (canary through each sink);
  push destination whitelist; no `--force`; field ownership (AICO never writes a human field); conflict →
  remote wins + event; injected text in issue/comment/log does not change a tool call; policy
  `forbid`/`allow-list`/`maxLanding`; TLS never skipped (an untrusted-CA fixture fails without
  `caBundle`, passes with it); PR body clipped to `bodyMax` with the rest in a comment.
- **Scrum folds** are pure functions over fixed journals (burndown, velocity, capacity, scope change).
- **Routes** are registered in `scripts/security/routes.json` and covered by the DAST suite; human routes
  (Open PR, Merge, Start sprint, enable connector, `landing: pr`) are refused on the API token alone.
- **Optional live smoke**, `npm run test:connections:live`, opt-in with the owner's tokens in the
  environment, read-only unless `--write` is given (then against a named sandbox repo/project only); free
  of model cost, never run in CI, never unprompted (AGENTS.md §4.11 by analogy).
- **Live verification** per adapter before it is called supported: add, test, map, import, run a task,
  open a PR, see the checks, merge on the platform, observe `merged` — with an isolated `AICO_HOME`.

## Alternatives considered

| Option | Why not |
|---|---|
| Per-provider MCP servers only | Moves auth, scopes, TLS and approvals into servers AICO does not control; no state-map, ownership or risk integration; every user re-solves setup. Kept as the *escape hatch* for custom connectors |
| Use the `gh`/`az`/`glab` CLIs | Not installed everywhere, three auth stores AICO cannot broker, output formats drift; `Git pr` already shows the ceiling of `gh` |
| Vendor SDKs (Octokit, azure-devops-node-api, …) | A dependency and transitive tree per provider for ~20 calls each; 0033 posture |
| Two-way sync of every field | Overwrites human edits; the ownership table is cheaper to explain and safer |
| Webhooks first | A local engine has no public address; polling is enough for a board and keeps 0035's "no new listener" |
| Model-written adapter code loaded into the engine | Runs arbitrary code with credential access; declarative + existing tool trust model gets 90% of the value |
| A separate Scrum/Agile page | A second product and a second place for the same tasks; one switch on the board |
| Ship Jira/Linear built-in | Large, vendor-specific, and the owner scoped Jira out; reachable through a dynamic connector |
| AICO merges when checks are green | Substitutes our judgement for the team's branch protection; merge stays the remote's and a person's |

## Consequences

- **Good:** the team's real gate (reviews, required checks, protections) governs landing; the backlog
  lives where people already look; no credential reaches the model; Scrum teams get a sprint without a
  new app; adding a platform is a reviewed pack, not a release.
- **Bad / costs:** nine adapters plus a manifest interpreter is the largest integration surface in the
  repo and will drift as vendors change APIs (the fixtures catch our regressions, not theirs); polling
  means up to a minute of staleness; PR mode gives up linear task-branch history; a new `pr` status and
  journal events change the shared contract; the OAuth conveniences need app registrations someone must
  own.
- **Honest limits:** capability depends on the token's rights and the server's version, and some
  probes report "unknown"; Bitbucket and Gitea/Forgejo/GitBucket get less planning support because the
  platforms have less; GitLab's write scope is coarse; the temp-file credential window exists (above);
  the author-declared effect class of a dynamic connector is a claim, hence the stricter-of rule; AICO
  cannot see branch protections it lacks the right to read.
- **Migration:** none for existing users: no connection means 0038 exactly as shipped; `mode` defaults
  to `kanban`; old journals fold unchanged.

## Out of scope

Jira, Linear, Asana, ClickUp and other trackers as *built-ins* (a dynamic connector may add them);
inbound webhooks; creating or deleting repositories, branches on the remote, or protections; editing CI
pipeline definitions or running deployments/releases; Azure Test Plans, wikis, boards beyond items,
epic/feature portfolio planning (a parent link is shown read-only); multi-repo or monorepo-splitting
mappings (one project ↔ one repo in v1); PRs from forks; inline code-review comments posted by AICO;
time tracking; SSO/SCIM/RBAC (0035); multi-user real-time assignment; a hosted AICO service.

## Decisions on the open questions (owner, 2026-10-09)

1. **PAT-only sign-in first.** No OAuth app is registered in AICO's name. Device flow, GitHub App and Entra
   are later, additive auth methods (phase 7) and need the owner to register apps.
2. **Git credentials use the read-once temp-file sink plus askpass.** No new local listener (no named pipe,
   no nonce server). The pre-push-hook window the ADR describes is closed further in the build: the
   engine's push runs with `core.hooksPath` pointed at an empty directory, so no repository hook runs while
   the token file exists.
3. **`pr` is a new `TaskStatus` and a board column, "PR open".** The shared contract grows by one status
   (plus `Task.pr` and `Task.remote`); clients ship with it.
4. **Provider order after GitHub:** Azure DevOps, then GitLab / Gitea / Forgejo / GitBucket, then Bitbucket.
   The phasing table's "2 before 3" is therefore reordered: phase 3 (Azure DevOps) comes next.

## Implementation notes (phase 0, GitHub, PR mode)

Built as designed except where this list says otherwise.

- **Where.** `src/connections/` (store, HTTP client, adapter interface, `github/`, `git.ts`, `sync.ts`,
  `landing.ts`, `poller.ts`), `shared/connections/types.ts`, `src/server/connection-routes.ts`,
  `src/tools/connection-manage.ts`, the Connections pane under `web/src/components/connections/`.
  Delivery stays network-free: it exposes `LandingHooks` and `observePr` / `mergePullRequest`, and
  `connections/index.ts` installs the hooks, so `src/delivery` still contains no push or fetch.
- **Fixtures** are under `scripts/fixtures/connections/<provider>/<scenario>/` (not `test/fixtures`) and are
  hand-written to the documented shapes; the owner still records real ones before an adapter is called
  supported. The loopback mock forge is `scripts/lib/mock-forge.mjs`; the reusable conformance suite is
  `scripts/connections-conformance.mjs`.
- **Journal.** PR and work-item state is recorded with ordinary `patch` events (`Task.pr`, `Task.remote`),
  not new `remote/*` / `pr/*` event types; a sync conflict is a task comment plus an audit line. Nothing in
  the fold needed to change.
- **Credential approval.** The vault credential is `approval: auto`, origin-bound, `allowedTools:
  ['Connection']`: the person's paste is the approval. The "first write per session is asked" line became
  the mapping step (a person turns the work-item source on) and the Open PR click. A re-sign-in stores a new
  credential name, because replacing a person's own credential needs a vault grant by design.
- **Stronger than the ADR:** `core.hooksPath` points at an empty folder during the engine's git calls, so no
  repository hook runs while the token file exists; the askpass script answers only for the expected host.
- **Local trunk.** In PR mode the engine fetches the remote trunk into a private ref
  (`refs/aico/remote/<trunk>`) and fast-forwards the local trunk when it is a strict ancestor and nothing
  uncommitted is on it, before preparing a task and after a remote merge.
- **A connection made by an agent** is a record with no token: it can do nothing until a person pastes one
  for the host the page shows, so the host-on-an-approval-card step is the token form itself.
- **Plain http** exists only as a person's opt-in for a private or loopback address (`insecureHttp`); it is
  how a self-hosted server on a LAN works and how the offline tests run.
- **Not built:** reassignment detection, Projects v2 writes, iteration sync into Delivery sprints (the adapter
  lists milestones and Projects v2 iterations; wiring them to sprints is phase 5), dynamic connectors
  (`draft`, `test-contract`), OAuth, and every adapter except GitHub. `ConnectionManage remove` is limited to
  a connection with no token.

## Implementation notes (phase 2: GitLab, Gitea, Forgejo, GitBucket)

Built as designed except where this list says otherwise. Fixtures are hand-written to the documented
shapes (`scripts/fixtures/connections/{gitlab,gitea,gitbucket}/`); none of these adapters has met a live
server, so the provider table above is **not** yet corrected by recorded fixtures and each is "built", not
"supported", until the owner has done the live add (the verification list in section 7).

- **Where.** `src/connections/gitlab/`, `gitea/` (one adapter, `makeGiteaAdapter('gitea' | 'forgejo')`),
  `gitbucket/`, and `rest.ts`, the request helpers they share (a non-2xx page is an error, never an empty list;
  provider-named messages; optional reads swallow only 403/404; bounded `Link: rel=next` paging). The GitHub
  adapter keeps its own copy and was deliberately not refactored to use `rest.ts`.
- **GitLab.** Projects are addressed by URL-encoded full path, so `RepoRef.owner` may contain slashes (nested
  groups); `mapProject` and the mapping form accept that for every provider (GitHub's own parser still takes two
  segments). Mergeability is `detailed_merge_status` (15.6+) with a conservative fallback to `merge_status` plus the
  head pipeline; an unknown status blocks and is shown in GitLab's words. Scopes and expiry come from
  `personal_access_tokens/self` (15.5+), unreported before. Iterations are probed (Premium) and fall back to
  milestones with a warning; a native iteration is set with the GraphQL `issueSetIteration` mutation because REST
  cannot, and its id is prefixed `iteration-` so it cannot collide with a milestone id. Weights are points where the
  tier returns them. Epics are not read; job re-run is not wired (no check id reaches the caller).
- **"Merge when pipeline succeeds" (the one contract change).** `PullState.autoMerge?: { kind: 'pipeline';
  available; armed }`, `ProviderAdapter.pulls.merge(..., { whenChecksPass })`, and `landing.mergePlan`: the click may
  arm it only when the remote offers it because a running pipeline is the one obstacle; GitLab applies every rule
  when it merges. The ADR's "AICO neither sets nor unsets auto-merge" stays true for every other case and provider.
  The Gitea family has `merge_when_checks_succeed`; it is not used.
- **Gitea / Forgejo.** Same API, a flavour for names and a version cross-check that warns (never fails) when a
  server reports the other name. `Authorization: token` (the transport's bearer auth gained a `scheme`). Scopes are
  never reported, so capabilities are probed. `mergeable: false` is "checking" for two minutes after the pull
  request's last update, then a conflict (rejected alternative: always a conflict, which would send a fresh pull
  request back to the agent). `canMerge` is conservative (mergeable, not a draft, no requested changes, no awaited
  review, every visible check green); the merge sends `head_commit_id` and never `force_merge`. Labels are ids on
  these servers, so names are resolved and the missing `aico:*` ones created. Trust is derived (the owner, the
  collaborators and `official` reviewers); nobody is trusted when those lists are unreadable. Estimates are `sp:N`
  labels; there is no Actions rerun.
- **GitBucket.** Not "the GitHub adapter with flags" after all: issues, labels, milestones and the merge-less
  pull request calls are delegated to `githubAdapter` (errors re-worded), but the pull request fold, probe,
  statuses, protection, issue listing (every filter applied client-side) and merge (head SHA compared first) are its
  own, because there is no `mergeable_state`, check-runs, reviews or search. Every gap is a capability that stays
  off. Whether GitBucket accepts a personal access token as the git https password is unverified.
- **Conformance suite.** `subject.wire` hooks (`authScheme`, `itemsQueryOk`, `assignedOk`, `updateVerb`,
  `updateSentOk`, `updateWrites`, `closeOk`, `labelsOk`, `assignOk`) let a provider say what a correct request
  looks like; the defaults are GitHub's, so the GitHub suite is unchanged.
- **Not built:** epics (GitLab), job/Actions re-run, GitLab merge trains, a Gitea `merge_when_checks_succeed`,
  OAuth device flow for GitLab, reading GitBucket reviews (it has none).

## Implementation notes (phase 4: Bitbucket; phase 6: connector packs)

Built as designed except where this list says otherwise.

**Bitbucket** (`src/connections/bitbucket/`: `cloud.ts`, `dc.ts`, `fold.ts`, `common.ts`)

- **Auth.** Atlassian retired app passwords (June 2026). A Cloud **API token** is Basic with the account email,
  so `StoredConnection.username` (not a secret, sent on create) picks Basic; with none the token is Bearer
  (repository, project and workspace access tokens). Data Center is Bearer with an HTTP access token. Git needs a
  different user name per kind, so the adapter interface gained `gitUsername(conn)` (default `x-access-token`):
  `x-bitbucket-api-token-auth`, `x-token-auth`, or the account the probe found.
- **Cloud cannot say whether a pull request merges.** `mergeable` is always `unknown`; `canMerge` is derived (open,
  not a draft, no failing or pending build, no changes requested, approvals at least the requirement). When the
  requirement is unreadable (it needs repository admin) one approval stands in for "reviewed", so a merge click is
  never offered on a pull request nobody approved. Cloud's merge has no head-sha parameter: `merge` re-reads the PR
  and refuses if the head moved since the caller looked (a small window the server's own restrictions still cover).
- **Data Center uses the server's merge check** (`GET .../merge`: `canMerge`, `conflicted`, vetoes) and the optimistic
  lock: the merge sends the PR's current `version`; a 409 is a `conflict`, never a retried merge. Required approvers
  and builds come from `settings/pull-requests` (admin); unreadable is a warning, and the server enforces them anyway.
- **Not built:** Jira (out of scope), sprints and iterations (none exist), inline comments, approving (AICO never
  approves a pull request). Cloud issues exist only where the repository enables the tracker; the component stands
  in for a label, and the label calls are no-ops. A personal Data Center repository (`~user`) is a valid owner.
- **Unverified against the real services.** Like the other adapters, the fixtures are hand-written to the documented
  shapes. Two points are from memory of the documentation and are the first to check when the owner records real
  ones: the Data Center merge body (`strategyId` only; `version` as a query parameter) and Cloud's description limit
  (30,000 characters is used, conservatively).

**Connector packs** (`src/connections/packs/`: `format.ts`, `store.ts`, `runner.ts`, `normalise.ts`, `contract.ts`,
`adapter.ts`, `index.ts`; the skill is `src/skills/builtin/connector-pack/`)

- **The credential is the connection's own vault record**, not a name in the pack: a pack says only HOW it is sent
  (`bearer`, `basic` with a username, or one header; never a query parameter). `storeToken` binds it to the pack's
  hosts, exactly as for a built-in provider. Anything credential-shaped in any pack file is refused.
- **The unit of approval is a digest** of `connector.json`, every tool and every fixture (hosts and mappings are in
  `connector.json`). `packs.json` records the digest a person enabled; `requireEnabled` compares it on EVERY request.
  Restoring the exact approved bytes is the approved content again (the record is a hash, not a flag).
- **Operations run through the shared `ConnectionClient`** with the tool's rendered request, not through the
  `HttpRequest` tool: the connection's policy, origin-bound vault resolution, rate limit and audit apply unchanged.
  The ADR 0009 `validateArgs` shell rules do not (a markdown body has newlines and backticks and never reaches a shell);
  `validatePackArgs` checks types, enum, pattern and bounds, and refuses `.`/`..` path values. Header values in a pack
  tool are literals.
- **Effect class = stricter of** the declared claim, the operation's own class (by name), the tool's `effect` and its
  HTTP method; a read must be GET unless `readOnlyPost`; a destructive operation (merge) refuses to run unless the
  caller says a person asked (`AdapterCtx.person`, set only by the human-gated landing path).
- **Contract test.** A loopback server the engine starts replays fixtures: method, path, query, body fragment and the
  declared credential scheme are checked on the request; the answer goes through normalisation, so a missing required
  field or an unmapped enum value fails. `ClientOptions.contractSecret` lets that one client skip the vault and the
  managed `connections` policy (loopback only; the network policy and SSRF guard still apply). MCP-backed operations
  are tested from the recorded tool result only (field maps and normalisation); the server itself is exercised by the
  person's live Test.
- **Weaker than a built-in adapter, said once:** no labels, no protection read, no iterations, one request per
  operation, mergeability is the connector's word narrowed by the normaliser, and pagination is the three declared styles.
- **Policy.** `connections.packs: "forbid"`; a provider allow-list without `custom`, and host lists, apply as for any
  provider; `customTools` is asked as `connector:<id>`; an MCP-backed operation asks the `mcp` rule at run time.
  Draft, test, enable and connect are all refused when packs are forbidden.
- **Who enables.** `ConnectionManage` has no enable action and imports no enable function (a test greps for it); the
  route `connections/pack-enable` needs the decision gate's human and the digest the person was shown (409 if stale).
  Disable and connect are person-only too. `create {provider: "custom", pack}` by the agent makes a token-less record
  with the approved hosts, like any agent-made connection.

## Implementation notes (phase 3: Azure DevOps; phase 5: iteration sync)

Built as designed except where this list says otherwise. **Every request and response shape follows the documented
REST reference (api-version 7.1, 7.0, 6.0) and hand-written fixtures; nothing has been run against a real Azure DevOps
Services organization or Server.** The owner still records real fixtures before the adapter is called supported.

- **Where.** `src/connections/azure-devops/` (`index.ts` the adapter, `fold.ts` the pure folds, `urls.ts`, `wiql.ts`,
  `scopes.ts`), `src/connections/iterations.ts` (provider-generic), `shared/connections/process.ts` (state categories,
  shared with the page so the preview and the write are one function), `web/src/connections-azure.ts`.
- **Repository identity.** `RepoRef.owner` is the Azure DevOps PROJECT and `name` the Git repository; the organization
  (or collection) is the connection's base URL. Projects may hold spaces, so `ProviderAdapter.validateRepo` replaces the
  generic `owner/name` pattern for this provider only. Services is entered as an organization name (the address is built
  from it); `suggestFromRemote` lets the board offer "Connect Azure DevOps for this repo?" from any of the six remote
  spellings before a connection exists.
- **Auth is Basic with an empty user name** (a new `basic-empty-user` mode in the ops transport; `Basic` with a
  username would have needed a fake one). A revoked or expired PAT is answered with `203` and an HTML sign-in page, not
  `401`; `ClientOptions.authFailure` makes the transport treat it as the 401 it is.
- **Versions.** Services is `7.1`. A Server is walked down 7.1, 7.0, 6.0, 5.1 by `GET _apis/projects?$top=1` until one is
  not answered with `400`; the result is written into `ProbeResult.version` ("Azure DevOps Server (REST 6.0)") and read
  back into the `Accept: application/json;api-version=X` header of every later request (a client built before any probe
  speaks 6.0). Policy evaluations are `X-preview.1`. Server 2019 or newer; older is refused with that sentence.
- **Mergeability is the policies'.** `canMerge` = merge status `succeeded` AND evaluations readable AND no blocking
  evaluation unapproved AND no change requested. Unreadable evaluations are "cannot tell", with a sentence, never a guess.
  Only build and status policies are CHECKS (they send a task back to the agent); policies code cannot fix (comment
  resolution, work item linking, required reviewers) are blockers. Merge sends `lastMergeSourceCommit` (re-checked
  against the PR first), `bypassPolicy: false`, `deleteSourceBranch: false`; completion is asynchronous so the PR is
  re-read. AICO's own threads are `closed` so they cannot trip a comment-resolution policy. Comment authors have no
  `author_association`: in a private project every commenter is a member (commenting needs permission), in a public one
  only the creator and the reviewers are.
- **Work items.** WIQL (`timePrecision=true` so a `since` filter compares times, not days) then `workitemsbatch` in chunks
  of 200; a person-typed condition is checked and parenthesised, and every returned item is verified to be in the mapped
  project. Writes are JSON-Patch with a `test /rev` operation after a re-read; tags are read-modify-write. `rev` is the
  revision number as text. Comments go through `System.History` (the comments API is preview-only).
- **State map is categories** (ADR section 2 said "map by category, never by name"): `Proposed`, `InProgress`,
  `Resolved`, `Completed`; `blocked` stays a tag. `ProviderAdapter.defaultStateMap` supplies it, `items.transitionCategory`
  writes it, forward only. A stored value that names a category is a state, not a label, only for an adapter that has
  `transitionCategory`, so a GitHub project that calls a label "InProgress" is unaffected.
- **Writes report their revision** (`WriteResult`): Azure DevOps bumps `rev` on every write, including AICO's own note,
  so the next write in the same sync pass must carry the new one or it conflicts with itself.
- **Iterations to sprints** (`iterations.ts`): the current and next iteration become PLANNED sprints (`Sprint.remote`,
  `sprint` and `sprint-sync` journal events, additive); the platform's timeFrame beats this machine's clock; a milestone
  has no start, so its sprint runs from the day it is first imported. Membership and points are a three-way merge with the
  base stored on `RemoteLink` (`iteration`, `points`): remote moved, remote wins; only local moved, push once; neither,
  nothing. `placeFromRemote` never makes a task ready. Unknown membership (a Projects read that failed) is not "none".
  An iteration is created on the platform only by `createRemoteIteration` from a human-gated route; an agent cannot turn
  sprint sync on (`human-required`).
- **Not built:** a Services OAuth/Entra sign-in (PAT only, as decided), Boards beyond items and iterations, Area-path
  filtering beyond a WIQL condition (the area is shown as an `area:` label), a UI tick for "create on Azure DevOps" at sprint
  start (the route and function exist), GitHub Projects v2 writes, test plans, wikis, and pipelines beyond reading builds
  and statuses. `checks.rerun` is off. Connections to a project whose process adds a state category AICO does not know
  read the unknown category as `proposed`, never as done.

## Verification

When built: the conformance suite and the invariant assertions above run in `npm test`; reversing any of
the following fails a test, not a review — push destination whitelist, remote-wins conflicts, untrusted
remote text, TLS verification, hash-bound connector enable, human-route-only merge/Open PR/Start sprint.
