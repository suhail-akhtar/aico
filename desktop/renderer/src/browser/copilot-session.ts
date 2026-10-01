/**
 * The browser copilot's own conversation.
 *
 * The shared store (`@web/store`) holds exactly one connected session — the
 * chat on screen. Browsing must never take that over, so the copilot is a
 * second, small client of the same engine: the same `/api/submit`, the same
 * `/api/events` stream (`streamSession`), the same log reducer
 * (`applyLogEvent`) and the same projection (`composeMessages`) the main chat
 * uses. It is a real AICO conversation — same agent, same tools, including the
 * `browser_*` tools that drive this browser — and it can be continued in the
 * main chat at any time, because it is an ordinary session on disk.
 *
 * What it does not do that the main store does: attachments, plan mode, edit
 * hand-offs, host tools, sub-agent panels. A browsing chat needs none of them.
 *
 * Its turns are submitted as `surface: 'browser-copilot'`: the engine adds the
 * copilot brief and `HandOffToChat`, and withholds the build-and-run tools, so
 * code, project and server work moves to a full chat (src/server/chat-handoff.ts).
 * `handOffNow` is the composer's "Hand off to chat" button — the same move,
 * without asking the model.
 *
 * Two documents can show it: the main window (docked, or minimised to the
 * launcher) and the floating copilot's own view over the page. Only the one on
 * screen holds the stream — `attachCopilot` when it takes over, `detachCopilot`
 * when it hands over — and the conversation it attaches to is the one in
 * localStorage, which both share, so a new chat started in one is the chat the
 * other picks up. Attaching replays the session, so a turn that is running
 * carries on where it is.
 *
 * @module desktop/renderer/browser/copilot-session
 */

import { create } from 'zustand';
import type { ChatMessage } from '@aico/ui';
import { api, streamSession, type ChatHandOff, type ChatHandOffRequest, type PermissionRequest, type StreamEvent, type StreamHandle, type SubmitOptions } from '@web/api';
import { applyLogEvent, dropPending, emptyDraft, withPending, type Draft, type ReasoningBurst } from '@web/reduce';
import { freshSessionId } from '@web/session-memory';
import { useStore } from '@web/store';

const SESSION_KEY = 'aico.browser.copilot.session';
const PROJECT_KEY = 'aico.browser.copilot.project';

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string | null): void {
  try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* per-window convenience only */ }
}

export interface CopilotState {
  sessionId: string | null;
  project: string | null;
  status: 'idle' | 'connecting' | 'live' | 'lost';
  logged: Map<number, ChatMessage>;
  draft: Draft;
  busy: boolean;
  lastSeq: number;
  title: string;
  question: string | null;
  permission: PermissionRequest | null;
  error: string | null;
  turnStartedAt: number | null;
  /** How many messages this conversation has, so an empty one shows the start screen. */
  started: boolean;
  /**
   * Hand-offs made with the composer's button, for their cards. (One the model
   * makes is a tool call in the log, and its card is drawn from that.)
   */
  handoffs: ChatHandOff[];
}

export const useCopilot = create<CopilotState>(() => ({
  sessionId: load(SESSION_KEY),
  project: load(PROJECT_KEY),
  status: 'idle',
  logged: new Map(),
  draft: emptyDraft(),
  busy: false,
  lastSeq: 0,
  title: '',
  question: null,
  permission: null,
  error: null,
  turnStartedAt: null,
  started: false,
  handoffs: [],
}));

let handle: StreamHandle | null = null;

/** The folder the copilot's chats run in: the workspace (scratch) project, else the current one. */
function pickProject(): string | null {
  const st = useStore.getState();
  return st.projects.find(p => p.isWorkspace)?.path ?? st.project ?? null;
}

function closeBursts(bursts: Map<number, ReasoningBurst>): Map<number, ReasoningBurst> {
  let changed = false;
  const next = new Map(bursts);
  for (const [k, b] of next) if (b.endedAt === undefined) { next.set(k, { ...b, endedAt: Date.now() }); changed = true; }
  return changed ? next : bursts;
}

function open(sessionId: string, since: number): void {
  handle?.close();
  const project = useCopilot.getState().project ?? undefined;
  handle = streamSession(
    sessionId,
    (event) => apply(sessionId, event),
    (status) => { if (useCopilot.getState().sessionId === sessionId) useCopilot.setState({ status }); },
    since,
    project,
  );
}

/** Connect to the remembered conversation, or start one, if nothing is connected yet. */
export function ensureCopilot(): void {
  const s = useCopilot.getState();
  if (handle && s.sessionId) return;
  connectCopilot(s.sessionId ?? freshSessionId());
}

