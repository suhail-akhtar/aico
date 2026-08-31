/**
 * The supervisor: limits enforced by the loop, not requested of the model.
 *
 * A model told "stop the agent if it gets too expensive" has to remember to
 * look, decide what "too expensive" means, and then act — three separate
 * chances to not. This repo has already been bitten by that shape twice, and
 * the lesson stuck: put the rule where it runs, not where it is read.
 *
 * So an orchestrator sets a {@link SupervisionPolicy} once, and this sweeps.
 *
 * ## One timer, not one per job
 *
 * A timer per supervised record is the obvious design and the wrong one: fifty
 * background agents becomes fifty timers, each waking the event loop on its own
 * schedule, and each needing to be cleared on every exit path — including the
 * ones that throw. One interval over the ledger has a fixed cost regardless of
 * load, and nothing to leak.
 *
 * ## Why idle is not the same as slow
 *
 * `deadlineMs` and `idleMs` look interchangeable and are not. An agent that has
 * worked hard for an hour and one that has made no tool call in ten minutes are
 * different failures, and a single timeout kills the wrong one. The harness in
 * this repo learned the same distinction the hard way: an assertion that
 * accepted "or it already finished" let a sub-agent making *zero* tool calls
 * count as making progress. Zero progress is not slow progress.
 *
 * @module work/supervisor
 */

import { pushNotification } from '../background/notifications.js';
import { stopWork } from './handles.js';
import { ledger } from './ledger.js';
import { isTerminal, reportsProgress } from './types.js';
import type { SupervisionPolicy, WorkRecord } from './types.js';

/** How often the ledger is swept. */
const SWEEP_MS = 5_000;

/** Which limit was hit. Reported verbatim, so the reason is never a guess. */
export type BreachKind = 'deadline' | 'cost' | 'steps' | 'idle';

export interface Breach {
  record: WorkRecord;
  kind: BreachKind;
  /** Human-readable, and the text carried into the stop reason. */
  detail: string;
}

/**
 * Check one record against its policy.
 *
 * Exported so the rule can be tested without a clock, a timer or a running
 * agent. Every check here is a comparison against two numbers; the value of
 * testing it is in the *ordering* — a record over both its deadline and its
 * budget should report the one that fires first in the list, so the reason a
 * user reads is stable rather than dependent on sweep timing.
 */
export function evaluate(record: WorkRecord, now: number): Breach | undefined {
  const policy = record.policy;
  if (!policy) return undefined;

  if (policy.deadlineMs !== undefined) {
    const age = now - record.startedAt;
    if (age > policy.deadlineMs) {
      return {
        record, kind: 'deadline',
        detail: `ran ${Math.round(age / 1000)}s, over its ${Math.round(policy.deadlineMs / 1000)}s deadline`,
      };
    }
  }

  if (policy.maxCostUsd !== undefined && record.cost && record.cost.usd > policy.maxCostUsd) {
    return {
      record, kind: 'cost',
      detail: `spent $${record.cost.usd.toFixed(2)}, over its $${policy.maxCostUsd.toFixed(2)} ceiling`,
    };
  }

  if (policy.maxSteps !== undefined && (record.progress?.steps ?? 0) > policy.maxSteps) {
    return {
      record, kind: 'steps',
      detail: `made ${record.progress?.steps} steps, over its ${policy.maxSteps} limit`,
    };
  }

  // Only where silence means something. A process has no heartbeat to give —
  // its liveness is the pid — so an idle rule on one would fire on every
  // healthy server after the first interval.
  if (policy.idleMs !== undefined && reportsProgress(record.kind)) {
    const idle = now - record.heartbeatAt;
    if (idle > policy.idleMs) {
      return {
        record, kind: 'idle',
        detail: `no activity for ${Math.round(idle / 1000)}s`
          + (record.progress?.lastTool ? ` — last inside ${record.progress.lastTool}` : ''),
      };
    }
  }

  return undefined;
}

function shouldNotify(policy: SupervisionPolicy, moment: 'breach' | 'finish'): boolean {
  const when = policy.notify ?? 'on-breach';
  if (when === 'never') return false;
  if (when === 'always') return true;
  return when === (moment === 'breach' ? 'on-breach' : 'on-finish');
}

class Supervisor {
  private timer: NodeJS.Timeout | undefined;
  /** Ids already acted on, so one breach does not fire on every sweep. */
  private acted = new Set<string>();
  /**
   * Re-entrancy guard for the subscriber.
   *
   * Acting on a breach closes a record, which emits, which re-enters the
   * subscriber. Without this the second pass would run against a half-finished
   * first one, and a parent stopping its children would recurse through every
   * emit each child produced on its way down.
   */
  private checking = false;

