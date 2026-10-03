/**
 * The left column.
 *
 * ChatGPT's shape on top — the wordmark with search and collapse, a New chat
 * row, then the destinations — and Antigravity's below: Projects as folders
 * that open to show their chats, then Conversations that belong to no project,
 * each with a compact age or a live dot. The profile sits at the foot and opens
 * the account menu upward.
 *
 * Destinations are not hard-coded: they are the `navItems` of every enabled
 * plugin, so switching a feature off removes it here, and a plugin the
 * orchestrator writes can add one.
 *
 * @module desktop/renderer/shell/Sidebar
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useStore } from '@web/store';
import { useProjects } from '@/lib/projects';
import type { Project, SessionSummary } from '@web/api';
import { useDesk, go, toast } from '@/state/desk';
import { useNavItems } from '@/plugins/registry';
import { Icon } from '@/lib/icons';
import { ago, basename, cls, initials } from '@/lib/util';
import { isUnread, useLocal } from '@/lib/local';
import { MenuButton, MenuItem, MenuSep, MenuSub } from './Popover';
import { desktop } from '@/desktop';
import type { UpdateState } from '@desk/updates';
import { newChat, openChat, chatCommands } from '@/chat/actions';

export function Sidebar(): React.ReactElement {
  const prefs = useDesk(s => s.prefs);
  const setPrefs = useDesk(s => s.setPrefs);
  const width = prefs.sidebar.width;
  const [dragging, setDragging] = useState(false);

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startW = width;
    let latest = startW;
    const move = (ev: MouseEvent): void => {
      latest = Math.max(220, Math.min(460, startW + ev.clientX - startX));
      document.documentElement.style.setProperty('--desk-sidebar-w', `${latest}px`);
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDragging(false);
      void setPrefs({ sidebar: { ...prefs.sidebar, width: latest } });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-aico-border-subtle bg-aico-sidebar"
      style={{ width: `var(--desk-sidebar-w, ${width}px)` }}
      aria-label="Sidebar"
    >
      <SidebarHeader />
      <div className="px-2 pb-1">
        <NewChatRow />
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <Destinations />
        <ProjectsSection />
        <GroupsSection />
        <ConversationsSection />
      </div>
      <ProfileRow />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onMouseDown={startResize}
        className={cls('absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize', dragging && 'bg-aico-accent/20')}
      />
    </aside>
  );
}

function SidebarHeader(): React.ReactElement {
  const setPrefs = useDesk(s => s.setPrefs);
  const sidebar = useDesk(s => s.prefs.sidebar);
  const setSearch = useDesk(s => s.setSearch);
  return (
    <div className="drag traffic-inset flex h-[52px] shrink-0 items-center gap-1 px-4">
      <button className="no-drag flex items-center gap-2 text-[17px] font-semibold tracking-tight text-aico-primary" onClick={() => newChat()} title="New chat">
        <Logo size={22} /> AICO
      </button>
      <div className="flex-1" />
      <button className="icon-btn" onClick={() => setSearch(true)} title="Search chats (Ctrl+Shift+F)" aria-label="Search chats"><Icon name="search" size={18} /></button>
      <button className="icon-btn" onClick={() => void setPrefs({ sidebar: { ...sidebar, collapsed: true } })} title="Close sidebar (Ctrl+B)" aria-label="Close sidebar">
        <Icon name="sidebar" size={18} />
      </button>
    </div>
  );
}

export function Logo({ size = 20 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="aico-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--aico-accent)" />
          <stop offset="1" stopColor="var(--aico-text-primary)" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="url(#aico-g)" />
      <path d="M10 22.5 16 8.5l6 14" fill="none" stroke="var(--aico-bg)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.3 17.5h7.4" stroke="var(--aico-bg)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

function NewChatRow(): React.ReactElement {
  const route = useDesk(s => s.route);
  const active = route.view === 'home';
  return (
    <button className={cls('nav-item group', active && 'nav-item-active')} onClick={() => newChat()}>
      <Icon name="new-chat" size={18} />
      <span className="flex-1">New chat</span>
      <span className="text-[11px] text-aico-muted opacity-0 transition-opacity group-hover:opacity-100">Ctrl N</span>
    </button>
  );
}

function Destinations(): React.ReactElement {
  const items = useNavItems();
  const route = useDesk(s => s.route);
  const [showMore, setShowMore] = useLocal('desk.navMore', false);
  const primary = items.filter(i => (i.placement ?? 'primary') === 'primary');
  const more = items.filter(i => i.placement === 'more');
  const row = (i: typeof items[number]): React.ReactElement => (
    <button key={`${i.pluginId}:${i.id}`} className={cls('nav-item', route.view === i.view && 'nav-item-active')} onClick={() => go(i.view)}>
      <Icon name={i.icon ?? 'puzzle'} size={18} className="text-aico-secondary" />
      <span className="truncate">{i.title}</span>
    </button>
  );
  return (
    <nav aria-label="Destinations" className="flex flex-col">
      {primary.map(row)}
      {more.length > 0 && (
        <>
          <button className="nav-item text-aico-secondary" onClick={() => setShowMore(!showMore)} aria-expanded={showMore}>
            <Icon name={showMore ? 'chevron-up' : 'more'} size={18} />
            <span>{showMore ? 'Less' : 'More'}</span>
          </button>
          {showMore && more.map(row)}
        </>
      )}
    </nav>
  );
}

/** Chats in a folder, newest first, archived hidden unless asked for. */
function useSessionsBy(): { byProject: Map<string, SessionSummary[]>; loose: SessionSummary[]; byGroup: Map<string, SessionSummary[]> } {
  const sessions = useStore(s => s.sessions);
  const projects = useProjects();
  const showArchived = useStore(s => s.showArchived);
  return useMemo(() => {
    const workspace = new Set(projects.filter(p => p.isWorkspace).map(p => norm(p.path)));
    const known = new Set(projects.filter(p => !p.isWorkspace).map(p => norm(p.path)));
    const byProject = new Map<string, SessionSummary[]>();
    const byGroup = new Map<string, SessionSummary[]>();
    const loose: SessionSummary[] = [];
    for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (s.archived && !showArchived) continue;
      if (s.group) {
        const list = byGroup.get(s.group) ?? [];
        list.push(s);
        byGroup.set(s.group, list);
        continue;
      }
      const p = s.project ? norm(s.project) : '';
      if (p && known.has(p) && !workspace.has(p)) {
        const list = byProject.get(p) ?? [];
        list.push(s);
        byProject.set(p, list);
      } else {
        loose.push(s);
      }
    }
    return { byProject, loose, byGroup };
  }, [sessions, projects, showArchived]);
}

