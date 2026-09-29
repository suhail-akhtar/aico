/**
 * The browser's session rules — what a real browser keeps between runs and
 * how its tabs are ordered — as pure functions, so every one is unit-tested
 * without Electron. browser-session.ts applies them.
 *
 * WHAT IS KEPT. The open tabs (address, title, pinned, muted, and each tab's
 * back/forward stack with Chromium's own page state, which carries the scroll
 * position and form values), which one was in front, and the last ~25 closed
 * tabs so Ctrl+Shift+T works across a restart. Pages that cannot be loaded
 * again (error pages, DevTools, `javascript:`) are dropped.
 *
 * TAB ORDER. Pinned tabs always come first. A tab opened from a page lands
 * just after its opener (after the ones already opened from it), as in
 * Chrome; a new tab from Ctrl+T goes at the end. Closing the tab in front
 * brings the one to its right forward (the left one at the end of the strip).
 *
 * THE PROFILE. Cookies, storage and cache live in `<AICO_HOME>/desktop/browser/profile`
 * so they survive an upgrade and an uninstall/reinstall. An older install kept
 * them in Electron's partition folder; that folder is copied once (never moved
 * or deleted) before the new profile is first opened.
 *
 * @module desktop/electron/browser-session-core
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SavedEntry { url: string; title: string; pageState?: string }

export interface SavedTab {
  url: string;
  title: string;
  favicon?: string;
  pinned?: boolean;
  muted?: boolean;
  /** The back/forward stack, oldest first, and which entry is showing. */
  entries?: SavedEntry[];
  index?: number;
}

export interface ClosedTab extends SavedTab {
  closedAt: number;
  /** Where it stood in the strip, so reopening puts it back there. */
  position: number;
}

export interface SavedSession {
  version: 1;
  savedAt: number;
  /** Index of the tab in front. */
  active: number;
  tabs: SavedTab[];
  closed: ClosedTab[];
}

export const CLOSED_CAP = 25;
export const ENTRY_CAP = 30;
/** Chromium's page state is usually a few KB; a huge one (a long form, a big history.state) is not worth keeping. */
export const PAGE_STATE_CAP = 96 * 1024;

export const EMPTY_SESSION: SavedSession = { version: 1, savedAt: 0, active: 0, tabs: [], closed: [] };

/** Can this address be loaded again next time? Blank tabs can (they reopen blank). */
export function isRestorable(url: string): boolean {
  if (!url) return false;
  if (/^(chrome-error|devtools|javascript|chrome|chrome-extension|blob):/i.test(url)) return false;
  if (/^data:/i.test(url)) return url.length < 4096;
  return /^(https?|file|about|view-source):/i.test(url);
}

const str = (v: unknown, max = 4096): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Keep the restorable part of a back/forward stack, at most ENTRY_CAP entries around the current one. */
export function trimEntries(entries: SavedEntry[], index: number): { entries: SavedEntry[]; index: number } {
  const kept: SavedEntry[] = [];
  let at = -1;
  entries.forEach((e, i) => {
    if (!e || !isRestorable(e.url)) return;
    if (i <= index) at = kept.length;
    const pageState = typeof e.pageState === 'string' && e.pageState.length <= PAGE_STATE_CAP ? e.pageState : undefined;
    kept.push({ url: e.url, title: str(e.title, 500), ...(pageState ? { pageState } : {}) });
  });
  if (!kept.length) return { entries: [], index: 0 };
  if (at < 0) at = 0;
  // Keep ENTRY_CAP entries, centred on the current one where the stack allows.
  if (kept.length > ENTRY_CAP) {
    const start = Math.max(0, Math.min(at - Math.floor(ENTRY_CAP / 2), kept.length - ENTRY_CAP));
    return { entries: kept.slice(start, start + ENTRY_CAP), index: at - start };
  }
  return { entries: kept, index: at };
}

