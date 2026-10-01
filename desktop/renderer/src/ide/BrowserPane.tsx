/**
 * The built-in browser: tabs, toolbar, the page, and the AICO copilot.
 *
 * The page itself is a native view drawn by main *above* this interface and
 * laid over the placeholder here on every layout change. Anything drawn over
 * the page area must therefore either sit outside the view's bounds (the bars
 * above it, the docked copilot beside it, the status line under it) or make
 * the view step aside: menus, dialogs and the palette hide it, and a still of
 * the page — captured by main in the moment before it hid it — stands in; the
 * chrome's own pages (new tab, history, bookmarks, reader, error pages)
 * replace it outright. The floating copilot is neither: it is a native view of
 * its own above the page (browser/copilot-overlay.ts), so the page stays live
 * round it.
 *
 * While the agent drives the page, a glow runs round it and the status line
 * says what it is doing, with Stop and Take over. When it needs you — a human
 * check, a sign-in, a payment it must not make — it hands over, and a banner
 * you cannot miss says so, with a one-click Done.
 *
 * The browser can also live in a window of its own (browser/host.ts,
 * electron/browser-window.ts). This pane is then what that window shows, and
 * the AICO window's Browser page and side dock show where it went instead.
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
  installBrowserStore, useAgentBusy, isCertError, letAgentContinue, tabError, takeOver, agentStop, useActiveTab, useBrowser, openUrl,
} from '@/browser/store';
import { isBlankUrl } from '@/browser/urls';
import { describeAgentAction } from '@/browser/context';
import { TabStrip } from '@/browser/TabStrip';
import { Toolbar } from '@/browser/Toolbar';
import { CertErrorPage, ErrorPage, InternalPageView, NewTabPage, ReaderView } from '@/browser/pages';
import { FindBar, HandoffBanner, HumanCheckBar, PageModal, PermissionBar, usePendingModal } from '@/browser/prompts';
import { SavePasswordBar } from '@/browser/PasswordsBar';
import { ProtectPage, ThreatBar, protectPageFor } from '@/browser/Interstitials';
import { CopilotPanel } from '@/browser/Copilot';
import { minimizeCopilot, toggleCopilot, useCopilotUi } from '@/browser/copilot-ui';
import { cancelCopilot, useCopilot } from '@/browser/copilot-session';
import { useFloatingCopilot } from '@/browser/copilot-overlay';
import { call } from '@/browser/ipc';
import type { PageStill } from '@desk/browser-types';
import { useBrowserKeys } from '@/browser/keys';
import { browserElsewhere, focusBrowserWindow, popInBrowser, refreshBrowserHost, useBrowserElsewhere } from '@/browser/host';
import { BookmarksBar } from '@/browser/BookmarksBar';

export function BrowserView({ params }: ViewProps): React.ReactElement {
  return <BrowserPane initialUrl={params?.url} />;
}

export function BrowserPane({ docked, initialUrl }: { docked?: boolean; initialUrl?: string }): React.ReactElement {
  useEffect(installBrowserStore, []);
  const elsewhere = useBrowserElsewhere();
  // A page asked for (a view opened with a URL) opens in the browser wherever it is.
  useEffect(() => {
    if (!initialUrl) return;
    openUrl(initialUrl);
    if (browserElsewhere()) focusBrowserWindow();
  }, [initialUrl]);
  return elsewhere ? <BrowserElsewhere docked={docked} /> : <BrowserHere docked={docked} />;
}

/** The AICO window's Browser page (or side dock) while the browser is in its own window. */
function BrowserElsewhere({ docked }: { docked?: boolean }): React.ReactElement {
  const count = useBrowser(s => s.state.tabs.length);
  const tab = useActiveTab();
  const title = tab && !isBlankUrl(tab.url) ? tab.title || tab.url : '';
  return (
    <div className={cls('flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center', docked ? 'py-8' : 'py-12')}>
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-aico-accent-soft text-aico-accent"><Icon name="pop-out" size={22} /></span>
      <div className="max-w-sm space-y-1">
        <div className="text-[15px] font-semibold text-aico-primary">The browser is open in its own window</div>
        <div className="text-[12.5px] text-aico-muted">
          {count > 0 && <>{count} tab{count === 1 ? '' : 's'}{title && <> · <span className="text-aico-secondary">{title}</span></>}. </>}
          AICO can still use it while you chat here.
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button className="btn-accent" onClick={focusBrowserWindow}><Icon name="pop-out" size={14} />Focus it</button>
        <button className="btn-outline" onClick={popInBrowser} title="Move the browser and its tabs back into this window"><Icon name="pop-in" size={14} />Bring it back here</button>
      </div>
    </div>
  );
}

