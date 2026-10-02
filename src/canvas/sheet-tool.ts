/**
 * The `Canvas` tool's sheet actions — how the agent builds and changes an
 * AICO Sheets workbook without ever sending the workbook.
 *
 * ## Small writes, read back as values
 *
 * The agent names cells (`cells: {"D2": "=B2*C2"}`) or a block (`range: "A1",
 * values: [[…], …]`), never the JSON. Each write is version-checked against
 * the canvas tab exactly like a document edit (a person editing the grid
 * meanwhile makes it a refusal carrying a compact view, not an overwrite),
 * and each result reports what the changed cells now compute to plus any
 * formula in the workbook that is now an error, with Excel's reason. So the
 * model sees `D5: =SUM(D2:D4) → 1,240.00` without a second read, and a
 * `#REF! (circular reference: D5 → D6 → D5)` the moment it makes one.
 *
 * `read` returns a compact table (`B4=12 | D4: =B4*C4 → 480`) of a range or
 * the used area, capped, rather than the stored JSON — a fraction of the
 * tokens and in the same notation the model writes.
 *
 * @module canvas/sheet-tool
 */

import path from 'path';
import { readFile } from 'fs/promises';
import {
  a1, applyOp, colIndex, computeBook, describeRange, describeSheet, gridCells, parseA1, parseBook, parseRangeA1, serializeBook,
  sheetByName, formatValue, isError, emptyBook,
  type SheetBook, type SheetOp,
} from '../../shared/ui/canvas/sheet-model.js';
import { FUNCTIONS } from '../../shared/ui/canvas/sheet-formula.js';
import { createCanvas, writeCanvas, type CanvasContext, type CanvasDoc } from './store.js';
import { importSheetFile } from './sheet-xlsx.js';

export interface SheetInput {
  id?: string;
  title?: string;
  version?: number;
  sheet?: string;
  range?: string;
  cells?: Record<string, unknown>;
  values?: unknown[][];
  style?: Record<string, unknown>;
  layout?: {
    widths?: Record<string, number>;
    freeze?: { rows?: number; cols?: number };
    filter?: boolean;
    conditional?: unknown[];
    chart?: { range?: string; type?: string; title?: string } | null;
  };
  operation?: { type?: string; at?: string | number; count?: number; column?: string; desc?: boolean; header?: boolean };
  tabs?: { title?: string }[];
  path?: string;
  note?: string;
}

export const SHEET_ACTIONS = ['set_cells', 'format_cells', 'add_sheet', 'grid_op', 'import'] as const;

export function bookOf(doc: CanvasDoc): SheetBook {
  return parseBook(doc.tabs[0]!.content);
}

function ref(doc: CanvasDoc): string {
  return `\`\`\`canvas\n${JSON.stringify({ id: doc.id, title: doc.title, kind: 'sheet' })}\n\`\`\``;
}

function card(doc: CanvasDoc): string {
  return 'Put this block in your reply so the user can open the sheet (a reference card — do not paste the cells into the chat):\n' + ref(doc);
}

/** The cells a write was about, as `D2: =B2*C2 → 55` lines, and any error in the workbook. */
function outcome(book: SheetBook, sheetName: string, touched: string[]): string {
  const sheet = sheetByName(book, sheetName)!;
  const computed = computeBook(book);
  const lines: string[] = [];
  for (const k of touched.slice(0, 40)) {
    const cell = sheet.cells[k];
    if (!cell || (cell.v === undefined && cell.f === undefined)) continue;
    const v = computed.get(sheet.id, k);
    const shown = typeof v === 'string' ? JSON.stringify(v) : formatValue(v, cell.s);
    lines.push(cell.f !== undefined ? `${k}: =${cell.f} → ${shown}${isError(v) && v.detail ? ` (${v.detail})` : ''}` : `${k}=${shown}`);
  }
  const more = touched.length > 40 ? ` (+${touched.length - 40} more)` : '';
  const errors = computed.errors.slice(0, 10).map((e) => {
    const s = book.sheets.find(x => x.id === e.sheet)!;
    return `${book.sheets.length > 1 ? `${s.name}!` : ''}${e.ref} ${e.error.error}${e.error.detail ? ` — ${e.error.detail}` : ''}`;
  });
  return `${lines.length ? `\nNow: ${lines.join(' | ')}${more}` : ''}`
    + `${errors.length ? `\nFormula errors in the workbook (fix them): ${errors.join('; ')}${computed.errors.length > 10 ? ` (+${computed.errors.length - 10} more)` : ''}` : ''}`;
}

