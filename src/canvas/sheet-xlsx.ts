/**
 * AICO Sheets ↔ files: .xlsx written by hand with `fflate`, .xlsx and .csv
 * read back into a workbook.
 *
 * ## Why by hand
 *
 * The same reason as the .docx writer (ADR 0008): a spreadsheet library is a
 * new runtime dependency (ExcelJS was removed from this codebase for the
 * deprecated packages it brought — see `tools/xlsx-lite`), and a workbook is a
 * zip of a few XML parts. This writes exactly what the sheet model holds:
 *
 * - **real formulas with cached values** — `<f>` plus `<v>` (and `t="str"`,
 *   `"b"`, `"e"` for text, boolean and error results), so the file shows the
 *   right numbers in any reader, and `fullCalcOnLoad` so Excel recalculates
 *   on open. Newer functions get the `_xlfn.` prefix the file format requires
 *   (without it Excel shows #NAME? for XLOOKUP). A formula that does not parse
 *   is written as text, never as a formula Excel would offer to repair;
 * - **number formats** as custom `numFmt` codes (`#,##0.00`, `"£"#,##0.00`,
 *   `0.0%`, `yyyy-mm-dd`, `@`), bold, fills and alignment as `cellXfs`;
 * - **column widths**, the **frozen header** (a frozen pane), the **filter**
 *   (`autoFilter` over the used range) and **conditional fills**
 *   (`conditionalFormatting` with `dxf` fills — live in Excel, not baked in).
 *
 * Strings are inline (`t="inlineStr"`), so there is no shared-strings part to
 * keep consistent. Charts are not written into the file (a DrawingML chart is
 * a part family of its own); the sheet keeps them and the app draws them.
 *
 * Import reads values and formulas through `tools/xlsx-lite` (shared formulas
 * are translated to each cell), keeps date cells as dates; widths, styles and
 * charts of an imported file are not read. CSV import parses each field as if
 * typed, except that a leading `=` stays text — a CSV is data, and running a
 * formula someone put in a downloaded file is how CSV injection works.
 *
 * @module canvas/sheet-xlsx
 */

import { zipSync, strToU8 } from 'fflate';
import { readWorkbook } from '../tools/xlsx-lite.js';
import {
  a1, bookFromRows, colIndex, colName, computeBook, emptyBook, isError, parseA1, parseDelimited, parseRangeA1,
  serializeBook, sheetCsv, usedExtent, DEFAULT_COL_PX,
  type Cell, type CellStyle, type CondRule, type Computed, type Sheet, type SheetBook, type Value,
} from '../../shared/ui/canvas/sheet-model.js';
import { mapFunctionNames, parseFormula, shiftFormula, MAX_ROWS } from '../../shared/ui/canvas/sheet-formula.js';

/** Functions newer than Excel 2007, which the file format spells with `_xlfn.`. */
const XLFN = new Set(['XLOOKUP', 'CONCAT', 'IFS', 'SWITCH', 'TEXTJOIN', 'MAXIFS', 'MINIFS', 'XMATCH', 'FILTER', 'SORT', 'UNIQUE', 'SEQUENCE', 'LET']);

function esc(s: string): string {
  return s
    // XML 1.0 forbids most control characters even escaped; a cell cannot carry them.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CURRENCY_CODES: Record<string, string> = {
  USD: '"$"', GBP: '"£"', EUR: '"€"', JPY: '"¥"', INR: '"₹"', CNY: '"¥"', KRW: '"₩"', AUD: '"A$"', CAD: '"C$"', NZD: '"NZ$"',
  CHF: '"CHF "', AED: '"AED "', SAR: '"SAR "', ZAR: '"R"', BRL: '"R$"', MXN: '"MX$"', SGD: '"S$"', HKD: '"HK$"', SEK: '"kr "',
  NOK: '"kr "', DKK: '"kr "', PKR: '"Rs "',
};

