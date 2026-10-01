/**
 * The built-in browser as an everyday browser: a profile that outlives the
 * app, tabs that come back after a restart or an update, tabs you can drag,
 * pin, duplicate and reopen, and full screen for videos.
 *
 * THE PROFILE. Cookies, localStorage, IndexedDB, service workers and the HTTP
 * cache live in `<AICO_HOME>/desktop/browser/profile` (`session.fromPath`),
 * next to history and bookmarks — outside the install folder and outside
 * Electron's per-app data, so neither an upgrade nor an uninstall/reinstall
 * signs you out. An older install kept them in Electron's partition folder
 * (`Partitions/aico-browser`); the first run copies that folder once, before
 * the new profile is opened, and never deletes it. Chromium writes cookies
 * lazily, so the store is flushed every minute and on quit.
 *
 * SESSION COOKIES. A site that signs you in "for this session" sets cookies
 * with no expiry, which Chromium drops at exit. With "Continue where you left
 * off" (the default) they are kept the way Chrome keeps them: saved on quit
 * (and every minute) encrypted with the OS keychain (`safeStorage`), and put
 * back before the restored tabs load. Without OS encryption they are not
 * written at all.
 *
 * THE TABS. The open tabs — order, pinned, muted, the tab in front, and each
 * tab's back/forward stack with Chromium's page state (scroll position, form
 * contents) — are written to `session.json` as they change and restored the
 * first time the browser is needed: the tab in front loads at once, the rest
 * when you first switch to them. The updater's restart and a crash restore
 * the same way. The last 25 closed tabs are kept too, for Ctrl+Shift+T.
 * The rules themselves are pure, in browser-session-core.ts.
 *
 * @module desktop/electron/browser-session
 */

import { app, BrowserWindow, clipboard, Menu, safeStorage, session as electronSession, type Session, type WebContents, type WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import { JsonFile } from './browser-store';
import {
  cleanUserAgent, cookieToSet, EMPTY_SESSION, insertIndex, isRestorable, migrateProfile, moveTab, normaliseSession, pinnedFirst, placeAt,
  pushClosed, sessionCookies, setPinned, tabMenuTemplate, trimEntries,
  type ClosedTab, type CookieLike, type SavedSession, type SavedTab, type TabMenuAction,
} from './browser-session-core';
import { PAGE_SIGNALS_JS, type PageSignals } from '../shared/page-signals';

/** The folder name of the older `persist:aico-browser` partition under userData/Partitions. */
export const LEGACY_PARTITION_DIR = 'aico-browser';
/** A world of our own for reading pages: the page's scripts cannot see or change what runs there. */
export const AICO_WORLD = 1337;

let browserSession: Session | null = null;
let cookiesReady: Promise<void> = Promise.resolve();

export const profileDirOf = (ctx: DesktopContext): string => path.join(ctx.paths.desktopDir, 'browser', 'profile');

/** Is this web contents one of the browser's tabs (its session is the browser profile)? */
export function isBrowserSession(ses: Session): boolean {
  return browserSession !== null && ses === browserSession;
}

function writeAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function saveSessionCookies(ses: Session, file: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) { try { fs.rmSync(file, { force: true }); } catch { /* nothing kept */ } return; }
  const list = sessionCookies(await ses.cookies.get({}) as CookieLike[]).slice(0, 4000);
  writeAtomic(file, safeStorage.encryptString(JSON.stringify({ v: 1, savedAt: Date.now(), cookies: list })));
}

async function restoreSessionCookies(ses: Session, file: string): Promise<void> {
  if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return;
  let list: CookieLike[] = [];
  try { list = (JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) as { cookies?: CookieLike[] }).cookies ?? []; } catch { return; }
  // A cookie the profile already has (set again since) wins over the saved copy.
  const have = new Set((await ses.cookies.get({})).map(c => `${c.domain}|${c.path}|${c.name}`));
  await Promise.all(list.filter(c => !have.has(`${c.domain}|${c.path}|${c.name}`)).map((c) => {
    const set = cookieToSet(c);
    return set ? ses.cookies.set(set).catch(() => { /* a cookie the store refuses now is skipped */ }) : undefined;
  }));
}

