import { readdir, stat } from 'fs/promises';
import path from 'path';
import { resolveInsideWorkspace } from './path.js';

export interface LSInput {
  path?: string;
  show_hidden?: boolean;
}

export async function listDirectory(input: LSInput): Promise<string> {
  const dirPath = resolveInsideWorkspace(input.path ?? '.', 'path');
  const entries = await readdir(dirPath, { withFileTypes: true });

  const filtered = input.show_hidden
    ? entries
    : entries.filter((e) => !e.name.startsWith('.'));

  const lines: string[] = [`Contents of ${dirPath}:`, ''];
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of filtered) {
    if (entry.isDirectory()) {
      dirs.push(`  📁 ${entry.name}/`);
    } else if (entry.isSymbolicLink()) {
      files.push(`  🔗 ${entry.name}`);
    } else {
      try {
        const s = await stat(path.join(dirPath, entry.name));
        const size = formatSize(s.size);
        files.push(`  📄 ${entry.name} (${size})`);
      } catch {
        files.push(`  📄 ${entry.name}`);
      }
    }
  }

  dirs.sort();
  files.sort();

  lines.push(...dirs, ...files);
  lines.push('');
  lines.push(`${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}, ${files.length} file${files.length === 1 ? '' : 's'}`);

  return lines.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const lsDefinition = {
  name: 'LS',
  description: 'List the contents of a directory.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list (defaults to CWD).' },
      show_hidden: { type: 'boolean', description: 'Include hidden files (starting with .).' },
    },
    required: [],
  },
};
