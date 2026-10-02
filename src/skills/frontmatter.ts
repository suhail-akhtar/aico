/**
 * The YAML that sits between a skill's `---` lines, read and written without
 * a YAML library.
 *
 * WHY THIS EXISTS. The loader used to split each line on its first colon. That
 * is fine for `name: commit` and wrong for the files people actually have:
 * Claude's skills write long descriptions as `description: >-` block scalars
 * (which imported with the description ">-"), list `allowed-tools` one per
 * line (lost), and carry a `metadata:` map (lost). Design §5.1 / F6.
 *
 * WHY NOT A DEPENDENCY. The owner chose an in-house reader over the `yaml`
 * package (design §12a, Q1): frontmatter is a small, fixed subset, and the
 * package would be more code to audit than this file.
 *
 * WHAT IT READS. The subset skill files use: plain, single- and double-quoted
 * scalars (including multi-line plain continuations); `|` and `>` block scalars
 * with `-`/`+` chomping and an optional indentation digit; block lists
 * (`- a`) and flow lists (`[a, "b"]`); block maps nested to any depth and
 * one-line flow maps (`{a: b}`); `#` comments. Scalars stay strings — `1.0`
 * is not silently turned into `1` — with `~` and an empty value read as null.
 *
 * WHAT IT DOES NOT. Anchors, aliases, tags, multi-document streams and complex
 * keys are refused with a line number for the keys AICO reads. For any other
 * key the raw text is kept, so a field this reader does not understand (a
 * Claude Code `hooks:` block, say) survives a rewrite byte for byte — the
 * "unknown keys kept" half of round-trip safety does not depend on parsing
 * them.
 *
 * Leniency, deliberately: a `: ` inside a plain scalar is accepted (strict
 * YAML refuses it), because AICO's own skills were written for the old line
 * parser and "Note: this does X" must not stop loading.
 *
 * @module skills/frontmatter
 */

export type FmValue = string | null | FmValue[] | { [key: string]: FmValue };
export type FmMap = { [key: string]: FmValue };

export interface FrontmatterEntry {
  key: string;
  /** Parsed value, or undefined when this reader could not parse it. */
  value: FmValue | undefined;
  /** The entry's exact source lines (key line through its last continuation). */
  raw: string;
  /** 1-based line within the frontmatter block. */
  line: number;
  error?: string;
}

export interface ParsedFrontmatter {
  /** A `---` block was present at the top of the file. */
  hasBlock: boolean;
  /** Parsed values by key, for every entry that parsed. */
  data: FmMap;
  /** Every top-level entry in source order, with its raw text. */
  entries: FrontmatterEntry[];
  /** Everything after the closing `---`, unchanged (line endings normalised to LF). */
  body: string;
  /** Problems found, each naming the line. */
  errors: string[];
}

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

class YamlError extends Error {
  constructor(message: string, readonly line: number) { super(message); }
}

/** Normalise a file's text: no BOM, LF line endings. */
export function normaliseText(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return noBom.split(CR + LF).join(LF).split(CR).join(LF);
}

/**
 * Split a file into its frontmatter text and body. The block must open on the
 * first line; it closes at the next line that is exactly `---` (or `...`).
 */
export function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const t = normaliseText(text);
  const lines = t.split(LF);
  if (lines[0]?.trimEnd() !== '---') return { yaml: null, body: t };
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!.trimEnd();
    if (l === '---' || l === '...') {
      return { yaml: lines.slice(1, i).join(LF), body: lines.slice(i + 1).join(LF) };
    }
  }
  return { yaml: null, body: t };
}

interface Line { n: number; indent: number; text: string; raw: string; blank: boolean }

function toLines(yaml: string, offset = 1): Line[] {
  return yaml.split(LF).map((raw, i) => {
    const indentMatch = /^[ ]*/.exec(raw)![0];
    const rest = raw.slice(indentMatch.length);
    const blank = rest.trim() === '' || rest.trimStart().startsWith('#');
    return { n: i + offset, indent: indentMatch.length, text: rest, raw, blank };
  });
}

