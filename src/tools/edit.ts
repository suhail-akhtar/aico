import { readFile, writeFile } from 'fs/promises';
import { resolveInsideWorkspace } from './path.js';

export interface EditInput {
  file_path: string;
  old_str: string;
  new_str: string;
}

export async function editFile(input: EditInput): Promise<string> {
  const resolved = resolveInsideWorkspace(input.file_path, 'file_path');
  const original = await readFile(resolved, 'utf8');

  const occurrences = countOccurrences(original, input.old_str);

  if (occurrences === 0) {
    throw new Error(
      `str_replace failed: the string to replace was not found in ${input.file_path}`,
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `str_replace failed: found ${occurrences} occurrences of the string in ${input.file_path} — must be unique`,
    );
  }

  const updated = original.replace(input.old_str, input.new_str);
  await writeFile(resolved, updated, 'utf8');

  const oldLines = input.old_str.split('\n').length;
  const newLines = input.new_str.split('\n').length;
  return `Successfully edited ${input.file_path}: replaced ${oldLines} line(s) with ${newLines} line(s)`;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

export const editDefinition = {
  name: 'Edit',
  description:
    'Replace the first (and only) occurrence of old_str with new_str in a file. Errors if the string is not found or appears multiple times.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file to edit.' },
      old_str: { type: 'string', description: 'The exact string to find and replace.' },
      new_str: { type: 'string', description: 'The string to replace old_str with.' },
    },
    required: ['file_path', 'old_str', 'new_str'],
  },
};
