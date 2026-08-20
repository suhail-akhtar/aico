import { readMemory, appendToMemory } from './memory.js';
import { detectProviderType, providerLabel } from './providers/index.js';
import { clearMemoryCache, getCacheStats } from './memory/index.js';
import { listSessions, loadSession } from './history.js';
import { mkdir, writeFile, readFile as readFileAsync, stat as statAsync } from 'fs/promises';
import path from 'path';
import fs from 'fs';
import { runHooks } from './hooks.js';
import { getProjectLocalSettingsPath, getSettingsAudit, saveProjectSettingsPatch, type AicoSettings } from './settings.js';
import { handleStudio } from './studio/index.js';
import { skillRegistry } from './skills/index.js';
import { subscribeToBackgroundAgents, cancelBackgroundAgent, getBackgroundAgents } from './background/index.js';
import { worktreeManager } from './worktree/index.js';
import { cronScheduler } from './cron/scheduler.js';
import {
  addMcpServer,
  removeMcpServer,
  reloadMcpServers,
  formatMcpServers,
  parseMcpAddCommand,
} from './mcp/manage.js';
import {
  ensureWorkspace,
  formatWorkspaceInfo,
  setProjectWorkspacePath,
  writeWorkspaceFile,
} from './workspace.js';
import { buildCapabilityReport } from './capabilities.js';
import {
  describeSessionContext,
  formatCompactionResult,
  maybeCompactSession,
  serializeSessionTranscript,
} from './session/index.js';
import { toolDefinitions } from './tools/index.js';
import { mcpRegistry } from './mcp/registry.js';
import { buildAgentChatPrompt, buildTeamPrompt } from './agents/prompts.js';
import { createAgentSpec, deleteProjectAgentSpec, formatAgentList, getAgentSpec, listAgentSpecs, updateProjectAgentSpec } from './agents/registry.js';
import { getAgentRegistry } from './tools/task.js';
import {
  approveToolPermission,
  denyAllPermissions,
  getPermissionState,
  resetPermissions,
  revokeToolPermission,
  trustAllPermissions,
} from './permissions.js';

export interface CommandContext {
  conversationHistory: Array<{ role: string; content: string }>;
  currentModel: string;
  sessionId: string;
  tokenCount: { input: number; output: number; cost: number };
  setModel: (m: string) => void;
  clearHistory: () => void;
  replaceHistory: (msgs: Array<{ role: string; content: string }>) => void;
  /** Plan mode state */
  planMode?: boolean;
  setPlanMode?: (enabled: boolean) => void;
  /** Settings for hooks */
  settings?: AicoSettings;
  /**
   * Durable session log, when the caller has one.
   *
   * Commands that act on "the conversation" must act on whatever the model
   * actually reads. With a log attached that is the log, not
   * `conversationHistory` — which remains for display and for the legacy path.
   */
  session?: import('./session/index.js').Session;
}

export interface CommandResult {
  handled: boolean;
  output?: string;
  exit?: boolean;
  /** Set by /compact — tells the UI to update the token display */
  newTokenCount?: number;
  /** If set, the caller should send this as a user message to the agent */
  sendAsPrompt?: string;
  /**
   * If set, the caller should run the deterministic studio pipeline directly
   * (instead of sending sendAsPrompt to runAgent). The caller supplies the
   * runtime adapter (runTask/askUser/abortSignal) and appends the resulting
   * summary to conversation history.
   */
  runStudioPipeline?: {
    projectDir: string;
  };
}

const HELP_TEXT = `
Available slash commands:
  /help                    Show this help message
  /exit  /quit  /bye       Exit aico
  /clear                   Clear conversation history
  /compact                 Compress history to summary (frees context window)
  /model [name]            Show current model or switch to a new one
  /plan                    Toggle plan mode (read-only — no edits/writes allowed)
  /status                  Show session info, model, CWD, message count, tokens
  /cost                    Show token usage and estimated cost
  /permissions             Show/reset session tool trust and dangerous tools
  /config                  Show/edit provider, model, workspace, MCP, hooks, cron
  /review [scope]          Professional evidence-based code review (diff, file, or branch)
  /verify [scope]          Adversarial verification — a critic that tries to break the code
  /studio <req>            Autonomous end-to-end SDLC (PRD → code → tests → docs)
  /scaffold <req>          Generate a full-stack project from requirements
  /security-audit          Run defensive security analysis on the codebase
  /memory                  Show all loaded memory file contents
  /memory add <text>       Append text to project AICO.md
  /memory types            Show cache stats and memory types loaded
  /memory clear-cache      Invalidate the memory file cache
  /history                 List recent sessions for this project
  /resume [id]             Resume a previous session by ID (lists sessions if no ID given)
  /init                    Create an AICO.md template in CWD if it doesn't exist
  /provider                Show configured providers and active provider
  /provider add            Add or update a provider (interactive wizard)
  /agents                  List built-in and custom agents
  /agents show <name>      Inspect an agent prompt/tools/skills
  /agents delete <name>    Delete a project custom agent
  /agents skills <n> <csv> Set skills on a project custom agent
  /agent-create <n> <role> Create a reusable custom agent
  /agent <name> <task>     Chat with a specialist agent
  /team <requirements>     Run Product Owner-led agent team orchestration
  /mcp                     List loaded MCP servers
  /mcp-add playwright      Add Playwright browser automation MCP preset
  /mcp-add <name> -- <cmd> Add a stdio MCP server command
  /mcp-create <name> <req> Create a local custom MCP tool server
  /mcp-remove <name>       Remove an MCP server
  /mcp-reload              Reload MCP servers from settings
  /mcp-security            Show MCP trust, command provenance, and env redaction
  /workspace               Show/create the project AICO workspace
  /workspace-set <path>    Configure workspace path (use "default" to reset)
  /capabilities            Show tools, commands, MCP servers, and workspace powers
  /transcript              Export this session transcript into the workspace
  /debug                   Show/export runtime debug details
  /github-action           Create a GitHub Actions AICO workflow template
  /ide-bridge              Create minimal VS Code task bridge files
  /doctor                  Check environment, provider, settings
  /skills                  List available skills (built-in + installed)
  /skills reload           Reload skills from disk
  /skill-install <url>     Install a skill from a URL
  /bg-agents               Show background agents status
  /bg-cancel <id>          Cancel a running background agent
  /worktrees               Show active git worktrees
  /worktree-cleanup <id>   Clean up a specific worktree
  /cron                    List scheduled cron jobs
  /cron-create             Create a cron job (guided)
  /cron-delete <id>        Delete a cron job
  /cron-pause <id>         Pause a cron job
`.trim();

const CLAUDE_MD_TEMPLATE = `# Project Memory

## Project Overview
<!-- Describe the project here -->

## Architecture
<!-- Key architectural decisions -->

## Development Notes
<!-- Important notes for the AI assistant -->

## Common Commands
<!-- Commands used in this project -->
`;

function formatAgentDetails(spec: NonNullable<Awaited<ReturnType<typeof getAgentSpec>>>): string {
  return [
    `Agent: ${spec.name}`,
    `Source: ${spec.source}`,
    `Role  : ${spec.role}`,
    `Desc  : ${spec.description}`,
    `Can delegate: ${spec.canDelegate ? 'yes' : 'no'}`,
    `Skills: ${spec.skills.length ? spec.skills.join(', ') : '(none)'}`,
    `Tools : ${spec.tools.length ? spec.tools.join(', ') : '(none)'}`,
    '',
    'Goals:',
    ...(spec.goals.length ? spec.goals.map((g) => `  - ${g}`) : ['  (none)']),
    '',
    'Report format:',
    `  ${spec.reportFormat}`,
    '',
    'System prompt XML:',
    spec.systemPromptXml,
  ].join('\n');
}