/** Strip a trailing ` # comment` from a plain scalar. */
function stripComment(s: string): string {
  const i = s.search(/\s#/);
  return (i >= 0 ? s.slice(0, i) : s).trimEnd();
}

function unescapeDouble(body: string, line: number): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') { out += c; continue; }
    const n = body[++i];
    switch (n) {
      case 'n': out += LF; break;
      case 't': out += '\t'; break;
      case 'r': out += CR; break;
      case '0': out += '\0'; break;
      case '"': out += '"'; break;
      case '/': out += '/'; break;
      case '\\': out += '\\'; break;
      case ' ': out += ' '; break;
      case 'x': out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; break;
      case 'u': out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; break;
      case 'U': out += String.fromCodePoint(parseInt(body.slice(i + 1, i + 9), 16)); i += 8; break;
      default: throw new YamlError(`unknown escape "\\${n ?? ''}" in a double-quoted string`, line);
    }
  }
  return out;
}

/** Fold the lines of a multi-line quoted or plain scalar: single breaks become spaces, blank lines become newlines. */
function foldLines(parts: string[]): string {
  let out = '';
  let pendingBreaks = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = i === 0 ? parts[i]!.trimEnd() : i === parts.length - 1 ? parts[i]!.trimStart() : parts[i]!.trim();
    if (p === '' && i > 0 && i < parts.length - 1) { pendingBreaks++; continue; }
    if (i > 0) out += pendingBreaks > 0 ? LF.repeat(pendingBreaks) : ' ';
    pendingBreaks = 0;
    out += p;
  }
  return out;
}

/**
 * Read a quoted scalar that starts at `lines[i].text.slice(col)`, possibly
 * spanning lines. Returns the value and the index of the line it ended on.
 */
function readQuoted(lines: Line[], i: number, col: number): { value: string; end: number; rest: string } {
  const q = lines[i]!.text[col]!;
  const parts: string[] = [];
  let cur = lines[i]!.text.slice(col + 1);
  let li = i;
  for (;;) {
    let j = 0;
    let closed = -1;
    while (j < cur.length) {
      if (q === "'" && cur[j] === "'") {
        if (cur[j + 1] === "'") { j += 2; continue; }
        closed = j; break;
      }
      if (q === '"' && cur[j] === '\\') { j += 2; continue; }
      if (q === '"' && cur[j] === '"') { closed = j; break; }
      j++;
    }
    if (closed >= 0) {
      parts.push(cur.slice(0, closed));
      const rest = cur.slice(closed + 1);
      const joined = parts.length === 1 ? parts[0]! : foldLines(parts);
      const value = q === "'" ? joined.split("''").join("'") : unescapeDouble(joined, lines[i]!.n);
      return { value, end: li, rest };
    }
    parts.push(cur);
    li++;
    if (li >= lines.length) throw new YamlError(`unterminated ${q === '"' ? 'double' : 'single'}-quoted string`, lines[i]!.n);
    cur = lines[li]!.raw;
  }
}

/** Split a flow collection's inside on top-level commas, respecting quotes and nesting. */
function splitFlow(inner: string, line: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      if (quote === '"' && c === '\\') { i++; continue; }
      if (c === quote) {
        if (quote === "'" && inner[i + 1] === "'") { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push(inner.slice(start, i)); start = i + 1; }
  }
  if (quote) throw new YamlError('unterminated string in a flow collection', line);
  if (depth !== 0) throw new YamlError('unbalanced brackets in a flow collection', line);
  const last = inner.slice(start);
  if (last.trim() || out.length) out.push(last);
  return out.map(s => s.trim()).filter((s, idx, arr) => s !== '' || idx < arr.length - 1);
}

/** A scalar or flow collection written on one line (already joined if it spanned several). */
function parseInline(text: string, line: number): FmValue {
  const t = text.trim();
  if (t === '' || t === '~') return null;
  if (t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) {
    throw new YamlError('anchors, aliases and tags are not supported in skill frontmatter', line);
  }
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new YamlError('a flow list must close with ] on the same entry', line);
    return splitFlow(t.slice(1, -1), line).map(item => parseInline(item, line));
  }
  if (t.startsWith('{')) {
    if (!t.endsWith('}')) throw new YamlError('a flow map must close with } on the same entry', line);
    const map: FmMap = {};
    for (const pair of splitFlow(t.slice(1, -1), line)) {
      const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+?)\s*:(?:\s+|$)(.*)$/.exec(pair);
      if (!m) throw new YamlError(`expected "key: value" inside { }, got "${pair}"`, line);
      const key = keyText(m[1]!, line);
      map[key] = parseInline(m[2]!, line);
    }
    return map;
  }
  if (t.startsWith('"') || t.startsWith("'")) {
    const r = readQuoted([{ n: line, indent: 0, text: t, raw: t, blank: false }], 0, 0);
    if (r.rest.trim() && !r.rest.trim().startsWith('#')) throw new YamlError(`unexpected text after a quoted string: "${r.rest.trim()}"`, line);
    return r.value;
  }
  return stripComment(t);
}

