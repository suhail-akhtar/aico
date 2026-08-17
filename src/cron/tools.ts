import { cronScheduler } from './scheduler.js';
import type { CronJob } from './types.js';

export const cronCreateToolDefinition = {
  name: 'CronCreate',
  description: 'Create a scheduled cron job that runs a prompt on a recurring schedule.',
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
}): Promise<CronJob> {
  return cronScheduler.createJob(args);
}

export async function executeCronDelete(args: { job_id: string }): Promise<{ deleted: boolean }> {
  await cronScheduler.deleteJob(args.job_id);
  return { deleted: true };
}

export function executeCronList(): CronJob[] {
  return cronScheduler.getJobs();
}

export async function executeCronPause(args: { job_id: string }): Promise<{ paused: boolean }> {
  await cronScheduler.pauseJob(args.job_id);
  return { paused: true };
}

export async function executeCronResume(args: { job_id: string }): Promise<{ resumed: boolean }> {
  await cronScheduler.resumeJob(args.job_id);
  return { resumed: true };
}
