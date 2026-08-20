/**
 * Reading current state out of an append-only log.
 *
 * The log records *decisions*, not state: a goal is paused by appending
 * "paused", a rating is changed by appending the new one. Nothing is ever
 * overwritten, so "what is true now" is always a fold over the events, and
 * that fold lives here rather than being re-implemented by each caller.
 *
 * Every function is a pure read. None of them mutate the session, which is what
 * makes them safe to call from a route handler on every request.
 *
 * @module session/projections
 */

import type { Session } from './session.js';
import type { Seq, SessionEvent } from './events.js';

// ── goals ────────────────────────────────────────────────────────────

export interface Goal {
  text: string;
  status: 'active' | 'paused' | 'cleared';
  /** When the current status was set. */
  since: number;
}

/**
 * The session's standing objective, or undefined if it has none.
 *
 * A cleared goal projects to undefined rather than to a record with
 * `status: 'cleared'` — the caller wants to know whether to show a goal bar,
 * and "there is a goal, but it is gone" is not a state a UI can render.
 */
export function currentGoal(session: Session): Goal | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    if (event?.type !== 'goal/set') continue;
    const data = event.data as { text: string; status: Goal['status'] };
    if (data.status === 'cleared') return undefined;
    return { text: data.text, status: data.status, since: event.timestamp };
  }
  return undefined;
}

/**
 * The agent this conversation is being held with, if it is not the orchestrator.
 *
 * A projection over the log rather than a field on the run, for the reason
 * everything else here is: the run is in memory and the log is on disk, so
 * reopening a session a week later has to be able to reconstruct who you were
 * talking to. Last write wins, and a cleared value ends it.
 */
export function currentAgent(session: Session): string | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    if (event?.type !== 'session/agent') continue;
    const name = (event.data as { name?: string | null }).name;
    return name ? String(name) : undefined;
  }
  return undefined;
}

// ── feedback ─────────────────────────────────────────────────────────

export interface Feedback {
  rating: 'up' | 'down';
  note?: string;
  at: number;
}

/**
 * Current rating for every rated message, keyed by the seq it judges.
 *
 * Built in one pass with later events overwriting earlier ones, so changing a
 * rating is just appending another. A rating of `none` is a withdrawal and
 * removes the entry rather than recording a third state — a UI showing
 * "explicitly unrated" alongside "never rated" would be distinguishing
 * something nobody cares about.
 */
export function feedbackBySeq(session: Session): Map<Seq, Feedback> {
  const ratings = new Map<Seq, Feedback>();
  for (const event of session.events) {
    if (event.type !== 'message/feedback') continue;
    const data = event.data as { targetSeq: Seq; rating: 'up' | 'down' | 'none'; note?: string };
    if (data.rating === 'none') { ratings.delete(data.targetSeq); continue; }
    ratings.set(data.targetSeq, {
      rating: data.rating,
      ...(data.note ? { note: data.note } : {}),
      at: event.timestamp,
    });
  }
  return ratings;
}

// ── deliverables ─────────────────────────────────────────────────────

export interface Deliverable {
  path: string;
  /** Whether the file was created or changed. */
  action: 'created' | 'modified';
  /** Seq of the tool call that produced it. */
  seq: Seq;
  /** How many times this turn touched it. */
  touches: number;
}

/** Tools whose arguments name a file the agent wrote. */
const WRITING_TOOLS: Record<string, 'created' | 'modified'> = {
  Write: 'created',
  write: 'created',
  WorkspaceWrite: 'created',
  Edit: 'modified',
  edit: 'modified',
  MultiEdit: 'modified',
  NotebookEdit: 'modified',
};

/** Argument names that carry a path, in the order they are preferred. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path'];

/**
 * Files this session produced, most recently touched first.
 *
 * Derived from the tool calls in the log rather than from the filesystem: the
 * question a reader is asking at the end of a turn is "what did *this run*
 * change", which a directory listing cannot answer.
 *
 * A file written and then edited three times is one deliverable with four
 * touches, not four rows — and it reports `created`, because that is what
 * happened to it first and is the more useful fact.
 *
 * @param sinceSeq only consider calls after this seq, to scope to one turn.
 */
