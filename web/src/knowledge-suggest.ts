/**
 * From a correction to a knowledge entry, pre-filled.
 *
 * A 👎 with a note is the moment SkillOpt-style systems reflect on: a failing
 * trajectory and, in the user's own words, why. Ours was stored and read by
 * nothing. This turns it into the two fields a knowledge entry needs, so that
 * keeping a lesson is one confirmation rather than a form.
 *
 * **Trigger** comes from what was *asked*, not from the reply. Knowledge is
 * matched against the next task's wording, and the next task will resemble the
 * request that went wrong — not the answer to it.
 *
 * **Content** is the note, verbatim. It is the one part a person already wrote.
 *
 * Pure, and shared by the browser client and the VS Code panel through the
 * `@web` alias — both surfaces must produce the same suggestion from the same
 * correction, or a lesson learned in one place reads differently in the other.
 *
 * @module knowledge-suggest
 */

/** Words that say nothing about *what* a task is, so they make a poor trigger. */
const FILLER = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'as', 'is', 'are', 'was', 'be', 'it', 'this', 'that', 'these', 'those', 'i', 'we',
  'you', 'me', 'my', 'our', 'your', 'please', 'can', 'could', 'would', 'should', 'just',
  'now', 'then', 'also', 'so', 'do', 'does', 'did', 'make', 'want', 'need', 'like',
]);

export interface KnowledgeSuggestion {
  trigger: string;
  content: string;
}

export function suggestKnowledge(askedFor: string | undefined, note: string): KnowledgeSuggestion {
  const words = (askedFor ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[^\p{L}\p{N}\s._/-]/gu, ' ')
    .split(/\s+/)
    .filter(w => w && !FILLER.has(w.toLowerCase()));

  /*
    Eight words, not the whole request. Trigger matching is word overlap, so a
    long trigger matches *more* loosely, not less — every extra word is another
    chance for an unrelated task to overlap it. Eight is enough to name a task
    and few enough to stay specific.
  */
  const trigger = words.slice(0, 8).join(' ').trim();

  return {
    trigger: trigger || 'when doing this kind of task',
    content: note.trim(),
  };
}
