/**
 * A small reader for .xlsx files: sheet names and cell text, nothing else.
 *
 * Why not a library. ExcelJS did this job and brought archiver, unzipper,
 * fstream, rimraf 2 and glob 7 with it — five deprecated packages, two with
 * published advisories, for a function that reads a spreadsheet a person
 * uploaded and prints its rows. SheetJS on the registry is abandoned with its
 * own advisories. An .xlsx is a zip of XML; the parts this needs are the
 * workbook (sheet names), its relationships (which part is which sheet), the
 * shared strings, the cell styles (to tell a date from a number) and the
 * sheets themselves. `fflate` unzips with no dependencies; the XML here is
 * regular enough for a scanner that looks for the handful of elements used.
 *
 * Not a general XML parser, and not meant to be: it reads what Excel, Google
 * Sheets and LibreOffice write, and treats anything else as empty rather than
 * throwing on a file a person cannot fix.
 *
 * @module tools/xlsx-lite
 */

import { unzipSync, strFromU8 } from 'fflate';

export interface Workbook {
  /** Sheet names, in workbook order. */
  sheets: string[];
  /** Rows of one sheet, keyed by row number (1-based); each row is cell text by column index (0-based). */
  rows(sheet: string): Map<number, string[]>;
}

/** Built-in number formats Excel treats as dates or times. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Every `<t>` inside an element, joined — rich text is several runs. */
function textRuns(xml: string): string {
  const out: string[] = [];
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out.push(decodeEntities(m[1]!));
  return out.join('');
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeEntities(m[1]!) : undefined;
}

/** "A" → 0, "AB" → 27. */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
}

/** An Excel serial date as an ISO day. The 1900 system, with Excel's phantom 29 February 1900. */
export function serialToIso(serial: number): string {
  const days = Math.floor(serial);
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

export function readWorkbook(bytes: Uint8Array): Workbook {
  const files = unzipSync(bytes);
  const text = (name: string): string | undefined => {
    const entry = files[name] ?? files[name.replace(/^\//, '')];
    return entry ? strFromU8(entry) : undefined;
  };

  // Sheet names and their relationship ids, then the part each id points at.
  const workbookXml = text('xl/workbook.xml') ?? '';
  const relsXml = text('xl/_rels/workbook.xml.rels') ?? '';
  const targets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const sheets: Array<{ name: string; part: string }> = [];
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = attr(m[0], 'r:id') ?? attr(m[0], 'id');
    const part = (rid && targets.get(rid)) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name, part });
  }

  const shared: string[] = [];
  const sharedXml = text('xl/sharedStrings.xml');
  if (sharedXml) for (const m of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1]!));

  // Which cell styles are dates: cellXfs[i].numFmtId, against the built-in
  // date ids and any custom format that spells out a day, month or year.
  const stylesXml = text('xl/styles.xml') ?? '';
  const customDateFormats = new Set<number>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = (attr(m[0], 'formatCode') ?? '').replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
    if (/[dmy]/i.test(code) && !/[#0]/.test(code)) customDateFormats.add(id);
  }
  const dateStyles = new Set<number>();
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  let styleIndex = 0;
  for (const m of cellXfs.matchAll(/<xf\b[^>]*>/g)) {
    const fmt = Number(attr(m[0], 'numFmtId') ?? '0');
    if (DATE_FORMAT_IDS.has(fmt) || customDateFormats.has(fmt)) dateStyles.add(styleIndex);
    styleIndex++;
  }

  const cache = new Map<string, Map<number, string[]>>();
  return {
    sheets: sheets.map(s => s.name),
    rows(sheet) {
      const hit = cache.get(sheet);
      if (hit) return hit;
      const rows = new Map<number, string[]>();
      const part = sheets.find(s => s.name === sheet)?.part;
      const xml = part ? text(part) : undefined;
      if (xml) {
        // Both spellings: a row with cells, and the self-closing `<row r="3"/>`
        // Excel writes for a row that once had content and no longer does.
        for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
          const rowNumber = Number(attr(`<row${rowMatch[1]}>`, 'r') ?? '0');
          const cells: string[] = [];
          for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const open = `<c${cellMatch[1]}>`;
            const ref = attr(open, 'r') ?? '';
            const type = attr(open, 't');
            const style = Number(attr(open, 's') ?? '-1');
            const body = cellMatch[2] ?? '';
            const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
            let out = '';
            if (type === 's') out = shared[Number(value)] ?? '';
            else if (type === 'inlineStr') out = textRuns(body);
            else if (type === 'str' || type === 'e') out = value === undefined ? '' : decodeEntities(value);
            else if (type === 'b') out = value === '1' ? 'TRUE' : 'FALSE';
            else if (value !== undefined) {
              const n = Number(value);
              out = Number.isFinite(n) && dateStyles.has(style) && n > 0 ? serialToIso(n) : decodeEntities(value);
            }
            const col = ref ? columnIndex(ref) : cells.length;
            while (cells.length < col) cells.push('');
            cells[col] = out;
          }
          if (rowNumber > 0) rows.set(rowNumber, cells);
        }
      }
      cache.set(sheet, rows);
      return rows;
    },
  };
}
