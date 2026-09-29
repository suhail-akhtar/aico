/**
 * The rich answer blocks — places, images, products, video, news, draft,
 * weather, currency, files, sports — as data: parsing, normalising, and the small
 * pieces of arithmetic each one needs.
 *
 * No React and no DOM, so every rule here is tested in Node and the components
 * are left with drawing. The parsers are deliberately forgiving about shape and
 * strict about meaning: a model that writes `"lon"` for `"lng"`, a rating as
 * `"4.6"`, or a bare array instead of `{"places": [...]}` gets what it meant;
 * a block with nothing drawable in it gets an error that names the field, so
 * the Fix flow can hand the model something it can act on.
 *
 * @module shared/ui/rich/specs
 */

// ── Shared helpers ──────────────────────────────────────────────────

export type Json = Record<string, unknown>;

/** Parse a block's JSON, with an error that says what the block should look like. */
export function parseJson(source: string, kind: string, shape: string): unknown {
  const text = source.trim();
  if (!text) throw new Error(`the ${kind} block is empty — expected ${shape}`);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`the ${kind} block is not valid JSON (${(err as Error).message}) — expected ${shape}`);
  }
}

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A non-empty trimmed string, or undefined. Numbers are accepted and stringified. */
export function str(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

/** A finite number from a number or a numeric string ("4.6", "1,204"), or undefined. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const t = v.replace(/[,\s]/g, '');
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** The first key present on `o` among `keys`. */
function pick(o: Json, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** The list under the first of `keys`, or the value itself when it is already a list. */
function listOf(root: unknown, keys: string[], kind: string, shape: string): unknown[] {
  if (Array.isArray(root)) return root;
  if (!isObj(root)) throw new Error(`the ${kind} block must be a JSON object — expected ${shape}`);
  for (const k of keys) {
    const v = root[k];
    if (Array.isArray(v)) return v;
    if (v !== undefined) throw new Error(`"${k}" must be an array — expected ${shape}`);
  }
  throw new Error(`the ${kind} block has no "${keys[0]}" array — expected ${shape}`);
}

/**
 * A URL safe to put in `href` or `src`.
 *
 * Web URLs always; a same-origin absolute path (`/api/…`) when `relative`,
 * because generated images are served by the engine that way; `data:image/`
 * when `data`. Never `javascript:`, never protocol-relative `//host`, which
 * would inherit an `aico:` or `vscode-webview:` scheme and go nowhere useful.
 */
export function safeUrl(v: unknown, opts: { relative?: boolean; data?: boolean } = {}): string | undefined {
  const u = str(v);
  if (!u) return undefined;
  if (/^https?:\/\/[^\s]+$/i.test(u)) return u;
  if (opts.relative && u.startsWith('/') && !u.startsWith('//') && !/\s/.test(u)) return u;
  if (opts.data && /^data:image\/[a-z0-9.+-]+[;,]/i.test(u)) return u;
  return undefined;
}

/** "nytimes.com" from "https://www.nytimes.com/…". */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const h = new URL(url).hostname.replace(/^www\./i, '');
    return h || undefined;
  } catch {
    return undefined;
  }
}

/** The favicon service URL for a host (Google's s2 endpoint). */
export function faviconUrl(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
}

/** The first letter to put in a badge when there is no favicon. */
export function initialOf(name: string | undefined): string {
  const m = /[\p{L}\p{N}]/u.exec(name ?? '');
  return m ? m[0].toUpperCase() : '?';
}

// ── places ──────────────────────────────────────────────────────────

export interface Place {
  id: number;
  name: string;
  lat?: number;
  lng?: number;
  rating?: number;
  reviews?: number;
  category?: string;
  address?: string;
  /** true open, false closed, undefined unknown. */
  open?: boolean;
  hours?: string;
  price?: string;
  phone?: string;
  url?: string;
  image?: string;
  note?: string;
  source?: string;
}

export interface PlacesSpec {
  title?: string;
  center?: [number, number];
  zoom?: number;
  places: Place[];
}

const PLACES_SHAPE = '{"places":[{"name":"…","lat":51.5,"lng":-0.12,"rating":4.6}]}';

function coord(v: unknown, lo: number, hi: number): number | undefined {
  const n = num(v);
  return n !== undefined && n >= lo && n <= hi ? n : undefined;
}

function openState(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (/^(open|open now|yes|true)$/.test(t)) return true;
    if (/^(closed|closed now|no|false)$/.test(t)) return false;
  }
  return undefined;
}

