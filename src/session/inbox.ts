/**
 * The agent inbox: durable queues for input that arrives while work is running.
 *
 * Before this existed, both UIs kept messages typed during a run in a plain
 * in-memory array. That has two problems. The array dies with the process, so a
 * crash loses whatever the user typed; and the queue can only be drained *after*
 * the current task finishes, so there is no way to redirect work already in
 * flight. If the agent is three steps into the wrong approach, you can cancel it
 * or wait — you cannot steer it.
 *
 * ## Two queues, two owners
 *
 * | Queue       | Claimed at      | Owned by  | Verb         |
 * |-------------|-----------------|-----------|--------------|
 * | `next-step` | step boundary   | the loop  | `steer`, `inject` |
 * | `next-turn` | turn boundary   | the caller| `followup`   |
 *
 * The split matters because AICO's loop is invoked per turn by its caller: the
 * REPL decides when a new turn starts. So the loop owns `next-step` (it can act
 * on it mid-run, which is what steering is) and the caller owns `next-turn` (it
 * drains followups after the run and submits each as its own turn). Merging
 * followups into the running turn would silently collapse several distinct user
 * requests into one, which is not what someone pressing Enter twice means.
 *
 * ## Durability
 *
 * Every mutation — insertion *and* claim — is an `inbox/spliced` event. Claims
 * are pure deletions. Replaying the log therefore reconstructs exactly what is
 * still pending, so a session resumed after a crash still owes the work the
 * user submitted before it.
 *
 * @module session/inbox
 */

import crypto from 'crypto';
import type { InboxTarget, MessageSource, QueuedMessage, SessionEventMap } from './events.js';
import type { Session } from './session.js';

/** Notified whenever either queue changes. */
export type InboxListener = (snapshot: InboxSnapshot) => void;

/** Point-in-time view of both queues, for UI rendering. */
export interface InboxSnapshot {
  nextTurn: QueuedMessage[];
  nextStep: QueuedMessage[];
}

/** Durable queues of pending input for one session. */
export class Inbox {
  private readonly queues: Record<InboxTarget, QueuedMessage[]> = {
    'next-turn': [],
    'next-step': [],
  };
  private listeners: InboxListener[] = [];

  /**
   * @param session - log this inbox records into and replays from.
   */
  constructor(private readonly session: Session) {
    // Replay persisted splices so pending work survives a restart. A malformed
    // splice is skipped rather than throwing: a corrupt inbox entry must not
    // make an otherwise resumable session unopenable.
    for (const event of session.events) {
      if (event.type !== 'inbox/spliced') continue;
      try {
        this.apply(event.data as SessionEventMap['inbox/spliced']);
      } catch {
        // Skipped; the rest of the log still replays.
      }
    }
  }

  // ── Reading ────────────────────────────────────────────────────────

  /** Messages awaiting their own turn. */
  get nextTurn(): readonly QueuedMessage[] {
    return this.queues['next-turn'];
  }

  /** Messages awaiting the next step boundary. */
  get nextStep(): readonly QueuedMessage[] {
    return this.queues['next-step'];
  }

  /** Whether either queue holds work. */
  get hasPending(): boolean {
    return this.queues['next-turn'].length > 0 || this.queues['next-step'].length > 0;
  }

  /** Current state of both queues. */
  snapshot(): InboxSnapshot {
    return {
      nextTurn: [...this.queues['next-turn']],
      nextStep: [...this.queues['next-step']],
    };
  }

  // ── Delivery verbs ─────────────────────────────────────────────────

  /**
   * Queue a message as its own next turn.
   *
   * Use for "and then do this" — a separate request that should not disturb the
   * work currently running. The caller drains it once the current run returns.
   */
  followup(content: string, source: MessageSource = { kind: 'human' }): QueuedMessage {
    return this.enqueue('next-turn', content, source);
  }

