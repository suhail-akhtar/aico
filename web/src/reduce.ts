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

import type { ChatMessage, MessageAttachment } from '@aico/ui';

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
  sessionId?: string,
): Map<number, ChatMessage> {
  const type = String(data.type ?? '');
  // Carried onto the messages that can be branched from. Only the conversation
  // itself has one; bookkeeping events do not, and neither do drafts.
  const turn = typeof data.turn === 'number' ? { turn: data.turn } : {};

  switch (type) {
    case 'user/message': {
      const next = new Map(logged);
      const content = String(data.content ?? '');

      /*
        Not everything on the user channel was written by the user.

        The loop speaks to the model through the same slot a person does: the
        truncation nudge, the completion gate, a compaction summary. The log has
        always recorded which is which, in `source` — the client just threw it
        away and drew a user bubble around all of it.

        The result was a session that appeared to argue with itself. A step cut
        off at the output ceiling produced an empty reply, then "you" said
        *Your previous step was cut off…*, three times over — and the honest
        reading of that screen is that something is stuck in a loop. Nobody had
        typed a word of it.

        So anything not from a person is a system note. Same text, no longer
        attributed to someone who did not say it.
      */
      const source = data.source as { kind?: string; plugin?: string; tool?: string } | undefined;
      const kind = source?.kind ?? 'human';
      if (kind !== 'human') {
        next.set(seq, {
          id: `seq-${seq}`,
          type: 'system',
          content: kind === 'compaction'
            // Earlier *steps* too, now: a long turn condenses itself as it runs.
            ? `Earlier conversation was condensed to save context.\n\n${content}`
            : content,
          // Named, because "the system said this" invites the next question.
          // A nudge you can attribute is one you can go and change.
          systemLabel: kind === 'plugin' ? (source?.plugin ?? 'aico')
            : kind === 'tool' ? (source?.tool ?? 'tool')
            : 'compaction',
          ...turn,
          timestamp: now,
        });
        return next;
      }

      const attachments = attachmentsOf(data, sessionId);
      next.set(seq, {
        id: `seq-${seq}`,
        type: 'user',
        // The file list written for the model is not something the person
        // typed; the bubble shows the files themselves instead.
        content: attachments.length ? stripAttachmentManifest(content) : content,
        ...(attachments.length ? { attachments } : {}),
        ...turn,
        timestamp: now,
      });
      return next;
    }

    /**
     * Who the conversation was addressed to, at the point it changed.
     *
     * Rendered in the transcript rather than only in the composer, because
     * reading a session back is the case that needs it most: without a mark in
     * the log there is no way to tell which replies came from the architect and
     * which from the orchestrator, and the composer only ever shows the current
     * answer.
     */
    case 'session/agent': {
      const name = data.name ? String(data.name) : null;
      const next = new Map(logged);
      next.set(seq, {
        id: `seq-${seq}`,
        type: 'system',
        content: name
          ? `Talking to ${name} from here — its role, its skills, its tools.`
          : 'Back to the orchestrator from here.',
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
          ...turn,
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
        ...turn,
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
  /**
   * Steers the loop has read during the running turn, keyed by inbox id.
   *
   * The log carries them, but the log reaches a client only when the turn
   * ends; until then this is where they appear, in the place they were read.
   */
  steers: Map<string, ChatMessage>;
  /** Order in which live entries appeared, so they render as they happened. */
  order: Array<{ kind: 'reasoning'; key: number } | { kind: 'tool'; key: string } | { kind: 'steer'; key: string }>;
}

export const emptyDraft = (): Draft => ({
  text: '', reasoning: new Map(), tools: new Map(), steers: new Map(), order: [],
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
    } else if (entry.kind === 'steer') {
      const steer = draft.steers.get(entry.key);
      if (steer) live.push(steer);
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
  attachments?: MessageAttachment[],
): Map<number, ChatMessage> {
  const next = new Map(logged);
  next.set(PENDING_KEY, {
    id: 'pending-user', type: 'user', content, timestamp: now,
    ...(attachments?.length ? { attachments } : {}),
  });
  return next;
}

/** The line the engine starts its file list with (src/server/attachments.ts). */
const MANIFEST_INTRO = '\n\nThe user attached these files.';

/** The message as the person typed it, without the file list appended for the model. */
export function stripAttachmentManifest(content: string): string {
  const at = content.indexOf(MANIFEST_INTRO);
  return at >= 0 ? content.slice(0, at) : content;
}

/** Where the engine serves an attachment of this session. */
export function attachmentUrl(sessionId: string, id: string): string {
  return `/api/attachments/file?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`;
}

/**
 * What a user message carried: the recorded `attachments`, or — for logs
 * written before those were recorded — the pictures in `images`.
 */
export function attachmentsOf(data: Record<string, unknown>, sessionId?: string): MessageAttachment[] {
  const recorded = Array.isArray(data.attachments) ? data.attachments as Array<Record<string, unknown>> : null;
  const images = Array.isArray(data.images) ? data.images as Array<Record<string, unknown>> : [];
  const raw: MessageAttachment[] = recorded
    ? recorded.map(a => ({
      id: String(a.id ?? ''), name: String(a.name ?? 'file'), mimeType: String(a.mimeType ?? ''),
      bytes: Number(a.bytes ?? 0), kind: a.kind === 'image' ? 'image' as const : 'file' as const,
    }))
    : images.map(i => ({
      id: String(i.id ?? ''), name: String(i.name ?? 'image'), mimeType: String(i.mediaType ?? 'image/png'),
      bytes: 0, kind: 'image' as const,
    }));
  return raw.filter(a => a.id).map(a => (sessionId ? { ...a, url: attachmentUrl(sessionId, a.id) } : a));
}

export function dropPending(logged: Map<number, ChatMessage>): Map<number, ChatMessage> {
  if (!logged.has(PENDING_KEY)) return logged;
  const next = new Map(logged);
  next.delete(PENDING_KEY);
  return next;
}

// ── Steer and Queue ────────────────────────────────────────────────────

/**
 * A message the person sent while a turn was running, not yet in the log.
 *
 * `id` arrives with the server's acknowledgement and names it in the `inbox`
 * frames; until then it is only on this screen ("sending").
 */
export interface PendingIntent {
  key: number;
  mode: 'steer' | 'followup';
  content: string;
  id?: string;
  /** Being taken back: its leaving the queue is not its turn starting. */
  withdrawing?: boolean;
}

/** The engine's `inbox` frame: what is waiting, and which steers were just read. */
export interface InboxFrame {
  nextStep?: Array<{ id: string; content: string }>;
  nextTurn?: Array<{ id: string; content: string }>;
  delivered?: Array<{ id: string; step: number }>;
}

/**
 * Bring the on-screen intents in line with the server's queues.
 *
 * The server is the truth for anything it has acknowledged: an id it no
 * longer lists was read (a steer), started (a queued turn) or withdrawn, and
 * an id it lists that this screen does not know — another tab, a reload — is
 * drawn too. Intents still being sent have no id yet and are kept as they are.
 * Keys are kept for ids already drawn so React does not remount them.
 */
export function reconcileIntents(
  local: PendingIntent[],
  frame: InboxFrame,
  nextKey: () => number,
): PendingIntent[] {
  const byId = new Map(local.filter(p => p.id).map(p => [p.id!, p]));
  // The frame usually beats the reply that names the message: an unknown id
  // whose text matches one still being sent is that one, not a second copy.
  const sending = local.filter(p => !p.id);
  const fromServer = (items: InboxFrame['nextStep'], mode: PendingIntent['mode']): PendingIntent[] =>
    (items ?? []).map(m => {
      const known = byId.get(m.id);
      if (known) return { ...known, mode };
      const at = sending.findIndex(p => p.mode === mode && p.content.trim() === m.content.trim());
      if (at >= 0) return { ...sending.splice(at, 1)[0]!, id: m.id };
      return { key: nextKey(), mode, content: m.content, id: m.id };
    });
  const listed = [...fromServer(frame.nextStep, 'steer'), ...fromServer(frame.nextTurn, 'followup')];
  return [...sending, ...listed];
}

/**
 * The queued message whose turn is starting, if this frame says one did.
 *
 * The server claims a queued message just before it starts its turn, so its
 * id leaving `nextTurn` is the earliest sign — earlier than `turn-start`,
 * which can fall in the gap while the stream reconnects after the last turn.
 * One at a time: the server starts one queued turn at a time.
 */
export function startedFollowup(local: PendingIntent[], frame: InboxFrame): PendingIntent | undefined {
  const still = new Set((frame.nextTurn ?? []).map(m => m.id));
  return local.find(p => p.mode === 'followup' && p.id && !p.withdrawing && !still.has(p.id));
}

/**
 * Put the steers the loop just read into the running turn, where they were read.
 *
 * Only intents this screen holds can be drawn (the frame carries ids, not
 * text). Returns the same draft when nothing was delivered.
 */
export function deliverSteers(
  draft: Draft,
  intents: PendingIntent[],
  delivered: InboxFrame['delivered'],
  now = Date.now(),
): Draft {
  if (!delivered?.length) return draft;
  let steers = draft.steers;
  let order = draft.order;
  for (const { id, step } of delivered) {
    const intent = intents.find(p => p.id === id && p.mode === 'steer');
    if (!intent || steers.has(id)) continue;
    if (steers === draft.steers) { steers = new Map(steers); order = [...order]; }
    steers.set(id, {
      id: `steer-${id}`, type: 'user', content: intent.content, steered: { step }, timestamp: now,
    });
    order.push({ kind: 'steer', key: id });
  }
  return steers === draft.steers ? draft : { ...draft, steers, order };
}

/** Where the replayed log stands: the open turn and its last step. */
export interface LogCursor { turn: number; step: number }

/**
 * Follow the log's turn and step boundaries, and mark a person's message read
 * mid-turn as a steer.
 *
 * A human message recorded after a step of its own turn can only have come
 * from the inbox at a step boundary — the turn's own request is recorded
 * before its first step — so it is marked with the step that read it. Same
 * answer live and on replay, because both read the same events.
 */
export function followLog(
  cursor: LogCursor | null,
  logged: Map<number, ChatMessage>,
  seq: number,
  data: Record<string, unknown>,
): { cursor: LogCursor | null; logged: Map<number, ChatMessage> } {
  const type = String(data.type ?? '');
  if (type === 'turn/start') return { cursor: { turn: Number(data.turn ?? 0), step: 0 }, logged };
  if (type === 'step/start') return { cursor: { turn: Number(data.turn ?? 0), step: Number(data.step ?? 0) }, logged };
  if (type !== 'user/message' || !cursor || cursor.step < 1 || Number(data.turn) !== cursor.turn) return { cursor, logged };
  const message = logged.get(seq);
  if (!message || message.type !== 'user') return { cursor, logged };
  const next = new Map(logged);
  next.set(seq, { ...message, steered: { step: cursor.step + 1 } });
  return { cursor, logged: next };
}
