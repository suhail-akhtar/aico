/**
 * Native right-click menus for the app window and the built-in browser's tabs.
 *
 * The contents are decided by context-menu-template.ts (pure, tested); this
 * module listens for Chromium's `context-menu` event on every web contents
 * that belongs to us, builds the `Menu`, and carries out what was picked.
 * "Ask AICO …" items are handed to the interface (`browser:ask`), which puts
 * them in the copilot. Save page (Ctrl+S) and View source (Ctrl+U) are also
 * reachable from the browser's shortcuts (`browser:savePage`, `browser:viewSource`).
 *
 * @module desktop/electron/context-menu
 */

import { app, BrowserWindow, clipboard, dialog, Menu, type WebContents, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import { isBrowserSession } from './browser-session';
import { askFor, buildContextMenuTemplate, SEARCH_URL, type MenuAction, type MenuSpec } from './context-menu-template';
import { openExternalLink } from './external-link';

const safeName = (s: string): string => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();

/** A file name for "Save … as": the URL's own name, or a sensible default. */
function fileName(src: string, fallback = 'image.png'): string {
  const m = /^data:(?:image|video|audio)\/([a-z0-9.+-]+)/i.exec(src);
  if (m) return `${fallback.replace(/\.[^.]+$/, '')}.${m[1]!.replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`;
  try {
    const base = decodeURIComponent(path.basename(new URL(src).pathname));
    return base && /\.[a-z0-9]{2,5}$/i.test(base) ? safeName(base) : fallback;
  } catch { return fallback; }
}

async function saveUrl(ctx: DesktopContext, wc: WebContents, src: string, name: string): Promise<void> {
  const w = BrowserWindow.fromWebContents(wc) ?? ctx.browserWindow();
  const opts = { defaultPath: path.join(app.getPath('downloads'), name) };
  const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return;
  let bytes: Buffer;
  const data = /^data:[^;,]*(;base64)?,(.*)$/s.exec(src);
  if (data) {
    bytes = data[1] ? Buffer.from(data[2]!, 'base64') : Buffer.from(decodeURIComponent(data[2]!), 'utf8');
  } else {
    // Through the page's own session, so a file behind a sign-in still saves.
    const res = await wc.session.fetch(src);
    if (!res.ok) throw new Error(`It could not be downloaded (${res.status}).`);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  fs.writeFileSync(r.filePath, bytes);
}

/** "Save page as…": complete (with its files), one .mhtml file, or the HTML only — by the file type chosen. */
export async function savePageAs(ctx: DesktopContext, wc: WebContents): Promise<string | null> {
  const w = ctx.browserWindow();
  const name = `${safeName(wc.getTitle() || 'page').slice(0, 100) || 'page'}.html`;
  const opts = {
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [
      { name: 'Webpage, Complete', extensions: ['html', 'htm'] },
      { name: 'Webpage, Single File', extensions: ['mhtml'] },
    ],
  };
  const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return null;
  await wc.savePage(r.filePath, /\.mhtml$/i.test(r.filePath) ? 'MHTML' : 'HTMLComplete');
  return r.filePath;
}

/** The <video>/<audio> the menu was opened on: by its source, else the one under the pointer. */
function mediaScript(p: ContextMenuParams, body: string): string {
  return `(() => {
    const src = ${JSON.stringify(p.srcURL)};
    const all = [...document.querySelectorAll('video, audio')];
    let el = all.find(m => m.currentSrc === src || m.src === src);
    if (!el) { const at = document.elementFromPoint(${Math.round(p.x)}, ${Math.round(p.y)}); el = at && (at.closest('video, audio') || (at.querySelector && at.querySelector('video, audio'))); }
    if (!el) return false;
    ${body}
    return true;
  })()`;
}

export function registerContextMenus(ctx: DesktopContext): void {
  const openTab = (wc: WebContents, url: string, background = false): void => {
    void ctx.services.browser?.openForUser(url, { opener: wc.id, background }).catch(() => {});
  };
  const fail = (title: string) => (err: Error): void => { dialog.showErrorBox(title, err.message); };

  const run = (wc: WebContents, p: ContextMenuParams, action: MenuAction): void => {
    const nav = wc.navigationHistory;
    const ask = askFor(action, p);
    if (ask) { ctx.emit('browser:ask', { action, ...ask, url: p.pageURL }); return; }
    switch (action) {
      case 'undo': wc.undo(); break;
      case 'redo': wc.redo(); break;
      case 'cut': wc.cut(); break;
      case 'copy': wc.copy(); break;
      case 'paste': wc.paste(); break;
      case 'pasteAsPlain': wc.pasteAndMatchStyle(); break;
      case 'selectAll': wc.selectAll(); break;
      case 'addToDictionary': wc.session.addWordToSpellCheckerDictionary(p.misspelledWord); break;
      // The link is the page's: only http(s)/mailto: reach the OS (external-link.ts).
      case 'openLinkExternal': void openExternalLink(p.linkURL, 'context menu').catch(() => {}); break;
      case 'openLinkNewTab': openTab(wc, p.linkURL); break;
      case 'openLinkBackground': openTab(wc, p.linkURL, true); break;
      case 'openLinkInBrowser':
        void ctx.services.browser?.openForUser(p.linkURL).catch(() => {});
        ctx.emit('command:run', { id: 'browser.open' });
        break;
      case 'copyLink': void clipboard.writeText(p.linkURL.replace(/^mailto:/i, '')); break;
      case 'saveLink': void saveUrl(ctx, wc, p.linkURL, fileName(p.linkURL, `${safeName(p.linkText || 'download').slice(0, 80) || 'download'}.html`)).catch(fail('Save link')); break;
      case 'copyImage': wc.copyImageAt(p.x, p.y); break;
      case 'copyImageAddress': case 'copyMediaAddress': void clipboard.writeText(p.srcURL); break;
      case 'saveImage': void saveUrl(ctx, wc, p.srcURL, fileName(p.srcURL)).catch(fail('Save image')); break;
      case 'saveMedia': void saveUrl(ctx, wc, p.srcURL, fileName(p.srcURL, p.mediaType === 'audio' ? 'audio.mp3' : 'video.mp4')).catch(fail('Save')); break;
      case 'openImageNewTab': case 'openMediaNewTab': openTab(wc, p.srcURL); break;
      case 'pictureInPicture':
        // A user gesture: the browser only lets a page enter picture-in-picture from one.
        void wc.executeJavaScript(mediaScript(p, 'if (document.pictureInPictureElement === el) document.exitPictureInPicture(); else el.requestPictureInPicture();'), true).catch(() => {});
        break;
      case 'toggleLoop': void wc.executeJavaScript(mediaScript(p, 'el.loop = !el.loop;'), true).catch(() => {}); break;
      case 'toggleControls': void wc.executeJavaScript(mediaScript(p, 'el.controls = !el.controls;'), true).catch(() => {}); break;
      case 'searchWeb': openTab(wc, SEARCH_URL + encodeURIComponent(p.selectionText.trim().slice(0, 500))); break;
      case 'back': if (nav.canGoBack()) nav.goBack(); break;
      case 'forward': if (nav.canGoForward()) nav.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'savePage': void savePageAs(ctx, wc).catch(fail('Save page')); break;
      case 'print': wc.print({ printBackground: true }); break;
      case 'viewSource': if (/^https?:/i.test(p.pageURL)) openTab(wc, `view-source:${p.pageURL}`); break;
      case 'inspect':
        wc.inspectElement(p.x, p.y);
        if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus();
        break;
      default: break;
    }
  };

  const toMenu = (wc: WebContents, p: ContextMenuParams, specs: MenuSpec[]): MenuItemConstructorOptions[] => specs.map((s): MenuItemConstructorOptions => {
    if (s.type === 'separator') return { type: 'separator' };
    if (s.type === 'spelling') return { label: s.label, enabled: s.enabled ?? true, click: () => wc.replaceMisspelling(s.word) };
    return {
      label: s.label,
      enabled: s.enabled ?? true,
      accelerator: s.accelerator,
      ...(s.checked !== undefined ? { type: 'checkbox' as const, checked: s.checked } : {}),
      // Shown as a hint only: the real shortcuts belong to the page and the app menu.
      registerAccelerator: false,
      click: () => run(wc, p, s.action),
    };
  });

  const attach = (wc: WebContents): void => {
    wc.on('context-menu', (_e, p) => {
      if (p.pageURL.startsWith('devtools://')) return;
      const inBrowser = isBrowserSession(wc.session);
      // A tab's menu opens in the window the browser is in; the app's own, in the window that asked
      // (the AICO window, or the browser's own window — its address bar and copilot).
      const own = ctx.services.browserWindow?.window() ?? null;
      const appWin = [ctx.window(), own].find(w => w && !w.isDestroyed() && w.webContents === wc) ?? null;
      const win = inBrowser ? ctx.browserWindow() : appWin;
      if (!inBrowser && !appWin) return;
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

  // The same two, from the browser's keyboard (Ctrl+S, Ctrl+U) — on the tab in front.
  const front = (): WebContents | null => ctx.services.browser?.activeWebContents() ?? null;
  ctx.handle('browser:savePage', async () => { const wc = front(); return wc ? savePageAs(ctx, wc) : null; });
  ctx.handle('browser:viewSource', () => {
    const wc = front();
    const url = wc?.getURL() ?? '';
    if (wc && /^https?:/i.test(url)) openTab(wc, `view-source:${url}`);
    return Boolean(wc);
  });
}
