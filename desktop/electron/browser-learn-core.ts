/**
 * Browsing intelligence — what AICO learns from how you browse, kept only on
 * this device (`<AICO_HOME>/desktop/browser/learn.json`).
 *
 * Pure: plain data in, plain data out, so every rule is unit-tested with
 * synthetic timestamps (scripts/test-browser-learn.mjs). browser-learn.ts
 * feeds it events from the tabs and serves what it derives.
 *
 * EXPLAINABLE, NOT A BLACK BOX. Each thing it learns is a small counted fact
 * with a reason a person can check:
 *   - interests: frecency — each site's visits and time, decaying with a
 *     14-day half-life — summed by topic (browser-learn-topics.ts);
 *   - routines: the days a site was opened in each part of the day, weekdays
 *     and weekends apart, over the last 6 weeks ("14 of the last 18 weekday
 *     mornings");
 *   - next site: a first-order Markov chain over site-to-site moves, smoothed
 *     toward overall frecency so a new site is not "impossible";
 *   - research threads: page titles and searches as TF-IDF vectors, grouped
 *     greedily by cosine similarity;
 *   - unfinished things: an article opened but barely read, a cart or checkout
 *     with no confirmation after it, a form typed into and never sent (only
 *     the fact — never a value), a search with no result opened;
 *   - tabs: when each was last looked at and for how long, as a priority.
 * "Not interested" is part of the loop: a dismissed site or topic is weighted
 * down from then on, and a used suggestion weighted up.
 *
 * WHAT IS NEVER KEPT: page contents, anything typed, passwords, pages the
 * agent opened, pages Protected Browsing flagged, internal pages, excluded
 * sites. Everything is capped and old data decays away.
 *
 * @module desktop/electron/browser-learn-core
 */

import type {
  LearnInterest, LearnItem, LearnKind, LearnPrediction, LearnRoutine, LearnSite, LearnTab, LearnThread, LearnView,
} from '../shared/browser-learn-types';
import { STOP, topicOf } from './browser-learn-topics';

export { topicOf };

export const DAY = 86_400_000;
const MIN = 60_000;
/** Half-lives, in days. */
export const HALF_LIFE = { site: 14, move: 30 };
/** How far back routines look. */
export const ROUTINE_DAYS = 42;
export const IDLE_DAYS = 3;
export const CAPS = { sites: 400, pages: 600, queries: 300, movesFrom: 200, movesTo: 16, titles: 6, tabs: 300, dismissed: 500, excluded: 500 };
/** Pages and searches older than this are dropped. */
export const KEEP_DAYS = 60;

// ── Data ──

export interface SiteModel {
  /** Frecency, decayed to `at`. */
  score: number;
  at: number;
  visits: number;
  pages: number;
  ms: number;
  first: number;
  last: number;
  /** Visits by hour of day, decayed with the score. */
  hours: number[];
  /** Local day number → the parts of the day it was opened (bitmask of SLOTS). */
  seen: Record<string, number>;
  kinds: Record<string, number>;
  titles: string[];
  /** Where to open it: the last address you arrived at when it was short (a home page), else the origin. */
  home: string;
}

export interface PageRecord {
  url: string;
  title: string;
  host: string;
  kind?: LearnKind;
  words?: number;
  first: number;
  last: number;
  visits: number;
  ms: number;
  /** How far down it was scrolled, 0–1. */
  scroll?: number;
  /** Something was typed on the page (the fact only). */
  typed?: boolean;
  /** Finished: the form was sent, the order confirmed. */
  done?: boolean;
  /** The search terms, on a search results page. */
  query?: string;
  /** The search that led here. */
  from?: string;
}

export interface QueryRecord { q: string; url: string; host: string; at: number; count: number; clicked: boolean }

export interface TabRecord { opened: number; focus: number; ms: number }

export interface LearnData {
  v: 1;
  paused: boolean;
  /** When learning started. */
  since: number;
  excluded: string[];
  /** "Not interested": item id → when. */
  dismissed: Record<string, number>;
  /** Learned from "Not interested": how many times a site / a word was turned down. */
  muted: { sites: Record<string, number>; terms: Record<string, number> };
  /** Suggestions used: site → count. */
  accepted: Record<string, number>;
  sites: Record<string, SiteModel>;
  /** from → to → decayed count. */
  moves: Record<string, Record<string, { n: number; at: number }>>;
  pages: PageRecord[];
  queries: QueryRecord[];
  /** Open tabs by address (so a restored tab keeps its history). */
  tabs: Record<string, TabRecord>;
  /** The site you were last on, in any tab (for site-to-site moves). */
  last: { host: string; at: number } | null;
  copilot: { asks: number; at: number; hosts: Record<string, number> };
}

export const emptyLearn = (now = 0): LearnData => ({
  v: 1, paused: false, since: now, excluded: [], dismissed: {}, muted: { sites: {}, terms: {} }, accepted: {},
  sites: {}, moves: {}, pages: [], queries: [], tabs: {}, last: null, copilot: { asks: 0, at: 0, hosts: {} },
});

const num = (v: unknown, min = 0): number => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : min);
const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const numMap = (v: unknown): Record<string, number> => Object.fromEntries(Object.entries(obj(v)).filter(([, x]) => num(x) > 0).map(([k, x]) => [k, num(x)]));

/** Read learn.json defensively: a damaged or older file never breaks the browser. */
export function normaliseLearn(raw: unknown, now = Date.now()): LearnData {
  const r = obj(raw);
  const d = emptyLearn(num(r.since) || now);
  d.paused = r.paused === true;
  d.excluded = Array.isArray(r.excluded) ? [...new Set(r.excluded.map(x => str(x, 253).toLowerCase()).filter(Boolean))].slice(0, CAPS.excluded) : [];
  d.dismissed = numMap(r.dismissed);
  const m = obj(r.muted);
  d.muted = { sites: numMap(m.sites), terms: numMap(m.terms) };
  d.accepted = numMap(r.accepted);
  for (const [host, v] of Object.entries(obj(r.sites))) {
    const s = obj(v);
    const hours = Array.isArray(s.hours) && s.hours.length === 24 ? s.hours.map(x => num(x)) : new Array(24).fill(0);
    d.sites[host] = {
      score: num(s.score), at: num(s.at), visits: num(s.visits), pages: num(s.pages), ms: num(s.ms), first: num(s.first), last: num(s.last),
      hours, seen: numMap(s.seen), kinds: numMap(s.kinds),
      titles: Array.isArray(s.titles) ? s.titles.map(x => str(x, 200)).filter(Boolean).slice(0, CAPS.titles) : [],
      home: str(s.home, 2000) || `https://${host}/`,
    };
  }
  for (const [from, tos] of Object.entries(obj(r.moves))) {
    const out: Record<string, { n: number; at: number }> = {};
    for (const [to, mv] of Object.entries(obj(tos))) { const o = obj(mv); if (num(o.n) > 0) out[to] = { n: num(o.n), at: num(o.at) }; }
    if (Object.keys(out).length) d.moves[from] = out;
  }
  d.pages = (Array.isArray(r.pages) ? r.pages : []).map(obj).filter(p => /^https?:/i.test(str(p.url))).map((p): PageRecord => ({
    url: str(p.url, 2000), title: str(p.title, 300), host: str(p.host, 253), first: num(p.first), last: num(p.last), visits: num(p.visits), ms: num(p.ms),
    ...(typeof p.kind === 'string' ? { kind: p.kind as LearnKind } : {}), ...(num(p.words) ? { words: num(p.words) } : {}),
    ...(typeof p.scroll === 'number' ? { scroll: Math.min(1, num(p.scroll)) } : {}), ...(p.typed === true ? { typed: true } : {}),
    ...(p.done === true ? { done: true } : {}), ...(str(p.query) ? { query: str(p.query, 200) } : {}), ...(str(p.from) ? { from: str(p.from, 200) } : {}),
  }));
  d.queries = (Array.isArray(r.queries) ? r.queries : []).map(obj).filter(q => str(q.q)).map(q => ({
    q: str(q.q, 200), url: str(q.url, 2000), host: str(q.host, 253), at: num(q.at), count: num(q.count) || 1, clicked: q.clicked === true,
  }));
  for (const [url, t] of Object.entries(obj(r.tabs))) { const o = obj(t); d.tabs[url] = { opened: num(o.opened), focus: num(o.focus), ms: num(o.ms) }; }
  const last = obj(r.last);
  d.last = str(last.host) ? { host: str(last.host, 253), at: num(last.at) } : null;
  const c = obj(r.copilot);
  d.copilot = { asks: num(c.asks), at: num(c.at), hosts: numMap(c.hosts) };
  return d;
}

