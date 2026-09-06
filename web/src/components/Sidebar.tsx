/**
 * The left column: the session list and the navigation.
 *
 * Grouped by project, with the groups you made and a section for the
 * conversations bound to Apps, and the handful you were just in above them all.
 * Sessions running on the server are marked distinctly from sessions that
 * merely exist on disk: closing the tab does not stop the work, so the list has
 * to be able to say "this one is still going" about a session you are not
 * looking at.
 *
 * The list is one flat sequence of rows (see {@link module:sidebar-rows}), which
 * is what lets it be walked with the keyboard and, past a couple of hundred
 * rows, windowed so a machine with five hundred sessions does not mount five
 * hundred rows to show thirty.
 *
 * What the reader folds is remembered ({@link module:sidebar-memory}); what
 * they type into the search box is not — a search is about now.
 *
 * @module components/Sidebar
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import type { SessionSummary } from '../api';
import {
  groupByProject, recentSessions, relativeAge, sectionLabelFor, showRecent, splitPinned,
  searchTerms, APPS_SECTION, type MatchContext, type Section,
} from '../grouping';
import { flattenRows, rowKey, isFocusable, type Row } from '../sidebar-rows';
import { moveFocus, HANDLED_KEYS } from '../sidebar-keys';
import { dropAction, SESSION_DRAG_TYPE } from '../sidebar-drop';
import { loadSidebarMemory, saveSidebarMemory, defaultCollapsed, type SidebarMemory } from '../sidebar-memory';
import { toggleDestination, type Route } from '../navigation';
import { Icon, type Glyph } from './Icon';
import { Portal } from './Portal';
import { SessionRowMenu } from './SessionRowMenu';
import { ProjectGroupHeader } from './ProjectGroupHeader';
import { ResizeHandle, useSidebarWidth } from './ResizeHandle';
import { WindowedList } from './WindowedList';
import { TOOLBAR_CONTROL, toolbarTone } from './toolbar';

interface Props {
  route: Route;
  onRoute: (route: Route) => void;
  open: boolean;
  onClose: () => void;
  onSettings: () => void;
  settingsOpen: boolean;
  onAddProject: () => void;
}

/** Past this many rows the list is windowed; below it, every row is mounted. */
const WINDOW_ABOVE = 200;
/** Uniform row height in windowed mode. */
const ROW_HEIGHT = 32;

