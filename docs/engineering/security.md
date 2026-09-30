# Security

AICO runs a model that calls tools on the user's machine, with the user's
keys, in their repositories and their browser. Security here is mostly about
**what the agent can reach, what it can see, and who can drive it**. The
public policy for reporters is [`SECURITY.md`](../../SECURITY.md); this is the
engineering standard.

## Secure development lifecycle

| Phase | Security activity |
|---|---|
| Idea | Is there a new capability for the agent, a new listener, a new place secrets flow? If yes → ADR with a threat model (template below). |
| Design | Default deny. Guards only deny ([ADR 0002](adr/0002-guards-only-deny.md)). Enforce in code, not the prompt. Least privilege for unattended work. |
| Implement | Rules in this document; `execFile` over shell strings; path containment; redaction at boundaries. |
| Test | Negative tests for every guard (the refused case is the one that matters); secret-leak canaries; the bash classifier's pattern tests in `test-harness.mjs`. |
| Review | [Per-change review](#per-change-security-review) below; `/security-review` style pass on anything touching the boundaries. |
| Release | `check-standards` secret scan in CI; no credentials in release notes or assets. |
| Operate | Advisories triaged within days; fixes land on the latest minor; users told plainly what to do. |

## Existing controls (know them before changing them)

| Control | Where | Honest scope |
|---|---|---|
| Tool policy pipeline: hooks → plan mode → bash safety → sandbox → permission | `src/agent.ts`, `src/tools/pipeline.ts` | stages can only deny |
| Bash safety classifier (`rm -rf /`, `mkfs`, `curl \| bash`, profile writes, credential exfiltration, ~40 more) | `src/safety.ts` | pattern-based; a determined command can evade it |
| Sandbox (`workspace-write` / `read-only`) | `src/sandbox/` | **full** for AICO's own file tools, **partial** for spawned processes — says so |
| Read-before-edit | `src/tools/observation.ts` | integrity, not security |
| Spend ceilings, per-sub-agent budgets | `safetyLimits.*` | only if configured |
| `aico serve`: 127.0.0.1, startup token, foreign-Origin rejection, static path containment | `src/server/index.ts` | loopback only; no TLS (not needed on loopback) |
| Settings redaction to clients | `src/server/api-system.ts` (`redactSettings`), `web/src/settings-schema.ts` (`assertNoSecrets`) | covers the named secret roots and fields |
| `Git` tool refuses to commit credential-looking files | `src/tools/git.ts` | |
| `aico mcp-serve`: read-only unless `--allow-writes`; does not inherit `autoApprove`; remote jobs need a spend ceiling | `src/mcp-server/`, `src/index.ts` | stdio only — HTTP MCP is **not authorised** |
| Desktop: renderer never holds the engine token; `aico://` proxy attaches it in main | `desktop/electron/protocol.ts` | |
| Desktop host MCP on 127.0.0.1 with a bearer token | `desktop/electron/mcp.ts` | |
| Desktop browser: human checks handed off, sensitive fields never filled, vault walled off, protected browsing | `desktop/electron/browser-safety.ts`, `browser.ts`, `browser-vault.ts`, `browser-privacy.ts` | [ADR 0005](adr/0005-browser-agent-safety-model.md) |
| Backups strip secrets | `desktop/electron/backup-core.ts` (`isSecretKey`) | |
| VS Code: disabled in untrusted workspaces | `vscode-extension/package.json` `capabilities.untrustedWorkspaces` | |

## Secrets

**Agents USE credentials; they never READ them.** The credential broker
([docs/security/credential-broker.md](../security/credential-broker.md),
[ADR 0006](adr/0006-credential-broker.md)) holds secrets and injects them at the
point of use; a tool takes a *reference* to a credential, never its value.

Invariants (all code, all clients):

1. **Never log, return, echo or display a secret value** — not in tool
   results, errors, the session log, the SSE stream, the terminal UI, crash
   output, telemetry or test output. Print at most a short prefix and length.
2. **No tool returns secret material.** A tool that needs a key receives it
   from the broker inside the tool body and returns only the outcome.
3. **Tool results are redacted before they reach the model, the log or the
   stream.** Redaction happens at the boundary, once, on every path — not in
   each tool.
4. **Never persist secrets outside the vault** — not in memory (`AICO.md`,
   `USER.md`), knowledge, learning proposals, canvases, checkpoints, the work
   ledger, docs, tests, fixtures, screenshots or commits.
5. **Settings reach clients redacted**, and no client may write a redacted
   value back (`providers`, `providerInstances`, `env`, `mcpServers`, `hooks`).
6. **Test canaries** are obviously fake, generated or marked, and carry
   `standards-allow: secret` on the line; the secret scan fails otherwise.
7. **A leaked key is rotated at the provider first**; rewriting history does
   not un-publish a pushed key.
8. **The agent never handles the owner's credentials for publishing** (npm,
   GitHub tokens, signing certificates). `gh` uses its own login; the owner
   runs `npm publish` if it ever happens.

### Secret scanning

