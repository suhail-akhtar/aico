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

/*
  Re-entrancy guard, and the reason it is needed.

  `npm install -g github:suhail-akhtar/aico#v0.9.0` recursed six levels deep
  and failed. The outer global install exports `npm_config_global=true` into
  every lifecycle script's environment; the web-dependency step below runs
  `npm --prefix web install`, which inherits it — and a *global* install with no
  package named installs the current directory. The current directory is this
  clone, so npm prepared it again, which ran this script again, which ran npm
  again. `npx github:` sets different config and never hit it, which is why the
  README's headline path worked while the one a VS Code user needs did not.

  Two defences, because each alone leaves a way back in: the marker stops any
  nested run dead, and the scrubbed environment stops the nesting from starting.
*/
if (process.env.AICO_PREPARING === '1') {
  process.exit(0);
}
const childEnv = { ...process.env, AICO_PREPARING: '1' };
for (const key of Object.keys(childEnv)) {
  // Everything npm derived from the *outer* command line: global, prefix,
  // location, and the `-g` shorthand's other spellings. A child npm must read
  // its own arguments, not ours.
  if (/^npm_config_(global|prefix|location|globalconfig|userconfig)$/i.test(key)) delete childEnv[key];
}

/** Run one step, and stop the install if it fails. */
function step(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: childEnv,
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

step('installing web dependencies', 'npm', ['--prefix', 'web', 'install', '--no-global', '--no-audit', '--no-fund']);
step('building the CLI', 'npm', ['run', 'build']);
step('building the web client', 'npm', ['run', 'build:web']);
