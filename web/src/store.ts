/**
 * Client state, and the one hard problem in it: reconciling two views of the
 * same turn.
 *
 * The server sends the same conversation twice, in two different shapes.
 * *Ephemeral* events (`chunk`, `reasoning`, `tool-start`) arrive while a turn
 * runs and are never replayed. *Durable* events (`assistant/message`,
 * `tool/call`, `tool/result`) are written to the session log, carry a `seq`,
 * and are replayed on every reconnect. Rendering both naively shows every
 * answer twice.
 *
 * The rule here: **the log is the truth, the stream is a preview.** Finalized
 * messages are keyed by log `seq`, so replaying them is idempotent — the same
 * event lands in the same slot no matter how many times it arrives. Live
 * deltas accumulate in a separate `draft` that is only rendered while a turn is
 * in flight, and is discarded the moment the log catches up.
 *
 * That is also why `turn-end` reconnects the stream instead of trying to
 * synthesize the final message locally: asking the server to replay the gap
 * gives us the durable version, with real tool results and real seqs, using the
 * same path a dropped connection uses. The resume machinery is therefore
 * exercised on every single turn rather than only when something goes wrong.
 *
 * @module store
 */

import { create } from 'zustand';
import { initialSessionId, rememberSession, freshSessionId } from './session-memory';
import type { ChatMessage } from '@aico/ui';
import { PLAN_REPLY } from './plans';
import { shouldClearBusy, type ServerTurn } from './turn-state';

/** The answers the plan panel can give. `amend` is not one — it sends nothing. */
export type PlanAnswer = 'approved' | 'deferred' | 'declined' | 'startNow';
import type { TurnSummaryData } from './components/TurnSummary';
import {
  api, streamSession,
  type StreamEvent, type StreamHandle, type SystemSnapshot,
  type ProviderInstance, type ProviderTypeInfo, type SessionSummary, type Project, type Group,
  type Goal, type Feedback, type Deliverable,
} from './api';
import {
  applyLogEvent, withPending, dropPending, emptyDraft,
  type Draft, type ReasoningBurst,
} from './reduce';
import { merge as mergeSessions, promote } from './grouping';

export type ConnectionStatus = 'connecting' | 'live' | 'lost';

export interface Usage {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  costUsd: number;
}

const NO_USAGE: Usage = { input: 0, output: 0, cached: 0, cacheWrite: 0, costUsd: 0 };

interface AppState {
  // ── connection ──
  status: ConnectionStatus;
  lastSeq: number;

  // ── projects ──
  /** Directories the server will start sessions in. */
  projects: Project[];
  /**
   * The directory new sessions are created in.
   *
   * Null until the first listing arrives, at which point it becomes the
   * server's launch directory. Opening a session switches it to that session's
   * project, so "new session" always means "here, where I am looking".
   */
  project: string | null;

  /** Containers you made. Orthogonal to projects: a group can span them. */
  groups: Group[];
  /**
   * A group the next new session should be filed under.
   *
   * Held rather than applied because a session that has never run has no log
   * to record membership in, and the membership *is* a log event. It is
   * written on the first submit, when the session becomes real.
   */
  pendingGroup: string | null;

  // ── sessions ──
  sessions: SessionSummary[];
  activeSessions: string[];
  sessionId: string;
  /** This session's display name, kept live from the stream. */
  title: string;
  /**
   * The specialist this conversation is addressed to, or null for the
   * orchestrator. Session state, restored on reconnect from `caught-up`.
   */
  sessionAgent: string | null;
  setSessionAgent: (name: string | null) => Promise<void>;

  // ── the conversation ──
  /** Finalized messages, keyed by log seq. Replay is idempotent. */
  logged: Map<number, ChatMessage>;
  draft: Draft;
  busy: boolean;
  /** When the running turn began. Null when nothing is running. */
  turnStartedAt: number | null;
  /**
   * When anything last arrived on the stream.
   *
   * A long quiet stretch is normal for a big model call and alarming for a
   * hung one, and the client cannot tell them apart — so it shows the number
   * and lets the reader judge. Without this the only signal was a screen
   * that had stopped changing, which is what "is it doing anything?" means.
   */
  lastActivityAt: number;
  usage: Usage;
  model: string | null;
  error: string | null;
  /** The session's standing objective, when it has one. */
  goal: Goal | null;
  /** Ratings, keyed by the log seq of the message each judges. */
  feedback: Record<number, Feedback>;
  /** Files the last finished turn produced. */
  deliverables: Deliverable[];
  /** How the last turn ended, and what it did. Null until one finishes. */
  turnSummary: TurnSummaryData | null;

