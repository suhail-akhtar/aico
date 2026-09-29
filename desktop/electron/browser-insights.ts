/**
 * Browsing insights — what you did and what AICO blocked, kept only on this
 * device (`<AICO_HOME>/desktop/browser/insights.json`) and never sent
 * anywhere. Pure data operations, so the bucketing is unit-tested.
 *
 * One bucket per local calendar day. Each day holds per-site active time
 * (counted only while the tab is in front and the window is focused and in
 * use), visits and pages, trackers blocked per site and per company, and the
 * day's counters: third-party cookies blocked, HTTPS upgrades, suspicious
 * pages warned, downloads. Days older than KEEP_DAYS are dropped, and the
 * busiest sites/companies are kept when a day grows past its caps, so the
 * file stays small (tens of KB) however long you browse.
 *
 * @module desktop/electron/browser-insights
 */

export interface SiteDay { ms: number; visits: number; pages: number; trackers: number }

export interface DayBucket {
  sites: Record<string, SiteDay>;
  companies: Record<string, number>;
  trackers: number;
  cookies: number;
  upgrades: number;
  warned: number;
  downloads: number;
}

export interface InsightsData { v: 1; days: Record<string, DayBucket> }

export type Counter = 'cookies' | 'upgrades' | 'warned' | 'downloads';

export const KEEP_DAYS = 120;
export const MAX_SITES_PER_DAY = 250;
export const MAX_COMPANIES_PER_DAY = 120;

export const emptyInsights = (): InsightsData => ({ v: 1, days: {} });

/** The local calendar day a moment falls on: 2026-09-29. */
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const emptyDay = (): DayBucket => ({ sites: {}, companies: {}, trackers: 0, cookies: 0, upgrades: 0, warned: 0, downloads: 0 });
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function normaliseInsights(raw: unknown): InsightsData {
  const out = emptyInsights();
  const days = (raw as InsightsData | undefined)?.days;
  if (!days || typeof days !== 'object') return out;
  for (const [k, v] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== 'object') continue;
    const d = emptyDay();
    for (const c of ['trackers', 'cookies', 'upgrades', 'warned', 'downloads'] as const) d[c] = num((v as DayBucket)[c]);
    for (const [site, s] of Object.entries((v as DayBucket).sites ?? {})) {
      if (s && typeof s === 'object') d.sites[site] = { ms: num(s.ms), visits: num(s.visits), pages: num(s.pages), trackers: num(s.trackers) };
    }
    for (const [co, n] of Object.entries((v as DayBucket).companies ?? {})) if (num(n)) d.companies[co] = num(n);
    out.days[k] = d;
  }
  return out;
}

function day(data: InsightsData, t: number): DayBucket {
  const k = dayKey(t);
  return (data.days[k] ??= emptyDay());
}
function site(d: DayBucket, s: string): SiteDay {
  return (d.sites[s] ??= { ms: 0, visits: 0, pages: 0, trackers: 0 });
}

/** Time the page was in front and in use. */
export function recordActive(data: InsightsData, t: number, siteName: string, ms: number): void {
  if (!siteName || !(ms > 0)) return;
  site(day(data, t), siteName).ms += Math.min(ms, 60_000);
}

/** A page load; `visit` when it arrived from another site (or a fresh tab). */
export function recordPage(data: InsightsData, t: number, siteName: string, visit: boolean): void {
  if (!siteName) return;
  const s = site(day(data, t), siteName);
  s.pages++;
  if (visit) s.visits++;
}

export function recordTracker(data: InsightsData, t: number, siteName: string, company: string): void {
  const d = day(data, t);
  d.trackers++;
  if (siteName) site(d, siteName).trackers++;
  if (company) d.companies[company] = (d.companies[company] ?? 0) + 1;
}

export function recordCount(data: InsightsData, t: number, counter: Counter, n = 1): void {
  if (!(n > 0)) return;
  day(data, t)[counter] += n;
}

const topEntries = <T>(rec: Record<string, T>, score: (v: T) => number, keep: number): Record<string, T> =>
  Object.fromEntries(Object.entries(rec).sort((a, b) => score(b[1]) - score(a[1])).slice(0, keep));

