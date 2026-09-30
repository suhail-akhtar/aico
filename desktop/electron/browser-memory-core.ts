/**
 * "Remember what I read" — the pure half of the browser's local memory by
 * meaning: which pages may be remembered, the on-disk store (one sealed file
 * per page), the search index, and the time phrases people use when they ask
 * ("the red leather jacket I looked at last week").
 *
 * WHY A LEXICAL INDEX, NOT EMBEDDINGS. The request was search by meaning with
 * no cloud call and no heavy new dependency. A local embedding model means a
 * 30–400 MB model file, a native or WASM runtime and seconds of CPU per page —
 * an ADR-sized decision (new dependency, new download). What people actually
 * ask of their own reading is recall of something they saw, described in the
 * words the page used, often with a time ("last week", "on Monday"). BM25 over
 * title, site and main text, with a light English stemmer (jackets → jacket,
 * looked → look), a small synonym table (coat ≈ jacket, laptop ≈ notebook),
 * one- or two-letter typo tolerance against the index's own vocabulary, and a
 * parsed time window answers those well, in milliseconds, with nothing to
 * download. Embeddings stay future work, behind the same `searchMemory` shape.
 *
 * What is never remembered (`rememberable`): internal pages, pages Protected
 * Browsing flagged, excluded sites, pages the agent is driving, pages with a
 * password or payment-card field, and anything outside the browser's own
 * persistent profile (an incognito-like session). The person's own settings
 * — off by default — are checked by the caller (browser-memory.ts).
 *
 * The store takes its cipher from the caller (Electron's safeStorage in the
 * app, a stand-in in the unit tests), like browser-vault-core.ts.
 *
 * @module desktop/electron/browser-memory-core
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryAnswer, MemoryHit, MemoryStatus, TimeWindow } from '../shared/browser-memory-types';

export type { MemoryAnswer, MemoryHit, TimeWindow };

export const DAY = 86_400_000;
export const MAX_TEXT = 8000;
export const LIMITS = { pages: 5000, bytes: 100 * 1024 * 1024 };

export interface MemoryPage {
  id: string;
  url: string;
  title: string;
  site: string;
  /** Clean main text, trimmed to MAX_TEXT characters. */
  text: string;
  first: number;
  last: number;
  /** When it was read (newest last, capped). */
  visits: number[];
}

// ── What may be remembered ──

export interface RememberCheck {
  url: string;
  flagged?: boolean;
  byAgent?: boolean;
  excluded?: boolean;
  /** A password or payment-card field is on the page. */
  sensitive?: boolean;
  /** The page is in the browser's persistent profile (false = incognito-like). */
  persistent?: boolean;
}

/** Why a page must not be remembered, or null when it may be. */
export function whyNotRemember(c: RememberCheck): string | null {
  if (!/^https?:\/\//i.test(c.url)) return 'internal';
  if (c.persistent === false) return 'private';
  if (c.flagged) return 'flagged';
  if (c.byAgent) return 'agent';
  if (c.excluded) return 'excluded';
  if (c.sensitive) return 'sensitive';
  return null;
}

/** The key a page is remembered under: without its #fragment and tracking parameters. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_|ref$|ref_)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch { return url; }
}

export const pageId = (url: string): string => crypto.createHash('sha256').update(pageKey(url)).digest('hex').slice(0, 20);

export function siteOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

// ── Words ──

const STOP = new Set(('a an and are as at be been but by can could did do does doing for from had has have i if in into is it its '
  + 'me my of on or our so some than that the their them then there these they this those to too us was we were what when where which '
  + 'who why will with would you your about again ago any earlier before find show tell remember looked look looking saw see seen '
  + 'read reading visited visit viewing viewed page pages site website thing something one ones was were that thingy stuff know just '
  + 'please help me yeah the lol also get got like').split(/\s+/));

/** A light English stemmer: plurals, -ing, -ed, -ly. Both the index and the query go through it, so it need only be consistent. */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  let s = w;
  if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith('sses')) s = s.slice(0, -2);
  else if (s.endsWith('es') && /(ch|sh|x|z|ss)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s') && !/(ss|us|is|ous)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed') && !s.endsWith('eed')) s = s.slice(0, -2);
  else if (s.length > 5 && s.endsWith('ly')) s = s.slice(0, -2);
  // "shopp(ing)" → "shop", "stopp(ed)" → "stop".
  if (s !== w && /([bdgmnprt])\1$/.test(s)) s = s.slice(0, -1);
  return s;
}

