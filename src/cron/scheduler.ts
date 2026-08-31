import { randomUUID } from 'crypto';
import type { CronJob } from './types.js';
import { loadCronStore, persistJob, removePersistedJob } from './store.js';
import { pushNotification } from '../background/notifications.js';
import { runHooks } from '../hooks.js';
import {
  cronFiringInFlight, failCronFiring, followCronFiring, liveCronFirings, openCronFiring,
} from '../work/cron-run.js';
import type { AicoSettings } from '../settings.js';

type SubscriberFn = (jobs: CronJob[]) => void;

/** Minimal 5-field cron expression parser — no external deps */
function fieldMatches(value: number, expr: string): boolean {
  if (expr === '*') return true;
  if (expr.startsWith('*/')) {
    const step = parseInt(expr.slice(2), 10);
    return !isNaN(step) && value % step === 0;
  }
  if (expr.includes('-')) {
    const [lo, hi] = expr.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  if (expr.includes(',')) {
    return expr.split(',').map(Number).includes(value);
  }
  const n = parseInt(expr, 10);
  return !isNaN(n) && value === n;
}

/**
 * Returns true if the given Date matches the cron schedule.
 * Fields: min hour dom month dow
 */
export function cronMatches(schedule: string, date: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minE, hourE, domE, monE, dowE] = parts;
  return (
    fieldMatches(date.getMinutes(), minE) &&
    fieldMatches(date.getHours(), hourE) &&
    fieldMatches(date.getDate(), domE) &&
    fieldMatches(date.getMonth() + 1, monE) &&
    fieldMatches(date.getDay(), dowE)
  );
}

/**
 * Compute the next run time (ms) for a cron schedule from a given start.
 * Scans forward minute-by-minute, up to 1 year.
 */
