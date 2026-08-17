/**
 * Path containment.
 *
 * This is the part where being subtly wrong is worse than being absent, so the
 * reasoning is spelled out rather than left in the code.
 *
 * ## Canonicalize with filesystem semantics BEFORE comparing
 *
 * `path.resolve('/work/link/..')` removes `link` lexically. If `link` is a
 * symlink to `/etc`, the real parent is `/`, not `/work` — so a purely lexical
 * check would place the path inside the workspace when the write actually lands
 * outside it. Every path is therefore resolved through `realpath` first.
 *
 * ## Canonicalize what exists, keep what does not
 *
 * A write target usually does not exist yet, and `realpath` fails on a missing
 * path. So the deepest existing ancestor is canonicalized and the remaining
 * segments are appended. That resolves any link on the way down while still
 * producing an answer for a file about to be created.
 *
 * ## Compare with `path.relative`, never `startsWith`
 *
 * `'/work/project-evil'.startsWith('/work/project')` is true, and that is a
 * containment bypass. `path.relative` gives `../project-evil`, which is
 * correctly outside. It also handles a different Windows drive by returning an
 * absolute path, and compares case-insensitively on win32.
 *
 * @module sandbox/path-policy
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Resolve a path to its canonical absolute form.
 *
 * Symlinks and Windows junctions are resolved as far down as the path exists;
 * the remainder is appended verbatim.
 *
 * @throws when the path contains a NUL byte, which some filesystem APIs treat
 *   as a terminator — a classic way to smuggle a different path past a check.
 */
export function canonicalize(input: string): string {
  if (input.includes('\0')) {
    throw new Error('path contains a NUL byte');
  }

  const absolute = path.resolve(input);
  const missing: string[] = [];
  let current = absolute;

  // Walk up until something exists, remembering what was skipped.
  for (;;) {
    try {
      // `realpathSync.native` returns the OS's canonical casing on Windows,
      // which matters because two spellings of one path must compare equal.
      const real = fs.realpathSync.native(current);
      return missing.length === 0
        ? real
        : path.join(real, ...missing.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists;
      // the lexically resolved path is the best answer available.
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `child` is `root` or lies beneath it.
 *
 * Both arguments must already be canonical — comparing a canonical root with a
 * non-canonical child is how containment checks are usually defeated.
 */
export function isWithin(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  if (relative === '') return true;
  // A different drive (or an otherwise unrelatable path) yields an absolute
  // result rather than a `..` chain.
  if (path.isAbsolute(relative)) return false;
  if (relative === '..') return false;
  if (relative.startsWith(`..${path.sep}`)) return false;
  return true;
}

/** Name of the scratch directory granted under `workspace-write`. */
export const SANDBOX_TEMP_DIRNAME = 'aico-sandbox';

/**
 * The scratch directory writes are permitted to touch under `workspace-write`.
 *
 * A temp area is granted because build tools, compilers and test runners write
 * to one as a matter of course; a policy that refused would be unusable and
 * would simply be switched off, which protects nothing.
 *
 * But it is a **dedicated subdirectory**, not the shared system temp root.
 * Granting all of `os.tmpdir()` would let a confined agent overwrite any other
 * process's temp files — an escape that is easy to miss precisely because the
 * grant looks innocuous. Narrow scratch space costs nothing and closes it.
 */
export function temporaryRoot(): string {
  const dedicated = path.join(os.tmpdir(), SANDBOX_TEMP_DIRNAME);
  try {
    fs.mkdirSync(dedicated, { recursive: true });
  } catch {
    // Creation failure is not fatal — the path still resolves, and a write into
    // a directory that does not exist fails on its own terms.
  }
  try {
    return canonicalize(dedicated);
  } catch {
    return path.resolve(dedicated);
  }
}