function keyText(raw: string, line: number): string {
  const k = raw.trim();
  if (k.startsWith('"') || k.startsWith("'")) {
    return readQuoted([{ n: line, indent: 0, text: k, raw: k, blank: false }], 0, 0).value;
  }
  if (k.startsWith('?')) throw new YamlError('complex keys are not supported', line);
  return k;
}

/** A `key: rest` split, or null when the line is not a mapping entry. */
function splitKey(text: string): { key: string; rest: string } | null {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*)|$)/.exec(text);
  if (quoted) return { key: quoted[1]!, rest: quoted[2] ?? '' };
  const m = /^([^\s#'"\-[{][^:]*?|-[^\s][^:]*?)\s*:(?:\s+(.*)|$)/.exec(text);
  if (!m) return null;
  return { key: m[1]!, rest: m[2] ?? '' };
}

const BLOCK_HEADER = /^([|>])([1-9])?([+-])?([1-9])?\s*(#.*)?$/;

/** Read a `|` or `>` block scalar whose header is `header`, with content on the lines after `i`. */
function readBlockScalar(lines: Line[], i: number, header: string, parentIndent: number): { value: string; end: number } {
  const h = BLOCK_HEADER.exec(header.trim());
  if (!h) throw new YamlError(`malformed block scalar header "${header.trim()}"`, lines[i]!.n);
  const style = h[1]!;
  const chomp = h[3] ?? '';
  const explicit = Number(h[2] ?? h[4] ?? 0);

  // Content lines: every following line that is blank or indented past the parent.
  let end = i;
  const content: string[] = [];
  let indent = explicit ? parentIndent + explicit : 0;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]!;
    const isEmpty = l.raw.trim() === '';
    if (!isEmpty) {
      if (!indent) {
        if (l.indent <= parentIndent) break;
        indent = l.indent;
      }
      if (l.indent < indent) break;
    }
    content.push(l.raw);
    end = j;
  }
  // Trailing blank lines belong to chomping, not to the next entry; keep them in `content` but end the entry at the last.
  const stripped = content.map(raw => (raw.trim() === '' ? '' : raw.slice(indent)));
  let lastText = stripped.length - 1;
  while (lastText >= 0 && stripped[lastText] === '') lastText--;
  const textLines = stripped.slice(0, lastText + 1);
  const trailing = stripped.length - 1 - lastText;

  let value: string;
  if (style === '|') {
    value = textLines.join(LF);
  } else {
    // Folding: lines at the base indent join with spaces; blank lines are kept
    // as newlines; more-indented lines keep their breaks.
    value = '';
    let prevMore = false;
    let blankRun = 0;
    for (let k = 0; k < textLines.length; k++) {
      const l = textLines[k]!;
      if (l === '') { blankRun++; continue; }
      const more = /^\s/.test(l);
      if (k > 0 && value !== '') {
        if (blankRun > 0) value += LF.repeat(prevMore || more ? blankRun + 1 : blankRun);
        else value += prevMore || more ? LF : ' ';
      } else if (blankRun > 0) value += LF.repeat(blankRun);
      value += l;
      prevMore = more;
      blankRun = 0;
    }
  }
  if (textLines.length === 0) value = '';
  if (chomp === '-') { /* strip: no final newline */ }
  else if (chomp === '+') value += LF.repeat(trailing + (textLines.length ? 1 : 0));
  else if (textLines.length) value += LF;
  // Lines after the content that were blank are part of this entry's raw text.
  return { value, end };
}

/** The lines that belong to a value starting after line `i` (indented past `parentIndent`). */
function childEnd(lines: Line[], i: number, parentIndent: number, allowSameIndentList: boolean): number {
  let end = i;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.blank) continue;
    if (l.indent > parentIndent) { end = j; continue; }
    if (allowSameIndentList && l.indent === parentIndent && /^-(\s|$)/.test(l.text)) { end = j; continue; }
    break;
  }
  return end;
}

