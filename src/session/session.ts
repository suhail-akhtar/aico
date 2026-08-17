/**
 * The append-only session log and the operations that read it.
 *
 * A `Session` owns an ordered list of {@link SessionEvent}s and hands out three
 * things derived from it: the model's message list, the current request header,
 * and turn/step position. Nothing mutates an event after it is appended — a
 * correction is a new event, which is what makes replay, audit, and fork work.
 *
 * Subscribers (persistence, the UI bridge, telemetry) attach with
 * {@link Session.subscribe} and see every append in order. A throwing
 * subscriber is contained and logged rather than being allowed to break the
 * agent loop — one bad listener must never take the session down.
 *
 * @module session/session
 */

import crypto from 'crypto';
import type { AicoMessage } from '../providers/types.js';
import { computeShadowedSeqs, deriveMessages, deriveMessagesDetailed, type DeriveResult } from './derive.js';
import type {
  RequestHeader,
  Seq,
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SurfaceOp,
  TurnEndReason,
} from './events.js';
import { isSurfaceEvent } from './events.js';

/** Options accepted when appending an event. */
export interface AppendOptions {
  /** How this event joins the model-visible surface. Surface events only. */
  surfaceOp?: SurfaceOp;
  /** Seqs this event was derived from (chunks → message, call → result). */
  sourceEventSeqs?: Seq[];
  /** Override the wall-clock stamp; used when replaying a persisted log. */
  timestamp?: number;
}

/** A subscriber notified of every appended event, in order. */
export type SessionListener = (event: SessionEvent) => void;

/** Metadata fixed at session creation. */
export interface SessionHeader {
  id: string;
  cwd: string;
  startedAt: number;
  name?: string;
}

/**
 * Build a stable, comparable request header. The system prompt is hashed rather
 * than stored: keeping the full text would put a multi-kilobyte string into the
 * log on every route change, and only its identity matters for change
 * detection. Tool names are sorted so a registration-order change that does not
 * alter the available tool set does not look like a change.
 */
export function canonicalHeader(input: {
  provider: string;
  model: string;
  systemPrompt: string;
  tools: string[];
}): RequestHeader {
  return {
    provider: input.provider,
    model: input.model,
    systemHash: crypto.createHash('sha256').update(input.systemPrompt).digest('hex').slice(0, 16),
    tools: [...input.tools].sort(),
  };
}

/** Whether two request headers describe the same request identity. */
export function headerEquals(a: RequestHeader, b: RequestHeader): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.systemHash === b.systemHash &&
    a.tools.length === b.tools.length &&
    a.tools.every((tool, i) => tool === b.tools[i])
  );
}

/** An append-only conversation log. */
export class Session {
  readonly header: SessionHeader;

  private readonly _events: SessionEvent[] = [];
  private listeners: SessionListener[] = [];
  private nextSeq: Seq = 1;

  constructor(header: SessionHeader) {
    this.header = header;
  }

  /** The full log, in seq order. Treat as immutable. */
  get events(): readonly SessionEvent[] {
    return this._events;
  }

  /** Number of events recorded so far. */
  get length(): number {
    return this._events.length;
  }

  // ── Appending ──────────────────────────────────────────────────────

  /**
   * Record one durable fact.
   *
   * @param type - event type from {@link SessionEventMap}.
   * @param data - the event payload.
   * @param options - surface behaviour and provenance.
   * @returns the appended event, including its assigned `seq`.
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    options: AppendOptions = {},
  ): SessionEvent<T> {
    const event: SessionEvent<T> = {
      seq: this.nextSeq++,
      type,
      timestamp: options.timestamp ?? Date.now(),
      data,
      ...(options.surfaceOp ? { surfaceOp: options.surfaceOp } : {}),
      ...(options.sourceEventSeqs ? { sourceEventSeqs: options.sourceEventSeqs } : {}),
    };
    this._events.push(event as SessionEvent);
    this.notify(event as SessionEvent);
    return event;
  }

  /**
   * Re-append a persisted event verbatim, preserving its original seq.
   * Used only by the loader; ordinary code must go through {@link append}.
   */
  restore(event: SessionEvent): void {
    this._events.push(event);
    if (event.seq >= this.nextSeq) this.nextSeq = event.seq + 1;
  }

