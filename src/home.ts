/**
 * Where aico keeps everything that is not in a project: settings, sessions,
 * skills, memories, the work ledger, the codemap cache.
 *
 * One function rather than twenty `path.join(os.homedir(), '.aico')` calls,
 * because the twenty could not be moved. The test harness and every live
 * probe wrote their sessions into the reader's real store — over a thousand
 * project folders under temp paths, all of them showing in the sidebar as
 * recent sessions — and the only way to point them elsewhere was to override
 * the user's home directory for the whole process, which VS Code and npm read
 * too.
 *
 * `AICO_HOME` moves the store. It is read at call time, not at load time, so a
 * process can decide where its store is before touching it, and a module that
 * is imported early does not freeze the answer.
 *
 * @module home
 */

import path from 'path';
import os from 'os';

/** The store directory: `$AICO_HOME` when set, else `~/.aico`. */
export function aicoHome(): string {
  const override = process.env.AICO_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.aico');
}
