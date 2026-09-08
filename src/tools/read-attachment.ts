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
    // Our own reader over fflate — see tools/xlsx-lite for why neither
    // SheetJS (abandoned on the registry, with advisories in the parser) nor
    // ExcelJS (five deprecated dependencies for a read) is used. Every file
    // reaching this line is one a person uploaded, so the parser's diet is
    // the whole point.
    const { readWorkbook } = await import('./xlsx-lite.js');
    const workbook = readWorkbook(await readFile(filePath));

    const name = input.sheet ?? workbook.sheets[0];
    // Naming a sheet that is not there lists what is, rather than failing.
    // Listing is also the honest answer for a workbook nobody named a sheet in.
    if (!name || !workbook.sheets.includes(name)) {
      return `Sheets:\n${workbook.sheets.map(s => `- ${s}`).join('\n')}`;
    }

    const rows = workbook.rows(name);
    const start = Math.max(1, input.start_row ?? 1);
    const end = Math.min(input.end_row ?? start + MAX_ROWS - 1, start + MAX_ROWS - 1);
    const lines: string[] = [];
    for (let n = start; n <= end; n++) {
      const values = rows.get(n) ?? [];
      // Blank rows are skipped rather than printed: a spreadsheet padded to
      // row 900 should not spend the budget on nothing.
      if (values.every(v => v === '')) continue;
      lines.push(`${n}: ${values.join(' | ')}`);
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