function staleSheet(doc: CanvasDoc, base: number | undefined): Error {
  const tab = doc.tabs[0]!;
  const book = bookOf(doc);
  const last = [...doc.versions].reverse()[0];
  return new Error(`NOT APPLIED — sheet ${doc.id} is at version ${tab.version}, not ${base ?? '(no version given)'}. `
    + `${last?.author === 'user' ? 'The user edited it' : 'It changed'} since your last read. Here it is now; re-apply your change with version: ${tab.version}.\n`
    + book.sheets.map(s => `${describeSheet(s)}\n${describeRange(book, s, undefined, computeBook(book), 300)}`).join('\n\n'));
}

/** A block of values (`range` = its top-left) or a `cells` map, as one `set`. */
function cellsFrom(input: SheetInput): { cells: Record<string, unknown>; touched: string[] } {
  const out: Record<string, unknown> = {};
  if (input.cells && typeof input.cells === 'object') {
    for (const [k, v] of Object.entries(input.cells)) {
      const p = parseA1(k);
      if (!p) throw new Error(`"${k}" is not a cell reference like B2 — cells is {"A1": value or "=formula", …}`);
      out[a1(p.r, p.c)] = v;
    }
  }
  if (Array.isArray(input.values)) {
    if (!input.values.every(Array.isArray)) throw new Error('values is an array of rows, each an array of cells: [["Item","Qty"],["Cement",10]]');
    const at = parseA1((input.range ?? 'A1').split(':')[0]!);
    if (!at) throw new Error(`range "${input.range}" must start with a cell like A1`);
    Object.assign(out, gridCells(input.values as unknown[][], at));
  }
  const touched = Object.keys(out).sort((x, y) => { const p = parseA1(x)!; const q = parseA1(y)!; return p.r - q.r || p.c - q.c; });
  if (!touched.length) throw new Error('set_cells needs cells {"A1": value, "D2": "=B2*C2"} or range + values [[…]]');
  if (touched.length > 5000) throw new Error('set at most 5,000 cells per call');
  return { cells: out, touched };
}

/** The operations a format_cells call stands for. */
function formatOps(input: SheetInput, sheet: string): SheetOp[] {
  const ops: SheetOp[] = [];
  if (input.style && typeof input.style === 'object') {
    if (!input.range) throw new Error('format_cells with style needs range, e.g. "D2:D20"');
    const style: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.style)) {
      const key = k === 'bold' ? 'b' : k === 'format' || k === 'type' ? 'num' : k === 'decimals' ? 'dp' : k === 'currency' ? 'cur' : k;
      style[key] = typeof v === 'string' && key === 'cur' ? v.toUpperCase() : v;
    }
    ops.push({ op: 'style', sheet, range: input.range, style });
  }
  const l = input.layout;
  if (l && typeof l === 'object') {
    for (const [col, px] of Object.entries(l.widths ?? {})) {
      if (colIndex(col) < 0) throw new Error(`layout.widths key "${col}" must be a column letter`);
      ops.push({ op: 'width', sheet, col, px: typeof px === 'number' ? px : null });
    }
    if (l.freeze) ops.push({ op: 'freeze', sheet, ...(l.freeze.rows !== undefined ? { rows: l.freeze.rows } : {}), ...(l.freeze.cols !== undefined ? { cols: l.freeze.cols } : {}) });
    if (typeof l.filter === 'boolean') ops.push({ op: 'filter', sheet, on: l.filter });
    if (Array.isArray(l.conditional)) ops.push({ op: 'cond', sheet, rules: l.conditional as never });
    if (l.chart !== undefined) {
      ops.push(l.chart === null
        ? { op: 'chart', sheet, chart: null, id: 'c1' }
        : { op: 'chart', sheet, chart: { id: 'c1', range: String(l.chart.range ?? ''), type: (l.chart.type ?? 'bar') as 'bar', ...(l.chart.title ? { title: l.chart.title } : {}) } });
    }
  }
  if (!ops.length) throw new Error('format_cells needs style {num, dp, cur, bold, fill, align} with range, and/or layout {widths, freeze, filter, conditional, chart}');
  return ops;
}

function rowOrCol(at: string | number | undefined, axis: 'row' | 'col'): number {
  if (typeof at === 'number') return axis === 'row' ? at - 1 : at - 1;
  const t = String(at ?? '').trim();
  if (axis === 'row') {
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1) throw new Error('operation.at is the row number (1-based) to insert before or delete from');
    return n - 1;
  }
  const c = colIndex(t);
  if (c < 0) throw new Error('operation.at is the column letter to insert before or delete from');
  return c;
}

