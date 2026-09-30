/**
 * The floating copilot's own view, laid over the page.
 *
 * Browser tabs are native views drawn above the interface, so anything the
 * interface draws over the page is hidden underneath it. The floating copilot
 * used to make the page step aside for a still image — which froze the page
 * the person wanted to watch and use. Instead it is a view of its own: a
 * small, transparent WebContentsView added to the window *above* the tabs,
 * exactly the size of the panel (plus a few pixels for its shadow), showing
 * `copilot.html` — the copilot and nothing else. The page stays live and
 * clickable everywhere the panel is not.
 *
 * WHO DECIDES WHAT. ("The main window" is the window the browser is in —
 * the AICO window, or the browser's own when popped out; `rehost` moves this
 * view with the browser, unreloaded.)
 *   - The main window says whether the copilot floats in the full browser, may
 *     be seen (nothing of its own covers the page — a menu, a dialog, the
 *     palette, a hand-over), and where the browser area is
 *     (`browser:overlay:set`). A hide that is only a cover can ask for a still
 *     of the panel first, drawn in its place under the menu.
 *   - The overlay says where the panel is (`browser:overlay:box`) — it is the
 *     one being dragged and resized — and its first box means it has loaded.
 *     Nothing is shown before that, so a half-loaded view never flashes.
 *   - Main places the view (shared/copilot-float.ts), keeps it above tabs as
 *     they are attached (`raise`), and hides it with the window's own.
 *
 * WHAT IT HEARS. The same events the window hears about the browser and the
 * prefs (so its page chip, chips and theme are right), plus
 * `browser:overlay:state`. `browser:overlay:relay` carries a prefill, a focus
 * request or "open in main chat" between the two documents; one sent before
 * the overlay has loaded waits for it.
 *
 * It is not a tab: it is in the app's own session (the one the window uses,
 * so the two share localStorage and with it the copilot's conversation and
 * look), has the window's preload and isolation, and no page can reach it.
 *
 * @module desktop/electron/browser-overlay
 */

