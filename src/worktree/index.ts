/**
 * Git worktrees for sub-agents that must not touch the parent's checkout.
 *
 * `Task {isolation: 'worktree'}` promised isolation and delivered three bugs
 * (ADR 0021): the worktree was created and then the child was handed the
 * *parent's* directory, so it edited the real checkout anyway; cleanup ran
 * `git worktree remove --force` and `git branch -D` — which threw away
 * whatever the child had not committed, the one thing isolation exists to keep;
 * and every git command ran in `process.cwd()`, which on a server driving
 * several projects is not the repository the worktree belongs to.
 *
 * The rules now:
 *
 * - **Work is never discarded.** Finishing a worktree commits anything
 *   uncommitted to the agent's branch. If that commit fails (no git identity, a
 *   hook refused it), the worktree is left on disk, untouched, and its path is
 *   reported. Only a worktree with nothing in it — no changes, no commits past
 *   its base — is removed along with its branch.
 * - **Git runs where the repository is.** Every command names its directory:
 *   the worktree for status/commit, the repository root (recorded at creation)
 *   for `worktree add/remove` and `branch -D`. `execFile` with an argument
 *   array — never a shell string; paths contain spaces.
 * - **Outside the checkout.** Worktrees live under `aicoHome()/worktrees`, not
 *   inside the repository: a nested worktree is a second copy of every file
 *   that the parent's own searches and `git status` then trip over.
 * - **The registry survives a restart** (`worktrees/registry.json`), so a
 *   resumed agent finds its worktree again and nothing is orphaned unseen.
 *
 * What it does not do: merge. The parent is told the branch and a diff summary
 * and decides; merging someone else's work unasked is not this module's call.
 *
 * @module worktree
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { aicoHome } from '../home.js';
import { looksLikeSecretPath } from '../tools/git.js';

export interface WorktreeRecord {
  worktreeId: string;
  agentId: string;
  path: string;
  branch: string;
  /** The branch the parent was on, for the report. */
  baseBranch: string;
  /** The commit the worktree started from — what "ahead" is measured against. */
  baseCommit?: string;
  /** The repository's top level, where `worktree add/remove` and `branch -D` run. */
  repoRoot?: string;
  status: 'creating' | 'active' | 'merged' | 'cleaned' | 'failed' | 'kept';
  createdAt: number;
  completedAt?: number;
  hasChanges: boolean;
  changesSummary?: string;
}

/** How a finished worktree was left. */
export interface WorktreeFinish {
  /**
   * - `clean`: nothing was changed; worktree and branch removed.
   * - `committed`: the work is on `branch` (committed now or by the agent); worktree removed.
   * - `kept`: the work could not be committed; the worktree is left at `path`, as it was.
   */
  outcome: 'clean' | 'committed' | 'kept';
  branch: string;
  path: string;
  base?: string;
  /** `git diff --stat` against the base, or `git status --short` for a kept worktree. */
  summary: string;
  /** Why it was kept, when it was. */
  reason?: string;
}

