/**
 * AICO Sheets — the workbook a `sheet` canvas holds, and every operation on
 * it, written once for the grid, the agent's tool and the exports.
 *
 * ## Storage: a versioned JSON text, one cell per line
 *
 * A sheet canvas keeps its workbook as the content of its one canvas tab, so
 * it rides the same store, versions, 409-on-stale-write and history as a
 * document (`src/canvas/store.ts`). The text is JSON with a format marker
 * (`{"aicoSheet":1,…}`) written by {@link serializeBook} one cell per line in
 * row order, so two versions diff like a spreadsheet changed, not like a blob
 * was replaced. Values are stored, not display text: a date is its Excel
 * serial number with a date format, a percentage is 0.15 with a percent
 * format — exactly what .xlsx stores, so export and import are lossless for
 * what the model covers.
 *
 * Cell: `{v?, f?, s?}` — a value, or a formula (`f`, Excel syntax without
 * `=`) whose value is computed, and a style (`num` format kind, `dp`
 * decimals, `cur` ISO currency, `b` bold, `fill` `#RRGGBB`, `align`). A sheet
 * adds column widths (px), a frozen header (`freeze.rows/cols`), conditional
 * fills, charts drawn from a range, and whether its filter row is on.
 *
 * ## Writes are small
 *
 * The person's grid and the agent's tool both change a sheet through these
 * pure operations (set cells, styles, insert/delete rows and columns with
 * every formula following its cells, sort, fill down, paste) and save the
 * result with the version it was based on. The agent sends the cells it
 * changes, never the sheet. The grid keeps its unsaved operations and replays
 * them on the agent's newer version (`replay`), so the two can work on one
 * sheet at once without a conflict banner unless they touch the same cell.
 *
 * Formulas: `sheet-formula.ts`. Contract: `docs/engineering/canvas-docs-contract.md`.
 *
 * @module shared/ui/canvas/sheet-model
 */

import {
  a1, adjustFormula, colIndex, colName, compareValues, dateSerial, evaluate, isError, numberText,
  parseA1, parseFormula, parseRangeA1, rangeA1, references, renameSheetInFormula, roundHalfAway, serialDate,
  sheetError, shiftFormula, todaySerial, MAX_COLS, MAX_ROWS,
  type EvalContext, type Node, type RangeAddr, type Scalar, type SheetError, type Value,
} from './sheet-formula';

export type { Scalar, Value, SheetError, RangeAddr } from './sheet-formula';
export { a1, colName, colIndex, parseA1, parseRangeA1, rangeA1, isError } from './sheet-formula';

// ── The model ────────────────────────────────────────────────────────

export const SHEET_FORMAT = 1;
export type NumKind = 'general' | 'number' | 'currency' | 'percent' | 'date' | 'text';
export const NUM_KINDS: readonly NumKind[] = ['general', 'number', 'currency', 'percent', 'date', 'text'];

export interface CellStyle {
  num?: NumKind;
  /** Decimal places (number 2, currency 2, percent 0 by default). */
  dp?: number;
  /** ISO 4217 code for currency (default USD). */
  cur?: string;
  b?: boolean;
  /** Background, `#RRGGBB`. */
  fill?: string;
  align?: 'left' | 'center' | 'right';
}
export interface Cell { v?: Scalar; f?: string; s?: CellStyle }

export type CondOp = 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'ne' | 'between' | 'contains' | 'error';
export interface CondRule { range: string; op: CondOp; value?: Scalar; value2?: Scalar; fill: string }
export type SheetChartType = 'bar' | 'line' | 'area' | 'pie';
export interface SheetChart { id: string; range: string; type: SheetChartType; title?: string }

export interface Sheet {
  id: string;
  name: string;
  cells: Record<string, Cell>;
  /** Column letter → width in px. */
  cols?: Record<string, number>;
  freeze?: { rows?: number; cols?: number };
  cond?: CondRule[];
  charts?: SheetChart[];
  /** The filter row is on (an autoFilter over the data in .xlsx). */
  filter?: boolean;
}
export interface SheetBook { aicoSheet: typeof SHEET_FORMAT; sheets: Sheet[] }

export const MAX_SHEETS = 20;
export const DEFAULT_COL_PX = 100;
const MAX_NAME = 31;

export function emptyBook(name = 'Sheet1'): SheetBook {
  return { aicoSheet: SHEET_FORMAT, sheets: [{ id: 's1', name: cleanSheetName(name) || 'Sheet1', cells: {} }] };
}

/** Excel's rules for a sheet name: ≤ 31 characters, none of : \ / ? * [ ]. */
export function cleanSheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').slice(0, MAX_NAME);
}

const HEX = /^#[0-9a-f]{6}$/i;
const CUR = /^[A-Z]{3}$/;

function cleanStyle(s: unknown): CellStyle | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const o = s as Record<string, unknown>;
  const out: CellStyle = {};
  if (typeof o.num === 'string' && (NUM_KINDS as readonly string[]).includes(o.num) && o.num !== 'general') out.num = o.num as NumKind;
  if (typeof o.dp === 'number' && Number.isInteger(o.dp) && o.dp >= 0 && o.dp <= 10) out.dp = o.dp;
  if (typeof o.cur === 'string' && CUR.test(o.cur.toUpperCase())) out.cur = o.cur.toUpperCase();
  if (o.b === true) out.b = true;
  if (typeof o.fill === 'string' && HEX.test(o.fill)) out.fill = o.fill.toLowerCase();
  if (o.align === 'left' || o.align === 'center' || o.align === 'right') out.align = o.align;
  return Object.keys(out).length ? out : undefined;
}