export function connectCopilot(sessionId: string): void {
  const project = useCopilot.getState().sessionId === sessionId && useCopilot.getState().project
    ? useCopilot.getState().project
    : pickProject();
  save(SESSION_KEY, sessionId);
  save(PROJECT_KEY, project);
  useCopilot.setState({
    sessionId, project, status: 'connecting', logged: new Map(), draft: emptyDraft(), busy: false, lastSeq: 0,
    title: useStore.getState().sessions.find(x => x.id === sessionId)?.title ?? '',
    question: null, permission: null, error: null, turnStartedAt: null, started: false, handoffs: [],
  });
  open(sessionId, 0);
}

export function newCopilotChat(): void {
  handle?.close();
  handle = null;
  connectCopilot(freshSessionId());
}

export function disconnectCopilot(): void {
  handle?.close();
  handle = null;
}

/** Take the stream: the conversation the other document may have switched to, replayed from the start. */
export function attachCopilot(): void {
  const stored = load(SESSION_KEY);
  const s = useCopilot.getState();
  if (handle && s.sessionId && s.sessionId === stored) return;
  // Keep the folder the other document started it in.
  if (stored && stored !== s.sessionId) useCopilot.setState({ sessionId: stored, project: load(PROJECT_KEY) });
  connectCopilot(stored ?? s.sessionId ?? freshSessionId());
}

/** Hand the stream to the other document; what is shown stays until it attaches again. */
export function detachCopilot(): void {
  disconnectCopilot();
  useCopilot.setState({ status: 'idle' });
}

export async function sendCopilot(task: string, opts: { title?: string; approval?: SubmitOptions['approval']; effort?: SubmitOptions['effort'] } = {}): Promise<boolean> {
  ensureCopilot();
  const { sessionId, project, started } = useCopilot.getState();
  if (!sessionId) return false;
  useCopilot.setState({ error: null, busy: true, draft: emptyDraft(), turnStartedAt: Date.now(), started: true });
  try {
    await api.submit({
      sessionId,
      task,
      surface: 'browser-copilot',
      ...(project ? { project } : {}),
      ...(opts.approval && opts.approval !== 'auto' ? { approval: opts.approval } : {}),
      ...(opts.effort && opts.effort !== 'auto' ? { effort: opts.effort } : {}),
    });
    useCopilot.setState(s => ({ logged: withPending(s.logged, task) }));
    // Named for what it is, so the sidebar does not title it after the page header.
    if (!started && opts.title) {
      void api.rename(sessionId, opts.title).then(() => useCopilot.setState({ title: opts.title! })).catch(() => {});
    }
    void useStore.getState().refreshSessions();
    return true;
  } catch (err) {
    useCopilot.setState({ busy: false, turnStartedAt: null, error: (err as Error).message });
    return false;
  }
}

/**
 * Move this request to a full chat now, without the model deciding: the
 * composer's "Hand off to chat". The engine opens, seeds and starts the chat;
 * the card shows here, and the main window's toast comes from the
 * `chat-handoff` topic like any other hand-off.
 */
export async function handOffNow(task: string, page: ChatHandOffRequest['page']): Promise<ChatHandOff | null> {
  const { sessionId } = useCopilot.getState();
  useCopilot.setState({ error: null });
  try {
    const out = await api.handOff({ task, page, ...(sessionId ? { fromSessionId: sessionId } : {}) });
    if (!out.ok) { useCopilot.setState({ error: out.error }); return null; }
    const done: ChatHandOff = { sessionId: out.sessionId, title: out.title, project: out.project, existing: out.existing, queued: out.queued };
    useCopilot.setState(s => ({ handoffs: [...s.handoffs, done] }));
    void useStore.getState().refreshSessions();
    return done;
  } catch (err) {
    useCopilot.setState({ error: `Could not hand off: ${(err as Error).message}` });
    return null;
  }
}

/** Stop the turn; if the server says nothing is running, stop looking busy too. */
export async function cancelCopilot(): Promise<void> {
  const { sessionId } = useCopilot.getState();
  if (!sessionId) return;
  const bounded = <T,>(p: Promise<T>): Promise<T | 'timeout'> => Promise.race([p, new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 4000))]);
  try { await bounded(api.cancel(sessionId)); } catch { /* reconciled below */ }
  try {
    const snap = await bounded(api.session(sessionId));
    if (snap === 'timeout' || !snap.busy) useCopilot.setState({ busy: false, turnStartedAt: null, question: null });
  } catch { useCopilot.setState({ busy: false, turnStartedAt: null }); }
}

export async function answerCopilot(content: string): Promise<void> {
  const { sessionId } = useCopilot.getState();
  if (!sessionId) return;
  await api.answer(sessionId, content);
  useCopilot.setState({ question: null });
}

