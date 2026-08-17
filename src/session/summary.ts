/**
 * What happened in a turn, once it is over.
 *
 * A turn that finishes just stops. The last token arrives, the spinner goes
 * away, and nothing says whether the work is *done* — whether the model
 * finished because it had finished, or because it hit a token ceiling, or
 * because a guard stopped it, or because it ran out of steps with work
 * outstanding. Those are completely different outcomes and they all looked
 * identical.
 *
 * The log already knows. `turn/end` records the reason, `step/*` records the
 * shape, `tool/*` records what was touched, and `assistant/message` carries
 * usage. This reads all of it and says so in one line plus the detail behind
 * it — which is the difference between "it stopped" and "it is done".
 *
 * @module session/summary
 */

import type { Session } from './session.js';
import type { Seq, TurnEndReason } from './events.js';
import { deliverables, type Deliverable } from './projections.js';

/** How a turn ended, in the terms a reader cares about. */
export type TurnOutcome =
  /** Finished because the work was finished. */
  | 'completed'
  /** Stopped for a reason that leaves work outstanding. */
  | 'incomplete'
  /** The user stopped it. */
  | 'cancelled'
  /** It failed. */
  | 'failed';

export interface TurnSummary {
  outcome: TurnOutcome;
  /** One line naming what happened, in plain words. */
  headline: string;
  /** Why it ended, when that needs saying beyond the headline. */
  detail?: string;
  durationMs: number;
  steps: number;
  /** Tool calls made, and how many failed. */
  toolCalls: number;
  toolFailures: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  files: Deliverable[];
}

/**
 * Summarise the turn that ended at or before `throughSeq`.
 *
 * Scoped to one turn rather than the session: "what did *that* do" is the
 * question someone asks when a turn stops, and session totals answer a
 * different one.
 */
export function summarizeLastTurn(session: Session, throughSeq?: Seq): TurnSummary | undefined {
  const events = session.events;
  const limit = throughSeq ?? Number.MAX_SAFE_INTEGER;

  // Walk back to the last turn/end within range, then back again to its start.
  let endIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.seq > limit) continue;
    if (event.type === 'turn/end') { endIndex = i; break; }
  }
  if (endIndex === -1) return undefined;

  const endEvent = events[endIndex]!;
  const endData = endEvent.data as { turn: number; reason: TurnEndReason };
  const turn = endData.turn;

  let startIndex = 0;
  for (let i = endIndex; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'turn/start' && (event.data as { turn: number }).turn === turn) {
      startIndex = i;
      break;
    }
  }

  const startEvent = events[startIndex]!;
  const slice = events.slice(startIndex, endIndex + 1);

  let steps = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;

  for (const event of slice) {
    switch (event.type) {
      case 'step/start':
        steps++;
        break;
      case 'tool/call':
        toolCalls++;
        break;
      case 'tool/result':
        if ((event.data as { isError?: boolean }).isError) toolFailures++;
        break;
      case 'assistant/message': {
        const usage = (event.data as { usage?: Record<string, number> }).usage;
        if (usage) {
          inputTokens += usage.inputTokens ?? 0;
          outputTokens += usage.outputTokens ?? 0;
          cachedTokens += usage.cachedTokens ?? 0;
        }
        break;
      }
      default:
        break;
    }
  }

  const { outcome, headline, detail } = describe(endData.reason, toolFailures);

  return {
    outcome,
    headline,
    ...(detail ? { detail } : {}),
    durationMs: Math.max(0, endEvent.timestamp - startEvent.timestamp),
    steps,
    toolCalls,
    toolFailures,
    inputTokens,
    outputTokens,
    cachedTokens,
    files: deliverables(session, startEvent.seq),
  };
}

/**
 * Turn the recorded reason into something worth reading.
 *
 * The wording matters more than it looks. "Done" and "Stopped early" are the
 * two things a reader needs to tell apart at a glance, and every reason that is
 * not `completed` belongs firmly in the second group — including the ones that
 * look benign, like hitting a token ceiling mid-sentence.
 */
function describe(
  reason: TurnEndReason,
  toolFailures: number,
): { outcome: TurnOutcome; headline: string; detail?: string } {
  switch (reason.kind) {
    case 'completed':
      return toolFailures > 0
        ? {
          outcome: 'completed',
          headline: 'Done',
          detail: `${toolFailures} tool call${toolFailures === 1 ? '' : 's'} failed along the way — worth checking the result.`,
        }
        : { outcome: 'completed', headline: 'Done' };

    case 'max-tokens':
      return {
        outcome: 'incomplete',
        headline: 'Stopped early — output limit reached',
        detail: 'The reply was cut off at the model\'s output ceiling. Ask it to continue, or raise maxTokens for this provider.',
      };

    case 'blocked':
      return {
        outcome: 'incomplete',
        headline: 'Stopped before starting',
        detail: 'A guard rejected the input, so no model call was made.',
      };

    case 'aborted':
      return {
        outcome: 'cancelled',
        headline: 'Stopped',
        detail: reason.cause,
      };

    case 'error':
      return {
        outcome: 'failed',
        headline: 'Failed',
        detail: reason.code ? `${reason.message} (${reason.code})` : reason.message,
      };
  }
}
