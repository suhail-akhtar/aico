import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Panel } from './Panel.js';
import type { WorktreeRecord } from '../../worktree/index.js';

// Braille spinner at 80ms — matches Claude Code CLI cadence
const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

/**
 * Worktree isolation panel — mirrors Claude Code CLI style:
 *
 *   ╭─ Worktrees (2 active) ──────────────────────────────────────╮
 *   │ ● worktrees/a1b2c3d4    aico/worktree/a1b2   * changes       │
 *   │ ● worktrees/e5f6a7b8    aico/worktree/e5f6   clean           │
 *   ╰─────────────────────────────────────────────────────────────╯
 */
export function WorktreePanel({ records }: { records: WorktreeRecord[] }) {
  const [frame, setFrame] = useState(0);

  const active = records.filter(r => r.status === 'creating' || r.status === 'active');

  // Use 80ms to match the rest of the panel system
  useEffect(() => {
    if (!active.length) return;
    const id = setInterval(() => setFrame(f => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(id);
  }, [active.length]);

  if (!records.length) return null;

  return (
    <Panel title={`Worktrees (${active.length} active)`} borderColor="blue">
      {records.slice(0, 6).map(rec => {
        // Show last two path segments: ".aico/worktrees/a1b2c3d4"
        const shortPath   = rec.path.split(/[\\/]/).slice(-2).join('/');
        // Strip common prefix: "aico/worktree/a1b2c3d4" → "a1b2c3d4"
        const shortBranch = rec.branch.replace('aico/worktree/', '');

        const icon =
          rec.status === 'creating' ? SPINNER[frame % SPINNER.length]
          : rec.status === 'active'  ? '●'
          : rec.status === 'merged'  ? '✓'
          : rec.status === 'cleaned' ? '○'
          : '✗'; // failed

        const iconColor =
          rec.status === 'creating' ? 'cyan'
          : rec.status === 'active'   ? 'blue'
          : rec.status === 'merged'   ? 'green'
          : rec.status === 'failed'   ? 'red' : 'gray';

        return (
          <Box key={rec.worktreeId} flexDirection="row">
            {/* Status icon */}
            <Box width={2}><Text color={iconColor as any}>{icon}</Text></Box>

            {/* Worktree path — 34 chars */}
            <Box width={34}><Text dimColor>{shortPath}</Text></Box>

            {/* Branch name — 20 chars */}
            <Box width={20}><Text color="blue">{shortBranch}</Text></Box>

            {/* Changes / clean status */}
            {rec.hasChanges
              ? <Text color="yellow">* changes</Text>
              : rec.status === 'active'
                ? <Text dimColor>clean</Text>
                : null}

            {/* Error summary for failed worktrees */}
            {rec.status === 'failed' && rec.changesSummary && (
              <Text color="red">  {rec.changesSummary.slice(0, 30)}</Text>
            )}
          </Box>
        );
      })}
    </Panel>
  );
}
