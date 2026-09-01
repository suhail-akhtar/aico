/**
 * Which part of a file actually changed.
 *
 * Split out of `apply-edit.ts` and free of any `vscode` import, so it can be
 * tested without an editor. That is not tidiness: this is string arithmetic with
 * an off-by-one that produces an *inverted range*, and an inverted range is the
 * kind of thing that either throws in the middle of applying somebody's edit or,
 * worse, replaces the wrong span.
 *
 * The purpose is to turn "here are the new contents of the file" into the
 * smallest edit that produces them. Replacing the whole document also works, and
 * gives an undo entry that reverts everything and a diff claiming every line
 * moved. A common prefix and suffix cost a few lines and make a one-character
 * change a one-character edit.
 *
 * @module view/text-span
 */

export interface Span {
  /** Character offset where the replacement begins. */
  start: number;
  /** Character offset in the *old* text where it ends. */
  end: number;
  /** What to put there. */
  text: string;
}

/**
 * The smallest span of `before` that can be replaced to yield `after`.
 *
 * Returns a zero-length span at 0 with empty text when nothing differs, so a
 * caller can treat "no change" as a no-op rather than a special case.
 */
export function changedSpan(before: string, after: string): Span {
  if (before === after) return { start: 0, end: 0, text: '' };

  const start = commonPrefix(before, after);
  const end = commonSuffix(before, after, start);

  return {
    start,
    end: before.length - end,
    text: after.slice(start, after.length - end),
  };
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/**
 * How many trailing characters match, without overlapping the prefix.
 *
 * The `prefix` guard is the whole difficulty. For `"aa"` → `"aaa"` an unguarded
 * scan counts two matching characters at the end while the prefix already
 * claimed two at the front — and the two claims overlap on a two-character
 * string, producing `end < start`: a range that finishes before it begins.
 */
function commonSuffix(a: string, b: string, prefix: number): number {
  const limit = Math.min(a.length - prefix, b.length - prefix);
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}
