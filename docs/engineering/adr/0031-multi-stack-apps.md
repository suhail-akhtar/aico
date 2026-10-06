# 0031 — Multi-stack apps: manifest-driven run/probe/env, one artifact-directory list, bundles of services, a per-app git release workflow

- **Status:** Accepted (2026-10-06)
- **Date:** 2026-10-06
- **Deciders:** owner (+ authors)
- **Supersedes / related:** [0027](0027-shell-confinement.md) (the same process-launching surface), [0009](0009-custom-tools.md) (argv, not shell strings), [0002](0002-guards-only-deny.md); extends `src/apps/templates.ts` and `src/miniapps/*` (see their headers)

## Context

Apps (`miniapps/<slug>/`) were built for Node: a process app could not start
without `package.json`, `built` meant "has `package.json`", install was
skipped only when `node_modules` existed, `requires` was `{node}`, secrets were
written to `.env.local` as hex, `toolAvailable` ran `<tool> --version` (invalid
for `go`), and eight filters listed Node's artefact directories by hand. The
owner wants starters for Python, Java, .NET, Go and PHP, and bundles
(frontend + API + database) that run together. A custom app in those stacks
could not even be started by AppManage, nor get the right checks, audit or
code-scan coverage.

Two further gaps: an app is one process on one port (`RunningApp` has one
`port`), and git for an app was one silent first commit; per-story commits
were prose in a skill, tags and release notes did not exist.

Constraints: no new runtime dependency; no new network listener; existing
`app.json` files must read unchanged; the nine templates must not change
behaviour; AGENTS.md says process-launching capability is an ask-first area, so
this ADR states exactly what it adds.

## Decision

1. **The manifest says how a stack is run; the engine stays stack-blind.**
   `template.json` gains optional `toolchain`, `manifestFile`, `envFile`,
   `artifactDirs`/`keepDirs`, `docker`, `verify`, and (for bundles) `services`,
   `preview`, `compose`; `run` gains `installedMarker`, `portEnv`, `health`,
   `env`, `format`, `audit`, `win32`. The types are in `src/apps/stack.ts` and
   `validateManifest` enforces them. Checks live in `run.*` (not a second key)
   so the one snapshot an app already carries stays the only source. A manifest
   that fails validation is still dropped by `readTemplate`;
   `scripts/validate-template.mjs` prints the errors, so a typo no longer makes
   a template vanish silently.
2. **Persisted `app.json` extension (additive, back-compatible).** New optional
   fields only: `stack` (`toolchain`, `manifestFile`, `envFile`, `docker`),
   `services[]` (bundle services with their own `run`), `compose`, and
   `kind: "bundle"`. A reader that does not know them ignores them; an old
   `app.json` has none and behaves exactly as before (`runProfileFor` still
   supplies the npm defaults, only for apps with no `stack`). `built` is
   recomputed from `stack.manifestFile` when present, else `package.json`.
3. **Toolchain probes are real and honest** (`src/apps/toolchain.ts`). A probe is
   `{command, args, parse}` with built-in defaults per id (`go version`,
   `java -version` on stderr, `dotnet --version`, `php --version`,
   `composer --version`, `docker --version`, `python`/`python3`/`py -3`). The
   parsed version is compared against the declared range. A missing or too-old
   toolchain makes `create`/`start` refuse with a message that names the
   install and, when Docker answers, the Docker fallback. Probing uses argv
   (`execFile`) with a timeout, never a shell string built from untrusted text.
   Results are cached for the process lifetime.
4. **Docker fallback = the same process surface, in a container.** When the
   native toolchain is missing and Docker is present, a template that declares
   `docker.image` can start *via* `docker run --rm -v <appdir>:/work -w /work -p
   127.0.0.1:<host>:<container> <image> sh -c "<command>"`. The mount is the app
   directory only (computed by the engine, never a manifest value); the port is
   published on `127.0.0.1` only; the environment is the same scrubbed one; it
   is never chosen silently: the refusal offers it and the caller passes
   `docker: true` (AppManage `start`, the Apps screen). It adds no listener
   beyond the app's own port.
5. **Env files per template** (`src/apps/env-file.ts`). `envFile.file` decides
   `.env` vs `.env.local`; `envFile.generate` maps keys to generators (`hex`,
   `base64`, `base64url`, `uuid`, `password`, Laravel `APP_KEY`, JWT secret,
   ASP.NET data-protection key directory, `path:`). Un-listed `change-me…`
   values keep becoming 24 random bytes in hex, so the nine templates behave as
   before. Generated values go only into the env file, never logged, never
   returned by a tool.
6. **One artifact-directory list** (`shared/apps/artifact-dirs.mjs`, imported by
   the engine, `tsup.config.ts`, `desktop/scripts/build.mjs` and the rot check).
   The instantiate copy, the walk, `apps/duplicate`, the Apps file tree, the file
   route, the bound-session listing and the two package filters all use it. A
   template that legitimately needs one of the names lists it in `keepDirs`.
7. **Checks per stack for apps without a template profile** (`src/checks.ts`,
   `src/project/profile.ts`): Maven/Gradle (wrapper preferred), .NET, Composer, Go
   (`go vet`), Python (ruff, mypy, pytest). `DependencyAudit` learns Maven and
   Gradle (OSV-scanner or OWASP dependency-check **when installed**, else it
   reports "not available" and what to install, never a pass) and Composer
   (`composer audit`). The security scan recognises the Java/.NET/PHP manifests
   and reports, honestly, that it has no code rules for those languages.