export function words(text: string): string[] {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length > 1 && w.length < 30);
}

export function terms(text: string, keepStop = false): string[] {
  return words(text).filter(w => keepStop || !STOP.has(w)).map(stem);
}

/** A small synonym table — the words people swap when they describe what they saw. Stemmed. */
const SYN_GROUPS = [
  ['jacket', 'coat', 'blazer', 'parka'], ['laptop', 'notebook', 'ultrabook'], ['phone', 'smartphone', 'mobile', 'handset'],
  ['cheap', 'inexpensive', 'affordable', 'budget', 'bargain'], ['price', 'cost'], ['buy', 'purchase', 'order'],
  ['tv', 'television'], ['sofa', 'couch', 'settee'], ['sneaker', 'trainer'], ['film', 'movie'], ['car', 'auto', 'vehicle'],
  ['headphone', 'earphone', 'headset', 'earbud'], ['bag', 'handbag', 'purse'], ['jean', 'denim'], ['grey', 'gray'],
  ['colour', 'color'], ['hotel', 'accommodation', 'lodging'], ['flight', 'airfare'], ['article', 'story', 'post', 'blog'],
  ['recipe', 'dish'], ['job', 'vacancy', 'role', 'position'], ['monitor', 'display', 'screen'], ['watch', 'smartwatch'],
];
const SYN = new Map<string, string[]>();
for (const g of SYN_GROUPS) { const s = g.map(stem); for (const w of s) SYN.set(w, s.filter(x => x !== w)); }
export const synonymsOf = (t: string): string[] => SYN.get(t) ?? [];

/** Edit distance with a cap (early exit), for typo tolerance. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

// ── Time phrases ──

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t: number, n: number): number => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const startOfWeek = (t: number): number => { const s = startOfDay(t); const wd = (new Date(s).getDay() + 6) % 7; return addDays(s, -wd); };
const NUMS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };

/**
 * Pull a time phrase out of a query: "red leather jacket I looked at last week"
 * → { rest: "red leather jacket I looked at", window: since last week's Monday }.
 * Windows are forgiving on purpose — people say "last week" about four days ago
 * — so "last week" runs from the Monday of the previous week until now.
 */
export function parseTime(query: string, now: number): { rest: string; window: TimeWindow | null } {
  const q = ` ${query.toLowerCase()} `;
  const today = startOfDay(now);
  const tries: Array<[RegExp, (m: RegExpMatchArray) => TimeWindow | null]> = [
    [/\b(earlier )?today\b|\bthis (morning|afternoon|evening)\b|\btonight\b/, () => ({ since: today, until: now, label: 'today' })],
    [/\blast night\b/, () => ({ since: addDays(today, -1) + 17 * 3600_000, until: today + 6 * 3600_000, label: 'last night' })],
    [/\b(yesterday|the day before)\b/, () => ({ since: addDays(today, -1), until: today, label: 'yesterday' })],
    [/\bthis week\b/, () => ({ since: startOfWeek(now), until: now, label: 'this week' })],
    [/\b(last|past|previous) week(end)?\b|\ba week ago\b/, (m) => (m[2]
      ? { since: addDays(startOfWeek(now), -2), until: startOfWeek(now), label: 'last weekend' }
      : { since: addDays(startOfWeek(now), -7), until: now, label: 'last week' })],
    [/\bthis month\b/, () => { const d = new Date(now); return { since: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), until: now, label: 'this month' }; }],
    [/\b(last|past|previous) month\b|\ba month ago\b/, () => { const d = new Date(now); return { since: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), until: now, label: 'last month' }; }],
    [/\b(?:in the |over the )?(?:last|past) (\d+|two|three|four|five|six|seven|eight|nine|ten|few|couple(?: of)?) days\b/, (m) => {
      const n = NUMS[m[1]!.replace(' of', '')] ?? Number(m[1]); return { since: addDays(today, -n), until: now, label: `the last ${n} days` };
    }],
    [/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|few|couple(?: of)?) days? ago\b/, (m) => {
      const key = m[1]!.replace(' of', '');
      if (key === 'few' || key === 'couple') { const n = NUMS[key]!; return { since: addDays(today, -n - 3), until: addDays(today, -1) + DAY, label: `${key} days ago` }; }
      const n = NUMS[key] ?? Number(m[1]);
      return { since: addDays(today, -n - 1), until: addDays(today, -n + 1), label: `${n} day${n === 1 ? '' : 's'} ago` };
    }],
    // "on Monday", "last Friday" — a bare day name is left alone ("Cyber Monday deals" is not a date).
    [/\b(?:on |last |this past )(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/, (m) => {
      const want = DAYS.indexOf(m[1]!);
      let d = today;
      for (let i = 1; i <= 7; i++) { d = addDays(today, -i); if (new Date(d).getDay() === want) break; }
      return { since: d, until: addDays(d, 1), label: `on ${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}` };
    }],
    [/\brecently\b|\bthe other day\b/, () => ({ since: addDays(today, -7), until: now, label: 'recently' })],
  ];
  for (const [re, fn] of tries) {
    const m = q.match(re);
    if (!m) continue;
    const w = fn(m);
    if (!w) continue;
    const rest = q.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    return { rest, window: w };
  }
  return { rest: query.trim(), window: null };
}

