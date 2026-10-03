/**
 * The Tasks panel: what is running beside your chats, what is waiting for
 * you, and what just finished — one list, live, for every client.
 *
 * Modelled on Claude Desktop's "Background tasks" side panel and taken
 * further, because AICO runs more kinds of work beside a chat: sub-agents
 * (nested under whoever delegated them), Investigate fan-outs, background
 * agents, long jobs, scheduled firings, backgrounded shell commands, terminal
 * tabs, browser procedures, watchers, and the asks that block all of them —
 * parked calls, long-job proposals, permission prompts and questions. Each
 * row says what it is doing in words, how long, on which model, at what
 * cost, how far through its list, and offers only the controls the engine
 * has a route for (shared/tasks `actionsFor`).
 *
 * Store-free and prop-driven, like the rest of shared/ui: the host feeds a
 * snapshot (the engine's `tasks/events` topic) and performs the actions, so
 * the desktop panel, the desktop page and the web drawer are one component.
 * The only state kept here is view state — scope, chips, search, what is
 * expanded — and the per-scope "cleared finished" mark, which is a viewer's
 * convenience and lives in localStorage (guarded; it may be unavailable).
 *
 * Not here: deciding whether a yes counts. Approve calls the host, the host
 * calls the existing route, and the decision gate on the server decides
 * whether a person is behind it.
 *
 * @module shared/ui/tasks/TasksPanel
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AicoMark } from '../AicoMark';
import {
  KIND_GROUPS, GROUP_LABEL, KIND_LABEL, STATUS_LABEL,
  actionsFor, applyCleared, buildTaskTree, countByGroup, elapsedOf, filterTasks, formatCost,
  formatElapsed, formatTokens, groupTasks, isLive, summarise,
  type KindGroup, type ScheduleItem, type TaskActionId, type TaskItem, type TaskKind, type TaskRow, type TasksSnapshot,
} from '../../tasks';
import './tasks.css';

// ── icons (inline: this renders in three builds with different icon sets) ──

const P: Record<string, React.ReactNode> = {
  subagent: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3.5 13.5c.6-2.4 2.4-3.6 4.5-3.6s3.9 1.2 4.5 3.6" /></>,
  investigate: <><circle cx="7" cy="7" r="4" /><path d="m10 10 3.5 3.5" /></>,
  background: <><path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2" /><circle cx="8" cy="8" r="3" /></>,
  longjob: <><path d="M3 13.5V3.5" /><path d="M3 4h8.5l-1.6 2.5L11.5 9H3" /></>,
  scheduled: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></>,
  shell: <><rect x="2" y="3" width="12" height="10" rx="1.8" /><path d="m4.8 6.5 2 1.6-2 1.6M8.5 10h2.8" /></>,
  terminal: <><rect x="2" y="3" width="12" height="10" rx="1.8" /><path d="m4.8 6.5 2 1.6-2 1.6M8.5 10h2.8" /></>,
  procedure: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5" /></>,
  watcher: <><path d="M1.8 8S4 4 8 4s6.2 4 6.2 4-2.2 4-6.2 4-6.2-4-6.2-4Z" /><circle cx="8" cy="8" r="1.7" /></>,
  app: <><rect x="2.5" y="2.5" width="11" height="11" rx="2.2" /><path d="M2.5 6h11" /></>,
  run: <path d="M5 3.5v9l7-4.5-7-4.5Z" />,
  inbox: <><path d="M2.5 9.5 4 3.5h8l1.5 6v3h-11v-3Z" /><path d="M2.5 9.5h3l.8 1.5h3.4l.8-1.5h3" /></>,
  permission: <><path d="M8 2 3 4v3.6c0 3 2.2 5.4 5 6.4 2.8-1 5-3.4 5-6.4V4L8 2Z" /><path d="m5.8 8 1.6 1.6 2.9-3" /></>,
  question: <><circle cx="8" cy="8" r="5.5" /><path d="M6.4 6.4a1.7 1.7 0 1 1 2.4 1.6c-.5.2-.8.6-.8 1.1v.3" /><path d="M8 11.3v.1" /></>,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  expand: <><path d="M9.5 2.5h4v4" /><path d="M6.5 13.5h-4v-4" /><path d="M13.5 2.5 9 7" /><path d="M2.5 13.5 7 9" /></>,
  shrink: <><path d="M13 3 9 7m0 0V3.5M9 7h3.5" /><path d="M3 13l4-4m0 0v3.5M7 9H3.5" /></>,
  search: <><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></>,
  chevron: <path d="m6 4 4 4-4 4" />,
  down: <path d="m4 6 4 4 4-4" />,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6.5" /></>,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  play: <path d="M5 3.5v9l7-4.5-7-4.5Z" />,
  retry: <><path d="M3 8a5 5 0 1 0 1.6-3.7" /><path d="M3 2.8v2.8h2.8" /></>,
  doc: <><path d="M4 2.5h5.5L12 5v8.5H4Z" /><path d="M9.5 2.5V5H12M6 8h4M6 10.5h4" /></>,
  chat: <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h.5A1.5 1.5 0 0 1 3 9.5Z" />,
  x: <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />,
  tasks: <><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" /><path d="m5 6 1.2 1.2L8.5 5M5 10.5h6M9.5 7h1.5" /></>,
};

function Svg({ name, size = 14 }: { name: string; size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[name] ?? P.run}</svg>
  );
}

// ── the contract with the host ───────────────────────────────────────────

export interface TasksPanelProps {
  snapshot: TasksSnapshot | null;
  /** Rows only the host knows about (the desktop's terminals and procedures). */
  extraItems?: TaskItem[];
  connection?: 'connecting' | 'live' | 'lost';
  /** The chat on screen, for "This chat". */
  sessionId?: string;
  sessionTitle?: (sessionId: string) => string | undefined;
  /** `panel`: a narrow side column. `page`: the full-width view. `drawer`: the web's overlay. */
  layout?: 'panel' | 'page' | 'drawer';
  onClose?: () => void;
  /** Panel → page (or page → panel, with `expanded`). */
  onExpand?: () => void;
  expanded?: boolean;
  onAction: (action: TaskActionId, item: TaskItem) => Promise<unknown> | void;
  onScheduleAction?: (action: 'pause' | 'resume', schedule: ScheduleItem) => Promise<unknown> | void;
  copyText?: (text: string) => Promise<void> | void;
  /** Focus the list when the panel opens (keyboard shortcut). */
  autoFocus?: boolean;
}

