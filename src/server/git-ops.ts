/**
 * Git operations for the workspace page — look at a commit, see and switch
 * branches, branch from a commit, revert one.
 *
 * The page listed commits and nothing more; every question a person has next
 * ("what changed here?", "get me back to that branch") meant leaving for a
 * terminal. These are the everyday ones, and each is chosen and guarded so it
 * can never lose work:
 *
 *   - nothing here rewrites history, force-anything, or deletes a branch;
 *   - switching branches and reverting refuse outright when tracked files have
 *     uncommitted changes, instead of carrying them along or stashing them
 *     somewhere the person will not find them;
 *   - "restore" is a new branch at the commit, not a reset — the branch you
 *     were on stays exactly as it was;
 *   - a revert that conflicts is aborted, leaving the tree as it was found;
 *   - names and hashes are validated before they reach git, the same rules the
 *     agent's own Git tool uses (a name starting with `-` would be read as a
 *     flag — that was a real bug once).
 *
 * @module server/git-ops
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return stdout;
}

/** A diff past this is cut, with a note, rather than shipped whole to a browser. */
const MAX_DIFF_CHARS = 200_000;

export function isValidHash(hash: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(hash);
}

/** Refuses what git would read as a flag, a range, or anything unusual. */
export function isValidBranchName(name: string): boolean {
  return /^[\w./-]+$/.test(name) && !name.startsWith('-') && !name.includes('..')
    && !name.endsWith('/') && !name.endsWith('.lock') && name.length <= 200;
}

/** Tracked files with uncommitted changes. Untracked files never block a switch. */
async function dirtyTracked(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  return out.split('\n').map(l => l.slice(3).trim()).filter(Boolean);
}

function dirtyError(files: string[]): Error {
  const shown = files.slice(0, 5).join(', ') + (files.length > 5 ? `, and ${files.length - 5} more` : '');
  return new Error(`There are uncommitted changes (${shown}). Commit or discard them first — `
    + 'nothing was changed, so no work could be lost.');
}

export interface CommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{ status: string; path: string }>;
  diff: string;
  truncated: boolean;
}

/** One commit: who, when, why, which files, and the diff. */
export async function showCommit(cwd: string, hash: string): Promise<CommitDetail> {
  if (!isValidHash(hash)) throw new Error('not a commit hash');
  const SEP = '\u001f';
  const head = await git(cwd, ['show', '-s', `--format=%H${SEP}%h${SEP}%an${SEP}%aI${SEP}%s${SEP}%b`, hash]);
  const [full, short, author, date, subject, ...body] = head.split(SEP);
  const status = await git(cwd, ['show', '--name-status', '--format=', hash]);
  const files = status.split('\n').filter(Boolean).map((line) => {
    const [code, ...paths] = line.split('\t');
    return { status: (code ?? '').charAt(0), path: paths.join(' → ') };
  });
  let diff = await git(cwd, ['show', '--format=', '--patch', '--no-color', hash]);
  const truncated = diff.length > MAX_DIFF_CHARS;
  if (truncated) diff = diff.slice(0, MAX_DIFF_CHARS);
  return {
    hash: (full ?? '').trim(), shortHash: short ?? '', author: author ?? '', date: date ?? '',
    subject: subject ?? '', body: body.join(SEP).trim(), files, diff, truncated,
  };
}

export interface BranchInfo {
  name: string;
  current: boolean;
  lastCommit: string;
  lastDate: string;
}

/** Local branches, the current one marked, most recently committed first. */
export async function listBranches(cwd: string): Promise<{ current: string | null; branches: BranchInfo[] }> {
  const SEP = '\u001f';
  const out = await git(cwd, [
    'for-each-ref', '--sort=-committerdate',
    `--format=%(HEAD)${SEP}%(refname:short)${SEP}%(objectname:short)${SEP}%(committerdate:iso-strict)`,
    'refs/heads',
  ]);
  const branches = out.split('\n').filter(Boolean).map((line) => {
    const [head, name, lastCommit, lastDate] = line.split(SEP);
    return { name: name ?? '', current: head === '*', lastCommit: lastCommit ?? '', lastDate: lastDate ?? '' };
  });
  return { current: branches.find(b => b.current)?.name ?? null, branches };
}

