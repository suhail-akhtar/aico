# 0019 — Terminals that follow the work: shell integration, read-only agent access, vault SSH

- **Status:** Accepted
- **Date:** 2026-10-03
- **Deciders:** owner (approved items 1, 2, 3, 5, 6, 7 of the terminal brief)
- **Supersedes / related:** [ADR 0003](0003-desktop-is-a-client.md) (desktop is a client),
  [ADR 0006](0006-credential-broker.md) (credential broker), [ADR 0007](0007-ops-tools-and-dependencies.md)
  (ssh2, host keys), [ADR 0015](0015-sentinel-reviewer.md) (taint rule)

## Context

AICO Desktop's terminal was a bare node-pty tab. It did not know which project
it belonged to, so after switching chats people typed into a shell in the
wrong folder; "Open terminal here" on a closed panel was lost (the panel loads
lazily and the request event fired before anything listened). When a command
failed, getting AICO's help meant copying output into the chat by hand — output
that can carry tokens and passwords. The agent's own shell calls were visible
only as chat cards. SSH to a server meant typing a password the vault already
held. Each of these touches a boundary: what the agent may read, what it may
type, and where a secret may go.

## Decision

1. **Shell integration by marks, not by guessing.** Tabs AICO spawns load a
   generated integration script that emits OSC 133 `A/B/C/D` (prompt, input,
   output, exit code) and OSC 633 `E`/`P` (command line, cwd): PowerShell via
   `-NoExit -Command ". '<script>'"` wrapping the existing `prompt` function;
   bash via `--rcfile` (sources `~/.bashrc` first); zsh via a `ZDOTDIR` whose
   `.zshrc` sources the user's own. **The user's profile files are never
   written.** `desktop/shared/terminal-integration.ts` (parser, record
   builder, scripts). Each finished command becomes a record
   `{command, cwd, exitCode, startedAt, durationMs, outputTail}`.
2. **Help is a click, and only a click.** A non-zero exit shows an inline chip
   (*Explain · Fix with AICO*); "Watch with AICO" (per tab, off by default)
   matches error patterns with a 30 s debounce and dedupe and shows a
   suggestion card. **Nothing calls a model until the person clicks**, and a
   click sends an ordinary chat message (command, cwd, exit code, redacted
   tail) through the normal turn — approvals and the Sentinel apply.
3. **The agent reads terminals; it does not type into the person's.**
   - `ide_terminal_list` and `ide_terminal_read` (any tab) return redacted,
     bounded text (ANSI stripped, unknown-secret mask from
     `desktop/shared/terminal-redact.ts`, ≤ 40 000 chars, last 20 commands),
     wrapped as untrusted content. They are host MCP tools, so the existing
     taint rule (`custom-tools/policy.ts taints()`: every `mcp__` tool) marks
     the session tainted for the Sentinel, and the engine's sink redactor then
     removes every value the vault holds. Both are in `HOST_READ_TOOLS`.
   - **Writing is code-enforced** in `desktop/electron/terminal.ts`
     (`agentWrite` → `agentMayWrite` in `terminal-safety.ts`): only into a tab
     the agent started with `ide_terminal_run`, and never while the tab's last
     line is a password/passphrase/sudo/PIN/OTP prompt. A person's tab and an
     SSH tab are refused by owner, whatever the agent asks.
   - Everything the agent runs still goes through its own tools, approvals and
     the Sentinel; the *Agent* tab only mirrors those calls (read-only xterm,
     Stop = cancel the turn).
