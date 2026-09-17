/**
 * Re-fetch providers and settings when this client regains focus.
 *
 * Each client — a browser tab, the VS Code sidebar panel, the workspace-page
 * tab — loads `defaultModel` and `settings` once, at its own startup
 * (`App.tsx` and the VS Code panel's boot effect). Changing the model in one
 * of them writes to disk but nothing tells the others: there is no
 * `hub.publish` for a settings change (see `server/api-system.ts`'s own
 * comment — these routes are meant to be polled, not subscribed to), so a
 * second open client just keeps showing what it loaded at startup until
 * something forces a re-fetch.
 *
 * The moment that actually matters is switching back to a client after
 * changing the model somewhere else, and `visibilitychange`/`focus` is
 * exactly that moment — cheaper than polling on a timer, and it fires
 * reliably in a VS Code webview (they implement the Page Visibility API) as
 * well as an ordinary browser tab.
 *
 * @module use-refresh-on-focus
 */
import { useEffect } from 'react';

export function useRefreshOnFocus(
  refreshProviders: () => Promise<void>,
  refreshSettings: () => Promise<void>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const refresh = (): void => { void refreshProviders(); void refreshSettings(); };
    const onVisible = (): void => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, refreshProviders, refreshSettings]);
}
