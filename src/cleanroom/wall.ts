/**
 * The wall around the implementer (ADR 0041, "The firewall is now a wall").
 *
 * The first version of the spec firewall only controlled what the implementer
 * was *given*; the agent still had a shell, and a shell reads anything the user
 * can. This makes the separation hold against an agent that goes looking, in
 * three layers that do not depend on the model behaving:
 *
 *  1. **Tools.** A clean-room workspace is marked by `.cleanroom-workspace`
 *     in its root. In a marked folder this deny-only guard (ADR 0002) refuses
 *     every tool except the file tools, a task list and `CloneRun`. No shell,
 *     no web fetch or search, no browser, no MCP, no delegation.
 *  2. **Paths.** The file tools may read anywhere inside the workspace and
 *     write only inside `clone/`; a path is resolved through symlinks before
 *     it is judged, so a link out of the folder is not a way out. `spec/` is
 *     read-only: the implementer cannot edit the description it was given.
 *  3. **Code it writes and runs.** `CloneRun` (tools/clone-run) starts the
 *     clone under Node's permission model: filesystem reads and writes are
 *     limited to `clone/`, and no child process, worker or addon can be
 *     started. A script that tries to read the corpus gets ERR_ACCESS_DENIED.
 *
 * What it does not do, said plainly: Node's permission model does not restrict
 * the network, so clone code could still open a connection. It has no address
 * to open, because the spec never names the target (implementer.ts), but this
 * is not a network sandbox. And the marker is a restriction only: planting it
 * in a folder narrows what an agent there can do, it never widens anything.
 *
 * @module cleanroom/wall
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolPipeline } from '../tools/pipeline.js';

export const WORKSPACE_MARKER = '.cleanroom-workspace';

/** The tools an implementer may use. Anything else is refused by name. */
export const WALL_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'Pwd', 'TodoWrite', 'TodoRead', 'LoadTools', 'CloneRun']);

const READ_ARG: Record<string, string> = { Read: 'file_path', Glob: 'path', Grep: 'path', LS: 'path' };
const WRITE_ARG: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path' };

export function isWorkspace(root: string): boolean {
  try { return fs.statSync(path.join(root, WORKSPACE_MARKER)).isFile(); } catch { return false; }
}

/** The path with symlinks resolved as far as it exists; a path that does not exist yet is judged by its nearest real parent. */
export function realish(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch { /* not there yet */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    tail.push(path.basename(cur));
    cur = parent;
  }
}

function inside(root: string, p: string): boolean {
  const r = path.relative(realish(root), realish(p));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/** Why a call is refused in a clean-room workspace, or undefined when it is allowed. */
export function wallRefusal(root: string, name: string, args: Record<string, unknown> | undefined, cwd: string): string | undefined {
  if (!WALL_TOOLS.has(name)) {
    return `${name} is not available here. This is a clean-room workspace: the clone is built from spec/ alone, with the file tools and CloneRun. There is no shell, web or other tool by design.`;
  }
  const a = args ?? {};
  const base = path.resolve(root);
  const readKey = READ_ARG[name];
  if (readKey) {
    const target = typeof a[readKey] === 'string' && (a[readKey] as string).trim() ? path.resolve(cwd, a[readKey] as string) : base;
    if (!inside(base, target)) return `${name} may only look inside this workspace (${base}); ${a[readKey]} is outside it.`;
    const pattern = typeof a.pattern === 'string' ? a.pattern : '';
    if (name === 'Glob' && (path.isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.replace(/\\/g, '/').split('/').includes('..'))) return 'A Glob pattern here stays inside the workspace: no absolute path and no "..".';
  }
  const writeKey = WRITE_ARG[name];
  if (writeKey) {
    const raw = a[writeKey];
    if (typeof raw !== 'string' || !raw.trim()) return `${name} needs "${writeKey}" so the clean-room wall can check where it writes.`;
    const target = path.resolve(cwd, raw);
    const cloneDir = path.join(base, 'clone');
    if (!inside(cloneDir, target)) return `${name} may only write inside clone/ (${cloneDir}). spec/ is the description you were given and is read-only; ${raw} is not in clone/.`;
  }
  return undefined;
}

/** Install the guard. It abstains everywhere that is not a marked workspace, and only ever denies. */
export function installCleanroomWall(pipeline: ToolPipeline, cwd: () => string, rootOf: () => string = cwd): () => void {
  return pipeline.onGuard('cleanroom-wall', (ctx) => {
    const root = rootOf();
    if (!isWorkspace(root)) return { kind: 'abstain' };
    const why = wallRefusal(root, ctx.name, ctx.arguments as Record<string, unknown> | undefined, cwd());
    return why ? { kind: 'deny', reason: why } : { kind: 'abstain' };
  });
}

/** The flags that confine a Node child to one folder, for this Node. Undefined when this Node cannot confine it. */
export function permissionFlags(dir: string, nodeVersion = process.versions.node): string[] | undefined {
  const [maj, min] = nodeVersion.split('.').map(Number) as [number, number];
  const real = realish(dir);
  // `--permission` is the stable name from 22.13 / 23.5; `--experimental-permission` before it, from 20.
  const stable = maj > 23 || (maj === 23 && min >= 5) || (maj === 22 && min >= 13);
  const flag = stable ? '--permission' : (maj >= 20 ? '--experimental-permission' : undefined);
  if (!flag) return undefined;
  return [flag, `--allow-fs-read=${real}`, `--allow-fs-write=${real}`];
}