/** An explicit `since` from the agent: a date ("2026-09-20"), a phrase ("last week"), or a number of days. */
export function parseSince(since: string | number | undefined, now: number): TimeWindow | null {
  if (since === undefined || since === '') return null;
  if (typeof since === 'number' && Number.isFinite(since)) return { since: addDays(startOfDay(now), -Math.max(0, since)), until: now, label: `the last ${since} days` };
  const s = String(since).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const t = new Date(s.length === 10 ? `${s}T00:00:00` : s).getTime(); if (Number.isFinite(t)) return { since: t, until: now, label: `since ${s.slice(0, 10)}` }; }
  if (/^\d+$/.test(s)) return parseSince(Number(s), now);
  return parseTime(s, now).window;
}

// ── The index ──

interface Doc { page: MemoryPage; tf: Map<string, number>; len: number }
const FIELD = { title: 3, site: 1.5, url: 1, text: 1 };

export class MemoryIndex {
  private docs = new Map<string, Doc>();
  private df = new Map<string, number>();
  private totalLen = 0;

  get size(): number { return this.docs.size; }
  has(id: string): boolean { return this.docs.has(id); }
  get(id: string): MemoryPage | undefined { return this.docs.get(id)?.page; }
  pages(): MemoryPage[] { return [...this.docs.values()].map(d => d.page); }

  add(page: MemoryPage): void {
    this.remove(page.id);
    const tf = new Map<string, number>();
    const put = (text: string, w: number): void => { for (const t of terms(text)) tf.set(t, (tf.get(t) ?? 0) + w); };
    put(page.title, FIELD.title);
    put(page.site.replace(/\./g, ' '), FIELD.site);
    try { put(decodeURIComponent(new URL(page.url).pathname).replace(/[-_/.]/g, ' '), FIELD.url); } catch { /* no path */ }
    put(page.text, FIELD.text);
    let len = 0;
    for (const [t, n] of tf) { len += n; this.df.set(t, (this.df.get(t) ?? 0) + 1); }
    this.docs.set(page.id, { page, tf, len });
    this.totalLen += len;
  }

  remove(id: string): void {
    const d = this.docs.get(id);
    if (!d) return;
    for (const t of d.tf.keys()) { const n = (this.df.get(t) ?? 1) - 1; if (n > 0) this.df.set(t, n); else this.df.delete(t); }
    this.totalLen -= d.len;
    this.docs.delete(id);
  }

  /** Query terms, each with the index terms it stands for and their weights: itself, synonyms, near-misspellings. */
  expand(query: string): Array<{ term: string; alts: Array<[string, number]> }> {
    const qs = [...new Set(terms(query))];
    return qs.map((term) => {
      const alts: Array<[string, number]> = [];
      if (this.df.has(term)) alts.push([term, 1]);
      for (const s of synonymsOf(term)) if (this.df.has(s)) alts.push([s, 0.6]);
      if (!this.df.has(term) && term.length >= 4 && !/\d/.test(term)) {
        const max = term.length >= 7 ? 2 : 1;
        for (const v of this.df.keys()) {
          if (Math.abs(v.length - term.length) > max || v[0] !== term[0]) continue;
          const dist = editDistance(term, v, max);
          if (dist <= max) alts.push([v, dist === 1 ? 0.5 : 0.35]);
        }
      }
      return { term, alts };
    });
  }