function norm(p: string): string { return p.replace(/[\\/]+$/, '').toLowerCase(); }

function ProjectsSection(): React.ReactElement | null {
  const projects = useProjects();
  const addProject = useStore(s => s.addProject);
  const { byProject } = useSessionsBy();
  const [sort, setSort] = useLocal<'recent' | 'name'>('desk.projectSort', 'recent');
  const [open, setOpen] = useLocal<Record<string, boolean>>('desk.projectOpen', {});
  const visible = projects.filter(p => !p.isWorkspace);
  const ordered = useMemo(() => {
    const list = [...visible];
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false)
      || Math.max(b.updatedAt, b.addedAt ?? 0) - Math.max(a.updatedAt, a.addedAt ?? 0));
    return list;
  }, [visible, sort]);

  const openFolder = async (): Promise<void> => {
    const dir = await desktop.dialog.pickFolder('Open a project folder');
    if (!dir) return;
    try {
      await addProject(dir);
      setOpen(o => ({ ...o, [norm(dir)]: true }));
      toast.success('Project added', basename(dir));
    } catch (err) { toast.error('Could not add that folder', (err as Error).message); }
  };

  return (
    <section aria-label="Projects" className="mt-2">
      <div className="group flex items-center pr-1">
        <div className="side-heading flex-1">Projects</div>
        <MenuButton className="icon-btn-sm opacity-60 hover:opacity-100" title="Sort projects" button={<Icon name="filter" size={14} />} placement="bottom-end">
          {close => (
            <>
              <MenuItem label="Most recent" checked={sort === 'recent'} onClick={() => { setSort('recent'); close(); }} />
              <MenuItem label="Name" checked={sort === 'name'} onClick={() => { setSort('name'); close(); }} />
            </>
          )}
        </MenuButton>
        <button className="icon-btn-sm opacity-60 hover:opacity-100" onClick={() => void openFolder()} title="Open a folder as a project" aria-label="Open a folder as a project">
          <Icon name="folder-plus" size={15} />
        </button>
      </div>
      {ordered.length === 0 && (
        <button className="group side-row text-aico-muted" onClick={() => void openFolder()}>
          <Icon name="folder-plus" size={16} /> Open a folder…
        </button>
      )}
      {ordered.map(p => (
        <ProjectRow key={p.path} project={p} chats={byProject.get(norm(p.path)) ?? []}
          open={open[norm(p.path)] ?? false}
          onToggle={() => setOpen(o => ({ ...o, [norm(p.path)]: !(o[norm(p.path)] ?? false) }))} />
      ))}
    </section>
  );
}

