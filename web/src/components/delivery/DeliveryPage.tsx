/**
 * The Delivery destination in the browser portal: picks the project and wires
 * the board's two host actions to this client's navigation.
 *
 * Project: the link's `path` if it named one, else the open chat's project,
 * else the first registered one — the same fallback the Code map uses. An
 * agent's session opens in the Chat tab; the Code map opens through the same
 * `aico:navigate` event the morning brief uses, so the workspace page's map is
 * reached by one route rather than a second implementation. A file with no
 * mode lands in the Focus view (CodeGraphView refocuses on it), which is what
 * "show me this task's file" wants.
 *
 * The desktop has its own page (desktop/renderer/pages/DeliveryPage) with its
 * own navigation; both render {@link DeliveryView}.
 *
 * @module web/components/delivery/DeliveryPage
 */

import React, { useMemo } from 'react';
import { useStore } from '../../store';
import { basename } from '../../grouping';
import { DeliveryView, type DeliveryHost } from './DeliveryView';

/** A path the Code map can match: relative to the project, forward slashes. */
export function relativeToProject(project: string, file: string): string {
  const f = file.replace(/\\/g, '/');
  const p = project.replace(/\\/g, '/').replace(/\/+$/, '');
  return f.toLowerCase().startsWith(`${p.toLowerCase()}/`) ? f.slice(p.length + 1) : f;
}

export function DeliveryPage({ projectPath, onProject, onOpenChat }: {
  projectPath?: string | undefined;
  onProject: (path: string) => void;
  onOpenChat: () => void;
}): React.ReactElement {
  const projects = useStore(s => s.projects);
  const current = useStore(s => s.project);
  const openSession = useStore(s => s.openSession);
  const path = projectPath ?? current ?? projects[0]?.path ?? '';
  const list = useMemo(() => projects.map(p => ({ path: p.path, name: p.name ?? basename(p.path) })), [projects]);

  const host = useMemo<DeliveryHost>(() => ({
    openSession: (id) => { void openSession(id).then(onOpenChat); },
    openCodeMap: (file) => window.dispatchEvent(new CustomEvent('aico:navigate', {
      detail: { destination: 'project', projectPath: path, codemap: file ? { file: relativeToProject(path, file) } : {} },
    })),
  }), [openSession, onOpenChat, path]);

  if (!path) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[14px] text-aico-secondary">
        Open a project to use Delivery: it is a board of tasks for one project&rsquo;s code.
      </div>
    );
  }
  return (
    <DeliveryView
      key={path}
      projectPath={path}
      projectName={list.find(p => p.path === path)?.name ?? basename(path)}
      host={host}
      projects={list}
      onProjectChange={onProject}
    />
  );
}