4. **Save as automation is a draft.** Selected commands (never output) export
   as a script file the person places, a custom tool **draft** (one argv, no
   shell; marked tokens become typed parameters; effect class chosen, default
   `exec`) that still needs a person to enable it (ADR 0009), or a prompt that
   asks the agent to schedule it (the cron tool's own confirmation applies).
   Everything is redacted and previewed before it is saved.
5. **SSH terminals use the vault without the renderer ever holding a value.**
   The renderer sends a credential *name* and host to main. Main reads
   `<AICO_HOME>/ops/known_hosts` with the ops tools' own module
   (`src/tools/ops/known-hosts.ts`, imported for this one purpose so there is
   one host-key implementation); an unknown host is probed without
   authenticating and its fingerprint shown in a **native** dialog that the
   person must accept; a mismatched or revoked key is refused with both
   fingerprints. Main then asks the engine over the private parent port
   (`vault/fill-request`, `tool: 'SshTerminal'`, `host`) — the same channel as
   browser fills — and the broker applies the credential's scope, allowed
   tools and approval mode. The connection (ssh2, AES-GCM/CTR only) accepts
   only the checked key; the key is pinned after it succeeds. The secret lives
   in main for the handshake and is dropped; it is never emitted, logged or
   returned to the renderer. There is no "skip host-key check" option.

## Alternatives considered

| Option | Why not |
|---|---|
| Parse prompts with regexes instead of OSC 133 | Breaks on every custom prompt; exit codes are not printed. |
| Edit the user's `$PROFILE` / `.bashrc` to add integration | Changes files AICO does not own; survives uninstall. |
| Let the agent type into any tab ("run it in my terminal") | The person's tab may be at a sudo prompt or on a production host; one injected instruction would type into it. |
| Run SSH shells in the engine and stream over SSE | Puts an interactive remote shell behind the API token; main already owns windows, dialogs and the private port. |
| Copy known-hosts code into desktop | Two host-key implementations drift; the security-critical one must be single. |
| Auto-explain failures with a model call | Spends money and sends output without a person asking. |

## Consequences

- **Good:** terminals open where the work is; failures are one click from
  help with secrets stripped; the agent can answer "what went wrong in my
  terminal?" without being able to type there; vault SSH without typing a
  password.
- **Bad / costs:** a generated script per shell under `<AICO_HOME>/desktop/shell-integration`;
  main bundles ssh2; desktop main imports one engine module (`known-hosts.ts`,
  pure + file I/O, no engine state) — an exception to "only `desktop/engine`
  imports `src/`", recorded here.
- **Honest limits:** the secret-prompt detector and the error matcher are
  patterns; a prompt with no keyword is not seen (the owner rule still holds:
  the agent cannot type into a person's tab at all). The unknown-secret mask is
  high-confidence, not complete; known vault values are removed by the engine
  only on the agent path and on chat submit (scan), not inside the person's
  own xterm. cmd.exe and unknown shells get no integration (records fall back
  to nothing). Remote shells over SSH get no integration either.
- **Migration:** none. Existing tabs keep working; integration applies to new tabs.

## Threat model

- **Asset:** the person's shells (a sudo prompt, a production host), vault values.
- **Adversary:** injected content (a web page, an MCP result, a log line) steering the agent.
- **Entry points:** host MCP tools; the renderer IPC `term:*`; terminal output read by the agent.
- **Mitigations:** owner-gated writes + secret-prompt refusal (code); reads are
  redacted, bounded, wrapped and taint the session; SSH host-key acceptance is
  a native dialog in main; credentials resolve through the broker under its
  policy and audit log, by name; the renderer never receives a value.
- **Residual risk:** a person who accepts a fingerprint without checking it.

## Verification

`desktop/scripts/test-terminal.mjs` (part of `npm --prefix desktop test`):
OSC 133 parser, record builder, error matcher debounce/dedupe, redaction,
secret-prompt detector, write policy (agent cannot write to user/SSH tabs or
at a prompt), export builders, and an ssh2 shell round trip with host-key
accept/mismatch against `scripts/lib/ssh-test-server.mjs`.
`scripts/terminal-ssh-host-test.mjs` (part of `npm test`): `SshTerminal`
fill requests honour host scope and allowed tools. Reversing the write policy
or the host-key check fails those tests.
