/**
 * The browser's keyboard shortcuts — the ones every browser has.
 *
 * `browserShortcut` maps a key press to an action name (pure, unit-tested);
 * `useBrowserKeys` runs the action while the full-size browser is on screen,
 * ahead of the app-wide shortcuts that share some of the same keys (Ctrl+L,
 * Ctrl+J, Alt+←) and mean something else elsewhere.
 *
 * Key presses inside the page itself go to the page, not here; main forwards
 * the ones it catches (Ctrl+L today) as events.
 *
 * @module desktop/renderer/browser/keys
 */

import { useEffect } from 'react';
import { on } from '@/desktop';
import { useDesk } from '@/state/desk';
import { useOverlays } from '@/lib/overlay';
import { fire } from './ipc';
import {
  closeFind, closeTab, cycleTab, newTab, openFind, showInternal, toggleBookmark, useBrowser, activeTab,
} from './store';
import { toggleCopilot } from './copilot-ui';
import { browserShortcut, parseShortcut, type BrowserAction } from './shortcuts';

export { browserShortcut, parseShortcut, type BrowserAction };

export function runBrowserAction(a: BrowserAction): boolean {
  const s = useBrowser.getState();
  switch (a) {
    case 'newTab': newTab(); return true;
    case 'closeTab': closeTab(); return true;
    case 'nextTab': cycleTab(1); return true;
    case 'prevTab': cycleTab(-1); return true;
    case 'focusAddress': useBrowser.setState({ focusOmnibox: s.focusOmnibox + 1 }); return true;
    case 'reload': case 'hardReload': fire('browser:reload'); return true;
    case 'find': openFind(); return true;
    case 'bookmark': void toggleBookmark(); return true;
    case 'history': showInternal(s.internal?.page === 'history' ? null : 'history'); return true;
    case 'downloads': useBrowser.setState({ downloadsOpen: !s.downloadsOpen }); return true;
    case 'zoomIn': fire('browser:zoom', 0.1); return true;
    case 'zoomOut': fire('browser:zoom', -0.1); return true;
    case 'zoomReset': fire('browser:zoom', 0); return true;
    case 'back': fire('browser:back'); return true;
    case 'forward': fire('browser:forward'); return true;
    case 'print': fire('browser:print'); return true;
    case 'devtools': fire('browser:devtools'); return true;
    case 'copilot': toggleCopilot(); return true;
    case 'escape': {
      if (s.find.open) { closeFind(); return true; }
      if (s.internal) { showInternal(null); return true; }
      if (s.reader) { useBrowser.setState({ reader: null }); return true; }
      if (activeTab(s)?.loading) { fire('browser:stop'); return true; }
      return false;
    }
  }
}

export function useBrowserKeys(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const mac = navigator.platform.toLowerCase().includes('mac');
    const onKey = (e: KeyboardEvent): void => {
      const d = useDesk.getState();
      if (d.settings !== null || d.paletteOpen || d.searchOpen) return;
      const action = browserShortcut(e, mac);
      if (!action) return;
      // Esc belongs to whatever is open (a menu, a dialog, a text box) before it belongs to the page.
      if (action === 'escape') {
        if (useOverlays.getState().count > 0) return;
        const t = e.target as HTMLElement | null;
        if (t?.closest('input, textarea, [contenteditable="true"], [role="dialog"], [role="alertdialog"]')) return;
      }
      if (runBrowserAction(action)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    // Shortcuts main caught while the page had focus, when it forwards them.
    const off = on<{ key?: string } | string>('browser:shortcut', (p) => {
      const spec = typeof p === 'string' ? p : p?.key;
      if (!spec) return;
      const action = browserShortcut(parseShortcut(spec), false);
      if (action) runBrowserAction(action);
    });
    return () => { window.removeEventListener('keydown', onKey, true); off(); };
  }, [enabled]);
}
