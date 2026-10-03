/**
 * Markdown → syntax tree for canvas exports, and the images a document refers to.
 *
 * ## Why this parser
 *
 * The chat and the canvas render Markdown with `react-markdown` + `remark-gfm`,
 * which parse with `mdast-util-from-markdown` and the GFM micromark extension.
 * Exports parse with exactly those packages, so a table, a task list or a
 * nested list comes out of a .docx the way it looked on screen — a hand-rolled
 * parser would disagree with the renderer on the edge cases (lazy
 * continuation, loose lists, pipes in code spans) that make up most bug
 * reports. They are bundled into `dist/` at build time (devDependencies, like
 * the web client's), so nothing new is installed at runtime (ADR 0008).
 *
 * ## Images
 *
 * A document may embed a picture as a data URL or refer to a file in the
 * project. Files are read only from inside the session's project directory
 * and only as png/jpeg/gif/webp/svg under 15 MB; remote URLs are never
 * fetched (an export must not become a way to make the engine request an
 * arbitrary address). A deck's `/api/deck-media/<hash>` pictures are read
 * from the AICO home's media store (`deck-media-store.ts`).
 *
 * @module canvas/markdown
 */

import path from 'path';
import { readFile, stat } from 'fs/promises';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import type { Root } from 'mdast';
import { DECK_MEDIA_PREFIX, readDeckMedia } from './deck-media-store.js';

export type { Root } from 'mdast';

export function parseMarkdown(markdown: string): Root {
  // Maths (`$…$`, `$$…$$`) as the chat parses it (remark-math uses the same pair).
  return fromMarkdown(markdown, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
}

export interface ImageData {
  bytes: Buffer;
  mediaType: string;
  /** File extension including the dot, lowercase. */
  ext: string;
}

export type ImageResolver = (src: string) => Promise<ImageData | undefined>;

const MEDIA: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const EXT_OF: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpeg', 'image/jpg': '.jpeg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg',
};
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Decode a `data:image/…;base64,` URL. */
export function decodeDataUrl(src: string): ImageData | undefined {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src.trim());
  if (!m) return undefined;
  const mediaType = m[1]!.toLowerCase();
  const ext = EXT_OF[mediaType];
  if (!ext) return undefined;
  const bytes = Buffer.from(m[2]!.replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return undefined;
  return { bytes, mediaType: mediaType === 'image/jpg' ? 'image/jpeg' : mediaType, ext };
}

/**
 * Images from data URLs, or files inside `root`. Anything else — a remote
 * URL, a path that climbs out, an unknown type — resolves to nothing, and the
 * exporter shows the alt text instead.
 */
export function workspaceImages(root: string): ImageResolver {
  const base = path.resolve(root);
  return async (src) => {
    if (!src) return undefined;
    if (/^data:/i.test(src)) return decodeDataUrl(src);
    // A picture AICO stored for a deck (ADR 0025): by hash from the AICO home, never a path walk.
    if (src.startsWith(DECK_MEDIA_PREFIX)) return readDeckMedia(src);
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return undefined;
    let rel = src;
    try { rel = decodeURIComponent(src); } catch { /* keep as written */ }
    rel = rel.replace(/^file:\/\//i, '').split(/[?#]/)[0]!;
    const full = path.resolve(base, rel);
    const inside = path.relative(base, full);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
    const ext = path.extname(full).toLowerCase();
    const mediaType = MEDIA[ext];
    if (!mediaType) return undefined;
    try {
      const s = await stat(full);
      if (!s.isFile() || s.size > MAX_IMAGE_BYTES) return undefined;
      return { bytes: await readFile(full), mediaType, ext: ext === '.jpg' ? '.jpeg' : ext };
    } catch {
      return undefined;
    }
  };
}

/** A file name from a title: lowercase words joined by dashes. */
export function fileBase(title: string): string {
  const base = String(title ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return base || 'document';
}
