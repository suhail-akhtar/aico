/**
 * The browser chrome's state: the tabs main reports, the prompts it raises,
 * downloads, what the agent is doing, and the chrome's own pages (new tab,
 * history, bookmarks, reader) and panels.
 *
 * One store for the window, subscribed to main once, so the full-size browser
 * and the side dock show the same thing and a prompt raised while neither is
 * on screen is not lost.
 *
 * @module desktop/renderer/browser/store
 */

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { on } from '@/desktop';
import { useDesk, go } from '@/state/desk';
import { call, fire, useMissing } from './ipc';
import { isBlankUrl } from './urls';
import { agentBusy, fromLegacy, isCertError, tabError } from './tabs';
import { installProtect } from './protect';
import { installLearnReporter } from './ForYouLearn';

export { agentBusy, fromLegacy, isCertError, tabError };
import type {
  AgentEvent, AuthPrompt, Bookmark, BrowserState, ConfirmPrompt, DialogPrompt, DownloadItem,
  HandoffPrompt, LegacyTab, PermissionPrompt, ReadResult, TabError, TabState,
} from './types';

export type InternalPage = 'history' | 'bookmarks' | 'downloads' | 'insights' | 'privacy' | 'passwords';

interface BrowserStore {
  state: BrowserState;
  /** Main speaks the full contract (`browser:state`), not only the old tab list. */
  modern: boolean;
  loaded: boolean;

  permissions: PermissionPrompt[];
  dialogs: DialogPrompt[];
  auths: AuthPrompt[];
  confirms: ConfirmPrompt[];
  handoff: HandoffPrompt | null;

  downloads: DownloadItem[];
  bookmarks: Bookmark[];

  /** The last thing the agent did in the browser, and when. */
  agent: { event: AgentEvent | null; at: number };
  /** An older main only says "the agent touched the browser" (`browser:agent-active`), with a time. */
  legacyAgentAt: number;
  /** The person took the wheel; the agent is paused until they hand it back. */
  takenOver: boolean;

  /** Errors reported by an older main that has no `TabState.error`. */
  legacyErrors: Record<string, TabError>;

  find: { open: boolean; text: string; matches: number; active: number };
  /** A chrome page shown in place of the active tab's page. */
  internal: { tabId: string | null; page: InternalPage } | null;
  reader: { tabId: string; url: string; loading: boolean; data: ReadResult | null; error?: string } | null;
  downloadsOpen: boolean;
  focusOmnibox: number;
}

const EMPTY: BrowserState = { activeId: null, tabs: [], blocking: { enabled: true } };

export const useBrowser = create<BrowserStore>(() => ({
  state: EMPTY,
  modern: false,
  loaded: false,
  permissions: [],
  dialogs: [],
  auths: [],
  confirms: [],
  handoff: null,
  downloads: [],
  bookmarks: [],
  agent: { event: null, at: 0 },
  legacyAgentAt: 0,
  takenOver: false,
  legacyErrors: {},
  find: { open: false, text: '', matches: 0, active: 0 },
  internal: null,
  reader: null,
  downloadsOpen: false,
  focusOmnibox: 0,
}));

export function activeTab(s: { state: BrowserState } = useBrowser.getState()): TabState | undefined {
  return s.state.tabs.find(t => t.id === s.state.activeId);
}

export function useActiveTab(): TabState | undefined {
  return useBrowser(s => s.state.tabs.find(t => t.id === s.state.activeId));
}

function setState(next: BrowserState): void {
  const prev = useBrowser.getState();
  const patch: Partial<BrowserStore> = { state: next, loaded: true };
  // Main says whether the agent is stopped (Stop / Take over hold until resumed).
  if (typeof next.agentStopped === 'boolean') patch.takenOver = next.agentStopped;
  // A chrome page or reader view belongs to the tab it was opened on and the page it showed.
  const active = next.tabs.find(t => t.id === next.activeId);
  if (prev.internal && prev.internal.tabId !== next.activeId) patch.internal = null;
  if (prev.reader && (prev.reader.tabId !== next.activeId || (active && active.url !== prev.reader.url && !active.loading))) patch.reader = null;
  if (prev.internal && active && prev.internal.tabId === active.id) {
    const before = prev.state.tabs.find(t => t.id === active.id);
    if (before && before.url !== active.url && !isBlankUrl(active.url)) patch.internal = null;
  }
  // Prompts for tabs that are gone are moot.
  const ids = new Set(next.tabs.map(t => t.id));
  if (prev.permissions.some(p => !ids.has(p.tabId))) patch.permissions = prev.permissions.filter(p => ids.has(p.tabId));
  if (prev.dialogs.some(p => !ids.has(p.tabId))) patch.dialogs = prev.dialogs.filter(p => ids.has(p.tabId));
  if (prev.auths.some(p => !ids.has(p.tabId))) patch.auths = prev.auths.filter(p => ids.has(p.tabId));
  useBrowser.setState(patch);
}

