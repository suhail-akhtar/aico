/**
 * The Delivery board's client state: one project's `BoardState`, kept fresh.
 *
 * Freshness has two sources, because a push can be missed: the engine's
 * `GET /api/delivery/events?project=` topic stream (a full `delivery/board`
 * frame on connect and after every change, read with `streamTopic`) and a poll.
 * While the stream is live the poll is only a 15 s safety net; the moment it is
 * connecting or lost the poll runs every 3 s, so a dead stream degrades to
 * polling instead of a frozen board. Any frame or fetch resets the poll's
 * clock, and the poll pauses while the tab is hidden.
 *
 * Shared by the web portal and the desktop (which imports `@web/*`), so both
 * show the same board from the same routes. Reference-counted like web/tasks:
 * the feed is open while a Delivery view is mounted, and follows one project
 * at a time.
 *
 * What it does not do: decide what a person may do (delivery-model.ts) or ask
 * for the human gate (api.ts sends the person-only calls as a person).
 *
 * @module web/delivery
 */

import { create } from 'zustand';
import { api, streamTopic, type StreamHandle } from './api';
import { normaliseBoard, normaliseTask, sameBoard } from './delivery-model';
import type { BoardState, Task, TaskStatus } from './delivery-types';

/** How often to poll when the stream is not live. */
export const POLL_MS = 3000;
/** With a live stream, a reconcile this often catches a frame the stream dropped. */
const SAFETY_POLL_MS = 15_000;

interface DeliveryState {
  project: string | null;
  board: BoardState | null;
  /** True until the first board (or the first error) for this project. */
  loading: boolean;
  error: string | null;
  /** When the board last changed from either source (a frame or a fetch). */
  lastEventAt: number;
  /**
   * Waits a person has just answered here: task id -> the wait's key. The engine confirms on its
   * next frame (3 s at most); until then the board shows the task as no longer waiting.
   */
  answered: Record<string, string>;
}

export const useDelivery = create<DeliveryState>(() => ({
  project: null, board: null, loading: false, error: null, lastEventAt: 0, answered: {},
}));

/** How long an answer is trusted before the engine's own word wins again (a lost answer must not hide a wait for good). */
const ANSWER_TRUST_MS = 20_000;

/** Show a wait as answered now; the engine's next frame confirms it (or, after 20 s, the wait shows again). */
export function markNeedAnswered(taskId: string, key: string): void {
  useDelivery.setState(s => ({ answered: { ...s.answered, [taskId]: key } }));
  setTimeout(() => {
    useDelivery.setState(s => {
      if (s.answered[taskId] !== key) return s;
      const { [taskId]: _gone, ...rest } = s.answered;
      return { answered: rest };
    });
  }, ANSWER_TRUST_MS);
}

let seq = 0;

/** Fetch the board now. A response for a project that is no longer shown is dropped. */
export async function refreshBoard(): Promise<void> {
  const project = useDelivery.getState().project;
  if (!project) return;
  const mine = ++seq;
  try {
    const raw = await api.deliveryBoard(project);
    if (mine !== seq || useDelivery.getState().project !== project) return;
    const board = normaliseBoard(raw);
    if (!board) throw new Error('The engine returned a board this version cannot read.');
    const cur = useDelivery.getState().board;
    useDelivery.setState({ board: sameBoard(cur, board) ? cur : board, loading: false, error: null, lastEventAt: Date.now() });
  } catch (err) {
    if (mine !== seq) return;
    useDelivery.setState({ loading: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** A `delivery/board` frame: the payload is a BoardState (or `{ board }`). */
export function applyBoardEvent(data: unknown): void {
  const raw = data && typeof data === 'object' && 'board' in data ? (data as { board: unknown }).board : data;
  const board = normaliseBoard(raw);
  if (!board) return;
  const s = useDelivery.getState();
  if (s.project && board.project && !samePath(board.project, s.project)) return;
  seq++; // anything in flight is older than this
  useDelivery.setState({
    board: sameBoard(s.board, board) ? s.board : board,
    loading: false, error: null, lastEventAt: Date.now(),
  });
}

/** The engine resolves the project path; Windows drive letters and slashes may differ in spelling only. */
function samePath(a: string, b: string): boolean {
  const n = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
}

/** A route that returned the changed task: fold it into the board without waiting for the next frame. */
export function upsertTask(task: Task): void {
  const s = useDelivery.getState();
  if (!s.board) return;
  const t = normaliseTask(task);
  const has = s.board.tasks.some(x => x.id === t.id);
  useDelivery.setState({ board: { ...s.board, tasks: has ? s.board.tasks.map(x => (x.id === t.id ? t : x)) : [...s.board.tasks, t] } });
}

/** A route that returned the whole board (dispatch). */
export function setBoard(board: BoardState): void {
  const b = normaliseBoard(board);
  if (b) useDelivery.setState({ board: b, error: null });
}

/** Show a move at once; returns the undo for when the engine refuses it. */
export function optimisticStatus(id: string, status: TaskStatus): () => void {
  const prev = useDelivery.getState().board;
  if (!prev) return () => undefined;
  useDelivery.setState({ board: { ...prev, tasks: prev.tasks.map(t => (t.id === id ? { ...t, status } : t)) } });
  return () => { if (useDelivery.getState().board !== null) useDelivery.setState({ board: prev }); };
}

let refs = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let stream: StreamHandle | undefined;
let streamFor: string | null = null;
let streamLive = false;

function openStream(project: string): void {
  if (stream && streamFor === project) return;
  stream?.close();
  streamFor = project;
  stream = streamTopic<unknown>(`delivery/events?project=${encodeURIComponent(project)}`, (ev) => {
    if (ev.type === 'delivery/board' || ev.type === 'full') applyBoardEvent(ev.data);
  }, (status) => { streamLive = status === 'live'; });
}

/** Follow one project's board. Returns the release; the stream and poll stop with the last one. */
export function followDelivery(project: string): () => void {
  refs++;
  if (useDelivery.getState().project !== project) {
    seq++;
    useDelivery.setState({ project, board: null, loading: true, error: null, lastEventAt: 0, answered: {} });
  }
  openStream(project);
  void refreshBoard();
  if (!timer) {
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (Date.now() - useDelivery.getState().lastEventAt < (streamLive ? SAFETY_POLL_MS : POLL_MS - 500)) return;
      void refreshBoard();
    }, POLL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refs = Math.max(0, refs - 1);
    if (refs === 0) {
      if (timer) { clearInterval(timer); timer = undefined; }
      stream?.close(); stream = undefined; streamFor = null; streamLive = false;
    }
  };
}