/**
 * The browser's session: the profile folder (migrated once), a browser's user
 * agent, spell-checking, and cookies kept across restarts. Called the first
 * time the browser needs its session.
 */
export function openBrowserSession(ctx: DesktopContext): Session {
  if (browserSession) return browserSession;
  const dir = profileDirOf(ctx);
  try {
    const r = migrateProfile(path.join(app.getPath('userData'), 'Partitions', LEGACY_PARTITION_DIR), dir);
    if (r === 'copied') console.log(`[browser] profile copied to ${dir}`);
  } catch (err) {
    console.error('[browser] could not copy the old browser profile:', (err as Error).message);
  }
  const ses = electronSession.fromPath(dir);
  browserSession = ses;
  // Sites serve their full modern pages to Chrome; "Electron/…" gets reduced ones, or a refusal.
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  ses.setSpellCheckerEnabled(true);

  const cookieFile = path.join(ctx.paths.desktopDir, 'browser', 'session-cookies.bin');
  if (ctx.prefs.get().browserStartup !== 'newTab') {
    cookiesReady = Promise.race([restoreSessionCookies(ses, cookieFile).catch(() => {}), new Promise<void>(r => setTimeout(r, 3000))]);
  }
  const persist = async (): Promise<void> => {
    await ses.cookies.flushStore().catch(() => {});
    await saveSessionCookies(ses, cookieFile).catch(() => {});
  };
  setInterval(() => { void persist(); }, 60_000).unref();
  let quitting = false;
  app.on('before-quit', () => { if (!quitting) { quitting = true; void persist(); } });
  return ses;
}

// ── Tabs ──

/** What this module needs of a tab (browser.ts's Tab has all of it). */
export interface SessionTab {
  id: string;
  view: WebContentsView;
  favicon?: string;
  pinned?: boolean;
  /** The tab this one was opened from (a link, window.open). */
  openerId?: string;
  /** Restored but not loaded yet: loads when first shown. */
  deferred?: SavedTab;
}

export interface BrowserInternals {
  /** The tabs, in strip order (insertion order is the order). */
  tabs: Map<string, SessionTab>;
  active(): string | null;
  setActive(id: string | null): void;
  /** A new tab at the end, made active. With a URL it starts loading it. */
  create(url?: string): SessionTab;
  close(id: string): void;
  layout(): void;
  pushState(): void;
  home(): string;
}

export interface TabSession {
  /** Bring back the last session's tabs (once per run). True when it made any. */
  restore(): boolean;
  /** A restored tab is being shown: load it. */
  wake(t: SessionTab): void;
  /** Put a tab opened from another just after it. */
  placeNew(t: SessionTab, openerId: string | undefined): void;
  /** A tab is closing: remember it for Ctrl+Shift+T and say which tab comes forward. */
  closing(t: SessionTab): string | null;
  /** The page asked for full screen (a video): it fills the window. */
  htmlFullscreen(t: SessionTab, on: boolean): void;
  /** The bounds a tab should have instead of the interface's, while it is full screen. */
  boundsFor(t: SessionTab): { x: number; y: number; width: number; height: number } | null;
  pageSignals(): Promise<PageSignals | null>;
}