function normaliseTab(raw: unknown): SavedTab | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const url = str(r.url, 8192);
  if (!isRestorable(url)) return null;
  const tab: SavedTab = { url, title: str(r.title, 500) };
  if (typeof r.favicon === 'string' && r.favicon.length < 2048 && /^(https?|data):/i.test(r.favicon)) tab.favicon = r.favicon;
  if (r.pinned === true) tab.pinned = true;
  if (r.muted === true) tab.muted = true;
  if (Array.isArray(r.entries)) {
    const idx = typeof r.index === 'number' && Number.isFinite(r.index) ? r.index : r.entries.length - 1;
    const t = trimEntries(r.entries as SavedEntry[], idx);
    if (t.entries.length) { tab.entries = t.entries; tab.index = t.index; }
  }
  return tab;
}

/** A session file as read from disk, made safe to use (anything malformed is dropped). */
export function normaliseSession(raw: unknown): SavedSession {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_SESSION, tabs: [], closed: [] };
  const r = raw as Record<string, unknown>;
  const tabs = (Array.isArray(r.tabs) ? r.tabs : []).map(normaliseTab).filter((t): t is SavedTab => t !== null);
  const closed = (Array.isArray(r.closed) ? r.closed : []).map((c) => {
    const t = normaliseTab(c);
    if (!t) return null;
    const cr = c as Record<string, unknown>;
    return { ...t, closedAt: typeof cr.closedAt === 'number' ? cr.closedAt : 0, position: typeof cr.position === 'number' && cr.position >= 0 ? Math.floor(cr.position) : 0 };
  }).filter((t): t is ClosedTab => t !== null).slice(0, CLOSED_CAP);
  const active = typeof r.active === 'number' && r.active >= 0 && r.active < tabs.length ? Math.floor(r.active) : 0;
  return { version: 1, savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0, active, tabs: pinnedFirst(tabs), closed };
}

/** Blank tabs are not worth reopening from the closed stack. */
export function isBlankTab(url: string): boolean {
  const u = url.trim().toLowerCase();
  return u === '' || u === 'about:blank' || u === 'about:newtab';
}

/** Remember a closed tab (newest first, capped). */
export function pushClosed(stack: ClosedTab[], tab: ClosedTab, cap = CLOSED_CAP): ClosedTab[] {
  if (isBlankTab(tab.url) || !isRestorable(tab.url)) return stack;
  return [tab, ...stack].slice(0, cap);
}

// ── Tab order ──

/** Pinned first, otherwise in the order given (a stable partition). */
export function pinnedFirst<T extends { pinned?: boolean }>(tabs: T[]): T[] {
  return [...tabs.filter(t => t.pinned), ...tabs.filter(t => !t.pinned)];
}

/**
 * Move `id` to `toIndex` (an index in the order *after* removing it). A tab
 * stays within its group: a pinned tab cannot be dragged among unpinned ones
 * or the other way round — it stops at the group's edge, as in Chrome.
 */
