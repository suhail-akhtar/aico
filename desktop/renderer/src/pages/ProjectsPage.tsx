/**
 * Projects — ChatGPT's Projects page: every folder (and group) as a card,
 * searchable, with New.
 *
 * @module desktop/renderer/pages/ProjectsPage
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '@web/store';
import { useProjects } from '@/lib/projects';
import { go, toast } from '@/state/desk';
import { desktop } from '@/desktop';
import { Icon } from '@/lib/icons';
import { ago, cls } from '@/lib/util';
import { MenuButton, MenuItem } from '@/shell/Popover';

export function ProjectsPage(): React.ReactElement {
  const projects = useProjects();
  const groups = useStore(s => s.groups);
  const sessions = useStore(s => s.sessions);
  const addProject = useStore(s => s.addProject);
  const createGroup = useStore(s => s.createGroup);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'all' | 'folders' | 'groups'>('all');

  const folders = useMemo(() => projects.filter(p => !p.isWorkspace && (!q || p.name.toLowerCase().includes(q.toLowerCase()) || p.path.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => Math.max(b.updatedAt, b.addedAt ?? 0) - Math.max(a.updatedAt, a.addedAt ?? 0)), [projects, q]);
  const shownGroups = useMemo(() => groups.filter(g => !q || g.name.toLowerCase().includes(q.toLowerCase())), [groups, q]);

  const openFolder = async (): Promise<void> => {
    const dir = await desktop.dialog.pickFolder('Open a project folder');
    if (!dir) return;
    try { await addProject(dir); go('project', { path: dir }); } catch (e) { toast.error('Could not add it', (e as Error).message); }
  };
  const newGroup = async (): Promise<void> => {
    const name = window.prompt('Name the group');
    if (!name?.trim()) return;
    const id = await createGroup(name.trim());
    if (id) go('group', { id });
  };

  const empty = folders.length === 0 && shownGroups.length === 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 pb-16 pt-10">
        <div className="flex items-center gap-3">
          <h1 className="text-[28px] font-semibold tracking-tight">Projects</h1>
          <div className="flex-1" />
          <div className="relative w-72">
            <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-aico-muted" />
            <input className="input rounded-full pl-9" placeholder="Search projects" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <MenuButton className="btn-primary" title="New" placement="bottom-end" button={<>New</>} width={220}>
            {close => (
              <>
                <MenuItem icon="folder-plus" label="Open a folder…" onClick={() => { close(); void openFolder(); }} />
                <MenuItem icon="stack" label="New group…" onClick={() => { close(); void newGroup(); }} />
                <MenuItem icon="github" label="Clone from GitHub…" onClick={() => { close(); go('github'); }} />
              </>
            )}
          </MenuButton>
        </div>
        <div className="mt-6 flex gap-1 border-b border-aico-border-subtle pb-3">
          {([['all', 'All'], ['folders', 'Folders'], ['groups', 'Groups']] as const).map(([id, label]) => (
            <button key={id} className={cls('rounded-full px-3.5 py-1.5 text-[13.5px]', tab === id ? 'bg-aico-hover font-medium' : 'text-aico-secondary hover:text-aico-primary')} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        {empty && (
          <div className="flex flex-col items-center py-24 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-aico-hover"><Icon name="folder" size={24} /></span>
            <div className="mt-3 text-[15px] font-medium">No projects yet</div>
            <button className="btn-outline mt-4" onClick={() => void openFolder()}>Open a folder</button>
          </div>
        )}
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tab !== 'groups' && folders.map(p => {
            const chats = sessions.filter(s => s.project === p.path).length;
            return (
              <button key={p.path} className="card flex flex-col items-start p-4 text-left transition-shadow hover:shadow-[var(--desk-shadow)]" onClick={() => go('project', { path: p.path })}>
                <div className="flex w-full items-center gap-2">
                  <Icon name="folder" size={18} style={p.color ? { color: p.color } : undefined} className={p.color ? '' : 'text-aico-accent'} />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{p.name}</span>
                  {p.pinned && <Icon name="pin" size={13} className="text-aico-muted" />}
                </div>
                <div className="mt-1 w-full truncate font-mono text-[11.5px] text-aico-muted">{p.path}</div>
                {p.description && <div className="mt-2 line-clamp-2 text-[12.5px] text-aico-secondary">{p.description}</div>}
                <div className="mt-3 text-[12px] text-aico-muted">{chats} chat{chats === 1 ? '' : 's'} · {p.updatedAt ? `active ${ago(p.updatedAt)} ago` : 'new'}{!p.exists && <span className="text-aico-danger"> · missing</span>}</div>
              </button>
            );
          })}
          {tab !== 'folders' && shownGroups.map(g => {
            const chats = sessions.filter(s => s.group === g.id).length;
            return (
              <button key={g.id} className="card flex flex-col items-start p-4 text-left transition-shadow hover:shadow-[var(--desk-shadow)]" onClick={() => go('group', { id: g.id })}>
                <div className="flex w-full items-center gap-2">
                  <Icon name="stack" size={18} style={g.color ? { color: g.color } : undefined} className={g.color ? '' : 'text-aico-secondary'} />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{g.name}</span>
                  <span className="badge bg-aico-hover text-aico-muted">group</span>
                </div>
                {g.description && <div className="mt-2 line-clamp-2 text-[12.5px] text-aico-secondary">{g.description}</div>}
                <div className="mt-3 text-[12px] text-aico-muted">{chats} chat{chats === 1 ? '' : 's'}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