export function parsePlaces(source: string): PlacesSpec {
  const root = parseJson(source, 'places', PLACES_SHAPE);
  const raw = listOf(root, ['places', 'results', 'items', 'locations'], 'places', PLACES_SHAPE);
  if (raw.length === 0) throw new Error(`"places" is empty — expected at least one place: ${PLACES_SHAPE}`);
  const places: Place[] = raw.map((item, i) => {
    if (!isObj(item)) throw new Error(`places[${i}] is not an object — each place is {"name","lat","lng",…}`);
    const name = str(pick(item, 'name', 'title'));
    if (!name) throw new Error(`places[${i}] has no "name"`);
    const loc = isObj(item.location) ? item.location : isObj(item.coordinates) ? item.coordinates : item;
    let lat = coord(pick(loc, 'lat', 'latitude'), -90, 90);
    let lng = coord(pick(loc, 'lng', 'lon', 'long', 'longitude'), -180, 180);
    const pair = Array.isArray(item.coords) ? item.coords : Array.isArray(item.position) ? item.position : undefined;
    if ((lat === undefined || lng === undefined) && pair && pair.length >= 2) {
      lat = coord(pair[0], -90, 90);
      lng = coord(pair[1], -180, 180);
    }
    const rating = num(pick(item, 'rating', 'stars'));
    const price = pick(item, 'price', 'priceLevel', 'price_level');
    return {
      id: i,
      name,
      lat: lat !== undefined && lng !== undefined ? lat : undefined,
      lng: lat !== undefined && lng !== undefined ? lng : undefined,
      rating: rating !== undefined && rating >= 0 && rating <= 5 ? rating : undefined,
      reviews: num(pick(item, 'reviews', 'reviewCount', 'review_count', 'ratings')),
      category: str(pick(item, 'category', 'type', 'cuisine')),
      address: str(pick(item, 'address', 'vicinity')),
      open: openState(pick(item, 'open', 'openNow', 'open_now', 'isOpen')),
      hours: str(item.hours),
      price: typeof price === 'number' ? '$'.repeat(Math.max(1, Math.min(4, Math.round(price)))) : str(price),
      phone: str(item.phone),
      url: safeUrl(pick(item, 'url', 'website', 'link')),
      image: safeUrl(pick(item, 'image', 'photo', 'thumbnail'), { relative: true, data: true }),
      note: str(pick(item, 'note', 'description', 'summary')),
      source: str(item.source),
    };
  });
  const r = root as Json;
  const c = Array.isArray(r.center) ? r.center : undefined;
  const center: [number, number] | undefined = c && coord(c[0], -90, 90) !== undefined && coord(c[1], -180, 180) !== undefined
    ? [num(c[0])!, num(c[1])!] : undefined;
  const zoom = num(r.zoom);
  return {
    title: isObj(root) ? str(r.title) : undefined,
    center,
    zoom: zoom !== undefined && zoom >= 1 && zoom <= 19 ? zoom : undefined,
    places,
  };
}

/** Where a place opens outside the app: its own site, else OpenStreetMap at its coordinates. */
export function placeLink(p: Place): string | undefined {
  if (p.url) return p.url;
  if (p.lat !== undefined && p.lng !== undefined) {
    return `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=18/${p.lat}/${p.lng}`;
  }
  return undefined;
}

/** Directions to a place on OpenStreetMap. */
export function directionsLink(p: Place): string | undefined {
  if (p.lat === undefined || p.lng === undefined) return undefined;
  return `https://www.openstreetmap.org/directions?to=${p.lat}%2C${p.lng}`;
}

// ── images ──────────────────────────────────────────────────────────

export interface ImageItem { id: number; url: string; caption?: string; source?: string; link?: string; alt?: string }
export interface ImagesSpec { title?: string; images: ImageItem[] }

const IMAGES_SHAPE = '{"images":[{"url":"https://…/a.jpg","caption":"…","source":"Wikimedia"}]}';

export function parseImages(source: string): ImagesSpec {
  const root = parseJson(source, 'images', IMAGES_SHAPE);
  const raw = listOf(root, ['images', 'items', 'photos'], 'images', IMAGES_SHAPE);
  const images: ImageItem[] = [];
  const bad: number[] = [];
  raw.forEach((item, i) => {
    const o = typeof item === 'string' ? { url: item } : item;
    if (!isObj(o)) { bad.push(i); return; }
    const url = safeUrl(pick(o, 'url', 'src', 'image'), { relative: true, data: true });
    if (!url) { bad.push(i); return; }
    const link = safeUrl(pick(o, 'link', 'page', 'href'));
    images.push({
      id: i,
      url,
      caption: str(pick(o, 'caption', 'title')),
      source: str(o.source) ?? hostOf(link ?? (url.startsWith('http') ? url : undefined)),
      link,
      alt: str(o.alt),
    });
  });
  if (images.length === 0) {
    throw new Error(raw.length
      ? `no image has a usable "url" (http(s) or /api/…) — items ${bad.join(', ')} were rejected`
      : `"images" is empty — expected ${IMAGES_SHAPE}`);
  }
  return { title: isObj(root) ? str(root.title) : undefined, images };
}

// ── products ────────────────────────────────────────────────────────

export interface Product {
  id: number;
  name: string;
  image?: string;
  price?: number | string;
  currency?: string;
  rating?: number;
  reviews?: number;
  store?: string;
  url?: string;
  badge?: string;
  specs?: Array<[string, string]>;
}
export interface ProductsSpec { title?: string; compare: boolean; products: Product[] }

const PRODUCTS_SHAPE = '{"products":[{"name":"…","price":299,"currency":"USD","url":"https://…"}]}';

export function parseProducts(source: string): ProductsSpec {
  const root = parseJson(source, 'products', PRODUCTS_SHAPE);
  const raw = listOf(root, ['products', 'items', 'results'], 'products', PRODUCTS_SHAPE);
  if (raw.length === 0) throw new Error(`"products" is empty — expected ${PRODUCTS_SHAPE}`);
  const products: Product[] = raw.map((item, i) => {
    if (!isObj(item)) throw new Error(`products[${i}] is not an object`);
    const name = str(pick(item, 'name', 'title'));
    if (!name) throw new Error(`products[${i}] has no "name"`);
    const priceRaw = item.price;
    const price = typeof priceRaw === 'number' && Number.isFinite(priceRaw) ? priceRaw : str(priceRaw);
    const rating = num(item.rating);
    const specsRaw = item.specs;
    let specs: Array<[string, string]> | undefined;
    if (isObj(specsRaw)) {
      specs = Object.entries(specsRaw)
        .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
        .map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)]);
      if (specs.length === 0) specs = undefined;
    }
    const currency = str(item.currency);
    return {
      id: i,
      name,
      image: safeUrl(pick(item, 'image', 'thumbnail', 'photo'), { relative: true, data: true }),
      price,
      currency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : currency,
      rating: rating !== undefined && rating >= 0 && rating <= 5 ? rating : undefined,
      reviews: num(item.reviews),
      store: str(pick(item, 'store', 'seller', 'merchant')) ?? hostOf(safeUrl(item.url)),
      url: safeUrl(pick(item, 'url', 'link')),
      badge: str(item.badge),
      specs,
    };
  });
  const r = isObj(root) ? root : {};
  const withSpecs = products.filter(p => p.specs).length;
  const compare = r.compare === true
    || (r.compare !== false && products.length >= 2 && products.length <= 5 && withSpecs >= 2);
  return { title: str(r.title), compare: compare && withSpecs > 0, products };
}

