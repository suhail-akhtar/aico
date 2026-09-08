/**
 * Money is not maths.
 *
 * The renderer accepts `$x^2$` as inline TeX, which is what the docs promise
 * and what a model writing a derivation uses. The same rule turned "$240.00
 * (subtotal $200.00)" in a reply about invoices into an italic formula with
 * the digits pulled out of it. A dollar that opens a plain number — digits,
 * an optional decimal part, then the end of the token — is a price, and is
 * escaped so the maths pass leaves it alone. `$2^n$` keeps its caret and stays
 * maths; code spans and fences are never touched, because `$1` in a shell
 * snippet must stay exactly `$1`.
 */

const PRICE = /\$(?=\d[\d,]*(?:\.\d+)?(?:[\s)\].,;:!?·—–-]|$))/g;

/** Escape currency dollars in the prose parts of a Markdown string. */
export function protectCurrency(markdown: string): string {
  if (!markdown.includes('$')) return markdown;
  // Prose and code alternate; only prose is rewritten.
  const parts = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/);
  return parts.map((part, i) => (i % 2 === 1 ? part : part.replace(PRICE, '\\$'))).join('');
}
