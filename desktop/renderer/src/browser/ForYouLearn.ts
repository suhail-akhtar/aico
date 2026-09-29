/**
 * The chrome's side of browsing intelligence (electron/browser-learn.ts):
 *
 *   - the reporter: when the page in front settles, the copilot's page
 *     classifier (suggest.ts) names what kind of page it is, and main is told
 *     the kind and its length — so the model knows an article from a cart
 *     without main reading pages twice or keeping any of their text;
 *   - the learned view, one store for the new tab page and Insights, with the
 *     verbs its cards use (open, "Not interested", forget, pause, tidy tabs).
 *
 * @module desktop/renderer/browser/ForYouLearn
 */

import { create } from 'zustand';
import type { PageSignals } from '@desk/page-signals';
import type { LearnCleanup, LearnItem, LearnView } from '@desk/browser-learn-types';
import { call, fire } from './ipc';
import { activeTab, openUrl, useBrowser } from './store';
import { classifyPage } from './suggest';

let installed = false;

/** Tell main what kind of page is in front, once per page, after it settles. */
export function installLearnReporter(): void {
  if (installed) return;
  installed = true;
  let reported = '';
  let pending = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    const t = activeTab();
    const url = t && !t.loading && /^https?:/i.test(t.url) && !t.threat ? t.url : '';
    if (url === pending || url === reported) return;
    pending = url;
    clearTimeout(timer);
    if (!url) return;
    timer = setTimeout(() => {
      void call<PageSignals | null>('browser:pageSignals').then((s) => {
        const now = activeTab();
        if (!s || !now || now.url !== url) return;
        reported = url;
        fire('browser:learn:page', { url, kind: classifyPage(s).kind, words: s.text.words });
      }).catch(() => {}).finally(() => { if (pending === url) pending = ''; });
    }, 1500);
  };
  useBrowser.subscribe(check);
  check();
  // Tabs opened or closed (by you, a card, or the agent tidying them): a shown For-you view is out of date.
  let tabsKey = '';
  let refresh: ReturnType<typeof setTimeout> | undefined;
  useBrowser.subscribe((s) => {
    const k = s.state.tabs.map(t => t.id).join(',');
    if (k === tabsKey) return;
    const had = tabsKey;
    tabsKey = k;
    if (!had || !useLearn.getState().view) return;
    clearTimeout(refresh);
    refresh = setTimeout(() => void refreshLearn(), 600);
  });
}

// ── The learned view ──

interface LearnStore { view: LearnView | null | undefined; loadedAt: number }
export const useLearn = create<LearnStore>(() => ({ view: undefined, loadedAt: 0 }));

export async function refreshLearn(): Promise<void> {
  const v = await call<LearnView>('browser:learn:view').catch(() => undefined);
  useLearn.setState({ view: v ?? null, loadedAt: Date.now() });
}

/** Apply a changed view main handed back (remove, exclude, pause, forget). */
const take = (v: LearnView | undefined): void => { if (v) useLearn.setState({ view: v, loadedAt: Date.now() }); };

export function openItem(item: LearnItem): void {
  fire('browser:learn:feedback', { id: item.id, action: 'open' });
  const a = item.action;
  if (a.type === 'tab' && a.tabId) { useBrowser.setState({ internal: null, reader: null }); fire('browser:select', a.tabId); return; }
  if (a.url) openUrl(a.url);
}

/** "Not interested": gone from the cards now, and weighted down from here on. */
export function dismiss(id: string): void {
  const v = useLearn.getState().view;
  if (v) {
    const drop = <T extends { id: string }>(xs: T[]): T[] => xs.filter(x => x.id !== id);
    useLearn.setState({
      view: {
        ...v, priorities: drop(v.priorities), unfinished: drop(v.unfinished), routines: drop(v.routines), threads: drop(v.threads),
        next: v.next.filter(n => `next:${n.site}` !== id), cleanup: id === 'cleanup:idle' ? null : v.cleanup,
      },
    });
  }
  void call('browser:learn:feedback', { id, action: 'dismiss' }).then(() => refreshLearn()).catch(() => {});
}

export async function removeLearned(id: string): Promise<void> { take(await call<LearnView>('browser:learn:remove', id).catch(() => undefined)); }
export async function setExcludedSite(site: string, on: boolean): Promise<void> { take(await call<LearnView>('browser:learn:exclude', site, on).catch(() => undefined)); }
export async function setLearningPaused(paused: boolean): Promise<void> { take(await call<LearnView>('browser:learn:pause', paused).catch(() => undefined)); }
export async function forgetLearning(): Promise<void> { take(await call<LearnView>('browser:learn:forget').catch(() => undefined)); }

export async function tidyTabs(o: LearnCleanup): Promise<{ closed: number; bookmarked: number; folder?: string } | undefined> {
  const r = await call<{ closed: number; bookmarked: number; folder?: string }>('browser:learn:cleanup', o);
  void refreshLearn();
  return r;
}
