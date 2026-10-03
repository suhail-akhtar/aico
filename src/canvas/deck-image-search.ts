/**
 * Finding licensed pictures for slides — Openverse and Wikimedia Commons
 * with no key, Pexels and Unsplash when the person stored a key for them —
 * returned as scored candidates the agent (or the person) picks from.
 *
 * ## Why these sources, and the licence filter
 *
 * A deck is shared and often commercial, so a picture must be one the person
 * may use there: only CC0, public domain, CC BY and CC BY-SA are kept (no
 * NonCommercial, no NoDerivatives — a slide crops, which is a derivative),
 * plus the Pexels and Unsplash licences. The filter is applied to what each
 * API *returns*, not only asked for in the query, because a search parameter
 * is a request and a returned licence is a fact. Every candidate carries its
 * creator, licence and the page that states them; placing one records that
 * credit on the slide and in the speaker notes (`deck-media.ts`).
 *
 * ## Why scored, and few calls
 *
 * The agent picks; the score helps it pick well: how many of the query's
 * words the title and tags contain, whether the picture is big enough for its
 * slot (a full-bleed picture wants ~1900 px), and how close its shape is to
 * the slot's. One search is one or two HTTP calls (a keyed stock library
 * first when there is one, else Openverse and Commons together), and the same
 * query is answered from memory for 20 minutes — a deck needs a handful of
 * searches, not a crawl.
 *
 * Keys are used, never read: a vault credential named `pexels` or `unsplash`
 * (kind api-token) is resolved by the broker for that API's origin only, and
 * the value goes into one request header.
 *
 * @module canvas/deck-image-search
 */

import { guardedFetch, rememberCandidates, type Fetcher, type ImageCandidate } from './deck-media.js';

export type { ImageCandidate } from './deck-media.js';

export interface SearchOptions {
  orientation?: 'landscape' | 'portrait' | 'square';
  /** The slot the picture is for, in points (scores resolution and shape). */
  slot?: { w: number; h: number };
  count?: number;
  fetcher?: Fetcher;
  /** A stock key, already resolved by the broker for that provider's origin (tests inject a fake). */
  keys?: { pexels?: () => Promise<{ value: string; release: () => void } | undefined>; unsplash?: () => Promise<{ value: string; release: () => void } | undefined> };
}

export interface SearchResult { candidates: ImageCandidate[]; notes: string[]; providers: string[] }

const WEBP_HOSTS = /^https:\/\/images\.rawpixel\.com\//i;

const STOP = new Set('a an and the of for to in on with at by from photo image picture stock team people'.split(' '));

/** Licences a commercial deck may use, normalised, or undefined to drop the picture. */
export function allowedLicence(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase().replace(/_/g, '-');
  if (/\bnc\b|non-?commercial|\bnd\b|no-?deriv|fair use|all rights reserved|copyright/.test(s)) return undefined;
  if (/^cc0|cc-zero|^zero/.test(s)) return 'CC0';
  if (/public domain|^pdm\b|^pd\b|^pd-/.test(s)) return 'Public domain';
  const m = /^(?:cc[- ]?)?(by(?:-sa)?)[- ]?(\d(?:\.\d)?)?/.exec(s.replace(/^cc /, 'cc-'));
  if (m) return `CC ${m[1]!.toUpperCase()}${m[2] ? ` ${m[2]}` : ''}`;
  return undefined;
}

function terms(q: string): string[] {
  return q.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
}

/** Relevance, resolution and shape → one score (0–1), with the reasons. */
export function scoreCandidate(c: Pick<ImageCandidate, 'title' | 'width' | 'height'> & { tags?: string }, query: string, slot = { w: 960, h: 540 }): { score: number; why: string } {
  const q = terms(query);
  const hay = `${c.title} ${c.tags ?? ''}`.toLowerCase();
  const rel = q.length ? q.filter(w => hay.includes(w)).length / q.length : 0.5;
  const needW = slot.w * 1.6;
  const w = c.width ?? 0;
  const h = c.height ?? 0;
  // The pixels the slot would get after cropping to cover it.
  const fill = w && h ? Math.min(w / needW, h / (slot.h * 1.6)) : 0.5;
  const res = Math.min(1, fill);
  const ar = w && h ? w / h : slot.w / slot.h;
  const shape = Math.max(0, 1 - Math.abs(Math.log(ar / (slot.w / slot.h))) / Math.log(3));
  const score = Math.round((0.45 * rel + 0.35 * res + 0.2 * shape) * 100) / 100;
  const why = `${Math.round(rel * 100)}% of the words, ${w && h ? `${w}×${h} px` : 'size unknown'}${res < 1 ? ' (soft for this slot)' : ''}, shape ${shape > 0.8 ? 'fits' : shape > 0.5 ? 'crops some' : 'crops a lot'}`;
  return { score, why };
}

interface Raw { cand: Omit<ImageCandidate, 'score' | 'why'>; tags?: string }

