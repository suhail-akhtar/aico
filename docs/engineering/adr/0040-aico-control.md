# 0040 — AICO Control: an organisation server for identity, policy, usage and audit (execution stays on each machine)

- **Status:** Accepted
- **Date:** 2026-10-10
- **Deciders:** owner (+ authors)
- **Supersedes / related:** [0035](0035-managed-policy-and-audit-export.md) (the managed policy and the `aico.audit/1` stream this serves and ingests), [0002](0002-guards-only-deny.md) (guards only deny), [0006](0006-credential-broker.md) (the vault holds the engine's tokens), [0003](0003-desktop-is-a-client.md), [0036](0036-licence-fsl.md) (licence), [0039](0039-connections-and-agile.md)

## Context

ADR 0035 gave an organisation a lock above the user (a machine-wide policy
file) and a SIEM-ready audit export, and said plainly what it did not build:
**no identity, no per-user or per-team policy, no central collection, no budget
that spans machines.** The file is distributed by MDM; a policy per role means
a different file per machine; "what did the contractors spend this week" means
collecting exports by hand. An organisation of more than a handful of people
needs one place that knows who the people are, what each may do, what they have
spent and what was done.

The owner's decision (2026-10-09) fixes the shape: **execution stays on each
person's machine** (tools, files, builds, the browser, apps, the model loop).
The server holds identity, tenancy, roles, policy, usage and budgets, and audit,
and serves an admin portal. The desktop app and web portal sign in to it; the
local engine enforces what it receives with the **same deny-only machinery** as
the managed policy file.

Constraints: Node >= 22.5 and `node:sqlite` are already the engine's baseline;
"no new runtime dependency without an ADR" ([coding-standards.md](../coding-standards.md));
a server that executes agent work would be a second, far larger security
product (sandboxing, tenancy of code execution) and is out of scope by the
owner's decision.

## Decision

### Components

| Component | Where | Notes |
|---|---|---|
| **Control server** | `control/` — a separate Node package in this repo (own `package.json` and lockfile), `control/src/**` | HTTP API + static portal. Zero runtime dependencies: `node:http`, `node:sqlite`, `node:crypto`. One process, one SQLite file = a single-node deployment. Postgres is a later storage option behind the same repository functions (phase 4). |
| **Admin portal** | `control/portal/` (React + Vite, built to `control/portal-dist`) | Reuses `web/`'s design tokens (CSS variables). Served by the control server; no separate origin, so cookies, CSRF and CSP stay simple. |
| **Engine client** | `src/control/**` | `aico control login/status/logout/sync`; device-flow enrolment; fetches the policy and applies it as one more **layer** in `src/policy/managed.ts`; pushes audit and usage in batches. |
| **Shared schema** | `src/policy/managed.ts` | The server imports `validatePolicy` from the engine's module (bundled at build time) rather than copying the schema, so the server cannot accept a document the engine reads differently. |

The control package is **not** part of the engine's npm files and is not
published; it ships as a Docker image / tarball from a GitHub release. The
engine does not depend on it being installed.

### Multi-tenancy

`tenant -> teams -> users`. A tenant is one organisation; one server may host
several (a managed offering) or one (self-hosted). Every row in every table
except `meta` carries `tenant_id`, every repository function takes the tenant
as its **first argument** and puts `tenant_id = ?` in the SQL, and tokens and
sessions are bound to a tenant. There is no function that reads a row by id
alone. Tests (`control/test/tenancy.test.mjs`) create two tenants with the same
emails, team names and policy scopes and prove that no admin API, no engine API
and no token of one can read, write, list, count, verify or revoke anything of
the other. A new table without `tenant_id` fails a schema test.

### Identity

- **Admins and people sign in with OIDC** — authorization code + PKCE (S256),
  `state` and `nonce`, against the tenant's own IdP (Entra ID, Okta, Google,
  Keycloak — anything with a discovery document and a JWKS). The ID token is
  verified (signature RS256/ES256 against the JWKS, `iss`, `aud`, `exp`,
  `nonce`); the server never sees a password. The client secret, when the IdP
  needs one, is encrypted at rest per tenant.
