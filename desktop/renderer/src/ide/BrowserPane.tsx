/**
 * The built-in browser: tabs, toolbar, the page, and the AICO copilot.
 *
 * The page itself is a native view drawn by main *above* this interface and
 * laid over the placeholder here on every layout change. Anything drawn over
 * the page area must therefore either sit outside the view's bounds (the bars
 * above it, the docked copilot beside it, the status line under it) or make
 * the view step aside: menus, dialogs and the floating copilot hide it and a
 * still of the page stands in; the chrome's own pages (new tab, history,
 * bookmarks, reader, error pages) replace it outright.
 *
 * While the agent drives the page, a glow runs round it and the status line
 * says what it is doing, with Stop and Take over. When it needs you — a human
 * check, a sign-in, a payment it must not make — it hands over, and a banner
 * you cannot miss says so, with a one-click Done.
 *
 * @module desktop/renderer/ide/BrowserPane
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import '@/browser/browser.css';
import { invoke } from '@/desktop';
import { useDesk } from '@/state/desk';
import { useOverlays } from '@/lib/overlay';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import type { ViewProps } from '@/plugins/registry';
import {
  installBrowserStore, useAgentBusy, isCertError, letAgentContinue, noteStill, tabError, takeOver, agentStop, useActiveTab, useBrowser, openUrl,
} from '@/browser/store';
import { isBlankUrl } from '@/browser/urls';
import { describeAgentAction } from '@/browser/context';
import { TabStrip } from '@/browser/TabStrip';
import { Toolbar } from '@/browser/Toolbar';
import { CertErrorPage, ErrorPage, InternalPageView, NewTabPage, ReaderView } from '@/browser/pages';
import { FindBar, HandoffBanner, HumanCheckBar, PageModal, PermissionBar, usePendingModal } from '@/browser/prompts';
import { CopilotPanel } from '@/browser/Copilot';
import { minimizeCopilot, toggleCopilot, useCopilotUi } from '@/browser/copilot-ui';
import { cancelCopilot, useCopilot } from '@/browser/copilot-session';
import { useBrowserKeys } from '@/browser/keys';

export function BrowserView({ params }: ViewProps): React.ReactElement {
  return <BrowserPane initialUrl={params?.url} />;
}

export function BrowserPane({ docked, initialUrl }: { docked?: boolean; initialUrl?: string }): React.ReactElement {
  useEffect(installBrowserStore, []);
  useBrowserKeys(!docked);

  const tab = useActiveTab();
  const tabs = useBrowser(s => s.state.tabs);
  const loaded = useBrowser(s => s.loaded);
  const internal = useBrowser(s => s.internal);
  const reader = useBrowser(s => s.reader);
  const legacyErrors = useBrowser(s => s.legacyErrors);
  const handoff = useBrowser(s => s.handoff);
  const takenOver = useBrowser(s => s.takenOver);
  const modal = usePendingModal();
  const ui = useCopilotUi();
  const overlays = useOverlays(s => s.count);
  const settingsOpen = useDesk(s => s.settings !== null);
  const paletteOpen = useDesk(s => s.paletteOpen || s.searchOpen);

  const host = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [areaSize, setAreaSize] = useState({ width: 800, height: 600 });
  const [still, setStill] = useState<string | null>(null);

  useEffect(() => {
    if (initialUrl) openUrl(initialUrl);
  }, [initialUrl]);

  // The side dock's "Open full size".
  useEffect(() => {
    if (!docked) return;
    const full = (): void => { useDesk.getState().setDock({ open: false }); useDesk.getState().navigate({ view: 'browser' }); };
    window.addEventListener('aico:browser-full', full);
    return () => window.removeEventListener('aico:browser-full', full);
  }, [docked]);

  // A hand-over needs the live page: a floating copilot over it gets out of the way.
  useEffect(() => {
    const onHandoff = (): void => { const u = useCopilotUi.getState(); if (u.open && !u.minimized && u.mode === 'float') minimizeCopilot(); };
    window.addEventListener('aico:browser-handoff', onHandoff);
    return () => window.removeEventListener('aico:browser-handoff', onHandoff);
  }, []);

  const error = tabError(tab, legacyErrors);
  const cert = isCertError(error) ? error : undefined;
  const blank = Boolean(tab && isBlankUrl(tab.url));
  const replaced: React.ReactNode = !tab ? null
    : cert ? <CertErrorPage tab={tab} error={cert} />
      : internal && !docked ? <InternalPageView page={internal.page} />
        : reader ? <ReaderView />
          : error ? <ErrorPage tab={tab} error={error} />
            : blank ? <NewTabPage />
              : null;
  const floating = !docked && ui.open && !ui.minimized && ui.mode === 'float';
  const covered = overlays > 0 || settingsOpen || paletteOpen || Boolean(modal) || floating || replaced !== null;
  const needsStill = covered && replaced === null;

  // Keep the native view exactly over the placeholder (or out of the way).
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    let frame = 0;
    const push = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        void invoke('browser:setBounds', { x: r.left, y: r.top, width: r.width, height: r.height }, !covered && r.width > 0 && r.height > 0).catch(() => {});
      });
    };
    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    window.addEventListener('resize', push);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', push);
    };
  }, [covered, docked]);
  useEffect(() => () => { void invoke('browser:setBounds', null, false).catch(() => {}); }, []);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setAreaSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // A still of the page while something covers it; kept fresh while the copilot floats over a page that changes.
  const agentAt = useBrowser(s => s.agent.at);
  const lastShot = useRef(0);
  useEffect(() => {
    if (!needsStill) { setStill(null); return; }
    const wait = floating && lastShot.current ? Math.max(0, 1200 - (Date.now() - lastShot.current)) : 0;
    const t = setTimeout(() => {
      lastShot.current = Date.now();
      noteStill();
      void invoke<{ dataUrl: string }>('browser:screenshot').then(s => setStill(s.dataUrl)).catch(() => {});
    }, wait + (floating ? 250 : 0));
    return () => clearTimeout(t);
  }, [needsStill, floating, tab?.url, tab?.loading, floating ? agentAt : 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const driving = useAgentBusy() && !handoff && !takenOver;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!docked && <TabStrip />}
      <Toolbar compact={docked} />
      <HandoffBanner />
      <PermissionBar />
      <HumanCheckBar />
      <FindBar />
      <div ref={area} className="relative flex min-h-0 flex-1">
        <div className={cls('bx-page-frame flex min-h-0 min-w-0 flex-1', driving && 'bx-driving', handoff && 'bx-handoff')}>
          <div ref={host} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-aico-bg" data-no-tip>
            {still && needsStill && (
              <>
                <img src={still} alt="" className="bx-still" draggable={false} />
                {floating && (
                  <button className="bx-still-veil flex items-end justify-start p-4" onClick={() => minimizeCopilot()}
                    title="Minimise the copilot to use the page">
                    <span className="bx-still-hint">
                      Page paused while the copilot floats — click here to use it, or dock the copilot beside it
                    </span>
                  </button>
                )}
              </>
            )}
            {replaced}
            {(!loaded || tabs.length === 0) && !replaced && !still && (
              <div className="absolute inset-0 flex items-center justify-center bg-aico-bg text-[13px] text-aico-muted">
                <span className="spinner mr-2 h-4 w-4" />Opening…
              </div>
            )}
            <PageModal />
          </div>
        </div>
        {!docked && <CopilotPanel area={areaSize} />}
      </div>
      <StatusLine docked={docked} />
    </div>
  );
}

/** "AICO is clicking “Add to cart”…", "AICO read the page", "AICO stopped before clicking “Pay now” — …". */
function agentLine(ev: Parameters<typeof describeAgentAction>[0]): string {
  const said = describeAgentAction(ev);
  const lower = said[0]!.toLowerCase() + said.slice(1);
  return ev.status === 'start' ? `AICO is ${lower}` : `AICO ${lower}`;
}

