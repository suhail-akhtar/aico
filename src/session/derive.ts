/**
 * Projection from the session event log to a provider-ready message list.
 *
 * This is the function that replaced AICO's old behaviour of flattening prior
 * turns into an XML string inside a single user message. Because the projection
 * emits real `assistant` messages carrying `toolCalls` and real `tool` result
 * messages, tool-call/result pairs survive across turns — which is what makes
 * append-only prompt caching, faithful resume, and session fork possible.
 *
 * ## Ordering with `replace`
 *
 * A surface event carrying `surfaceOp: {op:'replace', start, end}` shadows every
 * surface event in `[start, end]` and is itself projected **at the position
 * where `start` was**. Projecting it at its own (later) seq would place a
 * compaction summary after the recent turns it was supposed to precede.
 *
 * Overlapping replaces are last-writer-wins for shadowing; each replacement is
 * positioned by its own `start`. A replacement whose own seq falls inside a
 * later replacement's range is itself shadowed, so repeated compaction
 * collapses rather than accumulating summaries.
 *
 * ## Repaired invariants
 *
 * Providers hard-reject a dangling tool call: OpenAI returns 400 when an
 * assistant message with `tool_calls` is not followed by a matching `tool`
 * message, and Anthropic rejects a `tool_use` block with no `tool_result`.
 * A log can legitimately contain one — a process killed mid-step logs the call
 * but never the result. Rather than let a crashed session become permanently
 * unresumable, derivation repairs:
 *
 *   1. A call with no result gets a synthesized error result.
 *   2. A result with no originating call is dropped.
 *
 * Both repairs are reported so callers can surface or assert on them.
 *
 * @module session/derive
 */

import type { AicoMessage, ReasoningTrace, ToolCall } from '../providers/types.js';
import type { SessionEvent, Seq } from './events.js';
import { isSurfaceEvent } from './events.js';

/** Text used for a tool call whose result never reached the log. */
export const MISSING_RESULT_TEXT =
  'Error: no result was recorded for this tool call (the session ended before it completed).';

/** Repairs applied while projecting a log that violated an invariant. */
export interface DeriveRepairs {
  /** Call IDs that had no matching result and received a synthetic one. */
  synthesizedResults: string[];
  /** Call IDs of results that had no originating call and were dropped. */
  droppedOrphanResults: string[];
}

/** Result of projecting a session log. */
export interface DeriveResult {
  messages: AicoMessage[];
  repairs: DeriveRepairs;
}

/**
 * Compute the set of seqs shadowed by `replace` operations.
 * Exported for the invariant checker and for tests that assert shadowing
 * without materializing messages.
 */
export function computeShadowedSeqs(events: readonly SessionEvent[]): Set<Seq> {
  const shadowed = new Set<Seq>();
  for (const event of events) {
    // A `context/cleared` marker hides everything before it outright. It is
    // applied alongside `replace` rather than instead of it, so a session that
    // was compacted and then cleared ends up with neither the originals nor the
    // summary — which is what "clear" means.
    if (event.type === 'context/cleared') {
      const through = (event.data as { throughSeq: Seq }).throughSeq;
      for (const candidate of events) {
        if (isSurfaceEvent(candidate) && candidate.seq <= through) shadowed.add(candidate.seq);
      }
      continue;
    }
    const op = event.surfaceOp;
    if (op?.op !== 'replace') continue;
    for (const candidate of events) {
      if (!isSurfaceEvent(candidate)) continue;
      // A replacement never shadows itself, even when its own seq happens to
      // fall inside the range it declares.
      if (candidate.seq === event.seq) continue;
      if (candidate.seq >= op.start && candidate.seq <= op.end) {
        shadowed.add(candidate.seq);
      }
    }
  }
  return shadowed;
}

/**
 * Project a session log into the message list a provider receives.
 *
 * @param events - the full log, in seq order.
 * @returns the derived messages plus any invariant repairs that were applied.
 */
