/**
 * Run lifecycle for the web server.
 *
 * The same adapter shape the Electron bridge uses — engine callbacks in, stream
 * events out — with one difference that matters: a browser client is not the
 * owner of the run. Closing the tab must not cancel work, and reopening it must
 * find the run still going. So run state lives here, keyed by session, and
 * outlives any particular connection.
 *
 * @module server/runs
 */

import { runAgent } from '../agent.js';
import { setBashProgressSink } from '../tools/bash.js';
import { createTokenTracker } from '../tokens.js';
import { openSession } from '../session/open.js';
import { loadSettings } from '../settings.js';
import { instructionsFor } from './projects.js';
import { groupInstructions } from './groups.js';
import { Inbox } from '../session/inbox.js';
import type { Session } from '../session/session.js';
import type { AicoSettings } from '../settings.js';
import type { EventHub } from './events.js';
import { currentTitle } from '../session/title.js';
import {
  currentGoal, feedbackBySeq, deliverables, trajectory,
} from '../session/projections.js';
import { summarizeLastTurn } from '../session/summary.js';
import { writeFallbackTitle, writeUserTitle, generateModelTitle } from '../session/title-service.js';

/**
 * The project's instructions, then the group's.
 *
 * Both, in that order, because a group is the narrower choice: you put *this*
 * conversation in it deliberately, while the project applies to everything in
 * the folder. Later wins where they conflict, which is the whole reason the
 * order is stated rather than left to whichever resolved first.
 */
async function combinedInstructions(
  cwd: string,
  group: string | undefined,
): Promise<string | undefined> {
  const [project, grouped] = await Promise.all([
    instructionsFor(cwd),
    groupInstructions(group),
  ]);
  return [project, grouped].filter(Boolean).join('\n\n') || undefined;
}

export interface ActiveRun {
  sessionId: string;
  cwd: string;
  session: Session;
  inbox: Inbox;
  tokenTracker: ReturnType<typeof createTokenTracker>;
  abort: AbortController;
  /** Detach the log's persistence and flush. */
  close: () => Promise<void>;
  /** True while a turn is in flight — a second submit is rejected, not queued. */
  busy: boolean;
  conversationHistory: Array<{ role: string; content: string }>;
}

export class RunManager {
  private readonly runs = new Map<string, ActiveRun>();

  constructor(
    private readonly hub: EventHub,
    /**
     * Settings as they were when the server started.
     *
     * A fallback only. Every turn re-reads them from disk, because the settings
     * screen writes there and a long-lived server that captured them once would
     * keep routing to the provider that was active when it booted. That is
     * exactly what happened: switching the active provider appeared to work,
     * then failed with the *old* provider complaining about the *new* model,
     * and "restart the server" was the only fix anyone found.
     */
    private readonly bootSettings: AicoSettings,
  ) {}

  /**
   * The settings this turn should run under.
   *
   * Read fresh. `loadSettings` is three small file reads and a merge, which is
   * nothing beside a model call, and the alternative is a cache with no
   * invalidation path — the settings screen writes to disk from a different
   * request, and there is no signal back into this object.
   */
  private async currentSettings(): Promise<AicoSettings> {
    try {
      return await loadSettings();
    } catch {
      return this.bootSettings;
    }
  }

  /** Open (or rejoin) a session. Idempotent — reconnecting must not reset state. */
  async ensure(sessionId: string, cwd: string): Promise<ActiveRun> {
    const existing = this.runs.get(sessionId);
    if (existing) return existing;

    const opened = await openSession(sessionId, cwd);
    const run: ActiveRun = {
      sessionId,
      cwd,
      session: opened.session,
      inbox: new Inbox(opened.session),
      tokenTracker: createTokenTracker(),
      abort: new AbortController(),
      close: opened.close,
      busy: false,
      conversationHistory: [],
    };
    this.runs.set(sessionId, run);
    return run;
  }

  get(sessionId: string): ActiveRun | undefined {
    return this.runs.get(sessionId);
  }

  list(): ActiveRun[] {
    return [...this.runs.values()];
  }