export function parseNextRun(schedule: string, fromMs = Date.now()): number {
  const d = new Date(fromMs);
  // Advance to next minute boundary
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const limit = fromMs + 365 * 24 * 60 * 60 * 1000;
  while (d.getTime() < limit) {
    if (cronMatches(schedule, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return d.getTime();
}

interface SchedulerOpts {
  token: string;
  model: string;
  autoApprove: boolean;
  settings?: AicoSettings;
  maxConcurrentJobs?: number;
}

class CronScheduler {
  private _jobs = new Map<string, CronJob>();
  private _tickTimer?: ReturnType<typeof setInterval>;
  private _subscribers: SubscriberFn[] = [];
  private _opts: SchedulerOpts | null = null;
  private _runningCount = 0;

  async start(opts: SchedulerOpts): Promise<void> {
    this._opts = opts;

    // Load persisted jobs
    const persisted = await loadCronStore();
    for (const job of persisted) {
      // Reset 'running' status left over from a crashed session
      if (job.status === 'running') job.status = 'enabled';
      job.nextRun = parseNextRun(job.schedule);
      this._jobs.set(job.id, job);
    }
    this._emit();

    // Tick every 30 seconds
    this._tickTimer = setInterval(() => { void this._tick(); }, 30_000);
    if (this._tickTimer.unref) this._tickTimer.unref();
  }

  stop(): void {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = undefined;
    }
  }

  private async _tick(): Promise<void> {
    if (!this._opts) return;
    const now = Date.now();
    const maxJobs = this._opts.settings?.cron?.maxConcurrentJobs ?? 3;

    for (const job of this._jobs.values()) {
      if (job.status !== 'enabled') continue;
      // Counted from the ledger, not from a tally. The tally was incremented on
      // fire and decremented in the dispatch's `finally` — but dispatch is
      // fire-and-forget and returns in milliseconds, so it only ever counted
      // dispatches in progress and limited nothing.
      if (liveCronFirings() >= maxJobs) break;
      if (!job.nextRun || now < job.nextRun) continue;

      void this._runJob(job);
    }
  }

  private async _runJob(job: CronJob): Promise<void> {
    if (!this._opts) return;

    /*
      A job whose previous run has not finished does not start another.

      Guarded here rather than in the tick, because the tick is not the only way
      in — `runJobNow` calls this directly, and a guard on one path is a guard
      that the other path proves does not exist. One job scheduled every minute
      that takes an hour would otherwise stack sixty copies of itself, each
      making the next slower, and the run already going is doing the work this
      one was for.
    */
    if (cronFiringInFlight(job.lastRunId)) {
      job.nextRun = parseNextRun(job.schedule);
      this._emit();
      return;
    }

    this._runningCount++;
    job.status = 'running';
    job.lastRun = Date.now();
    this._emit();

    // CronJobStart hook
    if (this._opts.settings) {
      await runHooks('CronJobStart', { event: 'CronJobStart', agentId: job.id }, this._opts.settings).catch(() => {});
    }

    /*
      The firing, as distinct from the job.

      The job is configuration and lives in the store; this is the occurrence.
      It stays open for as long as the work does — an earlier version closed it
      the moment it had dispatched, which meant the ledger showed a scheduled
      job as *done* while its agent was still running, and a job that failed at
      3am appeared nowhere near its schedule.
    */
    const firingId = openCronFiring(job);
    job.lastRunId = firingId;

    try {
      // Use dynamic import to avoid circular dependency
      const { spawnBackgroundAgent } = await import('../background/index.js');
      const spawnedId = spawnBackgroundAgent(
        { description: `[cron] ${job.name}`, prompt: job.prompt, model: job.model },
        {
          token: this._opts.token,
          model: this._opts.model,
          autoApprove: this._opts.autoApprove,
          verbose: false,
          settings: this._opts.settings,
          cwd: job.cwd,
          // Nobody can approve anything at 3am, so the alternatives are "act"
          // or "silently do nothing" — and a job that refuses itself every
          // night is worse than one that acts, because it looks like it is
          // working. The user wrote the prompt and chose the schedule; that is
          // the authorization. Set `permissions: 'readonly'` on a job that only
          // needs to report.
          permissions: job.permissions ?? 'full',
        },
      );

      // The firing now follows the agent to its end, so stopping the schedule
      // stops the run and the outcome lands back on the schedule's own record.
      followCronFiring(firingId, spawnedId);

      job.status = 'enabled';
      job.runCount++;
      job.nextRun = parseNextRun(job.schedule);
      job.lastError = undefined;
      await persistJob(job);

      if (this._opts.settings) {
        await runHooks('CronJobComplete', { event: 'CronJobComplete', agentId: job.id }, this._opts.settings).catch(() => {});
      }
    } catch (err) {
      job.status = 'enabled';
      job.runCount++;
      job.lastError = err instanceof Error ? err.message : String(err);
      job.nextRun = parseNextRun(job.schedule);
      failCronFiring(firingId, job.lastError);
      await persistJob(job);

      pushNotification({
        title: `Cron job failed: ${job.name}`,
        body: job.lastError,
        level: 'error',
        sourceId: job.id,
      });

      if (this._opts.settings) {
        await runHooks('CronJobFailed', { event: 'CronJobFailed', agentId: job.id }, this._opts.settings).catch(() => {});
      }
    } finally {
      this._runningCount--;
      this._emit();
    }
  }

  async createJob(params: {
    name: string;
    schedule: string;
    prompt: string;
    model?: string;
    cwd?: string;
    permissions?: CronJob['permissions'];
  }): Promise<CronJob> {
    const job: CronJob = {
      id: randomUUID(),
      name: params.name,
      schedule: params.schedule,
      prompt: params.prompt,
      model: params.model,
      cwd: params.cwd ?? process.cwd(),
      permissions: params.permissions ?? 'full',
      status: 'enabled',
      createdAt: Date.now(),
      nextRun: parseNextRun(params.schedule),
      runCount: 0,
    };

    this._jobs.set(job.id, job);
    await persistJob(job);
    this._emit();
    return job;
  }

  async deleteJob(id: string): Promise<void> {
    this._jobs.delete(id);
    await removePersistedJob(id);
    this._emit();
  }

  async pauseJob(id: string): Promise<void> {
    const job = this._jobs.get(id);
    if (job && job.status !== 'running') {
      job.status = 'paused';
      await persistJob(job);
      this._emit();
    }
  }

  async resumeJob(id: string): Promise<void> {
    const job = this._jobs.get(id);
    if (job && job.status === 'paused') {
      job.status = 'enabled';
      job.nextRun = parseNextRun(job.schedule);
      await persistJob(job);
      this._emit();
    }
  }

  async runJobNow(id: string): Promise<void> {
    const job = this._jobs.get(id);
    if (job) void this._runJob(job);
  }

  getJobs(): CronJob[] {
    return Array.from(this._jobs.values());
  }

  subscribe(fn: SubscriberFn): () => void {
    this._subscribers.push(fn);
    fn(this.getJobs());
    return () => {
      const idx = this._subscribers.indexOf(fn);
      if (idx !== -1) this._subscribers.splice(idx, 1);
    };
  }

  private _emit(): void {
    const jobs = this.getJobs();
    for (const fn of this._subscribers) fn(jobs);
  }
}

export const cronScheduler = new CronScheduler();
