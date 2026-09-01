/**
 * Recent conversations, scoped to the folder you have open.
 *
 * Filtering by project is the whole design. The server keeps sessions for every
 * directory it has ever worked in, and a panel that listed all of them would put
 * yesterday's unrelated repository above this morning's work in the same window.
 * The browser client can afford to show everything because it has a sidebar and
 * a project picker; a side bar in an editor already knows which project it is.
 *
 * Sessions that have never been written to are left out. A new session is
 * created optimistically the moment the panel opens, so listing empties would
 * mean the list always began with a row for the conversation you are already in.
 *
 * @module components/SessionList
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '@web/store';
import { sameFolder } from '../paths';

/** Rows shown before the list is collapsed behind "View all". */
const PREVIEW = 5;

export function SessionList({ activeId, onPick }: {
  activeId: string;
  onPick: () => void;
}): React.ReactElement {
  const sessions = useStore(s => s.sessions);
  const project = useStore(s => s.project);
  const openSession = useStore(s => s.openSession);
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => sessions
    .filter(s => !s.archived)
    .filter(s => (s.turns ?? 0) > 0 || s.id === activeId)
    /*
      An older server may not record a project on every session. Those are kept
      rather than hidden: a missing field is not evidence that the session
      belongs somewhere else, and dropping it would make history vanish after an
      upgrade for no reason the reader could see.

      The comparison is deliberately tolerant. VS Code spells Windows paths with
      a lowercase drive letter and everything else uses an uppercase one, so an
      exact match hid every session started from a terminal in this very
      folder.
    */
    .filter(s => !project || !s.project || sameFolder(s.project, project))
    .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, project, activeId]);

  const shown = expanded ? rows : rows.slice(0, PREVIEW);

  if (rows.length === 0) {
    return (
      <div className="border-b border-aico-border-subtle px-3 py-2 text-[11px] text-aico-muted">
        No conversations in this folder yet.
      </div>
    );
  }

  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-aico-border-subtle py-1">
      {shown.map(session => (
        <button
          key={session.id}
          type="button"
          onClick={() => { void openSession(session.id); onPick(); }}
          className={[
            'flex w-full items-center gap-2 px-3 py-1 text-left',
            'hover:bg-aico-hover',
            session.id === activeId ? 'bg-aico-accent-soft' : '',
          ].join(' ')}
        >
          <span className="min-w-0 flex-1 truncate text-[12px] text-aico-primary">
            {session.title || 'Untitled'}
          </span>
          {session.running && (
            <span
              title="Running"
              className="size-[5px] shrink-0 animate-pulse-soft rounded-full bg-aico-accent"
            />
          )}
          <span className="shrink-0 text-[11px] tabular-nums text-aico-muted">
            {ago(session.updatedAt)}
          </span>
        </button>
      ))}

      {rows.length > PREVIEW && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="px-3 py-1 text-[11px] text-aico-muted hover:text-aico-primary"
        >
          {expanded ? 'Show fewer' : `View all (${rows.length})`}
        </button>
      )}
    </div>
  );
}

/**
 * Coarse on purpose.
 *
 * "3mo" is as much as anyone needs from a history row, and the coarseness is
 * what keeps the column narrow enough to leave room for the title — which is the
 * thing being scanned for.
 */
function ago(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}
