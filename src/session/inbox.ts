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

/** One pending message as a client draws it: what the person typed, and the id to name it by. */
export interface InboxItem { id: string; content: string }

/**
 * What a client is shown of the queues: only what a person typed.
 *
 * A background agent's report or a watcher's wake-up rides the same queues,
 * but drawing it as "your message, waiting" would put words in the person's
 * mouth — the same rule the transcript keeps for `source`.
 */
export function inboxView(snapshot: InboxSnapshot): { nextStep: InboxItem[]; nextTurn: InboxItem[] } {
  const human = (m: QueuedMessage): boolean => (m.source?.kind ?? 'human') === 'human';
  const item = (m: QueuedMessage): InboxItem => ({ id: m.id, content: m.content });
  return {
    nextStep: snapshot.nextStep.filter(human).map(item),
    nextTurn: snapshot.nextTurn.filter(human).map(item),
  };
}

/**
 * The step that reads a message claimed from `next-step` right now.
 *
 * The loop claims at a step boundary — after step N's tools, before step N+1
 * asks the model — or at a turn's start, before its first step. Read from the
 * log rather than counted alongside it, so it cannot drift from what replays.
 */
export function deliveryStep(events: readonly { type: string; data: unknown }[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'turn/start') return 1;
    if (e.type === 'step/start') return Number((e.data as { step?: number }).step ?? 0) + 1;
  }
  return 1;
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
   * Discard pending step input, except what `keep` says to hold on to.
   *
   * For a cancelled turn: a correction addressed to it is moot, but a
   * background agent's report queued on the same queue is not (ADR 0021).
   * Each discarded message is its own splice, so a replay of the log ends in
   * exactly this state. Returns what was discarded.
   */
  discardStep(keep: (message: QueuedMessage) => boolean): QueuedMessage[] {
    const discarded: QueuedMessage[] = [];
    for (let i = this.queues['next-step'].length - 1; i >= 0; i--) {
      const message = this.queues['next-step'][i]!;
      if (keep(message)) continue;
      this.splice('next-step', i, 1, []);
      discarded.unshift(message);
    }
    return discarded;
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
   * Take back one queued turn before it starts, by id.
   *
   * The person's "remove" on a queued message. Only `next-turn`: a steer is
   * claimed at the very next step boundary, usually before a click could land,
   * and withdrawing one the model may already have read would let the screen
   * disagree with the log. One splice, so a replay agrees it is gone.
   */
  withdraw(id: string): QueuedMessage | undefined {
    const at = this.queues['next-turn'].findIndex(m => m.id === id);
    if (at < 0) return undefined;
    const message = this.queues['next-turn'][at];
    this.splice('next-turn', at, 1, []);
    return message;
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
