# Architecture

The module map, who owns what, which way dependencies point, and where to
extend. Architecture memory for the product itself (the contracts a model must
not misread) is in [`AICO.md`](../../AICO.md); this is the map for people and
agents changing the code. Paths were verified against the tree on 2026-09-30.

## Shape

```
          ┌──────────────── clients ────────────────┐
          │ desktop/ (Electron)   vscode-extension/ │
          │ web/ (browser)        src/ui (terminal) │
          └───────┬───────────── HTTP + SSE ────────┘
                  │  token-gated, 127.0.0.1
          ┌───────▼──────────── engine: src/ ───────────────────────┐
          │ server/ → agent.ts (turn · step · steer)                │
          │   session/ (append-only log) ← projections, compaction  │
          │   tools/ + tools/pipeline.ts (hooks → plan → bash-safety│
          │          → sandbox → permission → body → post)          │
          │   providers/ (8 vendors, prompt dialects via prompt/)   │
          │   mcp/ (client) · mcp-server/ (stdio server)            │
          │   work/ (ledger · supervisor · watchers) · cron/        │
          └─────────────────────────────────────────────────────────┘
                  ▲ imported by engine and every client
          shared/ (UI renderers, widget kit, host-tool contracts)
```

## Entry points

| Entry | File | What starts |
|---|---|---|
| `aico` (REPL) | `src/index.ts` → `src/ui/App.tsx` (Ink) | terminal chat |
| `aico run <task>` / `aico -p` | `src/index.ts` | one-shot turn |
| `aico serve` | `src/index.ts` → `src/server/index.ts` `serve()` | HTTP + SSE server on 127.0.0.1 with a startup token; the web client |
| `aico mcp-serve` | `src/index.ts` → `src/mcp-server/index.ts` | MCP server on stdio (read-only unless `--allow-writes`) |
| Desktop | `desktop/electron/main.ts`; engine in `desktop/engine/entry.ts` (calls `serve()`) in a `utilityProcess` (`desktop/electron/engine-host.ts`) | the desktop app |
| VS Code | `vscode-extension/src/extension.ts`; panel `vscode-extension/webview/` | the panel, talking to `aico serve` through the extension host |

`src/bootstrap.ts` initialises skills, MCP (including desktop host servers from
`AICO_HOST_MCP`), background agents and cron for any entry point that runs turns.

## Engine modules (`src/`)

