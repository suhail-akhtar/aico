/**
 * An agent's `paths.write`: where AICO's own file tools may write for it.
 *
 * Why a separate guard from `sandbox/guard.ts`: the sandbox is a session
 * setting (off by default) about the workspace as a whole; this is a property
 * of one agent definition, inherited by every child it delegates to, and it
 * must hold whatever the session's sandbox mode is. It is deny-only (ADR 0002):
 * it can refuse a write, never allow one another stage refused.
 *
 * What it binds, honestly: Write, Edit, MultiEdit and NotebookEdit, by their
 * path argument, resolved against the run's directory. A write-capable call
 * whose path argument is missing is refused (an unrecognised shape is the one
 * not to permit). It does **not** bind Bash, Terminal, Git, the editor's
 * rename/format, or any process the agent starts — a command line is not a
 * path. The builder says "file tools only" next to the field, and the summary
 * says Bash is unbound when the agent has it (AICO.md: say what is enforced).
 *
 * Globs: `**` any number of segments, `*` within one segment, `?` one
 * character; matched against the path relative to the bound's root with `/`
 * separators, case-insensitively on Windows. A path outside the root never
 * matches.
 *
 * @module agents/paths-guard
 */

import path from 'path';
import type { ToolPipeline } from '../tools/pipeline.js';
import type { WriteBound } from './effective.js';

/** Tools whose writes this guard governs, and the argument naming the target. */
export const WRITE_PATH_ARGUMENTS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** A write-path glob as a regular expression over `/`-separated relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A bare directory (`deploy` or `deploy/`) means everything under it.
  if (!/[*?]/.test(g)) re = `${re.replace(/\/$/, '')}(?:/.*)?`;
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

/** Problems with one glob, phrased as the fix. Empty when it is usable. */
export function writeGlobProblem(glob: string): string | undefined {
  const g = glob.trim();
  if (!g) return 'an empty write path — remove it';
  if (path.isAbsolute(g) || /^[A-Za-z]:/.test(g)) return `"${g}" is absolute — write paths are relative to the project, e.g. "src/**"`;
  if (g.replace(/\\/g, '/').split('/').includes('..')) return `"${g}" climbs out with ".." — write paths stay inside the project`;
  return undefined;
}

/** Whether every bound admits a write to `target` (absolute or relative to `cwd`). */
export function writeRefusal(bounds: readonly WriteBound[], target: string, cwd: string): string | undefined {
  const abs = path.resolve(cwd, target);
  for (const b of bounds) {
    const rel = path.relative(b.root, abs);
    const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    const posix = rel.split(path.sep).join('/');
    if (!inside || !b.globs.some(g => globToRegExp(g).test(posix))) {
      return `Writing ${target} is outside what ${b.label} may write (paths.write: ${b.globs.join(', ')}). `
        + 'Write only inside those paths, or tell the person what needs changing elsewhere.';
    }
  }
  return undefined;
}

/** Install the guard. Scoped to one agent id: a composed pipeline may be shared. */
export function installWritePathsGuard(pipeline: ToolPipeline, opts: {
  agentId: string;
  bounds: readonly WriteBound[];
  cwd: () => string;
}): () => void {
  return pipeline.onGuard('agent-paths', (ctx) => {
    if (ctx.agentId !== opts.agentId) return { kind: 'abstain' };
    const key = WRITE_PATH_ARGUMENTS[ctx.name];
    if (!key) return { kind: 'abstain' };
    const target = ctx.arguments?.[key];
    if (typeof target !== 'string' || !target.trim()) {
      return { kind: 'deny', reason: `${ctx.name} needs "${key}" so this agent's write paths can be checked.` };
    }
    const refused = writeRefusal(opts.bounds, target, opts.cwd());
    return refused ? { kind: 'deny', reason: refused } : { kind: 'abstain' };
  });
}
