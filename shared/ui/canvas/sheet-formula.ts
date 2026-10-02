/**
 * The formula language of AICO Sheets — Excel's own syntax, parsed and
 * evaluated here so the grid, the agent's tool and the .xlsx export agree on
 * every number.
 *
 * ## Why Excel's grammar and Excel's answers
 *
 * A sheet is exported to Excel and read back from it, and the model already
 * writes Excel formulas without being taught. So the syntax is Excel's
 * (A1 refs, `$` anchors, `Sheet!A1`, `'My sheet'!A1:B2`, `%`, `&`, `^` with
 * negation binding tighter: `-2^2` is 4), and so are the edge cases the tests
 * pin: blanks are 0 in arithmetic and "" in text, `"3"+1` is 4, SUM over a
 * range skips text but SUM("x") is #VALUE!, AVERAGE of nothing is #DIV/0!,
 * ROUND rounds half away from zero, text compares case-insensitively and
 * numbers < text < booleans. Errors are Excel's seven codes, so a cached value
 * written to .xlsx is one Excel understands. A circular reference is #REF!
 * with the loop named in `detail` (Excel shows 0 and a warning bar; a silent 0
 * in a BOQ total is the worse failure).
 *
 * ## Evaluation order, not recursion
 *
 * `computeBook` (in `sheet-model`) builds the dependency graph once, finds the
 * cycles with an iterative Tarjan pass, and evaluates in dependency order — a
 * column of ten thousand `=A1+1` chains would overflow the stack of a
 * recursive evaluator. There is no INDIRECT/OFFSET, so every dependency is
 * visible in the formula text and the graph is exact.
 *
 * ## What it deliberately is not
 *
 * No array formulas or spills (a range in a cell is #VALUE!), no named ranges
 * (#NAME?), no R1C1, no locale-specific separators. Unknown functions are
 * #NAME?; a formula that does not parse is #ERROR! (Google Sheets' word —
 * Excel refuses to store one) and is exported to .xlsx as text, never as a
 * formula Excel would have to repair.
 *
 * @module shared/ui/canvas/sheet-formula
 */

// ── Values ───────────────────────────────────────────────────────────

export type ErrorCode = '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#N/A' | '#NUM!' | '#NULL!' | '#ERROR!';
export const ERROR_CODES: readonly ErrorCode[] = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#NUM!', '#NULL!', '#ERROR!'];
export interface SheetError { error: ErrorCode; detail?: string }
/** `null` is a blank cell. */
export type Scalar = number | string | boolean | null;
export type Value = Scalar | SheetError;
interface RangeValue { range: true; rows: Value[][] }
type EvalValue = Value | RangeValue;

export function isError(v: unknown): v is SheetError {
  return typeof v === 'object' && v !== null && typeof (v as SheetError).error === 'string';
}
export function sheetError(code: ErrorCode, detail?: string): SheetError {
  return detail ? { error: code, detail } : { error: code };
}
function isRange(v: EvalValue): v is RangeValue {
  return typeof v === 'object' && v !== null && (v as RangeValue).range === true;
}

// ── Addresses ────────────────────────────────────────────────────────

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

export interface CellAddr { r: number; c: number }
export interface RangeAddr { r1: number; c1: number; r2: number; c2: number }

/** 0 → "A", 26 → "AA". */
export function colName(c: number): string {
  let s = '';
  let n = c + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
/** "A" → 0, "AA" → 26; -1 when it is not a column. */
export function colIndex(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1 < MAX_COLS ? n - 1 : -1;
}
export function a1(r: number, c: number): string { return `${colName(c)}${r + 1}`; }
export function parseA1(ref: string): CellAddr | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!m) return null;
  const c = colIndex(m[1]!);
  const r = Number(m[2]) - 1;
  return c < 0 || r < 0 || r >= MAX_ROWS ? null : { r, c };
}
/** "A1:B3", "B3:A1" (normalised), or one cell. */
export function parseRangeA1(text: string): RangeAddr | null {
  const [a, b] = text.trim().split(':');
  const p = parseA1(a ?? '');
  const q = b === undefined ? p : parseA1(b);
  if (!p || !q) return null;
  return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
}
export function rangeA1(r: RangeAddr): string {
  const a = a1(r.r1, r.c1);
  const b = a1(r.r2, r.c2);
  return a === b ? a : `${a}:${b}`;
}

/** A sheet name as a formula writes it: quoted when it is not a plain word. */
export function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

// ── Tokens ───────────────────────────────────────────────────────────

interface RefPart { r?: number; c?: number; ar: boolean; ac: boolean }
type Tok =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'str'; v: string; s: number; e: number }
  | { t: 'bool'; v: boolean; s: number; e: number }
  | { t: 'err'; v: ErrorCode; s: number; e: number }
  | { t: 'ref'; sheet?: string; prefix: string; a: RefPart; b?: RefPart; kind: 'cell' | 'col' | 'row'; s: number; e: number }
  | { t: 'func'; name: string; s: number; e: number; nameEnd: number }
  | { t: 'name'; name: string; s: number; e: number }
  | { t: 'op'; v: string; s: number; e: number }
  | { t: '(' | ')' | ','; s: number; e: number };