  // ── installation ──
  providers: ProviderInstance[];
  providerTypes: ProviderTypeInfo[];
  activeProvider: string | null;
  settings: Record<string, unknown>;
  system: SystemSnapshot | null;

  // ── actions ──
  connect: (sessionId: string) => void;
  /** Reconnect in place, replaying only the gap since `lastSeq`. */
  resume: () => void;
  disconnect: () => void;
  newSession: () => void;
  openSession: (id: string) => Promise<void>;
  submit: (task: string, opts?: { planMode?: boolean; model?: string }) => Promise<void>;
  /**
   * Text to place in the composer without sending it.
   *
   * For answers that need the reader's own words — amending a plan is the one
   * that prompted this. Writing to the textarea's DOM value would be ignored by
   * a controlled input, and re-briefing from scratch is what people do when
   * there is no way to edit, which throws away the parts that were right.
   */
  composerPrefill: { text: string; at: number } | null;
  prefillComposer: (text: string) => void;
  /**
   * Hand a brief to the agent in a conversation of its own.
   *
   * "Write one with the agent" was dropping the brief into whatever chat
   * happened to be open, which is the wrong place twice over: the request
   * lands in the middle of unrelated work, and the work it produces is buried
   * in a session about something else. Making a skill or an agent is its own
   * task and deserves its own thread.
   */
  askAgentFor: (text: string) => void;
  /**
   * Panels the reader has closed, keyed by *what* was closed.
   *
   * A plain boolean would make dismissal permanent, so a genuinely new plan or
   * a task list that has moved on would stay hidden behind a decision made
   * about something else. Keyed by content identity, closing means "I have seen
   * this one" and anything new comes back on its own.
   */
  dismissed: Record<string, string>;
  dismissPanel: (panel: string, identity: string) => void;

  /**
   * Whether the next turn plans rather than builds.
   *
   * Session state, not a toggle inside the composer. It began life as local
   * component state, which meant nothing else could see it and — worse —
   * nothing else could change it: approving a plan recorded the approval and
   * left the mode on, so the agent came back still unable to write a file. The
   * decision that ends planning has to be able to end planning.
   */
  planMode: boolean;
  setPlanMode: (on: boolean) => void;