  /**
   * Start a turn. Resolves when the turn finishes.
   *
   * Rejects rather than queues when a turn is already running: the inbox is the
   * supported way to add input mid-run (`steer` for this turn, `followup` for
   * the next), and silently queueing a second submit would give two different
   * behaviours for what looks like one action.
   */
  async submit(
    sessionId: string,
    cwd: string,
    task: string,
    model: string,
    opts: { planMode?: boolean; autoApprove?: boolean; effort?: string } = {},
  ): Promise<string> {
    const run = await this.ensure(sessionId, cwd);
    if (run.busy) throw new Error('A turn is already running — use steer or followup');

    const settings = await this.currentSettings();

    run.busy = true;
    // Fresh per turn: an AbortController is single-use, so reusing one would
    // make every turn after the first cancellation start pre-aborted.
    run.abort = new AbortController();

    const emit = (type: string, data: unknown): void =>
      this.hub.publish({ type, sessionId, data });

    // Named before the work begins: a turn can take minutes, and an unnamed
    // row in the sidebar for all of them is the common case, not the edge one.
    const named = writeFallbackTitle(run.session, task);
    if (named) emit('title', named);

    // Remembered so the turn's deliverables can be scoped to this turn rather
    // than reporting everything the session has ever written.
    const seqBeforeTurn = run.session.length;

    emit('turn-start', { task, model });

    try {
      const result = await runAgent({
        task,
        model,
        // The run's own directory, not the server's. This is what lets one
        // server drive sessions in several projects at once; before `runAgent`
        // took a cwd, every session silently worked in whatever directory the
        // server process happened to be started in.
        cwd: run.cwd,
        // Whatever the user attached to this folder, re-read per turn so an
        // edit takes effect on the next message rather than the next restart.
        ...(await combinedInstructions(run.cwd, this.groupOf(sessionId) ?? undefined)
          .then(v => (v ? { projectInstructions: v } : {}))),
        showPlan: false,
        verbose: false,
        silent: true,
        conversationHistory: run.conversationHistory,
        sessionId,
        session: run.session,
        inbox: run.inbox,
        tokenTracker: run.tokenTracker,
        settings,
        autoApprove: opts.autoApprove ?? true,
        planMode: opts.planMode ?? false,
        ...(opts.effort ? { effort: opts.effort } : {}),
        abortSignal: run.abort.signal,

        onChunk: (text) => emit('chunk', { text }),
        onReasoning: (text, step) => emit('reasoning', { text, step }),
        onToolCall: (name, args, callId) => {
          emit('tool-start', { name, args, callId });
          // A long command's own output is the only honest answer to "is this
          // still working". Scoped to the call that is running, so partial
          // output lands on the right card.
          if (name === 'Bash') {
            setBashProgressSink(({ output, elapsedMs }) =>
              emit('tool-progress', { callId, output, elapsedMs }));
          }
        },
        onToolDone: (name, result, callId) => {
          if (name === 'Bash') setBashProgressSink(undefined);
          emit('tool-done', { name, result, callId });
        },
        onTokens: (input, output, cached, cacheWrite) => emit('tokens', {
          input, output, cached, cacheWrite,
          costUsd: run.tokenTracker.estimateCost(model),
        }),
      });

      run.conversationHistory.push({ role: 'user', content: task });
      run.conversationHistory.push({ role: 'assistant', content: result });
      emit('turn-end', {
        result,
        seq: run.session.length,
        // Derived server-side and delivered with the turn, so the client
        // renders what the turn produced without a second round trip and
        // without a second copy of the derivation logic.
        deliverables: deliverables(run.session, seqBeforeTurn),
        // A turn that merely stops tells you nothing about whether it is
        // finished. The log knows why it ended; this says so.
        summary: summarizeLastTurn(run.session),
      });

      // Deliberately not awaited: the turn is finished as far as the user is
      // concerned, and a naming call must never hold it open. Failures are
      // swallowed inside — the fallback name was already good enough.
      void generateModelTitle(run.session, task, result, { settings, workModel: model })
        .then(title => { if (title) emit('title', title); });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Cancellation is an outcome, not a failure — a client that treats every
      // non-success as an error shows a red banner for a button the user pressed.
      emit('turn-end', {
        error: message,
        cancelled: run.abort.signal.aborted,
        seq: run.session.length,
      });
      throw err;
    } finally {
      run.busy = false;
    }
  }

  /** Explicit rename. Pins the name — automatic naming stops for this session. */
  rename(sessionId: string, title: string): boolean {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    const record = writeUserTitle(run.session, title);
    if (!record) return false;
    this.hub.publish({ type: 'title', sessionId, data: record });
    return true;
  }

  /**
   * Flush a session's log and let go of it.
   *
   * `close` detaches persistence, so a run left in the map afterwards would
   * look open and silently stop recording. Dropping it means the next `ensure`
   * reopens from disk, which is the same path a reconnect takes.
   */
  async release(sessionId: string): Promise<boolean> {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    if (run.busy) return false;
    await run.close();
    this.runs.delete(sessionId);
    return true;
  }