const SHEET_PREFIX = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!`;
const CELL = String.raw`(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})`;
const RE_CELL = new RegExp(`(?:${SHEET_PREFIX})?${CELL}(?::${CELL})?(?![A-Za-z0-9_(!.])`, 'y');
const RE_COLS = new RegExp(String.raw`(?:${SHEET_PREFIX})?(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])`, 'y');
const RE_ROWS = new RegExp(String.raw`(?:${SHEET_PREFIX})?(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![0-9A-Za-z_.(])`, 'y');
const RE_FUNC = /([A-Za-z_][A-Za-z0-9_.]*)\s*\(/y;
const RE_NAME = /[A-Za-z_][A-Za-z0-9_.]*/y;
const RE_NUM = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;

function at(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(text);
}

/** Tokenise a formula (without its leading `=`). Throws on a character it cannot read. */
export function tokenize(f: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < f.length) {
    const ch = f[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= f.length) throw new Error('a text value is missing its closing "');
        if (f[j] === '"') { if (f[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
        v += f[j++];
      }
      out.push({ t: 'str', v, s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      const code = ERROR_CODES.find(c => f.slice(i, i + c.length).toUpperCase() === c);
      if (!code) throw new Error(`"${f.slice(i, i + 8)}" is not an error value`);
      out.push({ t: 'err', v: code, s: i, e: i + code.length });
      i += code.length;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') { out.push({ t: ch, s: i, e: i + 1 }); i++; continue; }
    const two = f.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') { out.push({ t: 'op', v: two, s: i, e: i + 2 }); i += 2; continue; }
    if ('+-*/^&=<>%'.includes(ch)) { out.push({ t: 'op', v: ch, s: i, e: i + 1 }); i++; continue; }

    let m: RegExpExecArray | null;
    if ((m = at(RE_FUNC, f, i))) {
      out.push({ t: 'func', name: m[1]!.toUpperCase(), s: i, e: i + m[0].length, nameEnd: i + m[1]!.length });
      i += m[0].length;
      continue;
    }
    if ((m = at(RE_CELL, f, i))) {
      const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
      const part = (d1: string | undefined, c: string, d2: string | undefined, r: string): RefPart =>
        ({ c: colIndex(c), r: Number(r) - 1, ac: d1 === '$', ar: d2 === '$' });
      const a = part(m[3], m[4]!, m[5], m[6]!);
      const b = m[8] !== undefined ? part(m[7], m[8], m[9], m[10]!) : undefined;
      if (a.c! >= 0 && (!b || b.c! >= 0) && a.r! >= 0 && (!b || b.r! >= 0)) {
        const prefixLen = m[1] !== undefined || m[2] !== undefined ? m[0].indexOf('!') + 1 : 0;
        out.push({ t: 'ref', ...(sheet !== undefined ? { sheet } : {}), prefix: m[0].slice(0, prefixLen), a, ...(b ? { b } : {}), kind: 'cell', s: i, e: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }
    if ((m = at(RE_COLS, f, i))) {
      const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
      const ca = colIndex(m[4]!);
      const cb = colIndex(m[6]!);
      if (ca >= 0 && cb >= 0) {
        const prefixLen = sheet !== undefined ? m[0].indexOf('!') + 1 : 0;
        out.push({ t: 'ref', ...(sheet !== undefined ? { sheet } : {}), prefix: m[0].slice(0, prefixLen), kind: 'col',
          a: { c: ca, ac: m[3] === '$', ar: false }, b: { c: cb, ac: m[5] === '$', ar: false }, s: i, e: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }
    if ((m = at(RE_ROWS, f, i))) {
      const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
      const ra = Number(m[4]) - 1;
      const rb = Number(m[6]) - 1;
      if (ra >= 0 && rb >= 0) {
        const prefixLen = sheet !== undefined ? m[0].indexOf('!') + 1 : 0;
        out.push({ t: 'ref', ...(sheet !== undefined ? { sheet } : {}), prefix: m[0].slice(0, prefixLen), kind: 'row',
          a: { r: ra, ar: m[3] === '$', ac: false }, b: { r: rb, ar: m[5] === '$', ac: false }, s: i, e: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }
    if ((m = at(RE_NUM, f, i))) { out.push({ t: 'num', v: Number(m[0]), s: i, e: i + m[0].length }); i += m[0].length; continue; }
    if ((m = at(RE_NAME, f, i))) {
      const up = m[0].toUpperCase();
      if (up === 'TRUE' || up === 'FALSE') out.push({ t: 'bool', v: up === 'TRUE', s: i, e: i + m[0].length });
      else out.push({ t: 'name', name: m[0], s: i, e: i + m[0].length });
      i += m[0].length;
      continue;
    }
    throw new Error(`unexpected "${ch}" at position ${i + 1}`);
  }
  return out;
}

// ── Parsing ──────────────────────────────────────────────────────────

export type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'err'; v: ErrorCode }
  | { k: 'ref'; sheet?: string; r: number; c: number }
  | { k: 'range'; sheet?: string; r1: number; c1: number; r2: number; c2: number; whole?: 'col' | 'row' }
  | { k: 'un'; op: '-' | '+'; a: Node }
  | { k: 'pct'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'name'; name: string }
  | { k: 'missing' };

const parseCache = new Map<string, Node | Error>();

/** Parse a formula (with or without its `=`). Throws with a readable reason. Cached by text. */
export function parseFormula(formula: string): Node {
  const f = formula.replace(/^\s*=/, '');
  const hit = parseCache.get(f);
  if (hit instanceof Error) throw hit;
  if (hit) return hit;
  try {
    const node = new Parser(tokenize(f)).parseAll();
    if (parseCache.size > 5000) parseCache.clear();
    parseCache.set(f, node);
    return node;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    parseCache.set(f, e);
    throw e;
  }
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}
  private peek(): Tok | undefined { return this.toks[this.i]; }
  private isOp(...ops: string[]): string | undefined {
    const t = this.peek();
    return t && t.t === 'op' && ops.includes(t.v) ? t.v : undefined;
  }
  parseAll(): Node {
    if (this.toks.length === 0) throw new Error('the formula is empty');
    const n = this.comparison();
    const t = this.peek();
    if (t) throw new Error(`unexpected ${t.t === 'op' ? `"${t.v}"` : t.t === ')' ? '")"' : t.t === ',' ? '","' : 'text'} at position ${t.s + 1}`);
    return n;
  }
  private comparison(): Node {
    let a = this.concat();
    for (let op = this.isOp('=', '<>', '<', '>', '<=', '>='); op; op = this.isOp('=', '<>', '<', '>', '<=', '>=')) {
      this.i++;
      a = { k: 'bin', op, a, b: this.concat() };
    }
    return a;
  }
  private concat(): Node {
    let a = this.additive();
    while (this.isOp('&')) { this.i++; a = { k: 'bin', op: '&', a, b: this.additive() }; }
    return a;
  }
  private additive(): Node {
    let a = this.multiplicative();
    for (let op = this.isOp('+', '-'); op; op = this.isOp('+', '-')) { this.i++; a = { k: 'bin', op, a, b: this.multiplicative() }; }
    return a;
  }
  private multiplicative(): Node {
    let a = this.power();
    for (let op = this.isOp('*', '/'); op; op = this.isOp('*', '/')) { this.i++; a = { k: 'bin', op, a, b: this.power() }; }
    return a;
  }
  private power(): Node {
    let a = this.percent();
    while (this.isOp('^')) { this.i++; a = { k: 'bin', op: '^', a, b: this.percent() }; }
    return a;
  }
  private percent(): Node {
    let a = this.unary();
    while (this.isOp('%')) { this.i++; a = { k: 'pct', a }; }
    return a;
  }
  private unary(): Node {
    const op = this.isOp('-', '+');
    if (op) { this.i++; return { k: 'un', op: op as '-' | '+', a: this.unary() }; }
    return this.primary();
  }
  private primary(): Node {
    const t = this.peek();
    if (!t) throw new Error('the formula ends too early');
    this.i++;
    switch (t.t) {
      case 'num': return { k: 'num', v: t.v };
      case 'str': return { k: 'str', v: t.v };
      case 'bool': return { k: 'bool', v: t.v };
      case 'err': return { k: 'err', v: t.v };
      case 'name': return { k: 'name', name: t.name };
      case 'ref': return refNode(t);
      case '(': {
        const n = this.comparison();
        if (this.peek()?.t !== ')') throw new Error('a "(" is missing its ")"');
        this.i++;
        return n;
      }
      case 'func': {
        const args: Node[] = [];
        if (this.peek()?.t === ')') { this.i++; return { k: 'call', name: t.name, args }; }
        for (;;) {
          const p = this.peek();
          if (p?.t === ',' || p?.t === ')') args.push({ k: 'missing' });
          else args.push(this.comparison());
          const q = this.peek();
          if (q?.t === ',') { this.i++; continue; }
          if (q?.t === ')') { this.i++; break; }
          throw new Error(`${t.name}( is missing its ")"`);
        }
        return { k: 'call', name: t.name.replace(/^_XLFN\./, ''), args };
      }
      default:
        throw new Error(`unexpected ${t.t === 'op' ? `"${t.v}"` : `"${t.t}"`} at position ${t.s + 1}`);
    }
  }
}

function refNode(t: Extract<Tok, { t: 'ref' }>): Node {
  const sheet = t.sheet !== undefined ? { sheet: t.sheet } : {};
  if (t.kind === 'col') {
    return { k: 'range', ...sheet, r1: 0, r2: MAX_ROWS - 1, c1: Math.min(t.a.c!, t.b!.c!), c2: Math.max(t.a.c!, t.b!.c!), whole: 'col' };
  }
  if (t.kind === 'row') {
    return { k: 'range', ...sheet, c1: 0, c2: MAX_COLS - 1, r1: Math.min(t.a.r!, t.b!.r!), r2: Math.max(t.a.r!, t.b!.r!), whole: 'row' };
  }
  if (!t.b) return { k: 'ref', ...sheet, r: t.a.r!, c: t.a.c! };
  return {
    k: 'range', ...sheet, r1: Math.min(t.a.r!, t.b.r!), r2: Math.max(t.a.r!, t.b.r!), c1: Math.min(t.a.c!, t.b.c!), c2: Math.max(t.a.c!, t.b.c!),
  };
}

/** Every cell or range a formula reads, for the dependency graph. */
export function references(node: Node, out: Array<Extract<Node, { k: 'ref' | 'range' }>> = []): Array<Extract<Node, { k: 'ref' | 'range' }>> {
  switch (node.k) {
    case 'ref': case 'range': out.push(node); break;
    case 'un': case 'pct': references(node.a, out); break;
    case 'bin': references(node.a, out); references(node.b, out); break;
    case 'call': for (const a of node.args) references(a, out); break;
    default: break;
  }
  return out;
}

// ── Rewriting formulas (fill, sort, insert/delete, rename, export) ───

function partText(p: RefPart): string {
  return `${p.c !== undefined ? `${p.ac ? '$' : ''}${colName(p.c)}` : ''}${p.r !== undefined ? `${p.ar ? '$' : ''}${p.r + 1}` : ''}`;
}

/**
 * Rewrite every reference in a formula, keeping all other characters as they
 * were. `fn` returns the new parts, or null for a reference that no longer
 * exists (written `#REF!`, as Excel does). A formula that does not tokenise
 * is returned unchanged.
 */
function rewriteRefs(formula: string, fn: (tok: Extract<Tok, { t: 'ref' }>) => { a: RefPart; b?: RefPart; prefix?: string } | null | undefined): string {
  let toks: Tok[];
  try { toks = tokenize(formula); } catch { return formula; }
  let out = '';
  let last = 0;
  for (const t of toks) {
    if (t.t !== 'ref') continue;
    const next = fn(t);
    if (next === undefined) continue;
    out += formula.slice(last, t.s);
    if (next === null) out += `${t.prefix}#REF!`;
    else out += `${next.prefix ?? t.prefix}${partText(next.a)}${next.b ? `:${partText(next.b)}` : ''}`;
    last = t.e;
  }
  return out + formula.slice(last);
}

/** A formula copied `dr` rows and `dc` columns away: relative parts move, `$` parts stay. */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  if (!dr && !dc) return formula;
  return rewriteRefs(formula, (t) => {
    const move = (p: RefPart): RefPart | null => {
      const r = p.r === undefined || p.ar ? p.r : p.r + dr;
      const c = p.c === undefined || p.ac ? p.c : p.c + dc;
      if ((r !== undefined && (r < 0 || r >= MAX_ROWS)) || (c !== undefined && (c < 0 || c >= MAX_COLS))) return null;
      return { ...p, ...(r !== undefined ? { r } : {}), ...(c !== undefined ? { c } : {}) };
    };
    const a = move(t.a);
    const b = t.b ? move(t.b) : undefined;
    if (!a || b === null) return null;
    return { a, ...(b ? { b } : {}) };
  });
}

/**
 * Rows or columns inserted (`count` > 0) or deleted (`count` < 0) at `at` in
 * the sheet `target`: every reference into that sheet follows the cells it
 * named, `$` or not. A reference to a deleted cell becomes #REF!; a range
 * loses the deleted part. `here` is the sheet the formula lives on (for refs
 * without a sheet prefix).
 */
export function adjustFormula(formula: string, target: string, here: string, axis: 'row' | 'col', at: number, count: number): string {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  return rewriteRefs(formula, (t) => {
    if (!same(t.sheet ?? here, target)) return undefined;
    const key = axis === 'row' ? 'r' : 'c';
    const v1 = t.a[key];
    if (v1 === undefined) return undefined; // a whole-column ref when rows move, or the other way round
    const v2 = t.b ? t.b[key]! : v1;
    const lo = Math.min(v1, v2);
    const hi = Math.max(v1, v2);
    let nlo = lo;
    let nhi = hi;
    if (count > 0) {
      if (lo >= at) nlo = lo + count;
      if (hi >= at) nhi = hi + count;
    } else {
      const del = -count;
      const end = at + del - 1;
      if (lo >= at && hi <= end) return null;
      nlo = lo < at ? lo : lo > end ? lo - del : at;
      nhi = hi < at ? hi : hi > end ? hi - del : at - 1;
    }
    const set = (p: RefPart, v: number): RefPart => ({ ...p, [key]: v });
    if (!t.b) return { a: set(t.a, nlo) };
    // Keep which end was written first.
    return v1 <= v2 ? { a: set(t.a, nlo), b: set(t.b, nhi) } : { a: set(t.a, nhi), b: set(t.b, nlo) };
  });
}

/** A sheet renamed: references that name it follow. */
export function renameSheetInFormula(formula: string, from: string, to: string): string {
  return rewriteRefs(formula, (t) => (t.sheet !== undefined && t.sheet.toLowerCase() === from.toLowerCase()
    ? { a: t.a, ...(t.b ? { b: t.b } : {}), prefix: `${quoteSheet(to)}!` }
    : undefined));
}

/** Rename functions (the .xlsx file format spells newer ones `_xlfn.XLOOKUP`). */
export function mapFunctionNames(formula: string, fn: (name: string) => string): string {
  let toks: Tok[];
  try { toks = tokenize(formula); } catch { return formula; }
  let out = '';
  let last = 0;
  for (const t of toks) {
    if (t.t !== 'func') continue;
    const name = formula.slice(t.s, t.nameEnd);
    const next = fn(name.toUpperCase());
    if (next.toUpperCase() === name.toUpperCase()) continue;
    out += formula.slice(last, t.s) + next;
    last = t.nameEnd;
  }
  return out + formula.slice(last);
}

// ── Dates ────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30);

/** Excel's 1900 date system, including its phantom 29 February 1900 (serial 60). */
export function dateSerial(y: number, m: number, d: number): number {
  const ms = Date.UTC(y, m - 1, d);
  let serial = Math.round((ms - EPOCH) / DAY_MS);
  if (serial < 61) serial -= 1;
  return serial;
}
export function serialDate(serial: number): { y: number; m: number; d: number; dow: number } {
  let days = Math.floor(serial);
  if (days < 61) days += 1;
  const dt = new Date(EPOCH + days * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
}
export function todaySerial(now = new Date()): number {
  return dateSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

// ── Coercion ─────────────────────────────────────────────────────────

/** A number as Excel's General format writes it into text: 15 significant digits, no trailing zeros. */
export function numberText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const p = Number(n.toPrecision(15));
  return String(p);
}

function toNumber(v: Value): number | SheetError {
  if (isError(v)) return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return 0;
  const t = v.trim();
  if (t === '') return sheetError('#VALUE!', 'empty text is not a number');
  const pct = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)%$/.exec(t);
  if (pct) return Number(pct[1]) / 100;
  const n = Number(t.replace(/,/g, ''));
  return /^[+-]?[\d,]*\.?\d+(?:[eE][+-]?\d+)?$/.test(t) && Number.isFinite(n) ? n : sheetError('#VALUE!', `"${t.slice(0, 40)}" is not a number`);
}
function toText(v: Value): string | SheetError {
  if (isError(v)) return v;
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numberText(v);
  return v;
}
function toBool(v: Value): boolean | SheetError {
  if (isError(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  const u = v.trim().toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return sheetError('#VALUE!', `"${v.slice(0, 40)}" is not TRUE or FALSE`);
}
function finite(n: number): number | SheetError {
  return Number.isFinite(n) ? n : sheetError('#NUM!', 'the result is too large');
}

/** Excel's ordering: numbers < text < booleans; text case-insensitive; blank is 0, "" or FALSE. */
export function compareValues(a: Scalar, b: Scalar): number {
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === 'number' ? 0 : typeof b === 'boolean' ? false : '';
  if (b === null) b = typeof a === 'number' ? 0 : typeof a === 'boolean' ? false : '';
  const rank = (v: Scalar): number => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  const ra = rank(a); const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  const x = String(a).toLowerCase(); const y = String(b).toLowerCase();
  return x === y ? 0 : x < y ? -1 : 1;
}

/** Round half away from zero, as Excel does (ROUND(2.5,0)=3, ROUND(-2.5,0)=-3, ROUND(1.005,2)=1.01). */
export function roundHalfAway(x: number, digits: number): number {
  const d = Math.trunc(digits);
  const f = 10 ** Math.abs(d);
  const scaled = d >= 0 ? Math.abs(x) * f : Math.abs(x) / f;
  const r = Math.round(Number(scaled.toPrecision(15)));
  return Math.sign(x) * (d >= 0 ? r / f : r * f);
}

// ── Evaluation ───────────────────────────────────────────────────────

export interface EvalContext {
  /** The sheet the formula lives on. */
  sheet: string;
  /** A sheet named in a formula, to its id; undefined/absent name means the current sheet. null when there is no such sheet. */
  resolveSheet(name: string | undefined): string | null;
  /** The (already computed) value of a cell. */
  value(sheet: string, r: number, c: number): Value;
  /** How far a sheet's content reaches, to bound whole-row/column ranges. */
  extent(sheet: string): { rows: number; cols: number };
  today: number;
}

export function evaluate(node: Node, ctx: EvalContext): Value {
  const v = ev(node, ctx);
  if (!isRange(v)) return v;
  if (v.rows.length === 1 && v.rows[0]!.length === 1) return v.rows[0]![0]!;
  return sheetError('#VALUE!', 'a range cannot be shown in one cell — wrap it in SUM, INDEX-free lookups or another function');
}

function scalar(v: EvalValue): Value {
  if (!isRange(v)) return v;
  if (v.rows.length === 1 && v.rows[0]!.length === 1) return v.rows[0]![0]!;
  return sheetError('#VALUE!', 'a range was used where one value is expected');
}

const MAX_RANGE_CELLS = 2_000_000;

function readRange(n: Extract<Node, { k: 'range' }>, ctx: EvalContext): RangeValue | SheetError {
  const sheet = ctx.resolveSheet(n.sheet);
  if (sheet === null) return sheetError('#REF!', `there is no sheet "${n.sheet}"`);
  let { r2, c2 } = n;
  if (n.whole) {
    const ext = ctx.extent(sheet);
    if (n.whole === 'col') r2 = Math.min(r2, Math.max(0, ext.rows - 1));
    else c2 = Math.min(c2, Math.max(0, ext.cols - 1));
  }
  if ((r2 - n.r1 + 1) * (c2 - n.c1 + 1) > MAX_RANGE_CELLS) return sheetError('#NUM!', 'the range is too large');
  const rows: Value[][] = [];
  for (let r = n.r1; r <= r2; r++) {
    const row: Value[] = [];
    for (let c = n.c1; c <= c2; c++) row.push(ctx.value(sheet, r, c));
    rows.push(row);
  }
  return { range: true, rows };
}

function ev(n: Node, ctx: EvalContext): EvalValue {
  switch (n.k) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'bool': return n.v;
    case 'err': return sheetError(n.v);
    case 'missing': return null;
    case 'name': return sheetError('#NAME?', `"${n.name}" is not a function, cell or sheet this knows`);
    case 'ref': {
      const sheet = ctx.resolveSheet(n.sheet);
      if (sheet === null) return sheetError('#REF!', `there is no sheet "${n.sheet}"`);
      return ctx.value(sheet, n.r, n.c);
    }
    case 'range': return readRange(n, ctx);
    case 'un': {
      const x = toNumber(scalar(ev(n.a, ctx)));
      if (isError(x)) return x;
      return n.op === '-' ? -x : x;
    }
    case 'pct': {
      const x = toNumber(scalar(ev(n.a, ctx)));
      return isError(x) ? x : x / 100;
    }
    case 'bin': return binary(n.op, scalar(ev(n.a, ctx)), scalar(ev(n.b, ctx)));
    case 'call': return call(n, ctx);
  }
}

function binary(op: string, a: Value, b: Value): Value {
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (op === '&') {
    const x = toText(a); const y = toText(b);
    if (isError(x)) return x;
    if (isError(y)) return y;
    return x + y;
  }
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
    const c = compareValues(a, b);
    switch (op) {
      case '=': return c === 0;
      case '<>': return c !== 0;
      case '<': return c < 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      default: return c >= 0;
    }
  }
  const x = toNumber(a); const y = toNumber(b);
  if (isError(x)) return x;
  if (isError(y)) return y;
  switch (op) {
    case '+': return finite(x + y);
    case '-': return finite(x - y);
    case '*': return finite(x * y);
    case '/': return y === 0 ? sheetError('#DIV/0!', 'division by zero') : finite(x / y);
    case '^': {
      if (x === 0 && y === 0) return sheetError('#NUM!', '0^0 is undefined');
      if (x === 0 && y < 0) return sheetError('#DIV/0!', 'division by zero');
      const r = x ** y;
      return Number.isNaN(r) ? sheetError('#NUM!', 'no real result') : finite(r);
    }
    default: return sheetError('#VALUE!', `unknown operator ${op}`);
  }
}

// ── Functions ────────────────────────────────────────────────────────

/** Each argument's cells (a range) or itself (a single value). */
function cellsOf(v: EvalValue): { values: Value[]; fromRange: boolean } {
  if (isRange(v)) return { values: v.rows.flat(), fromRange: true };
  return { values: [v], fromRange: false };
}

/**
 * The numbers SUM-like functions see: from a range only numbers (text,
 * booleans and blanks skipped); typed directly, booleans and numeric text
 * count and other text is #VALUE!. Any error wins.
 */
function numbers(args: EvalValue[], opts: { direct?: boolean } = {}): number[] | SheetError {
  const out: number[] = [];
  for (const a of args) {
    const { values, fromRange } = cellsOf(a);
    for (const v of values) {
      if (isError(v)) return v;
      if (typeof v === 'number') { out.push(v); continue; }
      if (fromRange || opts.direct === false) continue;
      if (v === null) continue;
      const n = toNumber(v);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** COUNTIF/SUMIF criteria: 5, ">5", "<>x", "=a*", "" (blank), "<>" (not blank). */
export function criteria(c: Value): (v: Value) => boolean {
  if (isError(c)) return () => false;
  if (typeof c === 'number' || typeof c === 'boolean') {
    return v => (typeof c === 'number' ? (typeof v === 'number' && v === c) || (typeof v === 'string' && v.trim() !== '' && Number(v) === c)
      : v === c);
  }
  const text = c === null ? '' : String(c);
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(text)!;
  const op = m[1] ?? '=';
  const operand = m[2]!;
  const num = operand.trim() !== '' && Number.isFinite(Number(operand)) ? Number(operand) : undefined;
  const upper = operand.toUpperCase();
  if (num !== undefined) {
    return (v) => {
      if (isError(v)) return false;
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
      if (n === undefined) return op === '<>';
      switch (op) {
        case '=': return n === num;
        case '<>': return n !== num;
        case '<': return n < num;
        case '>': return n > num;
        case '<=': return n <= num;
        default: return n >= num;
      }
    };
  }
  if (op === '=' || op === '<>') {
    if (operand === '') return v => (op === '=' ? v === null || v === '' : !(v === null || v === ''));
    const bool = upper === 'TRUE' ? true : upper === 'FALSE' ? false : undefined;
    const re = wildcard(operand);
    const hit = (v: Value): boolean => {
      if (isError(v) || v === null) return false;
      if (bool !== undefined) return v === bool;
      if (typeof v !== 'string') return false;
      return re.test(v);
    };
    return op === '=' ? hit : v => !hit(v);
  }
  return (v) => {
    if (typeof v !== 'string') return false;
    const cmp = compareValues(v, operand);
    return op === '<' ? cmp < 0 : op === '>' ? cmp > 0 : op === '<=' ? cmp <= 0 : cmp >= 0;
  };
}

/** Excel wildcards: * any run, ? one character, ~ escapes. Case-insensitive, whole text. */
function wildcard(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '~' && i + 1 < pattern.length) { re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function argCount(name: string, args: unknown[], min: number, max = min): SheetError | undefined {
  if (args.length < min || args.length > max) {
    return sheetError('#VALUE!', `${name} takes ${min === max ? min : `${min} to ${max === Infinity ? 'any number of' : max}`} argument${max === 1 ? '' : 's'}`);
  }
  return undefined;
}

function rows2d(v: EvalValue): Value[][] {
  return isRange(v) ? v.rows : [[v]];
}

function lookupEquals(target: Value, v: Value): boolean {
  if (isError(v) || isError(target)) return false;
  if (typeof target === 'string' && /[*?~]/.test(target)) return typeof v === 'string' && wildcard(target).test(v);
  if (v === null) return false;
  return typeof v === typeof target && compareValues(v, target as Scalar) === 0;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** TEXT(value, format): the common number and date codes. */
export function formatWithCode(value: number, code: string): string {
  const section = code.split(';');
  const fmt = value < 0 && section[1] !== undefined ? section[1] : section[0]!;
  const abs = value < 0 && section[1] !== undefined ? Math.abs(value) : value;
  // Dates and times: any d, m, y, h, s outside quotes.
  const bare = fmt.replace(/"[^"]*"/g, '').replace(/\\./g, '');
  if (/[dyhs]/i.test(bare) || (/m/i.test(bare) && !/[0#]/.test(bare))) {
    const { y, m, d, dow } = serialDate(abs);
    const frac = abs - Math.floor(abs);
    const secs = Math.round(frac * 86400);
    const hh = Math.floor(secs / 3600); const mi = Math.floor((secs % 3600) / 60); const ss = secs % 60;
    const ampm = /AM\/PM/i.test(fmt);
    let out = '';
    const toks = fmt.match(/"[^"]*"|\\.|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|[\s\S]/gi) ?? [];
    let lastWasHour = false;
    for (const t of toks) {
      const l = t.toLowerCase();
      if (t.startsWith('"')) { out += t.slice(1, -1); continue; }
      if (t.startsWith('\\')) { out += t.slice(1); continue; }
      switch (l) {
        case 'yyyy': out += String(y); break;
        case 'yy': out += String(y % 100).padStart(2, '0'); break;
        case 'mmmm': out += MONTHS[m - 1]; break;
        case 'mmm': out += MONTHS[m - 1]!.slice(0, 3); break;
        case 'mm': out += lastWasHour ? String(mi).padStart(2, '0') : String(m).padStart(2, '0'); break;
        case 'm': out += lastWasHour ? String(mi) : String(m); break;
        case 'dddd': out += DAYS[dow]; break;
        case 'ddd': out += DAYS[dow]!.slice(0, 3); break;
        case 'dd': out += String(d).padStart(2, '0'); break;
        case 'd': out += String(d); break;
        case 'hh': out += String(ampm ? (hh % 12 || 12) : hh).padStart(2, '0'); break;
        case 'h': out += String(ampm ? (hh % 12 || 12) : hh); break;
        case 'ss': out += String(ss).padStart(2, '0'); break;
        case 's': out += String(ss); break;
        case 'am/pm': out += hh < 12 ? 'AM' : 'PM'; break;
        default: out += t;
      }
      if (l === 'hh' || l === 'h') lastWasHour = true;
      else if (!/^[:\s]$/.test(t)) lastWasHour = false;
    }
    return out;
  }
  // Numbers: literal text around one numeric pattern of 0 # , . %.
  const m = /^((?:"[^"]*"|\\.|[^0#?.,%])*)([0#?,]*(?:\.[0#?]*)?)(%?)((?:"[^"]*"|\\.|[\s\S])*)$/.exec(fmt);
  if (!m || !m[2]) return numberText(value);
  const lit = (s: string): string => s.replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1');
  const [, pre, pat, pct, post] = m;
  const dec = pat!.includes('.') ? pat!.split('.')[1]!.length : 0;
  const scaled = pct ? abs * 100 : abs;
  const rounded = roundHalfAway(scaled, dec);
  const group = pat!.includes(',');
  const minInt = (pat!.split('.')[0]!.match(/0/g) ?? []).length;
  let [int, frac = ''] = Math.abs(rounded).toFixed(dec).split('.');
  if (minInt === 0 && int === '0') int = '';
  int = int!.padStart(minInt, '0');
  if (group) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = rounded < 0 && section[1] === undefined ? '-' : '';
  return `${sign}${lit(pre!)}${int}${dec ? `.${frac}` : ''}${pct}${lit(post!)}`;
}

/** The names `call` knows, for #NAME? and for the tool's description. */
export const FUNCTIONS = [
  'SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'COUNTIF', 'SUMIF', 'SUMPRODUCT', 'IF', 'IFERROR', 'AND', 'OR', 'NOT',
  'ROUND', 'ABS', 'INT', 'MOD', 'VLOOKUP', 'XLOOKUP', 'TEXT', 'DATE', 'TODAY', 'CONCAT', 'CONCATENATE', 'LEN', 'UPPER', 'LOWER',
] as const;

function call(n: Extract<Node, { k: 'call' }>, ctx: EvalContext): EvalValue {
  const name = n.name;
  // Lazy ones first: only the branch taken is evaluated, as in Excel.
  if (name === 'IF') {
    const bad = argCount('IF', n.args, 1, 3);
    if (bad) return bad;
    const cond = toBool(scalar(ev(n.args[0]!, ctx)));
    if (isError(cond)) return cond;
    if (cond) return n.args[1] && n.args[1].k !== 'missing' ? ev(n.args[1], ctx) : n.args[1] ? 0 : true;
    return n.args[2] ? (n.args[2].k === 'missing' ? 0 : ev(n.args[2], ctx)) : false;
  }
  if (name === 'IFERROR') {
    const bad = argCount('IFERROR', n.args, 2);
    if (bad) return bad;
    const v = scalar(ev(n.args[0]!, ctx));
    return isError(v) ? scalar(ev(n.args[1]!, ctx)) : v;
  }
  const args = n.args.map(a => ev(a, ctx));
  const one = (i: number): Value => scalar(args[i] ?? null);
  const num = (i: number): number | SheetError => toNumber(one(i));

  switch (name) {
    case 'SUM': {
      const xs = numbers(args);
      return isError(xs) ? xs : finite(xs.reduce((s, x) => s + x, 0));
    }
    case 'AVERAGE': {
      const xs = numbers(args);
      if (isError(xs)) return xs;
      return xs.length ? finite(xs.reduce((s, x) => s + x, 0) / xs.length) : sheetError('#DIV/0!', 'AVERAGE of no numbers');
    }
    case 'MIN': case 'MAX': {
      const xs = numbers(args);
      if (isError(xs)) return xs;
      if (!xs.length) return 0;
      return name === 'MIN' ? Math.min(...xs) : Math.max(...xs);
    }
    case 'COUNT': {
      let k = 0;
      for (const a of args) {
        const { values, fromRange } = cellsOf(a);
        for (const v of values) {
          if (typeof v === 'number') k++;
          else if (!fromRange && (typeof v === 'boolean' || (typeof v === 'string' && !isError(toNumber(v))))) k++;
        }
      }
      return k;
    }
    case 'COUNTA': {
      let k = 0;
      for (const a of args) for (const v of cellsOf(a).values) if (v !== null) k++;
      return k;
    }
    case 'COUNTIF': {
      const bad = argCount('COUNTIF', args, 2);
      if (bad) return bad;
      const test = criteria(one(1));
      return cellsOf(args[0]!).values.filter(test).length;
    }
    case 'SUMIF': {
      const bad = argCount('SUMIF', args, 2, 3);
      if (bad) return bad;
      const test = criteria(one(1));
      const where = rows2d(args[0]!);
      const sum = args[2] !== undefined ? rows2d(args[2]) : where;
      let total = 0;
      for (let r = 0; r < where.length; r++) {
        for (let c = 0; c < where[r]!.length; c++) {
          if (!test(where[r]![c]!)) continue;
          const v = sum[r]?.[c] ?? null;
          if (isError(v)) return v;
          if (typeof v === 'number') total += v;
        }
      }
      return finite(total);
    }
    case 'SUMPRODUCT': {
      if (!args.length) return sheetError('#VALUE!', 'SUMPRODUCT needs at least one range');
      const grids = args.map(rows2d);
      const h = grids[0]!.length; const w = grids[0]![0]?.length ?? 0;
      if (grids.some(g => g.length !== h || (g[0]?.length ?? 0) !== w)) return sheetError('#VALUE!', 'SUMPRODUCT ranges must be the same size');
      let total = 0;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          let p = 1;
          for (const g of grids) {
            const v = g[r]![c]!;
            if (isError(v)) return v;
            p *= typeof v === 'number' ? v : 0;
          }
          total += p;
        }
      }
      return finite(total);
    }
    case 'AND': case 'OR': {
      const bools: boolean[] = [];
      for (const a of args) {
        const { values, fromRange } = cellsOf(a);
        for (const v of values) {
          if (isError(v)) return v;
          if (typeof v === 'boolean') bools.push(v);
          else if (typeof v === 'number') bools.push(v !== 0);
          else if (!fromRange && v !== null) {
            const b = toBool(v);
            if (isError(b)) return b;
            bools.push(b);
          }
        }
      }
      if (!bools.length) return sheetError('#VALUE!', `${name} found no TRUE/FALSE values`);
      return name === 'AND' ? bools.every(Boolean) : bools.some(Boolean);
    }
    case 'NOT': {
      const bad = argCount('NOT', args, 1);
      if (bad) return bad;
      const b = toBool(one(0));
      return isError(b) ? b : !b;
    }
    case 'ROUND': {
      const bad = argCount('ROUND', args, 2);
      if (bad) return bad;
      const x = num(0); const d = num(1);
      if (isError(x)) return x;
      if (isError(d)) return d;
      return roundHalfAway(x, d);
    }
    case 'ABS': case 'INT': {
      const bad = argCount(name, args, 1);
      if (bad) return bad;
      const x = num(0);
      if (isError(x)) return x;
      return name === 'ABS' ? Math.abs(x) : Math.floor(x);
    }
    case 'MOD': {
      const bad = argCount('MOD', args, 2);
      if (bad) return bad;
      const x = num(0); const d = num(1);
      if (isError(x)) return x;
      if (isError(d)) return d;
      if (d === 0) return sheetError('#DIV/0!', 'MOD by zero');
      return x - d * Math.floor(x / d);
    }
    case 'VLOOKUP': {
      const bad = argCount('VLOOKUP', args, 3, 4);
      if (bad) return bad;
      const target = one(0);
      if (isError(target)) return target;
      const table = rows2d(args[1]!);
      const col = num(2);
      if (isError(col)) return col;
      const approx = args[3] === undefined || n.args[3]?.k === 'missing' ? true : toBool(one(3));
      if (isError(approx)) return approx;
      const ci = Math.trunc(col) - 1;
      if (ci < 0) return sheetError('#VALUE!', 'VLOOKUP column index must be 1 or more');
      if (ci >= (table[0]?.length ?? 0)) return sheetError('#REF!', 'VLOOKUP column index is beyond the table');
      if (!approx) {
        const row = table.find(r => lookupEquals(target, r[0]!));
        return row ? row[ci]! : sheetError('#N/A', 'VLOOKUP found no exact match');
      }
      let hit = -1;
      for (let r = 0; r < table.length; r++) {
        const v = table[r]![0]!;
        if (isError(v) || v === null) continue;
        if (typeof v !== typeof target) continue;
        if (compareValues(v, target as Scalar) <= 0) hit = r; else break;
      }
      return hit >= 0 ? table[hit]![ci]! : sheetError('#N/A', 'VLOOKUP found no value at or below the lookup value');
    }
    case 'XLOOKUP': {
      const bad = argCount('XLOOKUP', args, 3, 6);
      if (bad) return bad;
      const target = one(0);
      if (isError(target)) return target;
      const look = rows2d(args[1]!);
      const ret = rows2d(args[2]!);
      const vertical = look.length > 1 || (look[0]?.length ?? 0) === 1;
      const list = vertical ? look.map(r => r[0]!) : look[0]!;
      if (vertical ? ret.length !== list.length : (ret[0]?.length ?? 0) !== list.length) {
        return sheetError('#VALUE!', 'XLOOKUP lookup and return ranges must be the same length');
      }
      const mode = args[4] === undefined || n.args[4]?.k === 'missing' ? 0 : num(4);
      const dir = args[5] === undefined || n.args[5]?.k === 'missing' ? 1 : num(5);
      if (isError(mode)) return mode;
      if (isError(dir)) return dir;
      const order = list.map((_, i) => i);
      if (dir < 0) order.reverse();
      let hit = -1;
      if (mode === 0 || mode === 2) {
        hit = order.find(i => (mode === 2 ? lookupEquals(target, list[i]!) : !isError(list[i]!) && list[i] !== null
          && typeof list[i] === typeof target && compareValues(list[i] as Scalar, target as Scalar) === 0)) ?? -1;
      } else {
        let best = -1;
        for (const i of order) {
          const v = list[i]!;
          if (isError(v) || v === null || typeof v !== typeof target) continue;
          const c = compareValues(v, target as Scalar);
          if (c === 0) { best = i; break; }
          if (mode === -1 && c < 0 && (best < 0 || compareValues(v, list[best] as Scalar) > 0)) best = i;
          if (mode === 1 && c > 0 && (best < 0 || compareValues(v, list[best] as Scalar) < 0)) best = i;
        }
        hit = best;
      }
      if (hit < 0) {
        if (args[3] !== undefined && n.args[3]?.k !== 'missing') return one(3);
        return sheetError('#N/A', 'XLOOKUP found no match');
      }
      if (vertical) {
        const row = ret[hit]!;
        return row.length === 1 ? row[0]! : { range: true, rows: [row] };
      }
      const column = ret.map(r => r[hit]!);
      return column.length === 1 ? column[0]! : { range: true, rows: column.map(v => [v]) };
    }
    case 'TEXT': {
      const bad = argCount('TEXT', args, 2);
      if (bad) return bad;
      const v = one(0);
      const code = toText(one(1));
      if (isError(v)) return v;
      if (isError(code)) return code;
      const x = typeof v === 'string' ? toNumber(v) : toNumber(v);
      if (isError(x)) return typeof v === 'string' ? v : x;
      return formatWithCode(x, code);
    }
    case 'DATE': {
      const bad = argCount('DATE', args, 3);
      if (bad) return bad;
      const y = num(0); const m = num(1); const d = num(2);
      if (isError(y)) return y;
      if (isError(m)) return m;
      if (isError(d)) return d;
      const year = Math.trunc(y) < 1900 ? Math.trunc(y) + 1900 : Math.trunc(y);
      if (year < 1900 || year > 9999) return sheetError('#NUM!', 'DATE year must be 1900–9999');
      const s = dateSerial(year, Math.trunc(m), Math.trunc(d));
      return s < 1 ? sheetError('#NUM!', 'the date is before 1900') : s;
    }
    case 'TODAY': return ctx.today;
    case 'CONCAT': case 'CONCATENATE': {
      let s = '';
      for (const a of args) {
        for (const v of cellsOf(a).values) {
          const t = toText(v);
          if (isError(t)) return t;
          s += t;
        }
      }
      return s;
    }
    case 'LEN': case 'UPPER': case 'LOWER': {
      const bad = argCount(name, args, 1);
      if (bad) return bad;
      const t = toText(one(0));
      if (isError(t)) return t;
      return name === 'LEN' ? t.length : name === 'UPPER' ? t.toUpperCase() : t.toLowerCase();
    }
    default:
      return sheetError('#NAME?', `${name} is not a function AICO Sheets knows (${FUNCTIONS.join(', ')})`);
  }
}
