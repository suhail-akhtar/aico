# 0006 — Credential broker: agents use credentials, never read them

- **Status:** Accepted (2026-09-30)
- **Deciders:** owner
- **Authoritative detail:** [docs/security/credential-broker.md](../../security/credential-broker.md)
  (routes, sink table, "how to write a secret-consuming tool"). This ADR records
  the decision and its invariants; where they differ, the broker document and
  the code in `src/vault/` win.
- **Related:** [security.md § secrets](../security.md#secrets); [ADR 0005](0005-browser-agent-safety-model.md)
- **Amended by:** [ADR 0010](0010-secret-file-sink.md) (temp-file secret sink for custom tools)

## Context

The owner wants the agent to operate real systems — SSH, HTTP APIs, WinRM,
SNMP, services it stands up itself — which needs credentials. A model that
holds a secret can leak it: in a tool call's arguments (logged, streamed,
shown to hooks), in its reply, in memory or knowledge it writes, or because a
page or file it read told it to. Provider keys already live in
`settings.json` and reach clients redacted, but nothing covered secrets the
agent itself must use.

## Decision

A credential vault and broker in the engine (`src/vault/`):

- **The model refers, trusted code substitutes.** The model writes
  `{{secret:name}}` / `{{secret:name.field}}`; a trusted consumer calls
  `resolve()` with its own tool name, the target it will send the value to and
  the purpose, and gets the value only if the credential's **policy** allows
  exactly that use (scope bound to a host/origin), after a **human approval**
  when the policy asks for one. The value is used, released, and never returned.
  There is deliberately no export that returns a value without a policy check
  or a human grant.
- **Shell use** gets the value only through a per-call environment variable
  handed to that one child process — never written into the call's arguments.
  Shell use requires approval on every use unless the owner chose otherwise.
- **Redaction is the net under everything.** Every sink (session log, tool
  pipeline, spill writer, SSE hub, UI callbacks) passes text through one
  redactor that replaces known values — raw and in common encodings (base64,
  URL, JSON, hex, shell-quoted) — with `[secret:<name>]`. Secrets typed into a
  user message are vaulted and replaced before the log or model sees them.
- **Human grants cannot be minted by the model.** The model may be able to
  reach the loopback API and learn its token, so revealing a value, widening a
  policy, or deleting a user-stored secret needs a one-time grant delivered by
  the desktop host channel, a typed passphrase, or an interactive terminal.
  Declining never needs proof.
- **At rest:** AES-256-GCM per record with id/version bound as AAD, an HMAC
  over the record list, atomic locked writes; the master key sealed by the
  desktop (`safeStorage`, injected over the private channel, never via
  environment), the OS keyring, or a passphrase. No plaintext fallback.
- **Guards:** deny-only pipeline guards keep file tools out of the vault
  directory (complete) and refuse obvious shell attempts on the vault, OS key
  stores or process environments (best effort, stated as such).
- **Audit:** append-only JSONL of who used which credential, for what, allowed
  or not — built from fixed fields, free text redacted.
- **Generated credentials** (passwords, ed25519 keys) are created in the vault;
  only the non-secret half (username, public key, fingerprint) is returned.

## Invariants (binding on all code)

1. Never log, return, echo or display a secret value.
2. No tool returns secret material; tools take references.
3. Tool results and every streamed/logged text are redacted before reaching the model, log or stream.
4. Never put secrets in memory, knowledge, docs, tests, fixtures or commits.

## Alternatives considered

| Option | Why not |
|---|---|
| Give the model the value when needed | it can leak it in any output, and injected content can ask it to |
| Environment variables for all secrets | every child process (the agent's Bash) inherits the environment |
| Redaction only | catches accidents, not a model that holds the value and transforms it |

## Consequences

- **Good:** the agent can operate systems without the model ever holding a
  secret; every use is scoped, approvable and audited.
- **Costs:** secret-consuming tools must be written against `resolve()`; some
  uses stop for a human.
- **Honest limits (from the implementation):** redaction cannot catch arbitrary
  transformations (reversed, split, encrypted) of a value a process already
  has; short secrets (< 4 chars) are not indexed; a same-user process can ask
  the OS key store for the same key AICO can, and can replace the vault file
  with an older genuine copy; the audit log is a record, not tamper-proof evidence.

## Verification

The vault's own test suite (being added with the implementation), secret-leak
canaries through each sink, and `check-standards` refusing committed keys.
Reversing any invariant should fail a test, not just a review.