function parseCsv(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function formatPermissions(): string {
  const state = getPermissionState();
  return [
    'Permissions',
    '-----------',
    `Trust mode : ${state.mode}`,
    `Approved   : ${state.approvedTools.length ? state.approvedTools.join(', ') : '(none)'}`,
    `Protected  : ${state.toolsRequiringPermission.join(', ')}`,
    `Dangerous  : ${state.dangerousTools.join(', ')}`,
    '',
    'Commands:',
    '  /permissions reset',
    '  /permissions trust-all',
    '  /permissions deny-all',
    '  /permissions approve <tool>',
    '  /permissions revoke <tool>',
  ].join('\n');
}

function formatConfig(settings: AicoSettings | undefined, currentModel: string): string {
  const s = settings ?? {};
  return [
    'AICO Config',
    '-----------',
    `Settings file : ${getProjectLocalSettingsPath()}`,
    `Provider      : ${s.provider ?? '(auto)'}`,
    `Model         : ${s.model ?? currentModel}`,
    `Auto approve  : ${String(s.autoApprove ?? false)}`,
    `Workspace     : ${s.workspace?.path || '(default ~/.aico/workspace/projects/<project>)'}`,
    `Bash timeout  : ${s.bashTimeout ?? 120}s`,
    `Agent timeout : ${s.agentTimeout ?? 0}ms`,
    `Auto compact  : ${s.autoCompact?.enabled === false ? 'disabled' : 'enabled'} @ ${s.autoCompact?.thresholdTokens ?? 80_000} tokens`,
    `MCP servers   : ${Object.keys(s.mcpServers ?? {}).length}`,
    `Hooks         : ${Object.keys(s.hooks ?? {}).length} event(s) configured`,
    `Cron enabled  : ${String(s.cron?.enabled ?? true)}`,
    '',
    'Set values:',
    '  /config set model <model>',
    '  /config set provider <provider>',
    '  /config set workspace <path|default>',
    '  /config set autoApprove true|false',
    '  /config set bashTimeout <seconds>',
    '  /config set agentTimeout <milliseconds>',
    '  /config set autoCompact true|false',
    '  /config set autoCompactThreshold <tokens>',
  ].join('\n');
}

function serializeTranscript(messages: CommandContext['conversationHistory'], sessionId: string): string {
  const lines = [`# AICO Transcript`, '', `Session: ${sessionId}`, `Exported: ${new Date().toISOString()}`, ''];
  for (const [idx, msg] of messages.entries()) {
    lines.push(`## ${idx + 1}. ${msg.role}`, '', msg.content, '');
  }
  return lines.join('\n');
}

function mcpSecurityReport(settings: AicoSettings | undefined): string {
  const servers = settings?.mcpServers ?? {};
  const trusted = new Set(settings?.mcpSecurity?.trustedServers ?? []);
  const allowed = new Set(settings?.mcpSecurity?.allowedCommands ?? ['node', 'npx']);
  const lines = [
    'MCP Security',
    '------------',
    `Warn untrusted: ${String(settings?.mcpSecurity?.warnUntrusted ?? true)}`,
    `Trusted servers: ${trusted.size ? [...trusted].join(', ') : '(none)'}`,
    `Allowed commands: ${allowed.size ? [...allowed].join(', ') : '(none)'}`,
    '',
  ];
  for (const [name, cfg] of Object.entries(servers)) {
    const command = cfg.type === 'stdio' ? cfg.command : cfg.type;
    const envKeys = cfg.type === 'stdio' && cfg.env ? Object.keys(cfg.env) : [];
    const warnings: string[] = [];
    if (!trusted.has(name)) warnings.push('untrusted');
    if (cfg.type === 'stdio' && command && !allowed.has(command)) warnings.push(`command not allowlisted: ${command}`);
    lines.push(
      `${name}`,
      `  type    : ${cfg.type}`,
      `  command : ${command ?? '(n/a)'}`,
      `  args    : ${cfg.type === 'stdio' ? (cfg.args ?? []).join(' ') || '(none)' : '(n/a)'}`,
      `  env     : ${envKeys.length ? envKeys.map((k) => `${k}=<redacted>`).join(', ') : '(none)'}`,
      `  warnings: ${warnings.length ? warnings.join(', ') : '(none)'}`,
    );
  }
  if (!Object.keys(servers).length) lines.push('(No MCP servers configured)');
  return lines.join('\n');
}

// ── /scaffold — Full-stack project generator ────────────────────────

const SCAFFOLD_STACKS = new Set(['nextjs', 'vite-react', 'vite-vue', 'vite-angular', 'mern', 'mean']);
const SCAFFOLD_DBS = new Set(['mariadb', 'mysql', 'postgresql', 'postgres', 'mongodb', 'mongo', 'sqlite']);
const SCAFFOLD_UIS = new Set(['shadcn', 'tailwind', 'bootstrap']);
const MAX_SCAFFOLD_REQUIREMENTS_FILE = 200_000;

function tokenizeScaffoldArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote === '"' && (args[i + 1] === '"' || args[i + 1] === '\\')) {
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (quote === ch) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (quote) throw new Error(`Unclosed quote in /scaffold arguments`);
  if (current) tokens.push(current);
  return tokens;
}

