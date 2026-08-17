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
  '/permissions', '/config', '/review', '/studio', '/scaffold', '/security-audit', '/memory', '/history', '/resume',
  '/init', '/provider', '/agents', '/agent-create', '/agent', '/team',
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

export function buildRuntimeAwareness(input: {
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
}): string {
  const enabledTools = input.tools.map((t) => t.name).join(', ');
  const agents = input.agents.map((a) => `${a.name}(${a.role})`).join('; ') || 'none';
  const skills = input.skills.map((s) => s.frontmatter.name).join(', ') || 'none';
  const mcp = input.mcpServers.map((s) => `${s.name}:${s.health}/${s.toolCount} tools`).join(', ') || 'none';
  const cron = input.cronJobs.map((j) => `${j.name}:${j.status}:${j.schedule}`).join('; ') || 'none';
  const bg = input.backgroundAgents.map((a) => `${a.agentId.slice(0, 8)}:${a.status}:${a.description}`).join('; ') || 'none';
  const subs = input.subAgents.map((a) => `${a.agentId}:${a.status}:${a.agentType}:${a.description}`).join('; ') || 'none';

  return [
    '<aico_runtime_awareness>',
    `  <model>${input.model ?? 'unknown'}</model>`,
    `  <cwd>${input.cwd ?? process.cwd()}</cwd>`,
    `  <session_id>${input.sessionId ?? 'none'}</session_id>`,
    `  <workspace>${input.workspace.root}</workspace>`,
    `  <commands>${SLASH_COMMAND_NAMES.join(', ')}</commands>`,
    `  <tools>${enabledTools}</tools>`,
    `  <agents>${agents}</agents>`,
    `  <skills>${skills}</skills>`,
    `  <mcp_servers>${mcp}</mcp_servers>`,
    `  <cron_jobs>${cron}</cron_jobs>`,
    `  <background_agents>${bg}</background_agents>`,
    `  <sub_agents>${subs}</sub_agents>`,
    '  <operating_processes>',
    '    <process name="single-agent">Use direct tools for small or tightly-coupled work.</process>',
    '    <process name="sub-agents">Use Task for isolated specialist work. Spawn by subagent_type (devops, devsecops, review, backend, frontend, qa, etc.), agent_name (a registered custom agent), or agent_spec (a fully custom inline agent with custom instructions, tools, and model). Pass complete context.</process>',
    '    <process name="agent-creation">Use AgentCreate to mint new specialist agents with custom roles, tools, skills, and pinned models. Created agents are immediately spawnable via Task agent_name. Assign skills to agents to give them specialized procedures — the skill prompt content is injected at spawn time.</process>',
    '    <process name="skill-creation">Use SkillCreate to write reusable prompt templates that become /commands or auto-triggers. Skills are saved to disk and immediately available. Assign them to agents or invoke them directly.</process>',
    '    <process name="pipeline-creation">Write .aico/pipeline.json to define custom SDLC pipelines with phases, per-phase agent types and models, conditions, and attached docs/policies. Run with /studio.</process>',
    '    <process name="teams">Use TeamPrompt or /team for Product Owner-led multi-agent work with QA/security gates and repair loops.</process>',
    '    <process name="skills">Use skill prompts when a user invokes a skill or when a skill clearly matches the task.</process>',
    '    <process name="workspace">Use WorkspaceWrite for durable reports, QA evidence, handoffs, and long-running operation notes.</process>',
    '    <process name="mcp">Use MCP tools when loaded; use McpAddServer/McpReloadServers when the user asks to add capability.</process>',
    '    <process name="cron-background">Cron jobs spawn background agents; use /cron and /bg-agents or tools to inspect and manage them.</process>',
    '  </operating_processes>',
    '</aico_runtime_awareness>',
  ].join('\n');
}
