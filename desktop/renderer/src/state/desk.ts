/**
 * The desktop's own interface state.
 *
 * Conversations, sessions, projects, runs and settings live in the shared
 * store (`@web/store`) — the same one the browser client and the VS Code panel
 * use. This store holds only what belongs to the window: where you are and how
 * you got there (back/forward), the engine's health, prefs, toasts, overlays,
 * and the activity feed of background work.
 *
 * @module desktop/renderer/state/desk
 */

import { create } from 'zustand';
import { DEFAULT_PREFS, type DesktopPrefs } from '@desk/prefs';
import { desktop, type AppInfo, type EngineState } from '@/desktop';

export interface Route {
  view: string;
  params?: Record<string, string>;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
  /** ms; 0 keeps it until dismissed. */
  ttl: number;
}

export interface ActivityItem {
  id: string;
  kind: 'turn' | 'task' | 'job' | 'app' | 'browser' | 'git' | 'terminal' | 'plugin' | 'system';
  title: string;
  detail?: string;
  status: 'running' | 'done' | 'failed' | 'waiting';
  startedAt: number;
  endedAt?: number;
  progress?: number;
  /** Where clicking it goes. */
  route?: Route;
}

export type SettingsSection = string;

interface DeskState {
  route: Route;
  back: Route[];
  forward: Route[];
  navigate: (route: Route, opts?: { replace?: boolean }) => void;
  goBack: () => void;
  goForward: () => void;

  info: AppInfo | null;
  engine: EngineState;
  prefs: DesktopPrefs;
  mode: 'light' | 'dark';
  setMode: (mode: 'light' | 'dark') => void;
  setPrefs: (patch: Partial<DesktopPrefs>) => Promise<void>;
  loadPrefs: () => Promise<void>;

  toasts: Toast[];
  toast: (t: Omit<Toast, 'id' | 'ttl'> & { ttl?: number }) => number;
  dismissToast: (id: number) => void;

  paletteOpen: boolean;
  setPalette: (open: boolean) => void;
  searchOpen: boolean;
  setSearch: (open: boolean) => void;
  settings: SettingsSection | null;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;

  activity: ActivityItem[];
  upsertActivity: (item: ActivityItem) => void;
  clearFinishedActivity: () => void;

  /** Bottom panel (terminal/output), shared by several views. */
  panel: { open: boolean; tab: string; height: number };
  setPanel: (patch: Partial<DeskState['panel']>) => void;
  /** Right-hand browser/preview dock beside chat. */
  dock: { open: boolean; view: string; width: number };
  setDock: (patch: Partial<DeskState['dock']>) => void;
}

let toastSeq = 1;
const HISTORY_LIMIT = 50;

function same(a: Route, b: Route): boolean {
  return a.view === b.view && JSON.stringify(a.params ?? {}) === JSON.stringify(b.params ?? {});
}

export const useDesk = create<DeskState>((set, get) => ({
  route: { view: 'home' },
  back: [],
  forward: [],
  navigate: (route, opts) => {
    const cur = get().route;
    if (same(cur, route)) return;
    if (opts?.replace) { set({ route }); return; }
    set({ route, back: [...get().back, cur].slice(-HISTORY_LIMIT), forward: [] });
  },
  goBack: () => {
    const { back, route, forward } = get();
    const prev = back[back.length - 1];
    if (!prev) return;
    set({ route: prev, back: back.slice(0, -1), forward: [route, ...forward] });
  },
  goForward: () => {
    const { back, route, forward } = get();
    const next = forward[0];
    if (!next) return;
    set({ route: next, back: [...back, route], forward: forward.slice(1) });
  },

  info: null,
  engine: { status: 'starting', attempt: 1 },
  prefs: DEFAULT_PREFS,
  mode: 'light',
  setMode: (mode) => set({ mode }),
  setPrefs: async (patch) => {
    // Optimistic: the screen should move when the control does.
    set({ prefs: { ...get().prefs, ...patch } as DesktopPrefs });
    try {
      const next = await desktop.prefs.set(patch);
      set({ prefs: next });
    } catch { /* offline preview: keep the local value */ }
  },
  loadPrefs: async () => {
    try { set({ prefs: await desktop.prefs.get() }); } catch { /* defaults */ }
  },

  toasts: [],
  toast: (t) => {
    const id = toastSeq++;
    const ttl = t.ttl ?? (t.kind === 'error' ? 9000 : 4500);
    set({ toasts: [...get().toasts.slice(-4), { ...t, id, ttl }] });
    if (ttl > 0) setTimeout(() => get().dismissToast(id), ttl);
    return id;
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter(t => t.id !== id) }),

  paletteOpen: false,
  setPalette: (open) => set({ paletteOpen: open }),
  searchOpen: false,
  setSearch: (open) => set({ searchOpen: open }),
  settings: null,
  openSettings: (section) => set({ settings: section ?? 'general' }),
  closeSettings: () => set({ settings: null }),

  activity: [],
  upsertActivity: (item) => {
    const list = get().activity.filter(a => a.id !== item.id);
    set({ activity: [item, ...list].slice(0, 200) });
  },
  clearFinishedActivity: () => set({ activity: get().activity.filter(a => a.status === 'running' || a.status === 'waiting') }),

  panel: { open: false, tab: 'terminal', height: 280 },
  setPanel: (patch) => set({ panel: { ...get().panel, ...patch } }),
  dock: { open: false, view: 'browser', width: 520 },
  setDock: (patch) => set({ dock: { ...get().dock, ...patch } }),
}));

/** Shorthand used all over: `toast.error('Could not save', err.message)`. */
export const toast = {
  info: (title: string, body?: string) => useDesk.getState().toast({ kind: 'info', title, body }),
  success: (title: string, body?: string) => useDesk.getState().toast({ kind: 'success', title, body }),
  warning: (title: string, body?: string) => useDesk.getState().toast({ kind: 'warning', title, body }),
  error: (title: string, body?: string) => useDesk.getState().toast({ kind: 'error', title, body }),
};

export function go(view: string, params?: Record<string, string>): void {
  useDesk.getState().navigate({ view, params });
}
