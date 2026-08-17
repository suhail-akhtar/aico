import { readFile } from 'fs/promises';
import path from 'path';
import fastGlob from 'fast-glob';
import { resolveInsideWorkspace } from './path.js';

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  context_lines?: number;
}

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export async function grepFiles(input: GrepInput): Promise<string> {
  const basePath = input.path ? resolveInsideWorkspace(input.path, 'path') : process.cwd();
  const globPattern = input.glob ?? '**/*';

  const files = await fastGlob(globPattern, {
    cwd: basePath,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
  });

  const flags = input.case_insensitive ? 'i' : '';
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, flags);
  } catch {
    throw new Error(`Invalid regex pattern: ${input.pattern}`);
  }

  const contextLines = input.context_lines ?? 0;
  const results: string[] = [];
  const MAX_RESULTS = 200;

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(path.join(basePath, file), 'utf8');
    } catch {
      continue;
    }

    // Skip binary-looking files
    if (content.includes('\0')) continue;

    const lines = content.split('\n');
    const matchedLineNums: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matchedLineNums.push(i);
      }
    }

    if (matchedLineNums.length === 0) continue;

    // Collect ranges with context
    const printedLines = new Set<number>();
    for (const lineNum of matchedLineNums) {
      const start = Math.max(0, lineNum - contextLines);
      const end = Math.min(lines.length - 1, lineNum + contextLines);
      for (let j = start; j <= end; j++) {
        printedLines.add(j);
      }
    }

    const sorted = [...printedLines].sort((a, b) => a - b);
    for (const lineNum of sorted) {
      const isMatch = matchedLineNums.includes(lineNum);
      const prefix = `${file}:${lineNum + 1}${isMatch ? ':' : '-'}`;
      results.push(`${prefix} ${lines[lineNum]}`);
    }

    if (results.length >= MAX_RESULTS) break;
  }

  if (results.length === 0) {
    return `No matches found for pattern: ${input.pattern}`;
  }

  return results.join('\n');
}

export const grepDefinition = {
  name: 'Grep',
  description: 'Search file contents using a regex pattern, returning matching lines with file and line number.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression pattern to search for.' },
      path: { type: 'string', description: 'Base directory to search in (defaults to CWD).' },
      glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "**/*.ts").' },
      case_insensitive: { type: 'boolean', description: 'Perform case-insensitive search.' },
      context_lines: { type: 'number', description: 'Number of context lines around each match.' },
    },
    required: ['pattern'],
  },
};
