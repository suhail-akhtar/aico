import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Panel } from './Panel.js';
import type { BackgroundAgentRecord } from '../../background/index.js';

// Braille spinner — same set used everywhere in Claude Code CLI
const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

function formatElapsed(rec: BackgroundAgentRecord): string {
  const ms = (rec.completedAt ?? Date.now()) - rec.startedAt;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function shortModelName(model: string): string {
  const tail = model.split('/').pop() ?? model;
  return tail
    .replace(/^claude-/, '')
    .replace(/^deepseek-/, 'ds-')
    .replace(/-latest$/, '')
    .replace(/:nitro$/, '')
    .replace(/-\d+.*$/, '')
    .slice(0, 8);
}

/** Heartbeat symbol + color based on time since last activity */
function getHeartbeat(rec: BackgroundAgentRecord): { sym: string; color: string } {
  if (rec.status !== 'running') return { sym: '', color: 'gray' };
  const idle = Date.now() - rec.lastActivityAt;
  if (idle < 5_000)  return { sym: '●', color: 'green' };   // active
  if (idle < 30_000) return { sym: '◐', color: 'yellow' };  // recent
  return { sym: '○', color: 'red' };                         // idle / stalled
}

/**
 * Background agents panel — mirrors Claude Code CLI style:
 *
 *   ╭─ Background Agents (3) · 2 active · 1 done ──────────────────╮
 *   │ ⠙ Generate test suite       haiku  ●  Writing…    12s  (4 ops) │
 *   │ ✓ Update changelog          haiku                 45s  (6 ops) ✉ │
 *   ╰──────────────────────────────────────────────────────────────────╯
 */
export function BackgroundAgentsPanel({ records }: { records: BackgroundAgentRecord[] }) {
  const [frame, setFrame] = useState(0);
  const [, tick] = useState(0); // force re-render to update elapsed times

  const running = records.filter(r => r.status === 'running');

  // 80ms interval matches AgentsPanel and Claude Code CLI's spinner cadence
  useEffect(() => {
    if (!running.length) return;
    const id = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER.length);
      tick(n => n + 1);
    }, 80);
    return () => clearInterval(id);
  }, [running.length]);

  if (!records.length) return null;

  const activeCount = records.filter(r => r.status === 'running' || r.status === 'queued').length;
  const doneCount   = records.filter(r => r.status === 'completed').length;
  const failedCount = records.filter(r => r.status === 'failed').length;

  const parts = [`Background Agents (${records.length})`];
  if (activeCount > 0)  parts.push(`${activeCount} active`);
  if (doneCount > 0)    parts.push(`${doneCount} done`);
  if (failedCount > 0)  parts.push(`${failedCount} failed`);

  return (
    <Panel title={parts.join(' · ')} borderColor="gray">
      {records.slice(0, 8).map(rec => {
        const hb      = getHeartbeat(rec);
        const elapsed = formatElapsed(rec);
        const tc      = rec.toolCallCount;

        const icon =
          rec.status === 'running'   ? SPINNER[frame % SPINNER.length]
          : rec.status === 'queued'    ? '○'
          : rec.status === 'completed' ? '✓'
          : rec.status === 'failed'    ? '✗' : '⊘';

        const iconColor =
          rec.status === 'running'   ? 'cyan'
          : rec.status === 'completed' ? 'green'
          : rec.status === 'failed'    ? 'red' : 'gray';

        const modelShort = shortModelName(rec.model);

        return (
          <Box key={rec.agentId} flexDirection="row">
            {/* Status icon (spinner when running, ✓/✗ when done) */}
            <Box width={2}><Text color={iconColor}>{icon}</Text></Box>

            {/* Description — left-aligned, 36 chars wide */}
            <Box width={36}><Text bold wrap="truncate">{rec.description}</Text></Box>

            {/* Model name — no brackets (matches Claude Code style) */}
            <Box width={8}><Text dimColor wrap="truncate">{modelShort}</Text></Box>

            {/* Heartbeat indicator ●/◐/○ */}
            <Box width={2}>
              {hb.sym
                ? <Text color={hb.color as any}>{hb.sym}</Text>
                : <Text> </Text>}
            </Box>

            {/* Current tool or blank when idle */}
            <Box width={18}>
              {rec.status === 'running' && rec.currentTool
                ? <Text dimColor wrap="truncate">{rec.currentTool}</Text>
                : <Text> </Text>}
            </Box>

            {/* Elapsed time */}
            <Box width={6}><Text dimColor>{elapsed}</Text></Box>

            {/* Op count */}
            {tc > 0 && <Text dimColor>({tc} ops)</Text>}

            {/* Notification badge — shown when completed and notification was pushed */}
            {rec.notified && rec.status === 'completed' && (
              <Text color="cyan">  ✉</Text>
            )}
          </Box>
        );
      })}
    </Panel>
  );
}
