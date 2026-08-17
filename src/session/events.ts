/**
 * Session event vocabulary.
 *
 * The session log is an append-only list of `SessionEvent`s with a monotonic
 * `seq`. It is the single source of truth for what the model has seen: the
 * governing invariant is
 *
 *     MODEL-VISIBLE MEANS LOGGED
 *
 * Anything that reaches a model request must be reconstructable from this log.
 * That is why adding a new kind of model-visible input means adding a new event
 * type here rather than threading another string through the agent loop.
 *
 * Events split into two classes:
 *
 *   • SURFACE events  — project into the model request (`user/message`,
 *                       `assistant/message`, `tool/result`).
 *   • RECORD events   — durable facts that never reach the model directly
 *                       (turn/step boundaries, `tool/call`, `request/header`,
 *                       `inbox/spliced`, `assistant/chunk`).
 *
 * `tool/call` is a record event on purpose: the model sees its own tool calls
 * through `assistant/message.toolCalls`, so projecting `tool/call` as well
 * would duplicate them on the wire. The separate event exists for audit,
 * ordering, and so a result can cite the exact call that produced it.
 *
 * @module session/events
 */

import type { ReasoningTrace, ToolCall } from '../providers/types.js';

// ── Sequence numbers ─────────────────────────────────────────────────

/** Monotonic position of an event within one session log. 1-based. */
export type Seq = number;

// ── Surface operations ───────────────────────────────────────────────

/**
 * How an event joins the model-visible surface.
 *
 * `append` places the event at its own position — the ordinary case.
 *
 * `replace` shadows every surface event in the inclusive seq range
 * `[start, end]` and projects the replacing event **at the position where
 * `start` was**, not at its own (later) seq. Positioning at `start` is what
 * makes a compaction summary land where the replaced history was, rather than
 * after the recent turns that were deliberately retained. Replacing at the
 * event's own seq would reorder the conversation and is always wrong.
 */
export type SurfaceOp =
  | { op: 'append' }
  | { op: 'replace'; start: Seq; end: Seq };

// ── Turn outcomes ────────────────────────────────────────────────────

/**
 * Why a turn stopped. Every exit path assigns exactly one of these, including
 * the failure paths — an unlabelled turn end is a bug, not a default.
 *
 * `max-tokens` is sticky across a turn: once any step hits the output ceiling,
 * a later step that completes normally must not downgrade the turn outcome,
 * because the earlier truncation is still part of what the user received.
 */
export type TurnEndReason =
  /** The model produced a final text answer with no outstanding tool work. */
  | { kind: 'completed' }
  /** A step hit the provider's output-token ceiling. */
  | { kind: 'max-tokens' }
  /** A pre-step listener rejected the claimed input; no model call was spent. */
  | { kind: 'blocked' }
  /** The caller cancelled, or a wall-clock timeout fired. */
  | { kind: 'aborted'; cause: string }
  /** A structured failure. `code` is the provider/classifier code when known. */
  | { kind: 'error'; message: string; code: string };

// ── Message provenance ───────────────────────────────────────────────

/**
 * Where a `user/message` came from. Synthetic sources are model-visible but not
 * typed by a human, and UIs render them differently — a guard reminder is not
 * something the user said.
 */
export type MessageSource =
  | { kind: 'human' }
  | { kind: 'plugin'; plugin: string }
  | { kind: 'tool'; tool: string }
  | { kind: 'compaction' };

// ── Request header ───────────────────────────────────────────────────

/**
 * The non-message part of a model request: route, system prompt, tool set.
 * Logged whenever it changes so a transcript can explain why two requests in
 * the same session behaved differently.
 */
export interface RequestHeader {
  provider: string;
  model: string;
  /** Hash of the system prompt — the prompt itself would bloat every log. */
  systemHash: string;
  /** Tool names in registration order. */
  tools: string[];
}

/** Token accounting reported by the provider for one assistant message. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

// ── Inbox ────────────────────────────────────────────────────────────

/** Which pending queue an inbox mutation targets. */
export type InboxTarget = 'next-turn' | 'next-step';

/** A queued user-role message awaiting a turn or step boundary. */
export interface QueuedMessage {
  id: string;
  content: string;
  source: MessageSource;
}

// ── The event map ────────────────────────────────────────────────────

/**
 * Every durable fact a session can record. Extending this type is the only
 * supported way to add model-visible state — see the module invariant above.
 */
export interface SessionEventMap {
  /** A turn opened. */
  'turn/start': { turn: number };
  /** A turn closed, with the reason it stopped. */
  'turn/end': { turn: number; reason: TurnEndReason };
  /** A step opened (one model request plus its tool calls). */
  'step/start': { turn: number; step: number };
  /**
   * A step closed.
   *
   * `firstTokenAt` is the clock at the first streamed delta of this step, which
   * is what separates *waiting for the model* from *reading its answer*. It is
   * recorded here rather than derived from `assistant/chunk` events because
   * chunk capture is off by default — it roughly triples log size — and this is
   * one number per step instead of thousands of events for the same fact.
   *
   * Absent when the step streamed no text at all, which is the normal shape of
   * a step that only requested tools.
   */
  'step/end': { turn: number; step: number; firstTokenAt?: number };

  /** SURFACE. Input entering the model request. */
  'user/message': { turn: number; content: string; source: MessageSource };

  /** SURFACE. One assistant reply, with any tool calls it requested. */
  'assistant/message': {
    turn: number;
    step: number;
    content: string;
    toolCalls?: ToolCall[];
    usage?: Usage;
    /**
     * The model's own reasoning trace, when the producing provider requires it
     * replayed on later requests. Logged rather than held in provider memory
     * because it is model-visible input on every subsequent step — the same
     * invariant that puts tool calls here.
     */
    reasoning?: ReasoningTrace;
  };

