/**
 * Pure reduction of session-log events into renderable messages.
 *
 * Separated from the store because this is the part with actual rules in it —
 * replay idempotency, call/result pairing, opaque reasoning traces — and rules
 * deserve tests that do not need a DOM, a React renderer, or a running server
 * to check. The store holds state; this decides what the state should become.
 *
 * Every function here is total and side-effect free: same input, same output,
 * no clock beyond the timestamp passed in.
 *
 * @module reduce
 */

import type { ChatMessage } from '@aico/ui';

/** Sentinel key for the optimistic user echo. Sorts after any real seq. */
export const PENDING_KEY = Number.MAX_SAFE_INTEGER;

/**
 * Fold one durable log event into the finalized message map.
 *
 * Keyed by seq throughout, which is what makes replay safe: the same event
 * always writes the same slot, so a reconnect that replays a turn already on
 * screen cannot duplicate a message or a tool card.
 *
 * Returns the same map instance when nothing changed, so a caller can use
 * identity to skip a re-render.
 */
export function applyLogEvent(
  logged: Map<number, ChatMessage>,
  seq: number,
  data: Record<string, unknown>,
  now = Date.now(),
): Map<number, ChatMessage> {
  const type = String(data.type ?? '');

  switch (type) {
    case 'user/message': {
      const next = new Map(logged);
      next.set(seq, {
        id: `seq-${seq}`,
        type: 'user',
        content: String(data.content ?? ''),
        timestamp: now,
      });
      return next;
    }

    case 'assistant/message': {
      const content = String(data.content ?? '');
      const reasoning = readReasoning(data.reasoning);
      const calledTools = Array.isArray(data.toolCalls) && data.toolCalls.length > 0;

      // A step whose only output was tool calls has no text to show — the tool
      // cards below it are the content, and an empty bubble would be noise.
      //
      // But a step with no text, no reasoning *and no tool calls* is a reply
      // that said nothing, and rendering nothing for it is worse: the turn
      // looks like it never happened, which reads as a dropped message. It is
      // reported instead — that is how a session ended up with the same
      // question asked twice.
      if (!content && !reasoning) {
        if (calledTools) return logged;
        const next = new Map(logged);
        next.set(seq, {
          id: `seq-${seq}`,
          type: 'system',
          content: 'The model returned an empty reply.',
          timestamp: now,
        });
        return next;
      }
      const next = new Map(logged);

      // Reasoning is its own entry, keyed just below the message it preceded.
      // Fractional keys sort it into place without renumbering anything, and
      // keep it separate from the reply the way the live view does — the same
      // burst should not look like part of the answer on replay.
      if (reasoning) {
        next.set(seq - 0.5, {
          id: `seq-${seq}-reasoning`,
          type: 'reasoning',
          content: reasoning,
          timestamp: now,
        });
      }
      if (content) {
        next.set(seq, {
          id: `seq-${seq}`,
          type: 'assistant',
          content,
          timestamp: now,
        });
      }
      return next;
    }

    case 'tool/call': {
      const next = new Map(logged);
      next.set(seq, {
        id: `seq-${seq}`,
        type: 'tool',
        content: '',
        toolName: String(data.name ?? 'tool'),
        toolArgs: parseArgs(data.arguments),
        toolCallId: String(data.callId ?? ''),
        toolRunning: true,
        timestamp: now,
      });
      return next;
    }

    case 'tool/result': {
      const callId = String(data.callId ?? '');
      // Attach to the call this result cites, so one card carries both the
      // arguments and the outcome. Pairing by arrival order would be wrong:
      // up to eight calls run in parallel and finish out of order.
      for (const [key, message] of logged) {
        if (message.type === 'tool' && message.toolCallId === callId) {
          const next = new Map(logged);
          next.set(key, {
            ...message, toolResult: data.content, toolRunning: false,
            toolFailed: data.isError === true,
          });
          return next;
        }
      }
      // No matching call in view — render the result alone rather than
      // discarding evidence of work that actually happened.
      const next = new Map(logged);
      next.set(seq, {
        id: `seq-${seq}`,
        type: 'tool',
        content: '',
        toolName: String(data.name ?? 'tool'),
        toolCallId: callId,
        toolResult: data.content,
        toolFailed: data.isError === true,
        toolRunning: false,
        timestamp: now,
      });
      return next;
    }

    default:
      // turn/start, step/end, request/header and friends are bookkeeping, not
      // conversation. Ignoring them here is what keeps the transcript readable.
      return logged;
  }
}

