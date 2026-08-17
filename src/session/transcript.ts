/**
 * The seam between the agent loop and where its history lives.
 *
 * The loop records the same facts either way; only the destination differs:
 *
 *   • {@link SessionTranscript} writes durable events and re-derives the
 *     request from the log every step, so the log IS the request. This is the
 *     path that gives cross-turn tool fidelity, cache-friendly prefixes,
 *     faithful resume, and fork.
 *
 *   • {@link LegacyTranscript} keeps the old in-memory array and the XML
 *     history string. It exists so every shipped entry point — the readline
 *     REPL, the Ink TUI, the Electron bridge, sub-agents — keeps working
 *     unchanged while it migrates.
 *
 * Having both behind one interface is what makes the migration incremental
 * instead of a flag day.
 *
 * @module session/transcript
 */

import type { AicoMessage, ReasoningTrace, ToolCall } from '../providers/types.js';
import type { MessageSource, RequestHeader, TurnEndReason, Usage } from './events.js';
import type { Session } from './session.js';

/** What the agent loop needs from wherever its history is kept. */
export interface Transcript {
  /** Messages for the next provider request. */
  messages(): AicoMessage[];

  /**
   * Record user-role input.
   * @param source - provenance; defaults to human. Synthetic input (a guard
   *   reminder, a completion-gate nudge) must declare its plugin so a UI does
   *   not render it as something the user typed.
   */
  recordUserMessage(content: string, source?: MessageSource): void;

  /** Open a turn. Returns its number. */
  beginTurn(): number;
  /** Close the open turn with the reason it stopped. */
  endTurn(reason: TurnEndReason): void;

  /** Open a step. Returns its position. */
  beginStep(): { turn: number; step: number };
  /** Close the open step. */
  endStep(): void;

  /** Record one streamed text delta (no-op unless chunk capture is enabled). */
  recordChunk(text: string): void;

  /** Record one assistant reply, any tool calls it requested, and its reasoning trace. */
  recordAssistant(
    content: string,
    toolCalls: ToolCall[],
    usage?: Usage,
    reasoning?: ReasoningTrace,
  ): void;

  /** Record that a tool call was dispatched. */
  recordToolCall(call: ToolCall): void;

  /** Record the single model-facing outcome of a tool call. */
  recordToolResult(call: ToolCall, content: string, isError: boolean): void;

  /** Record the request route/prompt/tool-set identity when it changes. */
  recordRequestHeader(header: RequestHeader): void;

  /** The underlying session, when this transcript is backed by one. */
  readonly session?: Session;
}

// ── Session-backed ───────────────────────────────────────────────────

/** Options for a session-backed transcript. */
export interface SessionTranscriptOptions {
  /**
   * Persist every streamed delta as an `assistant/chunk` event.
   *
   * Off by default: chunk capture roughly triples log size, and its only
   * consumer is exact stream replay in a UI. Deployments that want
   * frame-accurate replay turn it on knowingly.
   */
  recordChunks?: boolean;
}

/** Records the loop's facts as durable session events. */
export class SessionTranscript implements Transcript {
  private turn = 0;
  private step = 0;
  private turnOpen = false;
  private stepOpen = false;
  /** Clock at this step's first streamed delta, for the TTFT/decode split. */
  private firstTokenAt: number | undefined;
  private readonly recordChunks: boolean;

  constructor(
    readonly session: Session,
    options: SessionTranscriptOptions = {},
  ) {
    this.turn = session.lastTurn;
    this.recordChunks = options.recordChunks ?? false;
  }

  messages(): AicoMessage[] {
    // Re-derived every call: the log is the request, not a mirror of it.
    return this.session.deriveMessages();
  }

  recordUserMessage(content: string, source: MessageSource = { kind: 'human' }): void {
    this.session.append('user/message', {
      turn: this.turn,
      content,
      source,
    }, { surfaceOp: { op: 'append' } });
  }

  beginTurn(): number {
    this.turn += 1;
    this.step = 0;
    this.turnOpen = true;
    this.session.append('turn/start', { turn: this.turn });
    return this.turn;
  }

