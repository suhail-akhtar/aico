/**
 * Delivery: a work board where agents take tasks in parallel and a person
 * reviews and lands their work. One component used by the web portal and the
 * desktop app; each supplies a `host` for the few things only it can do
 * (open an agent's session, open the Code map).
 *
 * Direction — purpose: an engineer who has handed work to agents and needs to see,
 * at a glance, what is moving, what is stuck and why, and what waits on them; and who
 * should not feel they need another board at first glance. Tone: calm and exact.
 * Signature: the board always says WHY nothing is moving (the status banner and the
 * Blocked-by chips) and offers the one click that fixes it; the Review column carries a
 * risk spine on each card (red / amber / green). Everything else is the portal's own
 * neutral palette; status colour appears only with a word.
 *
 * Decisions that shape the code:
 *  - People move cards only among Backlog / Ready / Blocked / Cancelled;
 *    agents own Running and landing is "Approve and land" in the drawer, never
 *    a drag (delivery-model `checkMove`, which also supplies the tooltips). Inside
 *    Backlog / Ready / Blocked a person's order is kept (drag, the card menu, or Alt +
 *    Up / Down); Review stays in risk order on purpose.
 *  - Board and List are two readings of one filtered set; the filter language, saved
 *    views, bulk ticks and the drawer are shared. Swimlanes group the board by assignee,
 *    type or epic; a column can collapse; density is comfortable or compact.
 *  - Blocked and Cancelled are filters (chips) that add a column, not columns
 *    that are always there; Merged starts as a collapsed rail, which keeps the working
 *    columns on screen at 1440 px without sideways scrolling.
 *  - Live updates come from `delivery/board` frames with a 3 s poll behind them
 *    (web/delivery.ts); this file only reads the store.
 *  - The drawer overlays the board's right edge rather than squeezing it, so a
 *    diff gets real width and the board stays where it was. The Activity panel and the
 *    metrics strip are toggles, off by default, so the board stays calm.
 *  - Views in the tab strip: the Board, the Review queue (with batch
 *    approval, ReviewQueue.tsx) and Releases (ReleasesView.tsx). The choice is
 *    remembered. A task whose run waits for a person is counted in the header
 *    ("N need you") and answered where it is seen; see NeedsYou.tsx.
 *  - Answers are optimistic: once a wait is answered the store hides it until the
 *    engine's next frame confirms, and `info` carries the one-line confirmation.
 *
 * What it does not do: decide risk, run agents, or talk to git. It draws the
 * board the engine reports and sends the person's decisions back.
 *
 * @module web/components/delivery/DeliveryView
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { followDelivery, optimisticOrder, optimisticStatus, refreshBoard, setBoard, upsertTask, useDelivery } from '../../delivery';
import type { Task, TaskStatus } from '../../delivery-types';
import {
  COLUMNS, PARKED, STATUS_LABEL, checkMove, countTasks, formatUsd, groupTasks, labelsOf, makeRef, needingYou, needsChipLabel, sessionOf, sortForReview,
  withoutAnswered, type ColumnDef,
} from '../../delivery-model';
import {
  agentsOf, applyFilter, assigneesOf, buildLanes, feedOf, nudgeId, parseFilter, reorderIds, statusLine, stepSelection, wipLimit,
  type LaneBy,
} from '../../delivery-board';
import { BoardConnectionBar } from '../connections/BoardConnectionBar';
import { BoardConnectionContext } from '../connections/context';
import { activeSprintOf, currentSprintOf, modeOf, plannedSprintOf, skippedBySprint, sprintsOf, type Mode } from '../../delivery-scrum';
import { ActivityPanel, MetricsStrip } from './ActivityPanel';
import { AutonomyChip } from './AutonomyControl';
import { Segmented } from './board-bits';
import { ADDABLE, BoardCanvas, REORDERABLE } from './BoardCanvas';
import { BulkBar } from './BulkBar';
import { NewTaskDialog, PlanDialog, StartDispatcherDialog } from './Dialogs';
import { FilterBar } from './FilterBar';
import { ListView } from './ListView';
import { ModeSwitch } from './scrum/bits';
import { BacklogView } from './scrum/BacklogView';
import { CeremoniesView } from './scrum/CeremoniesView';
import { AddToSprintDialog, PlanSprintDialog, SprintActionDialog } from './scrum/PlanSprintDialog';
import { ReportsView } from './scrum/ReportsView';
import { ScrumHeader } from './scrum/ScrumHeader';
import { DvIcon } from './icons';
import { ReleasesView } from './ReleasesView';
import { ReviewQueue } from './ReviewQueue';
import { ShortcutsHelp } from './ShortcutsHelp';
import { ViewOptions } from './ViewOptions';
import { AgentsStrip, StatusBanner, bannerVisible } from './StatusBanner';
import type { CardContext, Density } from './TaskCard';
import { TaskDrawer } from './TaskDrawer';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, Callout, ErrorLine, INPUT, RefContext, Skeleton, Tabs, edge, panelId, tabId, tint } from './ui';

export interface DeliveryHost {
  /** Open an agent's (or the planner's) session. */
  openSession: (sessionId: string) => void;
  /** Open the Code map on a file in Focus view (or the map itself, with no file). */
  openCodeMap: (file?: string) => void;
  /** Open Settings on the Connections page (ADR 0039). Absent in a host with no Settings; the link is then left out. */
  openConnections?: (() => void) | undefined;
}

export interface DeliveryViewProps {
  projectPath: string;
  projectName: string;
  host: DeliveryHost;
  /** When given with `onProjectChange`, the header offers a project switcher. */
  projects?: Array<{ path: string; name: string }>;
  onProjectChange?: (path: string) => void;
  /** Open this task's drawer when the board has loaded (a link from the task's chat). */
  openTaskId?: string | undefined;
}