  private notify(event: SessionEvent): void {
    // Contained dispatch: a listener that throws must not reject the append it
    // runs inside, nor starve the listeners registered after it.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`  ⚠ session listener failed on ${event.type}: ${reason}`);
      }
    }
  }

  /** Attach a subscriber. Returns an unsubscribe function. */
  subscribe(listener: SessionListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  // ── Projections ────────────────────────────────────────────────────

  /** The message list a provider receives for the next request. */
  deriveMessages(): AicoMessage[] {
    return deriveMessages(this._events);
  }

  /** Message list plus any invariant repairs derivation had to apply. */
  deriveMessagesDetailed(): DeriveResult {
    return deriveMessagesDetailed(this._events);
  }

  /** The most recently logged request header, if any. */
  requestHeader(): RequestHeader | undefined {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const event = this._events[i];
      if (event.type === 'request/header') {
        return (event.data as SessionEventMap['request/header']).header;
      }
    }
    return undefined;
  }

  /**
   * Log a request header only when it differs from the last one.
   *
   * @returns the reason it was logged, or `undefined` when unchanged.
   */
  recordRequestHeader(header: RequestHeader): 'initial' | 'resume' | 'change' | undefined {
    const previous = this.requestHeader();
    if (previous !== undefined && headerEquals(previous, header)) return undefined;
    // "resume" distinguishes a header logged by a fresh loop instance over an
    // existing log from a genuine mid-session route change.
    const reason: 'initial' | 'resume' | 'change' =
      previous === undefined
        ? (this._events.length === 0 ? 'initial' : 'resume')
        : 'change';
    this.append('request/header', { header, reason });
    return reason;
  }

  /** The highest turn number opened so far. 0 when no turn has started. */
  get lastTurn(): number {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const event = this._events[i];
      if (event.type === 'turn/start') {
        return (event.data as SessionEventMap['turn/start']).turn;
      }
    }
    return 0;
  }

  /** Whether a turn is currently open (started with no matching end). */
  get hasOpenTurn(): boolean {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const event = this._events[i];
      if (event.type === 'turn/end') return false;
      if (event.type === 'turn/start') return true;
    }
    return false;
  }

  /** The reason the last completed turn ended, if any. */
  lastTurnEndReason(): TurnEndReason | undefined {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const event = this._events[i];
      if (event.type === 'turn/end') {
        return (event.data as SessionEventMap['turn/end']).reason;
      }
    }
    return undefined;
  }

  /** Surface events still visible to the model, in projection order. */
  surfaceEvents(): SessionEvent[] {
    const shadowed = computeShadowedSeqs(this._events);
    return this._events.filter(e => isSurfaceEvent(e) && !shadowed.has(e.seq));
  }

  /**
   * Start fresh: hide the conversation so far from the model.
   *
   * Nothing is deleted — a `context/cleared` marker shadows the prior surface
   * events, so the transcript, audit trail, and any future "undo clear" still
   * have them. This is what `/clear` must do once requests are derived from the
   * log: emptying a message array the model no longer reads would report
   * success while changing nothing it sees.
   *
   * @returns the marker event, or `undefined` when there was nothing to clear.
   */
  clearContext(): SessionEvent<'context/cleared'> | undefined {
    const visible = this.surfaceEvents();
    if (visible.length === 0) return undefined;
    const throughSeq = visible[visible.length - 1].seq;
    return this.append('context/cleared', { throughSeq, reason: 'user' });
  }

  // ── Compaction ─────────────────────────────────────────────────────

  /**
   * Replace a range of history with a summary, without deleting anything.
   *
   * The summary rides on a `user/message` carrying
   * `surfaceOp: {op:'replace', start, end}` so the projection substitutes it at
   * the position the replaced range occupied. A companion
   * `compaction/summary` event records what was shadowed, so the reduction is
   * auditable and a future "expand history" feature has the originals.
   *
   * @param summary - the replacement text the model will see.
   * @param range - inclusive seq range to shadow.
   * @param tokens - before/after estimates, recorded for telemetry.
   * @returns the appended summary event.
   */
  appendCompactionSummary(
    summary: string,
    range: { start: Seq; end: Seq },
    tokens: { before: number; after: number },
  ): SessionEvent<'user/message'> {
    const shadowedSeqs = this._events
      .filter(e => isSurfaceEvent(e) && e.seq >= range.start && e.seq <= range.end)
      .map(e => e.seq);

    const event = this.append(
      'user/message',
      { turn: this.lastTurn, content: summary, source: { kind: 'compaction' } },
      { surfaceOp: { op: 'replace', start: range.start, end: range.end } },
    );

    this.append('compaction/summary', {
      replacedFrom: range.start,
      replacedTo: range.end,
      shadowedSeqs,
      tokensBefore: tokens.before,
      tokensAfter: tokens.after,
    }, { sourceEventSeqs: [event.seq] });

    return event;
  }

  // ── Fork ───────────────────────────────────────────────────────────

  /**
   * Create a new session containing this one's history up to `boundary`.
   *
   * The child gets copies of the events (the log is append-only, so sharing
   * would let the child's future appends renumber against the parent's). This
   * is the operation that lets a user branch a conversation at a decision point
   * and explore both paths — impossible while history was an opaque string.
   *
   * @param childId - identity for the new session.
   * @param boundary - last seq to copy; defaults to the whole log.
   */
  fork(childId: string, boundary?: Seq): Session {
    const limit = boundary ?? Number.MAX_SAFE_INTEGER;
    const child = new Session({
      id: childId,
      cwd: this.header.cwd,
      startedAt: Date.now(),
      ...(this.header.name ? { name: `${this.header.name} (fork)` } : {}),
    });
    for (const event of this._events) {
      if (event.seq > limit) break;
      child.restore(structuredClone(event));
    }
    return child;
  }
}
