/**
 * The floating copilot's own document: the copilot, and nothing else.
 *
 * Shown in a small transparent view that main lays over the page
 * (electron/browser-overlay.ts), so the page stays live round it. It is the
 * same copilot as the docked one — the same components, the same conversation
 * (its session id is in localStorage, which this document shares with the
 * main window), the same look (localStorage too, kept in step both ways by
 * copilot-ui.ts) and the same theme (the prefs, followed as they change).
 *
 * What main tells it (`browser:overlay:state`): whether the copilot floats
 * (then this document holds the conversation's stream), whether it is on
 * screen, where the panel sits in the view and how big the area it floats
 * over is. What it tells main: where the panel is (`browser:overlay:box`) —
 * the first report also says it has loaded.
 *
 * @module desktop/renderer/copilot-main
 */

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import '@/browser/browser.css';
import '@/browser/copilot-overlay.css';
import { useStore } from '@web/store';
import { FLOAT_SHADOW, type OverlayMessage, type OverlayState } from '@desk/copilot-float';
import { invoke, on, platform } from './desktop';
import { useDesk } from './state/desk';
import { applyTheme } from './theme';
import { setSendOptions } from './chat/actions';
import { installBrowserStore } from './browser/store';
import { setCopilotSurface, useCopilotUi } from './browser/copilot-ui';
import { attachCopilot, detachCopilot } from './browser/copilot-session';
import { FloatingCopilot } from './browser/Copilot';

setCopilotSurface('overlay');
document.documentElement.dataset.platform = String(platform);
document.documentElement.classList.add('aico-overlay');

function syncTheme(): void {
  const { prefs, setMode } = useDesk.getState();
  setMode(applyTheme(prefs, setMode));
}

function reportBox(): void {
  const { x, y, w, h } = useCopilotUi.getState();
  void invoke('browser:overlay:box', { x, y, w, h }).catch(() => {});
}

function Overlay(): React.ReactElement {
  const [state, setState] = useState<OverlayState>({ active: false, visible: false, panel: null, area: null });
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => on<OverlayState>('browser:overlay:state', setState), []);
  useEffect(() => {
    const r = (): void => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);

  // This document holds the conversation's stream while the copilot floats; the window holds it otherwise.
  useEffect(() => { if (state.active) attachCopilot(); else detachCopilot(); }, [state.active]);

  useEffect(() => on<OverlayMessage>('browser:overlay:message', (m) => {
    if (m?.type === 'prefill') useCopilotUi.setState({ prefill: { text: m.text, at: m.at } });
    if (m?.type === 'prefill' || m?.type === 'focus') window.dispatchEvent(new Event('aico:copilot-focus'));
  }), []);

  // Loaded: say where the panel goes (which lets main show the view), and again whenever it moves.
  // Not only on a paint callback: this view is hidden until it reports, and a hidden view does not
  // paint, so a reload while hidden waited for a frame that never came and the panel never returned.
  // Main also asks (`browser:overlay:report`) whenever it needs the box and has none.
  useEffect(() => {
    const t = requestAnimationFrame(reportBox);
    const t2 = setTimeout(reportBox, 0);
    const off = useCopilotUi.subscribe((s, p) => { if (s.x !== p.x || s.y !== p.y || s.w !== p.w || s.h !== p.h) reportBox(); });
    const offAsk = on('browser:overlay:report', reportBox);
    return () => { cancelAnimationFrame(t); clearTimeout(t2); off(); offAsk(); };
  }, []);

  const panel = state.panel ?? { x: FLOAT_SHADOW, y: FLOAT_SHADOW, width: size.width - 2 * FLOAT_SHADOW, height: size.height - 2 * FLOAT_SHADOW };
  const area = state.area ?? { width: size.width + 2 * FLOAT_SHADOW, height: size.height + 2 * FLOAT_SHADOW };
  return <FloatingCopilot panel={panel} area={area} />;
}

async function boot(): Promise<void> {
  await useDesk.getState().loadPrefs();
  syncTheme();
  useDesk.subscribe((s, prev) => { if (s.prefs !== prev.prefs) syncTheme(); });
  on('prefs:changed', (p) => useDesk.setState({ prefs: p as never }));
  // Approval and effort follow what the main composer last chose.
  window.addEventListener('storage', (e) => {
    if (e.key !== 'desk.sendOptions' || !e.newValue) return;
    try { setSendOptions(JSON.parse(e.newValue)); } catch { /* keep the current options */ }
  });
  // The page chip and quick actions need the browser's tabs; a new chat needs the folders.
  installBrowserStore();
  const st = useStore.getState();
  void Promise.resolve().then(() => st.refreshProjects()).catch(() => {});
  void Promise.resolve().then(() => st.refreshSessions()).catch(() => {});
  createRoot(document.getElementById('root')!).render(<Overlay />);
}

void boot();