type View = 'board' | 'review' | 'releases' | 'backlog' | 'reports' | 'ceremonies';
const VIEWS: readonly View[] = ['board', 'review', 'releases', 'backlog', 'reports', 'ceremonies'];
/** Views that exist only in Scrum mode (ADR 0039 section 4). */
const SCRUM_VIEWS: readonly View[] = ['backlog', 'reports', 'ceremonies'];
const TABS_PREFIX = 'dv-view';

function pref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try { const v = localStorage.getItem(key); return v && (allowed as readonly string[]).includes(v) ? v as T : fallback; } catch { return fallback; }
}
function setPref(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* best effort: a convenience, not state */ }
}

export function DeliveryView({ projectPath, projectName, host, projects, onProjectChange, openTaskId }: DeliveryViewProps): React.ReactElement {
  const board = useDelivery(s => s.board);
  const loading = useDelivery(s => s.loading);
  const error = useDelivery(s => s.error);
  const answered = useDelivery(s => s.answered);

  useEffect(() => followDelivery(projectPath), [projectPath]);

  const [view, setView] = useState<View>(() => pref('aico.delivery.view', 'board', VIEWS));
  const [layout, setLayout] = useState<'board' | 'list'>(() => pref('aico.delivery.layout', 'board', ['board', 'list']));
  const [density, setDensity] = useState<Density>(() => pref('aico.delivery.density', 'comfortable', ['comfortable', 'compact']));
  const [laneBy, setLaneBy] = useState<LaneBy>(() => pref('aico.delivery.lanes', 'none', ['none', 'assignee', 'type', 'epic']));
  const [activityOpen, setActivityOpen] = useState(() => pref('aico.delivery.activity', 'closed', ['open', 'closed']) === 'open');
  const [metricsOpen, setMetricsOpen] = useState(() => pref('aico.delivery.metrics', 'closed', ['open', 'closed']) === 'open');
  const [collapsed, setCollapsed] = useState<Set<TaskStatus>>(() => {
    try { const raw = localStorage.getItem('aico.delivery.collapsed'); if (raw) return new Set(JSON.parse(raw) as TaskStatus[]); } catch { /* fall through to the default */ }
    return new Set<TaskStatus>(['merged']);
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [quickAdd, setQuickAdd] = useState<TaskStatus | null>(null);
  const [query, setQuery] = useState('');
  const [showBlocked, setShowBlocked] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'plan' | 'start' | 'sprint' | 'keys' | null>(null);
  const [sprintAction, setSprintAction] = useState<'start' | 'close' | null>(null);
  const [addTask, setAddTask] = useState<Task | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [refining, setRefining] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [onlyNeeds, setOnlyNeeds] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [listOrder, setListOrder] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  // Reset the per-project bits when the project changes.
  useEffect(() => { setSelectedId(null); setFocusedId(null); setTicked(new Set()); setQuickAdd(null); setQuery(''); setNotice(null); setInfo(null); setOnlyNeeds(false); }, [projectPath]);

  // A wait the person has just answered reads as answered now; the engine's next frame confirms it.
  const tasks = useMemo(() => withoutAnswered(board?.tasks ?? [], answered), [board?.tasks, answered]);
  const byId = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const ref = useMemo(() => makeRef(tasks), [tasks]);
  const waiting = useMemo(() => needingYou(tasks), [tasks]);
  // Scrum (ADR 0039 section 4): the same board with a time box. The sprint board shows the sprint's tasks and any work already in flight.
  const mode: Mode = modeOf(board);
  const scrum = mode === 'scrum';
  const sprints = sprintsOf(board);
  const currentSprint = currentSprintOf(sprints);
  const offsetMin = -new Date().getTimezoneOffset();
  const boardTasks = useMemo(
    () => (scrum ? tasks.filter(t => (currentSprint && t.sprintId === currentSprint.id) || ['running', 'review', 'changes', 'pr'].includes(t.status)) : tasks),
    [scrum, tasks, currentSprint],
  );
  const filter = useMemo(() => parseFilter(query), [query]);
  const shown = useMemo(() => applyFilter(boardTasks, filter, ref), [boardTasks, filter, ref]);
  const filtered = Boolean(query.trim() || onlyNeeds);
  const queue = board?.queue ?? [];
  const groups = useMemo(() => groupTasks(shown, queue, { ref, onlyNeeds }), [shown, queue, ref, onlyNeeds]);
  const fullOrder = useMemo(() => groupTasks(boardTasks, queue, { ref }), [boardTasks, queue, ref]);
  const laneList = useMemo(() => buildLanes(shown, laneBy, tasks), [shown, laneBy, tasks]);
  const laneGroups = useMemo(() => laneList.map(lane => ({ lane, byStatus: groupTasks(lane.tasks, queue, { ref, onlyNeeds }) })), [laneList, queue, ref, onlyNeeds]);
  const counts = useMemo(() => countTasks(tasks), [tasks]);
  const labels = useMemo(() => labelsOf(tasks), [tasks]);
  const assignees = useMemo(() => assigneesOf(tasks), [tasks]);
  const reviewList = useMemo(() => sortForReview(tasks), [tasks]);
  const runs = useMemo(() => new Map((board?.running ?? []).map(r => [r.taskId, r])), [board?.running]);
  const totalCost = useMemo(() => tasks.reduce((n, t) => n + (t.costUsd ?? 0), 0), [tasks]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const status = useMemo(() => (board ? statusLine(board, tasks, ref) : null), [board, tasks, ref]);
  const agents = useMemo(() => (board ? agentsOf(board, tasks) : []), [board, tasks]);
  const feed = useMemo(() => (board ? feedOf(board, tasks) : []), [board, tasks]);

  // A ticking clock, only while something is running (elapsed times).
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = (board?.running.length ?? 0) > 0;
  useEffect(() => {
    if (!anyRunning && !selected) { setNow(Date.now()); return; }
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning, selected]);

  // The "need you" filter ends by itself when nobody is waiting any more.
  useEffect(() => { if (onlyNeeds && waiting.length === 0) setOnlyNeeds(false); }, [onlyNeeds, waiting.length]);

  // Back in Kanban the Scrum-only views are gone: land on the board rather than on a blank panel.
  useEffect(() => { if (board && !scrum && SCRUM_VIEWS.includes(view)) setView('board'); }, [board, scrum, view]);

  // A link from a task's chat asks for its drawer; honoured once, when the board has the task.
  const opened = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!openTaskId || opened.current === openTaskId || !board) return;
    if (byId.has(openTaskId)) { opened.current = openTaskId; setSelectedId(openTaskId); setView('board'); }
  }, [openTaskId, board, byId]);

  // Ticks that no longer point at a task (a replan, another client) drop out.
  useEffect(() => { setTicked(t => (t.size && [...t].some(id => !byId.has(id)) ? new Set([...t].filter(id => byId.has(id))) : t)); }, [byId]);

  const changeMode = async (next: Mode): Promise<void> => {
    setModeBusy(true); setNotice(null);
    try { await api.deliveryScrumMode(projectPath, next); await refreshBoard(); if (next === 'kanban' && SCRUM_VIEWS.includes(view)) switchView('board'); }
    catch (e) { setNotice(`Could not switch to ${next === 'scrum' ? 'Scrum' : 'Kanban'}: ${(e as Error).message}`); }
    finally { setModeBusy(false); }
  };
  const refine = async (): Promise<void> => {
    setRefining(true); setNotice(null);
    try { host.openSession((await api.deliveryRefine(projectPath)).sessionId); setInfo('An agent is reading the backlog. Its suggestions appear in the Backlog view for you to accept or dismiss.'); }
    catch (e) { setNotice(`Could not start refinement: ${(e as Error).message}`); }
    finally { setRefining(false); }
  };

  // A confirmation fades by itself; an error never does.
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => setInfo(null), 7000);
    return () => clearTimeout(t);
  }, [info]);

  // A selected task that disappears (a replan, another client) closes its drawer.
  useEffect(() => { if (selectedId && board && !byId.has(selectedId)) setSelectedId(null); }, [selectedId, board, byId]);

  const switchView = (v: View): void => { setView(v); setPref('aico.delivery.view', v); };
  const changeLayout = useCallback((l: 'board' | 'list'): void => { setLayout(l); setPref('aico.delivery.layout', l); }, []);
  const toggleNeeds = (): void => {
    if (view !== 'board') switchView('board');
    setOnlyNeeds(v => (view !== 'board' ? true : !v));
  };
  const toggleCollapse = useCallback((s: TaskStatus): void => {
    setCollapsed(c => { const n = new Set(c); if (n.has(s)) n.delete(s); else n.add(s); setPref('aico.delivery.collapsed', JSON.stringify([...n])); return n; });
  }, []);

  // ── the order the J / K keys walk ──
  const visibleColumns: ColumnDef[] = useMemo(() => {
    const showPr = board?.connection?.landing === 'pr' || counts.byStatus.pr > 0;
    return [
      ...COLUMNS.filter(c => (c.id !== 'pr' || showPr)).map(c => (scrum && c.id === 'backlog' ? { ...c, label: 'Sprint backlog', hint: 'Committed to the sprint; Ready once it starts' } : c)),
      ...(showBlocked ? PARKED.filter(c => c.id === 'blocked') : []),
      ...(showCancelled ? PARKED.filter(c => c.id === 'cancelled') : []),
    ];
  }, [board?.connection?.landing, counts.byStatus.pr, scrum, showBlocked, showCancelled]);
  const walkOrder = useMemo(
    () => (layout === 'list' ? listOrder : visibleColumns.filter(c => !collapsed.has(c.id)).flatMap(c => groups[c.id].map(t => t.id))),
    [layout, listOrder, visibleColumns, collapsed, groups],
  );

  // ── actions ──
  const applyOrder = useCallback(async (statusKey: TaskStatus, ids: string[]): Promise<void> => {
    const undo = optimisticOrder(ids);
    try { await api.deliveryReorder(projectPath, statusKey, ids); }
    catch (e) { undo(); setNotice(`Could not save the new order: ${(e as Error).message}`); }
  }, [projectPath]);

  const move = useCallback(async (task: Task, to: TaskStatus, beforeId: string | null = null): Promise<void> => {
    setNotice(null);
    if (task.status === to) {
      if (!REORDERABLE.includes(to)) return;
      await applyOrder(to, reorderIds(fullOrder[to].map(t => t.id), task.id, beforeId));
      return;
    }
    const c = checkMove(task, to);
    if (!c.ok) { setNotice(c.reason); return; }
    const undo = optimisticStatus(task.id, to);
    try {
      upsertTask(await api.deliveryUpdate(task.id, projectPath, { status: to }));
      if (beforeId && REORDERABLE.includes(to)) await applyOrder(to, reorderIds(fullOrder[to].map(t => t.id), task.id, beforeId));
    } catch (e) { undo(); setNotice(`Could not move ${ref(task.id)} to ${STATUS_LABEL[to]}: ${(e as Error).message}`); }
  }, [projectPath, ref, applyOrder, fullOrder]);

  const reorder = useCallback((task: Task, to: 'up' | 'down' | 'top'): void => {
    const ids = fullOrder[task.status].map(t => t.id);
    void applyOrder(task.status, to === 'top' ? reorderIds(ids, task.id, ids[0] ?? null) : nudgeId(ids, task.id, to === 'up' ? -1 : 1));
  }, [fullOrder, applyOrder]);

  const duplicate = useCallback(async (t: Task): Promise<void> => {
    try { const copy = await api.deliveryDuplicate(t.id, projectPath); upsertTask(copy); setSelectedId(copy.id); setInfo(`Duplicated ${ref(t.id)} into the backlog.`); }
    catch (e) { setNotice(`Could not duplicate: ${(e as Error).message}`); }
  }, [projectPath, ref]);

  const archive = useCallback((t: Task): void => {
    void move(t, 'cancelled').then(() => setInfo(`Archived ${ref(t.id)}. Restore it from the Cancelled column.`));
  }, [move, ref]);

  const tick = useCallback((t: Task): void => {
    setTicked(s => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; });
  }, []);

  const open = useCallback((t: Task) => { setSelectedId(t.id); setFocusedId(t.id); }, []);
  const openId = useCallback((id: string) => { setSelectedId(id); setFocusedId(id); }, []);
  const openChatOf = useCallback((taskId: string): void => {
    const t = useDelivery.getState().board?.tasks.find(x => x.id === taskId);
    const sid = t ? sessionOf(t) : undefined;
    if (sid) host.openSession(sid);
  }, [host]);
  const dragStart = useCallback((t: Task) => setDragId(t.id), []);
  const dragEnd = useCallback(() => setDragId(null), []);
  const dragged = dragId ? byId.get(dragId) ?? null : null;

  // A drop that moves a card re-parents its element, so the source never sees `dragend`; the window does.
  useEffect(() => {
    const end = (): void => setDragId(null);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => { window.removeEventListener('dragend', end); window.removeEventListener('drop', end); };
  }, []);

  // Keys. Ignored while typing or when a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || dialog) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (el?.closest('[role="menu"], [role="dialog"], [role="radiogroup"]')) return;
      const k = e.key;
      if (k === 'n') { e.preventDefault(); setDialog('new'); }
      else if (k === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (k === '?') { e.preventDefault(); setDialog('keys'); }
      else if (k === 'v') { e.preventDefault(); changeLayout(layout === 'board' ? 'list' : 'board'); }
      else if (k === 'a') { e.preventDefault(); setActivityOpen(o => { setPref('aico.delivery.activity', o ? 'closed' : 'open'); return !o; }); }
      else if (view === 'board' && (k === 'j' || k === 'k')) {
        e.preventDefault();
        const next = stepSelection(walkOrder, focusedId, k === 'j' ? 1 : -1);
        setFocusedId(next);
        if (next) requestAnimationFrame(() => document.querySelector(`[data-task="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      } else if (view === 'board' && k === 'Enter' && focusedId && byId.has(focusedId) && el?.tagName !== 'BUTTON') { e.preventDefault(); setSelectedId(focusedId); }
      else if (view === 'board' && k === 'x' && focusedId && byId.has(focusedId)) { e.preventDefault(); tick(byId.get(focusedId)!); }
      else if (k === 'Escape' && (ticked.size || focusedId)) { setTicked(new Set()); setFocusedId(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, layout, view, walkOrder, focusedId, byId, ticked.size, tick, changeLayout]);

  // After a decision, the review queue moves to the next task (the batch flow); otherwise the drawer closes.
  const afterDecision = useCallback((id: string) => {
    const list = sortForReview(useDelivery.getState().board?.tasks ?? []).filter(t => t.id !== id);
    setSelectedId(view === 'review' && list[0] ? list[0].id : null);
  }, [view]);

  const toggleDispatcher = async (): Promise<void> => {
    if (!board) return;
    if (board.dispatcher === 'running') {
      setPausing(true); setNotice(null);
      try { setBoard(await api.deliveryDispatch(projectPath, 'pause')); }
      catch (e) { setNotice(`Could not pause: ${(e as Error).message}`); }
      finally { setPausing(false); }
    } else setDialog('start');
  };

  /** The one click behind "2 ready tasks wait for #1 and #2": move the Backlog prerequisites to Ready. */
  const unblock = async (): Promise<void> => {
    if (!status) return;
    setFixing(true); setNotice(null);
    try {
      try { await Promise.all(status.blockedReady.map(id => api.deliveryPromotePrerequisites(id, projectPath))); }
      catch (e) {
        // An engine without the route: move the prerequisites one by one.
        if ((e as { status?: number }).status !== 404) throw e;
        await Promise.all(status.promote.map(id => api.deliveryUpdate(id, projectPath, { status: 'ready' })));
      }
      await refreshBoard();
      setInfo(`Moved ${status.promote.map(ref).join(', ')} to Ready. Agents will take them first.`);
    } catch (e) { setNotice(`Could not move them: ${(e as Error).message}`); }
    finally { setFixing(false); }
  };

  const columnCtx = (t: Task): CardContext => ({
    now, run: runs.get(t.id), selected: t.id === selectedId,
    onOpen: open, onMove: (task, to) => void move(task, to), onOpenSession: host.openSession, onHandled: setInfo, onDragStart: dragStart, onDragEnd: dragEnd,
    byId, allTasks: tasks, paused: board?.dispatcher === 'paused', density, focused: t.id === focusedId, ticked: ticked.has(t.id), ticking: ticked.size > 0, onTick: tick,
    ...(REORDERABLE.includes(t.status) ? { onReorder: reorder } : {}),
    onDuplicate: t2 => void duplicate(t2), onArchive: archive, onOpenTask: openId,
    ...(scrum ? {
      scrum: {
        skipped: skippedBySprint(t, sprints),
        onEstimate: (task: Task, points: number | null) => { void api.deliveryEstimate(task.id, projectPath, points).then(upsertTask).catch((e: Error) => setNotice(`Could not set the estimate: ${e.message}`)); },
      },
    } : {}),
  });

  const connCtx = useMemo(() => ({ connection: board?.connection, trunk: board?.settings.trunk ?? 'main' }), [board?.connection, board?.settings.trunk]);
  const mergedCount = scrum ? boardTasks.filter(t => t.status === 'merged').length : counts.byStatus.merged;
  const parkedHidden = PARKED.filter(p => (p.id === 'blocked' ? !showBlocked : !showCancelled));
  const hasFilterBar = view === 'board' || view === 'review';

  return (
    <RefContext.Provider value={ref}>
    <BoardConnectionContext.Provider value={connCtx}>
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-aico-bg motion-reduce:[&_*]:!animate-none motion-reduce:[&_*]:!transition-none">
      <Header
        board={board} projectName={projectName} projectPath={projectPath} projects={projects} onProjectChange={onProjectChange}
        pausing={pausing} onToggle={() => void toggleDispatcher()}
        onNew={() => setDialog('new')} onPlan={() => setDialog('plan')}
        needs={waiting.length} needsOn={onlyNeeds} onNeeds={toggleNeeds}
        connectionBar={board ? (
          <BoardConnectionBar
            project={projectPath} projectName={projectName} connection={board.connection}
            // Without a connection the toolbar carries the "Import from ..." entry; keep one link, not two.
            onOpenConnections={board.connection ? host.openConnections : undefined} onInfo={setInfo} onError={setNotice}
          />
        ) : null}
      />

      {board && status && (
        <StatusBanner status={status} onFix={() => void unblock()} fixing={fixing} onResume={() => setDialog('start')} resuming={false} />
      )}

      {scrum && board && (tasks.length > 0 || sprints.length > 0) && (
        <ScrumHeader
          sprint={currentSprint} tasks={tasks} now={now} offsetMin={offsetMin} source={board.connection?.label}
          onPlan={() => setDialog('sprint')} onStart={() => setSprintAction('start')} onClose={() => setSprintAction('close')} onRefine={() => void refine()}
        />
      )}

      {board && tasks.length > 0 && status && (
        <AgentsStrip
          status={status} short={bannerVisible(status)} agents={agents} onOpenTask={openId} onOpenChat={openChatOf} sessionFor={id => { const t = byId.get(id); return t ? sessionOf(t) : undefined; }}
        />
      )}
      {board && tasks.length > 0 && metricsOpen && <MetricsStrip metrics={board.metrics} budget={board.settings.budgetUsdPerDay} />}

      {board && tasks.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-1 pt-2.5 sm:px-6">
          <Tabs
            label="Delivery views" prefix={TABS_PREFIX} value={view} onChange={switchView}
            items={[
              { id: 'board', label: scrum ? 'Sprint' : 'Board' },
              ...(scrum ? [{ id: 'backlog' as const, label: 'Backlog', badge: (board.proposals?.length ?? 0) || undefined, badgeTone: 'accent' as const }] : []),
              { id: 'review', label: 'Review queue', badge: reviewList.length || undefined, badgeTone: 'accent' },
              ...(scrum ? [{ id: 'reports' as const, label: 'Reports' }, { id: 'ceremonies' as const, label: 'Review & retro' }] : []),
              { id: 'releases', label: 'Releases', badge: board.releases.length || undefined },
            ]}
          />
          {view === 'board' && (
            <Segmented
              label="Layout" value={layout} onChange={changeLayout}
              items={[{ id: 'board', label: 'Board', icon: 'board', hint: 'Columns of cards  (V)' }, { id: 'list', label: 'List', icon: 'table', hint: 'A sortable table  (V)' }]}
            />
          )}
          <span className="flex-1" />
          {!board.connection && host.openConnections && (
            <button type="button" onClick={host.openConnections} className={`${BTN_GHOST} !py-1 !text-[12.5px] max-sm:hidden`} title="Bring work items in from Azure DevOps, GitHub or GitLab, and open pull requests there. Teams that need more than this board connect one.">
              <DvIcon name="link" size={13} />
              <span className="hidden 2xl:inline">Import from Azure DevOps / GitHub / GitLab…</span><span className="2xl:hidden">Import…</span>
            </button>
          )}
          <ModeSwitch mode={mode} busy={modeBusy} onChange={m => void changeMode(m)} />
          <ToolToggle on={metricsOpen} icon="gauge" label="Metrics" onClick={() => setMetricsOpen(o => { setPref('aico.delivery.metrics', o ? 'closed' : 'open'); return !o; })} />
          <ToolToggle on={activityOpen} icon="activity" label="Activity" hint="A" onClick={() => setActivityOpen(o => { setPref('aico.delivery.activity', o ? 'closed' : 'open'); return !o; })} />
          <button type="button" onClick={() => setDialog('keys')} aria-label="Keyboard shortcuts" title="Keyboard shortcuts  (?)" className="rounded-md p-1.5 text-aico-muted hover:bg-aico-hover hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent max-sm:hidden">
            <DvIcon name="keyboard" size={16} />
          </button>
        </div>
      )}

      {board && tasks.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-aico-border-subtle px-4 pb-2.5 pt-1.5 sm:px-6">
          {hasFilterBar && (
            <FilterBar
              query={query} onQuery={setQuery} searchRef={searchRef} assignees={assignees} labels={labels} views={board.settings.views} project={projectPath}
              showStatus={layout === 'list' && view === 'board'} onNotice={setNotice}
            />
          )}
          <span className="flex-1" />
          {view === 'board' && layout === 'board' && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
              <ViewOptions
                laneBy={laneBy} onLaneBy={l => { setLaneBy(l); setPref('aico.delivery.lanes', l); }}
                density={density} onDensity={d => { setDensity(d); setPref('aico.delivery.density', d); }}
              />
              <FilterChip on={showBlocked} onClick={() => setShowBlocked(v => !v)} count={counts.byStatus.blocked}>Blocked</FilterChip>
              <FilterChip on={showCancelled} onClick={() => setShowCancelled(v => !v)} count={counts.byStatus.cancelled}>Cancelled</FilterChip>
            </div>
          )}
        </div>
      )}

      {notice && (
        <div className="shrink-0 px-4 pt-3 sm:px-6">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1"><ErrorLine>{notice}</ErrorLine></div>
            <button type="button" className={BTN_GHOST} onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        </div>
      )}
      {info && (
        <div className="shrink-0 px-4 pt-3 sm:px-6">
          <Callout tone="success" role="status" onDismiss={() => setInfo(null)}>{info}</Callout>
        </div>
      )}
      {board && error && (
        <p role="status" className="shrink-0 px-4 pt-2 text-[12px] text-aico-warning sm:px-6">Live updates are paused ({error}). Retrying.</p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {!board && !error && loading && <BoardSkeleton />}
          {!board && error && (
            <div className="mx-auto mt-10 max-w-md space-y-3 px-6">
              <ErrorLine>Could not load the board: {error}</ErrorLine>
              <button type="button" className={BTN_OUTLINE} onClick={() => void refreshBoard()}><DvIcon name="refresh" size={14} />Try again</button>
            </div>
          )}
          {board && tasks.length === 0 && <EmptyBoard onPlan={() => setDialog('plan')} onNew={() => setDialog('new')} onConnections={board.connection ? undefined : host.openConnections} />}

          {board && tasks.length > 0 && view === 'board' && (
            <div role="tabpanel" id={panelId(TABS_PREFIX)} aria-labelledby={tabId(TABS_PREFIX, 'board')} className="flex min-h-0 flex-1 flex-col">
              {layout === 'board' ? (
                <>
                  <BoardCanvas
                    columns={visibleColumns} groups={laneGroups} lanes={laneBy !== 'none'} collapsed={collapsed} onToggleCollapse={toggleCollapse}
                    dragged={dragged} ctx={columnCtx} onDrop={(t, to, before) => void move(t, to, before)}
                    quickAdd={quickAdd} onQuickAdd={setQuickAdd} project={projectPath} onCreated={() => setNotice(null)} onError={setNotice}
                    wip={s => (board ? wipLimit(board, s) : undefined)} wipHard={s => s !== 'running' || board?.settings.wip?.running !== undefined} filtered={filtered} allTasks={tasks} mergedCount={mergedCount}
                  />
                  {dragged && parkedHidden.length > 0 && (
                    <div className="grid shrink-0 grid-cols-2 gap-3 border-t border-aico-border-subtle bg-aico-surface px-4 py-3 sm:px-6" aria-hidden="true">
                      {parkedHidden.map(p => <DropZone key={p.id} col={p} dragged={dragged} onDrop={(t, to) => void move(t, to)} />)}
                    </div>
                  )}
                </>
              ) : (
                <ListView
                  tasks={shown.filter(t => !onlyNeeds || t.needs)} all={boardTasks} byId={byId} now={now} selectedId={selectedId} focusedId={focusedId} ticked={ticked}
                  onTick={tick} onTickAll={on => setTicked(on ? new Set(shown.map(t => t.id)) : new Set())} onOpen={open} onOpenTask={openId} project={projectPath}
                  onCreated={() => setNotice(null)} onError={setNotice} onOrder={setListOrder}
                />
              )}
            </div>
          )}

          {board && tasks.length > 0 && view === 'review' && (
            <div role="tabpanel" id={panelId(TABS_PREFIX)} aria-labelledby={tabId(TABS_PREFIX, 'review')} className="flex min-h-0 flex-1 flex-col">
              <ReviewQueue list={reviewList} now={now} selectedId={selectedId} project={projectPath} onOpen={open} onShowBoard={() => switchView('board')} />
            </div>
          )}

          {board && scrum && view === 'backlog' && (
            <div role="tabpanel" id={panelId(TABS_PREFIX)} aria-labelledby={tabId(TABS_PREFIX, 'backlog')} className="flex min-h-0 flex-1 flex-col">
              <BacklogView
                project={projectPath} tasks={tasks} proposals={board.proposals ?? []} sprint={plannedSprintOf(sprints) ?? activeSprintOf(sprints)}
                onOpenTask={setSelectedId} onPlan={() => setDialog('sprint')} onAdd={setAddTask} onRefine={() => void refine()} refining={refining} onHandled={setInfo}
              />
            </div>
          )}

          {board && scrum && view === 'reports' && (
            <div role="tabpanel" id={panelId(TABS_PREFIX)} aria-labelledby={tabId(TABS_PREFIX, 'reports')} className="flex min-h-0 flex-1 flex-col">
              <ReportsView tasks={tasks} sprints={sprints} now={now} offsetMin={offsetMin} onOpenTask={setSelectedId} />
            </div>
          )}

          {board && scrum && view === 'ceremonies' && (
            <div role="tabpanel" id={panelId(TABS_PREFIX)} aria-labelledby={tabId(TABS_PREFIX, 'ceremonies')} className="flex min-h-0 flex-1 flex-col">
              <CeremoniesView project={projectPath} sprints={sprints} onSaved={setInfo} />
            </div>
          )}

          {board && tasks.length > 0 && view === 'releases' && (
            <div role="tabpanel" id={panelId(TABS_PREFIX)} aria-labelledby={tabId(TABS_PREFIX, 'releases')} className="flex min-h-0 flex-1 flex-col">
              <ReleasesView
                project={projectPath} releases={board.releases} tasks={tasks}
                onOpenTask={setSelectedId} onShowBoard={() => switchView('board')} onShowReview={() => switchView('review')}
              />
            </div>
          )}

          {ticked.size > 0 && board && (
            <BulkBar
              ids={[...ticked]} tasks={tasks} project={projectPath} assignees={assignees} onClear={() => setTicked(new Set())}
              onDone={m => { setInfo(m); setTicked(new Set()); }} onError={setNotice}
            />
          )}

          {selected && board && (
            <TaskDrawer
              key={selected.id}
              task={selected} tasks={tasks} project={projectPath} host={host} now={now}
              runStartedAt={runs.get(selected.id)?.startedAt}
              onClose={() => setSelectedId(null)} onOpenTask={setSelectedId} onLanded={afterDecision} onHandled={setInfo}
            />
          )}
        </div>

        {board && activityOpen && (
          <ActivityPanel
            feed={feed} titleOf={id => byId.get(id)?.title} now={now} onOpenTask={openId} onClose={() => { setActivityOpen(false); setPref('aico.delivery.activity', 'closed'); }}
            className="max-md:fixed max-md:inset-0 max-md:z-[60] md:w-[320px] md:shrink-0"
          />
        )}
      </div>

      {dialog === 'new' && <NewTaskDialog project={projectPath} tasks={tasks} onClose={() => setDialog(null)} onCreated={t => { setNotice(null); void refreshBoard(); setSelectedId(t.id); }} />}
      {dialog === 'plan' && <PlanDialog project={projectPath} host={host} onClose={() => setDialog(null)} />}
      {dialog === 'keys' && <ShortcutsHelp onClose={() => setDialog(null)} />}
      {dialog === 'sprint' && board && <PlanSprintDialog project={projectPath} tasks={tasks} sprints={sprints} now={now} offsetMin={offsetMin} onClose={() => setDialog(null)} onDone={setInfo} />}
      {sprintAction && currentSprint && <SprintActionDialog project={projectPath} sprint={currentSprint} kind={sprintAction} tasks={tasks} onClose={() => setSprintAction(null)} onDone={setInfo} />}
      {addTask && (plannedSprintOf(sprints) ?? activeSprintOf(sprints)) && <AddToSprintDialog project={projectPath} sprint={(plannedSprintOf(sprints) ?? activeSprintOf(sprints))!} task={addTask} onClose={() => setAddTask(null)} onDone={setInfo} />}
      {dialog === 'start' && board && <StartDispatcherDialog project={projectPath} initial={board.settings.maxParallel} readyCount={counts.byStatus.ready} onClose={() => setDialog(null)} />}
    </div>
    </BoardConnectionContext.Provider>
    </RefContext.Provider>
  );
}

// ── header ────────────────────────────────────────────────────────────

function Header({ board, projectName, projectPath, projects, onProjectChange, pausing, onToggle, onNew, onPlan, needs, needsOn, onNeeds, connectionBar }: {
  board: ReturnType<typeof useDelivery.getState>['board'];
  projectName: string; projectPath: string;
  projects: DeliveryViewProps['projects']; onProjectChange: DeliveryViewProps['onProjectChange'];
  pausing: boolean; onToggle: () => void; onNew: () => void; onPlan: () => void;
  needs: number; needsOn: boolean; onNeeds: () => void;
  /** The project's connection line (components/connections): sync state, Sync now, Connections, or the one-line suggestion. */
  connectionBar?: React.ReactNode;
}): React.ReactElement {
  const state = board?.dispatcher ?? 'idle';
  return (
    <header className="shrink-0 px-4 pb-2 pt-3 sm:px-6 sm:pt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          {/* The page already carries "Delivery" in its top bar on a phone; the heading is for wider screens. */}
          <h1 className="sr-only text-[20px] font-semibold tracking-tight text-aico-primary sm:not-sr-only sm:block">Delivery</h1>
          <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-aico-muted">
            {projects && projects.length > 1 && onProjectChange ? (
              <select aria-label="Project" value={projectPath} onChange={e => onProjectChange(e.target.value)} className="max-w-[220px] truncate rounded-md border border-aico-border bg-aico-bg px-1.5 py-0.5 text-[12.5px] text-aico-primary">
                {projects.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}
              </select>
            ) : <span className="truncate text-aico-secondary" title={projectPath}>{projectName}</span>}
            {board && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-aico-hover px-1.5 py-px font-mono text-[11.5px] text-aico-secondary" title="Approved work lands on this branch">
                <DvIcon name="branch" size={12} />{board.settings.trunk}
              </span>
            )}
          </div>
        </div>
        <span className="flex-1" />
        {board && needs > 0 && (
          <button
            type="button" aria-pressed={needsOn} onClick={onNeeds}
            title={needsOn ? 'Show every task again' : 'Show only the tasks waiting on you'}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium text-aico-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aico-accent ${tint('warning')} ${needsOn ? 'border-aico-warning' : edge('warning')} hover:border-aico-warning`}
          >
            <DvIcon name="help" size={14} className="text-aico-warning" />
            <span className="tabular-nums">{needsChipLabel(needs)}</span>
            {needsOn && <span className="font-normal text-aico-secondary">· showing only these</span>}
          </button>
        )}
        {board && <AutonomyChip board={board} project={projectPath} />}
        {board && (
          <button type="button" className={BTN_OUTLINE} disabled={pausing} onClick={onToggle}>
            <DvIcon name={state === 'running' ? 'pause' : 'play'} size={13} />
            {state === 'running' ? (pausing ? 'Pausing…' : 'Pause') : state === 'paused' ? 'Resume' : 'Start'}<span className="max-sm:hidden"> agents</span>
          </button>
        )}
        <button type="button" className={BTN_OUTLINE} onClick={onPlan} title="Describe the work and let a planner split it into tasks"><DvIcon name="sparkles" size={14} /><span className="max-sm:sr-only">Plan</span><span className="max-lg:hidden"> from a brief</span></button>
        <button type="button" className={BTN_PRIMARY} onClick={onNew}><DvIcon name="plus" size={14} />New<span className="max-sm:hidden"> task</span></button>
      </div>
      {connectionBar}
    </header>
  );
}

