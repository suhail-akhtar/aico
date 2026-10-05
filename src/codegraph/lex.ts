/**
 * A masking lexer: comments and string bodies blanked, everything else kept,
 * offsets and line numbers unchanged.
 *
 * ## Why not a parser
 *
 * The graph reads import, export and binding syntax, which is regular, and the
 * thing that breaks regular expressions over source is not grammar but *text
 * that is not code*: an import in a comment, a function name in a string, a
 * `'` in JSX text. Blanking those (with spaces, so every offset and line still
 * lines up) lets plain patterns run on code alone. A grammar per language
 * would be several megabytes of dependency for what this file does in a few
 * hundred lines (ADR 0028; the decision `codemap/extract.ts` records).
 *
 * String *values* are kept beside the masked text, by offset, because import
 * specifiers are strings and are the one string content the graph needs.
 *
 * Interpolations stay code: `${formatAmount(x)}` inside a template literal is
 * a call, and blanking it would hide exactly the uses an impact query is for.
 *
 * ## What it deliberately does not do
 *
 * - Decide JavaScript regex-vs-division perfectly. It uses the previous
 *   significant character, the rule every editor uses, and a mistake costs one
 *   line: a single- or double-quoted string that reaches a newline is
 *   abandoned and scanning resumes after the quote (JavaScript, Go, Java and
 *   C# strings cannot span lines unescaped), which also keeps a JSX
 *   apostrophe from swallowing a component.
 *
 * @module codegraph/lex
 */

export interface LiteralString {
  /** Offset of the opening quote. */
  start: number;
  /** Offset just past the closing quote. */
  end: number;
  value: string;
}

export interface Masked {
  code: string;
  strings: LiteralString[];
  /** Offsets where each line starts, for {@link lineAt}. */
  lineStarts: number[];
}

export type LexFamily = 'js' | 'py' | 'go' | 'java' | 'kotlin' | 'cs' | 'php' | 'rb' | 'rs';

interface Spec {
  lineComments: string[];
  block: boolean;
  nestedBlock: boolean;
  /** Quotes whose strings may not span a line. */
  singleLine: string[];
  /** Quotes whose strings may span lines. */
  multiLine: string[];
  /** Interpolation opener inside double-quoted/template strings, closed by `}`. */
  interp?: string;
  jsTemplate?: boolean;
  jsRegex?: boolean;
  pyStrings?: boolean;
  goRaw?: boolean;
  tripleQuote?: boolean;
  csVerbatim?: boolean;
  rustRaw?: boolean;
  rustLifetimes?: boolean;
}

const SPECS: Record<LexFamily, Spec> = {
  js: { lineComments: ['//'], block: true, nestedBlock: false, singleLine: ['"', '\''], multiLine: [], jsTemplate: true, jsRegex: true },
  py: { lineComments: ['#'], block: false, nestedBlock: false, singleLine: [], multiLine: [], pyStrings: true },
  go: { lineComments: ['//'], block: true, nestedBlock: false, singleLine: ['"', '\''], multiLine: [], goRaw: true },
  java: { lineComments: ['//'], block: true, nestedBlock: false, singleLine: ['"', '\''], multiLine: [], tripleQuote: true },
  kotlin: { lineComments: ['//'], block: true, nestedBlock: true, singleLine: ['"', '\''], multiLine: [], tripleQuote: true, interp: '${' },
  cs: { lineComments: ['//'], block: true, nestedBlock: false, singleLine: ['"', '\''], multiLine: [], csVerbatim: true, tripleQuote: true },
  php: { lineComments: ['//', '#'], block: true, nestedBlock: false, singleLine: [], multiLine: ['"', '\''] },
  rb: { lineComments: ['#'], block: false, nestedBlock: false, singleLine: [], multiLine: ['"', '\''], interp: '#{' },
  rs: { lineComments: ['//'], block: true, nestedBlock: true, singleLine: [], multiLine: ['"'], rustRaw: true, rustLifetimes: true },
};

const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '~', '+', '-', '*', '%', '<', '>', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

