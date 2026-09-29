/**
 * Pure rules about tabs: reading an older main's tab list, which error a tab
 * shows, and whether the agent is busy. Unit-tested without a DOM.
 *
 * @module desktop/renderer/browser/tabs
 */

import type { AgentEvent, BrowserState, LegacyTab, TabError, TabState } from './types';

/** Guess what an older main does not say, so the chrome can treat both the same. */
export function fromLegacy(tabs: LegacyTab[]): BrowserState {
  return {
    activeId: tabs.find(t => t.active)?.id ?? tabs[0]?.id ?? null,
    tabs: tabs.map(t => ({
      id: t.id, url: t.url, title: t.title, favicon: t.favicon, loading: t.loading,
      canGoBack: t.canGoBack, canGoForward: t.canGoForward, zoom: t.zoom,
      audible: false, muted: false, trackersBlocked: 0, agentActive: false, humanCheck: false,
      security: /^https:/.test(t.url) ? 'secure' : /^http:/.test(t.url) ? 'insecure' : 'internal',
    })),
    blocking: { enabled: false },
  };
}

/** The error a tab is showing, from main's state or from an older main's event. */
export function tabError(tab: TabState | undefined, legacy: Record<string, TabError>): TabError | undefined {
  if (!tab) return undefined;
  if (tab.error) return tab.error;
  const e = legacy[tab.id];
  return e && e.url === tab.url && !tab.loading ? e : undefined;
}

/** Chromium's certificate errors are -200 … -299. */
export function isCertError(e: TabError | undefined): boolean {
  return Boolean(e && e.code <= -200 && e.code > -300);
}

/** Is the agent working in the browser right now (from main's flag, or its recent actions)? */
export function agentBusy(s: { agent: { event: AgentEvent | null; at: number }; state: BrowserState; legacyAgentAt: number }, now = Date.now()): boolean {
  if (s.state.tabs.some(t => t.agentActive)) return true;
  if (now - s.legacyAgentAt < 8000) return true;
  const ev = s.agent.event;
  if (!ev) return false;
  const age = now - s.agent.at;
  return ev.status === 'start' ? age < 20_000 : age < 4_000;
}

// ── The strip: order, pinning, dragging ──

/** Ctrl+1 … Ctrl+8 pick that tab; Ctrl+9 is always the last one. */
export function tabForDigit(ids: string[], digit: number): string | null {
  if (!ids.length || digit < 1 || digit > 9) return null;
  return digit === 9 ? ids[ids.length - 1]! : ids[digit - 1] ?? null;
}

/** Where Ctrl+Shift+PgUp/PgDn moves the tab in front (null at its group's edge — pinned tabs stay among pinned ones). */
export function moveTarget(tabs: Array<{ id: string; pinned?: boolean }>, activeId: string | null, dir: -1 | 1): number | null {
  const i = tabs.findIndex(t => t.id === activeId);
  if (i < 0) return null;
  const pinned = Boolean(tabs[i]!.pinned);
  const j = i + dir;
  if (j < 0 || j >= tabs.length || Boolean(tabs[j]!.pinned) !== pinned) return null;
  return j;
}

/**
 * Where a dragged tab lands: the index (in the order without it) whose slot
 * the pointer is over, from the other tabs' boxes. A tab stays within its
 * group, as `browser:move` enforces too.
 */
export function dropIndex(boxes: Array<{ id: string; left: number; width: number; pinned?: boolean }>, draggedId: string, x: number): number {
  const dragged = boxes.find(b => b.id === draggedId);
  const rest = boxes.filter(b => b.id !== draggedId);
  let i = 0;
  while (i < rest.length && x > rest[i]!.left + rest[i]!.width / 2) i++;
  const pinnedCount = rest.filter(b => b.pinned).length;
  return dragged?.pinned ? Math.min(i, pinnedCount) : Math.max(i, pinnedCount);
}

/** The strip order while dragging: the dragged tab shown at `to`. */
export function previewOrder<T extends { id: string }>(tabs: T[], draggedId: string, to: number): T[] {
  const d = tabs.find(t => t.id === draggedId);
  if (!d) return tabs;
  const rest = tabs.filter(t => t.id !== draggedId);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), d, ...rest.slice(at)];
}
