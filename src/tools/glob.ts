import fastGlob from 'fast-glob';
import { currentCwd } from '../run-context.js';
import { resolveForReading } from './path.js';

export interface GlobInput {
  pattern: string;
  cwd?: string;
}

/**
 * Why a glob pattern is refused before it reaches fast-glob, or undefined.
 *
 * WHY: brace expansion (`braces`, under micromatch/fast-glob) has a known
 * resource-exhaustion advisory with no upstream fix (GHSA-vfj7-8cjw-p6xm), and
 * the pattern is model-chosen. Long patterns, many braces and numeric ranges
 * are what blow it up, so they are capped here. A pattern that climbs out of
 * the search root (`../`) or is absolute is refused too: the root was checked
 * by `resolveForReading`, and the pattern must not walk around that check.
 */
export function globPatternProblem(pattern: unknown, label = 'pattern'): string | undefined {
  if (typeof pattern !== 'string' || !pattern) return `${label} is required and must be a non-empty string.`;
  if (pattern.length > 500) return `${label} is ${pattern.length} characters; the limit is 500.`;
  if ((pattern.match(/\{/g) ?? []).length > 10) return `${label} has more than 10 brace groups; split it into several calls.`;
  for (const m of pattern.matchAll(/\{\s*(-?\d+)\s*\.\.\s*(-?\d+)/g)) {
    if (Math.abs(Number(m[2]) - Number(m[1])) > 100) return `${label} has a numeric range wider than 100 ({${m[1]}..${m[2]}}).`;
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(pattern) || /^(?:[\\/]|[A-Za-z]:)/.test(pattern)) {
    return `${label} must be relative to the search folder and may not contain "..". Pass the folder as cwd/path instead.`;
  }
  return undefined;
}

export async function globFiles(input: GlobInput): Promise<string> {
  const problem = globPatternProblem(input.pattern);
  if (problem) throw new Error(problem);
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
