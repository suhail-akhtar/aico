/**
 * The chats of one workspace or group, with search and bulk actions.
 *
 * Shared by the workspace page and the group page. Rows open on click; a
 * checkbox on each selects it, and with anything selected the bar offers
 * archive (reversible) and delete (not — so it asks, inline, and says how
 * many). A chat that is running is refused by the server and reported here
 * rather than silently skipped.
 *
 * @module components/ChatList
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import type { SessionSummary } from '../api';
import { matchesSession, searchTerms, type MatchContext } from '../grouping';
import { Icon } from './Icon';

interface Props {
  chats: SessionSummary[];
  /** What the search box says it searches. */
  scope: string;
  onOpen: (id: string) => void;
}

export function ChatList({ chats, scope, onOpen }: Props): React.ReactElement {
  const projects = useStore(s => s.projects);
  const groups = useStore(s => s.groups);
  const showArchived = useStore(s => s.showArchived);
  const toggleArchived = useStore(s => s.toggleArchived);
  const archiveSession = useStore(s => s.archiveSession);
  const deleteSessions = useStore(s => s.deleteSessions);

  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const ctx: MatchContext = useMemo(() => ({
    projects: new Map(projects.map(p => [p.path, p])),
    groups: new Map(groups.map(g => [g.id, g])),
  }), [projects, groups]);

  const shown = useMemo(() => {
    const terms = searchTerms(filter);
    return chats
      .filter(s => showArchived || !s.archived)
      .filter(s => matchesSession(s, terms, ctx))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [chats, showArchived, filter, ctx]);

  const visiblePicked = shown.filter(c => picked.has(c.id));
  const allPicked = shown.length > 0 && visiblePicked.length === shown.length;
  const toggle = (id: string): void => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const archive = async (archived: boolean): Promise<void> => {
    setBusy(true);
    for (const c of visiblePicked) await archiveSession(c.id, archived);
    setPicked(new Set());
    setBusy(false);
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    const result = await deleteSessions(visiblePicked.map(c => c.id));
    setBusy(false);
    setConfirming(false);
    setPicked(new Set(result.skipped.map(s => s.id)));
    setNote(result.skipped.length > 0
      ? `${result.deleted.length} deleted; ${result.skipped.length} not — ${result.skipped[0]!.reason}.`
      : `${result.deleted.length} chat${result.deleted.length === 1 ? '' : 's'} deleted.`);
  };

  const bar = 'rounded-lg border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-50';

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-aico-muted" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder={`Search chats in this ${scope}…`}
            aria-label={`Search chats in this ${scope}`}
            className="w-full rounded-lg border border-aico-border-subtle bg-aico-surface py-1.5 pl-8 pr-3
                       text-[12px] text-aico-primary placeholder:text-aico-muted
                       transition-colors focus:border-aico-accent/60 focus:outline-none"
          />
        </div>
        <button
          onClick={() => toggleArchived()}
          aria-pressed={showArchived}
          title={showArchived ? 'Hide archived chats' : 'Show archived chats'}
          className={`flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors
                      ${showArchived ? 'border-aico-accent/50 bg-aico-accent-soft text-aico-accent' : 'border-aico-border-subtle text-aico-muted hover:text-aico-primary'}`}
        >
          <Icon name="archive" size={14} /> Archived
        </button>
      </div>

      {shown.length > 0 && (
        <div className="mb-1 flex min-h-[32px] flex-wrap items-center gap-2 px-1 text-[12px] text-aico-secondary">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allPicked}
              onChange={() => setPicked(allPicked ? new Set() : new Set(shown.map(c => c.id)))}
              aria-label="Select all chats shown"
              className="h-3.5 w-3.5 accent-aico-accent"
            />
            {visiblePicked.length > 0 ? `${visiblePicked.length} selected` : 'Select'}
          </label>
          {visiblePicked.length > 0 && !confirming && (
            <>
              <button disabled={busy} onClick={() => void archive(true)}
                className={`${bar} border-aico-border-subtle hover:bg-aico-hover`}>Archive</button>
              {visiblePicked.some(c => c.archived) && (
                <button disabled={busy} onClick={() => void archive(false)}
                  className={`${bar} border-aico-border-subtle hover:bg-aico-hover`}>Restore</button>
              )}
              <button disabled={busy} onClick={() => { setConfirming(true); setNote(null); }}
                className={`${bar} border-aico-danger/40 text-aico-danger hover:bg-aico-danger/10`}>Delete…</button>
            </>
          )}
          {confirming && (
            <span role="alert" className="flex flex-wrap items-center gap-2">
              <span className="text-aico-danger">
                Delete {visiblePicked.length} chat{visiblePicked.length === 1 ? '' : 's'} for good? This cannot be undone.
              </span>
              <button disabled={busy} onClick={() => void remove()}
                className={`${bar} border-aico-danger/40 bg-aico-danger/10 text-aico-danger`}>Delete</button>
              <button disabled={busy} onClick={() => setConfirming(false)}
                className={`${bar} border-aico-border-subtle hover:bg-aico-hover`}>Keep</button>
            </span>
          )}
          {note && !confirming && <span className="text-aico-muted">{note}</span>}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="py-3 text-[12px] text-aico-muted">{filter ? 'No chats match.' : 'No chats here yet.'}</p>
      ) : (
        <ul className="divide-y divide-aico-border-subtle">
          {shown.map(chat => (
            <li key={chat.id} className="flex items-center gap-2 px-1">
              <input
                type="checkbox"
                checked={picked.has(chat.id)}
                onChange={() => toggle(chat.id)}
                aria-label={`Select ${chat.title?.trim() || 'chat'}`}
                className="h-3.5 w-3.5 shrink-0 accent-aico-accent"
              />
              <button
                onClick={() => onOpen(chat.id)}
                className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left transition-colors hover:bg-aico-hover"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-aico-primary">
                  {chat.title?.trim() || 'New session'}
                </span>
                {chat.running && <span className="shrink-0 text-[11px] text-aico-accent">running</span>}
                {chat.archived && <Icon name="archive" size={12} className="shrink-0 text-aico-muted" />}
                <span className="shrink-0 tabular-nums text-[11px] text-aico-muted">
                  {chat.turns ?? 0} turn{chat.turns === 1 ? '' : 's'}
                </span>
                <span className="shrink-0 text-[11px] text-aico-muted">
                  {new Date(chat.updatedAt).toLocaleDateString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
