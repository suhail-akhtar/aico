/**
 * Getting pictures into a deck safely — the one way the engine fetches a
 * picture from the internet for a slide, and the one way a slide's picture
 * becomes a stored file.
 *
 * ## The rules this enforces (ADR 0025)
 *
 * - **Only licensed candidates are fetched.** A URL is downloaded only if an
 *   image search (`deck-image-search.ts`) returned it, with its licence and
 *   credit, within the last days (`candidates.json` in the media folder). An
 *   image URL the model read on a web page, or one a prompt injection planted,
 *   is refused with the fix ("use find_images"). The credit and licence come
 *   from the search, not from the model.
 * - **Every fetch goes through the SSRF guard** (`tools/ops/ssrf.ts`): the
 *   name is resolved, every address checked — metadata, loopback, private,
 *   link-local are refused, nothing vouches for them here — and the socket is
 *   pinned to the checked address; each redirect hop is checked again.
 * - **Size and type limits**: at most 15 MB, and only PNG, JPEG or GIF by
 *   their bytes (what PowerPoint opens), never by the server's word.
 * - **A downloaded picture is untrusted content**: it is stored and drawn,
 *   never decoded beyond its header, never read as text.
 *
 * Project files (`assets/photo.jpg`) are copied into the store the same way
 * (read only from inside the project), so the editor can show them too.
 *
 * @module canvas/deck-media
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decideTarget, resolveAll } from '../tools/ops/ssrf.js';
import { imageSize } from './deck-pptx.js';
import { deckMediaDir, writeDeckMedia, DECK_MEDIA_PREFIX, MAX_DECK_IMAGE } from './deck-media-store.js';
import { workspaceImages } from './markdown.js';
import type { Deck, DeckImage, Slide } from '../../shared/ui/canvas/deck-model.js';

export const USER_AGENT = 'AICO-deck/1 (presentation images; +https://github.com/suhail-akhtar/aico)';

export interface FetchResult { status: number; headers: http.IncomingHttpHeaders; body: Buffer; url: string; truncated: boolean }

export type Fetcher = (url: string, opts?: { maxBytes?: number; timeoutMs?: number; headers?: Record<string, string>; accept?: string; signal?: AbortSignal }) => Promise<FetchResult>;

function request(u: URL, address: string, opts: { maxBytes: number; headers: Record<string, string>; signal: AbortSignal }): Promise<FetchResult> {
  const family = net.isIPv6(address) ? 6 : 4;
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`, method: 'GET', headers: { 'User-Agent': USER_AGENT, ...opts.headers },
      // Pinned to the checked address: a second DNS answer cannot move the socket.
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => { if (o?.all) cb(null, [{ address, family }]); else cb(null, address, family); }) as unknown as net.LookupFunction,
      ...(u.protocol === 'https:' ? { servername: net.isIP(u.hostname) ? undefined : u.hostname } : {}),
      signal: opts.signal, agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > opts.maxBytes) { res.destroy(); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), url: u.toString(), truncated: true }); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), url: u.toString(), truncated: false }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET a public http(s) URL through the SSRF guard: only public addresses,
 * pinned, at most 4 redirects each re-checked, a byte cap and a deadline.
 */