/** The union of spec keys, in first-seen order — the comparison table's rows. */
export function specKeys(products: Product[]): string[] {
  const seen: string[] = [];
  for (const p of products) for (const [k] of p.specs ?? []) if (!seen.includes(k)) seen.push(k);
  return seen;
}

/** "$1,299.00" for a number with an ISO currency; the string as written otherwise. */
export function formatPrice(price: number | string | undefined, currency?: string, locale?: string): string | undefined {
  if (price === undefined) return undefined;
  if (typeof price === 'string') return price;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: Number.isInteger(price) ? 0 : 2 }).format(price);
    } catch { /* unknown code: fall through */ }
  }
  const n = price.toLocaleString(locale, { maximumFractionDigits: 2 });
  return currency ? `${n} ${currency}` : n;
}

// ── video ───────────────────────────────────────────────────────────

export interface VideoItem {
  id: number;
  url: string;
  /** The YouTube id, when it is one. */
  youtube?: string;
  start?: number;
  title?: string;
  channel?: string;
  duration?: string;
}
export interface VideoSpec { title?: string; videos: VideoItem[] }

const VIDEO_SHAPE = '{"videos":[{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","title":"…","channel":"…"}]}';
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** The 11-character id from any YouTube URL form, or a bare id. */
export function youtubeId(input: string | undefined): string | undefined {
  const s = (input ?? '').trim();
  if (!s) return undefined;
  if (YT_ID.test(s)) return s;
  let url: URL;
  try { url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { return undefined; }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id: string | undefined;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v) id = v;
    else {
      const m = /^\/(?:embed|shorts|live|v|e)\/([^/?#]+)/.exec(url.pathname);
      if (m) id = m[1];
    }
  }
  return id && YT_ID.test(id) ? id : undefined;
}

/** Start time in seconds from `t=90`, `t=1m30s`, `start=90`. */
export function youtubeStart(input: string | undefined): number | undefined {
  const s = (input ?? '').trim();
  let t: string | null = null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    t = url.searchParams.get('t') ?? url.searchParams.get('start');
    if (!t && url.hash) t = new URLSearchParams(url.hash.slice(1)).get('t');
  } catch { return undefined; }
  if (!t) return undefined;
  if (/^\d+$/.test(t)) return Number(t) || undefined;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || !(m[1] || m[2] || m[3])) return undefined;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) || undefined;
}

export function youtubeEmbed(id: string, start?: number): string {
  const q = new URLSearchParams({ autoplay: '1', rel: '0', modestbranding: '1', playsinline: '1' });
  if (start) q.set('start', String(start));
  return `https://www.youtube-nocookie.com/embed/${id}?${q.toString()}`;
}

