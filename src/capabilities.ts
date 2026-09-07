import type { AicoSettings } from './settings.js';
import type { WorkspaceInfo } from './workspace.js';
import type { McpServerInfo } from './mcp/registry.js';
import type { AgentSpec } from './agents/types.js';
import type { Skill } from './skills/types.js';
import type { CronJob } from './cron/types.js';
import type { BackgroundAgentRecord } from './background/index.js';
import type { SubAgentRecord } from './tools/task.js';

export interface CapabilityToolSummary {
  name: string;
  description: string;
}

export const SLASH_COMMAND_NAMES = [
  '/help', '/exit', '/clear', '/compact', '/model', '/plan', '/status', '/cost',
  '/permissions', '/config', '/review', '/app', '/security-audit', '/memory', '/history', '/resume',
  '/init', '/provider', '/agents', '/agent-create', '/agent',
  '/mcp', '/mcp-add', '/mcp-create', '/mcp-remove',
  '/mcp-reload', '/mcp-security', '/workspace', '/workspace-set', '/capabilities', '/transcript', '/debug',
  '/github-action', '/ide-bridge', '/doctor',
  '/skills', '/skill-install', '/bg-agents', '/bg-cancel', '/worktrees',
  '/worktree-cleanup', '/cron', '/cron-create', '/cron-delete', '/cron-pause',
  '/cron-resume',
];

export function buildCapabilityReport(input: {
  model?: string;
  cwd?: string;
  sessionId?: string;
  settings?: AicoSettings;
  tools: CapabilityToolSummary[];
  mcpServers: McpServerInfo[];
  workspace: WorkspaceInfo;
  agents?: AgentSpec[];
  skills?: Skill[];
  cronJobs?: CronJob[];
  backgroundAgents?: BackgroundAgentRecord[];
  subAgents?: SubAgentRecord[];
}): string {
  const mcpLines = input.mcpServers.length
    ? input.mcpServers.map((s) => `  ${s.name}: ${s.health}, ${s.toolCount} tool(s), ${s.resourceCount} resource(s)`)
    : ['  (none loaded)'];

  const toolLines = input.tools
    .map((t) => `  ${t.name} - ${t.description.slice(0, 110)}`)
    .join('\n');

  const settingsKeys = input.settings ? Object.keys(input.settings) : [];
  const agents = input.agents ?? [];
  const skills = input.skills ?? [];
  const cronJobs = input.cronJobs ?? [];
  const backgroundAgents = input.backgroundAgents ?? [];
  const subAgents = input.subAgents ?? [];

  return [
    'AICO Capability Report',
    '----------------------',
    `Model       : ${input.model ?? '(unknown)'}`,
    `CWD         : ${input.cwd ?? process.cwd()}`,
    `Session ID  : ${input.sessionId ?? '(none)'}`,
    `Workspace   : ${input.workspace.root}`,
    `Tools       : ${input.tools.length} built-in/managed tool(s)`,
    `Agents      : ${agents.length} specialist agent(s)`,
    `Skills      : ${skills.length} skill(s)`,
    `Commands    : ${SLASH_COMMAND_NAMES.length} slash command(s)`,
    `Settings    : ${settingsKeys.length ? settingsKeys.join(', ') : '(none loaded)'}`,
    '',
    'Workspace Layout:',
    `  common   : ${input.workspace.commonDir}`,
    `  sessions : ${input.workspace.sessionsDir}`,
    ...(input.workspace.sessionDir ? [
      `  current  : ${input.workspace.sessionDir}`,
      `  artifacts: ${input.workspace.artifactsDir}`,
      `  reports  : ${input.workspace.reportsDir}`,
      `  logs     : ${input.workspace.logsDir}`,
      `  scratch  : ${input.workspace.scratchDir}`,
    ] : []),
    '',
    'MCP Servers:',
    ...mcpLines,
    '',
    'Agents:',
    ...(agents.length ? agents.map((a) => `  ${a.name}: ${a.role}`) : ['  (none loaded)']),
    '',
    'Skills:',
    ...(skills.length ? skills.map((s) => `  ${s.frontmatter.name}: ${s.frontmatter.description}`) : ['  (none loaded)']),
    '',
    'Background Operations:',
    ...(backgroundAgents.length ? backgroundAgents.map((a) => `  ${a.agentId.slice(0, 8)} ${a.status} ${a.description}`) : ['  background agents: none']),
    ...(subAgents.length ? subAgents.map((a) => `  sub ${a.agentId} ${a.status} ${a.description}`) : ['  sub-agents: none']),
    '',
    'Cron Jobs:',
    ...(cronJobs.length ? cronJobs.map((j) => `  ${j.id.slice(0, 8)} ${j.status} ${j.name} ${j.schedule}`) : ['  (none scheduled)']),
    '',
    'Slash Commands:',
    `  ${SLASH_COMMAND_NAMES.join('  ')}`,
    '',
    'Tools:',
    toolLines,
  ].join('\n');
}