  search(query: string, o: { window?: TimeWindow | null; limit?: number; now: number }): Array<{ page: MemoryPage; score: number; matched: string[] }> {
    const q = this.expand(query);
    const N = this.docs.size || 1;
    const avg = this.totalLen / N || 1;
    const k1 = 1.2; const b = 0.75;
    const out: Array<{ page: MemoryPage; score: number; matched: string[] }> = [];
    const asked = q.filter(x => x.alts.length || x.term.length > 2).length || 1;
    for (const d of this.docs.values()) {
      if (o.window && !d.page.visits.some(v => v >= o.window!.since && v < o.window!.until)) continue;
      let score = 0;
      const matched: string[] = [];
      for (const { term, alts } of q) {
        let best = 0;
        for (const [t, w] of alts) {
          const tf = d.tf.get(t);
          if (!tf) continue;
          const df = this.df.get(t) ?? 0;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          const s = w * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.len) / avg)));
          if (s > best) best = s;
        }
        if (best > 0) { score += best; matched.push(term); }
      }
      if (!score) continue;
      // Pages that match everything asked beat pages that match one word very often.
      const coverage = matched.length / asked;
      score *= 0.35 + 0.65 * coverage * coverage;
      // A little recency, so of two equal matches the newer one comes first.
      score *= 1 + 0.1 * Math.exp(-(o.now - d.page.last) / (14 * DAY));
      out.push({ page: d.page, score, matched });
    }
    return out.sort((a, b2) => b2.score - a.score).slice(0, o.limit ?? 8);
  }
}