function cleanCell(c: unknown): Cell | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const o = c as Record<string, unknown>;
  const out: Cell = {};
  if (typeof o.f === 'string' && o.f.trim()) out.f = o.f.replace(/^\s*=/, '').slice(0, 8000);
  else if (typeof o.v === 'number' && Number.isFinite(o.v)) out.v = o.v;
  else if (typeof o.v === 'string' && o.v !== '') out.v = o.v.slice(0, 32_000);
  else if (typeof o.v === 'boolean') out.v = o.v;
  const s = cleanStyle(o.s);
  if (s) out.s = s;
  return out.v !== undefined || out.f !== undefined || out.s ? out : undefined;
}

/**
 * Read a sheet canvas's text. Throws with a reason a model can act on when it
 * is not a workbook; drops (rather than refuses) individual malformed cells.
 */
export function parseBook(text: string): SheetBook {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('a sheet canvas holds a workbook as JSON ({"aicoSheet":1,"sheets":[…]}); this text is not JSON'); }
  const o = raw as { aicoSheet?: unknown; sheets?: unknown };
  if (!o || typeof o !== 'object' || o.aicoSheet !== SHEET_FORMAT || !Array.isArray(o.sheets)) {
    throw new Error('a sheet canvas holds {"aicoSheet":1,"sheets":[…]}');
  }
  if (o.sheets.length === 0) throw new Error('a workbook needs at least one sheet');
  if (o.sheets.length > MAX_SHEETS) throw new Error(`a workbook holds at most ${MAX_SHEETS} sheets`);
  const names = new Set<string>();
  const ids = new Set<string>();
  const sheets: Sheet[] = o.sheets.map((s: unknown, i: number) => {
    const x = (s ?? {}) as Record<string, unknown>;
    let name = cleanSheetName(typeof x.name === 'string' ? x.name : '') || `Sheet${i + 1}`;
    while (names.has(name.toLowerCase())) name = `${name.slice(0, MAX_NAME - 3)} ${i + 1}`;
    names.add(name.toLowerCase());
    let id = typeof x.id === 'string' && /^[\w-]{1,20}$/.test(x.id) ? x.id : `s${i + 1}`;
    while (ids.has(id)) id = `${id}x`;
    ids.add(id);
    const cells: Record<string, Cell> = {};
    if (x.cells && typeof x.cells === 'object') {
      for (const [ref, cell] of Object.entries(x.cells as Record<string, unknown>)) {
        const p = parseA1(ref);
        const c = cleanCell(cell);
        if (p && c) cells[a1(p.r, p.c)] = c;
      }
    }
    const sheet: Sheet = { id, name, cells };
    if (x.cols && typeof x.cols === 'object') {
      const cols: Record<string, number> = {};
      for (const [k, w] of Object.entries(x.cols as Record<string, unknown>)) {
        if (colIndex(k) >= 0 && typeof w === 'number' && w >= 20 && w <= 1000) cols[k.toUpperCase()] = Math.round(w);
      }
      if (Object.keys(cols).length) sheet.cols = cols;
    }
    const fr = x.freeze as { rows?: unknown; cols?: unknown } | undefined;
    if (fr && typeof fr === 'object') {
      const rows = typeof fr.rows === 'number' && fr.rows > 0 && fr.rows <= 50 ? Math.trunc(fr.rows) : 0;
      const cols = typeof fr.cols === 'number' && fr.cols > 0 && fr.cols <= 20 ? Math.trunc(fr.cols) : 0;
      if (rows || cols) sheet.freeze = { ...(rows ? { rows } : {}), ...(cols ? { cols } : {}) };
    }
    if (Array.isArray(x.cond)) {
      const cond = (x.cond as unknown[]).map(cleanCond).filter((r): r is CondRule => Boolean(r)).slice(0, 50);
      if (cond.length) sheet.cond = cond;
    }
    if (Array.isArray(x.charts)) {
      const charts = (x.charts as unknown[]).map(cleanChart).filter((c): c is SheetChart => Boolean(c)).slice(0, 10);
      if (charts.length) sheet.charts = charts;
    }
    if (x.filter === true) sheet.filter = true;
    return sheet;
  });
  return { aicoSheet: SHEET_FORMAT, sheets };
}

const COND_OPS: readonly CondOp[] = ['gt', 'lt', 'gte', 'lte', 'eq', 'ne', 'between', 'contains', 'error'];
function scalarOf(v: unknown): Scalar | undefined {
  return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : undefined;
}
export function cleanCond(r: unknown): CondRule | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const o = r as Record<string, unknown>;
  if (typeof o.range !== 'string' || !parseRangeA1(o.range)) return undefined;
  if (typeof o.op !== 'string' || !(COND_OPS as readonly string[]).includes(o.op)) return undefined;
  if (typeof o.fill !== 'string' || !HEX.test(o.fill)) return undefined;
  const value = scalarOf(o.value);
  const value2 = scalarOf(o.value2);
  if (o.op !== 'error' && value === undefined) return undefined;
  return {
    range: rangeA1(parseRangeA1(o.range)!), op: o.op as CondOp, fill: o.fill.toLowerCase(),
    ...(value !== undefined ? { value } : {}), ...(value2 !== undefined ? { value2 } : {}),
  };
}
function cleanChart(c: unknown): SheetChart | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const o = c as Record<string, unknown>;
  if (typeof o.range !== 'string' || !parseRangeA1(o.range)) return undefined;
  const type = o.type === 'line' || o.type === 'area' || o.type === 'pie' ? o.type : 'bar';
  return {
    id: typeof o.id === 'string' && /^[\w-]{1,20}$/.test(o.id) ? o.id : `c${Math.random().toString(36).slice(2, 8)}`,
    range: rangeA1(parseRangeA1(o.range)!), type,
    ...(typeof o.title === 'string' && o.title.trim() ? { title: o.title.trim().slice(0, 120) } : {}),
  };
}

/** Row-major order: A1, B1, …, A2. */
export function compareRefs(x: string, y: string): number {
  const p = parseA1(x)!; const q = parseA1(y)!;
  return p.r - q.r || p.c - q.c;
}

