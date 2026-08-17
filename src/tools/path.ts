/**
 * Where file-writing tools are allowed to write.
 *
 * Two roots, and the second one is the fix for a real failure: the agent has a
 * **workspace** — a durable place of its own for artifacts, reports, scratch
 * files and anything else it produces that is not part of the user's project —
 * and `Write` used to refuse it. Asked to save a chart, the agent tried its
 * workspace, was told the path "must stay inside the current workspace", and
 * fell back to dropping a `charts/` directory into the user's repository. That
 * is exactly backwards: the workspace exists so that generated files do *not*
 * land in someone's source tree.
 *
 * So writes are permitted under:
 *
 *   1. **the project** — the directory the agent was launched in, which is the
 *      work it was asked to do; and
 *   2. **the workspace** — `~/.aico/workspace/…` by default, or wherever
 *      `workspace.path` points.
 *
 * Everything else is refused. The point of the guard is that a path traversal
 * or a confidently-wrong absolute path cannot reach the rest of the filesystem;
 * the point is not that the agent has nowhere of its own to work.
 *
 * @module tools/path
 */

import path from 'path';
import { resolveWorkspaceRoot } from '../workspace.js';
import { getWorkspaceRuntime } from '../workspace.js';

/** Whether `target` is `parent` or sits beneath it. */
function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Roots a write may land in, most specific first.
 *
 * Resolved on each call rather than cached: the workspace root depends on
 * settings and on which session is running, both of which change within the
 * life of a process.
 */
export function writableRoots(cwd = path.resolve(process.cwd())): string[] {
  const roots = [path.resolve(cwd)];
  try {
    const runtime = getWorkspaceRuntime();
    const workspace = resolveWorkspaceRoot(runtime.settings, runtime.cwd ?? cwd);
    if (!roots.some(root => isInside(root, workspace))) roots.push(workspace);
  } catch {
    // No workspace configured yet — the project alone is still a valid root,
    // and refusing every write because the workspace could not be resolved
    // would be a worse failure than the one this guard exists to prevent.
  }
  return roots;
}

/**
 * Resolve a tool's path argument, refusing anything outside the writable roots.
 *
 * A relative path is resolved against the project, not the workspace: relative
 * paths in a coding session mean "in the code", and silently reinterpreting
 * `src/index.ts` as a workspace path would be far more surprising than an
 * error. Reaching the workspace is done with an absolute path, which is what
 * the workspace tools report.
 */
export function resolveInsideWorkspace(inputPath: string, label = 'path'): string {
  const cwd = path.resolve(process.cwd());
  const resolved = path.resolve(cwd, inputPath);
  const roots = writableRoots(cwd);

  if (roots.some(root => isInside(root, resolved))) return resolved;

  throw new Error(
    `${label} must stay inside the project or the AICO workspace.\n` +
    `  given:     ${inputPath}\n` +
    roots.map(root => `  allowed:   ${root}`).join('\n'),
  );
}