// ── persisted view prefs (a viewer's convenience only) ───────────────────

const PREFS_KEY = 'aico.tasks.view';
interface ViewPrefs { scope?: 'chat' | 'all'; finishedOpen?: boolean; scheduledOpen?: boolean; cleared?: Record<string, number> }

function readPrefs(): ViewPrefs {
  try { return JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? '{}') as ViewPrefs; } catch { return {}; }
}
function writePrefs(next: ViewPrefs): void {
  try { globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* storage unavailable: the view still works */ }
}

const ACTION: Record<TaskActionId, { label: string; icon: string; tone?: 'primary' | 'danger' | 'quiet' }> = {
  approve: { label: 'Approve', icon: 'check', tone: 'primary' },
  deny: { label: 'Deny', icon: 'x', tone: 'danger' },
  review: { label: 'Answer in chat', icon: 'chat', tone: 'primary' },
  stop: { label: 'Stop', icon: 'stop', tone: 'danger' },
  pause: { label: 'Pause', icon: 'pause' },
  resume: { label: 'Resume', icon: 'play' },
  retry: { label: 'Retry', icon: 'retry' },
  transcript: { label: 'View transcript', icon: 'doc', tone: 'quiet' },
  'open-chat': { label: 'Open chat', icon: 'chat', tone: 'quiet' },
  show: { label: 'Show', icon: 'expand', tone: 'quiet' },
  'copy-command': { label: 'Copy command', icon: 'copy', tone: 'quiet' },
};

