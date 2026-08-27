/**
 * Deciding whether a piece of guidance applies to what is being asked.
 *
 * Word overlap between the trigger and the task, and it is worth being blunt
 * about what that is and is not. It is not semantic search: "fix the payment
 * flow" will not match a trigger about "billing" unless a word is shared. Real
 * retrieval would mean embeddings — a model call, an index to maintain, and a
 * dependency — to make a feature whose entire purpose is *saving* tokens cost
 * a call before every turn. That trade is not worth making, and pretending
 * otherwise by dressing up the matching would be worse than saying so.
 *
 * What overlap is, is honest and cheap, and it puts the author in control: a
 * trigger is written by someone who knows which words their tasks contain.
 * The {@link Knowledge} tool covers the rest — when the agent suspects there
 * is guidance it was not handed, it can go and look.
 *
 * Two guards against the failure that matters, which is a confident wrong
 * match: a proportion of the trigger must be present, *and* an absolute
 * minimum number of words. Without the second, a two-word trigger fires on one
 * incidental word.
 *
 * @module knowledge/match
 */

import type { KnowledgeEntry, KnowledgeMatch } from './types.js';

/**
 * Words too common to carry meaning.
 *
 * Deliberately short. A long stopword list starts removing terms that are
 * genuinely load-bearing in a codebase — "test", "use", "get" — and the point
 * of this list is only to stop "the" and "when" from making everything match.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'then',
  'there', 'these', 'this', 'to', 'when', 'with', 'you', 'your', 'we', 'our',
  'i', 'me', 'my', 'do', 'does', 'not', 'no', 'so', 'up', 'out', 'all', 'can',
]);

/** Meaningful lowercase words in a piece of text. */
export function meaningfulWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    // Split on anything that is not a word character, but keep intra-word
    // punctuation that carries meaning in code: `user_id`, `payments-service`.
    .split(/[^a-z0-9_.-]+/)
    .map(word => word.replace(/^[.\-_]+|[.\-_]+$/g, ''))
    .filter(word => word.length > 2 && !STOPWORDS.has(word));
  return new Set(words);
}

/** Minimum share of a trigger's words that must appear. */
const MIN_SCORE = 0.5;

/** Minimum absolute overlap, so a short trigger cannot fire on one word. */
const MIN_WORDS = 2;

/**
 * Entries whose trigger matches the task, best first.
 *
 * `scope` is a hard filter rather than part of the score: a convention for
 * another repository is not weak evidence, it is the wrong answer.
 */
export function matchKnowledge(
  entries: readonly KnowledgeEntry[],
  taskText: string,
  projectRoot?: string,
): KnowledgeMatch[] {
  const haystack = meaningfulWords(taskText);
  if (haystack.size === 0) return [];

  const matches: KnowledgeMatch[] = [];
  for (const entry of entries) {
    if (entry.scope && projectRoot && entry.scope !== projectRoot) continue;
    if (entry.scope && !projectRoot) continue;

    const triggerWords = meaningfulWords(entry.trigger);
    if (triggerWords.size === 0) continue;

    let overlap = 0;
    for (const word of triggerWords) if (haystack.has(word)) overlap++;

    const score = overlap / triggerWords.size;
    if (overlap >= Math.min(MIN_WORDS, triggerWords.size) && score >= MIN_SCORE) {
      matches.push({ entry, score });
    }
  }

  return matches.sort((a, b) =>
    b.score - a.score || a.entry.id.localeCompare(b.entry.id));
}

/** Longest a knowledge block may be before it stops being the cheap option. */
const MAX_CHARS = 2_000;

/** Most entries to attach, however many matched. */
const MAX_ENTRIES = 5;

/**
 * The matched entries, rendered for the tail of a request.
 *
 * Bounded twice over, because this rides in the volatile context — paid in
 * full on every request rather than read from cache. An unbounded block here
 * would cost more per turn than the whole-file loading it replaced, which is
 * the exact failure this feature exists to avoid.
 */
export function renderKnowledge(matches: readonly KnowledgeMatch[]): string {
  if (matches.length === 0) return '';

  const lines: string[] = [];
  let budget = MAX_CHARS;
  let used = 0;

  for (const match of matches.slice(0, MAX_ENTRIES)) {
    const body = match.entry.content.trim();
    const block = `- ${body}`;
    if (block.length > budget) break;
    budget -= block.length;
    used++;
    lines.push(block);
  }
  if (lines.length === 0) return '';

  const dropped = matches.length - used;
  const note = dropped > 0
    ? `\n(${dropped} further entr${dropped === 1 ? 'y' : 'ies'} matched but did not fit; `
      + 'the Knowledge tool can list them.)'
    : '';

  return 'Project knowledge that applies to this task:\n' + lines.join('\n') + note;
}