  /**
   * Steer the running turn: deliver at the next step boundary.
   *
   * Use for "actually, do it this way instead" — a correction that should reach
   * the model before it takes another action, without discarding what it has
   * already learned. Unlike cancelling, the conversation and tool results so far
   * are kept.
   */
  steer(content: string, source: MessageSource = { kind: 'human' }): QueuedMessage {
    return this.enqueue('next-step', content, source);
  }

  /**
   * Add model-visible context at the next step boundary.
   *
   * Same delivery point as {@link steer}, but attributed to a plugin or tool
   * rather than a person. The distinction is not cosmetic: a UI must not render
   * a guard reminder as something the user typed, and a transcript reader needs
   * to know which instructions came from a human.
   */
  inject(content: string, source: MessageSource): QueuedMessage {
    return this.enqueue('next-step', content, source);
  }

  private enqueue(target: InboxTarget, content: string, source: MessageSource): QueuedMessage {
    const message: QueuedMessage = { id: crypto.randomUUID(), content, source };
    this.splice(target, this.queues[target].length, 0, [message]);
    return message;
  }

  // ── Claiming ───────────────────────────────────────────────────────

  /**
   * Remove and return everything pending at a step boundary.
   *
   * Called by the agent loop between steps. The durable splice is a pure
   * deletion, so a replay of the log shows the work as consumed rather than
   * still owed.
   */
  claimStep(): QueuedMessage[] {
    const pending = this.queues['next-step'];
    if (pending.length === 0) return [];
    const claimed = [...pending];
    this.splice('next-step', 0, claimed.length, []);
    return claimed;
  }

  /**
   * Remove and return the next queued turn, if any.
   *
   * One at a time by design: each followup is its own turn, so draining them in
   * a batch would merge separate requests into a single turn.
   */
  claimTurn(): QueuedMessage | undefined {
    if (this.queues['next-turn'].length === 0) return undefined;
    const claimed = this.queues['next-turn'][0];
    this.splice('next-turn', 0, 1, []);
    return claimed;
  }

  /**
   * Discard all pending input.
   *
   * `next-step` is cleared before `next-turn` so that an observer watching the
   * splices never sees a state where steering input outlived the followups
   * queued after it.
   */
  clear(): void {
    if (this.queues['next-step'].length > 0) {
      this.splice('next-step', 0, this.queues['next-step'].length, []);
    }
    if (this.queues['next-turn'].length > 0) {
      this.splice('next-turn', 0, this.queues['next-turn'].length, []);
    }
  }

  // ── Mutation ───────────────────────────────────────────────────────

  /**
   * The single mutation primitive: record a durable splice, then apply it.
   *
   * Recording before applying means the log is authoritative — if the append
   * throws, in-memory state has not drifted ahead of what was persisted.
   */
  private splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    messages: QueuedMessage[],
  ): void {
    this.session.append('inbox/spliced', { target, start, deleteCount, messages });
    this.apply({ target, start, deleteCount, messages });
    this.notify();
  }

  /** Apply a splice to in-memory state. Used by both live mutation and replay. */
  private apply(data: SessionEventMap['inbox/spliced']): void {
    const queue = this.queues[data.target];
    if (queue === undefined) throw new Error(`unknown inbox target "${data.target}"`);
    queue.splice(data.start, data.deleteCount, ...data.messages);
  }

  // ── Observation ────────────────────────────────────────────────────

  /**
   * Subscribe to queue changes, receiving an immediate snapshot.
   *
   * The immediate delivery is contained exactly like every later one: a
   * subscriber that throws on its first call must not break `subscribe()`
   * itself, or one bad panel takes down whatever was wiring it up.
   */
  subscribe(listener: InboxListener): () => void {
    this.listeners.push(listener);
    this.deliver(listener, this.snapshot());
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) this.deliver(listener, snapshot);
  }

  /**
   * Contained dispatch: a throwing listener must not break the mutation it runs
   * inside, nor starve the listeners after it.
   */
  private deliver(listener: InboxListener, snapshot: InboxSnapshot): void {
    try {
      listener(snapshot);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠ inbox listener failed: ${reason}`);
    }
  }
}