function FilterChip({ on, onClick, count, children }: { on: boolean; onClick: () => void; count: number; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button" aria-pressed={on} onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent ${on ? 'border-aico-accent bg-aico-accent-soft text-aico-primary' : 'border-aico-border text-aico-secondary hover:bg-aico-hover'}`}
    >
      {children}<span className="tabular-nums text-aico-muted">{count}</span>
    </button>
  );
}

function ToolToggle({ on, icon, label, hint, onClick }: { on: boolean; icon: 'gauge' | 'activity'; label: string; hint?: string; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button" aria-pressed={on} onClick={onClick} title={`${on ? 'Hide' : 'Show'} ${label.toLowerCase()}${hint ? `  (${hint})` : ''}`}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent ${on ? 'bg-aico-accent-soft text-aico-primary' : 'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary'}`}
    >
      <DvIcon name={icon} size={14} />{label}
    </button>
  );
}

function DropZone({ col, dragged, onDrop }: { col: ColumnDef; dragged: Task; onDrop: (t: Task, to: TaskStatus) => void }): React.ReactElement {
  const [over, setOver] = useState(false);
  const v = checkMove(dragged, col.id);
  return (
    <div
      onDragOver={e => { if (v.ok) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); if (v.ok) onDrop(dragged, col.id); }}
      title={v.ok ? col.hint : v.reason}
      className={`rounded-lg border border-dashed px-3 py-2.5 text-center text-[12.5px] transition-colors ${over ? 'border-aico-accent bg-aico-accent-soft text-aico-primary' : v.ok ? 'border-aico-border text-aico-secondary' : 'border-aico-border-subtle text-aico-muted opacity-50'}`}
    >
      Drop here to mark {col.label.toLowerCase()}
    </div>
  );
}

