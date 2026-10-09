/**
 * Delivery: a work board where agents take tasks in parallel and a person
 * reviews and lands their work. One component used by the web portal and the
 * desktop app; each supplies a `host` for the few things only it can do
 * (open an agent's session, open the Code map).
 *
 * Direction — purpose: someone who has handed work to several agents and now
 * needs to see, at a glance, what is moving and what is waiting on them.
 * Tone: calm and exact. Signature: the Review column carries a risk spine on
 * each card (red / amber / green) and the Review queue sorts riskiest first,
 * so the eye lands on what most needs a person. Everything else is the
 * portal's own neutral palette; status colour appears only with a word.
 *
 * Decisions that shape the code:
 *  - People move cards only among Backlog / Ready / Blocked / Cancelled;
 *    agents own Running and landing is "Approve and land" in the drawer, never
 *    a drag (delivery-model `checkMove`, which also supplies the tooltips).
 *  - Blocked and Cancelled are filters (chips) that add a column, not columns
 *    that are always there; Merged is a collapsible rail, which keeps the five
 *    working columns on screen at 1440 px without sideways scrolling.
 *  - Live updates come from `delivery/board` frames with a 3 s poll behind them
 *    (web/delivery.ts); this file only reads the store.
 *  - The drawer overlays the board's right edge rather than squeezing it, so a
 *    diff gets real width and the board stays where it was.
 *  - Three views share the header: the Board, the Review queue (with batch
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
import { followDelivery, optimisticStatus, refreshBoard, setBoard, upsertTask, useDelivery } from '../../delivery';
import type { Task, TaskStatus } from '../../delivery-types';
import {
  COLUMNS, PARKED, STATUS_LABEL, checkMove, countTasks, formatUsd, groupTasks, labelsOf, makeRef, needingYou, needsChipLabel, sortForReview, unmetDeps,
  withoutAnswered, type ColumnDef,
} from '../../delivery-model';
import { BoardConnectionBar } from '../connections/BoardConnectionBar';
import { BoardConnectionContext } from '../connections/context';
import { activeSprintOf, currentSprintOf, modeOf, plannedSprintOf, skippedBySprint, sprintsOf, type Mode } from '../../delivery-scrum';
import { NewTaskDialog, PlanDialog, StartDispatcherDialog } from './Dialogs';
import { ModeSwitch } from './scrum/bits';
import { BacklogView } from './scrum/BacklogView';
import { CeremoniesView } from './scrum/CeremoniesView';
import { AddToSprintDialog, PlanSprintDialog, SprintActionDialog } from './scrum/PlanSprintDialog';
import { ReportsView } from './scrum/ReportsView';
import { ScrumHeader } from './scrum/ScrumHeader';
import { DvIcon } from './icons';
import { ReleasesView } from './ReleasesView';
import { ReviewQueue } from './ReviewQueue';
import { TaskCard, type CardContext } from './TaskCard';
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

export function DeliveryView({ projectPath, projectName, host, projects, onProjectChange }: DeliveryViewProps): React.ReactElement {
  const board = useDelivery(s => s.board);
  const loading = useDelivery(s => s.loading);
  const error = useDelivery(s => s.error);
  const answered = useDelivery(s => s.answered);

  useEffect(() => followDelivery(projectPath), [projectPath]);

  const [view, setView] = useState<View>(() => pref('aico.delivery.view', 'board', VIEWS));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [label, setLabel] = useState('');
  const [showBlocked, setShowBlocked] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [mergedOpen, setMergedOpen] = useState(() => pref('aico.delivery.merged', 'closed', ['open', 'closed']) === 'open');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'plan' | 'start' | 'sprint' | null>(null);
  const [sprintAction, setSprintAction] = useState<'start' | 'close' | null>(null);
  const [addTask, setAddTask] = useState<Task | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [refining, setRefining] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [onlyNeeds, setOnlyNeeds] = useState(false);
  const [pausing, setPausing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Reset the per-project bits when the project changes.
  useEffect(() => { setSelectedId(null); setQuery(''); setLabel(''); setNotice(null); setInfo(null); setOnlyNeeds(false); }, [projectPath]);

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
  const groups = useMemo(() => groupTasks(boardTasks, board?.queue ?? [], { query, label, ref, onlyNeeds }), [boardTasks, board?.queue, query, label, ref, onlyNeeds]);
  const counts = useMemo(() => countTasks(tasks), [tasks]);
  const labels = useMemo(() => labelsOf(tasks), [tasks]);
  const reviewList = useMemo(() => sortForReview(tasks), [tasks]);
  const runs = useMemo(() => new Map((board?.running ?? []).map(r => [r.taskId, r])), [board?.running]);
  const totalCost = useMemo(() => tasks.reduce((n, t) => n + (t.costUsd ?? 0), 0), [tasks]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;

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

  // Keys: n = new task, / = search. Ignored while typing or when a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || dialog) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.key === 'n') { e.preventDefault(); setDialog('new'); }
      else if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  // A drop that moves a card re-parents its element, so the source never sees `dragend`; the window does.
  useEffect(() => {
    const end = (): void => setDragId(null);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => { window.removeEventListener('dragend', end); window.removeEventListener('drop', end); };
  }, []);

  const switchView = (v: View): void => { setView(v); setPref('aico.delivery.view', v); };
  const toggleNeeds = (): void => {
    if (view !== 'board') switchView('board');
    setOnlyNeeds(v => (view !== 'board' ? true : !v));
  };

  const move = useCallback(async (task: Task, to: TaskStatus): Promise<void> => {
    const c = checkMove(task, to);
    if (!c.ok) { setNotice(c.reason); return; }
    setNotice(null);
    const undo = optimisticStatus(task.id, to);
    try { upsertTask(await api.deliveryUpdate(task.id, projectPath, { status: to })); }
    catch (e) { undo(); setNotice(`Could not move ${ref(task.id)} to ${STATUS_LABEL[to]}: ${(e as Error).message}`); }
  }, [projectPath, ref]);

  const open = useCallback((t: Task) => setSelectedId(t.id), []);
  const dragStart = useCallback((t: Task) => setDragId(t.id), []);
  const dragEnd = useCallback(() => setDragId(null), []);
  const dragged = dragId ? byId.get(dragId) ?? null : null;

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

  const columnCtx = (t: Task): CardContext => ({
    now, unmet: unmetDeps(t, byId), run: runs.get(t.id), selected: t.id === selectedId,
    onOpen: open, onMove: (task, to) => void move(task, to), onOpenSession: host.openSession, onHandled: setInfo, onDragStart: dragStart, onDragEnd: dragEnd,
    ...(scrum ? {
      scrum: {
        skipped: skippedBySprint(t, sprints),
        onEstimate: (task: Task, points: number | null) => { void api.deliveryEstimate(task.id, projectPath, points).then(upsertTask).catch((e: Error) => setNotice(`Could not set the estimate: ${e.message}`)); },
      },
    } : {}),
  });

  // "PR open" is a column only for a project that lands through pull requests (or still has one open).
  const showPr = board?.connection?.landing === 'pr' || counts.byStatus.pr > 0;
  const connCtx = useMemo(() => ({ connection: board?.connection, trunk: board?.settings.trunk ?? 'main' }), [board?.connection, board?.settings.trunk]);

  // In Scrum the rail counts what this sprint landed, as the column does, not every task the board ever merged.
  const mergedCount = scrum ? boardTasks.filter(t => t.status === 'merged').length : counts.byStatus.merged;

  const visibleColumns: ColumnDef[] = [
    ...COLUMNS.filter(c => c.id !== 'merged' && (c.id !== 'pr' || showPr)).map(c => (scrum && c.id === 'backlog' ? { ...c, label: 'Sprint backlog', hint: 'Committed to the sprint; Ready once it starts' } : c)),
    ...(mergedOpen ? COLUMNS.filter(c => c.id === 'merged') : []),
    ...(showBlocked ? PARKED.filter(c => c.id === 'blocked') : []),
    ...(showCancelled ? PARKED.filter(c => c.id === 'cancelled') : []),
  ];

  return (
    <RefContext.Provider value={ref}>
    <BoardConnectionContext.Provider value={connCtx}>
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-aico-bg motion-reduce:[&_*]:!animate-none motion-reduce:[&_*]:!transition-none">
      <Header
        board={board} projectName={projectName} projectPath={projectPath} projects={projects} onProjectChange={onProjectChange}
        pausing={pausing} onToggle={() => void toggleDispatcher()}
        onNew={() => setDialog('new')} onPlan={() => setDialog('plan')}
        needs={waiting.length} needsOn={onlyNeeds} onNeeds={toggleNeeds}
        mode={mode} modeBusy={modeBusy} onMode={m => void changeMode(m)}
        connectionBar={board ? (
          <BoardConnectionBar
            project={projectPath} projectName={projectName} connection={board.connection}
            onOpenConnections={host.openConnections} onInfo={setInfo} onError={setNotice}
          />
        ) : null}
      />

      {scrum && board && (tasks.length > 0 || sprints.length > 0) && (
        <ScrumHeader
          sprint={currentSprint} tasks={tasks} now={now} offsetMin={offsetMin} source={board.connection?.label}
          onPlan={() => setDialog('sprint')} onStart={() => setSprintAction('start')} onClose={() => setSprintAction('close')} onRefine={() => void refine()}
        />
      )}

      {board && tasks.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-aico-border-subtle px-4 py-2 sm:px-6">
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
          {(view === 'board' || view === 'review') && (
            <>
              <input
                ref={searchRef} type="search" value={query} onChange={e => setQuery(e.target.value)} aria-label="Filter tasks" placeholder="Filter tasks  /"
                className={`${INPUT} !w-44 !py-1.5 !text-[12.5px]`}
              />
              {labels.length > 0 && (
                <select aria-label="Filter by label" value={label} onChange={e => setLabel(e.target.value)} className={`${INPUT} !w-auto !py-1.5 !text-[12.5px]`}>
                  <option value="">All labels</option>
                  {labels.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              )}
            </>
          )}
          <span className="flex-1" />
          {view === 'board' && (
            <>
              <FilterChip on={showBlocked} onClick={() => setShowBlocked(v => !v)} count={counts.byStatus.blocked}>Blocked</FilterChip>
              <FilterChip on={showCancelled} onClick={() => setShowCancelled(v => !v)} count={counts.byStatus.cancelled}>Cancelled</FilterChip>
            </>
          )}
          <span className="hidden text-[12px] tabular-nums text-aico-muted md:inline" title="Spent across all tasks on this board">{formatUsd(totalCost)} spent</span>
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

      <div className="relative flex min-h-0 flex-1 flex-col">
        {!board && !error && loading && <BoardSkeleton />}
        {!board && error && (
          <div className="mx-auto mt-10 max-w-md space-y-3 px-6">
            <ErrorLine>Could not load the board: {error}</ErrorLine>
            <button type="button" className={BTN_OUTLINE} onClick={() => void refreshBoard()}><DvIcon name="refresh" size={14} />Try again</button>
          </div>
        )}
        {board && tasks.length === 0 && <EmptyBoard onPlan={() => setDialog('plan')} onNew={() => setDialog('new')} />}

        {board && tasks.length > 0 && view === 'board' && (
          <div role="tabpanel" id={panelId(TABS_PREFIX)} aria-labelledby={tabId(TABS_PREFIX, 'board')} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-x-auto px-4 py-4 sm:px-6" tabIndex={-1}>
              <div className="flex h-full min-w-min snap-x snap-mandatory gap-3 md:snap-none">
                {visibleColumns.map(col => (
                  <Column
                    key={col.id} col={col} tasks={groups[col.id]} dragged={dragged}
                    running={col.id === 'running' ? { n: board.running.length, max: board.settings.maxParallel } : undefined}
                    ctx={columnCtx} onDrop={(t, to) => void move(t, to)} onAdd={col.id === 'backlog' ? () => setDialog('new') : undefined}
                    onCollapse={col.id === 'merged' ? () => { setMergedOpen(false); setPref('aico.delivery.merged', 'closed'); } : undefined}
                    filtered={Boolean(query || label || onlyNeeds)}
                  />
                ))}
                {!mergedOpen && (
                  <button
                    type="button" onClick={() => { setMergedOpen(true); setPref('aico.delivery.merged', 'open'); }}
                    aria-label={`Show Merged, ${mergedCount} tasks`}
                    className="flex w-10 shrink-0 flex-col items-center gap-2 rounded-xl border border-dashed border-aico-border py-3 text-aico-muted transition-colors hover:bg-aico-hover hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
                  >
                    <span className="rounded-full bg-aico-hover px-1.5 text-[11px] tabular-nums">{mergedCount}</span>
                    <span className="text-[12px] font-medium [writing-mode:vertical-rl]">Merged</span>
                  </button>
                )}
              </div>
            </div>
            {dragged && (
              <div className="grid shrink-0 grid-cols-2 gap-3 border-t border-aico-border-subtle bg-aico-surface px-4 py-3 sm:px-6" aria-hidden="true">
                {PARKED.map(p => (
                  <DropZone key={p.id} col={p} dragged={dragged} onDrop={(t, to) => void move(t, to)} />
                ))}
              </div>
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

        {selected && board && (
          <TaskDrawer
            key={selected.id}
            task={selected} tasks={tasks} project={projectPath} host={host} now={now}
            runStartedAt={runs.get(selected.id)?.startedAt}
            onClose={() => setSelectedId(null)} onOpenTask={setSelectedId} onLanded={afterDecision} onHandled={setInfo}
          />
        )}
      </div>

      {dialog === 'new' && <NewTaskDialog project={projectPath} tasks={tasks} onClose={() => setDialog(null)} onCreated={t => { setNotice(null); void refreshBoard(); setSelectedId(t.id); }} />}
      {dialog === 'plan' && <PlanDialog project={projectPath} host={host} onClose={() => setDialog(null)} />}
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

function Header({ board, projectName, projectPath, projects, onProjectChange, pausing, onToggle, onNew, onPlan, needs, needsOn, onNeeds, connectionBar, mode, modeBusy, onMode }: {
  board: ReturnType<typeof useDelivery.getState>['board'];
  projectName: string; projectPath: string;
  projects: DeliveryViewProps['projects']; onProjectChange: DeliveryViewProps['onProjectChange'];
  pausing: boolean; onToggle: () => void; onNew: () => void; onPlan: () => void;
  needs: number; needsOn: boolean; onNeeds: () => void;
  /** The project's connection line (components/connections): sync state, Sync now, Connections, or the one-line suggestion. */
  connectionBar?: React.ReactNode;
  mode: Mode; modeBusy: boolean; onMode: (m: Mode) => void;
}): React.ReactElement {
  const state = board?.dispatcher ?? 'idle';
  const running = board?.running.length ?? 0;
  const max = board?.settings.maxParallel ?? 0;
  return (
    <header className="shrink-0 border-b border-aico-border-subtle px-4 pb-3 pt-3 sm:px-6 sm:pt-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          {/* The page already carries "Delivery" in its top bar on a phone; the heading is for wider screens. */}
          <h1 className="sr-only text-[20px] font-semibold tracking-tight text-aico-primary sm:not-sr-only sm:block">Delivery</h1>
          <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-aico-muted sm:mt-0.5">
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
        {board && <ModeSwitch mode={mode} busy={modeBusy} onChange={onMode} />}
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
        {board && (
          <div className="flex items-center gap-2 text-[12.5px] text-aico-secondary" role="status" aria-live="polite">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              {state === 'running' && running > 0 && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-aico-success opacity-60 motion-reduce:animate-none" />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${state === 'running' ? 'bg-aico-success' : state === 'paused' ? 'bg-aico-warning' : 'bg-aico-muted'}`} />
            </span>
            {state === 'running' && running === 0
              // On but idle must not look like work: say what the agents are waiting for.
              ? <span title="Nothing is running. Agents pick up tasks in the Ready column; move a task there or plan from a brief.">
                  Agents on · {board.tasks.some(t => t.status === 'ready') ? 'starting…' : 'waiting for Ready tasks'}</span>
              : state === 'running' ? <span>Agents working <span className="tabular-nums">{running}/{max}</span></span>
              : state === 'paused' ? <span>Paused{running ? ` · ${running} finishing` : ''}</span>
              : <span>Agents stopped</span>}
          </div>
        )}
        {board && (
          <button type="button" className={BTN_OUTLINE} disabled={pausing} onClick={onToggle}>
            <DvIcon name={state === 'running' ? 'pause' : 'play'} size={13} />
            {state === 'running' ? (pausing ? 'Pausing…' : 'Pause') : state === 'paused' ? 'Resume agents' : 'Start agents'}
          </button>
        )}
        <button type="button" className={BTN_OUTLINE} onClick={onPlan}><DvIcon name="sparkles" size={14} />Plan from a brief</button>
        <button type="button" className={BTN_PRIMARY} onClick={onNew}><DvIcon name="plus" size={14} />New task</button>
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

// ── columns ───────────────────────────────────────────────────────────

function Column({ col, tasks, dragged, running, ctx, onDrop, onAdd, onCollapse, filtered }: {
  col: ColumnDef; tasks: Task[]; dragged: Task | null; running?: { n: number; max: number } | undefined;
  ctx: (t: Task) => CardContext; onDrop: (t: Task, to: TaskStatus) => void; onAdd?: (() => void) | undefined; onCollapse?: (() => void) | undefined; filtered: boolean;
}): React.ReactElement {
  const [over, setOver] = useState(false);
  const verdict = dragged ? checkMove(dragged, col.id) : null;
  const isOrigin = dragged?.status === col.id;
  const accepts = Boolean(verdict?.ok);
  return (
    <section
      aria-label={`${col.label}, ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}
      onDragOver={e => { if (accepts) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true); } else if (dragged) e.dataTransfer.dropEffect = 'none'; }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={e => { e.preventDefault(); setOver(false); if (dragged && accepts) onDrop(dragged, col.id); }}
      title={dragged && !accepts && !isOrigin && verdict && !verdict.ok ? verdict.reason : undefined}
      className={`flex w-[84vw] min-w-0 shrink-0 snap-start flex-col rounded-xl border transition-colors duration-150 sm:w-[248px] md:w-auto md:min-w-[172px] md:shrink md:grow md:basis-0 ${
        over ? 'border-aico-accent bg-aico-accent-soft'
          : accepts ? 'border-dashed border-aico-accent bg-aico-surface'
          : dragged && !isOrigin ? 'border-aico-border-subtle bg-aico-surface opacity-55'
          : 'border-aico-border-subtle bg-aico-surface'
      } md:max-w-[360px]`}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-aico-secondary" title={col.hint}>{col.label}</h2>
        <span className="rounded-full bg-aico-hover px-1.5 text-[11px] tabular-nums text-aico-secondary">
          {running ? `${running.n}/${running.max}` : tasks.length}
        </span>
        <span className="flex-1" />
        {onCollapse && (
          <button type="button" onClick={onCollapse} aria-label="Hide Merged" title="Hide Merged" className="rounded-md p-0.5 text-aico-muted hover:bg-aico-hover hover:text-aico-primary">
            <DvIcon name="close" size={14} />
          </button>
        )}
        {onAdd && (
          <button type="button" onClick={onAdd} aria-label="New task" title="New task  (n)" className="rounded-md p-0.5 text-aico-muted hover:bg-aico-hover hover:text-aico-primary">
            <DvIcon name="plus" size={15} />
          </button>
        )}
      </div>
      <ul className="flex min-h-[72px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 pt-1">
        {dragged && !accepts && !isOrigin && verdict && !verdict.ok && (
          <li className="rounded-lg border border-dashed border-aico-border px-2.5 py-2 text-[11.5px] leading-snug text-aico-secondary">{verdict.reason}</li>
        )}
        {tasks.map(t => <li key={t.id}><TaskCard task={t} ctx={ctx(t)} /></li>)}
        {tasks.length === 0 && !dragged && (
          <li className="px-2 py-3 text-center text-[12px] leading-snug text-aico-muted">{filtered ? 'No matches.' : EMPTY_COPY[col.id] ?? 'Nothing here.'}</li>
        )}
      </ul>
    </section>
  );
}

const EMPTY_COPY: Partial<Record<TaskStatus, string>> = {
  backlog: 'New tasks start here.',
  ready: 'Move tasks here for agents to pick up.',
  running: 'No agent is working. Start the agents to begin.',
  review: 'Finished work waits here for you.',
  changes: 'Work you sent back appears here.',
  pr: 'Pull requests wait here for the remote’s checks and reviews.',
  merged: 'Nothing has landed yet.',
  blocked: 'Nothing is blocked.',
  cancelled: 'Nothing was cancelled.',
};

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

function EmptyBoard({ onPlan, onNew }: { onPlan: () => void; onNew: () => void }): React.ReactElement {
  const steps = [
    ['Describe the work', 'Write a brief and let a planner split it into small tasks, or add tasks yourself with acceptance criteria.'],
    ['Start the agents', 'Move tasks to Ready and start the dispatcher. Each agent works in its own branch, up to four at once.'],
    ['Review and land', 'Finished work arrives with a risk rating, a diff and an evidence report. You approve it onto the trunk or send it back.'],
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
      </div>
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
