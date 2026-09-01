/**
 * Comparing folder paths, in a webview.
 *
 * A browser-safe twin of the extension host's `src/paths.ts`. It cannot share
 * that module because that one uses Node's `path`, and it cannot skip the
 * problem because the panel compares paths in two places that both matter: the
 * project it selects at boot, and the sessions it lists.
 *
 * The problem being solved is measured, not theoretical. VS Code reports Windows
 * paths with a lowercase drive letter (`e:\work`), while aico's registry — fed
 * by terminals and by `path.resolve` — holds `E:\work`. Compared exactly, one
 * folder becomes two: a duplicate project row, and a session list that hides
 * every conversation started outside the editor.
 *
 * @module paths
 */

/**
 * Whether two paths name the same folder.
 *
 * Case is ignored only when the path looks like Windows — a drive letter, or a
 * backslash. On a case-sensitive filesystem `~/Work` and `~/work` really are two
 * directories, and folding them together would be a worse bug than the one this
 * fixes.
 */
export function sameFolder(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const windows = looksLikeWindows(a) || looksLikeWindows(b);
  return clean(a, windows) === clean(b, windows);
}

function looksLikeWindows(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.includes('\\');
}

function clean(p: string, windows: boolean): string {
  // Separators unified and any trailing one dropped: `C:\work` and `C:\work\`
  // are the same directory to everyone except a string comparison.
  const normalised = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return windows ? normalised.toLowerCase() : normalised;
}
