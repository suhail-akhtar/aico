export type CronJobStatus = 'enabled' | 'paused' | 'running';

/**
 * What a scheduled run may do.
 *
 * Defaults to `full`, and the reasoning is that a cron job is different from
 * every other kind of unattended work. Nobody can approve anything at 3am — so
 * the alternatives are "act" or "silently do nothing", and a job that quietly
 * refuses itself every night is worse than one that acts, because it looks like
 * it is working. **The user wrote the prompt and chose the schedule; that is the
 * authorization.** Requiring them to also flip a global `autoApprove` is the
 * kind of friction that produces exactly the failure being complained about: a
 * scheduled job that stopped producing anything and never said why.
 *
 * `readonly` is there for a job that only reports — a nightly summary, a
 * dependency scan — where there is no reason to hand it write access at all.
 */
export type CronPermissions = 'full' | 'readonly' | 'inherit';

export interface CronJob {
  id: string;
  name: string;
  /** Standard 5-field cron expression: min hour dom month dow */
  schedule: string;
  prompt: string;
  model?: string;
  cwd: string;
  /** See {@link CronPermissions}. Absent means `full`, for jobs created before this existed. */
  permissions?: CronPermissions;
  status: CronJobStatus;
  createdAt: number;
  /** Unix ms of last run start */
  lastRun?: number;
  /** Unix ms of next scheduled run */
  nextRun?: number;
  runCount: number;
  lastError?: string;
  lastResult?: string;
  /**
   * The ledger id of the most recent firing.
   *
   * Kept so a listing can report what the run actually *did* rather than only
   * that it started. The store knows when a job last fired; only the ledger
   * knows whether that firing finished, failed, was stopped by the user, or is
   * still going four hours later.
   */
  lastRunId?: string;
}

export interface CronStore {
  jobs: CronJob[];
  version: number;
}