/** The stretch of text that best shows why a page matched, ~240 characters. */
export function snippetOf(text: string, query: string, max = 240): string {
  const want = new Set(terms(query).flatMap(t => [t, ...synonymsOf(t)]));
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  let best = 0; let bestScore = -1;
  for (let i = 0; i < parts.length; i++) {
    const got = new Set(terms(parts[i]!).filter(t => want.has(t)));
    if (got.size > bestScore) { bestScore = got.size; best = i; }
  }
  let s = parts[best]!;
  for (let j = best + 1; s.length < max * 0.7 && j < parts.length; j++) s += ` ${parts[j]}`;
  s = s.replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// ── The store: one sealed file per page ──

export interface MemoryCipher {
  /** False when the OS offers no keychain: files are then written unencrypted (the settings page says so). */
  available(): boolean;
  encrypt(s: string): Buffer;
  decrypt(b: Buffer): string;
}

const SEALED = Buffer.from('AICOMEM1\n');
const PLAIN = Buffer.from('AICOMEM0\n');

export type MemoryStats = Omit<MemoryStatus, 'enabled'>;

export class MemoryStore {
  readonly index = new MemoryIndex();
  private sizes = new Map<string, number>();
  private loaded = false;

  constructor(readonly dir: string, private cipher: MemoryCipher, private limits = LIMITS) {}

  private file(id: string): string { return path.join(this.dir, 'pages', `${id}.bin`); }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(this.dir, 'pages')).filter(n => n.endsWith('.bin')); } catch { return; }
    for (const n of names) {
      const f = path.join(this.dir, 'pages', n);
      try {
        const buf = fs.readFileSync(f);
        const page = this.decode(buf);
        if (!page || `${page.id}.bin` !== n) continue;
        this.index.add(page);
        this.sizes.set(page.id, buf.length);
      } catch { /* an unreadable page (another machine's keychain) is skipped, not fatal */ }
    }
  }

  private decode(buf: Buffer): MemoryPage | null {
    if (buf.subarray(0, SEALED.length).equals(SEALED)) return JSON.parse(this.cipher.decrypt(buf.subarray(SEALED.length))) as MemoryPage;
    if (buf.subarray(0, PLAIN.length).equals(PLAIN)) return JSON.parse(buf.subarray(PLAIN.length).toString('utf8')) as MemoryPage;
    return null;
  }

  private encode(p: MemoryPage): Buffer {
    const json = JSON.stringify(p);
    return this.cipher.available() ? Buffer.concat([SEALED, this.cipher.encrypt(json)]) : Buffer.concat([PLAIN, Buffer.from(json, 'utf8')]);
  }

  /** Remember a page read at `now` (again, if it was read before: its text is refreshed). Evicts the oldest over the caps. */
  put(o: { url: string; title: string; text: string }, now: number): MemoryPage {
    this.load();
    const id = pageId(o.url);
    const prev = this.index.get(id);
    const visits = [...(prev?.visits ?? []), now].slice(-30);
    const page: MemoryPage = {
      id, url: pageKey(o.url), site: siteOf(o.url),
      title: o.title.replace(/\s+/g, ' ').trim().slice(0, 300),
      text: o.text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT),
      first: prev?.first ?? now, last: now, visits,
    };
    const buf = this.encode(page);
    fs.mkdirSync(path.join(this.dir, 'pages'), { recursive: true });
    const f = this.file(id);
    fs.writeFileSync(`${f}.tmp`, buf);
    fs.renameSync(`${f}.tmp`, f);
    this.index.add(page);
    this.sizes.set(id, buf.length);
    this.evict();
    return page;
  }

  /** Note another read of a page already remembered, without re-reading it. */
  touch(url: string, now: number): boolean {
    this.load();
    const p = this.index.get(pageId(url));
    if (!p) return false;
    if (now - p.last < 30 * 60_000) return true;
    this.put({ url: p.url, title: p.title, text: p.text }, now);
    return true;
  }

  private evict(): void {
    let bytes = [...this.sizes.values()].reduce((a, b) => a + b, 0);
    if (this.index.size <= this.limits.pages && bytes <= this.limits.bytes) return;
    const byAge = this.index.pages().sort((a, b) => a.last - b.last);
    for (const p of byAge) {
      if (this.index.size <= this.limits.pages && bytes <= this.limits.bytes) break;
      bytes -= this.sizes.get(p.id) ?? 0;
      this.remove(p.id);
    }
  }

  remove(id: string): boolean {
    this.load();
    const had = this.index.has(id);
    this.index.remove(id);
    this.sizes.delete(id);
    try { fs.rmSync(this.file(id), { force: true }); } catch { /* already gone */ }
    return had;
  }

  forgetUrl(url: string): boolean { return this.remove(pageId(url)); }

  /** "Clear browsing data": everything, or every page read since `sinceMs`. */
  clear(sinceMs?: number): number {
    this.load();
    if (sinceMs === undefined) {
      const n = this.index.size;
      for (const p of this.index.pages()) this.index.remove(p.id);
      this.sizes.clear();
      try { fs.rmSync(path.join(this.dir, 'pages'), { recursive: true, force: true }); } catch { /* nothing kept */ }
      return n;
    }
    let n = 0;
    for (const p of this.index.pages()) if (p.last >= sinceMs) { this.remove(p.id); n++; }
    return n;
  }

  stats(): MemoryStats {
    this.load();
    const pages = this.index.pages();
    return { pages: pages.length, bytes: [...this.sizes.values()].reduce((a, b) => a + b, 0), encrypted: this.cipher.available(), oldest: pages.length ? Math.min(...pages.map(p => p.first)) : null };
  }
}

// ── Asking ──


/**
 * Search what was read. A time phrase in the query (or `since`) narrows it to
 * that window; when nothing in the window matches, the window is dropped and
 * the answer says so (`widened`) — people misremember when as often as what.
 */
export function searchMemory(index: MemoryIndex, query: string, o: { since?: string | number; now: number; limit?: number }): MemoryAnswer {
  const { rest, window: fromQuery } = parseTime(query, o.now);
  const window = parseSince(o.since, o.now) ?? fromQuery;
  const text = rest || query;
  let found = index.search(text, { window, now: o.now, limit: o.limit ?? 8 });
  let widened = false;
  if (!found.length && window) { found = index.search(text, { now: o.now, limit: o.limit ?? 8 }); widened = found.length > 0; }
  const hits = found.map(({ page, score }) => ({
    id: page.id, url: page.url, title: page.title || page.url, site: page.site, last: page.last, visits: page.visits.length,
    snippet: snippetOf(page.text, text), score: Math.round(score * 100) / 100,
  }));
  return { query: text, window, widened, hits, total: index.size };
}