export function Sidebar(
  { route, onRoute, open, onClose, onSettings, settingsOpen, onAddProject }: Props,
): React.ReactElement {
  const sessions = useStore(s => s.sessions);
  const activeSessions = useStore(s => s.activeSessions);
  const sessionId = useStore(s => s.sessionId);
  const openSession = useStore(s => s.openSession);
  const newSession = useStore(s => s.newSession);
  const moveToGroup = useStore(s => s.moveToGroup);
  const showArchived = useStore(s => s.showArchived);
  const toggleArchived = useStore(s => s.toggleArchived);
  const projects = useStore(s => s.projects);
  const groups = useStore(s => s.groups);
  const createGroup = useStore(s => s.createGroup);

  const [filter, setFilter] = useState('');
  const [width, setWidth] = useSidebarWidth();
  const [naming, setNaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // What the reader folded, remembered. Read once; every toggle writes back.
  const [memory, setMemory] = useState<SidebarMemory>(() => loadSidebarMemory());
  const remember = useCallback((patch: Partial<SidebarMemory>) => {
    setMemory(current => {
      const next = { ...current, ...patch, touched: true };
      saveSidebarMemory(next);
      return next;
    });
  }, []);
  // The archived toggle lives in the store (the VS Code panel reads it too);
  // the memory only seeds it on the first paint and mirrors later flips.
  useEffect(() => {
    if (memory.showArchived !== showArchived) toggleArchived();
    // Once, at mount: afterwards the store is the source and the memory follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const flipArchived = (): void => {
    toggleArchived();
    remember({ showArchived: !showArchived });
  };

  const visible = useMemo(
    () => (showArchived ? sessions : sessions.filter(s => !s.archived)),
    [sessions, showArchived],
  );
  const ctx: MatchContext = useMemo(() => ({
    projects: new Map(projects.map(p => [p.path, { name: p.name }])),
    groups: new Map(groups.map(g => [g.id, { name: g.name }])),
  }), [projects, groups]);
  const filtering = searchTerms(filter).length > 0;

  const sections: Section[] = useMemo(
    () => groupByProject(visible, projects, filter, groups),
    [visible, projects, filter, groups],
  );
  const ordered = useMemo(() => {
    const { pinned, rest } = splitPinned(sections);
    return [...pinned, ...rest];
  }, [sections]);
  const recent = useMemo(() => recentSessions(visible, filter, undefined, ctx), [visible, filter, ctx]);
  const recentShown = showRecent(filter, visible.length);

  const collapsed = useMemo(
    () => defaultCollapsed(ordered, memory),
    [ordered, memory],
  );
  const toggleSection = (path: string): void => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path); else next.add(path);
    remember({ collapsed: [...next] });
  };

  const rows: Row[] = useMemo(() => flattenRows({
    recent, showRecent: recentShown, recentFolded: memory.recentFolded,
    sections: ordered, collapsed, filtering,
  }), [recent, recentShown, memory.recentFolded, ordered, collapsed, filtering]);
  const matchCount = useMemo(() => ordered.reduce((n, s) => n + s.items.length, 0), [ordered]);

  const select = useCallback((id: string): void => {
    void openSession(id);
    onRoute({ destination: 'sessions', tab: 'chat' });
    onClose();
  }, [openSession, onRoute, onClose]);

  const startNew = (): void => { newSession(); onRoute({ destination: 'sessions', tab: 'chat' }); onClose(); };

  // ── keyboard ────────────────────────────────────────────────────────
  const [focusIndex, setFocusIndex] = useState(0);
  // The focus ring is drawn only while the tree itself has focus; a ring on a
  // row while the reader is typing in the composer is a ring about nothing.
  const [treeFocused, setTreeFocused] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keep the focus on a real row when the rows change under it.
    if (rows.length === 0) { setFocusIndex(0); return; }
    if (focusIndex >= rows.length || !isFocusable(rows[focusIndex]!)) {
      const first = rows.findIndex(isFocusable);
      setFocusIndex(first < 0 ? 0 : first);
    }
  }, [rows, focusIndex]);

  const onTreeKey = (e: React.KeyboardEvent): void => {
    if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return; }
    if (!HANDLED_KEYS.has(e.key)) return;
    // A rename input inside a row owns its own keys.
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    const move = moveFocus(rows, focusIndex, e.key);
    setFocusIndex(move.index);
    if (move.action.type === 'open') select(move.action.sessionId);
    if (move.action.type === 'toggle') {
      if (move.action.path === 'recent') remember({ recentFolded: !memory.recentFolded });
      else toggleSection(move.action.path);
    }
  };

  // ── drag to a group ─────────────────────────────────────────────────
  const dragged = draggingId ? sessions.find(s => s.id === draggingId) : undefined;
  const acceptsDrop = (section: Section): boolean => Boolean(dragged && dropAction(section, dragged));
  const onDrop = (section: Section, id: string): void => {
    const session = sessions.find(s => s.id === id);
    if (!session) return;
    const action = dropAction(section, session);
    if (!action) return;
    void moveToGroup(id, action.type === 'move' ? action.group : null);
    setDraggingId(null);
  };

  // ── rendering one row ───────────────────────────────────────────────
  const dense = rows.length > WINDOW_ABOVE;
  const rowId = (index: number): string => `sidebar-row-${index}`;
  const renderRow = (row: Row, index: number): React.ReactNode => {
    const focused = treeFocused && index === focusIndex;
    switch (row.kind) {
      case 'recent-header':
        return (
          <div
            id={rowId(index)}
            role="treeitem"
            aria-expanded={!row.folded}
            aria-level={1}
            className={`flex items-center gap-1.5 px-3 ${dense ? 'h-8' : 'py-1'}
                        ${focused ? 'rounded-lg outline outline-1 outline-aico-accent/60' : ''}`}
          >
            <button
              onClick={() => remember({ recentFolded: !row.folded })}
              tabIndex={-1}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              aria-expanded={!row.folded}
            >
              <Icon name={row.folded ? 'chevron-right' : 'chevron-down'} size={12} className="text-aico-muted" />
              <Icon name="clock" size={14} className="text-aico-muted" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-aico-muted">Recent</span>
            </button>
          </div>
        );
      case 'section-header': {
        const { section } = row;
        const known = section.kind === 'group'
          ? groups.some(g => g.id === section.path)
          : section.kind === 'project' && projects.some(p => p.path === section.path);
        return (
          <ProjectGroupHeader
            label={section.label}
            path={section.path}
            kind={section.kind}
            known={known}
            isLaunch={projects.some(p => p.path === section.path && p.isLaunch)}
            collapsed={row.collapsed}
            count={row.matches}
            filtering={filtering}
            onToggle={() => toggleSection(section.path)}
            acceptsDrop={acceptsDrop(section)}
            onDropSession={id => onDrop(section, id)}
            onOpenApps={() => { onRoute({ ...route, destination: 'apps' }); onClose(); }}
            dense={dense}
            focused={focused}
            rowId={rowId(index)}
          />
        );
      }
      case 'empty':
        return (
          <p className={`px-3 text-[12px] text-aico-muted ${dense ? 'flex h-8 items-center' : 'pb-1'}`}>
            {filtering ? 'No match here.'
              : row.section.kind === 'group' ? 'No sessions here yet. Drop one on the name, or use ⋯ → Move to group.'
              : row.section.kind === 'apps' ? 'No app conversations yet.'
              : 'No sessions here yet.'}
          </p>
        );
      case 'session':
        return (
          <SessionRow
            session={row.session}
            running={row.session.running === true || activeSessions.includes(row.session.id)}
            current={row.session.id === sessionId}
            suffix={row.within === 'recent' ? sectionLabelFor(row.session, projects, groups) : ''}
            groupColor={row.within === 'recent' ? groups.find(g => g.id === row.session.group)?.color : undefined}
            onSelect={() => select(row.session.id)}
            onDragStart={() => setDraggingId(row.session.id)}
            onDragEnd={() => setDraggingId(null)}
            dense={dense}
            focused={focused}
            rowId={rowId(index)}
          />
        );
    }
  };

  const treeProps: React.HTMLAttributes<HTMLDivElement> = {
    role: 'tree',
    'aria-label': 'Sessions',
    tabIndex: 0,
    'aria-activedescendant': rows.length ? rowId(focusIndex) : undefined,
    onKeyDown: onTreeKey,
    onFocus: (e: React.FocusEvent) => { if (e.target === e.currentTarget) setTreeFocused(true); },
    onBlur: (e: React.FocusEvent) => { if (e.target === e.currentTarget) setTreeFocused(false); },
  };

  const empty = sessions.length === 0;
  const nothingMatches = !empty && filtering && matchCount === 0 && ordered.length === 0;

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={onClose} aria-hidden />
      )}

      <aside
        data-sidebar
        // The width is inline because it is a dragged value, and `transition-transform`
        // is scoped to the mobile drawer: leaving it on during a resize animates
        // every pixel of the drag a beat behind the pointer. The max keeps a
        // remembered desktop width from exceeding a phone.
        style={{ width, maxWidth: 'calc(100vw - 48px)' }}
        className={`fixed inset-y-0 left-0 z-30 flex flex-col border-r border-aico-border-subtle
                    bg-aico-surface md:static md:translate-x-0
                    ${open ? 'translate-x-0' : '-translate-x-full transition-transform'}`}
        onKeyDown={e => { if (e.key === 'Escape' && open) onClose(); }}
      >
        <ResizeHandle onResize={setWidth} />
        <div className="flex items-center gap-2 px-4 pb-2 pt-4">
          <span className="text-[15px] font-semibold tracking-tight text-aico-primary">AICO</span>
          <span
            className="rounded bg-aico-hover px-1.5 py-0.5 text-[10px] tabular-nums text-aico-muted"
            title={`aico ${__AICO_VERSION__} — by Suhail Akhtar`}
          >
            v{__AICO_VERSION__}
          </span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="text-aico-muted hover:text-aico-primary md:hidden"
            aria-label="Close sidebar"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={startNew}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-aico-border
                       bg-aico-bg px-3 py-2 text-[14px] font-medium text-aico-primary
                       transition-colors hover:bg-aico-hover"
          >
            <Icon name="plus" size={17} className="text-aico-muted" /> New session
          </button>
        </div>

        {/*
          Always on. Search used to hide behind an icon, which meant the box was
          missing exactly when someone opened the sidebar to find something. The
          placeholder says what it searches, because it searches more than
          titles: project and group names too.
        */}
        <div className="px-3 pb-1">
          <div className="flex items-center gap-2 rounded-lg border border-aico-border-subtle bg-aico-bg
                          px-2.5 py-1.5 transition-colors focus-within:border-aico-accent/40">
            <Icon name="search" size={15} className="text-aico-muted" />
            <input
              ref={searchRef}
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Search sessions, projects, groups"
              aria-label="Search sessions, projects and groups"
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  if (filter) setFilter(''); else (e.target as HTMLInputElement).blur();
                }
                if (e.key === 'ArrowDown') { e.preventDefault(); treeRef.current?.focus(); }
              }}
              className="w-full min-w-0 bg-transparent text-[13px] text-aico-primary
                         placeholder:text-aico-muted focus:outline-none"
            />
            {filter && (
              <button onClick={() => setFilter('')} aria-label="Clear search" className="text-aico-muted hover:text-aico-primary">
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
          {filtering && (
            <p className="px-1 pt-1 text-[11px] text-aico-muted">
              {matchCount === 1 ? '1 match' : `${matchCount} matches`}
            </p>
          )}
        </div>

        {/*
          Two labelled controls, not four glyphs. The header used to carry four
          17px icons with nothing but a tooltip to tell them apart — and two of
          them (new group, add folder) looked the same. A `+` menu holds the
          three ways to make something; the archive toggle says its own name.
        */}
        <div data-sidebar-header className="flex items-center gap-1 px-3 pb-1 pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-aico-muted">
            Projects
          </span>
          <div className="flex-1" />
          <button
            onClick={flipArchived}
            aria-pressed={showArchived}
            title={showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
            className={`${TOOLBAR_CONTROL} ${toolbarTone(showArchived)} text-[12px]`}
          >
            <Icon name="archive" size={14} /> Archived
          </button>
          <AddMenu
            open={menuOpen}
            onToggle={() => setMenuOpen(v => !v)}
            onClose={() => setMenuOpen(false)}
            onNewSession={startNew}
            onOpenProject={onAddProject}
            onNewGroup={() => setNaming(true)}
          />
        </div>

        {naming && (
          <div className="px-3 pb-1">
            <input
              autoFocus
              placeholder="Group name, then Enter"
              aria-label="New group name"
              onBlur={() => setNaming(false)}
              onKeyDown={e => {
                if (e.key === 'Escape') setNaming(false);
                if (e.key === 'Enter') {
                  const value = (e.target as HTMLInputElement).value.trim();
                  setNaming(false);
                  if (value) {
                    void createGroup(value).then(id => {
                      // A new group opens: the whole point of making it was to look at it.
                      if (id) remember({ collapsed: [...collapsed].filter(p => p !== id) });
                    });
                  }
                }
              }}
              className="w-full rounded-lg border border-aico-accent/50 bg-aico-bg px-2.5 py-1.5
                         text-[13px] text-aico-primary placeholder:text-aico-muted focus:outline-none"
            />
          </div>
        )}

        {/*
          The first-run card sits above the list, not instead of it: a reader
          who has opened two projects and started nothing still needs to see
          the projects they opened.
        */}
        {empty && <FirstRun onNewSession={startNew} onOpenProject={onAddProject} />}
        {nothingMatches ? (
          <p className="px-5 py-3 text-[13px] text-aico-muted">Nothing matches that.</p>
        ) : dense ? (
          <WindowedList
            rows={rows}
            rowHeight={ROW_HEIGHT}
            renderRow={renderRow}
            rowKey={rowKey}
            scrollToIndex={focusIndex}
            className="mt-1 flex-1 px-2 pb-2 focus:outline-none"
            containerProps={{ ...treeProps, ref: treeRef } as React.HTMLAttributes<HTMLDivElement>}
          />
        ) : (
          <div
            {...treeProps}
            ref={treeRef}
            data-sidebar-list
            className="mt-1 flex-1 overflow-y-auto px-2 pb-2 focus:outline-none"
          >
            {rows.map((row, index) => (
              <React.Fragment key={rowKey(row)}>{renderRow(row, index)}</React.Fragment>
            ))}
          </div>
        )}

        {/*
          Destinations, not views. Chat, Changes and Trajectory are three
          readings of one session and are tabs on it in the header. Settings is
          a sheet over whatever you are doing, and its button lights while the
          sheet is open. Apps earns a place because an app outlives the session
          that built it.
        */}
        <div className="border-t border-aico-border-subtle px-2 py-2">
          <NavButton
            icon="grid"
            active={route.destination === 'apps'}
            onClick={() => { onRoute(toggleDestination(route, 'apps')); onClose(); }}
          >
            Apps
          </NavButton>
          <NavButton
            icon="activity"
            active={route.destination === 'system'}
            onClick={() => { onRoute(toggleDestination(route, 'system')); onClose(); }}
          >
            System
          </NavButton>
          <NavButton icon="sliders" active={settingsOpen} onClick={() => { onSettings(); onClose(); }}>
            Settings
          </NavButton>
        </div>
      </aside>
    </>
  );
}

/**
 * One session in the list.
 *
 * Shows its title when it has one and its id when it does not. A model-written
 * title that is still provisional is marked, because a name you did not choose
 * that silently changes under you is disorienting. Double-clicking renames,
 * which pins it. The row can be dragged onto a group header.
 */
const SessionRow = React.memo(function SessionRow(
  { session, running, current, suffix, groupColor, onSelect, onDragStart, onDragEnd, dense, focused, rowId }: {
    session: SessionSummary; running: boolean; current: boolean;
    /** Where it lives, for a Recent row: the project or group name. */
    suffix: string;
    groupColor?: string | undefined;
    onSelect: () => void;
    onDragStart: () => void;
    onDragEnd: () => void;
    dense: boolean;
    focused: boolean;
    rowId: string;
  },
): React.ReactElement {
  const renameSession = useStore(s => s.renameSession);
  const archiveSession = useStore(s => s.archiveSession);
  const forkSession = useStore(s => s.forkSession);
  const allGroups = useStore(s => s.groups);
  const moveToGroup = useStore(s => s.moveToGroup);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title ?? '');

  const commit = async (): Promise<void> => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === session.title) return;
    await renameSession(session.id, next);
  };

  if (editing) {
    return (
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={e => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') { setDraft(session.title ?? ''); setEditing(false); }
        }}
        autoFocus
        aria-label="Session name"
        className={`w-full rounded-lg border border-aico-accent/50 bg-aico-bg px-3 text-[13px]
                    text-aico-primary focus:outline-none ${dense ? 'h-8' : 'mb-0.5 py-1.5'}`}
      />
    );
  }

  const label = session.title ?? session.id;
  return (
    // A row, not a button: the ellipsis is interactive and a button inside a
    // button is invalid markup. The selected row is the one you are *looking
    // at*; the green dot means *running* — three signals for selection (bar,
    // tint, weight) because the single subtle one failed.
    <div
      id={rowId}
      role="treeitem"
      aria-level={2}
      aria-selected={current}
      aria-current={current ? 'true' : undefined}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`group/row relative flex w-full items-center gap-2 rounded-lg pr-1.5 text-left
                  text-[13px] transition-colors ${dense ? 'h-8' : 'mb-0.5'} ${current
                    ? 'bg-aico-accent-soft font-medium text-aico-primary'
                    : 'text-aico-secondary hover:bg-aico-hover'} ${session.archived ? 'opacity-55' : ''}
                  ${focused ? 'outline outline-1 outline-aico-accent/60' : ''}`}
    >
      {current && (
        <span aria-hidden className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-aico-accent" />
      )}
      <button
        onClick={onSelect}
        onDoubleClick={() => { setDraft(session.title ?? ''); setEditing(true); }}
        tabIndex={-1}
        title={`${label}\n${session.id}\nDouble-click to rename`}
        className={`flex min-w-0 flex-1 items-center gap-2 pl-3 text-left ${dense ? 'h-8' : 'py-1.5'}`}
      >
        {running && (
          <span className="aico-thinking shrink-0 text-aico-success" title="Running on the server">●</span>
        )}
        {groupColor && (
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: groupColor }} />
        )}
        <span className={`min-w-0 flex-1 truncate ${session.title ? '' : 'font-mono opacity-70'}`}>
          {label}
          {suffix && (
            <span className="ml-1.5 text-[11px] font-normal text-aico-muted">{suffix}</span>
          )}
        </span>
      </button>

      {/* The age gives way to the menu on hover: both on one row would either
          crowd the title or leave a permanent gap where a control might be. */}
      <span className="shrink-0 text-[11px] text-aico-muted group-hover/row:hidden">
        {session.titleSource === 'fallback' ? '~' : ''}
        {relativeAge(session.updatedAt)}
      </span>

      <SessionRowMenu
        archived={session.archived === true}
        groups={allGroups}
        currentGroup={session.group}
        onMoveToGroup={g => void moveToGroup(session.id, g)}
        onRename={() => { setDraft(session.title ?? ''); setEditing(true); }}
        onFork={() => void forkSession(session.id)}
        onArchive={() => void archiveSession(session.id, !session.archived)}
      />
    </div>
  );
});

