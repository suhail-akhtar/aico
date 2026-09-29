/**
 * Path identity for projects, without React: see `lib/projects` for why.
 *
 * @module desktop/renderer/lib/project-paths
 */

const WINDOWS_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

/** A comparison key: separators unified, trailing ones dropped, case folded for Windows paths. */
export function pathKey(p: string): string {
  const unified = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return WINDOWS_PATH.test(p) ? unified.toLowerCase() : unified;
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b) && pathKey(a!) === pathKey(b!);
}

/**
 * The list with each folder once. The spelling kept is the one that exists
 * and, between two that do, the one with the upper-case drive letter — what
 * Explorer and every Windows dialog show.
 */
export function uniqueProjects<T extends { path: string; exists?: boolean }>(list: T[]): T[] {
  const byKey = new Map<string, T>();
  const order: string[] = [];
  for (const p of list) {
    const k = pathKey(p.path);
    const seen = byKey.get(k);
    if (!seen) { byKey.set(k, p); order.push(k); continue; }
    const better = (p.exists !== false && seen.exists === false) || (p.exists === seen.exists && /^[A-Z]:/.test(p.path) && !/^[A-Z]:/.test(seen.path));
    if (better) byKey.set(k, p);
  }
  return order.map(k => byKey.get(k)!);
}