  endTurn(reason: TurnEndReason): void {
    // Idempotent: the loop closes the turn in a `finally`, and an error path
    // may already have closed it. A double `turn/end` would break the balance
    // invariant, so swallow the second.
    if (!this.turnOpen) return;
    if (this.stepOpen) this.endStep();
    this.turnOpen = false;
    this.session.append('turn/end', { turn: this.turn, reason });
  }

  beginStep(): { turn: number; step: number } {
    this.step += 1;
    this.stepOpen = true;
    this.firstTokenAt = undefined;
    this.session.append('step/start', { turn: this.turn, step: this.step });
    return { turn: this.turn, step: this.step };
  }

  endStep(): void {
    if (!this.stepOpen) return;
    this.stepOpen = false;
    this.session.append('step/end', {
      turn: this.turn,
      step: this.step,
      ...(this.firstTokenAt !== undefined ? { firstTokenAt: this.firstTokenAt } : {}),
    });
  }

  recordChunk(text: string): void {
    if (!text) return;
    // Stamped even when chunks are not persisted: the *timing* of the first
    // delta is the useful signal, and keeping it costs one number per step
    // rather than one event per token.
    this.firstTokenAt ??= Date.now();
    if (!this.recordChunks) return;
    this.session.append('assistant/chunk', { turn: this.turn, step: this.step, text });
  }

  recordAssistant(
    content: string,
    toolCalls: ToolCall[],
    usage?: Usage,
    reasoning?: ReasoningTrace,
  ): void {
    this.session.append('assistant/message', {
      turn: this.turn,
      step: this.step,
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(usage ? { usage } : {}),
      ...(reasoning ? { reasoning } : {}),
    }, { surfaceOp: { op: 'append' } });
  }

  recordToolCall(call: ToolCall): void {
    this.session.append('tool/call', {
      turn: this.turn,
      step: this.step,
      callId: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input),
    });
  }

  recordToolResult(call: ToolCall, content: string, isError: boolean): void {
    // Cite the originating call so a transcript can link result to dispatch.
    const callSeq = this.findCallSeq(call.id);
    this.session.append('tool/result', {
      turn: this.turn,
      step: this.step,
      callId: call.id,
      name: call.name,
      content,
      ...(isError ? { isError: true } : {}),
    }, {
      surfaceOp: { op: 'append' },
      ...(callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] }),
    });
  }

  private findCallSeq(callId: string): number | undefined {
    const events = this.session.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type !== 'tool/call') continue;
      if ((event.data as { callId: string }).callId === callId) return event.seq;
    }
    return undefined;
  }

  recordRequestHeader(header: RequestHeader): void {
    this.session.recordRequestHeader(header);
  }
}

// ── Legacy in-memory ─────────────────────────────────────────────────

/**
 * The pre-session-log behaviour, preserved verbatim.
 *
 * History arrives already flattened into the seed message by the caller; this
 * transcript only accumulates the current run's messages, exactly as the loop
 * did before. Turn/step numbering is tracked so the loop's bookkeeping is
 * uniform, but nothing durable is written.
 */
export class LegacyTranscript implements Transcript {
  private readonly buffer: AicoMessage[] = [];
  private turn = 0;
  private step = 0;

  messages(): AicoMessage[] {
    return this.buffer;
  }

  recordUserMessage(content: string): void {
    this.buffer.push({ role: 'user', content });
  }

  beginTurn(): number {
    this.turn += 1;
    this.step = 0;
    return this.turn;
  }

  endTurn(): void { /* nothing durable to close */ }

  beginStep(): { turn: number; step: number } {
    this.step += 1;
    return { turn: this.turn, step: this.step };
  }

  endStep(): void { /* nothing durable to close */ }

  recordChunk(): void { /* chunks were never retained on this path */ }

  recordAssistant(
    content: string,
    toolCalls: ToolCall[],
    _usage?: Usage,
    reasoning?: ReasoningTrace,
  ): void {
    this.buffer.push({
      role: 'assistant',
      content,
      toolCalls,
      ...(reasoning ? { reasoning } : {}),
    });
  }

  recordToolCall(): void { /* the legacy path recorded only results */ }

  recordToolResult(call: ToolCall, content: string): void {
    this.buffer.push({
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name,
      content,
    });
  }

  recordRequestHeader(): void { /* no log to record into */ }
}