  /**
   * Answer the plan on the table, and mean it.
   *
   * Owns the mode change as well as the message, because those are one act. A
   * caller that only sends the message produces the bug this replaced.
   */
  answerPlan: (decision: PlanAnswer) => Promise<void>;
  /** Start amending: stay in planning, and frame the composer as a correction. */
  amendPlan: () => void;
  cancel: () => Promise<void>;
  /**
   * A question the agent is blocked on, or null.
   *
   * The turn cannot proceed until this is answered, which is why it takes over
   * the composer rather than sitting in the transcript: a question you can
   * scroll past is a turn that hangs.
   */
  question: string | null;
  answer: (content: string) => Promise<void>;
  steer: (content: string) => Promise<void>;
  followup: (content: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  /** Work in this directory from now on. */
  selectProject: (path: string) => void;
  addProject: (path: string, name?: string) => Promise<void>;
  removeProject: (path: string) => Promise<void>;
  updateProject: (path: string, patch: {
    name?: string; pinned?: boolean; color?: string;
    description?: string; instructions?: string;
  }) => Promise<void>;
  /** Start a session in a specific folder, whatever is currently selected. */
  newSessionIn: (path: string) => void;
  refreshGroups: () => Promise<void>;
  createGroup: (name: string) => Promise<void>;
  updateGroup: (id: string, patch: {
    name?: string; color?: string; pinned?: boolean;
    description?: string; instructions?: string; cwd?: string;
  }) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  moveToGroup: (sessionId: string, group: string | null) => Promise<void>;
  /** Start a session filed under a group. */
  newSessionInGroup: (groupId: string) => void;
  refreshProviders: () => Promise<void>;
  refreshSystem: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  setModel: (model: string) => void;
  rename: (title: string) => Promise<void>;
  /** Rename any session, not only the open one. */
  renameSession: (id: string, title: string) => Promise<void>;
  archiveSession: (id: string, archived: boolean) => Promise<void>;
  forkSession: (id: string) => Promise<void>;
  /** Whether filed-away sessions are listed. */
  showArchived: boolean;
  toggleArchived: () => void;
  setGoal: (text: string, status: 'active' | 'paused' | 'cleared') => Promise<void>;
  rate: (seq: number, rating: 'up' | 'down' | 'none', note?: string) => Promise<void>;
  clearError: () => void;
}

let handle: StreamHandle | null = null;

export const useStore = create<AppState>((set, get) => ({
  status: 'connecting',
  lastSeq: 0,
  projects: [],
  groups: [],
  pendingGroup: null,
  project: null,
  showArchived: false,
  sessions: [],
  activeSessions: [],
  sessionId: initialSessionId(),
  title: '',
  logged: new Map(),
  draft: emptyDraft(),
  composerPrefill: null,
  dismissed: {},
  question: null,
  planMode: false,
  busy: false,
  turnStartedAt: null,
  sessionAgent: null,
  lastActivityAt: 0,
  usage: NO_USAGE,
  model: null,
  error: null,
  goal: null,
  feedback: {},
  deliverables: [],
  turnSummary: null,
  providers: [],
  providerTypes: [],
  activeProvider: null,
  settings: {},
  system: null,

  connect: (sessionId) => {
    handle?.close();
    rememberSession(sessionId);
    set({
      // Dismissals and planning mode belong to the session they were made in:
      // closing a panel — or planning — in one conversation says nothing about
      // the next.
      sessionId, logged: new Map(), draft: emptyDraft(), dismissed: {}, planMode: false,
      // Cleared on switch and restored by `caught-up`, so a session opened from
      // the sidebar never inherits the previous one's persona.
      sessionAgent: null,
      question: null,
      lastSeq: 0, usage: NO_USAGE, busy: false,
      turnStartedAt: null, lastActivityAt: 0,
      goal: null, feedback: {}, deliverables: [], turnSummary: null,
      // Seeded from the sidebar so a session opened from the list is named
      // immediately, rather than blank until its first title event replays.
      title: get().sessions.find(s => s.id === sessionId)?.title ?? '',
    });
    // The project rides along on subscribe: subscribing is what opens the
    // session server-side, and a brand-new session has no row on disk for the
    // server to infer a directory from.
    const project = get().sessions.find(s => s.id === sessionId)?.project ?? get().project;
    handle = streamSession(
      sessionId,
      (event) => applyEvent(set, get, event),
      (status) => set({ status }),
      0,
      project ?? undefined,
    );

    // Usage lives on the server's run, not in the log, so replaying events
    // cannot restore it — a reopened session showed 0 tokens and $0.00 for a
    // conversation that had cost real money.
    void api.session(sessionId)
      .then(snapshot => {
        if (get().sessionId !== sessionId) return;
        const u = snapshot.usage ?? {};
        set({
          usage: {
            input: Number(u.inputTokens ?? 0),
            output: Number(u.outputTokens ?? 0),
            cached: Number(u.cachedTokens ?? 0),
            cacheWrite: Number(u.cacheWriteTokens ?? 0),
            costUsd: Number(u.costUsd ?? 0),
          },
        });
      })
      .catch(() => { /* the stream is the important half; usage is a garnish */ });
  },

  resume: () => {
    const { sessionId, lastSeq } = get();
    handle?.close();
    handle = streamSession(
      sessionId,
      (event) => applyEvent(set, get, event),
      (status) => set({ status }),
      lastSeq,
      get().project ?? undefined,
    );
  },

  disconnect: () => {
    handle?.close();
    handle = null;
  },

  newSession: () => {
    get().connect(freshSessionId());
    void get().refreshSessions();
  },

  openSession: async (id) => {
    // Follow the session into its directory, so the next new session lands
    // where you are looking rather than wherever you last were.
    const project = get().sessions.find(s => s.id === id)?.project;
    if (project) set({ project });
    get().connect(id);
    await get().refreshSessions();
  },

  // Stamped, so asking for the same text twice still reaches the composer —
  // an identical value would otherwise look like no change at all.
  prefillComposer: (text) => set({ composerPrefill: { text, at: Date.now() } }),

  setSessionAgent: async (name) => {
    const { sessionId } = get();
    const result = await api.setSessionAgent(sessionId, name);
    if (!result.ok) { set({ error: result.error ?? 'could not switch agent' }); return; }

    set({ sessionAgent: result.agent ?? null, error: null });
    // The switch is a log event, and log events reach the client by replay
    // rather than live — the same reason `turn-end` reconnects instead of
    // synthesizing the final message. Resuming replays the gap, so the mark
    // appears in the transcript where it happened.
    get().resume();
  },

  askAgentFor: (text) => {
    // New session first: connect() resets the draft, so prefilling before it
    // would put the brief in a composer that is about to be cleared.
    get().newSession();
    get().prefillComposer(text);
  },

  dismissPanel: (panel, identity) =>
    set(state => ({ dismissed: { ...state.dismissed, [panel]: identity } })),

  setPlanMode: (on) => set({ planMode: on }),

  answer: async (content) => {
    const { sessionId } = get();
    // Cleared optimistically: the turn resumes the moment the server has it,
    // and leaving the prompt up through a round trip invites a second answer.
    set({ question: null });
    await api.answer(sessionId, content);
  },

  answerPlan: async (decision) => {
    // Approving, or starting a deferred plan, is the moment planning ends.
    // Declining ends it too — there is nothing left to plan. Deferring does
    // not: the reader may well want to keep planning something else.
    const stillPlanning = decision === 'deferred';
    set({ planMode: stillPlanning });
    await get().submit(PLAN_REPLY[decision], { planMode: stillPlanning });
  },

  amendPlan: () => {
    // Planning stays on. An amendment asks for a better plan, and a model with
    // write tools in hand will take "amend that" as licence to start building
    // the amended version.
    set({ planMode: true });
    get().prefillComposer(PLAN_REPLY.amendPrefix);
  },

  submit: async (task, opts = {}) => {
    const { sessionId, model } = get();
    // Started here rather than on `turn-start`: the server may take a moment
    // to accept, and a blank screen during that moment is the exact problem.
    set({
      error: null, busy: true, draft: emptyDraft(),
      turnStartedAt: Date.now(), lastActivityAt: Date.now(),
    });
    try {
      await api.submit({
        sessionId,
        task,
        ...(get().project ? { project: get().project! } : {}),
        ...(opts.model ?? model ? { model: opts.model ?? model! } : {}),
        planMode: opts.planMode ?? false,
      });
      // The user's own message is echoed immediately rather than waiting for
      // the log to replay it — a composer that clears with nothing appearing
      // reads as a dropped message. The sidebar row moves to the top on the
      // same beat, for the same reason: sending is the clearest possible
      // statement that this is now the most recent session.
      set(state => ({
        logged: withPending(state.logged, task),
        sessions: promote(state.sessions, sessionId, Date.now(), state.title ? { title: state.title } : {}),
      }));
      const pending = get().pendingGroup;
      if (pending) {
        set({ pendingGroup: null });
        void get().moveToGroup(sessionId, pending);
      }
      void get().refreshSessions();
    } catch (err) {
      set({ busy: false, error: (err as Error).message });
    }
  },

  /**
   * Stop the turn — and, failing that, stop the *appearance* of one.
   *
   * Cancelling used to only ask the server and then wait for a `turn-end`
   * event to clear `busy`. That is correct whenever a turn exists. When one
   * does not, nothing ever arrives and the page sits at "running" forever with
   * a Stop button that cannot help: found live after a submit whose request
   * never settled, leaving the client certain a turn was running while the
   * server had no record of one. Reloading was the only way out, which is the
   * same "stuck until I killed it" the stall detector was built to end.
   *
   * So Stop reconciles against the server rather than waiting to be told. The
   * server stays the source of truth — it is asked, not overruled — but if it
   * says nothing is running, the UI stops pretending.
   *
   * **Both requests are bounded, and that is the part that matters.** The first
   * version awaited the cancel before reconciling, which is fine until the
   * request that hangs is the cancel itself — and a request hanging is the
   * exact condition Stop is here to escape. Watched live: Stop was pressed on a
   * page whose fetches were not settling, and nothing happened, because the
   * rescue was queued behind the thing it was rescuing from. A rescue that can
   * be blocked by the failure it handles is not a rescue.
   */
  cancel: async () => {
    const { sessionId } = get();

    // Long enough that a healthy server always answers first, short enough that
    // a person pressing Stop does not wonder whether they missed.
    const bounded = <T,>(work: Promise<T>): Promise<T | 'timeout'> => Promise.race([
      work,
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 4000)),
    ]);

    try { await bounded(api.cancel(sessionId)); }
    catch (err) { set({ error: (err as Error).message }); }

    let server: ServerTurn = 'unreachable';
    try {
      const snapshot = await bounded(api.session(sessionId));
      // A timeout is not a claim that a turn is running, so it stays
      // 'unreachable' — the case that clears.
      if (snapshot !== 'timeout') server = { running: snapshot.busy };
    } catch { /* unreachable is the answer, and shouldClearBusy knows what to do */ }

    if (shouldClearBusy(get().busy, server)) {
      set({ busy: false, turnStartedAt: null, question: null });
    }
  },

  steer: async (content) => {
    try { await api.steer(get().sessionId, content); }
    catch (err) { set({ error: (err as Error).message }); }
  },

  followup: async (content) => {
    try { await api.followup(get().sessionId, content); }
    catch (err) { set({ error: (err as Error).message }); }
  },

  refreshSessions: async () => {
    try {
      const { sessions, active, projects, groups } = await api.sessions();
      // Merged rather than assigned. A listing fetched the moment a message is
      // sent has not necessarily seen the write yet, and assigning it wholesale
      // would undo the promotion that just put the row at the top.
      set(state => ({
        sessions: mergeSessions(state.sessions, sessions),
        activeSessions: active,
        ...(projects ? { projects } : {}),
        ...(groups ? { groups } : {}),
        // The launch directory is the answer until someone chooses otherwise.
        ...(state.project ? {} : { project: projects?.find(p => p.isLaunch)?.path ?? null }),
      }));
    } catch { /* the sidebar is not worth an error banner */ }
  },

  refreshProjects: async () => {
    try {
      const { projects, launch } = await api.projects();
      set(state => ({ projects, ...(state.project ? {} : { project: launch }) }));
    } catch { /* the picker will say so when it is opened */ }
  },

  selectProject: (path) => {
    if (get().project === path) return;
    // A new session, because a session belongs to one directory for its whole
    // life — the log is filed under it. Switching project mid-session would
    // leave the transcript describing work in a directory it is no longer in.
    set({ project: path });
    get().newSession();
  },

  addProject: async (path, name) => {
    try {
      const { project } = await api.addProject(path, name);
      await get().refreshProjects();
      get().selectProject(project.path);
    } catch (err) { set({ error: (err as Error).message }); }
  },

  updateProject: async (path, patch) => {
    try {
      await api.updateProject(path, patch);
      await get().refreshProjects();
    } catch (err) { set({ error: (err as Error).message }); }
  },

  newSessionIn: (path) => {
    // Selecting the folder is the same act as starting a session in it — a new
    // session belongs to exactly one directory for its whole life, so there is
    // no meaningful "new session here while I am looking at somewhere else".
    set({ project: path });
    get().newSession();
  },

  refreshGroups: async () => {
    try {
      const { groups } = await api.groups();
      set({ groups });
    } catch { /* the sidebar is not worth an error banner */ }
  },

  createGroup: async (name) => {
    try {
      // Seeded with the folder you are looking at, so a group made while
      // working somewhere starts its sessions in that somewhere.
      const { group } = await api.createGroup(name, get().project ?? undefined);
      await get().refreshGroups();
      get().newSessionInGroup(group.id);
    } catch (err) { set({ error: (err as Error).message }); }
  },

  updateGroup: async (id, patch) => {
    try {
      await api.updateGroup(id, patch);
      await get().refreshGroups();
    } catch (err) { set({ error: (err as Error).message }); }
  },

  deleteGroup: async (id) => {
    try {
      await api.deleteGroup(id);
      await get().refreshGroups();
      // The sessions are untouched; they fall back to their own folders.
      await get().refreshSessions();
    } catch (err) { set({ error: (err as Error).message }); }
  },

  moveToGroup: async (sessionId, group) => {
    // Applied locally first: the row should move on the click, not after a
    // round trip, and the server call is the durable record of it.
    set(state => ({
      sessions: state.sessions.map(s =>
        (s.id === sessionId ? { ...s, group: group ?? undefined } : s)),
    }));
    try {
      await api.moveToGroup(sessionId, group);
    } catch (err) {
      set({ error: (err as Error).message });
      await get().refreshSessions();
    }
  },

  newSessionInGroup: (groupId) => {
    const group = get().groups.find(g => g.id === groupId);
    // A group is not a directory, so it borrows one: its own if it has been
    // given one, otherwise wherever the client currently is.
    if (group?.cwd) set({ project: group.cwd });
    set({ pendingGroup: groupId });
    get().newSession();
  },

  removeProject: async (path) => {
    try {
      await api.removeProject(path);
      const { projects } = await api.projects();
      set(state => ({
        projects,
        ...(state.project === path
          ? { project: projects.find(p => p.isLaunch)?.path ?? null }
          : {}),
      }));
    } catch (err) { set({ error: (err as Error).message }); }
  },

  refreshProviders: async () => {
    try {
      const { instances, types, active, model } = await api.providers();
      set(state => ({
        providers: instances,
        providerTypes: types,
        activeProvider: active,
        model: state.model ?? model,
      }));
    } catch (err) { set({ error: (err as Error).message }); }
  },

  renameSession: async (id, title) => {
    try {
      await api.rename(id, title);
      if (get().sessionId === id) set({ title });
      set(state => ({
        sessions: state.sessions.map(s =>
          (s.id === id ? { ...s, title, titleSource: 'user' as const } : s)),
      }));
    } catch (err) { set({ error: (err as Error).message }); }
  },

  archiveSession: async (id, archived) => {
    // Applied locally first: the row should leave the list on the click, not
    // after a round trip, and the server call is the durable record of it.
    set(state => ({ sessions: state.sessions.map(s => (s.id === id ? { ...s, archived } : s)) }));
    try {
      await api.archive(id, archived);
    } catch (err) {
      set(state => ({
        error: (err as Error).message,
        sessions: state.sessions.map(s => (s.id === id ? { ...s, archived: !archived } : s)),
      }));
    }
  },

  forkSession: async (id) => {
    try {
      const forked = await api.fork(id);
      if (forked.project) set({ project: forked.project });
      await get().refreshSessions();
      // Opened immediately: forking is something you do in order to keep
      // going, so leaving the user on the original is a second click nobody
      // wanted.
      await get().openSession(forked.id);
    } catch (err) { set({ error: (err as Error).message }); }
  },

  toggleArchived: () => set(state => ({ showArchived: !state.showArchived })),

  rename: async (title) => {
    const { sessionId } = get();
    try {
      await api.rename(sessionId, title);
      set({ title });
      void get().refreshSessions();
    } catch (err) { set({ error: (err as Error).message }); }
  },

  refreshSystem: async () => {
    try { set({ system: await api.system() }); }
    catch { /* polled; a transient failure resolves on the next tick */ }
  },

  refreshSettings: async () => {
    try { set({ settings: await api.settings() }); }
    catch (err) { set({ error: (err as Error).message }); }
  },

  setGoal: async (text, status) => {
    const { sessionId } = get();
    // Applied optimistically: the goal bar is a control, and a control that
    // waits for a round trip before showing its own state feels broken.
    set({ goal: status === 'cleared' ? null : { text, status, since: Date.now() } });
    try { await api.setGoal(sessionId, text, status); }
    catch (err) { set({ error: (err as Error).message }); }
  },

  rate: async (seq, rating, note) => {
    const { sessionId } = get();
    set(state => {
      const next = { ...state.feedback };
      if (rating === 'none') delete next[seq];
      else next[seq] = { rating, ...(note ? { note } : {}), at: Date.now() };
      return { feedback: next };
    });
    try { await api.rate(sessionId, seq, rating, note); }
    catch (err) { set({ error: (err as Error).message }); }
  },

  setModel: (model) => set({ model }),
  clearError: () => set({ error: null }),

}));

