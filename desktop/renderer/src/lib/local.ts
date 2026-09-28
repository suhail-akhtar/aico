/**
 * Small per-window memories kept in localStorage: which folders are open in
 * the sidebar, which chats have been read. Wrapped because storage can throw
 * (a full or disabled profile), and none of this is worth crashing over.
 * @module desktop/renderer/lib/local
 */

import { useCallback, useState } from 'react';

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
}

export function writeJSON(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not worth failing for */ }
}

/** useState that survives a reload. */
export function useLocal<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readJSON(key, initial));
  const set = useCallback((v: T | ((prev: T) => T)) => {
    setValue(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      writeJSON(key, next);
      return next;
    });
  }, [key]);
  return [value, set];
}

const SEEN_KEY = 'desk.seen';
let seen: Record<string, number> = readJSON(SEEN_KEY, {});

/** Mark a chat read up to its latest update. */
export function markSeen(id: string, at = Date.now()): void {
  seen = { ...seen, [id]: Math.max(seen[id] ?? 0, at) };
  writeJSON(SEEN_KEY, seen);
}

/** Unread means it changed since you last looked — and you have looked at it before, or it is new. */
export function isUnread(id: string, updatedAt: number): boolean {
  const s = seen[id];
  return s !== undefined ? updatedAt > s + 1500 : false;
}

export function seenAt(id: string): number | undefined { return seen[id]; }
