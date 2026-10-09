# 0007 — Operate remote machines through trusted consumer tools, with ssh2 and net-snmp

- **Status:** Accepted (2026-09-30)
- **Date:** 2026-09-30
- **Deciders:** owner (requested SSH/HTTP/WinRM/SNMP ops tools and approved the dependencies in the brief)
- **Supersedes / related:** [ADR 0006](0006-credential-broker.md) (the broker these consume);
  authoritative detail in [docs/security/ops-tools.md](../../security/ops-tools.md)

## Context

The owner's scenario: "set up X on my server" — connect with a stored credential,
create the service's admin account with a generated password nobody sees,
configure, verify, and later reuse the same credentials for SSH/API/WinRM/SNMP work.
Until now the only way was `Bash` with `{{secret:…}}` placeholders, which needs
`allowShell` on the credential and a person to approve every command (the shell's
target is whatever the command says), so unattended operation was impossible and
every SSH password had to go through `sshpass`-style tricks.

## Decision

1. **Six trusted consumer tools** in `src/tools/ops/` — `SshExec`, `SshCopy`,
   `SshTunnel`, `HttpRequest`, `WinRmExec`, `SnmpQuery` — each resolving a credential
   by name through `vault.resolve()` for the exact host/origin it then contacts,
   classified `consumer` in `VAULT_TOOL_CLASSES`, and returning no value. Enforced by
   `scripts/ops-test.mjs` (source scan: only `tools/credentials.ts` and `tools/ops/**`
   import the vault; results checked with the redactor off; a real agent turn's sinks
   scanned for canaries).
2. **One approval primitive.** `UseContext.requireApproval` (tightening only) makes
   any use every-use; destructive commands, unknown SSH host keys, SNMP sets, HTTP
   DELETE, sensitive-file replacement and tunnel pivots use it. Approval therefore
   always needs a human channel the API token cannot fake (ADR 0006 §grants).
3. **SSH via `ssh2`** (pure JS, MIT), not the system client.
4. **WinRM via Windows' own PowerShell remoting** (`Invoke-Command`), Windows engines
   only; no JS WinRM library.
5. **SNMP via `net-snmp`** (pure JS, MIT).
6. **`SshTunnel` is a new network listener**, bound to 127.0.0.1 only, registered in
   the work ledger, closed by TTL (max 12 h), `Supervise stop` or connection loss.
   This is the owner-requested port forward for reaching a server's localhost web
   UI; it is not the MCP "phase 5" remote access that devops.md still reserves.
7. **No `DbQuery` and no runbook tool yet.** Database clients run on the server via
   `SshExec`; the `server-ops` skill keeps a workspace runbook.

## Alternatives considered

| Option | Why not |
|---|---|
| System `ssh` + `SSH_ASKPASS` helper | the password would sit in a helper process's stdout/pipe we then trust; `SSH_ASKPASS_REQUIRE` only on OpenSSH ≥ 8.4; host-key policy would be flags on a binary we do not control |
| System `ssh` + 0600 temp key file | Windows OpenSSH rejects key files whose ACL it dislikes and Node cannot set ACLs; a key on disk, however briefly, is a key on disk; passwords still unsolved |
| `sshpass` | puts the password in argv or env of a child; not on Windows |
| `node-ssh` | a wrapper over `ssh2` adding promises; one more dependency for nothing we need |
| JS WinRM (`nodejs-winrm`, `winrm-client`) | unmaintained since 2022 / 0.0.x and Basic-only; Basic over HTTP sends the password in clear; NTLM/Kerberos message encryption is a security stack we should not re-implement |
| `snmp-native`, shelling out to net-snmp tools | unmaintained / the tools take the community in argv and are not on Windows |
| Plain `fetch` for HttpRequest | cannot pin the resolved address (DNS rebinding), follows redirects with headers unless handled manually, no per-hop TLS decision |

## Consequences

- **Good:** unattended ops within a credential's scope; secrets never in argv, disk,
  logs, results or the model context; every operation visible to `Supervise`.
- **Bad / costs:** +8 packages (`ssh2`, `asn1`, `bcrypt-pbkdf`, `tweetnacl`,
  `safer-buffer`, `net-snmp`, `asn1-ber`, `smart-buffer`; optional native
  `cpu-features`/`nan` absent unless built). `ssh2` runs an install script that tries
  to build an optional native crypto binding and silently continues when it cannot
  (adds a few seconds to installs with build tools present). Licences: MIT, BSD-3
  (`bcrypt-pbkdf`), Unlicense (`tweetnacl`) — all compatible with distribution under
  PolyForm Noncommercial (the licence at the time; FSL-1.1-ALv2 since 0.48.0).
- **Desktop bundle:** the engine is one esbuild ESM file; ssh2's CommonJS reads a free
  `__dirname` at load and its ChaCha20 module reads it lazily. `ssh.ts` supplies a
  global only for the import and offers only AES-GCM/AES-CTR ciphers. Verified by
  bundling with the desktop's esbuild settings and running an SSH command through it.
- **Honest limits:** destructive detection is pattern-based; remote processes may
  outlive a stopped channel; WinRM is Windows-only; see ops-tools.md §7.
- **Migration:** none — new tools; `npm install` picks up the dependencies.

## Threat model

- **Untrusted:** the model and everything it reads (it may try to aim a credential
  at another host, exfiltrate through a redirect, hide a destructive tail in a long
  command, get a password written to a command's stdin, or reach cloud metadata).
- **Controls:** broker scope per host/origin (a trusted tool declares its real
  target); pinned host keys with human-approved TOFU; forced every-use approvals
  with full text or refusal; values only over encrypted channel stdin, SFTP writes
  or request bodies/headers for the bound origin; sudo password written only on the
  randomised prompt; SSRF policy on resolved, pinned addresses; manual redirects;
  unknown-secret masking and `capture`; per-target rate limits; deadlines and
  cancellation; ledger records.
- **Residual:** an approved command can still do harm (the person must read it);
  pattern evasion of the destructive classifier; Bash/curl are outside the SSRF
  policy (separate, pattern-based guards).

## Verification

`scripts/ops-test.mjs` (in `npm test`, 178 checks): classifier, known_hosts, command
planning (executed by a real `sh`), SSRF, HTTP auth/redirect/masking, WinRM driver
(real PowerShell stdin round trip on Windows), registry/source invariants, then real
servers — SSH (host-key TOFU decline/approve, mismatch refusal with zero auth
attempts reaching the impostor, placeholders, sudo incl. NOPASSWD and wrong password,
destructive approvals, capture, masking, keys, timeout, cancel, background, SFTP,
tunnel), HTTP(S) (auth modes, capture, redirects, DELETE approval, metadata and LAN
refusals, self-signed only by credential policy) and SNMP v2c/v3 (get/walk/set with
approval) — and a mock-model agent turn whose session log, model requests, stream,
ledger file, audit log, run logs and known_hosts contain no canary in any encoding.
Live with a real model: `scripts/ops-live.mjs` (paid; run on request).