import { ipcMain, WebContentsView, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';
import path from 'node:path';
import type { DesktopContext } from './context';
import { APP_ORIGIN } from './protocol';
import { browserShortcutSpec } from './browser-keys';
import {
  overlayLayout, type FloatBox, type OverlayMessage, type OverlayRequest, type OverlayState, type OverlayStill, type Rect,
} from '../shared/copilot-float';

export const OVERLAY_URL = `${APP_ORIGIN}/copilot.html`;

/** Events the window hears that the overlay needs too. */
const RELAYED = /^(browser:(?!overlay:)|prefs:changed$|engine:status$)/;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function registerBrowserOverlay(ctx: DesktopContext): void {
  let view: WebContentsView | null = null;
  let host: BrowserWindow | null = null;
  let req: OverlayRequest = { active: false, show: false, area: null };
  let reqGen = 0;
  /** The panel's box as the overlay last reported it; null until it has loaded. */
  let box: FloatBox | null = null;
  let shown = false;
  let lastLayout: { bounds: Rect; zoom: number } | null = null;
  let sentState = '';
  let focusAt = 0;
  let outbox: Array<{ m: OverlayMessage; at: number }> = [];

  const alive = (): WebContentsView | null =>
    view && host && !host.isDestroyed() && !view.webContents.isDestroyed() ? view : null;
  const isOverlay = (wc: WebContents): boolean => Boolean(alive() && wc === view!.webContents);
  /** The window the browser is in — the AICO window, or the browser's own (browser-window.ts). */
  const isWindow = (wc: WebContents): boolean => { const w = ctx.browserWindow(); return Boolean(w && !w.isDestroyed() && wc === w.webContents); };
  const isOwnWindow = (wc: WebContents): boolean => { const w = ctx.services.browserWindow?.window(); return Boolean(w && !w.isDestroyed() && wc === w.webContents); };

  function create(): WebContentsView | null {
    const win = ctx.browserWindow();
    if (!win || win.isDestroyed()) return null;
    if (alive() && host === win) return view;
    const v = new WebContentsView({
      webPreferences: {
        // Exactly the window's renderer settings: same preload, same isolation.
        preload: path.join(ctx.paths.distDir, 'preload.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true, webviewTag: false,
        backgroundThrottling: false,
      },
    });
    v.setBackgroundColor('#00000000');
    v.setVisible(false);
    win.contentView.addChildView(v);
    view = v; host = win; box = null; shown = false; sentState = ''; lastLayout = null;
    const wc = v.webContents;
    // Links open in the built-in browser; the view itself never leaves copilot.html.
    const openLink = (url: string): void => { if (/^https?:/i.test(url)) void ctx.services.browser?.openForUser(url).catch(() => {}); };
    wc.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
    wc.on('will-navigate', (e, url) => { if (url.split('#')[0] !== OVERLAY_URL) { e.preventDefault(); openLink(url); } });
    wc.on('before-input-event', (e, input) => {
      // The browser's shortcuts still work while the copilot has the keyboard.
      const spec = browserShortcutSpec(input);
      if (!spec) return;
      e.preventDefault();
      if (!/^Ctrl\+Shift\+a$/i.test(spec)) host?.webContents.focus();
      ctx.emit('browser:shortcut', { key: spec });
    });
    // A reload (or a crash) starts again from "not loaded": hidden until it reports its box.
    wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) { box = null; sentState = ''; apply(); } });
    wc.on('render-process-gone', (_e, d) => { box = null; apply(); if (d.reason !== 'clean-exit') void wc.loadURL(OVERLAY_URL).catch(() => {}); });
    win.once('closed', () => { if (host === win) { view = null; host = null; box = null; shown = false; } });
    void wc.loadURL(OVERLAY_URL).catch(() => {});
    return v;
  }

  /** Keep the overlay the topmost view: a tab attached later would otherwise cover it. */
  function raise(): void {
    const v = alive();
    if (!v || !host) return;
    const kids = host.contentView.children;
    if (kids[kids.length - 1] !== v) host.contentView.addChildView(v);
  }

  function sendState(): void {
    const v = alive();
    if (!v || !box) return;
    const layout = req.area ? overlayLayout(req.area, box) : null;
    const state: OverlayState = {
      active: req.active, visible: shown, panel: layout?.panel ?? null,
      area: req.area ? { width: req.area.width, height: req.area.height } : null,
    };
    const key = JSON.stringify(state);
    if (key === sentState) return;
    sentState = key;
    v.webContents.send('browser:overlay:state', state);
  }

  function apply(): void {
    const v = alive();
    if (!v || !host) return;
    const zoom = host.webContents.getZoomFactor();
    const area = req.area;
    const on = req.active && req.show && box !== null && area !== null && area.width > 0 && area.height > 0;
    if (on) {
      const { bounds } = overlayLayout(area!, box!, zoom);
      v.setBounds(bounds);
      lastLayout = { bounds, zoom };
      if (Math.abs(v.webContents.getZoomFactor() - zoom) > 0.001) v.webContents.setZoomFactor(zoom);
      raise();
      if (!shown) {
        v.setVisible(true);
        shown = true;
        if (Date.now() - focusAt < 4000) { focusAt = 0; v.webContents.focus(); }
      }
    } else if (shown) {
      const hadFocus = v.webContents.isFocused();
      v.setVisible(false);
      shown = false;
      if (hadFocus) host.webContents.focus();
    }
    sendState();
  }

  /** The panel as it looks now, before it is hidden under a menu — only ever of a view on screen, and never for long. */
  async function capture(): Promise<OverlayStill | undefined> {
    const v = alive();
    if (!v || !shown || !lastLayout || !req.area) return undefined;
    try {
      const img = await Promise.race([v.webContents.capturePage(), sleep(400).then(() => null)]);
      if (!img || img.isEmpty()) return undefined;
      const { width, height } = img.getSize();
      if (width * height > 16_000_000) return undefined;
      const { bounds, zoom } = lastLayout;
      return {
        dataUrl: img.toDataURL(),
        x: bounds.x / zoom - req.area.x, y: bounds.y / zoom - req.area.y, width: bounds.width / zoom, height: bounds.height / zoom,
      };
    } catch { return undefined; }
  }

  function deliver(m: OverlayMessage): void {
    const v = alive();
    if (v && box) { v.webContents.send('browser:overlay:message', m); return; }
    // Not loaded yet: hold it (briefly) for when it is.
    outbox = [...outbox.filter(x => Date.now() - x.at < 10_000 && x.m.type !== m.type), { m, at: Date.now() }];
  }

  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, fn as (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
  };

  handle('browser:overlay:set', async (e, r: OverlayRequest) => {
    if (!isWindow(e.sender) || !r || typeof r !== 'object') return {};
    const gen = ++reqGen;
    const next: OverlayRequest = { active: Boolean(r.active), show: Boolean(r.show), area: validRect(r.area) };
    if (next.active) create();
    let still: OverlayStill | undefined;
    if (r.capture && shown && !(next.active && next.show)) {
      still = await capture();
      if (gen !== reqGen) return still ? { still } : {};
    }
    req = next;
    // Wanted on screen but never told where: ask the overlay again rather than wait for it
    // (a reload while hidden used to leave it waiting for a paint that never came).
    const v = alive();
    if (next.active && next.show && box === null && v && !v.webContents.isLoading()) v.webContents.send('browser:overlay:report');
    apply();
    return still ? { still } : {};
  });

  handle('browser:overlay:box', (e, b: FloatBox) => {
    if (!isOverlay(e.sender) || !b || ![b.x, b.y, b.w, b.h].every(n => typeof n === 'number' && Number.isFinite(n))) return;
    const first = box === null;
    box = { x: b.x, y: b.y, w: b.w, h: b.h };
    apply();
    if (first) {
      const v = alive();
      for (const { m, at } of outbox) if (v && Date.now() - at < 10_000) v.webContents.send('browser:overlay:message', m);
      outbox = [];
    }
  });

  handle('browser:overlay:relay', (e, m: OverlayMessage) => {
    if (!m || typeof m !== 'object') return;
    if (isOverlay(e.sender) || (isOwnWindow(e.sender) && m.type === 'openChat')) {
      // The overlay (or the browser's own window) asks the AICO window: open this chat in the main view.
      if (m.type === 'openChat') {
        ctx.window()?.webContents.send('browser:overlay:message', m);
        if (ctx.services.browserWindow?.window()) ctx.reveal();
      }
      return;
    }
    if (!isWindow(e.sender)) return;
    if (m.type === 'focus') {
      const v = alive();
      if (v && shown) v.webContents.focus(); else focusAt = Date.now();
    }
    if (m.type === 'prefill' || m.type === 'focus') deliver(m);
  });

  // Everything the window hears about the browser and the prefs, the overlay hears too.
  const emit = ctx.emit;
  ctx.emit = (channel, payload) => {
    emit.call(ctx, channel, payload);
    const v = alive();
    if (v && RELAYED.test(channel)) v.webContents.send(channel, payload);
    // A hand-over needs the live page in front, whatever the interface is about to say.
    if (channel === 'browser:handoff' && shown) { req = { ...req, show: false }; apply(); }
  };

  /**
   * The browser moved window: the view goes with it — not reloaded, so a
   * floating conversation carries on — hidden until the new window says where
   * its browser area is.
   */
  function rehost(): void {
    const v = alive();
    const win = ctx.browserWindow();
    if (!v || !host || host === win) return;
    const from = host;
    try { from.contentView.removeChildView(v); } catch { /* the old window is going */ }
    v.setVisible(false);
    shown = false; lastLayout = null;
    req = { ...req, show: false, area: null };
    if (!win || win.isDestroyed()) {
      view = null; host = null; box = null;
      if (!v.webContents.isDestroyed()) v.webContents.close();
      return;
    }
    win.contentView.addChildView(v);
    host = win;
    win.once('closed', () => { if (host === win) { view = null; host = null; box = null; shown = false; } });
    sentState = '';
    apply();
  }

  ctx.services.browserOverlay = { raise, rehost };
}

function validRect(r: Rect | null | undefined): Rect | null {
  if (!r || ![r.x, r.y, r.width, r.height].every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  return { x: r.x, y: r.y, width: Math.max(0, r.width), height: Math.max(0, r.height) };
}
