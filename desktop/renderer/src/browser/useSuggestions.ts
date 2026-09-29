/**
 * The page in front, as the copilot's suggestions see it: its signals (read
 * once per page load through `browser:pageSignals`), what kind of page it is
 * and the chips for it (suggest.ts).
 *
 * One reader for the window, subscribed to the browser store: a page is read
 * when it finishes loading (and again shortly after, for pages that build
 * themselves late), never while it is loading, and the result is kept per
 * address so switching tabs costs nothing.
 *
 * @module desktop/renderer/browser/useSuggestions
 */

import { create } from 'zustand';
import type { PageSignals } from '@desk/page-signals';
import { call } from './ipc';
import { useBrowser, activeTab } from './store';
import { pageSuggestions, type PageClass } from './suggest';
import type { QuickAction } from './context';

interface SignalsState { url: string; signals: PageSignals | null }

const useSignals = create<SignalsState>(() => ({ url: '', signals: null }));
const cache = new Map<string, PageSignals | null>();
let installed = false;
let timers: ReturnType<typeof setTimeout>[] = [];

function read(url: string): void {
  void call<PageSignals | null>('browser:pageSignals').then((s) => {
    const t = activeTab();
    if (!t || t.url !== url) return;
    const v = s ?? null;
    if (v) cache.set(url, v);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    useSignals.setState({ url, signals: v });
  }).catch(() => {});
}

function install(): void {
  if (installed) return;
  installed = true;
  let last = '';
  const check = (): void => {
    const t = activeTab();
    const url = t && /^https?:/i.test(t.url) ? t.url : '';
    const key = `${url}|${t?.loading ? 1 : 0}`;
    if (key === last) return;
    last = key;
    for (const x of timers) clearTimeout(x);
    timers = [];
    if (!url) { useSignals.setState({ url: '', signals: null }); return; }
    const hit = cache.get(url);
    useSignals.setState({ url, signals: hit ?? null });
    if (t!.loading) return;
    timers.push(setTimeout(() => read(url), hit ? 1500 : 350), setTimeout(() => read(url), 3000));
  };
  useBrowser.subscribe(check);
  check();
}

export function usePageSignals(): PageSignals | null {
  install();
  return useSignals(s => s.signals);
}

/** The kind of the page in front and the copilot's chips for it (empty for a plain page). */
export function usePageSuggestions(max = 4): { page: PageClass; chips: QuickAction[]; signals: PageSignals | null } {
  const signals = usePageSignals();
  const { page, chips } = pageSuggestions(signals, max);
  return { page, chips, signals };
}