/** The workbook as its canvas text: stable key order, one cell per line, so versions diff by cell. */
export function serializeBook(book: SheetBook): string {
  const sheets = book.sheets.map((s) => {
    const head: Record<string, unknown> = { id: s.id, name: s.name };
    if (s.freeze) head.freeze = s.freeze;
    if (s.cols && Object.keys(s.cols).length) {
      head.cols = Object.fromEntries(Object.entries(s.cols).sort((a, b) => colIndex(a[0]) - colIndex(b[0])));
    }
    if (s.filter) head.filter = true;
    if (s.cond?.length) head.cond = s.cond;
    if (s.charts?.length) head.charts = s.charts;
    const keys = Object.keys(s.cells).sort(compareRefs);
    const cells = keys.map((k) => {
      const c = s.cells[k]!;
      const o: Record<string, unknown> = {};
      if (c.f !== undefined) o.f = c.f; else if (c.v !== undefined) o.v = c.v;
      if (c.s) o.s = c.s;
      return `${JSON.stringify(k)}:${JSON.stringify(o)}`;
    });
    const headText = JSON.stringify(head).slice(0, -1);
    return `${headText},"cells":{${cells.length ? `\n${cells.join(',\n')}\n` : ''}}}`;
  });
  return `{"aicoSheet":${SHEET_FORMAT},"sheets":[\n${sheets.join(',\n')}\n]}\n`;
}

/** Is this canvas text a workbook (rather than Markdown)? Cheap, no full parse. */
export function looksLikeBook(text: string): boolean {
  return /^\s*\{\s*"aicoSheet"\s*:/.test(text);
}

export function sheetByName(book: SheetBook, name: string | undefined): Sheet | undefined {
  if (name === undefined || name === '') return book.sheets[0];
  const n = name.trim().toLowerCase();
  return book.sheets.find(s => s.id === name) ?? book.sheets.find(s => s.name.toLowerCase() === n);
}

/** How far a sheet's content reaches: the bottom-right corner of the used cells (exclusive). */
export function usedExtent(sheet: Sheet): { rows: number; cols: number } {
  let rows = 0; let cols = 0;
  for (const k of Object.keys(sheet.cells)) {
    const p = parseA1(k)!;
    if (p.r + 1 > rows) rows = p.r + 1;
    if (p.c + 1 > cols) cols = p.c + 1;
  }
  return { rows, cols };
}

// ── Input: what a person types, what the agent sends ─────────────────

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', GBP: '£', EUR: '€', JPY: '¥', INR: '₹', CNY: '¥', KRW: '₩', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', CHF: 'CHF ',
  AED: 'AED ', SAR: 'SAR ', ZAR: 'R', BRL: 'R$', MXN: 'MX$', SGD: 'S$', HKD: 'HK$', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ', PKR: 'Rs ',
};
const SYMBOL_CURRENCY: Record<string, string> = { '$': 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR', '₩': 'KRW' };
export function currencySymbol(code = 'USD'): string { return CURRENCY_SYMBOLS[code] ?? `${code} `; }

export interface ParsedInput { cell: Cell | null; style?: CellStyle }

/**
 * Turn typed text into a cell the way a spreadsheet does: `=…` a formula,
 * `'…` literal text, numbers with thousands separators, `12%`, `$1,200`,
 * `2026-10-03` (a date), TRUE/FALSE. The style it implies (percent, currency,
 * date) is returned separately so it never overrides a format already set.
 */
export function parseInput(input: unknown): ParsedInput {
  if (input === null || input === undefined) return { cell: null };
  if (typeof input === 'number') return Number.isFinite(input) ? { cell: { v: input } } : { cell: null };
  if (typeof input === 'boolean') return { cell: { v: input } };
  const text = String(input);
  if (text === '') return { cell: null };
  if (text.startsWith('=') && text.trim().length > 1) return { cell: { f: text.trim().slice(1).trim() } };
  if (text.startsWith("'")) return text.length > 1 ? { cell: { v: text.slice(1) } } : { cell: null };
  const t = text.trim();
  if (/^(true|false)$/i.test(t)) return { cell: { v: t.toUpperCase() === 'TRUE' } };
  const num = (s: string): number | undefined => {
    if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s) || !/\d/.test(s)) return undefined;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
  };
  const plain = num(t);
  if (plain !== undefined) return { cell: { v: plain } };
  const pct = /^([+-]?[\d,.]+)\s*%$/.exec(t);
  if (pct && num(pct[1]!) !== undefined) {
    const p = num(pct[1]!)!;
    const dp = (pct[1]!.split('.')[1] ?? '').length;
    return { cell: { v: Number((p / 100).toPrecision(15)) }, style: { num: 'percent', ...(dp ? { dp } : {}) } };
  }
  const cur = /^(-)?\s*([$£€¥₹₩])\s*(-)?([\d,]*\.?\d+)$/.exec(t);
  if (cur && num(cur[4]!) !== undefined) {
    const n = num(cur[4]!)! * (cur[1] || cur[3] ? -1 : 1);
    return { cell: { v: n }, style: { num: 'currency', cur: SYMBOL_CURRENCY[cur[2]!] ?? 'USD' } };
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900) return { cell: { v: dateSerial(y, m, d) }, style: { num: 'date' } };
  }
  return { cell: { v: text } };
}

// ── Showing a value ──────────────────────────────────────────────────

