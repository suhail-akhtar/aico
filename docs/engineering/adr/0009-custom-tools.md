# 0009 — Custom tools: a typed JSON wrapper around one argv or one HTTP call

- **Status:** Accepted (2026-10-02)
- **Deciders:** owner (design [agents-skills-tools.md](../design/agents-skills-tools.md) §5.2, Phase 2; owner decisions §12a)
- **Supersedes / related:** [ADR 0002](0002-guards-only-deny.md) (guards only deny), [ADR 0006](0006-credential-broker.md)
  and its amendment [ADR 0010](0010-secret-file-sink.md), [ADR 0007](0007-ops-tools-and-dependencies.md) (the HTTP client reused)

## Context

People want to give the agent a typed, reviewable operation — "wrap `helm
diff` for this cluster, with this kubeconfig" — without writing an MCP
server. The only alternative the agent had was Bash with a command string,
which is where argument injection, secrets in command lines and "the model
decided this was harmless" come from. Every vendor's answer to the need is a
function tool with a JSON Schema; this adds an agent capability, so it needs a
record.

## Decision

A custom tool is a JSON file — `~/.aico/tools/<pack>/<name>.tool.json`
(user) or `<project>/.aico/tools/<pack>/<name>.tool.json` (project) — with a
name, description, a flat `input_schema` (`additionalProperties: false`
required), exactly one runner, and an author-declared **effect class**
(`read | write | exec | external | destructive`).

- **Runners.** `run.argv` is spawned with no shell; each `{field}` is one
  whole argv element, never concatenated. On Windows a real `.exe` is spawned
  directly; a `.cmd`/`.bat` shim must go through `cmd.exe`, so any argument
  carrying cmd syntax (`" % ! ^ & | < > ( )`) is refused before spawn and the
  rest are quoted. `http` goes through the ops `HttpRequest` client (SSRF
  guard, origin-bound credentials, masked responses). Enforced in
  `src/custom-tools/runner.ts`.
- **Arguments** are validated before any prompt or spawn (`format.ts`
  `validateArgs`, the `custom-tool:args` guard): schema types, `pattern`,
  `enum`, bounds; a value starting with `-` is refused unless the field sets
  `allowFlagLike`; a field with neither `pattern` nor `enum` may not carry
  shell metacharacters, control characters or a `..` segment.
- **Approvals** come from the effect class and the session's level
  (`policy.ts` `approvalDecision`, the `custom-tool:approval` guard):
  read runs; write/exec follow the session; external is asked on first use at
  `auto` (every use once the session has read web or MCP content); destructive
  is asked **every** call at every level, with the `preview` tool's output on
  the card, no "always allow", and refused outright when nobody can be asked.
  `approval` in the file can tighten anything and relax only external.
- **Secrets** are references resolved by trusted code under `tool:<name>`:
  `{{secret:name}}` as an env value or HTTP header value,
  `{{secret-file:name}}` as an env value (ADR 0010). Never in argv or URLs.
- **Who turns one on.** A user tool is a draft until a person enables it;
  the enable record is bound to the file's sha256, so any edit un-enables it.
  A project's tools are part of the project-trust hash (`workspace-trust.ts`).
  `ToolManage` (the model's tool, in the deferred `registry` group) can write
  drafts but never enable; the HTTP route needs the decision gate's person.
- **Budget.** Each pack is a deferred group `tools:<pack>`: one line in
  `LoadTools` until loaded; schemas only after.
- **Scope.** Agent allow-lists name them as `custom:<name>`; the effective-set
  resolver and `disabledTools` apply as to built-ins.

## Alternatives considered

| Option | Why not |
|---|---|
| Ask authors to write an MCP server | The right answer for anything with state; far too much for "one command, typed". The UI points there for more. |
| A shell-string template (`"helm diff {release}"`) | Re-creates the injection problem quoting cannot solve on Windows. |
| Typed tools inside skill folders | Owner decision §12a: no — a larger trust surface for a convenience. |
| Let `test` execute any tool | A test button that deploys is a deploy without an approval. Only read tools execute from `test`, and only for a person. |

## Consequences

- **Good:** typed, reviewable operations with approval matched to impact; the
  model fills values and nothing else; secrets never in its context.
- **Bad / costs:** one more directory a person must review; `.cmd`-shim tools
  refuse some legitimate values on Windows (point the tool at the `.exe`).
- **Honest limits:** the effect class is the author's claim — a tool marked
  `read` that deletes runs without asking. The enable record is a file in the
  user's store, so a process running as the user could rewrite it (as for
  skills). The HTTP runner resolves header secrets under `HttpRequest`'s
  scope, not `tool:<name>`. No approve-later inbox yet (Phase 7): unattended
  runs refuse anything that needs a person.
- **Migration:** none; nothing existed.

## Threat model

| Threat | Mitigation |
|---|---|
| Model injects a second command via a value | no shell on POSIX; whole-element substitution; free-text metacharacter refusal; cmd-syntax refusal for Windows shims |
| Model injects an option (`--kubeconfig=/evil`) | leading `-` refused unless the author allows it |
| Model enables or edits its own tool | enable needs a proven person; enable is hash-bound, so edits un-enable |
| Cloned repo ships a tool | project tools are in the project-trust hash; nothing loads until a person approves the exact files |
| Secret leaks via output | broker resolution in trusted code; pipeline redaction of every result; temp files deleted (ADR 0010) |
| Destructive call without a person | asked every use, preview shown, no always-allow; refused when nobody is there |

## Verification

`scripts/phase2-custom-tools-test.mjs` (part of `npm test`): definition and
argument validation, hostile values as single argv items through `node.exe`
and a `.cmd` shim in a path with spaces (and refused for cmd syntax),
approval routing per effect and level, plan mode, taint, the secret canary
through log/stream/result, temp-file cleanup on success/failure/timeout/spawn
error/half-way failure/cancel, project trust, `custom:` scopes, drafts, and the
depth-0 budget with three packs. Reversing any rule above fails an assertion.
