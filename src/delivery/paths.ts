/**
 * Where delivery's task worktrees live, and the one question the tool pipeline asks
 * about them: "is this run working inside a task's worktree?"
 *
 * A leaf on purpose (it imports only `home` and `projectKey`): `agent.ts` asks it for
 * its in-loop guard, and the service that owns the board imports half the engine.
 *
 * It also names the dependency folders a worktree may share with the project
 * (`node_modules`, a Python venv, PHP `vendor`) and answers "is this one still a
 * link?", because the guard below refuses a package manager's install through a link:
 * an install would write into the person's own checkout, and into every other task.
 *
 * @module delivery/paths
 */

import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { projectKey } from '../learning/proposals.js';

/** `aicoHome()/worktrees/delivery`, beside (not inside) the other worktrees; never inside a repository. */
export function worktreesRoot(): string { return path.join(aicoHome(), 'worktrees', 'delivery'); }

export function worktreePath(project: string, id: string): string { return path.join(worktreesRoot(), projectKey(project), id); }

export const branchOf = (id: string): string => `aico/task-${id}`;

const real = (p: string): string => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/**
 * `dir` relative to the worktrees root, or undefined when it is outside. Compared as
 * given and again by real path: Windows reports one folder as `C:\Users\SUHAIL~1` or
 * `C:\Users\Suhail Akhtar`, and git prints it with forward slashes.
 */
export function relativeToWorktrees(dir: string): string | undefined {
  const inside = (root: string, d: string): string | undefined => {
    const rel = path.relative(root, d);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : undefined;
  };
  return inside(worktreesRoot(), path.resolve(dir)) ?? inside(real(worktreesRoot()), real(dir));
}

/** Whether a directory is inside any task's worktree (`<root>/<project key>/<task id>/…`). */
export function isDeliveryWorktree(dir: string): boolean {
  const rel = relativeToWorktrees(dir);
  return rel !== undefined && rel.split(/[\\/]/).length >= 2;
}

/** The task worktree a directory inside `<root>/<project key>/<task id>/…` belongs to (the directory itself when it is not in one). */
export function worktreeRootOf(dir: string): string {
  const rel = relativeToWorktrees(dir);
  const parts = rel ? rel.split(/[\\/]/) : [];
  return parts.length >= 2 ? path.join(worktreesRoot(), parts[0]!, parts[1]!) : dir;
}

type DepStack = 'node' | 'python' | 'php';

/** Dependency folders a task's worktree can share with the project by link, and the stack each belongs to. */
export const DEP_DIRS: ReadonlyArray<{ dir: string; stack: DepStack }> = [
  { dir: 'node_modules', stack: 'node' },
  { dir: '.venv', stack: 'python' },
  { dir: 'venv', stack: 'python' },
  { dir: 'vendor', stack: 'php' },
];

/** A symlink, or a Windows junction (Node reports both as symbolic links). */
export function isLink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** The dependency folders directly under `dir` that are links rather than real folders. */
export function linkedDeps(dir: string): Array<{ dir: string; stack: DepStack; path: string }> {
  return DEP_DIRS.filter(d => isLink(path.join(dir, d.dir))).map(d => ({ ...d, path: path.join(dir, d.dir) }));
}

/** Package-manager commands that write into the dependency folder of their stack. */
const INSTALLERS: ReadonlyArray<{ stack: DepStack; re: RegExp }> = [
  { stack: 'node', re: /\b(?:npm|pnpm|yarn|bun)\s+(?:--?[\w-]+(?:=\S+)?\s+)*(?:install|i|ci|add|remove|rm|uninstall|update|up|upgrade|rebuild|dedupe|link|prune)\b|\byarn\s*(?:$|[;&|])/ },
  { stack: 'python', re: /\b(?:pip3?|uv\s+pip|poetry|pipenv|pdm|hatch)\b[^;&|\n]*\b(?:install|uninstall|add|remove|update|sync|lock)\b|\bpython3?\s+-m\s+pip\b[^;&|\n]*\b(?:install|uninstall)\b/ },
  { stack: 'php', re: /\bcomposer\s+(?:--?[\w-]+\s+)*(?:install|update|require|remove|dump-autoload)\b/ },
];

/** A shell command that would move the trunk or leave the machine: refused for a task's run (ADR 0038). */
const FORBIDDEN_GIT = /\bgit\s+(?:(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?)\s+)*(?:push|pull|fetch|merge|switch|worktree|remote|clone)\b/;

/**
 * Why a tool call by a task's run is refused, or undefined. Deny-only (a guard never grants):
 * the run commits locally on its own branch; landing is the merge queue's and a person's.
 * `cwd` is where the call runs: a package-manager install is refused while that worktree's
 * dependency folder is still a link into the project's own (the Delivery tool's `localise`
 * action gives the worktree a private one).
 */
export function deliveryRunDenial(toolName: string, args: Record<string, unknown>, command: string | undefined, cwd?: string): string | undefined {
  if (toolName === 'Git') {
    const action = String(args.action ?? '');
    if (action === 'push' || action === 'pr') return `A delivery task's run never pushes or opens pull requests (git ${action}). Commit locally on this branch and submit with the Delivery tool.`;
  }
  if (command !== undefined && FORBIDDEN_GIT.test(command)) {
    return 'A delivery task\'s run works on its own branch in its own worktree: it does not push, pull, fetch, merge, switch branches or manage worktrees. Commit locally, then submit with the Delivery tool; the merge queue and a person land it.';
  }
  if (command !== undefined && cwd) {
    const linked = [...new Set([cwd, worktreeRootOf(cwd)])].flatMap(linkedDeps);
    for (const l of linked) {
      if (INSTALLERS.some(i => i.stack === l.stack && i.re.test(command))) {
        return `This worktree's ${l.dir} is a link to the project's own folder, shared by every task: installing through it would change the person's checkout. `
          + 'Call the Delivery tool with action "localise" to give this worktree a private one, then run the install again.';
      }
    }
  }
  return undefined;
}