// ── Time ──

/** The local calendar day as a number (days since 1970-01-01), immune to daylight saving. */
export function dayIndex(t: number): number {
  const d = new Date(t);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}
/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (day: number): number => (day + 4) % 7;
export const isWeekend = (day: number): boolean => weekdayOf(day) === 0 || weekdayOf(day) === 6;

/** Parts of the day. */
export const PARTS = ['morning', 'afternoon', 'evening', 'night'] as const;
export function partOf(hour: number): number { return hour >= 5 && hour < 12 ? 0 : hour >= 12 && hour < 17 ? 1 : hour >= 17 && hour < 22 ? 2 : 3; }
/** 0–3 weekday parts, 4–7 weekend parts. */
export function slotOf(t: number): number { return partOf(new Date(t).getHours()) + (isWeekend(dayIndex(t)) ? 4 : 0); }

export function decay(value: number, from: number, to: number, halfLifeDays: number): number {
  if (!(value > 0) || to <= from) return value;
  return value * 0.5 ** ((to - from) / (halfLifeDays * DAY));
}

// ── Addresses ──

/** The site a page belongs to, for learning: its host without "www." ('' for anything not on the web). */
export function hostKey(url: string): string {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}

/** The key a page is remembered under: without its #fragment. */
const pageKey = (url: string): string => { const i = url.indexOf('#'); return i >= 0 ? url.slice(0, i) : url; };

const ENGINES: Array<[RegExp, string, RegExp]> = [
  [/(^|\.)google\.[a-z.]+$/, 'q', /^\/(search|webhp)?$/],
  [/(^|\.)bing\.com$/, 'q', /^\/search$/],
  [/(^|\.)duckduckgo\.com$/, 'q', /^\/(html\/?)?$/],
  [/^search\.brave\.com$/, 'q', /^\/search$/],
  [/(^|\.)ecosia\.org$/, 'q', /^\/search$/],
  [/(^|\.)search\.yahoo\.com$/, 'p', /^\/search/],
  [/(^|\.)youtube\.com$/, 'search_query', /^\/results$/],
  [/(^|\.)amazon\.[a-z.]+$/, 'k', /^\/s\/?$/],
  [/(^|\.)wikipedia\.org$/, 'search', /^\/w\/index\.php$|^\/wiki\/Special:Search/],
];

/** The search terms, when the address is a search results page. */
export function searchOf(url: string): { q: string; host: string } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const [re, key, path] of ENGINES) {
      if (!re.test(host) || !path.test(u.pathname)) continue;
      const q = (u.searchParams.get(key) ?? '').replace(/\s+/g, ' ').trim();
      return q ? { q: q.slice(0, 200), host } : null;
    }
  } catch { /* not an address */ }
  return null;
}
const normQ = (q: string): string => q.toLowerCase().replace(/\s+/g, ' ').trim();

/** An order was placed: the page after checkout says so. */
const CONFIRMED = /(order|checkout)[-_/]?(confirm|complete|success|received|placed)|thank[-_]?you|\/receipt|order-?status|\/confirmation/i;

/** What a page is, from its address alone — for pages never classified in front. */
export function guessKind(url: string): LearnKind | undefined {
  if (searchOf(url)) return 'search';
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  const p = u.pathname.toLowerCase();
  const h = u.hostname.replace(/^www\./, '');
  if (/(^|\/)(checkout|payment)(\/|$)/.test(p)) return 'checkout';
  if (/(^|\/)(cart|basket|bag|trolley)(\/|$)|\/gp\/cart/.test(p)) return 'cart';
  if (/(^|\/)(login|signin|sign-in|log-in)(\/|$)/.test(p)) return 'login';
  if (/^(github\.com|gitlab\.com)$/.test(h) && /^\/[^/]+\/[^/]+/.test(p)) return 'code';
  if (/youtube\.com$/.test(h) && /^\/watch/.test(p)) return 'video';
  if (/(^|\/)(dp|product|products|item|itm|p)\/[^/]+/.test(p)) return 'product';
  return undefined;
}

// ── Recording (each skips what must not be learned: the caller checks paused / flagged / agent / excluded) ──

export function isExcluded(d: LearnData, host: string): boolean {
  if (!host) return true;
  return d.excluded.some(x => host === x || host.endsWith(`.${x}`));
}

function siteOf(d: LearnData, host: string, now: number): SiteModel {
  let s = d.sites[host];
  if (!s) {
    s = { score: 0, at: now, visits: 0, pages: 0, ms: 0, first: now, last: now, hours: new Array(24).fill(0), seen: {}, kinds: {}, titles: [], home: `https://${host}/` };
    d.sites[host] = s;
  }
  // Decay lazily, to now, before adding.
  if (now > s.at) {
    const f = 0.5 ** ((now - s.at) / (HALF_LIFE.site * DAY));
    s.score *= f;
    for (let i = 0; i < 24; i++) s.hours[i] = s.hours[i]! * f;
    s.at = now;
  }
  return s;
}

function pageOf(d: LearnData, url: string, now: number): PageRecord {
  const key = pageKey(url);
  let p = d.pages.find(x => x.url === key);
  if (!p) {
    p = { url: key, title: '', host: hostKey(url), first: now, last: now, visits: 0, ms: 0 };
    d.pages.unshift(p);
  }
  return p;
}
const findPage = (d: LearnData, url: string): PageRecord | undefined => { const k = pageKey(url); return d.pages.find(x => x.url === k); };

function addMove(d: LearnData, from: string, to: string, now: number): void {
  const row = (d.moves[from] ??= {});
  const m = row[to] ?? { n: 0, at: now };
  row[to] = { n: decay(m.n, m.at, now, HALF_LIFE.move) + 1, at: now };
}

export interface VisitEvent {
  url: string;
  title?: string;
  /** The page this tab showed before (its previous address), '' for a new tab. */
  fromUrl?: string;
  /** The same document (a single-page app's route change). */
  inPage?: boolean;
}