export function youtubeThumb(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

export function parseVideo(source: string): VideoSpec {
  const text = source.trim();
  // A bare URL (or several, one per line) is a fair thing to write in a ```youtube fence.
  if (text && !/^[[{]/.test(text)) {
    const urls = text.split(/\s+/).filter(Boolean);
    return parseVideo(JSON.stringify({ videos: urls.map(url => ({ url })) }));
  }
  const root = parseJson(source, 'video', VIDEO_SHAPE);
  const rootObj = isObj(root) ? root : undefined;
  const raw = rootObj && !rootObj.videos && (rootObj.url || rootObj.id)
    ? [rootObj]
    : listOf(root, ['videos', 'items'], 'video', VIDEO_SHAPE);
  const videos: VideoItem[] = [];
  raw.forEach((item, i) => {
    const o = typeof item === 'string' ? { url: item } : item;
    if (!isObj(o)) return;
    const given = str(pick(o, 'url', 'link', 'id'));
    const yt = youtubeId(given);
    const url = yt ? `https://www.youtube.com/watch?v=${yt}` : safeUrl(given);
    if (!url) return;
    videos.push({
      id: i,
      url,
      youtube: yt,
      start: yt ? num(o.start) ?? youtubeStart(given) : undefined,
      title: str(o.title),
      channel: str(pick(o, 'channel', 'author')),
      duration: str(o.duration),
    });
  });
  if (videos.length === 0) {
    throw new Error(raw.length
      ? 'no video has a usable "url" — give a YouTube link (watch?v=, youtu.be/, shorts/, embed/) or an http(s) URL'
      : `"videos" is empty — expected ${VIDEO_SHAPE}`);
  }
  return { title: rootObj ? str(rootObj.title) : undefined, videos };
}

// ── news ────────────────────────────────────────────────────────────

export interface NewsItem {
  id: number;
  title: string;
  url?: string;
  source?: string;
  host?: string;
  date?: string;
  image?: string;
  summary?: string;
}
export interface NewsSpec { title?: string; items: NewsItem[] }

const NEWS_SHAPE = '{"items":[{"title":"…","source":"Reuters","url":"https://…","date":"2026-09-29T08:00:00Z"}]}';

export function parseNews(source: string): NewsSpec {
  const root = parseJson(source, 'news', NEWS_SHAPE);
  const raw = listOf(root, ['items', 'articles', 'news', 'stories'], 'news', NEWS_SHAPE);
  if (raw.length === 0) throw new Error(`"items" is empty — expected ${NEWS_SHAPE}`);
  const items: NewsItem[] = raw.map((item, i) => {
    if (!isObj(item)) throw new Error(`items[${i}] is not an object`);
    const title = str(pick(item, 'title', 'headline'));
    if (!title) throw new Error(`items[${i}] has no "title"`);
    const url = safeUrl(pick(item, 'url', 'link'));
    const host = hostOf(url);
    return {
      id: i,
      title,
      url,
      host,
      source: str(pick(item, 'source', 'publisher', 'outlet')) ?? host,
      date: str(pick(item, 'date', 'published', 'publishedAt', 'time')),
      image: safeUrl(pick(item, 'image', 'thumbnail', 'imageUrl'), { relative: true, data: true }),
      summary: str(pick(item, 'summary', 'description', 'snippet')),
    };
  });
  return { title: isObj(root) ? str(root.title) : undefined, items };
}

/**
 * "just now", "12m ago", "5h ago", "3d ago", else a short date.
 *
 * `now` is a parameter so the rule is testable; dates in the future (a feed
 * with a skewed clock) are shown as dates rather than "in 3h".
 */
export function relativeDate(date: string | undefined, now: number = Date.now(), locale?: string): string | undefined {
  if (!date) return undefined;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return date;
  const diff = now - t;
  const min = 60_000, hour = 60 * min, day = 24 * hour;
  if (diff >= 0 && diff < min) return 'just now';
  if (diff >= 0 && diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff >= 0 && diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff >= 0 && diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  const d = new Date(t);
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}

// ── draft ───────────────────────────────────────────────────────────

export const DRAFT_KINDS = ['email', 'post', 'message', 'report', 'script', 'document'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export interface DraftSpec {
  kind: DraftKind;
  title?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body: string;
  platform?: string;
}

const DRAFT_SHAPE = '{"kind":"email","to":"…","subject":"…","body":"Markdown text"}';

function addressList(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.map(x => str(x)).filter(Boolean).join(', ') || undefined;
  return str(v);
}

/**
 * A draft, from JSON or — because the fence is called `email` or `writing` and
 * a model will sometimes just write the text — from plain Markdown.
 */
export function parseDraft(source: string, language = 'draft'): DraftSpec {
  const fallbackKind: DraftKind = language === 'email' ? 'email' : language === 'post' ? 'post' : 'document';
  const text = source.replace(/^\uFEFF/, '');
  if (!text.trim().startsWith('{')) {
    if (!text.trim()) throw new Error(`the draft is empty — expected ${DRAFT_SHAPE}`);
    // Plain text: an email may lead with "Subject: …" / "To: …" header lines.
    const lines = text.split(/\r?\n/);
    const head: Json = {};
    let i = 0;
    while (i < lines.length && /^(to|cc|subject|title):\s*\S/i.test(lines[i]!)) {
      const m = /^(\w+):\s*(.*)$/.exec(lines[i]!)!;
      head[m[1]!.toLowerCase()] = m[2]!.trim();
      i++;
    }
    const body = lines.slice(i).join('\n').replace(/^\s*\n/, '');
    return {
      kind: head.subject || head.to ? 'email' : fallbackKind,
      to: str(head.to), cc: str(head.cc), subject: str(head.subject), title: str(head.title),
      body,
    };
  }
  const root = parseJson(text, 'draft', DRAFT_SHAPE);
  if (!isObj(root)) throw new Error(`the draft must be a JSON object — expected ${DRAFT_SHAPE}`);
  const body = pick(root, 'body', 'text', 'content', 'markdown');
  if (typeof body !== 'string' || !body.trim()) throw new Error(`the draft has no "body" (Markdown text) — expected ${DRAFT_SHAPE}`);
  const k = str(root.kind)?.toLowerCase();
  const kind: DraftKind = (DRAFT_KINDS as readonly string[]).includes(k ?? '')
    ? (k as DraftKind)
    : k === 'tweet' || k === 'linkedin' ? 'post'
    : k === 'letter' || k === 'mail' ? 'email'
    : k === 'sms' || k === 'chat' || k === 'dm' ? 'message'
    : root.subject || root.to ? 'email' : fallbackKind;
  return {
    kind,
    title: str(root.title),
    to: addressList(root.to),
    cc: addressList(root.cc),
    subject: str(root.subject),
    body,
    platform: str(root.platform),
  };
}

/**
 * Single newlines kept as line breaks, the way a letter is written.
 *
 * Markdown folds "Thanks,\nSuhail" into one line; in an email or a message
 * that is a visible mistake. Code fences are left alone.
 */
export function keepLineBreaks(md: string): string {
  return md.split(/(```[\s\S]*?(?:```|$))/).map((part, i) => (i % 2 === 1
    ? part
    : part.replace(/([^\n])[ \t]*\n(?=[^\n])/g, '$1  \n'))).join('');
}

/** Markdown reduced to readable plain text: for mail bodies, .txt and the plain half of a copy. */
export function markdownToPlain(md: string): string {
  return md
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    // [ \t], never \s, at line starts: \s would eat the blank line above.
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A mailto: link with subject, cc and a plain-text body. */
export function mailtoLink(d: Pick<DraftSpec, 'to' | 'cc' | 'subject' | 'body'>): string {
  const q: string[] = [];
  if (d.subject) q.push(`subject=${encodeURIComponent(d.subject)}`);
  if (d.cc) q.push(`cc=${encodeURIComponent(d.cc)}`);
  q.push(`body=${encodeURIComponent(markdownToPlain(d.body))}`);
  const to = (d.to ?? '').split(/[,;]\s*/).map(a => encodeURIComponent(a.trim())).filter(Boolean).join(',');
  return `mailto:${to}?${q.join('&')}`;
}

/** Character limits worth showing against a post. */
export function platformLimit(platform: string | undefined): number | undefined {
  const p = (platform ?? '').toLowerCase();
  if (/^(x|twitter|x\.com)$/.test(p)) return 280;
  if (/threads/.test(p)) return 500;
  if (/bluesky|bsky/.test(p)) return 300;
  if (/mastodon/.test(p)) return 500;
  if (/linkedin/.test(p)) return 3000;
  return undefined;
}

// ── weather ─────────────────────────────────────────────────────────

export type WeatherIcon =
  | 'clear' | 'mostly-clear' | 'partly' | 'overcast' | 'fog' | 'drizzle' | 'freezing'
  | 'rain' | 'heavy-rain' | 'snow' | 'showers' | 'snow-showers' | 'thunder' | 'unknown';

/** WMO weather interpretation codes (as Open-Meteo reports them) → a label and an icon. */
export function wmo(code: number | undefined): { label: string; icon: WeatherIcon } {
  switch (code) {
    case 0: return { label: 'Clear sky', icon: 'clear' };
    case 1: return { label: 'Mainly clear', icon: 'mostly-clear' };
    case 2: return { label: 'Partly cloudy', icon: 'partly' };
    case 3: return { label: 'Overcast', icon: 'overcast' };
    case 45: return { label: 'Fog', icon: 'fog' };
    case 48: return { label: 'Rime fog', icon: 'fog' };
    case 51: return { label: 'Light drizzle', icon: 'drizzle' };
    case 53: return { label: 'Drizzle', icon: 'drizzle' };
    case 55: return { label: 'Dense drizzle', icon: 'drizzle' };
    case 56: return { label: 'Light freezing drizzle', icon: 'freezing' };
    case 57: return { label: 'Freezing drizzle', icon: 'freezing' };
    case 61: return { label: 'Light rain', icon: 'rain' };
    case 63: return { label: 'Rain', icon: 'rain' };
    case 65: return { label: 'Heavy rain', icon: 'heavy-rain' };
    case 66: return { label: 'Light freezing rain', icon: 'freezing' };
    case 67: return { label: 'Freezing rain', icon: 'freezing' };
    case 71: return { label: 'Light snow', icon: 'snow' };
    case 73: return { label: 'Snow', icon: 'snow' };
    case 75: return { label: 'Heavy snow', icon: 'snow' };
    case 77: return { label: 'Snow grains', icon: 'snow' };
    case 80: return { label: 'Light showers', icon: 'showers' };
    case 81: return { label: 'Showers', icon: 'showers' };
    case 82: return { label: 'Violent showers', icon: 'heavy-rain' };
    case 85: return { label: 'Snow showers', icon: 'snow-showers' };
    case 86: return { label: 'Heavy snow showers', icon: 'snow-showers' };
    case 95: return { label: 'Thunderstorm', icon: 'thunder' };
    case 96: return { label: 'Thunderstorm with hail', icon: 'thunder' };
    case 99: return { label: 'Thunderstorm with heavy hail', icon: 'thunder' };
    default: return { label: 'Unknown', icon: 'unknown' };
  }
}

export interface WeatherSpec {
  location: string;
  lat?: number;
  lng?: number;
  timezone?: string;
  units: 'metric' | 'imperial';
  current?: { time?: string; temp: number; feels?: number; humidity?: number; wind?: number; code?: number; isDay: boolean };
  hourly: Array<{ time: string; temp: number; code?: number; precip?: number }>;
  daily: Array<{ date: string; min: number; max: number; code?: number; precip?: number; sunrise?: string; sunset?: string }>;
  source?: string;
}

const WEATHER_SHAPE = '{"location":"Lahore","units":"metric","current":{"time":"2026-09-29T14:00","temp":31,"code":1},"daily":[{"date":"2026-09-29","min":24,"max":33,"code":1}]}';

export function parseWeather(source: string): WeatherSpec {
  const root = parseJson(source, 'weather', WEATHER_SHAPE);
  if (!isObj(root)) throw new Error(`the weather block must be a JSON object — expected ${WEATHER_SHAPE}`);
  const location = str(pick(root, 'location', 'place', 'city', 'name'));
  if (!location) throw new Error('the weather block has no "location"');
  const u = str(root.units)?.toLowerCase();
  const units: 'metric' | 'imperial' = u === 'imperial' || u === 'us' || u === 'f' || u === 'fahrenheit' ? 'imperial' : 'metric';
  let current: WeatherSpec['current'];
  if (isObj(root.current)) {
    const c = root.current;
    const temp = num(pick(c, 'temp', 'temperature', 'temperature_2m'));
    if (temp !== undefined) {
      const isDay = pick(c, 'isDay', 'is_day');
      current = {
        time: str(c.time),
        temp,
        feels: num(pick(c, 'feels', 'feelsLike', 'apparent_temperature')),
        humidity: num(pick(c, 'humidity', 'relative_humidity_2m')),
        wind: num(pick(c, 'wind', 'windSpeed', 'wind_speed_10m')),
        code: num(pick(c, 'code', 'weather_code', 'weathercode')),
        isDay: isDay === undefined ? true : isDay === true || isDay === 1 || isDay === '1',
      };
    }
  }
  const hourly = (Array.isArray(root.hourly) ? root.hourly : [])
    .filter(isObj)
    .map(h => ({ time: str(h.time) ?? '', temp: num(pick(h, 'temp', 'temperature')), code: num(pick(h, 'code', 'weather_code')), precip: num(pick(h, 'precip', 'precipitation_probability')) }))
    .filter((h): h is { time: string; temp: number; code: number | undefined; precip: number | undefined } => Boolean(h.time) && h.temp !== undefined);
  const daily: WeatherSpec['daily'] = [];
  for (const d of Array.isArray(root.daily) ? root.daily : []) {
    if (!isObj(d)) continue;
    const date = str(pick(d, 'date', 'time'));
    const min = num(pick(d, 'min', 'temp_min', 'temperature_2m_min'));
    const max = num(pick(d, 'max', 'temp_max', 'temperature_2m_max'));
    if (!date || min === undefined || max === undefined) continue;
    daily.push({
      date, min, max,
      code: num(pick(d, 'code', 'weather_code')),
      precip: num(pick(d, 'precip', 'precipitation_probability_max')),
      sunrise: str(d.sunrise),
      sunset: str(d.sunset),
    });
  }
  if (!current && daily.length === 0) {
    throw new Error('the weather block has neither "current" (with "temp") nor a "daily" forecast (each with "date","min","max")');
  }
  return {
    location,
    lat: num(pick(root, 'lat', 'latitude')),
    lng: num(pick(root, 'lng', 'lon', 'longitude')),
    timezone: str(root.timezone),
    units,
    current,
    hourly,
    daily,
    source: str(root.source),
  };
}

/** Convert a temperature between the block's units and the one being shown. */
export function convertTemp(t: number, from: 'metric' | 'imperial', to: 'metric' | 'imperial'): number {
  if (from === to) return t;
  return to === 'imperial' ? t * 9 / 5 + 32 : (t - 32) * 5 / 9;
}

export function convertWind(w: number, from: 'metric' | 'imperial', to: 'metric' | 'imperial'): number {
  if (from === to) return w;
  return to === 'imperial' ? w / 1.609344 : w * 1.609344;
}

/** "14:00" from "2026-09-29T14:00" — the local wall time as given, never re-zoned. */
export function wallTime(iso: string | undefined): string | undefined {
  const m = /T(\d{2}):(\d{2})/.exec(iso ?? '');
  return m ? `${m[1]}:${m[2]}` : undefined;
}

/** "Mon" from "2026-09-28" (read as a calendar date, not an instant). */
export function weekday(date: string, locale?: string, style: 'short' | 'long' = 'short'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString(locale, { weekday: style, timeZone: 'UTC' });
}

/** Hourly entries from the current hour on, at most `count`. */
export function upcomingHours<T extends { time: string }>(hourly: T[], now: string | undefined, count = 24): T[] {
  const hour = (now ?? '').slice(0, 13);
  const start = hour ? hourly.findIndex(h => h.time.slice(0, 13) >= hour) : 0;
  return hourly.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + count);
}

// ── currency ────────────────────────────────────────────────────────

export interface CurrencySpec {
  base: string;
  amount: number;
  /** Units of each currency per one `base`, with `base` itself at 1. */
  rates: Record<string, number>;
  /** The first target named, for the converter's second field. */
  target: string;
  date?: string;
  source?: string;
}

const CURRENCY_SHAPE = '{"base":"USD","amount":100,"rates":{"PKR":278.4,"EUR":0.92},"date":"2026-09-29","source":"ECB"}';

export function parseCurrency(source: string): CurrencySpec {
  const root = parseJson(source, 'currency', CURRENCY_SHAPE);
  if (!isObj(root)) throw new Error(`the currency block must be a JSON object — expected ${CURRENCY_SHAPE}`);
  const base = str(pick(root, 'base', 'from'))?.toUpperCase();
  if (!base) throw new Error(`the currency block has no "base" currency code — expected ${CURRENCY_SHAPE}`);
  const rates: Record<string, number> = { [base]: 1 };
  const rawRates = root.rates;
  if (isObj(rawRates)) {
    for (const [k, v] of Object.entries(rawRates)) {
      const n = num(v);
      if (n !== undefined && n > 0) rates[k.toUpperCase()] = k.toUpperCase() === base ? 1 : n;
    }
  }
  // {"base":"USD","to":"EUR","rate":0.92} is the one-pair shorthand.
  const to = str(root.to)?.toUpperCase();
  const rate = num(root.rate);
  if (to && rate !== undefined && rate > 0 && to !== base) rates[to] = rate;
  const targets = Object.keys(rates).filter(k => k !== base);
  if (targets.length === 0) throw new Error(`"rates" has no positive numeric rate — expected ${CURRENCY_SHAPE}`);
  const amount = num(root.amount);
  return {
    base,
    amount: amount !== undefined && amount >= 0 ? amount : 1,
    rates,
    target: to && rates[to] ? to : targets[0]!,
    date: str(root.date),
    source: str(root.source),
  };
}

/** `amount` of `from` in `to`, through the base: every rate is per one base unit. */
export function convertCurrency(amount: number, from: string, to: string, rates: Record<string, number>): number {
  const f = rates[from], t = rates[to];
  if (!f || !t) return NaN;
  return amount / f * t;
}

/** A money amount: two decimals, more for tiny values so they never show as 0.00. */
export function formatAmount(n: number, locale?: string): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs === 0 || abs >= 1 ? 2 : Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(abs)) + 2));
  return n.toLocaleString(locale, { minimumFractionDigits: abs >= 1 || abs === 0 ? 2 : 0, maximumFractionDigits: digits });
}