export interface RuntimeBlocksInput {
  model?: string;
  cwd?: string;
  sessionId?: string;
  settings?: AicoSettings;
  tools: CapabilityToolSummary[];
  mcpServers: McpServerInfo[];
  workspace: WorkspaceInfo;
  agents: AgentSpec[];
  skills: Skill[];
  cronJobs: CronJob[];
  backgroundAgents: BackgroundAgentRecord[];
  subAgents: SubAgentRecord[];
  /** Discrete memories that apply to this project and session. */
  memories?: Array<{ id: string; scope: string; text: string }>;
}

/**
 * The runtime facts, split by how often they change — which decides where
 * they are sent.
 *
 * `runtime`, `operatingProcesses` and `remembered` are stable for the life of a
 * session (a memory saved mid-session moves the prefix once, deliberately) and
 * belong in the cached system prompt. `mcpHealth` is the one line that can
 * change between steps and rides in the volatile tail. Slash commands and the
 * tool roster are not here at all any more: the model cannot run a slash
 * command, and the tool names duplicate the schemas the request already
 * carries — together they were half the tail, paid on every step.
 */
export interface RuntimeBlocks {
  /** Model, directory, session, workspace, agents, skills, cron — the identity of this run. */
  runtime: string;
  /** The handful of process decisions the model actually has to make. */
  operatingProcesses: string;
  /** What the user asked to be remembered, or empty. */
  remembered: string;
  /** MCP server health, or empty when none is configured. */
  mcpHealth: string;
}

/** The six decisions worth stating. Everything else is in the tool descriptions. */
const OPERATING_PROCESSES = [
  '<process name="single-agent">Do small or tightly-coupled work yourself with direct tools.</process>',
  '<process name="sub-agents">Task spawns one isolated specialist (subagent_type, agent_name or agent_spec) with complete context; Investigate is the read-only fan-out for research. No role-based build teams.</process>',
  '<process name="apps">Build applications with AppManage: a template first (zero-token skeleton with a worked feature, tests and a Dockerfile), one writing agent, RunChecks, then start and VerifyApp. The whole platform — kinds, templates, files, the workspace panel the person sees, the gates — is Skill app-platform; read it once before working on an app.</process>',
  '<process name="skills">Prefer a skill over working the procedure out again; a skill flagged as matching the request is the first thing to consider. SkillManage creates and registers them.</process>',
  '<process name="memory">MemoryManage remembers durable facts by scope (global, project, session). Remember when told to, and when a fact will still be true next week.</process>',
  '<process name="mcp">Use MCP tools when loaded; McpManage changes what is connected. WorkspaceWrite keeps durable reports and handoffs.</process>',
].join('\n');

export function buildRuntimeBlocks(input: RuntimeBlocksInput): RuntimeBlocks {
  const agents = input.agents.map((a) => `${a.name}(${a.role})`).join('; ') || 'none';
  const skills = input.skills.map((s) => s.frontmatter.name).join(', ') || 'none';
  const cron = input.cronJobs.map((j) => `${j.name}:${j.status}:${j.schedule}`).join('; ') || 'none';
  const mcp = input.mcpServers.map((s) => `${s.name}:${s.health}/${s.toolCount} tools`).join(', ');

  // Memories are rendered as their own block rather than squeezed into an
  // attribute list. They are the only part of this that is an *instruction* —
  // "deploys happen on Fridays" changes what the agent should do — and a fact
  // that reads as metadata gets skimmed like metadata. Ordered narrowest-last
  // by the store, so when two disagree the more specific one is read last.
  const remembered = (input.memories ?? []).length
    ? [
      '<!-- Things this user asked to be remembered. Treat them as true unless',
      '     the conversation contradicts them; the later ones are more specific. -->',
      ...input.memories!.map(m =>
        `<memory id="${m.id}" scope="${m.scope}">${m.text.replace(/\s*\n+\s*/g, ' ').trim()}</memory>`),
    ].join('\n')
    : '';

  return {
    runtime: [
      `<model>${input.model ?? 'unknown'}</model>`,
      `<cwd>${input.cwd ?? process.cwd()}</cwd>`,
      `<session_id>${input.sessionId ?? 'none'}</session_id>`,
      `<workspace>${input.workspace.root}</workspace>`,
      `<agents>${agents}</agents>`,
      `<skills>${skills}</skills>`,
      `<cron_jobs>${cron}</cron_jobs>`,
      // Background and sub-agent rosters used to be listed here as well. They
      // are not any more: the `<running_work>` block built from the work
      // ledger is the one view, and it knows things these lines could not.
    ].join('\n'),
    operatingProcesses: OPERATING_PROCESSES,
    remembered,
    mcpHealth: mcp ? `<mcp_servers>${mcp}</mcp_servers>` : '',
  };
}

/**
 * The blocks as one document — for tests and diagnostics.
 *
 * Production sends the parts separately (see {@link buildRuntimeBlocks}); this
 * exists so "does a memory reach the prompt" can be asked of one string.
 */
export function buildRuntimeAwareness(input: RuntimeBlocksInput): string {
  const b = buildRuntimeBlocks(input);
  return [
    '<aico_runtime_awareness>',
    b.runtime,
    b.mcpHealth,
    b.remembered ? `<remembered>\n${b.remembered}\n</remembered>` : '',
    `<operating_processes>\n${b.operatingProcesses}\n</operating_processes>`,
    '</aico_runtime_awareness>',
  ].filter(Boolean).join('\n');
}