export function isoDate(serial: number): string {
  const { y, m, d } = serialDate(serial);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function grouped(n: number, dp: number): string {
  const [int, frac] = Math.abs(roundHalfAway(n, dp)).toFixed(dp).split('.');
  return `${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
}

/** A computed value as the grid shows it, under its number format. */
export function formatValue(v: Value, s?: CellStyle): string {
  if (v === null) return '';
  if (isError(v)) return v.error;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  switch (s?.num) {
    case 'number': return `${v < 0 && roundHalfAway(v, s.dp ?? 2) !== 0 ? '-' : ''}${grouped(v, s.dp ?? 2)}`;
    case 'currency': return `${v < 0 && roundHalfAway(v, s.dp ?? 2) !== 0 ? '-' : ''}${currencySymbol(s.cur)}${grouped(v, s.dp ?? 2)}`;
    case 'percent': {
      const p = roundHalfAway(v * 100, s.dp ?? 0);
      return `${Object.is(p, -0) ? '0' : p.toFixed(s.dp ?? 0)}%`;
    }
    case 'date': return v >= 1 && v < 2_958_466 ? isoDate(v) : numberText(v);
    default: {
      if (Number.isInteger(v)) return Math.abs(v) < 1e11 ? String(v) : v.toExponential(5).replace(/\.?0+e/, 'E').replace('e', 'E');
      const a = Math.abs(v);
      if (a >= 1e11 || a < 1e-9) return v.toExponential(5).replace(/\.?0+e/, 'E').replace('e', 'E');
      return String(Number(v.toPrecision(10)));
    }
  }
}

/** What the formula bar shows for a cell: its formula, or its value in an editable spelling. */
export function editText(cell: Cell | undefined): string {
  if (!cell) return '';
  if (cell.f !== undefined) return `=${cell.f}`;
  const v = cell.v;
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (cell.s?.num === 'date' && v >= 1) return isoDate(v);
    if (cell.s?.num === 'percent') return `${numberText(Number((v * 100).toPrecision(15)))}%`;
    return numberText(v);
  }
  return /^(=|'|true$|false$)/i.test(v) || parseInput(v).cell?.v !== v ? `'${v}` : v;
}

// ── Computing ────────────────────────────────────────────────────────

export interface Computed {
  /** The value of any cell (formula or not); blank is null. */
  get(sheetId: string, ref: string): Value;
  at(sheetId: string, r: number, c: number): Value;
  /** Formula cells whose result is an error, with why. */
  errors: Array<{ sheet: string; ref: string; error: SheetError }>;
}

/**
 * Evaluate every formula in the workbook in dependency order. Cells on a
 * cycle are #REF! naming the loop; cells reading them inherit the error.
 */
export function computeBook(book: SheetBook, opts: { today?: number } = {}): Computed {
  const today = opts.today ?? todaySerial();
  const byName = new Map(book.sheets.map(s => [s.name.toLowerCase(), s.id]));
  const sheetOf = new Map(book.sheets.map(s => [s.id, s]));
  const extents = new Map(book.sheets.map(s => [s.id, usedExtent(s)]));
  const values = new Map<string, Value>();
  const key = (sheet: string, r: number, c: number): string => `${sheet}!${r},${c}`;

  // Formula cells, parsed once.
  interface FCell { key: string; sheet: string; r: number; c: number; ref: string; node?: Node; parseError?: string }
  const formulas = new Map<string, FCell>();
  const formulasBySheet = new Map<string, FCell[]>();
  for (const s of book.sheets) {
    const list: FCell[] = [];
    for (const [ref, cell] of Object.entries(s.cells)) {
      if (cell.f === undefined) continue;
      const p = parseA1(ref)!;
      const fc: FCell = { key: key(s.id, p.r, p.c), sheet: s.id, r: p.r, c: p.c, ref };
      try { fc.node = parseFormula(cell.f); } catch (err) { fc.parseError = (err as Error).message; }
      formulas.set(fc.key, fc);
      list.push(fc);
    }
    formulasBySheet.set(s.id, list);
  }
  const resolve = (here: string) => (name: string | undefined): string | null => (name === undefined ? here : byName.get(name.toLowerCase()) ?? null);

  // Edges: a formula cell → the formula cells it reads.
  const edges = new Map<string, string[]>();
  for (const fc of formulas.values()) {
    const out: string[] = [];
    if (fc.node) {
      const res = resolve(fc.sheet);
      for (const ref of references(fc.node)) {
        const sid = res(ref.sheet);
        if (sid === null) continue;
        if (ref.k === 'ref') {
          if (formulas.has(key(sid, ref.r, ref.c))) out.push(key(sid, ref.r, ref.c));
        } else {
          for (const g of formulasBySheet.get(sid) ?? []) {
            if (g.r >= ref.r1 && g.r <= ref.r2 && g.c >= ref.c1 && g.c <= ref.c2) out.push(g.key);
          }
        }
      }
    }
    edges.set(fc.key, out);
  }

  // Iterative Tarjan: SCCs come out dependencies-first.
  const order: string[][] = [];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  for (const start of formulas.keys()) {
    if (index.has(start)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: start, i: 0 }];
    index.set(start, counter); low.set(start, counter); counter++;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1]!;
      const next = edges.get(top.v)!;
      if (top.i < next.length) {
        const w = next[top.i++]!;
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter++;
          stack.push(w); onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1]!.v;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
      }
      if (low.get(top.v) === index.get(top.v)) {
        const scc: string[] = [];
        let w: string;
        do { w = stack.pop()!; onStack.delete(w); scc.push(w); } while (w !== top.v);
        order.push(scc);
      }
    }
  }

  const label = (k: string): string => {
    const fc = formulas.get(k)!;
    const multi = book.sheets.length > 1;
    return `${multi ? `${sheetOf.get(fc.sheet)!.name}!` : ''}${fc.ref}`;
  };
  const valueAt = (sheet: string, r: number, c: number): Value => {
    const k = key(sheet, r, c);
    if (values.has(k)) return values.get(k)!;
    if (formulas.has(k)) return sheetError('#REF!', 'circular reference');
    const cell = sheetOf.get(sheet)?.cells[a1(r, c)];
    return cell?.v ?? null;
  };
  const errors: Computed['errors'] = [];
  for (const scc of order) {
    const cyclic = scc.length > 1 || (edges.get(scc[0]!) ?? []).includes(scc[0]!);
    for (const k of scc) {
      const fc = formulas.get(k)!;
      let v: Value;
      if (fc.parseError) v = sheetError('#ERROR!', fc.parseError);
      else if (cyclic) v = sheetError('#REF!', `circular reference: ${[...scc].reverse().map(label).join(' → ')} → ${label(scc[scc.length - 1]!)}`);
      else {
        const ctx: EvalContext = {
          sheet: fc.sheet, resolveSheet: resolve(fc.sheet), value: valueAt,
          extent: sid => extents.get(sid) ?? { rows: 0, cols: 0 }, today,
        };
        try { v = evaluate(fc.node!, ctx); } catch (err) { v = sheetError('#VALUE!', (err as Error).message); }
      }
      if (typeof v === 'number' && Object.is(v, -0)) v = 0;
      values.set(k, v);
      if (isError(v)) errors.push({ sheet: fc.sheet, ref: fc.ref, error: v });
    }
  }
  return {
    at: valueAt,
    get(sheetId, ref) { const p = parseA1(ref); return p ? valueAt(sheetId, p.r, p.c) : null; },
    errors,
  };
}

