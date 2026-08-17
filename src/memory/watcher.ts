import fs from 'fs';
import { invalidate } from './cache.js';

const _watchers = new Map<string, fs.FSWatcher>();

/**
 * Watch a memory file for changes and invalidate its cache entry on modification.
 * Safe on Windows — wraps all calls in try/catch.
 */
export function watchMemoryFile(filePath: string): void {
  if (_watchers.has(filePath)) return;
  try {
    const watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        invalidate(filePath);
      }
    });
    watcher.on('error', () => {
      // Silently ignore watch errors (e.g. file deleted)
      _watchers.delete(filePath);
    });
    _watchers.set(filePath, watcher);
  } catch {
    // fs.watch can throw on some platforms/paths — silently ignore
  }
}

/** Stop watching a specific file */
export function unwatchMemoryFile(filePath: string): void {
  const watcher = _watchers.get(filePath);
  if (watcher) {
    try { watcher.close(); } catch { /* ignore */ }
    _watchers.delete(filePath);
  }
}

/** Stop all active watchers — call on process exit */
export function stopMemoryWatcher(): void {
  for (const [, watcher] of _watchers) {
    try { watcher.close(); } catch { /* ignore */ }
  }
  _watchers.clear();
}

export function getWatchedFiles(): string[] {
  return Array.from(_watchers.keys());
}