- A user must already exist (invited by an admin) or the tenant must allow
  just-in-time creation, which creates a `developer`. The first `owner` is
  created by `control bootstrap` on the server host, never over the network.
- **SAML** and **SCIM 2.0** (Users/Groups) are later phases; the user table
  already carries `external_id` and `source` for them.
- **Engines are enrolled with the OAuth device authorization grant (RFC
  8628)**: `aico control login <url>` shows a code, the person approves it in
  the browser (signed in through OIDC), and the engine receives a signed
  access token (15 minutes) and a rotating refresh token. Each enrolment is a
  **device** (a token family). Reusing a refresh token that was already
  rotated revokes the whole family (theft detection). An admin can revoke a
  device at any time; the next refresh or request fails.
- Access tokens are Ed25519-signed JWTs (EdDSA) so a later offline verifier
  needs only the public key; the server still checks the device and user rows
  on every request, so revocation and disabling are immediate.

### RBAC

Built-in roles (custom roles are phase 3): `owner`, `admin`, `auditor`,
`team-lead`, `developer`, `contractor`. Permissions: `tenant.read`,
`tenant.manage`, `users.read`, `users.manage`, `teams.read`, `teams.manage`,
`roles.read`, `policies.read`, `policies.manage`, `devices.read`,
`devices.revoke`, `audit.read`, `audit.export`, `usage.read`, `budgets.manage`,
`engine.use`. `team-lead` reads users, devices and usage **of their own team
only**; `auditor` reads everything and changes nothing; `developer` and
`contractor` can only use an engine (their difference is policy, below). The
role -> permission table is code (`control/src/rbac.ts`) and is tested
exhaustively; an unknown role has no permissions.

### Policy

The ADR 0035 policy document, **stored per scope**: `tenant`, `team`, `role`.
The server does not merge them into one blob. It serves the applicable
documents as an ordered list of **layers** and the engine asks every layer on
every check — exactly what `AICO_POLICY_FILE` does beside the system file
(0035: "layers, not a merged blob"; an intersection of glob lists has no clean
form). A team policy therefore cannot loosen the tenant policy, a role policy
cannot loosen either, and the control layers cannot loosen the system file. A
document is validated with the engine's `validatePolicy` when it is saved: any
`error`-level problem rejects the save and is shown in the portal editor.
Restrict-only is by construction of the schema; there is no key that grants.

### Usage, budgets, rate limits