function gridOps(input: SheetInput, sheet: string): SheetOp {
  const o = input.operation ?? {};
  switch (o.type) {
    case 'insert_rows': case 'delete_rows': case 'insert_cols': case 'delete_cols': {
      const axis = o.type.endsWith('rows') ? 'row' : 'col';
      return { op: o.type.startsWith('insert') ? 'insert' : 'delete', sheet, axis, at: rowOrCol(o.at, axis), count: Math.max(1, Math.trunc(o.count ?? 1)) };
    }
    case 'sort': {
      if (!input.range) throw new Error('sort needs range (the rows to sort, header included when header: true)');
      const r = parseRangeA1(input.range);
      const col = colIndex(o.column ?? '');
      if (!r || col < 0) throw new Error('sort needs range and operation.column (the column letter to sort by)');
      return { op: 'sort', sheet, range: input.range, col, ...(o.desc ? { desc: true } : {}), ...(o.header ? { header: true } : {}) };
    }
    case 'fill_down':
      if (!input.range) throw new Error('fill_down needs range: its first row is copied down the rest, formulas adjusted');
      return { op: 'fill', sheet, range: input.range };
    default:
      throw new Error('operation.type is insert_rows, delete_rows, insert_cols, delete_cols, sort or fill_down');
  }
}

/** Read a sheet canvas for the agent. */
export function readSheet(doc: CanvasDoc, input: SheetInput): string {
  const book = bookOf(doc);
  const tab = doc.tabs[0]!;
  const computed = computeBook(book);
  const last = [...doc.versions].reverse()[0];
  const head = `Sheet canvas ${doc.id} "${doc.title}" — version ${tab.version}, last edited by ${last?.author === 'user' ? 'the user' : 'you (the agent)'}. `
    + `Pass version: ${tab.version} with set_cells/format_cells/add_sheet/grid_op.`;
  const wanted = input.sheet ? [sheetByName(book, input.sheet)] : book.sheets;
  if (wanted.some(s => !s)) throw new Error(`no sheet "${input.sheet}". Sheets: ${book.sheets.map(s => `"${s.name}"`).join(', ')}`);
  const range = input.range ? parseRangeA1(input.range) : undefined;
  if (input.range && !range) throw new Error(`"${input.range}" is not a range like A1:D20`);
  const parts = wanted.map(s => `${describeSheet(s!)}\n${describeRange(book, s!, range ?? undefined, computed) || '(empty)'}`);
  return `${head}\n${book.sheets.length > 1 ? `Sheets: ${book.sheets.map(s => `"${s.name}"`).join(', ')}.\n` : ''}${parts.join('\n\n')}`;
}

async function write(ctx: CanvasContext, doc: CanvasDoc, input: SheetInput, ops: SheetOp[], note: string): Promise<{ doc: CanvasDoc; book: SheetBook }> {
  const tab = doc.tabs[0]!;
  if (typeof input.version !== 'number' || input.version !== tab.version) throw staleSheet(doc, input.version);
  let book = bookOf(doc);
  for (const op of ops) book = applyOp(book, op);
  const written = await writeCanvas(ctx, doc.id, { content: serializeBook(book), baseVersion: tab.version, author: 'agent', tab: tab.id, note: input.note ?? note });
  if (!written.ok) throw staleSheet(written.canvas, input.version);
  return { doc: written.canvas, book };
}

/** create with kind "sheet". */
export async function createSheet(ctx: CanvasContext, input: SheetInput): Promise<string> {
  if (!input.title?.trim()) throw new Error('`title` is required to create a sheet.');
  let book = emptyBook(input.tabs?.[0]?.title ?? 'Sheet1');
  for (const t of (input.tabs ?? []).slice(1)) book = applyOp(book, { op: 'add_sheet', name: t.title ?? '' });
  const sheet = sheetByName(book, input.sheet)?.name ?? book.sheets[0]!.name;
  let touched: string[] = [];
  if (input.cells || input.values) {
    const set = cellsFrom(input);
    touched = set.touched;
    book = applyOp(book, { op: 'set', sheet, cells: set.cells });
  }
  if (input.style || input.layout) for (const op of formatOps(input, sheet)) book = applyOp(book, op);
  const doc = await createCanvas(ctx, { title: input.title, kind: 'sheet', content: serializeBook(book), author: 'agent', note: 'Created' });
  return `Created sheet canvas ${doc.id} "${doc.title}", version 1 (sheets: ${book.sheets.map(s => `"${s.name}"`).join(', ')}).${outcome(book, sheet, touched)}\n`
    + 'Fill it with set_cells (values, and formulas as "=…" strings in Excel syntax), then format_cells for number formats, widths and a frozen header.\n'
    + card(doc);
}

