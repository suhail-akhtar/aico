import type { Skill } from './types.js';

const MAX_DEPTH = 3;

/**
 * Resolve `${/skill-name args}` references inside a skill prompt template.
 * Prevents infinite loops via depth limit.
 */
export async function resolveSkillRef(
  template: string,
  lookupSkill: (name: string) => Skill | undefined,
  depth = 0,
): Promise<string> {
  if (depth >= MAX_DEPTH) return template;

  // Match ${/skill-name optional-args}
  const refPattern = /\$\{\/([a-z0-9-]+)([^}]*)?\}/gi;
  let result = template;
  const matches = [...template.matchAll(refPattern)];

  for (const match of matches) {
    const skillName = match[1];
    const skillArgs = (match[2] ?? '').trim();
    const referencedSkill = lookupSkill(skillName);

    if (referencedSkill) {
      const inner = referencedSkill.promptTemplate.replace('{args}', skillArgs);
      const resolved = await resolveSkillRef(inner, lookupSkill, depth + 1);
      result = result.replace(match[0], resolved);
    }
  }

  return result;
}
