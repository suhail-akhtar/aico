/**
 * Browsing intelligence — the shapes main (electron/browser-learn*.ts) and
 * the chrome (renderer/src/browser/ForYou*.tsx, the omnibox) exchange.
 * Everything here is computed on this device from learn.json; nothing is
 * sent anywhere.
 *
 * Invoke channels:
 *
 *   browser:learn:view      ()                          → LearnView (For you + what AICO has learned)
 *   browser:learn:predict   ({ query? })                → LearnPrediction[] (omnibox: sites likely next)
 *   browser:learn:page      ({ url, kind, words? })     the chrome classified the page in front (suggest.ts)
 *   browser:learn:feedback  ({ id, action })            'dismiss' ("Not interested") | 'open' (a card was used)
 *   browser:learn:remove    (id)                        forget one learned item (site, routine, thread, page, search)
 *   browser:learn:exclude   (site, on)                  never learn from a site (on=false lets it back in)
 *   browser:learn:pause     (paused)                    stop / resume learning
 *   browser:learn:forget    ()                          forget everything learned (keeps pause and exclusions)
 *   browser:learn:cleanup   ({ tabIds, action, folder? }) the user's own tab clean-up → { closed, bookmarked, folderId? }
 *
 * @module desktop/shared/browser-learn-types
 */

/** What a page is — the copilot's page classifier (renderer/src/browser/suggest.ts) names these. */
export type LearnKind =
  | 'product' | 'article' | 'recipe' | 'job' | 'event' | 'video' | 'search' | 'cart' | 'checkout'
  | 'login' | 'form' | 'docs' | 'code' | 'qa' | 'email' | 'chat' | 'page';

export interface LearnAction {
  /** open a URL · switch to an open tab · ask the copilot · tidy tabs. */
  type: 'open' | 'tab' | 'ask' | 'cleanup';
  url?: string;
  tabId?: string;
  prompt?: string;
}

/** One card line: what, why it is shown, and what it does. `id` is what "Not interested" dismisses. */
export interface LearnItem {
  id: string;
  title: string;
  why: string;
  /** unfinished: read · form · cart · product · search; priorities: the source (unfinished, routine, thread, cleanup, next). */
  kind: string;
  icon: string;
  url?: string;
  site?: string;
  score: number;
  action: LearnAction;
}

export interface LearnRoutine {
  id: string;
  site: string;
  url: string;
  /** "Weekday mornings", "Every evening". */
  label: string;
  /** The hour it usually happens (0–23), when clear. */
  hour?: number;
  /** Days it happened / days it could have, in the window. */
  hits: number;
  days: number;
  /** Its time is now and it has not happened yet today. */
  due: boolean;
  why: string;
}

export interface LearnThread {
  id: string;
  label: string;
  terms: string[];
  pages: Array<{ url: string; title: string; site: string }>;
  sites: string[];
  queries: string[];
  first: number;
  last: number;
  why: string;
  /** What "Summarize this research with AICO" asks the copilot. */
  prompt: string;
}

export interface LearnTab {
  id: string;
  url: string;
  title: string;
  site: string;
  kind?: string;
  /** 0–100: how much this tab matters now. */
  priority: number;
  idle: boolean;
  /** Since you last looked at it (ms). */
  idleFor: number;
  activeMs: number;
  pinned: boolean;
  active: boolean;
  why: string;
}

export interface LearnPrediction { url: string; title: string; site: string; why: string; score: number }

export interface LearnInterest { id: string; label: string; share: number; sites: string[] }

export interface LearnSite { id: string; site: string; topic: string; score: number; visits: number; ms: number; last: number }

export interface LearnView {
  paused: boolean;
  /** When learning started (0 when nothing was learned yet). */
  since: number;
  excluded: string[];
  stats: { sites: number; pages: number; searches: number; tabs: number };
  priorities: LearnItem[];
  unfinished: LearnItem[];
  routines: LearnRoutine[];
  threads: LearnThread[];
  cleanup: { tabs: LearnTab[]; days: number; why: string } | null;
  next: LearnPrediction[];
  interests: LearnInterest[];
  sites: LearnSite[];
}

export interface LearnCleanup { tabIds: string[]; action: 'close' | 'bookmark' | 'bookmark_close'; folder?: string }