// ── empty and loading ─────────────────────────────────────────────────

function EmptyBoard({ onPlan, onNew, onConnections }: { onPlan: () => void; onNew: () => void; onConnections?: (() => void) | undefined }): React.ReactElement {
  const steps = [
    ['Describe the work', 'Write a brief and let a planner split it into small tasks, or add tasks yourself with acceptance criteria.'],
    ['Start the agents', 'Move tasks to Ready and start the agents. Each works in its own branch, up to four at once. Tasks that depend on others wait for them.'],
    ['Review and land', 'Finished work arrives with a risk rating, a diff and an evidence report. You approve it onto the trunk or send it back. Turn on autonomy to let low-risk work land by itself.'],
  ] as const;
  return (
    <div className="mx-auto mt-10 w-full max-w-3xl px-6">
      <h2 className="text-[22px] font-semibold tracking-tight text-aico-primary">Nothing on the board yet</h2>
      <p className="mt-1.5 max-w-xl text-[14px] leading-relaxed text-aico-secondary">Delivery is where agents take tasks in parallel and you decide what lands. It starts with a list of tasks.</p>
      <ol className="mt-6 grid gap-3 sm:grid-cols-3">
        {steps.map(([t, d], i) => (
          <li key={t} className="rounded-xl border border-aico-border-subtle bg-aico-surface p-4">
            <span className="text-[12px] font-medium tabular-nums text-aico-muted">{i + 1}</span>
            <p className="mt-1 text-[14px] font-medium text-aico-primary">{t}</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-aico-secondary">{d}</p>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex flex-wrap gap-2">
        <button type="button" className={BTN_PRIMARY} onClick={onPlan}><DvIcon name="sparkles" size={14} />Plan from a brief</button>
        <button type="button" className={BTN_OUTLINE} onClick={onNew}><DvIcon name="plus" size={14} />New task</button>
        {onConnections && <button type="button" className={BTN_GHOST} onClick={onConnections}><DvIcon name="link" size={14} />Import from Azure DevOps / GitHub / GitLab…</button>}
      </div>
      <p className="mt-4 max-w-xl text-[12.5px] leading-relaxed text-aico-muted">Already track work somewhere else? Connect it and this board stays in step with it: you do not need a second board.</p>
    </div>
  );
}

function BoardSkeleton(): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-hidden px-4 py-4 sm:px-6" aria-busy="true" aria-label="Loading the board">
      {[3, 2, 1, 2, 1].map((n, i) => (
        <div key={i} className="hidden w-[248px] shrink-0 flex-col gap-2 rounded-xl border border-aico-border-subtle bg-aico-surface p-2.5 first:flex sm:flex md:min-w-[216px] md:flex-1">
          <Skeleton className="h-4 w-20" />
          {Array.from({ length: n }, (_, j) => <Skeleton key={j} className="h-[84px]" />)}
        </div>
      ))}
    </div>
  );
}