/** A rate to five significant figures, whatever its magnitude. */
export function formatRate(n: number, locale?: string): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(locale, { maximumSignificantDigits: 5 });
}

// ── files ───────────────────────────────────────────────────────────

export type FileKind = 'pdf' | 'sheet' | 'doc' | 'slides' | 'csv' | 'markdown' | 'image' | 'code' | 'archive' | 'text' | 'audio' | 'video' | 'file';

export interface FileItem { id: number; path: string; name: string; ext: string; size?: number; kind: FileKind }
export interface FilesSpec { title?: string; files: FileItem[] }

const FILES_SHAPE = '{"files":[{"path":"C:/work/report.pdf","size":48213}]}';

const EXT_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  xlsx: 'sheet', xls: 'sheet', xlsm: 'sheet', ods: 'sheet', numbers: 'sheet',
  docx: 'doc', doc: 'doc', odt: 'doc', rtf: 'doc', pages: 'doc',
  pptx: 'slides', ppt: 'slides', odp: 'slides', key: 'slides',
  csv: 'csv', tsv: 'csv',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', ico: 'image', avif: 'image', heic: 'image', tiff: 'image',
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', '7z': 'archive', rar: 'archive', bz2: 'archive', xz: 'archive',
  txt: 'text', log: 'text',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', py: 'code', rb: 'code', go: 'code', rs: 'code',
  java: 'code', kt: 'code', c: 'code', h: 'code', cpp: 'code', cs: 'code', php: 'code', swift: 'code', sh: 'code', ps1: 'code',
  sql: 'code', html: 'code', css: 'code', scss: 'code', json: 'code', yaml: 'code', yml: 'code', toml: 'code', xml: 'code', ipynb: 'code',
};