/** A page was shown. Counts the site (once per arrival), the time of day, the move from the last site, the page, and searches. */
export function learnVisit(d: LearnData, e: VisitEvent, now: number): void {
  const host = hostKey(e.url);
  if (!host) return;
  const fromHost = e.fromUrl ? hostKey(e.fromUrl) : '';
  const arrival = host !== fromHost;
  const s = siteOf(d, host, now);
  s.pages++;
  s.last = now;
  s.score += arrival ? 1 : 0.15;
  if (e.title?.trim()) s.titles = [e.title.trim().slice(0, 200), ...s.titles.filter(t => t !== e.title!.trim())].slice(0, CAPS.titles);
  if (arrival) {
    s.visits++;
    s.hours[new Date(now).getHours()]! += 1;
    const day = String(dayIndex(now));
    s.seen[day] = (s.seen[day] ?? 0) | (1 << slotOf(now));
    try { const u = new URL(e.url); s.home = u.pathname.split('/').filter(Boolean).length <= 1 && !u.search ? pageKey(e.url) : `${u.origin}/`; } catch { /* keep */ }
    // A move from the site you were last on (in any tab), if it was recent enough to be one train of thought.
    if (d.last && d.last.host !== host && now - d.last.at < 30 * MIN) addMove(d, d.last.host, host, now);
  }
  d.last = { host, at: now };

  const p = pageOf(d, e.url, now);
  if (!e.inPage || p.visits === 0) p.visits++;
  p.last = now;
  if (e.title?.trim()) p.title = e.title.trim().slice(0, 300);
  const guess = guessKind(e.url);
  if (guess && !p.kind) p.kind = guess;

  const search = searchOf(e.url);
  if (search) {
    p.kind = 'search';
    p.query = search.q;
    const k = normQ(search.q);
    const q = d.queries.find(x => normQ(x.q) === k);
    if (q) { q.at = now; q.count++; q.clicked = false; q.url = pageKey(e.url); } else d.queries.unshift({ q: search.q, url: pageKey(e.url), host, at: now, count: 1, clicked: false });
  }
  // A result opened from a search: the search found something.
  const prev = e.fromUrl ? searchOf(e.fromUrl) : null;
  if (prev && !search && host !== prev.host) {
    const q = d.queries.find(x => normQ(x.q) === normQ(prev.q));
    if (q) q.clicked = true;
    if (!p.from) p.from = prev.q;
  }
  // Leaving a page you typed on for another page of the same site: it was sent.
  if (e.fromUrl && !arrival && pageKey(e.fromUrl) !== pageKey(e.url)) {
    const before = findPage(d, e.fromUrl);
    if (before?.typed) before.done = true;
  }
  // An order confirmation: the site's carts and checkouts are done.
  if (CONFIRMED.test(e.url)) for (const x of d.pages) if (x.host === host && (x.kind === 'cart' || x.kind === 'checkout')) x.done = true;
}

/** Time a page was in front and in use; `scroll` is how far down it is (0–1). */
export function learnActive(d: LearnData, url: string, ms: number, now: number, scroll?: number): void {
  const host = hostKey(url);
  if (!host || !(ms > 0)) return;
  const s = siteOf(d, host, now);
  const add = Math.min(ms, 60_000);
  s.ms += add;
  s.score += add / (10 * MIN);
  const p = pageOf(d, url, now);
  p.ms += add;
  p.last = Math.max(p.last, now);
  if (typeof scroll === 'number' && Number.isFinite(scroll)) p.scroll = Math.max(p.scroll ?? 0, Math.min(1, Math.max(0, scroll)));
  const t = d.tabs[pageKey(url)];
  if (t) { t.ms += add; t.focus = now; }
}

/** The chrome classified the page in front (the copilot's page classifier). */
export function learnKind(d: LearnData, url: string, kind: LearnKind, now: number, words?: number): void {
  const host = hostKey(url);
  if (!host) return;
  const p = findPage(d, url) ?? pageOf(d, url, now);
  if (p.kind === kind && (!words || p.words === words)) return;
  // A search page stays a search page; everything else takes the classifier's word.
  if (p.kind !== 'search') p.kind = kind;
  if (words && words > 0) p.words = Math.round(words);
  const s = siteOf(d, host, now);
  s.kinds[kind] = (s.kinds[kind] ?? 0) + 1;
}

/** Titles arrive after the navigation. */
export function learnTitle(d: LearnData, url: string, title: string): void {
  const p = findPage(d, url);
  const t = title.trim().slice(0, 300);
  if (!p || !t || p.title === t) return;
  p.title = t;
  const s = d.sites[p.host];
  if (s) s.titles = [t.slice(0, 200), ...s.titles.filter(x => x !== t)].slice(0, CAPS.titles);
}

/** Something was typed on the page — the fact only, never what. */
export function learnTyped(d: LearnData, url: string, now: number): void {
  if (!hostKey(url)) return;
  const p = findPage(d, url) ?? pageOf(d, url, now);
  if (p.kind === 'search' || p.kind === 'login') return;
  p.typed = true;
  p.done = false;
}

export function learnCopilot(d: LearnData, url: string, now: number): void {
  d.copilot.asks++;
  d.copilot.at = now;
  const host = hostKey(url);
  if (host) { d.copilot.hosts[host] = (d.copilot.hosts[host] ?? 0) + 1; siteOf(d, host, now).score += 0.5; }
}

// ── Tabs ──

/** A tab showed this address; `fromUrl` is what it showed before (its record moves with it). */
export function tabAt(d: LearnData, url: string, now: number, fromUrl?: string): void {
  const key = pageKey(url);
  const prev = fromUrl ? d.tabs[pageKey(fromUrl)] : undefined;
  if (prev) { if (pageKey(fromUrl!) !== key) { delete d.tabs[pageKey(fromUrl!)]; d.tabs[key] = { ...prev }; } return; }
  // A tab's first page: a new tab, or a restored one being woken — either way you are looking at it now.
  const had = d.tabs[key];
  d.tabs[key] = { opened: had?.opened ?? now, focus: now, ms: had?.ms ?? 0 };
}
/** You looked at the tab. */
export function tabFocus(d: LearnData, url: string, now: number): void {
  const key = pageKey(url);
  const t = (d.tabs[key] ??= { opened: now, focus: now, ms: 0 });
  t.focus = now;
}
export function tabClosed(d: LearnData, url: string): void { delete d.tabs[pageKey(url)]; }

// ── Feedback: the learning loop ──

/** Terms of a thread id ("thread:desk+standing"), sites of a site/routine/next id. */
function subjectOf(id: string): { site?: string; terms?: string[]; url?: string } {
  const [kind, rest = ''] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'thread') return { terms: rest.split('+').filter(Boolean) };
  if (kind === 'site' || kind === 'next') return { site: rest };
  if (kind === 'routine') return { site: rest.split('@')[0] };
  if (kind === 'page' || kind === 'read' || kind === 'form' || kind === 'cart' || kind === 'product') return { url: rest };
  return {};
}

/** "Not interested": hidden for 30 days, and what it was about is weighted down from now on. */
export function learnDismiss(d: LearnData, id: string, now: number): void {
  d.dismissed[id] = now;
  const s = subjectOf(id);
  if (s.site) d.muted.sites[s.site] = (d.muted.sites[s.site] ?? 0) + 1;
  for (const t of s.terms ?? []) d.muted.terms[t] = (d.muted.terms[t] ?? 0) + 1;
  if (s.url) { const p = findPage(d, s.url); if (p) p.done = true; }
}

/** A suggestion was used: its site counts for a little more. */
export function learnAccept(d: LearnData, id: string, now: number): void {
  const s = subjectOf(id);
  const site = s.site ?? (s.url ? hostKey(s.url) : '');
  if (site) { d.accepted[site] = (d.accepted[site] ?? 0) + 1; if (d.sites[site]) siteOf(d, site, now).score += 0.5; }
  if (s.url) { const p = findPage(d, s.url); if (p && (id.startsWith('read:') || id.startsWith('product:'))) p.last = now; }
}

