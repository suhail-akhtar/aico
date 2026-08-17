import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir } from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

export interface WorktreeRecord {
  worktreeId: string;
  agentId: string;
  path: string;
  branch: string;
  baseBranch: string;
  status: 'creating' | 'active' | 'merged' | 'cleaned' | 'failed';
  createdAt: number;
  completedAt?: number;
  hasChanges: boolean;
  changesSummary?: string;
}

const _registry = new Map<string, WorktreeRecord>();
const _subscribers: Array<(records: WorktreeRecord[]) => void> = [];
let _idSeq = 1;

function _emit(): void {
  const records = Array.from(_registry.values());
  for (const fn of _subscribers) fn(records);
}

export class WorktreeManager {
  /** Create a git worktree for an agent and return the record */
  async createWorktree(agentId: string, cwd: string): Promise<WorktreeRecord> {
    const worktreeId = `wt-${Date.now()}-${_idSeq++}`;
    const shortId = worktreeId.slice(-8);

    // Get current branch name
    let baseBranch = 'main';
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd });
      baseBranch = stdout.trim() || 'main';
    } catch {
      // not a git repo or no commits — use 'main'
    }

    const branch = `aico/worktree/${shortId}`;
    const worktreePath = path.join(cwd, '.aico', 'worktrees', shortId);

    const rec: WorktreeRecord = {
      worktreeId,
      agentId,
      path: worktreePath,
      branch,
      baseBranch,
      status: 'creating',
      createdAt: Date.now(),
      hasChanges: false,
    };

    _registry.set(worktreeId, rec);
    _emit();

    try {
      await mkdir(path.dirname(worktreePath), { recursive: true });
      await execAsync(
        `git worktree add -b "${branch}" "${worktreePath}" HEAD`,
        { cwd },
      );
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

  /** Check whether a worktree has uncommitted changes */
  async hasChanges(worktreePath: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync('git status --porcelain', { cwd: worktreePath });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Get a short human-readable summary of changes in a worktree */
  async getChangesSummary(worktreePath: string): Promise<string> {
    try {
      const { stdout } = await execAsync(
        'git diff --stat HEAD 2>/dev/null || git status --short',
        { cwd: worktreePath },
      );
      return stdout.trim().slice(0, 500);
    } catch {
      return '';
    }
  }

  /**
   * Cleanup a worktree.
   * If it has changes and opts.keepBranch is true, the branch is preserved for manual merge.
   * Otherwise the worktree and branch are deleted.
   */
  async cleanupWorktree(
    worktreeId: string,
    opts: { cwd: string; keepBranch?: boolean } = { cwd: process.cwd() },
  ): Promise<{ cleaned: boolean; path?: string; branch?: string }> {
    const rec = _registry.get(worktreeId);
    if (!rec || rec.status === 'cleaned') return { cleaned: false };

    const hasChanges = await this.hasChanges(rec.path);
    if (hasChanges) {
      rec.hasChanges = true;
      rec.changesSummary = await this.getChangesSummary(rec.path);
    }

    try {
      // Remove the worktree filesystem entry
      await execAsync(`git worktree remove --force "${rec.path}"`, { cwd: opts.cwd });
    } catch {
      // If already removed, continue
    }

    if (!hasChanges || !opts.keepBranch) {
      try {
        await execAsync(`git branch -D "${rec.branch}"`, { cwd: opts.cwd });
      } catch {
        // Branch may already be deleted
      }
    }

    rec.status = hasChanges && opts.keepBranch ? 'merged' : 'cleaned';
    rec.completedAt = Date.now();
    _emit();

    return {
      cleaned: true,
      path: hasChanges ? rec.path : undefined,
      branch: hasChanges ? rec.branch : undefined,
    };
  }

  subscribe(fn: (records: WorktreeRecord[]) => void): () => void {
    _subscribers.push(fn);
    fn(Array.from(_registry.values()));
    return () => {
      const idx = _subscribers.indexOf(fn);
      if (idx !== -1) _subscribers.splice(idx, 1);
    };
  }

  getAll(): WorktreeRecord[] {
    return Array.from(_registry.values());
  }

  getByAgentId(agentId: string): WorktreeRecord | undefined {
    return Array.from(_registry.values()).find((r) => r.agentId === agentId);
  }
}

export const worktreeManager = new WorktreeManager();
