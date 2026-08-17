/**
 * Compaction over the session log.
 *
 * ## Why this exists
 *
 * Once requests are derived from the session log, compacting
 * `conversationHistory` does nothing: the model no longer reads that array.
 * Auto-compaction and `/compact` both operated on it, so on the session path
 * context management was silently a no-op — the log grew without bound and
 * `/compact` reported success while changing nothing the model saw. Two stores
 * of the same conversation, only one of which the model reads, is exactly the
 * failure the log was introduced to remove.
 *
 * ## Cutting on turn boundaries
 *
 * The array-based compactor keeps "the last N×2 messages", which can slice
 * between an assistant message and the tool results answering it. On the log
 * that is worse than untidy: derivation would have to synthesize error results
 * for the orphaned calls, and retained results whose call was shadowed get
 * dropped — so the model would see a tool result for a call it cannot see it
 * made.
 *
 * So the cut lands on a **turn boundary**. Turns are recoverable from the log
 * (every surface event carries its turn), and a whole turn always contains
 * complete assistant/tool groups.
 *
 * ## Non-destructive
 *
 * Nothing is deleted. The summary is appended as a `user/message` carrying
 * `surfaceOp: {op:'replace', start, end}`, so the originals stay in the log for
 * audit and a future "expand history" feature, while the projection shows the
 * summary in their place.
 *
 * @module session/compact
 */

import { buildConversationSummary, getCompactionThreshold } from '../compact.js';
import { estimateTokens } from '../tokens.js';
import type { AicoSettings } from '../settings.js';
import { deriveMessages } from './derive.js';
import type { Seq, SessionEvent } from './events.js';
import type { Session } from './session.js';

/** Outcome of a compaction attempt. */
export interface SessionCompactionResult {
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
  /** How many whole turns were folded into the summary. */
  droppedTurns: number;
  /** Present when nothing was compacted, explaining why. */
  reason?: string;
}

/**
 * Turns kept verbatim by default.
 *
 * Lower than the array-based path's default of 6 because that number counted
 * message *pairs*, while here a turn is a real agentic turn that may contain
 * many steps and tool results. Keeping six of those would routinely retain more
 * than the threshold that triggered compaction in the first place.
 */
const DEFAULT_KEEP_RECENT_TURNS = 3;

/** Estimated tokens of a derived message list. */
function estimateMessages(messages: Array<{ role: string; content: string }>): number {
  return messages.reduce((total, m) => total + estimateTokens(m.content) + 4, 0);
}

/** The turn a surface event belongs to. */
function turnOf(event: SessionEvent): number {
  return (event.data as { turn?: number }).turn ?? 0;
}

/**
 * Compact a session log if it has grown past the model's threshold.
 *
 * @param session - the log to compact, in place (by appending, never deleting).
 * @param settings - supplies threshold and retention policy.
 * @param model - determines the context window the threshold scales with.
 * @param options.force - compact regardless of threshold (used by `/compact`).
 */
