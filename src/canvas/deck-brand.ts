/**
 * A brand's colours (and font, when it is one the layout engine can measure)
 * from its website — so "a deck for Contoso" can be in Contoso's colours.
 *
 * ## How, and what it does not do
 *
 * The page is fetched through the SSRF guard (public addresses only, pinned,
 * size-capped) and read as *data*: nothing on it is followed except, at most,
 * three of its own stylesheets and one logo or icon picture. Colours are
 * collected from where brands declare them — `<meta name="theme-color">`,
 * CSS custom properties named like a brand colour (`--primary`, `--brand`,
 * `--accent`…), then every colour in the CSS by how often it is used — and
 * near-greys, near-white and near-black are dropped (they are every site's
 * text and background, not its brand). A PNG logo's dominant colour is found
 * by decoding it here (zlib only; no image library), an SVG logo's from its
 * fills. The result is a ranked list the design brief turns into a palette
 * (`shared/ui/canvas/deck-design.ts`), never applied blindly: the palette is
 * then held to the contrast rules like any theme.
 *
 * Text on the page (including anything that reads like an instruction) is
 * never returned to the model — only colours, a font name from a closed list,
 * the site's name from its title, and how each was found.
 *
 * @module canvas/deck-brand
 */

import { inflateSync } from 'node:zlib';
import { MEASURED_FONTS } from '../../shared/ui/canvas/deck-fonts.js';
import { hexToHsl } from '../../shared/ui/canvas/deck-themes.js';
import { guardedFetch, type Fetcher } from './deck-media.js';

export interface BrandResult {
  url: string;
  name?: string;
  /** Ranked brand colours, #RRGGBB. */
  colors: string[];
  font?: string;
  /** How each colour was found, for the person to judge. */
  notes: string[];
}

function hex6(raw: string): string | undefined {
  const s = raw.trim().replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(s)) return `#${s.split('').map(ch => ch + ch).join('')}`.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(s)) return `#${s}`.toUpperCase();
  if (/^[0-9a-f]{8}$/i.test(s)) return `#${s.slice(0, 6)}`.toUpperCase();
  return undefined;
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** A colour that can be a brand colour: not a grey, not near-white, not near-black. */
export function isBrandish(hex: string): boolean {
  const [, s, l] = hexToHsl(hex);
  return s >= 0.22 && l >= 0.12 && l <= 0.88;
}

/** Every colour in CSS text, with brand-named custom properties weighted up. */
export function cssColors(css: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (hex: string | undefined, w: number): void => { if (hex && isBrandish(hex)) counts.set(hex, (counts.get(hex) ?? 0) + w); };
  // Custom properties named like brand colours.
  for (const m of css.matchAll(/--([\w-]*(?:primary|brand|accent|main|theme|secondary|highlight)[\w-]*)\s*:\s*([^;}{]+)/gi)) {
    const v = m[2]!;
    const h = /#([0-9a-f]{3,8})\b/i.exec(v);
    const rgb = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
    add(h ? hex6(h[1]!) : rgb ? rgbHex(+rgb[1]!, +rgb[2]!, +rgb[3]!) : undefined, /secondary/i.test(m[1]!) ? 6 : 10);
  }
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) add(hex6(m[1]!), 1);
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) add(rgbHex(+m[1]!, +m[2]!, +m[3]!), 1);
  return counts;
}

/** Merge colours closer than a small distance, keeping the more used one. */
export function rankColors(counts: Map<string, number>, max = 5): string[] {
  const rgb = (h: string): number[] => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const out: string[] = [];
  for (const [hex] of sorted) {
    const c = rgb(hex);
    if (out.some(o => { const d = rgb(o); return Math.hypot(c[0]! - d[0]!, c[1]! - d[1]!, c[2]! - d[2]!) < 48; })) continue;
    out.push(hex);
    if (out.length >= max) break;
  }
  return out;
}