function ProjectRow({ project, chats, open, onToggle }: {
  project: Project; chats: SessionSummary[]; open: boolean; onToggle: () => void;
}): React.ReactElement {
  const route = useDesk(s => s.route);
  const target = useStore(s => s.project);
  const targetGroup = useStore(s => s.targetGroup);
  const selectTarget = useStore(s => s.selectTarget);
  const newSessionIn = useStore(s => s.newSessionIn);
  const removeProject = useStore(s => s.removeProject);
  const [limit, setLimit] = useState(5);
  const isTarget = !targetGroup && target !== null && norm(target) === norm(project.path);
  const pageActive = route.view === 'project' && route.params?.path === project.path;
  return (
    <div>
      <div className={cls('group side-row pr-1', pageActive && 'bg-aico-hover')}>
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle} onDoubleClick={() => go('project', { path: project.path })}
          aria-expanded={open} title={project.path}>
          <Icon name={open ? 'folder-open' : 'folder'} size={16} className="shrink-0 text-aico-secondary" style={project.color ? { color: project.color } : undefined} />
          <span className={cls('truncate', !project.exists && 'text-aico-muted line-through')}>{project.name}</span>
          {isTarget && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-aico-accent" title="New chats start here" />}
        </button>
        <button className="icon-btn-sm opacity-0 group-hover:opacity-100" title={`New chat in ${project.name}`} aria-label={`New chat in ${project.name}`}
          onClick={() => { newSessionIn(project.path); go('home'); }}>
          <Icon name="plus" size={14} />
        </button>
        <MenuButton className="icon-btn-sm opacity-0 group-hover:opacity-100" title="Project actions" button={<Icon name="more" size={14} />} placement="bottom-end">
          {close => (
            <>
              <MenuItem icon="folder-open" label="Open project page" onClick={() => { close(); go('project', { path: project.path }); }} />
              <MenuItem icon="new-chat" label="New chat here" onClick={() => { close(); newSessionIn(project.path); go('home'); }} />
              <MenuItem icon="pin" label={isTarget ? 'Default for new chats' : 'Use for new chats'} checked={isTarget}
                onClick={() => { close(); selectTarget({ kind: 'project', path: project.path }); }} />
              <MenuSep />
              <MenuItem icon="code" label="Open in editor" onClick={() => { close(); go('files', { root: project.path }); }} />
              <MenuItem icon="git" label="Source control" onClick={() => { close(); go('git', { path: project.path }); }} />
              <MenuItem icon="terminal" label="Open terminal here" onClick={() => { close(); useDesk.getState().setPanel({ open: true, tab: 'terminal' }); window.dispatchEvent(new CustomEvent('desk:terminal', { detail: { cwd: project.path } })); }} />
              <MenuItem icon="external" label="Reveal in file manager" onClick={() => { close(); void desktop.shell.openPath(project.path); }} />
              <MenuSep />
              <MenuItem icon="trash" danger label="Remove from sidebar" onClick={() => {
                close();
                void removeProject(project.path).then(() => toast.info('Project removed', 'The folder and its chats are untouched on disk.'))
                  .catch((e: Error) => toast.error('Could not remove it', e.message));
              }} />
            </>
          )}
        </MenuButton>
      </div>
      {open && (
        <div className="mb-1">
          {chats.length === 0 && <div className="py-1 pl-9 text-[12.5px] text-aico-muted">No chats yet</div>}
          {chats.slice(0, limit).map(s => <ChatRow key={s.id} session={s} indent />)}
          {chats.length > limit && (
            <button className="py-1 pl-9 text-[12.5px] text-aico-muted hover:text-aico-primary" onClick={() => setLimit(l => l + 10)}>
              Show {Math.min(10, chats.length - limit)} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function GroupsSection(): React.ReactElement | null {
  const groups = useStore(s => s.groups);
  const createGroup = useStore(s => s.createGroup);
  const { byGroup } = useSessionsBy();
  const [open, setOpen] = useLocal<Record<string, boolean>>('desk.groupOpen', {});
  if (groups.length === 0) return null;
  const ordered = [...groups].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false)
    || Math.max(byGroup.get(b.id)?.[0]?.updatedAt ?? 0, b.createdAt ?? 0) - Math.max(byGroup.get(a.id)?.[0]?.updatedAt ?? 0, a.createdAt ?? 0));
  return (
    <section aria-label="Groups" className="mt-1">
      <div className="flex items-center pr-1">
        <div className="side-heading flex-1">Groups</div>
        <button className="icon-btn-sm opacity-60 hover:opacity-100" title="New group" aria-label="New group"
          onClick={() => { const name = window.prompt('Name the group'); if (name?.trim()) void createGroup(name.trim()); }}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      {ordered.map(g => {
        const chats = byGroup.get(g.id) ?? [];
        const isOpen = open[g.id] ?? false;
        return (
          <div key={g.id}>
            <div className="group side-row pr-1">
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(o => ({ ...o, [g.id]: !isOpen }))}
                onDoubleClick={() => go('group', { id: g.id })} aria-expanded={isOpen}>
                <Icon name="stack" size={16} className="shrink-0 text-aico-secondary" style={g.color ? { color: g.color } : undefined} />
                <span className="truncate">{g.name}</span>
              </button>
              <button className="icon-btn-sm opacity-0 group-hover:opacity-100" title="Open group" aria-label={`Open ${g.name}`} onClick={() => go('group', { id: g.id })}>
                <Icon name="chevron-right" size={14} />
              </button>
            </div>
            {isOpen && chats.map(s => <ChatRow key={s.id} session={s} indent />)}
            {isOpen && chats.length === 0 && <div className="py-1 pl-9 text-[12.5px] text-aico-muted">No chats yet</div>}
          </div>
        );
      })}
    </section>
  );
}

function ConversationsSection(): React.ReactElement {
  const { loose } = useSessionsBy();
  const [limit, setLimit] = useState(30);
  const showArchived = useStore(s => s.showArchived);
  const toggleArchived = useStore(s => s.toggleArchived);
  return (
    <section aria-label="Conversations" className="mt-1">
      <div className="flex items-center pr-1">
        <div className="side-heading flex-1">Conversations</div>
        <MenuButton className="icon-btn-sm opacity-60 hover:opacity-100" title="Conversation options" button={<Icon name="more" size={14} />} placement="bottom-end">
          {close => (
            <MenuItem icon="archive" label="Show archived" checked={showArchived} onClick={() => { toggleArchived(); close(); }} />
          )}
        </MenuButton>
        <button className="icon-btn-sm opacity-60 hover:opacity-100" onClick={() => newChat({ workspace: true })} title="New conversation" aria-label="New conversation">
          <Icon name="plus" size={15} />
        </button>
      </div>
      {loose.length === 0 && <div className="px-2.5 py-1 text-[12.5px] text-aico-muted">Your conversations will appear here.</div>}
      {loose.slice(0, limit).map(s => <ChatRow key={s.id} session={s} />)}
      {loose.length > limit && (
        <button className="group side-row text-aico-muted" onClick={() => setLimit(l => l + 30)}>Show more</button>
      )}
    </section>
  );
}

export function ChatRow({ session, indent }: { session: SessionSummary; indent?: boolean }): React.ReactElement {
  const current = useStore(s => s.sessionId);
  const route = useDesk(s => s.route);
  const active = route.view === 'chat' && current === session.id;
  const running = session.running;
  const unread = !active && isUnread(session.id, session.updatedAt);
  const title = session.title || 'New chat';
  const [renaming, setRenaming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const renameSession = useStore(s => s.renameSession);

  const commit = useCallback((value: string) => {
    setRenaming(false);
    const t = value.trim();
    if (t && t !== session.title) void renameSession(session.id, t);
  }, [renameSession, session.id, session.title]);

  return (
    <div className={cls('group side-row pr-1', indent && 'pl-9', active && 'bg-aico-hover')}>
      {renaming ? (
        <input ref={input} autoFocus defaultValue={title} className="input h-7 py-0" aria-label="Chat title"
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(false); }} />
      ) : (
        <button className="min-w-0 flex-1 truncate text-left" onClick={() => void openChat(session.id)} onDoubleClick={() => setRenaming(true)} title={title}>
          <span className={cls(unread && 'font-medium')}>{title}</span>
        </button>
      )}
      {!renaming && (
        <>
          <span className="shrink-0 text-[11.5px] text-aico-muted group-hover:hidden">
            {running ? <span className="live-dot" title="Running" /> : unread ? <span className="inline-block h-2 w-2 rounded-full bg-aico-accent" title="Unread" /> : ago(session.updatedAt)}
          </span>
          <MenuButton className="icon-btn-sm hidden group-hover:inline-flex" title="Chat actions" button={<Icon name="more" size={14} />} placement="bottom-end">
            {close => <>{chatCommands(session, close, () => setRenaming(true)).map(i => i)}</>}
          </MenuButton>
        </>
      )}
    </div>
  );
}

function ProfileRow(): React.ReactElement {
  const info = useDesk(s => s.info);
  const engine = useDesk(s => s.engine);
  const openSettings = useDesk(s => s.openSettings);
  const prefs = useDesk(s => s.prefs);
  const setPrefs = useDesk(s => s.setPrefs);
  const name = info?.user ?? 'You';
  return (
    <div className="border-t border-aico-border-subtle p-2">
      <MenuButton
        className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-aico-hover"
        title="Account and settings"
        placement="top-start"
        width={272}
        button={
          <>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aico-accent-soft text-[12px] font-semibold text-aico-accent">
              {initials(name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">{name}</span>
              <span className="flex items-center gap-1.5 truncate text-[11.5px] text-aico-muted">
                <span className={cls('h-1.5 w-1.5 rounded-full', engine.status === 'ready' ? 'bg-aico-success' : engine.status === 'crashed' ? 'bg-aico-danger' : 'bg-aico-warning')} />
                Local · AICO {info?.engine ?? ''}
              </span>
            </span>
          </>
        }
      >
        {close => (
          <>
            <button className="mx-0.5 mb-1 flex w-[calc(100%-4px)] items-center gap-3 rounded-xl bg-aico-hover/60 px-3 py-2.5 text-left transition-colors hover:bg-aico-hover"
              onClick={() => { close(); openSettings('personalization'); }} title="Personalization — how AICO talks to you">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aico-accent-soft text-[12.5px] font-semibold text-aico-accent">{initials(name)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">{name}</span>
                <span className="block truncate text-[12px] text-aico-muted">Local account · {info?.hostname}</span>
              </span>
              <Icon name="chevron-right" size={14} className="text-aico-muted" />
            </button>
            <MenuSep />
            <MenuItem icon="sparkles" label="Personalization" onClick={() => { close(); openSettings('personalization'); }} />
            <MenuItem icon="settings" label="Settings" hint="Ctrl+," onClick={() => { close(); openSettings('general'); }} />
            <MenuSub icon="palette" label="Appearance" width={220}>
              <MenuItem icon="sun" label="Light" checked={prefs.theme === 'light'} onClick={() => { close(); void setPrefs({ theme: 'light' }); }} />
              <MenuItem icon="moon" label="Dark" checked={prefs.theme === 'dark'} onClick={() => { close(); void setPrefs({ theme: 'dark' }); }} />
              <MenuItem icon="monitor" label="Match system" checked={prefs.theme === 'system'} onClick={() => { close(); void setPrefs({ theme: 'system' }); }} />
              <MenuSep />
              <MenuItem icon="palette" label="Colours and fonts…" onClick={() => { close(); openSettings('appearance'); }} />
            </MenuSub>
            <MenuItem icon="puzzle" label="Plugins" onClick={() => { close(); go('plugins'); }} />
            <MenuSep />
            <MenuSub icon="database" label="Your data" width={250}>
              <MenuItem icon="download" label="Back up settings…" hint="to another machine" onClick={() => {
                close();
                void desktop.backup.export({}).then(r => { if (r) toast.success('Backup saved', r.file); }).catch(e => toast.error('Backup failed', (e as Error).message));
              }} />
              <MenuItem icon="upload" label="Restore from backup…" onClick={() => { close(); openSettings('application'); toast.info('Restore is under Backup & restore', 'It shows what will change before anything is replaced.'); }} />
              <MenuItem icon="folder" label="Open the AICO folder" onClick={() => { close(); if (info?.home) void desktop.shell.openPath(info.home); }} />
            </MenuSub>
            <MenuSub icon="activity" label="Engine" width={240}>
              <MenuItem icon="globe" label="Open in web browser" onClick={() => {
                close();
                void desktop.engine.webUrl().then(u => u ? desktop.shell.openExternal(u) : toast.warning('The engine is not running yet.'));
              }} />
              <MenuItem icon="refresh" label="Restart engine" onClick={() => { close(); void desktop.engine.restart(); toast.info('Restarting the engine…', 'Running chats keep their history; a running turn is stopped.'); }} />
              <MenuItem icon="activity" label="Activity monitor" onClick={() => { close(); go('activity'); }} />
            </MenuSub>
            <MenuSub icon="help" label="Help" width={250}>
              <MenuItem icon="book" label="Help and docs" onClick={() => { close(); void desktop.shell.openExternal('https://suhail-akhtar.github.io/aico/'); }} />
              <MenuItem icon="keyboard" label="Keyboard shortcuts" onClick={() => { close(); openSettings('shortcuts'); }} />
              <MenuItem icon="sparkles" label="What's new" onClick={() => { close(); void desktop.shell.openExternal('https://github.com/suhail-akhtar/aico/releases'); }} />
              <MenuItem icon="bug" label="Report a problem" onClick={() => { close(); void desktop.shell.openExternal('https://github.com/suhail-akhtar/aico/issues/new'); }} />
              <MenuSep />
              <MenuItem icon="refresh" label="Check for updates" onClick={() => {
                close();
                // The check reports "checking" at once and the answer later, as a state event.
                const report = (s: UpdateState): boolean => {
                  if (s.status === 'checking' || s.status === 'idle') return false;
                  if (s.status === 'unsupported') toast.info('Updates install from the release page in this build', s.message);
                  else if (s.status === 'error') toast.error('Could not check for updates', s.message);
                  else if (s.status === 'up-to-date') toast.success(`AICO ${s.current} is up to date`);
                  else if (s.status === 'ready') toast.success(`AICO ${s.version} is ready`, 'Restart from Settings → Application, or it installs when you quit.');
                  else toast.info(`AICO ${s.version} is available`, s.status === 'downloading' ? 'Downloading in the background.' : 'Download it from Settings → Application.');
                  return true;
                };
                toast.info('Checking for updates…');
                const off = desktop.updates.onState(s => { if (report(s)) off(); });
                void desktop.updates.check().then(s => { if (report(s)) off(); }).catch(e => { off(); toast.error('Could not check for updates', (e as Error).message); });
                window.setTimeout(off, 60_000);
              }} />
              <MenuItem icon="info" label="About AICO" hint={info?.app ? `v${info.app}` : undefined} onClick={() => { close(); openSettings('about'); }} />
            </MenuSub>
            <MenuSep />
            <MenuItem icon="logout" label="Quit AICO" hint="Ctrl+Q" onClick={() => { close(); void desktop.quit(); }} />
          </>
        )}
      </MenuButton>
    </div>
  );
}