const GIT_TIMEOUT_MS = 60_000;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 400)}`));
      else resolve(String(stdout));
    });
  });
}

const _registry = new Map<string, WorktreeRecord>();
const _subscribers: Array<(records: WorktreeRecord[]) => void> = [];
let _idSeq = 1;
let _loadedFrom: string | undefined;

function registryFile(): string {
  return path.join(aicoHome(), 'worktrees', 'registry.json');
}

/**
 * Read the persisted registry once per store. Keyed by the file path because
 * tests move `AICO_HOME` between runs; a registry read for one store must not
 * answer for another.
 */
function ensureLoaded(): void {
  const file = registryFile();
  if (_loadedFrom === file) return;
  _loadedFrom = file;
  _registry.clear();
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as WorktreeRecord[];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row && typeof row.worktreeId === 'string') _registry.set(row.worktreeId, row);
    }
  } catch { /* no registry yet, or unreadable: start empty rather than refuse to isolate */ }
}

function save(): void {
  try {
    const file = registryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Bounded: settled rows older than the newest 200 say nothing anyone acts on.
    const rows = [...(_registry.values())].slice(-200);
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  } catch { /* best effort: the worktree itself is on disk whatever the registry says */ }
}

function _emit(): void {
  save();
  const records = Array.from(_registry.values());
  for (const fn of _subscribers) fn(records);
}

export class WorktreeManager {
  /** Create a git worktree for an agent, branched from the parent's HEAD. */
  async createWorktree(agentId: string, cwd: string): Promise<WorktreeRecord> {
    ensureLoaded();
    const worktreeId = `wt-${Date.now()}-${_idSeq++}`;
    const shortId = `${agentId}-${worktreeId.slice(-6)}`.replace(/[^a-zA-Z0-9_-]/g, '');

    const repoRoot = path.resolve((await git(['rev-parse', '--show-toplevel'], cwd)).trim());
    let baseBranch = 'HEAD';
    try { baseBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim() || 'HEAD'; } catch { /* detached or unborn: named HEAD */ }
    const baseCommit = (await git(['rev-parse', 'HEAD'], cwd)).trim();

    const branch = `aico/worktree/${shortId}`;
    const worktreePath = path.join(aicoHome(), 'worktrees', shortId);

    const rec: WorktreeRecord = {
      worktreeId, agentId, path: worktreePath, branch, baseBranch, baseCommit, repoRoot,
      status: 'creating', createdAt: Date.now(), hasChanges: false,
    };
    _registry.set(worktreeId, rec);
    _emit();

    try {
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      await git(['worktree', 'add', '-b', branch, worktreePath, baseCommit], repoRoot);
      rec.status = 'active';
      _emit();
    } catch (err) {
      rec.status = 'failed';
      rec.changesSummary = err instanceof Error ? err.message : String(err);
      _emit();
      throw err;
    }
    return rec;
  }

  /**
   * The directory inside the worktree that corresponds to `cwd` in the parent
   * checkout — a parent working in `repo/packages/api` gets the same
   * sub-directory of its worktree, not the worktree's root.
   */
  childCwd(rec: WorktreeRecord, parentCwd: string): string {
    if (!rec.repoRoot) return rec.path;
    const rel = path.relative(rec.repoRoot, path.resolve(parentCwd));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(rec.path, rel) : rec.path;
  }

  /** Whether a worktree has uncommitted changes. */
  async hasChanges(worktreePath: string): Promise<boolean> {
    try {
      return (await git(['status', '--porcelain'], worktreePath)).trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Finish a worktree without losing anything in it. See the module note for
   * the three outcomes. `message` is the commit message for uncommitted work.
   */
  async finish(worktreeId: string, opts: { message: string }): Promise<WorktreeFinish | undefined> {
    ensureLoaded();
    const rec = _registry.get(worktreeId);
    if (!rec || rec.status === 'cleaned' || rec.status === 'merged') return undefined;
    const repoRoot = rec.repoRoot ?? rec.path;
    const base = rec.baseCommit;
    const report = (outcome: WorktreeFinish['outcome'], summary: string, reason?: string): WorktreeFinish => ({
      outcome, branch: rec.branch, path: rec.path, summary,
      ...(base ? { base } : {}), ...(reason ? { reason } : {}),
    });

    if (!fs.existsSync(rec.path)) {
      // Removed by hand while we were down; the branch, if any, is what is left.
      rec.status = 'cleaned';
      rec.completedAt = Date.now();
      _emit();
      return report('committed', '(worktree directory no longer exists; the branch is kept)');
    }

    // 1. Anything uncommitted goes onto the agent's branch.
    let dirty = false;
    try {
      dirty = (await git(['status', '--porcelain'], rec.path)).trim().length > 0;
    } catch (err) {
      rec.status = 'kept';
      _emit();
      return report('kept', '', `could not read its status: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (dirty) {
      rec.hasChanges = true;
      try {
        await git(['add', '-A'], rec.path);
        /*
          `add -A` sweeps in a `.env` or a key the agent wrote. Check what was
          actually staged, unstage anything that looks like credentials, and
          keep the worktree (rather than clean it up) so the file is neither
          committed nor deleted — the person decides (security review 2026-10).
        */
        const staged = (await git(['diff', '--cached', '--name-only'], rec.path)).split('\n').map(s => s.trim()).filter(Boolean);
        const secrets = staged.filter(looksLikeSecretPath);
        if (secrets.length > 0) {
          await git(['reset', '-q', '--', ...secrets], rec.path);
          if (staged.length > secrets.length) await git(['commit', '-m', opts.message], rec.path);
          let status = '';
          try { status = (await git(['status', '--short'], rec.path)).trim().slice(0, 2000); } catch { /* reported without it */ }
          rec.status = 'kept';
          rec.changesSummary = status;
          rec.completedAt = Date.now();
          _emit();
          return report('kept', status, `left uncommitted because they look like credentials: ${secrets.join(', ')}. `
            + 'Add them to .gitignore, or commit them yourself if they are genuinely safe');
        }
        await git(['commit', '-m', opts.message], rec.path);
      } catch (err) {
        // Never discard: leave it exactly where it is and say where.
        let status = '';
        try { status = (await git(['status', '--short'], rec.path)).trim().slice(0, 2000); } catch { /* reported without it */ }
        rec.status = 'kept';
        rec.changesSummary = status;
        rec.completedAt = Date.now();
        _emit();
        return report('kept', status, `its changes could not be committed (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    // 2. Is there anything on the branch past where it started?
    let ahead = 0;
    if (base) {
      try { ahead = Number((await git(['rev-list', '--count', `${base}..HEAD`], rec.path)).trim()) || 0; } catch { ahead = dirty ? 1 : 0; }
    } else {
      ahead = dirty ? 1 : 0;
    }

    if (ahead > 0) {
      let summary = '';
      try { summary = (await git(['diff', '--stat', `${base ?? 'HEAD~1'}..HEAD`], rec.path)).trim().slice(0, 4000); } catch { /* reported without it */ }
      rec.hasChanges = true;
      rec.changesSummary = summary;
      try {
        await git(['worktree', 'remove', rec.path], repoRoot);
        rec.status = 'merged';
      } catch {
        // Clean but busy (a process holding a file on Windows): leave it. The
        // branch has the work either way.
        rec.status = 'kept';
      }
      rec.completedAt = Date.now();
      _emit();
      return report('committed', summary);
    }

    // 3. Nothing to keep.
    try { await git(['worktree', 'remove', '--force', rec.path], repoRoot); } catch { /* already gone */ }
    try { await git(['branch', '-D', rec.branch], repoRoot); } catch { /* already gone */ }
    rec.status = 'cleaned';
    rec.completedAt = Date.now();
    _emit();
    return report('clean', '');
  }

  /**
   * Put a finished worktree back so a resumed agent works where it left off:
   * re-adds it from its kept branch when the directory was removed. Undefined
   * when there is nothing to come back to.
   */
  async reattach(rec: Pick<WorktreeRecord, 'path' | 'branch'> & { repoRoot?: string }): Promise<string | undefined> {
    if (fs.existsSync(rec.path)) return rec.path;
    if (!rec.repoRoot) return undefined;
    try {
      await git(['rev-parse', '--verify', rec.branch], rec.repoRoot);
      fs.mkdirSync(path.dirname(rec.path), { recursive: true });
      await git(['worktree', 'add', rec.path, rec.branch], rec.repoRoot);
      ensureLoaded();
      const known = [..._registry.values()].find(r => r.path === rec.path);
      if (known) { known.status = 'active'; _emit(); }
      return rec.path;
    } catch {
      return undefined;
    }
  }

  subscribe(fn: (records: WorktreeRecord[]) => void): () => void {
    ensureLoaded();
    _subscribers.push(fn);
    fn(Array.from(_registry.values()));
    return () => {
      const idx = _subscribers.indexOf(fn);
      if (idx !== -1) _subscribers.splice(idx, 1);
    };
  }

  getAll(): WorktreeRecord[] {
    ensureLoaded();
    return Array.from(_registry.values());
  }

  get(worktreeId: string): WorktreeRecord | undefined {
    ensureLoaded();
    return _registry.get(worktreeId);
  }

  getByAgentId(agentId: string): WorktreeRecord | undefined {
    ensureLoaded();
    return Array.from(_registry.values()).reverse().find((r) => r.agentId === agentId);
  }
}

export const worktreeManager = new WorktreeManager();

/** The parent-facing paragraph for a finished worktree: where the work is and how to take it. */
export function describeWorktreeFinish(f: WorktreeFinish): string {
  if (f.outcome === 'clean') return '[Worktree: no changes were made; it was removed.]';
  if (f.outcome === 'kept') {
    return `[Worktree kept at ${f.path} (branch ${f.branch}) — ${f.reason ?? 'it could not be finished'}. `
      + `Nothing was discarded. Uncommitted changes:\n${f.summary || '(none listed)'}\n`
      + 'Review them there, commit, and merge the branch when ready.]';
  }
  return `[Worktree changes are on branch ${f.branch}${f.base ? ` (from ${f.base.slice(0, 10)})` : ''}. `
    + `Diff summary:\n${f.summary || '(no summary)'}\n`
    + `Nothing is merged yet: review with \`git diff ${f.base ? f.base.slice(0, 10) : 'HEAD'}..${f.branch}\` `
    + `and merge with \`git merge ${f.branch}\` when it is right.]`;
}