/** Blank comments and string bodies; keep code and string values. */
export function mask(source: string, family: LexFamily): Masked {
  const spec = SPECS[family];
  const src = source;
  const n = src.length;
  const out: string[] = new Array(n);
  const strings: LiteralString[] = [];

  const keep = (at: number): void => { out[at] = src[at]!; };
  const blank = (at: number): void => { out[at] = src[at] === '\n' || src[at] === '\r' ? src[at]! : ' '; };
  /** Previous significant code character and word, for the regex rule. */
  const prevSignificant = (at: number): { ch: string; word: string } => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(out[j] ?? '')) j--;
    if (j < 0) return { ch: '', word: '' };
    const ch = out[j]!;
    if (/[\w$]/.test(ch)) {
      let k = j;
      while (k >= 0 && /[\w$]/.test(out[k] ?? '')) k--;
      return { ch, word: out.slice(k + 1, j + 1).join('') };
    }
    return { ch, word: '' };
  };

  /**
   * Scan a quoted string from `start` (the opening quote(s), length `open`).
   * Returns the index just past the close, or -1 to abandon (single-line string hit a newline).
   */
  const scanString = (start: number, open: number, close: string, opts: { multiLine: boolean; escapes: boolean; interp?: string; doubledQuoteEscape?: boolean }): number => {
    for (let k = start; k < start + open; k++) keep(k);
    let j = start + open;
    const value: string[] = [];
    while (j < n) {
      const c = src[j]!;
      if (opts.escapes && c === '\\' && j + 1 < n) { value.push(src[j + 1]!); blank(j); blank(j + 1); j += 2; continue; }
      if (opts.doubledQuoteEscape && src.startsWith(close + close, j)) { value.push(close); blank(j); blank(j + 1); j += 2; continue; }
      if (src.startsWith(close, j)) {
        for (let k = j; k < j + close.length; k++) keep(k);
        strings.push({ start, end: j + close.length, value: value.join('') });
        return j + close.length;
      }
      if (!opts.multiLine && c === '\n') return -1;
      if (opts.interp && src.startsWith(opts.interp, j)) {
        // The interpolation is code: keep it, scanning nested strings and braces.
        for (let k = j; k < j + opts.interp.length; k++) keep(k);
        j = scanCode(j + opts.interp.length, '}');
        continue;
      }
      value.push(c);
      blank(j);
      j++;
    }
    return n;
  };

  /** Scan code from `from` until an unmatched `stop` (for interpolations) or the end. */
  const scanCode = (from: number, stop?: string): number => {
    let depth = 0;
    let j = from;
    while (j < n) {
      const c = src[j]!;
      if (stop && depth === 0 && c === stop) { keep(j); return j + 1; }
      // Comments.
      let comment = false;
      for (const lc of spec.lineComments) {
        if (src.startsWith(lc, j)) {
          // PHP 8 attributes (`#[Route(...)]`) are code, not comments.
          if (lc === '#' && family === 'php' && src[j + 1] === '[') break;
          let k = j;
          while (k < n && src[k] !== '\n') { blank(k); k++; }
          j = k;
          comment = true;
          break;
        }
      }
      if (comment) continue;
      if (spec.block && src.startsWith('/*', j)) {
        let level = 0;
        let k = j;
        while (k < n) {
          if (src.startsWith('/*', k)) { level++; blank(k); blank(k + 1); k += 2; continue; }
          if (src.startsWith('*/', k)) {
            level--; blank(k); blank(k + 1); k += 2;
            if (level === 0 || !spec.nestedBlock) break;
            continue;
          }
          blank(k); k++;
        }
        j = k;
        continue;
      }
      // Python strings: optional prefix, single or triple quotes.
      if (spec.pyStrings && (c === '"' || c === '\'' || /[rRbBuUfF]/.test(c))) {
        const m = /^([rRbBuUfF]{0,2})("""|'''|"|')/.exec(src.slice(j, j + 5));
        if (m && (m[1] === '' || !/[\w]/.test(src[j - 1] ?? ''))) {
          const prefix = m[1]!;
          const quote = m[2]!;
          for (let k = j; k < j + prefix.length; k++) keep(k);
          const raw = /[rR]/.test(prefix);
          const f = /[fF]/.test(prefix);
          const end = scanString(j + prefix.length, quote.length, quote, {
            multiLine: quote.length === 3, escapes: !raw, ...(f ? { interp: '{' } : {}),
          });
          if (end === -1) { keep(j + prefix.length); j = j + prefix.length + 1; continue; }
          j = end;
          continue;
        }
      }
      if (spec.goRaw && c === '`') { j = scanString(j, 1, '`', { multiLine: true, escapes: false }); continue; }
      if (spec.jsTemplate && c === '`') { j = scanString(j, 1, '`', { multiLine: true, escapes: true, interp: '${' }); continue; }
      if (spec.rustRaw && (c === 'r' || c === 'b') && /^b?r(#*)"/.test(src.slice(j, j + 8)) && !/[\w]/.test(src[j - 1] ?? '')) {
        const m = /^b?r(#*)"/.exec(src.slice(j, j + 8))!;
        const open = m[0].length;
        j = scanString(j, open, `"${m[1]}`, { multiLine: true, escapes: false });
        continue;
      }
      if (spec.csVerbatim && (c === '@' || c === '$') && /^(\$@|@\$|@|\$)"/.test(src.slice(j, j + 3))) {
        const m = /^(\$@|@\$|@|\$)"/.exec(src.slice(j, j + 3))!;
        const verbatim = m[1]!.includes('@');
        const interp = m[1]!.includes('$');
        j = scanString(j, m[0].length, '"', { multiLine: verbatim, escapes: !verbatim, doubledQuoteEscape: verbatim, ...(interp ? { interp: '{' } : {}) });
        if (j === -1) j = n;
        continue;
      }
      if (spec.tripleQuote && src.startsWith('"""', j)) {
        j = scanString(j, 3, '"""', { multiLine: true, escapes: true, ...(spec.interp ? { interp: spec.interp } : {}) });
        continue;
      }
      if (spec.rustLifetimes && c === '\'') {
        // A char literal closes within a few characters; a lifetime never does.
        if (/^'(\\.[^']*|[^\\'\n])'/.test(src.slice(j, j + 12))) {
          j = scanString(j, 1, '\'', { multiLine: false, escapes: true });
          if (j === -1) j = n;
        } else { keep(j); j++; }
        continue;
      }
      if (spec.singleLine.includes(c) || spec.multiLine.includes(c)) {
        const multi = spec.multiLine.includes(c);
        const interp = c === '"' && spec.interp ? spec.interp : undefined;
        const end = scanString(j, 1, c, { multiLine: multi, escapes: true, ...(interp ? { interp } : {}) });
        if (end === -1) { keep(j); j++; continue; }
        j = end;
        continue;
      }
      if (spec.jsRegex && c === '/' && src[j + 1] !== '/' && src[j + 1] !== '*') {
        const prev = prevSignificant(j);
        if (REGEX_PREV.has(prev.ch) || REGEX_KEYWORDS.has(prev.word)) {
          let k = j + 1;
          let inClass = false;
          let ok = false;
          while (k < n && src[k] !== '\n') {
            const r = src[k]!;
            if (r === '\\') { k += 2; continue; }
            if (r === '[') inClass = true;
            else if (r === ']') inClass = false;
            else if (r === '/' && !inClass) { ok = true; break; }
            k++;
          }
          if (ok) {
            keep(j);
            for (let q = j + 1; q < k; q++) blank(q);
            keep(k);
            j = k + 1;
            while (j < n && /[a-z]/i.test(src[j]!)) { keep(j); j++; }
            continue;
          }
        }
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      keep(j);
      j++;
    }
    return n;
  };

  scanCode(0);
  for (let k = 0; k < n; k++) if (out[k] === undefined) out[k] = src[k]!;
  const code = out.join('');
  const lineStarts = [0];
  for (let k = 0; k < n; k++) if (code.charCodeAt(k) === 10) lineStarts.push(k + 1);
  return { code, strings, lineStarts };
}

/** 1-based line of an offset. */
export function lineAt(m: Masked, offset: number): number {
  const starts = m.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** The string literal whose opening quote is at or just after `offset` (within a few blanks). */
export function stringAt(m: Masked, offset: number): LiteralString | undefined {
  const list = m.strings;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.start < offset) lo = mid + 1; else hi = mid;
  }
  const s = list[lo];
  return s && s.start - offset <= 4 ? s : undefined;
}

