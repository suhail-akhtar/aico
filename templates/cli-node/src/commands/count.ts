/**
 * The worked command. Every command in this tool has this shape: parse its
 * own flags, do the work through a pure function, print, return an exit code.
 * Copy this file for the next one.
 */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { Io } from '../cli.js';

export interface CountResult { file: string; count: number }

/** Pure: the counting, testable without files. */
export function countText(text: string, words: boolean): number {
  if (words) return text.split(/\s+/).filter(Boolean).length;
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).filter((line, i, all) => i < all.length - 1 || line.length > 0).length;
}

export function renderTable(rows: CountResult[], label: string): string {
  const width = Math.max(...rows.map(r => String(r.count).length), label.length);
  const lines = rows.map(r => `${String(r.count).padStart(width)}  ${r.file}`);
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (rows.length > 1) lines.push(`${String(total).padStart(width)}  total`);
  return `${label.padStart(width)}  file\n${lines.join('\n')}\n`;
}

export async function count(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { words: { type: 'boolean' }, json: { type: 'boolean' } },
    allowPositionals: true,
  });
  if (positionals.length === 0) {
    io.stderr.write('count: give at least one file.\n');
    return 2;
  }
  const rows: CountResult[] = [];
  for (const file of positionals) {
    const text = await readFile(file, 'utf8');
    rows.push({ file, count: countText(text, values.words === true) });
  }
  io.stdout.write(values.json ? `${JSON.stringify(rows)}\n` : renderTable(rows, values.words ? 'words' : 'lines'));
  return 0;
}
