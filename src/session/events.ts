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
/** One file the person attached to a message, for showing it back to them. */
export interface UserAttachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  kind: 'image' | 'file';
}

export interface RequestHeader {
  provider: string;
  model: string;
  /** Hash of the system prompt — the prompt itself would bloat every log. */
  systemHash: string;
  /** Tool names in registration order. */
  tools: string[];
  /**
   * A short hash per rendered prompt section, keyed by section id, so a
   * changed prefix can be attributed to the section that moved. Optional:
   * older logs have none, and equality is decided by `systemHash`.
   */
  sectionHashes?: Record<string, string>;
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
  'user/message': {
    turn: number; content: string; source: MessageSource;
    /**
     * What the person attached, as they would describe it: name, type, size.
     * Display only — the model learns of documents from the manifest in
     * `content` and of pictures from `images` — but without it a reopened chat
     * shows the question and not the file it was about.
     */
    attachments?: UserAttachment[];
  };

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

  /**
   * RECORD. Older tool output is shown as a placeholder from here on.
   *
   * Every maskable `tool/result` at or before `throughSeq` projects as a short
   * note saying what was there, and oversized arguments of the calls before it
   * are abbreviated (see `session/mask.ts`). Nothing is deleted. A record, not
   * a `replace`, because it changes how existing events render rather than
   * standing in for a range — and because it is sticky, the shortened prefix
   * is what gets cached afterwards.
   */
  'context/masked': {
    throughSeq: Seq;
    /** Where the full text of a masked result was kept, keyed by the result's seq. */
    spills?: Record<string, string>;
    /** Estimated tokens this mask removed from the request, for telemetry. */
    tokensFreed: number;
  };

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
   * RECORD. Which group this session is filed under, if any.
   *
   * In the log for the same reason the title and the archive flag are: it is
   * durable state about the session, and the log is the only durable state a
   * session has. A separate index would be a second thing to keep in step and
   * a migration the first time it changed shape.
   *
   * `null` removes the session from whatever group it was in. The current
   * group is simply the last one logged, so moving between groups is an
   * append rather than an edit.
   */
  'session/group': { group: string | null };

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
   * RECORD. This conversation is about one Mini App and nothing else.
   *
   * A binding rather than a topic. The app's identity, paths and schema go into
   * the system prompt for every turn of a bound session, which is what lets
   * "make the overdue column red" mean something without the reader restating
   * which app they are in — and what keeps that context in the cached prefix
   * instead of being re-sent as a message each turn.
   *
   * Logged so it survives a reload: a session that forgot what it was about
   * would answer the next question against the wrong app.
   */
  'session/miniapp': {
    /** The app's slug, or null to unbind and return to an ordinary session. */
    slug: string | null;
  };

  /**
   * RECORD. Work was handed to a sub-agent.
   *
   * A delegated stretch of a turn is otherwise invisible in the log: the
   * parent records one `tool/call` for `Task` and then nothing for however
   * many minutes the child takes. Reading that back, a six-minute delegation
   * and a six-minute hang are the same shape.
   *
   * Only the spawn and the outcome are logged. Which tool the child is running
   * right now changes several times a second, means nothing once it is over,
   * and belongs on the live stream rather than in the file every request is
   * derived from.
   */
  'agent/spawn': {
    agentId: string;
    agentType: string;
    /** What it was asked to do, in the parent's words. */
    description: string;
    model: string;
    /** 1 for a child of the main run, 2 for a child of that, and so on. */
    depth: number;
  };

