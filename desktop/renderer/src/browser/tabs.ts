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
