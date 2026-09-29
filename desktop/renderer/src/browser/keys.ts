/**
 * The browser's keyboard shortcuts — the ones every browser has.
 *
 * `browserShortcut` maps a key press to an action name (pure, unit-tested);
 * `useBrowserKeys` runs the action while the full-size browser is on screen,
 * ahead of the app-wide shortcuts that share some of the same keys (Ctrl+L,
 * Ctrl+J, Alt+←) and mean something else elsewhere.
 *
 * Key presses inside the page itself go to the page, not here; main forwards
 * the ones every browser reserves (browser-keys.ts) as `browser:shortcut`.
 *
 * Tabs: Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PgUp / Ctrl+PgDn cycle, Ctrl+1…8 pick,
 * Ctrl+9 is the last tab, Ctrl+Shift+PgUp/PgDn move the tab, Ctrl+Shift+T
 * reopens the last closed one. F11 is full screen, Shift+F11 full view.
 * Ctrl+Shift+N opens the browser in its own window (and, there, moves it back).
 *
 * Also here: the right-click menu's "Ask AICO …" items (`browser:ask`), which
 * start a question in the copilot.
 *
 * @module desktop/renderer/browser/keys
 */

import { useEffect } from 'react';
import { on } from '@/desktop';
import { useDesk } from '@/state/desk';
import { useOverlays } from '@/lib/overlay';
import { call, fire } from './ipc';
import {
  closeFind, closeTab, cycleTab, newTab, openFind, showInternal, useBrowser, activeTab,
} from './store';
import { prefillCopilot, toggleCopilot } from './copilot-ui';
import { askCopilot } from './Copilot';
import { installFullView, setFullView, toggleFullscreen, toggleFullView, useFullView } from './fullview';
import { moveTarget, tabForDigit } from './tabs';
import { toast } from '@/state/desk';
import { bookmarkAllTabs, bookmarkTab, toggleBar } from './bookmarks';
import { browserShortcut, parseShortcut, type BrowserAction } from './shortcuts';
import { inBrowserWindow, toggleBrowserWindow } from './host';

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
    case 'bookmark': void bookmarkTab(); return true;
    case 'bookmarksBar': toggleBar(); return true;
    case 'bookmarkAll': bookmarkAllTabs(); return true;
    case 'bookmarkManager': showInternal(s.internal?.page === 'bookmarks' ? null : 'bookmarks'); return true;
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
    case 'reopenTab': fire('browser:reopenClosed'); return true;
    // The browser's own window is all browser already: Shift+F11 there is full screen.
    case 'fullView': if (inBrowserWindow()) toggleFullscreen(); else toggleFullView(); return true;
    case 'fullscreen': toggleFullscreen(); return true;
    case 'popOut': toggleBrowserWindow(); return true;
    case 'savePage':
      void call<string | null>('browser:savePage').then((p) => { if (p) toast.success('Page saved', p); }).catch((e: Error) => toast.error('Could not save the page', e.message));
      return true;
    case 'viewSource': fire('browser:viewSource'); return true;
    case 'moveTabLeft': case 'moveTabRight': {
      const to = moveTarget(s.state.tabs, s.state.activeId, a === 'moveTabLeft' ? -1 : 1);
      if (to !== null && s.state.activeId) fire('browser:move', s.state.activeId, to);
      return true;
    }
    case 'tab1': case 'tab2': case 'tab3': case 'tab4': case 'tab5': case 'tab6': case 'tab7': case 'tab8': case 'tab9': {
      const id = tabForDigit(s.state.tabs.map(t => t.id), Number(a.slice(3)));
      if (id && id !== s.state.activeId) fire('browser:select', id);
      return true;
    }
    case 'escape': {
      if (s.find.open) { closeFind(); return true; }
      if (s.internal) { showInternal(null); return true; }
      if (s.reader) { useBrowser.setState({ reader: null }); return true; }
      if (activeTab(s)?.loading) { fire('browser:stop'); return true; }
      if (useFullView.getState().on) { setFullView(false); return true; }
      return false;
    }
  }
}

let askInstalled = false;

/** "Ask AICO about …" from the page's right-click menu: straight to the copilot, or into its box to finish. */
function installAsk(): void {
  if (askInstalled) return;
  askInstalled = true;
  on<{ text?: string; send?: boolean }>('browser:ask', (a) => {
    const text = String(a?.text ?? '').trim();
    if (!text) return;
    if (a.send) { toggleCopilot(true); void askCopilot(text).catch((e: Error) => toast.error('Could not ask AICO', e.message)); }
    else prefillCopilot(`${text}

`);
  });
}

export function useBrowserKeys(enabled: boolean): void {
  useEffect(() => { installAsk(); installFullView(); }, []);
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
