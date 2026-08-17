# AICO — Complete Guide

**Version:** 0.3.0-beta
**Tagline:** Multi-provider AI coding assistant CLI — Claude Code compatible, provider-agnostic, dynamically extensible.

AICO is a terminal-based AI coding assistant that works with **6 AI providers** (OpenRouter, Anthropic, OpenAI, Google Gemini, Z.AI GLM, Ollama), supports **17 specialist agent types**, **dynamic agent creation**, **custom pipelines**, **prompt caching**, and a **Claude Code-style terminal UI**.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Providers & Models](#2-providers--models)
3. [Prompt Caching (Cost Optimization)](#3-prompt-caching-cost-optimization)
4. [Agent Types](#4-agent-types)
5. [Talking to a Specific Agent](#5-talking-to-a-specific-agent)
6. [Dynamic Agent Creation](#6-dynamic-agent-creation)
7. [Skills](#7-skills)
8. [Custom Pipelines](#8-custom-pipelines)
9. [Slash Commands](#9-slash-commands)
10. [Terminal UI](#10-terminal-ui)
11. [Settings Reference](#11-settings-reference)
12. [How to Prompt Effectively](#12-how-to-prompt-effectively)
13. [Performance Tips](#13-performance-tips)

---

## 1. Quick Start

### Install

```bash
npm install -g aico
# OR run directly:
npx aico
```

### Set your API key

Pick one provider (any one works):

```bash
# Option A: Z.AI GLM (cheapest, strong coding)
export ZAI_API_KEY=your-key

# Option B: OpenRouter (any model, including free ones)
export OPENROUTER_API_KEY=your-key

# Option C: Anthropic (Claude — best quality)
export ANTHROPIC_API_KEY=your-key

# Option D: OpenAI
export OPENAI_API_KEY=your-key

# Option E: Google Gemini
export GEMINI_API_KEY=your-key

# Option F: Local Ollama (no key needed)
# Just install Ollama and add to ~/.aico/settings.json:
# { "provider": "ollama" }
```

Or store keys in `~/.aico/settings.json`:
```json
{
  "providers": {
    "zai": { "apiKey": "your-key" }
  }
}
```

Or use a `.env` file in your project root (AICO loads it automatically).

### Run

```bash
# Interactive REPL
aico

# Single task (non-interactive)
aico -p "fix the failing tests in src/auth.test.ts"

# With a specific model
aico -m glm-4.6

# With a specific agent
aico --agent devops -p "set up CI/CD for this project"

# Auto-approve all tool calls (fully autonomous)
aico -y -p "create a REST API with Express and SQLite"
```

---

## 2. Providers & Models

### Supported Providers

| Provider | Key Variable | Default Model | Notes |
|----------|-------------|---------------|-------|
| **Z.AI (GLM)** | `ZAI_API_KEY` | `glm-4.6` | Cheapest strong coding model. Implicit caching. Coding Plan endpoint available. |
| **OpenRouter** | `OPENROUTER_API_KEY` | `deepseek/deepseek-v4-flash` | Routes any model. Implicit + explicit caching. |
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | Best quality. Explicit cache_control (90% input savings). |
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o-mini` | Automatic server-side caching. |
| **Gemini** | `GEMINI_API_KEY` | `gemini-2.0-flash` | Google's models. |
| **Ollama** | (none) | `llama3.1` | Local, free, private. |

### Model Aliases (short names)

```bash
aico -m glm          # → glm-4.6
aico -m glm-flash    # → glm-4.5-air (fast, cheap)
aico -m haiku        # → claude-haiku-4.5
aico -m sonnet       # → claude-sonnet-4-6
aico -m deepseek     # → deepseek/deepseek-v4-flash
aico -m gpt4         # → gpt-4o
aico -m gemini       # → gemini-2.0-flash
```

### Provider Auto-Detection

AICO auto-detects the provider from the model name:
- `claude-*` → Anthropic
- `gpt-*`, `o1`, `o3`, `o4` → OpenAI
- `gemini-*` → Gemini
- `glm-*`, `zai/*` → Z.AI
- `deepseek/*` → OpenRouter

The model prefix **overrides** the default provider setting — so `aico -m glm-4.6` routes to Z.AI even if your default is OpenRouter.

### Z.AI Coding Plan

If you have a GLM Coding Plan (not the standard API plan), enable the coding endpoint:
```json
// ~/.aico/settings.json
{
  "providers": {
    "zai": { "useCodingEndpoint": true }
  }
}
```
This switches the base URL to `https://api.z.ai/api/coding/paas/v4`.

---

## 3. Prompt Caching (Cost Optimization)

Prompt caching is **on by default** and saves up to **90% on input tokens** for repeat turns.

### How it works per provider

| Provider | Mechanism | Savings |
|----------|-----------|---------|
| **Anthropic** | Explicit `cache_control` on system prompt + tools | ~90% input cost reduction |
| **Z.AI (GLM)** | Implicit/automatic — no flag needed | Automatic cache hits |
| **OpenRouter** | Top-level `cache_control` + session routing | 90% for Anthropic models, implicit for DeepSeek |
| **OpenAI** | Automatic server-side | Reported in `cached_tokens` |
| **Gemini** | Automatic | Reported in usage |

### Viewing cache hits

Use `/cost` to see cached tokens:
```
↑ 5,000 ↓ 1,200 ⚡4,800 (~$0.0021)
```
The ⚡ marker shows cached tokens. The status bar shows a live context-window percentage.

### Disabling caching

```json
{ "promptCaching": { "enabled": false } }
```

---

## 4. Agent Types

AICO has **17 built-in agent types**. Each has a specialized system prompt and tool whitelist.

### Core Agents

| Agent | Tools | Best For |
|-------|-------|----------|
| `general` | Full | Versatile generalist (default) |
| `project` | Full | Project-dedicated orchestrator — locked to project context, spawns specialists |
| `explore` | Read-only | Fast codebase exploration |
| `plan` | Read-only + todos | Designing implementation plans |

### Specialist Agents

| Agent | Tools | Best For |
|-------|-------|----------|
| `backend` | Full | API/server implementation (TypeScript/Node primary, stack-adaptive) |
| `frontend` | Full | UI implementation (React/TS primary, accessible, performant) |
| `qa` | Read/Write/Bash | Test writing and execution |
| `architect` | Read/Write/Web | System design, architecture docs, task graphs |

### Review & Security Agents

| Agent | Tools | Best For |
|-------|-------|----------|
| `review` | Read + Bash | Industry-standard code review (SOLID, architecture, security, performance) |
| `verification` | Read-only | Adversarial review — tries to BREAK the work. Returns VERDICT: PASS/FAIL |
| `security-audit` | Read + Bash | Defensive security analysis (OWASP, CVEs, secrets) |
| `devsecops` | Read + Bash | DevSecOps: SAST/DAST, container/dep/IaC scanning, SBOM |

### DevOps Agent

| Agent | Tools | Best For |
|-------|-------|----------|
| `devops` | Full | IaC (Terraform/Ansible/Pulumi), CI/CD, Docker/K8s, cloud, monitoring. Safety-constrained. |

### Studio Pipeline Agents

| Agent | Tools | Best For |
|-------|-------|----------|
| `healer` | Full | Error recovery — fixes build/test failures |
| `tech-writer` | Full | Documentation |
| `product-owner` | Read/Write/Web | Requirements, acceptance gate |
| `studio-orchestrator` | Full | Pipeline coordination |

---

## 5. Talking to a Specific Agent

### Via CLI flag

```bash
# Chat directly with the DevOps agent
aico --agent devops

# Chat with the code reviewer
aico --agent review

# Chat with the project orchestrator
aico --agent project

# Chat with a custom agent you created
aico --agent my-database-specialist
```

When you use `--agent`, the agent's system prompt is prepended to your conversation. The agent operates within its assigned capabilities — a `devsecops` agent won't edit files, a `review` agent only reads and runs analysis.

### Via slash command (mid-session)

```
/agent-mode devops      → switch to DevOps agent
/agent-mode review      → switch to code reviewer
/agent-mode project     → switch to project orchestrator
/agent-mode off         → back to default
```

### Via Task tool (from the orchestrator)

The orchestrator can spawn any agent mid-task:
```
Task({
  description: "Review the auth module",
  subagent_type: "review",
  prompt: "Review src/auth/ for security issues and SOLID violations."
})
```

---

## 6. Dynamic Agent Creation

### The orchestrator can create agents at runtime

The orchestrator (or you, via commands) can create new specialist agents on the fly:

```
AgentCreate({
  name: "k8s-deployer",
  description: "Kubernetes deployment specialist",
  role: "Senior Kubernetes Engineer",
  tools: ["Read", "Write", "Bash", "Glob"],
  model: "glm-4.6",
  goals: ["Deploy services to K8s", "Write Helm charts", "Validate manifests"],
  skills: ["k8s-deploy-checklist"]
})
```

Created agents are **immediately spawnable** — no restart needed:
```
Task({
  description: "Deploy the API to staging",
  agent_name: "k8s-deployer",
  prompt: "Deploy src/api to the staging cluster"
})
```

### Per-agent model assignment

Each agent can be pinned to a specific model:
- Backend agent → Claude Sonnet (best for complex code)
- Exploration agent → DeepSeek Flash (fast, cheap)
- DevOps agent → GLM-4.6 (strong coding, low cost)

```json
// ~/.aico/agents/my-agent.json
{
  "name": "fast-coder",
  "model": "deepseek/deepseek-v4-flash",
  "role": "Fast Implementation Agent",
  "tools": ["Read", "Write", "Edit", "Bash"],
  ...
}
```

### Inline custom agents (agent_spec)

The orchestrator can synthesize a completely custom agent on the fly without registering it:

```
Task({
  description: "Database migration",
  agent_spec: {
    instructions: "You are a database migration specialist. Always backup before migrating.",
    tools: ["Read", "Write", "Bash"],
    model: "claude-sonnet-5"
  },
  prompt: "Migrate the users table to add a deleted_at column"
})
```

### Agent files location

- Built-in agents: hardcoded in the registry
- User agents: `~/.aico/agents/*.json`
- Project agents: `.aico/agents/*.json`

---

## 7. Skills

Skills are reusable prompt templates that become `/commands` or auto-trigger on pattern match.

### Built-in Skills

| Skill | Command | Description |
|-------|---------|-------------|
| `review` | `/review [scope]` | Evidence-based code review with 11 dimensions |
| `security-review` | `/security-review` or `/sec` | OWASP security audit with severity scoring |
| `commit` | `/commit` or `/cm` | Generate a conventional commit message |
| `init` | `/init` | Create an AICO.md memory file |

### Creating Skills

The orchestrator can create skills at runtime:
```
SkillCreate({
  name: "deploy-checklist",
  description: "Pre-deployment verification checklist",
  prompt: "Run through this deployment checklist:\n1. All tests pass\n2. No console.logs\n3. Env vars set\n4. Database migrated\n{args}",
  aliases: ["dc"],
  trigger: "deploy|ship|release"
})
```

Skills are **immediately available** — no reload needed.

### Assigning Skills to Agents

When you create an agent, list its skills:
```json
{
  "name": "deploy-agent",
  "skills": ["deploy-checklist", "security-review"],
  ...
}
```

When the agent is spawned, each skill's full prompt content is **injected into the agent's instructions** — the agent receives the actual procedure, not just the name.

### Skill files location

- Built-in: bundled with AICO
- User skills: `~/.aico/skills/*.md`
- Project skills: `.aico/skills/*.md` or directories configured via `settings.skills.dirs`

---

## 8. Custom Pipelines

Pipelines are multi-phase SDLC processes (like `/studio`) that you can fully customize.

### Default pipeline

```bash
aico
> /studio "build a task management API with auth"
```

This runs the built-in pipeline: Architecture → Backend → Frontend → QA → Validation → PO Gate → Docs.

### Custom pipeline

Create `.aico/pipeline.json` in your project:

```json
{
  "phases": [
    {
      "name": "Design",
      "agentType": "architect",
      "model": "claude-sonnet-5",
      "kind": "design",
      "outputs": ["ARCHITECTURE.md", "TASKS.md"]
    },
    {
      "name": "Backend Implementation",
      "agentType": "backend",
      "model": "glm-4.6",
      "kind": "implementation",
      "maxIterations": 15,
      "runValidationAfter": true,
      "docs": ["docs/api-standards.md", "docs/security-policy.md"]
    },
    {
      "name": "Security Scan",
      "agentType": "devsecops",
      "model": "glm-4.6",
      "kind": "validation",
      "condition": "if-previous-succeeded"
    },
    {
      "name": "Remediation",
      "agentType": "healer",
      "kind": "implementation",
      "condition": "if-feedback-non-empty"
    }
  ]
}
```

Then run: `aico` → `/studio "your requirements"`

### Phase features

| Feature | Description |
|---------|-------------|
| **`model`** | Per-phase model selection (mix providers per phase) |
| **`docs`** | Policy/guidance files injected into the phase prompt — the agent MUST follow them |
| **`condition`** | Conditional execution: `always`, `skip`, `if-previous-succeeded`, `if-feedback-empty`, `if-feedback-non-empty` |
| **`maxIterations`** | For implementation phases: how many Ralph Loop iterations |
| **`runValidationAfter`** | Run the validation stack (tsc + build + test) after this phase |
| **`runPoGateAfter`** | Run the Product Owner quality gate after this phase |

---

## 9. Slash Commands

### Session & Context

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/status` | Show model, provider, CWD, session info |
| `/cost` | Show token usage and cost (with cache hits) |
| `/compact [focus]` | Compress conversation to free context |
| `/clear` | Wipe conversation history |
| `/model [name]` | Show or switch model |
| `/agent-mode [name]` | Switch to a specific agent persona (`off` to reset) |
| `/plan` | Toggle plan mode (read-only) |
| `/permissions` | Show/reset tool trust |
| `/config [key] [val]` | Show/edit settings |
| `/memory` | Show loaded memory files |
| `/history` | Show conversation history |
| `/resume [id]` | Resume a previous session |

### Code Review & Verification

| Command | Description |
|---------|-------------|
| `/review [scope]` | Industry-standard code review (diff, file, or branch) |
| `/verify [scope]` | Adversarial verification — tries to break the code |
| `/security-audit` | Full defensive security audit |
| `/security-review` or `/sec` | OWASP security review skill |

### Agents & Teams

| Command | Description |
|---------|-------------|
| `/agents` | List all agents (built-in + custom) |
| `/agent <name> <task>` | Run a specific agent on a task |
| `/agent-create` | Create a custom agent |
| `/team <requirements>` | Product Owner-led multi-agent team |

### Project & Workspace

| Command | Description |
|---------|-------------|
| `/init` | Create AICO.md memory file |
| `/studio <requirements>` | Run the autonomous SDLC pipeline |
| `/scaffold <requirements>` | Generate a full-stack project |
| `/workspace` | Show workspace info |
| `/workspace-set <path>` | Set workspace path |
| `/capabilities` | Show all tools, agents, skills, MCP servers |
| `/doctor` | Health check: environment, providers, settings |

### MCP

| Command | Description |
|---------|-------------|
| `/mcp` | List MCP servers and tools |
| `/mcp-add <name> <cmd>` | Add an MCP server |
| `/mcp-add-playwright` | Add Playwright browser automation |
| `/mcp-remove <name>` | Remove an MCP server |
| `/mcp-reload` | Reload MCP servers |
| `/mcp-security` | MCP security posture report |

---

## 10. Terminal UI

AICO has a Claude Code-style terminal UI built with Ink (React for terminals).

### Visual elements

- **⏺ coral marker** before every assistant message
- **✻ spinner** with rotating verbs (Thinking → Pondering → Working → Processing → Analyzing)
- **Rounded tool call boxes** with tool-specific glyphs (⚡ Bash, 📖 Read, ✏️ Write)
- **Progressive streaming markdown** — formatted text renders as it arrives
- **Live tool list** — running tools shown with their own spinners
- **Permission prompts with diff preview** — see red/green changes before approving
- **Status bar** — model, CWD, git branch, context %, tokens, cost, mode

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | Newline (multi-line input) |
| `\` + Enter | Newline fallback (terminals without Shift+Enter) |
| `Ctrl+J` | Newline |
| `Shift+Tab` | Cycle mode: Normal → Plan → Auto-Accept |
| `Ctrl+P` | Attach clipboard image |
| `Ctrl+X` | Remove last attachment |
| `Ctrl+C` | Cancel / exit |
| `Tab` | Autocomplete slash commands |
| `↑` / `↓` | Navigate autocomplete suggestions |

### Modes (Shift+Tab)

| Mode | Border | Behavior |
|------|--------|----------|
| **Normal** | Default | Permissions enforced per rules |
| **Plan** | Purple | Read-only — no edits, writes, or commits |
| **Auto-Accept** | Green | All tool calls auto-approved (no prompts) |

### Themes

```json
{ "theme": "dark" }   // default
{ "theme": "light" }  // for bright terminals
```

---

## 11. Settings Reference

All settings in `~/.aico/settings.json` or `.aico/settings.json`:

```json
{
  "model": "glm-4.6",
  "provider": "zai",
  "providers": {
    "zai": {
      "apiKey": "...",
      "baseUrl": "https://api.z.ai/api/paas/v4",
      "useCodingEndpoint": true,
      "defaultModel": "glm-4.6"
    },
    "openrouter": { "apiKey": "...", "defaultModel": "deepseek/deepseek-v4-flash" },
    "anthropic": { "apiKey": "..." },
    "openai": { "apiKey": "...", "baseUrl": "custom-endpoint" },
    "gemini": { "apiKey": "..." },
    "ollama": { "baseUrl": "http://localhost:11434/v1" }
  },
  "autoApprove": false,
  "agentTimeout": 0,
  "bashTimeout": 120,
  "maxIterations": 100,
  "promptCaching": { "enabled": true },
  "completionGate": { "enabled": true },
  "safetyLimits": {
    "maxCostPerSession": 5.0,
    "maxTokensPerSession": 500000
  },
  "theme": "dark",
  "autoCompact": {
    "enabled": true,
    "thresholdTokens": 80000,
    "keepRecentTurns": 6
  },
  "workspace": { "path": "~/.aico/workspace/projects/myproject" },
  "skills": { "dirs": ["./docs/skills"], "disableBuiltins": false },
  "cron": { "enabled": true, "maxConcurrentJobs": 3 },
  "mcpServers": { ... },
  "hooks": { ... }
}
```

---

## 12. How to Prompt Effectively

### For coding tasks

**Good prompt:**
```
Read src/auth/login.ts and src/auth/session.ts. The login function doesn't
invalidate existing sessions when a user logs in again. Fix it so that calling
login() destroys all prior sessions for that user before creating a new one.
Then write a test that verifies the old session token no longer works after
re-login. Run the test and confirm it passes.
```

**Why it works:**
- Names the exact files
- Describes the bug precisely (sessions not invalidated)
- Specifies the expected behavior
- Asks for a test (verification)
- Asks to run the test (proof)

**Bad prompt:**
```
Fix the login bug.
```
(Too vague — the agent doesn't know which file, which bug, or what "fixed" means.)

### For architecture/design

```
I'm building a multi-tenant SaaS API with Express + PostgreSQL. Design the
database schema, API routes, and authentication flow. Consider:
- Row-level isolation between tenants
- JWT auth with refresh token rotation
- Rate limiting per tenant
- Audit logging

Write ARCHITECTURE.md and create the initial migration files.
```

### For code review

```
/review src/api/
```
Or for staged changes:
```
/review
```

The review agent will read every changed file, run available linters/tests,
and produce evidence-based findings with file:line, severity, and concrete fixes.

### For DevOps

```
--agent devops

Set up a GitHub Actions CI/CD pipeline for this Node.js project:
- Run tests on every PR (Node 18 + 20)
- Build and push Docker image on merge to main
- Deploy to Kubernetes (staging namespace)
- Include security scanning (Trivy) in the pipeline

Create the workflow file and a multi-stage Dockerfile.
```

### For the studio pipeline

```
/studio Build a REST API for a blog platform with:
- User authentication (JWT + refresh tokens)
- CRUD for posts, comments, and tags
- SQLite database with proper schema
- Input validation on every endpoint
- Integration tests for all endpoints
- API documentation

Tech stack: Express + better-sqlite3 + Zod validation
```

### For multi-agent teams

```
/team Build a real-time chat application with:
- WebSocket server (Socket.io)
- User presence and typing indicators
- Message persistence (SQLite)
- Frontend (React + Tailwind)

P0: working chat with persistence. P1: typing indicators. P2: file sharing.
```

---

## 13. Performance Tips

### Cost optimization

1. **Use prompt caching** (on by default) — saves up to 90% on input tokens for multi-turn sessions.
2. **Use the cheapest model that works** — DeepSeek V4 Flash and GLM-4.5-Air are extremely cheap and strong for coding.
3. **Use `--effort low`** for simple tasks (faster, fewer tokens).
4. **Use `--effort max`** only for complex architecture decisions.
5. **Set cost safety limits** to prevent runaway spending:
   ```json
   { "safetyLimits": { "maxCostPerSession": 2.0 } }
   ```

### Speed optimization

1. **Use sub-agents for parallel work** — the orchestrator can spawn multiple Task calls in one response; they run in parallel.
2. **Use the `explore` agent** for fast read-only codebase searches (it has fewer tools = faster startup).
3. **Use `-y` (auto-approve)** for fully autonomous runs — no waiting for permission prompts.
4. **Use single-task mode (`-p`)** for one-off tasks — no REPL overhead.

### Quality optimization

1. **Be specific** — name files, describe expected behavior, specify what "done" means.
2. **Ask for verification** — "run the tests and confirm they pass" ensures the agent doesn't hallucinate.
3. **Use the right agent** — `--agent review` for reviews, `--agent devops` for infrastructure, `--agent devsecops` for security.
4. **Use the completion gate** (on by default) — it nudges the agent to keep working if open todos remain.
5. **Use `/compact`** when context gets large — it summarizes old messages to free space.
6. **Assign skills to agents** — skills inject specific procedures that make agents follow your exact process.

### Multi-model strategy

Mix models for best cost/quality:

```bash
# Architecture on Claude (best reasoning), implementation on GLM (cheap, strong coding)
aico -m claude-sonnet-5 -p "Design the architecture, then spawn a backend agent on glm-4.6 to implement it"
```

In custom pipelines:
```json
{
  "phases": [
    { "name": "Design", "agentType": "architect", "model": "claude-sonnet-5" },
    { "name": "Backend", "agentType": "backend", "model": "glm-4.6" },
    { "name": "Review", "agentType": "review", "model": "claude-sonnet-5" }
  ]
}
```

---

## Appendix: File Locations

| Path | Description |
|------|-------------|
| `~/.aico/settings.json` | Global settings |
| `.aico/settings.json` | Project settings |
| `.aico/settings.local.json` | Project local settings (not committed) |
| `~/.aico/agents/*.json` | User-defined agents |
| `.aico/agents/*.json` | Project-defined agents |
| `~/.aico/skills/*.md` | User-defined skills |
| `.aico/skills/*.md` | Project-defined skills |
| `.aico/pipeline.json` | Custom SDLC pipeline |
| `~/.aico/sessions/` | Saved conversation sessions |
| `~/.aico/workspace/` | Artifacts, reports, logs |
| `.aico/trust.json` | Session tool trust state |
| `.env` | Environment variables (API keys) |
