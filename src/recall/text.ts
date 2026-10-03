/**
 * Words, for Recall: one tokenizer shared by the write-side duplicate check,
 * the FTS5 query builder and the relevance threshold.
 *
 * WHY ONE PLACE. The duplicate check (memory/store, on write), the search
 * (recall/search) and the upkeep merge all ask "are these the same words?".
 * Three slightly different tokenizers would give three answers, and a memory
 * merged on write but not by upkeep (or the reverse) is a bug nobody can see.
 *
 * WHY THE QUERY IS REBUILT, NOT ESCAPED. FTS5's MATCH has its own grammar
 * (`AND`, `NEAR(...)`, `col:`, `^`, `*`, quotes, parentheses). Passing a
 * person's text through means `"what about C++?"` is a syntax error and
 * `title:secret` is a column filter. So user text never reaches MATCH: it is
 * split into word tokens and each is emitted as a quoted string, OR-joined.
 * A token cannot contain a quote (they are split away), so nothing can close
 * the string early.
 *
 * Deliberately not here: a real stemmer. SQLite's porter tokenizer stems the
 * index; the light suffix strip below only has to make the *JS-side* checks
 * (coverage, Jaccard) agree with each other, not with porter exactly.
 *
 * @module recall/text
 */

/** Too common to carry meaning. Short on purpose (see knowledge/match). */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'then',
  'there', 'these', 'this', 'to', 'when', 'with', 'you', 'your', 'we', 'our',
  'i', 'me', 'my', 'do', 'does', 'not', 'no', 'so', 'up', 'out', 'all', 'can',
  'was', 'were', 'what', 'which', 'who', 'how', 'did', 'have', 'has', 'had',
  'about', 'last', 'time', 'remember', 'please', 'should', 'would', 'could',
  'will', 'just', 'us', 'they', 'them', 'he', 'she', 'his', 'her', 'than',
]);

/** Light suffix strip so "deploys", "deployed" and "deploying" compare equal. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ied')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('es') && /(?:ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

/** Lowercase word tokens (letters and digits, any script), stopwords kept. */
export function rawTokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Meaningful, stemmed tokens: what two texts are compared on. */
export function terms(text: string): string[] {
  return rawTokens(text).filter(t => t.length > 1 && !STOPWORDS.has(t)).map(stem);
}

export function termSet(text: string): Set<string> {
  return new Set(terms(text));
}

/** |A∩B| / |A∪B| over meaningful terms. 1 for two empty texts is wrong, so 0. */
export function jaccard(a: string | Set<string>, b: string | Set<string>): number {
  const A = typeof a === 'string' ? termSet(a) : a;
  const B = typeof b === 'string' ? termSet(b) : b;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Text compared for exact-duplicate purposes: case, spacing and trailing punctuation do not count. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?;,\s]+$/g, '').trim();
}

/** Most query terms sent to MATCH; a whole pasted request is not a query. */
const MAX_QUERY_TERMS = 24;

/**
 * A safe FTS5 MATCH expression for arbitrary text, or '' when it has no words.
 *
 * Each distinct meaningful token becomes a quoted string; tokens of six or
 * more letters also add a quoted prefix of all but their last two letters
 * (`"postgr"*`), which forgives a typo in a word's ending and nothing else.
 */
export function ftsQuery(text: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const t of rawTokens(text)) {
    if (t.length < 2 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    // Tokens are [\p{L}\p{N}]+ so they cannot contain a quote; the replace is belt and braces.
    const safe = t.replace(/"/g, '');
    parts.push(`"${safe}"`);
    if (safe.length >= 6) parts.push(`"${safe.slice(0, Math.max(4, safe.length - 2))}"*`);
    if (seen.size >= MAX_QUERY_TERMS) break;
  }
  return parts.join(' OR ');
}

/** The query's terms, for the coverage check that decides relevance. */
export function queryTerms(text: string): string[] {
  return [...new Set(terms(text))].slice(0, MAX_QUERY_TERMS);
}

/** How many of the query's terms the text contains (prefix-tolerant for long words). */
export function matchedTerms(query: readonly string[], text: string): number {
  const have = termSet(text);
  let n = 0;
  for (const q of query) {
    if (have.has(q)) { n++; continue; }
    if (q.length >= 6) {
      const p = q.slice(0, Math.max(4, q.length - 2));
      for (const h of have) if (h.startsWith(p)) { n++; break; }
    }
  }
  return n;
}

/** One line, at most `max` characters, cut on a word where possible. */
export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Rough tokens for a budget: four characters each, as tokens.ts estimates. */
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * What a memory is *about*, when it says so in a recognisable shape.
 *
 * "Package manager: pnpm", "Deploy day is Friday", "The staging URL =
 * https://…". Returns the normalized subject and value, or undefined when the
 * text has no such shape. Conservative on purpose — a wrong subject marks a
 * true memory superseded:
 * - `key: value` and `key = value` count with a key of one to six words;
 * - `X is Y` counts only with at least two words of subject and a short value
 *   (three words at most), so "The API server is slow" and "The API server is
 *   written in Go and deployed on Fly" are not read as a contradiction.
 */
export function subjectOf(text: string): { subject: string; value: string } | undefined {
  const first = text.split('\n')[0]!.trim();
  const kv = /^([^:=]{2,60}?)\s*[:=]\s+(\S.*)$/.exec(first);
  if (kv && !/^\w+:\/\//.test(first)) {
    const left = terms(kv[1]!);
    if (left.length >= 1 && left.length <= 6) return { subject: left.join(' '), value: normalizeText(kv[2]!) };
  }
  const is = /^(.{3,60}?)\s+(?:is|are)\s+(\S.*)$/i.exec(first);
  if (is) {
    const left = terms(is[1]!);
    const right = terms(is[2]!);
    if (left.length >= 2 && left.length <= 6 && right.length >= 1 && right.length <= 3) {
      return { subject: left.join(' '), value: normalizeText(is[2]!) };
    }
  }
  return undefined;
}
