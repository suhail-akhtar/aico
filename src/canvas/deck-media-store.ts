/**
 * Where a deck's pictures live once AICO has them: a content-addressed
 * folder under the AICO home (`<AICO_HOME>/media/deck/<sha>.<ext>`), named in
 * slides as `/api/deck-media/<sha>.<ext>`.
 *
 * ## Why not the project, and why not data URLs
 *
 * A picture fetched from Openverse or a stock library is not a project file
 * the person asked for (GenerateImage's pictures are, and stay in the
 * project); writing it into their repository would be a surprise. A data URL
 * inside the deck's JSON makes every canvas version carry megabytes. So the
 * bytes go once into the AICO home, by hash (the same picture placed twice is
 * one file), and the slide names it with a path every client can show — the
 * engine serves `/api/deck-media/…` behind its token — and every exporter can
 * resolve (`workspaceImages` reads it from here).
 *
 * This module only stores and reads; it never fetches (`deck-media.ts` does,
 * through the SSRF guard), and a name that is not exactly a hash plus a known
 * extension is refused, so the route cannot be walked to another file.
 *
 * @module canvas/deck-media-store
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { aicoHome } from '../home.js';

export const DECK_MEDIA_PREFIX = '/api/deck-media/';
const NAME = /^[a-f0-9]{24}\.(png|jpeg|gif)$/;
const MEDIA: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' };
/** A slide picture is at most this big (a 4K JPEG is ~3 MB; a camera original is not a slide picture). */
export const MAX_DECK_IMAGE = 15 * 1024 * 1024;

export function deckMediaDir(): string {
  return path.join(aicoHome(), 'media', 'deck');
}

/** The stored file a `/api/deck-media/<name>` src names, or undefined for anything else. */
export function deckMediaName(src: string): string | undefined {
  if (!src.startsWith(DECK_MEDIA_PREFIX)) return undefined;
  const name = src.slice(DECK_MEDIA_PREFIX.length).split(/[?#]/)[0]!;
  return NAME.test(name) ? name : undefined;
}

/** Store picture bytes (already checked to be PNG/JPEG/GIF); returns the src slides use. */
export async function writeDeckMedia(bytes: Buffer, ext: '.png' | '.jpeg' | '.gif'): Promise<{ src: string; name: string }> {
  if (bytes.length > MAX_DECK_IMAGE) throw new Error(`the picture is ${(bytes.length / 1048576).toFixed(1)} MB — at most ${MAX_DECK_IMAGE / 1048576} MB`);
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}${ext}`;
  const dir = deckMediaDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const exists = await stat(file).then(s => s.size === bytes.length, () => false);
  if (!exists) await writeFile(file, bytes);
  return { src: `${DECK_MEDIA_PREFIX}${name}`, name };
}

/** Read a stored picture by its src (or bare name). */
export async function readDeckMedia(srcOrName: string): Promise<{ bytes: Buffer; mediaType: string; ext: string } | undefined> {
  const name = srcOrName.startsWith(DECK_MEDIA_PREFIX) ? deckMediaName(srcOrName) : NAME.test(srcOrName) ? srcOrName : undefined;
  if (!name) return undefined;
  try {
    const bytes = await readFile(path.join(deckMediaDir(), name));
    const ext = name.split('.').pop()!;
    return { bytes, mediaType: MEDIA[ext]!, ext: `.${ext}` };
  } catch {
    return undefined;
  }
}
