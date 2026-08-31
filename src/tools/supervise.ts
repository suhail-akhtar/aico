/**
 * `Supervise` — one tool over everything that is running.
 *
 * It replaces `AgentSupervise`, which could see sub-agents and nothing else. A turn that had also
 * backgrounded a dev server, scheduled a job and spawned a background agent had
 * to reach for a different tool for each — and had no way at all to ask the
 * question that actually matters between turns: *what is still going, and what
 * finished while I was not looking?*
 *
 * ## Why one tool and not seven
 *
 * Every action here is `list`, `stop`, `guide`, `wait`, `watch` or `policy`
 * against an id. Eight tools would be eight schemas in every request, eight names for the
 * model to choose between, and — the part that costs real turns — seven round
 * trips when a step needs two of them. One tool with an `action` and **array
 * arguments** means stopping three runaway children is one call, not three.
 *
 * ## Reporting is a state, not an event
 *
 * `list` defaults to unreported outcomes plus everything live, and marks
 * nothing as read. `ack` is what marks it. That split exists because the
 * alternative — clearing outcomes when they are listed — loses a failure to any
 * turn that listed it and then did something else. Work that finished stays on
 * offer until the orchestrator says it has dealt with it.
 *
 * @module tools/supervise
 */

import { currentRunContext } from '../run-context.js';
import { stopWork, takeStopHandle } from '../work/handles.js';
import { ledger } from '../work/ledger.js';
import { supervisor } from '../work/supervisor.js';
import { unwatch, watch } from '../work/watchers.js';
import { guideAgent, owningSession } from './task.js';
import type { SupervisionPolicy, WatchSpec, WorkRecord } from '../work/types.js';
import { isTerminal, reportsProgress } from '../work/types.js';

export interface SuperviseInput {
  action: 'list' | 'stop' | 'guide' | 'wait' | 'watch' | 'unwatch' | 'policy' | 'ack';
  /** One id, or several. Every id-taking action accepts a batch. */
  id?: string | string[];
  /** Why. Required for `stop` — see the note in the stop branch. */
  reason?: string;
  /** The correction, for `guide`. */
  message?: string;
  /** For `list`: include finished work that has already been acknowledged. */
  all?: boolean;
  /** For `wait`: seconds before giving up and leaving the work running. */
  timeoutSeconds?: number;
  /** For `watch`. */
  watch?: WatchSpec;
  /** For `policy`. */
  policy?: SupervisionPolicy;
  /** For `stop`: skip the graceful ask and signal immediately. */
  force?: boolean;
}

function ids(input: SuperviseInput): string[] {
  if (!input.id) return [];
  return Array.isArray(input.id) ? input.id : [input.id];
}

