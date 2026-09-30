# Ops tools: operating real machines with credentials the agent never sees

`SshExec`, `SshCopy`, `SshTunnel`, `HttpRequest`, `WinRmExec` and `SnmpQuery` let
the agent install, configure, deploy, verify and operate the owner's servers and
devices. They are the credential broker's **trusted consumers**
([credential-broker.md §10](credential-broker.md#10-how-to-write-a-secret-consuming-tool)):
each takes a credential by **name**, resolves it through the broker for the exact
host or origin it is about to contact, sends the value there, and returns a result
that does not contain it.

Code: `src/tools/ops/` (one module per protocol, shared rules in `common.ts`).
Tests: `scripts/ops-test.mjs` (part of `npm test`), with a real SSH server in
`scripts/lib/ssh-test-server.mjs`. Live check: `scripts/ops-live.mjs` (real model;
costs money — run only when asked). Decision record: [ADR 0007](../engineering/adr/0007-ops-tools-and-dependencies.md).
Method the agent follows: the `server-ops` built-in skill (`src/skills/builtin/server-ops.md`).

---

## 1. The scenario

> "Set up Grafana on my server 10.0.0.5."

1. `SshExec {host: "10.0.0.5", credential: "nas-root", command: "cat /etc/os-release"}` —
   first contact: the host key's fingerprint is shown to the person with the
   command; on yes the key is pinned in `<AICO_HOME>/ops/known_hosts` and the
   credential is sent to 10.0.0.5 only.
2. `CredentialGenerate {name: "grafana-admin", kind: "login", username: "admin", url: "http://10.0.0.5:3000"}` —
   a password nobody sees, bound to that origin.
3. `SshCopy {content: "GF_SECURITY_ADMIN_PASSWORD={{secret:grafana-admin}}\n", remote_path: "/etc/grafana/grafana.env", mode: "0640"}` —
   written in memory straight to the remote file; world-readable modes refused.
4. `SshExec {command: "systemctl restart grafana-server", sudo: true, background: true}` —
   sudo answered from the credential only when sudo asks; progress via `Supervise wait`.
5. `HttpRequest {url: "http://10.0.0.5:3000/api/health"}` then
   `HttpRequest {url: ".../api/serviceaccounts", credential: "grafana-admin", json: {...}, capture: [{name: "grafana-api", from: "json:key"}]}` —
   the API key Grafana returns goes into the vault, never the conversation.
6. Later: the desktop browser signs into `http://10.0.0.5:3000` with `grafana-admin`
   (another consumer, same broker), and SSH/API/WinRM/SNMP work reuses the same
   names.

---

## 2. Contracts

All tools: every call is a **work ledger** record (`kind: process`, title
`<Tool> <target> [cred <name>]: <summary>`, state running → done/failed/cancelled),
so `Supervise list/wait/stop` covers them and a restart marks in-flight ones `lost`.
Foreground calls are marked reported (the tool result told the model); background
runs and tunnels stay unreported until acked. Per-target rate limits (per minute):
SshExec 60, SshCopy 60, SshTunnel 20, HttpRequest 120, WinRmExec 60, SnmpQuery 120.
Results never carry a credential value; output passes the vault redactor (known
values, every encoding) **and** an unknown-secret mask (token formats, keyed
`password=`/`*_TOKEN=`/`"secret":` values, URL passwords, private keys) —
`capture` is the way to keep such a value.

### SshExec
`{host, port?=22, credential, user?, command, sudo?, sudo_credential?, cwd?, timeout?=120 (max 1800; background default 3600, max 86400), background?, capture?: {name, kind?, description?}}`
→ `{host, user, credential, host_key: "known" | "trusted now (SHA256:…)", work_id, exit_code, stdout, stderr, duration_ms, signal?, captured?, approved_as?, notes?}`;
background → `{status: "running in the background", log, work_id, note}`.

- `{{secret:NAME[.field]}}` in `command`: resolved for this host; the command runs as
  `sh -c '<script>'` whose script prints a random ready marker, `read`s one line per
  value into unexported shell variables, then runs the command with the references
  rewritten to `"${AICO_SECRET_n}"`. The exec request (visible in the remote `ps`
  and logs) holds only the variable names. Values spanning lines are refused (use
  `SshCopy content`).
- `sudo`: `sudo -S -p <random marker> -- sh -c …`; the password is written when —
  and only when — the marker appears on stderr, so a NOPASSWD sudo never receives
  it on stdin (the `echo pw | sudo -S tee /etc/x` leak). A second prompt means a
  wrong password: stdin is closed, the command does not run, the result says so.
  With a key login, `sudo_credential` names the password credential.
- Exit 124 on timeout/cancel (with a note); the remote side gets `TERM` and the
  channel is closed.
- Background runs log to `<AICO_HOME>/ops/runs/<work-id>.log` (0600), redacted as a
  stream and masked a line at a time; the ledger record's outcome carries the exit
  code and the last output.

### SshCopy
`{host, port?, credential, user?, direction: "upload"|"download", remote_path, local_path?, content?, mode?, overwrite?}`
→ `{direction, remote_path, local_path?, files, bytes, mode?, host_key, work_id}`.
Files or whole directories over SFTP; `content` writes text straight to a remote
file with `{{secret:…}}` substituted in memory, default mode `0600` when it holds a
secret (`0644` otherwise) and world-readable modes refused for such content; the
mode is applied after the write so an existing file cannot stay world-readable.
Local paths inside the vault directory or AICO's settings files are refused.
Downloads do not overwrite unless `overwrite: true`. Replacing `sshd_config`,
`sudoers`, account files or `authorized_keys` needs approval.

### SshTunnel
`{host, port?, credential, user?, remote_port, remote_host?="127.0.0.1", local_port?=0, ttl_minutes?=60 (max 720)}`
→ `{status: "open", local: "127.0.0.1:<port>", local_url, forwards_to, host_key, work_id, note}`.
Listens on **loopback only**; closes on TTL, `Supervise stop`, or when the SSH
connection drops. Forwarding to anything other than the server's own localhost
(pivoting to another machine) needs approval.

### HttpRequest
`{method?, url, headers?, json? | body?, credential?, auth?: "bearer"|"basic"|"header:<Name>"|"query:<param>"|"none", timeout?=60 (max 300), max_bytes?=1 MB (max 10 MB), follow_redirects?=true, save_to?, capture?: [{name, from: "json:<path>"|"header:<Name>"|"body", kind?}]}`
→ `{status, status_text, url, redirects?, headers, body, credential?, captured?, approved_as?, notes?, work_id}`.

- Default auth: bearer for `api-token`/`generic`, basic (credential's username) otherwise.
- `{{secret:…}}` allowed in headers and the body (JSON values are substituted
  before serialisation, so they are escaped correctly), **not in the URL** —
  servers log URLs; `query:<param>` exists for APIs that insist, and the returned
  `url` never carries the parameter.
- Response: `Set-Cookie` reduced to cookie names; auth-like headers hidden;
  JSON keys like `token`, `refresh_token`, `password`, `apiKey`, `secret` masked;
  bodies capped; binary bodies summarised unless `save_to`.
- `DELETE` needs approval — and therefore a credential (approval is a credential
  use). An unauthenticated DELETE is refused.

### WinRmExec (Windows engines only)
`{host, port?=5985|5986, credential, script, use_ssl?, authentication?: "negotiate"|"kerberos"|"basic"|"credssp", timeout?=120}`
→ `{host, port, transport, user, credential, exit_code, stdout, stderr, duration_ms, approved_as?, notes?, work_id}`.
Runs `powershell.exe -EncodedCommand <driver>`; the driver holds no secret and
reads the password, `{{secret:…}}` values and the script from **stdin**, builds a
`PSCredential` from a `SecureString`, and calls `Invoke-Command`; values reach the
remote script as `-ArgumentList` parameters (`$AICO_SECRET_n`). Basic auth is
refused without HTTPS. Certificate checks are skipped only when the credential
allows self-signed. AICO never edits `TrustedHosts`. On Linux/macOS the tool says
to use `SshExec` against the Windows host's OpenSSH Server.

### SnmpQuery
`{host, port?=161, credential, action: "get"|"walk"|"set", oids?, oid?, set?: [{oid, type, value}], version?, auth_protocol?="sha", priv_protocol?="aes", max_rows?=500 (max 5000), timeout?=5}`
→ `{host, port, version, action, credential, rows: [{oid, type, value, error?}], truncated?, approved_as?, notes?, work_id}`.
v2c community or v3 USM (username + `authKey`/`privKey` fields of an `snmp`
credential). Numeric OIDs only. `set` always needs approval. DES is not offered.

---

## 3. What needs a person, and how that is enforced

There is **one** approval primitive: a credential use with `requireApproval`
(added to the broker's `UseContext`; it only ever tightens a policy to
`every-use`). It is answered through the broker's human channels — AICO Desktop's
native dialog, the grant passphrase in the web client, or the terminal UI's own
permission dialog (carried into the ops tools by the `ops:prompter` pipeline
stage). The API token cannot answer it and neither can the model; a headless run
has nobody to ask, so the use is refused.

| Forces approval | Where |
|---|---|
| First connection to an SSH host (shows key type + SHA256 fingerprint) | `ssh.ts establish()` |
| Destructive remote commands: recursive/forced deletes, `find -delete`, wiping/formatting/partitioning/raw device writes, volume destroys, `DROP`/`TRUNCATE`/unfiltered `DELETE FROM`, datastore flushes, service/container/cluster stop-remove, reboot/shutdown, **firewall changes**, **SSH daemon config/restart**, account deletion/locking, sudoers, `crontab -r`, package removal, recursive chmod/chown of `/` — POSIX and PowerShell forms | `destructive.ts` (used by SshExec, WinRmExec) |
| Replacing `sshd_config`, `sudoers`, `/etc/passwd|shadow|group|pam.d`, `authorized_keys` via SshCopy | `ssh.ts remotePathRisks()` |
| Tunnel to a machine other than the server's localhost | `ssh.ts sshTunnel()` |
| HTTP `DELETE` | `http.ts` |
| SNMP `set` | `snmp.ts` |

The approval text leads with the reason (`DESTRUCTIVE (recursive delete).`,
`FIRST CONNECTION …`) and shows the exact command with `{{secret:NAME}}`
references, never values. The broker displays 500 characters of a purpose, so a
forced approval longer than 480 characters is **refused** ("split it") rather than
shown truncated. There is no model-facing argument that skips any of this.

Credential policy still applies first: scope (host/origin), allowed tools, expiry,
rate limit, plain-http and self-signed rules. An agent-generated credential bound
to a host is `auto` there, so routine (non-destructive) steps against a known host
run unattended — that is the point.

---

## 4. SSH host keys

`<AICO_HOME>/ops/known_hosts`, OpenSSH format (hashed `|1|` entries and
`@revoked` understood), 0600, atomic writes. AICO never reads `~/.ssh`. Unknown
host: a probe connection reads the key without authenticating; the credential is
resolved with approval showing the fingerprint; the real connection accepts only
that key; the line is written after it succeeds. Known host with a different key:
refused as a possible interception, naming both fingerprints, before any
credential is sent — replacing a pin is the owner editing the file. There is no
"accept new key" option, no `StrictHostKeyChecking=no` equivalent.

Ciphers offered: AES-GCM and AES-CTR (Node's crypto). ChaCha20-Poly1305 is not
offered because ssh2 implements it with an Emscripten module that cannot load
inside AICO Desktop's ESM bundle.

---

## 5. SSRF policy (HttpRequest)

Decided on **every address the name resolves to**, then the socket is pinned to the
checked address (TLS still verifies the name), and re-decided on every redirect hop.

| Target | Rule |
|---|---|
| Cloud metadata: `169.254.169.254`, `169.254.170.2`, `169.254.170.23`, `169.254.169.123`, `100.100.100.200`, `168.63.129.16`, `fd00:ec2::254`, `fd00:ec2::23`, names `metadata.google.internal`, `metadata`, `instance-data`, … (IPv4-mapped and NAT64 forms too) | **always refused** |
| Unspecified, multicast/broadcast, reserved (192.0.0.0/24, 198.18/15, 240/4, 2001:db8::/32) | always refused |
| Public | allowed |
| Private, loopback, link-local, CGNAT, unique-local | allowed only if (a) the credential in use admits this origin (the broker checked — possibly with a person's approval for an unscoped credential), or (b) some stored credential's scope names this host (a server the owner registered — e.g. unauthenticated health checks of a box you SSH into), or (c) it is loopback and the port is the near end of an open AICO `SshTunnel`. Otherwise refused, naming the fix. |

A name resolving to one public and one private address is judged by the private one.

**Redirects** are manual (max 5): same origin keeps the auth; cross-origin keeps
it only if the broker admits the new origin too, otherwise the 3xx is returned
unfollowed; a 307/308 whose body holds stored values is never re-sent to another
origin; 301/302/303 continue as GET without a body; non-http(s) targets are not
followed. **TLS**: verification is on; `allowSelfSigned` on the credential (an
owner setting) relaxes it for that credential's origin only, and only while its
auth is being sent there.

Honest scope: the agent also has Bash and `curl`, which do not pass through this
policy. It protects the tool that carries credentials and makes the obvious
injected request fail; the Bash safety classifier and the vault's shell guard are
separate, pattern-based lines.

---

## 6. Dependencies

`ssh2` (MIT; deps `asn1` MIT, `bcrypt-pbkdf` BSD-3 → `tweetnacl` Unlicense; optional
native `cpu-features`/`nan` and ssh2's own crypto binding, all optional — the pure-JS
path is used when they are absent) and `net-snmp` (MIT; deps `asn1-ber`, `smart-buffer`,
MIT). `@types/ssh2` (dev). No deprecated packages; `npm audit` shows nothing new.
Install footprint: +8 packages. ssh2 runs an install script that *tries* to build its
optional native binding and continues silently when it cannot. Why these and not the
system `ssh` client: [ADR 0007](../engineering/adr/0007-ops-tools-and-dependencies.md).

---

## 7. Honest limits

- **Destructive detection is pattern matching** over command text, like the Bash
  classifier: `$(printf rm) -rf /` is not seen. The owner scoping credentials (a
  deploy user, not root) is the stronger control. It also errs the safe way: in the
  live run, `busybox --list | grep -E '…|deluser|…'` was flagged "deleting an account"
  (quotes are stripped so `sh -c "rm -rf /"` cannot hide), costing one approval.
- **Stopping a remote command** sends `TERM` and closes the channel; a server that
  ignores signal requests and a command without a controlling terminal may keep
  running after the channel is gone.
- **sudo with `requiretty`** refuses non-tty use; no pty is allocated (a pty would
  echo stdin). `{{secret:…}}` and sudo need a POSIX `sh` on the host.
- **The unknown-secret mask** is high-confidence, not complete; a bare random
  string with no key name is not caught. The redactor still catches every value
  the vault holds.
- **WinRM** needs AICO on Windows; it is verified here at unit level plus a real
  PowerShell round trip of the stdin path (no WinRM endpoint was available — no
  Windows host was configured for the test). **SNMP** is verified against
  net-snmp's own agent over UDP on loopback, not a hardware device.
- **DbQuery is not built.** Database work goes through `SshExec` on the server
  (`psql`/`mysql` there), with the password passed as `{{secret:…}}` into
  `PGPASSWORD=… psql` style commands or a 0600 option file written with `SshCopy`.
- **No runbook tool.** The `server-ops` skill keeps a runbook in the session
  workspace (step, status, verify, rollback) — resumable with existing tools.