const isDismissed = (d: LearnData, id: string, now: number): boolean => d.dismissed[id] !== undefined && now - d.dismissed[id]! < 30 * DAY;
const muteFactor = (d: LearnData, host: string): number => 0.5 ** (d.muted.sites[host] ?? 0);

// ── Forgetting ──

function dropSite(d: LearnData, host: string): void {
  delete d.sites[host];
  delete d.moves[host];
  for (const row of Object.values(d.moves)) delete row[host];
  d.pages = d.pages.filter(p => p.host !== host && !p.host.endsWith(`.${host}`));
  d.queries = d.queries.filter(q => q.host !== host);
  if (d.last?.host === host) d.last = null;
  delete d.copilot.hosts[host];
  delete d.accepted[host];
}

/** Forget one learned item (the panel's ✕). */
export function removeItem(d: LearnData, id: string): void {
  const i = id.indexOf(':');
  const kind = id.slice(0, i); const rest = id.slice(i + 1);
  if (kind === 'site' || kind === 'next') dropSite(d, rest);
  else if (kind === 'interest') { for (const [host, s] of Object.entries(d.sites)) if (topicOf(host, s.titles) === rest) dropSite(d, host); }
  else if (kind === 'routine') {
    const [site = '', slot = ''] = rest.split('@');
    const s = d.sites[site];
    const slots = slot.split(',').map(Number).filter(n => n >= 0 && n < 8);
    if (s) for (const k of Object.keys(s.seen)) { for (const n of slots) s.seen[k]! &= ~(1 << n); if (!s.seen[k]) delete s.seen[k]; }
    d.dismissed[id] = Date.now();
  } else if (kind === 'thread') {
    const terms = rest.split('+');
    for (const t of terms) d.muted.terms[t] = (d.muted.terms[t] ?? 0) + 2;
    const hit = (text: string): boolean => { const w = new Set(tokens(text).map(stem)); return terms.every(t => w.has(t)); };
    d.pages = d.pages.filter(p => !hit(`${p.title} ${p.query ?? ''} ${p.from ?? ''}`));
    d.queries = d.queries.filter(q => !hit(q.q));
  } else if (kind === 'search') d.queries = d.queries.filter(q => normQ(q.q) !== normQ(rest));
  else { const k = pageKey(rest); d.pages = d.pages.filter(p => p.url !== k); }
}

/** Never learn from a site again (and forget what was learned from it); `on=false` lets it back in. */
export function setExcluded(d: LearnData, site: string, on: boolean): void {
  const s = site.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!s) return;
  if (!on) { d.excluded = d.excluded.filter(x => x !== s); return; }
  if (!d.excluded.includes(s)) d.excluded = [...d.excluded, s].slice(-CAPS.excluded);
  for (const host of Object.keys(d.sites)) if (host === s || host.endsWith(`.${s}`)) dropSite(d, host);
  dropSite(d, s);
  for (const url of Object.keys(d.tabs)) { const h = hostKey(url); if (h === s || h.endsWith(`.${s}`)) delete d.tabs[url]; }
}

/** "Forget everything": all that was learned goes; the pause switch and the excluded sites stay. */
export function forgetAll(d: LearnData, now: number): LearnData {
  return { ...emptyLearn(now), paused: d.paused, excluded: d.excluded };
}

/**
 * "Clear browsing data" from `sinceMs` (everything when omitted): what was learned from that history goes with it.
 * Aggregates cannot be split by time, so anything that could include cleared visits is dropped rather than kept.
 */
export function clearSince(d: LearnData, now: number, sinceMs?: number): LearnData {
  if (sinceMs === undefined || !Number.isFinite(sinceMs) || sinceMs <= 0) return forgetAll(d, now);
  const fromDay = dayIndex(sinceMs);
  for (const [host, s] of Object.entries(d.sites)) {
    if (s.first >= sinceMs) { dropSite(d, host); continue; }
    if (s.last >= sinceMs) {
      for (const k of Object.keys(s.seen)) if (Number(k) >= fromDay) delete s.seen[k];
      s.titles = [];
    }
  }
  for (const [from, row] of Object.entries(d.moves)) {
    for (const [to, m] of Object.entries(row)) if (m.at >= sinceMs) delete row[to];
    if (!Object.keys(row).length) delete d.moves[from];
  }
  d.pages = d.pages.filter(p => p.first < sinceMs && p.last < sinceMs);
  d.queries = d.queries.filter(q => q.at < sinceMs);
  if (d.last && d.last.at >= sinceMs) d.last = null;
  return d;
}

/** A page removed from history is forgotten here too. */
export function forgetUrl(d: LearnData, url: string): void {
  const k = pageKey(url);
  d.pages = d.pages.filter(p => p.url !== k);
  const s = searchOf(url);
  if (s) d.queries = d.queries.filter(q => normQ(q.q) !== normQ(s.q));
}

/** Keep the file small: old things decay out, every list is capped. */
export function pruneLearn(d: LearnData, now: number): LearnData {
  const oldDay = dayIndex(now) - ROUTINE_DAYS;
  const sites = Object.entries(d.sites).map(([h, s]) => [h, s, decay(s.score, s.at, now, HALF_LIFE.site)] as const);
  for (const [h, s, score] of sites) {
    if (score < 0.01 && now - s.last > 120 * DAY) { delete d.sites[h]; continue; }
    for (const k of Object.keys(s.seen)) if (Number(k) < oldDay) delete s.seen[k];
  }
  if (Object.keys(d.sites).length > CAPS.sites) {
    const keep = new Set(sites.filter(([h]) => d.sites[h]).sort((a, b) => b[2] - a[2]).slice(0, CAPS.sites).map(([h]) => h));
    for (const h of Object.keys(d.sites)) if (!keep.has(h)) delete d.sites[h];
  }
  for (const [from, row] of Object.entries(d.moves)) {
    if (!d.sites[from]) { delete d.moves[from]; continue; }
    const kept = Object.entries(row).filter(([to, m]) => d.sites[to] && decay(m.n, m.at, now, HALF_LIFE.move) >= 0.05)
      .sort((a, b) => decay(b[1].n, b[1].at, now, HALF_LIFE.move) - decay(a[1].n, a[1].at, now, HALF_LIFE.move)).slice(0, CAPS.movesTo);
    if (kept.length) d.moves[from] = Object.fromEntries(kept); else delete d.moves[from];
  }
  if (Object.keys(d.moves).length > CAPS.movesFrom) {
    const keep = Object.keys(d.moves).sort((a, b) => (d.sites[b]?.score ?? 0) - (d.sites[a]?.score ?? 0)).slice(0, CAPS.movesFrom);
    d.moves = Object.fromEntries(keep.map(k => [k, d.moves[k]!]));
  }
  d.pages = d.pages.filter(p => now - p.last < KEEP_DAYS * DAY).sort((a, b) => b.last - a.last).slice(0, CAPS.pages);
  d.queries = d.queries.filter(q => now - q.at < KEEP_DAYS * DAY).sort((a, b) => b.at - a.at).slice(0, CAPS.queries);
  const tabs = Object.entries(d.tabs).filter(([, t]) => now - t.focus < 45 * DAY).sort((a, b) => b[1].focus - a[1].focus).slice(0, CAPS.tabs);
  d.tabs = Object.fromEntries(tabs);
  const dismissed = Object.entries(d.dismissed).filter(([, at]) => now - at < 30 * DAY).sort((a, b) => b[1] - a[1]).slice(0, CAPS.dismissed);
  d.dismissed = Object.fromEntries(dismissed);
  return d;
}