/** Switch to a local branch — refused while tracked files have uncommitted changes. */
export async function switchBranch(cwd: string, name: string): Promise<void> {
  if (!isValidBranchName(name)) throw new Error('not a valid branch name');
  const dirty = await dirtyTracked(cwd);
  if (dirty.length > 0) throw dirtyError(dirty);
  await git(cwd, ['checkout', name, '--']);
}

/**
 * A new branch at a commit — how a past state is "restored" here.
 *
 * Nothing is reset: the branch you were on keeps every commit. With `switchTo`,
 * the new branch is checked out as well (under the same dirty-tree rule).
 */
export async function createBranch(cwd: string, name: string, at: string, switchTo: boolean): Promise<void> {
  if (!isValidBranchName(name)) throw new Error('not a valid branch name');
  if (!isValidHash(at)) throw new Error('not a commit hash');
  const existing = (await listBranches(cwd)).branches.some(b => b.name === name);
  if (existing) throw new Error(`A branch called "${name}" already exists.`);
  if (switchTo) {
    const dirty = await dirtyTracked(cwd);
    if (dirty.length > 0) throw dirtyError(dirty);
  }
  await git(cwd, ['branch', name, at]);
  if (switchTo) await git(cwd, ['checkout', name, '--']);
}

/**
 * Undo one commit with a new commit that reverses it. History is not
 * rewritten. A conflict is aborted, so the tree is left exactly as found.
 */
export async function revertCommit(cwd: string, hash: string): Promise<void> {
  if (!isValidHash(hash)) throw new Error('not a commit hash');
  const dirty = await dirtyTracked(cwd);
  if (dirty.length > 0) throw dirtyError(dirty);
  try {
    await git(cwd, ['revert', '--no-edit', hash]);
  } catch (err) {
    await git(cwd, ['revert', '--abort']).catch(() => { /* nothing to abort */ });
    const detail = (err as { stderr?: string }).stderr?.split('\n').find(l => l.trim()) ?? (err as Error).message;
    throw new Error(`The revert conflicts with later changes and was cancelled; nothing changed. (${detail})`);
  }
}

// ── Working tree ────────────────────────────────────────────────────────────
//
// What a source-control view needs beyond history: what changed, staging,
// committing, and trading commits with a remote. The same rules hold —
// nothing force-pushes, nothing resets, a pull only fast-forwards — and the
// one destructive move a person expects to have (discarding their own edits
// to a tracked file) touches only the paths named, and only tracked ones.

export interface StatusEntry {
  path: string;
  /** For a rename: where it came from. */
  from?: string;
  /** Index (staged) status letter, or ' '. */
  index: string;
  /** Worktree (unstaged) status letter, or ' '. `?` is untracked. */
  worktree: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: StatusEntry[];
  conflicted: StatusEntry[];
  remotes: string[];
}

/** Refuses paths git would read as options or that climb out of the repo. */
function checkPaths(paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('name at least one file');
  for (const p of paths) {
    if (typeof p !== 'string' || !p || p.startsWith('-') || p.split(/[\\/]/).includes('..')) throw new Error(`not a usable path: ${p}`);
  }
  return paths;
}

