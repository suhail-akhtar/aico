/**
 * Files in the way of a landing, and what to do about each.
 *
 * WHY. Landing a task is a fast-forward of the trunk checked out in the person's own folder,
 * and that folder is a working place: it has files git does not track yet (notes, a generated
 * profile, a half-written config) and edits not committed yet. When the branch also writes one
 * of those paths git refuses the merge with a message about "untracked working tree files",
 * which is correct and of no use to a person clicking Approve. The first real use hit it (the
 * branch had committed AICO's own `.aico/profile.json`). Here the refusal is turned into a
 * decision:
 *
 *  - a path whose content is IDENTICAL to what the branch brings is not in the way: the merge
 *    would write the same bytes, so the copy is set aside and the landing goes on;
 *  - a path that is AICO's own machine state (`runtime-files.ts`) is set aside too - it is
 *    never the person's work, and the branch should not have carried it;
 *  - anything else is the person's work and differs from the task's: the landing stops, names
 *    the files, and offers exactly two ways forward - keep yours (the task's change to those
 *    paths is dropped from the branch) or take the task's (yours is saved aside first).
 *
 * "Set aside" is never deletion: the file is copied under the board's own folder
 * (`aicoHome()/delivery/<project key>/displaced/<task>/...`) before it is removed from the
 * checkout, so no choice here can lose a byte of the person's work.
 *
 * Only a checkout that has the trunk checked out can collide; moving the ref of a trunk that
 * is checked out nowhere touches no working files (git.ts `fastForward`).
 *
 * @module delivery/landing
 */

import fs from 'node:fs';
import path from 'node:path';
import * as G from './git.js';
import { isRuntimePath } from './runtime-files.js';
import { boardDir } from './store.js';

export interface Collision {
  path: string;
  /** `untracked`: a file git does not track is where the branch adds one. `modified`: a tracked file with uncommitted edits that the branch also changes. */
  why: 'untracked' | 'modified';
  /** The checkout's copy has exactly the content the branch would write. */
  identical: boolean;
  /** AICO's own machine state. */
  runtime: boolean;
}

/** Porcelain v1 with NUL separators: `XY path`. Renames carry a second path that is skipped. */
function parseStatus(out: string): Array<{ xy: string; path: string }> {
  const parts = out.split('\0');
  const res: Array<{ xy: string; path: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    res.push({ xy, path: e.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return res;
}

/**
 * The paths a fast-forward of `branch` into the checked-out trunk would overwrite or refuse over.
 * Empty when the trunk is not the checked-out branch of `repo` (nothing in the working tree moves).
 */
export async function findCollisions(repo: string, trunk: string, branch: string): Promise<Collision[]> {
  if ((await G.currentBranch(repo)) !== trunk) return [];
  const changed = await G.git(['diff', '--name-status', '--no-renames', '-z', 'HEAD', branch], repo);
  if (!changed.ok) return [];
  const toks = changed.out.split('\0').filter(Boolean);
  const branchChanges = new Map<string, string>();
  for (let i = 0; i + 1 < toks.length; i += 2) branchChanges.set(toks[i + 1]!, toks[i]!);
  if (branchChanges.size === 0) return [];
  const status = await G.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repo);
  if (!status.ok) return [];
  const out: Collision[] = [];
  for (const s of parseStatus(status.out)) {
    const change = branchChanges.get(s.path);
    if (!change) continue;
    const untracked = s.xy === '??';
    if (!untracked && /^!!/.test(s.xy)) continue;
    // An untracked file only matters where the branch ADDS a file; a tracked edit matters where the branch changes that file at all.
    if (untracked && change !== 'A') continue;
    let identical = false;
    if (change !== 'D') {
      const theirs = await G.git(['show', `${branch}:${s.path}`], repo);
      try { identical = theirs.ok && fs.readFileSync(path.join(repo, s.path), 'utf8') === theirs.out; } catch { identical = false; }
    }
    out.push({ path: s.path, why: untracked ? 'untracked' : 'modified', identical, runtime: isRuntimePath(s.path) });
  }
  return out;
}

/** Where a displaced copy goes: under the board's own folder, one folder per task and moment. */
export function displacedDir(project: string, taskId: string, stamp: string): string {
  return path.join(boardDir(project), 'displaced', taskId, stamp.replace(/[:.]/g, '-'));
}

/**
 * Copy the checkout's version of each path aside, then put the checkout back as the trunk has it
 * (untracked: the file is removed; modified: restored from HEAD). Returns where the copies are.
 */
export async function setAside(repo: string, paths: readonly string[], dest: string): Promise<{ ok: boolean; saved: string; error?: string }> {
  for (const rel of paths) {
    const from = path.join(repo, rel);
    const to = path.join(dest, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.existsSync(from)) fs.copyFileSync(from, to);
    } catch (e) {
      return { ok: false, saved: dest, error: `could not save a copy of ${rel} first: ${(e as Error).message}` };
    }
  }
  const tracked = (await G.git(['ls-files', '-z', '--', ...paths], repo)).out.split('\0').filter(Boolean);
  const trackedSet = new Set(tracked);
  for (const rel of paths) {
    if (trackedSet.has(rel)) {
      const r = await G.git(['checkout', 'HEAD', '--', rel], repo);
      if (!r.ok) return { ok: false, saved: dest, error: (r.err || r.out).trim().slice(0, 300) };
    } else {
      try { fs.rmSync(path.join(repo, rel), { force: true }); } catch (e) { return { ok: false, saved: dest, error: (e as Error).message }; }
    }
  }
  return { ok: true, saved: dest };
}
