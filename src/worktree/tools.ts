/**
 * `EnterWorktree` / `ExitWorktree`: a git worktree the model manages itself.
 *
 * Honest about what they do (ADR 0021). They create and finish a worktree;
 * they do **not** move the session's working directory. A run's directory is
 * fixed for its whole life on purpose (server/runs.ts `ensure`) — every guard,
 * the checks gate and the session's filing are keyed to it — so silently
 * re-pointing it mid-turn would be the riskiest change in the product for a
 * convenience. The description says so instead, and points at the path that
 * does give an agent its own directory: `Task` with `isolation: "worktree"`,
 * which starts the sub-agent *inside* the worktree.
 *
 * `ExitWorktree` never discards work: uncommitted changes are committed to the
 * worktree's branch, or the worktree is left in place when that fails
 * (`worktree/index.ts`). `keep_branch` is accepted for old callers and no
 * longer needed — a branch with work on it is always kept.
 *
 * @module worktree/tools
 */

import { currentCwd } from '../run-context.js';
import { describeWorktreeFinish, worktreeManager } from './index.js';

export const enterWorktreeToolDefinition = {
  name: 'EnterWorktree',
  description:
    'Create a git worktree (a separate checkout on a new branch) and return its path and branch. '
    + 'It does NOT change your working directory: to work inside it, give paths under the returned '
    + 'path, or delegate with Task isolation:"worktree", which runs a sub-agent inside a worktree. '
    + 'Finish it with ExitWorktree — your changes are committed to its branch, never discarded.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'A label for whose worktree this is (used in the branch name).',
      },
      cwd: {
        type: 'string',
        description: 'The repository directory (default: your working directory).',
      },
    },
    required: ['agent_id'],
  },
};

export const exitWorktreeToolDefinition = {
  name: 'ExitWorktree',
  description:
    'Finish a worktree from EnterWorktree. Uncommitted changes are committed to its branch and the '
    + 'branch is kept for you to merge; a worktree with no changes is removed. If the commit fails the '
    + 'worktree is left in place and its path returned. Nothing is ever discarded.',
  inputSchema: {
    type: 'object',
    properties: {
      worktree_id: {
        type: 'string',
        description: 'The worktree ID returned by EnterWorktree',
      },
      keep_branch: {
        type: 'boolean',
        description: 'Ignored: a branch with work on it is always kept.',
      },
    },
    required: ['worktree_id'],
  },
};

export async function executeEnterWorktree(args: {
  agent_id: string;
  cwd?: string;
}): Promise<{ worktreeId: string; path: string; branch: string; note: string }> {
  // The run's directory, not the process's: a server drives many projects.
  const cwd = args.cwd ?? currentCwd();
  const rec = await worktreeManager.createWorktree(args.agent_id, cwd);
  return {
    worktreeId: rec.worktreeId, path: rec.path, branch: rec.branch,
    note: `Your working directory is unchanged (${cwd}). Work in the worktree by using paths under ${rec.path}.`,
  };
}

export async function executeExitWorktree(args: {
  worktree_id: string;
  keep_branch?: boolean;
}): Promise<{ cleaned: boolean; path?: string; branch?: string; outcome?: string; message: string }> {
  const finished = await worktreeManager.finish(args.worktree_id, {
    message: `Work from worktree ${args.worktree_id}`,
  });
  if (!finished) return { cleaned: false, message: 'Worktree not found or already finished.' };
  return {
    cleaned: finished.outcome !== 'kept',
    outcome: finished.outcome,
    ...(finished.outcome !== 'clean' ? { path: finished.path, branch: finished.branch } : {}),
    message: describeWorktreeFinish(finished),
  };
}
