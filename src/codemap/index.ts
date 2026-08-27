/**
 * The codebase map, and the four questions worth asking it.
 *
 * ## Why this is a tool and not a prompt
 *
 * The obvious way to give an agent a project map is to put one in the system
 * prompt. It is also the way that loses: a map big enough to be useful is
 * thousands of tokens, and in the prompt it is paid for on **every request of
 * every turn** — including the many that are editing one known file and need
 * none of it. An index that costs more than the exploration it replaces is a
 * regression wearing a feature's clothes.
 *
 * So nothing here is ever injected. The map lives on disk, costs no model
 * tokens to build, and is read only when the agent asks — the same progressive
 * disclosure the attachment manifest uses, for the same reason.
 *
 * Every answer is bounded. An unbounded query against a five-thousand-file map
 * would hand back more than the exploration it was meant to save, which is the
 * same failure by a different route.
 *
 * @module codemap
 */

import { buildCodeMap } from './build.js';
import { isStale, loadCodeMap, saveCodeMap } from './store.js';
import type { CodeMap, FileEntry } from './types.js';

export type { CodeMap, FileEntry } from './types.js';
export { buildCodeMap } from './build.js';
export { loadCodeMap, saveCodeMap, isStale } from './store.js';

/** In-process cache, so several queries in one turn cost one disk read. */
const memory = new Map<string, CodeMap>();

/**
 * The current map for a project, building or refreshing it if needed.
 *
 * Callers never wait on this more than once per turn in practice: the first
 * query pays for the walk, everything after it hits memory.
 */
export async function getCodeMap(root: string, force = false): Promise<CodeMap> {
  if (!force) {
    const held = memory.get(root);
    if (held) return held;

    const stored = await loadCodeMap(root);
    if (stored && !await isStale(stored)) {
      memory.set(root, stored);
      return stored;
    }
  }

  const built = await buildCodeMap({ root });
  await saveCodeMap(built);
  memory.set(root, built);
  return built;
}

/** Forget cached maps. For tests, and after a change that invalidates one. */
export function resetCodeMapCache(): void {
  memory.clear();
}

/**
 * The shape of the project: which directories exist and how big they are.
 *
 * The first thing worth knowing about an unfamiliar repository, and the
 * cheapest — a few dozen lines that replace the Glob-and-squint that would
 * otherwise open a session.
 */
export function overview(map: CodeMap, limit = 40): string {
  if (map.files.length === 0) return 'No indexable source files found.';

  const byDirectory = new Map<string, { files: number; bytes: number }>();
  for (const file of map.files) {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.';
    const cell = byDirectory.get(dir) ?? { files: 0, bytes: 0 };
    cell.files++;
    cell.bytes += file.bytes;
    byDirectory.set(dir, cell);
  }

  const rows = [...byDirectory.entries()]
    .sort((a, b) => b[1].files - a[1].files)
    .slice(0, limit)
    .map(([dir, cell]) => `  ${dir}  —  ${cell.files} files, ${Math.round(cell.bytes / 1024)}KB`);

  const truncated = byDirectory.size > limit
    ? `\n  … and ${byDirectory.size - limit} more directories`
    : '';

  return `${map.files.length} indexed source files across ${byDirectory.size} directories.\n`
    + `${rows.join('\n')}${truncated}\n`
    + note(map);
}

/** Files in one directory, each with what it says it is for. */
export function listDirectory(map: CodeMap, prefix: string, limit = 60): string {
  const clean = prefix.replace(/^\.?\//, '').replace(/\/$/, '');
  const inside = map.files.filter(f => (clean === '' || clean === '.')
    ? !f.path.includes('/')
    : f.path.startsWith(`${clean}/`));

  if (inside.length === 0) return `Nothing indexed under "${prefix}".`;

  const rows = inside.slice(0, limit).map(describe);
  const truncated = inside.length > limit
    ? `\n… and ${inside.length - limit} more files under ${clean}`
    : '';
  return `${inside.length} files under ${clean || '.'}:\n${rows.join('\n')}${truncated}`;
}

/**
 * Where a symbol is declared.
 *
 * Exact matches first, then the ones that merely contain the term — an agent
 * looking for `runAgent` wants that file before it wants `runAgentInContext`,
 * and ordering by relevance is the difference between reading one result and
 * reading all of them.
 */
export function findSymbol(map: CodeMap, name: string, limit = 20): string {
  const needle = name.toLowerCase();
  const exact: FileEntry[] = [];
  const partial: FileEntry[] = [];

  for (const file of map.files) {
    const names = file.symbols.map(s => s.toLowerCase());
    if (names.includes(needle)) exact.push(file);
    else if (names.some(s => s.includes(needle))) partial.push(file);
  }

  const hits = [...exact, ...partial].slice(0, limit);
  if (hits.length === 0) {
    return `No indexed file declares a symbol matching "${name}". `
      + 'The index only records exported/top-level declarations — Grep will find local ones.';
  }
  const rows = hits.map((file) => {
    const matched = file.symbols.filter(s => s.toLowerCase().includes(needle));
    return `  ${file.path}  —  ${matched.join(', ')}`;
  });
  return `${hits.length} file(s) declaring "${name}":\n${rows.join('\n')}`;
}

/**
 * Files whose stated purpose mentions a term.
 *
 * Searches the one-line summaries rather than file contents, which is what
 * makes it different from Grep and worth having beside it: "which file is
 * about caching" is a question about intent, and Grep answers questions about
 * text.
 */
export function searchPurpose(map: CodeMap, term: string, limit = 25): string {
  const needle = term.toLowerCase();
  const hits = map.files.filter(f =>
    f.purpose?.toLowerCase().includes(needle) || f.path.toLowerCase().includes(needle));
  if (hits.length === 0) return `No indexed file's purpose or path mentions "${term}".`;
  const rows = hits.slice(0, limit).map(describe);
  const truncated = hits.length > limit ? `\n… and ${hits.length - limit} more` : '';
  return `${hits.length} file(s) matching "${term}":\n${rows.join('\n')}${truncated}`;
}

function describe(file: FileEntry): string {
  const purpose = file.purpose ? `  —  ${file.purpose}` : '';
  const symbols = file.symbols.length > 0
    ? `\n      ${file.symbols.slice(0, 8).join(', ')}${file.symbols.length > 8 ? ', …' : ''}`
    : '';
  return `  ${file.path}${purpose}${symbols}`;
}

/** What the map is not covering, said out loud rather than left to be assumed. */
function note(map: CodeMap): string {
  const parts: string[] = [];
  if (map.skipped > 0) parts.push(`${map.skipped} files were too large or beyond the index limit`);
  if (map.unparsed > 0) parts.push(`${map.unparsed} had no readable declarations`);
  return parts.length > 0 ? `\n(${parts.join('; ')}.)` : '';
}