/** Under the page: what the agent is doing (with Stop / Take over), and the copilot's launcher. */
function StatusLine({ docked }: { docked?: boolean }): React.ReactElement | null {
  const agent = useBrowser(s => s.agent);
  const busy = useAgentBusy();
  const takenOver = useBrowser(s => s.takenOver);
  const handoff = useBrowser(s => s.handoff);
  const copilotBusy = useCopilot(s => s.busy);
  const ui = useCopilotUi();
  const hidden = !ui.open || ui.minimized;
  const minimized = ui.open && ui.minimized;

  const live = (busy || (copilotBusy && hidden)) && !handoff && !takenOver;
  const showLauncher = !docked && minimized;
  if (!live && !takenOver && !showLauncher) return null;

  const text = agent.event && Date.now() - agent.at < 20_000
    ? agentLine(agent.event)
    : busy ? 'AICO is using this page…' : 'AICO is working…';
  const stop = (): void => { agentStop(); if (useCopilot.getState().busy) void cancelCopilot(); };

  return (
    <div className={cls('bx-status', live && 'bx-status-live')} role="status" aria-live="polite">
      {live && (
        <>
          <span className="bx-orb bx-spin h-3.5 w-3.5" />
          <span className="min-w-0 flex-1 truncate bx-shimmer-text font-medium">{text}</span>
          <button className="btn-ghost btn-sm !py-0.5" onClick={takeOver} title="Pause AICO here and use the page yourself"><Icon name="hand" size={13} />Take over</button>
          <button className="btn-outline btn-sm !py-0.5" onClick={stop} title="Stop what AICO is doing"><Icon name="stop" size={11} style={{ fill: 'currentColor' }} />Stop</button>
        </>
      )}
      {!live && takenOver && (
        <>
          <Icon name="hand" size={14} className="text-aico-accent" />
          <span className="min-w-0 flex-1 truncate text-aico-secondary">You’re in control — AICO is paused on this page.</span>
          <button className="btn-accent btn-sm !py-0.5" onClick={letAgentContinue}><Icon name="play" size={11} style={{ fill: 'currentColor' }} />Let AICO continue</button>
        </>
      )}
      {!live && !takenOver && <span className="flex-1" />}
      {showLauncher && (
        <button className="cp-launcher ml-1 shrink-0" onClick={() => toggleCopilot(true)} title="Open the AICO copilot (Ctrl+Shift+A)">
          <span className={cls('bx-orb h-4 w-4', copilotBusy && 'bx-spin')} />Ask AICO
        </button>
      )}
    </div>
  );
}