/** A block list or block map occupying `lines[from..to]`. */
function parseBlock(lines: Line[], from: number, to: number): FmValue {
  const firstIdx = lines.findIndex((l, k) => k >= from && k <= to && !l.blank);
  if (firstIdx < 0) return null;
  const first = lines[firstIdx]!;
  if (/^-(\s|$)/.test(first.text)) return parseBlockList(lines, from, to, first.indent);
  if (splitKey(first.text)) return parseBlockMap(lines, from, to, first.indent);
  // A scalar that starts on the line after its key (`description:` then an indented paragraph).
  return parseScalarAt(lines, firstIdx, first.text, first.indent, to).value;
}

function parseBlockList(lines: Line[], from: number, to: number, indent: number): FmValue[] {
  const out: FmValue[] = [];
  let j = from;
  while (j <= to) {
    const l = lines[j]!;
    if (l.blank) { j++; continue; }
    if (l.indent !== indent || !/^-(\s|$)/.test(l.text)) {
      throw new YamlError(`expected a "- item" at this indentation (${indent} spaces)`, l.n);
    }
    const after = l.text.slice(1);
    const itemText = after.trimStart();
    const itemCol = indent + 1 + (after.length - itemText.length);
    const end = Math.min(childEnd(lines, j, indent, false), to);
    if (itemText === '') {
      out.push(end > j ? parseBlock(lines, j + 1, end) : null);
    } else if (BLOCK_HEADER.test(itemText)) {
      out.push(readBlockScalar(lines, j, itemText, indent).value);
    } else if (splitKey(itemText) && !/^["'[{]/.test(itemText)) {
      // `- key: value` — a map item; its other keys sit at the item's column.
      const virtual: Line[] = [{ n: l.n, indent: itemCol, text: itemText, raw: ' '.repeat(itemCol) + itemText, blank: false }, ...lines.slice(j + 1, end + 1)];
      out.push(parseBlockMap(virtual, 0, virtual.length - 1, itemCol));
    } else {
      out.push(parseScalarAt(lines, j, itemText, indent, end).value);
    }
    j = end + 1;
  }
  return out;
}

function parseBlockMap(lines: Line[], from: number, to: number, indent: number): FmMap {
  const out: FmMap = {};
  let j = from;
  while (j <= to) {
    const l = lines[j]!;
    if (l.blank) { j++; continue; }
    if (l.indent !== indent) throw new YamlError(`unexpected indentation (${l.indent} spaces; expected ${indent})`, l.n);
    const kv = splitKey(l.text);
    if (!kv) throw new YamlError(`expected "key: value", got "${l.text.trim()}"`, l.n);
    const key = keyText(kv.key, l.n);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`"${key}" appears twice`, l.n);
    const end = Math.min(childEnd(lines, j, indent, kv.rest.trim() === ''), to);
    out[key] = parseValue(lines, j, kv.rest, indent, end);
    j = end + 1;
  }
  return out;
}

/** A value whose first text is `rest` on line `i`, with continuation lines up to `end`. */
function parseValue(lines: Line[], i: number, rest: string, indent: number, end: number): FmValue {
  const r = rest.trim();
  if (r === '' || r.startsWith('#')) return end > i ? parseBlock(lines, i + 1, end) : null;
  if (BLOCK_HEADER.test(r)) return readBlockScalar(lines, i, r, indent).value;
  return parseScalarAt(lines, i, r, indent, end).value;
}

/** A scalar (plain, quoted, or flow) beginning on line `i` that may continue to `end`. */
function parseScalarAt(lines: Line[], i: number, text: string, _indent: number, end: number): { value: FmValue } {
  const t = text.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const col = lines[i]!.text.indexOf(t);
    const r = readQuoted(lines, i, col >= 0 ? col : 0);
    if (r.rest.trim() && !r.rest.trim().startsWith('#')) throw new YamlError(`unexpected text after a quoted string: "${r.rest.trim()}"`, lines[r.end]!.n);
    return { value: r.value };
  }
  if (t.startsWith('[') || t.startsWith('{')) {
    // A flow collection may wrap over several lines.
    const joined = [t, ...lines.slice(i + 1, end + 1).filter(l => !l.blank).map(l => l.text.trim())].join(' ');
    return { value: parseInline(joined, lines[i]!.n) };
  }
  if (t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) {
    throw new YamlError('anchors, aliases and tags are not supported in skill frontmatter', lines[i]!.n);
  }
  // A plain scalar, possibly continued on more-indented lines (folded with spaces).
  const parts = [stripComment(t)];
  for (let j = i + 1; j <= end; j++) {
    const l = lines[j]!;
    if (l.raw.trim() === '') { parts.push(''); continue; }
    if (l.text.trimStart().startsWith('#')) continue;
    parts.push(stripComment(l.text.trim()));
  }
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  const value = parts.length === 1 ? parts[0]! : foldLines(parts);
  return { value: value === '~' ? null : value };
}

