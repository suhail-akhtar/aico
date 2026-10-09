/**
 * The few git operations delivery needs, each naming the directory it runs in.
 *
 * WHY NOT `src/worktree`. That manager makes branches named
 * `aico/worktree/<agent>-<n>` for blocking sub-agents and finishes them by
 * committing whatever is left; delivery's branches are `aico/task-<id>`, the
 * task owns the branch's lifetime (it is removed on merge or cancel, not when
 * an agent ends), and landing is a decision, not a cleanup. The rules are the
 * same ones that module records — `execFile` with an argument array (paths
 * contain spaces), git always told where the repository is, work never
 * discarded — and this file keeps them, with no overlap in what it creates.
 *
 * Never pushes. There is no `push`, `fetch` or `remote` call in this module
 * on purpose (ADR 0038: checkpoints stay local); the test suite asserts it.
 *
 * @module delivery/git
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitResult { ok: boolean; code: number; out: string; err: string }

const TIMEOUT_MS = 120_000;

/** Run git in `cwd`. Never throws: a failure is a result the caller reads. */
export function git(args: readonly string[], cwd: string, timeout = TIMEOUT_MS): Promise<GitResult> {
  return new Promise(resolve => {
    execFile('git', [...args], {
      cwd, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
      // No prompt, no editor: an unattended rebase must fail, not wait for a person at a terminal.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ ok: !error, code, out: String(stdout), err: String(stderr || (error && error.message) || '') });
    });
  });
}

const lines = (s: string): string[] => s.split('\n').map(l => l.trim()).filter(Boolean);

export async function repoRootOf(dir: string): Promise<string | undefined> {
  const r = await git(['rev-parse', '--show-toplevel'], dir);
  return r.ok ? path.resolve(r.out.trim()) : undefined;
}

export async function currentBranch(dir: string): Promise<string | undefined> {
  const r = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir);
  return r.ok ? r.out.trim() : undefined;
}

export async function revParse(dir: string, ref: string): Promise<string | undefined> {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], dir);
  return r.ok ? r.out.trim() : undefined;
}

export async function treeOf(dir: string, ref = 'HEAD'): Promise<string | undefined> {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], dir);
  return r.ok ? r.out.trim() : undefined;
}

export async function porcelain(dir: string): Promise<string[]> {
  const r = await git(['status', '--porcelain'], dir);
  return r.ok ? r.out.split('\n').filter(l => l.trim()) : [];
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)).ok;
}

/** `git worktree add -b <branch> <path> <start>` (or checkout of an existing branch). */
export async function worktreeAdd(repo: string, wt: string, branch: string, start: string): Promise<GitResult> {
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  if (await branchExists(repo, branch)) return git(['worktree', 'add', wt, branch], repo);
  return git(['worktree', 'add', '-b', branch, wt, start], repo);
}

export async function worktreeRemove(repo: string, wt: string, force = false): Promise<GitResult> {
  return git(['worktree', 'remove', ...(force ? ['--force'] : []), wt], repo);
}

export async function worktreePrune(repo: string): Promise<void> { await git(['worktree', 'prune'], repo); }

