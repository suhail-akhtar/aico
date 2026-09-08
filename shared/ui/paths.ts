/**
 * Paths as a reader wants them: relative to the thing they are working on.
 *
 * Tool rows and the turn summary print what the tool was given, and what the
 * tool was given is absolute — on Windows, sixty characters of temp directory
 * before the part that says anything. A row that reads "Read C:\Users\…\w…
 * 41 lines" tells nobody which file was read.
 *
 * Two rules, in order: strip a known root (the project directory the portal is
 * showing); failing that, strip everything up to and including an app's
 * `miniapps/<slug>/` segment, since a bound conversation is about that app and
 * every path in it starts the same way. Anything else is left alone — a path
 * outside both is worth seeing in full.
 */

let roots: string[] = [];

/** Directories that count as "here". Set by the host when the project changes. */
export function setPathRoots(next: readonly string[]): void {
  roots = next.filter(Boolean).map(normalise);
}

function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function shortenPath(p: string): string {
  if (typeof p !== 'string' || !p) return p;
  const norm = normalise(p);
  const lower = norm.toLowerCase();
  let best = '';
  for (const root of roots) {
    const r = root.toLowerCase();
    if (r.length > best.length && (lower === r || lower.startsWith(`${r}/`))) best = root;
  }
  if (best) return norm.length === best.length ? '.' : norm.slice(best.length + 1);
  const app = /\/miniapps\/[^/]+\/(.+)$/.exec(norm);
  if (app) return app[1]!;
  return p;
}
