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