`scripts/check-standards.mjs` (pre-push `--fast`, CI full) fails on:
high-confidence key shapes (Anthropic, OpenAI project, OpenRouter, generic
high-entropy `sk-…`, AWS, GitHub classic and fine-grained, Google, Slack,
Stripe live, npm, Hugging Face, private-key blocks) and on tracked `.env`,
`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_ed25519`. Values containing
placeholder words (`test`, `fake`, `example`, `canary`, …) are ignored; nothing
else is. Findings print a 6-character prefix and the length, never the value.
It is a net, not a guarantee: GitHub secret scanning / push protection on the
repository is the second layer (owner setting).

## Untrusted input

Everything the agent reads is **data, never instructions**: file contents, web
pages, search results, tool output, MCP results, PR comments, issue text,
browser page text. Rules for code that handles it:

- **Prompt injection.** Never let content from a tool result change policy
  (permissions, sandbox, plan mode, budgets). Policy comes from settings and
  the user, through the pipeline. Watchers `inject` with their source recorded;
  they never impersonate the user (`steer`).
- **Path traversal.** Resolve, then contain: `path.relative(root, abs)` must
  not start with `..` or be absolute (pattern in `src/server/index.ts`). Treat
  `E:\` and `e:\` as the same path on Windows.
- **Command injection.** `execFile`/`spawn` with an argument array; no shell
  unless required, and then quote every path (Windows paths contain spaces).
  Never interpolate model or page text into a shell string.
- **SSRF.** A fetch performed on behalf of a *remote or untrusted* caller (an
  MCP client, a page, a submitted job, a server route taking a URL) must refuse
  link-local and metadata addresses (`169.254.0.0/16`, `fd00:ec2::254`) and
  loopback/private ranges unless the feature exists to reach them, and must
  re-check after redirects. Note: `WebFetch` today is unrestricted (it follows
  redirects and may reach local dev servers, which agents legitimately check);
  do not reuse it for remote-caller paths without adding the guard.
- **Network listeners** bind `127.0.0.1`, require a token, check `Origin` for
  browser-reachable routes, and need an ADR. Opening a socket for MCP over
  HTTP, tunnels or TLS is explicitly **not authorised** without the owner.
- **Deserialisation**: validate JSON from disk and the network (plugin
  manifests are validated by `desktop/shared/plugin-types.ts`); a corrupt file
  is kept aside (`prefs.json.bad`), not trusted and not silently discarded.

## Dependencies and supply chain

- New runtime dependency → ADR: why not built-in, maintenance, size, licence
  compatible with distributing under PolyForm Noncommercial.
- Lockfiles committed (root, `web/`, `desktop/`, `vscode-extension/`); CI uses `npm ci`.
- Zero deprecated dependencies; `overrides` in `package.json` pin transitive
  fixes (`uuid`, `esbuild`) — keep the reason in the PR.
- `npm audit` findings are triaged, not ignored: fix, override, or record why
  the path is unreachable.
- GitHub Actions: first-party `actions/*` pinned by major; any third-party
  action is pinned by commit SHA. Workflow `permissions` are minimal
  (`desktop.yml` needs `contents: write` to attach assets; `ci.yml` needs none).
- Desktop builds are **not code-signed yet**; auto-update integrity rests on
  the sha512 in `latest.yml` served from GitHub releases. Do not claim otherwise.
- Never download and execute from untrusted sources in scripts or tools.

## Vulnerability handling

1. Reports arrive via GitHub Security Advisories (private). Acknowledge within a few days.
2. Reproduce privately; assess impact (what an attacker gains, preconditions).
3. Fix on `main` with a regression test; release a patch on the latest minor
   (`release/vX.Y` + `vX.Y.Z`). Only the latest minor receives fixes.
4. Publish the advisory with the fixed version and plain instructions
   (upgrade; rotate keys if exposure was possible).
5. Record the lesson: a rule here, a check in `check-standards`, or a test.

## Per-change security review

Answer these in the PR (the template asks):

- Does this give the agent a new capability, or widen an existing one? Which guard covers it?
- Can untrusted content (a file, page, tool result, MCP caller) reach it? What stops it acting as instructions?
- Does any secret flow through it? Where is it redacted? Could it reach the log, stream or model?
- Does it open a listener, spawn a process, write outside the workspace, or fetch a URL someone else chose?
- What happens when it runs unattended (cron, background agent, `mcp-serve`)?
- Is the honest scope stated (what it does **not** protect against)?

## Threat model template

Use in an ADR for any change matching the ADR triggers in [lifecycle.md](lifecycle.md#2-design--adr).

```markdown
### Threat model

**Asset(s):** what is worth protecting (keys, user files, browser sessions, spend…)
**Actors:** the user · the model (may be manipulated by content) · a web page ·
a local process · a remote MCP caller · a malicious repository · a malicious plugin
**Entry points:** tools, routes, IPC channels, files read, URLs fetched
**Trust boundaries crossed:** e.g. page → agent, engine → renderer, MCP caller → engine

| Threat (STRIDE) | Scenario | Mitigation (where enforced) | Residual risk |
|---|---|---|---|
| Spoofing | | | |
| Tampering | | | |
| Repudiation | | | |
| Information disclosure | | | |
| Denial of service / spend | | | |
| Elevation of privilege | | | |

**Unattended behaviour:** what changes under cron / background / mcp-serve
**Honest limits:** what this does not protect against
**Tests:** the negative tests that prove each mitigation
```