export function maybeCompactSession(
  session: Session,
  settings: AicoSettings | undefined,
  model?: string,
  options: { force?: boolean } = {},
): SessionCompactionResult {
  const cfg = settings?.autoCompact;
  const force = options.force ?? false;

  const before = deriveMessages(session.events);
  const tokensBefore = estimateMessages(before);
  const idle = (reason: string): SessionCompactionResult =>
    ({ compacted: false, tokensBefore, tokensAfter: tokensBefore, droppedTurns: 0, reason });

  if (!force && cfg?.enabled === false) return idle('auto-compaction is disabled');

  const threshold = model
    ? getCompactionThreshold(model, settings)
    : (cfg?.thresholdTokens ?? 80_000);
  if (!force && tokensBefore < threshold) {
    return idle(`below threshold (${tokensBefore} < ${threshold} tokens)`);
  }

  // ── Group visible surface events by turn ─────────────────────────
  const visible = session.surfaceEvents();
  if (visible.length === 0) return idle('nothing to compact');

  const turns: number[] = [];
  const seqsByTurn = new Map<number, Seq[]>();
  for (const event of visible) {
    const turn = turnOf(event);
    if (!seqsByTurn.has(turn)) {
      seqsByTurn.set(turn, []);
      turns.push(turn);
    }
    seqsByTurn.get(turn)!.push(event.seq);
  }

  const keepTurns = Math.max(1, cfg?.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS);
  if (turns.length <= keepTurns) {
    return idle(`only ${turns.length} turn(s) present; keeping ${keepTurns}`);
  }

  const droppedTurns = turns.slice(0, turns.length - keepTurns);
  // The cut is the last surface seq of the last dropped turn, so every retained
  // turn keeps all of its assistant/tool groups intact.
  const cutEnd = Math.max(...droppedTurns.flatMap(t => seqsByTurn.get(t)!));
  const cutStart = visible[0].seq;
  if (cutEnd <= cutStart && droppedTurns.length === 1 && seqsByTurn.get(droppedTurns[0])!.length === 1) {
    return idle('nothing meaningful to fold');
  }

  // ── Summarize exactly what is being replaced ─────────────────────
  // Derive from the truncated log rather than slicing the full projection: the
  // same shadowing and repair rules then apply to the summarised range as to a
  // real request, so the summary describes what the model actually saw.
  const dropped = deriveMessages(session.events.filter(e => e.seq <= cutEnd));
  if (dropped.length === 0) return idle('replaced range projects to nothing');

  const summary = buildConversationSummary(
    dropped.map(m => ({ role: m.role, content: m.content })),
  );

  // `dropped` is the projection of the prefix and `before` the full projection,
  // so the tail past `dropped.length` is exactly what survives. That makes the
  // post-compaction size computable BEFORE the append — which matters, because
  // it is the only way to refuse a compaction that would not help.
  const retained = before.slice(dropped.length);
  const projectedAfter = estimateTokens(summary) + 4 + estimateMessages(retained);

  // A summary carries fixed scaffolding — section headers, the timeline frame.
  // Over a short conversation that costs more than the content it replaces, so
  // compaction can actually GROW the context. Observed live: a four-turn
  // session went 110 → 121 tokens. Compaction that grows context is strictly
  // harmful, and it is worth nothing to trade fidelity for a rounding error, so:
  //
  //   • never compact if the result would not be smaller, and
  //   • for automatic compaction, require a real saving — otherwise the
  //     threshold is still exceeded afterwards and every turn re-triggers a
  //     lossy no-win rewrite.
  const MIN_AUTOMATIC_SAVING = 0.2;
  if (projectedAfter >= tokensBefore) {
    return idle(
      `summary would not be smaller (~${tokensBefore} → ~${projectedAfter} tokens)`,
    );
  }
  if (!force && projectedAfter > tokensBefore * (1 - MIN_AUTOMATIC_SAVING)) {
    const pct = Math.round((1 - projectedAfter / tokensBefore) * 100);
    return idle(
      `saving too small to be worth the fidelity loss (${pct}%, need ` +
      `${Math.round(MIN_AUTOMATIC_SAVING * 100)}%)`,
    );
  }

  session.appendCompactionSummary(summary, { start: cutStart, end: cutEnd }, {
    before: tokensBefore,
    after: projectedAfter,
  });

  const tokensAfter = estimateMessages(deriveMessages(session.events));

  return {
    compacted: true,
    tokensBefore,
    tokensAfter,
    droppedTurns: droppedTurns.length,
  };
}

/**
 * Render a session log as a Markdown transcript.
 *
 * Serialized from the log rather than from `conversationHistory`, because that
 * array only ever held user/assistant text pairs — every tool call and result,
 * and every turn outcome, was silently absent from exported transcripts once
 * the log became the source of truth.
 *
 * @param session - the log to render.
 * @param options.includeShadowed - include history hidden by compaction or a
 *   context clear. Off by default so the transcript matches what the model
 *   currently sees; on, it is the full audit trail.
 */