/** The `+` menu on the Projects header: the three ways to make something. */
function AddMenu(
  { open, onToggle, onClose, onNewSession, onOpenProject, onNewGroup }: {
    open: boolean; onToggle: () => void; onClose: () => void;
    onNewSession: () => void; onOpenProject: () => void; onNewGroup: () => void;
  },
): React.ReactElement {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent): void => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if ((event.target as HTMLElement).closest('[data-add-menu]')) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', dismiss, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', dismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const item = (glyph: Glyph, label: string, onPick: () => void): React.ReactElement => (
    <button
      role="menuitem"
      onClick={() => { onClose(); onPick(); }}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-aico-primary
                 transition-colors hover:bg-aico-hover"
    >
      <Icon name={glyph} size={15} className="text-aico-muted" /> {label}
    </button>
  );

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => {
          const box = buttonRef.current?.getBoundingClientRect();
          if (box) setAt({ top: box.bottom + 4, left: Math.min(box.left, window.innerWidth - 220) });
          onToggle();
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="New session, open a project, or make a group"
        className={`${TOOLBAR_CONTROL} ${toolbarTone(open)} w-7 justify-center px-0`}
      >
        <Icon name="plus" size={16} />
      </button>
      {open && (
        <Portal>
          <div
            data-add-menu
            role="menu"
            style={{ top: at.top, left: at.left }}
            className="fixed z-50 w-[212px] overflow-hidden rounded-xl border border-aico-border
                       bg-aico-bg py-1 shadow-2xl"
          >
            {item('plus', 'New session', onNewSession)}
            {item('folder-plus', 'Open project…', onOpenProject)}
            {item('stack', 'New group…', onNewGroup)}
          </div>
        </Portal>
      )}
    </>
  );
}