/**
 * Parse frontmatter text (without the `---` lines) into top-level entries.
 * Each entry is parsed on its own, so one malformed key does not lose the rest.
 */
export function parseYamlSubset(yaml: string): { data: FmMap; entries: FrontmatterEntry[]; errors: string[] } {
  if (/\t/.test(yaml.split(LF).map(l => /^[ \t]*/.exec(l)![0]).join(''))) {
    // Tabs are not indentation in YAML; say so rather than misreading them.
    const n = yaml.split(LF).findIndex(l => /^[ ]*\t/.test(l)) + 1;
    return { data: {}, entries: [], errors: [`line ${n}: a tab is used for indentation; YAML needs spaces`] };
  }
  const lines = toLines(yaml);
  const data: FmMap = {};
  const entries: FrontmatterEntry[] = [];
  const errors: string[] = [];
  let j = 0;
  // Blank and comment lines before an entry travel with it, so a rewrite that
  // keeps the entry keeps the comment that explains it.
  let lead = 0;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.blank) { j++; continue; }
    if (l.indent !== 0) {
      errors.push(`line ${l.n}: unexpected indentation — top-level keys start at the left margin`);
      j++;
      lead = j;
      continue;
    }
    const kv = splitKey(l.text);
    if (!kv) {
      errors.push(`line ${l.n}: expected "key: value", got "${l.text.trim().slice(0, 60)}"`);
      j++;
      lead = j;
      continue;
    }
    const isBlockHeader = BLOCK_HEADER.test(kv.rest.trim());
    let end = isBlockHeader ? readBlockEnd(lines, j) : childEnd(lines, j, 0, kv.rest.trim() === '');
    // Trailing blank/comment lines after the value stay with the next entry.
    while (end > j && lines[end]!.blank && !isBlockHeader) end--;
    const raw = lines.slice(lead, end + 1).map(x => x.raw).join(LF);
    lead = end + 1;
    let key = kv.key;
    try {
      key = keyText(kv.key, l.n);
      if (Object.prototype.hasOwnProperty.call(data, key) || entries.some(e => e.key === key)) {
        throw new YamlError(`"${key}" appears twice`, l.n);
      }
      const value = parseValue(lines, j, kv.rest, 0, end);
      data[key] = value;
      entries.push({ key, value, raw, line: l.n });
    } catch (err) {
      const msg = err instanceof YamlError ? `line ${err.line}: ${err.message}` : `line ${l.n}: ${(err as Error).message}`;
      entries.push({ key, value: undefined, raw, line: l.n, error: msg });
      errors.push(`${key}: ${msg}`);
    }
    j = end + 1;
  }
  return { data, entries, errors };
}

/** Where a block scalar starting on line `i` (indent 0) ends: the last line indented past 0, or blank between them. */
function readBlockEnd(lines: Line[], i: number): number {
  let end = i;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.raw.trim() === '') continue;
    if (l.indent > 0) { end = j; continue; }
    break;
  }
  return end;
}

/** Parse a whole file: the frontmatter block and the body after it. */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const { yaml, body } = splitFrontmatter(text);
  if (yaml === null) return { hasBlock: false, data: {}, entries: [], body, errors: [] };
  const parsed = parseYamlSubset(yaml);
  return { hasBlock: true, ...parsed, body };
}

// ── writing ─────────────────────────────────────────────────────────────

/** Strings that would read back as something else if written plain. */
function needsQuotes(s: string): boolean {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/: |\s#|:$/.test(s)) return true;
  if (/^(~|null|true|false|yes|no|on|off)$/i.test(s)) return true;
  if (/[\u0000-\u001f\u007f]/.test(s)) return true;
  return false;
}

