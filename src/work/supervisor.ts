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
import { invokeStop } from './handles.js';
import { ledger } from './ledger.js';
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

  if (policy.idleMs !== undefined) {
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

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, SWEEP_MS);
    // Supervision must never be the reason the process stays up. If the only
    // thing left running is the thing watching for things to run, exit.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
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
      await invokeStop(child.id, action, `parent ${record.id} stopped — ${detail}`);
      ledger.close(child.id, 'cancelled', `Stopped with parent: ${detail}`);
    }

    const stopped = await invokeStop(record.id, action, reason);
    // Closed whether or not a handle answered. Work with no handle is work
    // nothing can stop, and leaving it `running` forever would mean the
    // supervisor reports the same breach on every sweep for the rest of the
    // process's life.
    ledger.close(record.id, 'cancelled', stopped ? reason : `${reason} (no stop handle)`);
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
