/**
 * A project's own page: its chats, its files, its source control, and what it
 * has cost — with New chat, Use for new chats, and its settings one click away.
 *
 * @module desktop/renderer/pages/ProjectPage
 */

import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useStore } from '@web/store';
import { api, type ProjectStats, type SessionSummary } from '@web/api';
import { useDesk, go, toast } from '@/state/desk';
import { desktop } from '@/desktop';
import { Icon } from '@/lib/icons';
import { ago, basename, cls } from '@/lib/util';
import { openChat } from '@/chat/actions';
import type { ViewProps } from '@/plugins/registry';

const SourceControl = lazy(() => import('@/ide/GitPage').then(m => ({ default: m.SourceControl })));
const FilesPage = lazy(() => import('@/ide/FilesPage').then(m => ({ default: m.FilesPage })));

export function ProjectPage({ params }: ViewProps): React.ReactElement {
  const path = params?.path ?? '';
  const project = useStore(s => s.projects.find(p => p.path === path));
  const sessions = useStore(s => s.sessions);
  const target = useStore(s => s.project);
  const targetGroup = useStore(s => s.targetGroup);
  const selectTarget = useStore(s => s.selectTarget);
  const newSessionIn = useStore(s => s.newSessionIn);
  const [tab, setTab] = useState<'chats' | 'files' | 'git'>((params?.tab as 'chats') ?? 'chats');
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const chats = useMemo(() => sessions.filter(s => s.project === path).sort((a, b) => b.updatedAt - a.updatedAt), [sessions, path]);

  useEffect(() => { setStats(null); if (path) api.projectStats(path).then(setStats).catch(() => {}); }, [path]);

  if (!project) return <div className="flex flex-1 items-center justify-center text-aico-muted">This project is not registered.</div>;
  const isTarget = !targetGroup && target === path;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-aico-border-subtle px-8 pb-0 pt-6">
        <div className="flex items-start gap-3">
          <Icon name="folder" size={26} style={project.color ? { color: project.color } : undefined} className={project.color ? 'mt-1' : 'mt-1 text-aico-accent'} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[24px] font-semibold tracking-tight">{project.name}</h1>
            <div className="truncate font-mono text-[12px] text-aico-muted">{path}</div>
            {project.description && <p className="mt-1 text-[13.5px] text-aico-secondary">{project.description}</p>}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button className="btn-primary" onClick={() => { newSessionIn(path); go('home'); }}><Icon name="new-chat" size={15} />New chat</button>
            <button className={cls('btn-outline', isTarget && 'border-aico-accent/60 text-aico-accent')} onClick={() => selectTarget({ kind: 'project', path })} aria-pressed={isTarget}>
              {isTarget ? <><Icon name="check" size={14} />Default for new chats</> : 'Use for new chats'}
            </button>
            <button className="btn-outline" onClick={() => { useDesk.getState().setPanel({ open: true, tab: 'terminal' }); window.dispatchEvent(new CustomEvent('desk:terminal', { detail: { cwd: path } })); }}><Icon name="terminal" size={14} />Terminal</button>
            <button className="icon-btn" onClick={() => void desktop.shell.openPath(path)} title="Reveal" aria-label="Reveal in file manager"><Icon name="external" size={16} /></button>
            <button className="icon-btn" onClick={() => useDesk.getState().openSettings(`project:${path}`)} title="Project settings" aria-label="Project settings"><Icon name="settings" size={16} /></button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-3">
          {[
            ['Chats', String(stats?.sessions ?? chats.length)],
            ['Turns', stats ? String(stats.turns) : '—'],
            ['Spend', stats ? `$${stats.costUsd.toFixed(2)}` : '—'],
            ['Last active', stats?.lastActive ? `${ago(stats.lastActive)} ago` : '—'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-aico-border-subtle px-3 py-2">
              <div className="text-[11.5px] text-aico-muted">{k}</div>
              <div className="text-[17px] font-semibold tabular-nums">{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex gap-1">
          {([['chats', 'Chats', 'chat'], ['files', 'Files', 'code'], ['git', 'Source control', 'git']] as const).map(([id, label, icon]) => (
            <button key={id} className={cls('-mb-px flex items-center gap-1.5 border-b-2 px-3 pb-2.5 pt-1 text-[13.5px]', tab === id ? 'border-aico-primary font-medium text-aico-primary' : 'border-transparent text-aico-muted hover:text-aico-primary')} onClick={() => setTab(id)}>
              <Icon name={icon} size={14} />{label}
            </button>
          ))}
        </div>
      </div>
      <Suspense fallback={<div className="p-8"><div className="skeleton h-40" /></div>}>
        {tab === 'chats' && <ChatTable chats={chats} project={path} />}
        {tab === 'files' && <FilesPage params={{ root: path }} />}
        {tab === 'git' && <SourceControl path={path} embedded />}
      </Suspense>
    </div>
  );
}

export function ChatTable({ chats, project }: { chats: SessionSummary[]; project?: string }): React.ReactElement {
  const deleteSessions = useStore(s => s.deleteSessions);
  const archiveSession = useStore(s => s.archiveSession);
  const newSessionIn = useStore(s => s.newSessionIn);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const shown = chats.filter(c => Boolean(c.archived) === archived && (!q || (c.title ?? '').toLowerCase().includes(q.toLowerCase())));
  const chosen = shown.filter(c => picked.has(c.id));
  const all = shown.length > 0 && chosen.length === shown.length;
  const toggle = (id: string): void => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72"><Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-aico-muted" /><input className="input rounded-full pl-9" placeholder="Search these chats" value={q} onChange={e => setQ(e.target.value)} /></div>
        <div className="segmented"><button aria-pressed={!archived} onClick={() => { setArchived(false); setPicked(new Set()); }}>Active</button><button aria-pressed={archived} onClick={() => { setArchived(true); setPicked(new Set()); }}>Archived</button></div>
        <div className="flex-1" />
        {chosen.length > 0 && (
          <>
            <span className="text-[12.5px]">{chosen.length} selected</span>
            <button className="btn-outline btn-sm" onClick={() => void Promise.all(chosen.map(c => archiveSession(c.id, !archived))).then(() => { setPicked(new Set()); toast.success(archived ? 'Restored' : 'Archived'); })}><Icon name="archive" size={13} />{archived ? 'Restore' : 'Archive'}</button>
            <button className="btn-danger btn-sm" onClick={() => void desktop.dialog.confirm({ title: 'Delete chats', message: `Delete ${chosen.length} chat${chosen.length === 1 ? '' : 's'} for good?`, detail: 'Running chats are skipped.', ok: 'Delete', danger: true })
              .then(async ok => { if (!ok) return; const r = await deleteSessions(chosen.map(c => c.id)); setPicked(new Set()); toast.success(`Deleted ${r.deleted.length}`, r.skipped.length ? `${r.skipped.length} skipped` : undefined); })}><Icon name="trash" size={13} />Delete…</button>
          </>
        )}
        {project && <button className="btn-outline btn-sm" onClick={() => { newSessionIn(project); go('home'); }}><Icon name="plus" size={13} />New chat</button>}
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-aico-border-subtle">
        <div className="flex items-center gap-3 border-b border-aico-border-subtle bg-aico-surface px-3 py-2 text-[12px] text-aico-muted">
          <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(shown.map(c => c.id)))} aria-label="Select all" />
          <span className="flex-1">Title</span><span className="w-20 text-right">Turns</span><span className="w-20 text-right">Updated</span>
        </div>
        {shown.map(c => (
          <div key={c.id} className={cls('flex items-center gap-3 border-b border-aico-border-subtle px-3 py-2 text-[13.5px] last:border-b-0 hover:bg-aico-hover', picked.has(c.id) && 'bg-aico-accent-soft')}>
            <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.title}`} />
            <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => void openChat(c.id)}>
              {c.running ? <span className="live-dot" /> : <Icon name="chat" size={14} className="text-aico-muted" />}<span className="truncate">{c.title || 'New chat'}</span>
            </button>
            <span className="w-20 text-right text-[12px] text-aico-muted">{c.turns ?? '—'}</span>
            <span className="w-20 text-right text-[12px] text-aico-muted">{ago(c.updatedAt)}</span>
          </div>
        ))}
        {shown.length === 0 && <div className="p-8 text-center text-[13px] text-aico-muted">{q ? 'No chats match.' : archived ? 'Nothing archived.' : `No chats in ${project ? basename(project) : 'here'} yet.`}</div>}
      </div>
    </div>
  );
}