export function moveTab(order: string[], pinned: ReadonlySet<string>, id: string, toIndex: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const rest = order.filter(x => x !== id);
  const pinnedCount = rest.filter(x => pinned.has(x)).length;
  const lo = pinned.has(id) ? 0 : pinnedCount;
  const hi = pinned.has(id) ? pinnedCount : rest.length;
  const at = Math.max(lo, Math.min(hi, Math.round(toIndex)));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Pin: to the end of the pinned group. Unpin: to the start of the others. */
export function setPinned(order: string[], pinned: ReadonlySet<string>, id: string, on: boolean): { order: string[]; pinned: Set<string> } {
  const next = new Set(pinned);
  if (on) next.add(id); else next.delete(id);
  if (!order.includes(id)) return { order, pinned: next };
  const rest = order.filter(x => x !== id);
  const pinnedCount = rest.filter(x => next.has(x)).length;
  return { order: [...rest.slice(0, pinnedCount), id, ...rest.slice(pinnedCount)], pinned: next };
}

/**
 * Where a tab opened from `openerId` goes: after the opener and after the
 * tabs already opened from it, so several links opened in a row keep their
 * order. With no opener (Ctrl+T) it goes at the end.
 */
export function insertIndex(order: string[], openerId: string | undefined, openerOf: (id: string) => string | undefined, pinned: ReadonlySet<string> = new Set()): number {
  const pinnedCount = order.filter(x => pinned.has(x)).length;
  const at = openerId ? order.indexOf(openerId) : -1;
  if (at < 0) return order.length;
  let i = at + 1;
  while (i < order.length && openerOf(order[i]!) === openerId) i++;
  return Math.max(pinnedCount, i);
}

/** Put `id` (already in `order`, usually last) at `index`. */
export function placeAt(order: string[], id: string, index: number): string[] {
  const rest = order.filter(x => x !== id);
  const at = Math.max(0, Math.min(rest.length, index));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Which tab comes forward when `closing` closes: the one to its right, else the one to its left. */
export function nextActive(order: string[], closing: string, activeId: string | null): string | null {
  if (activeId !== closing) return activeId && order.includes(activeId) ? activeId : order.find(x => x !== closing) ?? null;
  const i = order.indexOf(closing);
  const rest = order.filter(x => x !== closing);
  if (!rest.length) return null;
  return rest[Math.min(Math.max(0, i), rest.length - 1)]!;
}

/** Ctrl+1 … Ctrl+8 pick that tab; Ctrl+9 always the last one. */
export function tabForDigit(order: string[], digit: number): string | null {
  if (!order.length || digit < 1 || digit > 9) return null;
  if (digit === 9) return order[order.length - 1]!;
  return order[digit - 1] ?? null;
}

// ── User agent ──

/**
 * Chromium's own user agent, without the tokens that make sites serve a
 * reduced page or refuse outright ("Electron/…", the app's name), and with
 * the version reduced the way Chrome itself reports it (Chrome/144.0.0.0).
 */
export function cleanUserAgent(ua: string): string {
  return ua
    .replace(/\s+(Electron|AICO|aico|aico-desktop|AICO Desktop)\/\S+/g, '')
    .replace(/Chrome\/(\d+)\.[\d.]+/, 'Chrome/$1.0.0.0')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── The profile folder ──

export interface ProfileFacts {
  /** The new profile folder has our marker (a migration, or a first run, already happened). */
  markerExists: boolean;
  /** The new profile folder already holds browser data (cookies / storage). */
  newHasData: boolean;
  /** The old partition folder exists and holds browser data. */
  oldHasData: boolean;
}

/** Copy the old partition into the new profile? Only once, only into an empty profile, never deleting the old. */
export function migrationPlan(f: ProfileFacts): 'copy' | 'none' {
  if (f.markerExists || f.newHasData) return 'none';
  return f.oldHasData ? 'copy' : 'none';
}

/** Folders not worth copying: GPU shader caches are tied to this machine's driver and rebuilt on demand. */
export function skipOnCopy(relPath: string): boolean {
  const first = relPath.split(/[\\/]/)[0] ?? '';
  return /^(GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache)$/i.test(first)
    || /(^|[\\/])(LOCK|lockfile|SingletonLock|SingletonCookie|SingletonSocket)$/.test(relPath);
}

/** Does a Chromium profile folder listing (top-level names) contain browsing data? */
export function profileHasData(names: string[]): boolean {
  return names.some(n => /^(Cookies|Network|Local Storage|IndexedDB|Session Storage|Service Worker|Cache|WebStorage)$/i.test(n));
}

const names = (dir: string): string[] => { try { return fs.readdirSync(dir); } catch { return []; } };

/**
 * Copy the older partition folder into the new profile folder — once, only
 * into an empty profile, never touching the old one — and leave a marker so
 * it is never tried again. Runs before the new profile's session is opened.
 */
export function migrateProfile(oldDir: string, newDir: string): 'copied' | 'none' {
  const marker = path.join(newDir, '.aico-profile');
  const plan = migrationPlan({ markerExists: fs.existsSync(marker), newHasData: profileHasData(names(newDir)), oldHasData: profileHasData(names(oldDir)) });
  fs.mkdirSync(newDir, { recursive: true });
  if (plan === 'copy') {
    fs.cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: false, filter: (src) => !skipOnCopy(path.relative(oldDir, src)) });
  }
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify({ created: Date.now(), migratedFrom: plan === 'copy' ? oldDir : null }));
  return plan === 'copy' ? 'copied' : 'none';
}