function seconds(ms: number): string {
  return ms < 60_000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * One line per record.
 *
 * Deliberately compact: this is read by a model on a turn that is about
 * something else, and a paragraph per process would push out the context that
 * turn actually needs. Everything here answers one of three questions — is it
 * alive, is it moving, and what has it cost.
 */
function line(record: WorkRecord, now: number): string {
  const ran = (record.endedAt ?? now) - record.startedAt;
  const idle = now - record.heartbeatAt;
  const bits = [`${record.id}  [${record.state}]  ${record.kind}  ${record.title}`];

  const facts: string[] = [`ran ${seconds(ran)}`];
  if (record.progress?.steps) facts.push(`${record.progress.steps} step(s)`);
  if (record.cost?.usd) facts.push(`$${record.cost.usd.toFixed(4)}`);
  if (record.pid !== undefined) facts.push(`pid ${record.pid}`);
  bits.push(`  ${facts.join(' · ')}`);

  if (!isTerminal(record.state)) {
    const now_ = record.progress?.lastTool ?? record.progress?.note;
    // The single most useful number for judging a stall. Something that has not
    // moved in four minutes is either on a very long call or stuck, and the
    // orchestrator is better placed to know which than a fixed timeout is.
    const stalled = idle > 30_000 && reportsProgress(record.kind)
      ? `  (nothing for ${seconds(idle)})` : '';
    if (now_ || stalled) bits.push(`  now: ${now_ ?? '—'}${stalled}`);
  }
  if (record.error) bits.push(`  error: ${record.error}`);
  else if (record.result && isTerminal(record.state)) {
    bits.push(`  result: ${record.result.slice(0, 200)}`);
  }
  return bits.join('\n');
}

/** Only this conversation's work — one session must never stop another's. */
function visible(): WorkRecord[] {
  const mine = owningSession(currentRunContext()?.sessionId);
  return ledger.all().filter(r => !mine || !r.sessionId || r.sessionId === mine);
}

export async function executeSupervise(input: SuperviseInput): Promise<string> {
  const now = Date.now();
  const mine = visible();
  const byId = new Map(mine.map(r => [r.id, r]));
  const targets = ids(input);

  switch (input.action) {
    case 'list': {
      const live = mine.filter(r => !isTerminal(r.state));
      const settled = mine.filter(r => isTerminal(r.state) && (input.all || !r.reported));
      if (!live.length && !settled.length) {
        return 'Nothing running, and nothing finished that you have not already seen.';
      }
      const out: string[] = [];
      if (live.length) {
        out.push(`${live.length} running:`, '', ...live.map(r => line(r, now)));
      }
      if (settled.length) {
        if (out.length) out.push('');
        out.push(
          input.all
            ? `${settled.length} finished:`
            : `${settled.length} finished since you last looked:`,
          '',
          ...settled.map(r => line(r, now)),
        );
        if (!input.all) {
          out.push('', 'These stay listed until you ack them: '
            + '{"action":"ack","id":[…]}. Nothing is cleared by reading it.');
        }
      }
      return out.join('\n');
    }

    case 'ack': {
      if (!targets.length) return 'Which ids? Use action "list" to see them.';
      const count = ledger.acknowledge(targets.filter(id => byId.has(id)));
      return count
        ? `Acknowledged ${count} outcome(s). They will not be listed again.`
        : 'Nothing to acknowledge — those ids are unknown, still running, or already acked.';
    }

    case 'stop': {
      if (!targets.length) return 'Which ids? Use action "list" to see them.';
      if (!input.reason) {
        // An abort surfaces inside the work as "aborted", and a reader who cannot
        // tell a deliberate stop from a crash will retry something that was
        // stopped on purpose.
        return 'A reason is required. A stopped agent\'s own error only says "aborted", and '
          + 'without a reason nobody can tell a deliberate termination from a crash — one '
          + 'invites a re-plan, the other a retry.';
      }
      const mode = input.force ? 'kill' : 'stop';
      const done: string[] = [];
      const missing: string[] = [];
      const already: string[] = [];

      for (const id of targets) {
        const record = byId.get(id);
        if (!record) { missing.push(id); continue; }
        if (isTerminal(record.state)) { already.push(`${id} (${record.state})`); continue; }

        /*
          Record the parent's outcome BEFORE stopping anything.

          Stopping a child can close the parent through a follower — a cron
          firing follows its agent's state — and that follower has only the
          child's generic message to work with. A caller that stopped children
          first found its own reason already overwritten by "Cancelled by user".
          Recording first, signalling after, keeps the stated reason authoritative
          while preserving the child-before-parent *signal* order that stops a
          parent blocked inside a child from being left with nothing to abort.
        */
        const handle = takeStopHandle(id);
        ledger.close(id, 'cancelled', input.reason);

        for (const child of ledger.descendants(id).reverse()) {
          if (isTerminal(child.state)) continue;
          await stopWork(child.id, mode, `parent ${id} stopped — ${input.reason}`,
            () => { ledger.close(child.id, 'cancelled', `Stopped with parent: ${input.reason}`); });
        }

        if (handle) {
          try {
            await handle(mode, input.reason);
          } catch { /* asked; a throwing handle is still on its way down */ }
        }
        done.push(handle ? id : `${id} (no handle — recorded, not signalled)`);
      }

      const parts: string[] = [];
      if (done.length) {
        parts.push(`Stopped ${done.length}: ${done.join(', ')}. `
          + (mode === 'kill'
            ? 'Signalled immediately; anything mid-write may be incomplete.'
            : 'Each finishes its current call and unwinds, so what is already written stays.'));
      }
      // Claiming a kill that did not happen is worse than reporting the miss:
      // "stopped 3" when two had already exited makes the next decision wrong.
      if (already.length) parts.push(`Already finished, nothing cancelled: ${already.join(', ')}.`);
      if (missing.length) parts.push(`Not found in this session: ${missing.join(', ')}.`);
      return parts.join(' ');
    }

    case 'guide': {
      if (!targets.length) return 'Which ids? Use action "list" to see them.';
      if (!input.message) {
        return 'A message is required — the correction to deliver.';
      }
      const delivered: string[] = [];
      const cannot: string[] = [];
      for (const id of targets) {
        const record = byId.get(id);
        if (!record) { cannot.push(`${id} (not found)`); continue; }
        if (isTerminal(record.state)) { cannot.push(`${id} (${record.state})`); continue; }
        // Only sub-agents have an inbox. A background agent runs headless with
        // nothing listening, and a process has no notion of being told
        // anything — saying so is better than a silent no-op that reads as
        // success and changes nothing.
        if (!id.startsWith('agent:')) {
          cannot.push(`${id} (a ${record.kind} cannot be guided — stop it and re-brief instead)`);
          continue;
        }
        if (guideAgent(id.slice('agent:'.length), input.message)) delivered.push(id);
        else cannot.push(`${id} (no inbox — it may have just finished)`);
      }
      return [
        delivered.length
          ? `Delivered to ${delivered.join(', ')}. It lands at the next step boundary, so `
            + 'everything already learned is kept — unlike cancelling and re-briefing, '
            + 'which throws away every tool result gathered so far.'
          : '',
        cannot.length ? `Not delivered: ${cannot.join(', ')}.` : '',
      ].filter(Boolean).join(' ');
    }

    case 'policy': {
      if (!targets.length) return 'Which ids? Use action "list" to see them.';
      if (!input.policy) return 'A policy is required. See the tool description for the fields.';
      const applied = targets.filter(id => ledger.setPolicy(id, input.policy!));
      if (!applied.length) return 'No live work matched those ids.';
      const limits = [
        input.policy.deadlineMs !== undefined && `${Math.round(input.policy.deadlineMs / 1000)}s deadline`,
        input.policy.maxCostUsd !== undefined && `$${input.policy.maxCostUsd} ceiling`,
        input.policy.maxSteps !== undefined && `${input.policy.maxSteps} steps`,
        input.policy.idleMs !== undefined && `${Math.round(input.policy.idleMs / 1000)}s idle`,
      ].filter(Boolean).join(', ');
      return `Policy set on ${applied.length}: ${limits || 'no limits'} → ${input.policy.onBreach}. `
        + 'Enforced by the supervisor sweep, not by you — you do not need to check back.';
    }

    case 'watch': {
      if (!input.watch) return 'A watch spec is required. See the tool description.';
      const sessionId = currentRunContext()?.sessionId;
      if (!input.watch.wake.sessionId && !sessionId) {
        return 'No session to wake. Supply watch.wake.sessionId explicitly.';
      }
      const spec: WatchSpec = {
        ...input.watch,
        wake: { ...input.watch.wake, sessionId: input.watch.wake.sessionId || sessionId! },
      };
      const id = watch(spec, {
        ...(sessionId ? { sessionId } : {}),
      });
      return `Watching as ${id}. You will be woken when it fires — do not poll for it. `
        + `Stop watching with {"action":"unwatch","id":"${id}"}.`;
    }

    case 'unwatch': {
      if (!targets.length) return 'Which ids? Use action "list" to see them.';
      const stopped = targets.filter(id => unwatch(id, input.reason ?? 'No longer needed'));
      return stopped.length
        ? `Stopped watching: ${stopped.join(', ')}.`
        : 'None of those ids is an active watcher.';
    }

    case 'wait': {
      if (!targets.length) return 'Which ids? Use action "list" to see them.';
      const timeoutMs = Math.max(1, input.timeoutSeconds ?? 600) * 1000;
      const pending = targets.filter(id => {
        const r = byId.get(id);
        return r && !isTerminal(r.state);
      });
      if (!pending.length) {
        return targets.map(id => {
          const r = byId.get(id);
          return r ? line(r, now) : `${id}: not found in this session.`;
        }).join('\n\n');
      }

      const settled = await waitFor(pending, timeoutMs);
      const after = Date.now();
      const lines = targets.map(id => {
        const r = ledger.get(id);
        return r ? line(r, after) : `${id}: not found.`;
      });
      return settled
        ? lines.join('\n\n')
        : [
          `Timed out after ${Math.round(timeoutMs / 1000)}s. Still running — nothing was cancelled:`,
          '',
          ...lines,
        ].join('\n');
    }
  }
}

/**
 * Block until every id is terminal, or the timeout expires.
 *
 * Subscription rather than a poll loop, so this costs nothing while it waits
 * and settles on the same tick the last record closes. The timeout is a
 * `setTimeout` that is unref'd — waiting for work must never be the reason the
 * process cannot exit.
 */
function waitFor(pending: string[], timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    const unsubscribe = ledger.subscribe(() => {
      const allDone = pending.every(id => {
        const r = ledger.get(id);
        return !r || isTerminal(r.state);
      });
      if (allDone) finish(true);
    });
  });
}

