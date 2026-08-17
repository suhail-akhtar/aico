/**
 * Runtime invariants for the session log.
 *
 * These assert contracts the rest of the system is entitled to assume. They are
 * cheap enough to run in tests and in a `/doctor`-style check, and each failure
 * names the exact seq that violated it — an invariant that only says "something
 * is wrong" costs more time than it saves.
 *
 * The governing contract is **model-visible means logged**: if a request
 * carried it, the log can reconstruct it.
 *
 * @module session/invariant
 */

import type { ToolCall } from '../providers/types.js';
import type { Session } from './session.js';
import type { SessionEvent, SessionEventMap } from './events.js';
import { isSurfaceEvent } from './events.js';

/** One violated contract. */
export interface InvariantViolation {
  /** Stable identifier so a check can be suppressed or asserted on by name. */
  code: string;
  /** Human-readable description naming the offending seq. */
  message: string;
  seq?: number;
}

/** Outcome of checking a session log. */
export interface InvariantReport {
  ok: boolean;
  violations: InvariantViolation[];
}

/**
 * Check every session-log invariant.
 *
 * @param session - the log to verify.
 * @returns a report; `ok` is true only when no contract was violated.
 */
export function checkSessionInvariants(session: Session): InvariantReport {
  const violations: InvariantViolation[] = [];
  const events = session.events as readonly SessionEvent[];

  // ── 1. Seqs are strictly increasing ────────────────────────────────
  // Derivation, shadow ranges, and `sourceEventSeqs` all address events by seq.
  // A duplicate or out-of-order seq makes every one of those ambiguous.
  let previousSeq = 0;
  for (const event of events) {
    if (event.seq <= previousSeq) {
      violations.push({
        code: 'SEQ_NOT_INCREASING',
        message: `event seq ${event.seq} does not follow ${previousSeq}`,
        seq: event.seq,
      });
    }
    previousSeq = event.seq;
  }

  // ── 2. surfaceOp appears only on surface events ────────────────────
  // A record event carrying a surface operation would silently do nothing,
  // which is exactly the kind of bug that survives review.
  for (const event of events) {
    if (event.surfaceOp !== undefined && !isSurfaceEvent(event as never)) {
      violations.push({
        code: 'SURFACE_OP_ON_RECORD_EVENT',
        message: `${event.type} at seq ${event.seq} carries a surfaceOp but is not a surface event`,
        seq: event.seq,
      });
    }
  }

  // ── 3. Replace ranges are well-formed and refer to existing seqs ───
  const knownSeqs = new Set(events.map(e => e.seq));
  for (const event of events) {
    const op = event.surfaceOp;
    if (op?.op !== 'replace') continue;
    if (op.start > op.end) {
      violations.push({
        code: 'REPLACE_RANGE_INVERTED',
        message: `replace at seq ${event.seq} has start ${op.start} after end ${op.end}`,
        seq: event.seq,
      });
    }
    if (op.end >= event.seq) {
      violations.push({
        code: 'REPLACE_RANGE_NOT_HISTORICAL',
        message: `replace at seq ${event.seq} covers seq ${op.end}, which is not strictly earlier`,
        seq: event.seq,
      });
    }
    if (!knownSeqs.has(op.start)) {
      violations.push({
        code: 'REPLACE_RANGE_UNKNOWN_START',
        message: `replace at seq ${event.seq} starts at unknown seq ${op.start}`,
        seq: event.seq,
      });
    }
  }

  // ── 4. Turn boundaries are balanced and monotonic ──────────────────
  let openTurn: number | undefined;
  let highestTurn = 0;
  for (const event of events) {
    if (event.type === 'turn/start') {
      const { turn } = event.data as SessionEventMap['turn/start'];
      if (openTurn !== undefined) {
        violations.push({
          code: 'TURN_ALREADY_OPEN',
          message: `turn ${turn} opened at seq ${event.seq} while turn ${openTurn} was still open`,
          seq: event.seq,
        });
      }
      if (turn <= highestTurn) {
        violations.push({
          code: 'TURN_NOT_MONOTONIC',
          message: `turn ${turn} at seq ${event.seq} does not follow turn ${highestTurn}`,
          seq: event.seq,
        });
      }
      openTurn = turn;
      highestTurn = Math.max(highestTurn, turn);
    } else if (event.type === 'turn/end') {
      const { turn } = event.data as SessionEventMap['turn/end'];
      if (openTurn === undefined) {
        violations.push({
          code: 'TURN_END_WITHOUT_START',
          message: `turn ${turn} ended at seq ${event.seq} with no open turn`,
          seq: event.seq,
        });
      } else if (openTurn !== turn) {
        violations.push({
          code: 'TURN_END_MISMATCH',
          message: `turn ${turn} ended at seq ${event.seq} while turn ${openTurn} was open`,
          seq: event.seq,
        });
      }
      openTurn = undefined;
    }
  }

  // ── 5. Every tool/result cites a tool/call in the same step ────────
  const calls = new Map<string, { seq: number; turn: number; step: number }>();
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as SessionEventMap['tool/call'];
      if (calls.has(data.callId)) {
        violations.push({
          code: 'DUPLICATE_TOOL_CALL_ID',
          message: `tool call id "${data.callId}" reused at seq ${event.seq}`,
          seq: event.seq,
        });
      }
      calls.set(data.callId, { seq: event.seq, turn: data.turn, step: data.step });
    } else if (event.type === 'tool/result') {
      const data = event.data as SessionEventMap['tool/result'];
      const call = calls.get(data.callId);
      if (call === undefined) {
        violations.push({
          code: 'RESULT_WITHOUT_CALL',
          message: `tool result at seq ${event.seq} cites unknown call "${data.callId}"`,
          seq: event.seq,
        });
      } else if (call.turn !== data.turn || call.step !== data.step) {
        violations.push({
          code: 'RESULT_STEP_MISMATCH',
          message:
            `tool result at seq ${event.seq} is in turn ${data.turn}/step ${data.step} ` +
            `but its call was in turn ${call.turn}/step ${call.step}`,
          seq: event.seq,
        });
      }
    }
  }

  // ── 6. Every assistant tool call has a matching tool/call event ────
  // The assistant message is what the model sees; the tool/call event is what
  // the audit trail sees. A call present in one and absent from the other means
  // the transcript and the request disagree.
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const data = event.data as SessionEventMap['assistant/message'];
    for (const call of (data.toolCalls ?? []) as ToolCall[]) {
      if (!calls.has(call.id)) {
        violations.push({
          code: 'ASSISTANT_CALL_NOT_LOGGED',
          message: `assistant message at seq ${event.seq} requested "${call.name}" (${call.id}) with no tool/call event`,
          seq: event.seq,
        });
      }
    }
  }

  // ── 7. Derivation leaves no dangling tool call ─────────────────────
  // This is the contract providers enforce with a 400. Derivation repairs it,
  // so a violation here means the repair itself regressed.
  const { messages } = session.deriveMessagesDetailed();
  const answered = new Set(
    messages.filter(m => m.role === 'tool').map(m => (m as { toolCallId: string }).toolCallId),
  );
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      if (!answered.has(call.id)) {
        violations.push({
          code: 'DERIVED_DANGLING_TOOL_CALL',
          message: `derived messages leave tool call "${call.id}" (${call.name}) unanswered`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Throw when any invariant is violated. Intended for tests and `/doctor`. */
export function assertSessionInvariants(session: Session): void {
  const report = checkSessionInvariants(session);
  if (report.ok) return;
  const detail = report.violations.map(v => `  • [${v.code}] ${v.message}`).join('\n');
  throw new Error(`session invariants violated:\n${detail}`);
}