// ── Operations ───────────────────────────────────────────────────────

/** One change to a workbook — what the grid records and replays, and what the tool applies. */
export type SheetOp =
  | { op: 'set'; sheet: string; cells: Record<string, unknown> }
  | { op: 'style'; sheet: string; range: string; style: Partial<Record<keyof CellStyle, unknown>> }
  | { op: 'insert' | 'delete'; sheet: string; axis: 'row' | 'col'; at: number; count: number }
  | { op: 'sort'; sheet: string; range: string; col: number; desc?: boolean; header?: boolean }
  | { op: 'fill'; sheet: string; range: string }
  | { op: 'width'; sheet: string; col: string; px: number | null }
  | { op: 'freeze'; sheet: string; rows?: number; cols?: number }
  | { op: 'filter'; sheet: string; on: boolean }
  | { op: 'cond'; sheet: string; rules: CondRule[] }
  | { op: 'chart'; sheet: string; chart: SheetChart | null; id?: string }
  | { op: 'add_sheet'; name: string; id?: string }
  | { op: 'rename_sheet'; sheet: string; name: string }
  | { op: 'delete_sheet'; sheet: string }
  | { op: 'replace'; book: SheetBook };

function cloneBook(book: SheetBook): SheetBook {
  return { aicoSheet: SHEET_FORMAT, sheets: book.sheets.map(s => ({ ...s, cells: { ...s.cells } })) };
}

function need(book: SheetBook, name: string): Sheet {
  const s = sheetByName(book, name);
  if (!s) throw new Error(`no sheet "${name}". Sheets: ${book.sheets.map(x => `"${x.name}"`).join(', ')}`);
  return s;
}

function needRange(text: string): RangeAddr {
  const r = parseRangeA1(text);
  if (!r) throw new Error(`"${text}" is not a cell or range like B2 or A1:D10`);
  return r;
}

function mergeStyle(prev: CellStyle | undefined, patch: Partial<Record<keyof CellStyle, unknown>>): CellStyle | undefined {
  const next: Record<string, unknown> = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === false || v === 'general') delete next[k];
    else next[k] = v;
  }
  return cleanStyle(next);
}

