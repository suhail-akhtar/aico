/**
 * Where a project's graph is kept between runs: one JSON file per project
 * under `aicoHome()/codegraph/`, never inside the user's repository.
 *
 * What is stored is the expensive part — each file's parse, keyed by its
 * content hash — plus the git summary and the HEAD it was read at, and the
 * TypeScript checker's method calls with the file hashes they were computed
 * for (codegraph/ts-check), so a restart does not re-run the checker. The
 * resolved graph is not stored: it is rebuilt from the parses in memory in
 * tens of milliseconds, and storing it would mean two things to keep in step.
 *
 * A store that cannot be read or written costs a rebuild, never an error.
 *
 * @module codegraph/store
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { aicoHome } from '../home.js';
import type { FileRecord } from './types.js';
import { emptyHistory, type GitHistory } from './git.js';
import type { TsFileResult, TsImpl } from './ts-check.js';

/** Bumped when the parse format changes; an older store is ignored and rebuilt. */
export const STORE_VERSION = 4;

/** The checker's answers and what they were computed from. */
export interface StoredTsExact {
  /** Hash of every TS/JS file's content hash and the tsconfigs: equal means nothing changed. */
  env: string;
  /** Per file: the content hash its calls were computed for. */
  hashes: Record<string, string>;
  files: Record<string, TsFileResult>;
  impls: TsImpl[];
  at: number;
}

interface StoredGit {
  available: boolean;
  head?: string;
  commits: number;
  skippedLarge: number;
  churn: Array<[string, number]>;
  authors: Array<[string, Array<[string, number]>]>;
  lastChanged: Array<[string, number]>;
  pairs: Array<[string, number]>;
  recent: Array<[string, Array<{ hash: string; at: number; author: string; subject: string }>]>;
}

interface Stored {
  storeVersion: number;
  root: string;
  savedAt: number;
  records: FileRecord[];
  git?: StoredGit;
  tsExact?: StoredTsExact;
}

export function storePath(root: string): string {
  const digest = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(aicoHome(), 'codegraph', `${digest}.json`);
}

export async function loadStore(root: string): Promise<{ records: FileRecord[]; git: GitHistory; tsExact?: StoredTsExact } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(storePath(root), 'utf8')) as Stored;
    if (parsed.storeVersion !== STORE_VERSION || !Array.isArray(parsed.records)) return undefined;
    return { records: parsed.records, git: parsed.git ? reviveGit(parsed.git) : emptyHistory(), ...(parsed.tsExact ? { tsExact: parsed.tsExact } : {}) };
  } catch {
    return undefined;
  }
}

export async function saveStore(root: string, records: FileRecord[], git: GitHistory, tsExact?: StoredTsExact): Promise<void> {
  try {
    const file = storePath(root);
    await mkdir(path.dirname(file), { recursive: true });
    const body: Stored = { storeVersion: STORE_VERSION, root: path.resolve(root), savedAt: Date.now(), records, git: storeGit(git), ...(tsExact ? { tsExact } : {}) };
    // Write then rename, so a reader never sees half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(body), 'utf8');
    await rename(tmp, file);
  } catch {
    // A graph that cannot be cached is rebuilt next time. Slower, not broken.
  }
}

function storeGit(g: GitHistory): StoredGit {
  // Pairs seen once are noise and most of the volume; they are not kept.
  const pairs = [...g.pairs.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 20_000);
  return {
    available: g.available, ...(g.head ? { head: g.head } : {}), commits: g.commits, skippedLarge: g.skippedLarge,
    churn: [...g.churn.entries()],
    authors: [...g.authors.entries()].map(([f, m]) => [f, [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)]),
    lastChanged: [...g.lastChanged.entries()],
    pairs,
    recent: [...g.recent.entries()],
  };
}

function reviveGit(s: StoredGit): GitHistory {
  return {
    available: s.available, ...(s.head ? { head: s.head } : {}), commits: s.commits, skippedLarge: s.skippedLarge,
    churn: new Map(s.churn),
    authors: new Map(s.authors.map(([f, list]) => [f, new Map(list)])),
    lastChanged: new Map(s.lastChanged),
    pairs: new Map(s.pairs),
    recent: new Map(s.recent),
  };
}
