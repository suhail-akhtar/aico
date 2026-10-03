/**
 * The Tasks panel in the desktop: the right-hand side panel, the full page,
 * the "N running tasks" chip under a chat, and the toasts and native
 * notifications when a task finishes or starts waiting for you.
 *
 * The list itself is the shared component (`@aico/ui` tasks/TasksPanel) fed
 * by the engine's `tasks/events` topic (`@web/tasks`); this file adds what
 * only the desktop has — terminal tabs and browser procedures from Electron
 * main (tasks/desktop-items), and the window's own ways to show things:
 * opening a chat, the trajectory view for a sub-agent's transcript, the
 * terminal panel, the built-in browser.
 *
 * Its open/closed state is its own small store rather than a field on
 * `state/desk`: the panel is one feature, and the shell should not have to
 * know it exists beyond mounting <TasksHost/>.
 *
 * @module desktop/renderer/tasks/TasksHost
 */

import React, { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useStore } from '@web/store';
import { connectTasks, runScheduleAction, runTaskAction, useTasks, type TaskActionHost } from '@web/tasks';
import { TasksChip, TasksPanel } from '@aico/shared/ui/tasks/TasksPanel';
import { filterTasks, memoOf, summarise, taskChanges, type TaskActionId, type TaskItem, type TaskMemo, type ScheduleItem } from '@aico/shared/tasks';
import { useDesk, toast } from '@/state/desk';
import { desktop, invoke } from '@/desktop';
import { openChat } from '@/chat/actions';
import { showBrowser } from '@/browser/host';
import { procedureItems, terminalItems, type ProcedureRunLike, type TerminalSummaryLike } from './desktop-items';

// ── state ────────────────────────────────────────────────────────────────

interface TasksUi {
  open: boolean;
  width: number;
  /** Bumped when opened from the keyboard, so the list takes focus. */
  focusKey: number;
  /** Rows from Electron main: terminals and procedures. */
  local: TaskItem[];
}

export const useTasksUi = create<TasksUi>(() => ({ open: false, width: 420, focusKey: 0, local: [] }));

/** Open, close or toggle the side panel. On the Tasks page, toggling goes back to where you were. */
export function toggleTasks(force?: boolean, focus = false): void {
  const desk = useDesk.getState();
  if (desk.route.view === 'tasks' && force !== true) { desk.goBack(); return; }
  const open = force ?? !useTasksUi.getState().open;
  useTasksUi.setState(s => ({ open, focusKey: focus && open ? s.focusKey + 1 : s.focusKey }));
}

export function openTasksPage(): void {
  useTasksUi.setState({ open: false });
  useDesk.getState().navigate({ view: 'tasks' });
}

/** Everything the panel lists: the engine's snapshot plus the desktop's own rows. */
export function useAllTasks(): TaskItem[] {
  const snapshot = useTasks(s => s.snapshot);
  const local = useTasksUi(s => s.local);
  return useMemo(() => [...(snapshot?.items ?? []), ...local], [snapshot, local]);
}

/** Running and waiting counts, for the status bar and the chip. */
export function useTaskTotals(sessionId?: string): { running: number; waiting: number } {
  const items = useAllTasks();
  return useMemo(() => {
    const mine = sessionId ? filterTasks(items, { scope: 'chat', sessionId }) : items;
    const t = summarise(mine, Date.now());
    return { running: t.running, waiting: t.waiting };
  }, [items, sessionId]);
}

// ── actions ──────────────────────────────────────────────────────────────

const HOST: TaskActionHost = {
  openChat: (id) => { void openChat(id); },
  // A sub-agent's log is a session of its own (`sub-<id>`); the trajectory view reads it.
  viewTranscript: (id) => { useDesk.getState().navigate({ view: 'trajectory', params: { id } }); },
  notify: (kind, title, body) => { toast[kind](title, body); },
};

