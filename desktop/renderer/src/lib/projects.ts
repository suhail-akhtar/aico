/**
 * One folder, one project.
 *
 * On Windows the engine can hold the same folder twice under two spellings —
 * `E:\repo` from one client, `e:\repo` from VS Code (which lower-cases the
 * drive) — and the interface drew two identical projects with the same chats
 * under both. Until the engine merges them, the desktop treats paths that
 * differ only in case as one folder when they are Windows paths (drive-letter
 * or UNC), and never on Linux, where case is significant.
 *
 * @module desktop/renderer/lib/projects
 */

import { useMemo } from 'react';
import { useStore } from '@web/store';
import type { Project } from '@web/api';

import { uniqueProjects } from './project-paths';

export { pathKey, samePath, uniqueProjects } from './project-paths';

export function useProjects(): Project[] {
  const projects = useStore(s => s.projects);
  return useMemo(() => uniqueProjects(projects), [projects]);
}