// ── Session cookies (kept across a restart, like "Continue where you left off") ──

export interface CookieLike {
  name: string; value: string; domain?: string; hostOnly?: boolean; path?: string;
  secure?: boolean; httpOnly?: boolean; session?: boolean; expirationDate?: number;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

export interface CookieSet {
  url: string; name: string; value: string; domain?: string; path?: string;
  secure?: boolean; httpOnly?: boolean; sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

/** Only session cookies need saving: persistent ones are in the profile's cookie store already. */
export function sessionCookies(all: CookieLike[]): CookieLike[] {
  return all.filter(c => c.session === true || c.expirationDate === undefined);
}

/** The `cookies.set` call that recreates a saved cookie as a session cookie again (null when it cannot be). */
export function cookieToSet(c: CookieLike): CookieSet | null {
  if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || !c.domain) return null;
  const host = c.domain.replace(/^\./, '');
  if (!host || /[\s/]/.test(host)) return null;
  const path = c.path && c.path.startsWith('/') ? c.path : '/';
  const secure = Boolean(c.secure) || c.name.startsWith('__Secure-') || c.name.startsWith('__Host-');
  // SameSite=None needs Secure; a cookie that broke that rule was never set in the first place.
  if (c.sameSite === 'no_restriction' && !secure) return null;
  const hostOnly = c.hostOnly === true || c.name.startsWith('__Host-') || !c.domain.startsWith('.');
  return {
    url: `${secure ? 'https' : 'http'}://${host}${path}`,
    name: c.name, value: c.value, path,
    ...(hostOnly ? {} : { domain: c.domain }),
    ...(secure ? { secure: true } : {}),
    ...(c.httpOnly ? { httpOnly: true } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  };
}

// ── The tab's right-click menu ──

export type TabMenuAction =
  | 'newTabRight' | 'reload' | 'duplicate' | 'pin' | 'unpin' | 'mute' | 'unmute'
  | 'bookmark' | 'copyAddress' | 'close' | 'closeOthers' | 'closeRight' | 'reopenClosed' | 'popOut' | 'popIn';

export type TabMenuSpec = { type: 'separator' } | { type: 'item'; action: TabMenuAction; label: string; enabled: boolean; accelerator?: string };

/** `window`: where the browser is — the AICO window or its own (browser-window.ts); absent, no item to move it. */
export function tabMenuTemplate(t: { blank: boolean; pinned: boolean; muted: boolean; bookmarked: boolean; count: number; isLast: boolean; closedCount: number; window?: 'main' | 'own' }): TabMenuSpec[] {
  const i = (action: TabMenuAction, label: string, enabled = true, accelerator?: string): TabMenuSpec => ({ type: 'item', action, label, enabled, ...(accelerator ? { accelerator } : {}) });
  const sep: TabMenuSpec = { type: 'separator' };
  return [
    i('newTabRight', 'New tab to the right'),
    sep,
    i('reload', 'Reload', !t.blank, 'CmdOrCtrl+R'),
    i('duplicate', 'Duplicate', !t.blank),
    t.pinned ? i('unpin', 'Unpin') : i('pin', 'Pin'),
    t.muted ? i('unmute', 'Unmute site') : i('mute', 'Mute site'),
    sep,
    i('bookmark', t.bookmarked ? 'Remove bookmark' : 'Bookmark tab', !t.blank),
    i('copyAddress', 'Copy address', !t.blank),
    ...(t.window === 'main' ? [i('popOut', 'Open browser in its own window', true, 'CmdOrCtrl+Shift+N')] : []),
    ...(t.window === 'own' ? [i('popIn', 'Move browser back to the AICO window', true, 'CmdOrCtrl+Shift+N')] : []),
    sep,
    i('close', 'Close', true, 'CmdOrCtrl+W'),
    i('closeOthers', 'Close other tabs', t.count > 1),
    i('closeRight', 'Close tabs to the right', !t.isLast),
    sep,
    i('reopenClosed', 'Reopen closed tab', t.closedCount > 0, 'CmdOrCtrl+Shift+T'),
  ];
}
