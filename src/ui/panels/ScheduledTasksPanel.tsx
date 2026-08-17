import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Panel } from './Panel.js';
import type { CronJob } from '../../cron/types.js';

// Braille spinner at 80ms — matches Claude Code CLI cadence
const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

/** Human-readable "next run" relative to now */
function formatNextRun(nextRun: number | undefined): string {
  if (!nextRun) return 'unknown';
  const diff = nextRun - Date.now();
  if (diff < 0) return 'overdue';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * Scheduled tasks panel — mirrors Claude Code CLI style:
 *
 *   ╭─ Scheduled Tasks (4 · 3 enabled) ──────────────────────────╮
 *   │ ⠙ nightly-audit         0 2 * * *      running now…         │
 *   │ ● daily-review          0 9 * * 1-5    next: in 6h 23m      │
 *   │ ○ old-task              * /30 * * * *  paused               │
 *   ╰─────────────────────────────────────────────────────────────╯
 */
export function ScheduledTasksPanel({ jobs }: { jobs: CronJob[] }) {
  const [frame, setFrame] = useState(0);
  const [, tick] = useState(0); // force re-render to update next-run countdowns

  const running = jobs.filter(j => j.status === 'running');

  // 80ms to keep spinner in sync with the rest of the panel system
  useEffect(() => {
    if (!running.length) return;
    const id = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER.length);
      tick(n => n + 1);
    }, 80);
    return () => clearInterval(id);
  }, [running.length]);

  if (!jobs.length) return null;

  const enabledCount = jobs.filter(j => j.status === 'enabled' || j.status === 'running').length;
  const title = `Scheduled Tasks (${jobs.length} · ${enabledCount} enabled)`;

  return (
    <Panel title={title} borderColor="magenta">
      {jobs.slice(0, 6).map(job => {
        const icon =
          job.status === 'running' ? SPINNER[frame % SPINNER.length]
          : job.status === 'enabled' ? '●'
          : '○'; // paused

        const iconColor =
          job.status === 'running' ? 'cyan'
          : job.status === 'enabled' ? 'magenta' : 'gray';

        return (
          <Box key={job.id} flexDirection="row">
            {/* Status icon */}
            <Box width={2}><Text color={iconColor as any}>{icon}</Text></Box>

            {/* Job name — 22 chars */}
            <Box width={22}><Text bold>{job.name.slice(0, 21)}</Text></Box>

            {/* Cron expression — 16 chars */}
            <Box width={16}><Text dimColor>{job.schedule}</Text></Box>

            {/* Next run / current status */}
            {job.status === 'running'
              ? <Text dimColor>running now…</Text>
              : job.status === 'paused'
                ? <Text dimColor>paused</Text>
                : <Text dimColor>next: {formatNextRun(job.nextRun)}</Text>}

            {/* Error indicator — last run failed */}
            {job.lastError && <Text color="red">  ✗</Text>}
          </Box>
        );
      })}
    </Panel>
  );
}