/** Drop old days and trim each day to its busiest sites and companies. */
export function pruneInsights(data: InsightsData, now: number, keepDays = KEEP_DAYS): InsightsData {
  const oldest = dayKey(now - keepDays * 86_400_000);
  for (const k of Object.keys(data.days)) {
    if (k < oldest) { delete data.days[k]; continue; }
    const d = data.days[k]!;
    if (Object.keys(d.sites).length > MAX_SITES_PER_DAY) d.sites = topEntries(d.sites, s => s.ms + s.pages * 1000 + s.trackers, MAX_SITES_PER_DAY);
    if (Object.keys(d.companies).length > MAX_COMPANIES_PER_DAY) d.companies = topEntries(d.companies, n => n, MAX_COMPANIES_PER_DAY);
  }
  return data;
}

/** Forget days on or after `sinceMs` (everything when omitted) — "Clear browsing data" and "Clear insights". */
export function clearInsights(data: InsightsData, sinceMs?: number): InsightsData {
  if (sinceMs === undefined || !Number.isFinite(sinceMs) || sinceMs <= 0) return emptyInsights();
  const from = dayKey(sinceMs);
  for (const k of Object.keys(data.days)) if (k >= from) delete data.days[k];
  return data;
}

export interface InsightsSummary {
  range: number;
  /** Oldest to newest, one entry per day in the range (empty days included). */
  days: Array<{ day: string; trackers: number; ms: number; cookies: number; upgrades: number; pages: number }>;
  totals: { trackers: number; cookies: number; upgrades: number; warned: number; downloads: number; ms: number; visits: number; pages: number; sites: number };
  topSites: Array<{ site: string; ms: number; visits: number; pages: number; trackers: number }>;
  topCompanies: Array<{ company: string; count: number }>;
  /** The first day anything was recorded (for "since …"), '' when nothing was. */
  since: string;
}

/** The last `range` days ending today, summed. */
export function summarizeInsights(data: InsightsData, now: number, range = 7): InsightsSummary {
  const days: InsightsSummary['days'] = [];
  const totals: InsightsSummary['totals'] = { trackers: 0, cookies: 0, upgrades: 0, warned: 0, downloads: 0, ms: 0, visits: 0, pages: 0, sites: 0 };
  const sites = new Map<string, SiteDay>();
  const companies = new Map<string, number>();
  const today = new Date(now);
  for (let i = range - 1; i >= 0; i--) {
    // Step by calendar day (not 24 h), so daylight-saving changes never skip or repeat a day.
    const k = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 12).getTime());
    const d = data.days[k];
    let ms = 0; let pages = 0;
    if (d) {
      for (const [name, s] of Object.entries(d.sites)) {
        ms += s.ms; pages += s.pages;
        const a = sites.get(name) ?? { ms: 0, visits: 0, pages: 0, trackers: 0 };
        a.ms += s.ms; a.visits += s.visits; a.pages += s.pages; a.trackers += s.trackers;
        sites.set(name, a);
        totals.visits += s.visits;
      }
      for (const [co, n] of Object.entries(d.companies)) companies.set(co, (companies.get(co) ?? 0) + n);
      totals.trackers += d.trackers; totals.cookies += d.cookies; totals.upgrades += d.upgrades; totals.warned += d.warned; totals.downloads += d.downloads;
    }
    totals.ms += ms; totals.pages += pages;
    days.push({ day: k, trackers: d?.trackers ?? 0, ms, cookies: d?.cookies ?? 0, upgrades: d?.upgrades ?? 0, pages });
  }
  totals.sites = sites.size;
  const all = Object.keys(data.days).sort();
  return {
    range, days, totals,
    topSites: [...sites.entries()].map(([s, v]) => ({ site: s, ...v })).sort((a, b) => b.ms - a.ms || b.pages - a.pages).slice(0, 12),
    topCompanies: [...companies.entries()].map(([company, count]) => ({ company, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    since: all[0] ?? '',
  };
}