/** Linked worktrees of a repository: path and branch (when on one). */
export async function worktreeList(repo: string): Promise<Array<{ path: string; branch?: string }>> {
  const r = await git(['worktree', 'list', '--porcelain'], repo);
  if (!r.ok) return [];
  const out: Array<{ path: string; branch?: string }> = [];
  let cur: { path: string; branch?: string } | undefined;
  for (const l of r.out.split('\n')) {
    if (l.startsWith('worktree ')) { cur = { path: path.resolve(l.slice(9).trim()) }; out.push(cur); }
    else if (l.startsWith('branch ') && cur) cur.branch = l.slice(7).trim().replace(/^refs\/heads\//, '');
  }
  return out;
}

export async function branchDelete(repo: string, branch: string, force = false): Promise<GitResult> {
  return git(['branch', force ? '-D' : '-d', branch], repo);
}

export async function mergeBase(dir: string, a: string, b: string): Promise<string | undefined> {
  const r = await git(['merge-base', a, b], dir);
  return r.ok ? r.out.trim() : undefined;
}

export async function aheadCount(dir: string, base: string): Promise<number> {
  const r = await git(['rev-list', '--count', `${base}..HEAD`], dir);
  return r.ok ? Number(r.out.trim()) || 0 : 0;
}

/** Files changed between `base` and HEAD, with the status letter (A/M/D/R). */
export async function changedFiles(dir: string, base: string): Promise<Array<{ status: string; path: string }>> {
  const r = await git(['diff', '--name-status', '--no-renames', base, 'HEAD'], dir);
  if (!r.ok) return [];
  return lines(r.out).map(l => { const [status, ...rest] = l.split('\t'); return { status: status ?? 'M', path: rest.join('\t') }; });
}

export async function diffText(dir: string, base: string, maxBytes = 1_500_000): Promise<string> {
  const r = await git(['diff', '--no-color', '--no-renames', base, 'HEAD'], dir);
  const text = r.ok ? r.out : '';
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n[… diff truncated at ${maxBytes} bytes]` : text;
}

export async function showFile(dir: string, ref: string, rel: string): Promise<string | null> {
  const r = await git(['show', `${ref}:${rel}`], dir);
  return r.ok ? r.out : null;
}

export interface RebaseResult { ok: boolean; conflicts: string[]; message: string }

/** Rebase the worktree's branch onto `onto`. On conflict: the files, then the rebase is aborted (nothing half-applied is left). */
export async function rebaseOnto(dir: string, onto: string): Promise<RebaseResult> {
  const r = await git(['rebase', onto], dir);
  if (r.ok) return { ok: true, conflicts: [], message: '' };
  const u = await git(['diff', '--name-only', '--diff-filter=U'], dir);
  const conflicts = lines(u.out);
  await git(['rebase', '--abort'], dir);
  return { ok: false, conflicts, message: (r.err || r.out).trim().slice(0, 600) };
}

/** Stage everything except credential-looking paths and commit. Returns false when there was nothing to commit or git refused. */
export async function commitAll(dir: string, message: string, isSecretPath: (p: string) => boolean): Promise<{ committed: boolean; kept: string[]; error?: string }> {
  if ((await porcelain(dir)).length === 0) return { committed: false, kept: [] };
  const add = await git(['add', '-A'], dir);
  if (!add.ok) return { committed: false, kept: [], error: add.err.trim().slice(0, 300) };
  const staged = lines((await git(['diff', '--cached', '--name-only'], dir)).out);
  const secrets = staged.filter(isSecretPath);
  if (secrets.length > 0) await git(['reset', '-q', '--', ...secrets], dir);
  if (staged.length === secrets.length) return { committed: false, kept: secrets };
  const c = await git(['commit', '-m', message], dir);
  if (!c.ok) return { committed: false, kept: secrets, error: (c.err || c.out).trim().slice(0, 300) };
  return { committed: true, kept: secrets };
}

/** Land `branch` on `trunk` by fast-forward only. Works whether or not the trunk is checked out in `repo`. */
export async function fastForward(repo: string, trunk: string, branch: string): Promise<{ ok: boolean; message: string; sha?: string }> {
  const target = await revParse(repo, branch);
  if (!target) return { ok: false, message: `branch ${branch} does not exist` };
  const here = await currentBranch(repo);
  if (here === trunk) {
    const r = await git(['merge', '--ff-only', branch], repo);
    return r.ok ? { ok: true, message: '', sha: target } : { ok: false, message: (r.err || r.out).trim().slice(0, 600) };
  }
  // The trunk is not checked out here: move the ref, but only forward (the old value is the guard).
  // ...and not in another worktree either: moving a checked-out branch's ref would leave that checkout behind it.
  const holder = (await worktreeList(repo)).find(w => w.branch === trunk);
  if (holder) return { ok: false, message: `${trunk} is checked out in ${holder.path}; land from a checkout of it there` };
  const old = await revParse(repo, trunk);
  if (!old) return { ok: false, message: `trunk branch ${trunk} does not exist` };
  const anc = await git(['merge-base', '--is-ancestor', old, target], repo);
  if (!anc.ok) return { ok: false, message: `${branch} is not a fast-forward of ${trunk}` };
  const r = await git(['update-ref', `refs/heads/${trunk}`, target, old], repo);
  return r.ok ? { ok: true, message: '', sha: target } : { ok: false, message: (r.err || r.out).trim().slice(0, 600) };
}

/** Add `/node_modules` to the repository's local exclude (one line, once): a linked node_modules is a link, which `node_modules/` does not match. */
export async function excludeLocally(repo: string, pattern: string): Promise<void> {
  const r = await git(['rev-parse', '--git-path', 'info/exclude'], repo);
  if (!r.ok) return;
  const file = path.resolve(repo, r.out.trim());
  try {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur.split('\n').some(l => l.trim() === pattern)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${pattern}\n`, 'utf8');
  } catch { /* best effort: the worst case is node_modules shown as untracked */ }
}