// ── What it has learned ──

const fmtMin = (ms: number): string => { const m = Math.round(ms / MIN); return ms < MIN ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };
export function ago(ms: number): string {
  const m = Math.round(ms / MIN);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
const hourLabel = (h: number): string => (h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} am` : `${h - 12} pm`);
const shortDate = (t: number): string => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** Frecency now, with feedback: muted sites count for less, used suggestions for a little more. */
export function siteScore(d: LearnData, host: string, now: number): number {
  const s = d.sites[host];
  if (!s) return 0;
  return decay(s.score, s.at, now, HALF_LIFE.site) * muteFactor(d, host) * (1 + 0.1 * Math.min(5, d.accepted[host] ?? 0));
}

function rankedSites(d: LearnData, now: number): Array<[string, number]> {
  return Object.keys(d.sites).filter(h => !isExcluded(d, h)).map(h => [h, siteScore(d, h, now)] as [string, number]).filter(([, s]) => s > 0.05).sort((a, b) => b[1] - a[1]);
}

export function topSites(d: LearnData, now: number, limit = 12): LearnSite[] {
  return rankedSites(d, now).slice(0, limit).map(([h, score]) => {
    const s = d.sites[h]!;
    return { id: `site:${h}`, site: h, topic: topicOf(h, s.titles), score: Math.round(score * 100) / 100, visits: s.visits, ms: s.ms, last: s.last };
  });
}

/** Topics by share of frecency (bookmarked sites count a little more). */
export function interests(d: LearnData, now: number, bookmarked: Set<string> = new Set(), limit = 8): LearnInterest[] {
  const by = new Map<string, { score: number; sites: Array<[string, number]> }>();
  let total = 0;
  for (const [h, score] of rankedSites(d, now)) {
    const topic = topicOf(h, d.sites[h]!.titles);
    if (topic === 'Search') continue;
    const w = score * (bookmarked.has(h) ? 1.2 : 1);
    const t = by.get(topic) ?? { score: 0, sites: [] };
    t.score += w; t.sites.push([h, w]);
    by.set(topic, t);
    total += w;
  }
  return [...by.entries()].filter(([id]) => !isDismissed(d, `interest:${id}`, now)).sort((a, b) => b[1].score - a[1].score).slice(0, limit).map(([label, t]) => ({
    id: `interest:${label}`, label, share: total ? Math.round((t.score / total) * 100) / 100 : 0,
    sites: t.sites.sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h]) => h),
  }));
}

// ── Routines ──

const SLOT_LABEL = (slot: number): string => `${slot >= 4 ? 'Weekend' : 'Weekday'} ${PARTS[slot % 4]}s`;
const HOURS_OF_PART: number[][] = [[5, 6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16], [17, 18, 19, 20, 21], [22, 23, 0, 1, 2, 3, 4]];

/**
 * Habits: a site opened in the same part of the day on at least 3 days and on at least 40% of the days that could
 * have been (weekdays for a weekday slot), within the last 6 weeks and since learning (or the site) began.
 * A habit on weekdays and weekends alike reads "Every morning".
 */
export function routines(d: LearnData, now: number, limit = 12): LearnRoutine[] {
  const today = dayIndex(now);
  const nowSlot = slotOf(now);
  const out: LearnRoutine[] = [];
  for (const [host, s] of Object.entries(d.sites)) {
    // Searching is how you get somewhere, not a habit of its own.
    if (isExcluded(d, host) || (d.muted.sites[host] ?? 0) >= 3 || topicOf(host, s.titles) === 'Search') continue;
    const start = Math.max(today - ROUTINE_DAYS + 1, dayIndex(Math.max(d.since, s.first)));
    const found: Array<{ slot: number; hits: number; days: number }> = [];
    for (let slot = 0; slot < 8; slot++) {
      let hits = 0; let days = 0; let active = 0;
      for (let day = start; day <= today; day++) {
        if (isWeekend(day) !== slot >= 4) continue;
        const seen = s.seen[String(day)] ?? 0;
        const hit = (seen & (1 << slot)) !== 0;
        // Today counts only once it has happened: a habit is not broken before its time has passed.
        if (day === today && !hit) continue;
        days++;
        if (hit) hits++;
        if (seen) active++;
      }
      // Often enough, and at that time on most of the days it was opened at all (a site opened at all hours is not a habit).
      if (hits >= 3 && hits / days >= 0.4 && hits / active >= 0.6) found.push({ slot, hits, days });
    }
    // Weekday + weekend of the same part → every day.
    const parts = new Map<number, typeof found>();
    for (const f of found) parts.set(f.slot % 4, [...(parts.get(f.slot % 4) ?? []), f]);
    for (const [part, fs] of parts) {
      const both = fs.length === 2;
      const hits = fs.reduce((n, f) => n + f.hits, 0);
      const days = fs.reduce((n, f) => n + f.days, 0);
      const slots = fs.map(f => f.slot);
      const id = `routine:${host}@${slots.join(',')}`;
      if (isDismissed(d, id, now)) continue;
      const hrs = HOURS_OF_PART[part]!;
      const peak = hrs.reduce((best, h) => (s.hours[h]! > s.hours[best]! ? h : best), hrs[0]!);
      const hourShare = s.hours[peak]! / Math.max(1e-9, hrs.reduce((n, h) => n + s.hours[h]!, 0));
      const label = both ? `Every ${PARTS[part]}` : SLOT_LABEL(slots[0]!);
      const doneToday = slots.some(sl => ((s.seen[String(today)] ?? 0) & (1 << sl)) !== 0);
      const due = slots.includes(nowSlot) && !doneToday;
      const when = both ? `${PARTS[part]}s` : `${slots[0]! >= 4 ? 'weekend' : 'weekday'} ${PARTS[part]}s`;
      out.push({
        id, site: host, url: s.home, label, ...(hourShare >= 0.35 ? { hour: peak } : {}), hits, days, due,
        why: `You opened ${host} on ${hits} of the last ${days} ${when}${hourShare >= 0.35 ? `, usually around ${hourLabel(peak)}` : ''}.`,
      });
    }
  }
  return out.sort((a, b) => Number(b.due) - Number(a.due) || b.hits / b.days - a.hits / a.days || b.hits - a.hits).slice(0, limit);
}

// ── Next site ──

/**
 * Where you are likely to go next: P(to | from) from the site-to-site moves, smoothed toward overall frecency
 * (α = 1), plus a routine due now. `from` is the site you are on (or were on in the last half hour).
 */
export function predict(d: LearnData, now: number, opts: { from?: string; query?: string; limit?: number } = {}): LearnPrediction[] {
  const limit = opts.limit ?? 6;
  const ranked = rankedSites(d, now);
  const total = ranked.reduce((n, [, s]) => n + s, 0);
  if (!total) return [];
  const from = opts.from ?? (d.last && now - d.last.at < 30 * MIN ? d.last.host : '');
  const row = from ? d.moves[from] ?? {} : {};
  const moves = Object.fromEntries(Object.entries(row).map(([to, m]) => [to, decay(m.n, m.at, now, HALF_LIFE.move)]));
  const n = Object.values(moves).reduce((a, b) => a + b, 0);
  const due = new Map(routines(d, now, 50).filter(r => r.due).map(r => [r.site, r]));
  const q = (opts.query ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').trim();
  const out: LearnPrediction[] = [];
  for (const [host, score] of ranked) {
    if (host === from || isDismissed(d, `next:${host}`, now)) continue;
    const s = d.sites[host]!;
    if (q && !host.startsWith(q) && !host.split('.').some(p => p.startsWith(q)) && !s.titles.some(t => t.toLowerCase().split(/\W+/).some(w => w && w.startsWith(q)))) continue;
    if (topicOf(host, s.titles) === 'Search' && !q) continue;
    const prior = score / total;
    const mv = moves[host] ?? 0;
    const p = (mv + prior) / (n + 1);
    const r = due.get(host);
    // A habit whose time is now outranks a site that is merely used a lot; a strong move from here still wins.
    const value = p + (r ? 0.4 + 0.4 * (r.hits / r.days) : 0);
    const why = mv >= 2 && mv / Math.max(n, 1) >= 0.15
      ? `After ${from} you often open ${host} (${Math.round(mv)} of the last ${Math.round(n)} times).`
      : r ? r.why : `One of the sites you use most (${s.visits} visit${s.visits === 1 ? '' : 's'}).`;
    out.push({ url: s.home, title: host, site: host, why, score: Math.round(value * 1000) / 1000 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Research threads ──

export function tokens(text: string): string[] {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9+#]+/).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(w => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/**
 * A word's stem for grouping: its first five letters, so "async", "asyncio" and "asynchronous" (or "standing" and
 * "stand") meet. Crude on purpose — it only decides what is grouped; labels keep the real words.
 */
export const stem = (w: string): string => (w.length > 5 ? w.slice(0, 5) : w);

const PATH_NOISE = new Set(['questions', 'question', 'comments', 'comment', 'wiki', 'index', 'html', 'php', 'amp', 'library', 'products', 'product', 'item', 'reviews', 'best', 'page']);
/** Words in the address's path ("/library/asyncio.html", "/async-io-python/"): a weaker signal than the title. */
export function pathTokens(url: string): string[] {
  try { return tokens(decodeURIComponent(new URL(url).pathname).replace(/[/_.-]+/g, ' ')).filter(w => !PATH_NOISE.has(w) && w.length <= 30); } catch { return []; }
}

type Vec = Map<string, number>;
const norm = (v: Vec): number => Math.sqrt([...v.values()].reduce((n, x) => n + x * x, 0));
function cosine(a: Vec, b: Vec): number {
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, x] of s) { const y = l.get(k); if (y) dot += x * y; }
  const n = norm(a) * norm(b);
  return n ? dot / n : 0;
}

/**
 * What you have been looking into: recent pages (and searches, counted twice) as TF-IDF vectors of their titles,
 * grouped greedily — each page joins the thread it is most like (cosine ≥ 0.3) or starts one. A thread is at least
 * three pages, across two sites or with a search. Words you turned down count for less.
 */
export function threads(d: LearnData, now: number, days = 14, limit = 6): LearnThread[] {
  const pages = d.pages.filter(p => now - p.last <= days * DAY && p.kind !== 'login' && !isExcluded(d, p.host));
  // Each word as its stem, weighted: a search counts twice, the title once, the address's path half.
  const shown = new Map<string, Map<string, number>>();
  const docs = pages.map((p) => {
    const hostWords = new Set(p.host.split('.'));
    const weighted: Array<[string, number]> = [];
    const add = (ws: string[], w: number): void => {
      for (const word of ws) {
        if (hostWords.has(word)) continue;
        const st = stem(word);
        weighted.push([st, w]);
        const m = shown.get(st) ?? new Map<string, number>();
        m.set(word, (m.get(word) ?? 0) + w);
        shown.set(st, m);
      }
    };
    add(tokens(p.title), 1); add(tokens(p.query ?? ''), 2); add(tokens(p.from ?? ''), 1);
    if (p.kind !== 'search') add(pathTokens(p.url), 0.5);
    return { p, weighted, words: [...new Set(weighted.map(([w]) => w))] };
  }).filter(x => x.words.length >= 1);
  const df = new Map<string, number>();
  for (const x of docs) for (const w of x.words) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  const vecs = docs.map((x) => {
    const v: Vec = new Map();
    for (const [w, wt] of x.weighted) v.set(w, (v.get(w) ?? 0) + wt);
    for (const [w, tf] of v) v.set(w, tf * (Math.log((N + 1) / ((df.get(w) ?? 0) + 1)) + 1) * 0.3 ** (d.muted.terms[w] ?? 0));
    return v;
  });
  const order = docs.map((_, i) => i).sort((a, b) => docs[a]!.p.first - docs[b]!.p.first);
  const clusters: Array<{ members: number[]; centroid: Vec }> = [];
  for (const i of order) {
    const v = vecs[i]!;
    if (!norm(v)) continue;
    let best = -1; let bestSim = 0;
    clusters.forEach((c, k) => { const sim = cosine(v, c.centroid); if (sim > bestSim) { bestSim = sim; best = k; } });
    if (best >= 0 && bestSim >= 0.3) {
      const c = clusters[best]!;
      c.members.push(i);
      for (const [w, x] of v) c.centroid.set(w, (c.centroid.get(w) ?? 0) + x);
    } else clusters.push({ members: [i], centroid: new Map(v) });
  }
  const out: LearnThread[] = [];
  for (const c of clusters) {
    const ps = c.members.map(i => docs[i]!.p);
    const sites = [...new Set(ps.map(p => p.host))];
    const queries = [...new Set(ps.map(p => p.query).filter((q): q is string => Boolean(q)))];
    if (ps.length < 3 || (sites.length < 2 && queries.length === 0)) continue;
    // The words most of the thread shares, weighted by how distinctive they are.
    const shared = [...c.centroid.entries()].map(([w, x]) => [w, x * (ps.filter((_, j) => docs[c.members[j]!]!.words.includes(w)).length / ps.length)] as const)
      .sort((a, b) => b[1] - a[1]).map(([w]) => w);
    const stems = shared.slice(0, 3);
    // Shown as the word most used for each stem ("standing", not "stand").
    const terms = stems.map(st => [...(shown.get(st) ?? new Map([[st, 1]])).entries()].sort((a, b) => b[1] - a[1])[0]![0]);
    const id = `thread:${[...stems.slice(0, 2)].sort().join('+')}`;
    if (!terms.length || isDismissed(d, id, now)) continue;
    const counts = new Map<string, number>();
    for (const p of ps) for (const q of [p.query, p.from]) if (q) counts.set(normQ(q), (counts.get(normQ(q)) ?? 0) + 1);
    const topQ = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const label = topQ ?? terms.join(' ');
    const first = Math.min(...ps.map(p => p.first));
    const last = Math.max(...ps.map(p => p.last));
    const content = ps.filter(p => p.kind !== 'search');
    const t: LearnThread = {
      id, label, terms, sites, queries, first, last, prompt: '',
      pages: (content.length ? content : ps).sort((a, b) => b.ms - a.ms || b.last - a.last).slice(0, 12).map(p => ({ url: p.url, title: p.title || p.url, site: p.host })),
      why: `${ps.length} pages on ${sites.length} site${sites.length === 1 ? '' : 's'}${queries.length ? `, ${queries.length} search${queries.length === 1 ? '' : 'es'}` : ''}, ${shortDate(first) === shortDate(last) ? shortDate(last) : `${shortDate(first)} – ${shortDate(last)}`}.`,
    };
    t.prompt = researchPrompt(t);
    out.push(t);
  }
  return out.sort((a, b) => b.last - a.last || b.pages.length - a.pages.length).slice(0, limit);
}

/** The copilot prompt behind "Summarize this research with AICO". */
export function researchPrompt(t: Omit<LearnThread, 'prompt'>): string {
  const list = t.pages.slice(0, 8).map((p, i) => `${i + 1}. ${p.title} — ${p.url}`).join('\n');
  return `Summarize my research on “${t.label}”. These are the pages I read (${t.why.replace(/\.$/, '')}):\n${list}\n\n`
    + 'Open and read the most relevant ones (browser_open in new tabs, then browser_read). Tell me what I was trying to find out, '
    + 'the key findings with their sources, where the sources agree or disagree, and what is still open. Keep it concise.';
}

// ── Unfinished ──

export interface OpenTab { id: string; url: string; title: string; pinned?: boolean; audible?: boolean; active?: boolean }

/** Things started and left: articles barely read, carts and checkouts, forms typed into, searches with no result opened. */
export function unfinished(d: LearnData, now: number, open: OpenTab[] = [], limit = 8): LearnItem[] {
  const openBy = new Map(open.map(t => [pageKey(t.url), t.id]));
  const out: LearnItem[] = [];
  const recency = (t: number): number => 0.5 ** ((now - t) / (2 * DAY));
  const act = (url: string): LearnItem['action'] => (openBy.has(url) ? { type: 'tab', tabId: openBy.get(url)!, url } : { type: 'open', url });
  for (const p of d.pages) {
    if (p.done || now - p.last > 7 * DAY || now - p.last < 2 * MIN || isExcluded(d, p.host)) continue;
    const kind = p.kind ?? guessKind(p.url);
    const title = p.title || p.url;
    const ref = (k: string): string => `${k}:${p.url}`;
    if ((kind === 'form' || kind === 'checkout') && p.typed) {
      if (isDismissed(d, ref('form'), now)) continue;
      out.push({ id: ref('form'), kind: 'form', icon: 'edit', title, url: p.url, site: p.host, score: 3 * recency(p.last), action: act(p.url), why: `You started filling this in ${ago(now - p.last)} and didn’t send it.` });
    } else if (kind === 'cart' || kind === 'checkout') {
      if (isDismissed(d, ref('cart'), now)) continue;
      out.push({ id: ref('cart'), kind: 'cart', icon: 'box', title, url: p.url, site: p.host, score: 2.5 * recency(p.last), action: act(p.url), why: `Left at the ${kind} on ${p.host} ${ago(now - p.last)} — no order confirmation followed.` });
    } else if (kind === 'article') {
      const readMs = p.words ? (p.words / 230) * MIN : 0;
      const barely = p.ms < MIN || (readMs > 0 && p.ms < 0.35 * readMs);
      if (!barely || (p.scroll ?? 0) >= 0.6 || isDismissed(d, ref('read'), now)) continue;
      const of = readMs ? ` of about ${Math.max(1, Math.round(readMs / MIN))} min` : '';
      const sc = typeof p.scroll === 'number' ? `, ${Math.round(p.scroll * 100)}% scrolled` : '';
      out.push({ id: ref('read'), kind: 'read', icon: 'book-open', title, url: p.url, site: p.host, score: 1.5 * recency(p.last), action: act(p.url), why: `Opened ${ago(now - p.first)}; you read ${fmtMin(p.ms)}${of}${sc}.` });
    } else if (kind === 'product' && (p.visits >= 2 || p.ms >= 2 * MIN)) {
      if (isDismissed(d, ref('product'), now)) continue;
      out.push({ id: ref('product'), kind: 'product', icon: 'tag', title, url: p.url, site: p.host, score: 1.2 * recency(p.last), action: act(p.url), why: `Viewed ${p.visits} time${p.visits === 1 ? '' : 's'} (${fmtMin(p.ms)} in all) — still deciding?` });
    }
  }
  for (const q of d.queries) {
    if (q.clicked || now - q.at > 3 * DAY || now - q.at < 5 * MIN || isExcluded(d, q.host)) continue;
    const id = `search:${q.q}`;
    if (isDismissed(d, id, now)) continue;
    const words = new Set(tokens(q.q));
    // Found later with a related search: not unfinished.
    if (d.queries.some(o => o !== q && o.clicked && o.at > q.at && tokens(o.q).some(w => words.has(w)))) continue;
    out.push({ id, kind: 'search', icon: 'search', title: q.q, url: q.url, site: q.host, score: 0.8 * recency(q.at), action: { type: 'open', url: q.url }, why: `You searched “${q.q}” ${ago(now - q.at)} and didn’t open a result.` });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Tabs ──

/**
 * How much each open tab matters now: when you last looked at it (half-life 6 h), how long you have spent on it,
 * how much you use its site, and whether something is unfinished there. Idle: not looked at for IDLE_DAYS, and
 * not pinned, playing, in front, or holding a form you started.
 */
export function tabPriorities(d: LearnData, tabs: OpenTab[], now: number, idleDays = IDLE_DAYS): LearnTab[] {
  const top = Math.max(1e-9, ...Object.keys(d.sites).map(h => siteScore(d, h, now)));
  return tabs.map((t) => {
    const key = pageKey(t.url);
    const host = hostKey(t.url);
    const rec = d.tabs[key];
    const focus = rec?.focus ?? now;
    const idleFor = Math.max(0, now - focus);
    const ms = rec?.ms ?? 0;
    const page = findPage(d, t.url);
    const kind = page?.kind ?? guessKind(t.url);
    const started = Boolean(page?.typed && !page.done && kind !== 'search');
    const recency = 0.5 ** (idleFor / (6 * 3600_000));
    const interest = host ? siteScore(d, host, now) / top : 0;
    const raw = 3 * recency + Math.min(3, Math.log2(1 + ms / MIN)) + 1.5 * interest + (started ? 2 : 0) + (kind === 'cart' || kind === 'checkout' ? 1 : 0) + (t.pinned ? 1 : 0);
    const idle = !t.pinned && !t.audible && !t.active && !started && idleFor >= idleDays * DAY && /^https?:/i.test(t.url);
    const why = started ? 'You started a form here and didn’t send it.'
      : t.active ? 'The tab in front.'
        : t.pinned ? 'Pinned.'
          : t.audible ? 'Playing sound.'
            : idle ? `Not looked at for ${Math.floor(idleFor / DAY)} days${ms ? ` (${fmtMin(ms)} on it in all)` : ''}.`
              : idleFor < 3600_000 && ms > 0 ? `Looked at ${ago(idleFor)} — ${fmtMin(ms)} on it.`
                : `Last looked at ${ago(idleFor)}.`;
    return {
      id: t.id, url: t.url, title: t.title || t.url, site: host, ...(kind ? { kind } : {}), priority: Math.round(Math.min(100, (raw / 8) * 100)),
      idle, idleFor, activeMs: ms, pinned: Boolean(t.pinned), active: Boolean(t.active), why,
    };
  }).sort((a, b) => b.priority - a.priority);
}

// ── Everything, for the For-you cards and the panel ──

export function buildView(d: LearnData, now: number, ctx: { tabs?: OpenTab[]; bookmarked?: Set<string>; current?: string } = {}): LearnView {
  const open = ctx.tabs ?? [];
  const unf = unfinished(d, now, open);
  const rts = routines(d, now);
  const ths = threads(d, now);
  const tabs = tabPriorities(d, open, now);
  const idle = tabs.filter(t => t.idle);
  const cleanup = idle.length >= 2 && !isDismissed(d, 'cleanup:idle', now)
    ? { tabs: idle, days: IDLE_DAYS, why: `${idle.length} tabs you haven’t looked at for ${IDLE_DAYS}+ days. Close them, or keep them as bookmarks.` }
    : null;
  const next = predict(d, now, { ...(ctx.current ? { from: ctx.current } : {}), limit: 6 });

  const pr: LearnItem[] = [];
  for (const u of unf.slice(0, 3)) pr.push({ ...u, kind: 'unfinished', score: 1 + u.score });
  for (const r of rts.filter(x => x.due).slice(0, 2)) {
    pr.push({ id: r.id, kind: 'routine', icon: 'clock', title: `Open ${r.site}`, url: r.url, site: r.site, score: 2 + r.hits / r.days, action: { type: 'open', url: r.url }, why: `${r.why} Not yet today.` });
  }
  for (const t of ths.filter(x => now - x.last < 2 * DAY).slice(0, 2)) {
    pr.push({ id: t.id, kind: 'thread', icon: 'compass', title: `Pick up “${t.label}”`, score: 1.5 + Math.min(1, t.pages.length / 10) * 0.5 ** ((now - t.last) / DAY), action: { type: 'ask', prompt: t.prompt }, why: `You’ve been researching this: ${t.why}` });
  }
  if (cleanup && idle.length >= 3) pr.push({ id: 'cleanup:idle', kind: 'cleanup', icon: 'layers', title: `Tidy ${idle.length} idle tabs`, score: Math.min(2.5, 1 + idle.length * 0.2), action: { type: 'cleanup' }, why: cleanup.why });
  const n0 = next[0];
  if (n0 && n0.score >= 0.25 && !pr.some(p => p.site === n0.site)) pr.push({ id: `next:${n0.site}`, kind: 'next', icon: 'arrow-right', title: `Go to ${n0.site}`, url: n0.url, site: n0.site, score: 1 + n0.score, action: { type: 'open', url: n0.url }, why: n0.why });

  return {
    paused: d.paused, since: Object.keys(d.sites).length ? d.since : 0, excluded: [...d.excluded],
    stats: { sites: Object.keys(d.sites).length, pages: d.pages.length, searches: d.queries.length, tabs: open.length },
    priorities: pr.sort((a, b) => b.score - a.score).slice(0, 5),
    unfinished: unf, routines: rts, threads: ths, cleanup, next,
    interests: interests(d, now, ctx.bookmarked), sites: topSites(d, now),
  };
}

// ── For the agent (browser_profile / browser_tabs_overview) ──

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** A readable summary of what was learned. URLs only for threads and unfinished items when asked. */
export function profileText(v: LearnView, opts: { section?: string; includeUrls?: boolean; days?: number } = {}): string {
  const want = (s: string): boolean => !opts.section || opts.section === 'all' || opts.section === s;
  const lines: string[] = [];
  lines.push(`Browsing profile — learned on this device only; learning is ${v.paused ? 'PAUSED' : 'on'}${v.since ? ` since ${shortDate(v.since)}` : ''}. ${v.stats.sites} sites, ${v.stats.pages} pages, ${v.stats.searches} searches remembered.`);
  if (!v.stats.sites) { lines.push('Nothing has been learned yet (or the user chose “Forget everything”).'); return lines.join('\n'); }
  if (want('interests')) {
    lines.push('', 'INTERESTS (share of recent browsing):');
    for (const i of v.interests) lines.push(`- ${i.label} ${pct(i.share)} — ${i.sites.join(', ')}`);
    lines.push(`Top sites: ${v.sites.slice(0, 8).map(s => s.site).join(', ')}`);
  }
  if (want('routines')) {
    lines.push('', 'ROUTINES:');
    if (!v.routines.length) lines.push('- none clear yet');
    for (const r of v.routines) lines.push(`- ${r.site}: ${r.label}${r.hour !== undefined ? ` around ${hourLabel(r.hour)}` : ''} (${r.hits}/${r.days} days)${r.due ? ' — due now, not yet today' : ''}`);
  }
  if (want('threads')) {
    lines.push('', `RESEARCH THREADS (last ${opts.days ?? 14} days):`);
    if (!v.threads.length) lines.push('- none');
    for (const t of v.threads) {
      lines.push(`- “${t.label}” — ${t.why} Sites: ${t.sites.slice(0, 5).join(', ')}${t.queries.length ? `. Searches: ${t.queries.slice(0, 4).map(q => `“${q}”`).join(', ')}` : ''}`);
      if (opts.includeUrls) for (const p of t.pages.slice(0, 8)) lines.push(`    · ${p.title} — ${p.url}`);
    }
  }
  if (want('unfinished')) {
    lines.push('', 'CONTINUE WHERE THEY LEFT OFF:');
    if (!v.unfinished.length) lines.push('- nothing unfinished');
    for (const u of v.unfinished) lines.push(`- [${u.kind}] ${u.title} (${u.site}) — ${u.why}${opts.includeUrls && u.url ? ` ${u.url}` : ''}`);
  }
  if (want('priorities')) {
    lines.push('', 'PRIORITIES NOW:');
    for (const p of v.priorities) lines.push(`- ${p.title} — ${p.why}`);
  }
  if (want('next')) {
    lines.push('', 'LIKELY NEXT SITES:');
    for (const n of v.next.slice(0, 5)) lines.push(`- ${n.site} — ${n.why}`);
  }
  if (want('tabs') || !opts.section || opts.section === 'all') {
    lines.push('', `OPEN TABS: ${v.stats.tabs}${v.cleanup ? `, ${v.cleanup.tabs.length} idle for ${v.cleanup.days}+ days` : ''} — browser_tabs_overview lists them with priorities.`);
  }
  return lines.join('\n');
}

export function tabsText(tabs: LearnTab[]): string {
  if (!tabs.length) return 'No tabs are open.';
  const idle = tabs.filter(t => t.idle);
  return [
    `${tabs.length} open tabs, highest priority first (priority 0–100; idle = not looked at for ${IDLE_DAYS}+ days and safe to close or bookmark).`,
    ...tabs.map(t => `- [${t.id}] ${t.priority}${t.idle ? ' IDLE' : ''}${t.pinned ? ' pinned' : ''}${t.active ? ' in-front' : ''} · ${t.kind ?? 'page'} · ${t.title.slice(0, 90)} (${t.site || t.url.slice(0, 40)}) — ${t.why}`),
    idle.length ? `Idle tab ids: ${idle.map(t => t.id).join(', ')}. browser_organize_tabs can bookmark and/or close them (closing more than one asks the user first).` : 'No idle tabs.',
  ].join('\n');
}

/** Seed from existing history on first run, so the cards are useful at once. Visit counts only — no times of day. */
export function seedFromHistory(d: LearnData, history: Array<{ url: string; title: string; visits: number; lastVisit: number }>, now: number): void {
  for (const h of history.slice(0, 2000)) {
    const host = hostKey(h.url);
    if (!host || isExcluded(d, host) || !(h.lastVisit > 0)) continue;
    const fresh = !d.sites[host];
    const s = siteOf(d, host, now);
    s.score += decay(Math.log2(1 + h.visits), h.lastVisit, now, HALF_LIFE.site);
    s.visits += h.visits;
    s.first = Math.min(s.first, h.lastVisit);
    s.last = fresh ? h.lastVisit : Math.max(s.last, h.lastVisit);
    if (h.title && s.titles.length < CAPS.titles) s.titles.push(h.title.slice(0, 200));
  }
}
