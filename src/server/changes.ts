/**
 * What changed, and how to put it back.
 *
 * An agent's diffs arrive scattered across tool rows, one per write, in the
 * order they happened rather than the order anyone reads. After twenty of them
 * the honest question — *what did this session actually do to my repository* —
 * has no answer short of running `git diff` in another window. And when the
 * answer is "something I did not want", there is no way back except to undo it
 * by hand.
 *
 * **Git is the source, not the session log.** The log knows what was written;
 * only git knows what the file looked like before, which is the difference
 * between a list and an undo. It also sees what the log cannot: a file deleted
 * by a shell command, a change made in the editor while the agent was thinking.
 *
 * **The session's own edits are marked, not filtered.** Showing only what the
 * agent touched would hide a conflicting edit of yours sitting in the same
 * working tree, which is precisely the situation where a revert is dangerous.
 * Everything is listed; the ones this session wrote are labelled.
 *
 * **Reverting is never automatic.** It is the one operation here that destroys
 * work, so it happens only when a person asks for a specific path, and an
 * untracked file — where "revert" means "delete" — says so before it is done.
 *
 * @module server/changes
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const run = promisify(execFile);

/** Git's porcelain codes, in the words a reader uses. */
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface FileChange {
  /** Repo-relative, forward-slashed, as git reports it. */
  path: string;
  kind: ChangeKind;
  /** Where it came from, for a rename. */
  from?: string;
  added: number;
  removed: number;
  /** True when this file cannot be shown as text. */
  binary: boolean;
  /** True when a tool in this session wrote it. */
  bySession: boolean;
}

export interface ChangesReport {
  /** False when the directory is not a git repository — then nothing is listed. */
  isRepo: boolean;
  files: FileChange[];
  /** Total across every file, so a header can say "+120 −34". */
  added: number;
  removed: number;
  /** Files this session wrote that git no longer reports as changed. */
  reverted: string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** Whether this directory is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch { return false; }
}

/** Porcelain status letters → what a person would call it. */
function kindOf(code: string): ChangeKind {
  if (code === '??') return 'untracked';
  const letters = code.replace(/\s/g, '');
  if (letters.includes('R')) return 'renamed';
  if (letters.includes('D')) return 'deleted';
  if (letters.includes('A')) return 'added';
  return 'modified';
}

/**
 * Per-file line counts, from one numstat call rather than one per file.
 *
 * `-` in either column means git could not diff it as text, which is how a
 * binary file announces itself.
 */
async function lineCounts(cwd: string): Promise<Map<string, { added: number; removed: number; binary: boolean }>> {
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (const args of [['diff', '--numstat', 'HEAD'], ['diff', '--numstat', '--cached']]) {
    let out = '';
    try { out = await git(cwd, args); } catch { continue; }
    for (const line of out.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [a, r, file] = parts;
      const name = (file ?? '').trim();
      if (!name) continue;
      counts.set(name, {
        added: a === '-' ? 0 : Number(a) || 0,
        removed: r === '-' ? 0 : Number(r) || 0,
        binary: a === '-' && r === '-',
      });
    }
  }
  return counts;
}

/** An untracked file has no diff, so its size is its addition. */
function countNewFile(cwd: string, rel: string): { added: number; binary: boolean } {
  try {
    const buf = fs.readFileSync(path.join(cwd, rel));
    // A NUL byte in the first block is the same heuristic git uses.
    const binary = buf.subarray(0, 8000).includes(0);
    return { added: binary ? 0 : buf.toString('utf8').split('\n').length, binary };
  } catch { return { added: 0, binary: false }; }
}

/**
 * Everything currently different from HEAD.
 *
 * `sessionFiles` are absolute paths a tool wrote during this session; they are
 * used only to label rows, never to filter them.
 */