/** set_cells, format_cells, add_sheet, grid_op on an existing sheet canvas. */
export async function sheetAction(ctx: CanvasContext, doc: CanvasDoc, action: string, input: SheetInput): Promise<string> {
  const book = bookOf(doc);
  const sheet = sheetByName(book, input.sheet);
  if (!sheet && action !== 'add_sheet' && action !== 'add_tab') {
    throw new Error(`no sheet "${input.sheet}". Sheets: ${book.sheets.map(s => `"${s.name}"`).join(', ')}`);
  }
  const name = sheet?.name ?? book.sheets[0]!.name;
  const done = (d: CanvasDoc): string => `Sheet ${d.id} "${d.title}" is now version ${d.tabs[0]!.version} (pass version: ${d.tabs[0]!.version} next).`;
  switch (action) {
    case 'set_cells': {
      const { cells, touched } = cellsFrom(input);
      const r = await write(ctx, doc, input, [{ op: 'set', sheet: name, cells }], `Set ${touched.length} cell${touched.length === 1 ? '' : 's'}`);
      return `${done(r.doc)}${outcome(r.book, name, touched)}`;
    }
    case 'format_cells': {
      const r = await write(ctx, doc, input, formatOps(input, name), 'Formatted');
      return `${done(r.doc)} ${describeSheet(sheetByName(r.book, name)!)}.${outcome(r.book, name, [])}`;
    }
    case 'add_sheet': case 'add_tab': {
      const title = input.title?.trim() || `Sheet${book.sheets.length + 1}`;
      const r = await write(ctx, doc, input, [{ op: 'add_sheet', name: title }], `Added sheet ${title}`);
      const made = r.book.sheets[r.book.sheets.length - 1]!;
      return `${done(r.doc)} Added sheet "${made.name}" — write to it with sheet: "${made.name}"; other sheets reference it as ${/^[A-Za-z_]\w*$/.test(made.name) ? made.name : `'${made.name}'`}!A1.`;
    }
    case 'grid_op': {
      const op = gridOps(input, name);
      const r = await write(ctx, doc, input, [op], `${input.operation?.type ?? 'grid'}`);
      return `${done(r.doc)} ${describeSheet(sheetByName(r.book, name)!)}; formulas that pointed at moved cells follow them.${outcome(r.book, name, [])}`;
    }
    default:
      throw new Error(`${action} does not apply to a sheet canvas. Sheet actions: read, set_cells, format_cells, add_sheet, grid_op, export (xlsx|csv).`);
  }
}

/** import {path}: a workspace .xlsx/.csv as a new sheet canvas. */
export async function importSheet(ctx: CanvasContext, file: string, title?: string): Promise<string> {
  const bytes = await readFile(file).catch(() => { throw new Error(`cannot read ${file}`); });
  if (bytes.length > 25 * 1024 * 1024) throw new Error('import a file of at most 25 MB');
  const book = importSheetFile(path.basename(file), new Uint8Array(bytes));
  const content = serializeBook(book);
  const doc = await createCanvas(ctx, { title: title?.trim() || path.basename(file).replace(/\.[^.]+$/, ''), kind: 'sheet', content, author: 'agent', note: `Imported ${path.basename(file)}` });
  const computed = computeBook(book);
  return `Imported ${path.basename(file)} as sheet canvas ${doc.id} "${doc.title}", version 1. `
    + `${book.sheets.map(describeSheet).join('; ')}.${computed.errors.length ? ` ${computed.errors.length} formula(s) compute to errors — read it to see them.` : ''}\n`
    + card(doc);
}

/** The one paragraph of the tool description about sheets. */
export const SHEET_TOOL_HELP = 'Sheets (kind "sheet": a live spreadsheet with Excel formulas the user edits in a grid): '
  + 'create {title, kind:"sheet", tabs?:[{title}] (sheet names), range?:"A1", values?:[[…]] or cells?:{"A1":…}} · '
  + 'read {id, sheet?, range?} → a compact table "D2: =B2*C2 → 55" · '
  + 'set_cells {id, version, sheet?, cells:{"B2":10,"D2":"=B2*C2"}} or {range:"A2", values:[["Cement",10,5.5,"=B2*C2"]]} — '
  + 'values are numbers/text/booleans, "12%", "$1,200", "2026-10-03", formulas start with "=" (Excel syntax incl. Sheet2!A1; '
  + `functions: ${FUNCTIONS.join(' ')}) · `
  + 'format_cells {id, version, range, style:{num:"number|currency|percent|date|text", dp, cur:"GBP", bold, fill:"#RRGGBB", align}, '
  + 'layout?:{widths:{"A":220}, freeze:{rows:1}, filter:true, conditional:[{range, op:"gt|lt|gte|lte|eq|ne|between|contains|error", value, fill}], chart:{range:"A1:B9", type:"bar|line|area|pie", title}}} · '
  + 'add_sheet {id, version, title} · grid_op {id, version, operation:{type:"insert_rows|delete_rows|insert_cols|delete_cols|sort|fill_down", at:"5"|"C", count, column, desc, header}, range?} · '
  + 'import {path} (.xlsx/.csv in the workspace) · export {id, format:"xlsx"|"csv", sheet?}. '
  + 'Every write returns the changed cells\' computed values and any formula errors — fix errors before you finish. Never send the whole sheet; write only the cells that change.';
