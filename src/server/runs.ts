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
import { getContextWindow, resolveWindow } from '../context-window.js';
import { openSession } from '../session/open.js';
import { loadSettings } from '../settings.js';
import { instructionsFor } from './projects.js';
import { groupInstructions } from './groups.js';
import { Inbox } from '../session/inbox.js';
import { setAskUserCallback } from '../tools/askuser.js';
import type { Session } from '../session/session.js';
import type { AicoSettings } from '../settings.js';
import type { EventHub } from './events.js';
import { currentTitle } from '../session/title.js';
import {
  currentGoal, currentAgent, currentModel, feedbackBySeq, deliverables, trajectory,
} from '../session/projections.js';
import { personaFor, resolveAgent } from '../agents/resolve.js';
import { activeProviderType } from '../providers/instances.js';
import type { ImageRef } from '../providers/types.js';
import { readFile } from 'fs/promises';
import { summarizeLastTurn } from '../session/summary.js';
import { writeFallbackTitle, writeUserTitle, generateModelTitle } from '../session/title-service.js';
import { getAgentRegistry, subscribeToAgents, type SubAgentStatus } from '../tools/task.js';
import { currentMiniApp } from '../session/projections.js';
import { miniAppContext } from '../miniapps/context.js';
import { getMiniApp, miniAppDir } from '../miniapps/store.js';

/**
 * The app context for a session bound to a Mini App, or nothing.
 *
 * Resolved per turn rather than captured when the session opened: the schema
 * and the file list are exactly what a build session keeps changing, and a
 * prefix describing the app as it was an hour ago is worse than none.
 */
async function miniAppInstructions(
  session: Session,
  settings: AicoSettings,
  cwd: string,
): Promise<string | undefined> {
  const slug = currentMiniApp(session);
  if (!slug) return undefined;
  try {
    const app = await getMiniApp(slug, settings, cwd);
    if (!app) return undefined;
    const host = settings.miniApps?.port
      ? `http://${settings.miniApps.host ?? '127.0.0.1'}:${settings.miniApps.port}`
      : 'http://127.0.0.1:<aico port + 1>';
    // Whether anything is actually listening. An agent told to open a URL that
    // answers nothing goes looking for the server rather than concluding the
    // plugin is off — see the note on `served`.
    const served = settings.miniApps?.enabled === true;
    return await miniAppContext(
      app, miniAppDir(slug, settings, cwd), `${host}/${slug}/`, served,
    );
  } catch {
    // A session bound to an app that has since been deleted still works; it
    // simply behaves as an ordinary conversation rather than refusing to run.
    return undefined;
  }
}

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
  /**
   * A question the agent is blocked on, and the promise waiting for the answer.
   *
   * Held on the run rather than in a module map so it cannot outlive the turn
   * that asked, and so two sessions asking at once cannot answer each other.
   */
  pendingQuestion?: { question: string; resolve: (answer: string) => void; at: number };
  /**
   * A tool call waiting to be allowed, and the promise holding the turn.
   *
   * Same shape and same reasoning as `pendingQuestion`, with one addition: an
   * `id`. A question can be answered by whatever is on screen, because there is
   * only ever one. A permission decision must name the call it is deciding —
   * a reconnecting client that answers the *previous* prompt would allow a tool
   * the reader never saw.
   */
  pendingPermission?: PendingPermission;
  /** How this run's tool calls are approved. Fixed for the turn. */
  approval: ApprovalMode;
  conversationHistory: Array<{ role: string; content: string }>;
}

export interface PendingPermission {
  id: string;
  tool: string;
  detail: string;
  fileDiff?: { path: string; added?: string[]; removed?: string[]; preview?: string };
  resolve: (allowed: boolean) => void;
  at: number;
}

/**
 * How much a run asks before acting.
 *
 * `auto` is the default and is what every web session has always done — the
 * browser workspace has never prompted, and changing that silently would turn
 * every existing user's next run into a series of modal dialogs.
 *
 * `edits` exists because the two risks are not the same. Writing a file inside
 * a project you opened is the work; running a shell command is the thing worth
 * being asked about. Collapsing them into one switch means people turn the whole
 * thing off after the fourth dialog about a file they expected to change.
 */
export type ApprovalMode = 'auto' | 'edits' | 'ask';

