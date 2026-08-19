export interface SkillFrontmatter {
  name: string;
  /**
   * What this skill is for, in the words that decide whether to use it.
   *
   * This is the only part of a skill the model sees until it chooses one, so it
   * carries the whole selection decision. "Formats a commit message" is useless
   * next to twenty others; "writes a conventional commit from staged changes,
   * including scope and body" is a choice someone can make.
   */
  description: string;
  /** Auto-dispatch trigger pattern (regex string) */
  trigger?: string;
  /** Alternative names for this skill */
  aliases?: string[];
  author?: string;
  version?: string;
  /**
   * Tools this skill expects, from Claude's skill format.
   *
   * Carried through and shown, not enforced: a skill that says it needs Bash is
   * telling the reader something useful, and silently restricting the agent
   * because a file said so would be a surprising way to lose a capability.
   */
  allowedTools?: string[];
  license?: string;
}

export interface Skill {
  frontmatter: SkillFrontmatter;
  /** Raw markdown template with {args} placeholder */
  promptTemplate: string;
  filePath: string;
  isBuiltin: boolean;
  /**
   * The skill's own directory, when it has one.
   *
   * A single-file skill is just a prompt. A directory skill — `SKILL.md` plus
   * whatever sits beside it — can ship scripts, references and templates, and
   * this is the root those relative paths resolve against. Claude's format is
   * the directory kind, which is why it is worth supporting rather than
   * flattening on import.
   */
  dir?: string;
  /** Files bundled with a directory skill, relative to `dir`. */
  resources?: string[];
}

export interface SkillDispatchResult {
  matched: boolean;
  skill?: Skill;
  resolvedPrompt?: string;
}
