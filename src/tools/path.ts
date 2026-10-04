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

import fs from 'fs';
import path from 'path';
import { currentCwd } from '../run-context.js';
import { aicoHome } from '../home.js';
import { resolveWorkspaceRoot } from '../workspace.js';
import { getBuiltinDir } from '../skills/loader.js';
import { getWorkspaceRuntime } from '../workspace.js';

/** Whether `target` is `parent` or sits beneath it. */
function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Where `p` really is on disk: symlinks and junctions in every existing part
 * of it resolved. For a path that does not exist yet (a new file), the nearest
 * existing ancestor is resolved and the rest appended.
 *
 * WHY: the containment check was lexical only, so a symlink or junction inside
 * the project pointing outside it let Read, Write and Edit reach anything
 * through `link/...` (security review 2026-10). The check now holds for the
 * real location as well as the written one.
 */
function realLocation(p: string): string {
  let head = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...rest);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** Inside one of `roots` both as written and where it really is on disk. */
function insideRoots(roots: string[], resolved: string): boolean {
  if (!roots.some(root => isInside(root, resolved))) return false;
  const real = realLocation(resolved);
  return roots.some(root => isInside(realLocation(root), real));
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
  roots.push(path.join(aicoHome(), 'skills'));

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
 * The argument every path-resolving tool depends on, checked once.
 *
 * `path.resolve()` and `path.join()` throw `The "paths[1]" argument must be
 * of type string. Received undefined` when a caller's value is missing — a
 * message that names a Node internal, not the tool argument a person or model
 * can actually see. A model that sent a malformed call (a missing `file_path`,
 * or the field under a different key) read that error, could not connect it
 * to what it had just sent, and spent several turns retrying variations of
 * the same call before giving up and going around the tool with `Bash`. This
 * says what is actually wrong, in the tool's own terms, on the first try.
 */
function requireStringPath(inputPath: unknown, label: string): asserts inputPath is string {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new Error(
      `${label} is required and must be a non-empty string; received `
      + `${inputPath === undefined ? 'nothing' : JSON.stringify(inputPath)}.`,
    );
  }
}

/**
 * Resolve a path a tool intends to read.
 *
 * Separate from the write path so widening one never widens the other.
 */
export function resolveForReading(inputPath: string, label = 'path'): string {
  requireStringPath(inputPath, label);
  const cwd = currentCwd();
  const resolved = path.resolve(cwd, inputPath);
  const roots = readableRoots(cwd);

  if (insideRoots(roots, resolved)) return resolved;

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
  requireStringPath(inputPath, label);
  const cwd = currentCwd();
  const resolved = path.resolve(cwd, inputPath);
  const roots = writableRoots(cwd);

  if (insideRoots(roots, resolved)) return resolved;

  throw new Error(
    `${label} must stay inside the project or the AICO workspace.\n` +
    `  given:     ${inputPath}\n` +
    roots.map(root => `  allowed:   ${root}`).join('\n'),
  );
}
