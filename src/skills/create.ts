/**
 * SkillCreate tool — lets the orchestrator (or any agent) create a new skill
 * at runtime. The skill is written to disk AND hot-merged into the registry,
 * so it's immediately usable in the same session without a manual reload.
 */

import { skillRegistry } from './registry.js';

export const skillCreateToolDefinition = {
  name: 'SkillCreate',
  description: [
    'Create a reusable skill (prompt template) that can be invoked via /<name> or auto-triggered.',
    'The skill is saved to disk and immediately available — no reload needed.',
    'Skills can be assigned to agents to give them specialized capabilities.',
    'Write the prompt body with {args} as a placeholder for user-provided arguments.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill name (lowercase, hyphenated, e.g. "deploy-checklist" or "api-design-review").',
      },
      description: {
        type: 'string',
        description: 'One-line description of what the skill does.',
      },
      prompt: {
        type: 'string',
        description: 'The full prompt template body. Use {args} for user arguments. This is what runs when the skill is invoked.',
      },
      aliases: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional short aliases (e.g. ["dc"] for deploy-checklist).',
      },
      trigger: {
        type: 'string',
        description: 'Optional regex pattern — if user input matches, this skill auto-activates.',
      },
      scope: {
        type: 'string',
        enum: ['user', 'project'],
        description: 'Where to save: "user" (global, ~/.aico/skills/) or "project" (.aico/skills/). Default: user.',
      },
    },
    required: ['name', 'description', 'prompt'],
  },
};

export async function executeSkillCreate(args: {
  name: string;
  description: string;
  prompt: string;
  aliases?: string[];
  trigger?: string;
  scope?: 'user' | 'project';
}): Promise<string> {
  const { name, description, prompt, aliases, trigger, scope } = args;

  // Build the markdown skill file with YAML frontmatter
  const fmLines = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
  ];
  if (aliases?.length) fmLines.push(`aliases: [${aliases.join(', ')}]`);
  if (trigger) fmLines.push(`trigger: ${trigger}`);
  fmLines.push('author: aico-orchestrator');
  fmLines.push('version: 1.0.0');
  fmLines.push('---');
  fmLines.push(prompt);

  const content = fmLines.join('\n');

  try {
    const skill = await skillRegistry.addSkill(content, name, scope ?? 'user');
    return `Skill "${skill.frontmatter.name}" created and activated immediately.\n` +
      `Description: ${skill.frontmatter.description}\n` +
      `Scope: ${scope ?? 'user'}\n` +
      `File: ${skill.filePath}\n` +
      (aliases?.length ? `Aliases: ${aliases.join(', ')}\n` : '') +
      `The skill is now available as /${skill.frontmatter.name} and can be assigned to agents.`;
  } catch (err) {
    return `Error creating skill: ${err instanceof Error ? err.message : String(err)}`;
  }
}