async function json<T>(fetcher: Fetcher, url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetcher(url, { maxBytes: 1.5 * 1024 * 1024, timeoutMs: 15_000, accept: 'application/json', headers });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.body.toString('utf8')) as T;
}

const strip = (html: string | undefined): string => (html ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

export async function openverse(q: string, o: SearchOptions, fetcher: Fetcher): Promise<Raw[]> {
  const p = new URLSearchParams({ q, license: 'cc0,pdm,by,by-sa', page_size: '20', mature: 'false', extension: 'jpg,png' });
  if (o.orientation) p.set('aspect_ratio', o.orientation === 'landscape' ? 'wide' : o.orientation === 'portrait' ? 'tall' : 'square');
  const r = await json<{ results?: Array<Record<string, unknown>> }>(fetcher, `https://api.openverse.org/v1/images/?${p}`);
  const out: Raw[] = [];
  for (const it of r.results ?? []) {
    const lic = allowedLicence(`${String(it.license ?? '')}${it.license_version ? ` ${String(it.license_version)}` : ''}`);
    const url = String(it.url ?? '');
    // Hosts that answer a .jpg URL with WebP whatever is asked (PowerPoint cannot open WebP): never offered.
    if (!lic || !/^https:\/\//.test(url) || WEBP_HOSTS.test(url)) continue;
    out.push({
      cand: {
        id: `ov:${String(it.id ?? '').slice(0, 40)}`, provider: 'openverse', url, title: strip(String(it.title ?? 'Untitled')).slice(0, 200),
        ...(it.creator ? { creator: strip(String(it.creator)).slice(0, 120) } : {}), license: lic,
        ...(it.license_url ? { licenseUrl: String(it.license_url) } : {}), sourceUrl: String(it.foreign_landing_url ?? url),
        ...(Number(it.width) ? { width: Number(it.width) } : {}), ...(Number(it.height) ? { height: Number(it.height) } : {}),
        ...(typeof it.thumbnail === 'string' && /^https:\/\//.test(it.thumbnail) ? { thumb: it.thumbnail } : {}),
      },
      tags: Array.isArray(it.tags) ? (it.tags as Array<{ name?: string }>).map(t => t.name ?? '').join(' ') : '',
    });
  }
  return out;
}

export async function wikimedia(q: string, _o: SearchOptions, fetcher: Fetcher): Promise<Raw[]> {
  const p = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: `${q} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '15',
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1920', origin: '*',
  });
  const r = await json<{ query?: { pages?: Record<string, { title?: string; imageinfo?: Array<Record<string, unknown>> }> } }>(fetcher, `https://commons.wikimedia.org/w/api.php?${p}`);
  const out: Raw[] = [];
  for (const page of Object.values(r.query?.pages ?? {})) {
    const ii = page.imageinfo?.[0];
    if (!ii) continue;
    const meta = (ii.extmetadata ?? {}) as Record<string, { value?: string }>;
    const lic = allowedLicence(strip(meta.LicenseShortName?.value) || strip(meta.License?.value));
    const mime = String(ii.mime ?? '');
    const url = String(ii.thumburl ?? ii.url ?? '');
    if (!lic || !/^image\/(jpeg|png)$/.test(mime) || !/^https:\/\//.test(url)) continue;
    const w = Number(ii.thumbwidth ?? ii.width) || undefined;
    const h = Number(ii.thumbheight ?? ii.height) || undefined;
    out.push({
      cand: {
        id: `wm:${String(page.title ?? '').slice(5, 80)}`, provider: 'wikimedia', url,
        title: strip(meta.ObjectName?.value) || String(page.title ?? '').replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
        ...(strip(meta.Artist?.value) ? { creator: strip(meta.Artist?.value).slice(0, 120) } : {}), license: lic,
        ...(meta.LicenseUrl?.value ? { licenseUrl: strip(meta.LicenseUrl.value) } : {}), sourceUrl: String(ii.descriptionurl ?? url),
        ...(w ? { width: w } : {}), ...(h ? { height: h } : {}),
        ...(/\/1920px-/.test(url) ? { thumb: url.replace('/1920px-', '/330px-') } : {}),
      },
      tags: strip(meta.ImageDescription?.value).slice(0, 300),
    });
  }
  return out;
}

async function pexels(q: string, o: SearchOptions, fetcher: Fetcher, key: string): Promise<Raw[]> {
  const p = new URLSearchParams({ query: q, per_page: '15', ...(o.orientation ? { orientation: o.orientation } : {}) });
  const r = await json<{ photos?: Array<Record<string, unknown>> }>(fetcher, `https://api.pexels.com/v1/search?${p}`, { Authorization: key });
  return (r.photos ?? []).map((it) => {
    const src = (it.src ?? {}) as Record<string, string>;
    const w = Number(it.width) || 0;
    const h = Number(it.height) || 0;
    const scale = w > 1880 ? 1880 / w : 1;
    return {
      cand: {
        id: `px:${String(it.id)}`, provider: 'pexels' as const, url: src.large2x ?? src.original ?? '', title: String(it.alt ?? 'Photo').slice(0, 200),
        ...(it.photographer ? { creator: String(it.photographer).slice(0, 120) } : {}), license: 'Pexels licence', licenseUrl: 'https://www.pexels.com/license/',
        sourceUrl: String(it.url ?? ''), ...(w ? { width: Math.round(w * scale), height: Math.round(h * scale) } : {}), ...(src.medium ? { thumb: src.medium } : {}),
      },
      tags: String(it.alt ?? ''),
    };
  }).filter(x => /^https:\/\//.test(x.cand.url));
}

async function unsplash(q: string, o: SearchOptions, fetcher: Fetcher, key: string): Promise<Raw[]> {
  const p = new URLSearchParams({ query: q, per_page: '15', ...(o.orientation ? { orientation: o.orientation === 'square' ? 'squarish' : o.orientation } : {}) });
  const r = await json<{ results?: Array<Record<string, unknown>> }>(fetcher, `https://api.unsplash.com/search/photos?${p}`, { Authorization: `Client-ID ${key}` });
  return (r.results ?? []).map((it) => {
    const urls = (it.urls ?? {}) as Record<string, string>;
    const links = (it.links ?? {}) as Record<string, string>;
    const user = (it.user ?? {}) as Record<string, string>;
    const w = Number(it.width) || 0;
    const h = Number(it.height) || 0;
    return {
      cand: {
        id: `us:${String(it.id)}`, provider: 'unsplash' as const, url: urls.raw ? `${urls.raw}&w=1920&q=80&fm=jpg` : urls.regular ?? '',
        title: String(it.alt_description ?? it.description ?? 'Photo').slice(0, 200), ...(user.name ? { creator: user.name.slice(0, 120) } : {}),
        license: 'Unsplash licence', licenseUrl: 'https://unsplash.com/license', sourceUrl: links.html ?? '',
        ...(w ? { width: 1920, height: Math.round((h / w) * 1920) } : {}), ...(links.download_location ? { trackUrl: links.download_location } : {}), ...(urls.small ? { thumb: urls.small } : {}),
      },
      tags: String(it.alt_description ?? ''),
    };
  }).filter(x => /^https:\/\//.test(x.cand.url));
}

const cache = new Map<string, { at: number; result: SearchResult }>();

/** Search for licensed pictures and remember the candidates (so placing one is allowed). */
export async function searchImages(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const q = query.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!q) throw new Error('find_images needs a query — what the picture should show ("team meeting in a bright office")');
  const fetcher = opts.fetcher ?? guardedFetch;
  const key = JSON.stringify([q, opts.orientation, opts.slot]);
  const hit = cache.get(key);
  if (hit && !opts.fetcher && Date.now() - hit.at < 20 * 60_000) return hit.result;
  const notes: string[] = [];
  const providers: string[] = [];
  let raw: Raw[] = [];
  // A keyed stock library first (better photos for slides); the open sources when there is none or it fails.
  for (const [name, get, run] of [['pexels', opts.keys?.pexels, pexels], ['unsplash', opts.keys?.unsplash, unsplash]] as const) {
    if (raw.length || !get) continue;
    const secret = await get().catch(() => undefined);
    if (!secret) continue;
    try { raw = await run(q, opts, fetcher, secret.value); providers.push(name); } catch (err) { notes.push(`${name}: ${err instanceof Error ? err.message : String(err)}`); } finally { secret.release(); }
  }
  if (!raw.length) {
    const [ov, wm] = await Promise.allSettled([openverse(q, opts, fetcher), wikimedia(q, opts, fetcher)]);
    if (ov.status === 'fulfilled') { raw.push(...ov.value); providers.push('openverse'); } else notes.push(`openverse: ${ov.reason instanceof Error ? ov.reason.message : String(ov.reason)}`);
    if (wm.status === 'fulfilled') { raw.push(...wm.value); providers.push('wikimedia'); } else notes.push(`wikimedia commons: ${wm.reason instanceof Error ? wm.reason.message : String(wm.reason)}`);
  }
  const seen = new Set<string>();
  const candidates = raw
    .filter(r => (seen.has(r.cand.url) ? false : (seen.add(r.cand.url), true)))
    .map(r => ({ ...r.cand, ...scoreCandidate({ ...r.cand, tags: r.tags }, q, opts.slot) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(12, opts.count ?? 8)));
  await rememberCandidates(candidates);
  const result = { candidates, notes, providers };
  if (!opts.fetcher) cache.set(key, { at: Date.now(), result });
  return result;
}

/** Candidates as lines the model can act on. */
export function candidateLines(list: ImageCandidate[]): string[] {
  return list.map((c, i) => `${i + 1}. [${c.provider}] score ${c.score} — "${c.title.slice(0, 70)}"${c.creator ? ` by ${c.creator.slice(0, 40)}` : ''}, ${c.license}; ${c.why}\n   src: ${c.url}`);
}
