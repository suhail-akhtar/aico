/**
 * The top of the main pane: back/forward (Antigravity), where you are
 * ("project / chat title"), and what you can do here — export and the chat's
 * menu, the browser dock, the bottom panel. The OS draws the window controls
 * over its right end, so it keeps that corner clear.
 *
 * @module desktop/renderer/shell/TopBar
 */

import React from 'react';
import { useStore } from '@web/store';
import { useProjects } from '@/lib/projects';
import { useDesk, toast } from '@/state/desk';
import { resolveView } from '@/plugins/registry';
import { Icon } from '@/lib/icons';
import { basename, cls } from '@/lib/util';
import { MenuButton, MenuItem, MenuSep } from './Popover';
import { exportChat } from '@/chat/actions';
import { desktop } from '@/desktop';
import { snapshotNode, standaloneHtml } from '@/lib/rich';

export function TopBar(): React.ReactElement {
  const route = useDesk(s => s.route);
  const back = useDesk(s => s.back);
  const forward = useDesk(s => s.forward);
  const goBack = useDesk(s => s.goBack);
  const goForward = useDesk(s => s.goForward);
  const sidebar = useDesk(s => s.prefs.sidebar);
  const setPrefs = useDesk(s => s.setPrefs);
  const panel = useDesk(s => s.panel);
  const setPanel = useDesk(s => s.setPanel);
  const dock = useDesk(s => s.dock);
  const setDock = useDesk(s => s.setDock);

  const inChat = route.view === 'chat' || route.view === 'home';

  return (
    <header className="drag titlebar-inset flex h-[52px] shrink-0 items-center gap-1 px-3">
      {sidebar.collapsed && (
        <>
          <button className="icon-btn traffic-inset" onClick={() => void setPrefs({ sidebar: { ...sidebar, collapsed: false } })} title="Open sidebar (Ctrl+B)" aria-label="Open sidebar">
            <Icon name="sidebar" size={18} />
          </button>
          <button className="icon-btn" onClick={() => { useStore.getState().newSession(); useDesk.getState().navigate({ view: 'home' }); }} title="New chat" aria-label="New chat">
            <Icon name="new-chat" size={18} />
          </button>
        </>
      )}
      <button className="icon-btn" onClick={goBack} disabled={back.length === 0} title="Back (Alt+Left)" aria-label="Back"><Icon name="arrow-left" size={17} /></button>
      <button className="icon-btn" onClick={goForward} disabled={forward.length === 0} title="Forward (Alt+Right)" aria-label="Forward"><Icon name="arrow-right" size={17} /></button>
      <div className="ml-1 min-w-0 flex-1"><Breadcrumb /></div>
      {inChat && <ChatMenu />}
      <button className={cls('icon-btn', dock.open && 'bg-aico-hover text-aico-primary')} onClick={() => setDock({ open: !dock.open })}
        title="Side panel (browser, preview)" aria-label="Toggle side panel" aria-pressed={dock.open}>
        <Icon name="panel-right" size={18} />
      </button>
      <button className={cls('icon-btn', panel.open && 'bg-aico-hover text-aico-primary')} onClick={() => setPanel({ open: !panel.open })}
        title="Bottom panel (terminal) — Ctrl+J" aria-label="Toggle bottom panel" aria-pressed={panel.open}>
        <Icon name="panel-bottom" size={18} />
      </button>
    </header>
  );
}

function Breadcrumb(): React.ReactElement {
  const route = useDesk(s => s.route);
  const title = useStore(s => s.title);
  const project = useStore(s => s.project);
  const projects = useProjects();
  const logged = useStore(s => s.logged);
  const groups = useStore(s => s.groups);
  const [editing, setEditing] = React.useState(false);
  const rename = useStore(s => s.rename);

  if (route.view === 'chat' || route.view === 'home') {
    const p = projects.find(x => x.path === project);
    const folder = p ? (p.isWorkspace ? null : p.name) : project ? basename(project) : null;
    if (logged.size === 0 && route.view === 'home') {
      return <span className="text-[14px] font-medium text-aico-primary">New chat</span>;
    }
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-[14px]">
        {folder && (
          <>
            <button className="no-drag shrink-0 truncate text-aico-secondary hover:text-aico-primary" onClick={() => useDesk.getState().navigate({ view: 'project', params: { path: project! } })}>{folder}</button>
            <span className="text-aico-muted">/</span>
          </>
        )}
        {editing ? (
          <input autoFocus defaultValue={title} className="input h-7 max-w-[420px] py-0" aria-label="Rename chat"
            onBlur={e => { setEditing(false); if (e.target.value.trim() && e.target.value !== title) void rename(e.target.value.trim()); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false); }} />
        ) : (
          <button className="no-drag min-w-0 truncate font-medium text-aico-primary" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {title || 'New chat'}
          </button>
        )}
      </div>
    );
  }
  const view = resolveView(route.view);
  let label = view?.title ?? route.view;
  if (route.view === 'project' && route.params?.path) label = projects.find(p => p.path === route.params!.path)?.name ?? basename(route.params.path);
  if (route.view === 'group' && route.params?.id) label = groups.find(g => g.id === route.params!.id)?.name ?? 'Group';
  return (
    <div className="flex items-center gap-2 text-[14px] font-medium">
      {view?.icon && <Icon name={view.icon} size={16} className="text-aico-secondary" />}
      <span className="truncate">{label}</span>
    </div>
  );
}

