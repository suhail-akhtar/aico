/**
 * Line endings, which on Windows are not a detail.
 *
 * `git config core.autocrlf` defaults to `true` on Windows, so a checked-out
 * file holds `\r\n` while every model on earth writes `\n`. That mismatch broke
 * `Edit` completely and silently: `Read` handed the model a file whose lines
 * each ended in an invisible `\r`, the model sent back an `old_str` joined with
 * plain `\n` — because that is what it perceives and what JSON encodes — and
 * `indexOf` found nothing.
 *
 * The failure was maximally confusing from the outside. `Read` succeeded and
 * looked perfect; the edit failed with *"the string to replace was not found"*,
 * which reads as the model having invented a snippet. Re-reading the file
 * changed nothing, so an agent would read, fail, read, fail, four times in a
 * row. Single-line edits worked throughout, because a needle with no newline in
 * it has nothing to disagree about.
 *
 * Two rules follow, and they have to be applied together:
 *
 * 1. **Never show a `\r` to a model.** It cannot see it, cannot reproduce it,
 *    and its presence in the transcript is pure noise.
 * 2. **Never write a file's endings back differently than they arrived.**
 *    Rewriting a CRLF file with LF turns a three-line edit into a diff that
 *    claims every line changed, which is worse than not editing it.
 *
 * @module tools/eol
 */

export type Eol = '\n' | '\r\n';

/**
 * Which ending this text actually uses.
 *
 * Decided by majority rather than by the first one found. Real files are mixed
 * more often than anyone expects — a generated header with one convention and a
 * hand-edited body with another — and picking the first would rewrite the
 * majority to match an outlier.
 *
 * A file with no newline at all is `\n`: there is nothing to preserve, and LF
 * is the right default everywhere except the one case this module exists for.
 */
export function dominantEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n') continue;
    if (i > 0 && text[i - 1] === '\r') crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/** The same text with every ending normalised to `\n`. */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * The same text with every ending rewritten to `eol`.
 *
 * Normalised first, so this is safe to call on text that is already mixed —
 * otherwise a `\r\n` would become `\r\r\n`, which is the kind of corruption
 * that survives review because it is invisible.
 */
export function toEol(text: string, eol: Eol): string {
  const lf = toLf(text);
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}
