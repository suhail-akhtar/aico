/**
 * Everything a person can ask to have done to their agents.
 *
 * Third instance of the same shape, and by now the shape is the argument: one
 * tool, one action enum, the same verbs every registry has. Someone who has
 * learned `SkillManage` already knows this one.
 *
 * **An agent's skills are part of its definition.** `AgentSpec.skills` names
 * the procedures that agent should reach for, which is what makes a specialist
 * more than a system prompt with opinions — so `create` and `update` take them,
 * and both check the names actually exist. A skill list that quietly contains a
 * typo produces an agent that is subtly less capable than intended, and nothing
 * would ever say so.
 *
 * **Built-in agents cannot be edited or deleted, only disabled.** They ship
 * with AICO, so "delete" would mean "until the next install".
 *
 * @module tools/manage-agents
 */

import fs from 'fs';
import path from 'path';
import {
  listAgentSpecs,
  getAgentSpec,
  createAgentSpec,
  deleteProjectAgentSpec,
  updateProjectAgentSpec,
} from '../agents/registry.js';
import { skillRegistry } from '../skills/index.js';
import { disabledIn, isDisabled, setEnabled, forget } from '../registry-state.js';
import { currentCwd } from '../run-context.js';

export interface AgentManageInput {
  action: 'list' | 'read' | 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'export' | 'import';
  name?: string;
  description?: string;
  role?: string;
  goals?: string[];
  skills?: string[];
  tools?: string[];
  canDelegate?: boolean;
  reportFormat?: string;
  model?: string;
  scope?: 'user' | 'project';
  path?: string;
}

/** Skill names that do not exist, so a typo is caught where it is made. */
function unknownSkills(names: string[]): string[] {
  return names.filter(skill => !skillRegistry.lookup(skill));
}

export async function executeAgentManage(input: AgentManageInput): Promise<string> {
  const cwd = currentCwd();
  const name = input.name?.trim() ?? '';

  switch (input.action) {
    case 'list': {
      const specs = await listAgentSpecs(cwd);
      if (specs.length === 0) return 'No agents defined.';
      const off = disabledIn('agents');
      return [
        `${specs.length} agent(s):`,
        ...specs.map(spec => {
          const marked = off.has(spec.name.toLowerCase()) ? ' [disabled]' : '';
          const skills = spec.skills?.length ? ` — skills: ${spec.skills.join(', ')}` : '';
          return `- ${spec.name} (${spec.source})${marked}: ${spec.description}${skills}`;
        }),
      ].join('\n');
    }

    case 'read': {
      const spec = await getAgentSpec(name, cwd);
      if (!spec) return `There is no agent called "${name}". Use action:"list".`;
      return [
        `name: ${spec.name}`,
        `description: ${spec.description}`,
        `source: ${spec.source}`,
        `enabled: ${!isDisabled('agents', spec.name)}`,
        `role: ${spec.role}`,
        spec.model ? `model: ${spec.model}` : '',
        spec.goals?.length ? `goals:\n${spec.goals.map(g => `  - ${g}`).join('\n')}` : '',
        spec.skills?.length ? `skills: ${spec.skills.join(', ')}` : '',
        spec.tools?.length ? `tools: ${spec.tools.join(', ')}` : '',
        `canDelegate: ${spec.canDelegate}`,
        spec.reportFormat ? `reportFormat: ${spec.reportFormat}` : '',
      ].filter(Boolean).join('\n');
    }

    case 'create': {
      if (!name) return 'A name is required.';
      if (!input.description?.trim()) {
        return 'A description is required — it is what decides whether this agent is the right one '
          + 'to hand a task to.';
      }
      const existing = await getAgentSpec(name, cwd);
      if (existing) {
        return `An agent called "${name}" already exists (${existing.source}). `
          + 'Use action:"update" to change it.';
      }
      const missing = unknownSkills(input.skills ?? []);
      if (missing.length) {
        return `Not created — these skills do not exist: ${missing.join(', ')}. `
          + 'Create them first with SkillManage, or leave them out. An agent pointed at a skill that '
          + 'is not there is quietly less capable than it looks.';
      }

      const spec = await createAgentSpec({
        name,
        description: input.description,
        role: input.role,
        goals: input.goals,
        skills: input.skills,
        tools: input.tools,
        canDelegate: input.canDelegate,
        reportFormat: input.reportFormat,
        model: input.model,
        scope: input.scope ?? 'user',
      }, cwd);

      return [
        `Created agent "${spec.name}" (${spec.source}).`,
        spec.skills?.length ? `It will reach for: ${spec.skills.join(', ')}.` : '',
        `Hand it work with AgentPrompt name:"${spec.name}".`,
      ].filter(Boolean).join('\n');
    }

    case 'update': {
      const spec = await getAgentSpec(name, cwd);
      if (!spec) return `There is no agent called "${name}".`;
      if (spec.source === 'builtin') {
        return `"${name}" is built in and cannot be edited. Create your own agent instead, or disable this one.`;
      }
      const missing = unknownSkills(input.skills ?? []);
      if (missing.length) return `Not updated — these skills do not exist: ${missing.join(', ')}.`;

      // Only what was named changes; everything else stands. Wrapped because
      // the registry throws for the cases it refuses, and a tool that throws
      // ends the turn instead of telling the model what to do differently.
      try {
      const updated = await updateProjectAgentSpec(name, {
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.goals !== undefined ? { goals: input.goals } : {}),
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.canDelegate !== undefined ? { canDelegate: input.canDelegate } : {}),
        ...(input.reportFormat !== undefined ? { reportFormat: input.reportFormat } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      }, cwd);
        return updated ? `Updated agent "${name}".` : `Could not update "${name}".`;
      } catch (err) {
        return `Not updated: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'delete': {
      const spec = await getAgentSpec(name, cwd);
      if (!spec) return `There is no agent called "${name}".`;
      if (spec.source === 'builtin') {
        return `"${name}" is built in and cannot be deleted — it would come back on the next install. `
          + 'Disable it instead.';
      }
      const done = await deleteProjectAgentSpec(name, cwd);
      if (done) forget('agents', name);
      return done ? `Deleted agent "${name}".` : `Could not delete "${name}".`;
    }

    case 'enable':
    case 'disable': {
      const spec = await getAgentSpec(name, cwd);
      if (!spec) return `There is no agent called "${name}".`;
      const wanted = input.action === 'enable';
      const changed = setEnabled('agents', spec.name, wanted);
      return changed
        ? `"${spec.name}" is now ${wanted ? 'enabled' : 'disabled'}.`
        : `"${spec.name}" was already ${wanted ? 'enabled' : 'disabled'}.`;
    }

    case 'export': {
      if (!input.path) return 'A path is required — where to write the JSON.';
      const specs = await listAgentSpecs(cwd);
      const chosen = name ? specs.filter(s => s.name.toLowerCase() === name.toLowerCase()) : specs;
      if (name && chosen.length === 0) return `There is no agent called "${name}".`;

      const target = path.resolve(input.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // The generated XML is left out: it is derived from the rest, and shipping
      // it would freeze a rendering that the importing install may do better.
      fs.writeFileSync(target, JSON.stringify({
        agents: chosen.map(({ systemPromptXml: _drop, source: _src, ...rest }) => rest),
      }, null, 2), 'utf8');
      return `Exported ${chosen.length} agent(s) to ${target}.`;
    }

    case 'import': {
      if (!input.path) return 'A path is required — the JSON file to read.';
      const target = path.resolve(input.path);
      if (!fs.existsSync(target)) return `${target} does not exist.`;
      let parsed: { agents?: Array<Record<string, unknown>> };
      try { parsed = JSON.parse(fs.readFileSync(target, 'utf8')); }
      catch (err) { return `${target} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`; }

      const incoming = parsed.agents ?? [];
      if (incoming.length === 0) return 'That file defines no agents.';

      const added: string[] = [];
      const skipped: string[] = [];
      for (const raw of incoming) {
        const agentName = String(raw['name'] ?? '').trim();
        if (!agentName) { skipped.push('(unnamed)'); continue; }
        if (await getAgentSpec(agentName, cwd)) { skipped.push(`${agentName} (already exists)`); continue; }
        const missing = unknownSkills((raw['skills'] as string[]) ?? []);
        try {
          await createAgentSpec({
            ...(raw as unknown as Parameters<typeof createAgentSpec>[0]),
            name: agentName,
            // A skill that did not come along is dropped rather than left
            // dangling, and named below so it is not a silent difference.
            skills: ((raw['skills'] as string[]) ?? []).filter(s => !missing.includes(s)),
            scope: input.scope ?? 'user',
          }, cwd);
          added.push(missing.length ? `${agentName} (without missing skills: ${missing.join(', ')})` : agentName);
        } catch (err) {
          skipped.push(`${agentName} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      return [
        added.length ? `Imported: ${added.join('; ')}` : '',
        skipped.length ? `Skipped: ${skipped.join('; ')}` : '',
      ].filter(Boolean).join('\n');
    }

    default:
      return `Unknown action "${String(input.action)}".`;
  }
}