  /** RECORD. One streamed text delta, retained for replay/UI fidelity. */
  'assistant/chunk': { turn: number; step: number; text: string };

  /** RECORD. A tool call was dispatched. Results cite this event's seq. */
  'tool/call': {
    turn: number;
    step: number;
    callId: string;
    name: string;
    /** Raw argument JSON as the model emitted it. */
    arguments: string;
  };

  /** SURFACE. The single model-facing outcome of one tool call. */
  'tool/result': {
    turn: number;
    step: number;
    callId: string;
    name: string;
    content: string;
    isError?: boolean;
  };

  /** RECORD. Route / prompt / tool-set identity, logged only when it changes. */
  'request/header': { header: RequestHeader; reason: 'initial' | 'resume' | 'change' };

  /**
   * RECORD. The user asked for a fresh start.
   *
   * Shadows every surface event at or before `throughSeq`, so the next request
   * carries none of the prior conversation. Deliberately a record event rather
   * than a `surfaceOp: replace` carrying empty content: a replacement has to
   * project to *something*, and an empty `user/message` is a shape providers
   * reject. Nothing is deleted — the log keeps the cleared history for audit
   * and for a future "undo clear".
   */
  'context/cleared': { throughSeq: Seq; reason: 'user' };

  /** RECORD. A durable inbox mutation, replayed on resume. */
  'inbox/spliced': {
    target: InboxTarget;
    start: number;
    deleteCount: number;
    messages: QueuedMessage[];
  };

  /**
   * RECORD. The session's display name.
   *
   * A record rather than a field on the session because a title has *history*:
   * a deterministic fallback appears the moment the first message lands, a
   * model-written one replaces it a few seconds later, and a user rename
   * outranks both permanently. Appending each decision keeps the provenance —
   * which model wrote it, whether a human overrode it — and makes the current
   * title simply the last one logged, with no separate state to keep in sync.
   *
   * The text is untrusted: `fallback` comes from the user and `model` comes
   * from a language model, so both are sanitized before they are stored. See
   * `session/title.ts`.
   */
  'session/title': {
    title: string;
    source: 'fallback' | 'model' | 'user';
    /** Which model wrote it, when `source` is `model`. */
    provider?: string;
    model?: string;
  };

  /**
   * RECORD. Whether this session is filed away.
   *
   * An event rather than a flag, for the same reason the title is one: the log
   * is the only durable state a session has, so recording it here means
   * archiving survives a restart with nothing to keep in sync and nothing to
   * migrate. The current state is simply the last one logged, which also makes
   * un-archiving an ordinary append rather than a deletion.
   *
   * Archiving is not deleting. The transcript stays on disk and stays
   * replayable; it is only hidden from the list, because "I am done with this"
   * and "destroy this" are different intentions and the destructive one should
   * never be the easy click.
   */
  'session/archived': { archived: boolean };

  /**
   * RECORD. A rating on one assistant message.
   *
   * Keyed by the seq of the message it judges rather than carried on that
   * message, because the log is append-only: a rating arrives long after the
   * message it is about, and can be changed or withdrawn afterwards. The
   * current rating for a message is the last one citing it.
   */
  'message/feedback': {
    /** Seq of the `assistant/message` being rated. */
    targetSeq: Seq;
    rating: 'up' | 'down' | 'none';
    note?: string;
  };

  /**
   * RECORD. The standing objective for this session.
   *
   * Distinct from the last user message: a goal outlives the turn that set it
   * and is what the work is measured against several turns later. Logged rather
   * than held in memory so it survives a resume, and appended rather than
   * mutated so "paused at 14:02, resumed at 14:40" is recoverable.
   */
  'goal/set': {
    text: string;
    status: 'active' | 'paused' | 'cleared';
  };

  /**
   * RECORD. Compaction bookkeeping. The summary itself rides on a
   * `user/message` carrying `surfaceOp: {op:'replace'}`; this event records
   * what was shadowed so the reduction is auditable and reversible.
   */
  'compaction/summary': {
    replacedFrom: Seq;
    replacedTo: Seq;
    shadowedSeqs: Seq[];
    tokensBefore: number;
    tokensAfter: number;
  };
}

/** Every event type name. */
export type SessionEventType = keyof SessionEventMap;

/** One durable fact in a session log. */
export interface SessionEvent<T extends SessionEventType = SessionEventType> {
  seq: Seq;
  type: T;
  timestamp: number;
  data: SessionEventMap[T];
  /** Present only on surface events. */
  surfaceOp?: SurfaceOp;
  /** Seqs this event was derived from (chunks → message, call → result). */
  sourceEventSeqs?: Seq[];
}

/**
 * Event types that project into a model request. Kept as a runtime Set (not
 * just a type) because derivation and the invariant checker both need to test
 * membership on values read back from disk.
 */
export const SURFACE_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set<SessionEventType>([
  'user/message',
  'assistant/message',
  'tool/result',
]);

/** Whether an event participates in the model-visible surface. */
export function isSurfaceEvent(event: SessionEvent): boolean {
  return SURFACE_EVENT_TYPES.has(event.type);
}

/** Format a turn ending for a transcript or status line. */
export function formatTurnEndReason(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'completed':  return 'completed';
    case 'max-tokens': return 'stopped at the output-token ceiling';
    case 'blocked':    return 'blocked before any model call';
    case 'aborted':    return `aborted (${reason.cause})`;
    case 'error':      return `error [${reason.code}]: ${reason.message}`;
  }
}
