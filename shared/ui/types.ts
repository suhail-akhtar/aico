/**
 * The chat shapes the view renders.
 *
 * These live here rather than in the client's store because the components in
 * this directory are the reason the type exists. A component that imported
 * `ChatMessage` from the store would drag the store — and everything the store
 * imports — in behind it. The type is data; the store is one way of holding it.
 *
 * @module shared/ui/types
 */

export type MessageType =
  | 'user'
  | 'assistant'
  | 'tool'
  /**
   * One burst of reasoning, ordered with the tool calls it sits between.
   *
   * Its own entry rather than a field on the assistant message: a turn that
   * calls tools reasons repeatedly, and those thoughts belong at the points in
   * the transcript where they happened, not merged onto the final reply.
   */
  | 'reasoning'
  | 'system'
  | 'error';

export interface ChatMessage {
  id: string;
  type: MessageType;
  content: string;
  /** For tool messages: the tool name */
  toolName?: string;
  /** For tool messages: tool arguments */
  toolArgs?: Record<string, unknown>;
  /** For tool messages: tool result */
  toolResult?: unknown;
  /**
   * Whether the call failed, as the engine reported it.
   *
   * Carried rather than re-derived. The result reaches the client as the JSON
   * string the log stored, and a string cannot be inspected for an `error`
   * field — so every structured failure was rendering as a success.
   */
  toolFailed?: boolean;
  /** For tool messages: whether the tool is still running */
  toolRunning?: boolean;
  /**
   * For tool messages: the provider's own call id.
   *
   * Carried so a result can be matched to the call that produced it. Parallel
   * tool calls make position unreliable — up to eight can be in flight, and
   * pairing them by arrival order attaches results to the wrong cards.
   */
  toolCallId?: string;
  /**
   * For a running tool: how long it has been going, in ms.
   *
   * Present only while output is still arriving, which is what lets the card
   * show elapsed time for a long command instead of an unchanging spinner.
   */
  toolProgressMs?: number;
  /** Timestamp */
  timestamp: number;
  /** Whether this message is being streamed (assistant text) */
  streaming?: boolean;
  /** For reasoning entries: how long the burst took, once it has ended. */
  durationMs?: number;
  /**
   * The model's reasoning for this reply, when the provider emitted any.
   *
   * Carried on the message rather than held globally so it stays attached to
   * the answer it produced — scrolling back to an earlier turn shows that
   * turn's thinking, not the most recent. Undefined is the normal case:
   * adaptive thinking is the model's decision and most providers say nothing.
   */
  reasoning?: string;
}

/** Rolled-up usage for a session, as both clients display it. */
export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export const EMPTY_USAGE: UsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};