/** Apply one operation, returning a new workbook. Throws with a readable reason. */
export function applyOp(book: SheetBook, op: SheetOp): SheetBook {
  if (op.op === 'replace') return parseBook(serializeBook(op.book));
  const next = cloneBook(book);
  switch (op.op) {
    case 'set': {
      const s = need(next, op.sheet);
      for (const [ref, input] of Object.entries(op.cells)) {
        const p = parseA1(ref);
        if (!p) throw new Error(`"${ref}" is not a cell reference like B2`);
        const k = a1(p.r, p.c);
        const prev = s.cells[k];
        const parsed = parseInput(input);
        if (parsed.cell?.f !== undefined) {
          try { parseFormula(parsed.cell.f); } catch (err) { throw new Error(`${k}: the formula =${parsed.cell.f} does not parse — ${(err as Error).message}`); }
        }
        const style = prev?.s?.num ? prev.s : parsed.style ? { ...(prev?.s ?? {}), ...parsed.style } : prev?.s;
        const cell: Cell = { ...(parsed.cell ?? {}), ...(style ? { s: style } : {}) };
        if (cell.v === undefined && cell.f === undefined && !cell.s) delete s.cells[k];
        else s.cells[k] = cell;
      }
      return next;
    }
    case 'style': {
      const s = need(next, op.sheet);
      const r = needRange(op.range);
      if ((r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1) > 100_000) throw new Error('style at most 100,000 cells at once');
      for (let row = r.r1; row <= r.r2; row++) {
        for (let col = r.c1; col <= r.c2; col++) {
          const k = a1(row, col);
          const cell = s.cells[k] ?? {};
          const style = mergeStyle(cell.s, op.style);
          const out: Cell = { ...cell };
          if (style) out.s = style; else delete out.s;
          if (out.v === undefined && out.f === undefined && !out.s) delete s.cells[k];
          else s.cells[k] = out;
        }
      }
      return next;
    }
    case 'insert': case 'delete': {
      const s = need(next, op.sheet);
      const count = Math.max(1, Math.min(op.count, op.axis === 'row' ? 10_000 : 500));
      const delta = op.op === 'insert' ? count : -count;
      const cells: Record<string, Cell> = {};
      for (const [ref, cell] of Object.entries(s.cells)) {
        const p = parseA1(ref)!;
        const v = op.axis === 'row' ? p.r : p.c;
        if (delta < 0 && v >= op.at && v < op.at - delta) continue;
        const nv = v >= op.at ? v + delta : v;
        if (nv >= (op.axis === 'row' ? MAX_ROWS : MAX_COLS)) continue;
        cells[op.axis === 'row' ? a1(nv, p.c) : a1(p.r, nv)] = cell;
      }
      s.cells = cells;
      for (const sh of next.sheets) {
        for (const [ref, cell] of Object.entries(sh.cells)) {
          if (cell.f === undefined) continue;
          const f = adjustFormula(cell.f, s.name, sh.name, op.axis, op.at, delta);
          if (f !== cell.f) sh.cells[ref] = { ...cell, f };
        }
      }
      const moveRange = (text: string): string | undefined => {
        const out = adjustFormula(text, s.name, s.name, op.axis, op.at, delta);
        return out.includes('#REF!') ? undefined : out;
      };
      if (s.cond) s.cond = s.cond.map(r => ({ ...r, range: moveRange(r.range) ?? '' })).filter(r => r.range);
      if (s.charts) s.charts = s.charts.map(c => ({ ...c, range: moveRange(c.range) ?? '' })).filter(c => c.range);
      if (op.axis === 'col' && s.cols) {
        const cols: Record<string, number> = {};
        for (const [letter, w] of Object.entries(s.cols)) {
          const c = colIndex(letter);
          if (delta < 0 && c >= op.at && c < op.at - delta) continue;
          cols[colName(c >= op.at ? c + delta : c)] = w;
        }
        s.cols = cols;
      }
      return next;
    }
    case 'sort': {
      const s = need(next, op.sheet);
      const r = needRange(op.range);
      const top = op.header ? r.r1 + 1 : r.r1;
      if (top > r.r2) return next;
      const comp = computeBook(next);
      const rows: Array<{ from: number; key: Value; cells: Array<Cell | undefined> }> = [];
      for (let row = top; row <= r.r2; row++) {
        const cells: Array<Cell | undefined> = [];
        for (let c = r.c1; c <= r.c2; c++) cells.push(s.cells[a1(row, c)]);
        rows.push({ from: row, key: comp.at(s.id, row, op.col), cells });
      }
      // Blanks and errors always last, as Excel does; the sort is stable.
      const rank = (v: Value): number => (v === null || v === '' ? 2 : isError(v) ? 1 : 0);
      rows.sort((x, y) => {
        const rx = rank(x.key); const ry = rank(y.key);
        if (rx || ry) return rx - ry;
        const c = compareValues(x.key as Scalar, y.key as Scalar);
        return op.desc ? -c : c;
      });
      rows.forEach((row, i) => {
        const to = top + i;
        row.cells.forEach((cell, j) => {
          const k = a1(to, r.c1 + j);
          if (!cell) { delete s.cells[k]; return; }
          s.cells[k] = cell.f !== undefined ? { ...cell, f: shiftFormula(cell.f, to - row.from, 0) } : cell;
        });
      });
      return next;
    }
    case 'fill': {
      const s = need(next, op.sheet);
      const r = needRange(op.range);
      for (let c = r.c1; c <= r.c2; c++) {
        const src = s.cells[a1(r.r1, c)];
        for (let row = r.r1 + 1; row <= r.r2; row++) {
          const k = a1(row, c);
          if (!src) { delete s.cells[k]; continue; }
          s.cells[k] = src.f !== undefined ? { ...src, f: shiftFormula(src.f, row - r.r1, 0) } : { ...src };
        }
      }
      return next;
    }
    case 'width': {
      const s = need(next, op.sheet);
      const letter = colIndex(op.col) >= 0 ? op.col.toUpperCase() : undefined;
      if (!letter) throw new Error(`"${op.col}" is not a column letter`);
      const cols = { ...(s.cols ?? {}) };
      if (op.px === null) delete cols[letter]; else cols[letter] = Math.max(30, Math.min(800, Math.round(op.px)));
      s.cols = cols;
      return next;
    }
    case 'freeze': {
      const s = need(next, op.sheet);
      const rows = Math.max(0, Math.min(50, Math.trunc(op.rows ?? s.freeze?.rows ?? 0)));
      const cols = Math.max(0, Math.min(20, Math.trunc(op.cols ?? s.freeze?.cols ?? 0)));
      if (rows || cols) s.freeze = { ...(rows ? { rows } : {}), ...(cols ? { cols } : {}) }; else delete s.freeze;
      return next;
    }
    case 'filter': {
      const s = need(next, op.sheet);
      if (op.on) s.filter = true; else delete s.filter;
      return next;
    }
    case 'cond': {
      const s = need(next, op.sheet);
      const rules = op.rules.map(cleanCond);
      const bad = rules.findIndex(r => !r);
      if (bad >= 0) throw new Error(`conditional rule ${bad + 1} needs {range:"D2:D20", op:"gt|lt|gte|lte|eq|ne|between|contains|error", value, value2?, fill:"#RRGGBB"}`);
      if (rules.length) s.cond = rules as CondRule[]; else delete s.cond;
      return next;
    }
    case 'chart': {
      const s = need(next, op.sheet);
      const charts = (s.charts ?? []).filter(c => c.id !== (op.chart?.id ?? op.id));
      if (op.chart) {
        const c = cleanChart(op.chart);
        if (!c) throw new Error('a chart needs {range:"A1:C10", type:"bar|line|area|pie", title?}');
        charts.push(c);
      }
      if (charts.length) s.charts = charts.slice(-10); else delete s.charts;
      return next;
    }
    case 'add_sheet': {
      if (next.sheets.length >= MAX_SHEETS) throw new Error(`a workbook holds at most ${MAX_SHEETS} sheets`);
      let name = cleanSheetName(op.name) || `Sheet${next.sheets.length + 1}`;
      if (next.sheets.some(s => s.name.toLowerCase() === name.toLowerCase())) throw new Error(`there is already a sheet named "${name}"`);
      let n = next.sheets.length + 1;
      let id = op.id && /^[\w-]{1,20}$/.test(op.id) ? op.id : `s${n}`;
      while (next.sheets.some(s => s.id === id)) id = `s${++n}`;
      name = name || `Sheet${n}`;
      next.sheets.push({ id, name, cells: {} });
      return next;
    }
    case 'rename_sheet': {
      const s = need(next, op.sheet);
      const name = cleanSheetName(op.name);
      if (!name) throw new Error('a sheet needs a name');
      if (next.sheets.some(x => x !== s && x.name.toLowerCase() === name.toLowerCase())) throw new Error(`there is already a sheet named "${name}"`);
      const old = s.name;
      s.name = name;
      for (const sh of next.sheets) {
        for (const [ref, cell] of Object.entries(sh.cells)) {
          if (cell.f === undefined) continue;
          const f = renameSheetInFormula(cell.f, old, name);
          if (f !== cell.f) sh.cells[ref] = { ...cell, f };
        }
      }
      return next;
    }
    case 'delete_sheet': {
      const s = need(next, op.sheet);
      if (next.sheets.length <= 1) throw new Error('a workbook needs at least one sheet');
      next.sheets = next.sheets.filter(x => x !== s);
      return next;
    }
  }
}

