/**
 * Native right-click menus for the app window and the built-in browser's tabs.
 *
 * The contents are decided by context-menu-template.ts (pure, tested); this
 * module listens for Chromium's `context-menu` event on every web contents
 * that belongs to us, builds the `Menu`, and carries out what was picked.
 *
 * @module desktop/electron/context-menu
 */

import { app, clipboard, dialog, Menu, session, shell, type WebContents, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import { BROWSER_PARTITION } from './browser';
import { buildContextMenuTemplate, type MenuAction, type MenuSpec } from './context-menu-template';

/** A file name for "Save image as…": the URL's own name, or a sensible default. */
function imageName(src: string): string {
  const m = /^data:image\/([a-z0-9.+-]+)/i.exec(src);
  if (m) return `image.${m[1]!.replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`;
  try {
    const base = decodeURIComponent(path.basename(new URL(src).pathname));
    return base && /\.[a-z0-9]{2,5}$/i.test(base) ? base.replace(/[<>:"/\\|?*]/g, '_') : 'image.png';
  } catch { return 'image.png'; }
}

async function saveImage(ctx: DesktopContext, wc: WebContents, src: string): Promise<void> {
  const w = ctx.window();
  const opts = { defaultPath: path.join(app.getPath('downloads'), imageName(src)) };
  const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return;
  let bytes: Buffer;
  const data = /^data:[^;,]*(;base64)?,(.*)$/s.exec(src);
  if (data) {
    bytes = data[1] ? Buffer.from(data[2]!, 'base64') : Buffer.from(decodeURIComponent(data[2]!), 'utf8');
  } else {
    // Through the page's own session, so an image behind a sign-in still saves.
    const res = await wc.session.fetch(src);
    if (!res.ok) throw new Error(`The image could not be downloaded (${res.status}).`);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  fs.writeFileSync(r.filePath, bytes);
}

export function registerContextMenus(ctx: DesktopContext): void {
  const run = (wc: WebContents, p: ContextMenuParams, action: MenuAction): void => {
    const nav = wc.navigationHistory;
    switch (action) {
      case 'undo': wc.undo(); break;
      case 'redo': wc.redo(); break;
      case 'cut': wc.cut(); break;
      case 'copy': wc.copy(); break;
      case 'paste': wc.paste(); break;
      case 'pasteAsPlain': wc.pasteAndMatchStyle(); break;
      case 'selectAll': wc.selectAll(); break;
      case 'addToDictionary': wc.session.addWordToSpellCheckerDictionary(p.misspelledWord); break;
      case 'openLinkExternal': void shell.openExternal(p.linkURL); break;
      case 'openLinkNewTab':
        void ctx.services.browser?.openForUser(p.linkURL).catch(() => {});
        break;
      case 'openLinkInBrowser':
        void ctx.services.browser?.openForUser(p.linkURL).catch(() => {});
        ctx.emit('command:run', { id: 'browser.open' });
        break;
      case 'copyLink': void clipboard.writeText(p.linkURL.replace(/^mailto:/i, '')); break;
      case 'copyImage': wc.copyImageAt(p.x, p.y); break;
      case 'copyImageAddress': void clipboard.writeText(p.srcURL); break;
      case 'saveImage':
        void saveImage(ctx, wc, p.srcURL).catch((err: Error) => {
          dialog.showErrorBox('Save image', err.message);
        });
        break;
      case 'back': if (nav.canGoBack()) nav.goBack(); break;
      case 'forward': if (nav.canGoForward()) nav.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'inspect':
        wc.inspectElement(p.x, p.y);
        if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus();
        break;
    }
  };

  const toMenu = (wc: WebContents, p: ContextMenuParams, specs: MenuSpec[]): MenuItemConstructorOptions[] => specs.map((s): MenuItemConstructorOptions => {
    if (s.type === 'separator') return { type: 'separator' };
    if (s.type === 'spelling') return { label: s.label, enabled: s.enabled ?? true, click: () => wc.replaceMisspelling(s.word) };
    return {
      label: s.label,
      enabled: s.enabled ?? true,
      accelerator: s.accelerator,
      // Shown as a hint only: the real shortcuts belong to the page and the app menu.
      registerAccelerator: false,
      click: () => run(wc, p, s.action),
    };
  });

  const attach = (wc: WebContents): void => {
    wc.on('context-menu', (_e, p) => {
      if (p.pageURL.startsWith('devtools://')) return;
      // Menus open after `ready`, so the partition's session can be looked up here.
      const inBrowser = wc.session === session.fromPartition(BROWSER_PARTITION);
      const win = ctx.window();
      if (!inBrowser && (!win || win.webContents !== wc)) return;
      const specs = buildContextMenuTemplate(p, {
        surface: inBrowser ? 'browser' : 'app',
        inspect: !app.isPackaged || ctx.prefs.get().developerMenus,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
      if (specs.length === 0) return;
      Menu.buildFromTemplate(toMenu(wc, p, specs)).popup({ window: win ?? undefined });
    });
  };

  app.on('web-contents-created', (_e, wc) => attach(wc));
}
