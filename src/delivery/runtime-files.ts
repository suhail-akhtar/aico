/**
 * Files AICO itself writes inside a project that must never travel with a task.
 *
 * WHY. A task runs in its own worktree, and the engine and its tools write beside the
 * agent's work: the project profile the observer learns (`.aico/profile.json`), the
 * per-machine settings (`.aico/settings.local.json`), screenshots of a verified page, caches.
 * A run's `git add -A` (the agent's, or the engine's own commit at submit) swept them into
 * the task's branch, and the first real use showed what that costs: the person's checkout
 * had its own untracked `.aico/profile.json`, so landing the branch failed with "untracked
 * working tree files would be overwritten by merge" - an error about a file nobody chose to
 * change. Whatever the engine itself wrote is not the agent's change, so it is kept out at
 * three points: never staged by the engine's commit (`commitAll`'s exclude list), stripped from
 * the branch before it enters the queue and again before it lands (`scrubBranch`, which also
 * covers an agent that committed them itself), and never counted or shown in a task's diff.
 *
 * Deliberately only what is MACHINE-STATE. `.aico/settings.json`, skills, tools, agents, rules,
 * knowledge and `AICO.md` are files a team commits on purpose; a task that edits them is
 * making a real change and keeps it. The profile is the borderline case (the docs call it
 * "committable"): a person who wants to commit it does so from their checkout, not as a
 * side effect of an agent's run in a worktree.
 *
 * @module delivery/runtime-files
 */

import fs from 'node:fs';
import path from 'node:path';
import * as G from './git.js';

/** Paths below `.aico/` (at the repository root or inside a project folder) that are machine state. */
const RUNTIME: RegExp[] = [
  /(^|\/)\.aico\/profile\.json$/,
  /(^|\/)\.aico\/trust\.json$/,
  /(^|\/)\.aico\/[^/]*\.local\.[^/]+$/,
  /(^|\/)\.aico\/(screenshots|sessions|projects|cache|tmp)\//,
  /(^|\/)\.aico\/[^/]*\.(jsonl|log|lock|sqlite)$/,
];

/** The same set as git pathspecs (`:(exclude,glob)`), for `add`, `diff` and `status`. */
export const RUNTIME_EXCLUDES: readonly string[] = [
  ':(exclude,glob)**/.aico/profile.json',
  ':(exclude,glob)**/.aico/trust.json',
  ':(exclude,glob)**/.aico/*.local.*',
  ':(exclude,glob)**/.aico/screenshots/**',
  ':(exclude,glob)**/.aico/sessions/**',
  ':(exclude,glob)**/.aico/projects/**',
  ':(exclude,glob)**/.aico/cache/**',
  ':(exclude,glob)**/.aico/tmp/**',
  ':(exclude,glob)**/.aico/*.jsonl',
  ':(exclude,glob)**/.aico/*.log',
  ':(exclude,glob)**/.aico/*.lock',
  ':(exclude,glob)**/.aico/*.sqlite',
];

/** Whether a repository-relative path is AICO's own machine state. */
export function isRuntimePath(rel: string): boolean {
  const p = rel.replace(/\\/g, '/').replace(/^"|"$/g, '');
  return RUNTIME.some(re => re.test(p));
}

/**
 * Take the given paths out of the branch's net change against `base`: files the branch added are
 * removed from the tree, files it modified or deleted are put back as `base` has them. One commit,
 * so the history says what happened; the net diff against `base` then no longer mentions them.
 * Never throws: a failure is returned for the caller to report.
 */
export async function dropPaths(wt: string, base: string, paths: readonly string[], message: string): Promise<{ ok: boolean; dropped: string[]; error?: string }> {
  if (paths.length === 0) return { ok: true, dropped: [] };
  const status = new Map((await G.changedFiles(wt, base)).map(c => [c.path, c.status]));
  const dropped: string[] = [];
  for (const p of paths) {
    const st = status.get(p);
    if (!st) continue;
    // An added file is removed from the disk too: left behind untracked it would collide with the very commit that added it
    // when the branch is replayed onto a moved trunk (found in the live run: "untracked working tree files would be overwritten").
    const r = st === 'A'
      ? await G.git(['rm', '-q', '-f', '--', p], wt)
      : await G.git(['checkout', base, '--', p], wt);
    if (!r.ok) return { ok: false, dropped, error: (r.err || r.out).trim().slice(0, 300) };
    dropped.push(p);
  }
  if (dropped.length === 0) return { ok: true, dropped };
  const c = await G.git(['commit', '-q', '-m', message], wt);
  if (!c.ok) return { ok: false, dropped: [], error: (c.err || c.out).trim().slice(0, 300) };
  return { ok: true, dropped };
}

/**
 * Delete AICO's runtime files that lie untracked in a task's worktree. They are machine state in a disposable
 * directory (the observer rewrites the profile whenever a command teaches it something), and a rebase that replays
 * a commit which added one of them stops at "untracked working tree files would be overwritten" if a different copy
 * is on disk. Tracked files are left alone; ignored ones cannot block a replay.
 */
export async function clearUntrackedRuntime(wt: string): Promise<string[]> {
  const r = await G.git(['ls-files', '--others', '--exclude-standard', '-z'], wt);
  if (!r.ok) return [];
  const gone: string[] = [];
  for (const rel of r.out.split('\0').filter(Boolean)) {
    if (!isRuntimePath(rel)) continue;
    try { fs.rmSync(path.join(wt, rel), { force: true }); gone.push(rel); } catch { /* busy: the replay will say so */ }
  }
  return gone;
}

/**
 * Strip AICO's runtime files from a task's branch. `trunk` is the trunk branch name. Returns the
 * paths removed from the branch's net change (empty: the branch was already clean, nothing was committed).
 */
export async function scrubBranch(wt: string, trunk: string, taskId: string): Promise<{ removed: string[]; error?: string }> {
  await clearUntrackedRuntime(wt);
  const base = await G.mergeBase(wt, G.headRef(trunk), 'HEAD');
  if (!base) return { removed: [] };
  const touched = (await G.changedFiles(wt, base)).map(c => c.path).filter(isRuntimePath);
  if (touched.length === 0) return { removed: [] };
  const r = await dropPaths(wt, base, touched, `chore: leave AICO's own runtime files out of task ${taskId}`);
  return r.ok ? { removed: r.dropped } : { removed: [], error: r.error ?? 'could not remove them' };
}