export function fileKind(name: string, given?: string): FileKind {
  const g = (given ?? '').toLowerCase();
  const kinds: FileKind[] = ['pdf', 'sheet', 'doc', 'slides', 'csv', 'markdown', 'image', 'code', 'archive', 'text', 'audio', 'video'];
  if ((kinds as string[]).includes(g)) return g as FileKind;
  if (g && EXT_KIND[g]) return EXT_KIND[g]!;
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return EXT_KIND[ext] ?? 'file';
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function formatBytes(n: number | undefined): string | undefined {
  if (n === undefined || !Number.isFinite(n) || n < 0) return undefined;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function parseFiles(source: string): FilesSpec {
  const root = parseJson(source, 'files', FILES_SHAPE);
  const raw = listOf(root, ['files', 'items', 'downloads'], 'files', FILES_SHAPE);
  if (raw.length === 0) throw new Error(`"files" is empty — expected ${FILES_SHAPE}`);
  const files: FileItem[] = raw.map((item, i) => {
    const o = typeof item === 'string' ? { path: item } : item;
    if (!isObj(o)) throw new Error(`files[${i}] is not an object`);
    const path = str(pick(o, 'path', 'file', 'location'));
    if (!path) throw new Error(`files[${i}] has no "path"`);
    const name = str(o.name) ?? baseName(path);
    return {
      id: i,
      path,
      name,
      ext: (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? /\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase(),
      size: num(o.size),
      kind: fileKind(name, str(o.kind)),
    };
  });
  return { title: isObj(root) ? str(root.title) : undefined, files };
}

// ── sports ──────────────────────────────────────────────────────────

export type SportsStatus = 'scheduled' | 'live' | 'final' | 'postponed';

export interface SportsSide {
  name: string;
  short?: string;
  logo?: string;
  score?: string;
  record?: string;
  winner: boolean;
}

export interface SportsGame {
  id: string;
  status: SportsStatus;
  /** What the clock says: "67'", "Q3 4:12", "Top 7th"; for a final, "AET" or "Final/OT". */
  clock?: string;
  start?: string;
  venue?: string;
  home: SportsSide;
  away: SportsSide;
  note?: string;
  url?: string;
}

export interface StandingsRow { team: string; logo?: string; values: string[] }
export interface SportsStandings { columns: string[]; groups: Array<{ name?: string; rows: StandingsRow[] }> }

export interface SportsSpec {
  title?: string;
  league?: string;
  sport?: string;
  date?: string;
  games: SportsGame[];
  standings?: SportsStandings;
  source?: string;
  updatedAt?: string;
}

const SPORTS_SHAPE = '{"league":"Premier League","games":[{"status":"final","home":{"name":"Arsenal","score":2},"away":{"name":"Chelsea","score":1}}]}';
const STANDINGS_SHAPE = '{"columns":["P","W","D","L","Pts"],"groups":[{"name":"…","rows":[{"team":"…","values":[5,4,0,1,12]}]}]}';

/** Whatever a feed calls a game's state → one of the card's four. */
export function sportsStatus(v: unknown): SportsStatus {
  const s = str(v)?.toLowerCase().replace(/[\s_-]+/g, '');
  if (!s) return 'scheduled';
  if (/^(status)?(postponed|cancel|suspended|delayed|abandoned|forfeit)/.test(s)) return 'postponed';
  if (/^(status)?(live|inprogress|in|playing|halftime|ht|ongoing|underway)$/.test(s)) return 'live';
  if (/^(status)?(final|ft|post|completed?|finished|ended|result|aet|fulltime)/.test(s)) return 'final';
  return 'scheduled';
}

function sportsSide(v: unknown, where: string): SportsSide {
  if (typeof v === 'string' && v.trim()) return { name: v.trim(), winner: false };
  if (!isObj(v)) throw new Error(`${where} must be an object with a "name" — expected ${SPORTS_SHAPE}`);
  const name = str(pick(v, 'name', 'team', 'displayName', 'shortName', 'abbreviation'));
  if (!name) throw new Error(`${where} has no "name"`);
  return {
    name,
    short: str(pick(v, 'short', 'abbreviation', 'abbr', 'code')),
    logo: safeUrl(pick(v, 'logo', 'badge', 'crest', 'image'), { relative: true, data: true }),
    score: str(pick(v, 'score', 'points', 'goals', 'runs')),
    record: str(pick(v, 'record', 'detail', 'summary')),
    winner: v.winner === true || v.winner === 'true',
  };
}

function parseStandings(v: unknown): SportsStandings | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new Error(`"standings" must be an object — expected ${STANDINGS_SHAPE}`);
  const columns = (Array.isArray(v.columns) ? v.columns : []).map(c => str(c) ?? '').filter(Boolean);
  const rawGroups: unknown[] = Array.isArray(v.groups) ? v.groups : Array.isArray(v.rows) ? [{ rows: v.rows }] : [];
  const groups = rawGroups.filter(isObj).map((g, gi) => ({
    name: str(g.name),
    rows: (Array.isArray(g.rows) ? g.rows : []).map((r, ri) => {
      if (!isObj(r)) throw new Error(`standings.groups[${gi}].rows[${ri}] is not an object`);
      const team = str(pick(r, 'team', 'name'));
      if (!team) throw new Error(`standings.groups[${gi}].rows[${ri}] has no "team"`);
      return {
        team,
        logo: safeUrl(pick(r, 'logo', 'badge', 'crest'), { relative: true, data: true }),
        values: (Array.isArray(r.values) ? r.values : []).map(x => str(x) ?? '–'),
      };
    }),
  })).filter(g => g.rows.length > 0);
  if (groups.length === 0) throw new Error(`"standings" has no rows — expected ${STANDINGS_SHAPE}`);
  if (columns.length === 0) throw new Error(`"standings" has no "columns" (the header labels) — expected ${STANDINGS_SHAPE}`);
  return { columns, groups };
}

export function parseSports(source: string): SportsSpec {
  const root = parseJson(source, 'sports', SPORTS_SHAPE);
  if (!isObj(root) && !Array.isArray(root)) throw new Error(`the sports block must be a JSON object — expected ${SPORTS_SHAPE}`);
  const obj: Json = Array.isArray(root) ? { games: root } : root;
  const standings = parseStandings(pick(obj, 'standings', 'table'));
  const rawGames = pick(obj, 'games', 'events', 'matches', 'fixtures', 'scores');
  if (rawGames !== undefined && !Array.isArray(rawGames)) throw new Error(`"games" must be an array — expected ${SPORTS_SHAPE}`);
  const games: SportsGame[] = ((rawGames as unknown[] | undefined) ?? []).map((g, i) => {
    if (!isObj(g)) throw new Error(`games[${i}] is not an object`);
    const status = sportsStatus(pick(g, 'status', 'state'));
    const home = sportsSide(pick(g, 'home', 'homeTeam'), `games[${i}].home`);
    const away = sportsSide(pick(g, 'away', 'awayTeam'), `games[${i}].away`);
    if (status === 'scheduled') { home.score = undefined; away.score = undefined; }
    if (status !== 'final') { home.winner = false; away.winner = false; }
    // A final with plain numbers and nobody marked: the higher score won.
    if (status === 'final' && !home.winner && !away.winner) {
      const h = num(home.score), a = num(away.score);
      if (h !== undefined && a !== undefined && h !== a) (h > a ? home : away).winner = true;
    }
    return {
      id: str(g.id) ?? String(i),
      status,
      clock: str(pick(g, 'clock', 'minute', 'period')),
      start: str(pick(g, 'start', 'date', 'kickoff', 'startTime')),
      venue: str(g.venue),
      home,
      away,
      note: str(pick(g, 'note', 'round', 'headline')),
      url: safeUrl(pick(g, 'url', 'link')),
    };
  });
  if (games.length === 0 && !standings) {
    throw new Error(`the sports block has neither "games" nor "standings" — expected ${SPORTS_SHAPE}`);
  }
  return {
    title: str(obj.title),
    league: str(pick(obj, 'league', 'competition')),
    sport: str(obj.sport)?.toLowerCase(),
    date: str(obj.date),
    games,
    standings,
    source: str(obj.source),
    updatedAt: str(pick(obj, 'updatedAt', 'updated', 'asOf')),
  };
}

/** Whether a sport lists the home side first (soccer, cricket, rugby) or the away side (the American way). */
export function homeFirst(sport: string | undefined): boolean {
  return !/^(basketball|football|american football|baseball|hockey|ice hockey|nba|wnba|nfl|mlb|nhl)$/i.test(sport ?? '');
}

/**
 * A scheduled game's start in the reader's time: "7:30 PM" today, "Tomorrow
 * 7:30 PM", "Tue 7:30 PM" within the week, "12 Oct 7:30 PM" beyond.
 * `timeZone` is for tests; the card uses the reader's own.
 */
export function startLabel(start: string | undefined, now: number = Date.now(), locale?: string, timeZone?: string): string | undefined {
  if (!start) return undefined;
  const t = Date.parse(start);
  if (Number.isNaN(t)) return start;
  const tz = timeZone ? { timeZone } : {};
  const time = new Date(t).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', ...tz });
  const dayKey = (ms: number): string => new Date(ms).toLocaleDateString('en-CA', tz);
  const day = 86_400_000;
  if (dayKey(t) === dayKey(now)) return time;
  if (dayKey(t) === dayKey(now + day)) return `Tomorrow ${time}`;
  if (dayKey(t) === dayKey(now - day)) return `Yesterday ${time}`;
  if (Math.abs(t - now) < 6 * day) return `${new Date(t).toLocaleDateString(locale, { weekday: 'short', ...tz })} ${time}`;
  return `${new Date(t).toLocaleDateString(locale, { day: 'numeric', month: 'short', ...tz })} ${time}`;
}
