/**
 * What a knowledge entry is.
 *
 * @module knowledge/types
 */

export interface KnowledgeEntry {
  /** Stable id, derived from the filename. */
  id: string;
  /**
   * When this applies, in the author's own words.
   *
   * Required, and the whole point. An entry without one is a rule that is
   * always on — which `AICO.md` already does, more cheaply, by living in the
   * cached part of the prompt. The trigger is what earns a piece of guidance
   * the right to be absent most of the time.
   */
  trigger: string;
  /** The guidance itself. Kept short by convention, not by force. */
  content: string;
  /** Absolute path of the file it came from. */
  path: string;
  /**
   * Project this belongs to, or undefined for entries that apply anywhere.
   *
   * A convention that is right for one repository is usually wrong stated
   * globally, and the failure is quiet: the agent follows it in the wrong
   * place and nobody can see why.
   */
  scope?: string;
}

export interface KnowledgeMatch {
  entry: KnowledgeEntry;
  /** Fraction of the trigger's meaningful words present in the task text. */
  score: number;
}