| Module | Responsibility |
|---|---|
| `agent.ts` | the agent loop: steps, tool dispatch through the pipeline, gates, steering, turn end reasons |
| `session/` | the append-only event log (`session.ts`, `events.ts`), JSONL persistence under `aicoHome()/projects/<cwd-hash>/sessions/`, projections, compaction, masking |
| `tools/` | built-in tools (`index.ts`: `toolDefinitions` + `executeTool`), `pipeline.ts`, `observation.ts` (read-before-edit), `timeout-policy.ts`, `supervise.ts`, `investigate.ts`, `task.ts` (sub-agents) |
| `registry/` | capability registry; `tool-registry.ts` (`register()` returns a disposer) |
| `providers/` | `ProviderAPI` (`types.ts`), `selectProvider()`/`providerFromInstance()` (`index.ts`), vendor implementations, capability probe |
| `prompt/`, `prompts.ts` | the system prompt as data (`prompts.ts`) rendered per `promptDialect` (`prompt/`) |
| `server/` | `aico serve`: HTTP routes (`api-*.ts`), SSE hub (`events.ts`: durable events carry `seq`, ephemeral never replayed), settings redaction |
| `mcp/` | MCP client (stdio, HTTP, SSE), registry, `McpManage` |
| `mcp-server/` | AICO as an MCP server: six tools (submit/status/wait/stop/ack/sessions), hand-rolled JSON-RPC on stdio |
| `work/` | the work ledger (`aicoHome()/work.jsonl`, `AICO_WORK_LOG`), handles, supervisor (limits enforced by the loop), watchers, `<running_work>` projection |
| `cron/` | scheduler + store (`AICO_CRON_STORE` or `aicoHome()/cron.json`) + Cron tools |
| `background/` | background agents, mirrored into the ledger via `work/adapters.ts` |
| `delivery/` | the task board ([ADR 0038](adr/0038-delivery.md)): journal (`aicoHome()/delivery/<project>/`), dispatcher over background agents in per-task worktrees, serial merge queue (rebase, checks by tree hash, evidence, risk), landing; wire types in `shared/delivery/types.ts`; routes in `server/delivery-routes.ts`; the deferred `Delivery` tool |
| `connections/` | connections to a forge and tracker ([ADR 0039](adr/0039-connections-and-agile.md)): store (`aicoHome()/connections/`, mappings beside the Delivery journal), the HTTP client (policy, SSRF guard, TLS, rate limits, ETag; the only transport), the `ProviderAdapter` interface and `github/` adapter, `git.ts` (the only place AICO pushes or fetches: `aico/task-*`, never forced, read-once askpass sink), `sync.ts` (work items), `landing.ts` (PR mode hooks into Delivery), `poller.ts`; wire types in `shared/connections/types.ts`; routes in `server/connection-routes.ts`; the deferred `ConnectionManage` tool |
| `sandbox/` | file-write confinement and its pipeline guard (`guard.ts`) |
| `skills/` | skill loader/registry (builtin → user → project; `skills/builtin/`) |
| `agents/` | agent specs, built-in specialist prompts (`prompts-registry.ts`), user agents, per-role model economy |
| `memory/` | `AICO.md` / `USER.md` / parent `CLAUDE.md` / `.aico/rules` loader, cache, watcher |
| `knowledge/`, `learning/` | knowledge entries (triggered, in the volatile tail); proposals from ratings/corrections |
| `checkpoint/` | undo for the agent's file changes |
| `codemap/` | codebase index (queried, never injected) |
| `apps/`, `miniapps/`, `project/` | app templates + deploy; Mini App host; `.aico/profile.json`, checks, decisions. `apps/` also holds the multi-stack layer ([ADR 0031](adr/0031-multi-stack-apps.md)): `toolchain` probes, `stack` types and validation, `env-file`, `docker-run` (the one place a manifest reaches `docker run`), `bundle` (services, compose), `app-git` (commits, releases); the artefact-directory list is `shared/apps/artifact-dirs.mjs` |
| `canvas/` | canvas documents edited by user and agent |
| `worktree/` | git worktree manager + tools |
| `verification.ts`, `checks.ts`, `requirements.ts` | completion gates: a turn that produced a web artifact cannot complete without a fresh passing verdict |
| `safety.ts` | bash command classifier |
| `home.ts` | `aicoHome()` — the only place the store path is computed |
| `run-context.ts` | AsyncLocalStorage for cwd/session per run |
| `test-exports.ts` | the surface `test-harness.mjs` imports |

`src/hooks/`, `src/lib/`, `src/services/`, `src/types/`, `src/app/`,
`src/components/`, `src/data/` are empty directories (untracked); hooks live in
`src/hooks.ts`. Do not put new code there without a reason.

## Clients

- **`web/`** — Vite + React + zustand. `web/src/store`, `api.ts`, `reduce.ts`
  are the client state layer that desktop and VS Code reuse. Talks to the
  engine over HTTP/SSE only. Alias `@aico/ui` → `shared/ui`.
- **`desktop/`** — `electron/` (main: engine host, `aico://` protocol proxy,
  IPC features, MCP host server, browser, updater, backup), `renderer/` (React;
  aliases `@web` → `web/src`, `@aico/ui`, `@aico/shared`, `@desk`), `shared/`
  (plugin contract), `engine/entry.ts`. Read `desktop/DESIGN.md`.
- **`vscode-extension/`** — extension host (`src/`) + panel (`webview/`, built
  into `media/`). The panel reuses the web client; host tools
  (`VSCodeDiagnostics`, `VSCodeTasks`, `VSCodeReferences`, `VSCodeRename`,
  `VSCodeFormat`) reach the editor's language server.
- **`shared/`** — UI renderers (`shared/ui`), widget catalogue
  (`shared/widgets/catalog.ts`), widget kit (`shared/kit`, 54 widgets), host
  tool contracts (`shared/host-tools.ts`), reasoning display (`shared/reasoning.ts`).

## Dependency direction (must hold)

```
shared/  ←  src/ (engine)
shared/  ←  web/src  ←  desktop/renderer, vscode-extension/webview
src/     ←  desktop/engine/entry.ts (bundled into the desktop app)
```