// ── event application ────────────────────────────────────────────────

type Set = (fn: (state: AppState) => Partial<AppState>) => void;
type Get = () => AppState;

function applyEvent(set: Set, get: Get, event: StreamEvent): void {
  const data = event.data ?? {};

  // Any event at all is a sign of life. Recorded before the switch so a type
  // this function does not otherwise handle still counts — the question being
  // answered is "is anything happening", not "is something I render happening".
  if (get().busy) set(() => ({ lastActivityAt: Date.now() }));

  switch (event.type) {
    // ── durable: the log ────────────────────────────────────────────
    case 'log':
      set(state => {
        const patch: Partial<AppState> = {
          logged: applyLogEvent(state.logged, event.seq ?? 0, data),
          lastSeq: Math.max(state.lastSeq, event.seq ?? 0),
        };
        // Goal and feedback are projections of the same log, so replaying it
        // restores them for free — a reopened session shows its goal without
        // a second request.
        if (data.type === 'goal/set') {
          const status = String(data.status) as Goal['status'];
          patch.goal = status === 'cleared'
            ? null
            : { text: String(data.text ?? ''), status, since: Date.now() };
        }
        if (data.type === 'message/feedback') {
          const targetSeq = Number(data.targetSeq);
          const rating = String(data.rating) as 'up' | 'down' | 'none';
          const next = { ...state.feedback };
          if (rating === 'none') delete next[targetSeq];
          else next[targetSeq] = {
            rating,
            ...(data.note ? { note: String(data.note) } : {}),
            at: Date.now(),
          };
          patch.feedback = next;
        }
        return patch;
      });
      return;

    case 'caught-up':
      // The log has told us everything it knows, so any draft still on screen
      // is now either represented in `logged` or was never going to be.
      set(state => ({
        status: 'live',
        busy: Boolean((data as { busy?: boolean }).busy),
        sessionAgent: (data as { agent?: string | null }).agent ?? null,
        draft: (data as { busy?: boolean }).busy ? state.draft : emptyDraft(),
        // Drop the optimistic echo now that the real user message has replayed.
        logged: dropPending(state.logged),
      }));
      return;

    // ── ephemeral: the live turn ────────────────────────────────────
    case 'agent':
      set(() => ({ sessionAgent: (data as { name?: string | null }).name ?? null }));
      return;

    case 'question':
      // An empty question means the run is no longer waiting — answered,
      // finished, or cancelled.
      set(() => ({ question: String((data as { question?: string }).question ?? '') || null }));
      return;

    case 'turn-start':
      // Ephemeral events are never replayed, which is precisely what makes
      // this a safe place to promote: it fires when a turn actually begins,
      // not every time an old log is re-read.
      set(state => ({
        busy: true, draft: emptyDraft(), error: null, turnSummary: null,
        turnStartedAt: state.turnStartedAt ?? Date.now(),
        lastActivityAt: Date.now(),
        sessions: promote(state.sessions, event.sessionId, Date.now(),
          state.title ? { title: state.title } : {}),
      }));
      return;

    case 'chunk':
      set(state => {
        // Text arriving means every reasoning burst is finished: the model has
        // stopped thinking and started answering.
        const reasoning = closeBursts(state.draft.reasoning);
        return {
          draft: {
            ...state.draft,
            reasoning,
            // Replaced, not appended. `onChunk` sends the text accumulated so
            // far in this step, exactly like `onReasoning` — appending it
            // produced "This" + "This is" + "This is a" concatenated into
            // "ThisThis isThis is a…", growing quadratically with the reply.
            text: String(data.text ?? ''),
          },
        };
      });
      return;

    case 'reasoning': {
      // The engine sends the text accumulated so far *within this step*, so
      // this replaces rather than appends. Appending it concatenated every
      // prefix of the burst into itself.
      const step = Number(data.step ?? 0);
      const text = String(data.text ?? '');
      set(state => {
        const reasoning = new Map(state.draft.reasoning);
        const existing = reasoning.get(step);
        reasoning.set(step, existing
          ? { ...existing, text }
          : { step, text, startedAt: Date.now() });
        const order = existing
          ? state.draft.order
          : [...state.draft.order, { kind: 'reasoning' as const, key: step }];
        return { draft: { ...state.draft, reasoning, order } };
      });
      return;
    }

    case 'tool-start': {
      const callId = String(data.callId ?? '');
      set(state => {
        const tools = new Map(state.draft.tools);
        tools.set(callId, {
          id: `tool-${callId}`,
          type: 'tool',
          content: '',
          toolName: String(data.name ?? 'tool'),
          toolArgs: (data.args ?? {}) as Record<string, unknown>,
          toolCallId: callId,
          toolRunning: true,
          timestamp: Date.now(),
        });
        // A dispatched tool call also ends the thinking that decided on it.
        const reasoning = closeBursts(state.draft.reasoning);
        const order = state.draft.order.some(e => e.kind === 'tool' && e.key === callId)
          ? state.draft.order
          : [...state.draft.order, { kind: 'tool' as const, key: callId }];
        return { draft: { ...state.draft, tools, reasoning, order } };
      });
      return;
    }

    case 'tool-progress': {
      const callId = String(data.callId ?? '');
      set(state => {
        const existing = state.draft.tools.get(callId);
        if (!existing) return {};
        const tools = new Map(state.draft.tools);
        // Written as a partial result so the card renders it through exactly
        // the same path the finished output takes — no second display mode
        // that could disagree with the real one.
        tools.set(callId, {
          ...existing,
          toolResult: { stdout: String(data.output ?? ''), stderr: '', exit_code: 0 },
          toolProgressMs: Number(data.elapsedMs ?? 0),
        });
        return { draft: { ...state.draft, tools } };
      });
      return;
    }

    case 'tool-done': {
      const callId = String(data.callId ?? '');
      set(state => {
        const tools = new Map(state.draft.tools);
        const existing = tools.get(callId);
        // A result for a call we never saw start still deserves a card —
        // dropping it would silently hide work the agent actually did.
        tools.set(callId, {
          ...(existing ?? {
            id: `tool-${callId}`,
            type: 'tool' as const,
            content: '',
            toolName: String(data.name ?? 'tool'),
            timestamp: Date.now(),
          }),
          toolResult: data.result,
          toolRunning: false,
        });
        return { draft: { ...state.draft, tools } };
      });
      return;
    }

    case 'title': {
      const title = String((data as { title?: string }).title ?? '');
      if (title) {
        const source = (data as { source?: SessionSummary['titleSource'] }).source;
        set(state => ({
          title,
          // Patch the sidebar row in place: refetching the whole list on every
          // title event would make a naming call cost a round trip per session.
          // A session naming itself for the first time may have no row yet, so
          // one is seeded rather than the name being dropped on the floor.
          sessions: state.sessions.some(s => s.id === event.sessionId)
            ? state.sessions.map(s =>
              s.id === event.sessionId ? { ...s, title, ...(source ? { titleSource: source } : {}) } : s)
            : promote(state.sessions, event.sessionId, Date.now(),
              { title, ...(source ? { titleSource: source } : {}) }),
        }));
      }
      return;
    }

    case 'goal': {
      const text = String((data as { text?: string }).text ?? '');
      const status = (data as { status?: Goal['status'] }).status ?? 'active';
      set(() => ({ goal: status === 'cleared' ? null : { text, status, since: Date.now() } }));
      return;
    }

    case 'feedback': {
      const targetSeq = Number((data as { targetSeq?: number }).targetSeq);
      const rating = (data as { rating?: 'up' | 'down' | 'none' }).rating;
      set(state => {
        const next = { ...state.feedback };
        if (rating === 'none' || !rating) delete next[targetSeq];
        else next[targetSeq] = {
          rating,
          ...((data as { note?: string }).note ? { note: String((data as { note?: string }).note) } : {}),
          at: Date.now(),
        };
        return { feedback: next };
      });
      return;
    }

    case 'tokens':
      set(() => ({
        usage: {
          input: Number(data.input ?? 0),
          output: Number(data.output ?? 0),
          cached: Number(data.cached ?? 0),
          cacheWrite: Number(data.cacheWrite ?? 0),
          costUsd: Number(data.costUsd ?? 0),
        },
      }));
      return;

    case 'turn-end': {
      const error = data.error ? String(data.error) : null;
      const cancelled = Boolean(data.cancelled);
      set(state => ({
        busy: false,
        turnStartedAt: null,
        sessions: promote(state.sessions, event.sessionId, Date.now(),
          state.title ? { title: state.title } : {}),
        // Derived server-side and delivered with the turn, so there is no
        // second copy of the "which tools count as writing" rules here.
        deliverables: Array.isArray(data.deliverables) ? data.deliverables as Deliverable[] : [],
        turnSummary: (data.summary ?? null) as TurnSummaryData | null,
        // A cancellation is an outcome the user chose, not a failure to report.
        error: error && !cancelled ? error : null,
      }));
      // Reconnect so the log replays this turn in its durable form: real tool
      // results, real seqs, and reasoning attached to the message it belongs to.
      const { sessionId } = get();
      queueMicrotask(() => {
        if (get().sessionId !== sessionId) return;
        get().resume();
        // Turn counts and any model-written title only exist on disk, so the
        // sidebar row is stale until this lands. Merged, so it cannot undo the
        // promotion above.
        void get().refreshSessions();
      });
      return;
    }

    default:
      return;
  }
}

/**
 * Mark every open reasoning burst as finished.
 *
 * There is no explicit "stopped thinking" signal, and there does not need to
 * be: text or a tool call is that signal. Returns the same Map when nothing
 * changed, so this cannot cause a render on its own.
 */
function closeBursts(bursts: Map<number, ReasoningBurst>): Map<number, ReasoningBurst> {
  let changed = false;
  const next = new Map(bursts);
  for (const [step, burst] of next) {
    if (burst.endedAt !== undefined) continue;
    next.set(step, { ...burst, endedAt: Date.now() });
    changed = true;
  }
  return changed ? next : bursts;
}