export async function listChanges(cwd: string, sessionFiles: string[] = []): Promise<ChangesReport> {
  if (!await isGitRepo(cwd)) {
    return { isRepo: false, files: [], added: 0, removed: 0, reverted: [] };
  }

  const status = await git(cwd, ['status', '--porcelain=v1', '-z']);
  const counts = await lineCounts(cwd);

  // -z separates records with NUL and, for renames, follows with the old name
  // as its own record — which is why this is a cursor rather than a split.
  const records = status.split('\0').filter(Boolean);
  const files: FileChange[] = [];
  const touched = new Set(sessionFiles.map(f => path.resolve(f).toLowerCase()));

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const code = record.slice(0, 2);
    let rel = record.slice(3);
    let from: string | undefined;
    if (kindOf(code) === 'renamed') {
      from = records[++i];
    }
    if (!rel) continue;

    const known = counts.get(rel);
    const fresh = code === '??' ? countNewFile(cwd, rel) : undefined;

    files.push({
      path: rel,
      kind: kindOf(code),
      ...(from ? { from } : {}),
      added: known?.added ?? fresh?.added ?? 0,
      removed: known?.removed ?? 0,
      binary: known?.binary ?? fresh?.binary ?? false,
      bySession: touched.has(path.resolve(cwd, rel).toLowerCase()),
    });
  }

  files.sort((a, b) => (Number(b.bySession) - Number(a.bySession)) || a.path.localeCompare(b.path));

  const changedNow = new Set(files.map(f => path.resolve(cwd, f.path).toLowerCase()));
  return {
    isRepo: true,
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    // Written this session and no longer different from HEAD: either reverted,
    // or written back to exactly what was there. Worth showing rather than
    // silently dropping, so a file that vanished from the list is explainable.
    reverted: sessionFiles
      .filter(f => !changedNow.has(path.resolve(f).toLowerCase()))
      .map(f => path.relative(cwd, f).split(path.sep).join('/'))
      .filter(rel => rel && !rel.startsWith('..')),
  };
}

/** The unified diff for one file, or the whole of a new one. */
export async function diffOf(cwd: string, rel: string): Promise<string> {
  const safe = safeRelative(cwd, rel);
  if (!safe) throw new Error('path is outside the project');

  const untracked = await git(cwd, ['ls-files', '--error-unmatch', '--', safe])
    .then(() => false).catch(() => true);

  if (untracked) {
    // `--no-index` against nothing gives a real diff for a file git has never
    // seen, so a new file reads the same as a changed one.
    return await git(cwd, ['diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', safe])
      .catch((err: { stdout?: string }) => err.stdout ?? '');
  }

  // Non-zero exit is how git says "there is a difference", so the output is on
  // the error for exactly the case we want.
  return await git(cwd, ['diff', 'HEAD', '--', safe])
    .catch((err: { stdout?: string }) => err.stdout ?? '');
}

/**
 * Put one file back to HEAD.
 *
 * Destructive by definition, so it takes one explicit path and nothing
 * wildcard. An untracked file has no HEAD to return to — reverting it means
 * deleting it, and the caller must have said so.
 */
export async function revertFile(
  cwd: string,
  rel: string,
  opts: { deleteUntracked?: boolean } = {},
): Promise<{ ok: boolean; deleted?: boolean; error?: string }> {
  const safe = safeRelative(cwd, rel);
  if (!safe) return { ok: false, error: 'path is outside the project' };

  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', safe])
    .then(() => true).catch(() => false);

  if (!tracked) {
    if (!opts.deleteUntracked) {
      return {
        ok: false,
        error: `${safe} is a new file — there is no earlier version to restore. `
          + 'Reverting it means deleting it; ask again with deleteUntracked to do that.',
      };
    }
    try { fs.rmSync(path.join(cwd, safe), { force: true }); return { ok: true, deleted: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  }

  try {
    // Unstage first so a staged change is undone too; a revert that leaves the
    // index holding the old edit has not reverted anything a commit would see.
    await git(cwd, ['restore', '--staged', '--worktree', '--source=HEAD', '--', safe]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A repo-relative path that cannot escape the project.
 *
 * Returns undefined rather than throwing so every caller has to decide what to
 * do about it, and none of them can forget.
 */
function safeRelative(cwd: string, rel: string): string | undefined {
  if (!rel || rel.includes('\0')) return undefined;
  const absolute = path.resolve(cwd, rel);
  const root = path.resolve(cwd);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return undefined;
  return path.relative(root, absolute).split(path.sep).join('/') || undefined;
}
