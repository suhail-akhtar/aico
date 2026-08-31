/**
 * A cron firing, as a supervised piece of work.
 *
 * The first version of this closed the firing record the instant it had
 * dispatched, so the ledger showed a scheduled job as **done** while the work
 * it started was still going — and a job that then failed at 3am appeared
 * nowhere near its schedule. "Did last night's job work?" could not be answered
 * from the one place that is supposed to know what is running.
 *
 * So the firing now lives as long as the work does:
 *
 * - It opens `running` when the schedule fires.
 * - The spawned agent becomes its **child**, so the tree reads
 *   `schedule → agent`, and stopping the schedule stops the agent under it.
 * - It closes with the agent's own outcome, which is what makes *done*,
 *   *failed*, *stopped by the user* and *stopped by a limit* four visible
 *   states rather than one.
 *
 * Split into its own module because the scheduler must not import the ledger
 * mirror: `cron/scheduler` → `work/adapters` → `background` → `cron/scheduler`
 * is a cycle, and the scheduler is imported at boot.
 *
 * @module work/cron-run
 */

import { cancelBackgroundAgent, subscribeToBackgroundAgents } from '../background/index.js';
import { registerStopHandle } from './handles.js';
import { ledger } from './ledger.js';
import { isTerminal } from './types.js';

/** Open the firing. Returns its ledger id. */
export function openCronFiring(job: { id: string; name: string }, at = Date.now()): string {
  const id = `cron:${job.id}:${at}`;
  ledger.open({
    id,
    kind: 'schedule',
    title: job.name,
    origin: 'cron',
  });
  return id;
}

/**
 * Attach the spawned agent to the firing and follow it to its end.
 *
 * Subscription rather than polling: the ledger already emits on every change,
 * so the firing settles on the same tick the agent does.
 *
 * The stop handle is registered on the *firing*, so `Supervise stop` against a
 * scheduled run reaches the agent actually doing the work — otherwise stopping
 * a cron job would close a bookkeeping record and leave the run going.
 */
export function followCronFiring(firingId: string, agentId: string): void {
  // Parenting is best-effort: it makes the tree readable and lets `descendants`
  // reach the agent, but it depends on the ledger mirror running. Following the
  // outcome does *not* — see below.
  const mirrored = ledger.get(`bg:${agentId}`);
  if (mirrored) mirrored.parent = firingId;

  registerStopHandle(firingId, () => {
    // Stopping the schedule means stopping the work it started.
    cancelBackgroundAgent(agentId);
  });

  /*
    Subscribed to the background registry, not to the ledger.

    The ledger only learns about a background agent through the mirror, and the
    mirror is started by `initializeFeatures`. Watching the ledger therefore
    made the firing's outcome depend on whether some *other* subsystem had been
    brought up — and where it had not, the firing simply stayed `running`
    forever with no error and nothing to look at. A live probe caught exactly
    that: the firing appeared, the work ran, and the schedule showed "running
    for 421s" indefinitely.

    The registry is the source of truth for a background agent's state, so
    reading it directly makes this correct in every entry point rather than
    only in the one that happens to boot everything.
  */
  const unsubscribe = subscribeToBackgroundAgents(records => {
    const agent = records.find(r => r.agentId === agentId);
    // Gone from the registry entirely: nothing further is coming, and leaving
    // the firing open would be the same silent hang in a different shape.
    if (!agent) {
      unsubscribe();
      if (!isTerminal(ledger.get(firingId)?.state ?? 'running')) {
        ledger.close(firingId, 'lost', 'The run disappeared before reporting an outcome');
      }
      return;
    }
    if (agent.status !== 'completed' && agent.status !== 'failed' && agent.status !== 'cancelled') {
      return;
    }
    unsubscribe();

    const firing = ledger.get(firingId);
    if (!firing || isTerminal(firing.state)) return;

    // Roll the run's spend and step count onto the schedule. "What did last
    // night's job cost?" is a question about the job, and the cost lives on the
    // agent — leaving it there means the schedule reports a run with no price.
    const mirroredNow = ledger.get(`bg:${agentId}`);
    ledger.beat(firingId, {
      steps: mirroredNow?.progress?.steps ?? agent.toolCallCount,
    }, mirroredNow?.cost);

    // The firing inherits the agent's verdict, including *why*. A run the user
    // stopped and a run that crashed are both "not done", and a schedule
    // listing that cannot tell them apart is one that invites the wrong fix.
    if (agent.status === 'completed') {
      ledger.close(firingId, 'done', agent.result ?? 'Completed');
    } else if (agent.status === 'cancelled') {
      ledger.close(firingId, 'cancelled', agent.error ?? agent.statusMessage ?? 'Stopped');
    } else {
      ledger.close(firingId, 'failed', agent.error ?? 'Failed');
    }
  });
}

/**
 * How many scheduled runs are actually in flight.
 *
 * Counted from the ledger rather than kept as a tally, because the tally was
 * wrong. `_runningCount` was incremented when a job fired and decremented in
 * the `finally` of the dispatch — but dispatch is fire-and-forget, so it
 * returned in milliseconds while the run went on for minutes. The effect was
 * that `maxConcurrentJobs` counted *dispatches in progress*, which is never
 * more than one, and therefore limited nothing at all.
 */
export function liveCronFirings(): number {
  return ledger.query({ kind: 'schedule', live: true }).length;
}

/**
 * Is this job's previous run still going?
 *
 * The overlap every cron system has to answer for: a job scheduled every
 * minute that takes an hour will otherwise start sixty copies of itself, each
 * one making the next slower. Skipping is the right default — a run that is
 * still going is doing the work the next one was going to do.
 */
export function cronFiringInFlight(runId: string | undefined): boolean {
  if (!runId) return false;
  const record = ledger.get(runId);
  return Boolean(record && !isTerminal(record.state));
}

/** Close a firing that never got as far as starting anything. */
export function failCronFiring(firingId: string, reason: string): void {
  ledger.close(firingId, 'failed', reason);
}

/**
 * What the most recent firing of each job actually did.
 *
 * The store knows when a job last *started*. Only the ledger knows whether that
 * run finished, failed, was stopped, or is still going — which is the part
 * somebody asking "is my nightly job working?" wants.
 */
export function cronFiringSummary(runId: string | undefined): string | undefined {
  if (!runId) return undefined;
  const record = ledger.get(runId);
  if (!record) return undefined;
  const outcome = record.error ?? record.result;
  const age = Math.round((Date.now() - record.startedAt) / 1000);
  return `${record.state}`
    + (record.state === 'running' ? ` for ${age}s` : '')
    + (record.cost?.usd ? ` · $${record.cost.usd.toFixed(4)}` : '')
    + (outcome ? ` · ${outcome.replace(/\s*\n+\s*/g, ' ').slice(0, 160)}` : '');
}