function ChatMenu(): React.ReactElement | null {
  const sessionId = useStore(s => s.sessionId);
  const title = useStore(s => s.title);
  const logged = useStore(s => s.logged);
  const sessions = useStore(s => s.sessions);
  const archiveSession = useStore(s => s.archiveSession);
  const forkSession = useStore(s => s.forkSession);
  const deleteSessions = useStore(s => s.deleteSessions);
  const mode = useDesk(s => s.mode);
  const jump = useDesk(s => s.prefs.jumpToAnswer);
  if (logged.size === 0) return null;
  const archived = sessions.find(s => s.id === sessionId)?.archived;

  const exportRendered = async (kind: 'html' | 'pdf'): Promise<void> => {
    const node = document.querySelector<HTMLElement>('.transcript');
    if (!node) return;
    const html = standaloneHtml(title || 'AICO chat', `<div class="transcript">${snapshotNode(node).innerHTML}</div>`, { dark: kind === 'html' && mode === 'dark' });
    const name = (title || 'chat').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80);
    const out = kind === 'pdf'
      ? await desktop.exportPdf(html, `${name}.pdf`)
      : await desktop.dialog.saveFile({ defaultName: `${name}.html`, content: html, filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (out) toast.success(`Saved ${kind.toUpperCase()}`, out);
  };
  const copyAll = async (): Promise<void> => {
    const res = await fetch(`/api/session/export?id=${encodeURIComponent(sessionId)}&format=md`);
    const md = await res.text();
    const node = document.querySelector<HTMLElement>('.transcript');
    await desktop.clipboard.writeRich(md, node ? snapshotNode(node).innerHTML : undefined);
    toast.success('Chat copied', 'Markdown and rich text are on the clipboard.');
  };

  return (
    <>
      <MenuButton className="btn-ghost btn-sm" title="Share and export" placement="bottom-end" width={260}
        button={<><Icon name="share" size={15} />Share</>}>
        {close => (
          <>
            <MenuItem icon="copy" label="Copy chat (rich + Markdown)" onClick={() => { close(); void copyAll(); }} />
            <MenuSep />
            <MenuItem icon="download" label="Export as PDF" hint="with every visual" onClick={() => { close(); void exportRendered('pdf'); }} />
            <MenuItem icon="globe" label="Export as HTML" hint="standalone page" onClick={() => { close(); void exportRendered('html'); }} />
            <MenuItem icon="file-text" label="Export as Markdown" onClick={() => { close(); void exportChat(sessionId, 'md', title); }} />
            <MenuItem icon="file" label="Export as text" onClick={() => { close(); void exportChat(sessionId, 'txt', title); }} />
          </>
        )}
      </MenuButton>
      <MenuButton className="icon-btn" title="Chat options" placement="bottom-end" button={<Icon name="more" size={18} />}>
        {close => (
          <>
            <MenuItem icon="git-branch" label="Branch into a new chat" onClick={() => { close(); void forkSession(sessionId); }} />
            <MenuItem icon="file-text" label="Review changes" onClick={() => { close(); useDesk.getState().navigate({ view: 'changes', params: { id: sessionId } }); }} />
            <MenuItem icon="activity" label="Trajectory" onClick={() => { close(); useDesk.getState().navigate({ view: 'trajectory', params: { id: sessionId } }); }} />
            <MenuSep />
            <MenuItem icon="arrow-up" label="Jump to the answer when it finishes" checked={jump}
              title="When a reply finishes, scroll up to where it starts"
              onClick={() => {
                close();
                void useDesk.getState().setPrefs({ jumpToAnswer: !jump });
                toast.info(jump ? 'Will stay at the end of replies' : 'Will jump to the start of each reply');
              }} />
            <MenuSep />
            <MenuItem icon="archive" label={archived ? 'Restore' : 'Archive'} onClick={() => { close(); void archiveSession(sessionId, !archived); }} />
            <MenuItem icon="trash" danger label="Delete…" onClick={() => {
              close();
              void desktop.dialog.confirm({ title: 'Delete chat', message: `Delete “${title || 'New chat'}” for good?`, detail: 'This cannot be undone.', ok: 'Delete', danger: true })
                .then(async ok => {
                  if (!ok) return;
                  const r = await deleteSessions([sessionId]);
                  if (r.skipped.length) toast.warning('Not deleted', r.skipped[0]!.reason); else { toast.success('Chat deleted'); useDesk.getState().navigate({ view: 'home' }); }
                });
            }} />
          </>
        )}
      </MenuButton>
    </>
  );
}