export const agentManageToolDefinition = {
  name: 'AgentManage',
  description: [
    'Manage the agents available to delegate to: list, read, create, update, delete, enable, disable,',
    'export and import. Use this whenever someone asks what agents exist, or asks to make, change,',
    'remove, or switch one off. An agent can be given skills it should reach for, and those names are',
    'checked. To actually hand work to an agent, use AgentPrompt instead.',
  ].join(' '),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'create', 'update', 'delete', 'enable', 'disable', 'export', 'import'],
        description:
          'list: every agent and whether it is enabled. read: one in full. create: define a new one. '
          + 'update: change one. delete: remove it. enable/disable: switch without deleting. '
          + 'export/import: JSON files.',
      },
      name: { type: 'string', description: 'Which agent. Required for everything except list and import.' },
      description: { type: 'string', description: 'What this agent is for — it decides when to hand it a task.' },
      role: { type: 'string', description: 'The role it plays, e.g. "senior backend engineer".' },
      goals: { type: 'array', items: { type: 'string' }, description: 'What it is trying to achieve.' },
      skills: {
        type: 'array', items: { type: 'string' },
        description: 'Skills it should reach for. Checked — a name that does not exist is refused, not silently kept.',
      },
      tools: { type: 'array', items: { type: 'string' }, description: 'Tool names it is allowed to use.' },
      canDelegate: { type: 'boolean', description: 'Whether it may spawn agents of its own.' },
      reportFormat: { type: 'string', description: 'How it should shape its final answer.' },
      model: { type: 'string', description: 'Pin it to a specific model, if it should not use the default.' },
      scope: { type: 'string', enum: ['user', 'project'], description: 'user: available everywhere. project: only here.' },
      path: { type: 'string', description: 'For export: where to write. For import: the file to read.' },
    },
    required: ['action'],
  },
};
