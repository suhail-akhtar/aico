/**
 * Session list and navigation.
 *
 * Grouped by when work last happened in each session — Today, Yesterday, then
 * widening windows. A flat list of forty rows is a lookup problem; the same
 * forty under date headings is a memory one, and people remember *when* they
 * were doing something far better than what they called it.
 *
 * Sessions running on the server are marked distinctly from sessions that
 * merely exist on disk. That distinction is the point of a server-owned run:
 * closing the tab does not stop the work, so the list has to be able to say
 * "this one is still going" about a session you are not looking at.
 *
 * @module components/Sidebar
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import type { SessionSummary } from '../api';
import { groupByAge, groupByProject, relativeAge } from '../grouping';
import { Icon, type Glyph } from './Icon';
import { SessionRowMenu } from './SessionRowMenu';
import { ProjectGroupHeader } from './ProjectGroupHeader';

export type View = 'chat' | 'trajectory' | 'system';

interface Props {
  view: View;
  onView: (view: View) => void;
  open: boolean;
  onClose: () => void;
  onSettings: () => void;
  onAddProject: () => void;
}

export function Sidebar(
  { view, onView, open, onClose, onSettings, onAddProject }: Props,
): React.ReactElement {
  const sessions = useStore(s => s.sessions);
  const activeSessions = useStore(s => s.activeSessions);
  const sessionId = useStore(s => s.sessionId);
  const openSession = useStore(s => s.openSession);
  const newSession = useStore(s => s.newSession);
  const [filter, setFilter] = useState('');
  const [searching, setSearching] = useState(false);
  /** Folded groups, by path. A view preference about right now, not stored. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const showArchived = useStore(s => s.showArchived);
  const toggleArchived = useStore(s => s.toggleArchived);

  const projects = useStore(s => s.projects);

  // Always grouped by folder now. The date axis was better when a folder was
  // not a thing you could choose, but a header that says Projects above a list
  // that shows none of them is a screen disagreeing with itself.
  const byProject = true;
  const visible = useMemo(
    () => (showArchived ? sessions : sessions.filter(s => !s.archived)),
    [sessions, showArchived],
  );
  // One shape for both axes, so the renderer below does not have to know which
  // it got. `path` is simply absent on the date buckets.
  const groups: Array<{ label: string; path?: string; items: SessionSummary[] }> = useMemo(
    () => (byProject ? groupByProject(visible, projects, filter) : groupByAge(visible, filter)),
    [byProject, visible, projects, filter],
  );

  const select = (id: string): void => {
    void openSession(id);
    onView('chat');
    onClose();
  };

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={onClose} aria-hidden />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-[280px] flex-col border-r border-aico-border-subtle
                    bg-aico-surface transition-transform md:static md:translate-x-0
                    ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex items-center gap-2 px-4 pb-2 pt-4">
          <span className="text-[15px] font-semibold tracking-tight text-aico-primary">AICO</span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="text-aico-muted hover:text-aico-primary md:hidden"
            aria-label="Close sidebar"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={() => { newSession(); onView('chat'); onClose(); }}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-aico-border
                       bg-aico-bg px-3 py-2 text-[14px] font-medium text-aico-primary
                       transition-colors hover:bg-aico-hover"
          >
            <Icon name="plus" size={15} className="text-aico-muted" /> New session
          </button>
        </div>

        {searching && (
          <div className="px-3 pb-1">
            <div className="flex items-center gap-2 rounded-lg border border-aico-border-subtle bg-aico-bg
                            px-2.5 py-1.5 transition-colors focus-within:border-aico-accent/40">
              <Icon name="search" size={13} className="text-aico-muted" />
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Search sessions"
                autoFocus
                onKeyDown={e => { if (e.key === 'Escape') { setFilter(''); setSearching(false); } }}
                className="w-full min-w-0 bg-transparent text-[13px] text-aico-primary
                           placeholder:text-aico-muted focus:outline-none"
              />
            </div>
          </div>
        )}

        {/*
          Always present. It was gated on having more than one folder open,
          which meant the controls on it — search, archived, add — were missing
          exactly when someone was looking for how to open their first one.
        */}
        <div className="flex items-center gap-0.5 px-4 pb-1 pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-aico-muted">
            Projects
          </span>
          <div className="flex-1" />
          <HeaderButton
            icon="search"
            label="Search sessions"
            active={searching}
            onClick={() => { setSearching(v => !v); if (searching) setFilter(''); }}
          />
          <HeaderButton
            icon="archive"
            label={showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
            active={showArchived}
            onClick={toggleArchived}
          />
          <HeaderButton icon="folder-plus" label="Add workspace" onClick={onAddProject} />
        </div>

        <nav className="mt-1 flex-1 overflow-y-auto px-2 pb-2">
          {sessions.length === 0 && (
            <p className="px-3 py-3 text-[13px] text-aico-muted">No sessions yet.</p>
          )}
          {sessions.length > 0 && groups.every(g => g.items.length === 0) && (
            <p className="px-3 py-3 text-[13px] text-aico-muted">Nothing matches that.</p>
          )}

          {groups.map(group => {
            const path = group.path ?? '';
            const known = projects.some(p => p.path === path);
            const isFolded = collapsed.has(path);
            return (
              <section key={group.label + path} className="mb-1">
                <ProjectGroupHeader
                  label={group.label}
                  path={path}
                  known={known}
                  isLaunch={projects.some(p => p.path === path && p.isLaunch)}
                  collapsed={isFolded}
                  count={group.items.length}
                  onToggle={() => setCollapsed(current => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path); else next.add(path);
                    return next;
                  })}
                />
                {!isFolded && group.items.length === 0 && (
                  <p className="px-3 pb-1 text-[12px] text-aico-muted">No sessions here yet.</p>
                )}
                {!isFolded && group.items.map(session => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    running={session.running === true || activeSessions.includes(session.id)}
                    current={session.id === sessionId}
                    onSelect={() => select(session.id)}
                  />
                ))}
              </section>
            );
          })}
        </nav>

        {/*
          Two entries, because there are only two *places*. Chat and Trajectory
          are two readings of the same session and are tabs on it in the header,
          so listing Trajectory here as well offered the same destination twice
          and made the sidebar disagree with the header about what it selected.
          Settings is a sheet over whatever you are doing, not somewhere to go.
        */}
        <div className="border-t border-aico-border-subtle px-2 py-2">
          <NavButton
            icon="stack"
            active={view === 'system'}
            onClick={() => { onView(view === 'system' ? 'chat' : 'system'); onClose(); }}
          >
            System
          </NavButton>
          <NavButton icon="sliders" active={false} onClick={() => { onSettings(); onClose(); }}>
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
 * which pins it.
 */