async function act(action: TaskActionId, item: TaskItem): Promise<void> {
  // The desktop's own rows: a terminal tab or the browser.
  if (item.kind === 'terminal') {
    const termId = item.ref?.terminalId;
    if (action === 'show') { useDesk.getState().setPanel({ open: true, tab: 'terminal' }); return; }
    if (action === 'stop' && termId) {
      // Ctrl+C into the tab, as the person would press it — the tab and its shell stay.
      await invoke('term:write', termId, '\x03').catch((e: Error) => toast.error('Could not interrupt it', e.message));
      toast.info('Sent Ctrl+C', item.title);
      return;
    }
  }
  if (item.kind === 'procedure' && action === 'show') { showBrowser(); return; }
  await runTaskAction(action, item, HOST);
}

function scheduleAct(action: 'pause' | 'resume', s: ScheduleItem): Promise<void> {
  return runScheduleAction(action, s.id, HOST);
}

// ── the host: stream, polling, notifications, the side panel ─────────────

const POLL_MS = 2000;

/** Mounted once by the App: keeps the stream open, polls main, raises notifications. */
export function TasksHost({ hidden = false }: { hidden?: boolean }): React.ReactElement | null {
  const ready = useDesk(s => s.engine.status === 'ready');
  const open = useTasksUi(s => s.open);
  const onPage = useDesk(s => s.route.view === 'tasks');

  useEffect(() => (ready ? connectTasks() : undefined), [ready]);

  // Terminals and procedures live in Electron main; poll them while the window lives.
  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const [terms, runs] = await Promise.all([
        invoke<TerminalSummaryLike[]>('term:list').catch(() => [] as TerminalSummaryLike[]),
        invoke<ProcedureRunLike[]>('browser:teach:runs').catch(() => [] as ProcedureRunLike[]),
      ]);
      if (!alive) return;
      const prev = new Map(useTasksUi.getState().local.map(i => [i.id, i]));
      const now = Date.now();
      const next = [...terminalItems(Array.isArray(terms) ? terms : [], prev, now), ...procedureItems(Array.isArray(runs) ? runs : [], prev, now)];
      const before = useTasksUi.getState().local;
      if (JSON.stringify(next) !== JSON.stringify(before)) useTasksUi.setState({ local: next });
    };
    void tick();
    const t = setInterval(() => { void tick(); }, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useTaskNotifications();

  if (!open || onPage || hidden) return null;
  return <TasksSide />;
}

/**
 * Tell the person when work they are not watching changes: a toast in the
 * window, a native notification when it is in the background. Inbox items
 * and permission prompts already notify through `notifications.ts`, so they
 * are left out here rather than announced twice.
 */