/** The Excel number-format code for a cell style, or undefined for General. */
export function numFmtCode(s: CellStyle | undefined): string | undefined {
  const dec = (n: number): string => (n > 0 ? `.${'0'.repeat(n)}` : '');
  switch (s?.num) {
    case 'number': return `#,##0${dec(s.dp ?? 2)}`;
    case 'currency': {
      const sym = CURRENCY_CODES[s.cur ?? 'USD'] ?? `"${s.cur} "`;
      const pos = `${sym}#,##0${dec(s.dp ?? 2)}`;
      return `${pos};-${pos}`;
    }
    case 'percent': return `0${dec(s.dp ?? 0)}%`;
    case 'date': return 'yyyy-mm-dd';
    case 'text': return '@';
    default: return undefined;
  }
}

/** px (what the grid stores) → Excel's character width. */
function excelWidth(px: number): number {
  return Math.max(1, Math.round(((px - 5) / 7) * 100) / 100);
}

interface StyleTable {
  /** The `s` index for a cell style. */
  index(s: CellStyle | undefined): number;
  /** The dxf index for a conditional fill. */
  dxf(fill: string): number;
  xml(): string;
}

function styleTable(): StyleTable {
  const numFmts: string[] = [];
  const fills: string[] = [];
  const xfs: string[] = ['0|0|0|'];
  const dxfs: string[] = [];
  const key = (s: CellStyle | undefined): string => {
    if (!s) return '0|0|0|';
    const code = numFmtCode(s);
    let fmt = 0;
    if (code === '@') fmt = 49;
    else if (code) {
      let i = numFmts.indexOf(code);
      if (i < 0) { numFmts.push(code); i = numFmts.length - 1; }
      fmt = 164 + i;
    }
    let fill = 0;
    if (s.fill) {
      let i = fills.indexOf(s.fill);
      if (i < 0) { fills.push(s.fill); i = fills.length - 1; }
      fill = 2 + i;
    }
    return `${fmt}|${s.b ? 1 : 0}|${fill}|${s.align ?? ''}`;
  };
  return {
    index(s) {
      const k = key(s);
      let i = xfs.indexOf(k);
      if (i < 0) { xfs.push(k); i = xfs.length - 1; }
      return i;
    },
    dxf(fill) {
      let i = dxfs.indexOf(fill);
      if (i < 0) { dxfs.push(fill); i = dxfs.length - 1; }
      return i;
    },
    xml() {
      const rgb = (hex: string): string => `FF${hex.slice(1).toUpperCase()}`;
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(c)}"/>`).join('')}</numFmts>` : '')
        + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
        + `<fills count="${2 + fills.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
        + fills.map(f => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb(f)}"/><bgColor indexed="64"/></patternFill></fill>`).join('')
        + '</fills>'
        + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + `<cellXfs count="${xfs.length}">${xfs.map((k) => {
          const [fmt, bold, fill, align] = k.split('|');
          return `<xf numFmtId="${fmt}" fontId="${bold}" fillId="${fill}" borderId="0" xfId="0"`
            + `${fmt !== '0' ? ' applyNumberFormat="1"' : ''}${bold !== '0' ? ' applyFont="1"' : ''}${fill !== '0' ? ' applyFill="1"' : ''}`
            + (align ? ` applyAlignment="1"><alignment horizontal="${align}"/></xf>` : '/>');
        }).join('')}</cellXfs>`
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        + `<dxfs count="${dxfs.length}">${dxfs.map(f => `<dxf><fill><patternFill patternType="solid"><bgColor rgb="${rgb(f)}"/></patternFill></fill></dxf>`).join('')}</dxfs>`
        + '</styleSheet>';
    },
  };
}

