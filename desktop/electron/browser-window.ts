/**
 * The built-in browser in a window of its own — "Pop out", as a tab dragged
 * out of Chrome becomes a browser window.
 *
 * ONE WINDOW AT A TIME. The browser lives in exactly one window: the AICO
 * window (its Browser page and side dock) or this one. Popping out copies and
 * reloads nothing: the tab views and the floating copilot's view are *moved*
 * from one window's content view to the other's (`browser.rehost`,
 * `browserOverlay.rehost`), so a signed-in page, a half-typed form and a
 * playing video carry on. Meanwhile the AICO window's Browser page is a
 * placeholder ("Focus it" / "Bring it back here"). Closing this window — or
 * "Move back" — moves everything back; the tabs are kept, never closed.
 *
 * THE HOST WINDOW. `ctx.browserWindow()` is whichever window has the browser,
 * and everything that belongs to the browser follows it: where the page is
 * drawn (only that window's renderer may say, `browser:setBounds`), the
 * browser's prompts and events (`ctx.emit` routes them, browser-window-core.ts),
 * the menus and dialogs parented to it, HTML full screen and F11, and the
 * insights' "in front and in use". The agent's browser_* tools act on tabs,
 * wherever they are shown.
 *
 * THE WINDOW. Frameless like the AICO window, with the same title-bar overlay
 * — the tab strip is the title bar, as in Chrome — its own taskbar entry, a
 * minimum size, and its place, size and maximised state remembered in
 * `<AICO_HOME>/desktop/browser/window.json`, with whether it was open when the
 * app quit (so it opens popped out again). It loads `browser.html`
 * (renderer/src/browser-main.tsx): the browser and nothing else, with a button
 * back to AICO. Its menu is the AICO window's without the chat's shortcuts, so
 * Ctrl+N here does not start a chat in a window you cannot see.
 *
 * One browser window, not several: several (Chrome's "Move tab to new window")
 * would need tabs that belong to windows, and the browser has one tab list and
 * one "tab in front" — which is also what the agent drives.
 *
 * @module desktop/electron/browser-window
 */

import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import { APP_ORIGIN } from './protocol';
import { JsonFile } from './browser-store';
import { DEFAULT_WINDOW, MIN_SIZE, normaliseWindowState, placeWindow, type SavedBrowserWindow } from './browser-window-core';

export const BROWSER_WINDOW_URL = `${APP_ORIGIN}/browser.html`;
const TITLE_BAR = 40;
const mac = process.platform === 'darwin';

function appIcon(distDir: string): Electron.NativeImage | undefined {
  for (const name of ['icon.png', '../build/icon.png']) {
    const p = path.join(distDir, name);
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  }
  return undefined;
}

