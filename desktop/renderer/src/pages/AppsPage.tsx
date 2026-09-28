/**
 * Apps — what the agent builds and runs for you. The Apps screen is the
 * engine's own (shared with the browser client), wrapped so a running app opens
 * in the built-in browser beside its chat.
 *
 * @module desktop/renderer/pages/AppsPage
 */

import React, { useEffect } from 'react';
import { AppsPane } from '@web/components/AppsPane';
import { useStore } from '@web/store';
import { go } from '@/state/desk';

export function AppsPage(): React.ReactElement {
  const connectApps = useStore(s => s.connectApps);
  useEffect(() => connectApps(), [connectApps]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <AppsPane onOpenChat={() => go('chat', { id: useStore.getState().sessionId })} />
    </div>
  );
}