/** What a brand-new install sees instead of "No sessions yet." */
function FirstRun(
  { onNewSession, onOpenProject }: { onNewSession: () => void; onOpenProject: () => void },
): React.ReactElement {
  return (
    <div className="mx-3 mt-2 rounded-xl border border-dashed border-aico-border p-4">
      <p className="text-[13px] font-medium text-aico-primary">Nothing here yet</p>
      <p className="mt-1 text-[12px] leading-relaxed text-aico-secondary">
        Ask anything below — it runs in the scratch workspace. Open a project folder to work on code.
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          onClick={onOpenProject}
          className="rounded-full bg-aico-accent px-3 py-1 text-[12px] font-medium text-aico-on-accent
                     transition-colors hover:bg-aico-accent-hover"
        >
          Open project…
        </button>
        <button
          onClick={onNewSession}
          className="rounded-full border border-aico-border px-3 py-1 text-[12px] text-aico-secondary
                     transition-colors hover:bg-aico-hover hover:text-aico-primary"
        >
          New session
        </button>
      </div>
    </div>
  );
}

function NavButton(
  { active, onClick, icon, children }: {
    active: boolean; onClick: () => void; icon: Glyph; children: React.ReactNode;
  },
): React.ReactElement {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px]
                  transition-colors ${
                    active ? 'bg-aico-hover text-aico-primary' : 'text-aico-secondary hover:bg-aico-hover'
                  }`}
    >
      <Icon name={icon} size={17} className={active ? 'text-aico-accent' : 'text-aico-muted'} />
      {children}
    </button>
  );
}

export { APPS_SECTION };
