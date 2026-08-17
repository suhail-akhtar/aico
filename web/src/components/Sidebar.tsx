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
import { groupByAge, relativeAge } from '../grouping';
import { Icon, type Glyph } from './Icon';

export type View = 'chat' | 'trajectory' | 'system';

interface Props {
  view: View;
  onView: (view: View) => void;
  open: boolean;
  onClose: () => void;
  onSettings: () => void;
}

export function Sidebar({ view, onView, open, onClose, onSettings }: Props): React.ReactElement {
  const sessions = useStore(s => s.sessions);
  const activeSessions = useStore(s => s.activeSessions);
  const sessionId = useStore(s => s.sessionId);
  const openSession = useStore(s => s.openSession);
  const newSession = useStore(s => s.newSession);
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => groupByAge(sessions, filter), [sessions, filter]);

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

        {sessions.length > 8 && (
          <div className="px-3 pb-1">
            <div className="flex items-center gap-2 rounded-lg border border-aico-border-subtle bg-aico-bg
                            px-2.5 py-1.5 transition-colors focus-within:border-aico-accent/40">
              <Icon name="search" size={13} className="text-aico-muted" />
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Search sessions"
                className="w-full min-w-0 bg-transparent text-[13px] text-aico-primary
                           placeholder:text-aico-muted focus:outline-none"
              />
            </div>
          </div>
        )}

        <nav className="mt-1 flex-1 overflow-y-auto px-2 pb-2">
          {sessions.length === 0 && (
            <p className="px-3 py-3 text-[13px] text-aico-muted">No sessions yet.</p>
          )}
          {sessions.length > 0 && groups.every(g => g.items.length === 0) && (
            <p className="px-3 py-3 text-[13px] text-aico-muted">Nothing matches that.</p>
          )}

          {groups.map(group => group.items.length > 0 && (
            <section key={group.label} className="mb-1">
              <h2 className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-aico-muted">
                {group.label}
              </h2>
              {group.items.map(session => (
                <SessionRow
                  key={session.id}
                  session={session}
                  running={session.running === true || activeSessions.includes(session.id)}
                  current={session.id === sessionId}
                  onSelect={() => select(session.id)}
                />
              ))}
            </section>
          ))}
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
  const rename = useStore(s => s.rename);
  const openSession = useStore(s => s.openSession);
  const sessionId = useStore(s => s.sessionId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title ?? '');

  const commit = async (): Promise<void> => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === session.title) return;
    // Renaming a session you are not in has to open it first: the rename is
    // applied to the run the server holds, and there is no run until then.
    if (sessionId !== session.id) await openSession(session.id);
    await rename(next);
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
    <button
      onClick={onSelect}
      onDoubleClick={() => { setDraft(session.title ?? ''); setEditing(true); }}
      title={`${label}\n${session.id}\nDouble-click to rename`}
      className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left
                  text-[13px] transition-colors ${current
                    ? 'bg-aico-hover text-aico-primary'
                    : 'text-aico-secondary hover:bg-aico-hover'}`}
    >
      {running && (
        <span className="aico-thinking shrink-0 text-aico-success" title="Running on the server">
          ●
        </span>
      )}
      <span className={`min-w-0 flex-1 truncate ${session.title ? '' : 'font-mono opacity-70'}`}>
        {label}
      </span>
      <span className="shrink-0 text-[11px] text-aico-muted">
        {session.titleSource === 'fallback' ? '~' : ''}
        {relativeAge(session.updatedAt)}
      </span>
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