Engines report usage events (`turn.end` facts: model, tokens, estimated cost).
Budgets (`tenant`, `team` or `user`; `day` or `month`; USD) are enforced two
ways: the served policy carries `budget.perDayUsd` so the engine enforces it
locally even offline (0035's day-budget machinery), and the server returns a
`lease` with `blocked: true` when its fleet-wide count has passed a limit,
which the engine turns into one more deny-only layer (no model calls). Costs
are estimates (0035), and are labelled so. Request rate limits protect the
auth and engine endpoints (token bucket per IP / per device).

### Audit ingestion

Engines `POST /v1/engine/audit` batches of `aico.audit/1` records. The server
overwrites `tenant` and `user` from the token (an engine cannot speak for
someone else), de-duplicates by record `id`, and appends to a **per-tenant
hash chain**: `hash = SHA-256(prevHash || canonical JSON of the stored row)`.
The table is append-only by construction (no update or delete path; SQLite
triggers abort both). `GET /v1/admin/audit/verify` recomputes the chain and
names the first broken sequence number. Admin actions in the portal (policy
saved, device revoked, role changed, sign-ins) are written to the same chain.
Export is JSONL/CSV; the engine's own formatters (CEF) work on the export
offline; server-side CEF is phase 2.

### Model gateway (phase 3, not built)

An optional mode in which the server holds provider keys and proxies model
calls so developers never hold one. Needs streaming, per-token metering and a
key-escrow design; it gets its own ADR. Phase 1 changes nothing about where
keys live (each person's vault).

### Admin portal

React + Vite, tokens from `web/`. Pages: Sign in, Users & teams, Roles,
Policies (editor with live validation), Devices (revoke), Audit (search, verify
chain), Usage (per user/team, budgets).

### Deployment and security

- **TLS is required.** The server refuses to listen on a non-loopback address
  without `--tls-cert/--tls-key` or `--behind-proxy` (then it requires
  `X-Forwarded-Proto: https` and sets `Secure` cookies). Loopback http is
  allowed for development only. Engines refuse non-https control URLs except
  loopback.
- Sessions: random 256-bit id, only its hash stored; `HttpOnly`,
  `SameSite=Lax` (`Secure` over TLS); 8 h absolute, 30 min idle. **CSRF:** every
  state-changing cookie-authenticated request needs `X-CSRF-Token` equal to the
  session's token and a same-origin `Origin`; bearer-authenticated engine calls
  are not cookie-ambient and need neither.
- Secrets at rest (IdP client secrets): AES-256-GCM with a per-tenant key
  derived by HKDF from the master key (`CONTROL_MASTER_KEY` or a `0600` key file
  created on first start) and the tenant id. Refresh tokens and device codes are
  stored only as SHA-256 hashes.
- Security headers (CSP `default-src 'self'`, `frame-ancestors 'none'`,
  `nosniff`, referrer only to the same origin), bounded request bodies, rate limits.
- **The server never executes anything for a client**: no shell, no file
  access beyond its own data directory and the portal assets, no outbound
  fetch except to a tenant's configured IdP (discovery/JWKS/token; link-local
  and metadata addresses refused).
- Docker image and compose file in phase 1 (`control/Dockerfile`,
  `control/compose.yaml`); Helm later.

### Phasing

1. **Phase 1 (this change):** single-node server (SQLite); tenants, teams,
   users, six built-in roles; policies per tenant/team/role validated with the
   engine schema; OIDC login (authorization code + PKCE) for the portal;
   device-flow enrolment with rotating refresh tokens and revocation;
   `GET /v1/engine/policy`; `POST /v1/engine/audit` (hash-chained) and
   `/usage` with day/month budgets; the engine client and the "Organisation"
   settings section; the admin portal; Dockerfile.
2. SCIM 2.0, SAML, server-side CEF/SIEM push, a managed-policy key that makes
   enrolment mandatory (`control.required`), policy version history and staged
   roll-out, per-device posture.
3. Model gateway; custom roles; per-project policy.
4. Postgres, high availability, Helm, multi-region.

**Not in phase 1:** SCIM, SAML, custom roles, the model gateway, Postgres,
Helm, mandatory enrolment, push notification of policy changes (engines poll
every few minutes), cross-tenant (MSP) administration, billing, and any
execution on the server.

## Alternatives considered

| Option | Why not |
|---|---|
| Run agents on the server (a hosted AICO) | A different product: sandboxing, per-tenant code execution, data residency. The owner chose local execution; it also keeps source code on the person's machine. |
| Distribute more policy files with MDM only | Already possible (0035); has no identity, no per-team policy, no central usage or audit. Remains the stronger lock and is complementary. |
| Merge all scopes into one policy document on the server | Needs an intersection of glob lists; layers are what the engine already evaluates and cannot be loosened by construction. |
| Express/Fastify, an ORM, `jose`/`openid-client` | Each is a new runtime dependency to track for supply-chain risk (0033). `node:http`, `node:sqlite` and `node:crypto` suffice for phase 1; JWT/OIDC verification is a few hundred lines, tested against a mock IdP and known-bad tokens. Revisit if SAML lands. |
| Long-lived API keys per engine | No expiry, no rotation, no theft detection. The device grant gives short tokens and one-click revocation. |
| Postgres first | A second thing to run for a first deployment; the repository layer is written so it can follow. |

## Consequences

- **Good:** per-role and per-team rules; one audit trail with tamper
  evidence; spend visible and capped across machines; engines keep working
  offline within the grace period.
- **Bad / costs:** a new package to build, test and release; a new network
  surface (the server) and a new outbound one (the engine -> control); a second
  UI to keep consistent. Build-time dependencies of the portal (React, Vite)
  live only in `control/package.json`; the server itself has none at runtime.
- **Honest limits:**
  - The control layer is enforced **by the engine on the person's machine**. A
    user who can edit their own AICO install can sign out (`aico control
    logout`) or patch the engine. It is as strong as the OS lock on the
    engine's files plus the system policy file (0035). Phase 2 adds a
    managed-policy key to refuse to run unless enrolled; until then, deploy the
    system policy file for hard requirements and use Control for per-person
    differences, usage and audit.
  - The audit chain proves the server's copy was not edited **after the fact**
    by anyone without the ability to rewrite the whole chain; anchoring the head
    hash externally (the verify endpoint returns it) closes that. Engines can
    report only what happened while they were running.
  - Usage cost is an estimate (0035), now summed across machines.
  - Offline grace: past `graceHours` without contact the engine applies a deny
    layer (model calls refused) until it reconnects; `0` disables it.
- **Migration:** none. An unenrolled engine behaves exactly as before.

## Threat model

Assets: the policy (integrity), the audit chain (integrity, confidentiality),
tokens (confidentiality), IdP secrets, tenant separation.

| Threat | Mitigation |
|---|---|
| Admin of tenant A reads/changes tenant B | `tenant_id` in every query, first-argument convention, tests with duplicate names/ids across tenants |
| Stolen refresh token | Rotation with reuse detection revokes the family; 15-minute access tokens; revoke per device |
| CSRF against the portal | `SameSite=Lax`, `Origin` check, per-session `X-CSRF-Token` on every mutation |
| Forged or replayed OIDC response | `state` (single-use, 10 min), PKCE S256, `nonce`, signature/`iss`/`aud`/`exp` verification, `alg` pinned to RS256/ES256 (never `none`/HS) |
| An engine posting audit for someone else | Identity taken from the token, not the body |
| Audit tampering at rest | Append-only triggers + hash chain + verify endpoint returning the head hash for external anchoring |
| Brute-forcing a device user code | 8-char code from an unambiguous alphabet, 10 min lifetime, per-IP rate limit, locked after 5 wrong approvals, polling interval enforced (`slow_down`) |
| Open redirect via `next` | Only same-origin relative paths accepted |
| SSRF through the IdP URL | Discovery/JWKS fetched only from the tenant's configured issuer; https required (loopback allowed only with `--allow-insecure-idp`, for tests and local demos); link-local and metadata addresses refused |
| A malicious policy value | Validated with the engine schema on save; the engine validates again on receipt (invalid -> most restrictive value) |
| Server compromise | Holds no provider keys or source code (phase 1); IdP secrets encrypted per tenant; the worst case is a policy that **restricts** — a layer cannot make an engine more permissive than its own settings |

## Verification

- `npm run test:control` — `control/test/*.test.mjs`: tenancy isolation,
  RBAC, device flow (pending, slow_down, denied, expired, approve), token
  rotation, reuse detection and revocation, policy validation and layering,
  audit hash chain verify and tamper detection, budgets, OIDC against a mock
  IdP (including bad nonce, bad signature, wrong audience, `alg: none`), CSRF.
- `scripts/control-client-test.mjs` (in `npm test`) — the engine against a mock
  control server: login, layer applied and restrict-only, offline grace, audit
  and usage batching with retry, logout.
- Live: seeded tenant, mock IdP, an isolated engine enrolled, a policy changed
  in the portal and observed in the engine's settings.
- The check that would fail if reversed: the restrict-only test feeds a control
  layer with every key at its loosest into `managedPolicy()` beside a system
  policy and asserts no decision gets more permissive.
