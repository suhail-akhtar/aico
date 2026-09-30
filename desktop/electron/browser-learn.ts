/**
 * Browsing intelligence, wired into the browser: the tabs' events feed the
 * model (browser-learn-core.ts), and its views are served to the chrome (the
 * For-you cards, the omnibox, the "What AICO has learned" panel) and to the
 * agent (browser_profile, browser_tabs_overview, browser_organize_tabs).
 *
 * PRIVACY. Learned on this device into `<AICO_HOME>/desktop/browser/learn.json`
 * and never sent anywhere; the agent sees a summary only when the user asks
 * it something and it calls a tool. Not learned: pages the agent is driving,
 * pages Protected Browsing flagged (forgotten if flagged later), internal
 * pages, excluded sites, anything while learning is paused. What was typed is
 * never read — only that typing happened, for "a form you started".
 * "Clear browsing data" clears what was learned from that history too.
 *
 * browser.ts calls in at a few points (a new tab, history cleared, the copilot
 * asked) and hands over what it owns through `LearnHooks`.
 *
 * @module desktop/electron/browser-learn
 */

import { app, powerMonitor, type WebContents } from 'electron';
import path from 'node:path';
import type { DesktopContext } from './context';
import type { BrowserState, ConfirmRequest, HistoryEntry } from '../shared/browser-types';
import type { LearnCleanup, LearnKind, LearnPrediction, LearnView } from '../shared/browser-learn-types';
import { JsonFile } from './browser-store';
import {
  buildView, clearSince, emptyLearn, forgetAll, forgetUrl, hostKey, isExcluded, learnAccept, learnActive, learnCopilot, learnDismiss,
  learnKind, learnTitle, learnTyped, learnVisit, normaliseLearn, predict, profileText, pruneLearn, removeItem, seedFromHistory, setExcluded,
  tabAt, tabClosed, tabFocus, tabPriorities, tabsText, threads, type LearnData, type OpenTab,
} from './browser-learn-core';

export interface LearnHooks {
  state(): BrowserState;
  /** The tab on screen right now (null when the browser is hidden). */
  frontTab(): { id: string; url: string } | null;
  lastInput(tabId: string): number;
  /** The agent is driving this tab: what it opens is not the user's browsing. */
  byAgent(tabId: string): boolean;
  /** Protected Browsing flagged the page in this tab. */
  flagged(tabId: string): boolean;
  closeTab(id: string): void;
  /** A new bookmarks folder holding these pages; its id. */
  bookmarkFolder(title: string, items: Array<{ url: string; title: string }>): string | null;
  bookmarkedUrls(): string[];
  confirm(req: Omit<ConfirmRequest, 'id'>): { id: string; done: Promise<boolean> };
  history(): HistoryEntry[];
  /**
   * The tab in front was read for `ms` more (every gate above passed: focused
   * window, someone there, not flagged, not the agent's, not excluded, not
   * paused) — "Remember what I read" (browser-memory.ts) keys off this.
   */
  reading?(tabId: string, url: string, wc: WebContents, ms: number, scroll?: number): void;
}

/** What the agent's tools call (mcp.ts). */
export interface LearnService {
  profile(opts: { section?: string; days?: number; includeUrls?: boolean }): string;
  tabsOverview(): string;
  organize(opts: { action?: LearnCleanup['action']; tabIds?: string[]; idle?: boolean; folder?: string; confirmId?: string }): Promise<string>;
}

export interface Learning {
  attachTab(tabId: string, wc: WebContents): void;
  noteCopilot(url: string): void;
  /** "Clear browsing data" / clear history from `sinceMs` (all when omitted). */
  clear(sinceMs?: number): void;
  forgetUrl(url: string): void;
  service: LearnService;
  flush(): void;
}

const TICK = 5000;
/** An isolated world for the scroll reading: the page cannot see or change it. */
const LEARN_WORLD = 1073;
const SCROLL_JS = `(() => { const e = document.documentElement; const h = Math.max(e ? e.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
  return h <= innerHeight + 4 ? 1 : Math.min(1, (scrollY + innerHeight) / h); })()`;
