/**
 * The browsing digest for "About you" (ADR 0018): what the engine's learner
 * may know about how the person browses, reduced to aggregates before it ever
 * leaves the browser's own store.
 *
 * WHY A DIGEST, NOT learn.json. The browser learner (browser-learn-core.ts)
 * keeps addresses with paths, page titles and whole searches, because the
 * For-you cards need them. The engine's learner does not, and whatever it
 * reads can end up in a model call. So main writes a second, much smaller
 * file — `<AICO_HOME>/desktop/browser/profile-digest.json` — that holds:
 *   - registrable domains only (`github.com`, never `gist.github.com/me/…`)
 *     with a category from a small readable table, minutes and visits over
 *     the last 30 days;
 *   - research-thread topic words (no titles, no addresses);
 *   - search *words*, stop-worded and counted — never a whole query;
 *   - visits by hour and weekday; reading depth (skim / read) and time on
 *     page; the mix of page kinds.
 *
 * WHAT NEVER REACHES IT, enforced here in code:
 *   - anything while learning is paused (the file says only `paused`), or
 *     when "Let About you use my browsing" is off (`off`);
 *   - excluded sites, pages the agent drove, flagged pages and incognito-like
 *     sessions — the learner never records them (browser-learn.ts), and
 *     excluded sites are checked again here in case the list changed;
 *   - sensitive domains and words (health, religion, politics, sexuality,
 *     ethnicity, finances, precise location, family, dating, adult —
 *     shared/sensitive-topics.ts). A search that touches one is dropped
 *     whole, not stripped of its sensitive word.
 *
 * Pure apart from writing the file, so the desktop unit suite runs it on
 * synthetic data (scripts/test-browser-profile-digest.mjs). No Electron import.
 *
 * @module desktop/electron/browser-profile-digest
 */

import fs from 'node:fs';
import path from 'node:path';
import { DAY, dayIndex, isExcluded, threads, tokens, weekdayOf, type LearnData } from './browser-learn-core';
import { topicOf, type Topic } from './browser-learn-topics';
import { sensitiveArea, sensitiveDomain } from '../../shared/sensitive-topics';
import type { ProfileDigest } from '../shared/profile-digest-types';

export const DIGEST_WINDOW_DAYS = 30;
const MAX_DOMAINS = 40;
const MAX_THREADS = 8;
const MAX_TERMS = 20;

/** Second-level labels under which the registrable domain is three labels long. */
const SECOND_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.in', 'co.jp', 'com.br',
  'com.cn', 'com.mx', 'co.za', 'com.sg', 'com.tr', 'co.kr', 'com.ar', 'com.hk', 'com.tw', 'co.il',
]);

/** The registrable domain of a host; '' for an IP address or anything that is not a web host. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!h || h.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return '';
  if (h === 'localhost' || h.endsWith('.localhost')) return 'localhost';
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  return SECOND_LEVEL.has(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

/** A few sites whose kind the topic table blurs (code hosting vs. Q&A vs. packages). */
const OVERRIDES: Record<string, string> = {
  'github.com': 'code hosting', 'gitlab.com': 'code hosting', 'bitbucket.org': 'code hosting', 'codeberg.org': 'code hosting',
  'stackoverflow.com': 'developer Q&A', 'stackexchange.com': 'developer Q&A', 'superuser.com': 'developer Q&A', 'serverfault.com': 'developer Q&A',
  'npmjs.com': 'package registries', 'pypi.org': 'package registries', 'crates.io': 'package registries', 'nuget.org': 'package registries',
  'news.ycombinator.com': 'tech news', 'localhost': 'local development',
};
const DEV_DOCS = /^(docs|developer|developers|devdocs|learn|api)\.|readthedocs|docs\.rs$|pkg\.go\.dev$|python\.org$|mozilla\.org$|w3schools\.com$/;
/** Topic → category; null means the topic itself is sensitive and the site is left out. */
const BY_TOPIC: Record<Topic, string | null> = {
  Programming: 'developer sites', AI: 'AI tools', 'Docs & reference': 'reference', News: 'news', Shopping: 'shopping', Video: 'video',
  Social: 'social', 'Mail & chat': 'mail & chat', 'Work & productivity': 'work tools', Finance: null, Travel: 'travel', Learning: 'learning',
  Music: 'music', Games: 'games', Sports: 'sports', 'Food & recipes': 'food & recipes', Health: null, Design: 'design',
  'Jobs & careers': 'jobs & careers', 'Home & DIY': 'home & DIY', Science: 'science', Search: 'search', Other: 'other',
};