/** Make sure the sweep is running. Called from the same place tools are wired. */
export function ensureSupervisorRunning(): void {
  supervisor.start();
}

export const superviseToolDefinition = {
  name: 'Supervise',
  description:
    'See and control everything this session has running — sub-agents, background agents, '
    + 'backgrounded shell commands, Mini App servers, scheduled runs and watchers — through '
    + 'one tool.\n\n'
    + 'ACTIONS\n'
    + '- list: what is running, plus anything that finished since you last acked. Start a turn '
    + 'with this if you delegated or backgrounded anything earlier.\n'
    + '- ack: mark outcomes as read. Nothing is cleared by listing it, so an outcome you have '
    + 'not acked will be offered again — that is deliberate.\n'
    + '- stop: end work. Requires a reason, and accepts an array of ids. Stops children first. '
    + 'Pass force:true to signal immediately instead of asking.\n'
    + '- wait: block until the given ids finish, or timeoutSeconds elapses. Nothing is '
    + 'cancelled on timeout.\n'
    + '- policy: attach limits the platform enforces for you — deadlineMs, maxCostUsd, '
    + 'maxSteps, idleMs — with onBreach of "report", "stop" or "kill". Set it once and stop '
    + 'checking back; the sweep does the rest.\n'
    + '- watch: register a condition and get woken when it fires. Kinds: file, process, http, '
    + 'command, work, log. USE THIS INSTEAD OF POLLING. Waiting for a build, a server or a '
    + 'sibling by running a command in a loop costs a full turn per check; a watcher costs one '
    + 'turn to set and one to be woken by.\n'
    + '- unwatch: stop watching.\n\n'
    + 'Every id-taking action accepts one id or an array, so stopping three runaway agents is '
    + 'one call.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'stop', 'guide', 'wait', 'watch', 'unwatch', 'policy', 'ack'],
      },
      id: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'One id or several. From "list".',
      },
      reason: {
        type: 'string',
        description: 'Required for stop. Carried into the work\'s own error so a reader can '
          + 'tell a deliberate termination from a crash.',
      },
      all: { type: 'boolean', description: 'list: include already-acked outcomes.' },
      message: {
        type: 'string',
        description: 'guide: the correction to deliver. Lands at the next step boundary of '
          + 'the sub-agent, keeping everything it has already learned.',
      },
      timeoutSeconds: { type: 'number', description: 'wait: default 600.' },
      force: { type: 'boolean', description: 'stop: signal immediately rather than asking.' },
      policy: {
        type: 'object',
        properties: {
          deadlineMs: { type: 'number' },
          maxCostUsd: { type: 'number' },
          maxSteps: { type: 'number' },
          idleMs: {
            type: 'number',
            description: 'No heartbeat for this long counts as stuck. Distinct from a deadline: '
              + 'an agent that has worked hard for an hour and one that has done nothing for ten '
              + 'minutes are different failures.',
          },
          onBreach: { type: 'string', enum: ['report', 'stop', 'kill'] },
          notify: { type: 'string', enum: ['always', 'on-breach', 'on-finish', 'never'] },
        },
        required: ['onBreach'],
      },
      watch: {
        type: 'object',
        properties: {
          condition: {
            type: 'object',
            description: 'One of: {kind:"file",path,debounceMs} · {kind:"process",pid} · '
              + '{kind:"http",url,expectStatus,intervalMs} · '
              + '{kind:"command",command,cwd,expectExit,intervalMs} · '
              + '{kind:"work",workId,states} · {kind:"log",path,pattern}',
          },
          wake: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              as: {
                type: 'string',
                enum: ['notification', 'followup', 'steer'],
                description: '"steer" reaches the running turn at its next step boundary; '
                  + '"followup" starts a new turn; "notification" only reaches the tray.',
              },
              message: { type: 'string' },
            },
            required: ['as'],
          },
          until: { type: 'string', enum: ['first', 'always'] },
          expiresInMs: { type: 'number' },
        },
        required: ['condition', 'wake'],
      },
    },
    required: ['action'],
  },
} as const;