// ── releases, rollback and maintenance (ADR 0038) ─────────────────────────

/** Whether `a` is an ancestor of (or the same commit as) `b`. */
export async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  return (await git(['merge-base', '--is-ancestor', a, b], repo)).ok;
}

/** Tags reachable from `ref`, newest version first (git's own version sort). */
export async function tagsMerged(repo: string, ref: string, pattern = 'v*'): Promise<string[]> {
  const r = await git(['tag', '--merged', ref, '--list', pattern, '--sort=-v:refname'], repo);
  return r.ok ? lines(r.out) : [];
}

export async function tagExists(repo: string, tag: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], repo)).ok;
}

/** An annotated tag at `commit`. The message is the release notes; the tagger is the repository's configured identity. */
export async function tagCreate(repo: string, tag: string, commit: string, message: string): Promise<GitResult> {
  return git(['tag', '-a', tag, '-m', message, commit], repo);
}

export async function tagDelete(repo: string, tag: string): Promise<GitResult> {
  return git(['tag', '-d', tag], repo);
}

export interface LogEntry { sha: string; subject: string; body: string }

/** Commits in a range, oldest first. `range` is a git revision range ("v1.0.0..main"). */
export async function logRange(repo: string, range: string, max = 1000): Promise<LogEntry[]> {
  const r = await git(['log', '--reverse', `--max-count=${max}`, '--format=%H%x1f%s%x1f%b%x1e', range], repo);
  if (!r.ok) return [];
  return r.out.split('\x1e').map(c => c.replace(/^\n+/, '')).filter(c => c.trim()).map(c => {
    const [sha = '', subject = '', body = ''] = c.split('\x1f');
    return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
  });
}

/** Commit shas in a range, oldest first. */
export async function revList(repo: string, range: string): Promise<string[]> {
  const r = await git(['rev-list', '--reverse', '--no-merges', range], repo);
  return r.ok ? lines(r.out) : [];
}

/** `git revert --no-edit` for commits (given newest first). On a conflict: the files, and the revert is aborted. */
export async function revertCommits(dir: string, shas: readonly string[]): Promise<{ ok: boolean; conflicts: string[]; message: string }> {
  for (const sha of shas) {
    const r = await git(['revert', '--no-edit', sha], dir);
    if (!r.ok) {
      const conflicts = lines((await git(['diff', '--name-only', '--diff-filter=U'], dir)).out);
      await git(['revert', '--abort'], dir);
      return { ok: false, conflicts, message: (r.err || r.out).trim().slice(0, 600) };
    }
  }
  return { ok: true, conflicts: [], message: '' };
}

/** Housekeeping git does itself when it decides it is due; cheap when it is not. Never throws. */
export async function gcAuto(repo: string): Promise<void> { await git(['gc', '--auto', '--quiet'], repo, 10 * 60_000); }