function quoteDouble(s: string): string {
  return '"' + s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`) + '"';
}

/** A scalar as it should be written after `key: `, at `indent`. */
function writeScalar(s: string, indent: number): string {
  if (s.includes(LF)) {
    const trailing = /\n*$/.exec(s)![0].length;
    const chomp = trailing === 0 ? '-' : trailing === 1 ? '' : '+';
    const content = trailing ? s.slice(0, s.length - trailing) : s;
    // A first line that starts with a space needs an explicit indentation indicator.
    const indicator = /^\s/.test(content) ? '2' : '';
    const pad = ' '.repeat(indent + 2);
    const body = content.split(LF).map(l => (l === '' ? '' : pad + l)).join(LF);
    return `|${indicator}${chomp}${LF}${body}${chomp === '+' ? LF.repeat(trailing - 1) : ''}`;
  }
  return needsQuotes(s) ? quoteDouble(s) : s;
}

function writeValue(v: FmValue, indent: number): string {
  const pad = ' '.repeat(indent);
  if (v === null) return '';
  if (typeof v === 'string') return ' ' + writeScalar(v, indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return ' []';
    if (v.every(x => typeof x === 'string' && !x.includes(LF))) {
      const inline = `[${(v as string[]).map(x => (needsQuotes(x) || /[,[\]{}]/.test(x) ? quoteDouble(x) : x)).join(', ')}]`;
      if (inline.length + indent < 100) return ' ' + inline;
    }
    return LF + v.map(x => `${pad}  -${writeValue(x, indent + 2)}`).join(LF);
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return ' {}';
  return LF + keys.map(k => `${pad}  ${writeKey(k)}:${writeValue(v[k]!, indent + 2)}`).join(LF);
}

function writeKey(k: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(k) ? k : quoteDouble(k);
}

/** One top-level `key: value` entry as YAML text. */
export function stringifyEntry(key: string, value: FmValue): string {
  return `${writeKey(key)}:${writeValue(value, 0)}`;
}

/**
 * Write a frontmatter map as YAML. Entries in `keep` (raw source text by key)
 * are written verbatim instead — that is how a key this module does not
 * understand survives a rewrite unchanged.
 */
export function stringifyFrontmatter(data: FmMap, keep: Record<string, string> = {}): string {
  return Object.keys(data)
    .map(k => (keep[k] !== undefined ? keep[k]! : stringifyEntry(k, data[k]!)))
    .join(LF);
}

/** A whole SKILL.md: the block, then the body as given. */
export function composeMarkdown(data: FmMap, body: string, keep: Record<string, string> = {}): string {
  const yaml = stringifyFrontmatter(data, keep);
  const b = body.startsWith(LF) || body === '' ? body : LF + body;
  return `---${LF}${yaml}${LF}---${b}`;
}

/**
 * Change some keys of an existing file and keep everything else exactly as it
 * was: untouched entries keep their raw text and position; a key set to
 * `undefined` is removed; new keys go at the end.
 */
export function updateFrontmatter(text: string, patch: Record<string, FmValue | undefined>): string {
  const parsed = parseFrontmatter(text);
  const lines: string[] = [];
  const done = new Set<string>();
  for (const e of parsed.entries) {
    if (Object.prototype.hasOwnProperty.call(patch, e.key)) {
      done.add(e.key);
      const v = patch[e.key];
      if (v !== undefined) lines.push(stringifyEntry(e.key, v));
      continue;
    }
    lines.push(e.raw);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (done.has(k) || v === undefined) continue;
    lines.push(stringifyEntry(k, v));
  }
  const body = parsed.hasBlock ? parsed.body : normaliseText(text);
  const b = body.startsWith(LF) || body === '' ? body : LF + body;
  return `---${LF}${lines.join(LF)}${LF}---${b}`;
}

/** A value as a single string, for fields the spec defines as text. */
export function asText(v: FmValue | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(x => asText(x) ?? '').join(', ');
  return undefined;
}

/**
 * A tool list, in any of the shapes it arrives in: a YAML list, Claude's
 * space-separated string (`Read Grep Bash(git status:*)`), or the
 * comma-separated string AICO wrote. Spaces inside parentheses do not split,
 * so `Bash(git add:*)` stays one entry.
 */
export function asList(v: FmValue | undefined): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(x => asText(x) ?? '').map(s => s.trim()).filter(Boolean);
  if (typeof v !== 'string') return undefined;
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of v) {
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (c === ',' || /\s/.test(c))) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
