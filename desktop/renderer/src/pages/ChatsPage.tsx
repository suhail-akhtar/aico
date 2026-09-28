/**
 * Every chat, searchable, with bulk archive and delete — the "Search" and
 * "Conversation History" destination.
 *
 * @module desktop/renderer/pages/ChatsPage
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '@web/store';
import { toast } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { ago, basename, cls, dayBucket } from '@/lib/util';
import { openChat } from '@/chat/actions';
import { desktop } from '@/desktop';

export function ChatsPage(): React.ReactElement {
  const sessions = useStore(s => s.sessions);
  const projects = useStore(s => s.projects);
  const archiveSession = useStore(s => s.archiveSession);
  const deleteSessions = useStore(s => s.deleteSessions);
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [folder, setFolder] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...sessions]
      .filter(s => Boolean(s.archived) === archived)
      .filter(s => !folder || s.project === folder)
      .filter(s => !needle || (s.title ?? '').toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, q, archived, folder]);

  const all = list.length > 0 && list.every(s => picked.has(s.id));
  const toggle = (id: string): void => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = list.filter(s => picked.has(s.id));

  const bulkArchive = async (): Promise<void> => {
    for (const s of chosen) await archiveSession(s.id, !archived);
    toast.success(`${chosen.length} chat${chosen.length === 1 ? '' : 's'} ${archived ? 'restored' : 'archived'}`);
    setPicked(new Set());
  };
  const bulkDelete = async (): Promise<void> => {
    const ok = await desktop.dialog.confirm({ title: 'Delete chats', message: `Delete ${chosen.length} chat${chosen.length === 1 ? '' : 's'} for good?`, detail: 'Transcripts are removed from disk. Running chats are skipped.', ok: 'Delete', danger: true });
    if (!ok) return;
    const r = await deleteSessions(chosen.map(s => s.id));
    toast.success(`Deleted ${r.deleted.length}`, r.skipped.length ? `${r.skipped.length} skipped: ${r.skipped[0]!.reason}` : undefined);
    setPicked(new Set());
  };

  let bucket = '';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 pb-16 pt-8">
        <h1 className="text-[26px] font-semibold tracking-tight">Chats</h1>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[260px] flex-1">
            <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-aico-muted" />
            <input className="input rounded-full pl-9" placeholder="Search chats" value={q} onChange={e => setQ(e.target.value)} autoFocus />
          </div>
          <select className="select w-52 rounded-full" value={folder} onChange={e => setFolder(e.target.value)} aria-label="Folder">
            <option value="">All folders</option>
            {projects.map(p => <option key={p.path} value={p.path}>{p.isWorkspace ? 'Workspace' : p.name}</option>)}
          </select>
          <div className="segmented">
            <button aria-pressed={!archived} onClick={() => { setArchived(false); setPicked(new Set()); }}>Active</button>
            <button aria-pressed={archived} onClick={() => { setArchived(true); setPicked(new Set()); }}>Archived</button>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3 border-b border-aico-border-subtle pb-2 text-[12.5px] text-aico-muted">
          <label className="flex items-center gap-2"><input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(list.map(s => s.id)))} className="accent-[var(--aico-accent)]" />Select all</label>
          <span>{list.length} chat{list.length === 1 ? '' : 's'}</span>
          <div className="flex-1" />
          {chosen.length > 0 && (
            <>
              <span className="text-aico-primary">{chosen.length} selected</span>
              <button className="btn-outline btn-sm" onClick={() => void bulkArchive()}><Icon name="archive" size={13} />{archived ? 'Restore' : 'Archive'}</button>
              <button className="btn-danger btn-sm" onClick={() => void bulkDelete()}><Icon name="trash" size={13} />Delete…</button>
            </>
          )}
        </div>
        <div className="mt-1">
          {list.map(s => {
            const b = dayBucket(s.updatedAt);
            const head = b !== bucket ? b : null;
            bucket = b;
            const p = projects.find(x => x.path === s.project);
            return (
              <React.Fragment key={s.id}>
                {head && <div className="pb-1 pt-4 text-[12px] font-medium text-aico-muted">{head}</div>}
                <div className={cls('group flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-aico-hover', picked.has(s.id) && 'bg-aico-accent-soft')}>
                  <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} className="accent-[var(--aico-accent)]" aria-label={`Select ${s.title}`} />
                  <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => void openChat(s.id)}>
                    <Icon name={s.running ? 'activity' : 'chat'} size={15} className={s.running ? 'text-aico-accent' : 'text-aico-muted'} />
                    <span className="min-w-0 flex-1 truncate text-[14px]">{s.title || 'New chat'}</span>
                    {p && !p.isWorkspace && <span className="flex max-w-[180px] items-center gap-1 truncate text-[12px] text-aico-muted"><Icon name="folder" size={12} />{p.name ?? basename(p.path)}</span>}
                    {s.turns !== undefined && <span className="text-[12px] text-aico-muted">{s.turns} turn{s.turns === 1 ? '' : 's'}</span>}
                    <span className="w-10 text-right text-[12px] text-aico-muted">{ago(s.updatedAt)}</span>
                  </button>
                </div>
              </React.Fragment>
            );
          })}
          {list.length === 0 && <div className="py-16 text-center text-[13.5px] text-aico-muted">{q ? 'No chats match.' : archived ? 'Nothing archived.' : 'No chats yet.'}</div>}
        </div>
      </div>
    </div>
  );
}
