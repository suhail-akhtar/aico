/**
 * Walking a project once so the agent does not have to walk it every session.
 *
 * The cost this removes is real and repeated: without a map, understanding an
 * unfamiliar repository means a dozen Glob calls, a handful of Greps and a
 * scattering of Reads — every one of them a model round trip, paid again at
 * the start of every session, on a codebase that did not change in between.
 *
 * Building the map costs file I/O and **no model tokens at all**. That is the
 * whole point of it, and it is why the result is queried through a tool rather
 * than pushed into the prompt: an index injected into every request would
 * spend on every turn exactly what it was built to save.
 *
 * @module codemap/build
 */

import fastGlob from 'fast-glob';
import { readFile, stat } from 'fs/promises';
import path from 'path';
import type { CodeMap, FileEntry } from './types.js';
import { extractPurpose, extractSymbols, languageFor } from './extract.js';

/**
 * Directories never worth indexing.
 *
 * Dependencies and build output are the two that matter: `node_modules` alone
 * would dwarf the project by two orders of magnitude, and a map mostly made of
 * other people's code is worse than no map — the agent's own files would be
 * lost in it.
 *
 * This list is the floor, not the whole answer. Every project names its own
 * build output differently — this repository emits `web-dist/` and
 * `dist-test/`, neither of which any generic list would guess — so
 * {@link gitignorePatterns} reads what the project already says about itself.
 * Chasing directory names by hand is a list that is permanently one project
 * behind.
 */
const IGNORED = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**',
  '**/.next/**', '**/.nuxt/**', '**/coverage/**', '**/vendor/**', '**/target/**',
  '**/__pycache__/**', '**/.venv/**', '**/venv/**', '**/.mypy_cache/**',
  '**/*.min.js', '**/*.bundle.js', '**/*.map',
];

const INDEXED_EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'rb', 'php', 'cs', 'swift', 'kt',
];

/** Files past this are recorded but not opened. */
const MAX_FILE_BYTES = 400_000;

/**
 * Files past this end the walk.
 *
 * A bound rather than a promise to index everything, because the failure mode
 * of the alternative is a monorepo that makes the first query take a minute.
 * The count is reported, so a truncated map says it is truncated instead of
 * quietly describing a fraction of the project as though it were all of it.
 */
const MAX_FILES = 5_000;

export interface BuildOptions {
  root: string;
  maxFiles?: number;
}

/**
 * Ignore globs derived from the project's own `.gitignore`.
 *
 * Not a full implementation of the format, and deliberately so: negations,
 * nested ignore files and anchoring subtleties all exist, and getting them
 * wrong in the *excluding* direction would hide real source. So only the
 * unambiguous forms are honoured — a plain directory or file pattern with no
 * negation — and anything cleverer is left to the built-in list. Missing an
 * ignore costs a few noisy entries in the map; over-applying one costs the
 * agent a file it needed.
 */
async function gitignorePatterns(root: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return [];
  }

  const patterns: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    // A trailing slash means a directory; everything under it goes.
    const body = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!body || body.includes('!')) continue;
    patterns.push(`**/${body}/**`, `**/${body}`);
  }
  return patterns;
}

/** Read a project into a map. Pure file I/O; no model is involved. */
export async function buildCodeMap(options: BuildOptions): Promise<CodeMap> {
  const root = options.root;
  const limit = options.maxFiles ?? MAX_FILES;

  const matches = await fastGlob(`**/*.{${INDEXED_EXTENSIONS.join(',')}}`, {
    cwd: root,
    ignore: [...IGNORED, ...await gitignorePatterns(root)],
    followSymbolicLinks: false,
    onlyFiles: true,
    dot: false,
    suppressErrors: true,
  });

  matches.sort();
  const chosen = matches.slice(0, limit);

  const files: FileEntry[] = [];
  let unparsed = 0;
  let skipped = 0;

  // Bounded concurrency. Unbounded `Promise.all` over five thousand files
  // exhausts the file-descriptor table on every platform that has one.
  const QUEUE = 32;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(QUEUE, chosen.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const relative = chosen[index];
      if (relative === undefined) return;
      const entry = await readEntry(root, relative);
      if (!entry) { skipped++; continue; }
      if (entry.symbols.length === 0 && !entry.purpose) unparsed++;
      files.push(entry);
    }
  });
  await Promise.all(workers);

  // Sorted after the fact: the workers finish out of order, and a map whose
  // file order changed between builds would produce a different answer to the
  // same question for no reason.
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    root,
    builtAt: Date.now(),
    files,
    unparsed,
    skipped: skipped + Math.max(0, matches.length - chosen.length),
  };
}

async function readEntry(root: string, relative: string): Promise<FileEntry | undefined> {
  const absolute = path.join(root, relative);
  try {
    const info = await stat(absolute);
    // Normalised to forward slashes so a map built on Windows reads the same
    // as one built anywhere else, and so a path from it can be handed straight
    // back to a tool.
    const normalised = relative.split(path.sep).join('/');
    const base: FileEntry = {
      path: normalised,
      symbols: [],
      bytes: info.size,
      mtimeMs: info.mtimeMs,
    };
    if (info.size > MAX_FILE_BYTES) return base;

    const language = languageFor(path.extname(relative));
    const source = await readFile(absolute, 'utf8');
    const purpose = language ? extractPurpose(source, language) : undefined;
    return {
      ...base,
      ...purpose ? { purpose } : {},
      symbols: language ? extractSymbols(source, language) : [],
    };
  } catch {
    // Unreadable, vanished mid-walk, or not text. One file is not worth
    // failing an index over.
    return undefined;
  }
}
