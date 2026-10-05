/**
 * Project-relative paths: one spelling (forward slashes), and lookups that
 * fold case only where the file system does.
 *
 * The lesson this is built on is another indexer's Windows bug: it lowered the
 * case of file nodes but not of symbol nodes, so every lookup of a
 * `components/Button.tsx` silently returned nothing. Here a path is stored
 * exactly as the file system spells it, and only the *lookup key* is folded —
 * on Windows and macOS, never on Linux, where `Config.ts` and `config.ts` are
 * two files.
 *
 * @module codegraph/paths
 */

export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

export function keyOf(rel: string): string {
  return CASE_INSENSITIVE_FS ? rel.toLowerCase() : rel;
}

/** Normalise a relative posix path (`a/./b/../c` → `a/c`); undefined if it escapes the root. */
export function normRel(p: string): string | undefined {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export function joinRel(dir: string, rel: string): string | undefined {
  return normRel(dir ? `${dir}/${rel}` : rel);
}

export function baseOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

export function stemOf(rel: string): string {
  const b = baseOf(rel);
  const d = b.indexOf('.');
  return d <= 0 ? b : b.slice(0, d);
}
