import { worktreeManager } from './index.js';

export const enterWorktreeToolDefinition = {
  name: 'EnterWorktree',
  description:
    'Create a git worktree for isolated development. Returns the worktree path and branch name. ' +
    'Use ExitWorktree when done to clean up.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'The agent ID this worktree is associated with',
      },
      cwd: {
        type: 'string',
        description: 'The base repository directory (default: process.cwd())',
      },
    },
    required: ['agent_id'],
  },
};

export const exitWorktreeToolDefinition = {
  name: 'ExitWorktree',
  description:
    'Clean up a git worktree after use. If the worktree has uncommitted changes and keep_branch is true, ' +
    'the branch is preserved for manual review.',
  inputSchema: {
    type: 'object',
    properties: {
      worktree_id: {
        type: 'string',
        description: 'The worktree ID returned by EnterWorktree',
      },
      keep_branch: {
        type: 'boolean',
        description: 'If true and changes exist, preserve the branch instead of deleting it',
      },
    },
    required: ['worktree_id'],
  },
};

export async function executeEnterWorktree(args: {
  agent_id: string;
  cwd?: string;
}): Promise<{ worktreeId: string; path: string; branch: string }> {
  const cwd = args.cwd ?? process.cwd();
  const rec = await worktreeManager.createWorktree(args.agent_id, cwd);
  return { worktreeId: rec.worktreeId, path: rec.path, branch: rec.branch };
}

export async function executeExitWorktree(args: {
  worktree_id: string;
  keep_branch?: boolean;
}): Promise<{ cleaned: boolean; path?: string; branch?: string; message: string }> {
  const result = await worktreeManager.cleanupWorktree(args.worktree_id, {
    cwd: process.cwd(),
    keepBranch: args.keep_branch ?? false,
  });

  const message = result.cleaned
    ? result.branch
      ? `Worktree cleaned. Branch "${result.branch}" preserved with changes.`
      : 'Worktree cleaned and branch deleted.'
    : 'Worktree not found or already cleaned.';

  return { ...result, message };
}