  /**
   * File a session away, or bring it back.
   *
   * Appended to the log rather than written to a side table, so the state
   * survives a restart with nothing to keep in sync. The transcript is
   * untouched — archiving hides a row, it does not destroy a conversation.
   */
  setArchived(sessionId: string, archived: boolean): boolean {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    run.session.append('session/archived', { archived });
    this.hub.publish({ type: 'archived', sessionId, data: { archived } });
    return true;
  }

  /**
   * The session's current title record, if it has one.
   *
   * The whole record, not just the text: a listing that took the name from
   * memory but its provenance from a disk scan would report a model-written
   * title as provisional until the log happened to flush.
   */
  titleOf(sessionId: string): ReturnType<typeof currentTitle> {
    const run = this.runs.get(sessionId);
    return run ? currentTitle(run.session) : undefined;
  }

  /** File a session under a group, or take it out of one. */
  setGroup(sessionId: string, group: string | null): boolean {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    run.session.append('session/group', { group });
    this.hub.publish({ type: 'group', sessionId, data: { group } });
    return true;
  }

  /** The group an open session is in, fresher than the log scan. */
  groupOf(sessionId: string): string | null | undefined {
    const run = this.runs.get(sessionId);
    if (!run) return undefined;
    let group: string | null | undefined;
    for (const event of run.session.events) {
      if (event.type === 'session/group') {
        group = (event.data as { group?: string | null }).group ?? null;
      }
    }
    return group;
  }

  /**
   * Whether an open session is archived, according to memory.
   *
   * The same freshness problem the title has, and the same answer. Archiving
   * appends an event, persistence flushes it asynchronously, and the listing
   * reads the file — so a listing fetched immediately after the click reports
   * the state from before it and the row reappears.
   */
  archivedOf(sessionId: string): boolean | undefined {
    const run = this.runs.get(sessionId);
    if (!run) return undefined;
    let archived: boolean | undefined;
    for (const event of run.session.events) {
      if (event.type === 'session/archived') {
        archived = (event.data as { archived?: boolean }).archived === true;
      }
    }
    return archived;
  }

  /** Set, pause, resume or clear the session's standing objective. */
  setGoal(sessionId: string, text: string, status: 'active' | 'paused' | 'cleared'): boolean {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    run.session.append('goal/set', { text, status });
    this.hub.publish({ type: 'goal', sessionId, data: { text, status } });
    return true;
  }

  goalOf(sessionId: string): ReturnType<typeof currentGoal> {
    const run = this.runs.get(sessionId);
    return run ? currentGoal(run.session) : undefined;
  }

  /** Rate one assistant message. `none` withdraws a previous rating. */
  rate(sessionId: string, targetSeq: number, rating: 'up' | 'down' | 'none', note?: string): boolean {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    run.session.append('message/feedback', {
      targetSeq, rating, ...(note ? { note } : {}),
    });
    this.hub.publish({ type: 'feedback', sessionId, data: { targetSeq, rating, note } });
    return true;
  }

  feedbackOf(sessionId: string): Record<number, unknown> {
    const run = this.runs.get(sessionId);
    if (!run) return {};
    return Object.fromEntries(feedbackBySeq(run.session));
  }

  /** Everything the trajectory view reads, in one pass over the log. */
  trajectoryOf(sessionId: string): ReturnType<typeof trajectory> | undefined {
    const run = this.runs.get(sessionId);
    return run ? trajectory(run.session) : undefined;
  }

  deliverablesOf(sessionId: string, sinceSeq = 0): ReturnType<typeof deliverables> {
    const run = this.runs.get(sessionId);
    return run ? deliverables(run.session, sinceSeq) : [];
  }

  cancel(sessionId: string): boolean {
    const run = this.runs.get(sessionId);
    if (!run || !run.busy) return false;
    run.abort.abort();
    return true;
  }

  /** Deliver into the running turn at its next step boundary. */
  steer(sessionId: string, content: string): boolean {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    run.inbox.steer(content);
    return true;
  }

  /** Queue as its own next turn, leaving the running one alone. */
  followup(sessionId: string, content: string): boolean {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    run.inbox.followup(content);
    return true;
  }

  /** Flush every session's log. Called on shutdown so nothing is lost. */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.runs.values()].map(r => r.close()));
    this.runs.clear();
  }
}