/** The AICO window's menu without what belongs to the chat: editing, reload, developer tools, zoom, full screen. */
function windowMenu(): Menu {
  return Menu.buildFromTemplate([
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

export function registerBrowserWindow(ctx: DesktopContext): void {
  const file = new JsonFile<SavedBrowserWindow>(path.join(ctx.paths.desktopDir, 'browser', 'window.json'), DEFAULT_WINDOW, normaliseWindowState);
  let win: BrowserWindow | null = null;
  let quitting = false;
  /** "Move back" (rather than closing the window): the AICO window comes forward on its Browser page. */
  let showBack = false;
  app.on('before-quit', () => { quitting = true; file.flush(); });

  const live = (): BrowserWindow | null => (win && !win.isDestroyed() ? win : null);
  const save = (patch: Partial<SavedBrowserWindow>): void => file.set({ ...file.get(), ...patch });
  const reveal = (w: BrowserWindow): void => { if (w.isMinimized()) w.restore(); w.show(); w.focus(); };

  function colours(): { bg: string; fg: string } {
    const p = ctx.prefs.get();
    const dark = p.theme === 'dark' || (p.theme === 'system' && nativeTheme.shouldUseDarkColors);
    return dark ? { bg: p.dark.background, fg: p.dark.foreground } : { bg: p.light.background, fg: p.light.foreground };
  }

  /** Tell both windows where the browser is now (`show`: the AICO window should go to its Browser page). */
  function announce(show = false): void {
    const popped = live() !== null;
    for (const w of [ctx.window(), live()]) if (w && !w.isDestroyed()) w.webContents.send('browser:host', { popped, show });
  }

  /** The browser changed window: its views follow, and the windows are told. */
  function moved(show = false): void {
    ctx.services.browser?.rehost();
    ctx.services.browserOverlay?.rehost();
    announce(show);
  }

  function popOut(): void {
    const open = live();
    if (open) { reveal(open); return; }
    const saved = file.get();
    const main = ctx.window();
    const near = main && !main.isDestroyed() && main.isVisible() && !main.isMinimized() ? main.getNormalBounds() : null;
    const place = placeWindow(saved, screen.getAllDisplays().map(d => d.workArea), near);
    const { bg, fg } = colours();
    const w = new BrowserWindow({
      ...place,
      // What is saved is the content's bounds (see setContentBounds below).
      useContentSize: true,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: 'AICO Browser',
      icon: appIcon(ctx.paths.distDir),
      backgroundColor: bg,
      titleBarStyle: mac ? 'hiddenInset' : 'hidden',
      titleBarOverlay: mac ? undefined : { color: bg, symbolColor: fg, height: TITLE_BAR },
      webPreferences: {
        // The AICO window's renderer settings: same preload, same isolation, same session (and so the same localStorage).
        preload: path.join(ctx.paths.distDir, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
        webviewTag: false,
      },
    });
    win = w;
    // Windows grows a frameless window by a pixel or two at creation (at 150% scaling); its content
    // bounds, set again, hold — so it opens the size it was left, every time.
    w.setContentBounds(place);
    // Its own taskbar entry, apart from the AICO window's.
    if (process.platform === 'win32') w.setAppDetails({ appId: 'dev.aico.desktop.browser' });
    if (!mac) w.setMenu(windowMenu());
    if (saved.maximized) w.maximize();
    save({ open: true });

    const saveBounds = (): void => {
      if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
      const maximized = w.isMaximized();
      if (maximized) { save({ maximized }); return; }
      save({ ...w.getContentBounds(), maximized: false });
    };
    w.on('resize', saveBounds);
    w.on('move', saveBounds);
    w.on('maximize', saveBounds);
    w.on('unmaximize', saveBounds);

    // Back into the AICO window before this one goes (its views must not go with it).
    w.on('close', () => {
      if (win !== w) return;
      saveBounds();
      win = null;
      if (!quitting) save({ open: false });
      const show = showBack && !quitting;
      showBack = false;
      moved(show);
      if (show) ctx.reveal();
    });

    // A link in this window's chrome (the copilot's answers) opens as a tab; the window never leaves browser.html.
    const openLink = (url: string): void => { if (/^https?:/i.test(url)) void ctx.services.browser?.openForUser(url).catch(() => {}); };
    w.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
    w.webContents.on('will-navigate', (e, url) => {
      if (url.split('#')[0] !== BROWSER_WINDOW_URL) { e.preventDefault(); if (/^https?:/i.test(url)) openLink(url); else if (/^mailto:/i.test(url)) void shell.openExternal(url); }
    });
    w.webContents.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit' && !w.isDestroyed()) void w.loadURL(BROWSER_WINDOW_URL).catch(() => {}); });

    w.once('ready-to-show', () => { if (!w.isDestroyed()) w.show(); });
    void w.loadURL(BROWSER_WINDOW_URL).catch(() => {});
    // The browser moves now: out of the AICO window, into this one as soon as its page area is laid out.
    moved();
  }

  function popIn(opts: { show?: boolean } = {}): void {
    const w = live();
    if (!w) { if (opts.show) ctx.reveal(); return; }
    showBack = Boolean(opts.show);
    w.close();
  }

  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, fn as (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
  };

  handle('browser:window:state', () => ({ popped: live() !== null }));
  handle('browser:window:popOut', () => { popOut(); return true; });
  handle('browser:window:popIn', () => { popIn({ show: true }); return true; });
  /** "Focus it" (the AICO window's placeholder, a link from the chat): the browser's window comes forward. */
  handle('browser:window:focus', () => { const w = live(); if (w) reveal(w); return Boolean(w); });
  /** The agent is about to use the page: a minimised browser window is restored (a page that is not drawn cannot be seen or captured), without taking the focus. */
  handle('browser:window:ensureShown', () => {
    const w = live();
    if (!w) return false;
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.showInactive();
    return true;
  });
  /** "Open AICO" from the browser's window, optionally at a settings page (the browser's window has no settings of its own). */
  handle('browser:window:showMain', (_e, o?: { settings?: string }) => {
    ctx.reveal();
    const section = typeof o?.settings === 'string' ? o.settings : null;
    if (section) {
      const send = (): void => { ctx.window()?.webContents.send('browser:window:openSettings', section); };
      // A window just re-created has to load before it can hear it.
      const main = ctx.window();
      if (main?.webContents.isLoading()) main.webContents.once('did-finish-load', () => setTimeout(send, 300)); else send();
    }
    return true;
  });
  /** The title bar's colours follow the theme, as the AICO window's do (win:setOverlay). */
  handle('browser:window:overlay', (e, o: { color: string; symbolColor: string }) => {
    const w = live();
    if (!w || mac || e.sender !== w.webContents || typeof o?.color !== 'string' || typeof o?.symbolColor !== 'string') return;
    try { w.setTitleBarOverlay({ color: o.color, symbolColor: o.symbolColor, height: TITLE_BAR }); } catch { /* frame without an overlay */ }
  });

  ctx.services.browserWindow = { window: live, popOut, popIn };

  // Open when the app last quit: it opens again, once the AICO window is up (so it is the one in front).
  if (file.get().open) {
    app.once('browser-window-created', (_e, first) => {
      first.once('ready-to-show', () => setTimeout(() => { if (!live() && !quitting) popOut(); }, 250));
    });
  }
}
