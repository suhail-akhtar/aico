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
  /**
   * Requests this skill is NOT for, even when `trigger` matches (regex string).
   *
   * A trigger is a bag of words, and words travel: "the admin UI shows 1,203
   * rows" in a backend CSV bug report matched app-design's `ui`, and the
   * suggestion was declined in twelve of eighteen replies. A negative cue is
   * cheaper and more honest than trying to make the positive regex know every
   * sentence a word can appear in.
   */
  antiTrigger?: string;
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
  /** The spec's environment note (≤ 500 characters). */
  compatibility?: string;
  /** The spec's string→string map; AICO's own keys travel here on export as `aico-*`. */
  metadata?: Record<string, string>;
  /**
   * Every key the file had, parsed, including ones AICO does not use
   * (`disable-model-invocation`, `hooks`, …). Kept so nothing is lost on a
   * rewrite and so a caller can read a field this interface does not name.
   */
  extra?: Record<string, unknown>;
}

/**
 * Whether a skill may reach the model (design §5.1).
 *
 *  - `builtin`    ships with AICO.
 *  - `authored`   written here — by a person in the editor, or by the agent
 *                 through create → verify → register — or installed before
 *                 provenance existed.
 *  - `reviewed`   imported, and a person looked at the review screen and
 *                 chose "Install and enable" for exactly this content.
 *  - `unreviewed` imported and not yet reviewed, or changed since review.
 *                 Kept out of the catalogue; `Skill` refuses it.
 */
export type SkillTrust = 'builtin' | 'authored' | 'reviewed' | 'unreviewed';

/** What `.aico-meta.json` records beside an imported skill. Never exported. */
export interface SkillProvenance {
  /** The path or URL it came from. */
  source: string;
  sourceKind: 'archive' | 'folder' | 'markdown' | 'pack' | 'plugin' | 'upload' | 'url' | 'draft';
  /** sha256 of the installed tree (sorted paths and contents), as reviewed. */
  sha256: string;
  /** sha256 of the archive or file it was unpacked from, when there was one. */
  sourceSha256?: string;
  importedAt: string;
  trust: 'authored' | 'reviewed' | 'unreviewed';
  reviewedAt?: string;
  /** The plugin it came out of, for a plugin import. */
  plugin?: string;
  /** Scan totals at import, so the list can show them without rescanning. */
  findings?: { high: number; warn: number; info: number };
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
  /** Whether it may reach the model; absent means `authored` (or `builtin`). */
  trust?: SkillTrust;
  /** Why it is `unreviewed`, when it is: never reviewed, or changed since. */
  trustReason?: string;
  /** Where it came from, for an imported skill. */
  provenance?: SkillProvenance;
  /** Spec problems found when it loaded; shown, never blocking for an installed skill. */
  warnings?: string[];
}

export interface SkillDispatchResult {
  matched: boolean;
  skill?: Skill;
  resolvedPrompt?: string;
}
