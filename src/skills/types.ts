export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Auto-dispatch trigger pattern (regex string) */
  trigger?: string;
  /** Alternative names for this skill */
  aliases?: string[];
  author?: string;
  version?: string;
}

export interface Skill {
  frontmatter: SkillFrontmatter;
  /** Raw markdown template with {args} placeholder */
  promptTemplate: string;
  filePath: string;
  isBuiltin: boolean;
}

export interface SkillDispatchResult {
  matched: boolean;
  skill?: Skill;
  resolvedPrompt?: string;
}