function kindIcon(kind: TaskKind): string {
  return kind;
}

// ── the panel ────────────────────────────────────────────────────────────

export function TasksPanel(props: TasksPanelProps): React.ReactElement {
  const { snapshot, extraItems, connection, sessionId, sessionTitle, layout = 'panel', onClose, onExpand, expanded, onAction, onScheduleAction } = props;
  const prefs0 = useMemo(readPrefs, []);
  const [scope, setScope] = useState<'chat' | 'all'>(sessionId ? (prefs0.scope ?? 'chat') : 'all');
  const [groups, setGroups] = useState<Set<KindGroup>>(new Set());
  const [query, setQuery] = useState('');
  const [finishedOpen, setFinishedOpen] = useState(prefs0.finishedOpen ?? true);
  const [scheduledOpen, setScheduledOpen] = useState(prefs0.scheduledOpen ?? false);
  const [cleared, setCleared] = useState<Record<string, number>>(prefs0.cleared ?? {});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement | null>(null);

  // No chat on screen: "This chat" means nothing.
  const effectiveScope = sessionId ? scope : 'all';
  useEffect(() => { writePrefs({ scope, finishedOpen, scheduledOpen, cleared }); }, [scope, finishedOpen, scheduledOpen, cleared]);

  const all = useMemo(() => [...(snapshot?.items ?? []), ...(extraItems ?? [])], [snapshot, extraItems]);
  const anyLive = all.some(i => isLive(i.status));
  // A live clock only while something is live: elapsed times tick, nothing else needs to.
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLive]);

  const clearKey = effectiveScope === 'chat' && sessionId ? `chat:${sessionId}` : 'all';
  const scoped = useMemo(() => filterTasks(all, { scope: effectiveScope, ...(sessionId ? { sessionId } : {}) }), [all, effectiveScope, sessionId]);
  const visibleScoped = useMemo(() => applyCleared(scoped, cleared[clearKey]), [scoped, cleared, clearKey]);
  const searched = useMemo(() => filterTasks(visibleScoped, { scope: 'all', query }), [visibleScoped, query]);
  const counts = useMemo(() => countByGroup(searched), [searched]);
  const shown = useMemo(() => filterTasks(searched, { scope: 'all', groups }), [searched, groups]);
  const sections = useMemo(() => groupTasks(shown), [shown]);
  const totals = useMemo(() => summarise(scoped, now), [scoped, now]);

  const waitingRows = useMemo(() => buildTaskTree(sections.waiting, collapsed), [sections.waiting, collapsed]);
  const runningRows = useMemo(() => buildTaskTree(sections.running, collapsed), [sections.running, collapsed]);
  const finishedRows = useMemo(() => buildTaskTree(sections.finished, collapsed), [sections.finished, collapsed]);
  const schedules = snapshot?.schedules ?? [];

  const toggle = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };

  const act = useCallback(async (action: TaskActionId, item: TaskItem): Promise<void> => {
    if (action === 'copy-command' && item.command) { await copy(item.command, `cmd:${item.id}`); return; }
    setBusy(b => new Set(b).add(item.id));
    try { await onAction(action, item); } finally {
      setBusy(b => { const n = new Set(b); n.delete(item.id); return n; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAction]);

  const copy = async (text: string, key: string): Promise<void> => {
    try {
      if (props.copyText) await props.copyText(text);
      else await globalThis.navigator?.clipboard?.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(c => (c === key ? null : c)), 1400);
    } catch { /* clipboard refused: nothing to show */ }
  };

  const clearFinished = (): void => {
    const latest = sections.finished.reduce((m, i) => Math.max(m, i.endedAt ?? i.startedAt), 0);
    setCleared(c => ({ ...c, [clearKey]: Math.max(latest, Date.now()) }));
  };

  // Keyboard: arrows move between rows, Enter/Space expands, Home/End jump, Escape closes.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const target = e.target as HTMLElement;
    if (e.key === 'Escape' && onClose && layout !== 'page') { e.preventDefault(); onClose(); return; }
    if (!target.classList.contains('tk-card')) return;
    const cards = [...(listRef.current?.querySelectorAll<HTMLElement>('.tk-card') ?? [])];
    const at = cards.indexOf(target);
    const go = (i: number): void => { const c = cards[Math.max(0, Math.min(cards.length - 1, i))]; c?.focus(); c?.scrollIntoView({ block: 'nearest' }); };
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(at + 1); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(at - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(cards.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const id = target.dataset.taskId;
      if (id) setOpen(o => toggle(o, id));
    }
  };

  useEffect(() => {
    if (!props.autoFocus) return;
    const first = listRef.current?.querySelector<HTMLElement>('.tk-card') ?? listRef.current?.querySelector<HTMLInputElement>('input');
    first?.focus();
  }, [props.autoFocus]);

  const renderRows = (rows: TaskRow[]): React.ReactNode => rows.map(row => (
    <TaskRowView
      key={row.item.id}
      row={row}
      now={now}
      open={open.has(row.item.id)}
      collapsed={collapsed.has(row.item.id)}
      busy={busy.has(row.item.id)}
      copied={copied}
      showChat={effectiveScope === 'all'}
      {...(sessionId ? { currentSessionId: sessionId } : {})}
      sessionTitle={sessionTitle}
      onToggle={() => setOpen(o => toggle(o, row.item.id))}
      onCollapse={() => setCollapsed(c => toggle(c, row.item.id))}
      onAct={(a) => void act(a, row.item)}
      onCopy={(text, key) => void copy(text, key)}
    />
  ));

  const nothingAtAll = all.length === 0 && schedules.length === 0;
  const nothingHere = !nothingAtAll && sections.waiting.length + sections.running.length + sections.finished.length === 0;
  const anyFilter = query.trim().length > 0 || groups.size > 0;

  return (
    <div className={`tk is-${layout}`} onKeyDown={onKeyDown} role="region" aria-label="Tasks">
      <div className="tk-head"><div className="tk-head-inner">
        <div className="tk-title-row">
          <span className="tk-title">Tasks</span>
          <div className="tk-totals" aria-live="polite">
            {totals.running > 0 && <span className="tk-total is-running"><AicoMark size={11} />{totals.running} running</span>}
            {totals.waiting > 0 && <span className="tk-total is-waiting">{totals.waiting} waiting for you</span>}
            {totals.spentTodayUsd > 0 && <span className="tk-total" title="Spent today on delegated and background work">{formatCost(totals.spentTodayUsd)} today</span>}
          </div>
          {onExpand && (
            <button className="tk-icon-btn" onClick={onExpand} title={expanded ? 'Back to the side panel' : 'Open as a page'} aria-label={expanded ? 'Back to the side panel' : 'Open as a page'}>
              <Svg name={expanded ? 'shrink' : 'expand'} size={13} />
            </button>
          )}
          {onClose && (
            <button className="tk-icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close tasks"><Svg name="close" size={13} /></button>
          )}
        </div>
        <div className="tk-tools">
          {sessionId && (
            <div className="tk-seg" role="group" aria-label="Which chats">
              <button aria-pressed={effectiveScope === 'chat'} onClick={() => setScope('chat')}>This chat</button>
              <button aria-pressed={effectiveScope === 'all'} onClick={() => setScope('all')}>All chats</button>
            </div>
          )}
          <label className="tk-search">
            <Svg name="search" size={12} />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search tasks" aria-label="Search tasks"
              onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }} />
          </label>
        </div>
        <div className="tk-chips" role="group" aria-label="Kinds">
          {KIND_GROUPS.filter(g => counts[g] > 0 || groups.has(g)).map(g => (
            <button key={g} className="tk-chip" aria-pressed={groups.has(g)} onClick={() => setGroups(s => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; })}>
              {GROUP_LABEL[g]} <span className="tk-n">{counts[g]}</span>
            </button>
          ))}
          {groups.size > 0 && <button className="tk-chip" onClick={() => setGroups(new Set())}>Clear</button>}
        </div>
      </div></div>

      <div className="tk-body" ref={listRef}>
        <div className="tk-inner">
          {connection === 'lost' && <div className="tk-banner" role="status">Reconnecting to the engine — the list may be out of date.</div>}
          {!snapshot && connection !== 'lost' && <div className="tk-inline-empty">Loading…</div>}

          {snapshot && nothingAtAll && (
            <Empty title="Nothing running" body="Sub-agents, background agents, long jobs, scheduled runs and background commands appear here while they work — and anything that needs your answer comes to the top." />
          )}
          {snapshot && nothingHere && (
            anyFilter
              ? <Empty title="No matches" body="Nothing matches this search or these filters." />
              : effectiveScope === 'chat'
                ? <Empty title="Nothing in this chat" body="Work this chat starts shows up here. Switch to All chats to see everything else." action={<button className="tk-btn" onClick={() => setScope('all')}>Show all chats</button>} />
                : <Empty title="All clear" body="Nothing is running and nothing is waiting for you." />
          )}

          {sections.waiting.length > 0 && (
            <section className="tk-section is-waiting" aria-label="Waiting for you">
              <div className="tk-section-head">Waiting for you <span className="tk-count">{sections.waiting.length}</span></div>
              <div className="tk-list" role="list">{renderRows(waitingRows)}</div>
            </section>
          )}

          {sections.running.length > 0 && (
            <section className="tk-section" aria-label="Running">
              <div className="tk-section-head">Running <span className="tk-count">{sections.running.length}</span></div>
              <div className="tk-list" role="list">{renderRows(runningRows)}</div>
            </section>
          )}

          {sections.finished.length > 0 && (
            <section className="tk-section" aria-label="Finished">
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button className="tk-section-head" aria-expanded={finishedOpen} onClick={() => setFinishedOpen(o => !o)}>
                  <Svg name={finishedOpen ? 'down' : 'chevron'} size={11} />
                  Finished <span className="tk-count">{sections.finished.length}</span>
                  <span className="tk-spacer" />
                </button>
                <button className="tk-icon-btn" onClick={clearFinished} title="Clear finished" aria-label="Clear finished tasks"><Svg name="trash" size={13} /></button>
              </div>
              {finishedOpen && <div className="tk-list" role="list">{renderRows(finishedRows)}</div>}
            </section>
          )}

          {schedules.length > 0 && effectiveScope === 'all' && !anyFilter && (
            <section className="tk-section" aria-label="Scheduled">
              <button className="tk-section-head" aria-expanded={scheduledOpen} onClick={() => setScheduledOpen(o => !o)}>
                <Svg name={scheduledOpen ? 'down' : 'chevron'} size={11} />
                Scheduled <span className="tk-count">{schedules.length}</span>
              </button>
              {scheduledOpen && schedules.map(s => (
                <div key={s.id} className="tk-sched">
                  <span className="tk-kind"><Svg name="scheduled" size={13} /></span>
                  <div className="tk-sched-main">
                    <div className="tk-sched-name">{s.name}</div>
                    <div className="tk-sched-sub">
                      {s.paused ? 'Paused' : s.nextRun ? `Next ${relative(s.nextRun, now)}` : s.schedule}
                      {` · ${s.schedule} · ${s.runCount} run${s.runCount === 1 ? '' : 's'}`}
                      {s.lastOutcome ? ` · last: ${s.lastOutcome}` : ''}
                    </div>
                  </div>
                  {onScheduleAction && (
                    <button className="tk-btn" onClick={() => void onScheduleAction(s.paused ? 'resume' : 'pause', s)}>
                      <Svg name={s.paused ? 'play' : 'pause'} size={11} />{s.paused ? 'Resume' : 'Pause'}
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }): React.ReactElement {
  return (
    <div className="tk-empty">
      <span className="tk-empty-mark"><Svg name="tasks" size={20} /></span>
      <div className="tk-empty-title">{title}</div>
      <div className="tk-empty-body">{body}</div>
      {action}
    </div>
  );
}

function relative(at: number, now: number): string {
  const d = at - now;
  if (d <= 0) return 'now';
  return `in ${formatElapsed(d)}`;
}

function ago(at: number, now: number): string {
  return `${formatElapsed(Math.max(0, now - at))} ago`;
}

// ── one row ──────────────────────────────────────────────────────────────

interface RowProps {
  row: TaskRow;
  now: number;
  open: boolean;
  collapsed: boolean;
  busy: boolean;
  copied: string | null;
  showChat: boolean;
  currentSessionId?: string;
  sessionTitle?: (sessionId: string) => string | undefined;
  onToggle: () => void;
  onCollapse: () => void;
  onAct: (action: TaskActionId) => void;
  onCopy: (text: string, key: string) => void;
}

const TaskRowView = React.memo(function TaskRowView(p: RowProps): React.ReactElement {
  const { row, now, open } = p;
  const item = row.item;
  const live = isLive(item.status);
  const running = item.status === 'running';
  const you = Boolean(item.needsYou && live);
  const failed = item.status === 'failed';
  // "Open chat" for the chat already on screen goes nowhere.
  const actions = actionsFor(item).filter(a => !(a === 'open-chat' && p.currentSessionId && item.sessionId === p.currentSessionId));
  const elapsed = elapsedOf(item, now);
  const tone = you ? 'is-needs-you' : running ? 'is-running' : failed ? 'is-failed' : !live ? 'is-done' : '';
  const chatTitle = item.sessionId ? p.sessionTitle?.(item.sessionId) : undefined;
  const hasMore = Boolean(item.output || item.detail || item.error || item.outcome || item.command || item.model || item.transcriptId);
  const pct = item.todo && item.todo.total > 0 ? Math.round((item.todo.done / item.todo.total) * 100) : 0;

  const meta: React.ReactNode[] = [];
  if (item.agentName) meta.push(<span key="a">{item.agentName}</span>);
  else meta.push(<span key="k">{KIND_LABEL[item.kind]}</span>);
  if (item.model) meta.push(<span key="m" title={item.model}>{shortModel(item.model)}</span>);
  meta.push(<span key="t" className={live ? 'tk-live' : undefined} title={new Date(item.startedAt).toLocaleString()}>
    {you ? `waiting ${formatElapsed(elapsed)}` : live ? formatElapsed(elapsed) : `${STATUS_LABEL[item.status].toLowerCase()} ${ago(item.endedAt ?? item.startedAt, now)} · took ${formatElapsed(elapsed)}`}
  </span>);
  if (item.tokensIn || item.tokensOut) {
    meta.push(<span key="tok" title={`${(item.tokensIn ?? 0).toLocaleString()} in · ${(item.tokensOut ?? 0).toLocaleString()} out`}>
      {formatTokens((item.tokensIn ?? 0) + (item.tokensOut ?? 0))} tokens
    </span>);
  }
  if (item.costUsd) meta.push(<span key="c">{formatCost(item.costUsd)}</span>);
  if (item.toolUses) meta.push(<span key="u">{item.toolUses} tool use{item.toolUses === 1 ? '' : 's'}</span>);
  if (p.showChat && chatTitle) {
    meta.push(<span key="chat">in <button className="tk-chat-link" onClick={() => p.onAct('open-chat')} title={`Open “${chatTitle}”`}>{chatTitle}</button></span>);
  }
  // Shown only when folded: unfolded, the sub-tasks are right there below it.
  if (row.descendants > 0 && p.collapsed) meta.push(<span key="d">{row.descendants} sub-task{row.descendants === 1 ? '' : 's'} hidden</span>);

  return (
    <div className="tk-row" role="listitem">
      {row.depth > 0 && (
        <div className="tk-guides" aria-hidden="true">
          {row.guides.slice(1).map((ancestorLast, i) => <span key={i} className={`tk-guide${ancestorLast ? '' : ' is-line'}`} />)}
          <span className={`tk-guide is-elbow${row.last ? '' : ' is-through'}`} />
        </div>
      )}
      <div className={`tk-card ${tone}`} tabIndex={0} data-task-id={item.id}
        aria-label={`${item.title} — ${you ? 'waiting for you' : STATUS_LABEL[item.status]}`} aria-expanded={hasMore ? open : undefined}>
        <div className="tk-top">
          <span className="tk-kind" title={KIND_LABEL[item.kind]}><Svg name={kindIcon(item.kind)} size={13} /></span>
          <div className="tk-main">
            <div className="tk-name">
              <span className="tk-name-text" title={item.title}>{item.title}</span>
              {running
                ? <span className="tk-pill s-running"><AicoMark size={11} />Running</span>
                : <span className={`tk-pill s-${item.status}${you ? ' is-you' : ''}`}>{you ? 'Needs you' : STATUS_LABEL[item.status]}</span>}
              {row.descendants > 0 && (
                <button className="tk-expand is-fold" onClick={p.onCollapse} aria-expanded={!p.collapsed}
                  title={p.collapsed ? `Show ${row.descendants} sub-task${row.descendants === 1 ? '' : 's'}` : 'Hide sub-tasks'} aria-label={p.collapsed ? 'Show sub-tasks' : 'Hide sub-tasks'}>
                  <Svg name={p.collapsed ? 'chevron' : 'down'} size={12} />
                </button>
              )}
              {hasMore && (
                <button className="tk-expand" onClick={p.onToggle} aria-expanded={open} title={open ? 'Less' : 'Details'} aria-label={open ? 'Hide details' : 'Show details'}>
                  <Svg name="chevron" size={12} />
                </button>
              )}
            </div>
            <div className="tk-meta">{meta}</div>
          </div>
        </div>

        {item.step && (live || open) && (
          <div className="tk-step">
            {running && <AicoMark size={12} still={false} />}
            <span className="tk-step-text" title={item.step}>{item.step}</span>
          </div>
        )}
        {you && item.detail && !open && <div className="tk-detail-line">{item.detail}</div>}
        {failed && item.error && !open && <div className="tk-error-line">{item.error}</div>}

        {item.todo && item.todo.total > 0 && (
          <div className="tk-todo" aria-label={`${item.todo.done} of ${item.todo.total} done`}>
            <span className="tk-bar" role="progressbar" aria-valuemin={0} aria-valuemax={item.todo.total} aria-valuenow={item.todo.done}><i style={{ width: `${pct}%` }} /></span>
            <span>{item.todo.done}/{item.todo.total}</span>
            {item.todo.current && <span className="tk-todo-current" title={item.todo.current}>· {item.todo.current}</span>}
          </div>
        )}

        {open && (
          <div className="tk-more">
            {item.output && (
              <div>
                <div className="tk-field-label">Output<span className="tk-spacer" />
                  <button className="tk-btn is-quiet" onClick={() => p.onCopy(item.output!, `out:${item.id}`)}><Svg name={p.copied === `out:${item.id}` ? 'check' : 'copy'} size={11} />{p.copied === `out:${item.id}` ? 'Copied' : 'Copy'}</button>
                </div>
                <OutputTail text={item.output} />
              </div>
            )}
            {item.error && <div><div className="tk-field-label">Error</div><pre className="tk-pre is-error">{item.error}</pre></div>}
            {item.outcome && <div><div className="tk-field-label">Result</div><pre className="tk-pre">{item.outcome}</pre></div>}
            {item.detail && <div><div className="tk-field-label">{item.needsYou ? 'What it asks' : 'Brief'}</div><pre className="tk-pre">{item.detail}</pre></div>}
            {item.command && (
              <div>
                <div className="tk-field-label">Command<span className="tk-spacer" />
                  <button className="tk-btn is-quiet" onClick={() => p.onCopy(item.command!, `cmd:${item.id}`)}><Svg name={p.copied === `cmd:${item.id}` ? 'check' : 'copy'} size={11} />{p.copied === `cmd:${item.id}` ? 'Copied' : 'Copy'}</button>
                </div>
                <pre className="tk-pre">{item.command}</pre>
              </div>
            )}
            <dl className="tk-kv">
              <dt>Kind</dt><dd>{KIND_LABEL[item.kind]}{item.origin ? ` · started by ${item.origin}` : ''}</dd>
              {item.model && <><dt>Model</dt><dd>{item.model}</dd></>}
              {(item.tokensIn || item.tokensOut) ? <><dt>Tokens</dt><dd>{(item.tokensIn ?? 0).toLocaleString()} in · {(item.tokensOut ?? 0).toLocaleString()} out</dd></> : null}
              <dt>Started</dt><dd>{new Date(item.startedAt).toLocaleTimeString()}</dd>
              {item.endedAt && <><dt>Ended</dt><dd>{new Date(item.endedAt).toLocaleTimeString()}</dd></>}
              {item.pid !== undefined && <><dt>PID</dt><dd>{item.pid}</dd></>}
              <dt>Id</dt><dd>{item.id}</dd>
            </dl>
          </div>
        )}

        {actions.length > 0 && (
          <div className={`tk-actions${you || open ? ' is-pinned' : ''}`}>
            {actions.map(a => {
              const spec = ACTION[a];
              const label = a === 'copy-command' && p.copied === `cmd:${item.id}` ? 'Copied' : spec.label;
              return (
                <button key={a} className={`tk-btn${spec.tone ? ` is-${spec.tone}` : ''}`} disabled={p.busy && a !== 'transcript' && a !== 'open-chat'}
                  onClick={() => (a === 'copy-command' && item.command ? p.onCopy(item.command, `cmd:${item.id}`) : p.onAct(a))}>
                  <Svg name={a === 'copy-command' && p.copied === `cmd:${item.id}` ? 'check' : spec.icon} size={11} />{label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

/** Output, scrolled to the end — the last line is what says why. */
function OutputTail({ text }: { text: string }): React.ReactElement {
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [text]);
  return <pre ref={ref} className="tk-pre" tabIndex={0} aria-label="Output">{text}</pre>;
}

/** `anthropic/claude-sonnet-4.5` → `claude-sonnet-4.5`: the provider prefix says little in a dense row. */
function shortModel(model: string): string {
  const tail = model.split('/').pop() ?? model;
  return tail.length > 28 ? `${tail.slice(0, 27)}…` : tail;
}

// ── the chip under a transcript ──────────────────────────────────────────

/**
 * "3 running tasks · 1 needs you", under the active chat. Renders nothing
 * when there is nothing to say — a permanent "0 tasks" would be read past.
 */
export function TasksChip({ running, waiting, onOpen }: { running: number; waiting: number; onOpen: () => void }): React.ReactElement | null {
  if (running + waiting === 0) return null;
  return (
    <div className="tk-chip-bar">
      <button className="tk-running-chip" onClick={onOpen} aria-label={`${running} running, ${waiting} waiting for you — open Tasks`}>
        {running > 0 && <AicoMark size={13} />}
        {running > 0 && <span>{running} running task{running === 1 ? '' : 's'}</span>}
        {running > 0 && waiting > 0 && <span className="tk-chip-sep">·</span>}
        {waiting > 0 && <span className="tk-chip-wait">{waiting} need{waiting === 1 ? 's' : ''} you</span>}
      </button>
    </div>
  );
}
