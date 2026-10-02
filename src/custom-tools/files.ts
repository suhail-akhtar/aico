/**
 * Finding custom tool files on disk: `<dir>/<pack>/<name>.tool.json`.
 *
 * Its own module because two things must read the same set the same way —
 * the tool store, and project trust (workspace-trust.ts), which hashes a
 * project's tool files into what a person approves. If they listed files
 * differently, a tool could load that the person was never shown.
 *
 * @module custom-tools/files
 */

import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { PACK_RE } from './format.js';

export const TOOL_FILE_SUFFIX = '.tool.json';

/** Tool files in one store, sorted by pack then file; packs that break the name rules are skipped. */
export function toolFilesIn(dir: string): Array<{ pack: string; file: string }> {
  const out: Array<{ pack: string; file: string }> = [];
  let packs: fs.Dirent[];
  try { packs = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const pack of packs.filter(d => d.isDirectory() && PACK_RE.test(d.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    let files: string[];
    try { files = fs.readdirSync(path.join(dir, pack.name)); } catch { continue; }
    for (const f of files.filter(f => f.endsWith(TOOL_FILE_SUFFIX)).sort()) out.push({ pack: pack.name, file: path.join(dir, pack.name, f) });
  }
  return out;
}

/** A project's own tool store. */
export function projectToolsDir(root: string): string {
  return path.join(root, '.aico', 'tools');
}

/**
 * A project's tool files — none when its `.aico` *is* the user's store.
 *
 * Run from the home directory, `<cwd>/.aico/tools` is `~/.aico/tools`: the
 * same files would load twice (as duplicates) and the person's own tools
 * would be put behind a project-trust prompt. Found by starting a server
 * in the folder that holds its store.
 */
export function projectToolFilesIn(root: string): Array<{ pack: string; file: string }> {
  // The real path, not the spelled one: on Windows a cwd may arrive as an 8.3
  // short name (C:\Users\SUHAIL~1\…) while the store is spelled in full.
  const norm = (p: string): string => {
    let real = path.resolve(p);
    try { real = fs.realpathSync.native(real); } catch { /* missing: compare as spelled */ }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  if (norm(projectToolsDir(root)) === norm(path.join(aicoHome(), 'tools'))) return [];
  return toolFilesIn(projectToolsDir(root));
}
