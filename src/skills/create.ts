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
      allowedTools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tools this procedure expects to use, e.g. ["Bash", "Read"]. Recorded as allowed-tools.',
      },
      resources: {
        type: 'array',
        description:
          'Files to ship alongside the skill, which makes it a directory skill. Use this when the '
          + 'procedure needs a script to run or a reference to consult — the body can then say '
          + '"run scripts/check.py" or "read references/tone.md" and the file will be there. '
          + 'Nothing is executed on creation.',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path inside the skill, e.g. "scripts/check.py" or "references/tone.md".',
            },
            content: { type: 'string', description: 'The file\'s full contents.' },
          },
          required: ['path', 'content'],
        },
      },
    },
    required: ['name', 'description', 'prompt'],
  },
};

/**
 * A frontmatter value that cannot break the block it sits in.
 *
 * The parser reads `key: value` a line at a time, so a description containing
 * a newline silently truncates the skill and one containing a leading `[` is
 * read as a list. Quoting is cheaper than discovering either later.
 */
function yamlValue(raw: string): string {
  const flat = raw.replace(/\r?\n/g, ' ').trim();
  return /^[^'"\[\]{}#&*!|>%@`:-]/.test(flat) && !flat.includes(': ')
    ? flat
    : `"${flat.replace(/"/g, '\\"')}"`;
}

export async function executeSkillCreate(args: {
  name: string;
  description: string;
  prompt: string;
  aliases?: string[];
  trigger?: string;
  scope?: 'user' | 'project';
  allowedTools?: string[];
  resources?: Array<{ path: string; content: string }>;
}): Promise<string> {
  const { name, description, prompt, aliases, trigger, scope, allowedTools, resources } = args;

  // The description is the only part another agent sees before choosing this
  // skill, so an empty one makes it unreachable no matter how good the body is.
  if (!description?.trim()) {
    return 'Error creating skill: a description is required — it is the only part visible when '
      + 'deciding whether to use this skill, so without one it can never be chosen.';
  }

  // Build the markdown skill file with YAML frontmatter
  const fmLines = [
    '---',
    `name: ${yamlValue(name)}`,
    `description: ${yamlValue(description)}`,
  ];
  if (aliases?.length) fmLines.push(`aliases: [${aliases.join(', ')}]`);
  if (trigger) fmLines.push(`trigger: ${trigger}`);
  // Claude's spelling, so a skill authored here and one imported from outside
  // are the same kind of file.
  if (allowedTools?.length) fmLines.push(`allowed-tools: [${allowedTools.join(', ')}]`);
  fmLines.push('author: aico-orchestrator');
  fmLines.push('version: 1.0.0');
  fmLines.push('---');
  fmLines.push(prompt);

  const content = fmLines.join('\n');

  try {
    const existing = skillRegistry.lookup(name);
    const skill = await skillRegistry.addSkill(content, name, scope ?? 'user', resources ?? []);
    const shipped = skill.resources ?? [];
    return `Skill "${skill.frontmatter.name}" created and activated immediately.\n` +
      `Description: ${skill.frontmatter.description}\n` +
      `Scope: ${scope ?? 'user'}\n` +
      `File: ${skill.filePath}\n` +
      (aliases?.length ? `Aliases: ${aliases.join(', ')}\n` : '') +
      (shipped.length ? `Ships with: ${shipped.join(', ')}\n` : '') +
      // Said plainly, because overwriting someone's procedure silently is the
      // kind of thing that should never be discovered later.
      (existing && !existing.isBuiltin ? `Replaced the previous skill of the same name.\n` : '') +
      `The skill is now available as /${skill.frontmatter.name} and can be assigned to agents.`;
  } catch (err) {
    return `Error creating skill: ${err instanceof Error ? err.message : String(err)}`;
  }
}
