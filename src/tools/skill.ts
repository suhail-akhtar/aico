/**
 * Using a skill, rather than merely having one.
 *
 * Skills were a slash command. A person could type `/commit` in the terminal
 * and get a carefully written procedure; the agent could *create* one and was
 * otherwise blind to them — never told which existed, and given no way to open
 * one. A library nobody can read is not a library.
 *
 * Two halves fix that, and they have to be separate.
 *
 * **Every skill's name and description go in the system prompt.** One line
 * each, always present, in the cached prefix. That is the whole selection
 * decision: the model cannot choose a skill it has never heard of, and asking
 * it to call a tool to find out what tools exist is a step nobody takes.
 *
 * **The body loads only when chosen.** A good skill is long — that is what
 * makes it worth having — and twenty of them in every request would cost more
 * than they save. So the description is always there and the procedure arrives
 * on request. Progressive disclosure, and the reason a hundred skills stay
 * affordable.
 *
 * @module tools/skill
 */

import fs from 'fs';
import path from 'path';
import { skillRegistry } from '../skills/index.js';
import { disabledIn } from '../registry-state.js';
import type { Skill } from '../skills/types.js';

export interface SkillInput {
  /** The skill's name, or one of its aliases. */
  name: string;
  /** Substituted for `{args}` in the body. */
  args?: string;
}

/** How much of a bundled file to inline before pointing at it instead. */
const INLINE_LIMIT = 4000;

/**
 * One line per skill, for the prompt.
 *
 * Disabled skills are left out entirely rather than listed as unavailable.
 * Offering something and then refusing it wastes a turn and reads as a bug; a
 * switched-off skill should simply not be part of the decision. They stay
 * visible in `SkillManage list`, which is where someone looking for the switch
 * would look.
 */
export function skillCatalogue(): string {
  const off = disabledIn('skills');
  const skills = skillRegistry.list().filter(s => !off.has(s.frontmatter.name.toLowerCase()));
  if (skills.length === 0) return '';
  return skills
    .map(s => `- ${s.frontmatter.name}: ${s.frontmatter.description}`)
    .join('\n');
}

/**
 * The skills whose trigger matches what was asked, most specific first.
 *
 * A skill can declare the shape of request it is for, and a description sitting
 * in a list is easy to skim past — so when one actually matches, it is named as
 * a match rather than left to be noticed. This is the "prefer a skill when one
 * fits" rule expressed where it can act, instead of as an instruction that the
 * model may or may not follow.
 */
export function matchingSkills(request: string): Skill[] {
  if (!request.trim()) return [];
  const off = disabledIn('skills');
  return skillRegistry.list().filter(skill => {
    if (off.has(skill.frontmatter.name.toLowerCase())) return false;
    if (!skill.frontmatter.trigger) return false;
    try { return new RegExp(skill.frontmatter.trigger, 'i').test(request); }
    catch { return false; }
  });
}

/**
 * A file's size, told truthfully at every scale.
 *
 * Rounding everything up to whole kilobytes seems harmless until a 7-byte
 * `tone.md` is announced as "1 KB". Watched live: the agent read the file
 * correctly, compared two lines against the promised kilobyte, concluded Read
 * had truncated it, and spent three tool calls proving otherwise with `cat` and
 * `type`. A number that disagrees with what the agent just saw is worse than no
 * number — it manufactures a problem and then gets worked around.
 */
export function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a skill ships with, described so the agent knows what it may read. */
function describeResources(skill: Skill): string {
  if (!skill.dir || !skill.resources?.length) return '';
  const lines = skill.resources.map(rel => {
    const full = path.join(skill.dir!, rel);
    let size = '';
    try { size = ` (${describeSize(fs.statSync(full).size)})`; } catch { /* gone */ }
    // The full path, not the relative name: the body says `references/tone.md`
    // and Read needs somewhere real. Making the agent join the two itself is a
    // step that can go wrong for no benefit.
    return `  ${rel}${size} — ${full}`;
  });
  return `\nThis skill ships files alongside it, in ${skill.dir}:\n${lines.join('\n')}\n`
    + 'Read any of them with Read when the procedure calls for it.';
}

export async function useSkill(input: SkillInput): Promise<string> {
  const name = (input.name ?? '').trim();
  if (!name) {
    const known = skillRegistry.list().map(s => s.frontmatter.name).join(', ');
    return `Which skill? Available: ${known || '(none installed)'}.`;
  }

  const skill = skillRegistry.lookup(name);
  if (!skill) {
    const known = skillRegistry.list().map(s => s.frontmatter.name);
    // Named alternatives rather than "not found": the usual cause is a near
    // miss, and a list is the fix.
    return `There is no skill called "${name}". Available: ${known.join(', ') || '(none installed)'}.`;
  }

  const body = skill.promptTemplate.replace(/\{args\}/g, input.args?.trim() ?? '');

  // A one-file skill that is mostly a pointer is more useful inlined than
  // described. Beyond that the agent can read what it needs.
  const resources = describeResources(skill);
  const inlined = skill.dir && skill.resources?.length === 1 && (() => {
    try {
      const only = path.join(skill.dir!, skill.resources![0]!);
      const stat = fs.statSync(only);
      if (stat.size > INLINE_LIMIT) return '';
      return `\n--- ${skill.resources![0]} ---\n${fs.readFileSync(only, 'utf8')}`;
    } catch { return ''; }
  })();

  return [
    `Skill: ${skill.frontmatter.name} — ${skill.frontmatter.description}`,
    skill.frontmatter.allowedTools?.length
      ? `The author expects this to use: ${skill.frontmatter.allowedTools.join(', ')}.`
      : '',
    '',
    body,
    resources,
    inlined || '',
    '',
    'Follow this procedure. It is instruction, not information — the person who '
    + 'wrote it knew something about this task that is not in the codebase.',
  ].filter(Boolean).join('\n');
}

export const skillDefinition = {
  name: 'Skill',
  description:
    'Open one of the installed skills and follow it. A skill is a procedure someone wrote '
    + 'down for a task like this one — use it when its description matches what you are about '
    + 'to do, rather than working the procedure out again. The available skills are listed in '
    + 'your instructions; this returns the full text of one.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'The skill to open, by name or alias.' },
      args: {
        type: 'string',
        description: 'Context for the skill, substituted wherever it says {args}.',
      },
    },
    required: ['name'],
  },
};