  /**
   * RECORD. How a delegation ended.
   *
   * Paired with `agent/spawn` by `agentId` rather than by position, because
   * sub-agents run concurrently and finish out of order.
   */
  'agent/done': {
    agentId: string;
    status: 'completed' | 'failed' | 'cancelled';
    toolCalls: number;
    ms: number;
    inputTokens: number;
    outputTokens: number;
    error?: string;
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
   * RECORD. Who this conversation is being held with.
   *
   * A session can be addressed to one specialist instead of the orchestrator,
   * and that choice outlives the turn that made it — so it belongs in the log
   * rather than on the in-memory run. Reopening the session a week later has to
   * restore the same persona, and "switched to the reviewer at 14:02, back to
   * the orchestrator at 14:40" is worth being able to reconstruct.
   *
   * A null name means back to the orchestrator.
   */
  'session/agent': {
    name: string | null;
  };

  /**
   * SURFACE. The model this conversation is being held with.
   *
   * Here for exactly the reason `session/agent` is: the choice outlives the
   * turn that made it, so it belongs in the log rather than on the in-memory
   * run or — as it was — in a browser tab.
   *
   * It used to live only in client state. Nothing wrote it down, so switching
   * models held until the next reload and then silently reverted to the global
   * default, which is the worst possible shape for a setting: it looks like it
   * worked, and the evidence that it did not arrives much later. Sessions also
   * could not differ from each other, because there was one value for the whole
   * tab rather than one per conversation.
   *
   * Recorded as a change rather than per turn. `request/header` already logs
   * which model actually served each request; this is the standing choice,
   * which has to survive a session with no turns in it yet.
   *
   * A null model means *follow the configured default again*, exactly as a null
   * name in `session/agent` means back to the orchestrator. Without a way to
   * say that, a pin set once outranks every later change in settings for the
   * life of the session, and the settings screen becomes a liar for reasons
   * nobody can see.
   */
  'session/model': {
    model: string | null;
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

  /**
   * RECORD. One project check ran (ADR 0034).
   *
   * The tool result a model reads is prose; a reviewer's report needs the exit
   * code and the counts as data. Appended by `RunChecks` for every check it
   * actually ran (a check it skipped after a failure has no event, which is
   * what lets the change packet say "not run" and mean it). `outcome: 'flaky'`
   * means the check failed, its failing tests were re-run once and passed:
   * the check is *not* green and the event names the tests.
   */
  'check/run': {
    name: string;
    command: string;
    /** Sub-project directory, relative to the run's root, when not the root. */
    cwd?: string;
    outcome: 'passed' | 'failed' | 'flaky';
    /** The process exit code; null for the in-process security check. */
    exitCode: number | null;
    ms: number;
    builtin?: 'security';
    /** What the runner reported, when its output could be read (`test-results.ts`). */
    tests?: { runner: string; passed: number; failed: number; skipped: number; unit?: 'tests' | 'packages'; failures: string[] };
    /** The one re-run of the failing tests: what was re-run and what happened. */
    retry?: { basis: 'tests' | 'whole-check'; tests: string[]; passed: boolean; flaky?: string[] };
    /** For `security`: the built-in scan's counts. */
    findings?: { secrets: number; high: number; medium: number; advisories: number };
  };

  /**
   * RECORD. A tool call was allowed or refused, and by whom (ADR 0034).
   *
   * `by: 'person'` is an answer to a permission dialog; `by: 'policy'` is a
   * guard denying (hook, plan mode, bash safety, scope, sandbox, shell
   * confinement…) with the stage's own reason. Records the decision only — the
   * call's result is still the `tool/result`. Calls auto-approved by a
   * setting have no event: nobody decided.
   */
  'tool/decision': {
    callId: string;
    name: string;
    decision: 'approved' | 'denied';
    by: 'person' | 'policy';
    reason?: string;
    /** The guard that refused (`managed-policy`, `permission`, `sentinel`, …); read by the audit export (ADR 0035). */
    stage?: string;
  };

  /**
   * RECORD. A supply-chain, secret, SAST or test-tamper control found something (ADR 0033).
   *
   * The nudge or refusal a model reads is prose; the change-evidence report
   * (ADR 0034) needs what was checked and what was found as data. One event per
   * finding, appended by the guards and gates in `security/change-safety.ts`
   * and `tools/supply-chain-guard.ts`. Old logs have none and render "no
   * record". `detail` never holds a secret value — a pattern name and a length
   * at most.
   */
  'safety/finding': {
    turn: number;
    control: 'supply-chain' | 'secret' | 'sast' | 'test-tamper';
    /** `package-missing`, `package-new`, `secret`, a SAST rule id, `test-file-deleted`, `skip-marker-added`… */
    rule: string;
    severity: 'high' | 'medium' | 'info';
    outcome: 'denied' | 'approved-by-person' | 'refused-commit' | 'nudged' | 'reported' | 'advisory';
    /** Project-relative, forward slashes. */
    file?: string;
    line?: number;
    /** `npm:left-padz`, `tests/a.test.ts`. */
    subject?: string;
    /** At most 300 characters. */
    detail: string;
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
