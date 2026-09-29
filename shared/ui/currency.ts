/**
 * Money is not maths — but arithmetic is.
 *
 * The renderer accepts `$x^2$` as inline TeX, which is what the docs promise
 * and what a model writing a derivation uses. The same rule turned "$240.00
 * (subtotal $200.00)" in a reply about invoices into an italic formula with
 * the digits pulled out of it, so a dollar that opens a plain number is read as
 * a price and escaped.
 *
 * That alone broke the other case: "$3 + 2$ and $2 + 3$" in a maths lesson is
 * two formulas that happen to start with a digit, and escaping their opening
 * dollars paired the leftover ones into a formula of " and \" (drawn in red).
 * So a dollar is a price only when it does not open inline maths, and it opens
 * inline maths when — by Pandoc's rule — a closing dollar follows on the same
 * line with no space just inside it and no digit just after it, around
 * something formula-like rather than a run of words.
 *
 * `$$…$$` display maths, code spans and fences are never touched: `$1` in a
 * shell snippet must stay exactly `$1`.
 */

const PRICE_AT = /^\$\d[\d,]*(?:\.\d+)?(?:[\s)\].,;:!?·—–-]|$)/;
/** Two ordinary words in a row: prose, not a formula ("$5 for adults and 3$"). */
const PROSE = /\b[A-Za-z]{3,}\s+[A-Za-z]{3,}\b/;
const FORMULA = /[-+*/=^_\\<>|()a-zA-Z]/;

/** Escape currency dollars in the prose parts of a Markdown string. */
export function protectCurrency(markdown: string): string {
  if (!markdown.includes('$')) return markdown;
  // Prose alternates with code and display maths; only prose is rewritten.
  const parts = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\$\$[\s\S]*?\$\$)/);
  return parts.map((part, i) => (i % 2 === 1 ? part : part.split('\n').map(protectLine).join('\n'))).join('');
}

function protectLine(line: string): string {
  if (!line.includes('$')) return line;
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '\\') { out += line.slice(i, i + 2); i += 2; continue; }
    if (ch !== '$') { out += ch; i++; continue; }
    if (line[i + 1] === '$') { out += '$$'; i += 2; continue; }
    const close = closer(line, i + 1);
    if (close !== -1) {
      const inner = line.slice(i + 1, close);
      if (FORMULA.test(inner) && !PROSE.test(inner.replace(/\\text\{[^}]*\}/g, ''))) {
        out += line.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    out += PRICE_AT.test(line.slice(i)) ? '\\$' : '$';
    i++;
  }
  return out;
}

/** The index of the dollar that closes inline maths opened just before `from`, or -1. */
function closer(line: string, from: number): number {
  if (from >= line.length || /\s/.test(line[from]!)) return -1;
  for (let j = from; j < line.length; j++) {
    const ch = line[j]!;
    if (ch === '\\') { j++; continue; }
    if (ch !== '$') continue;
    // The first dollar decides: a bad closer means the opener was not maths.
    if (j === from || line[j + 1] === '$' || /\s/.test(line[j - 1]!) || /\d/.test(line[j + 1] ?? '')) return -1;
    return j;
  }
  return -1;
}
