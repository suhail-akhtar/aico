/**
 * What git history says about a project's files: which change together, how
 * often each changes, who changes it, and what is changed right now.
 *
 * Co-change is the one graph signal the Phase 0 benchmark found genuinely
 * useful (ADR 0028): a tax-rate table and a ledger-partition table that share
 * no import and no vocabulary, but every commit that touched one touched the
 * other. No import graph can see that; `git log` can, for free.
 *
 * ## Bounds, and why
 *
 * - The last {@link MAX_COMMITS} non-merge commits: recent history is the
 *   relevant history, and a ten-year log is seconds of `git` for nothing.
 * - Commits touching more than {@link MAX_FILES_PER_COMMIT} files are skipped:
 *   a reformat or a dependency bump pairs everything with everything (a
 *   5,000-file commit is 12.5 million pairs) and says nothing about design.
 * - `--relative` from the project directory: paths come back relative to the
 *   project even when it is a folder inside a bigger repository — the
 *   monorepo case where another indexer silently found no history.
 *
 * Runs `git` with an argument array and no shell; a missing git or a folder
 * that is not a repository yields an empty history, never an error.
 *
 * @module codegraph/git
 */

import { execFile } from 'node:child_process';

export const MAX_COMMITS = 400;
export const MAX_FILES_PER_COMMIT = 40;
const TIMEOUT_MS = 20_000;

export interface GitHistory {
  available: boolean;
  head?: string;
  commits: number;
  skippedLarge: number;
  /** Per file: commits that touched it. */
  churn: Map<string, number>;
  /** Per file: author → commits. */
  authors: Map<string, Map<string, number>>;
  /** Per file: most recent commit time (ms). */
  lastChanged: Map<string, number>;
  /** `a\0b` (a < b) → commits that touched both. */
  pairs: Map<string, number>;
  /** Recent commits per file (bounded), newest first. */
  recent: Map<string, Array<{ hash: string; at: number; author: string; subject: string }>>;
}

export function runGit(cwd: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout ?? '') });
    });
  });
}

export async function gitHead(root: string): Promise<string | undefined> {
  const r = await runGit(root, ['rev-parse', 'HEAD'], 5_000);
  return r.ok ? r.out.trim() || undefined : undefined;
}

export function emptyHistory(): GitHistory {
  return { available: false, commits: 0, skippedLarge: 0, churn: new Map(), authors: new Map(), lastChanged: new Map(), pairs: new Map(), recent: new Map() };
}

/** Parse `git log` output written with the format used by {@link readHistory}. Pure, for tests. */
export function parseLog(out: string, maxFilesPerCommit = MAX_FILES_PER_COMMIT): Omit<GitHistory, 'available' | 'head'> {
  const h = emptyHistory();
  for (const block of out.split('\x1e')) {
    const trimmed = block.replace(/^\s+/, '');
    if (!trimmed) continue;
    const [header, ...rest] = trimmed.split('\n');
    const [hash, author, at, subject] = (header ?? '').split('\x1f');
    if (!hash) continue;
    const files = [...new Set(rest.map(l => l.trim()).filter(Boolean))];
    if (files.length === 0) continue;
    h.commits++;
    if (files.length > maxFilesPerCommit) { h.skippedLarge++; continue; }
    const when = Number(at) * 1000;
    for (const f of files) {
      h.churn.set(f, (h.churn.get(f) ?? 0) + 1);
      const byAuthor = h.authors.get(f) ?? new Map<string, number>();
      byAuthor.set(author ?? '?', (byAuthor.get(author ?? '?') ?? 0) + 1);
      h.authors.set(f, byAuthor);
      if (!h.lastChanged.has(f)) h.lastChanged.set(f, when);
      const recent = h.recent.get(f) ?? [];
      if (recent.length < 5) recent.push({ hash: hash.slice(0, 10), at: when, author: author ?? '?', subject: (subject ?? '').slice(0, 120) });
      h.recent.set(f, recent);
    }
    const sorted = [...files].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}\0${sorted[j]}`;
        h.pairs.set(key, (h.pairs.get(key) ?? 0) + 1);
      }
    }
  }
  return h;
}

/** History of the project directory, bounded as the module header says. */
export async function readHistory(root: string): Promise<GitHistory> {
  const head = await gitHead(root);
  if (!head) return emptyHistory();
  const r = await runGit(root, ['log', `-n${MAX_COMMITS}`, '--no-merges', '--name-only', '--relative', '--format=%x1e%H%x1f%an%x1f%ct%x1f%s', '--', '.']);
  if (!r.ok) return { ...emptyHistory(), head };
  return { ...parseLog(r.out), available: true, head };
}

/** Files changed but not committed (tracked edits, staged, and untracked), relative to the project. */
export async function uncommittedFiles(root: string): Promise<string[]> {
  const [diff, untracked] = await Promise.all([
    runGit(root, ['diff', '--name-only', '--relative', 'HEAD', '--', '.']),
    runGit(root, ['ls-files', '--others', '--exclude-standard', '--', '.']),
  ]);
  const out = new Set<string>();
  for (const r of [diff, untracked]) if (r.ok) for (const l of r.out.split('\n')) if (l.trim()) out.add(l.trim());
  return [...out];
}