export async function refreshState(): Promise<void> {
  try {
    const s = await call<BrowserState>('browser:state');
    if (s) { useBrowser.setState({ modern: true }); setState(s); return; }
    const tabs = await call<LegacyTab[]>('browser:tabs');
    if (tabs) setState(fromLegacy(tabs));
  } catch { /* the pane shows "Opening…" until main answers */ }
}

export async function refreshBookmarks(): Promise<Bookmark[]> {
  const list = await call<Bookmark[]>('browser:bookmarks:list').catch(() => undefined);
  if (list) useBrowser.setState({ bookmarks: list });
  return list ?? useBrowser.getState().bookmarks;
}

export async function refreshDownloads(): Promise<void> {
  const list = await call<DownloadItem[]>('browser:downloads:list').catch(() => undefined);
  if (list) useBrowser.setState({ downloads: list });
}

/**
 * Make sure a prompt can be seen. A hand-over opens the side dock beside the
 * chat (the agent is waiting on it); anything else says so in a notice with a
 * way to get there, rather than pulling you away from what you were doing.
 */
function reveal(what?: string): void {
  const d = useDesk.getState();
  if (d.route.view === 'browser' || d.dock.open) return;
  if (!what) { d.setDock({ open: true }); return; }
  d.toast({ kind: 'warning', title: 'The browser needs you', body: what, ttl: 12_000, action: { label: 'Show', run: () => go('browser') } });
}

let installed = false;
let stillAt = 0;

/** The chrome is about to take a still of the page — an older main reports that as agent activity, which it is not. */
export function noteStill(): void { stillAt = Date.now(); }

/** Subscribe to main once for the window's lifetime. */
export function installBrowserStore(): void {
  if (installed) return;
  installed = true;
  const push = <K extends 'permissions' | 'dialogs' | 'auths' | 'confirms'>(key: K, item: BrowserStore[K][number], what: string): void => {
    useBrowser.setState(s => ({ [key]: [...(s[key] as Array<{ id: string }>).filter(p => p.id !== (item as { id: string }).id), item] } as Partial<BrowserStore>));
    reveal(what);
  };
  const site = (tabId: string): string => {
    const t = useBrowser.getState().state.tabs.find(x => x.id === tabId);
    try { return t ? new URL(t.url).host : 'A page'; } catch { return 'A page'; }
  };
  on<BrowserState>('browser:state', (s) => { useBrowser.setState({ modern: true }); setState(s); });
  on<LegacyTab[]>('browser:tabs', (tabs) => { if (!useBrowser.getState().modern) setState(fromLegacy(tabs)); });
  on<PermissionPrompt>('browser:permission', (p) => push('permissions', p, `${p.origin} is asking for a permission.`));
  on<DialogPrompt>('browser:dialog', (p) => push('dialogs', p, `${site(p.tabId)} is showing a message.`));
  on<AuthPrompt>('browser:auth', (p) => push('auths', p, `${p.host} asks you to sign in.`));
  on<ConfirmPrompt>('browser:confirm', (p) => push('confirms', p, p.title));
  on<HandoffPrompt>('browser:handoff', (h) => {
    // The page must be live and in front: no chrome page, reader or still over it.
    useBrowser.setState({ handoff: h, internal: null, reader: null, takenOver: false });
    reveal();
    window.dispatchEvent(new Event('aico:browser-handoff'));
  });
  on<DownloadItem | { file: string; state: string }>('browser:download', (d) => {
    if ('id' in d) {
      useBrowser.setState(s => {
        const rest = s.downloads.filter(x => x.id !== d.id);
        return { downloads: [d, ...rest].sort((a, b) => b.startedAt - a.startedAt) };
      });
      if (d.state === 'completed' || d.state === 'interrupted') {
        const ok = d.state === 'completed';
        useDesk.getState().toast({
          kind: ok ? 'success' : 'warning', title: ok ? 'Download complete' : 'Download failed', body: d.filename,
          ...(ok ? { action: { label: 'Show in folder', run: () => fire('browser:downloads:show', d.id) } } : {}),
        });
      }
    } else {
      useDesk.getState().toast({ kind: d.state === 'completed' ? 'success' : 'warning', title: d.state === 'completed' ? 'Downloaded' : 'Download failed', body: d.file });
    }
  });
  on<AgentEvent>('browser:agent', (ev) => {
    useBrowser.setState({ agent: { event: ev, at: Date.now() } });
  });
  on<{ at: number }>('browser:agent-active', (e) => {
    // Main that speaks the full contract says this per tab (`agentActive`) and per action (`browser:agent`).
    if (useBrowser.getState().modern || Date.now() - stillAt < 3000) return;
    useBrowser.setState({ legacyAgentAt: e?.at ?? Date.now() });
  });
  on<{ matches: number; active: number }>('browser:found', (f) => {
    useBrowser.setState(s => ({ find: { ...s.find, matches: f.matches, active: f.active } }));
  });
  on<{ id: string; url: string; message: string }>('browser:error', (e) => {
    // A main that speaks the full contract reports errors on the tab (and clears them); this map would outlive a successful reload.
    if (useBrowser.getState().modern) return;
    const code = Number(e.message.match(/\((-?\d+)\)\s*$/)?.[1] ?? -2);
    const description = e.message.replace(/\s*\(-?\d+\)\s*$/, '');
    useBrowser.setState(s => ({ legacyErrors: { ...s.legacyErrors, [e.id]: { code, description, url: e.url } } }));
  });
  on('browser:focus-address', () => useBrowser.setState(s => ({ focusOmnibox: s.focusOmnibox + 1 })));
  void refreshState();
  void refreshBookmarks();
  void refreshDownloads();
  installProtect();
  installLearnReporter();
}