function SessionRow(
  { session, running, current, onSelect }: {
    session: SessionSummary; running: boolean; current: boolean; onSelect: () => void;
  },
): React.ReactElement {
  const renameSession = useStore(s => s.renameSession);
  const archiveSession = useStore(s => s.archiveSession);
  const forkSession = useStore(s => s.forkSession);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title ?? '');

  const commit = async (): Promise<void> => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === session.title) return;
    // No longer has to open the session first. Renaming used to be defined only
    // for the session you were in, so renaming any other row silently switched
    // you into it — a destination change nobody asked for from a menu item that
    // says "Rename".
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
        className="mb-0.5 w-full rounded-lg border border-aico-accent/50 bg-aico-bg px-3 py-1.5
                   text-[13px] text-aico-primary focus:outline-none"
      />
    );
  }

  const label = session.title ?? session.id;
  return (
    // A row, not a button: the ellipsis is interactive and a button inside a
    // button is invalid markup that browsers resolve by dropping one of them.
    <div
      className={`group/row mb-0.5 flex w-full items-center gap-2 rounded-lg pr-1.5 text-left
                  text-[13px] transition-colors ${current
                    ? 'bg-aico-hover text-aico-primary'
                    : 'text-aico-secondary hover:bg-aico-hover'} ${session.archived ? 'opacity-55' : ''}`}
    >
      <button
        onClick={onSelect}
        onDoubleClick={() => { setDraft(session.title ?? ''); setEditing(true); }}
        title={`${label}\n${session.id}\nDouble-click to rename`}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left"
      >
        {running && (
          <span className="aico-thinking shrink-0 text-aico-success" title="Running on the server">
            ●
          </span>
        )}
        <span className={`min-w-0 flex-1 truncate ${session.title ? '' : 'font-mono opacity-70'}`}>
          {label}
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
        onRename={() => { setDraft(session.title ?? ''); setEditing(true); }}
        onFork={() => void forkSession(session.id)}
        onArchive={() => void archiveSession(session.id, !session.archived)}
      />
    </div>
  );
}

/**
 * One icon in the projects header.
 *
 * The label is a `title` *and* an `aria-label`: the tooltip is the only thing
 * that says what an unlabelled glyph does, and a screen reader gets nothing
 * from a tooltip.
 */
function HeaderButton(
  { icon, label, onClick, active = false }: {
    icon: Glyph; label: string; onClick: () => void; active?: boolean;
  },
): React.ReactElement {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`rounded-md p-1.5 transition-colors hover:bg-aico-hover ${
        active ? 'bg-aico-hover text-aico-accent' : 'text-aico-muted hover:text-aico-primary'
      }`}
    >
      <Icon name={icon} size={15} />
    </button>
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
      className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px]
                  transition-colors ${
                    active ? 'bg-aico-hover text-aico-primary' : 'text-aico-secondary hover:bg-aico-hover'
                  }`}
    >
      <Icon name={icon} size={15} className={active ? 'text-aico-accent' : 'text-aico-muted'} />
      {children}
    </button>
  );
}