function useTaskNotifications(): void {
  const items = useAllTasks();
  const memo = React.useRef<TaskMemo | undefined>(undefined);
  const snapshotSeen = useTasks(s => s.snapshot !== null);
  useEffect(() => {
    if (!snapshotSeen) return;
    const changes = taskChanges(memo.current, items);
    memo.current = memoOf(items);
    if (!changes.length) return;
    const prefs = useDesk.getState().prefs.notifications;
    const focused = typeof document !== 'undefined' && document.hasFocus();
    const openPanel = { label: 'View', run: () => toggleTasks(true) };
    // Someone looking at the panel is already being told; a toast over it would be noise.
    const watching = focused && (useTasksUi.getState().open || useDesk.getState().route.view === 'tasks');
    if (watching) return;

    const finished = changes.filter(c => c.type === 'finished' && !c.item.parentId && c.item.kind !== 'permission' && c.item.kind !== 'question' && c.item.kind !== 'inbox');
    if (finished.length === 1) {
      const it = finished[0]!.item;
      const failed = it.status === 'failed';
      useDesk.getState().toast({ kind: failed ? 'error' : it.status === 'stopped' ? 'info' : 'success', title: `${failed ? 'Failed' : it.status === 'stopped' ? 'Stopped' : 'Finished'}: ${it.title}`, body: failed ? it.error : it.outcome?.slice(0, 160), action: openPanel });
      if (!focused && prefs.background) void desktop.notify({ title: failed ? `Task failed — ${it.title}` : `Task finished — ${it.title}`, body: (failed ? it.error : it.outcome)?.slice(0, 180) ?? 'Open Tasks to see it.', data: { view: 'tasks' }, onlyWhenUnfocused: true });
    } else if (finished.length > 1) {
      const failed = finished.filter(c => c.item.status === 'failed').length;
      useDesk.getState().toast({ kind: failed ? 'warning' : 'success', title: `${finished.length} tasks finished${failed ? `, ${failed} failed` : ''}`, action: openPanel });
      if (!focused && prefs.background) void desktop.notify({ title: `${finished.length} tasks finished`, body: failed ? `${failed} failed — open Tasks to see why.` : 'Open Tasks to see them.', data: { view: 'tasks' }, onlyWhenUnfocused: true });
    }

    const asks = changes.filter(c => c.type === 'needs-you' && (c.item.kind === 'longjob' || c.item.kind === 'procedure'));
    for (const c of asks.slice(0, 2)) {
      useDesk.getState().toast({ kind: 'warning', title: `Waiting for you: ${c.item.title}`, body: c.item.detail?.slice(0, 160), action: openPanel, ttl: 9000 });
      if (!focused && prefs.attention) void desktop.notify({ title: `Waiting for you — ${c.item.title}`, body: c.item.detail?.slice(0, 180) ?? 'Open Tasks to answer.', data: { view: 'tasks' }, onlyWhenUnfocused: true });
    }
  }, [items, snapshotSeen]);
}

function usePanelProps(): Omit<React.ComponentProps<typeof TasksPanel>, 'layout'> {
  const snapshot = useTasks(s => s.snapshot);
  const connection = useTasks(s => s.connection);
  const local = useTasksUi(s => s.local);
  const sessionId = useStore(s => s.sessionId);
  const logged = useStore(s => s.logged.size);
  const sessions = useStore(s => s.sessions);
  const titles = useMemo(() => new Map(sessions.map(s => [s.id, s.title || 'New chat'])), [sessions]);
  return {
    snapshot,
    extraItems: local,
    connection,
    // "This chat" only means something when a chat is on screen.
    ...(logged > 0 ? { sessionId } : {}),
    sessionTitle: (id: string) => titles.get(id),
    onAction: act,
    onScheduleAction: scheduleAct,
    copyText: (text: string) => { void desktop.clipboard.writeRich(text); },
  };
}

/** The right-hand side panel, resizable like the browser dock. */
function TasksSide(): React.ReactElement {
  const width = useTasksUi(s => s.width);
  const focusKey = useTasksUi(s => s.focusKey);
  const props = usePanelProps();
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: MouseEvent): void => useTasksUi.setState({ width: Math.max(320, Math.min(Math.min(720, window.innerWidth - 480), startW - (ev.clientX - startX))) });
    const up = (): void => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <aside className="relative flex shrink-0 flex-col border-l border-aico-border-subtle bg-aico-bg" style={{ width }} aria-label="Tasks">
      <div className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize" onMouseDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize the Tasks panel" />
      <TasksPanel key={focusKey} {...props} layout="panel" autoFocus={focusKey > 0}
        onClose={() => toggleTasks(false)} onExpand={openTasksPage} />
    </aside>
  );
}

/** The full-page view (route `tasks`). */
export function TasksPage(): React.ReactElement {
  const props = usePanelProps();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TasksPanel {...props} layout="page" expanded
        onExpand={() => { useDesk.getState().goBack(); useTasksUi.setState({ open: true }); }} />
    </div>
  );
}

/** "3 running tasks · 1 needs you" under the open chat; opens the panel. */
export function TasksChipHost(): React.ReactElement | null {
  const sessionId = useStore(s => s.sessionId);
  const { running, waiting } = useTaskTotals(sessionId);
  const open = useTasksUi(s => s.open);
  if (open) return null;
  return <TasksChip running={running} waiting={waiting} onOpen={() => toggleTasks(true)} />;
}