// ── Verbs used from the chrome, the menus and the keyboard ──

export function newTab(url?: string): void {
  useBrowser.setState({ internal: null, reader: null });
  fire('browser:newTab', url ?? 'about:blank');
}

export function openUrl(url: string, newTabToo = false): void {
  useBrowser.setState({ internal: null, reader: null });
  fire('browser:open', url, newTabToo);
}

export function closeTab(id?: string): void {
  const s = useBrowser.getState();
  const target = id ?? s.state.activeId;
  if (target) fire('browser:close', target);
}

export function cycleTab(dir: 1 | -1): void {
  const { state } = useBrowser.getState();
  if (state.tabs.length < 2) return;
  const i = state.tabs.findIndex(t => t.id === state.activeId);
  const next = state.tabs[(i + dir + state.tabs.length) % state.tabs.length]!;
  fire('browser:select', next.id);
}

export function showInternal(page: InternalPage | null): void {
  const s = useBrowser.getState();
  useBrowser.setState({ internal: page ? { tabId: s.state.activeId, page } : null, reader: null });
}

export async function toggleBookmark(tab: TabState | undefined = activeTab()): Promise<boolean | undefined> {
  if (!tab || isBlankUrl(tab.url)) return undefined;
  const marks = useBrowser.getState().bookmarks;
  const had = marks.some(b => b.url === tab.url);
  const res = had
    ? await call('browser:bookmarks:remove', tab.url)
    : await call('browser:bookmarks:add', { url: tab.url, title: tab.title, favicon: tab.favicon });
  if (res === undefined && useMissing.getState().missing[had ? 'browser:bookmarks:remove' : 'browser:bookmarks:add']) return undefined;
  await refreshBookmarks();
  return !had;
}

export async function toggleReader(): Promise<void> {
  const s = useBrowser.getState();
  const tab = activeTab(s);
  if (!tab) return;
  if (s.reader) { useBrowser.setState({ reader: null }); return; }
  useBrowser.setState({ reader: { tabId: tab.id, url: tab.url, loading: true, data: null }, internal: null });
  try {
    const data = await call<ReadResult>('browser:read', { mode: 'reader', maxChars: 200_000 });
    if (useBrowser.getState().reader?.tabId !== tab.id) return;
    useBrowser.setState({ reader: { tabId: tab.id, url: tab.url, loading: false, data: data ?? null, error: data ? undefined : 'Reader mode is not available in this version.' } });
  } catch (err) {
    if (useBrowser.getState().reader?.tabId !== tab.id) return;
    useBrowser.setState({ reader: { tabId: tab.id, url: tab.url, loading: false, data: null, error: (err as Error).message } });
  }
}

export function openFind(): void {
  useBrowser.setState(s => ({ find: { ...s.find, open: true } }));
  window.dispatchEvent(new Event('aico:browser-find'));
}

export function closeFind(): void {
  useBrowser.setState(s => ({ find: { ...s.find, open: false, matches: 0, active: 0 } }));
  fire('browser:findStop');
}

export async function runFind(text: string, forward = true, findNext = false): Promise<void> {
  useBrowser.setState(s => ({ find: { ...s.find, text } }));
  if (!text) { fire('browser:findStop'); useBrowser.setState(s => ({ find: { ...s.find, matches: 0, active: 0 } })); return; }
  const r = await call<{ matches: number; active: number }>('browser:find', { text, forward, findNext }).catch(() => undefined);
  if (r) useBrowser.setState(s => ({ find: { ...s.find, matches: r.matches, active: r.active } }));
}

export function agentStop(): void {
  fire('browser:agentStop');
}

export function takeOver(): void {
  fire('browser:agentStop');
  useBrowser.setState({ takenOver: true });
}

export function letAgentContinue(): void {
  fire('browser:agentResume');
  useBrowser.setState({ takenOver: false });
}

/**
 * Whether the agent is busy in the browser, re-checked every second while it
 * is: "recent" is a matter of time passing, which no store change announces.
 */
export function useAgentBusy(): boolean {
  const [, tick] = useState(0);
  const busy = useBrowser(s => agentBusy(s));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  return busy;
}