8. **Bundles.** `kind: "bundle"` apps carry `services[]`. Start/stop is either
   **compose** (`docker compose -f compose.yaml -p aico-<slug> up -d --wait`,
   when Docker is present and the file exists) or **native** (each template
   service as its own process, started in `dependsOn` order, each with its own
   free port, health gate and log ring, env wired by
   `{service.<id>.url|host|port}`). `RunningApp` gains an optional `services[]`
   (id, state, port, url, output); the record's own `url` is the preview
   service's. Container-only services (a database image) need Docker and say so.
   The generated compose file pins images from the verified-tags table
   (Postgres 18, Valkey 9, Keycloak 26.8, Mailpit, Traefik 3.7; never Redis 8 or
   MinIO), drops capabilities, uses named volumes only, puts secrets behind
   `${VAR:?}` interpolation from a gitignored `.env` it fills with random values
   (`{secret}` / `{secret.<service>}` in wiring), and fronts a frontend + API with a
   Traefik single origin configured from files, never the Docker socket.
   Deploy for a bundle is the compose file through the existing `deploy`
   targets. Not built: Kubernetes, service meshes, VerifyApp across several
   origins (the gate verifies the preview service's origin; the others are
   visible through `status`/health).
9. **Per-app git workflow** (`src/apps/app-git.ts`). Scaffold commit:
   `chore: scaffold <name> (aico template <id>@<version>)`. A story commit is a
   Conventional Commit with the "Done when" evidence in the body. **In the
   loop:** the completion gate refuses to complete a turn in an app-bound
   session that wrote source and left uncommitted changes in an app with a git
   repo, after `VerifyApp` has passed (the existing gate order), naming the
   exact `AppManage commit` call. The commit goes through AppManage `commit`
   (argv, the app's own local identity). Annotated `v0.1.0` is created by
   `AppManage release` with `baseline: true` once the action has itself run the declared checks and a person approved. `AppManage
   release` bumps SemVer in the stack's manifest, moves CHANGELOG
   `[Unreleased]` to the version, writes `docs/releases/<version>.md`, commits
   and tags annotated. **Tagging is a human gate**: the action returns a plan
   and tags only with `confirm: true`; it never pushes. Guards still only deny.
10. **Not changed:** no new dependency, no new route family (optional body
    fields on `apps/run` and `apps/create`), no change to the session log
    format, the template search order, or the scrubbed-environment rule.

## Alternatives considered

| Option | Why not |
|---|---|
| Per-stack adapters in the engine (a Python runner, a Java runner…) | Eight code paths to keep honest; the manifest already carries everything an adapter would hard-code. |
| A second `checks` key beside `run` | Two sources of truth for the same commands; the app snapshots `run` already and the profile seeds from it. |
| Always run non-Node stacks in Docker | Docker is not on every machine, and a container hides the toolchain the person will use; native first, container as an explicit fallback. |
| Compose only for bundles | No Docker, no bundle; native start in dependency order covers the common frontend + API case. |
| Auto-tag every passing commit | Releases are decisions; AICO's own release flow gates on a person, so does this. |
| A shell wrapper for `&&` in commands | Reopens shell-string building ([0009](0009-custom-tools.md), [0027](0027-shell-confinement.md)); commands stay argv. |

## Consequences

- **Good:** Python/Java/.NET/Go/PHP starters and custom apps run, check, audit and
  verify through one runner; the nine Node templates are unchanged; `built`,
  Deploy and Preview work for any stack; bundles start with one action.
- **Bad / costs:** more manifest surface to validate; native bundle start needs
  every service's toolchain installed; Windows needs `win32` overrides for
  `mvnw`.
- **Honest limits:** not a sandbox (an app runs with the user's permissions; the
  Docker fallback narrows filesystem exposure to the app directory but is not a
  boundary against a hostile image); the Docker fallback and compose paths are
  unit-tested with a fake `docker` and exercised live only where Docker exists;
  Maven/Gradle audits need an external scanner.
- **Migration:** none. Old apps read as before.

## Threat model

- **Assets:** the user's disk, ports, credentials.
- **New capability:** launching processes from a manifest (as before),
  `docker run`/`docker compose` from a manifest, writing an env file,
  `git commit`/`git tag` in the app directory.
- **Abuse:** a hostile template or `app.json` declares a malicious command. Same
  trust as before (a repository you clone and run). The Docker form adds `-v`,
  so the **volume source is always the app directory computed by the engine,
  never a manifest value**; extra `docker run` flags cannot come from a manifest
  (`docker.image` is validated as an image reference, cache names as volume
  names); ports bind `127.0.0.1`; there is no `--privileged`, host networking,
  Docker socket or other mount. Env values are not interpreted by a shell.
  Tags/commits use argv with a charset check on branch, tag and subject.
- **Residual:** a template can still run arbitrary code in the app directory
  with the user's permissions, exactly as an `npm install` postinstall does today.

## Verification

`test-harness.mjs` (toolchain probes with fake executables, version ranges, env
generators, the artifact list, manifest validation incl. every shipped template,
manifest-driven start with a fake stack, bundle ordering/wiring/compose text,
git workflow and release); `npm run test:templates` (every shipped template
through its declared checks natively or in Docker); `check:standards`.
