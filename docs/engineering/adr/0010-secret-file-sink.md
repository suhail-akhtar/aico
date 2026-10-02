# 0010 — Amend 0006: a temp-file secret sink for custom tools, deleted after one call

- **Status:** Accepted (2026-10-02)
- **Deciders:** owner (design [agents-skills-tools.md](../design/agents-skills-tools.md) Q5; owner decisions §12a)
- **Amends:** [ADR 0006](0006-credential-broker.md) (its "Shell use" rule and invariant 1 stay; this adds one sink)
- **Related:** [ADR 0009](0009-custom-tools.md)

## Context

ADR 0006 hands a secret to a child process only through a per-call
environment variable. Some programs only take a credential as a *file*:
`kubectl`/`helm` (`KUBECONFIG`), cloud CLIs (`GOOGLE_APPLICATION_CREDENTIALS`),
`ssh -i`. Without a file sink those tools either cannot be wrapped, or the
person keeps a long-lived plaintext kubeconfig on disk — worse than a file
that exists for one call.

## Decision

A custom tool's `run.env` value may be exactly `{{secret-file:name}}` (or
`name.field`). For one call, trusted code (`src/custom-tools/runner.ts`
`bindEnv`):

1. resolves the credential through the broker under `tool:<name>` — policy,
   approval and audit exactly as any use;
2. creates a fresh directory under `<os tmp>/aico-secret-files/call-*` (mode
   0700) and writes the value to a file in it (mode 0600, exclusive create);
3. passes the file's **path** in the named variable — the value is never in
   arguments, the log or the stream;
4. deletes the directory in `finally`: after success, a non-zero exit, a
   timeout, cancellation, a spawn error, and when a later secret of the same
   call fails to resolve (nothing is spawned then);
5. as a last resort, removes any directory still registered at process exit.

Only commands take a secret file; an HTTP tool's secrets are header values.

## Alternatives considered

| Option | Why not |
|---|---|
| No file sink (env only) | Excludes kubeconfigs and service-account keys — the DevOps scenario (design S1) depends on it. |
| Keep the file for the session | Longer exposure for no gain; one call is the unit that was approved. |
| Named pipe / `/dev/fd` | Not portable to Windows; several CLIs stat or re-open the path. |

## Consequences

- **Good:** file-only CLIs can use vaulted credentials without a plaintext copy living on disk.
- **Costs:** the value is on disk for the duration of one call.
- **Honest limits:** while the call runs, any process running as the same user
  can read the file (on Windows, POSIX modes are mostly ignored; the
  per-user `%TEMP%` ACL is what protects it). A crash that kills the process
  without an orderly exit (power loss, `kill -9`) leaves the file until the
  next cleanup of the temp directory. The child itself can copy the value
  anywhere — as with env, a tool is trusted configuration.
- **Migration:** none.

## Verification

`scripts/phase2-custom-tools-test.mjs` "Secrets" block: the canary is absent
from the session log, the stream and the result; the secret-file root is
empty after a successful call, a non-zero exit, a timeout, a spawn error, a
half-way secret failure and a cancelled call.