export function serializeSessionTranscript(
  session: Session,
  options: { includeShadowed?: boolean } = {},
): string {
  const lines: string[] = [
    '# AICO Transcript',
    '',
    `Session: ${session.header.id}`,
    `Started: ${new Date(session.header.startedAt).toISOString()}`,
    `Exported: ${new Date().toISOString()}`,
    `Events: ${session.length}`,
    '',
  ];

  const visible = new Set(session.surfaceEvents().map(e => e.seq));
  const showAll = options.includeShadowed ?? false;

  for (const event of session.events) {
    switch (event.type) {
      case 'turn/start':
        lines.push(`## Turn ${(event.data as { turn: number }).turn}`, '');
        break;
      case 'user/message': {
        const data = event.data as { content: string; source: { kind: string; plugin?: string } };
        if (!showAll && !visible.has(event.seq)) continue;
        const who = data.source.kind === 'human'
          ? 'User'
          : `${data.source.kind}${data.source.plugin ? `:${data.source.plugin}` : ''}`;
        const hidden = visible.has(event.seq) ? '' : ' _(hidden from the model)_';
        lines.push(`### ${who}${hidden}`, '', data.content, '');
        break;
      }
      case 'assistant/message': {
        const data = event.data as { content: string; toolCalls?: Array<{ name: string }> };
        if (!showAll && !visible.has(event.seq)) continue;
        if (data.content) lines.push('### Assistant', '', data.content, '');
        for (const call of data.toolCalls ?? []) {
          lines.push(`- calls \`${call.name}\``);
        }
        if (data.toolCalls?.length) lines.push('');
        break;
      }
      case 'tool/call': {
        const data = event.data as { name: string; arguments: string };
        lines.push(`#### Tool: ${data.name}`, '', '```json', data.arguments, '```', '');
        break;
      }
      case 'tool/result': {
        const data = event.data as { name: string; content: string; isError?: boolean };
        const body = data.content.length > 2000 ? data.content.slice(0, 2000) + '\n… (truncated)' : data.content;
        lines.push(`##### Result${data.isError ? ' (error)' : ''}`, '', '```', body, '```', '');
        break;
      }
      case 'turn/end': {
        const data = event.data as { reason: { kind: string } };
        lines.push(`_Turn ended: ${data.reason.kind}_`, '');
        break;
      }
      case 'compaction/summary':
        lines.push('_History compacted here; originals retained in the log._', '');
        break;
      case 'context/cleared':
        lines.push('_Context cleared by the user._', '');
        break;
      default:
        break;
    }
  }

  return lines.join('\n');
}

/** One-line summary of what the model currently holds. */
export function describeSessionContext(session: Session, model?: string, settings?: AicoSettings): string {
  const messages = deriveMessages(session.events);
  const tokens = estimateMessages(messages);
  const turns = session.events.filter(e => e.type === 'turn/start').length;
  const steps = session.events.filter(e => e.type === 'step/start').length;
  const calls = session.events.filter(e => e.type === 'tool/call').length;
  const hidden = session.events.filter(e => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result').length
    - session.surfaceEvents().length;
  const threshold = model ? getCompactionThreshold(model, settings) : undefined;
  const parts = [
    `${turns} turn(s), ${steps} step(s), ${calls} tool call(s)`,
    `${messages.length} message(s) in context (~${tokens.toLocaleString()} tokens)`,
    `${session.length} event(s) logged${hidden > 0 ? `, ${hidden} hidden by compaction/clear` : ''}`,
  ];
  if (threshold) parts.push(`compaction threshold ~${threshold.toLocaleString()} tokens`);
  return parts.join('\n');
}

/** Human-readable one-liner for a compaction outcome. */
export function formatCompactionResult(result: SessionCompactionResult): string {
  if (!result.compacted) {
    return `No compaction performed — ${result.reason ?? 'nothing to do'}.`;
  }
  const saved = result.tokensBefore - result.tokensAfter;
  const pct = result.tokensBefore > 0 ? Math.round((saved / result.tokensBefore) * 100) : 0;
  return (
    `Compacted ${result.droppedTurns} turn(s): ` +
    `~${result.tokensBefore.toLocaleString()} → ~${result.tokensAfter.toLocaleString()} tokens ` +
    `(${pct}% smaller). Originals are retained in the session log.`
  );
}
