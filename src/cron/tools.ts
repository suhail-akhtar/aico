import { cronScheduler } from './scheduler.js';
import { cronFiringSummary } from '../work/cron-run.js';
import type { CronJob } from './types.js';

export const cronCreateToolDefinition = {
  name: 'CronCreate',
  description:
    'Create a scheduled job that runs a prompt on a recurring schedule.\n\n'
    + 'Scheduled runs are unattended: nothing can ask the user anything, so the job is '
    + 'given full tool access by default — writing the prompt and choosing the schedule '
    + 'IS the authorization. Set permissions to "readonly" for a job that only needs to '
    + 'report (a nightly summary, a dependency scan), which is safer and just as useful '
    + 'for those.\n\n'
    + 'A run that is still going does not start a second copy of itself, and every firing '
    + 'is visible through Supervise with its own outcome.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human-readable name for this job' },
      schedule: {
        type: 'string',
        description: 'Standard 5-field cron expression (e.g. "0 9 * * 1-5" for 9am Mon-Fri)',
      },
      prompt: {
        type: 'string',
        description: 'The task prompt to run on schedule',
      },
      model: {
        type: 'string',
        description: 'Model override (optional)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the job (default: current directory)',
      },
      permissions: {
        type: 'string',
        enum: ['full', 'readonly'],
        description: 'What the run may do. "full" (default) can run commands and change '
          + 'files; "readonly" can only read and report. There is no third option that '
          + 'asks — nobody is there to answer.',
      },
    },
    required: ['name', 'schedule', 'prompt'],
  },
};

export const cronDeleteToolDefinition = {
  name: 'CronDelete',
  description: 'Delete a scheduled cron job by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The cron job ID to delete' },
    },
    required: ['job_id'],
  },
};

export const cronListToolDefinition = {
  name: 'CronList',
  description: 'List all scheduled cron jobs.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export const cronPauseToolDefinition = {
  name: 'CronPause',
  description: 'Pause a scheduled cron job (it will not run until resumed).',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The cron job ID to pause' },
    },
    required: ['job_id'],
  },
};

export const cronResumeToolDefinition = {
  name: 'CronResume',
  description: 'Resume a paused cron job.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The cron job ID to resume' },
    },
    required: ['job_id'],
  },
};

// ── Execute functions ──────────────────────────────────────────────────

export async function executeCronCreate(args: {
  name: string;
  schedule: string;
  prompt: string;
  model?: string;
  cwd?: string;
  permissions?: CronJob['permissions'];
}): Promise<CronJob> {
  return cronScheduler.createJob(args);
}

export async function executeCronDelete(args: { job_id: string }): Promise<{ deleted: boolean }> {
  await cronScheduler.deleteJob(args.job_id);
  return { deleted: true };
}

/**
 * Every job, with what its last firing actually did.
 *
 * The store records when a job last *started*. That is not the question anyone
 * is asking: "is my nightly job working?" needs to know whether the run
 * finished, failed, was stopped, or is still going four hours later — and only
 * the ledger knows that. Folding it in here is what turns a schedule listing
 * into an answer.
 */
export function executeCronList(): Array<CronJob & { lastOutcome?: string }> {
  return cronScheduler.getJobs().map(job => {
    const lastOutcome = cronFiringSummary(job.lastRunId);
    return lastOutcome ? { ...job, lastOutcome } : { ...job };
  });
}

export async function executeCronPause(args: { job_id: string }): Promise<{ paused: boolean }> {
  await cronScheduler.pauseJob(args.job_id);
  return { paused: true };
}

export async function executeCronResume(args: { job_id: string }): Promise<{ resumed: boolean }> {
  await cronScheduler.resumeJob(args.job_id);
  return { resumed: true };
}
