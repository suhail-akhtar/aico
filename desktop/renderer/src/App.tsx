/**
 * The window: sidebar, top bar, the current view (with an optional side dock
 * and bottom panel), and the overlays — settings, palette, search, toasts —
 * behind the engine's loading gate.
 *
 * @module desktop/renderer/App
 */

import React, { Suspense, useEffect } from 'react';
import { useStore } from '@web/store';
import { useDesk } from '@/state/desk';
import { resolveView, useRegistry, commandsNow } from '@/plugins/registry';
import { PluginView } from '@/plugins/PluginView';
import { Sidebar } from '@/shell/Sidebar';
import { TopBar } from '@/shell/TopBar';
import { EngineGate } from '@/shell/EngineGate';
import { CommandPalette } from '@/shell/CommandPalette';
import { SearchDialog } from '@/shell/SearchDialog';
import { Tooltips } from './shell/Tooltips';
import { Toasts } from '@/shell/Toasts';
import { SettingsModal } from '@/settings/SettingsModal';
import { ImportWizard } from '@/browser/ImportWizard';
import { BottomPanel } from '@/shell/BottomPanel';
import { Dock } from '@/shell/Dock';
import { StatusBar } from '@/shell/StatusBar';
import { matchesKey } from '@/lib/util';
import { Icon } from '@/lib/icons';
import { useFullView } from '@/browser/fullview';

export function App({ engineReady }: { engineReady: boolean }): React.ReactElement {
  const collapsed = useDesk(s => s.prefs.sidebar.collapsed);
  const panel = useDesk(s => s.panel);
  const dock = useDesk(s => s.dock);
  const onBrowserPage = useDesk(s => s.route.view === 'browser');
  // The browser's full view: the page and its tabs fill the window (browser/fullview.ts).
  const fullView = useFullView(s => s.on) && onBrowserPage;

  useKeybindings();

  return (
    <div className="flex h-full w-full">
      {!collapsed && !fullView && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col bg-aico-bg">
        {!fullView && <TopBar />}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <ViewHost />
          </div>
          {dock.open && !onBrowserPage && <Dock />}
        </div>
        {panel.open && !fullView && <BottomPanel />}
        {!fullView && <StatusBar />}
      </main>
      <SettingsModal />
      <ImportWizard />
      <CommandPalette />
      <SearchDialog />
      <Toasts />
      <Tooltips />
      <EngineGate ready={engineReady} />
    </div>
  );
}

function ViewHost(): React.ReactElement {
  const route = useDesk(s => s.route);
  // Re-resolve when plugins change or are switched on and off.
  useRegistry(s => s.builtins);
  useRegistry(s => s.user);
  useDesk(s => s.prefs.plugins.disabled);
  const view = resolveView(route.view === 'home' ? 'chat' : route.view);
  if (!view) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-aico-muted">
        <Icon name="puzzle" size={28} />
        <div className="text-[14px]">This page belongs to a plugin that is switched off or missing.</div>
        <button className="btn-outline" onClick={() => useDesk.getState().navigate({ view: 'plugins' })}>Manage plugins</button>
      </div>
    );
  }
  if (view.component) {
    const C = view.component;
    return (
      <Suspense fallback={<PageSkeleton />}>
        <C params={route.params} />
      </Suspense>
    );
  }
  return <PluginView view={view} />;
}

export function PageSkeleton(): React.ReactElement {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-3 px-8 py-10">
      <div className="skeleton h-7 w-56" />
      <div className="skeleton h-4 w-96" />
      <div className="grid grid-cols-3 gap-3 pt-4">
        {[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton h-24" />)}
      </div>
    </div>
  );
}

/** App-wide shortcuts, plus every plugin command that declares a keybinding. */
function useKeybindings(): void {
  useEffect(() => {
    const fixed: Array<[string, () => void]> = [
      ['Ctrl+K', () => useDesk.getState().setPalette(true)],
      ['Ctrl+Shift+P', () => useDesk.getState().setPalette(true)],
      ['Ctrl+N', () => { useStore.getState().newSession(); useDesk.getState().navigate({ view: 'home' }); window.dispatchEvent(new Event('desk:focus-composer')); }],
      ['Ctrl+,', () => useDesk.getState().openSettings('general')],
      ['Ctrl+B', () => { const s = useDesk.getState(); void s.setPrefs({ sidebar: { ...s.prefs.sidebar, collapsed: !s.prefs.sidebar.collapsed } }); }],
      ['Ctrl+J', () => { const s = useDesk.getState(); s.setPanel({ open: !s.panel.open }); }],
      ['Ctrl+Shift+F', () => useDesk.getState().setSearch(true)],
      ['Alt+ArrowLeft', () => useDesk.getState().goBack()],
      ['Alt+ArrowRight', () => useDesk.getState().goForward()],
      ['Ctrl+L', () => window.dispatchEvent(new Event('desk:focus-composer'))],
    ];
    const onKey = (e: KeyboardEvent): void => {
      for (const [spec, run] of fixed) {
        if (matchesKey(e, spec.replace('ArrowLeft', 'arrowleft').replace('ArrowRight', 'arrowright'))) { e.preventDefault(); run(); return; }
      }
      const overrides = useDesk.getState().prefs.shortcuts;
      for (const c of commandsNow()) {
        const key = overrides[c.id] ?? c.keybinding;
        if (key && matchesKey(e, key)) { e.preventDefault(); void c.run(); return; }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
