/**
 * The browser's own window (electron/browser-window.ts): the browser and
 * nothing else — tabs in the title bar, toolbar, bookmarks bar, the page, the
 * copilot docked or floating, the status line, the browser's own pages and
 * prompts — in the app's theme, with its tooltips and toasts.
 *
 * It is the same browser as the AICO window's Browser page: the same
 * components and the same stores, fed by the same events, which main sends
 * here while the browser is in this window. It shares the AICO window's
 * localStorage (same origin, same session), so the copilot's conversation and
 * look, the bookmarks bar's state and the composer's send options are the
 * AICO window's. What it does not have — settings, the main chat — it asks
 * the AICO window for.
 *
 * @module desktop/renderer/browser-main
 */

import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import '@/browser/browser.css';
import { useStore } from '@web/store';
import { invoke, on, platform } from './desktop';
import { useDesk } from './state/desk';
import { applyTheme } from './theme';
import { setSendOptions } from './chat/actions';
import { installBrowserStore, useActiveTab } from './browser/store';
import { installBrowserHost, markBrowserWindow } from './browser/host';
import { installCopilotRelay } from './browser/copilot-overlay';
import { isBlankUrl } from './browser/urls';
import { BrowserPane } from './ide/BrowserPane';
import { Toasts } from './shell/Toasts';
import { Tooltips } from './shell/Tooltips';

markBrowserWindow();
document.documentElement.dataset.platform = String(platform);
document.documentElement.classList.add('aico-browser-window');

function syncTheme(): void {
  const { prefs, setMode } = useDesk.getState();
  const mode = applyTheme(prefs, (m) => { setMode(m); syncOverlay(); });
  setMode(mode);
  syncOverlay();
}

/** The window's own controls sit on the tab strip: the same colour as it. */
function syncOverlay(): void {
  const css = getComputedStyle(document.documentElement);
  const color = css.getPropertyValue('--desk-sidebar').trim() || css.getPropertyValue('--aico-bg').trim();
  const symbolColor = css.getPropertyValue('--aico-text-primary').trim();
  if (color) void invoke('browser:window:overlay', { color, symbolColor }).catch(() => {});
}

function BrowserWindowApp(): React.ReactElement {
  const tab = useActiveTab();
  // The taskbar says which page this is, as a browser's window does.
  useEffect(() => {
    const title = tab && !isBlankUrl(tab.url) ? tab.title || tab.url : '';
    document.title = title ? `${title} — AICO Browser` : 'AICO Browser';
  }, [tab?.title, tab?.url]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex h-full w-full flex-col bg-aico-bg">
      <BrowserPane />
      <Toasts />
      <Tooltips />
    </div>
  );
}

async function boot(): Promise<void> {
  await useDesk.getState().loadPrefs();
  syncTheme();
  useDesk.subscribe((s, prev) => { if (s.prefs !== prev.prefs) syncTheme(); });
  on('prefs:changed', (p) => useDesk.setState({ prefs: p as never }));
  // The browser is always on screen here: what asks "is the browser open?" hears yes.
  useDesk.setState({ route: { view: 'browser' } });
  // Settings live in the AICO window: "Manage autofill…" and the like open them there.
  useDesk.subscribe((s, prev) => {
    if (!s.settings || s.settings === prev.settings) return;
    void invoke('browser:window:showMain', { settings: s.settings }).catch(() => {});
    useDesk.setState({ settings: null });
  });
  // Approval and effort follow what the main composer last chose.
  window.addEventListener('storage', (e) => {
    if (e.key !== 'desk.sendOptions' || !e.newValue) return;
    try { setSendOptions(JSON.parse(e.newValue)); } catch { /* keep the current options */ }
  });
  installBrowserStore();
  installBrowserHost();
  installCopilotRelay();
  // The copilot's new chats need the folders.
  const st = useStore.getState();
  void Promise.resolve().then(() => st.refreshProjects()).catch(() => {});
  void Promise.resolve().then(() => st.refreshSessions()).catch(() => {});
  createRoot(document.getElementById('root')!).render(<BrowserWindowApp />);
}

void boot();