export function deriveMessagesDetailed(events: readonly SessionEvent[]): DeriveResult {
  const shadowed = computeShadowedSeqs(events);

  // ── Order surface events, honouring replace positioning ────────────
  // Each surviving surface event gets a sort key: its own seq normally, or its
  // replace range's `start` when it stands in for earlier history. The seq is
  // kept as a tiebreaker so two replacements anchored at the same position stay
  // in the order they were appended.
  const ordered = events
    .filter(e => isSurfaceEvent(e) && !shadowed.has(e.seq))
    .map((e) => {
      const op = e.surfaceOp;
      return { event: e, anchor: op?.op === 'replace' ? op.start : e.seq };
    })
    .sort((a, b) => (a.anchor - b.anchor) || (a.event.seq - b.event.seq))
    .map(entry => entry.event);

  // ── Emit messages, tracking tool-call/result pairing ───────────────
  const messages: AicoMessage[] = [];
  const repairs: DeriveRepairs = { synthesizedResults: [], droppedOrphanResults: [] };

  // Calls awaiting a result, in the order the assistant requested them.
  let openCalls: Array<{ call: ToolCall; satisfied: boolean }> = [];

  /**
   * Close the current assistant group, synthesizing any missing results.
   *
   * Called immediately before the next `user`/`assistant` message is pushed (and
   * once at the end), so appending here is exactly "directly after this group's
   * real results" — the adjacency providers require.
   */
  const flushOpenCalls = (): void => {
    if (openCalls.length === 0) return;
    for (const entry of openCalls) {
      if (entry.satisfied) continue;
      repairs.synthesizedResults.push(entry.call.id);
      messages.push({
        role: 'tool',
        toolCallId: entry.call.id,
        toolName: entry.call.name,
        content: MISSING_RESULT_TEXT,
      });
    }
    openCalls = [];
  };

  for (const event of ordered) {
    if (event.type === 'user/message') {
      // A user message starts a new exchange: any assistant tool calls still
      // unanswered at this point never will be.
      flushOpenCalls();
      const data = event.data as { content: string };
      messages.push({ role: 'user', content: data.content });
      continue;
    }

    if (event.type === 'assistant/message') {
      flushOpenCalls();
      const data = event.data as {
        content: string;
        toolCalls?: ToolCall[];
        reasoning?: ReasoningTrace;
      };
      const toolCalls = data.toolCalls ?? [];
      messages.push({
        role: 'assistant',
        content: data.content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        // Replayed so a provider that wants its own reasoning back still gets
        // it after a restart or resume, when provider-local memory is long
        // gone. Both Anthropic and DeepSeek document the trace as needing to
        // return; both were observed to tolerate its absence, so this is
        // contract adherence rather than a fix for an observed failure.
        ...(data.reasoning ? { reasoning: data.reasoning } : {}),
      });
      openCalls = toolCalls.map(call => ({ call, satisfied: false }));
      continue;
    }

    if (event.type === 'tool/result') {
      const data = event.data as {
        callId: string; name: string; content: string; isError?: boolean;
      };
      const pending = openCalls.find(entry => entry.call.id === data.callId);
      if (pending === undefined) {
        // No open call with this id — the originating assistant message was
        // shadowed by compaction, or the log is malformed. Either way the
        // provider would reject it, so drop rather than emit.
        repairs.droppedOrphanResults.push(data.callId);
        continue;
      }
      pending.satisfied = true;
      messages.push({
        role: 'tool',
        toolCallId: data.callId,
        toolName: data.name,
        content: data.content,
      });
      continue;
    }
  }

  flushOpenCalls();

  return { messages, repairs };
}

/**
 * Project a session log into a provider-ready message list.
 * Convenience wrapper over {@link deriveMessagesDetailed} for the common case
 * where the caller does not inspect repairs.
 */
export function deriveMessages(events: readonly SessionEvent[]): AicoMessage[] {
  return deriveMessagesDetailed(events).messages;
}
