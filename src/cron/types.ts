export type CronJobStatus = 'enabled' | 'paused' | 'running';

export interface CronJob {
  id: string;
  name: string;
  /** Standard 5-field cron expression: min hour dom month dow */
  schedule: string;
  prompt: string;
  model?: string;
  cwd: string;
  status: CronJobStatus;
  createdAt: number;
  /** Unix ms of last run start */
  lastRun?: number;
  /** Unix ms of next scheduled run */
  nextRun?: number;
  runCount: number;
  lastError?: string;
  lastResult?: string;
}

export interface CronStore {
  jobs: CronJob[];
  version: number;
}