const QUIET_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const empty: GitStatus = { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], remotes: [] };
  let raw: string;
  try {
    raw = await git(cwd, ['status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all']);
  } catch {
    return empty;
  }
  const parts = raw.split('\0');
  const out: GitStatus = { ...empty, isRepo: true };
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!;
    if (!rec) continue;
    if (rec.startsWith('## ')) {
      const head = rec.slice(3);
      const m = /^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(head);
      out.branch = m?.[1] === 'HEAD' ? null : (m?.[1] ?? null);
      out.upstream = m?.[2] ?? null;
      const ab = m?.[3] ?? '';
      out.ahead = Number(/ahead (\d+)/.exec(ab)?.[1] ?? 0);
      out.behind = Number(/behind (\d+)/.exec(ab)?.[1] ?? 0);
      continue;
    }
    const x = rec[0] ?? ' ';
    const y = rec[1] ?? ' ';
    const entry: StatusEntry = { path: rec.slice(3), index: x, worktree: y };
    if (x === 'R' || x === 'C') entry.from = parts[++i];
    if (x === '?' && y === '?') { out.untracked.push({ ...entry, index: ' ', worktree: '?' }); continue; }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { out.conflicted.push(entry); continue; }
    if (x !== ' ') out.staged.push(entry);
    if (y !== ' ') out.unstaged.push(entry);
  }
  try { out.remotes = (await git(cwd, ['remote'])).split('\n').map(s => s.trim()).filter(Boolean); } catch { /* none */ }
  return out;
}

/** One file's diff: staged, unstaged, or (for an untracked file) the whole file as added. */
export async function fileDiff(cwd: string, file: string, staged: boolean): Promise<{ diff: string; truncated: boolean }> {
  checkPaths([file]);
  let diff = await git(cwd, ['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', file]);
  if (!diff && !staged) {
    // Untracked: show it as all-new, without asking git to read outside the tree.
    const { default: fs } = await import('fs');
    const { default: path } = await import('path');
    const full = path.resolve(cwd, file);
    if (full.startsWith(path.resolve(cwd)) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
      diff = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(l => `+${l}`).join('\n');
    }
  }
  const truncated = diff.length > MAX_DIFF_CHARS;
  return { diff: truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff, truncated };
}

export async function stage(cwd: string, paths: string[] | 'all'): Promise<void> {
  if (paths === 'all') await git(cwd, ['add', '-A']);
  else await git(cwd, ['add', '--', ...checkPaths(paths)]);
}

export async function unstage(cwd: string, paths: string[] | 'all'): Promise<void> {
  // `restore --staged` needs a commit to restore from; a brand-new repo uses rm --cached.
  const hasHead = await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  const list = paths === 'all' ? ['.'] : checkPaths(paths);
  if (hasHead) await git(cwd, ['restore', '--staged', '--', ...list]);
  else await git(cwd, ['rm', '-r', '--cached', '--quiet', '--', ...list]);
}

/**
 * Throw away uncommitted edits to tracked files — the person asked for it, by
 * name. Untracked files are refused: deleting a file nobody committed is a
 * trash-can job, not a git one, and the desktop sends those to the trash.
 */
export async function discard(cwd: string, paths: string[]): Promise<void> {
  const list = checkPaths(paths);
  const tracked = (await git(cwd, ['ls-files', '--', ...list])).split('\n').map(s => s.trim()).filter(Boolean);
  if (tracked.length === 0) throw new Error('Those files are not tracked; nothing to discard in git.');
  await git(cwd, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...tracked]);
}

