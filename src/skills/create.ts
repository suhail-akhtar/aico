/**
 * SkillCreate tool — the older, single-purpose way for an agent to write a
 * skill, kept because sessions and prompts still name it.
 *
 * It used to write the skill straight into the skills directory and hot-merge
 * it into the catalogue. That contradicted the decision `skills/manage.ts`
 * records — creating a skill must not register it, because a tool that
 * installs on the first call makes trying it first optional, and optional
 * verification does not happen. So this is now `SkillManage create` under its
 * old name: it writes a DRAFT the loader never scans, runs the checks, and
 * says that `register` is the step that installs.
 */

import { executeSkillManage } from './manage.js';

export const skillCreateToolDefinition = {
  name: 'SkillCreate',
  description: [
    'Draft a reusable skill (a written procedure). It is written as a DRAFT and is NOT usable yet:',
    'check it, try it on a real example, then install it with SkillManage action:"register".',
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
        description: 'Where registering installs it: "user" (global, ~/.aico/skills/) or "project" (this project\'s .aico/skills/). Default: user.',
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
  // The description is the only part another agent sees before choosing this
  // skill, so an empty one makes it unreachable no matter how good the body is.
  if (!args.description?.trim()) {
    return 'Error creating skill: a description is required — it is the only part visible when '
      + 'deciding whether to use this skill, so without one it can never be chosen.';
  }

  try {
    const drafted = await executeSkillManage({
      action: 'create',
      name: args.name,
      description: args.description,
      prompt: args.prompt,
      ...(args.aliases ? { aliases: args.aliases } : {}),
      ...(args.trigger ? { trigger: args.trigger } : {}),
      ...(args.allowedTools ? { allowedTools: args.allowedTools } : {}),
      ...(args.resources ? { resources: args.resources } : {}),
      ...(args.scope ? { scope: args.scope } : {}),
    });
    return `${drafted}\nTo install it: SkillManage action:"register" name:"${args.name}".`;
  } catch (err) {
    return `Error creating skill: ${err instanceof Error ? err.message : String(err)}`;
  }
}