function BrowserHere({ docked }: { docked?: boolean }): React.ReactElement {
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
  const [still, setStill] = useState<PageStill | null>(null);

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
    : protectPageFor(tab) && !(internal && !docked) ? <ProtectPage tab={tab} />
    : cert ? <CertErrorPage tab={tab} error={cert} />
      : internal && !docked ? <InternalPageView page={internal.page} />
        : reader ? <ReaderView />
          : error ? <ErrorPage tab={tab} error={error} />
            : blank ? <NewTabPage />
              : null;
  const floating = !docked && ui.open && !ui.minimized && ui.mode === 'float';
  const appCovered = overlays > 0 || settingsOpen || paletteOpen || Boolean(modal);
  const covered = appCovered || replaced !== null;
  const needsStill = covered && replaced === null;
  const floatStill = useFloatingCopilot(area, { enabled: !docked, active: floating, show: !appCovered && !handoff });
  const stillWanted = useRef(needsStill);
  stillWanted.current = needsStill;

  // Keep the native view exactly over the placeholder (or out of the way).
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    let frame = 0;
    const push = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        void invoke<{ still?: PageStill; elsewhere?: boolean }>('browser:setBounds', { x: r.left, y: r.top, width: r.width, height: r.height }, !covered && r.width > 0 && r.height > 0)
          .then((res) => {
            if (res?.elsewhere) refreshBrowserHost();
            else if (res?.still && stillWanted.current) setStill(res.still);
          })
          .catch(() => {});
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

  // The still main captured as it hid the page belongs to the tab it was taken of; a tab switched to
  // while covered shows its own last still, if it has one (asked once the capture has had its time).
  const tabId = tab?.id;
  useEffect(() => {
    if (!needsStill) { setStill(null); return; }
    if (!tabId || still?.tabId === tabId) return;
    let live = true;
    const t = setTimeout(() => {
      void call<PageStill | null>('browser:still').then((s) => { if (live && s?.tabId === tabId) setStill(s); }).catch(() => {});
    }, 700);
    return () => { live = false; clearTimeout(t); };
  }, [needsStill, tabId, still?.tabId]);
  const pageStill = needsStill && still && still.tabId === tabId ? still.dataUrl : null;

  const driving = useAgentBusy() && !handoff && !takenOver;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!docked && <TabStrip />}
      <Toolbar compact={docked} />
      {!docked && <BookmarksBar />}
      <HandoffBanner />
      <PermissionBar />
      <SavePasswordBar />
      <HumanCheckBar />
      <ThreatBar />
      <FindBar />
      <div ref={area} className="relative flex min-h-0 flex-1">
        <div className={cls('bx-page-frame flex min-h-0 min-w-0 flex-1', driving && 'bx-driving', handoff && 'bx-handoff')}>
          <div ref={host} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-aico-bg" data-no-tip>
            {pageStill && <img src={pageStill} alt="" className="bx-still" draggable={false} />}
            {replaced}
            {(!loaded || tabs.length === 0) && !replaced && !pageStill && (
              <div className="absolute inset-0 flex items-center justify-center bg-aico-bg text-[13px] text-aico-muted">
                <span className="spinner mr-2 h-4 w-4" />Opening…
              </div>
            )}
            <PageModal />
          </div>
        </div>
        {!docked && <CopilotPanel />}
        {floatStill && (
          <img src={floatStill.dataUrl} alt="" draggable={false} className="pointer-events-none absolute z-[45]"
            style={{ left: floatStill.x, top: floatStill.y, width: floatStill.width, height: floatStill.height }} />
        )}
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

  // Per tab: the line speaks for whoever drives the page in front — the copilot, or the chat that owns it.
  const front = useActiveTab();
  const live = (busy || (copilotBusy && hidden)) && !handoff && !takenOver;
  const showLauncher = !docked && minimized;
  if (!live && !takenOver && !showLauncher) return null;

  const who = front?.driver && front.driver !== 'Copilot' ? ` · ${front.driver}` : '';
  const text = (agent.event && agent.event.tabId === front?.id && Date.now() - agent.at < 20_000
    ? agentLine(agent.event)
    : busy ? 'AICO is using this page…' : 'AICO is working…') + who;
  // Stop pauses this tab; the copilot's turn is cancelled only when this page is the copilot's (not a chat's own tab).
  const stop = (): void => { agentStop(); if (useCopilot.getState().busy && !front?.owner) void cancelCopilot(); };

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