- `shared/` imports nothing from `src/`, `web/` or `desktop/`.
- The engine imports nothing from `web/`, `desktop/` or `vscode-extension/`.
- `web/src` never imports the engine; it talks HTTP/SSE.
- Desktop main never re-implements engine state (sessions, settings, skills,
  MCP, cron). It hosts the engine and proxies to it.
- The renderer never holds the engine token: `desktop/electron/protocol.ts`
  strips any token from renderer requests and attaches the real one in main.
- `src/work/register.ts` exists only to break the cycle
  `bash → adapters → task → tool registry → bash`; keep cycles out.

Verify with `grep` before adding an import that crosses a boundary.

## Extension points

| To add… | Do this | Also |
|---|---|---|
| **A tool** | define `{ name, description, inputSchema }` + an execute function (minimal example: `src/tools/pwd.ts`); add to `toolDefinitions` and `executeTool` in `src/tools/index.ts`, or `register()` via `src/registry/tool-registry.ts`; mark `isConcurrencySafe` only if it truly is; set `maxResultSizeChars` | decide sub-agent/plan-mode availability (`SUBAGENT_TOOL_SETS`, plan-mode read-only set); a result the model can act on; timeout via the policy; offline tests in `test-harness.mjs`; security review (it runs on the user's machine) |
| **A provider** | implement `ProviderAPI` (`src/providers/types.ts`); add a case to `selectProvider()` and `providerFromInstance()` in `src/providers/index.ts`; prices/windows with sources | idle timeout (shared), usage reporting (or it is marked estimated), prompt dialect with a `rationale`, capability defaults conservative |
| **A chat widget** | add the kind to `shared/widgets/catalog.ts`; renderer in `shared/ui/widget-registry.tsx` (a kind with no renderer is a type error); spec parsing in `shared/ui/widget-specs.ts` | unit tests in `web/test-ui.mjs` (add a per-entry esbuild line to `test:web:unit`) |
| **A kit widget** | `shared/kit/` (catalog, contracts, `registry.ts`); CSS via `scripts/build-kit-css.mjs` (scoped `.aico-kit`) | |
| **A desktop feature** | a main-process module exporting `register(ctx)`, listed in `desktop/electron/features.ts`; IPC channels under an allowed prefix in `desktop/electron/preload.ts` (`PREFIXES`) | renderer as a builtin plugin in `desktop/renderer/src/plugins/builtins.tsx` |
| **A desktop plugin** | JSON manifest validated by `desktop/shared/plugin-types.ts` (`PLUGIN_API_VERSION = 1`); user plugins in `~/.aico/desktop/plugins` | |
| **An agent tool from the desktop** | add to the host MCP server `desktop/electron/mcp.ts` (`ide_*`, `browser_*`); the engine sees it via `AICO_HOST_MCP` | MCP `instructions` reach the prompt — keep them short |
| **A browser capability** | `desktop/electron/browser*.ts`; safety rules in `browser-safety.ts` apply at the action gate | [ADR 0005](adr/0005-browser-agent-safety-model.md) |
| **A skill** | folder with `SKILL.md` in `src/skills/builtin/` (or user/project dirs) | eval with `aico skill eval` |
| **A hook event** | `HookEvent` in `src/hooks.ts`; configured in `settings.hooks` | hooks are a pipeline stage and can only deny |
| **Background work** | report into the work ledger via its subsystem's `subscribe*` feed (`src/work/adapters.ts`) | [devops.md § background operations](devops.md#headless-and-background-operations) |
| **An HTTP route** | `src/server/api-*.ts`; token-gated like the rest | durable changes publish on the SSE hub; see redaction rules |

## Stores and files (under `aicoHome()`, default `~/.aico`)

`settings.json` · `projects/<cwd-hash>/sessions/<id>.events.jsonl` ·
`work.jsonl` · `cron.json` · `agents/` · `knowledge/` · `codemap/` ·
`cache/model-capabilities.json` · `AICO.md` · `USER.md` · `desktop/prefs.json` ·
`desktop/plugins/` · `desktop/browser/` (profile, vault). Per project:
`.aico/settings.json`, `.aico/profile.json`, `.aico/knowledge/`, `.aico/rules/`.
Note the desktop computes `AICO_HOME` itself in `desktop/electron/main.ts` and
passes it to the engine; keep the two definitions in step.
