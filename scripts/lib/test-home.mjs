/**
 * A store of aico's own for the process that imports this.
 *
 * Import it first, before anything from `dist` or `dist-test`, and everything
 * that would have gone to `~/.aico` — sessions, the work ledger, skills a test
 * registers, a context window a test records — goes to a directory under the
 * system temp folder instead, and is removed when the process exits.
 *
 * Why this exists: every test and probe used to write into the reader's real
 * store. After a few weeks of running them there were over a thousand
 * project folders in it named after temp directories, each one a "recent
 * session" in the sidebar, and a discipline of "leave settings.json as you
 * found it" that every suite had to remember separately. Now none of them
 * can reach it.
 *
 * The real `settings.json` is *copied* in, read-only from the reader's point
 * of view, because the live suites need the provider keys in it. Nothing else
 * is copied: a fresh store is the point.
 *
 * Children inherit it: `spawn` with `{ ...process.env }` carries `AICO_HOME`
 * to a server started by a probe, and to the editor started by the VS Code
 * probe, and to the server that editor starts in turn.
 *
 * Set `AICO_KEEP_TEST_HOME=1` to keep the directory for a look afterwards; the
 * path is printed either way.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const realHome = path.join(os.homedir(), '.aico');
const label = path.basename(process.argv[1] ?? 'test', '.mjs').replace(/[^a-z0-9-]/gi, '') || 'test';
const parent = fs.mkdtempSync(path.join(os.tmpdir(), `aico-${label}-home-`));
// Named `.aico` so anything that asserts on the store's name still holds.
const home = path.join(parent, '.aico');
fs.mkdirSync(home, { recursive: true });

try {
  fs.copyFileSync(path.join(realHome, 'settings.json'), path.join(home, 'settings.json'));
} catch {
  // No real settings — the store starts empty, which is also fine.
}

process.env.AICO_HOME = home;

/** Where this process's store is. */
export const testHome = home;

function cleanup() {
  if (process.env.AICO_KEEP_TEST_HOME) {
    console.log(`  (test store kept at ${home})`);
    return;
  }
  try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', cleanup);