export const guardedFetch: Fetcher = async (raw, opts = {}) => {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`not a URL: ${String(raw).slice(0, 80)}`); }
  for (let hop = 0; hop < 5; hop++) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http(s) is fetched, not ${u.protocol}`);
    if (u.username || u.password) throw new Error('a URL with credentials in it is not fetched');
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const decision = decideTarget({
      host, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), addresses: await resolveAll(host),
      // Nothing vouches for a private address here: deck pictures and brand pages come from the public internet.
      credentialAdmits: false, knownTarget: false, tunnelPort: false,
    });
    if (!decision.allowed) throw new Error(`refused: ${decision.reason}`);
    const res = await request(u, decision.address, { maxBytes, headers: { ...(opts.accept ? { Accept: opts.accept } : {}), ...(opts.headers ?? {}) }, signal });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      u = new URL(String(res.headers.location), u);
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
};

// ── Licensed candidates ──────────────────────────────────────────────

export interface ImageCandidate {
  id: string;
  provider: 'openverse' | 'wikimedia' | 'pexels' | 'unsplash';
  /** What is downloaded (a size fit for slides where the provider offers one). */
  url: string;
  title: string;
  creator?: string;
  /** Short licence name: "CC BY 2.0", "CC0", "Public domain", "Pexels licence". */
  license: string;
  licenseUrl?: string;
  /** The page that states the licence and credits the creator. */
  sourceUrl: string;
  width?: number;
  height?: number;
  score: number;
  why: string;
  /** Unsplash asks that a download is reported to it. */
  trackUrl?: string;
  /** A small preview the editor shows through the engine (never fetched by the page itself). */
  thumb?: string;
}

const KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_KEEP = 2000;

function registryFile(): string {
  return path.join(deckMediaDir(), 'candidates.json');
}

const urlKey = (u: string): string => createHash('sha256').update(u).digest('hex').slice(0, 20);

async function loadRegistry(): Promise<Record<string, ImageCandidate & { at: number }>> {
  try { return JSON.parse(await readFile(registryFile(), 'utf8')) as Record<string, ImageCandidate & { at: number }>; } catch { return {}; }
}

/** Remember what a search returned, so placing one of them later is allowed and credited. */
export async function rememberCandidates(list: ImageCandidate[]): Promise<void> {
  if (!list.length) return;
  const reg = await loadRegistry();
  const now = Date.now();
  for (const c of list) {
    reg[urlKey(c.url)] = { ...c, at: now };
    if (c.thumb) reg[`t:${urlKey(c.thumb)}`] = { ...c, at: now };
  }
  const kept = Object.entries(reg).filter(([, v]) => now - v.at < KEEP_MS).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_KEEP);
  await mkdir(deckMediaDir(), { recursive: true });
  await writeFile(registryFile(), JSON.stringify(Object.fromEntries(kept)));
}

export async function candidateFor(url: string, thumb = false): Promise<ImageCandidate | undefined> {
  const hit = (await loadRegistry())[thumb ? `t:${urlKey(url)}` : urlKey(url)];
  return hit && Date.now() - hit.at < KEEP_MS ? hit : undefined;
}

const thumbCache = new Map<string, { bytes: Buffer; mediaType: string }>();

/** A search candidate's preview, fetched by the engine for the editor's picker (the page never fetches a remote picture itself). */
export async function candidateThumb(url: string, fetcher: Fetcher = guardedFetch): Promise<{ bytes: Buffer; mediaType: string }> {
  const hit = thumbCache.get(url);
  if (hit) return hit;
  if (!(await candidateFor(url, true))) throw new Error('not a preview an image search returned');
  const res = await fetcher(url, { maxBytes: 900 * 1024, timeoutMs: 12_000, accept: 'image/png,image/jpeg,image/gif' });
  const size = res.status === 200 && !res.truncated ? imageSize(res.body) : undefined;
  if (!size) throw new Error(`no preview (HTTP ${res.status})`);
  const out = { bytes: res.body, mediaType: size.ext === '.png' ? 'image/png' : size.ext === '.gif' ? 'image/gif' : 'image/jpeg' };
  thumbCache.set(url, out);
  if (thumbCache.size > 120) thumbCache.delete(thumbCache.keys().next().value!);
  return out;
}

/** Store picture bytes after checking what they are. */
export async function storePicture(bytes: Buffer): Promise<{ src: string; px: [number, number] }> {
  const size = imageSize(bytes);
  if (!size) throw new Error('not a PNG, JPEG or GIF picture (by its bytes)');
  if (size.width < 2 || size.height < 2 || size.width > 20000 || size.height > 20000) throw new Error(`a ${size.width}×${size.height} picture is not a usable slide picture`);
  const stored = await writeDeckMedia(bytes, size.ext);
  return { src: stored.src, px: [size.width, size.height] };
}

/** Download a candidate the search returned and store it. Refuses any other URL. */
export async function placeCandidate(url: string, fetcher: Fetcher = guardedFetch): Promise<DeckImage> {
  const cand = await candidateFor(url);
  if (!cand) {
    throw new Error(`NOT APPLIED — ${url.slice(0, 120)} was not returned by an image search. Pictures from the internet must come from find_images `
      + '(licensed, with credit): run it, then use one of the URLs it returns — or use a project file, or "art:mesh" for generated art.');
  }
  const res = await fetcher(cand.url, { maxBytes: MAX_DECK_IMAGE, timeoutMs: 45_000, accept: 'image/png,image/jpeg,image/gif' });
  if (res.status !== 200) throw new Error(`the picture could not be downloaded (HTTP ${res.status}) — pick another candidate`);
  if (res.truncated) throw new Error(`the picture is larger than ${MAX_DECK_IMAGE / 1048576} MB — pick another candidate`);
  if (!imageSize(res.body)) {
    throw new Error(`NOT APPLIED — ${new URL(cand.url).host} sent ${String(res.headers['content-type'] ?? 'something').split(';')[0]}, not a PNG, JPEG or GIF picture — pick another candidate`);
  }
  const stored = await storePicture(res.body);
  if (cand.trackUrl) void fetcher(cand.trackUrl, { maxBytes: 64 * 1024, timeoutMs: 10_000 }).catch(() => undefined);
  return {
    src: stored.src, alt: cand.title.slice(0, 300), px: stored.px, license: cand.license, sourceUrl: cand.sourceUrl,
    ...(cand.creator ? { credit: cand.creator.slice(0, 160) } : {}),
  };
}

/** Copy a project picture into the store (so the editor can show it). */
export async function importProjectPicture(cwd: string, file: string): Promise<DeckImage | undefined> {
  const data = await workspaceImages(cwd)(file);
  if (!data) return undefined;
  const size = imageSize(data.bytes);
  if (!size) return undefined;
  const stored = await storePicture(data.bytes);
  return { src: stored.src, px: stored.px, alt: path.basename(file).replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') };
}

/**
 * Bring every picture a deck names into the store: a search candidate's URL
 * is downloaded and credited, a project file is copied; data URLs, stored
 * pictures and generated art stay as they are. A URL that no search returned
 * refuses the whole write (nothing is half-applied).
 */
export async function importDeckImages(cwd: string, deck: Deck, opts: { fetcher?: Fetcher; only?: Set<string> } = {}): Promise<{ deck: Deck; notes: string[] }> {
  const notes: string[] = [];
  const fix = async (img: DeckImage | undefined): Promise<DeckImage | undefined> => {
    if (!img?.src) return img;
    const src = img.src;
    if (src.startsWith('data:') || src.startsWith(DECK_MEDIA_PREFIX) || src.startsWith('art:')) return img;
    if (/^https?:\/\//i.test(src)) {
      const placed = await placeCandidate(src, opts.fetcher);
      notes.push(`fetched ${placed.credit ? `"${placed.alt}" by ${placed.credit}` : `"${placed.alt}"`} (${placed.license})`);
      // The model's alt text wins (it knows what the slide needs it to say); the credit and licence are the search's.
      return { ...placed, ...(img.alt ? { alt: img.alt } : {}), ...(img.mask ? { mask: img.mask } : {}), ...(img.side ? { side: img.side } : {}), ...(img.fit ? { fit: img.fit } : {}), ...(img.caption ? { caption: img.caption } : {}) };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return img;
    const local = await importProjectPicture(cwd, src).catch(() => undefined);
    if (!local) return img;
    notes.push(`imported project picture ${src}`);
    return { ...img, src: local.src, px: local.px, ...(img.alt ? {} : { alt: local.alt }) };
  };
  const slides: Slide[] = [];
  for (const s of deck.slides) {
    if (opts.only && !opts.only.has(s.id)) { slides.push(s); continue; }
    const next: Slide = { ...s };
    if (s.image) next.image = await fix(s.image);
    if (s.images) next.images = await Promise.all(s.images.map(async i => (await fix(i))!));
    if (s.infographic) next.infographic = { ...s.infographic, items: await Promise.all(s.infographic.items.map(async it => (it.image ? { ...it, image: await fix(it.image) } : it))) };
    slides.push(next);
  }
  return { deck: { ...deck, slides }, notes };
}