export async function permitCopilot(allow: boolean): Promise<void> {
  const { sessionId, permission } = useCopilot.getState();
  if (!sessionId || !permission) return;
  await api.permit(sessionId, permission.id, allow);
  useCopilot.setState({ permission: null });
}

/** Fold one stream event into the copilot's state — the main store's rules, for the events a browsing chat has. */
function apply(sessionId: string, event: StreamEvent): void {
  if (useCopilot.getState().sessionId !== sessionId) return;
  const data = event.data ?? {};
  const set = useCopilot.setState;
  switch (event.type) {
    case 'log':
      set(s => {
        const patch: Partial<CopilotState> = {
          logged: applyLogEvent(s.logged, event.seq ?? 0, data),
          lastSeq: Math.max(s.lastSeq, event.seq ?? 0),
        };
        if (data.type === 'user/message') patch.started = true;
        if (data.type === 'session/title' && data.title) patch.title = String(data.title);
        return patch;
      });
      return;
    case 'caught-up': {
      const d = data as { busy?: boolean; permission?: PermissionRequest | null };
      set(s => ({
        status: 'live',
        busy: Boolean(d.busy),
        permission: d.permission ?? null,
        draft: d.busy ? s.draft : emptyDraft(),
        logged: dropPending(s.logged),
        started: s.started || s.logged.size > 0,
      }));
      return;
    }
    case 'turn-start':
      set(s => ({ busy: true, draft: emptyDraft(), error: null, turnStartedAt: s.turnStartedAt ?? Date.now() }));
      return;
    case 'chunk':
      set(s => ({ draft: { ...s.draft, reasoning: closeBursts(s.draft.reasoning), text: String(data.text ?? '') } }));
      return;
    case 'reasoning': {
      const step = Number(data.step ?? 0);
      const text = String(data.text ?? '');
      set(s => {
        const reasoning = new Map(s.draft.reasoning);
        const existing = reasoning.get(step);
        reasoning.set(step, existing ? { ...existing, text } : { step, text, startedAt: Date.now() });
        const order = existing ? s.draft.order : [...s.draft.order, { kind: 'reasoning' as const, key: step }];
        return { draft: { ...s.draft, reasoning, order } };
      });
      return;
    }
    case 'tool-start': {
      const callId = String(data.callId ?? '');
      set(s => {
        const tools = new Map(s.draft.tools);
        tools.set(callId, {
          id: `tool-${callId}`, type: 'tool', content: '', toolName: String(data.name ?? 'tool'),
          toolArgs: (data.args ?? {}) as Record<string, unknown>, toolCallId: callId, toolRunning: true, timestamp: Date.now(),
        });
        const order = s.draft.order.some(e => e.kind === 'tool' && e.key === callId) ? s.draft.order : [...s.draft.order, { kind: 'tool' as const, key: callId }];
        return { draft: { ...s.draft, tools, reasoning: closeBursts(s.draft.reasoning), order } };
      });
      return;
    }
    case 'tool-progress': {
      const callId = String(data.callId ?? '');
      set(s => {
        const existing = s.draft.tools.get(callId);
        if (!existing) return {};
        const tools = new Map(s.draft.tools);
        tools.set(callId, { ...existing, toolResult: { stdout: String(data.output ?? ''), stderr: '', exit_code: 0 }, toolProgressMs: Number(data.elapsedMs ?? 0) });
        return { draft: { ...s.draft, tools } };
      });
      return;
    }
    case 'tool-done': {
      const callId = String(data.callId ?? '');
      set(s => {
        const tools = new Map(s.draft.tools);
        const existing = tools.get(callId);
        tools.set(callId, {
          ...(existing ?? { id: `tool-${callId}`, type: 'tool' as const, content: '', toolName: String(data.name ?? 'tool'), timestamp: Date.now() }),
          toolResult: data.result, toolRunning: false,
        });
        return { draft: { ...s.draft, tools } };
      });
      return;
    }
    case 'question':
      set({ question: String((data as { question?: string }).question ?? '') || null });
      return;
    case 'permission': {
      const asked = data as unknown as PermissionRequest;
      set({ permission: asked?.id ? asked : null });
      return;
    }
    case 'title': {
      const title = String((data as { title?: string }).title ?? '');
      if (title) set({ title });
      return;
    }
    case 'turn-end': {
      const error = data.error && !data.cancelled ? String(data.error) : null;
      set({ busy: false, turnStartedAt: null, error, question: null });
      // Replay this turn in its durable form, as the main chat does.
      queueMicrotask(() => {
        const s = useCopilot.getState();
        if (s.sessionId === sessionId) open(sessionId, s.lastSeq);
      });
      return;
    }
    default:
      return;
  }
}
