import { readFile as fsReadFile } from 'fs/promises';
import { resolveForReading } from './path.js';
import { toLf } from './eol.js';

export interface ReadInput {
  file_path: string;
  start_line?: number;
  end_line?: number;
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'PNG image', '.jpg': 'JPEG image', '.jpeg': 'JPEG image', '.gif': 'GIF image', '.webp': 'WebP image',
  '.bmp': 'bitmap image', '.ico': 'icon', '.pdf': 'PDF document', '.zip': 'zip archive', '.gz': 'gzip archive',
  '.woff': 'font', '.woff2': 'font', '.ttf': 'font', '.sqlite': 'SQLite database', '.db': 'database',
};

/**
 * What a binary file is, in one line, instead of its bytes.
 *
 * A model asked to look at a verifier's screenshot called Read on the PNG and
 * was handed eight thousand characters of control bytes as "lines". Nothing
 * useful can come of that. A model that can see images gets them as
 * attachments, not through Read; for everyone else the honest answer is what
 * the file is and how big.
 */
function describeBinary(file: string, bytes: Buffer): string | undefined {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  const known = IMAGE_TYPES[ext];
  const sample = bytes.subarray(0, 8000);
  const hasNul = sample.includes(0);
  if (!known && !hasNul) return undefined;
  const kb = Math.max(1, Math.round(bytes.length / 1024));
  let size = '';
  if (ext === '.png' && bytes.length >= 24 && bytes.readUInt32BE(12) === 0x49484452) {
    size = `, ${bytes.readUInt32BE(16)}×${bytes.readUInt32BE(20)}`;
  }
  return `${file} is a binary file (${known ?? 'unknown type'}, ${kb} KB${size}). It cannot be read as text. `
    + (known?.endsWith('image') ? 'An image reaches a model that can see it as an attachment, not through Read; if this model cannot, rely on what the check that produced it reported.' : 'Use a tool that understands the format.');
}

export async function readFile(input: ReadInput): Promise<string> {
  const resolved = resolveForReading(input.file_path, 'file_path');
  const bytes = await fsReadFile(resolved);
  const binary = describeBinary(input.file_path, bytes);
  if (binary) return binary;
  const raw = bytes.toString('utf8');
  /*
    Normalised before splitting, so a CRLF file does not hand the model a
    trailing carriage return on every line.

    Splitting the raw text left one on the end of each line. A model cannot see
    it and does not reproduce it, so every multi-line `old_str` it sent back to
    `Edit` failed to match — reported as "the string to replace was not found",
    which reads as the model having invented the snippet. Re-reading changed
    nothing, so the agent would read and fail, read and fail. See `tools/eol`.
  */
  const lines = toLf(raw).split('\n');

  const start = input.start_line ? input.start_line - 1 : 0;
  const end = input.end_line ? input.end_line : lines.length;
  const sliced = lines.slice(start, end);

  return sliced.map((line, idx) => `${start + idx + 1}: ${line}`).join('\n');
}

export const readDefinition = {
  name: 'Read',
  description: 'Read the contents of a file, optionally limited to a range of lines.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file to read.' },
      start_line: { type: 'number', description: 'First line number to read (1-indexed, inclusive).' },
      end_line: { type: 'number', description: 'Last line number to read (1-indexed, inclusive).' },
    },
    required: ['file_path'],
  },
};