/**
 * Tools that `edits` lets through without asking.
 *
 * Deliberately only the file writers. `Terminal` is absent and should stay
 * absent: a shell command can do anything a file write can and everything it
 * cannot, and "auto-accept edits" would be a lie if it also ran commands.
 */
const EDIT_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
]);

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
      // Until a turn says otherwise. Every web session before this existed ran
      // this way, and a default of anything else would change their behaviour
      // without anyone asking for it.
      approval: 'auto',
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
    opts: {
      planMode?: boolean; autoApprove?: boolean; effort?: string;
      /** How much to ask before acting. Defaults to `auto`, as it always was. */
      approval?: ApprovalMode;
      /** Images the reader attached to this turn, by attachment id. */
      images?: ImageRef[];
    } = {},
  ): Promise<string> {
    const run = await this.ensure(sessionId, cwd);
    if (run.busy) throw new Error('A turn is already running — use steer or followup');
    run.approval = opts.approval ?? 'auto';

    const settings = await this.currentSettings();
    const goal = currentGoal(run.session);

    // Who this conversation is being held with. Resolved per turn from the log
    // so a change takes effect on the next message, and so reopening the
    // session a week later restores the same persona.
    // Honoured here as well as in the UI. Hiding the picker while the server
    // still ran a stored persona would leave sessions addressed to an agent
    // with no visible way to tell, or to change it back.
    const directChat = settings.agents?.directChat !== false;
    const agentName = directChat ? currentAgent(run.session) : undefined;
    const agent = await personaFor(agentName, run.cwd);
    const activeGoal = goal?.status === 'active' ? goal.text : undefined;

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

    // Said out loud. A session addressed to an agent that has since been
    // deleted or switched off used to run as the orchestrator with nothing on
    // screen to explain why the replies had changed character.
    if (agent.notice) emit('notice', { text: agent.notice });

    emit('turn-start', { task, model });

    // The agent can ask a question, and until now the web had no way to hear
    // it. `askUser` falls back to readline when nothing registers a callback,
    // so a question asked from a browser session was printed on the *server's*
    // terminal and the turn blocked on stdin nobody was watching — a silent
    // hang for up to the hour that tool is allowed. Registered per turn, so
    // the answer is delivered to the run that asked.
    setAskUserCallback((question) => new Promise<string>((resolve) => {
      run.pendingQuestion = { question, resolve, at: Date.now() };
      emit('question', { question });
    }));

    /**
     * Ask before a tool runs, when the turn was submitted that way.
     *
     * Undefined for `auto`, and that matters: the engine only consults a
     * callback when `autoApprove` is false, and passing one that always
     * resolves true would be a slower way of doing nothing while making every
     * tool call wait for a promise.
     *
     * The absence of this used to be a trap. Without a callback the engine falls
     * back to `checkPermission`, which reads stdin and writes stdout — fine in a
     * terminal, and in a server a turn blocked for ever on input nobody could
     * see. That is why `approval` and this callback are set together and never
     * separately.
     */
    const onPermissionRequest = run.approval === 'auto' ? undefined
      : (tool: string, detail: string, fileDiff?: PendingPermission['fileDiff']) =>
        new Promise<boolean>((resolve) => {
          if (run.approval === 'edits' && EDIT_TOOLS.has(tool)) { resolve(true); return; }

          /*
            One prompt at a time.

            Tool calls can run up to eight in parallel, and a second prompt
            would overwrite the first — leaving its promise unresolved and the
            turn hung on a dialog nobody will ever see. Refusing the second is
            recoverable: the model is told it was denied and can ask again.
          */
          if (run.pendingPermission) { resolve(false); return; }

          const pending: PendingPermission = {
            id: `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            tool, detail, fileDiff, resolve, at: Date.now(),
          };
          run.pendingPermission = pending;
          emit('permission', {
            id: pending.id, tool, detail, ...(fileDiff ? { fileDiff } : {}),
          });
        });

    /**
     * Sub-agent activity, which the browser previously could not see at all.
     *
     * A delegated turn looked exactly like a hung one: the transcript stopped,
     * the activity line said "Running Task", and the work — minutes of it,
     * across a dozen tool calls — happened somewhere the page had no window
     * onto. The registry has always tracked it; only the terminal UI ever
     * subscribed.
     *
     * Split deliberately between the two channels this server already has:
     *
     * **The log gets the facts.** A spawn and its outcome are durable, so they
     * replay after a reload — which has to be true, because closing the tab is
     * supposed to be safe and a turn that delegated for six minutes would
     * otherwise come back looking like it did nothing.
     *
     * **The hub gets the ticker.** Which tool a child is on changes constantly
     * and means nothing an hour later. Writing that to an append-only log would
     * be pure noise in the file that everything else is derived from.
     */
    const seenAgents = new Map<string, SubAgentStatus>();
    /*
      Set when the turn ends, so the subscription can outlive it exactly as long
      as the work does.

      A detached sub-agent keeps running after the turn that spawned it returns
      — that is the whole point of detaching. Tearing the subscription down at
      turn end would freeze the panel on whatever the child was doing at that
      instant, which is worse than showing nothing: it reads as a live view and
      is not one.
    */
    let turnOver = false;
    let releaseAgents: (() => void) | undefined;
    const detachAgents = subscribeToAgents((records) => {
      const mine = records.filter(r => r.sessionId === sessionId);

      for (const agent of mine) {
        const before = seenAgents.get(agent.agentId);
        if (before === agent.status) continue;
        seenAgents.set(agent.agentId, agent.status);

        if (before === undefined) {
          run.session.append('agent/spawn', {
            agentId: agent.agentId,
            agentType: agent.agentType,
            description: agent.description,
            model: agent.model,
            depth: agent.depth,
          });
          continue;
        }
        if (agent.status === 'running') continue;

        run.session.append('agent/done', {
          agentId: agent.agentId,
          status: agent.status,
          toolCalls: agent.toolCallCount,
          ms: (agent.completedAt ?? Date.now()) - agent.startedAt,
          inputTokens: agent.inputTokens,
          outputTokens: agent.outputTokens,
          ...(agent.error ? { error: agent.error } : {}),
        });
      }

      // Everything this session owns, running or not, so a panel can show the
      // ones that finished during the turn rather than having them vanish the
      // instant they succeed.
      emit('subagents', { agents: mine });

      // Once the turn is over and nothing of this session's is still running,
      // there is nothing left to report. Released from inside the subscriber so
      // the last frame — the one saying it finished — always gets out first.
      if (turnOver && !mine.some(a => a.status === 'running')) releaseAgents?.();
    });
    releaseAgents = () => {
      detachAgents();
      releaseAgents = undefined;
    };

    try {
      const result = await runAgent({
        task,
        // References go to the log; the bytes are fetched per request by the
        // resolver below. Whether they are fetched at all is a question about
        // the model, answered inside the run where the model is known.
        ...(opts.images?.length ? { images: opts.images } : {}),
        resolveImages: async (refs) => {
          const { resolveAttachment } = await import('./attachments.js');
          return Promise.all(refs.map(async (ref) => {
            try {
              const found = await resolveAttachment({
                settings, cwd: run.cwd, sessionId, id: ref.id,
              });
              return {
                data: (await readFile(found.path)).toString('base64'),
                mediaType: ref.mediaType,
                ...ref.name ? { name: ref.name } : {},
              };
            } catch {
              // One missing attachment must not cost the others. Answered
              // positionally, so this slot is empty and the rest still arrive
              // against the messages they belong to.
              return undefined;
            }
          }));
        },
        // An agent pinned to a model gets it, unless the caller named one
        // explicitly — an explicit choice is a decision, the pin is a default.
        model: model ?? agent.model ?? model,
        // The run's own directory, not the server's. This is what lets one
        // server drive sessions in several projects at once; before `runAgent`
        // took a cwd, every session silently worked in whatever directory the
        // server process happened to be started in.
        cwd: run.cwd,
        // Whatever the user attached to this folder, re-read per turn so an
        // edit takes effect on the next message rather than the next restart.
        /*
          Folder instructions, group instructions, and — for a session bound to
          a Mini App — everything about that app.

          All of it lands in the system prompt, which is the cached prefix. A
          bound session therefore pays for the app's schema, file list and
          contract once and reads them from cache on every turn after, rather
          than re-sending a couple of thousand tokens per message. Putting them
          in the messages instead would cost full price every turn *and* change
          the tail each time, which is the thing that stops a cache hitting.
        */
        ...(await (async () => {
          const parts = [
            await combinedInstructions(run.cwd, this.groupOf(sessionId) ?? undefined),
            await miniAppInstructions(run.session, settings, run.cwd),
          ].filter(Boolean);
          return parts.length ? { projectInstructions: parts.join('\n\n') } : {};
        })()),
        // Only while active. A paused goal is one the user explicitly set
        // aside, and telling the model to pursue it anyway would make the
        // pause button a lie.
        ...(activeGoal ? { goal: activeGoal } : {}),
        showPlan: false,
        verbose: false,
        silent: true,
        conversationHistory: run.conversationHistory,
        sessionId,
        session: run.session,
        inbox: run.inbox,
        tokenTracker: run.tokenTracker,
        settings,
        // The agent's own system prompt, with its skills' procedures inlined.
        // Same resolver the Task tool uses, so an agent behaves identically
        // whether it was delegated to or is being spoken to directly.
        ...(agent.persona ? { agentPersona: agent.persona } : {}),
        ...(agent.tools?.length ? { agentSpecTools: agent.tools } : {}),
        /*
          The two halves of one decision.

          `approval: 'auto'` keeps the historical behaviour exactly — nothing is
          asked. Anything else turns the engine's gate on *and* supplies the
          callback that answers it, which is the pairing that must never come
          apart: a gate with no callback falls through to stdin.
        */
        autoApprove: run.approval === 'auto' ? (opts.autoApprove ?? true) : false,
        ...(onPermissionRequest ? { onPermissionRequest } : {}),
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
          costUsd: run.tokenTracker.estimateCost(model, settings),
          // Sent so the reader is not shown an invented number as a fact. The
          // engine has always known this; only the CLI ever said it.
          costEstimated: run.tokenTracker.isEstimated(model, settings, activeProviderType(settings)),
          // The other, independent way a figure can be soft: the provider
          // reported no usage and these counts were derived from text length.
          usageEstimated: run.tokenTracker.hasEstimatedUsage(),
          // How much room this model actually has, so the client can show
          // occupancy rather than a bare token count. A number of tokens means
          // nothing on its own — 180k is comfortable in a 1M window and nearly
          // fatal in a 200k one, and the reader cannot tell which without this.
          contextWindow: getContextWindow(model, settings),
          // Whether that number is measured or guessed. Sent because a bar
          // drawn against an assumption should not look identical to one drawn
          // against the vendor's own figure.
          contextSource: resolveWindow(model, settings).source,
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
        // The success path sends one and this did not, so a cancelled turn left
        // no trace at all: the screen simply stopped changing, which is
        // indistinguishable from the crash the user was worried about when they
        // pressed the button. The log already recorded *why* it ended — the
        // summary is a read of that, and is as true here as it is on the way out
        // the happy path.
        summary: summarizeLastTurn(run.session),
        deliverables: deliverables(run.session, seqBeforeTurn),
      });
      throw err;
    } finally {
      run.busy = false;
      /*
        The subscription is released when the work is, not when the turn is.

        Anything this session detached is still going, and still worth
        watching. Only when nothing of ours is running does the listener go —
        immediately here if that is already true, otherwise from the subscriber
        itself once the last child settles. Left attached unconditionally it
        would publish the *next* turn's children into this turn's stream.
      */
      turnOver = true;
      if (!getAgentRegistry().some(a => a.sessionId === sessionId && a.status === 'running')) {
        releaseAgents?.();
      }
      // However the turn ended — finished, failed, cancelled — nothing is
      // waiting for an answer any more. Leaving the prompt on screen would
      // invite an answer that resolves nothing.
      if (run.pendingQuestion) {
        run.pendingQuestion.resolve('');
        delete run.pendingQuestion;
        emit('question', { question: '' });
      }
      /*
        A pending approval is denied rather than abandoned.

        The same cleanup, with a stricter default. An unanswered question can
        resolve to an empty string and the turn carries on; an unanswered
        *permission* has to mean no. Resolving true would let a cancelled run's
        last act be the tool call the reader was still deciding about.
      */
      if (run.pendingPermission) {
        run.pendingPermission.resolve(false);
        delete run.pendingPermission;
        emit('permission', { id: '', tool: '', detail: '' });
      }
      // Queued messages run now, as their own turns.
      //
      // The inbox has always had two queues: `next-step`, which the agent loop
      // drains at step boundaries, and `next-turn`, which is the caller's to
      // drain. Nothing ever drained it. `claimTurn` had no callers anywhere, so
      // every message sent with Queue went into a list that was never read —
      // it vanished, with the composer clearing as if it had been accepted.
      //
      // Started rather than awaited, and outside the `finally` block's own
      // control flow, because this runs on the failure path too: a turn that
      // was cancelled or threw must still hand back what the reader queued
      // behind it, and awaiting here would make one turn's duration depend on
      // every turn queued after it.
      this.drainQueued(sessionId, cwd, model, opts);
    }
  }

  /**
   * Run whatever was queued behind the turn that just ended, one at a time.
   *
   * One at a time is the point: each queued message was a separate thought and
   * deserves its own turn, its own reply and its own place in the log. Merging
   * them would collapse several distinct requests into one, which is exactly
   * what `followup` exists to avoid.
   *
   * Recursion is through `submit`, so a message queued *during* a queued turn
   * is picked up when that one ends. Depth is bounded by the reader's typing,
   * not by anything here.
   */
  private drainQueued(
    sessionId: string,
    cwd: string,
    model: string,
    opts: Parameters<RunManager['submit']>[4],
  ): void {
    const run = this.runs.get(sessionId);
    if (!run || run.busy) return;
    const queued = run.inbox.claimTurn();
    if (!queued) return;
    void this.submit(sessionId, cwd, queued.content, model, opts)
      .catch(() => {
        // The turn's own error already reached the client through `turn-end`.
        // Rethrowing here would be an unhandled rejection with nobody to catch
        // it, and would stop the rest of the queue for a failure the reader has
        // already been told about.
      });
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

  /**
   * Address this conversation to a specialist, or back to the orchestrator.
   *
   * Refused when the agent does not exist, so a typo leaves you talking to the
   * orchestrator rather than to nobody — a session silently addressed to a
   * missing agent would answer every message as though nothing had been set,
   * which is indistinguishable from the feature not working.
   */
  /**
   * Bind a session to one Mini App, or unbind it.
   *
   * The binding is a log event, so it survives a reload — a session that forgot
   * what it was about would answer the next question against the wrong app,
   * silently and plausibly.
   */
  async setMiniApp(
    sessionId: string, slug: string | null, cwd: string,
  ): Promise<{ ok: boolean; error?: string; slug?: string | null }> {
    const run = await this.ensure(sessionId, cwd);
    if (slug) {
      const settings = await this.currentSettings();
      const app = await getMiniApp(slug, settings, run.cwd);
      if (!app) return { ok: false, error: `There is no Mini App called "${slug}".` };
    }
    run.session.append('session/miniapp', { slug });
    this.hub.publish({ type: 'miniapp', sessionId, data: { slug } });

    /*
      Name it after the app, once.

      Binding writes an event, which makes the session no longer empty and puts
      it in the sidebar — under its raw id, `miniapp-reading-log`, because
      nothing had named it. A dedicated section that appears as a slug is the
      sort of detail that makes a feature feel unfinished.

      Only when it has no name yet: a session the reader renamed is theirs, and
      re-binding must not undo that.
    */
    if (slug && !currentTitle(run.session)) {
      const app = await getMiniApp(slug, await this.currentSettings(), run.cwd);
      const named = writeUserTitle(run.session, app?.title ?? slug);
      if (named) this.hub.publish({ type: 'title', sessionId, data: named });
    }
    return { ok: true, slug };
  }

  /** Which app a session is bound to, for the client to render its scope. */
  miniAppOf(sessionId: string): string | undefined {
    const run = this.runs.get(sessionId);
    return run ? currentMiniApp(run.session) : undefined;
  }

  async setAgent(sessionId: string, name: string | null): Promise<{ ok: boolean; error?: string; agent?: string }> {
    const run = this.runs.get(sessionId);
    if (!run) return { ok: false, error: 'no such session' };

    if (name) {
      const resolved = await resolveAgent(name, run.cwd);
      if (!resolved) return { ok: false, error: `There is no agent called "${name}".` };
      if (!resolved.enabled) {
        return {
          ok: false,
          error: `"${resolved.spec.name}" is switched off. Enable it in Settings first.`,
        };
      }
      run.session.append('session/agent', { name: resolved.spec.name });
      this.hub.publish({ type: 'agent', sessionId, data: { name: resolved.spec.name } });
      return { ok: true, agent: resolved.spec.name };
    }

    run.session.append('session/agent', { name: null });
    this.hub.publish({ type: 'agent', sessionId, data: { name: null } });
    return { ok: true };
  }

  agentOf(sessionId: string): string | undefined {
    const run = this.runs.get(sessionId);
    return run ? currentAgent(run.session) : undefined;
  }

  /**
   * Record the model this session should use from here on.
   *
   * Appended rather than assigned, so it survives a reload and so two sessions
   * can differ. Idempotent: choosing the model already in force writes nothing,
   * which keeps a log from filling with the same line every time a picker
   * re-announces its own value.
   */
  setModel(sessionId: string, model: string | null): { ok: boolean; error?: string } {
    const run = this.runs.get(sessionId);
    if (!run) return { ok: false, error: 'no such session' };
    if ((currentModel(run.session) ?? null) === model) return { ok: true };
    run.session.append('session/model', { model });
    this.hub.publish({ type: 'model', sessionId, data: { model } });
    return { ok: true };
  }

  modelOf(sessionId: string): string | undefined {
    const run = this.runs.get(sessionId);
    return run ? currentModel(run.session) : undefined;
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

  /**
   * Answer the question the run is waiting on.
   *
   * Returns false when nothing was asked, so a stale answer from a reloaded tab
   * cannot resolve a question that has already moved on.
   */
  answer(sessionId: string, content: string): boolean {
    const run = this.runs.get(sessionId);
    if (!run?.pendingQuestion) return false;
    const { resolve } = run.pendingQuestion;
    delete run.pendingQuestion;
    this.hub.publish({ type: 'question', sessionId, data: { question: '' } });
    resolve(content);
    return true;
  }

  /** The question this session is waiting on, if any. */
  questionOf(sessionId: string): string | undefined {
    return this.runs.get(sessionId)?.pendingQuestion?.question;
  }

  /**
   * Decide the tool call this run is blocked on.
   *
   * The id must match. A client that reconnects mid-prompt replays the pending
   * request and answers *that*; without the check, a decision made about one
   * tool call could allow whichever call happened to be waiting when it arrived
   * — which is precisely the mistake a permission prompt exists to prevent.
   */
  decide(sessionId: string, id: string, allowed: boolean): boolean {
    const run = this.runs.get(sessionId);
    if (!run?.pendingPermission || run.pendingPermission.id !== id) return false;
    const { resolve } = run.pendingPermission;
    delete run.pendingPermission;
    this.hub.publish({ type: 'permission', sessionId, data: { id: '', tool: '', detail: '' } });
    resolve(allowed);
    return true;
  }

  /**
   * The approval this session is waiting on, if any.
   *
   * Read on reconnect. A prompt that vanished because a tab was reloaded would
   * leave the turn blocked with nothing on screen explaining why.
   */
  permissionOf(sessionId: string): Omit<PendingPermission, 'resolve' | 'at'> | undefined {
    const pending = this.runs.get(sessionId)?.pendingPermission;
    if (!pending) return undefined;
    return {
      id: pending.id,
      tool: pending.tool,
      detail: pending.detail,
      ...(pending.fileDiff ? { fileDiff: pending.fileDiff } : {}),
    };
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

  /**
   * Deliver a watcher's wake-up.
   *
   * `inject`, not `steer`. The source of every queued message is recorded in
   * the session log, and a message from a watcher is not something a person
   * typed — a transcript that claims otherwise is one you cannot audit, and
   * "why did I say that?" is a bad question to leave a user holding.
   *
   * Returns false when the session has no live run, which is the ordinary case
   * for a watcher that fires long after the conversation moved on. The caller
   * falls back to a notification rather than dropping it.
   */
  wake(sessionId: string, content: string, as: 'steer' | 'followup'): boolean {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    const source = { kind: 'plugin', plugin: 'watcher' } as const;
    if (as === 'followup') run.inbox.followup(content, source);
    else run.inbox.inject(content, source);
    return true;
  }

  /** Flush every session's log. Called on shutdown so nothing is lost. */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.runs.values()].map(r => r.close()));
    this.runs.clear();
  }
}