  private unsubscribe: (() => void) | undefined;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, SWEEP_MS);
    // Supervision must never be the reason the process stays up. If the only
    // thing left running is the thing watching for things to run, exit.
    this.timer.unref?.();

    /*
      Cost and step ceilings are also checked the moment they change.

      The sweep alone is enough for `deadlineMs` and `idleMs`, which become true
      by the passage of time and cannot be missed by waiting. It is not enough
      for `maxCostUsd` and `maxSteps`: those become true at a token report, and
      a five-second sweep window is five seconds of unbounded spend on a fast
      model — or, as a live probe found, a job that breached its ceiling,
      finished, and was never noticed at all.

      Cheap enough to run on every beat: it looks only at records that carry a
      policy, and each check is a pair of comparisons.
    */
    this.unsubscribe = ledger.subscribe(records => {
      if (this.checking) return;
      const now = Date.now();
      const hot = records.filter(r =>
        r.policy && !this.acted.has(r.id) && !isTerminal(r.state) && r.state !== 'blocked'
        && (r.policy.maxCostUsd !== undefined || r.policy.maxSteps !== undefined));
      if (!hot.length) return;
      this.checking = true;
      void (async () => {
        try {
          for (const record of hot) {
            const breach = evaluate(record, now);
            // Only the event-driven limits act here. A deadline that expires
            // during someone else's heartbeat is the sweep's business, and
            // acting on it from inside a subscriber would make the reason
            // depend on which unrelated record happened to beat first.
            if (!breach || (breach.kind !== 'cost' && breach.kind !== 'steps')) continue;
            this.acted.add(record.id);
            await this.act(breach);
          }
        } finally {
          this.checking = false;
        }
      })();
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * One pass. Exported through {@link sweepOnce} so tests can drive it
   * deterministically rather than waiting five seconds a case.
   */
  async sweep(now = Date.now()): Promise<Breach[]> {
    const breaches: Breach[] = [];
    for (const record of ledger.query({ live: true })) {
      // `blocked` is waiting on purpose. Applying an idle timer to work that is
      // deliberately parked is how a watcher gets killed for watching.
      if (record.state === 'blocked') continue;
      if (this.acted.has(record.id)) continue;

      const breach = evaluate(record, now);
      if (!breach) continue;

      breaches.push(breach);
      this.acted.add(record.id);
      await this.act(breach);
    }

    // Ids only stay marked while they are still live, so a reused id or a
    // record that came back cannot inherit a previous breach.
    for (const id of [...this.acted]) {
      const record = ledger.get(id);
      if (!record || record.state === 'done' || record.state === 'failed'
        || record.state === 'cancelled' || record.state === 'lost') {
        this.acted.delete(id);
      }
    }
    return breaches;
  }

  private async act(breach: Breach): Promise<void> {
    const { record, detail } = breach;
    const policy = record.policy!;
    const action = policy.onBreach;
    const reason = `Supervisor: ${detail}`;

    if (shouldNotify(policy, 'breach')) {
      pushNotification({
        title: action === 'report'
          ? `${record.title} passed a limit`
          : `${record.title} ${action === 'kill' ? 'killed' : 'stopped'}`,
        body: detail,
        level: action === 'report' ? 'warning' : 'error',
        sourceId: record.id,
      });
    }

    if (action === 'report') {
      // Left running on purpose. Recorded on the progress note so the next
      // listing shows it was flagged rather than looking untouched.
      ledger.beat(record.id, { note: `over limit — ${detail}` });
      return;
    }

    // Children first: stopping a parent that is waiting inside a child leaves
    // the child running and the parent's abort landing on nothing.
    for (const child of ledger.descendants(record.id).reverse()) {
      if (child.state === 'done' || child.state === 'failed'
        || child.state === 'cancelled' || child.state === 'lost') continue;
      await stopWork(child.id, action, `parent ${record.id} stopped — ${detail}`,
        () => { ledger.close(child.id, 'cancelled', `Stopped with parent: ${detail}`); });
    }

    let stopped = false;
    await stopWork(record.id, action, reason, () => {
      // Written before the stop lands, so this reason is the one on the record
      // rather than whatever the stopped subsystem says about itself.
      ledger.close(record.id, 'cancelled', reason);
    }).then(ok => { stopped = ok; });
    // Work with no handle is work nothing can stop. It is still closed — above,
    // before the attempt — because leaving it `running` forever would mean the
    // supervisor reports the same breach on every sweep for the rest of the
    // process's life. The note only says so.
    if (!stopped) {
      ledger.beat(record.id, { note: `${reason} (no stop handle — recorded, not signalled)` });
    }
  }

  /** Tests only. */
  resetForTest(): void {
    this.stop();
    this.acted.clear();
  }
}

export const supervisor = new Supervisor();

/** Run one sweep now. The testable entry point. */
export function sweepOnce(now?: number): Promise<Breach[]> {
  return supervisor.sweep(now);
}