export function deliverables(session: Session, sinceSeq = 0): Deliverable[] {
  const byPath = new Map<string, Deliverable>();

  for (const event of session.events) {
    if (event.seq <= sinceSeq || event.type !== 'tool/call') continue;
    const data = event.data as { name: string; arguments: string };
    const action = WRITING_TOOLS[data.name];
    if (!action) continue;

    const path = extractPath(data.arguments);
    if (!path) continue;

    const existing = byPath.get(path);
    if (existing) {
      existing.touches += 1;
      existing.seq = event.seq;
      continue;
    }
    byPath.set(path, { path, action, seq: event.seq, touches: 1 });
  }

  return [...byPath.values()].sort((a, b) => b.seq - a.seq);
}

/** Pull a file path out of a tool call's raw argument JSON. */
function extractPath(raw: string): string | undefined {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    args = parsed as Record<string, unknown>;
  } catch {
    // A truncated or malformed call is not a deliverable we can name.
    return undefined;
  }
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

// ── turn timing ──────────────────────────────────────────────────────

export interface StepTiming {
  turn: number;
  step: number;
  startedAt: number;
  /** First streamed token — the latency the user actually feels. */
  firstTokenAt?: number;
  endedAt?: number;
  /** Time to first token, in ms. */
  ttftMs?: number;
  /** Time spent streaming after the first token, in ms. */
  decodeMs?: number;
  /** Tokens reported for this step, when the provider said. */
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

/**
 * Per-step timing, split into waiting and streaming.
 *
 * The split is the point. A step that took nine seconds is a completely
 * different problem depending on whether eight of them were spent waiting for
 * the first token — a cold cache, a queued request, a slow provider — or spent
 * streaming a long answer, which is just the answer being long. One duration
 * cannot tell those apart, and they have opposite fixes.
 */
export function stepTimings(session: Session): StepTiming[] {
  const steps: StepTiming[] = [];
  let open: StepTiming | undefined;

  for (const event of session.events) {
    switch (event.type) {
      case 'step/start': {
        const data = event.data as { turn: number; step: number };
        open = { turn: data.turn, step: data.step, startedAt: event.timestamp };
        steps.push(open);
        break;
      }
      case 'assistant/chunk':
        // Only the first chunk marks the end of waiting; later ones are decode.
        if (open && open.firstTokenAt === undefined) {
          open.firstTokenAt = event.timestamp;
          open.ttftMs = event.timestamp - open.startedAt;
        }
        break;
      case 'assistant/message': {
        const usage = (event.data as { usage?: Record<string, number> }).usage;
        if (open && usage) {
          open.inputTokens = usage.inputTokens ?? usage.input_tokens;
          open.outputTokens = usage.outputTokens ?? usage.output_tokens;
          open.cachedTokens = usage.cachedTokens ?? usage.cache_read_input_tokens;
        }
        break;
      }
      case 'step/end':
        if (open) {
          open.endedAt = event.timestamp;
          // Prefer the recorded stamp; chunk events are only present when a
          // deployment has opted into full chunk capture.
          const stamped = (event.data as { firstTokenAt?: number }).firstTokenAt;
          if (stamped !== undefined && open.firstTokenAt === undefined) {
            open.firstTokenAt = stamped;
            open.ttftMs = stamped - open.startedAt;
          }
          // A step with no streamed text (a pure tool-call step) has no decode
          // phase; reporting one as zero would imply it streamed nothing
          // quickly rather than that it never streamed.
          if (open.firstTokenAt !== undefined) {
            open.decodeMs = event.timestamp - open.firstTokenAt;
          }
          open = undefined;
        }
        break;
      default:
        break;
    }
  }

  return steps;
}

/** Everything the trajectory view renders, in one read. */
export function trajectory(session: Session): {
  events: readonly SessionEvent[];
  steps: StepTiming[];
  deliverables: Deliverable[];
} {
  return {
    events: session.events,
    steps: stepTimings(session),
    deliverables: deliverables(session),
  };
}