/** Apply operations in order; one that no longer applies (its sheet was deleted) is skipped. */
export function replay(book: SheetBook, ops: SheetOp[]): { book: SheetBook; skipped: number } {
  let cur = book;
  let skipped = 0;
  for (const op of ops) {
    try { cur = applyOp(cur, op); } catch { skipped++; }
  }
  return { book: cur, skipped };
}

/** The cells two op lists both write (for "you and AICO changed the same cell"). */
export function touchedCells(ops: SheetOp[]): Set<string> {
  const out = new Set<string>();
  for (const op of ops) if (op.op === 'set') for (const ref of Object.keys(op.cells)) out.add(`${op.sheet}!${ref.toUpperCase()}`);
  return out;
}

// ── Paste and CSV ────────────────────────────────────────────────────

/** Rows of text from a clipboard or a file: tab-separated (Excel, Sheets) or CSV, quotes honoured. */
export function parseDelimited(text: string, sep?: string): string[][] {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (t === '') return [];
  const first = t.split('\n', 1)[0]!;
  const d = sep ?? (first.includes('\t') ? '\t' : first.split(';').length > first.split(',').length ? ';' : ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quoted) {
      if (ch === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === d) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** `set` cells for a block of text rows starting at `at`. */
export function gridCells(rows: unknown[][], at: { r: number; c: number }): Record<string, unknown> {
  const cells: Record<string, unknown> = {};
  rows.forEach((row, i) => row.forEach((v, j) => {
    if (at.r + i < MAX_ROWS && at.c + j < MAX_COLS) cells[a1(at.r + i, at.c + j)] = v === '' ? null : v;
  }));
  return cells;
}

function csvField(s: string): string {
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One sheet as CSV: computed values, formatted (dates ISO, percentages with %), RFC 4180 quoting. */
export function sheetCsv(book: SheetBook, sheet: Sheet, computed = computeBook(book)): string {
  const ext = usedExtent(sheet);
  const lines: string[] = [];
  for (let r = 0; r < ext.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < ext.cols; c++) {
      const cell = sheet.cells[a1(r, c)];
      const v = computed.at(sheet.id, r, c);
      const s = cell?.s;
      // Numbers stay machine-readable: no thousands separators or currency symbols in a CSV.
      const text = typeof v === 'number'
        ? s?.num === 'date' ? formatValue(v, s) : s?.num === 'percent' ? formatValue(v, s) : numberText(v)
        : formatValue(v, s);
      row.push(csvField(text));
    }
    lines.push(row.join(','));
  }
  return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}

/** A workbook from rows of text (CSV import): each cell parsed as if typed. */
export function bookFromRows(rows: string[][], name = 'Sheet1'): SheetBook {
  const book = emptyBook(name);
  const s = book.sheets[0]!;
  rows.forEach((row, r) => row.forEach((text, c) => {
    if (text === '' || r >= MAX_ROWS || c >= MAX_COLS) return;
    // Imported text is data: a leading "=" in a CSV is not run as a formula.
    const parsed = parseInput(text.startsWith('=') ? `'${text}` : text);
    if (parsed.cell) s.cells[a1(r, c)] = { ...parsed.cell, ...(parsed.style ? { s: parsed.style } : {}) };
  }));
  if (rows.length > 1 && rows[0]!.every(t => t !== '' && Number.isNaN(Number(t)))) {
    s.freeze = { rows: 1 };
    for (let c = 0; c < rows[0]!.length; c++) {
      const k = a1(0, c);
      if (s.cells[k]) s.cells[k] = { ...s.cells[k], s: { ...(s.cells[k]!.s ?? {}), b: true } };
    }
  }
  return book;
}

// ── Reading a range compactly (the agent's view) ─────────────────────

/**
 * A range as a compact pipe table: one line per row, `B4=12` for values and
 * `D4: =B4*C4 → 480` for formulas, blank cells omitted. What the agent reads
 * instead of the JSON — a 50-row BOQ is a few hundred tokens.
 */
export function describeRange(book: SheetBook, sheet: Sheet, range: RangeAddr | undefined, computed = computeBook(book), maxCells = 600): string {
  const ext = usedExtent(sheet);
  const r = range ?? { r1: 0, c1: 0, r2: Math.max(0, ext.rows - 1), c2: Math.max(0, ext.cols - 1) };
  const lines: string[] = [];
  let shown = 0;
  let truncated = false;
  for (let row = r.r1; row <= Math.min(r.r2, ext.rows - 1); row++) {
    const parts: string[] = [];
    for (let c = r.c1; c <= Math.min(r.c2, ext.cols - 1); c++) {
      const k = a1(row, c);
      const cell = sheet.cells[k];
      if (!cell || (cell.v === undefined && cell.f === undefined)) continue;
      if (shown >= maxCells) { truncated = true; break; }
      const v = computed.at(sheet.id, row, c);
      const shownValue = typeof v === 'string' ? JSON.stringify(v) : formatValue(v, cell.s);
      const err = isError(v) && v.detail ? ` (${v.detail})` : '';
      parts.push(cell.f !== undefined ? `${k}: =${cell.f} → ${shownValue}${err}` : `${k}=${shownValue}`);
      shown++;
    }
    if (parts.length) lines.push(parts.join(' | '));
    if (truncated) break;
  }
  if (truncated) lines.push(`… more cells — read a smaller range (e.g. ${rangeA1({ ...r, r1: Math.min(r.r2, r.r1 + 50) })})`);
  return lines.join('\n');
}

/** The first rows of the first sheet as text, for the card in the chat ("Item · Qty · Rate"). Never throws. */
export function sheetPreview(text: string, max = 3): string[] {
  let book: SheetBook;
  try { book = parseBook(text); } catch { return []; }
  const sheet = book.sheets[0]!;
  const ext = usedExtent(sheet);
  const computed = computeBook(book);
  const out: string[] = [];
  for (let r = 0; r < ext.rows && out.length < max; r++) {
    const parts: string[] = [];
    for (let c = 0; c < Math.min(ext.cols, 8); c++) {
      const t = formatValue(computed.at(sheet.id, r, c), sheet.cells[a1(r, c)]?.s);
      if (t) parts.push(t);
    }
    if (parts.length) out.push(parts.join(' · ').slice(0, 160));
  }
  const more = `${ext.rows} row${ext.rows === 1 ? '' : 's'}${book.sheets.length > 1 ? ` · ${book.sheets.length} sheets` : ''}`;
  return out.length ? [...out, more] : [more];
}

/** A one-line summary of the sheet's layout for the agent: size, frozen rows, formats by column. */
export function describeSheet(sheet: Sheet): string {
  const ext = usedExtent(sheet);
  const fmts = new Map<string, string>();
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    if (!cell.s?.num) continue;
    const col = ref.replace(/\d+$/, '');
    if (!fmts.has(col)) fmts.set(col, `${col} ${cell.s.num}${cell.s.cur ? ` ${cell.s.cur}` : ''}`);
  }
  return `"${sheet.name}" ${ext.rows} rows × ${ext.cols} columns${ext.cols ? ` (A–${colName(ext.cols - 1)})` : ''}`
    + `${sheet.freeze?.rows ? `, header row frozen` : ''}${fmts.size ? `, formats: ${[...fmts.values()].join(', ')}` : ''}`
    + `${sheet.cond?.length ? `, ${sheet.cond.length} conditional fill${sheet.cond.length === 1 ? '' : 's'}` : ''}`
    + `${sheet.charts?.length ? `, ${sheet.charts.length} chart${sheet.charts.length === 1 ? '' : 's'}` : ''}`;
}

// ── Conditional fills and charts ─────────────────────────────────────

/** The fill a cell gets from the sheet's rules (the first rule that matches wins), or undefined. */
export function condFill(sheet: Sheet, r: number, c: number, v: Value): string | undefined {
  for (const rule of sheet.cond ?? []) {
    const range = parseRangeA1(rule.range);
    if (!range || r < range.r1 || r > range.r2 || c < range.c1 || c > range.c2) continue;
    if (condMatches(rule, v)) return rule.fill;
  }
  return undefined;
}

export function condMatches(rule: CondRule, v: Value): boolean {
  if (rule.op === 'error') return isError(v);
  if (isError(v) || v === null) return false;
  if (rule.op === 'contains') return String(v).toLowerCase().includes(String(rule.value ?? '').toLowerCase());
  const a = rule.value ?? null;
  const cmp = (x: Scalar): number => compareValues(v, x);
  if (typeof a === 'number' && typeof v !== 'number') return rule.op === 'ne';
  switch (rule.op) {
    case 'gt': return cmp(a) > 0;
    case 'lt': return cmp(a) < 0;
    case 'gte': return cmp(a) >= 0;
    case 'lte': return cmp(a) <= 0;
    case 'eq': return cmp(a) === 0;
    case 'ne': return cmp(a) !== 0;
    case 'between': {
      const lo = Math.min(Number(a), Number(rule.value2)); const hi = Math.max(Number(a), Number(rule.value2));
      return typeof v === 'number' && v >= lo && v <= hi;
    }
    default: return false;
  }
}

/**
 * The data of a chart drawn from a range: the first column is the category,
 * each further column a series named by its header row (when the first row is
 * text). Feeds the chat's chart block (`visual.ts` `chartOption`).
 */
export function chartData(sheet: Sheet, range: string, computed: Computed): { categories: string[]; series: Array<{ name: string; data: number[] }> } {
  const r = parseRangeA1(range);
  if (!r) return { categories: [], series: [] };
  const at = (row: number, col: number): Value => computed.at(sheet.id, row, col);
  const header = r.r2 > r.r1 && Array.from({ length: r.c2 - r.c1 + 1 }, (_, j) => at(r.r1, r.c1 + j)).slice(1).every(v => typeof v === 'string');
  const top = header ? r.r1 + 1 : r.r1;
  const oneCol = r.c1 === r.c2;
  const categories: string[] = [];
  for (let row = top; row <= r.r2; row++) categories.push(oneCol ? String(row + 1) : formatValue(at(row, r.c1), sheet.cells[a1(row, r.c1)]?.s));
  const series: Array<{ name: string; data: number[] }> = [];
  for (let col = oneCol ? r.c1 : r.c1 + 1; col <= r.c2; col++) {
    const name = header ? String(at(r.r1, col) ?? colName(col)) : `Column ${colName(col)}`;
    const data: number[] = [];
    for (let row = top; row <= r.r2; row++) { const v = at(row, col); data.push(typeof v === 'number' ? v : 0); }
    series.push({ name, data });
  }
  return { categories, series };
}
