/**
 * Boot: theme first (so the first frame is the right colour), then plugins,
 * then the engine connection — the interface shows at once with a loading
 * gate over it, and the shared store connects the moment the engine answers.
 *
 * @module desktop/renderer/main
 */

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { useStore } from '@web/store';
import { App } from './App';
import { desktop, isDesktop, on, platform } from './desktop';
import { useDesk } from './state/desk';
import { applyTheme } from './theme';
import { registerBuiltins } from './plugins/builtins';
import { watchUserPlugins, runCommand } from './plugins/registry';
import { installActionRunner } from './plugins/run-action';
import { installNotifications } from './notifications';
import { installRendererBridge } from './bridge';
import { installUpdateListener } from './updates';
import { installChatRouteSync } from './chat/actions';
import { installCanvasHost } from '@web/canvas-host';
import { setScriptedHtmlFrame } from '@aico/shared/ui/HtmlPreview';
import { CanvasCode, useCanvasPanel } from './chat/CanvasPanel';
import { installBrowserStore } from './browser/store';
import { installBrowserLinks } from './browser/links';
import { installBrowserHost } from './browser/host';
import { installCopilotRelay } from './browser/copilot-overlay';
import { installHandOffToasts } from './browser/handoff-toasts';

document.documentElement.dataset.platform = String(platform);

function syncTheme(): void {
  const { prefs, setMode } = useDesk.getState();
  const mode = applyTheme(prefs, (m) => { setMode(m); syncOverlay(); });
  setMode(mode);
  syncOverlay();
}

function syncOverlay(): void {
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--desk-sidebar').trim() || css.getPropertyValue('--aico-bg').trim();
  const fg = css.getPropertyValue('--aico-text-primary').trim();
  if (isDesktop && bg) void desktop.win.setOverlay(bg, fg);
}

function Root(): React.ReactElement {
  const [ready, setReady] = useState(false);
  const connected = React.useRef(false);

  useEffect(() => {
    const start = (): void => {
      setReady(true);
      if (connected.current) {
        // The engine restarted: reconnect the stream and refresh everything.
        useStore.getState().resume();
      } else {
        connected.current = true;
        const st = useStore.getState();
        st.newSession();
      }
      const st = useStore.getState();
      void st.refreshSessions();
      void st.refreshProviders();
      void st.refreshSettings();
      void st.refreshProjects();
      void st.refreshGroups();
      void st.refreshSystem();
    };
    if (!isDesktop) { start(); return; }
    void desktop.engine.status().then(s => { useDesk.setState({ engine: s }); if (s.status === 'ready') start(); });
    return desktop.engine.onStatus((s) => {
      useDesk.setState({ engine: s });
      if (s.status === 'ready') start();
      else setReady(false);
    });
  }, []);

  // Keep the lists fresh while the window is in use.
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => { void useStore.getState().refreshSessions(); }, 15_000);
    const onFocus = (): void => { void useStore.getState().refreshSessions(); void useStore.getState().refreshProviders(); };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [ready]);

  return <App engineReady={ready} />;
}

async function boot(): Promise<void> {
  await useDesk.getState().loadPrefs();
  syncTheme();
  useDesk.subscribe((s, prev) => { if (s.prefs !== prev.prefs) syncTheme(); });
  if (isDesktop) {
    try { useDesk.setState({ info: await desktop.info() }); } catch { /* shown as unknown */ }
  }
  installActionRunner();
  registerBuiltins();
  watchUserPlugins();
  installNotifications();
  installRendererBridge();
  installUpdateListener();
  installChatRouteSync();
  // The browser's prompts (permissions, dialogs, hand-overs) are heard even while it is not on screen.
  if (isDesktop) installBrowserStore();
  // Where the browser is (here, or popped out into its own window), and "open in main chat" from it.
  if (isDesktop) { installBrowserHost(); installCopilotRelay(); }
  // Work the browser copilot hands to a chat: a toast with Open, wherever the copilot is.
  if (isDesktop) installHandOffToasts();
  installBrowserLinks();
  // Canvases open beside the chat here, and code canvases get Monaco.
  installCanvasHost({ openPanel: ref => useCanvasPanel.getState().show(ref), CodeEditor: CanvasCode });
  // A ```html block with "scripts" ticked runs from its own origin (aico://preview, ADR 0020);
  // in a srcdoc frame this window's CSP refuses its inline scripts.
  if (isDesktop) setScriptedHtmlFrame(html => desktop.preview.register({ html }).then(r => r.url));
  desktop.onCommand((cmd) => { if (!runCommand(cmd.id, cmd.args)) console.warn('Unknown command', cmd.id); });
  // Buttons inside widgets (the kit's action row) ask through window events.
  window.addEventListener('aico:ask', (e) => {
    const d = (e as CustomEvent<{ text?: string; send?: boolean }>).detail ?? {};
    if (!d.text) return;
    if (d.send) void useStore.getState().submit(d.text);
    else useStore.getState().prefillComposer(d.text);
  });
  window.addEventListener('aico:open-view', (e) => {
    const id = (e as CustomEvent<{ id?: string }>).detail?.id;
    if (id) useDesk.getState().navigate({ view: id });
  });

  on('prefs:changed', (p) => useDesk.setState({ prefs: p as never }));

  document.getElementById('boot')?.remove();
  createRoot(document.getElementById('root')!).render(<Root />);
}

void boot();
