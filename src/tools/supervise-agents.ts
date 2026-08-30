/**
 * Watching the agents you delegated to, and stopping the ones going wrong.
 *
 * ## What this can and cannot reach
 *
 * `Task` blocks: the parent's step does not return until every sub-agent it
 * spawned in that step has finished. So an orchestrator cannot poll a child it
 * is currently waiting on — it is suspended inside the same tool call. That is
 * a real limit and worth stating plainly rather than pretending otherwise.
 *
 * What it *can* do is supervise across the boundary, which covers the cases
 * that actually go wrong:
 *
 * - **Siblings.** Several `Task` calls in one step run concurrently. A
 *   supervise call issued in that same step runs alongside them, and can stop
 *   one that has gone off without touching the others.
 * - **Between delegations.** After a step returns, the parent can see what each
 *   child cost, how many calls it made, and whether it was stopped — and decide
 *   whether to accept the work, re-delegate it, or do it itself.
 * - **Anything still running.** A detached or long-running child from an
 *   earlier step is stoppable at any point.
 *
 * ## Why stopping needs a reason
 *
 * An abort surfaces inside the sub-agent as an ordinary error reading
 * "aborted". A parent reading that cannot tell a deliberate termination from a
 * crash — and it has to, because a crash invites a retry and a termination
 * invites a re-plan. The reason is carried through to the result text.
 *
 * @module tools/supervise-agents
 */

import { currentRunContext } from '../run-context.js';
import {
  detachedRun, getAgentRegistry, guideAgent, owningSession, requestAgentStop,
  type SubAgentRecord,
} from './task.js';

export interface AgentSuperviseInput {
  action: 'list' | 'stop' | 'guide' | 'wait';
  /** Which agent. The id `list` reports. */
  agentId?: string;
  /** Why it is being stopped. Required for `stop` — see the module note. */
  reason?: string;
  /** The correction, for `guide`. */
  message?: string;
  /** Seconds to wait before giving up and leaving it running. Default 600. */
  timeoutSeconds?: number;
}

