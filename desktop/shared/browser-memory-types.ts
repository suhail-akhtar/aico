/**
 * "Remember what I read" — the shapes main (electron/browser-memory*.ts) and
 * the chrome (renderer/src/browser/MemorySearch.tsx) exchange. Everything is
 * kept and searched on this device.
 *
 * Invoke channels:
 *
 *   browser:memory:status   ()                    → MemoryStatus
 *   browser:memory:set      ({ enabled })         → MemoryStatus (off by default)
 *   browser:memory:search   ({ query, since? })   → MemoryAnswer
 *   browser:memory:remove   (id)                  → MemoryStatus (forget one page)
 *   browser:memory:forget   ()                    → MemoryStatus (forget everything)
 *
 * @module desktop/shared/browser-memory-types
 */

export interface TimeWindow { since: number; until: number; label: string }

export interface MemoryHit { id: string; url: string; title: string; site: string; last: number; visits: number; snippet: string; score: number }

export interface MemoryAnswer {
  /** The query without its time phrase. */
  query: string;
  window: TimeWindow | null;
  /** Nothing matched inside the window, so these are from other times. */
  widened: boolean;
  hits: MemoryHit[];
  /** Pages remembered in all. */
  total: number;
}

export interface MemoryStatus {
  enabled: boolean;
  pages: number;
  bytes: number;
  /** Sealed with the OS keychain (false: this computer offers none, so files are plain). */
  encrypted: boolean;
  oldest: number | null;
}
