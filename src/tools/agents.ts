import { createAgentSpec, formatAgentList, getAgentSpec, listAgentSpecs } from '../agents/registry.js';
import type { AgentCreateInput } from '../agents/types.js';
import { buildAgentChatPrompt, buildTeamPrompt } from '../agents/prompts.js';
import { skillRegistry } from '../skills/index.js';

export const agentCreateToolDefinition = {
  name: 'AgentCreate',
  description: 'Create or update a reusable AICO agent spec with role, goals, skills, tools, XML system prompt, and report format.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Agent name, e.g. payments-backend or qa-lead.' },
      description: { type: 'string', description: 'What this agent is responsible for.' },
      role: { type: 'string', description: 'Precise role title/persona.' },
      goals: { type: 'array', items: { type: 'string' }, description: 'Concrete goals this agent optimizes for.' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Skill names or capabilities this agent should know.' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Tool names or tool categories this agent may use.' },
      canDelegate: { type: 'boolean', description: 'Whether this agent may engage other agents via Task.' },
      reportFormat: { type: 'string', description: 'Required final report format.' },
      model: { type: 'string', description: 'Optional: pin this agent to a specific model (e.g. "glm-4.6", "claude-sonnet-5"). When spawned via Task agent_name, this model is used.' },
      scope: { type: 'string', enum: ['user', 'project'], description: 'Where to store the agent. Defaults to project.' },
    },
    required: ['name', 'description'],
  },
};

export const agentListToolDefinition = {
  name: 'AgentList',
  description: 'List built-in and custom AICO agents available to the current project.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

export const agentReadToolDefinition = {
  name: 'AgentRead',
  description: 'Read a full AICO agent spec including XML system prompt, skills, tools, and report contract.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Agent name.' },
    },
    required: ['name'],
  },
};

export const agentPromptToolDefinition = {
  name: 'AgentPrompt',
  description: 'Build the XML prompt for chatting with one agent on a task. The caller should execute or send this prompt next.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Agent name.' },
      task: { type: 'string', description: 'Task for that agent.' },
    },
    required: ['name', 'task'],
  },
};

export const teamPromptToolDefinition = {
  name: 'TeamPrompt',
  description: 'Build a powerful XML team-orchestration prompt led by Product Owner with specialist agents, QA, security, and repair loops.',
  inputSchema: {
    type: 'object',
    properties: {
      requirements: { type: 'string', description: 'User requirements or mission for the agent team.' },
      agents: { type: 'array', items: { type: 'string' }, description: 'Optional agent names. Defaults to product-owner, architect, backend, frontend, qa, security.' },
    },
    required: ['requirements'],
  },
};

export async function executeAgentCreate(args: AgentCreateInput): Promise<string> {
  const spec = await createAgentSpec(args);
  return `Agent "${spec.name}" saved (${spec.source}).\nRole: ${spec.role}\nSkills: ${spec.skills.join(', ') || '(none)'}`;
}

export async function executeAgentList(): Promise<string> {
  return `Agents:\n${formatAgentList(await listAgentSpecs())}`;
}

export async function executeAgentRead(args: { name: string }): Promise<string> {
  const spec = await getAgentSpec(args.name);
  if (!spec) return `Agent "${args.name}" not found.`;
  return JSON.stringify(spec, null, 2);
}

export async function executeAgentPrompt(args: { name: string; task: string }): Promise<string> {
  const spec = await getAgentSpec(args.name);
  if (!spec) return `Agent "${args.name}" not found.`;
  return buildAgentChatPrompt({
    agent: spec,
    task: args.task,
    availableSkills: skillRegistry.list(),
  });
}

export async function executeTeamPrompt(args: { requirements: string; agents?: string[] }): Promise<string> {
  const names = args.agents?.length
    ? args.agents
    : ['product-owner', 'architect', 'backend', 'frontend', 'qa', 'security'];
  const specs = (await Promise.all(names.map((name) => getAgentSpec(name)))).filter(Boolean);
  return buildTeamPrompt({
    requirements: args.requirements,
    agents: specs.length ? specs as NonNullable<typeof specs[number]>[] : await listAgentSpecs(),
    availableSkills: skillRegistry.list(),
  });
}
