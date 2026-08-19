import fastGlob from 'fast-glob';
import { currentCwd } from '../run-context.js';
import { resolveForReading } from './path.js';

export interface GlobInput {
  pattern: string;
  cwd?: string;
}

export async function globFiles(input: GlobInput): Promise<string> {
  const cwd = input.cwd ? resolveForReading(input.cwd, 'cwd') : currentCwd();
  const matches = await fastGlob(input.pattern, {
    cwd,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: false,
  });
  if (matches.length === 0) {
    return `No files matched pattern: ${input.pattern}`;
  }
  return matches.join('\n');
}

export const globDefinition = {
  name: 'Glob',
  description: 'Find files matching a glob pattern.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match (e.g. "src/**/*.ts").' },
      cwd: { type: 'string', description: 'Directory to search from (defaults to CWD).' },
    },
    required: ['pattern'],
  },
};