// ── Pictures: the dominant colour of a PNG or SVG logo ───────────────

/** Decode an 8-bit RGB/RGBA/palette (1–8 bit) PNG to RGBA pixels, or undefined. Non-interlaced only; capped at 4 M pixels. */
export function decodePng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } | undefined {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return undefined;
  let pos = 8;
  let width = 0; let height = 0; let depth = 0; let type = 0; let interlace = 0;
  let palette: Buffer | undefined; let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]!; type = data[9]!; interlace = data[12]!; }
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height || width * height > 4_000_000 || interlace) return undefined;
  const channels = type === 2 ? 3 : type === 6 ? 4 : type === 3 ? 1 : type === 0 ? 1 : type === 4 ? 2 : 0;
  if (!channels || (type !== 3 && depth !== 8)) return undefined;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return undefined; }
  const bpp = Math.max(1, (channels * depth) / 8);
  const stride = Math.ceil((width * channels * depth) / 8);
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    if (line.length < stride) return undefined;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - Math.floor(bpp)]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - Math.floor(bpp)]! : 0;
      let v = line[i]!;
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (type === 3) {
        const bit = x * depth;
        const idx = (line[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        out[o] = palette?.[idx * 3] ?? 0; out[o + 1] = palette?.[idx * 3 + 1] ?? 0; out[o + 2] = palette?.[idx * 3 + 2] ?? 0; out[o + 3] = trns?.[idx] ?? 255;
      } else if (type === 0 || type === 4) {
        const g = line[x * channels]!;
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = type === 4 ? line[x * channels + 1]! : 255;
      } else {
        out[o] = line[x * channels]!; out[o + 1] = line[x * channels + 1]!; out[o + 2] = line[x * channels + 2]!; out[o + 3] = channels === 4 ? line[x * channels + 3]! : 255;
      }
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

/** The most used brand-like colours of a picture (opaque pixels, 4-bit buckets). */
export function dominantColors(rgba: Uint8Array, max = 3): string[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const step = Math.max(1, Math.floor(rgba.length / 4 / 40000));
  for (let i = 0; i < rgba.length; i += 4 * step) {
    if (rgba[i + 3]! < 200) continue;
    const key = ((rgba[i]! >> 4) << 8) | ((rgba[i + 1]! >> 4) << 4) | (rgba[i + 2]! >> 4);
    const b = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += rgba[i]!; b.g += rgba[i + 1]!; b.b += rgba[i + 2]!;
    buckets.set(key, b);
  }
  const counts = new Map<string, number>();
  for (const b of buckets.values()) {
    const hex = rgbHex(b.r / b.n, b.g / b.n, b.b / b.n);
    if (isBrandish(hex)) counts.set(hex, (counts.get(hex) ?? 0) + b.n);
  }
  return rankColors(counts, max);
}

const FONT_ALIASES: Record<string, string> = { helvetica: 'Arial', 'helvetica neue': 'Arial', inter: 'Segoe UI', roboto: 'Segoe UI', 'open sans': 'Segoe UI', lato: 'Calibri', 'source sans pro': 'Calibri', 'times new roman': 'Georgia', merriweather: 'Georgia', montserrat: 'Century Gothic', poppins: 'Century Gothic', futura: 'Century Gothic' };

/** The first font-family in the CSS that the deck can use (measured), directly or as its nearest measured cousin. */
export function cssFont(css: string): string | undefined {
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    for (const part of m[1]!.split(',')) {
      const f = part.trim().replace(/^["']|["']$/g, '').toLowerCase();
      const hit = MEASURED_FONTS.find(x => x.toLowerCase() === f) ?? FONT_ALIASES[f];
      if (hit && hit !== 'Consolas') return hit;
    }
  }
  return undefined;
}

/** Brand colours, name and font from a page's HTML (and the CSS and logo it links to, fetched by `fetcher`). */
export async function extractBrand(rawUrl: string, deps: { fetcher?: Fetcher } = {}): Promise<BrandResult> {
  const fetcher = deps.fetcher ?? guardedFetch;
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`); } catch { throw new Error(`not a website address: ${rawUrl.slice(0, 80)}`); }
  const page = await fetcher(url.toString(), { maxBytes: 1.5 * 1024 * 1024, timeoutMs: 15_000, accept: 'text/html' });
  if (page.status !== 200) throw new Error(`${url.host} answered HTTP ${page.status}`);
  const html = page.body.toString('utf8');
  const base = new URL(page.url);
  const notes: string[] = [];
  const counts = new Map<string, number>();
  const bump = (hex: string | undefined, w: number, why: string): void => {
    if (!hex || !isBrandish(hex)) return;
    counts.set(hex, (counts.get(hex) ?? 0) + w);
    if (w >= 20) notes.push(`${hex} from ${why}`);
  };
  const meta = (name: string): string | undefined => new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["']`, 'i').exec(html)?.slice(1).find(Boolean);
  bump(hex6(meta('theme-color') ?? ''), 40, 'the page\'s theme-color');
  bump(hex6(meta('msapplication-TileColor') ?? ''), 25, 'the tile colour');
  let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
  css += [...html.matchAll(/style=["']([^"']+)["']/gi)].map(m => m[1]).join(';');
  const sheets = [...html.matchAll(/<link[^>]+rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi)].map(m => /href=["']([^"']+)["']/i.exec(m[0])?.[1]).filter((h): h is string => Boolean(h)).slice(0, 3);
  for (const href of sheets) {
    try {
      const r = await fetcher(new URL(href, base).toString(), { maxBytes: 600 * 1024, timeoutMs: 10_000, accept: 'text/css' });
      if (r.status === 200) css += `\n${r.body.toString('utf8')}`;
    } catch (err) { notes.push(`stylesheet not read (${err instanceof Error ? err.message.slice(0, 80) : 'error'})`); }
  }
  for (const [hex, n] of cssColors(css)) bump(hex, n, 'the CSS');
  // The logo: an SVG's fills, or a PNG's dominant colour.
  const logoHref = /<link[^>]+rel=["'](?:apple-touch-icon|icon|shortcut icon)["'][^>]*href=["']([^"']+\.(?:png|svg)[^"']*)["']/i.exec(html)?.[1]
    ?? /<img[^>]+src=["']([^"']*logo[^"']*\.(?:png|svg)[^"']*)["']/i.exec(html)?.[1];
  if (logoHref) {
    try {
      const r = await fetcher(new URL(logoHref, base).toString(), { maxBytes: 1024 * 1024, timeoutMs: 10_000 });
      if (r.status === 200) {
        if (/\.svg/i.test(logoHref) || /<svg/i.test(r.body.subarray(0, 200).toString('utf8'))) {
          for (const [hex, n] of cssColors(r.body.toString('utf8').replace(/fill=["']/g, 'fill:'))) bump(hex, 8 + n * 2, 'the logo');
        } else {
          const png = decodePng(r.body);
          if (png) dominantColors(png.rgba).forEach((hex, i) => bump(hex, 30 - i * 8, 'the logo\'s pixels'));
        }
      }
    } catch (err) { notes.push(`logo not read (${err instanceof Error ? err.message.slice(0, 80) : 'error'})`); }
  }
  const title = meta('og:site_name') ?? /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1];
  const name = title?.replace(/\s+/g, ' ').split(/\s[|–—-]\s/)[0]!.trim().slice(0, 60);
  const font = cssFont(css);
  const colors = rankColors(counts, 5);
  if (!colors.length) notes.push('no brand colour found (the site may be all greys, or styled by script) — give the colours instead');
  return { url: base.toString(), ...(name ? { name } : {}), colors, ...(font ? { font } : {}), notes: [...new Set(notes)].slice(0, 8) };
}
