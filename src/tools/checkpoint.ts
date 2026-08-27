/**
 * Checkpoints, as the agent and the reader reach them.
 *
 * Recording happens on its own — every turn that writes a file opens one. This
 * tool is for looking at what was recorded and, when something has gone wrong,
 * putting it back.
 *
 * `restore` is the most destructive operation in this codebase, so it is
 * narrow by construction: a file is only touched if it is still exactly as the
 * agent left it. Anything changed since is skipped and named. `dryRun` shows
 * the same report without writing anything, and is the right first call.
 *
 * @module tools/checkpoint
 */

import path from 'path';
import { currentRunContext } from '../run-context.js';
import { getWorkspaceInfo } from '../workspace.js';
import { loadSettings } from '../settings.js';
import { listCheckpoints, restoreCheckpoint } from '../checkpoint/index.js';

export interface CheckpointInput {
  action?: 'list' | 'restore' | 'preview';
  /** Checkpoint id. Defaults to the most recent for restore and preview. */
  id?: string;
}

/** Where this session's checkpoints live. */
export async function checkpointDir(): Promise<string | undefined> {
  const context = currentRunContext();
  if (!context?.sessionId) return undefined;
  const info = getWorkspaceInfo({
    settings: await loadSettings(),
    cwd: context.cwd,
    sessionId: context.sessionId,
  });
  return info.sessionDir ? path.join(info.sessionDir, 'checkpoints') : undefined;
}

function describe(when: number): string {
  const seconds = Math.round((Date.now() - when) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5_400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export async function checkpointTool(input: CheckpointInput): Promise<string> {
  const directory = await checkpointDir();
  if (!directory) return 'Checkpoints are unavailable — this run has no session workspace.';

  const all = await listCheckpoints(directory);
  if (all.length === 0) {
    return 'No checkpoints yet. One is recorded automatically for every turn that '
      + 'changes a file.';
  }

  const action = input.action ?? 'list';
  if (action === 'list') {
    return `${all.length} checkpoint(s), newest first:\n`
      + all.map(cp => `  [${cp.id}] ${describe(cp.createdAt)} — ${cp.files.length} file(s)\n`
        + `      ${cp.label}`).join('\n');
  }

  const chosen = input.id ? all.find(cp => cp.id === input.id) : all[0];
  if (!chosen) return `No checkpoint called "${input.id}". Use action:"list".`;

  const report = await restoreCheckpoint(chosen, { dryRun: action === 'preview' });
  const verb = action === 'preview' ? 'Would restore' : 'Restored';
  const lines: string[] = [`${verb} from [${chosen.id}] — ${chosen.label}`];

  if (report.restored.length > 0) {
    lines.push(`${report.restored.length} file(s) put back:`,
      ...report.restored.map(f => `  ${f}`));
  }
  if (report.removed.length > 0) {
    lines.push(`${report.removed.length} file(s) created by the agent ${
      action === 'preview' ? 'would be' : 'were'} removed:`,
    ...report.removed.map(f => `  ${f}`));
  }
  if (report.skipped.length > 0) {
    // Named rather than counted: a partial restore that does not say which
    // files it left is one the reader has to verify by hand.
    lines.push(`${report.skipped.length} file(s) left alone — changed since the agent `
      + 'wrote them, so reverting would discard someone else\'s work:',
    ...report.skipped.map(f => `  ${f}`));
  }
  if (report.restored.length === 0 && report.removed.length === 0
      && report.skipped.length === 0) {
    lines.push('Nothing to do — every file is already as it was.');
  }
  return lines.join('\n');
}

export const checkpointDefinition = {
  name: 'Checkpoint',
  description: [
    'Undo file changes. A checkpoint is recorded automatically for every turn that',
    'writes a file, holding each touched file as it was before the turn started.',
    '',
    'actions:',
    '  list    — checkpoints, newest first.',
    '  preview — what a restore would do, without doing it. Call this first.',
    '  restore — put the files back. id defaults to the most recent checkpoint.',
    '',
    'Restore only touches files that are still exactly as the agent left them. Anything',
    'changed since — by the user, their editor, another process — is skipped and named,',
    'so it can never discard work that was not the agent\'s. Files the agent created are',
    'removed on restore, under the same rule.',
    '',
    'Use it when a change has made things worse and unpicking it by hand would be slower',
    'than starting again. Tell the user what you are reverting before you do.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'preview', 'restore'],
        description: 'What to do. Defaults to list.',
      },
      id: { type: 'string', description: 'Checkpoint id. Defaults to the most recent.' },
    },
    required: [] as string[],
  },
};