function seconds(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function line(agent: SubAgentRecord, now: number): string {
  const ran = (agent.completedAt ?? now) - agent.startedAt;
  const idle = now - agent.lastActivityAt;
  const bits = [
    `${agent.agentId}  [${agent.status}]  ${agent.agentType}`,
    `  ${agent.description}`,
    `  ran ${seconds(ran)} · ${agent.toolCallCount} tool call(s)`
      + ` · ${agent.inputTokens.toLocaleString()} in / ${agent.outputTokens.toLocaleString()} out`,
  ];
  if (agent.status === 'running') {
    bits.push(`  now: ${agent.statusMessage}`
      // The single most useful number for judging a stall. A child that has not
      // touched a tool in four minutes is either on a very long model call or
      // stuck, and the parent is better placed to know which than a fixed
      // timeout is.
      + (idle > 30_000 ? `  (nothing for ${seconds(idle)})` : ''));
  }
  if (agent.error) bits.push(`  error: ${agent.error}`);
  return bits.join('\n');
}

export async function executeAgentSupervise(input: AgentSuperviseInput): Promise<string> {
  // Only this conversation's agents. The registry is process-wide, and one
  // session listing — or worse, stopping — another's work would be a bug with
  // no upside.
  const mine = owningSession(currentRunContext()?.sessionId);
  const visible = getAgentRegistry().filter(a => !mine || a.sessionId === mine);
  const now = Date.now();

  switch (input.action) {
    case 'list': {
      if (visible.length === 0) {
        return 'No sub-agents from this session are running or recently finished.';
      }
      const running = visible.filter(a => a.status === 'running');
      return [
        `${visible.length} sub-agent(s), ${running.length} running:`,
        '',
        ...visible.map(a => line(a, now)),
      ].join('\n');
    }

    case 'stop': {
      if (!input.agentId) return 'Which agent? Use action "list" to see the ids.';
      if (!input.reason) {
        return 'A reason is required. The sub-agent\'s own error will only say "aborted", '
          + 'and without a reason nobody can tell a deliberate stop from a crash.';
      }
      const target = visible.find(a => a.agentId === input.agentId);
      if (!target) {
        return `No sub-agent "${input.agentId}" belongs to this session. Use action "list".`;
      }
      if (target.status !== 'running') {
        return `Sub-agent "${input.agentId}" already ${target.status} — nothing to stop.`;
      }
      const stopped = requestAgentStop(input.agentId, input.reason);
      return stopped
        ? `Stopping "${input.agentId}": ${input.reason}. It finishes its current tool call and `
          + 'then unwinds, so anything already written stays on disk. Its Task result will say '
          + 'it was stopped rather than that it failed.'
        // The window between "running" in the snapshot and gone from the stop
        // map is small but real, and claiming a kill we did not make is worse
        // than saying so.
        : `Sub-agent "${input.agentId}" finished before the stop reached it. Nothing was cancelled.`;
    }

    case 'guide': {
      if (!input.agentId) return 'Which agent? Use action "list" to see the ids.';
      if (!input.message) return 'What correction? Pass it as "message".';
      const target = visible.find(a => a.agentId === input.agentId);
      if (!target) {
        return `No sub-agent "${input.agentId}" belongs to this session. Use action "list".`;
      }
      if (target.status !== 'running') {
        return `Sub-agent "${input.agentId}" already ${target.status} — too late to correct it. `
          + 'Judge the result instead, and re-delegate if it is wrong.';
      }
      const delivered = guideAgent(input.agentId, input.message);
      return delivered
        ? `Correction queued for "${input.agentId}". It arrives at that agent's next step `
          + 'boundary, so it keeps everything it has already learned rather than starting over. '
          + 'It has not seen the message yet — nothing has changed as of this moment.'
        // A child whose session could not be opened runs without an inbox. It
        // is still working; it simply cannot be talked to.
        : `Sub-agent "${input.agentId}" has no channel to receive corrections. `
          + 'Stop it and re-delegate with a better brief, or let it finish and judge the result.';
    }

    case 'wait': {
      if (!input.agentId) return 'Which agent? Use action "list" to see the ids.';
      /*
        Ownership checked against the id map rather than the registry.

        The registry drops a finished agent after ten seconds, so by the time a
        parent comes back to collect a result its record is usually gone — and
        an ownership test that only consults the registry would refuse the
        legitimate late collection while still letting an unknown id through.
        The `sub-<id>` mapping outlives the record.
      */
      const belongsHere = !mine || owningSession(`sub-${input.agentId}`) === mine;
      if (!belongsHere) {
        return `No sub-agent "${input.agentId}" belongs to this session. Use action "list".`;
      }
      const running = detachedRun(input.agentId);
      const known = visible.find(a => a.agentId === input.agentId);
      if (!running) {
        if (known?.result) return known.result;
        if (known) {
          return `Sub-agent "${input.agentId}" ${known.status}`
            + `${known.error ? `: ${known.error}` : ''}.`;
        }
        return `Nothing to wait for: "${input.agentId}" is not a detached sub-agent of this `
          + 'session. Only agents spawned with detach:true can be waited on.';
      }

      /*
        Bounded, and honest when the bound is hit.

        An unbounded wait would reintroduce exactly the hang this feature exists
        to make visible — and worse, one the supervisor chose. On timeout the
        agent keeps running: the parent is told it is still going, and can look
        again, correct it, or stop it. Killing something because a caller ran
        out of patience would throw away work nobody asked to discard.
      */
      const limitMs = Math.min(Math.max((input.timeoutSeconds ?? 600) * 1000, 1_000), 3_600_000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = Symbol('timeout');
      const outcome = await Promise.race([
        running,
        new Promise<typeof expired>(resolve => {
          timer = setTimeout(() => resolve(expired), limitMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);

      if (outcome === expired) {
        const live = getAgentRegistry().find(a => a.agentId === input.agentId);
        return `Still running after ${Math.round(limitMs / 1000)}s`
          + `${live ? ` — ${live.statusMessage}, ${live.toolCallCount} tool call(s) so far` : ''}. `
          + 'It has NOT been stopped. Wait again, correct it with "guide", or end it with "stop".';
      }
      return outcome;
    }

    default:
      return `Unknown action "${String(input.action)}".`;
  }
}

export const agentSuperviseToolDefinition = {
  name: 'AgentSupervise',
  description: [
    'Watch and stop the sub-agents you delegated to with Task.',
    'Use "list" to see what each one is doing right now — the tool it is inside, how long it has',
    'run, how many calls it has made, what it has cost, and how long since it last did anything.',
    'Use "guide" to correct one that is going wrong without restarting it — the message arrives at',
    'its next step boundary, so it keeps every tool result it has already gathered.',
    'Use "stop" to terminate one that has stalled, gone down the wrong path, or is burning tokens',
    'without progress; the others keep running. Use "wait" to collect a detached agent\'s result.',
    'To supervise a delegation while it happens, spawn it with Task detach:true — an ordinary Task',
    'blocks, and while you are waiting on one you are suspended inside it and cannot look at',
    'anything. Without detaching, this still covers siblings running alongside a supervise call,',
    'anything still going from an earlier step, and the decision after a delegation returns.',
  ].join(' '),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'stop', 'guide', 'wait'],
        description:
          'list: every sub-agent of this session, running or just finished, with what it is doing '
          + 'and what it has spent. guide: send a correction to a running one — it arrives at that '
          + "agent's next step boundary and keeps everything it has already learned, which "
          + 'stopping and re-delegating would throw away. stop: terminate one by id. '
          + 'wait: block until a detached sub-agent finishes, and return its result.',
      },
      message: {
        type: 'string',
        description:
          'The correction, for "guide". Say what to do differently — "the schema has to exist '
          + 'before the page can read it", "stop rewriting app.js and fix the failing test". It '
          + 'reaches the agent as an instruction from its supervisor.',
      },
      timeoutSeconds: {
        type: 'number',
        description:
          'For "wait": how long to wait before returning. Default 600. On timeout the agent keeps '
          + 'running and you are told so — nothing is cancelled.',
      },
      agentId: {
        type: 'string',
        description: 'Which agent to stop. Shown by list.',
      },
      reason: {
        type: 'string',
        description:
          'Why you are stopping it — "looping on the same file", "wrong approach, needs the '
          + 'schema first", "12 calls with no progress". Required, and passed through to the '
          + 'Task result so the record says what happened rather than just "aborted".',
      },
    },
    required: ['action'],
  },
};