/**
 * Reasoning traces are opaque by contract — each provider stores whatever it
 * needs replayed to itself. Anthropic's is a JSON array of signed thinking
 * blocks, which must never be dumped on screen as JSON; DeepSeek's is already
 * prose. Anything unrecognised is shown verbatim rather than dropped, because
 * a trace we cannot parse is still the model's reasoning.
 */
export function readReasoning(trace: unknown): string {
  if (!trace || typeof trace !== 'object') return '';
  const { content } = trace as { content?: unknown };
  if (typeof content !== 'string' || !content) return '';
  if (!content.trimStart().startsWith('[')) return content;
  try {
    const blocks = JSON.parse(content) as unknown;
    if (!Array.isArray(blocks)) return content;
    const text = blocks
      .map(b => (b && typeof b === 'object' ? (b as { thinking?: string; text?: string }) : {}))
      .map(b => b.thinking ?? b.text ?? '')
      .filter(Boolean)
      .join('\n\n');
    return text || content;
  } catch {
    return content;
  }
}

/** Tool arguments arrive as the raw JSON string the model emitted. */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    // A model can emit a bare string or array as arguments; neither is a
    // props object, and spreading one into a component yields nonsense.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { input: parsed };
  } catch {
    return { input: raw };
  }
}

/** Order finalized messages for rendering. */
export function orderMessages(logged: Map<number, ChatMessage>): ChatMessage[] {
  return [...logged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, message]) => message);
}

/** One burst of reasoning within the running turn. */
export interface ReasoningBurst {
  step: number;
  text: string;
  startedAt: number;
  endedAt?: number;
}

/** Live state for the turn currently running. Not persisted, not replayed. */
export interface Draft {
  text: string;
  /**
   * Reasoning bursts, keyed by step.
   *
   * The engine sends the text accumulated *within a step*, not deltas — so
   * these are replaced, never appended. Appending them produced "a", "ab",
   * "abc" concatenated into "aababc": every burst garbled into gibberish that
   * grew quadratically. Keying by step also keeps a turn's separate thoughts
   * separate, which is what they are.
   */
  reasoning: Map<number, ReasoningBurst>;
  /** Tool cards for the running turn, keyed by the provider's own call id. */
  tools: Map<string, ChatMessage>;
  /** Order in which live entries appeared, so they render as they happened. */
  order: Array<{ kind: 'reasoning'; key: number } | { kind: 'tool'; key: string }>;
}

export const emptyDraft = (): Draft => ({
  text: '', reasoning: new Map(), tools: new Map(), order: [],
});

/**
 * The full render list: finalized history, then the in-flight turn.
 *
 * A pure function rather than a store selector on purpose. It allocates a new
 * array every call, so subscribing a component directly to it would make
 * zustand see a changed value on every render and loop forever — which is
 * exactly what happened. Callers memoise on the three inputs instead.
 */
export function composeMessages(
  logged: Map<number, ChatMessage>,
  draft: Draft,
  busy: boolean,
  now = Date.now(),
): ChatMessage[] {
  const finalized = orderMessages(logged);
  if (!busy) return finalized;

  // Live entries render in the order they actually happened — think, call a
  // tool, think again about the result — because that sequence is the story of
  // the turn. Collapsing it into "all the reasoning, then all the tools" loses
  // which thought preceded which action.
  const live: ChatMessage[] = [];
  for (const entry of draft.order) {
    if (entry.kind === 'reasoning') {
      const burst = draft.reasoning.get(entry.key);
      if (!burst?.text.trim()) continue;
      live.push({
        id: `draft-reasoning-${burst.step}`,
        type: 'reasoning',
        content: burst.text,
        streaming: burst.endedAt === undefined,
        ...(burst.endedAt !== undefined ? { durationMs: burst.endedAt - burst.startedAt } : {}),
        timestamp: burst.startedAt,
      });
    } else {
      const tool = draft.tools.get(entry.key);
      if (tool) live.push(tool);
    }
  }

  if (draft.text) {
    live.push({
      id: 'draft-text',
      type: 'assistant',
      content: draft.text,
      streaming: true,
      timestamp: now,
    });
  }

  return [...finalized, ...live];
}

export function withPending(
  logged: Map<number, ChatMessage>,
  content: string,
  now = Date.now(),
): Map<number, ChatMessage> {
  const next = new Map(logged);
  next.set(PENDING_KEY, { id: 'pending-user', type: 'user', content, timestamp: now });
  return next;
}

export function dropPending(logged: Map<number, ChatMessage>): Map<number, ChatMessage> {
  if (!logged.has(PENDING_KEY)) return logged;
  const next = new Map(logged);
  next.delete(PENDING_KEY);
  return next;
}
