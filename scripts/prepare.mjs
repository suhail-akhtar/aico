/**
 * Build on install, but only when there is something to build.
 *
 * npm runs `prepare` in two very different situations and they need opposite
 * behaviour:
 *
 *   - **Installed from a git ref** (`npx github:owner/repo#tag`). The clone has
 *     `src/` and no `dist/`, because `dist/` is not committed. The build has to
 *     run, and if it fails the install must fail — a package with no
 *     `dist/index.js` is not a working install, it is a confusing one.
 *   - **Installed from a published tarball.** `dist/` is already there and
 *     `src/` is not, because `files` does not ship it. There is nothing to
 *     build and nothing to fail.
 *
 * This used to be one shell line ending in `|| exit 0`, which handled the
 * second case by making *every* failure succeed. A genuine build error was
 * therefore reported as a successful install, and the first sign of trouble was
 * `Cannot find module dist/index.js` from a user who had no idea a build had
 * even been attempted. Since installing from a git ref is now the only way
 * anyone gets this, that is the one path that must not fail quietly.
 */

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(path.join(root, 'src'))) {
  // A published tarball. Already built, nothing to do.
  process.exit(0);
}

/** Run one step, and stop the install if it fails. */
function step(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    // npm and npx are batch files on Windows and are not executable directly.
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(
      `\naico: ${label} failed (exit ${result.status ?? 'signal ' + result.signal}).\n`
      + 'The package is not usable without it, so the install is stopping here\n'
      + 'rather than leaving you with a missing dist/index.js.\n',
    );
    process.exit(result.status || 1);
  }
}

step('installing web dependencies', 'npm', ['--prefix', 'web', 'install', '--no-audit', '--no-fund']);
step('building the CLI', 'npm', ['run', 'build']);
step('building the web client', 'npm', ['run', 'build:web']);
