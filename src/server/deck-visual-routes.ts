/**
 * The deck editor's picture and brand routes (ADR 0025): serve a stored deck
 * picture, search licensed pictures, place one, upload or import one, and
 * read a brand's colours from its site.
 *
 * ## Why the engine does this, not the page
 *
 * The editor runs in a browser (or the desktop's renderer, or a VS Code
 * webview) that must not fetch arbitrary addresses, and the licence filter,
 * the SSRF guard and the size and type checks are engine code
 * (`canvas/deck-media.ts`). So the page asks; the engine searches, downloads
 * (only a candidate a search returned), stores the bytes by hash under the
 * AICO home and answers with the `/api/deck-media/…` src and the credit. The
 * page then writes that into the slide like any other edit.
 *
 * `deck-media/<hash>.<ext>` takes no path: a name that is not a hash plus a
 * picture extension is a 404, never a file-system probe.
 *
 * @module server/deck-visual-routes
 */

import type http from 'node:http';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readDeckMedia } from '../canvas/deck-media-store.js';
import { candidateThumb, importProjectPicture, placeCandidate, storePicture } from '../canvas/deck-media.js';
import { searchImages } from '../canvas/deck-image-search.js';
import { extractBrand } from '../canvas/deck-brand.js';
import { paletteFromBrand } from '../../shared/ui/canvas/deck-design.js';

export interface DeckVisualRouteDeps {
  resolveCwd: (sessionId: string) => Promise<string>;
  readJson: (req: http.IncomingMessage) => Promise<unknown>;
  send: (res: http.ServerResponse, status: number, body: unknown) => void;
}

const SESSION = /^[\w.-]{1,120}$/;
const PICTURE = /\.(png|jpe?g|gif)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.venv', '__pycache__']);

/** Pictures in the project (a few levels deep, at most 80), for the editor's "project files" tab. */
export async function projectPictures(root: string): Promise<{ path: string; bytes: number }[]> {
  const out: { path: string; bytes: number }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || out.length >= 80) return;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 80) return;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) await walk(full, depth + 1); }
      else if (e.isFile() && PICTURE.test(e.name)) {
        const s = await stat(full).catch(() => undefined);
        if (s && s.size <= 15 * 1024 * 1024) out.push({ path: path.relative(root, full).split(path.sep).join('/'), bytes: s.size });
      }
    }
  };
  await walk(root, 0);
  return out;
}

/** Handle a `deck-media/*` or `deck/*` route. Returns false for any other route. */
export async function handleDeckVisualRoute(
  route: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: DeckVisualRouteDeps,
): Promise<boolean> {
  if (!route.startsWith('deck-media/') && !route.startsWith('deck/')) return false;
  const { send } = deps;
  const method = req.method ?? 'GET';
  try {
    if (route.startsWith('deck-media/') && method === 'GET') {
      const found = await readDeckMedia(route.slice('deck-media/'.length));
      if (!found) { send(res, 404, { error: 'no such picture' }); return true; }
      res.writeHead(200, {
        'Content-Type': found.mediaType, 'Content-Length': String(found.bytes.length), 'X-Content-Type-Options': 'nosniff',
        // Content-addressed: a name is one picture for ever.
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
      });
      res.end(found.bytes);
      return true;
    }
    if (route === 'deck/images/search' && method === 'POST') {
      const b = await deps.readJson(req) as { query?: string; orientation?: string; count?: number; slot?: { w: number; h: number } };
      const o = b.orientation === 'portrait' || b.orientation === 'square' || b.orientation === 'landscape' ? b.orientation : undefined;
      const r = await searchImages(String(b.query ?? ''), { ...(o ? { orientation: o } : {}), count: Math.min(12, Number(b.count) || 9), ...(b.slot ? { slot: b.slot } : {}) });
      send(res, 200, r);
      return true;
    }
    if (route === 'deck/images/thumb' && method === 'GET') {
      const t = await candidateThumb(url.searchParams.get('u') ?? '');
      res.writeHead(200, {
        'Content-Type': t.mediaType, 'Content-Length': String(t.bytes.length), 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
      });
      res.end(t.bytes);
      return true;
    }
    if (route === 'deck/images/place' && method === 'POST') {
      const b = await deps.readJson(req) as { url?: string };
      send(res, 200, { image: await placeCandidate(String(b.url ?? '')) });
      return true;
    }
    if (route === 'deck/images/upload' && method === 'POST') {
      const b = await deps.readJson(req) as { name?: string; data?: string };
      const bytes = Buffer.from(String(b.data ?? '').replace(/^data:[^,]*,/, ''), 'base64');
      const stored = await storePicture(bytes);
      send(res, 200, { image: { src: stored.src, px: stored.px, alt: String(b.name ?? 'Picture').replace(/\.[a-z0-9]+$/i, '').slice(0, 200) } });
      return true;
    }
    if (route === 'deck/images/project') {
      const sessionId = method === 'GET' ? url.searchParams.get('session') ?? '' : '';
      if (method === 'GET') {
        if (!SESSION.test(sessionId)) { send(res, 400, { error: 'session required' }); return true; }
        send(res, 200, { files: await projectPictures(await deps.resolveCwd(sessionId)) });
        return true;
      }
      const b = await deps.readJson(req) as { session?: string; path?: string };
      if (!SESSION.test(String(b.session ?? '')) || !b.path) { send(res, 400, { error: 'session and path required' }); return true; }
      const image = await importProjectPicture(await deps.resolveCwd(String(b.session)), String(b.path));
      if (!image) { send(res, 404, { error: 'no PNG, JPEG or GIF picture at that path in the project' }); return true; }
      send(res, 200, { image });
      return true;
    }
    if (route === 'deck/brand' && method === 'POST') {
      const b = await deps.readJson(req) as { url?: string; theme?: string };
      const brand = await extractBrand(String(b.url ?? ''));
      send(res, 200, { brand, palette: brand.colors.length ? paletteFromBrand(brand.colors, String(b.theme ?? 'slate')) : {} });
      return true;
    }
    send(res, 404, { error: `unknown deck route ${route}` });
    return true;
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
