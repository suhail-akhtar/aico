/**
 * The small, always-on main-process services: app info, the window frame,
 * shell hand-offs, file dialogs, native notifications, the clipboard, and
 * exports (files and PDF).
 *
 * @module desktop/electron/core-ipc
 */

import {
  app, BrowserWindow, clipboard, ClipboardItem, dialog, nativeTheme, Notification, powerSaveBlocker, shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DesktopContext } from './context';
import { openedRoots } from './opened-roots';
import { isExecutablePath } from './security-core';
import { openExternalLink } from './external-link';

declare const __AICO_VERSION__: string;
declare const __DESKTOP_VERSION__: string;

let sleepBlocker: number | null = null;

export function applyPowerPrefs(ctx: DesktopContext): void {
  const want = ctx.prefs.get().preventSleep;
  if (want && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && sleepBlocker !== null) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = null; }
  if (process.platform !== 'linux' || app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: ctx.prefs.get().launchAtLogin }); } catch { /* unsupported here */ }
  }
}

export function registerCoreIpc(ctx: DesktopContext): void {
  ctx.handle('app:info', () => ({
    app: __DESKTOP_VERSION__,
    engine: __AICO_VERSION__,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    hostname: os.hostname(),
    user: os.userInfo().username,
    home: os.homedir(),
    aicoHome: ctx.paths.aicoHome,
    desktopDir: ctx.paths.desktopDir,
    pluginsDir: ctx.paths.pluginsDir,
    packaged: app.isPackaged,
  }));
  ctx.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });
  ctx.handle('app:quit', () => { app.quit(); });

  // ── Engine ──
  ctx.handle('engine:status', () => ctx.engine.state);
  ctx.handle('engine:restart', () => ctx.engine.restart());
  ctx.handle('engine:log', () => ctx.engine.recentLog());
  /** The tokenised URL, for "open this in the browser client". */
  ctx.handle('engine:webUrl', () => {
    const e = ctx.engine.current();
    return e ? `${e.origin}/?token=${encodeURIComponent(e.token)}` : null;
  });

  // ── Prefs ──
  ctx.handle('prefs:get', () => ctx.prefs.get());
  ctx.handle('prefs:set', (patch: unknown) => {
    const next = ctx.prefs.set(patch as never);
    applyPowerPrefs(ctx);
    return next;
  });

  // ── Window frame ──
  ctx.handle('win:minimize', () => ctx.window()?.minimize());
  ctx.handle('win:toggleMaximize', () => {
    const w = ctx.window();
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  });
  ctx.handle('win:close', () => ctx.window()?.close());
  ctx.handle('win:isMaximized', () => ctx.window()?.isMaximized() ?? false);
  ctx.handle('win:setOverlay', (o: { color: string; symbolColor: string }) => {
    const w = ctx.window();
    if (!w || process.platform === 'darwin') return;
    try { w.setTitleBarOverlay({ color: o.color, symbolColor: o.symbolColor, height: 40 }); } catch { /* frame without overlay */ }
  });
  ctx.handle('win:setThemeSource', (mode: 'system' | 'light' | 'dark') => { nativeTheme.themeSource = mode; });
  ctx.handle('win:zoom', (delta: number) => {
    const w = ctx.window();
    if (!w) return 1;
    const wc = w.webContents;
    const next = delta === 0 ? 1 : Math.min(2, Math.max(0.6, wc.getZoomFactor() + delta));
    wc.setZoomFactor(next);
    return next;
  });
  ctx.handle('win:devtools', () => ctx.window()?.webContents.toggleDevTools());

  // ── Shell ──
  ctx.handle('shell:openExternal', async (url: string) => {
    if (!(await openExternalLink(url, 'shell:openExternal'))) throw new Error('Only web and mail links open externally.');
  });
  ctx.handle('shell:showItemInFolder', (p: string) => shell.showItemInFolder(path.resolve(p)));
  // Only inside the folders open in AICO; a program or script is run only after the person says so.
  ctx.handle('shell:openPath', async (p: string) => {
    const target = await openedRoots(ctx).check(p, 'Cannot open');
    let isDir = false;
    try { isDir = fs.statSync(target).isDirectory(); } catch { /* shell.openPath reports a missing file */ }
    if (!isDir && isExecutablePath(target)) {
      const w = ctx.window();
      const opts: Electron.MessageBoxOptions = {
        type: 'warning', title: 'Run this file?', message: `${path.basename(target)} is a program or script. Opening it runs it.`,
        detail: target, buttons: ['Run it', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      };
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      if (r.response !== 0) return 'Not opened.';
    }
    return shell.openPath(target);
  });

  // ── Dialogs ──
  ctx.handle('dialog:pickFolder', async (title?: string) => {
    const w = ctx.window();
    const r = await dialog.showOpenDialog(w!, { title: title ?? 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    // The person picked it: the file handlers may work in it (opened-roots.ts).
    if (!r.canceled && r.filePaths[0]) openedRoots(ctx).add(r.filePaths[0]);
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  ctx.handle('dialog:pickFiles', async (opts?: { title?: string; multi?: boolean; filters?: Electron.FileFilter[] }) => {
    const w = ctx.window();
    const r = await dialog.showOpenDialog(w!, {
      title: opts?.title ?? 'Choose files',
      properties: opts?.multi === false ? ['openFile'] : ['openFile', 'multiSelections'],
      filters: opts?.filters,
    });
    if (r.canceled) return [];
    for (const p of r.filePaths) openedRoots(ctx).add(p);
    return r.filePaths.map(p => {
      const st = fs.statSync(p);
      return { path: p, name: path.basename(p), size: st.size };
    });
  });
  /** Read a picked file as base64 — for attachments, capped so a stray ISO cannot stall the UI. */
  ctx.handle('dialog:readFileBase64', (p: string) => {
    const st = fs.statSync(p);
    if (st.size > 40 * 1024 * 1024) throw new Error('That file is larger than 40 MB.');
    return fs.readFileSync(p).toString('base64');
  });
  ctx.handle('dialog:saveFile', async (o: { defaultName: string; content: string; encoding?: 'utf8' | 'base64'; filters?: Electron.FileFilter[] }) => {
    const w = ctx.window();
    const r = await dialog.showSaveDialog(w!, {
      defaultPath: path.join(app.getPath('documents'), o.defaultName),
      filters: o.filters,
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, Buffer.from(o.content, o.encoding ?? 'utf8'));
    openedRoots(ctx).add(r.filePath);
    return r.filePath;
  });
  ctx.handle('dialog:confirm', async (o: { title: string; message: string; detail?: string; ok?: string; cancel?: string; danger?: boolean }) => {
    const w = ctx.window();
    const r = await dialog.showMessageBox(w!, {
      type: o.danger ? 'warning' : 'question',
      title: o.title, message: o.message, detail: o.detail,
      buttons: [o.ok ?? 'OK', o.cancel ?? 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
    });
    return r.response === 0;
  });

  // ── Notifications ──
  ctx.handle('notify:show', (o: { title: string; body: string; tag?: string; silent?: boolean; data?: unknown; onlyWhenUnfocused?: boolean }) => {
    const w = ctx.window();
    if (o.onlyWhenUnfocused && w && w.isFocused() && w.isVisible()) return false;
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title: o.title, body: o.body, silent: o.silent ?? !ctx.prefs.get().notifications.sound });
    n.on('click', () => { ctx.reveal(); ctx.emit('notify:click', o.data ?? null); });
    n.show();
    if (w && !w.isFocused()) w.flashFrame(true);
    return true;
  });
  ctx.handle('notify:badge', (count: number) => {
    try { app.setBadgeCount(Math.max(0, count | 0)); } catch { /* not supported on this platform */ }
  });

  // ── Clipboard ──
  // Electron 44's clipboard is the async, web-shaped one: items keyed by MIME type.
  ctx.handle('clipboard:writeRich', async (o: { html?: string; text: string }) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': o.text, ...(o.html ? { 'text/html': o.html } : {}) })]);
    return true;
  });
  ctx.handle('clipboard:writeImage', async (dataUrl: string) => {
    const bytes = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
    return true;
  });

  // ── Export ──
  /**
   * Print a standalone HTML document to PDF in a hidden window, so every chart,
   * formula and diagram is rendered exactly as it looks on screen.
   */
  ctx.handle('export:pdf', async (o: { html: string; defaultName: string; landscape?: boolean }) => {
    const w = ctx.window();
    const target = await dialog.showSaveDialog(w!, {
      defaultPath: path.join(app.getPath('documents'), o.defaultName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (target.canceled || !target.filePath) return null;
    const tmp = path.join(app.getPath('temp'), `aico-export-${Date.now()}.html`);
    fs.writeFileSync(tmp, o.html, 'utf8');
    const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    try {
      await printer.loadFile(tmp);
      const pdf = await printer.webContents.printToPDF({
        printBackground: true, landscape: o.landscape ?? false, pageSize: 'A4',
        margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      });
      fs.writeFileSync(target.filePath, pdf);
      return target.filePath;
    } finally {
      printer.destroy();
      try { fs.unlinkSync(tmp); } catch { /* temp cleanup is best effort */ }
    }
  });
}