/** What kind of site a host is, or null when it must not be in the digest at all. */
export function categoryOf(host: string, titles: string[] = []): string | null {
  const h = host.toLowerCase().replace(/^www\./, '');
  if (sensitiveDomain(h)) return null;
  const domain = registrableDomain(h);
  if (OVERRIDES[h]) return OVERRIDES[h]!;
  if (OVERRIDES[domain]) return OVERRIDES[domain]!;
  const topic = topicOf(h, titles);
  const cat = BY_TOPIC[topic];
  if (cat === 'reference' && DEV_DOCS.test(h)) return 'developer docs';
  if (cat === 'developer sites' && DEV_DOCS.test(h)) return 'developer docs';
  return cat;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface DigestOptions {
  /** "Let About you use my browsing". Default on. */
  useBrowsing?: boolean;
  windowDays?: number;
}

const empty = (now: number, windowDays: number): ProfileDigest => ({
  v: 1, at: now, windowDays, domains: [], categories: [], threads: [], searchTerms: [],
  routines: { hours: new Array(24).fill(0), weekdays: new Array(7).fill(0) },
  reading: { pages: 0, medianSeconds: 0, skim: 0, partial: 0, read: 0, style: 'unknown' }, kinds: {}, dropped: { sensitive: 0, excluded: 0 },
});

/** The digest for this moment. Pure over `d`. */
export function buildDigest(d: LearnData, now: number, opts: DigestOptions = {}): ProfileDigest {
  const windowDays = opts.windowDays ?? DIGEST_WINDOW_DAYS;
  const out = empty(now, windowDays);
  if (d.paused) return { ...out, paused: true };
  if (opts.useBrowsing === false) return { ...out, off: true };
  const since = now - windowDays * DAY;
  const firstDay = dayIndex(since);

  // Which hosts may count at all, decided once.
  const verdict = new Map<string, { domain: string; category: string } | 'sensitive' | 'excluded'>();
  const judge = (host: string): { domain: string; category: string } | 'sensitive' | 'excluded' => {
    const hit = verdict.get(host);
    if (hit) return hit;
    let v: { domain: string; category: string } | 'sensitive' | 'excluded';
    const domain = registrableDomain(host);
    if (!domain || isExcluded(d, host)) v = 'excluded';
    else {
      const category = categoryOf(host, d.sites[host]?.titles ?? []);
      v = category ? { domain, category } : 'sensitive';
    }
    verdict.set(host, v);
    return v;
  };

  // Domains: minutes and visits from the pages seen in the window, days from the site's routine record.
  const rows = new Map<string, { domain: string; category: string; ms: number; visits: number; days: Set<number> }>();
  const droppedHosts = { sensitive: new Set<string>(), excluded: new Set<string>() };
  const readMs: number[] = [];
  for (const p of d.pages) {
    if (p.last < since) continue;
    const v = judge(p.host);
    if (v === 'sensitive' || v === 'excluded') { droppedHosts[v].add(p.host); continue; }
    // A page title or search that is itself sensitive drops the page, even on an ordinary site.
    if (sensitiveArea(`${p.title} ${p.query ?? ''} ${p.from ?? ''}`)) { droppedHosts.sensitive.add(`${p.host}#page`); continue; }
    const key = `${v.domain}|${v.category}`;
    const row = rows.get(key) ?? { domain: v.domain, category: v.category, ms: 0, visits: 0, days: new Set<number>() };
    row.ms += p.ms; row.visits += Math.max(1, p.visits);
    rows.set(key, row);
    if (p.kind && p.kind !== 'login') out.kinds[p.kind] = (out.kinds[p.kind] ?? 0) + 1;
    if (p.ms > 0 && p.kind !== 'search') {
      readMs.push(p.ms);
      if (typeof p.scroll === 'number') {
        if (p.scroll < 0.3) out.reading.skim++; else if (p.scroll < 0.7) out.reading.partial++; else out.reading.read++;
      }
    }
  }
  for (const [host, s] of Object.entries(d.sites)) {
    const v = judge(host);
    if (typeof v === 'string') { if (s.last >= since) droppedHosts[v].add(host); continue; }
    const row = rows.get(`${v.domain}|${v.category}`);
    for (const [day] of Object.entries(s.seen)) {
      const n = Number(day);
      if (n < firstDay) continue;
      row?.days.add(n);
      out.routines.weekdays[weekdayOf(n)]! += 1;
    }
    if (s.last >= since) s.hours.forEach((x, h) => { out.routines.hours[h]! += x; });
  }
  out.routines.hours = out.routines.hours.map(x => Math.round(x * 10) / 10);
  out.domains = [...rows.values()]
    .map(r => ({ domain: r.domain, category: r.category, minutes: Math.round(r.ms / 60_000), visits: r.visits, days: r.days.size }))
    .sort((a, b) => b.minutes - a.minutes || b.visits - a.visits || a.domain.localeCompare(b.domain))
    .slice(0, MAX_DOMAINS);
  const cats = new Map<string, { minutes: number; visits: number }>();
  for (const r of rows.values()) {
    const c = cats.get(r.category) ?? { minutes: 0, visits: 0 };
    c.minutes += r.ms / 60_000; c.visits += r.visits;
    cats.set(r.category, c);
  }
  out.categories = [...cats.entries()].map(([category, c]) => ({ category, minutes: Math.round(c.minutes), visits: c.visits }))
    .sort((a, b) => b.minutes - a.minutes || b.visits - a.visits);

  // Research threads: topic words only, and none that touch a sensitive area or a left-out site.
  for (const t of threads(d, now, windowDays, MAX_THREADS * 2)) {
    if (sensitiveArea(t.terms.join(' ')) || t.sites.some(h => typeof judge(h) === 'string')) { droppedHosts.sensitive.add(`thread:${t.id}`); continue; }
    out.threads.push({ terms: t.terms.slice(0, 3), pages: t.pages.length, sites: t.sites.length, last: t.last });
    if (out.threads.length >= MAX_THREADS) break;
  }

  // Search words: a query touching a sensitive area is dropped whole; the rest become counted words.
  const terms = new Map<string, number>();
  for (const q of d.queries) {
    if (q.at < since) continue;
    if (q.host && judge(q.host) === 'excluded') continue;
    if (sensitiveArea(q.q)) { droppedHosts.sensitive.add(`q:${q.q}`); continue; }
    for (const w of new Set(tokens(q.q))) {
      if (w.length > 24 || /\d{3,}/.test(w) || sensitiveArea(w)) continue;
      terms.set(w, (terms.get(w) ?? 0) + Math.max(1, q.count));
    }
  }
  out.searchTerms = [...terms.entries()].map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term)).slice(0, MAX_TERMS);

  out.reading.pages = readMs.length;
  out.reading.medianSeconds = Math.round(median(readMs) / 1000);
  const scrolled = out.reading.skim + out.reading.partial + out.reading.read;
  out.reading.style = scrolled < 5 ? 'unknown'
    : out.reading.skim / scrolled >= 0.5 ? 'skims'
      : out.reading.read / scrolled >= 0.5 ? 'reads' : 'mixed';
  out.dropped = { sensitive: droppedHosts.sensitive.size, excluded: droppedHosts.excluded.size };
  return out;
}

export function digestFile(desktopDir: string): string {
  return path.join(desktopDir, 'browser', 'profile-digest.json');
}

/** Write atomically (tmp + rename), so the engine never reads half a file. Best effort. */
export function writeDigest(file: string, digest: ProfileDigest): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(digest));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; /* the next interval or quit writes again */ }
}

/** "Let About you use my browsing" — its own small file, on unless the person turned it off. */
export function readUseBrowsing(file: string): boolean {
  try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as { useBrowsing?: unknown }).useBrowsing !== false; } catch { return true; }
}

export function writeUseBrowsing(file: string, on: boolean): void {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ useBrowsing: on })); } catch { /* best effort */ }
}
