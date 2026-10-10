/**
 * The desktop's Delivery page: the shared board (web/components/delivery) with
 * the desktop's own hands.
 *
 * Route: `delivery` with an optional `path` (the project; the chat's project
 * when absent) and an optional `task` (open that task's drawer: the link from the
 * task's chat, see chat/ChatView). An agent's session opens as a desktop chat; a touched file
 * opens the Code map page on that file (Focus view). The calls that need a
 * person — start/pause the dispatcher, Approve and land, Request changes — go
 * through the window's own transport, where main attaches the one-time human
 * grant (electron/protocol.ts HUMAN_ROUTES), exactly like approving a parked
 * call in the inbox.
 *
 * @module desktop/renderer/pages/DeliveryPage
 */

import React, { useMemo } from 'react';
import { useStore } from '@web/store';
import { DeliveryView, type DeliveryHost } from '@web/components/delivery/DeliveryView';
import { relativeToProject } from '@web/components/delivery/DeliveryPage';
import { go, useDesk } from '@/state/desk';
import { openChat } from '@/chat/actions';
import { basename } from '@/lib/util';
import type { ViewProps } from '@/plugins/registry';

export function DeliveryPage({ params }: ViewProps): React.ReactElement {
  const fallback = useStore(s => s.project);
  const projects = useStore(s => s.projects);
  const path = params?.path || fallback || projects[0]?.path || '';
  const list = useMemo(() => projects.map(p => ({ path: p.path, name: p.name ?? basename(p.path) })), [projects]);

  const host = useMemo<DeliveryHost>(() => ({
    openSession: (id) => { void openChat(id); },
    openCodeMap: (file) => go('codemap', { path, ...(file ? { file: relativeToProject(path, file) } : {}) }),
    openConnections: () => useDesk.getState().openSettings('connections'),
  }), [path]);

  if (!path) {
    return <div className="flex flex-1 items-center justify-center text-aico-muted">Open a project to use Delivery.</div>;
  }
  return (
    <DeliveryView
      key={path}
      projectPath={path}
      projectName={list.find(p => p.path === path)?.name ?? basename(path)}
      host={host}
      projects={list}
      onProjectChange={(p) => go('delivery', { path: p })}
      openTaskId={params?.task}
    />
  );
}