export function registerTabSession(ctx: DesktopContext, b: BrowserInternals): TabSession {
  const dataDir = path.join(ctx.paths.desktopDir, 'browser');
  const file = new JsonFile<SavedSession>(path.join(dataDir, 'session.json'), EMPTY_SESSION, normaliseSession, 1500);
  const previous = file.get();
  let closed: ClosedTab[] = previous.closed;
  /** Until the last session has been restored (or passed over), the file is not written: it is what we restore from. */
  let restored = false;
  const waking = new Set<string>();
  let fsTab: string | null = null;
  let fsByUs = false;

  const order = (): string[] => [...b.tabs.keys()];
  const pinnedSet = (): Set<string> => new Set([...b.tabs.values()].filter(t => t.pinned).map(t => t.id));
  const applyOrder = (ids: string[]): void => {
    const next: Array<[string, SessionTab]> = [];
    for (const id of ids) { const t = b.tabs.get(id); if (t) next.push([id, t]); }
    for (const [id, t] of b.tabs) if (!ids.includes(id)) next.push([id, t]);
    b.tabs.clear();
    for (const [id, t] of next) b.tabs.set(id, t);
  };
  const live = (t: SessionTab | undefined): t is SessionTab => Boolean(t && !t.view.webContents.isDestroyed());

  function load(t: SessionTab, s: SavedTab): void {
    const wc = t.view.webContents;
    const entries = s.entries?.length ? s.entries : [{ url: s.url, title: s.title }];
    const index = Math.max(0, Math.min(s.index ?? entries.length - 1, entries.length - 1));
    const url = entries[index]!.url;
    t.deferred = { ...s };
    waking.add(t.id);
    const done = (): void => { waking.delete(t.id); if (t.deferred) { t.deferred = undefined; b.pushState(); } };
    wc.once('did-start-navigation', done);
    setTimeout(done, 15_000).unref();
    void cookiesReady.then(() => {
      if (wc.isDestroyed()) return;
      // Chromium's page state brings back the scroll position and what was typed into forms.
      wc.navigationHistory.restore({ entries, index }).catch(() => wc.loadURL(url).catch(() => {}));
    });
  }

  function savedOf(t: SessionTab): SavedTab | null {
    if (t.deferred) return { ...t.deferred, ...(t.pinned ? { pinned: true } : { pinned: undefined }) };
    const wc = t.view.webContents;
    if (wc.isDestroyed()) return null;
    const trimmed = trimEntries(wc.navigationHistory.getAllEntries(), wc.navigationHistory.getActiveIndex());
    const url = trimmed.entries[trimmed.index]?.url ?? wc.getURL();
    if (!isRestorable(url)) return null;
    return {
      url, title: wc.getTitle(), ...(t.favicon ? { favicon: t.favicon } : {}), ...(t.pinned ? { pinned: true } : {}),
      ...(wc.isAudioMuted() ? { muted: true } : {}), ...(trimmed.entries.length ? { entries: trimmed.entries, index: trimmed.index } : {}),
    };
  }

  let last = '';
  function save(): void {
    if (!restored) return;
    const list: Array<{ id: string; tab: SavedTab }> = [];
    for (const t of b.tabs.values()) { const s = savedOf(t); if (s) list.push({ id: t.id, tab: s }); }
    const active = Math.max(0, list.findIndex(x => x.id === b.active()));
    const body = { active, tabs: list.map(x => x.tab), closed };
    const json = JSON.stringify(body);
    if (json === last) return;
    last = json;
    file.set({ version: 1, savedAt: Date.now(), ...body });
  }
  setInterval(save, 2000).unref();
  app.on('before-quit', () => { save(); file.flush(); });

  function restore(): boolean {
    if (restored) return false;
    restored = true;
    if (ctx.prefs.get().browserStartup === 'newTab' || previous.tabs.length === 0) return false;
    const before = b.active();
    const existing = order();
    const made = previous.tabs.map((s) => {
      const t = b.create();
      if (s.pinned) t.pinned = true;
      if (s.muted) t.view.webContents.setAudioMuted(true);
      t.deferred = s;
      return t;
    });
    applyOrder(pinnedFirst([...made, ...existing.map(id => b.tabs.get(id)!)]).map(t => t.id));
    const front = before ?? made[previous.active]?.id ?? made[0]!.id;
    b.setActive(front);
    const ft = b.tabs.get(front);
    if (ft?.deferred) load(ft, ft.deferred);
    b.layout();
    b.pushState();
    return true;
  }

  function wake(t: SessionTab): void {
    if (t.deferred && !waking.has(t.id)) load(t, t.deferred);
  }

  function placeNew(t: SessionTab, openerId: string | undefined): void {
    if (!openerId || !b.tabs.has(openerId)) return;
    t.openerId = openerId;
    const rest = order().filter(x => x !== t.id);
    const at = insertIndex(rest, openerId, id => b.tabs.get(id)?.openerId, pinnedSet());
    applyOrder(placeAt(order(), t.id, at));
    b.pushState();
  }

  function closing(t: SessionTab): string | null {
    if (fsTab === t.id) htmlFullscreen(t, false);
    const ids = order();
    const s = savedOf(t);
    if (s) closed = pushClosed(closed, { ...s, closedAt: Date.now(), position: ids.indexOf(t.id) });
    // The tab to the right comes forward (the left one at the end), as in every browser.
    const active = b.active();
    if (active !== t.id) return active;
    const i = ids.indexOf(t.id);
    const rest = ids.filter(x => x !== t.id);
    return rest.length ? rest[Math.min(i, rest.length - 1)]! : null;
  }

  function reopenClosed(): boolean {
    restore();
    const c = closed[0];
    if (!c) return false;
    closed = closed.slice(1);
    const t = b.create();
    if (c.pinned) t.pinned = true;
    const ids = placeAt(order(), t.id, c.position);
    applyOrder(pinnedFirst(ids.map(id => b.tabs.get(id)!)).map(x => x.id));
    b.setActive(t.id);
    load(t, c);
    b.layout();
    b.pushState();
    return true;
  }

  function duplicate(id: string): SessionTab | null {
    const src = b.tabs.get(id);
    if (!live(src)) return null;
    const s = savedOf(src);
    if (!s) return null;
    const t = b.create();
    applyOrder(placeAt(order(), t.id, order().indexOf(id) + 1));
    if (src.pinned) { t.pinned = true; applyOrder(pinnedFirst([...b.tabs.values()]).map(x => x.id)); }
    load(t, { ...s, pinned: undefined });
    b.layout();
    b.pushState();
    return t;
  }

  function pin(id: string, on: boolean): void {
    const t = b.tabs.get(id);
    if (!t) return;
    const r = setPinned(order(), pinnedSet(), id, on);
    t.pinned = on || undefined;
    applyOrder(r.order);
    b.pushState();
  }

  // ── Full screen ──

  function htmlFullscreen(t: SessionTab, on: boolean): void {
    const win = ctx.browserWindow();
    if (!win) return;
    if (on) {
      fsTab = t.id;
      fsByUs = !win.isFullScreen();
      if (fsByUs) win.setFullScreen(true);
    } else {
      if (fsTab !== t.id) return;
      fsTab = null;
      if (fsByUs && win.isFullScreen()) win.setFullScreen(false);
      fsByUs = false;
    }
    b.layout();
    // The window takes a moment to reach its new size.
    setTimeout(() => b.layout(), 300);
    ctx.emit('browser:htmlFullscreen', { tabId: t.id, on });
  }

  function boundsFor(t: SessionTab): { x: number; y: number; width: number; height: number } | null {
    if (fsTab !== t.id) return null;
    const win = ctx.browserWindow();
    if (!win) return null;
    const [width, height] = win.getContentSize();
    return { x: 0, y: 0, width: width!, height: height! };
  }

  app.on('browser-window-created', (_e, win: BrowserWindow) => {
    win.on('enter-full-screen', () => { if (win === ctx.browserWindow()) ctx.emit('win:fullscreen', true); });
    win.on('leave-full-screen', () => {
      if (win !== ctx.browserWindow()) return;
      ctx.emit('win:fullscreen', false);
      // Leaving with the window's own control while a video was full screen: the video leaves too.
      const t = fsTab ? b.tabs.get(fsTab) : undefined;
      if (live(t)) { fsByUs = false; void t.view.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {}); }
    });
    win.on('resize', () => { if (fsTab) b.layout(); });
  });

  // ── What the page is (for the copilot's suggestions) ──

  async function pageSignals(): Promise<PageSignals | null> {
    const id = b.active();
    const t = id ? b.tabs.get(id) : undefined;
    if (!live(t) || t.deferred) return null;
    const wc: WebContents = t.view.webContents;
    if (!/^https?:/i.test(wc.getURL())) return null;
    return Promise.race([
      wc.executeJavaScriptInIsolatedWorld(AICO_WORLD, [{ code: PAGE_SIGNALS_JS }]).then(r => (r ?? null) as PageSignals | null).catch(() => null),
      new Promise<null>(r => setTimeout(() => r(null), 2500)),
    ]);
  }

  // ── Interface ──

  ctx.handle('browser:move', (id: string, toIndex: number) => {
    applyOrder(moveTab(order(), pinnedSet(), String(id), Number(toIndex)));
    b.pushState();
    return order();
  });
  ctx.handle('browser:pin', (id: string, on: boolean) => { pin(String(id), Boolean(on)); return true; });
  ctx.handle('browser:duplicate', (id: string) => Boolean(duplicate(String(id))));
  ctx.handle('browser:reopenClosed', () => reopenClosed());
  ctx.handle('browser:closedTabs', () => closed.map(c => ({ url: c.url, title: c.title, favicon: c.favicon, closedAt: c.closedAt })));
  ctx.handle('browser:pageSignals', () => pageSignals());
  ctx.handle('browser:windowFullscreen', (on?: boolean) => {
    const win = ctx.browserWindow();
    if (!win) return false;
    win.setFullScreen(typeof on === 'boolean' ? on : !win.isFullScreen());
    return typeof on === 'boolean' ? on : win.isFullScreen();
  });
  ctx.handle('browser:isWindowFullscreen', () => Boolean(ctx.browserWindow()?.isFullScreen()));

  /** The tab's right-click menu (native, like Chrome's). Resolves the action chosen, for the ones the interface finishes (bookmark). */
  ctx.handle('browser:tabMenu', (id: string, info?: { bookmarked?: boolean }) => new Promise<TabMenuAction | null>((resolve) => {
    const t = b.tabs.get(String(id));
    const win = ctx.browserWindow();
    if (!t || !win) { resolve(null); return; }
    const url = t.deferred?.url ?? t.view.webContents.getURL();
    const ids = order();
    const blank = !url || /^about:(blank|newtab)$/i.test(url);
    const specs = tabMenuTemplate({
      blank, pinned: Boolean(t.pinned), muted: t.view.webContents.isAudioMuted(), bookmarked: Boolean(info?.bookmarked),
      count: ids.length, isLast: ids[ids.length - 1] === t.id, closedCount: closed.length,
      window: ctx.services.browserWindow ? (ctx.services.browserWindow.window() ? 'own' : 'main') : undefined,
      handToChat: Boolean(ctx.services.browser),
    });
    let picked: TabMenuAction | null = null;
    const run = (a: TabMenuAction): void => {
      picked = a;
      const others = (pred: (x: string, i: number) => boolean): void => {
        for (const x of ids.filter(pred)) if (x !== t.id && !b.tabs.get(x)?.pinned) b.close(x);
      };
      switch (a) {
        case 'newTabRight': { restore(); const n = b.create('about:blank'); applyOrder(placeAt(order(), n.id, order().indexOf(t.id) + 1)); b.pushState(); break; }
        case 'reload': if (t.deferred) wake(t); else t.view.webContents.reload(); break;
        case 'duplicate': duplicate(t.id); break;
        case 'pin': pin(t.id, true); break;
        case 'unpin': pin(t.id, false); break;
        case 'mute': t.view.webContents.setAudioMuted(true); b.pushState(); break;
        case 'unmute': t.view.webContents.setAudioMuted(false); b.pushState(); break;
        case 'copyAddress': clipboard.writeText(url); break;
        case 'close': b.close(t.id); break;
        case 'closeOthers': others(() => true); break;
        case 'closeRight': { const i = ids.indexOf(t.id); others((_x, j) => j > i); break; }
        case 'reopenClosed': reopenClosed(); break;
        case 'popOut': ctx.services.browserWindow?.popOut(); break;
        case 'popIn': ctx.services.browserWindow?.popIn({ show: true }); break;
        case 'handToChat':
          void ctx.services.browser?.handToOpenChat(t.id).then((title) => {
            void ctx.services.renderer?.call('notify', title
              ? { title: 'Tab handed over', body: `“${title}” may now use this tab (its tools name it by id ${t.id}).`, kind: 'success' }
              : { title: 'No chat to hand it to', body: 'Open the chat that should use this tab, then try again.', kind: 'warning' }).catch(() => {});
          });
          break;
        case 'bookmark': break; // the interface does it (the bookmarks list is its)
      }
      resolve(a);
    };
    const menu = Menu.buildFromTemplate(specs.map(s => s.type === 'separator'
      ? { type: 'separator' as const }
      : { label: s.label, enabled: s.enabled, accelerator: s.accelerator, registerAccelerator: false, click: () => run(s.action) }));
    // A click can arrive just after the menu reports it closed.
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(picked), 80) });
  }));

  return { restore, wake, placeNew, closing, htmlFullscreen, boundsFor, pageSignals };
}
