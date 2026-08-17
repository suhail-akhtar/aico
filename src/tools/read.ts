import { readFile as fsReadFile } from 'fs/promises';
import { resolveInsideWorkspace } from './path.js';

export interface ReadInput {
  file_path: string;
  start_line?: number;
  end_line?: number;
}

export async function readFile(input: ReadInput): Promise<string> {
  const resolved = resolveInsideWorkspace(input.file_path, 'file_path');
  const raw = await fsReadFile(resolved, 'utf8');
  const lines = raw.split('\n');

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