export async function commit(cwd: string, message: string, opts: { all?: boolean } = {}): Promise<{ hash: string }> {
  const msg = message.trim();
  if (!msg) throw new Error('A commit needs a message.');
  if (opts.all) await git(cwd, ['add', '-A']);
  const staged = await git(cwd, ['diff', '--cached', '--name-only']);
  if (!staged.trim()) throw new Error('Nothing is staged. Stage some changes first.');
  try {
    await git(cwd, ['commit', '-m', msg]);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (/user\.(email|name)|Please tell me who you are/i.test(stderr)) {
      throw new Error('Git does not know who you are yet. Set user.name and user.email (git config --global) and try again.');
    }
    throw new Error(stderr.trim() || (err as Error).message);
  }
  return { hash: (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim() };
}

/** Push the current branch. Never forces; sets the upstream the first time. */
export async function push(cwd: string): Promise<string> {
  const st = await gitStatus(cwd);
  if (!st.branch) throw new Error('Not on a branch (detached HEAD) — switch to a branch to push.');
  if (st.remotes.length === 0) throw new Error('This repository has no remote to push to.');
  const remote = st.remotes.includes('origin') ? 'origin' : st.remotes[0]!;
  const args = st.upstream ? ['push'] : ['push', '--set-upstream', remote, st.branch];
  try {
    const { stderr, stdout } = await run('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: QUIET_ENV });
    return (stderr || stdout).trim() || 'Pushed.';
  } catch (err) {
    const e = (err as { stderr?: string }).stderr ?? (err as Error).message;
    if (/rejected|non-fast-forward|fetch first/i.test(e)) throw new Error('The remote has commits you do not have. Pull first, then push.');
    if (/Authentication|could not read Username|Permission denied|403/i.test(e)) throw new Error('The remote refused the credentials. Sign in (for GitHub: gh auth login) and try again.');
    throw new Error(e.trim());
  }
}

/** Pull, fast-forward only — a pull that would need a merge says so instead of making one. */
export async function pull(cwd: string): Promise<string> {
  try {
    const { stderr, stdout } = await run('git', ['pull', '--ff-only'], { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: QUIET_ENV });
    return (stdout || stderr).trim() || 'Up to date.';
  } catch (err) {
    const e = (err as { stderr?: string }).stderr ?? (err as Error).message;
    if (/Not possible to fast-forward|diverged/i.test(e)) throw new Error('Your branch and the remote have both moved on. Merge or rebase them yourself — AICO only fast-forwards.');
    if (/no tracking information/i.test(e)) throw new Error('This branch has no upstream yet. Push it first.');
    throw new Error(e.trim());
  }
}

export async function fetchAll(cwd: string): Promise<string> {
  const { stderr, stdout } = await run('git', ['fetch', '--all', '--prune'], { cwd, windowsHide: true, env: QUIET_ENV });
  return (stderr || stdout).trim() || 'Fetched.';
}

export interface StashEntry { ref: string; message: string; date: string }

export async function stashList(cwd: string): Promise<StashEntry[]> {
  const SEP = '\u001f';
  const out = await git(cwd, ['stash', 'list', `--format=%gd${SEP}%s${SEP}%cI`]).catch(() => '');
  return out.split('\n').filter(Boolean).map(l => { const [ref, message, date] = l.split(SEP); return { ref: ref ?? '', message: message ?? '', date: date ?? '' }; });
}

export async function stashPush(cwd: string, message: string, includeUntracked: boolean): Promise<void> {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('--include-untracked');
  if (message.trim()) args.push('-m', message.trim());
  const out = await git(cwd, args);
  if (/No local changes to save/i.test(out)) throw new Error('There is nothing to stash.');
}

/** Re-apply a stash. A conflict leaves the stash in place (`pop` only drops it on success). */
export async function stashPop(cwd: string, ref: string): Promise<void> {
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error('not a stash reference');
  try { await git(cwd, ['stash', 'pop', ref]); }
  catch (err) {
    throw new Error(`The stash did not apply cleanly; it is still saved. ${((err as { stderr?: string }).stderr ?? '').split('\n')[0] ?? ''}`.trim());
  }
}

/** Delete a branch that is fully merged. Unmerged work is never deleted from here. */
export async function deleteBranch(cwd: string, name: string): Promise<void> {
  if (!isValidBranchName(name)) throw new Error('not a valid branch name');
  const { current } = await listBranches(cwd);
  if (current === name) throw new Error('That is the branch you are on.');
  try { await git(cwd, ['branch', '-d', '--', name]); }
  catch (err) {
    const e = (err as { stderr?: string }).stderr ?? '';
    if (/not fully merged/i.test(e)) throw new Error(`"${name}" has commits that are not merged anywhere, so it was kept.`);
    throw new Error(e.trim() || (err as Error).message);
  }
}

/** A new branch from where you are, switched to. */
export async function newBranchHere(cwd: string, name: string): Promise<void> {
  if (!isValidBranchName(name)) throw new Error('not a valid branch name');
  if ((await listBranches(cwd)).branches.some(b => b.name === name)) throw new Error(`A branch called "${name}" already exists.`);
  await git(cwd, ['checkout', '-b', name]);
}

export async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ['init']);
}
