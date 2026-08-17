# Security Policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/suhail-akhtar/aico/security/advisories/new)
rather than opening a public issue.

Include the version, the steps to reproduce, and what an attacker gains. You
can expect an initial response within a few days.

## Supported versions

`0.3.x` is the only line receiving fixes.

## Handling credentials

AICO reads provider keys from the environment or a `.env` file, and never
writes them to disk itself. `.env` is gitignored — copy `.env.example` and fill
it in locally.

If a key does reach a commit, rotate it at the provider first. Rewriting git
history does not un-publish a key that was pushed; assume anything committed to
a public repository is compromised the moment it lands.

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