/**
 * Lines where each of `names` occurs as an identifier, outside `[skipFrom, skipTo)` ranges,
 * not as a property (`.name`). At most `cap` lines per name.
 */
export function identifierLines(m: Masked, names: Set<string>, skip: Array<[number, number]>, cap = 5, identRe = /[A-Za-z_$][\w$]*/g): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (names.size === 0) return out;
  const code = m.code;
  identRe.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = identRe.exec(code)) !== null) {
    const word = match[0];
    if (!names.has(word)) continue;
    const at = match.index;
    if (skip.some(([a, b]) => at >= a && at < b)) continue;
    // `obj.name` is a property, not this binding (but `...name` is a spread of it).
    let p = at - 1;
    while (p >= 0 && (code[p] === ' ' || code[p] === '\t')) p--;
    if (code[p] === '.' && code[p - 1] !== '.') continue;
    if (code[p] === '?' && code[p + 1] === '.') continue;
    const list = (out[word] ??= []);
    const line = lineAt(m, at);
    if (list.length < cap && list[list.length - 1] !== line) list.push(line);
  }
  return out;
}

/** `qualifier.member` uses for the given qualifiers (`sep` `.` or `::`). */
export function memberLines(m: Masked, qualifiers: Set<string>, skip: Array<[number, number]>, sep = '.', cap = 5): Record<string, Record<string, number[]>> {
  const out: Record<string, Record<string, number[]>> = {};
  if (qualifiers.size === 0) return out;
  const esc = sep === '.' ? '\\.' : '::';
  const re = new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\s*${esc}\\s*([A-Za-z_$][\\w$]*)`, 'g');
  let match: RegExpExecArray | null;
  const code = m.code;
  while ((match = re.exec(code)) !== null) {
    // A dotted chain `a.b.c.d`: try each prefix as a qualifier (Python `import a.b.c`).
    const chain = `${match[1]}${sep === '.' ? '.' : '::'}${match[2]}`;
    const parts = sep === '.' ? chain.split('.') : [match[1]!, match[2]!];
    for (let k = parts.length - 1; k >= 1; k--) {
      const q = parts.slice(0, k).join('.');
      if (!qualifiers.has(q)) continue;
      const at = match.index;
      if (skip.some(([a, b]) => at >= a && at < b)) break;
      const member = parts[k]!;
      const byMember = (out[q] ??= {});
      const list = (byMember[member] ??= []);
      const line = lineAt(m, at);
      if (list.length < cap && list[list.length - 1] !== line) list.push(line);
      break;
    }
    // Let overlapping chains (`a.b` inside `x.a.b`) be found from the next identifier.
    re.lastIndex = match.index + match[1]!.split(sep === '.' ? '.' : '::')[0]!.length;
  }
  return out;
}

/** Whitespace-normalised, capped header text: a stable signature to compare. */
export function normaliseSig(text: string, cap = 300): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > cap ? one.slice(0, cap) : one;
}

/**
 * From `start`, the text up to the end of a balanced parameter list and any
 * return annotation, stopping at the body (`{`, `=>`, `:` for Python) at depth 0.
 */
export function headerFrom(code: string, start: number, stops: string[], cap = 600): string {
  let depth = 0;
  const end = Math.min(code.length, start + cap);
  for (let j = start; j < end; j++) {
    const c = code[j]!;
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      for (const s of stops) if (code.startsWith(s, j)) return code.slice(start, j);
    }
  }
  return code.slice(start, end);
}
