/**
 * The updater as the interface sees it: the latest state from main (for
 * Settings → Application → Updates) and, wherever you are in the app, a toast
 * with Restart when a new version has downloaded.
 *
 * Restart goes through `updates:install`, which checks for running work first
 * and asks before stopping it (see electron/updater.ts).
 *
 * @module desktop/renderer/updates
 */

import { create } from 'zustand';
import type { UpdateState } from '@desk/updates';
import { desktop, isDesktop } from '@/desktop';
import { useDesk } from '@/state/desk';

export const useUpdates = create<{ state: UpdateState | null }>(() => ({ state: null }));

let toastedVersion: string | null = null;

function apply(s: UpdateState): void {
  useUpdates.setState({ state: s });
  if (s.status === 'ready' && s.version && toastedVersion !== s.version) {
    toastedVersion = s.version;
    useDesk.getState().toast({
      kind: 'info',
      title: `AICO ${s.version} is ready`,
      body: 'Restart to update. If a reply or an agent is still running you can wait for it.',
      action: { label: 'Restart', run: () => { void desktop.updates.install(); } },
      ttl: 0,
    });
  }
}

export function installUpdateListener(): void {
  if (!isDesktop) return;
  void desktop.updates.state().then(apply).catch(() => {});
  desktop.updates.onState(apply);
}