function takeFlagValue(tokens: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const eq = tokens[index].indexOf('=');
  if (eq !== -1) {
    const value = tokens[index].slice(eq + 1);
    if (!value) throw new Error(`Flag ${flag} requires a value`);
    return { value, nextIndex: index + 1 };
  }
  const value = tokens[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Flag ${flag} requires a value`);
  return { value, nextIndex: index + 2 };
}

function normalizeScaffoldDb(db: string | undefined): string | undefined {
  if (!db) return undefined;
  if (db === 'postgres') return 'postgresql';
  if (db === 'mongo') return 'mongodb';
  return db;
}

function parseScaffoldArgs(args: string): {
  requirements: string;
  filePath?: string;
  outputDir?: string;
  stack?: string;
  db?: string;
  ui?: string;
  docker?: boolean;
} {
  let requirements = args;
  let filePath: string | undefined;
  let outputDir: string | undefined;
  let stack: string | undefined;
  let db: string | undefined;
  let ui: string | undefined;
  let docker = false;

  const requirementTokens: string[] = [];
  const tokens = tokenizeScaffoldArgs(args);

  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    const [flagName] = token.split('=', 1);
    switch (flagName) {
      case '--file': {
        const r = takeFlagValue(tokens, i, '--file');
        filePath = r.value;
        i = r.nextIndex;
        break;
      }
      case '--dir': {
        const r = takeFlagValue(tokens, i, '--dir');
        outputDir = r.value;
        i = r.nextIndex;
        break;
      }
      case '--stack': {
        const r = takeFlagValue(tokens, i, '--stack');
        stack = r.value.toLowerCase();
        i = r.nextIndex;
        break;
      }
      case '--db': {
        const r = takeFlagValue(tokens, i, '--db');
        db = normalizeScaffoldDb(r.value.toLowerCase());
        i = r.nextIndex;
        break;
      }
      case '--ui': {
        const r = takeFlagValue(tokens, i, '--ui');
        ui = r.value.toLowerCase();
        i = r.nextIndex;
        break;
      }
      case '--docker':
        docker = true;
        i++;
        break;
      case '--no-docker':
        docker = false;
        i++;
        break;
      default:
        if (token.startsWith('--')) {
          throw new Error(`Unknown /scaffold flag: ${flagName}`);
        }
        requirementTokens.push(token);
        i++;
    }
  }

  requirements = requirementTokens.join(' ').trim();

  if (stack && !SCAFFOLD_STACKS.has(stack)) {
    throw new Error(`Unsupported stack "${stack}". Use: ${Array.from(SCAFFOLD_STACKS).join(', ')}`);
  }
  if (db && !SCAFFOLD_DBS.has(db)) {
    throw new Error(`Unsupported database "${db}". Use: mariadb, mysql, postgresql, mongodb, sqlite`);
  }
  if (ui && !SCAFFOLD_UIS.has(ui)) {
    throw new Error(`Unsupported UI "${ui}". Use: ${Array.from(SCAFFOLD_UIS).join(', ')}`);
  }

  return { requirements, filePath, outputDir, stack, db, ui, docker };
}

async function readScaffoldRequirementsFile(filePath: string): Promise<string> {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const info = await statAsync(abs);
  if (!info.isFile()) throw new Error('path is not a file');
  if (info.size > MAX_SCAFFOLD_REQUIREMENTS_FILE) {
    throw new Error(`file is too large (${Math.round(info.size / 1024)}KB, max ${Math.round(MAX_SCAFFOLD_REQUIREMENTS_FILE / 1024)}KB)`);
  }

  const buf = await readFileAsync(abs);
  if (buf.includes(0)) throw new Error('file appears to be binary');
  return buf.toString('utf8');
}

function buildScaffoldPrompt(opts: {
  requirements: string;
  fileContent?: string;
  outputDir: string;
  stack?: string;
  db?: string;
  ui?: string;
  docker: boolean;
}): string {
  const { requirements, fileContent, outputDir, stack, db, ui, docker } = opts;

  const reqSource = fileContent
    ? `## Requirements (from file)\n\`\`\`\n${fileContent}\n\`\`\``
    : `## Requirements\n${requirements}`;

  const stackHint = stack ? `\nPreferred tech stack: ${stack}` : '';
  const dbHint = db ? `\nPreferred database: ${db}` : '';
  const uiHint = ui ? `\nPreferred UI library: ${ui}` : '';
  const dockerHint = docker ? '\nGenerate Docker and docker-compose configuration.' : '';

  return `You are the Scaffold Orchestrator. Build a complete, production-ready full-stack project. Follow the phases IN ORDER. Do not dump phase instructions to the user — just execute them.

${reqSource}
${stackHint}${dbHint}${uiHint}${dockerHint}

Base directory: ${outputDir}

Path handling rules:
- Treat PROJECT_ROOT as an absolute path.
- Quote PROJECT_ROOT in every shell command because paths may contain spaces.
- The Bash tool runs through the platform shell. On Windows, use cmd.exe-compatible commands with quoted paths, for example: \`cd /d "<PROJECT_ROOT>" && npm install\`.
- For long install/build commands, pass Bash timeout=0.

═══════════════════════════════════════════════════════════
PHASE 1: CLARIFICATION (use AskUserQuestion tool)
═══════════════════════════════════════════════════════════

Ask the user using AskUserQuestion (combine into ONE question if possible):

1. **Project directory**: "Create project in current directory (${outputDir}) or in a new subdirectory? If new, what name?" — If user says a name like "gym-app", the project root becomes ${outputDir}/<name>. If user says "current", use ${outputDir}.

2. ONLY ask the following if NOT already specified above:
   - Tech stack: nextjs | vite-react | vite-vue | vite-angular | mern | mean
   - Database: mariadb | mysql | postgresql | mongodb | sqlite
   - UI library: shadcn (React/Next only) | tailwind | bootstrap
   - Auth needed? (yes/no)
   - Docker? (yes/no)

If a tech stack IS already specified, skip asking about it. Be brief.

After user answers, set PROJECT_ROOT to the chosen directory path.

═══════════════════════════════════════════════════════════
PHASE 2: BOOTSTRAP PROJECT (do this FIRST, before docs)
═══════════════════════════════════════════════════════════

Use Bash to scaffold the project with the appropriate CLI tool.
If the project directory doesn't exist, create it first.

| Stack | Commands |
|-------|----------|
| nextjs | \`npx create-next-app@latest "<PROJECT_ROOT>" --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes\` |
| vite-react | \`npm create vite@latest "<PROJECT_ROOT>" -- --template react-ts\` then \`cd /d "<PROJECT_ROOT>" && npm install\` |
| vite-vue | \`npm create vite@latest "<PROJECT_ROOT>" -- --template vue-ts\` then \`cd /d "<PROJECT_ROOT>" && npm install\` |
| vite-angular | \`npx @angular/cli new "<project-name>" --directory "<PROJECT_ROOT>" --style=css --routing --skip-git\` |
| mern | \`npm create vite@latest "<PROJECT_ROOT>/client" -- --template react-ts\` then create \`<PROJECT_ROOT>/server/\` manually |
| mean | \`npx @angular/cli new client --directory "<PROJECT_ROOT>/client" --style=css --routing --skip-git\` then create \`<PROJECT_ROOT>/server/\` manually |

After bootstrapping:
- cd into PROJECT_ROOT
- Install additional dependencies: database driver, ORM (prisma/mongoose/knex), auth (bcrypt, jsonwebtoken), validation (zod), UI library
- Create \`docs/\` subdirectory inside PROJECT_ROOT for documentation

═══════════════════════════════════════════════════════════
PHASE 3: GENERATE docs/PRD.md
═══════════════════════════════════════════════════════════

Write \`<PROJECT_ROOT>/docs/PRD.md\` with:
- **Product Overview**: One paragraph describing the product
- **User Personas**: Who uses this and why
- **Core Features**: Numbered list of all features with acceptance criteria
- **Non-Functional Requirements**: Performance, security, scalability
- **Out of Scope**: What this version does NOT include
- **Tech Stack**: Chosen stack, database, UI library, key packages

═══════════════════════════════════════════════════════════
PHASE 4: GENERATE docs/REQUIREMENTS.md
═══════════════════════════════════════════════════════════

Write \`<PROJECT_ROOT>/docs/REQUIREMENTS.md\` derived from PRD.md:
- **Database Schema**: All tables/collections with fields, types, relationships, indexes
- **API Endpoints**: Method, path, request/response bodies, auth required, status codes
- **Frontend Routes**: Path, page component, auth guard needed
- **Auth Flow**: Registration, login, token refresh, logout sequence
- **State Management**: What state is global vs local
- **Environment Variables**: All required env vars with descriptions

═══════════════════════════════════════════════════════════
PHASE 5: GENERATE docs/TASKS.md
═══════════════════════════════════════════════════════════

Write \`<PROJECT_ROOT>/docs/TASKS.md\` as a phased checklist driven by PRD.md and REQUIREMENTS.md. Each phase should have concrete tasks with checkboxes. Include phases for: Database & Models, Backend API, Frontend Layout, Frontend Features, Auth, Testing, Quality/Build, Docker (if requested). Add sub-tasks where needed. Mark tasks complete as you finish them.

═══════════════════════════════════════════════════════════
PHASE 6: BUILD — FOLLOW docs/TASKS.md
═══════════════════════════════════════════════════════════

Execute the task phases from docs/TASKS.md one by one. For each task:
1. Read docs/TASKS.md to see what's next
2. Read docs/REQUIREMENTS.md for the specification
3. Write the code in PROJECT_ROOT
4. Edit docs/TASKS.md to mark the task \`[x]\` completed
5. Move to next task

CODING STANDARDS (enforce strictly):
- TypeScript strict mode — no \`any\` types
- Reusable UI components in \`components/ui/\` — Button, Input, Card, Modal, Table, Badge, Alert, Spinner, etc.
- Reusable hooks in \`hooks/\` — useAuth, useFetch, useForm, useDebounce, etc.
- Typed API client with error handling, auth headers, base URL from env
- Environment variables via .env + .env.example — NEVER hardcode URLs, secrets, ports
- Error handling: try/catch on all API routes, proper HTTP status codes (200, 201, 400, 401, 403, 404, 500)
- Input validation: zod schemas (shared frontend + backend where possible)
- Database: connection pooling, parameterized queries, indexes on foreign keys
- Auth: bcrypt (saltRounds=12), JWT with expiration, httpOnly cookies or Authorization header
- Security: helmet, CORS with specific origins, rate limiting on auth endpoints
- .gitignore (node_modules, .env, dist, .next), README.md with setup instructions
- File naming: kebab-case for files, PascalCase for components, camelCase for functions

═══════════════════════════════════════════════════════════
PHASE 7: VERIFY & FIX
═══════════════════════════════════════════════════════════

Run inside PROJECT_ROOT and fix ALL errors (loop until clean):
1. \`npm run lint\` — fix lint errors (set up ESLint if missing)
2. \`npm run build\` — fix TypeScript/build errors
3. \`npm test\` — fix test failures
4. If any fails: read error, fix code, re-run. Repeat until all 3 pass.

═══════════════════════════════════════════════════════════
PHASE 8: DOCKER (if requested)
═══════════════════════════════════════════════════════════

Generate in PROJECT_ROOT:
- \`Dockerfile\`: multi-stage build, non-root user, proper EXPOSE
- \`docker-compose.yml\`: app + database services with volumes, env, health checks, depends_on
- \`.dockerignore\`: node_modules, .git, .env, dist, .next

═══════════════════════════════════════════════════════════
PHASE 9: FINAL SUMMARY
═══════════════════════════════════════════════════════════

Provide:
1. What was built (features list)
2. How to run (\`cd <PROJECT_ROOT> && npm run dev\` or \`docker-compose up\`)
3. Project structure tree
4. Manual steps needed (create database, set env vars, etc.)
5. Known limitations or next steps

RULES:
- All project files go in PROJECT_ROOT. All docs go in PROJECT_ROOT/docs/.
- Read files before editing. Write complete files, not snippets.
- If a phase fails, debug and fix before moving on.
- Use TodoWrite to track progress.
- This must be a REAL working project, not a skeleton.`;
}

async function handleScaffold(args: string): Promise<CommandResult> {
  if (!args.trim()) {
    return {
      handled: true,
      output: [
        'Usage: /scaffold <requirements>',
        '',
        'Options:',
        '  --file <path>      Read requirements from a file',
        '  --dir <path>       Output directory (default: current dir)',
        '  --stack <name>     Tech stack: nextjs | vite-react | vite-vue | vite-angular | mern | mean',
        '  --db <name>        Database: mariadb | mysql | postgresql | mongodb | sqlite',
        '  --ui <name>        UI library: shadcn | tailwind | bootstrap',
        '  --docker           Generate Dockerfile + docker-compose.yml',
        '',
        'Examples:',
        '  /scaffold "Task management app with user auth and teams"',
        '  /scaffold --stack nextjs --db postgresql --ui shadcn "E-commerce platform"',
        '  /scaffold --file requirements.txt --dir ./my-project --docker',
        '  /scaffold --stack mern --db mongodb "Blog with comments and tags"',
      ].join('\n'),
    };
  }

  let parsed: ReturnType<typeof parseScaffoldArgs>;
  try {
    parsed = parseScaffoldArgs(args);
  } catch (err) {
    return { handled: true, output: err instanceof Error ? err.message : String(err) };
  }
  let fileContent: string | undefined;

  // Read requirements from file if --file specified
  if (parsed.filePath) {
    try {
      fileContent = await readScaffoldRequirementsFile(parsed.filePath);
    } catch (err) {
      return {
        handled: true,
        output: `Error reading file: ${parsed.filePath} — ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (!parsed.requirements && !fileContent) {
    return { handled: true, output: 'Usage: /scaffold <requirements> or /scaffold --file <path>' };
  }

  const outputDir = parsed.outputDir
    ? (path.isAbsolute(parsed.outputDir) ? parsed.outputDir : path.resolve(process.cwd(), parsed.outputDir))
    : process.cwd();

  const prompt = buildScaffoldPrompt({
    requirements: parsed.requirements || '(requirements from file)',
    fileContent,
    outputDir,
    stack: parsed.stack,
    db: parsed.db,
    ui: parsed.ui,
    docker: parsed.docker ?? false,
  });

  return {
    handled: true,
    output: `🏗️  Scaffold starting...\n   Output: ${outputDir}${parsed.stack ? `\n   Stack: ${parsed.stack}` : ''}${parsed.db ? `\n   DB: ${parsed.db}` : ''}${parsed.ui ? `\n   UI: ${parsed.ui}` : ''}${parsed.docker ? '\n   Docker: yes' : ''}`,
    sendAsPrompt: prompt,
  };
}

export async function handleSlashCommand(
  input: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const [cmd, ...rest] = trimmed.slice(1).split(' ');
  const args = rest.join(' ').trim();

  // ── Skill dispatch (pre-switch) ────────────────────────────────────
  // Check if the command matches a registered skill name or alias
  const skill = skillRegistry.lookup(cmd.toLowerCase());
  if (skill) {
    const resolvedPrompt = await skillRegistry.resolvePrompt(skill, args);
    return {
      handled: true,
      sendAsPrompt: resolvedPrompt,
      output: `Running skill: ${skill.frontmatter.name}…`,
    };
  }

  switch (cmd.toLowerCase()) {
    case 'help':
      return { handled: true, output: HELP_TEXT };

    case 'exit':
    case 'quit':
    case 'bye':
      return { handled: true, output: 'Goodbye! 👋', exit: true };

    case 'clear': {
      ctx.clearHistory();
      // With a log attached, emptying the message array clears something the
      // model no longer reads. The log must be told too, or "cleared" is a
      // false promise and the next request still carries everything.
      if (ctx.session) {
        const marker = ctx.session.clearContext();
        return {
          handled: true,
          output: marker
            ? 'Conversation cleared — the model starts fresh. ' +
              'The history is retained in the session log for the transcript and audit trail.'
            : 'Nothing to clear — the conversation is already empty.',
        };
      }
      return { handled: true, output: 'Conversation history cleared.' };
    }

    case 'model': {
      if (!args) {
        return { handled: true, output: `Current model: ${ctx.currentModel}` };
      }
      ctx.setModel(args);
      return { handled: true, output: `Model switched to: ${args}` };
    }

    case 'agent-mode': {
      // Address this whole conversation to one specialist.
      //
      // This used to print "all subsequent messages will be handled by the X
      // agent persona" and set nothing — nothing outside this file read it,
      // despite a comment claiming the REPL applied it as a prefix. It is now
      // the same logged session state the web portal uses, so the two clients
      // cannot disagree about who you are talking to.
      if (!ctx.session) {
        return { handled: true, output: 'Agent mode needs a session; this UI does not have one.' };
      }

      const { currentAgent } = await import('./session/projections.js');
      const active = currentAgent(ctx.session);

      if (!args) {
        const specs = await listAgentSpecs();
        return {
          handled: true,
          output: [
            active ? `Talking to: ${active}` : 'Talking to: the orchestrator',
            '',
            'Usage: /agent-mode <name>   — address this conversation to one agent',
            '       /agent-mode off      — back to the orchestrator',
            '',
            'The agent stays in role for every turn, with its own instructions,',
            'its assigned skills, and its tool list. Available:',
            ...specs.map((spec) => `  ${spec.name.padEnd(18)} ${spec.description}`),
          ].join('\n'),
        };
      }

      if (args.toLowerCase() === 'off' || args.toLowerCase() === 'default') {
        ctx.session.append('session/agent', { name: null });
        return { handled: true, output: 'Back to the orchestrator.' };
      }

      const { resolveAgent } = await import('./agents/resolve.js');
      const resolved = await resolveAgent(args.trim());
      if (!resolved) {
        return { handled: true, output: `There is no agent called "${args.trim()}". Use /agents to list them.` };
      }
      if (!resolved.enabled) {
        return { handled: true, output: `"${resolved.spec.name}" is switched off. Enable it first.` };
      }

      ctx.session.append('session/agent', { name: resolved.spec.name });
      return {
        handled: true,
        output: [
          `Talking to ${resolved.spec.name} — ${resolved.spec.description}`,
          resolved.spec.skills?.length ? `It reaches for: ${resolved.spec.skills.join(', ')}` : '',
          resolved.missingSkills.length
            ? `Note: these assigned skills are missing or switched off: ${resolved.missingSkills.join(', ')}`
            : '',
          'Every turn from here, until /agent-mode off.',
        ].filter(Boolean).join('\n'),
      };
    }

    case 'plan': {
      if (!ctx.setPlanMode) {
        return { handled: true, output: 'Plan mode is not supported in this UI mode.' };
      }
      const newState = !ctx.planMode;
      ctx.setPlanMode(newState);
      return {
        handled: true,
        output: newState
          ? 'Plan mode ON — only read-only tools are available. No edits, writes, or commits.'
          : 'Plan mode OFF — full tool access restored.',
      };
    }

    case 'status': {
      const lines = [
        `Session ID : ${ctx.sessionId}`,
        `Model      : ${ctx.currentModel}`,
        `CWD        : ${process.cwd()}`,
      ];
      // Report the context the model actually holds. Counting the message array
      // would describe a store the model stopped reading once a log is attached
      // — and would keep counting cleared or compacted history as present.
      if (ctx.session) {
        lines.push(...describeSessionContext(ctx.session, ctx.currentModel, ctx.settings).split('\n')
          .map(l => `Context    : ${l}`));
      } else {
        lines.push(`Messages   : ${ctx.conversationHistory.length}`);
      }
      lines.push(
        `Tokens in  : ${ctx.tokenCount.input.toLocaleString()}`,
        `Tokens out : ${ctx.tokenCount.output.toLocaleString()}`,
        `Est. cost  : $${ctx.tokenCount.cost.toFixed(4)}`,
      );
      return { handled: true, output: lines.join('\n') };
    }

    case 'cost': {
      const lines = [
        `Input tokens  : ${ctx.tokenCount.input.toLocaleString()}`,
        `Output tokens : ${ctx.tokenCount.output.toLocaleString()}`,
        `Estimated cost: $${ctx.tokenCount.cost.toFixed(4)} USD`,
      ];
      return { handled: true, output: lines.join('\n') };
    }

    case 'permissions': {
      const [sub, ...parts] = args.split(/\s+/).filter(Boolean);
      const tool = parts.join(' ').trim();
      if (!sub) return { handled: true, output: formatPermissions() };
      if (sub === 'reset') {
        resetPermissions();
        return { handled: true, output: 'Session permissions reset.' };
      }
      if (sub === 'trust-all') {
        trustAllPermissions();
        return { handled: true, output: 'All tools trusted for this session.' };
      }
      if (sub === 'deny-all') {
        denyAllPermissions();
        return { handled: true, output: 'All protected tools denied for this session.' };
      }
      if (sub === 'approve' && tool) {
        approveToolPermission(tool);
        return { handled: true, output: `Approved ${tool} for this session.` };
      }
      if (sub === 'revoke' && tool) {
        revokeToolPermission(tool);
        return { handled: true, output: `Revoked ${tool} for this session.` };
      }
      return { handled: true, output: 'Usage: /permissions [reset|trust-all|deny-all|approve <tool>|revoke <tool>]' };
    }

    case 'config': {
      if (!args) return { handled: true, output: formatConfig(ctx.settings, ctx.currentModel) };
      const [action, key, ...valueParts] = args.split(/\s+/);
      const value = valueParts.join(' ').trim();
      if (action !== 'set' || !key) return { handled: true, output: formatConfig(ctx.settings, ctx.currentModel) };
      const lower = key.toLowerCase();
      let patch: AicoSettings | undefined;
      if (lower === 'model' && value) patch = { model: value };
      else if (lower === 'provider' && value) patch = { provider: value };
      else if (lower === 'workspace') patch = { workspace: { path: value === 'default' || value === 'reset' ? '' : value } };
      else if (lower === 'autoapprove') patch = { autoApprove: value === 'true' || value === 'yes' || value === '1' };
      else if (lower === 'bashtimeout') patch = { bashTimeout: Number(value) };
      else if (lower === 'agenttimeout') patch = { agentTimeout: Number(value) };
      else if (lower === 'autocompact') patch = { autoCompact: { enabled: value !== 'false' && value !== 'off' && value !== '0' } };
      else if (lower === 'autocompactthreshold') patch = { autoCompact: { thresholdTokens: Number(value) } };
      if (!patch) return { handled: true, output: 'Unsupported setting. Use /config to see editable keys.' };
      if ((patch.bashTimeout !== undefined || patch.agentTimeout !== undefined || patch.autoCompact?.thresholdTokens !== undefined) && Number.isNaN(Number(value))) {
        return { handled: true, output: `Expected numeric value for ${key}.` };
      }
      const updated = await saveProjectSettingsPatch(patch);
      if (ctx.settings) Object.assign(ctx.settings, updated);
      if (patch.model) ctx.setModel(patch.model);
      return { handled: true, output: `Saved ${key} to ${getProjectLocalSettingsPath()}.\n\n${formatConfig(updated, ctx.currentModel)}` };
    }

    // /review is handled by the review skill (review.md) via skill dispatch above.
    // The previous multi-agent handler here was unreachable dead code (skills take
    // precedence in the dispatch order). /verify below provides the adversarial
    // second-opinion path.

    case 'verify': {
      const scope = args || 'staged changes';
      return {
        handled: true,
        output: `Starting adversarial verification of ${scope}...`,
        sendAsPrompt: [
          `Use the Task tool to spawn a verification agent (subagent_type: "verification") to adversarially review: ${scope}.`,
          ``,
          `The verification agent should: read the actual changed code, search for bugs/edge-cases/security/concurrency/`,
          `resource-leaks/performance issues, and return a VERDICT: PASS | FAIL | PARTIAL with a severity count.`,
          ``,
          `Scope determination:`,
          `- If "${scope}" is "staged changes": review \`git diff --staged\` (or \`git diff\` if nothing staged).`,
          `- If it's a file path: review that file.`,
          `- If it's a branch: review \`git diff main...${scope}\`.`,
          ``,
          `After the verification agent returns, summarize its verdict and findings. If it found CRITICAL or HIGH issues,`,
          `list them with file:line and the recommended fix. Do NOT fix them yourself unless asked — just report.`,
        ].join('\n'),
      };
    }

    case 'memory': {
      if (args.startsWith('add ') || args === 'add') {
        const text = args.slice(4).trim();
        if (!text) return { handled: true, output: 'Usage: /memory add <text>' };
        await appendToMemory(text, 'project');
        return { handled: true, output: 'Appended to project AICO.md.' };
      }
      if (args === 'clear-cache') {
        clearMemoryCache();
        return { handled: true, output: 'Memory cache cleared.' };
      }
      if (args === 'types') {
        const stats = getCacheStats();
        const lines = [
          `Memory cache stats:`,
          `  Entries  : ${stats.entries}`,
          `  Cache hits: ${stats.hits}`,
          `  Misses   : ${stats.misses}`,
          `  Oldest   : ${Math.round(stats.oldestEntryAge / 1000)}s ago`,
        ];
        return { handled: true, output: lines.join('\n') };
      }
      const memory = await readMemory();
      return {
        handled: true,
        output: memory || '(No memory files found)',
      };
    }

    case 'compact': {
      // Fire PreCompact hook
      if (ctx.settings) {
        await runHooks('PreCompact', { event: 'PreCompact' }, ctx.settings);
      }

      // With a session log attached, the model's context IS the log — compacting
      // the plain message array would report success while shrinking something
      // nothing reads. Compact the log, non-destructively.
      if (ctx.session) {
        const result = maybeCompactSession(ctx.session, ctx.settings, ctx.currentModel, { force: true });
        if (ctx.settings) {
          await runHooks('PostCompact', { event: 'PostCompact' }, ctx.settings);
        }
        return {
          handled: true,
          output: formatCompactionResult(result),
          ...(result.compacted ? { newTokenCount: result.tokensAfter } : {}),
        };
      }

      if (ctx.conversationHistory.length === 0) {
        return { handled: true, output: 'Nothing to compact — conversation history is empty.' };
      }
      const turns = Math.floor(ctx.conversationHistory.length / 2);
      const keepCount = Math.max(2, Math.floor(ctx.conversationHistory.length * 0.2));
      const toSummarise = ctx.conversationHistory.slice(0, -keepCount);
      const toKeep = ctx.conversationHistory.slice(-keepCount);

      const summaryLines: string[] = ['[Compacted conversation summary]'];
      for (const msg of toSummarise) {
        if (msg.role === 'user') {
          summaryLines.push(`User asked: ${msg.content.slice(0, 120)}`);
        } else if (msg.role === 'assistant') {
          summaryLines.push(`Assistant: ${msg.content.slice(0, 200)}`);
        }
      }
      const summary = summaryLines.join('\n');

      const newMessages = [
        { role: 'user', content: summary },
        {
          role: 'assistant',
          content: 'Understood. I have the context from our earlier conversation summarised above.',
        },
        ...toKeep,
      ];
      ctx.replaceHistory(newMessages);

      const newTokenEst = Math.ceil(
        (summary.length + toKeep.reduce((a, m) => a + m.content.length, 0)) / 4,
      );
      // Fire PostCompact hook
      if (ctx.settings) {
        await runHooks('PostCompact', { event: 'PostCompact' }, ctx.settings);
      }
      return {
        handled: true,
        output:
          `Compacted ${turns} turns → summary + ${Math.floor(keepCount / 2)} recent turns kept.\n` +
          `Context reduced to ~${newTokenEst.toLocaleString()} tokens.`,
        newTokenCount: newTokenEst,
      };
    }

    case 'history': {
      const sessions = await listSessions(process.cwd());
      if (sessions.length === 0) {
        return { handled: true, output: 'No sessions found for this project.' };
      }
      const lines = sessions.slice(0, 10).map((s) => {
        const date = new Date(s.startedAt).toLocaleString();
        return `  ${s.id}  ${date}  ${s.model}  (${s.messageCount} messages)`;
      });
      return { handled: true, output: `Recent sessions:\n${lines.join('\n')}` };
    }

    case 'resume': {
      const sessions = await listSessions(process.cwd());
      if (sessions.length === 0) {
        return { handled: true, output: 'No previous sessions found for this project.' };
      }

      if (args) {
        // Direct ID provided — load it
        const session = await loadSession(args, process.cwd());
        if (!session) {
          return { handled: true, output: `Session "${args}" not found.` };
        }
        // A live session log is bound at startup and owns this run's context.
        // Swapping it mid-session would leave the durable log and the model's
        // context describing two different conversations, so say so plainly
        // rather than replacing an array the model does not read and reporting
        // turns that were never loaded.
        if (ctx.session) {
          return {
            handled: true,
            output:
              `Session ${session.id} exists (${Math.floor(session.messages.length / 2)} turns), but it ` +
              `cannot be swapped into a running session — the durable log is bound at startup.\n` +
              `Restart to resume it:\n  aico --resume ${session.id}`,
          };
        }
        // Replace conversation history with resumed session messages
        ctx.replaceHistory(session.messages.map(m => ({ role: m.role, content: m.content })));
        return {
          handled: true,
          output:
            `Resumed session ${session.id} — ` +
            `${Math.floor(session.messages.length / 2)} turns loaded into context.`,
        };
      }

      // No ID — list sessions for the user to pick from
      const lines = sessions.slice(0, 10).map((s, i) => {
        const date = new Date(s.startedAt).toLocaleString();
        const model = s.model.replace('claude-', '').replace('gpt-', 'gpt/');
        return `  [${i + 1}] ${s.id}  ${date}  ${model}  (${s.messageCount} msgs)`;
      });
      return {
        handled: true,
        output:
          `Recent sessions:\n${lines.join('\n')}\n\n` +
          `Use /resume <id> to load a specific session.`,
      };
    }

    case 'init': {
      const filePath = path.join(process.cwd(), 'AICO.md');
      if (fs.existsSync(filePath)) {
        return { handled: true, output: 'AICO.md already exists in this directory.' };
      }
      await writeFile(filePath, CLAUDE_MD_TEMPLATE);
      return { handled: true, output: `Created AICO.md in ${process.cwd()}` };
    }

    case 'provider': {
      const { runProviderSetup, listConfiguredProviders } = await import('./setup.js');
      if (args === 'add' || args === 'setup') {
        // Run wizard — needs to return to REPL after, so just show output
        await runProviderSetup();
        return { handled: true, output: '' };
      }
      const output = await listConfiguredProviders();
      return { handled: true, output };
    }

    case 'agents': {
      const [sub, name, ...valueParts] = args.split(/\s+/).filter(Boolean);
      if (sub === 'show' && name) {
        const spec = await getAgentSpec(name);
        return { handled: true, output: spec ? formatAgentDetails(spec) : `Agent "${name}" not found.` };
      }
      if (sub === 'delete' && name) {
        const deleted = await deleteProjectAgentSpec(name);
        return { handled: true, output: deleted ? `Deleted project agent "${name}".` : `Could not delete "${name}" (only project agents can be deleted).` };
      }
      if (sub === 'skills' && name) {
        const skills = parseCsv(valueParts.join(' '));
        if (!skills.length) return { handled: true, output: 'Usage: /agents skills <name> <skill1,skill2,...>' };
        try {
          const updated = await updateProjectAgentSpec(name, { skills });
          return { handled: true, output: `Updated ${updated.name} skills: ${updated.skills.join(', ')}` };
        } catch (err) {
          return { handled: true, output: err instanceof Error ? err.message : String(err) };
        }
      }
      if (sub === 'tools' && name) {
        const tools = parseCsv(valueParts.join(' '));
        if (!tools.length) return { handled: true, output: 'Usage: /agents tools <name> <Tool1,Tool2,...>' };
        try {
          const updated = await updateProjectAgentSpec(name, { tools });
          return { handled: true, output: `Updated ${updated.name} tools: ${updated.tools.join(', ')}` };
        } catch (err) {
          return { handled: true, output: err instanceof Error ? err.message : String(err) };
        }
      }
      return { handled: true, output: `Agents:\n${formatAgentList(await listAgentSpecs())}` };
    }

    case 'agent-create': {
      const [name, ...descParts] = args.split(/\s+/);
      const description = descParts.join(' ').trim();
      if (!name || !description) {
        return { handled: true, output: 'Usage: /agent-create <name> <role or responsibility>' };
      }
      try {
        const spec = await createAgentSpec({ name, description, scope: 'project' });
        return {
          handled: true,
          output: `Created agent "${spec.name}" in .aico/agents.\nRole: ${spec.role}`,
        };
      } catch (err) {
        return { handled: true, output: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'agent': {
      const [name, ...taskParts] = args.split(/\s+/);
      const task = taskParts.join(' ').trim();
      if (!name || !task) return { handled: true, output: 'Usage: /agent <name> <task>' };
      const spec = await getAgentSpec(name);
      if (!spec) return { handled: true, output: `Agent "${name}" not found. Use /agents to list available agents.` };
      return {
        handled: true,
        output: `Running agent: ${spec.name}`,
        sendAsPrompt: buildAgentChatPrompt({
          agent: spec,
          task,
          availableSkills: skillRegistry.list(),
        }),
      };
    }

    case 'team': {
      if (!args) return { handled: true, output: 'Usage: /team <requirements or mission>' };
      const names = ['product-owner', 'architect', 'backend', 'frontend', 'qa', 'security'];
      const specs = (await Promise.all(names.map((name) => getAgentSpec(name)))).filter(Boolean);
      return {
        handled: true,
        output: 'Starting Product Owner-led agent team orchestration...',
        sendAsPrompt: buildTeamPrompt({
          requirements: args,
          agents: specs as NonNullable<typeof specs[number]>[],
          availableSkills: skillRegistry.list(),
        }),
      };
    }

    case 'mcp': {
      return { handled: true, output: `MCP servers:\n${formatMcpServers()}` };
    }

    case 'mcp-add': {
      try {
        const parsed = parseMcpAddCommand(args);
        const output = await addMcpServer(parsed);
        return { handled: true, output };
      } catch (err) {
        return {
          handled: true,
          output: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case 'mcp-add-playwright': {
      const output = await addMcpServer({ name: 'playwright', preset: 'playwright' });
      return { handled: true, output };
    }

    case 'mcp-create': {
      const [name, ...descParts] = args.split(/\s+/);
      const description = descParts.join(' ').trim();
      if (!name || !description) {
        return { handled: true, output: 'Usage: /mcp-create <name> <what this MCP tool server should do>' };
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return { handled: true, output: 'MCP server name may only contain letters, numbers, underscores, and dashes.' };
      }
      return {
        handled: true,
        output: `Creating MCP server: ${name}`,
        sendAsPrompt: [
          `Create a custom local MCP server named "${name}" for this requirement: ${description}`,
          ``,
          `Implementation rules:`,
          `1. Create it under .aico/mcp-servers/${name}.mjs.`,
          `2. Implement MCP JSON-RPC over stdio with initialize, notifications/initialized, tools/list, and tools/call.`,
          `3. Expose focused tools only for the requested capability, with JSON schemas and clear errors.`,
          `4. Add a small self-test script or command if practical.`,
          `5. Register it by calling McpAddServer with name="${name}", type="stdio", command="node", args=[".aico/mcp-servers/${name}.mjs"].`,
          `6. Call McpReloadServers and report the loaded tool names.`,
          ``,
          `Keep the server dependency-light and local to this repo unless the requirement truly needs an npm package.`,
        ].join('\n'),
      };
    }

    case 'mcp-remove': {
      if (!args) return { handled: true, output: 'Usage: /mcp-remove <name>' };
      const output = await removeMcpServer(args);
      return { handled: true, output };
    }

    case 'mcp-reload': {
      const output = await reloadMcpServers();
      return { handled: true, output: `MCP servers:\n${output}` };
    }

    case 'mcp-security': {
      return { handled: true, output: mcpSecurityReport(ctx.settings) };
    }

    case 'workspace': {
      const info = await ensureWorkspace({
        settings: ctx.settings,
        sessionId: ctx.sessionId,
        cwd: process.cwd(),
      });
      return { handled: true, output: formatWorkspaceInfo(info) };
    }

    case 'workspace-set': {
      const value = args.trim();
      const workspacePath = !value || value === 'default' || value === 'reset' ? undefined : value;
      const output = await setProjectWorkspacePath(workspacePath);
      if (ctx.settings) {
        ctx.settings.workspace = { path: workspacePath ?? '' };
      }
      await ensureWorkspace({
        settings: ctx.settings,
        sessionId: ctx.sessionId,
        cwd: process.cwd(),
      });
      return { handled: true, output };
    }

    case 'capabilities': {
      const workspace = await ensureWorkspace({
        settings: ctx.settings,
        sessionId: ctx.sessionId,
        cwd: process.cwd(),
      });
      return {
        handled: true,
        output: buildCapabilityReport({
          model: ctx.currentModel,
          cwd: process.cwd(),
          sessionId: ctx.sessionId,
          settings: ctx.settings,
          tools: toolDefinitions.map((t) => ({ name: t.name, description: t.description })),
          mcpServers: mcpRegistry.getServerInfos(),
          workspace,
          agents: await listAgentSpecs(),
          skills: skillRegistry.list(),
          cronJobs: cronScheduler.getJobs(),
          backgroundAgents: getBackgroundAgents(),
          subAgents: getAgentRegistry(),
        }),
      };
    }

    case 'transcript': {
      // Render from the log when there is one: the message array never held
      // tool calls, tool results, or turn outcomes, so an array-based export
      // silently omits most of what actually happened.
      const includeHidden = /--all|--full/.test(args);
      const content = ctx.session
        ? serializeSessionTranscript(ctx.session, { includeShadowed: includeHidden })
        : serializeTranscript(ctx.conversationHistory, ctx.sessionId);
      const result = await writeWorkspaceFile({
        path: `reports/transcript-${ctx.sessionId}.md`,
        content,
        scope: 'session',
        settings: ctx.settings,
        sessionId: ctx.sessionId,
        cwd: process.cwd(),
      });
      const note = ctx.session && !includeHidden
        ? ' (visible context only — use /transcript --all for compacted and cleared history)'
        : '';
      return { handled: true, output: `Transcript exported: ${result.path}${note}` };
    }

    case 'debug': {
      const workspace = await ensureWorkspace({
        settings: ctx.settings,
        sessionId: ctx.sessionId,
        cwd: process.cwd(),
      });
      const report = buildCapabilityReport({
        model: ctx.currentModel,
        cwd: process.cwd(),
        sessionId: ctx.sessionId,
        settings: ctx.settings,
        tools: toolDefinitions.map((t) => ({ name: t.name, description: t.description })),
        mcpServers: mcpRegistry.getServerInfos(),
        workspace,
        agents: await listAgentSpecs(),
        skills: skillRegistry.list(),
        cronJobs: cronScheduler.getJobs(),
        backgroundAgents: getBackgroundAgents(),
        subAgents: getAgentRegistry(),
      });
      if (args === 'export') {
        const result = await writeWorkspaceFile({
          path: `reports/debug-${ctx.sessionId}.md`,
          content: report,
          scope: 'session',
          settings: ctx.settings,
          sessionId: ctx.sessionId,
          cwd: process.cwd(),
        });
        return { handled: true, output: `Debug report exported: ${result.path}` };
      }
      return { handled: true, output: report };
    }

    case 'github-action': {
      const dir = path.join(process.cwd(), '.github', 'workflows');
      const filePath = path.join(dir, 'aico.yml');
      if (fs.existsSync(filePath)) {
        return { handled: true, output: `.github/workflows/aico.yml already exists.` };
      }
      await mkdir(dir, { recursive: true });
      const workflow = [
        'name: AICO',
        '',
        'on:',
        '  workflow_dispatch:',
        '    inputs:',
        '      prompt:',
        '        description: AICO task or review prompt',
        '        required: true',
        '        default: Run /review on this repository',
        '  issue_comment:',
        '    types: [created]',
        '',
        'permissions:',
        '  contents: write',
        '  pull-requests: write',
        '  issues: write',
        '',
        'jobs:',
        '  aico:',
        "    if: github.event_name == 'workflow_dispatch' || contains(github.event.comment.body, '@aico')",
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '        with:',
        '          fetch-depth: 0',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 20',
        '      - run: npm ci',
        '      - run: npm run build',
        '      - name: Run AICO',
        '        env:',
        '          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}',
        '          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
        '          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}',
        '        run: |',
        '          PROMPT="${{ github.event.inputs.prompt || github.event.comment.body }}"',
        '          node dist/index.js "$PROMPT"',
      ].join('\n');
      await writeFile(filePath, workflow, 'utf8');
      return { handled: true, output: `Created ${filePath}` };
    }

    case 'ide-bridge': {
      const dir = path.join(process.cwd(), '.vscode');
      const filePath = path.join(dir, 'tasks.json');
      if (fs.existsSync(filePath)) {
        return { handled: true, output: `.vscode/tasks.json already exists. Add AICO tasks manually or move the file before rerunning.` };
      }
      await mkdir(dir, { recursive: true });
      const tasks = {
        version: '2.0.0',
        tasks: [
          {
            label: 'AICO: Review',
            type: 'shell',
            command: 'aico',
            args: ['run', '/review ${workspaceFolder}'],
            problemMatcher: [],
          },
          {
            label: 'AICO: Chat',
            type: 'shell',
            command: 'aico',
            problemMatcher: [],
          },
        ],
      };
      await writeFile(filePath, JSON.stringify(tasks, null, 2), 'utf8');
      return { handled: true, output: `Created ${filePath}` };
    }

    case 'doctor': {
      const checks: string[] = [];

      // 1. Provider / API keys
      const provId    = detectProviderType(ctx.currentModel, ctx.settings);
      const provLabel_ = providerLabel(ctx.currentModel, ctx.settings);
      checks.push(provId
        ? `✓ Provider: ${provLabel_}`
        : `✗ No AI provider configured — set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY`,
      );

      // Show each available key (masked)
      const keyChecks: Array<[string, string | undefined]> = [
        ['OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY],
        ['ANTHROPIC_API_KEY',  process.env.ANTHROPIC_API_KEY],
        ['OPENAI_API_KEY',     process.env.OPENAI_API_KEY],
        ['GEMINI_API_KEY',     process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY],
      ];
      for (const [name, val] of keyChecks) {
        if (val) checks.push(`  ✓ ${name} (${val.slice(0, 8)}…)`);
      }

      // 2. GITHUB_TOKEN (optional, for git ops)
      const ghToken = process.env.GITHUB_TOKEN;
      checks.push(ghToken
        ? `✓ GITHUB_TOKEN set (optional — git ops)`
        : `  GITHUB_TOKEN not set (optional)`,
      );

      // 3. Node version
      const nodeVer = process.version;
      const [major] = nodeVer.slice(1).split('.').map(Number);
      checks.push(major >= 18
        ? `✓ Node.js ${nodeVer}`
        : `✗ Node.js ${nodeVer} — requires v18+`,
      );

      // 4. Settings file
      const settingsPath = path.join(process.cwd(), '.aico', 'settings.json');
      checks.push(fs.existsSync(settingsPath)
        ? `✓ .aico/settings.json found`
        : `  .aico/settings.json not found (optional)`,
      );

      // 5. AICO.md / CLAUDE.md
      const aicoMd  = path.join(process.cwd(), 'AICO.md');
      const claudeMd = path.join(process.cwd(), 'CLAUDE.md');
      checks.push(fs.existsSync(aicoMd) || fs.existsSync(claudeMd)
        ? `✓ AICO.md found — project memory loaded`
        : `  AICO.md not found (run /init to create one)`,
      );

      // 6. Global AICO.md
      const homeAico = path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? '',
        '.aico',
        'AICO.md',
      );
      checks.push(fs.existsSync(homeAico)
        ? `✓ ~/.aico/AICO.md found — user memory loaded`
        : `  ~/.aico/AICO.md not found (optional global memory)`,
      );

      // 7. Model
      checks.push(`✓ Model: ${ctx.currentModel}`);

      // 8. Settings source audit
      const audit = getSettingsAudit();
      if (audit) {
        checks.push('');
        checks.push('Settings sources:');
        for (const src of audit.sources) {
          const status   = src.found ? '✓' : ' ';
          const keys     = src.keys.length > 0 ? ` (${src.keys.join(', ')})` : '';
          const shortPath = src.path.replace(process.env.HOME ?? process.env.USERPROFILE ?? '', '~');
          checks.push(`  ${status} ${shortPath}${keys}`);
        }
      }

      return {
        handled: true,
        output: `aico Doctor\n${'─'.repeat(40)}\n${checks.join('\n')}`,
      };
    }

    case 'studio': {
      const workspace = await ensureWorkspace({
        settings: ctx.settings,
        sessionId: ctx.sessionId,
        cwd: process.cwd(),
      });
      const result = await handleStudio(args, workspace.commonDir);
      return {
        handled: result.handled,
        output: result.output,
        sendAsPrompt: result.sendAsPrompt,
      };
    }

    case 'scaffold': {
      return handleScaffold(args);
    }

    // ── Skills commands ───────────────────────────────────────────────
    case 'skills': {
      if (args === 'reload') {
        await skillRegistry.reload();
        const list = skillRegistry.list();
        return { handled: true, output: `Skills reloaded. ${list.length} available.` };
      }
      const list = skillRegistry.list();
      if (!list.length) return { handled: true, output: '(No skills loaded)' };
      const lines = list.map((s) => {
        const aliases = s.frontmatter.aliases?.length ? ` (${s.frontmatter.aliases.join(', ')})` : '';
        const tag = s.isBuiltin ? '[builtin]' : '[user]';
        return `  /${s.frontmatter.name}${aliases}  ${tag}  — ${s.frontmatter.description}`;
      });
      return { handled: true, output: `Available skills (${list.length}):\n${lines.join('\n')}` };
    }

    case 'skill-install': {
      if (!args) return { handled: true, output: 'Usage: /skill-install <url>' };
      try {
        const skill = await skillRegistry.install(args);
        return { handled: true, output: `Installed skill: ${skill.frontmatter.name}` };
      } catch (err) {
        return { handled: true, output: `Failed to install skill: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // ── Background agents commands ────────────────────────────────────
    case 'bg-agents': {
      const records = await new Promise<import('./background/index.js').BackgroundAgentRecord[]>((resolve) => {
        const unsub = subscribeToBackgroundAgents((recs) => { resolve(recs); unsub(); });
      });
      if (!records.length) return { handled: true, output: '(No background agents)' };
      const lines = records.slice(0, 10).map((r) => {
        const elapsed = Math.round((Date.now() - r.startedAt) / 1000);
        return `  [${r.agentId.slice(0, 8)}] ${r.status.padEnd(9)} ${r.description.slice(0, 40)} (${elapsed}s, ${r.toolCallCount} ops)`;
      });
      return { handled: true, output: `Background agents:\n${lines.join('\n')}` };
    }

    case 'bg-cancel': {
      if (!args) return { handled: true, output: 'Usage: /bg-cancel <agentId>' };
      const cancelled = cancelBackgroundAgent(args);
      return { handled: true, output: cancelled ? `Cancelled agent ${args}.` : `Agent "${args}" not found.` };
    }

    // ── Worktree commands ─────────────────────────────────────────────
    case 'worktrees': {
      const records = worktreeManager.getAll();
      if (!records.length) return { handled: true, output: '(No worktrees)' };
      const lines = records.map((r) =>
        `  [${r.worktreeId}] ${r.status.padEnd(8)} ${r.path.split(/[\\/]/).slice(-2).join('/')} → ${r.branch}`,
      );
      return { handled: true, output: `Worktrees:\n${lines.join('\n')}` };
    }

    case 'worktree-cleanup': {
      if (!args) return { handled: true, output: 'Usage: /worktree-cleanup <worktreeId>' };
      try {
        const result = await worktreeManager.cleanupWorktree(args, { cwd: process.cwd() });
        return { handled: true, output: result.cleaned ? `Cleaned worktree ${args}.` : `Worktree "${args}" not found.` };
      } catch (err) {
        return { handled: true, output: `Cleanup failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // ── Cron commands ────────────────────────────────────────────────
    case 'cron': {
      const jobs = cronScheduler.getJobs();
      if (!jobs.length) return { handled: true, output: '(No scheduled jobs)\nUse CronCreate tool or /cron-create to schedule tasks.' };
      const lines = jobs.map((j) => {
        const next = j.nextRun ? new Date(j.nextRun).toLocaleString() : 'unknown';
        return `  [${j.id.slice(0, 8)}] ${j.status.padEnd(7)} ${j.name.padEnd(20)} ${j.schedule.padEnd(14)} next: ${next}`;
      });
      return { handled: true, output: `Scheduled jobs (${jobs.length}):\n${lines.join('\n')}` };
    }

    case 'cron-delete': {
      if (!args) return { handled: true, output: 'Usage: /cron-delete <jobId>' };
      await cronScheduler.deleteJob(args);
      return { handled: true, output: `Deleted cron job ${args}.` };
    }

    case 'cron-pause': {
      if (!args) return { handled: true, output: 'Usage: /cron-pause <jobId>' };
      await cronScheduler.pauseJob(args);
      return { handled: true, output: `Paused cron job ${args}.` };
    }

    case 'cron-resume': {
      if (!args) return { handled: true, output: 'Usage: /cron-resume <jobId>' };
      await cronScheduler.resumeJob(args);
      return { handled: true, output: `Resumed cron job ${args}.` };
    }

    case 'security-audit': {
      const scope = args || process.cwd();
      return {
        handled: true,
        output: 'Starting security audit...',
        sendAsPrompt: [
          `Run a comprehensive defensive security audit of this codebase.`,
          `Use the Task tool with subagent_type: "security-audit" to spawn a security audit agent.`,
          `The agent should analyze: ${scope}`,
          ``,
          `Pass this prompt to the security-audit agent:`,
          `"Perform a full defensive security audit of the codebase at ${scope}.`,
          `Scan all source files for vulnerabilities. Run npm audit if package.json exists.`,
          `Check for hardcoded secrets, OWASP Top 10 issues, dependency CVEs, misconfigurations.`,
          `Report findings organized by severity with exact file:line locations."`,
        ].join('\n'),
      };
    }

    default:
      return {
        handled: true,
        output: `Unknown command: /${cmd}\nType /help for available commands.`,
      };
  }
}
