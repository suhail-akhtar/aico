# Security Policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/suhail-akhtar/aico/security/advisories/new)
rather than opening a public issue.

Include the version, the steps to reproduce, and what an attacker gains. You
can expect an initial response within a few days.

## Supported versions

Only the latest minor release line receives security fixes — currently
**`0.29.x`** (branch `release/v0.29`). Fixes ship as a patch release on that
line; upgrade to the newest patch. Earlier lines receive no fixes.

| Version | Supported |
|---|---|
| 0.29.x | yes |
| < 0.29 | no |

## Handling credentials

AICO reads provider keys from the environment or a `.env` file, and never
writes them to disk itself. `.env` is gitignored — copy `.env.example` and fill
it in locally.

If a key does reach a commit, rotate it at the provider first. Rewriting git
history does not un-publish a key that was pushed; assume anything committed to
a public repository is compromised the moment it lands.

## Credentials the agent uses (the vault)

Passwords, SSH keys and tokens the agent needs for *your* systems live in the
credential vault (`aico vault …`, the Credential Manager, or the agent's
`CredentialGenerate` / `CredentialRequest` tools). The agent refers to them by
name — `{{secret:nas-admin}}` — and never sees the value: trusted engine code
substitutes it at the moment of use, only for the host or origin the credential
is bound to, after a person approves when its policy says so, with an audit
entry either way. Every value the vault holds is redacted from tool output, the
session log, exports, spill files, hook input and the live stream. Secrets you
paste into a chat message are caught, moved into the vault and replaced by a
reference before the model reads the message.

Records are sealed with AES-256-GCM; the master key is sealed by the OS
(DPAPI, Keychain, Secret Service), by AICO Desktop, or by a passphrase — never
stored in the clear and never placed in an environment variable. Revealing a
value, or loosening where a credential may be used, needs a one-time human
grant that the API token alone cannot produce.

What it does not protect against, plainly: another process running as you can
ask the OS key store for the same key AICO uses (the agent's shell is refused
the obvious ways to do that, but that is defence in depth, not a boundary);
shell use of a credential is opt-in per credential and shown to you command by
command, because an approved command can send the value anywhere; and
redaction recognises stored values in common encodings, not arbitrary
transformations. Set a grant passphrase (`aico vault grant-passphrase`) or use
AICO Desktop for the strongest setup. Full design, threat model and limits:
[docs/security/credential-broker.md](docs/security/credential-broker.md).

## Execution model, and what it does not protect against

AICO runs a model that calls tools on your machine. Two limits are worth stating
plainly:

- **Sandboxing is partial.** `settings.sandbox.mode` confines file writes, and
  the tool reports enforcement honestly as `full` or `partial`. Subprocess
  execution (the `Bash` tool) is reported as **partial**: a command can reach
  outside the workspace. Treat `workspace-write` as a guard against mistakes,
  not against a determined escape.
- **There is no spend ceiling unless you set one.** Configure
  `settings.safetyLimits.maxCostPerSession` before running unattended. Without
  it, a turn is bounded only by `maxIterations` (default 100 model calls).

Run against untrusted repositories in a container or VM.
