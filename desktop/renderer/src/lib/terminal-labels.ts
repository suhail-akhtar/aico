/**
 * Which project a terminal is in, as a label a person recognises.
 *
 * WHY. After switching chats people typed into a shell that was still in the
 * previous project. A tab now shows the project it runs in (the innermost
 * known project containing its directory), and a chat with no project says
 * "Scratch workspace" instead of a temp-looking path under AICO's store.
 *
 * Pure (no React), so the desktop test can check it.
 *
 * @module desktop/renderer/lib/terminal-labels
 */

import { pathKey } from './project-paths';

export interface ProjectLike { path: string; name?: string; isWorkspace?: boolean }

export interface Place {
  /** Short name for the chip. */
  label: string;
  /** The project's path when the directory is inside one. */
  project?: string;
  scratch: boolean;
}

const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** The innermost project containing `cwd`, or the folder's own name. */
export function placeOf(cwd: string | null | undefined, projects: readonly ProjectLike[]): Place {
  if (!cwd) return { label: 'Scratch workspace', scratch: true };
  const k = pathKey(cwd);
  let best: ProjectLike | undefined;
  for (const p of projects) {
    const pk = pathKey(p.path);
    if ((k === pk || k.startsWith(`${pk}/`)) && (!best || pk.length > pathKey(best.path).length)) best = p;
  }
  if (!best) return { label: base(cwd), scratch: false };
  if (best.isWorkspace) return { label: 'Scratch workspace', project: best.path, scratch: true };
  return { label: best.name || base(best.path), project: best.path, scratch: false };
}

/** The place new terminals should open in for the active chat. */
export function activePlace(project: string | null | undefined, projects: readonly ProjectLike[]): Place & { path: string | null } {
  const ws = projects.find(p => p.isWorkspace);
  const path = project ?? ws?.path ?? null;
  return { ...placeOf(path, projects), path };
}

/** Whether a tab already sits in this place. */
export function tabInPlace(tabCwd: string, place: { path: string | null }): boolean {
  if (!place.path) return false;
  const a = pathKey(tabCwd);
  const b = pathKey(place.path);
  return a === b || a.startsWith(`${b}/`);
}
