import path from 'path';
import { readFile } from 'fs/promises';
import { resolveForReading } from './path.js';

const MAX_CHARS = 100_000;
const MAX_ROWS = 500;

export interface ReadAttachmentInput {
  file_path: string;
  page?: number;
  sheet?: string;
  start_row?: number;
  end_row?: number;
}

function clip(text: string): string {
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n\n... [attachment output truncated]`
    : text;
}

export async function readAttachment(input: ReadAttachmentInput): Promise<string> {
  const filePath = resolveForReading(input.file_path, 'file_path');
  const ext = path.extname(filePath).toLowerCase();
  if (!['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md'].includes(ext)) {
    throw new Error('ReadAttachment supports PDF, DOCX, XLSX, CSV, TXT, and Markdown files only');
  }

  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    return clip(await readFile(filePath, 'utf8'));
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return clip(result.value);
  }
  if (ext === '.xlsx') {
    // ExcelJS rather than SheetJS.
    //
    // Not a preference. The `xlsx` package on npm is abandoned at 0.18.5 and
    // carries a prototype-pollution and a ReDoS advisory, both in the parser,
    // both fixed only in releases SheetJS publishes to their own CDN. Every
    // file reaching this line is a spreadsheet a user uploaded, so "reachable
    // from untrusted input" is not a hypothetical here — it is the entire job
    // of the function.
    //
    // The alternatives were a tarball URL dependency or a third-party
    // republish of the patched build. This is a package other people install:
    // a `https://cdn.sheetjs.com/…tgz` dependency breaks anyone on a registry
    // mirror or an offline cache, and swapping a known advisory for an unknown
    // maintainer is not obviously an improvement when the code parses hostile
    // files. ExcelJS is on the registry and covers what this needs.
    // Off the default export, not a named one. ExcelJS is CommonJS, so under
    // Node's ESM interop the namespace has exactly one key — `default` — and
    // `import { Workbook }` type-checks against the bundled .d.ts while being
    // undefined at run time. A probe caught it; nothing else would have.
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.default.Workbook();
    // Through the underlying ArrayBuffer: ExcelJS types `load` as taking one,
    // and Node's Buffer no longer satisfies that after the typed-array changes
    // in @types/node.
    const bytes = await readFile(filePath);
    await workbook.xlsx.load(bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer);

    const name = input.sheet ?? workbook.worksheets[0]?.name;
    const sheet = name ? workbook.getWorksheet(name) : undefined;
    // Naming a sheet that is not there lists what is, rather than failing.
    // Listing is also the honest answer for a workbook nobody named a sheet in.
    if (!name || !sheet) {
      return `Sheets:\n${workbook.worksheets.map(ws => `- ${ws.name}`).join('\n')}`;
    }

    const start = Math.max(1, input.start_row ?? 1);
    const end = Math.min(input.end_row ?? start + MAX_ROWS - 1, start + MAX_ROWS - 1);
    const lines: string[] = [];
    for (let n = start; n <= end; n++) {
      const row = sheet.getRow(n);
      // ExcelJS numbers cells from 1 and puts a hole at index 0, so the row
      // array is one longer than the row is wide.
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      // Blank rows are skipped rather than printed, the same as before: a
      // spreadsheet padded to row 900 should not spend the budget on nothing.
      if (values.every(v => v === null || v === undefined || v === '')) continue;
      lines.push(`${n}: ${values.map(cellText).join(' | ')}`);
    }
    return clip(`Sheet: ${name}\nRows ${start}-${end}\n\n${lines.join('\n')}`);
  }

  const pdf = await import('pdf-parse');
  const parser = new pdf.PDFParse({ data: await readFile(filePath) });
  try {
    const result = await parser.getText();
    return clip(result.text);
  } finally {
    await parser.destroy();
  }
}

/**
 * One cell as text.
 *
 * ExcelJS returns rich objects where SheetJS returned primitives: a formula
 * cell is `{ formula, result }`, a hyperlink is `{ text, hyperlink }`, and rich
 * text is `{ richText: [...] }`. Left alone they stringify to `[object Object]`,
 * which is worse than useless — it looks like data.
 *
 * Formulas resolve to their cached result, because a reader asking what is in a
 * spreadsheet wants the number, not `=SUM(B2:B40)`.
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value);

  const cell = value as Record<string, unknown>;
  if ('result' in cell) return cellText(cell.result);
  if ('text' in cell) return String(cell.text);
  if (Array.isArray(cell.richText)) {
    return (cell.richText as Array<{ text?: unknown }>).map(part => String(part.text ?? '')).join('');
  }
  if ('formula' in cell) return `=${String(cell.formula)}`;
  // An error cell — #DIV/0! and friends. Saying so beats an empty column.
  if ('error' in cell) return String(cell.error);
  return '';
}

export const readAttachmentDefinition = {
  name: 'ReadAttachment',
  description: 'Read an uploaded PDF, DOCX, XLSX, CSV, TXT, or Markdown attachment by its server-provided path. Use XLSX sheet and row bounds to inspect a spreadsheet in slices.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Attachment path named in the user message.' },
      page: { type: 'number', description: 'Reserved for PDF page selection.' },
      sheet: { type: 'string', description: 'XLSX sheet name. Omit to read the first sheet.' },
      start_row: { type: 'number', description: 'First XLSX row, 1-indexed.' },
      end_row: { type: 'number', description: 'Last XLSX row, inclusive.' },
    },
    required: ['file_path'],
  },
};
