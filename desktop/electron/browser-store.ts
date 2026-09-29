/**
 * The built-in browser's own records — history, bookmarks, and its settings
 * (tracker blocking, per-site zoom and permissions) — as pure list operations
 * plus a small debounced JSON file. No Electron here, so all of it is tested.
 *
 * Files live in `<AICO_HOME>/desktop/browser/`: history.json, bookmarks.json,
 * settings.json, downloads.json.
 *
 * @module desktop/electron/browser-store
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Bookmark, BookmarkInput, HistoryEntry, PermissionSetting } from '../shared/browser-types';

export const HISTORY_CAP = 5000;

/** Pages that are not history: blank tabs, inline documents, the app itself. */
export function isRecordable(url: string): boolean {
  if (!url) return false;
  return !/^(about|data|aico|blob|javascript|chrome|chrome-extension|devtools|view-source|file):/i.test(url);
}

/** The key a visit is counted under: the URL without its #fragment. */
export function historyKey(url: string): string {
  const i = url.indexOf('#');
  return i >= 0 ? url.slice(0, i) : url;
}

/** Record one visit: de-duplicated per URL (visits + lastVisit), newest first, capped. */
export function recordVisit(list: HistoryEntry[], visit: { url: string; title?: string; favicon?: string }, now: number, cap = HISTORY_CAP): HistoryEntry[] {
  if (!isRecordable(visit.url)) return list;
  const key = historyKey(visit.url);
  const prev = list.find(e => e.url === key);
  const entry: HistoryEntry = {
    url: key,
    title: visit.title?.trim() || prev?.title || key,
    ...(visit.favicon || prev?.favicon ? { favicon: visit.favicon || prev?.favicon } : {}),
    visits: (prev?.visits ?? 0) + 1,
    lastVisit: now,
  };
  const rest = list.filter(e => e.url !== key);
  const next = [entry, ...rest];
  if (next.length > cap) {
    next.sort((a, b) => b.lastVisit - a.lastVisit);
    next.length = cap;
  }
  return next;
}

/** Update the title / icon of an entry without counting a visit (titles arrive after the navigation). */
export function touchVisit(list: HistoryEntry[], url: string, patch: { title?: string; favicon?: string }): HistoryEntry[] {
  const key = historyKey(url);
  let changed = false;
  const next = list.map(e => {
    if (e.url !== key) return e;
    const title = patch.title?.trim() || e.title;
    const favicon = patch.favicon || e.favicon;
    if (title === e.title && favicon === e.favicon) return e;
    changed = true;
    return { ...e, title, ...(favicon ? { favicon } : {}) };
  });
  return changed ? next : list;
}

/** Search: every word must appear in the title or URL; ranked by recency and visit count. */
export function searchHistory(list: HistoryEntry[], query?: string, limit = 100): HistoryEntry[] {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length
    ? list.filter(e => { const hay = `${e.title} ${e.url}`.toLowerCase(); return words.every(w => hay.includes(w)); })
    : [...list];
  if (words.length) {
    const now = Math.max(0, ...hits.map(h => h.lastVisit));
    const score = (e: HistoryEntry): number => {
      const ageDays = (now - e.lastVisit) / 86_400_000;
      const titleHit = words.every(w => e.title.toLowerCase().includes(w)) ? 2 : 0;
      const hostHit = words.some(w => { try { return new URL(e.url).hostname.includes(w); } catch { return false; } }) ? 3 : 0;
      return Math.log2(1 + e.visits) + titleHit + hostHit - Math.min(10, ageDays / 7);
    };
    hits.sort((a, b) => score(b) - score(a) || b.lastVisit - a.lastVisit);
  } else {
    hits.sort((a, b) => b.lastVisit - a.lastVisit);
  }
  return hits.slice(0, Math.max(1, Math.min(limit, 5000)));
}

/** Clear visits at or after `sinceMs` (everything when omitted). */
export function clearHistory(list: HistoryEntry[], sinceMs?: number): HistoryEntry[] {
  if (sinceMs === undefined || sinceMs === null || !Number.isFinite(sinceMs) || sinceMs <= 0) return [];
  return list.filter(e => e.lastVisit < sinceMs);
}

export function removeHistory(list: HistoryEntry[], url: string): HistoryEntry[] {
  const key = historyKey(url);
  return list.filter(e => e.url !== key && e.url !== url);
}

// ── Bookmarks ──

export function addBookmark(list: Bookmark[], b: BookmarkInput, now: number): Bookmark[] {
  if (!b || typeof b.url !== 'string' || !b.url.trim()) throw new Error('A bookmark needs a URL.');
  const url = b.url.trim();
  const prev = list.find(x => x.url === url);
  const entry: Bookmark = {
    url,
    title: (b.title ?? '').trim() || prev?.title || url,
    ...(b.favicon || prev?.favicon ? { favicon: b.favicon || prev?.favicon } : {}),
    addedAt: prev?.addedAt ?? now,
    ...(b.folder?.trim() || prev?.folder ? { folder: b.folder?.trim() || prev?.folder } : {}),
  };
  return prev ? list.map(x => (x.url === url ? entry : x)) : [...list, entry];
}

export function removeBookmark(list: Bookmark[], url: string): Bookmark[] {
  return list.filter(b => b.url !== url);
}

// ── Settings ──

export interface BrowserSettings {
  blocking: { enabled: boolean; allowOrigins: string[] };
  /** Zoom factor remembered per origin (1 is not stored). */
  zoom: Record<string, number>;
  /** Remembered permission answers: origin → permission → allow/deny. */
  permissions: Record<string, Record<string, Exclude<PermissionSetting, 'ask'>>>;
}

export const DEFAULT_SETTINGS: BrowserSettings = { blocking: { enabled: true, allowOrigins: [] }, zoom: {}, permissions: {} };

export function normaliseSettings(raw: unknown): BrowserSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<BrowserSettings>;
  const blocking = r.blocking && typeof r.blocking === 'object' ? r.blocking : DEFAULT_SETTINGS.blocking;
  const zoom: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.zoom ?? {})) if (typeof v === 'number' && v >= 0.25 && v <= 5 && v !== 1) zoom[k] = v;
  const permissions: BrowserSettings['permissions'] = {};
  for (const [origin, perms] of Object.entries(r.permissions ?? {})) {
    if (!perms || typeof perms !== 'object') continue;
    const clean: Record<string, 'allow' | 'deny'> = {};
    for (const [p, v] of Object.entries(perms)) if (v === 'allow' || v === 'deny') clean[p] = v;
    if (Object.keys(clean).length) permissions[origin] = clean;
  }
  return {
    blocking: {
      enabled: typeof blocking.enabled === 'boolean' ? blocking.enabled : true,
      allowOrigins: Array.isArray(blocking.allowOrigins) ? [...new Set(blocking.allowOrigins.filter((o): o is string => typeof o === 'string'))] : [],
    },
    zoom,
    permissions,
  };
}

// ── A JSON file written after changes settle ──

export class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null;
  private value: T;

  constructor(private readonly file: string, fallback: T, normalise: (raw: unknown) => T = (r) => (r ?? fallback) as T, private readonly delayMs = 800) {
    let raw: unknown = undefined;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run, or a damaged file: start clean */ }
    try { this.value = raw === undefined ? fallback : normalise(raw); } catch { this.value = fallback; }
  }

  get(): T { return this.value; }

  set(next: T): void {
    this.value = next;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.value));
      fs.renameSync(tmp, this.file);
    } catch { /* best effort: the next change writes again */ }
  }
}

export function asArray<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}
