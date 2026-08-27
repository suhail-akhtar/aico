/**
 * Keeping a built map, and knowing when to stop trusting it.
 *
 * Staleness is decided by sampling rather than by re-walking. A full walk to
 * check whether a walk is needed costs the same as doing it, so this compares
 * the recorded modification times of a spread of indexed files against disk:
 * if any of them moved, the project moved. It is a heuristic and it is stated
 * as one — a change confined entirely to files outside the sample survives
 * until the age limit expires.
 *
 * The age limit is the backstop that makes that acceptable. Nothing here is
 * ever more than a day old, and `refresh` forces the issue immediately.
 *
 * @module codemap/store
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { stat } from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import type { CodeMap } from './types.js';

/** Beyond this a map is rebuilt whether or not the sample looks unchanged. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How many files to check before believing the rest are unchanged. */
const SAMPLE_SIZE = 24;

function mapPath(root: string): string {
  // Hashed rather than derived from the path, because a project path contains
  // separators, drive letters and spaces, and a readable filename is worth
  // less here than one that cannot collide or escape its directory.
  const digest = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.aico', 'codemap', `${digest}.json`);
}

export async function loadCodeMap(root: string): Promise<CodeMap | undefined> {
  try {
    const parsed = JSON.parse(await readFile(mapPath(root), 'utf8')) as CodeMap;
    return Array.isArray(parsed?.files) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function saveCodeMap(map: CodeMap): Promise<void> {
  try {
    const file = mapPath(map.root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(map), 'utf8');
  } catch {
    // A map that cannot be cached is rebuilt next time. Slower, not broken.
  }
}

/**
 * Whether a stored map still describes the project on disk.
 *
 * Spread across the file list rather than taking the first N, so a change in a
 * deep directory is as visible as one at the root — the first N of an
 * alphabetical listing is usually one folder, and a sample of one folder is a
 * sample of one folder.
 */
export async function isStale(map: CodeMap): Promise<boolean> {
  if (Date.now() - map.builtAt > MAX_AGE_MS) return true;
  if (map.files.length === 0) return true;

  const step = Math.max(1, Math.floor(map.files.length / SAMPLE_SIZE));
  for (let i = 0; i < map.files.length; i += step) {
    const entry = map.files[i]!;
    try {
      const info = await stat(path.join(map.root, entry.path));
      if (Math.abs(info.mtimeMs - entry.mtimeMs) > 1) return true;
    } catch {
      // Deleted since the map was built, which is itself a change.
      return true;
    }
  }
  return false;
}
