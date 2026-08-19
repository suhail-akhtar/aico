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
import { currentCwd } from '../run-context.js';
import os from 'os';
import { resolveWorkspaceRoot } from '../workspace.js';
import { getBuiltinDir } from '../skills/loader.js';
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
export function writableRoots(cwd = currentCwd()): string[] {
  const roots = [path.resolve(cwd)];

  // Skills the user installed and the agent authors. Watched live: the
  // orchestrator wrote a skill, ran its script, found a bug in it, was refused
  // an Edit — and then rewrote the identical file with Bash and python. Four
  // extra calls, the same result, and the change no longer visible as a diff.
  //
  // A rule Bash walks straight through is not a boundary, it is friction, and
  // this one bought nothing: SkillCreate already replaces any skill by name. So
  // the tools that show their work are allowed to do what the shell could do
  // regardless. Built-in skills stay out — those ship with AICO and are
  // readable only, which is the asymmetry actually worth keeping.
  roots.push(path.join(os.homedir(), '.aico', 'skills'));

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
 * Roots a *read* may reach, which is a longer list than the writable one.
 *
 * A skill can ship references and scripts, and its whole purpose is to tell the
 * agent to read them — `read references/tone.md before writing the summary`.
 * Those files live in `~/.aico/skills`, outside the project, so `Read` refused
 * them and the skill's own instruction could not be followed. Watched live: the
 * agent fell back to `cat` through Bash, which worked by luck and would not
 * have on a machine without it.
 *
 * Used by every tool that only looks — Read, LS, Glob, Grep. Fixing Read alone
 * was the obvious half-measure and it showed up within one turn: the
 * orchestrator created a skill, ran LS on the directory it had just been told
 * it owned, and was refused. A boundary that four tools disagree about is not a
 * boundary, it is a lottery.
 *
 * The one thing readable adds over writable is the **built-in** skills, which
 * ship inside the install and are nobody's to edit. That is the asymmetry worth
 * keeping: a procedure you installed is yours to change, and a procedure that
 * came with the program is yours to read.
 */
export function readableRoots(cwd = currentCwd()): string[] {
  const roots = writableRoots(cwd);
  const builtin = getBuiltinDir();
  if (!roots.some(root => isInside(root, builtin))) roots.push(builtin);
  return roots;
}

/**
 * Resolve a path a tool intends to read.
 *
 * Separate from the write path so widening one never widens the other.
 */
export function resolveForReading(inputPath: string, label = 'path'): string {
  const cwd = currentCwd();
  const resolved = path.resolve(cwd, inputPath);
  const roots = readableRoots(cwd);

  if (roots.some(root => isInside(root, resolved))) return resolved;

  throw new Error(
    `${label} must stay inside the project, the AICO workspace, or the skills directories.\n` +
    `  given:     ${inputPath}\n` +
    roots.map(root => `  allowed:   ${root}`).join('\n'),
  );
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
  const cwd = currentCwd();
  const resolved = path.resolve(cwd, inputPath);
  const roots = writableRoots(cwd);

  if (roots.some(root => isInside(root, resolved))) return resolved;

  throw new Error(
    `${label} must stay inside the project or the AICO workspace.\n` +
    `  given:     ${inputPath}\n` +
    roots.map(root => `  allowed:   ${root}`).join('\n'),
  );
}
