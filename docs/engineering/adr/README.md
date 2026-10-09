# Architecture Decision Records

An ADR records a decision that is expensive to reverse: what was decided, in
what context, what else was considered, and what it costs. They exist so a
future author — human or AI — does not re-derive, or quietly undo, a decision
whose reasons they never saw.

## When to write one

Before implementing a change that: adds a runtime dependency, listener,
process or agent capability; changes a persisted format or a wire contract
(session events, HTTP/SSE, MCP tools, desktop IPC, settings schema); changes a
security boundary; or reverses a recorded decision. Details:
[lifecycle.md § design](../lifecycle.md#2-design--adr). Smaller decisions live
in the module header of the code they govern.

## How

1. Copy [0000-template.md](0000-template.md) to `NNNN-short-title.md` (next number).
2. Status `Proposed`; fill every section; include a threat model if it touches a boundary.
3. The owner accepts (status `Accepted`, date) or rejects (`Rejected`, kept for the record).
4. ADRs are not edited after acceptance except for status and links; a
   changed decision is a new ADR that `Supersedes` the old one.
5. Cite the code that enforces the decision, so a reader can verify it still holds.

## Index

| # | Decision | Status |
|---|---|---|
| [0001](0001-append-only-session-log.md) | A session is an append-only event log; the transcript is derived | Accepted |
| [0002](0002-guards-only-deny.md) | Tool-policy guards may only deny, never grant | Accepted |
| [0003](0003-desktop-is-a-client.md) | The desktop app is a client of the engine, not a fork | Accepted |
| [0004](0004-licence-polyform-noncommercial.md) | Licence: PolyForm Noncommercial 1.0.0 from 0.28.0 | Superseded by 0036 |
| [0005](0005-browser-agent-safety-model.md) | Browser agent safety: hand off human checks, never see or fill secrets, approvals | Accepted |
| [0006](0006-credential-broker.md) | Credential broker: agents use credentials, never read them | Accepted |
| [0007](0007-ops-tools-and-dependencies.md) | Operate remote machines through trusted consumer tools (SSH via ssh2, HTTP, WinRM via PowerShell, SNMP via net-snmp) | Accepted |
| [0008](0008-canvas-docs-export.md) | Export canvases with the renderer's own Markdown parser and a hand-written OOXML writer | Accepted |
| [0009](0009-custom-tools.md) | Custom tools: a typed JSON wrapper around one argv or one HTTP call, approvals by effect class | Accepted |
| [0010](0010-secret-file-sink.md) | Amend 0006: a temp-file secret sink for custom tools, deleted after one call | Accepted |
| [0011](0011-approve-later-inbox.md) | The approve-later inbox: unattended (L4) runs park calls that need a person; approval replays the exact call once | Accepted |
| [0012](0012-agent-certification.md) | Agent certification: a hash-bound certificate gates unattended (L4) runs | Accepted |
| [0013](0013-refactor-tools-ast-grep.md) | Wide refactors as one planned, checked step: ast-grep (optional dependency) and the TypeScript language service | Accepted |
| [0014](0014-long-jobs.md) | Long jobs: work estimated over a few hours runs only after a person approves its proposal; milestones gated by checks and acceptance | Accepted |
| [0015](0015-sentinel-reviewer.md) | The Sentinel: an independent model reviews high-risk calls and can only deny or escalate to a person | Accepted |
| [0016](0016-learning-preferences.md) | Learn how the user works as reviewed, scoped rules injected in the request tail | Accepted |
| [0019](0019-terminal-integration.md) | Terminals: OSC 133 shell integration, read-only agent access to user tabs, vault SSH shells from main | Accepted |
| [0020](0020-scripted-html-previews.md) | Run HTML previews from their own origin (`aico://preview`), sandboxed, with no network | Accepted |
| [0021](0021-background-agents-that-report-back.md) | Background agents report back, inherit their parent's bounds, resume (also after a restart), isolate in worktrees without discarding work, and share a per-session concurrency cap | Accepted |
| [0022](0022-document-design-system.md) | Lay documents out by family: blueprints (cover, front matter, faces, numbering, running text, captions, expected visuals) drive the writing brief, the .docx and the PDF | Accepted |
| [0023](0023-presentations.md) | Presentations: slides as layouts plus fields, one layout engine that fits text for the app, PDF and a hand-written .pptx (native text, tables, charts, notes) | Accepted |
| [0024](0024-inline-scoped-edits.md) | Ask AICO edits one part of a document: a typed patch for that part, validated in code (scope, shape, figures, references), reviewed as a diff, accepted as one version | Accepted |
| [0025](0025-deck-visual-system.md) | Deck visuals: a parametric infographic library as native PowerPoint shapes, licensed picture search behind the SSRF guard, a vendored icon set, design briefs with brand palettes, and presentation rules enforced by the validator | Accepted |
| [0026](0026-shift-left-security.md) | Shift-left security: a fast static scan with a reviewed baseline (pre-commit + CI), CodeQL, lockfile/licence/audit gates with SBOMs on releases, a DAST suite against the real engine, and a `security` check in the agent's own completion gate | Accepted |
| [0027](0027-shell-confinement.md) | Confine shell commands: writes outside the project, executable downloads, global installs, running what was downloaded and lasting system changes need a person at every autonomy level; user-only escape hatches | Accepted |
| [0028](0028-code-graph.md) | A native, accurate code graph (resolved imports, symbol references through re-exports, git co-change) for the agent's deferred `CodeGraph` tool, an in-loop edit check and the Code map view; no parser dependency | Accepted |
| [0029](0029-browser-certificate-exceptions.md) | Browser certificate exceptions: only the person proceeds past a certificate warning, bound to the exact certificate (session or always); localhost opt-in; revoked/HSTS never; no saved passwords on excepted sites | Accepted |
| [0030](0030-open-in-editor.md) | Open a project file in the person's editor from the web client (and "Open in external editor" in the desktop): a person's click only, the program from user settings or VS Code on the PATH, no shell, registered-project files by real path; the client's own viewer otherwise | Accepted |
| [0031](0031-multi-stack-apps.md) | Multi-stack apps: manifest-driven run/probe/env for Python, Java, .NET, Go and PHP, one artifact-directory list, bundles of services (compose or native), Docker fallback, a per-app git release workflow with a human gate on tags | Accepted |
| [0032](0032-brief-fix-all.md) | Fix all in the morning brief: one confirmed background fix per project on its own branch, started only by a person, auto-approve and unattended with the inbox (L4, never full autonomy or `permissions: 'full'`), anything the Sentinel or shell confinement stops waits for the person | Accepted |
| [0033](0033-supply-chain-and-change-safety.md) | Supply-chain and change safety: a deny-only guard checks that packages named in install commands exist on the public registry (and are not brand-new, near-unknown or lookalikes) before they are installed; secrets and a small SAST set in six languages are scanned in the agent's diff (turn-end nudge, commit refusal); weakened tests are named and, unattended, deleting or skipping them needs a person; findings are recorded as `safety/finding` | Accepted |
| [0035](0035-managed-policy-and-audit-export.md) | Managed policy: a machine-wide, restrict-only policy file (MDM/GPO deployable) above user and project settings, enforced at the settings merge, model selection, the tool pipeline and run start; plus a redacted, versioned audit export (JSONL/CEF/CSV) and a usage report for SIEM; SSO/SCIM/RBAC/admin console are not built | Accepted |
| [0034](0034-evidence-ci-agent-flaky-tests.md) | Change evidence report built from the session log (two new record events), a read-only-by-default GitHub Action CI agent (review and gated fix-ci, engine-made branch, token never in the model's process), and one-shot flaky-test re-run that reports FLAKY instead of green and never quarantines | Accepted |
| [0036](0036-licence-fsl.md) | Licence: Functional Source License 1.1 with Apache 2.0 future licence (FSL-1.1-ALv2) from 0.48.0; earlier versions keep MIT / PolyForm Noncommercial | Accepted |

ADRs 0001–0005 record decisions made and shipped before ADRs existed
(backfilled 2026-09-30 from the code, module headers, CHANGELOG and release notes).