function cellXml(ref: string, cell: Cell, value: Value, s: number): string {
  const sAttr = s ? ` s="${s}"` : '';
  if (cell.f !== undefined) {
    let ok = true;
    try { parseFormula(cell.f); } catch { ok = false; }
    if (ok) {
      const f = `<f>${esc(mapFunctionNames(cell.f, n => (XLFN.has(n) ? `_xlfn.${n}` : n)))}</f>`;
      if (isError(value)) {
        // Excel has no #ERROR!; a circular reference is cached as #REF! already.
        const code = value.error === '#ERROR!' ? '#VALUE!' : value.error;
        return `<c r="${ref}"${sAttr} t="e">${f}<v>${code}</v></c>`;
      }
      if (typeof value === 'number') return `<c r="${ref}"${sAttr}>${f}<v>${value}</v></c>`;
      if (typeof value === 'boolean') return `<c r="${ref}"${sAttr} t="b">${f}<v>${value ? 1 : 0}</v></c>`;
      if (value === null) return `<c r="${ref}"${sAttr}>${f}</c>`;
      return `<c r="${ref}"${sAttr} t="str">${f}<v>${esc(value)}</v></c>`;
    }
    return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(`=${cell.f}`)}</t></is></c>`;
  }
  const v = cell.v;
  if (v === undefined || v === null) return `<c r="${ref}"${sAttr}/>`;
  if (typeof v === 'number') return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

const CF_OPERATOR: Partial<Record<CondRule['op'], string>> = {
  gt: 'greaterThan', lt: 'lessThan', gte: 'greaterThanOrEqual', lte: 'lessThanOrEqual', eq: 'equal', ne: 'notEqual', between: 'between',
};

function cfFormula(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

function sheetXml(sheet: Sheet, computed: Computed, styles: StyleTable, active: boolean): string {
  const ext = usedExtent(sheet);
  const byRow = new Map<number, Array<{ c: number; ref: string; cell: Cell }>>();
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    const p = parseA1(ref)!;
    const list = byRow.get(p.r) ?? [];
    list.push({ c: p.c, ref, cell });
    byRow.set(p.r, list);
  }
  const rows = [...byRow.keys()].sort((x, y) => x - y).map((r) => {
    const cells = byRow.get(r)!.sort((x, y) => x.c - y.c)
      .map(({ ref, cell, c }) => cellXml(ref, cell, computed.at(sheet.id, r, c), styles.index(cell.s)));
    return `<row r="${r + 1}">${cells.join('')}</row>`;
  });
  const fr = sheet.freeze?.rows ?? 0;
  const fc = sheet.freeze?.cols ?? 0;
  const pane = fr || fc
    ? `<pane${fc ? ` xSplit="${fc}"` : ''}${fr ? ` ySplit="${fr}"` : ''} topLeftCell="${a1(fr, fc)}" activePane="${fr && fc ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight'}" state="frozen"/>`
    : '';
  const cols = Object.entries(sheet.cols ?? {})
    .map(([letter, px]) => ({ i: colIndex(letter), px }))
    .filter(c => c.i >= 0 && c.px !== DEFAULT_COL_PX)
    .sort((x, y) => x.i - y.i)
    .map(c => `<col min="${c.i + 1}" max="${c.i + 1}" width="${excelWidth(c.px)}" customWidth="1"/>`);
  const dim = ext.rows && ext.cols ? `A1:${a1(ext.rows - 1, ext.cols - 1)}` : 'A1';
  const filter = sheet.filter && ext.rows > 0 && ext.cols > 0
    ? `<autoFilter ref="${a1(Math.max(0, fr - 1), 0)}:${a1(ext.rows - 1, ext.cols - 1)}"/>` : '';
  let priority = 1;
  const cond = (sheet.cond ?? []).map((rule) => {
    const range = parseRangeA1(rule.range);
    if (!range) return '';
    const dxf = styles.dxf(rule.fill);
    const top = a1(range.r1, range.c1);
    if (rule.op === 'contains') {
      return `<conditionalFormatting sqref="${rule.range}"><cfRule type="containsText" dxfId="${dxf}" priority="${priority++}" operator="containsText" text="${esc(String(rule.value ?? ''))}">`
        + `<formula>NOT(ISERROR(SEARCH(${esc(cfFormula(String(rule.value ?? '')))},${top})))</formula></cfRule></conditionalFormatting>`;
    }
    if (rule.op === 'error') {
      return `<conditionalFormatting sqref="${rule.range}"><cfRule type="containsErrors" dxfId="${dxf}" priority="${priority++}"><formula>ISERROR(${top})</formula></cfRule></conditionalFormatting>`;
    }
    const operator = CF_OPERATOR[rule.op];
    if (!operator) return '';
    return `<conditionalFormatting sqref="${rule.range}"><cfRule type="cellIs" dxfId="${dxf}" priority="${priority++}" operator="${operator}">`
      + `<formula>${esc(cfFormula(rule.value))}</formula>${rule.op === 'between' ? `<formula>${esc(cfFormula(rule.value2))}</formula>` : ''}</cfRule></conditionalFormatting>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<dimension ref="${dim}"/>`
    + `<sheetViews><sheetView workbookViewId="0"${active ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>`
    // The grid's default column (100 px) rather than Excel's 64 px, so an ISO date or a currency total is not "####".
    + `<sheetFormatPr defaultColWidth="${excelWidth(DEFAULT_COL_PX)}" defaultRowHeight="15"/>`
    + (cols.length ? `<cols>${cols.join('')}</cols>` : '')
    + `<sheetData>${rows.join('')}</sheetData>`
    + filter
    + cond
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
    + '</worksheet>';
}

/** The workbook as .xlsx bytes. */
export function bookToXlsx(book: SheetBook, opts: { today?: number; title?: string } = {}): Uint8Array {
  const computed = computeBook(book, opts.today !== undefined ? { today: opts.today } : {});
  const styles = styleTable();
  const sheets = book.sheets.map((s, i) => sheetXml(s, computed, styles, i === 0));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + '</Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
      + '</Relationships>'),
    'docProps/core.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + `<dc:title>${esc(opts.title ?? '')}</dc:title><dc:creator>AICO</dc:creator></cp:coreProperties>`),
    'docProps/app.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>AICO</Application></Properties>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<bookViews><workbookView/></bookViews>'
      + `<sheets>${book.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
      + definedNames(book)
      + '<calcPr calcId="191029" fullCalcOnLoad="1"/>'
      + '</workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + book.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${book.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + '</Relationships>'),
  };
  sheets.forEach((xml, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(xml); });
  files['xl/styles.xml'] = strToU8(styles.xml());
  return zipSync(files, { level: 6 });
}

/** Excel stores an autoFilter's range as a hidden defined name too; without it Excel repairs the file. */
function definedNames(book: SheetBook): string {
  const names = book.sheets.map((s, i) => {
    if (!s.filter) return '';
    const ext = usedExtent(s);
    if (!ext.rows || !ext.cols) return '';
    const top = Math.max(0, (s.freeze?.rows ?? 0) - 1);
    const quoted = `'${s.name.replace(/'/g, "''")}'`;
    return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(`${quoted}!$A$${top + 1}:$${colName(ext.cols - 1)}$${ext.rows}`)}</definedName>`;
  }).join('');
  return names ? `<definedNames>${names}</definedNames>` : '';
}

// ── Import ───────────────────────────────────────────────────────────

/** An .xlsx file as a workbook: values, formulas (shared ones translated), dates. */
export function xlsxToBook(bytes: Uint8Array): SheetBook {
  let wb: ReturnType<typeof readWorkbook>;
  try { wb = readWorkbook(bytes); } catch { throw new Error('that file is not a readable .xlsx workbook'); }
  if (!wb.sheets.length) throw new Error('that workbook has no sheets');
  const book = emptyBook();
  book.sheets = [];
  const used = new Set<string>();
  for (const [i, name] of wb.sheets.slice(0, 20).entries()) {
    let clean = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(clean.toLowerCase())) clean = `${clean.slice(0, 28)} ${i + 1}`;
    used.add(clean.toLowerCase());
    const sheet: Sheet = { id: `s${i + 1}`, name: clean, cells: {} };
    const masters = new Map<number, { formula: string; r: number; c: number }>();
    for (const raw of wb.cells(name)) {
      const p = parseA1(raw.ref);
      if (!p || p.r >= MAX_ROWS) continue;
      const cell: Cell = {};
      let formula = raw.formula;
      if (raw.shared !== undefined) {
        if (formula !== undefined) masters.set(raw.shared, { formula, r: p.r, c: p.c });
        else {
          const m = masters.get(raw.shared);
          if (m) formula = shiftFormula(m.formula, p.r - m.r, p.c - m.c);
        }
      }
      if (formula !== undefined) cell.f = formula.replace(/_xlfn\./gi, '').replace(/_xlws\./gi, '');
      else if (raw.type === 'n' && raw.number !== undefined) cell.v = raw.number;
      else if (raw.type === 'd' && raw.number !== undefined) { cell.v = raw.number; cell.s = { num: 'date' }; }
      else if (raw.type === 'b') cell.v = raw.text === 'TRUE';
      else if (raw.text !== '') cell.v = raw.text;
      if (cell.f !== undefined && raw.type === 'd') cell.s = { num: 'date' };
      if (cell.v !== undefined || cell.f !== undefined) sheet.cells[a1(p.r, p.c)] = cell;
    }
    book.sheets.push(sheet);
  }
  return book;
}

/** A .csv (or .tsv) text as a one-sheet workbook. */
export function csvToBook(text: string, name = 'Sheet1'): SheetBook {
  const rows = parseDelimited(text.replace(/^﻿/, ''));
  if (rows.length > 100_000) throw new Error('a CSV of more than 100,000 rows is too large for a sheet canvas');
  return bookFromRows(rows, name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet1');
}

/** A workbook from an uploaded file, by its extension. */
export function importSheetFile(name: string, bytes: Uint8Array): SheetBook {
  const ext = name.toLowerCase().split('.').pop();
  const base = name.replace(/\.[^.]+$/, '');
  if (ext === 'xlsx' || ext === 'xlsm') return xlsxToBook(bytes);
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return csvToBook(new TextDecoder('utf-8').decode(bytes), base);
  throw new Error('import a .xlsx, .csv or .tsv file');
}

// ── Export ───────────────────────────────────────────────────────────

export type SheetExportFormat = 'xlsx' | 'csv';
export const SHEET_EXPORT_FORMATS: readonly SheetExportFormat[] = ['xlsx', 'csv'];
export const SHEET_MEDIA: Record<SheetExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
};

/** A sheet canvas's bytes. CSV is one sheet (`sheet` by name or id; default the first). */
export function exportSheet(book: SheetBook, format: SheetExportFormat, opts: { sheet?: string; title?: string; today?: number } = {}): Buffer {
  if (format === 'xlsx') return Buffer.from(bookToXlsx(book, { ...(opts.title ? { title: opts.title } : {}), ...(opts.today !== undefined ? { today: opts.today } : {}) }));
  const want = opts.sheet?.trim().toLowerCase();
  const sheet = want ? book.sheets.find(s => s.id === opts.sheet || s.name.toLowerCase() === want) : book.sheets[0];
  if (!sheet) throw new Error(`no sheet "${opts.sheet}". Sheets: ${book.sheets.map(s => `"${s.name}"`).join(', ')}`);
  // A BOM so Excel opens UTF-8 (£, €) correctly when the CSV is double-clicked.
  return Buffer.from(`﻿${sheetCsv(book, sheet, computeBook(book, opts.today !== undefined ? { today: opts.today } : {}))}`, 'utf8');
}

export { serializeBook };
