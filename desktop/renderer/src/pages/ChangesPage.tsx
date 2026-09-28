/**
 * A chat's changes (every file it touched, with diffs and revert) and its
 * trajectory (every step, tool call and timing) — the engine's own review
 * panes, opened for the chat named in the route.
 *
 * @module desktop/renderer/pages/ChangesPage
 */

import React, { useEffect } from 'react';
import { ChangesPane } from '@web/components/ChangesPane';
import { Trajectory } from '@web/components/Trajectory';
import { useStore } from '@web/store';
import type { ViewProps } from '@/plugins/registry';

function useChat(id?: string): void {
  const sessionId = useStore(s => s.sessionId);
  const openSession = useStore(s => s.openSession);
  useEffect(() => { if (id && id !== sessionId) void openSession(id); }, [id, sessionId, openSession]);
}

export function ChangesPage({ params }: ViewProps): React.ReactElement {
  useChat(params?.id);
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><ChangesPane /></div>;
}

export function TrajectoryPage({ params }: ViewProps): React.ReactElement {
  useChat(params?.id);
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><Trajectory /></div>;
}
