/**
 * One spelling for one folder.
 *
 * VS Code hands out Windows paths with a **lowercase drive letter**:
 * `Uri.fsPath` for `E:\work\thing` is `e:\work\thing`. Nothing else on Windows
 * does that — Node's `path.resolve`, the shell, and `process.cwd()` all produce
 * `E:\`. aico's project registry compares paths as strings, so the two spellings
 * are two projects.
 *
 * That is not cosmetic. It was measured against a running server, whose project
 * list had `E:\github_repos\AI-Projects\aico` from a terminal sitting directly
 * above `e:\tmp\vsdiag3\ws` from the extension. The consequences all look like
 * "the folder was not picked up properly":
 *
 * - a duplicate project row appears for a directory already registered;
 * - sessions started from the terminal do not appear in the panel's list,
 *   because it filters by an exactly-matching project path;
 * - the same repository behaves as two places depending on how it was opened.
 *
 * So every path leaving this extension goes through here first. The extension is
 * where the odd spelling is introduced, which makes it the right place to fix —
 * normalising inside the server would have to reinterpret paths already written
 * into session logs.
 *
 * @module paths
 */

import * as path from 'path';

/**
 * The canonical spelling of a folder, as the rest of the platform writes it.
 *
 * Case is corrected only for the drive letter. The rest of a Windows path is
 * case-insensitive but *case-preserving*, and lowercasing it would replace one
 * cosmetic mismatch with an unreadable one.
 */
export function canonicalFolder(fsPath: string): string {
  const normalised = path.normalize(fsPath);
  if (process.platform !== 'win32') return normalised;
  return normalised.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

/**
 * Whether two paths name the same folder.
 *
 * Case-insensitive on Windows because the filesystem is, and a trailing
 * separator is ignored because `C:\work` and `C:\work\` are the same directory
 * to everyone except a string comparison.
 */
export function sameFolder(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const clean = (p: string): string => {
    const normalised = path.normalize(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalised.toLowerCase() : normalised;
  };
  return clean(a) === clean(b);
}