const KINDS = new Set<LearnKind>(['product', 'article', 'recipe', 'job', 'event', 'video', 'search', 'cart', 'checkout', 'login', 'form', 'docs', 'code', 'qa', 'email', 'chat', 'page']);

export function createLearning(ctx: DesktopContext, hooks: LearnHooks): Learning {
  const file = path.join(ctx.paths.desktopDir, 'browser', 'learn.json');
  const store = new JsonFile<LearnData>(file, emptyLearn(Date.now()), raw => pruneLearn(normaliseLearn(raw), Date.now()), 4000);
  // First run: start from the history there already is, so the cards are useful at once.
  if (!Object.keys(store.get().sites).length && !store.get().paused) {
    const d = store.get();
    seedFromHistory(d, hooks.history(), Date.now());
    if (Object.keys(d.sites).length) { d.since = Math.min(d.since, ...Object.values(d.sites).map(s => s.first)); store.set(d); }
  }
  const d = (): LearnData => store.get();
  const save = (): void => store.set(store.get());
  const wcs = new Map<string, WebContents>();

  const learnable = (tabId: string, url: string): boolean => {
    if (d().paused || !/^https?:/i.test(url)) return false;
    if (hooks.flagged(tabId) || hooks.byAgent(tabId)) return false;
    return !isExcluded(d(), hostKey(url));
  };

  const openTabs = (): OpenTab[] => {
    const s = hooks.state();
    return s.tabs.map(t => ({ id: t.id, url: t.url, title: t.title, pinned: Boolean(t.pinned), audible: t.audible, active: t.id === s.activeId }));
  };
  const currentHost = (): string | undefined => { const f = hooks.frontTab(); const h = f ? hostKey(f.url) : ''; return h || undefined; };
  const view = (): LearnView => buildView(d(), Date.now(), {
    tabs: openTabs(),
    bookmarked: new Set(hooks.bookmarkedUrls().map(hostKey).filter(Boolean)),
    ...(currentHost() ? { current: currentHost() } : {}),
  });

  // ── The tabs ──
  const attachTab = (tabId: string, wc: WebContents): void => {
    wcs.set(tabId, wc);
    let url = '';
    let typedAt = 0;
    const nav = (next: string, inPage: boolean): void => {
      const from = url;
      url = next;
      if (!learnable(tabId, next)) return;
      const now = Date.now();
      learnVisit(d(), { url: next, title: wc.isDestroyed() ? '' : wc.getTitle(), fromUrl: from, inPage }, now);
      tabAt(d(), next, now, from && /^https?:/i.test(from) ? from : undefined);
      save();
      // Protected Browsing judges the page after it loads: a page flagged then is forgotten.
      setTimeout(() => { if (!wc.isDestroyed() && hooks.flagged(tabId) && wc.getURL() === next) { forgetUrl(d(), next); save(); } }, 3500).unref?.();
    };
    wc.on('did-navigate', (_e, u) => nav(u, false));
    wc.on('did-navigate-in-page', (_e, u, isMainFrame) => { if (isMainFrame) nav(u, true); });
    wc.on('page-title-updated', (_e, title) => { if (url && learnable(tabId, url)) { learnTitle(d(), url, title); save(); } });
    wc.on('before-input-event', (_e, input) => {
      // Only that a key was typed — which key, and into what, is never looked at.
      if (input.type !== 'char' && !(input.type === 'keyDown' && input.key.length === 1 && !input.control && !input.meta)) return;
      const now = Date.now();
      if (now - typedAt < 3000 || !url || !learnable(tabId, url)) return;
      typedAt = now;
      learnTyped(d(), url, now);
      save();
    });
    wc.on('destroyed', () => { wcs.delete(tabId); });
  };

  // ── Time in front, and how far down the page is ──
  let ticks = 0;
  setInterval(() => {
    if (d().paused) return;
    // The browser may be in its own window (browser-window.ts).
    const win = ctx.services.browserWindow?.window() ?? ctx.window();
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()) return;
    const front = hooks.frontTab();
    if (!front || !/^https?:/i.test(front.url)) return;
    let idle = 0;
    try { idle = powerMonitor.getSystemIdleTime(); } catch { /* no idle signal: count it */ }
    if (idle > 90 && Date.now() - hooks.lastInput(front.id) > 90_000) return;
    if (hooks.flagged(front.id)) { forgetUrl(d(), front.url); save(); return; }
    if (!learnable(front.id, front.url)) return;
    const now = Date.now();
    tabFocus(d(), front.url, now);
    const wc = wcs.get(front.id);
    if (++ticks % 3 === 0 && wc && !wc.isDestroyed()) {
      void Promise.race([
        wc.executeJavaScriptInIsolatedWorld(LEARN_WORLD, [{ code: SCROLL_JS }]) as Promise<number>,
        new Promise<null>(r => setTimeout(() => r(null), 800)),
      ]).catch(() => null).then((scroll) => {
        learnActive(d(), front.url, TICK, now, typeof scroll === 'number' ? scroll : undefined);
        save();
        if (!wc.isDestroyed()) hooks.reading?.(front.id, front.url, wc, TICK, typeof scroll === 'number' ? scroll : undefined);
      });
    } else {
      learnActive(d(), front.url, TICK, now);
      save();
      if (wc && !wc.isDestroyed()) hooks.reading?.(front.id, front.url, wc, TICK);
    }
  }, TICK).unref?.();
  setInterval(() => { store.set(pruneLearn(d(), Date.now())); }, 6 * 3600_000).unref?.();
  app.on('before-quit', () => store.flush());

  // ── Tidying tabs (the agent's tool and the For-you card) ──
  const apply = (tabs: Array<{ id: string; url: string; title: string }>, action: LearnCleanup['action'], folder?: string): { closed: number; bookmarked: number; folderId?: string; folder?: string } => {
    let folderId: string | null = null;
    const name = folder?.trim() || `Saved tabs — ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    const web = tabs.filter(t => /^https?:/i.test(t.url));
    if (action !== 'close' && web.length) folderId = hooks.bookmarkFolder(name, web.map(t => ({ url: t.url, title: t.title })));
    let closed = 0;
    if (action !== 'bookmark') {
      for (const t of tabs) { hooks.closeTab(t.id); tabClosed(d(), t.url); closed++; }
      save();
    }
    return { closed, bookmarked: folderId ? web.length : 0, ...(folderId ? { folderId, folder: name } : {}) };
  };
  const pending = new Map<string, Promise<string>>();
  const withinMs = <T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> => Promise.race([p, new Promise<typeof TIMEOUT>(r => setTimeout(() => r(TIMEOUT), ms))]);

  const service: LearnService = {
    profile: (o) => {
      const days = Math.max(1, Math.min(60, Math.round(o.days ?? 14)));
      const v = view();
      // Threads over the window asked for ("last week" → 7, "this month" → 30).
      if (days !== 14) v.threads = threads(d(), Date.now(), days, 8);
      return profileText(v, { section: o.section, includeUrls: o.includeUrls, days });
    },
    tabsOverview: () => tabsText(tabPriorities(d(), openTabs(), Date.now())),
    async organize(o) {
      if (o.confirmId) {
        const p = pending.get(o.confirmId);
        if (!p) return 'Unknown or finished confirmId.';
        const r = await withinMs(p, 22_000);
        if (r === TIMEOUT) return `Still waiting for the user to answer (confirmId ${o.confirmId}). Call again with the same confirmId, or tell the user what you are waiting for.`;
        pending.delete(o.confirmId);
        return r;
      }
      const action = o.action === 'close' || o.action === 'bookmark' ? o.action : 'bookmark_close';
      const tabs = tabPriorities(d(), openTabs(), Date.now());
      const ids = (o.tabIds ?? []).map(String);
      const targets = ids.length ? tabs.filter(t => ids.includes(t.id)) : o.idle !== false ? tabs.filter(t => t.idle) : [];
      if (!targets.length) return ids.length ? `None of those tab ids are open (${ids.join(', ')}). Call browser_tabs_overview for the current ids.` : 'No idle tabs to tidy — every tab was looked at in the last few days.';
      const describe = (r: ReturnType<typeof apply>): string => [
        r.bookmarked ? `Bookmarked ${r.bookmarked} tab${r.bookmarked === 1 ? '' : 's'} into the folder “${r.folder}” (bookmarks bar).` : '',
        r.closed ? `Closed ${r.closed} tab${r.closed === 1 ? '' : 's'}.` : '',
      ].filter(Boolean).join(' ') || 'Nothing changed.';
      if (action === 'bookmark' || targets.length === 1) return describe(apply(targets, action, o.folder));
      const ask = hooks.confirm({
        kind: 'tabs',
        title: `Close ${targets.length} tabs?`,
        detail: action === 'bookmark_close'
          ? `AICO will save these tabs as bookmarks in a new folder${o.folder ? ` “${o.folder}”` : ''} and then close them.`
          : 'AICO will close these tabs. You can reopen them from History (or Ctrl+Shift+T).',
        files: targets.map(t => `${t.title.slice(0, 80)} — ${t.site || t.url}`),
        origin: 'AICO', okLabel: action === 'bookmark_close' ? `Save and close ${targets.length}` : `Close ${targets.length} tabs`, cancelLabel: 'Keep them',
      });
      const run = ask.done.then(ok => (ok ? describe(apply(targets, action, o.folder)) : 'The user said no — no tabs were closed. Do not ask again unless they bring it up.'));
      const r = await withinMs(run, 22_000);
      if (r !== TIMEOUT) return r;
      pending.set(ask.id, run);
      return `Asked the user to confirm closing ${targets.length} tabs (they see the list). Call browser_organize_tabs with confirmId "${ask.id}" to wait for their answer.`;
    },
  };
  ctx.services.browserLearn = service;

  // ── The chrome ──
  ctx.handle('browser:learn:view', (): LearnView => view());
  ctx.handle('browser:learn:predict', (o?: { query?: string }): LearnPrediction[] =>
    predict(d(), Date.now(), { ...(currentHost() ? { from: currentHost() } : {}), query: typeof o?.query === 'string' ? o.query.slice(0, 100) : undefined, limit: 5 }));
  ctx.handle('browser:learn:page', (o: { url?: string; kind?: string; words?: number }) => {
    const url = String(o?.url ?? '');
    const tab = hooks.state().tabs.find(t => t.url === url);
    if (!tab || !KINDS.has(o.kind as LearnKind) || !learnable(tab.id, url)) return false;
    learnKind(d(), url, o.kind as LearnKind, Date.now(), typeof o.words === 'number' ? o.words : undefined);
    save();
    return true;
  });
  ctx.handle('browser:learn:feedback', (o: { id?: string; action?: string }) => {
    const id = String(o?.id ?? '');
    if (!id.includes(':')) return false;
    if (o.action === 'dismiss') learnDismiss(d(), id, Date.now()); else learnAccept(d(), id, Date.now());
    save();
    return true;
  });
  ctx.handle('browser:learn:remove', (id: string) => { removeItem(d(), String(id)); save(); return view(); });
  ctx.handle('browser:learn:exclude', (site: string, on?: boolean) => { setExcluded(d(), String(site ?? ''), on !== false); save(); return view(); });
  ctx.handle('browser:learn:pause', (paused: boolean) => { d().paused = Boolean(paused); save(); store.flush(); return view(); });
  ctx.handle('browser:learn:forget', () => { store.set(forgetAll(d(), Date.now())); store.flush(); return view(); });
  ctx.handle('browser:learn:cleanup', (o: LearnCleanup) => {
    const ids = new Set((o?.tabIds ?? []).map(String));
    const tabs = openTabs().filter(t => ids.has(t.id));
    const action = o?.action === 'close' || o?.action === 'bookmark' ? o.action : 'bookmark_close';
    return apply(tabs, action, o?.folder);
  });

  return {
    attachTab,
    noteCopilot(url) { if (!d().paused && /^https?:/i.test(url) && !isExcluded(d(), hostKey(url))) { learnCopilot(d(), url, Date.now()); save(); } },
    clear(sinceMs) { store.set(clearSince(d(), Date.now(), sinceMs)); store.flush(); },
    forgetUrl(url) { forgetUrl(d(), url); save(); },
    service,
    flush: () => store.flush(),
  };
}

const TIMEOUT = Symbol('timeout');
